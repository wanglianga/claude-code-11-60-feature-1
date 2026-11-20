// 地理训练场景样例生成脚本（确定性）。
// 产出一个本地平面米制坐标的“训练城”：主河 + 支流 + 桥、六个行政区、若干粗粒度来源区域、
// 人口格、派遣站点、训练时段与多个路网版本（封路 / 站点迁移 / 区域修订）。
// 坐标全部为本地平面米，不含真实经纬度。
// 用法：node scripts/gen-geo-scenarios.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'samples', 'geo');

// ---------- 网格定义 ----------
const XS = [400, 1200, 2000, 2800, 3600, 4400, 5200, 6800, 7600, 8400, 9200, 10000, 10800, 11600];
const YS = [400, 1200, 2000, 2800, 3600, 4400, 5200, 6000, 6800, 7600, 8400, 9200, 10000];
const MAIN_GAP = [6, 7];       // 主河：ci6(5200) 与 ci7(6800) 之间
const TRI_GAP = [10, 11];      // 支流：ci10(9200) 与 ci11(10000) 之间
const MAIN_BRIDGE_ROWS = [3, 7, 11]; // y=2800/6000/9200 主桥
const TRI_BRIDGE_ROW = 7;            // y=6000 支流桥

const nodeId = (ci, ri) => `g${ci}-${ri}`;

const nodes = [];
for (let ci = 0; ci < XS.length; ci++) {
  for (let ri = 0; ri < YS.length; ri++) nodes.push({ id: nodeId(ci, ri), x: XS[ci], y: YS[ri] });
}

const edges = [];
let edgeSeq = 0;
const addEdge = (ci1, ri1, ci2, ri2, opts = {}) => {
  edgeSeq++;
  const west = !!opts.bridgeAcrossMain;
  const village = ci1 >= 11 || ci2 >= 11;
  // 城区折算平均车速 20km/h（含信号与拥堵），乡村 14km/h；时段系数再在图上叠加
  const speedKmh = opts.speedKmh ?? (village ? 14 : 20);
  edges.push({
    id: opts.id ?? `e${String(edgeSeq).padStart(3, '0')}`,
    a: nodeId(ci1, ri1),
    b: nodeId(ci2, ri2),
    speedKmh,
    bridge: !!opts.bridge,
    name: opts.name ?? undefined
  });
  void west;
};

// 纵向道路（每列 ri -> ri+1）
for (let ci = 0; ci < XS.length; ci++) {
  for (let ri = 0; ri < YS.length - 1; ri++) addEdge(ci, ri, ci, ri + 1);
}
// 横向道路（同列区间 ci -> ci+1，跳过河/支流缺口）
for (let ci = 0; ci < XS.length - 1; ci++) {
  const isMainGap = ci === MAIN_GAP[0];
  const isTriGap = ci === TRI_GAP[0];
  for (let ri = 0; ri < YS.length; ri++) {
    if (isMainGap) {
      if (MAIN_BRIDGE_ROWS.includes(ri)) addEdge(ci, ri, ci + 1, ri, { bridge: true, name: `主河桥${ri}` });
      continue; // 主河其他位置无路
    }
    if (isTriGap) {
      if (ri === TRI_BRIDGE_ROW) addEdge(ci, ri, ci + 1, ri, { bridge: true, name: '支流桥' });
      continue; // 支流其他位置无路
    }
    addEdge(ci, ri, ci + 1, ri);
  }
}

// ---------- 河流折线（仅用于展示与距离展示，不参与图算法） ----------
const river = { name: '主河', points: [] };
for (let ri = 0; ri <= 20; ri++) {
  const t = ri / 20;
  river.points.push({ x: 6000 + Math.sin(t * Math.PI * 1.4) * 220, y: t * 10400 });
}
const tributary = { name: '东支流', points: [] };
for (let ri = 0; ri <= 20; ri++) {
  const t = ri / 20;
  tributary.points.push({ x: 9200 + Math.cos(t * Math.PI * 1.1) * 120, y: t * 10400 });
}

