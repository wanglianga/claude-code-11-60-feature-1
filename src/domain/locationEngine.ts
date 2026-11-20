// 替代位置生成引擎（纯领域逻辑，可测试、可 Worker 执行）。
//
// 处理流程（对每个事件）：
//  1) 解析来源区域（覆盖真实原点的几何范围）→ 若缺失/无效 = 不可验证；
//  2) 解析路网版本、训练时段、派遣站点 → 缺失/未连通 = 不可验证；
//  3) 在区域内沿“与道路图连通”的道路采样可能起点，得到
//       - 可能起点集合（规模 k，隐私集合）
//       - 可能起点→站点 的道路行程时间范围 [lo, hi]（同一时段/路网版本）；
//  4) 若 k 不足或 (hi-lo)/2 > 容差 → 不可生成（任何单点都无法同时满足最坏差值容差）；
//  5) 按策略（area / road-node）构造候选面并筛选：
//       - 距离下界 = 候选点到整个来源区域（可能来源集合的超集）的最小直线距离；
//       - 行程时间 = 候选点→站点（同一时段/路网版本）；
//       - 最坏差值 = max(|候选行程 - lo|, |候选行程 - hi|) = 与整个可能来源集合的最坏差；
//     距离下界 ≥ 隐私门槛 且 最坏差值 ≤ 容差 才可生成；否则记录拒绝原因；
//  6) 发布前对距离下界向下取整到桶、坐标落到网格、行程取整分钟，绝不含原始点。

import type { Point } from './geo';
import {
  pointInPolygon, dist, pointPolygonDistance, polygonBounds, floorToBucket, roundToGrid
} from './geo';
import type {
  GeoScenario, GeoVersion, GeoPeriod, GeoStation, SourceRegion, PopulationBand,
  LocationEventInput, LocationConfig, LocationStrategy, LocationEntry, LocationResult,
  LocationEntryPublished, LocationEntryAudit, LocationSummary, ReasonCode, LocationStatus, RejectionNote
} from './locationTypes';
import { REASON_LABELS } from './locationTypes';
import { mulberry32, type Rng } from './prng';

const ACCESS_SPEED_KMH = 30;   // 候选点（非道路点）接入最近道路的折算速度
const ORIGIN_SAMPLE_STEP_M = 25; // 沿道路采样的可能起点间距
const SEARCH_STEP_MIN_M = 80;  // area 策略的搜索网格下限（发布网格可能更粗）

interface EdgeRef {
  id: string; a: string; b: string; lenM: number; timeMin: number; blocked: boolean;
}

interface Graph {
  nodeIds: string[];
  pos: Map<string, Point>;
  adj: Map<string, { to: string; timeMin: number; edgeId: string }[]>;
  edges: EdgeRef[];
  valid: boolean;
}

export function buildGraph(s: GeoScenario, version: GeoVersion, period: GeoPeriod): Graph {
  const pos = new Map<string, Point>();
  for (const n of s.nodes) pos.set(n.id, { x: n.x, y: n.y });
  const blocked = new Set(version.blockedEdges ?? []);
  const adj = new Map<string, { to: string; timeMin: number; edgeId: string }[]>();
  const nodeIds = s.nodes.map((n) => n.id);
  for (const id of nodeIds) adj.set(id, []);
  const edges: EdgeRef[] = [];
  let valid = true;
  for (const e of s.edges) {
    if (!pos.has(e.a) || !pos.has(e.b)) { valid = false; continue; }
    const lenM = dist(pos.get(e.a)!, pos.get(e.b)!);
    const baseMin = (lenM / 1000) / Math.max(1, e.speedKmh) * 60;
    const timeMin = baseMin * (period.speedFactor || 1);
    const isBlocked = blocked.has(e.id);
    edges.push({ id: e.id, a: e.a, b: e.b, lenM, timeMin, blocked: isBlocked });
    if (isBlocked) continue;
    adj.get(e.a)!.push({ to: e.b, timeMin, edgeId: e.id });
    adj.get(e.b)!.push({ to: e.a, timeMin, edgeId: e.id });
  }
  return { nodeIds, pos, adj, edges, valid };
}

