// IndexedDB（Dexie）：批次/规则/方案/运行/报告/清单全部本地持久化。

import Dexie, { type Table } from 'dexie';
import type { BatchMeta, RuleSet, Plan, Run, Report, Manifest, TableRows } from '../domain/types';
import type { LocationPackage, LocationResult } from '../domain/locationTypes';

export interface BatchRowsRow { key: string; tables: TableRows; }
export interface RunOutputRow { runId: string; tables: TableRows; }
export interface KvRow { key: string; value: unknown; }
/** 替代位置训练记录：发布包 + 内部审计结果（审计仅本机核对，导出时剥离） */
export interface LocationRunRow {
  id: string;
  seq: number;
  scenarioId: string;
  scenarioName: string;
  networkVersion: string;
  strategy: string;
  versionTag: string;
  status: 'running' | 'done' | 'failed';
  createdAt: string;
  finishedAt?: string;
  packageId?: string;
  packageHash?: string;
  summaryText?: string;
  result?: LocationResult;
  pkg?: LocationPackage;
  error?: string;
  versions: { network: number; stations: number; regions: number }; // 修订快照
}

export class SynthDB extends Dexie {
  batches!: Table<BatchMeta, string>;
  batchRows!: Table<BatchRowsRow, string>;
  ruleSets!: Table<RuleSet, string>;
  plans!: Table<Plan, string>;
  runs!: Table<Run, string>;
  runOutputs!: Table<RunOutputRow, string>;
  reports!: Table<Report, string>;
  manifests!: Table<Manifest, string>;
  locationRuns!: Table<LocationRunRow, string>;
  kv!: Table<KvRow, string>;

  constructor() {
    super('emerg-synth-lab');
    this.version(1).stores({
      batches: 'key, batchId, revision',
      batchRows: 'key',
      ruleSets: 'id, status',
      plans: 'id, status',
      runs: 'id, seq, planId, status',
      runOutputs: 'runId',
      reports: 'id, runId',
      manifests: 'id, runId',
      kv: 'key'
    });
    this.version(2).stores({
      locationRuns: 'id, seq, scenarioId, status, versionTag'
    });
  }
}

export const db = new SynthDB();

export async function getKv<T>(key: string): Promise<T | undefined> {
  const row = await db.kv.get(key);
  return row?.value as T | undefined;
}
export async function setKv(key: string, value: unknown): Promise<void> {
  await db.kv.put({ key, value });
}

export async function nextSeq(key: string): Promise<number> {
  const cur = (await getKv<number>(key)) ?? 0;
  const next = cur + 1;
  await setKv(key, next);
  return next;
}
