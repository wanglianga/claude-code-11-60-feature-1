// 替代位置生成 WebWorker：在后台线程执行几何/路网计算，避免阻塞 UI。
// 分批生成以获得进度反馈，最后按确定性顺序汇总（单事件种子独立，分批不改变结果）。

import type { GeoScenario, LocationConfig, LocationEventInput, LocationResult } from '../domain/locationTypes';
import { generateEntry, assembleResult, alarmHourOf } from '../domain/locationEngine';
import { mulberry32 } from '../domain/prng';

interface GenerateMsg {
  type: 'generate';
  payload: { scenario: GeoScenario; inputs: LocationEventInput[]; networkVersion: string; config: LocationConfig };
}

function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

self.onmessage = (e: MessageEvent<GenerateMsg>) => {
  const msg = e.data;
  if (msg.type !== 'generate') return;
  try {
    const { scenario, inputs, networkVersion, config } = msg.payload;
    const total = inputs.length;
    const chunk = 25;
    const entries: LocationResult['entries'] = [];
    for (let i = 0; i < inputs.length; i += chunk) {
      for (const ev of inputs.slice(i, i + chunk)) {
        const evRng = mulberry32((config.seed ^ hashStr(ev.event_id)) >>> 0);
        entries.push(generateEntry(scenario, ev, networkVersion, alarmHourOf(ev.alarm_time), config, evRng));
      }
      (self as unknown as Worker).postMessage({ type: 'progress', done: Math.min(total, i + chunk), total });
    }
    const result = assembleResult(scenario, entries, networkVersion, config);
    (self as unknown as Worker).postMessage({ type: 'done', result });
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
};