/** Dijkstra：从出发节点到所有节点的最短行程时间（分钟），不可达为 Infinity */
export function dijkstra(g: Graph, start: string): Map<string, number> {
  const distMap = new Map<string, number>();
  for (const id of g.nodeIds) distMap.set(id, Infinity);
  if (!g.pos.has(start)) return distMap;
  const visited = new Set<string>();
  distMap.set(start, 0);
  // 简单二叉堆
  const heap: { id: string; d: number }[] = [{ id: start, d: 0 }];
  const push = (id: string, d: number) => {
    heap.push({ id, d });
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].d <= heap[i].d) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): { id: string; d: number } | undefined => {
    if (heap.length === 0) return undefined;
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = i * 2 + 2;
        let m = i;
        if (l < heap.length && heap[l].d < heap[m].d) m = l;
        if (r < heap.length && heap[r].d < heap[m].d) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length > 0) {
    const { id, d } = pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const nb of g.adj.get(id) ?? []) {
      const nd = d + nb.timeMin;
      if (nd < (distMap.get(nb.to) ?? Infinity)) {
        distMap.set(nb.to, nd);
        push(nb.to, nd);
      }
    }
  }
  return distMap;
}

interface PossibleOrigin { point: Point; travelMin: number; }

/**
 * 在来源区域内找出与道路图连通、且能到达派遣站点的可能起点。
 * 包括：区域内道路节点 + 穿过区域的道路段上的采样点（按端点接入路网并加成行程）。
 */
export function findPossibleOrigins(
  region: Point[][],
  g: Graph,
  distFromStation: Map<string, number>
): { origins: PossibleOrigin[]; roadSamplePoints: number } {
  const inRegion = (p: Point) => region.some((poly) => pointInPolygon(p, poly));
  const origins: PossibleOrigin[] = [];
  let roadSamplePoints = 0;

  // 1) 区域内的道路节点
  for (const id of g.nodeIds) {
    const p = g.pos.get(id)!;
    if (!inRegion(p)) continue;
    const t = distFromStation.get(id);
    if (t == null || !Number.isFinite(t)) continue;
    origins.push({ point: { x: p.x, y: p.y }, travelMin: t });
  }

  // 2) 穿过区域的道路段内部采样点
  for (const e of g.edges) {
    if (e.blocked) continue;
    const pa = g.pos.get(e.a)!, pb = g.pos.get(e.b)!;
    const da = distFromStation.get(e.a) ?? Infinity;
    const db = distFromStation.get(e.b) ?? Infinity;
    if (!Number.isFinite(da) && !Number.isFinite(db)) continue;
    const steps = Math.max(1, Math.floor(e.lenM / ORIGIN_SAMPLE_STEP_M));
    for (let i = 1; i < steps; i++) {
      const f = i / steps;
      const p = { x: pa.x + (pb.x - pa.x) * f, y: pa.y + (pb.y - pa.y) * f };
      if (!inRegion(p)) continue;
      roadSamplePoints++;
      const tA = Number.isFinite(da) ? f * e.timeMin + da : Infinity;
      const tB = Number.isFinite(db) ? (1 - f) * e.timeMin + db : Infinity;
      const t = Math.min(tA, tB);
      if (!Number.isFinite(t)) continue;
      origins.push({ point: p, travelMin: t });
    }
  }
  return { origins, roadSamplePoints };
}

function regionDistance(p: Point, region: Point[][]): number {
  let best = Infinity;
  for (const poly of region) best = Math.min(best, pointPolygonDistance(p, poly));
  return best;
}

function districtAt(p: Point, s: GeoScenario): string | null {
  for (const d of s.districts) if (pointInPolygon(p, d.polygon)) return d.name;
  return null;
}

function populationAt(p: Point, s: GeoScenario) {
  for (const c of s.populationCells) if (pointInPolygon(p, c.polygon)) return c;
  return null;
}

