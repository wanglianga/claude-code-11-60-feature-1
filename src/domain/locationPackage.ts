// 训练包封装与版本化：对 LocationResult 计算内容哈希、生成发布包（剥离审计）、
// 以及版本标签（路网/站点/来源区域修订，或配置变更都会产生新版本）。

import type { LocationResult, LocationPackage, LocationEntryPublished } from './locationTypes';
import { hashObject } from './hash';

/** 仅保留可发布字段；确保条目里不含 audit / 原始点 / 细粒度距离 */
export function toPublished(result: LocationResult): LocationEntryPublished[] {
  // LocationResult.entries[].published 已是可发布字段集合；这里再做一次白名单投影防止误带审计字段
  return result.entries.map((e) => {
    const p = e.published;
    return {
      event_id: p.event_id,
      district: p.district,
      source_region_id: p.source_region_id,
      status: p.status,
      reasons: [...p.reasons],
      reason_labels: [...p.reason_labels],
      privacy_distance_lb_bucket_m: p.privacy_distance_lb_bucket_m,
      possible_origin_count: p.possible_origin_count,
      station_id: p.station_id,
      station_name: p.station_name,
      period_id: p.period_id,
      period_label: p.period_label,
      network_version: p.network_version,
      source_travel_min_min: p.source_travel_min_min,
      source_travel_min_max: p.source_travel_min_max,
      candidate_travel_min: p.candidate_travel_min,
      worst_diff_min: p.worst_diff_min,
      synthetic_point: p.synthetic_point ? { x: p.synthetic_point.x, y: p.synthetic_point.y } : null,
      synthetic_address: p.synthetic_address,
      population_band: p.population_band,
      same_district: p.same_district,
      representativeness: p.representativeness
    };
  });
}

export function versionTagOf(result: LocationResult): string {
  const r = result.meta.revisions;
  // 版本标签同时包含修订三元组与具体路网版本 id：
  // 道路图结构修订（revisions.network）、站点迁移、来源区域修订、封路（networkVersion）都会改变标签。
  return `${result.meta.networkVersion}.net-r${r.network}.st-r${r.stations}.rg-r${r.regions}.${result.meta.strategy}.s${result.meta.config.seed}`;
}

/** 组装发布包：附带各输入哈希 + 版本标签 + 包内容哈希（可复现回查） */
export async function buildPackage(result: LocationResult): Promise<LocationPackage> {
  const entries = toPublished(result);
  const versionTag = versionTagOf(result);
  const packageId = await hashObject({
    scenarioId: result.meta.scenarioId,
    networkVersion: result.meta.networkVersion,
    versionTag,
    strategy: result.meta.strategy,
    config: result.meta.config,
    entries: entries.map((e) => e.event_id)
  });
  const meta = {
    ...result.meta,
    packageId: `LP-${packageId.slice(0, 10)}`,
    versionTag
  };
  const body = {
    ...meta,
    coordinateNote: result.coordinateNote,
    summary: result.summary,
    entries,
    disclaimer: result.disclaimer
  };
  const packageHash = await hashObject(body);
  return { ...body, packageHash };
}

/** 发布包内容检查：确认不含原始点/细粒度距离字段（仅白名单字段） */
export function assertPublishSafe(pkg: LocationPackage): string[] {
  const problems: string[] = [];
  const allowed = new Set([
    'event_id', 'district', 'source_region_id', 'status', 'reasons', 'reason_labels',
    'privacy_distance_lb_bucket_m', 'possible_origin_count', 'station_id', 'station_name',
    'period_id', 'period_label', 'network_version', 'source_travel_min_min', 'source_travel_min_max',
    'candidate_travel_min', 'worst_diff_min', 'synthetic_point', 'synthetic_address',
    'population_band', 'same_district', 'representativeness'
  ]);
  const forbidden = ['audit', 'possible_origin_node_ids', 'privacy_distance_raw_m', 'candidate_node_id', 'region', 'origin', 'raw'];
  pkg.entries.forEach((e, i) => {
    for (const k of Object.keys(e)) {
      if (!allowed.has(k)) problems.push(`条目 ${i} 含非发布字段 ${k}`);
    }
    for (const f of forbidden) {
      if (JSON.stringify(e).includes(`"${f}"`)) problems.push(`条目 ${i} 疑似含 ${f}`);
    }
  });
  if (!/桶|下界/.test(pkg.disclaimer)) problems.push('缺少距离下界说明');
  return problems;
}
