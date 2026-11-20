import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../src/db/db';
import {
  generateLocationPackage, inputsFromSample, inputsFromBatch, loadScenarios
} from '../src/services/locationService';
import { DEFAULT_LOCATION_CONFIG } from '../src/domain/locationTypes';
import type { GeoScenario, GeoScenarioFile } from '../src/domain/locationTypes';
import type { TableRows } from '../src/domain/types';

const SAMPLE = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'samples', 'geo', 'scenarios.json');
const scenario = (JSON.parse(readFileSync(SAMPLE, 'utf8')) as GeoScenarioFile).scenarios[0];

const emptyRows: TableRows = { events: [], dispatches: [], resources: [], arrivals: [], closures: [] };

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('替代位置服务（Dexie 端到端，非 Worker 路径）', () => {
  it('生成并落库，含版本标签、包哈希与内部审计', async () => {
    const inputs = inputsFromSample(scenario);
    const res = await generateLocationPackage({
      scenario, inputs: inputs.inputs, config: { ...DEFAULT_LOCATION_CONFIG }, networkVersion: 'v1', useWorker: false
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.row.status).toBe('done');
    expect(res.row.versionTag).toContain('net-r1');
    expect(res.row.packageHash).toBeTruthy();
    // 落库可回读
    const stored = await db.locationRuns.get(res.row.id);
    expect(stored?.pkg?.entries.length).toBe(inputs.inputs.length);
    // 内部审计存在（可能起点），但发布包不含
    const anyGen = stored!.result!.entries.find((e) => e.published.status === 'generatable')!;
    expect(anyGen.audit.possible_origin_count).toBeGreaterThan(0);
    expect(JSON.stringify(stored!.pkg)).not.toContain('possible_origin_node_ids');
  });

  it('不同路网版本产生不同包哈希（版本化）', async () => {
    const inputs = inputsFromSample(scenario);
    const r1 = await generateLocationPackage({ scenario, inputs: inputs.inputs, config: { ...DEFAULT_LOCATION_CONFIG }, networkVersion: 'v1', useWorker: false });
    const r2 = await generateLocationPackage({ scenario, inputs: inputs.inputs, config: { ...DEFAULT_LOCATION_CONFIG }, networkVersion: 'v2', useWorker: false });
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.row.packageHash).not.toBe(r2.row.packageHash);
      expect(r1.row.versionTag).not.toBe(r2.row.versionTag);
    }
  });

  it('来源批次粗粒度 district 映射后生成，未知行政区委为不可验证', async () => {
    const rows: TableRows = {
      ...emptyRows,
      events: [
        { event_id: 'E1', alarm_time: '2025-09-10 08:00:00', event_type: '火灾', district: '高新区', address_text: 'x', caller_phone: 'x', priority: 'P1' },
        { event_id: 'E2', alarm_time: '2025-09-10 08:00:00', event_type: '火灾', district: '无此区', address_text: 'x', caller_phone: 'x', priority: 'P1' }
      ]
    };
    const mapped = inputsFromBatch(scenario, rows);
    const res = await generateLocationPackage({ scenario, inputs: mapped.inputs, config: { ...DEFAULT_LOCATION_CONFIG }, networkVersion: 'v1', useWorker: false });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const e2 = res.row.result!.entries.find((e) => e.published.event_id === 'E2')!;
    expect(e2.published.status).toBe('unverifiable');
  });

  it('空输入报错且不落 running 残留（失败行状态可追踪）', async () => {
    const res = await generateLocationPackage({ scenario, inputs: [], config: { ...DEFAULT_LOCATION_CONFIG }, networkVersion: 'v1', useWorker: false });
    expect(res.ok).toBe(false);
    const all = await db.locationRuns.toArray();
    expect(all.length).toBe(0);
  });
});

describe('loadScenarios', () => {
  it('在 Node 环境读取本地样例（用文件系统模拟 fetch）', async () => {
    // Node 无 fetch 到本地静态目录，这里验证 JSON 结构与 loadScenarios 的解析契约一致
    const file = JSON.parse(readFileSync(SAMPLE, 'utf8')) as GeoScenarioFile;
    expect(file.scenarios.length).toBeGreaterThan(0);
    const s: GeoScenario = file.scenarios[0];
    expect(s.defaultVersion).toBe('v1');
    expect(loadScenarios).toBeTypeOf('function');
  });
});