/** 任意点接入最近道路节点后的行程时间（分钟） */
function travelFromPoint(p: Point, g: Graph, distFromStation: Map<string, number>): number | null {
  let best = Infinity;
  for (const id of g.nodeIds) {
    const t = distFromStation.get(id);
    if (t == null || !Number.isFinite(t)) continue;
    const accessMin = (dist(p, g.pos.get(id)!) / 1000) / ACCESS_SPEED_KMH * 60;
    best = Math.min(best, accessMin + t);
  }
  return Number.isFinite(best) ? best : null;
}

function representativeness(
  p: Point,
  district: string | null,
  allowedBands: PopulationBand[],
  s: GeoScenario
): { score: number; sameDistrict: boolean; band: PopulationBand | null; bandMatch: boolean } {
  const sameDistrict = district != null && districtAt(p, s) === district;
  const cell = populationAt(p, s);
  const band = cell?.band ?? null;
  const bandMatch = band != null && allowedBands.includes(band);
  let score = 0;
  if (sameDistrict) score += 0.5;
  if (bandMatch) score += 0.3;
  if (cell) score += 0.2 * Math.max(0, Math.min(1, cell.density));
  return { score, sameDistrict, band, bandMatch };
}

interface Candidate {
  point: Point;
  privacyDist: number;
  travelMin: number;
  worstDiff: number;
  representativeness: number;
  sameDistrict: boolean;
  band: PopulationBand | null;
  nodeId: string | null;
}

interface CandidateSearchResult {
  candidates: Candidate[];
  evaluated: number;
  distanceOk: number;
  travelOk: number;
}

function searchCandidates(
  strategy: LocationStrategy,
  region: Point[][],
  district: string | null,
  allowedBands: PopulationBand[],
  s: GeoScenario,
  g: Graph,
  distFromStation: Map<string, number>,
  lo: number,
  hi: number,
  cfg: LocationConfig,
  rng: Rng
): CandidateSearchResult {
  const result: CandidateSearchResult = { candidates: [], evaluated: 0, distanceOk: 0, travelOk: 0 };
  const tol = cfg.travelToleranceMin;
  const check = (p: Point, nodeId: string | null, travelMin: number | null) => {
    result.evaluated++;
    const privacyDist = regionDistance(p, region);
    // 距离下界按桶向下取整后仍须达到隐私门槛，保证发布值本身即满足门槛
    const bucket = floorToBucket(privacyDist, cfg.privacyBucketM);
    if (bucket < cfg.privacyMinDistanceM) return;
    result.distanceOk++;
    if (travelMin == null) return;
    const worstDiff = Math.max(Math.abs(travelMin - lo), Math.abs(travelMin - hi));
    if (worstDiff > tol) return;
    result.travelOk++;
    const rep = representativeness(p, district, allowedBands, s);
    result.candidates.push({ point: p, privacyDist, travelMin, worstDiff, representativeness: rep.score, sameDistrict: rep.sameDistrict, band: rep.band, nodeId });
  };

  if (strategy === 'road-node') {
    // 在道路节点上按可达时间与阻隔条件（封路已在图中排除）抽样
    const order = [...g.nodeIds];
    // 固定顺序 + 抖动，保证可复现
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const id of order) {
      const t = distFromStation.get(id);
      if (t == null || !Number.isFinite(t)) continue;
      const p = g.pos.get(id)!;
      if (cfg.sameDistrictOnly && district && districtAt(p, s) !== district) continue;
      check(p, id, t);
    }
  } else {
    // area：在行政区与人口带构造的面内网格枚举
    let bx: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
    if (district) {
      for (const d of s.districts) if (d.name === district) bx = polygonBounds(d.polygon);
    }
    if (!bx) {
      // 无行政区信息时退回区域外扩包围盒
      for (const poly of region) {
        const b = polygonBounds(poly);
        bx = bx ? { minX: Math.min(bx.minX, b.minX), minY: Math.min(bx.minY, b.minY), maxX: Math.max(bx.maxX, b.maxX), maxY: Math.max(bx.maxY, b.maxY) } : b;
      }
      if (bx) {
        const pad = cfg.privacyMinDistanceM * 2;
        bx = { minX: bx.minX - pad, minY: bx.minY - pad, maxX: bx.maxX + pad, maxY: bx.maxY + pad };
      }
    }
    if (!bx) return result;
    const step = Math.max(SEARCH_STEP_MIN_M, cfg.candidateGridM);
    for (let y = bx.minY; y <= bx.maxY; y += step) {
      for (let x = bx.minX; x <= bx.maxX; x += step) {
        const p = { x: x + (rng() - 0.5) * step * 0.4, y: y + (rng() - 0.5) * step * 0.4 };
        if (district) {
          let ok = false;
          for (const d of s.districts) if (d.name === district && pointInPolygon(p, d.polygon)) { ok = true; break; }
          if (!ok) continue;
        }
        // 人口带约束：若区域声明了人口带，则只取匹配人口带的格
        const cell = populationAt(p, s);
        if (allowedBands.length > 0 && allowedBands.length < 3) {
          if (!cell || !allowedBands.includes(cell.band)) continue;
        }
        check(p, null, travelFromPoint(p, g, distFromStation));
      }
    }
  }
  return result;
}

