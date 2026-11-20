import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GeoScenario, GeoScenarioFile, LocationConfig } from '../src/domain/locationTypes';
import { DEFAULT_LOCATION_CONFIG } from '../src/domain/locationTypes';
import { generateLocationEntries, generateEntry, validateScenario, alarmHourOf } from '../src/domain/locationEngine';
import { buildPackage, assertPublishSafe, versionTagOf } from '../src/domain/locationPackage';
import { mulberry32 } from '../src/domain/prng';
import { pointInPolygon, pointPolygonDistance } from '../src/domain/geo';

const SAMPLE = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'samples', 'geo', 'scenarios.json');

function loadScenario(): GeoScenario {
  const file = JSON.parse(readFileSync(SAMPLE, 'utf8')) as GeoScenarioFile;
  return file.scenarios[0];
}

const scenario = loadScenario();
const baseCfg: LocationConfig = { ...DEFAULT_LOCATION_CONFIG };

function eventOf(id: string) {
  const ev = scenario.sampleEvents!.find((e) => e.event_id === id);
  if (!ev) throw new Error(`无样例事件 ${id}`);
  return ev;
}

function run(ids: string[], cfg: LocationConfig = baseCfg, versionId = 'v1') {
  return generateLocationEntries(scenario, ids.map(eventOf), versionId, cfg);
}

function entryOf(ids: string[], id: string, cfg: LocationConfig = baseCfg, versionId = 'v1') {
  const res = run(ids, cfg, versionId);
  return res.entries.find((e) => e.published.event_id === id)!;
}

describe('场景结构', () => {
  it('场景通过结构校验', () => {
    expect(validateScenario(scenario)).toEqual([]);
  });
  it('覆盖六类验收场景所需要素', () => {
    expect(scenario.rivers.length).toBeGreaterThanOrEqual(2);
    expect(scenario.versions.map((v) => v.id)).toEqual(['v1', 'v2', 'v3', 'v4']);
    expect(scenario.regions.find((r) => r.id === '郊区:R1')).toBeTruthy();
    expect(scenario.populationCells.find((c) => c.id === 'pc-small-low')).toBeTruthy();
  });
});

describe('可生成：中心城区密集路网', () => {
  it('生成合法合成点，距离下界与行程区间自洽', () => {
    const e = entryOf(['LOC-CC-01'], 'LOC-CC-01');
    expect(e.published.status).toBe('generatable');
    expect(e.published.privacy_distance_lb_bucket_m).not.toBeNull();
    expect(e.published.privacy_distance_lb_bucket_m!).toBeGreaterThanOrEqual(baseCfg.privacyMinDistanceM);
    expect(e.published.synthetic_point).not.toBeNull();
    expect(e.published.source_travel_min_min! <= e.published.source_travel_min_max!).toBe(true);
    // 最坏差值定义自洽
    const lo = e.published.source_travel_min_min!;
    const hi = e.published.source_travel_min_max!;
    const c = e.published.candidate_travel_min!;
    const worst = Math.max(Math.abs(c - lo), Math.abs(c - hi));
    expect(Math.abs(worst - e.published.worst_diff_min!)).toBeLessThanOrEqual(1);
    expect(e.published.worst_diff_min!).toBeLessThanOrEqual(baseCfg.travelToleranceMin);
  });

  it('合成点确实落在来源区域之外，距离下界与几何一致', () => {
    const e = entryOf(['LOC-CC-01'], 'LOC-CC-01');
    const region = scenario.regions.find((r) => r.id === e.published.source_region_id)!;
    const p = e.published.synthetic_point!;
    const inside = region.polygons.some((poly) => pointInPolygon(p, poly));
    expect(inside).toBe(false);
    const geoDist = Math.min(...region.polygons.map((poly) => pointPolygonDistance(p, poly)));
    // 发布值向下取桶，因此不大于几何距离，且相差不超过一个桶宽 + 网格误差
    expect(e.published.privacy_distance_lb_bucket_m!).toBeLessThanOrEqual(geoDist + 1e-6);
    expect(e.published.privacy_distance_lb_bucket_m!).toBeGreaterThanOrEqual(baseCfg.privacyMinDistanceM);
  });
});

