import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import {
  loadScenarios, inputsFromBatch, inputsFromSample, generateLocationPackage
} from '../services/locationService';
import { exportJson } from '../services/exportService';
import { DEFAULT_LOCATION_CONFIG, REASON_LABELS } from '../domain/locationTypes';
import type {
  GeoScenario, LocationConfig, LocationEntry, LocationStrategy
} from '../domain/locationTypes';
import { LevelBadge, Empty, HashChip } from '../ui/widgets';
import { useToast } from '../ui/toast';

export default function Locations() {
  const toast = useToast();
  const [scenarios, setScenarios] = useState<GeoScenario[] | null>(null);
  const [scenarioId, setScenarioId] = useState<string>('');
  const [networkVersion, setNetworkVersion] = useState<string>('');
  const [inputMode, setInputMode] = useState<'sample' | 'batch'>('sample');
  const [batchKey, setBatchKey] = useState<string>('');
  const [config, setConfig] = useState<LocationConfig>({ ...DEFAULT_LOCATION_CONFIG });
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const batches = useLiveQuery(() => db.batches.toArray(), []);
  const runs = useLiveQuery(() => db.locationRuns.orderBy('seq').reverse().toArray(), []);

  useEffect(() => {
    void (async () => {
      try {
        const list = await loadScenarios();
        setScenarios(list);
        if (list.length > 0) {
          setScenarioId(list[0].id);
          setNetworkVersion(list[0].defaultVersion);
        }
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  const scenario = useMemo(() => scenarios?.find((s) => s.id === scenarioId), [scenarios, scenarioId]);
  const latestBatch = useMemo(() => {
    const list = (batches ?? []).filter((b) => b.status === 'latest');
    return list.sort((a, b) => b.revision - a.revision)[0];
  }, [batches]);

  const onScenarioChange = (id: string) => {
    setScenarioId(id);
    const s = scenarios?.find((x) => x.id === id);
    if (s) setNetworkVersion(s.defaultVersion);
  };

  const generate = async () => {
    if (!scenario) return;
    let inputs;
    if (inputMode === 'batch') {
      const key = batchKey || latestBatch?.key;
      if (!key) { toast('尚无来源批次，请先在「来源批次」登记', 'bad'); return; }
      const rows = (await db.batchRows.get(key))?.tables;
      if (!rows) { toast('批次数据缺失', 'bad'); return; }
      const mapped = inputsFromBatch(scenario, rows);
      if (mapped.warnings.length > 0) toast(`部分事件无法映射：${mapped.warnings[0]}`, 'info');
      inputs = mapped;
    } else {
      inputs = inputsFromSample(scenario);
    }
    if (inputs.inputs.length === 0) { toast('没有事件输入', 'bad'); return; }
    setBusy(true);
    setProgress({ done: 0, total: inputs.inputs.length });
    const res = await generateLocationPackage({
      scenario,
      inputs: inputs.inputs,
      config,
      networkVersion,
      useWorker: true,
      onProgress: (done, total) => setProgress({ done, total })
    });
    setBusy(false);
    setProgress(null);
    if (res.ok) {
      toast(`训练包 ${res.row.packageId} 已生成：${res.row.summaryText}`, 'ok');
      setSelectedRun(res.row.id);
    } else toast(res.error, 'bad');
  };

  const setCfg = <K extends keyof LocationConfig>(k: K, v: LocationConfig[K]) => setConfig((c) => ({ ...c, [k]: v }));

  return (
    <div>
      <h1 className="page-title">替代位置</h1>
      <p className="page-sub">
        主任务样例只含粗粒度来源区域（行政区），不含可计算的精确原点。本页把该区域解释为覆盖真实原点的几何范围，
        在区域内找出与道路图连通的可能起点，计算候选点到整个可能来源集合的最小直线距离下界，以及可能起点→派遣站点的道路行程时间范围；
        只有距离下界达到隐私门槛、且与来源行程时间范围的最坏差值仍在容差内，候选点才标为可生成。
        若区域边界、道路连接或站点信息不足以形成这些界限，则输出不可验证/不可生成及原因，绝不以区域中心或人口权重中心冒充原点。
      </p>

      {loadError && <div className="notice bad">场景样例加载失败：{loadError}</div>}

      <div className="card">
        <h3>生成配置</h3>
        <div className="grid2">
          <label className="field"><span>地理场景</span>
            <select value={scenarioId} onChange={(e) => onScenarioChange(e.target.value)} disabled={busy}>
              {(scenarios ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></label>
          <label className="field"><span>路网/站点/区域版本</span>
            <select value={networkVersion} onChange={(e) => setNetworkVersion(e.target.value)} disabled={busy}>
              {(scenario?.versions ?? []).map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select></label>
          <label className="field"><span>事件输入</span>
            <select value={inputMode} onChange={(e) => setInputMode(e.target.value as 'sample' | 'batch')} disabled={busy}>
              <option value="sample">场景内置样例事件（覆盖验收场景）</option>
              <option value="batch">来源批次（粗粒度行政区 → 来源区域）</option>
            </select></label>
          {inputMode === 'batch' && (
            <label className="field"><span>来源批次</span>
              <select value={batchKey || latestBatch?.key || ''} onChange={(e) => setBatchKey(e.target.value)}>
                {(batches ?? []).map((b) => <option key={b.key} value={b.key}>{b.key}（r{b.revision}，{b.files[0]?.rows} 事件）</option>)}
                {(!batches || batches.length === 0) && <option value="">尚未登记批次</option>}
              </select></label>
          )}
          <label className="field"><span>候选策略</span>
            <select value={config.strategy} onChange={(e) => setCfg('strategy', e.target.value as LocationStrategy)} disabled={busy}>
              <option value="road-node">road-node：道路节点抽样（路径语义真实，依赖路网连通）</option>
              <option value="area">area：行政区/人口带构造面（代表性较好，细长/跨河常无合格点）</option>
            </select></label>
          <label className="field"><span>隐私距离门槛（米）</span>
            <input type="number" value={config.privacyMinDistanceM} onChange={(e) => setCfg('privacyMinDistanceM', Number(e.target.value))} disabled={busy} /></label>
          <label className="field"><span>行程容差（分钟，最坏差值上限）</span>
            <input type="number" value={config.travelToleranceMin} onChange={(e) => setCfg('travelToleranceMin', Number(e.target.value))} disabled={busy} /></label>
          <label className="field"><span>可能起点集合最小规模 k</span>
            <input type="number" value={config.minPossibleOrigins} onChange={(e) => setCfg('minPossibleOrigins', Number(e.target.value))} disabled={busy} /></label>
          <label className="field"><span>距离下界桶宽（米，发布粗化）</span>
            <input type="number" value={config.privacyBucketM} onChange={(e) => setCfg('privacyBucketM', Number(e.target.value))} disabled={busy} /></label>
          <label className="field"><span>合成点网格（米）</span>
            <input type="number" value={config.candidateGridM} onChange={(e) => setCfg('candidateGridM', Number(e.target.value))} disabled={busy} /></label>
          <label className="field"><span>随机种子（可复现）</span>
            <input type="number" value={config.seed} onChange={(e) => setCfg('seed', Math.floor(Number(e.target.value)))} disabled={busy} /></label>
          <label className="field" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={config.sameDistrictOnly} style={{ width: 'auto' }}
              onChange={(e) => setCfg('sameDistrictOnly', e.target.checked)} disabled={busy} />
            <span style={{ margin: 0 }}>area 策略仅取同行政区候选</span></label>
        </div>
        <div className="btn-row" style={{ marginTop: 6 }}>
          <button className="primary" disabled={busy || !scenario} onClick={() => void generate()}>
            {busy ? '生成中…' : '生成训练包'}
          </button>
          <span className="small muted">
            {scenario ? `${scenario.nodes.length} 节点 / ${scenario.edges.length} 道路 / ${scenario.regions.length} 来源区域` : '场景加载中…'}
          </span>
        </div>
        {progress && (
          <div style={{ marginTop: 12 }}>
            <div className="progress-track"><div className="progress-bar" style={{ width: `${Math.min(100, (progress.done / Math.max(1, progress.total)) * 100)}%` }} /></div>
            <div className="small muted" style={{ marginTop: 4 }}>WebWorker 生成中：{progress.done} / {progress.total}</div>
          </div>
        )}
        {scenario && <ScenarioFacts scenario={scenario} versionId={networkVersion} />}
      </div>

      <div className="card">
        <h3>训练包记录（版本化）</h3>
        {!runs || runs.length === 0 ? <Empty text="尚无训练包。选择场景与版本后生成。" /> : (
          <table className="data">
            <thead>
              <tr><th>运行</th><th>场景 / 版本标签</th><th>输入快照（net/st/rg）</th><th>结论</th><th>包</th><th>操作</th></tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.id}</b><div className="small muted">{new Date(r.createdAt).toLocaleString()}</div></td>
                  <td className="small">{r.scenarioName}<br /><span className="mono">{r.versionTag || '-'}</span></td>
                  <td className="small">net-r{r.versions.network} / st-r{r.versions.stations} / rg-r{r.versions.regions}<br />{r.networkVersion} · {r.strategy}</td>
                  <td className="small">
                    {r.status === 'done' ? r.summaryText : <LevelBadge level={r.status as 'running' | 'failed'} />}
                    {r.error && <div className="badge bad" style={{ marginTop: 4 }}>{r.error}</div>}
                  </td>
                  <td className="small">{r.packageId ? <>{r.packageId}<br /><HashChip text={r.packageHash} len={12} /></> : '-'}</td>
                  <td>
                    {r.status === 'done' && (
                      <div className="btn-row">
                        <button onClick={() => setSelectedRun(selectedRun === r.id ? null : r.id)}>{selectedRun === r.id ? '收起' : '核对'}</button>
                        <button className="primary" disabled={!r.pkg} onClick={() => r.pkg && exportJson(`${r.packageId}.training.json`, r.pkg)}>导出训练包</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selectedRun && <RunDetail runId={selectedRun} />}
    </div>
  );
}

function ScenarioFacts({ scenario, versionId }: { scenario: GeoScenario; versionId: string }) {
  const version = scenario.versions.find((v) => v.id === versionId);
  return (
    <div className="grid2" style={{ marginTop: 14 }}>
      <div className="small">
        <b>场景坐标：</b>{scenario.coordinateNote}
        <div style={{ marginTop: 6 }}><b>当前版本：</b>{version?.label} —— {version?.note}</div>
        <div style={{ marginTop: 6 }}><b>训练时段：</b>{scenario.periods.map((p) => `${p.label}（×${p.speedFactor}）`).join('；')}</div>
      </div>
      <div>
        <MapPreview scenario={scenario} versionId={versionId} />
      </div>
    </div>
  );
}

function MapPreview({ scenario, versionId }: { scenario: GeoScenario; versionId: string }) {
  const version = scenario.versions.find((v) => v.id === versionId);
  const blocked = new Set(version?.blockedEdges ?? []);
  const W = 420, H = 300, pad = 8;
  const xs = scenario.nodes.map((n) => n.x), ys = scenario.nodes.map((n) => n.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const sx = (x: number) => pad + ((x - minX) / (maxX - minX)) * (W - 2 * pad);
  const sy = (y: number) => H - pad - ((y - minY) / (maxY - minY)) * (H - 2 * pad);
  const pos = new Map(scenario.nodes.map((n) => [n.id, n]));
  const stationNode = new Map(scenario.stations.map((s) => [s.id, version?.stationNodes?.[s.id] ?? s.nodeId]));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', border: '1px solid var(--line)', borderRadius: 8, background: '#fbfcff' }}>
      {/* 河流 */}
      {scenario.rivers.map((r) => (
        <polyline key={r.name} fill="none" stroke="#9cc3f5" strokeWidth={4} opacity={0.7}
          points={r.points.map((p) => `${sx(p.x)},${sy(p.y)}`).join(' ')} />
      ))}
      {/* 道路 */}
      {scenario.edges.map((e) => {
        const a = pos.get(e.a), b = pos.get(e.b);
        if (!a || !b) return null;
        const isBlocked = blocked.has(e.id);
        return <line key={e.id} x1={sx(a.x)} y1={sy(a.y)} x2={sx(b.x)} y2={sy(b.y)}
          stroke={isBlocked ? '#c9372c' : (e.bridge ? '#7a8aa6' : '#cdd6e4')} strokeWidth={isBlocked ? 1.6 : 0.8}
          strokeDasharray={isBlocked ? '3 2' : undefined} />;
      })}
      {/* 来源区域 */}
      {scenario.regions.map((r) => r.polygons.map((poly, i) => (
        <polygon key={`${r.id}-${i}`} points={poly.map((p) => `${sx(p.x)},${sy(p.y)}`).join(' ')}
          fill="rgba(31,111,235,0.06)" stroke="#1f6feb" strokeWidth={0.6} strokeDasharray="4 2" />
      )))}
      {/* 站点 */}
      {scenario.stations.map((st) => {
        const nid = stationNode.get(st.id)!;
        const n = pos.get(nid);
        if (!n) return null;
        return <g key={st.id}>
          <rect x={sx(n.x) - 3} y={sy(n.y) - 3} width={6} height={6} fill="#12805c" />
          <text x={sx(n.x) + 5} y={sy(n.y) + 3} fontSize={7} fill="#12805c">{st.name}</text>
        </g>;
      })}
    </svg>
  );
}

function RunDetail({ runId }: { runId: string }) {
  const run = useLiveQuery(() => db.locationRuns.get(runId), [runId]);
  const [showAudit, setShowAudit] = useState(true);
  if (!run || run.status !== 'done' || !run.result || !run.pkg) return <div className="card"><Empty text="加载中…" /></div>;
  const { result, pkg } = run;
  return (
    <div className="card">
      <div className="btn-row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>核对视图：{run.id} · {pkg.packageId}</h3>
        <LevelBadge level={pkg.summary.generatable > 0 ? 'pass' : 'warn'} />
      </div>
      <dl className="kv" style={{ marginTop: 10 }}>
        <dt>版本标签</dt><dd className="mono">{run.versionTag}</dd>
        <dt>输入哈希</dt><dd className="small">路网 <HashChip text={pkg.graphHash} len={10} /> · 站点 <HashChip text={pkg.stationHash} len={10} /> · 区域 <HashChip text={pkg.regionHash} len={10} /></dd>
        <dt>包哈希</dt><dd><HashChip text={pkg.packageHash} len={24} /></dd>
        <dt>汇总</dt><dd className="small">{pkg.summary.generatable} 可生成 / {pkg.summary.notGeneratable} 不可生成 / {pkg.summary.unverifiable} 不可验证
          {Object.entries(pkg.summary.byReason).map(([k, v]) => ` · ${REASON_LABELS[k as keyof typeof REASON_LABELS] ?? k}: ${v}`).join('')}</dd>
      </dl>
      <div className="btn-row" style={{ margin: '8px 0' }}>
        <button onClick={() => setShowAudit((v) => !v)}>{showAudit ? '隐藏' : '显示'}内部审计（可能起点/原始距离）</button>
        <span className="small muted">内部审计仅供核对，导出训练包永不包含这些字段。</span>
      </div>
      <EntryTable entries={result.entries} showAudit={showAudit} />
      <div className="notice info small" style={{ marginTop: 10 }}><b>训练包范围声明：</b>{pkg.disclaimer}</div>
    </div>
  );
}

function EntryTable({ entries, showAudit }: { entries: LocationEntry[]; showAudit: boolean }) {
  return (
    <div style={{ overflowX: 'auto', maxHeight: '58vh' }}>
      <table className="data">
        <thead>
          <tr>
            <th>事件</th><th>状态</th><th>来源区域</th><th>可能起点 k</th>
            <th>距离下界(发布)</th><th>来源行程区间</th><th>候选行程</th><th>最坏差值</th>
            <th>合成点</th><th>原因</th>
            {showAudit && <th>内部审计</th>}
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const p = e.published;
            return (
              <tr key={p.event_id}>
                <td className="mono small">{p.event_id}</td>
                <td><LevelBadge level={p.status === 'generatable' ? 'pass' : p.status === 'not-generatable' ? 'warn' : 'fail'} />
                  <div className="small muted">{p.status}</div></td>
                <td className="small">{p.source_region_id || '-'}</td>
                <td className="small">{p.possible_origin_count ?? '-'}</td>
                <td className="small">{p.privacy_distance_lb_bucket_m != null ? `${p.privacy_distance_lb_bucket_m}m` : '-'}</td>
                <td className="small">{p.source_travel_min_min != null ? `${p.source_travel_min_min}~${p.source_travel_min_max} 分` : '-'}</td>
                <td className="small">{p.candidate_travel_min != null ? `${p.candidate_travel_min} 分` : '-'}</td>
                <td className="small">{p.worst_diff_min != null ? `${p.worst_diff_min} 分` : '-'}</td>
                <td className="small mono">{p.synthetic_point ? `${p.synthetic_point.x},${p.synthetic_point.y}` : '—'}</td>
                <td className="small">{p.reason_labels.join('；') || '-'}</td>
                {showAudit && (
                  <td className="small">
                    起点样本 {e.audit.possible_origin_count}（道路采样 {e.audit.region_road_sample_points}）<br />
                    原始距离 {e.audit.privacy_distance_raw_m != null ? `${e.audit.privacy_distance_raw_m.toFixed(1)}m` : '-'}<br />
                    原始行程 {e.audit.candidate_travel_raw_min != null ? `${e.audit.candidate_travel_raw_min.toFixed(2)} 分` : '-'} ·
                    最坏差 {e.audit.worst_diff_raw_min != null ? `${e.audit.worst_diff_raw_min.toFixed(2)} 分` : '-'}<br />
                    候选评估 {e.audit.candidates_evaluated} / 距离达标 {e.audit.candidates_distance_ok} / 行程达标 {e.audit.candidates_travel_ok}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