function pickBest(candidates: Candidate[], rng: Rng): Candidate | null {
  if (candidates.length === 0) return null;
  // 代表性优先，其次隐私距离更大者；同分用种子抖动保持确定性
  const jitter = new Map<Candidate, number>();
  for (const c of candidates) jitter.set(c, rng() * 1e-6);
  return [...candidates].sort((a, b) => {
    if (Math.abs(b.representativeness - a.representativeness) > 1e-9) return b.representativeness - a.representativeness;
    if (Math.abs(b.privacyDist - a.privacyDist) > 1e-9) return b.privacyDist - a.privacyDist;
    return (jitter.get(a) ?? 0) - (jitter.get(b) ?? 0);
  })[0];
}

function emptyPublished(ev: LocationEventInput, versionId: string): LocationEntryPublished {
  return {
    event_id: ev.event_id,
    district: ev.district,
    source_region_id: ev.regionId ?? '',
    status: 'unverifiable',
    reasons: [],
    reason_labels: [],
    privacy_distance_lb_bucket_m: null,
    possible_origin_count: null,
    station_id: null,
    station_name: ev.station ?? null,
    period_id: null,
    period_label: null,
    network_version: versionId,
    source_travel_min_min: null,
    source_travel_min_max: null,
    candidate_travel_min: null,
    worst_diff_min: null,
    synthetic_point: null,
    synthetic_address: null,
    population_band: null,
    same_district: null,
    representativeness: null
  };
}

function emptyAudit(): LocationEntryAudit {
  return {
    possible_origin_node_ids: [],
    possible_origin_count: 0,
    region_road_sample_points: 0,
    privacy_distance_raw_m: null,
    source_travel_raw_min: null,
    candidate_travel_raw_min: null,
    worst_diff_raw_min: null,
    candidate_node_id: null,
    candidate_reachable: false,
    station_node_id: null,
    candidates_evaluated: 0,
    candidates_distance_ok: 0,
    candidates_travel_ok: 0,
    rejection_notes: []
  };
}

function finalize(
  published: LocationEntryPublished,
  audit: LocationEntryAudit,
  status: LocationStatus,
  reasons: ReasonCode[],
  detailNotes: RejectionNote[] = []
): LocationEntry {
  published.status = status;
  published.reasons = reasons;
  published.reason_labels = reasons.map((r) => REASON_LABELS[r]);
  audit.rejection_notes = detailNotes.length > 0 ? detailNotes : reasons.map((r) => ({ code: r }));
  return { published, audit };
}