// ---------- 矩形助手 ----------
const rect = (x0, y0, x1, y1) => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }
];

// ---------- 行政区（大矩形） ----------
const districts = [
  { name: '城南区', polygon: rect(0, 0, 5200, 2600) },
  { name: '城西区', polygon: rect(0, 2600, 5200, 6600) },
  { name: '城北区', polygon: rect(0, 6600, 5200, 10000) },
  { name: '高新区', polygon: rect(6800, 0, 9200, 4000) },
  { name: '城东区', polygon: rect(6800, 4000, 9200, 10000) },
  { name: '郊区', polygon: rect(9200, 0, 12000, 10000) }
];

// ---------- 粗粒度来源区域（小于行政区，覆盖真实原点） ----------
const regions = [
  {
    id: '城西区:R1', district: '城西区', label: '西城中心块',
    polygons: [rect(1600, 3400, 3200, 5000)], populationBands: ['high', 'medium']
  },
  {
    id: '城北区:R1', district: '城北区', label: '北郊居住区',
    polygons: [rect(1600, 7000, 3200, 8600)], populationBands: ['high', 'medium', 'low']
  },
  {
    id: '城南区:R1', district: '城南区', label: '南站片区',
    polygons: [rect(1600, 800, 3200, 2400)], populationBands: ['medium', 'low']
  },
  {
    id: '城东区:R1', district: '城东区', label: '东城密集区',
    polygons: [rect(7200, 4600, 8600, 6200)], populationBands: ['high', 'medium']
  },
  {
    id: '高新区:R1', district: '高新区', label: '科技园片区',
    polygons: [rect(7200, 1600, 8600, 3200)], populationBands: ['high', 'medium']
  },
  {
    id: '郊区:R1', district: '郊区', label: '河东村（跨支流）',
    polygons: [rect(10000, 4400, 11600, 7600)], populationBands: ['medium', 'low']
  },
  {
    // 跨越东支流、且支流桥不在片区内的“断点片”：整块落在支流河道缺口中，区域内没有任何道路。
    // 正确行为是判为不可生成（区域内道路无法与站点连通），而不是拿区域中心冒充原点。
    id: '郊区:R3', district: '郊区', label: '滨河断点片（跨支流无桥）',
    polygons: [rect(9250, 3200, 9950, 4400)], populationBands: ['low']
  },
  {
    // 需要低人口带、且人口格极小：用于“小人口格”
    id: '高新区:R2', district: '高新区', label: '低密度小格片区',
    polygons: [rect(8400, 2800, 8800, 3200)], populationBands: ['low']
  },
  {
    // 仅覆盖单个稀疏乡村节点（盒半径 10m，小于 25m 道路采样间距）：可能起点集合不足 k
    id: '郊区:R2', district: '郊区', label: '孤立村口（单节点）',
    polygons: [rect(10790, 8390, 10810, 8410)], populationBands: ['low']
  }
];

// ---------- 人口格 ----------
const populationCells = [
  { id: 'pc-west-h', polygon: rect(1200, 3000, 3600, 5400), band: 'high', density: 0.95 },
  { id: 'pc-west-m', polygon: rect(3600, 2600, 5200, 6600), band: 'medium', density: 0.6 },
  { id: 'pc-south-m', polygon: rect(1200, 600, 3600, 2600), band: 'medium', density: 0.55 },
  { id: 'pc-north-m', polygon: rect(1200, 6600, 3600, 9000), band: 'medium', density: 0.5 },
  { id: 'pc-east-h', polygon: rect(6800, 4200, 8800, 6600), band: 'high', density: 0.92 },
  { id: 'pc-hitech-h', polygon: rect(6800, 1200, 8800, 3800), band: 'high', density: 0.85 },
  // 小人口格：极小、低密度
  { id: 'pc-small-low', polygon: rect(8420, 2820, 8660, 3060), band: 'low', density: 0.08 },
  // 乡村低密度
  { id: 'pc-village', polygon: rect(9800, 4000, 11800, 8000), band: 'low', density: 0.15 },
  { id: 'pc-isolated', polygon: rect(10600, 8200, 11000, 8600), band: 'low', density: 0.05 }
];