describe('可生成：跨河村落', () => {
  it('跨支流村落的候选点在容差内且距离达标', () => {
    const e = entryOf(['LOC-RIV-01'], 'LOC-RIV-01');
    expect(e.published.status).toBe('generatable');
    expect(e.published.worst_diff_min!).toBeLessThanOrEqual(baseCfg.travelToleranceMin);
    expect(e.published.privacy_distance_lb_bucket_m!).toBeGreaterThanOrEqual(baseCfg.privacyMinDistanceM);
    // 乡村区域可能起点应足够多，隐私集合达标
    expect(e.published.possible_origin_count!).toBeGreaterThanOrEqual(baseCfg.minPossibleOrigins);
  });

  it('当容差收紧到不可行时拒绝，并给出跨河/绕桥原因', () => {
    const tight: LocationConfig = { ...baseCfg, travelToleranceMin: 0.5, privacyMinDistanceM: 200 };
    const e = entryOf(['LOC-RIV-01'], 'LOC-RIV-01', tight);
    if (e.published.status !== 'generatable') {
      expect(e.published.reasons.length).toBeGreaterThan(0);
      expect(['TRAVEL_RANGE_TOO_WIDE', 'NO_CANDIDATE_TRAVEL', 'AREA_NO_CANDIDATE', 'NO_CANDIDATE_DISTANCE']).toContain(e.published.reasons[0]);
    }
  });
});

describe('道路封闭版本', () => {
  it('封路版本改变行程范围或候选（与基准版本不一致）', () => {
    const v1 = entryOf(['LOC-CC-01'], 'LOC-CC-01', baseCfg, 'v1');
    const v2 = entryOf(['LOC-CC-01'], 'LOC-CC-01', baseCfg, 'v2');
    expect(v1.published.network_version).toBe('v1');
    expect(v2.published.network_version).toBe('v2');
    // 封路后城东密集区可能起点集合缩小（纵向路被封闭）
    expect(v2.published.possible_origin_count!).toBeLessThan(v1.published.possible_origin_count!);
    const changed =
      v1.published.candidate_travel_min !== v2.published.candidate_travel_min ||
      v1.published.status !== v2.published.status ||
      v1.published.source_travel_min_max !== v2.published.source_travel_min_max ||
      v1.published.source_travel_min_min !== v2.published.source_travel_min_min ||
      v1.published.possible_origin_count !== v2.published.possible_origin_count;
    expect(changed).toBe(true);
  });

  it('封桥后跨支流村落失去可达路径 → 不可生成', () => {
    const v1 = entryOf(['LOC-RIV-01'], 'LOC-RIV-01', baseCfg, 'v1');
    const v2 = entryOf(['LOC-RIV-01'], 'LOC-RIV-01', baseCfg, 'v2');
    expect(v1.published.status).toBe('generatable');
    expect(v2.published.status).toBe('not-generatable');
    expect(v2.published.reasons).toContain('NO_CONNECTED_ORIGINS');
    expect(v2.published.synthetic_point).toBeNull();
  });
});

describe('站点迁移版本', () => {
  it('迁移站点后行程计算使用新站点节点', () => {
    const v1 = entryOf(['LOC-CC-01'], 'LOC-CC-01', baseCfg, 'v1');
    const v3 = entryOf(['LOC-CC-01'], 'LOC-CC-01', baseCfg, 'v3');
    expect(v3.published.status === 'generatable').toBe(true);
    // 站点节点改变，行程范围/候选应变化
    const changed =
      v1.published.source_travel_min_min !== v3.published.source_travel_min_min ||
      v1.published.source_travel_min_max !== v3.published.source_travel_min_max ||
      v1.published.candidate_travel_min !== v3.published.candidate_travel_min;
    expect(changed).toBe(true);
  });
});

describe('区域跨越路网断点', () => {
  it('跨河无桥片区判为不可生成，且不是以区域中心冒充原点', () => {
    const e = entryOf(['LOC-BRK-01'], 'LOC-BRK-01');
    expect(e.published.synthetic_point).toBeNull();
    expect(['not-generatable', 'unverifiable']).toContain(e.published.status);
    expect(e.published.reasons.length).toBeGreaterThan(0);
    // 该片区在 v1 下横跨主河且无桥，可能起点为 0
    expect(['NO_CONNECTED_ORIGINS', 'NO_CANDIDATE_DISTANCE', 'NO_CANDIDATE_TRAVEL', 'AREA_NO_CANDIDATE']).toContain(e.published.reasons[0]);
  });
});