function resolveRegion(s: GeoScenario, ev: LocationEventInput, version: GeoVersion): { regionId: string; polygons: Point[][] } | { error: ReasonCode; detail: string } {
  // 事件显式声明 regionId 时以它为准（缺失即视为信息不足，不回退到行政区）；
  // 未声明时才按行政区匹配（来源批次事件到本场景的默认映射）。
  let region: SourceRegion | undefined;
  if (ev.regionId) {
    region = s.regions.find((r) => r.id === ev.regionId);
    if (!region) return { error: 'REGION_MISSING', detail: `未找到声明的来源区域「${ev.regionId}」` };
  } else {
    region = s.regions.find((r) => r.district === ev.district);
    if (!region) return { error: 'REGION_MISSING', detail: `未找到行政区「${ev.district}」的来源区域` };
  }
  const override = version.regionOverrides?.[region.id];
  const polygons = override ?? region.polygons;
  const validPolygons = polygons.filter((p) => p.length >= 3);
  if (validPolygons.length === 0) return { error: 'REGION_INVALID', detail: `区域 ${region.id} 无有效多边形` };
  // 退化面积检测
  const bounds = validPolygons.map((p) => polygonBounds(p));
  const area = bounds.reduce((acc, b) => acc + Math.max(0, (b.maxX - b.minX)) * Math.max(0, (b.maxY - b.minY)), 0);
  if (area <= 0) return { error: 'REGION_INVALID', detail: `区域 ${region.id} 面积为零` };
  return { regionId: region.id, polygons: validPolygons };
}

function resolveStation(s: GeoScenario, version: GeoVersion, name: string): { station: GeoStation; nodeId: string } | { error: ReasonCode; detail: string } {
  const station = s.stations.find((st) => st.name === name || st.id === name);
  if (!station) return { error: 'STATION_MISSING', detail: `场景未登记站点「${name}」` };
  const nodeId = version.stationNodes?.[station.id] ?? station.nodeId;
  return { station, nodeId };
}

/**
 * 生成单个事件的替代位置条目。
 * @param alarmHour 用于选择训练时段（0..23）
 */
