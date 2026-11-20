// 替代位置生成：类型定义。
// 背景：主任务样例只给出事件的粗粒度来源区域（行政区），不含可计算的精确原点。
// 本模块把该区域解释为覆盖真实原点的几何范围，在范围内找出与道路图连通的可能起点，
// 用“候选点到可能来源集合的最小直线距离下界”衡量隐私，用“可能起点→派遣站点的行程时间范围”衡量可达性。
// 所有坐标均为本地平面米制坐标，不含任何真实经纬度。

import type { Point } from './geo';

export type PopulationBand = 'high' | 'medium' | 'low';

export interface GeoNode { id: string; x: number; y: number; }

export interface GeoEdge {
  id: string;
  a: string;
  b: string;
  speedKmh: number;
  bridge?: boolean;
  name?: string;
}

export interface GeoStation { id: string; name: string; nodeId: string; }

export interface GeoPeriod {
  id: string;
  label: string;
  speedFactor: number;
  hours: number[];       // 该时段覆盖的 0..23 小时
}

export interface GeoVersion {
  id: string;
  label: string;
  blockedEdges: string[];              // 本版本封闭的道路（封路/桥隧维护）
  stationNodes?: Record<string, string>; // 站点迁移：站点 -> 新节点
  regionOverrides?: Record<string, Point[][]>; // 来源区域修订：区域 -> 新几何
  note?: string;
}

export interface PopulationCell {
  id: string;
  polygon: Point[];
  band: PopulationBand;
  density: number;       // 相对人口密度（仅用于展示/代表性，不用于冒充原点）
}

export interface SourceRegion {
  id: string;
  district: string;
  polygons: Point[][];
  populationBands: PopulationBand[];
  label: string;
}

export interface DistrictGeo { name: string; polygon: Point[]; }

export interface ScenarioSampleEvent {
  event_id: string;
  district: string;
  alarm_time: string;   // 'YYYY-MM-DD HH:mm:ss'
  station: string;      // 站点名称（与 stations[].name 对应）
  regionId?: string;
}

export interface GeoScenario {
  id: string;
  name: string;
  description: string;
  coordinateNote: string;
  nodes: GeoNode[];
  edges: GeoEdge[];
  rivers: { name: string; points: Point[] }[];
  districts: DistrictGeo[];
  regions: SourceRegion[];
  populationCells: PopulationCell[];
  stations: GeoStation[];
  districtStations?: Record<string, string>; // 行政区 -> 默认派遣站点名称（把来源批次事件映射到本场景）
  versions: GeoVersion[];
  defaultVersion: string;
  periods: GeoPeriod[];
  revisions: { network: number; stations: number; regions: number };
  sampleEvents?: ScenarioSampleEvent[];
}

export interface GeoScenarioFile { version: string; generatedBy: string; scenarios: GeoScenario[]; }

// ---------- 生成输入 ----------
export interface LocationEventInput {
  event_id: string;
  district: string;
  alarm_time: string;
  station: string;         // 事件实际派遣站点的名称
  regionId?: string;
}

export type LocationStrategy = 'area' | 'road-node';

export interface LocationConfig {
  strategy: LocationStrategy;
  privacyMinDistanceM: number;   // 隐私距离门槛（候选点到可能来源集合的最小距离下界下限）
  privacyBucketM: number;        // 发布距离下界时向下取整的桶宽（防细粒度反推）
  travelToleranceMin: number;    // 与来源行程时间范围最坏差值的容差
  minPossibleOrigins: number;    // 可能起点集合最小规模 k（隐私集合不足即拒绝）
  candidateGridM: number;        // 合成点坐标发布网格
  seed: number;
  sameDistrictOnly: boolean;     // 面积策略下是否只取同行政区候选
}

export const DEFAULT_LOCATION_CONFIG: LocationConfig = {
  strategy: 'road-node',
  privacyMinDistanceM: 500,
  privacyBucketM: 50,
  travelToleranceMin: 8,
  minPossibleOrigins: 3,
  candidateGridM: 25,
  seed: 20251120,
  sameDistrictOnly: false
};

// ---------- 结果 ----------
export type LocationStatus = 'generatable' | 'not-generatable' | 'unverifiable';

export type ReasonCode =
  | 'REGION_MISSING'
  | 'REGION_INVALID'
  | 'STATION_MISSING'
  | 'STATION_NOT_CONNECTED'
  | 'NETWORK_INVALID'
  | 'NETWORK_VERSION_MISSING'
  | 'PERIOD_MISSING'
  | 'NO_CONNECTED_ORIGINS'
  | 'PRIVACY_SET_TOO_SMALL'
  | 'TRAVEL_RANGE_TOO_WIDE'
  | 'NO_CANDIDATE_DISTANCE'
  | 'NO_CANDIDATE_TRAVEL'
  | 'AREA_NO_CANDIDATE'
  | 'OK';

