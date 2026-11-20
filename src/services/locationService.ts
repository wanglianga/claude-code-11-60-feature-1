// 替代位置生成编排：加载场景 -> 组装事件（来自主任务样例的粗粒度 district，或场景内置样例事件）
// -> 在 WebWorker 中生成 -> 计算发布包与版本 -> 落库。
// 生成期间记录路网/站点/来源区域修订快照；任一修订都会产生新的版本标签与包哈希。

import { db, nextSeq } from '../db/db';
import type { LocationRunRow } from '../db/db';
import type {
  GeoScenario, GeoScenarioFile, LocationConfig, LocationEventInput, LocationResult
} from '../domain/locationTypes';import { generateLocationEntries, validateScenario } from '../domain/locationEngine';
import { buildPackage, assertPublishSafe, versionTagOf } from '../domain/locationPackage';
import { hashObject } from '../domain/hash';
import type { TableRows } from '../domain/types';

const SAMPLE_URL = `${import.meta.env.BASE_URL}samples/geo/scenarios.json`;

export async function loadScenarios(): Promise<GeoScenario[]> {
  const res = await fetch(SAMPLE_URL);
  if (!res.ok) throw new Error(`无法加载地理场景样例: HTTP ${res.status}`);
  const file = (await res.json()) as GeoScenarioFile;
  return file.scenarios;
}

export interface ScenarioInputs {
  scenario: GeoScenario;
  inputs: LocationEventInput[];
  inputSource: string;
  warnings: string[];
}

/**
 * 把来源批次（主任务样例）映射成本场景的生成输入：
 * 主任务样例只有粗粒度 district，这正对应“区域”语义——先按 district 找到该行政区的默认粗粒度区域，
 * 站点取场景的 districtStations 映射。无法映射的事件保留原样，由引擎判为不可验证。
 */
export function inputsFromBatch(scenario: GeoScenario, rows: TableRows): ScenarioInputs {
  const warnings: string[] = [];
  const regionsByDistrict = new Map<string, string>();
  for (const r of scenario.regions) if (!regionsByDistrict.has(r.district)) regionsByDistrict.set(r.district, r.id);
  const inputs: LocationEventInput[] = rows.events.map((e) => {
    const regionId = regionsByDistrict.get(e.district);
    if (!regionId) warnings.push(`行政区「${e.district}」在场景中无默认来源区域`);
    const station = scenario.districtStations?.[e.district] ?? '';
    return { event_id: e.event_id, district: e.district, alarm_time: e.alarm_time, station, regionId };
  });
  return { scenario, inputs, inputSource: '来源批次的粗粒度行政区 → 场景默认来源区域', warnings };
}

/** 使用场景内置样例事件（覆盖各验收场景） */
export function inputsFromSample(scenario: GeoScenario): ScenarioInputs {
  const inputs: LocationEventInput[] = (scenario.sampleEvents ?? []).map((e) => ({
    event_id: e.event_id, district: e.district, alarm_time: e.alarm_time, station: e.station, regionId: e.regionId
  }));
  return { scenario, inputs, inputSource: '场景内置样例事件（覆盖验收场景）', warnings: [] };
}

/** 计算输入哈希，确保包能回查路网/站点/区域具体版本 */
export async function computeInputHashes(scenario: GeoScenario, networkVersion: string) {
  const version = scenario.versions.find((v) => v.id === networkVersion);
  const graphHash = await hashObject({ nodes: scenario.nodes, edges: scenario.edges, version: version?.blockedEdges ?? [] });
  const stationHash = await hashObject({ stations: scenario.stations, moves: version?.stationNodes ?? {} });
  const regionHash = await hashObject({ regions: scenario.regions, overrides: version?.regionOverrides ?? {} });
  return { graphHash, stationHash, regionHash };
}

export interface GenerateOptions {
  scenario: GeoScenario;
  inputs: LocationEventInput[];
  config: LocationConfig;
  networkVersion: string;
  onProgress?: (done: number, total: number) => void;
  useWorker?: boolean;
}

export async function generateLocationPackage(opts: GenerateOptions): Promise<
  { ok: true; row: LocationRunRow } | { ok: false; error: string }
> {
  const { scenario, inputs, config, networkVersion } = opts;
  const issues = validateScenario(scenario);
  if (issues.length > 0) return { ok: false, error: `场景结构无效：${issues.slice(0, 3).join('；')}` };
  if (inputs.length === 0) return { ok: false, error: '没有可生成的事件输入' };

  const seq = await nextSeq('locationSeq');
  const now = new Date().toISOString();
  const baseRow: LocationRunRow = {
    id: `LOCRUN-${String(seq).padStart(4, '0')}`,
    seq,
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    networkVersion,
    strategy: config.strategy,
    versionTag: '',
    status: 'running',
    createdAt: now,
    versions: { ...scenario.revisions }
  };
  await db.locationRuns.put(baseRow);

  try {
    const raw = opts.useWorker
      ? await runInWorker(scenario, inputs, networkVersion, config, opts.onProgress)
      : generateLocationEntries(scenario, inputs, networkVersion, config);

    const hashes = await computeInputHashes(scenario, networkVersion);
    const result: LocationResult = {
      ...raw,
      meta: { ...raw.meta, ...hashes, generatedAt: new Date().toISOString() }
    };
    const pkg = await buildPackage(result);
    const safety = assertPublishSafe(pkg);
    if (safety.length > 0) throw new Error(`发布包安全性检查失败：${safety.slice(0, 3).join('；')}`);

    const done: LocationRunRow = {
      ...baseRow,
      status: 'done',
      finishedAt: new Date().toISOString(),
      versionTag: versionTagOf(result),
      packageId: pkg.packageId,
      packageHash: pkg.packageHash,
      summaryText: `${pkg.summary.generatable} 可生成 / ${pkg.summary.notGeneratable} 不可生成 / ${pkg.summary.unverifiable} 不可验证`,
      result,
      pkg
    };
    await db.locationRuns.put(done);
    return { ok: true, row: done };
  } catch (e) {
    const failed: LocationRunRow = {
      ...baseRow, status: 'failed', finishedAt: new Date().toISOString(),
      error: e instanceof Error ? e.message : String(e)
    };
    await db.locationRuns.put(failed);
    return { ok: false, error: failed.error ?? '生成失败' };
  }
}

function runInWorker(
  scenario: GeoScenario,
  inputs: LocationEventInput[],
  networkVersion: string,
  config: LocationConfig,
  onProgress?: (done: number, total: number) => void
): Promise<LocationResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/location.worker.ts', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('生成超时（120s）')); }, 120_000);
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') onProgress?.(msg.done, msg.total);
      else if (msg.type === 'done') { clearTimeout(timer); worker.terminate(); resolve(msg.result as LocationResult); }
      else if (msg.type === 'error') { clearTimeout(timer); worker.terminate(); reject(new Error(msg.error)); }
    };
    worker.onerror = (e) => { clearTimeout(timer); worker.terminate(); reject(new Error(e.message)); };
    worker.postMessage({ type: 'generate', payload: { scenario, inputs, networkVersion, config } });
  });
}

export async function getLocationRun(id: string): Promise<LocationRunRow | undefined> {
  return db.locationRuns.get(id);
}

export async function listLocationRuns(): Promise<LocationRunRow[]> {
  return db.locationRuns.orderBy('seq').reverse().toArray();
}