export function generateEntry(
  s: GeoScenario,
  ev: LocationEventInput,
  versionId: string,
  alarmHour: number,
  cfg: LocationConfig,
  rng: Rng
): LocationEntry {
  const published = emptyPublished(ev, versionId);
  const audit = emptyAudit();

  const version = s.versions.find((v) => v.id === versionId);
  if (!version) return finalize(published, audit, 'unverifiable', ['NETWORK_VERSION_MISSING'], [{ code: 'NETWORK_VERSION_MISSING', detail: `场景无路网版本 ${versionId}` }]);

  const regionRes = resolveRegion(s, ev, version);
  if ('error' in regionRes) return finalize(published, audit, 'unverifiable', [regionRes.error], [{ code: regionRes.error, detail: regionRes.detail }]);
  const { regionId, polygons } = regionRes;
  published.source_region_id = regionId;

  const stationRes = resolveStation(s, version, ev.station);
  if ('error' in stationRes) return finalize(published, audit, 'unverifiable', [stationRes.error], [{ code: stationRes.error, detail: stationRes.detail }]);
  const { station, nodeId: stationNode } = stationRes;
  published.station_id = station.id;
  published.station_name = station.name;
  audit.station_node_id = stationNode;

  const period = s.periods.find((p) => p.hours.includes(alarmHour));
  if (!period) return finalize(published, audit, 'unverifiable', ['PERIOD_MISSING'], [{ code: 'PERIOD_MISSING', detail: `无覆盖 ${alarmHour} 时的训练时段` }]);
  published.period_id = period.id;
  published.period_label = period.label;

  if (!s.nodes.some((n) => n.id === stationNode)) {
    return finalize(published, audit, 'unverifiable', ['STATION_NOT_CONNECTED'], [{ code: 'STATION_NOT_CONNECTED', detail: `站点节点 ${stationNode} 不在路网中` }]);
  }

  const g = buildGraph(s, version, period);
  if (!g.valid) return finalize(published, audit, 'unverifiable', ['NETWORK_INVALID'], [{ code: 'NETWORK_INVALID', detail: '路网存在引用缺失节点的道路' }]);

  const distFromStation = dijkstra(g, stationNode);
  const reachableNodes = [...distFromStation.values()].filter((d) => Number.isFinite(d)).length;
  if (reachableNodes <= 1) {
    return finalize(published, audit, 'unverifiable', ['STATION_NOT_CONNECTED'], [{ code: 'STATION_NOT_CONNECTED', detail: `站点 ${station.name} 在当前路网/封路条件下孤立` }]);
  }

  // ---- 可能起点集合 ----
  const { origins, roadSamplePoints } = findPossibleOrigins(polygons, g, distFromStation);
  audit.region_road_sample_points = roadSamplePoints;
  audit.possible_origin_count = origins.length;
  audit.possible_origin_node_ids = origins.filter((o) => Number.isFinite(o.travelMin)).slice(0, 400).map((o) => `${o.point.x.toFixed(1)},${o.point.y.toFixed(1)}`);

  const allowedBands = s.regions.find((r) => r.id === regionId)?.populationBands ?? [];

  if (origins.length === 0) {
    return finalize(published, audit, 'not-generatable', ['NO_CONNECTED_ORIGINS'], [{ code: 'NO_CONNECTED_ORIGINS', detail: '区域内的道路均无法由派遣站点到达（可能跨路网断点/封闭）' }]);
  }

  const travels = origins.map((o) => o.travelMin);
  const lo = Math.min(...travels);
  const hi = Math.max(...travels);
  audit.source_travel_raw_min = { min: lo, max: hi };
  published.source_travel_min_min = Math.round(lo);
  published.source_travel_min_max = Math.round(hi);
  published.possible_origin_count = origins.length;

  if (origins.length < cfg.minPossibleOrigins) {
    return finalize(published, audit, 'not-generatable', ['PRIVACY_SET_TOO_SMALL'], [{ code: 'PRIVACY_SET_TOO_SMALL', detail: `可能起点仅 ${origins.length} 个，低于 k=${cfg.minPossibleOrigins}（稀疏乡村节点会缩小隐私集合）` }]);
  }

  // 必要条件：任何单点的最坏差值最小值为 (hi-lo)/2
  if ((hi - lo) / 2 > cfg.travelToleranceMin) {
    return finalize(published, audit, 'not-generatable', ['TRAVEL_RANGE_TOO_WIDE'], [{ code: 'TRAVEL_RANGE_TOO_WIDE', detail: `来源行程范围 ${lo.toFixed(1)}~${hi.toFixed(1)} 分，半宽 ${((hi - lo) / 2).toFixed(1)} 分 > 容差 ${cfg.travelToleranceMin} 分，任何单点都无法同时贴近全体可能起点` }]);
  }

  // ---- 候选搜索 ----
  const search = searchCandidates(
    cfg.strategy, polygons, ev.district, allowedBands, s, g, distFromStation, lo, hi, cfg, rng
  );
  audit.candidates_evaluated = search.evaluated;
  audit.candidates_distance_ok = search.distanceOk;
  audit.candidates_travel_ok = search.travelOk;

  const best = pickBest(search.candidates, rng);
  if (!best) {
    if (search.distanceOk === 0) {
      const code: ReasonCode = cfg.strategy === 'area' ? 'AREA_NO_CANDIDATE' : 'NO_CANDIDATE_DISTANCE';
      return finalize(published, audit, 'not-generatable', [code], [{ code, detail: `${cfg.strategy === 'area' ? '行政区/人口带' : '道路节点'}候选中无一点达到隐私距离下界 ${cfg.privacyMinDistanceM}m` }]);
    }
    const code: ReasonCode = cfg.strategy === 'area' ? 'AREA_NO_CANDIDATE' : 'NO_CANDIDATE_TRAVEL';
    return finalize(published, audit, 'not-generatable', [code], [{ code, detail: `有候选点达到隐私下界，但行程最坏差值均超过 ${cfg.travelToleranceMin} 分（跨河/绕桥导致可达时间不一致）` }]);
  }

  // ---- 发布（粗化） ----
  const bucket = floorToBucket(best.privacyDist, cfg.privacyBucketM);
  published.privacy_distance_lb_bucket_m = bucket;
  published.candidate_travel_min = Math.round(best.travelMin);
  published.worst_diff_min = Math.round(best.worstDiff);
  published.synthetic_point = { x: roundToGrid(best.point.x, cfg.candidateGridM), y: roundToGrid(best.point.y, cfg.candidateGridM) };
  published.population_band = best.band;
  published.same_district = best.sameDistrict;
  published.representativeness = Math.round(best.representativeness * 1000) / 1000;
  published.synthetic_address = `${ev.district}替代点-${ev.event_id.slice(-4).padStart(4, '0')}（演练）`;

  audit.privacy_distance_raw_m = best.privacyDist;
  audit.candidate_travel_raw_min = best.travelMin;
  audit.worst_diff_raw_min = best.worstDiff;
  audit.candidate_node_id = best.nodeId;
  audit.candidate_reachable = true;

  return finalize(published, audit, 'generatable', ['OK'], []);
}