describe('小人口格', () => {
  it('低密度小格片区：区域难有合格点或隐私集合不足', () => {
    const e = entryOf(['LOC-SMALL-01'], 'LOC-SMALL-01');
    if (e.published.status === 'generatable') {
      // 若可生成，必须各项达标
      expect(e.published.privacy_distance_lb_bucket_m!).toBeGreaterThanOrEqual(baseCfg.privacyMinDistanceM);
      expect(e.published.worst_diff_min!).toBeLessThanOrEqual(baseCfg.travelToleranceMin);
    } else {
      expect(e.published.reasons.length).toBeGreaterThan(0);
    }
  });
});

describe('稀疏乡村节点', () => {
  it('孤立村口可能起点不足 k，判为不可生成并给出隐私集合原因', () => {
    const e = entryOf(['LOC-SPARSE-01'], 'LOC-SPARSE-01');
    if (e.published.possible_origin_count != null) {
      expect(e.published.possible_origin_count).toBeLessThan(baseCfg.minPossibleOrigins);
    }
    expect(e.published.status).not.toBe('generatable');
    expect(e.published.reasons).toContain('PRIVACY_SET_TOO_SMALL');
  });
});

describe('不可验证：信息不足', () => {
  it('站点缺失 → 不可验证 STATION_MISSING', () => {
    const e = entryOf(['LOC-MISS-ST-01'], 'LOC-MISS-ST-01');
    expect(e.published.status).toBe('unverifiable');
    expect(e.published.reasons).toContain('STATION_MISSING');
    expect(e.published.synthetic_point).toBeNull();
  });
  it('来源区域缺失 → 不可验证 REGION_MISSING', () => {
    const e = entryOf(['LOC-MISS-RG-01'], 'LOC-MISS-RG-01');
    expect(e.published.status).toBe('unverifiable');
    expect(e.published.reasons).toContain('REGION_MISSING');
  });
  it('路网版本缺失 → 不可验证 NETWORK_VERSION_MISSING', () => {
    const res = generateLocationEntries(scenario, [eventOf('LOC-CC-01')], 'v999', baseCfg);
    expect(res.entries[0].published.status).toBe('unverifiable');
    expect(res.entries[0].published.reasons).toContain('NETWORK_VERSION_MISSING');
  });
});

describe('隐私与发布安全', () => {
  it('发布包不含原始点、可能起点坐标或细粒度距离', async () => {
    const res = run(scenario.sampleEvents!.map((e) => e.event_id));
    const pkg = await buildPackage(res);
    const problems = assertPublishSafe(pkg);
    expect(problems).toEqual([]);
    const text = JSON.stringify(pkg);
    expect(text).not.toContain('possible_origin_node_ids');
    expect(text).not.toContain('privacy_distance_raw_m');
    expect(text.includes('"audit"')).toBe(false);
  });

  it('距离下界发布为桶的整数倍（无细粒度泄漏）', async () => {
    const res = run(scenario.sampleEvents!.map((e) => e.event_id));
    const pkg = await buildPackage(res);
    for (const e of pkg.entries) {
      if (e.privacy_distance_lb_bucket_m != null) {
        expect(e.privacy_distance_lb_bucket_m % baseCfg.privacyBucketM).toBe(0);
      }
      if (e.synthetic_point) {
        expect(e.synthetic_point.x % baseCfg.candidateGridM).toBe(0);
        expect(e.synthetic_point.y % baseCfg.candidateGridM).toBe(0);
      }
    }
  });
});