export const REASON_LABELS: Record<ReasonCode, string> = {
  REGION_MISSING: '找不到该事件的来源区域',
  REGION_INVALID: '来源区域边界无效（少于 3 个顶点或面积为零），无法形成几何范围',
  STATION_MISSING: '派遣站点信息缺失或未在场景中登记',
  STATION_NOT_CONNECTED: '派遣站点未接入当前路网版本',
  NETWORK_INVALID: '路网版本数据无效（道路引用了不存在的节点）',
  NETWORK_VERSION_MISSING: '路网版本不存在',
  PERIOD_MISSING: '训练时段缺失或未覆盖报警小时',
  NO_CONNECTED_ORIGINS: '区域内没有与道路图连通、可由派遣站点到达的可能起点',
  PRIVACY_SET_TOO_SMALL: '可能起点集合规模低于隐私门槛 k',
  TRAVEL_RANGE_TOO_WIDE: '来源行程时间范围过宽，任何单点都无法同时满足最坏差值容差',
  NO_CANDIDATE_DISTANCE: '无候选点满足隐私距离下界',
  NO_CANDIDATE_TRAVEL: '有候选点满足距离下界，但无候选点落在行程时间容差内',
  AREA_NO_CANDIDATE: '行政区/人口带候选面中没有同时满足距离与行程容差的点',
  OK: '满足隐私距离下界与最坏差值容差'
};

export interface RejectionNote { code: ReasonCode; detail?: string; }

/** 可写进训练包的字段（不含原始点、不含可反推原点的细粒度距离） */
export interface LocationEntryPublished {
  event_id: string;
  district: string;
  source_region_id: string;
  status: LocationStatus;
  reasons: ReasonCode[];
  reason_labels: string[];
  privacy_distance_lb_bucket_m: number | null; // 向下取整的粗粒度距离下界
  possible_origin_count: number | null;
  station_id: string | null;
  station_name: string | null;
  period_id: string | null;
  period_label: string | null;
  network_version: string;
  source_travel_min_min: number | null;  // 可能起点→站点行程范围下界（整数分钟）
  source_travel_min_max: number | null;  // 上界
  candidate_travel_min: number | null;   // 候选点→站点行程（整数分钟）
  worst_diff_min: number | null;         // 最坏差值（整数分钟）
  synthetic_point: { x: number; y: number } | null;
  synthetic_address: string | null;
  population_band: PopulationBand | null;
  same_district: boolean | null;
  representativeness: number | null;     // 0..1
}

/** 内部审计视图（仅界面核对，永不进入导出包） */
export interface LocationEntryAudit {
  possible_origin_node_ids: string[];
  possible_origin_count: number;
  region_road_sample_points: number;
  privacy_distance_raw_m: number | null;
  source_travel_raw_min: { min: number; max: number } | null;
  candidate_travel_raw_min: number | null;
  worst_diff_raw_min: number | null;
  candidate_node_id: string | null;
  candidate_reachable: boolean;
  station_node_id: string | null;
  candidates_evaluated: number;
  candidates_distance_ok: number;
  candidates_travel_ok: number;
  rejection_notes: RejectionNote[];
}

export interface LocationEntry {
  published: LocationEntryPublished;
  audit: LocationEntryAudit;
}

export interface LocationSummary {
  total: number;
  generatable: number;
  notGeneratable: number;
  unverifiable: number;
  byReason: Partial<Record<ReasonCode, number>>;
  byDistrict: Record<string, { total: number; generatable: number }>;
}

export interface LocationPackageMeta {
  packageId: string;
  versionTag: string;
  scenarioId: string;
  scenarioName: string;
  revisions: { network: number; stations: number; regions: number };
  networkVersion: string;
  periodScope: string[];
  graphHash: string;
  stationHash: string;
  regionHash: string;
  strategy: LocationStrategy;
  config: LocationConfig;
  generatedAt: string;
}

export interface LocationPackage extends LocationPackageMeta {
  coordinateNote: string;
  summary: LocationSummary;
  entries: LocationEntryPublished[];
  disclaimer: string;
  packageHash: string;
}

/** 生成运行的完整结果（含内部审计，仅供界面/测试核对，导出前剥离） */
export interface LocationResult {
  meta: LocationPackageMeta;
  coordinateNote: string;
  summary: LocationSummary;
  entries: LocationEntry[];
  disclaimer: string;
}