// ---------- 站点 ----------
// 站点放在来源区域之外（真实调度基地不在居民片区正中），使“可能起点→站点”的行程时间范围有意义。
const stations = [
  { id: 'ST-W', name: '城西分站', nodeId: nodeId(4, 5) },   // (3600,4400) 城西区，区域(x≤3200)之外
  { id: 'ST-N', name: '城北分站', nodeId: nodeId(4, 9) },   // (3600,7600) 城北区，区域(x≤3200)之外
  { id: 'ST-S', name: '城南分站', nodeId: nodeId(4, 2) },   // (3600,2000) 城南区，区域(x≤3200)之外
  { id: 'ST-E', name: '城东分站', nodeId: nodeId(7, 7) },   // (6800,6000) 城东区西南角，区域(x≥7200)之外
  { id: 'ST-H', name: '高新分站', nodeId: nodeId(7, 2) },   // (6800,2000) 高新区西侧，区域(x≥7200)之外
  { id: 'ST-SUB', name: '郊区分站', nodeId: nodeId(10, 7) } // (9200,6000) 支流西岸，河东村在支流东岸
];

const districtStations = {
  城西区: '城西分站',
  城北区: '城北分站',
  城南区: '城南分站',
  城东区: '城东分站',
  高新区: '高新分站',
  郊区: '郊区分站'
};

// ---------- 训练时段 ----------
const periods = [
  { id: 'night', label: '夜间 22:00–06:59', speedFactor: 1.25, hours: [22, 23, 0, 1, 2, 3, 4, 5, 6] },
  { id: 'peak', label: '早晚高峰 07:00–09:59 / 17:00–19:59', speedFactor: 0.62, hours: [7, 8, 9, 17, 18, 19] },
  { id: 'day', label: '日间平峰 10:00–16:59', speedFactor: 0.85, hours: [10, 11, 12, 13, 14, 15, 16] },
  { id: 'evening', label: '晚平峰 20:00–21:59', speedFactor: 1.0, hours: [20, 21] }
];

// ---------- 找到特定道路的边 id（供封路版本引用） ----------
const edgeBetween = (ci1, ri1, ci2, ri2) =>
  edges.find((e) => (e.a === nodeId(ci1, ri1) && e.b === nodeId(ci2, ri2)) || (e.a === nodeId(ci2, ri2) && e.b === nodeId(ci1, ri1)));

// 封路版本：封闭主河中部桥北侧引道（连接城东密集区与主桥的关键纵向路）+ 东支流唯一桥。
// 后果：跨支流的河东村在封桥后无法由西岸站点到达 → 跨河事件判为不可生成（可达性被破坏）。
const closureEdge = edgeBetween(9, 6, 9, 7); // 城东密集区内纵向路
const closureEdge2 = edgeBetween(8, 6, 8, 7); // 城东密集区内纵向路
const triBridgeEdge = edgeBetween(TRI_GAP[0], TRI_BRIDGE_ROW, TRI_GAP[1], TRI_BRIDGE_ROW); // 东支流唯一桥

const versions = [
  {
    id: 'v1', label: '基准路网 v1', blockedEdges: [],
    note: '基准路网，含主河三桥与支流一桥'
  },
  {
    id: 'v2', label: '道路封闭 v2',
    blockedEdges: [closureEdge?.id, closureEdge2?.id, triBridgeEdge?.id].filter(Boolean),
    note: '城东密集区两条纵向道路施工封闭，且东支流桥检修封闭（跨河村落失去可达路径）'
  },
  {
    id: 'v3', label: '站点迁移 v3',
    blockedEdges: [],
    stationNodes: { 'ST-E': nodeId(8, 6) },    note: '城东分站由 g9-7 迁至 g8-6'
  },
  {
    id: 'v4', label: '区域修订 v4',
    blockedEdges: [],
    regionOverrides: { '城东区:R1': [rect(7000, 4800, 8800, 6000)] },
    note: '东城密集区来源范围修订（向东扩展）'
  }
];

