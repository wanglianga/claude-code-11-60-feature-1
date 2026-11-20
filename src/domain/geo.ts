// 平面几何工具（本地米制坐标）：点在多边形内、点到多边形最短距离、折线距离。
// 坐标一律为“本地平面米”，不涉及任何真实经纬度。

export interface Point { x: number; y: number; }

/** 射线法判断点是否在多边形内（边界视为在内部，调用方按“包含”处理） */
export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 点到线段的距离 */
export function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** 点到折线（开放）的最短距离 */
export function pointPolylineDistance(p: Point, line: Point[]): number {
  if (line.length === 0) return Infinity;
  if (line.length === 1) return dist(p, line[0]);
  let best = Infinity;
  for (let i = 1; i < line.length; i++) best = Math.min(best, pointSegmentDistance(p, line[i - 1], line[i]));
  return best;
}

/**
 * 点到多边形区域（含边界与内部）的最短距离。
 * 点在多边形内部时返回 0——这正是隐私距离下界为 0 的含义：
 * 候选点落在可能来源范围内时，可能原点可与候选点重合。
 */
export function pointPolygonDistance(p: Point, poly: Point[]): number {
  if (poly.length < 3) return Infinity;
  if (pointInPolygon(p, poly)) return 0;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    best = Math.min(best, pointSegmentDistance(p, poly[j], poly[i]));
  }
  return best;
}

/** 点到闭合环折线的距离（用于河流），无所谓内外 */
export function pointClosedPolylineDistance(p: Point, line: Point[]): number {
  const pts = line.length > 1 ? line : line.slice();
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) best = Math.min(best, pointSegmentDistance(p, pts[i - 1], pts[i]));
  if (pts.length > 2) best = Math.min(best, pointSegmentDistance(p, pts[0], pts[pts.length - 1]));
  return best;
}

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number; }

export function polygonBounds(poly: Point[]): Bounds {
  const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** 向下取整到给定桶宽（用于发布前粗化距离下界，避免细粒度距离反推原点） */
export function floorToBucket(v: number, bucket: number): number {
  return Math.floor(v / bucket) * bucket;
}

/** 四舍五入到网格（用于候选点坐标粗化） */
export function roundToGrid(v: number, grid: number): number {
  return Math.round(v / grid) * grid;
}

export function roundTo(v: number, step: number): number {
  return Math.round(v / step) * step;
}