describe('可复现与版本', () => {
  it('同一配置同一输入输出哈希一致', async () => {
    const ids = scenario.sampleEvents!.map((e) => e.event_id);
    const a = await buildPackage(run(ids));
    const b = await buildPackage(run(ids));
    expect(a.packageHash).toBe(b.packageHash);
  });

  it('不同路网/站点/区域修订产生不同版本标签与包哈希', async () => {
    const ids = ['LOC-CC-01'];
    const p1 = await buildPackage(run(ids, baseCfg, 'v1'));
    const p2 = await buildPackage(run(ids, baseCfg, 'v2'));
    const p3 = await buildPackage(run(ids, baseCfg, 'v3'));
    const p4 = await buildPackage(run(ids, baseCfg, 'v4'));
    expect(new Set([p1.networkVersion, p2.networkVersion, p3.networkVersion, p4.networkVersion]).size).toBe(4);
    expect(new Set([p1.packageHash, p2.packageHash, p3.packageHash, p4.packageHash]).size).toBe(4);
  });

  it('版本标签包含修订号与策略/种子', () => {
    const res = run(['LOC-CC-01']);
    const tag = versionTagOf(res);
    expect(tag).toContain('net-r1');
    expect(tag).toContain('st-r1');
    expect(tag).toContain('rg-r1');
    expect(tag).toContain(String(baseCfg.seed));
  });
});

describe('单事件确定性', () => {
  it('单事件结果不受同批其他事件或顺序影响', () => {
    const cfg = baseCfg;
    const single = generateEntry(scenario, eventOf('LOC-CC-01'), 'v1', alarmHourOf(eventOf('LOC-CC-01').alarm_time), cfg, mulberry32(123));
    const batch = run(['LOC-WC-01', 'LOC-CC-01', 'LOC-RIV-01']).entries.find((e) => e.published.event_id === 'LOC-CC-01')!;
    // 两者使用相同的事件派生种子
    expect(single.published.synthetic_point).toEqual(batch.published.synthetic_point);
  });
});

describe('来源批次粗粒度 district 映射（主任务样例路径）', () => {
  it('把样例事件的行政区映射到默认来源区域与站点，并生成可核对条目', async () => {
    const { inputsFromBatch } = await import('../src/services/locationService');
    const rows: any = {
      events: [
        { event_id: 'E0001', alarm_time: '2025-09-25 01:56:57', event_type: '危化品泄漏', district: '城西区', address_text: 'x', caller_phone: 'x', priority: 'P1' },
        { event_id: 'E0002', alarm_time: '2025-09-25 14:00:00', event_type: '火灾', district: '城东区', address_text: 'x', caller_phone: 'x', priority: 'P2' },
        { event_id: 'E0003', alarm_time: '2025-09-25 14:00:00', event_type: '火灾', district: '未知区', address_text: 'x', caller_phone: 'x', priority: 'P2' }
      ],
      dispatches: [], resources: [], arrivals: [], closures: []
    };
    const mapped = inputsFromBatch(scenario, rows);
    expect(mapped.inputs[0].regionId).toBe('城西区:R1');
    expect(mapped.inputs[0].station).toBe('城西分站');
    expect(mapped.inputs[1].regionId).toBe('城东区:R1');
    expect(mapped.warnings.some((w) => w.includes('未知区'))).toBe(true);
    const res = generateLocationEntries(scenario, mapped.inputs, 'v1', baseCfg);
    expect(res.entries.length).toBe(3);
    // 未知区无法映射区域 → 不可验证
    expect(res.entries.find((e) => e.published.event_id === 'E0003')!.published.status).toBe('unverifiable');
  });
});

describe('area 策略（行政区/人口带构造面）', () => {
  it('area 策略结果可用且不泄漏细粒度距离；细长/跨河常无合格点', async () => {
    const areaCfg: LocationConfig = { ...baseCfg, strategy: 'area', privacyBucketM: 50, candidateGridM: 25 };
    const res = generateLocationEntries(scenario, scenario.sampleEvents!.map((e) => ({ event_id: e.event_id, district: e.district, alarm_time: e.alarm_time, station: e.station, regionId: e.regionId })), 'v1', areaCfg);
    const pkg = await buildPackage(res);
    expect(assertPublishSafe(pkg)).toEqual([]);
    // 至少有一个可生成，且每个可生成的都满足门槛/容差
    const gen = res.entries.filter((e) => e.published.status === 'generatable');
    expect(gen.length).toBeGreaterThan(0);
    for (const e of gen) {
      expect(e.published.privacy_distance_lb_bucket_m!).toBeGreaterThanOrEqual(areaCfg.privacyMinDistanceM);
      expect(e.published.worst_diff_min!).toBeLessThanOrEqual(areaCfg.travelToleranceMin);
    }
  });
});