// ---------- 样例事件（命中各验收场景） ----------
const sampleEvents = [
  { event_id: 'LOC-CC-01', district: '城东区', regionId: '城东区:R1', alarm_time: '2025-09-12 08:20:00', station: '城东分站' }, // 中心城区密集路网
  { event_id: 'LOC-WC-01', district: '城西区', regionId: '城西区:R1', alarm_time: '2025-09-12 14:05:00', station: '城西分站' },
  { event_id: 'LOC-NC-01', district: '城北区', regionId: '城北区:R1', alarm_time: '2025-09-12 23:40:00', station: '城北分站' },
  { event_id: 'LOC-SC-01', district: '城南区', regionId: '城南区:R1', alarm_time: '2025-09-13 10:10:00', station: '城南分站' },
  { event_id: 'LOC-HC-01', district: '高新区', regionId: '高新区:R1', alarm_time: '2025-09-13 16:30:00', station: '高新分站' },
  { event_id: 'LOC-RIV-01', district: '郊区', regionId: '郊区:R1', alarm_time: '2025-09-13 21:15:00', station: '郊区分站' },  // 跨河村落
  { event_id: 'LOC-BRK-01', district: '郊区', regionId: '郊区:R3', alarm_time: '2025-09-14 09:00:00', station: '郊区分站' },  // 区域跨越路网断点
  { event_id: 'LOC-SMALL-01', district: '高新区', regionId: '高新区:R2', alarm_time: '2025-09-14 12:00:00', station: '高新分站' }, // 小人口格
  { event_id: 'LOC-SPARSE-01', district: '郊区', regionId: '郊区:R2', alarm_time: '2025-09-14 03:00:00', station: '郊区分站' },   // 稀疏乡村节点
  { event_id: 'LOC-MISS-ST-01', district: '城北区', regionId: '城北区:R1', alarm_time: '2025-09-14 15:00:00', station: '未登记站点' }, // 站点缺失
  { event_id: 'LOC-MISS-RG-01', district: '城北区', regionId: '不存在区域', alarm_time: '2025-09-14 15:30:00', station: '城北分站' } // 区域缺失
];

const scenario = {
  id: 'train-city-2025',
  name: '训练城（本地平面米制）',
  description:
    '本地平面米制坐标的合成城市：主河（三桥）、东支流（一桥）、六个行政区、九个粗粒度来源区域、' +
    '人口格、六个派遣站点与四个路网版本。用于为粗粒度来源事件生成隐私保护且保持响应可达性的替代位置。',
  coordinateNote: '坐标为本地平面米制，x 向东、y 向北，原点为虚构，不含任何真实经纬度；桥与封路仅用于可达时间计算。',
  nodes,
  edges,
  rivers: [river, tributary],
  districts,
  regions,
  populationCells,
  stations,
  districtStations,
  versions,
  defaultVersion: 'v1',
  periods,
  revisions: { network: 1, stations: 1, regions: 1 },
  sampleEvents
};

mkdirSync(ROOT, { recursive: true });
const file = {
  version: '1.0',
  generatedBy: 'scripts/gen-geo-scenarios.mjs',
  scenarios: [scenario]
};
writeFileSync(join(ROOT, 'scenarios.json'), JSON.stringify(file, null, 2));
console.log(`已生成 ${join(ROOT, 'scenarios.json')}`);
console.log(`节点 ${nodes.length}，道路 ${edges.length}，行政区 ${districts.length}，区域 ${regions.length}，版本 ${versions.length}`);
console.log(`封路边：${[closureEdge, closureEdge2, triBridgeEdge].map((e) => e?.id).join(', ')}`);