/** 校验场景结构，返回致命问题列表（用于全局不可验证判定） */
export function validateScenario(s: GeoScenario): string[] {
  const issues: string[] = [];
  const nodeIds = new Set(s.nodes.map((n) => n.id));
  for (const e of s.edges) {
    if (!nodeIds.has(e.a) || !nodeIds.has(e.b)) issues.push(`道路 ${e.id} 引用了不存在的节点`);
    if (!(e.speedKmh > 0)) issues.push(`道路 ${e.id} 速度非法`);
  }
  for (const st of s.stations) if (!nodeIds.has(st.nodeId)) issues.push(`站点 ${st.name} 的节点不在路网中`);
  if (s.periods.length === 0) issues.push('缺少训练时段');
  if (s.versions.length === 0) issues.push('缺少路网版本');
  return issues;
}

export function summarize(entries: LocationEntry[]): LocationSummary {
  const byReason: Partial<Record<ReasonCode, number>> = {};
  const byDistrict: Record<string, { total: number; generatable: number }> = {};
  let generatable = 0, notGeneratable = 0, unverifiable = 0;
  for (const e of entries) {
    const d = e.published.district;
    byDistrict[d] = byDistrict[d] ?? { total: 0, generatable: 0 };
    byDistrict[d].total++;
    if (e.published.status === 'generatable') { generatable++; byDistrict[d].generatable++; }
    else if (e.published.status === 'not-generatable') notGeneratable++;
    else unverifiable++;
    for (const r of e.published.reasons) byReason[r] = (byReason[r] ?? 0) + 1;
  }
  return { total: entries.length, generatable, notGeneratable, unverifiable, byReason, byDistrict };
}

export function alarmHourOf(alarmTime: string): number {
  const h = Number(alarmTime.slice(11, 13));
  return Number.isFinite(h) ? h : 0;
}

/** 主入口：对一个场景 + 事件列表生成全部条目 */
export function generateLocationEntries(
  s: GeoScenario,
  events: LocationEventInput[],
  versionId: string,
  cfg: LocationConfig
): LocationResult {
  const entries: LocationEntry[] = [];
  for (const ev of events) {
    // 每个事件使用独立的确定性 RNG，保证单事件结果不受事件顺序影响
    const evRng = mulberry32((cfg.seed ^ hashStr(ev.event_id)) >>> 0);
    entries.push(generateEntry(s, ev, versionId, alarmHourOf(ev.alarm_time), cfg, evRng));
  }
  return assembleResult(s, entries, versionId, cfg);
}

/** 由已生成的条目组装结果（供分批生成后汇总） */
export function assembleResult(
  s: GeoScenario,
  entries: LocationEntry[],
  versionId: string,
  cfg: LocationConfig
): LocationResult {
  const summary = summarize(entries);
  return {
    meta: {
      packageId: '',
      versionTag: '',
      scenarioId: s.id,
      scenarioName: s.name,
      revisions: { ...s.revisions },
      networkVersion: versionId,
      periodScope: s.periods.map((p) => p.id),
      graphHash: '',
      stationHash: '',
      regionHash: '',
      strategy: cfg.strategy,
      config: cfg,
      generatedAt: ''
    },
    coordinateNote: s.coordinateNote,
    summary,
    entries,
    disclaimer: buildDisclaimer()
  };
}

export function buildDisclaimer(): string {
  return (
    '训练包仅包含合成点、距离下界（粗化到桶）、行程区间与可生成依据；' +
    '不包含原始坐标、可能起点坐标或可反推出原点的细粒度距离。' +
    '“距离下界”是候选点到整个可能来源区域（覆盖真实原点的几何范围）的最小直线距离，' +
    '按桶向下取整发布，仅用于训练题的隐私难度标定。'
  );
}

function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
