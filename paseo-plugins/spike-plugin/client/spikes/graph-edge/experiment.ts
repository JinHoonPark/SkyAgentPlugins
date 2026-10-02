import fixture from './fixture/graph';
import dagre from './vendor/dagre';
import { edgeLabelPlacements, layoutGraph, pointAlongSegments, STATUS_SCALE, type EdgeSegment, type NodeBox, type PlacedGraph } from './motion-logic';
import type { Direction, GraphView } from './graph-types';

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Label = Size & { key: string; pathKey: string; text: string; left: number; top: number; identified: boolean };
export type PhysicalPath = { key: string; directions: Direction[]; points: Point[] };
export type Options = {
  merge?: boolean; ports?: 12 | 16; lanes?: 12 | 20; semantic?: boolean;
  avoidLabels?: 8 | 16; reserveLabels?: boolean; spacing?: boolean; orthogonal?: boolean; priority?: boolean;
  labelMode?: 'center' | 'arrival'; attributeMode?: 'neutral' | 'halves';
};
export const CANDIDATES: Array<{ id: string; title: string; options: Options }> = [
  { id: 'B', title: '개선 전', options: {} },
  { id: 'return12', title: '복귀 외곽 12px', options: { lanes: 12 } },
  { id: 'return20', title: '복귀 외곽 20px', options: { lanes: 20 } },
  { id: 'kind12', title: '명시 종류 배치·외곽 12px', options: { lanes: 12, semantic: true } },
  { id: 'kind20', title: '명시 종류 배치·외곽 20px', options: { lanes: 20, semantic: true } },
  { id: 'one', title: '왕복 한 선', options: { merge: true } },
  { id: 'ports12', title: '접점 분산 12px', options: { ports: 12 } },
  { id: 'ports16', title: '접점 분산 16px', options: { ports: 16 } },
  { id: 'onePorts12', title: '한 선·접점 분산 12px', options: { merge: true, ports: 12 } },
  { id: 'onePorts16', title: '한 선·접점 분산 16px', options: { merge: true, ports: 16 } },
  { id: 'labels8', title: '고정 배치 라벨 회피 8px', options: { avoidLabels: 8 } },
  { id: 'labels16', title: '고정 배치 라벨 회피 16px', options: { avoidLabels: 16 } },
  { id: 'reserve', title: '실측 라벨 Dagre 예약', options: { reserveLabels: true } },
  { id: 'priority', title: '고정 경로 채도·선택 강조', options: { priority: true } },
  { id: 'spacing', title: '간격 1.25배 대조군', options: { spacing: true } },
  { id: 'orthogonal', title: '장애물 회피 직교', options: { orthogonal: true } },
];
const feedback = new Set(['G1-N1', 'G3-N3', 'G4-N3', 'G4-N1', 'G6-N6', 'G7-N7', 'N9-N8']);
export const metadata = fixture.metadata;
export function viewFor(state = -1, dashed = 0): GraphView {
  const statuses = [['실행 중', '대기'], ['대기', '실행 중'], ['실행 중', '실행 중'], ['대기', '대기'], ['완료', '완료']] as const;
  return { name: 'graph-edge-layout', root: null, waiting: false,
    nodes: fixture.nodes.map(n => ({ ...n, agentId: null, labelLines: [...n.labelLines],
      status: state >= 0 && n.id === 'N8' ? statuses[state][0] : state >= 0 && n.id === 'N9' ? statuses[state][1] : n.status })),
    edges: fixture.edges.map(e => ({ ...e, dashed: e.from === 'N8' && e.to === 'N9' ? Boolean(dashed & 1)
      : e.from === 'N9' && e.to === 'N8' ? Boolean(dashed & 2) : e.dashed })),
  };
}
export function segments(points: Point[], key: string): EdgeSegment[] {
  return points.slice(1).flatMap((p, i) => {
    const a = points[i], length = Math.hypot(p.x - a.x, p.y - a.y);
    return length < 1 ? [] : [{ key: `${key}-${i}`, left: a.x, top: a.y - 1, width: Math.round(length), deg: Math.atan2(p.y - a.y, p.x - a.x) * 180 / Math.PI }];
  });
}
export function pointsOf(segs: EdgeSegment[]): Point[] {
  if (!segs.length) return [];
  return [{ x: segs[0].left, y: segs[0].top + 1 }, ...segs.map(s => ({ x: s.left + Math.cos(s.deg * Math.PI / 180) * s.width,
    y: s.top + 1 + Math.sin(s.deg * Math.PI / 180) * s.width }))];
}
export function polygon(b: NodeBox, shape: string): Point[] {
  const l = b.left, r = l + b.width, t = b.top, d = t + b.height, m = (t + d) / 2;
  return shape === 'hexagon' ? [{ x: l + 17, y: t }, { x: r - 17, y: t }, { x: r, y: m },
    { x: r - 17, y: d }, { x: l + 17, y: d }, { x: l, y: m }] : [{ x: l, y: t }, { x: r, y: t }, { x: r, y: d }, { x: l, y: d }];
}
export function visibleBox(box: NodeBox, view: GraphView): NodeBox {
  const status = view.nodes.find(n => n.id === box.id)!.status;
  const factor = status ? STATUS_SCALE[status] : 1;
  return { ...box, left: box.left + box.width * (1 - factor) / 2, top: box.top + box.height * (1 - factor) / 2, width: box.width * factor, height: box.height * factor };
}
export function nodeContour(box: NodeBox, view: GraphView): Point[] {
  const node = view.nodes.find(n => n.id === box.id)!;
  const factor = node.status ? STATUS_SCALE[node.status] : 1;
  let points: Point[];
  if (node.shape === 'hexagon') points = polygon(box, node.shape);
  else {
    const radius = 12, l = box.left, t = box.top, r = l + box.width, b = t + box.height;
    points = [[r - radius, t + radius, -90], [r - radius, b - radius, 0], [l + radius, b - radius, 90], [l + radius, t + radius, 180]].flatMap(([x, y, start]) =>
      Array.from({ length: 17 }, (_, i) => ({ x: x + radius * Math.cos((start + i * 90 / 16) * Math.PI / 180), y: y + radius * Math.sin((start + i * 90 / 16) * Math.PI / 180) })));
  }
  const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
  return points.map(p => ({ x: cx + (p.x - cx) * factor, y: cy + (p.y - cy) * factor }));
}
export function inside(p: Point, poly: Point[]): boolean {
  let positive = false, negative = false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(c) < 1e-7) continue;
    positive ||= c > 0; negative ||= c < 0;
  }
  return !(positive && negative) && positive !== negative;
}
export function intersection(a: Point, b: Point, c: Point, d: Point): Point | null {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y, den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-7) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
  return t >= -1e-7 && t <= 1 + 1e-7 && u >= -1e-7 && u <= 1 + 1e-7 ? { x: a.x + t * rx, y: a.y + t * ry } : null;
}
export function pierces(a: Point, b: Point, poly: Point[]): boolean {
  const values = [0, 1];
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (!length) return false;
  for (let i = 0; i < poly.length; i++) {
    const p = intersection(a, b, poly[i], poly[(i + 1) % poly.length]);
    if (p) values.push(Math.hypot(p.x - a.x, p.y - a.y) / length);
  }
  values.sort((x, y) => x - y);
  return values.slice(1).some((t, i) => {
    const mid = (t + values[i]) / 2;
    return t - values[i] > 1e-7 && inside({ x: a.x + (b.x - a.x) * mid, y: a.y + (b.y - a.y) * mid }, poly)
      && distanceToPolygon({ x: a.x + (b.x - a.x) * mid, y: a.y + (b.y - a.y) * mid }, poly) > 1e-5;
  });
}
export function pointDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
export function distanceToPolygon(p: Point, poly: Point[]): number {
  return Math.min(...poly.map((a, i) => pointDistance(p, a, poly[(i + 1) % poly.length])));
}
const rect = (r: { left: number; top: number; width: number; height: number }) => polygon({ id: '', ...r }, 'rect');
export function rectPathDistance(r: Label, points: Point[]): number {
  const corners = rect(r);
  if (points.some(p => inside(p, corners))) return 0;
  let best = Infinity;
  for (let j = 1; j < points.length; j++) for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4], c = points[j - 1], d = points[j];
    if (intersection(a, b, c, d)) return 0;
    best = Math.min(best, pointDistance(a, c, d), pointDistance(b, c, d), pointDistance(c, a, b), pointDistance(d, a, b));
  }
  return best;
}
export function polygonsOverlap(a: Point[], b: Point[]): boolean {
  if (a.some(p => inside(p, b) && distanceToPolygon(p, b) > 1e-5) || b.some(p => inside(p, a) && distanceToPolygon(p, a) > 1e-5)) return true;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    const p = intersection(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length]);
    if (p && pointDistance(p, a[i], a[i]) > 1e-5 && pointDistance(p, a[(i + 1) % a.length], a[(i + 1) % a.length]) > 1e-5
      && pointDistance(p, b[j], b[j]) > 1e-5 && pointDistance(p, b[(j + 1) % b.length], b[(j + 1) % b.length]) > 1e-5) return true;
  }
  return false;
}
function configurableLayout(view: GraphView, compact: boolean, options: Options, sizes: Record<string, Size>): PlacedGraph {
  if (!options.spacing && !options.semantic && !(options.reserveLabels && view.edges.every(e => sizes[e.from + '-' + e.to]))) return layoutGraph(null, view.nodes, view.edges, compact);
  const g = new dagre.graphlib.Graph();
  const factor = options.spacing ? 1.25 : 1;
  g.setGraph({ rankdir: 'TB', nodesep: (compact ? 16 : 24) * factor, ranksep: (compact ? 48 : 68) * factor, edgesep: 20 * factor });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of view.nodes) g.setNode(n.id, { width: n.shape === 'hexagon' ? 294 : 260, height: 42 + Math.max(1, n.labelLines.length) * 16 });
  for (const e of view.edges) if (!options.semantic || !feedback.has(e.from + '-' + e.to)) g.setEdge(e.from, e.to, options.reserveLabels ? sizes[e.from + '-' + e.to] : {});
  dagre.layout(g);
  const boxes = new Map<string, NodeBox>();
  for (const n of view.nodes) {
    const b = g.node(n.id) as { x: number; y: number; width: number; height: number };
    boxes.set(n.id, { id: n.id, left: Math.round(b.x - b.width / 2) + 16, top: Math.round(b.y - b.height / 2) + 16, width: b.width, height: b.height });
  }
  const paths = view.edges.map(e => {
    const found = g.edge(e.from, e.to) as { points?: Point[] } | undefined;
    const a = boxes.get(e.from)!, b = boxes.get(e.to)!;
    const points = found?.points?.map(p => ({ x: p.x + 16, y: p.y + 16 })) ?? [{ x: a.left + a.width / 2, y: a.top }, { x: b.left + b.width / 2, y: b.top + b.height }];
    return { ...e, key: e.from + '-' + e.to, segments: segments(points, e.from + '-' + e.to) };
  });
  let canvasWidth = Math.max(...[...boxes.values()].map(b => b.left + b.width)) + 16;
  const canvasHeight = Math.max(...[...boxes.values()].map(b => b.top + b.height)) + 16;
  const positions = edgeLabelPlacements(paths);
  const leftPositions = [...positions.values()].filter(p => p.align === 'end');
  if (leftPositions.length) {
    const minLeft = Math.min(...leftPositions.map(p => p.x - 160));
    const maxRight = Math.max(...[...positions.values()].filter(p => p.align === 'start').map(p => p.x + 160));
    const shift = Math.max(0, 4 - minLeft), extend = Math.max(0, maxRight + 4 - canvasWidth);
    for (const b of boxes.values()) b.left += shift;
    for (const p of paths) for (const s of p.segments) s.left += shift;
    canvasWidth += shift + extend;
  }
  return { boxes, rootBox: null, entryIds: [], paths, segments: paths.flatMap(p => p.segments), canvasWidth, canvasHeight };
}
function simplify(points: Point[]): Point[] {
  const result: Point[] = [];
  for (const p of points) {
    if (result.length && Math.hypot(p.x - result.at(-1)!.x, p.y - result.at(-1)!.y) < 0.001) continue;
    while (result.length >= 2) {
      const a = result.at(-2)!, b = result.at(-1)!;
      if (Math.abs((b.x - a.x) * (p.y - b.y) - (b.y - a.y) * (p.x - b.x)) > 1e-6) break;
      result.pop();
    }
    result.push(p);
  }
  return result;
}
// 노드 경계로 구성한 직교 가시성 격자에서 최단 경로를 찾는다. 선 교차 비용은 추가하지 않는다.
function route(a: Point, b: Point, boxes: NodeBox[]): Point[] | null {
  const xs = [...new Set([a.x, b.x, ...boxes.flatMap(n => [n.left - 8, n.left + n.width + 8])])].sort((x, y) => x - y);
  const ys = [...new Set([a.y, b.y, ...boxes.flatMap(n => [n.top - 8, n.top + n.height + 8])])].sort((x, y) => x - y);
  const polys = boxes.map(n => rect(n));
  const start = ys.indexOf(a.y) * xs.length + xs.indexOf(a.x), target = ys.indexOf(b.y) * xs.length + xs.indexOf(b.x);
  const pt = (index: number) => ({ x: xs[index % xs.length], y: ys[Math.floor(index / xs.length)] });
  const cost = new Map([[start, 0]]), prev = new Map<number, number>();
  const open = [{ index: start, score: Math.abs(a.x - b.x) + Math.abs(a.y - b.y) }];
  const closed = new Set<number>();
  while (open.length) {
    open.sort((x, y) => y.score - x.score);
    const { index } = open.pop()!;
    if (closed.has(index)) continue;
    if (index === target) {
      const result: Point[] = [pt(index)]; let current = index;
      while (prev.has(current)) { current = prev.get(current)!; result.unshift(pt(current)); }
      return simplify(result);
    }
    closed.add(index);
    const x = index % xs.length, y = Math.floor(index / xs.length), p = pt(index);
    const neighbours = [x > 0 ? index - 1 : -1, x + 1 < xs.length ? index + 1 : -1, y > 0 ? index - xs.length : -1, y + 1 < ys.length ? index + xs.length : -1];
    for (const next of neighbours) {
      if (next < 0 || closed.has(next)) continue;
      const q = pt(next);
      if (polys.some(poly => pierces(p, q, poly))) continue;
      const proposed = cost.get(index)! + Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
      if (proposed >= (cost.get(next) ?? Infinity)) continue;
      cost.set(next, proposed); prev.set(next, index);
      open.push({ index: next, score: proposed + Math.abs(q.x - b.x) + Math.abs(q.y - b.y) });
    }
  }
  return null;
}
export type Experiment = {
  placed: PlacedGraph; physical: PhysicalPath[]; labels: Label[]; options: Options;
  measuredLabels: boolean; lanes: { left: number[]; right: number[] }; routeFailures: string[];
  classifications: Array<{ key: string; geometric: boolean; semantic: boolean }>;
};
export function experiment(view: GraphView, compact: boolean, options: Options, sizes: Record<string, Size> = {}): Experiment {
  const original = configurableLayout(view, compact, options, sizes);
  const physical: PhysicalPath[] = [];
  const seen = new Set<string>();
  for (const p of original.paths) {
    if (seen.has(p.key)) continue;
    const direction = view.edges.find(e => e.from === p.from && e.to === p.to)!;
    const reverse = options.merge && view.edges.find(e => e.from === p.to && e.to === p.from);
    seen.add(p.key); if (reverse) seen.add(reverse.from + '-' + reverse.to);
    physical.push({ key: p.key, directions: reverse ? [direction, reverse] : [direction], points: pointsOf(p.segments) });
  }
  const boxes = [...original.boxes.values()];
  const ports = new Map<string, Array<{ path: PhysicalPath; end: number; side: 'top' | 'bottom' }>>();
  if (options.ports) for (const path of physical) {
    const d = path.directions[0];
    for (const [id, end] of [[d.from, 0], [d.to, path.points.length - 1]] as const) {
      const box = original.boxes.get(id)!, other = path.points[end === 0 ? 1 : end - 1];
      const side = other.y < box.top + box.height / 2 ? 'top' : 'bottom';
      const key = id + ':' + side;
      ports.set(key, [...(ports.get(key) ?? []), { path, end, side }]);
    }
  }
  for (const [key, list] of ports) {
    const b = visibleBox(original.boxes.get(key.split(':')[0])!, view);
    list.sort((a, c) => a.path.points[a.end].x - c.path.points[c.end].x || a.path.key.localeCompare(c.path.key));
    list.forEach((entry, i) => {
      const point = { x: b.left + b.width / 2 + (i - (list.length - 1) / 2) * options.ports!, y: entry.side === 'top' ? b.top : b.top + b.height };
      entry.path.points[entry.end] = point;
    });
  }
  const lanes: Experiment['lanes'] = { left: [], right: [] }, routeFailures: string[] = [];
  const classifications = view.edges.map(e => {
    const a = original.boxes.get(e.from)!, b = original.boxes.get(e.to)!;
    return { key: e.from + '-' + e.to, geometric: b.top + b.height / 2 < a.top + a.height / 2, semantic: feedback.has(e.from + '-' + e.to) };
  }).filter(c => c.geometric !== c.semantic);
  for (const path of physical) {
    const d = path.directions[0], aBox = visibleBox(original.boxes.get(d.from)!, view), bBox = visibleBox(original.boxes.get(d.to)!, view);
    const exterior = options.lanes && path.directions.some(e => options.semantic ? feedback.has(e.from + '-' + e.to)
      : original.boxes.get(e.to)!.top + original.boxes.get(e.to)!.height / 2 < original.boxes.get(e.from)!.top + original.boxes.get(e.from)!.height / 2);
    if (!exterior && !options.orthogonal) continue;
    // 직교화와 외곽 라우팅의 출입은 실제 노드 위·아래 변에 고정한다.
    const a = { x: path.points[0].x, y: path.points[0].y < aBox.top + aBox.height / 2 ? aBox.top : aBox.top + aBox.height };
    const b = { x: path.points.at(-1)!.x, y: path.points.at(-1)!.y < bBox.top + bBox.height / 2 ? bBox.top : bBox.top + bBox.height };
    a.x = Math.max(aBox.left + 18, Math.min(aBox.left + aBox.width - 18, a.x));
    b.x = Math.max(bBox.left + 18, Math.min(bBox.left + bBox.width - 18, b.x));
    const outA = { x: a.x, y: a.y + (a.y === aBox.top ? -8 : 8) }, outB = { x: b.x, y: b.y + (b.y === bBox.top ? -8 : 8) };
    let routed: Point[] | null;
    if (exterior) {
      const side = lanes.left.length <= lanes.right.length ? 'left' : 'right';
      const x = side === 'left' ? Math.min(...boxes.map(n => n.left)) - 20 - lanes.left.length * options.lanes!
        : Math.max(...boxes.map(n => n.left + n.width)) + 20 + lanes.right.length * options.lanes!;
      lanes[side].push(x);
      const p = { x, y: outA.y }, q = { x, y: outB.y };
      const entry = route(outA, p, boxes.map(box => visibleBox(box, view))), exit = route(q, outB, boxes.map(box => visibleBox(box, view)));
      routed = entry && exit ? simplify([a, ...entry, q, ...exit, b]) : null;
    } else {
      const middle = route(outA, outB, boxes.map(box => visibleBox(box, view)));
      routed = middle ? simplify([a, ...middle, b]) : null;
    }
    if (routed) path.points = routed; else routeFailures.push(path.key);
  }
  const paths = physical.map(p => ({ ...p.directions[0], key: p.key, label: p.directions.length === 1 ? p.directions[0].label : null,
    segments: options.ports || options.lanes || options.orthogonal ? segments(p.points, p.key) : original.paths.find(path => path.key === p.key)!.segments.map(s => ({ ...s })) }));
  // 지표는 실제 View의 반올림된 선 조각으로 계산한다.
  physical.forEach((p, i) => p.points = pointsOf(paths[i].segments));
  const placements = edgeLabelPlacements(original.paths), measuredLabels = view.edges.every(e => sizes[e.from + '-' + e.to] != null);
  const labels: Label[] = [];
  for (const path of physical) path.directions.forEach((e, index) => {
    const key = e.from + '-' + e.to, size = sizes[key] ?? { width: 0, height: 0 };
    const paired = path.directions.length === 2;
    const text = paired ? `${e.from}→${e.to} ${e.dashed ? '[점선]' : '[실선]'} ${e.label ?? ''}` : e.label ?? '';
    const old = placements.get(key);
    const t = paired && options.labelMode === 'arrival' ? (index === 0 ? 0.85 : 0.15) : 0.5;
    const point = pointAlongSegments(paths.find(p => p.key === path.key)!.segments, t)!;
    const isUnchanged = !options.merge && !options.ports && !options.lanes && !options.orthogonal && !options.spacing && !options.semantic && !options.reserveLabels;
    const x = isUnchanged && old ? old.x : point.x;
    const y = isUnchanged && old ? old.y : point.y;
    const align = paired ? (index === 0 ? 'end' : 'start') : isUnchanged && old ? old.align : 'center';
    let label: Label = { key, pathKey: path.key, text, ...size, left: align === 'end' ? x - size.width - (paired ? 4 : 0) : align === 'start' ? x + (paired ? 4 : 0) : x - size.width / 2,
      top: y - size.height / 2, identified: paired };
    if (options.avoidLabels && measuredLabels) {
      let best: Label | null = null, score = Infinity;
      for (const s of paths.find(p => p.key === path.key)!.segments) for (const t of [0.25, 0.5, 0.75]) for (const sign of [-1, 1]) {
        const p = pointAlongSegments([s], t)!;
        const rad = s.deg * Math.PI / 180, nx = -Math.sin(rad), ny = Math.cos(rad);
        const offset = Math.abs(nx) * size.width / 2 + Math.abs(ny) * size.height / 2 + options.avoidLabels;
        const candidate = { ...label, left: p.x + nx * offset * sign - size.width / 2, top: p.y + ny * offset * sign - size.height / 2 };
        const corners = rect(candidate);
        const collisions = boxes.filter(b => polygonsOverlap(corners, polygon(b, view.nodes.find(n => n.id === b.id)!.shape))).length
          + labels.filter(l => polygonsOverlap(corners, rect(l))).length
          + physical.filter(other => other.key !== path.key && rectPathDistance(candidate, other.points) === 0).length;
        const distance = rectPathDistance(candidate, path.points);
        const value = collisions * 1e6 + (distance > options.avoidLabels ? 1e5 : 0) + Math.hypot(candidate.left - label.left, candidate.top - label.top);
        if (value < score) { score = value; best = candidate; }
      }
      if (best) label = best;
    }
    labels.push(label);
  });
  const allPoints = physical.flatMap(p => p.points);
  if (Object.keys(options).length === 0) return { placed: original, physical, labels, options, measuredLabels, lanes, routeFailures, classifications };
  const minX = Math.min(0, ...allPoints.map(p => p.x), ...labels.map(l => l.left));
  const minY = Math.min(0, ...allPoints.map(p => p.y), ...labels.map(l => l.top));
  const shiftX = -minX, shiftY = -minY;
  if (shiftX || shiftY) {
    for (const b of boxes) { b.left += shiftX; b.top += shiftY; }
    for (const p of physical) for (const pt of p.points) { pt.x += shiftX; pt.y += shiftY; }
    for (const l of labels) { l.left += shiftX; l.top += shiftY; }
    paths.forEach(p => p.segments.forEach(s => { s.left += shiftX; s.top += shiftY; }));
    lanes.left = lanes.left.map(x => x + shiftX); lanes.right = lanes.right.map(x => x + shiftX);
  }
  const placed = { ...original, paths, segments: paths.flatMap(p => p.segments),
    canvasWidth: Math.max(...boxes.map(b => b.left + b.width), ...physical.flatMap(p => p.points.map(v => v.x)), ...labels.map(l => l.left + l.width)) + 16,
    canvasHeight: Math.max(...boxes.map(b => b.top + b.height), ...physical.flatMap(p => p.points.map(v => v.y)), ...labels.map(l => l.top + l.height)) + 16 };
  return { placed, physical, labels, options, measuredLabels, lanes, routeFailures, classifications };
}
