import dagre from './vendor/dagre';
import { mermaidNodeOrder, mermaidEdgeOrder } from './fixture/mermaid-order';
import { layoutGraph, edgeLabelPlacements, type EdgeSegment, type NodeBox, type PlacedGraph } from './motion-logic';
import type { GraphView } from './graph-types';
import { segments, type Point } from './experiment';

export const ROUND2_CANDIDATES = [
  { id: 'baseline', title: '개선 전', description: '현재 노드 배치와 직선 관계선을 그대로 표시합니다.', order: false, curve: false },
  { id: 'order', title: '배치 순서', description: '피드백은 배치 계산에서 뒤집어 본 흐름을 아래로 배치합니다. 화살표는 원래 방향입니다.', order: true, curve: false },
  { id: 'curve', title: '곡선', description: '현재 노드 위치를 유지하고 관계선의 꺾임만 부드러운 곡선으로 바꿉니다.', order: false, curve: true },
  { id: 'orderCurve', title: '배치 순서 + 곡선', description: '본 흐름 배치와 부드러운 곡선 관계선을 함께 적용합니다.', order: true, curve: true },
] as const;
export type Round2Candidate = typeof ROUND2_CANDIDATES[number];
export const isFeedback = (label: string | null) => label?.startsWith('피드백') ?? false;

export function dagreInput(view: GraphView, ordered: boolean) {
  const nodes = ordered ? mermaidNodeOrder.map(id => view.nodes.find(n => n.id === id)!) : view.nodes;
  const edges = ordered ? mermaidEdgeOrder.map(key => view.edges.find(e => e.from + '-' + e.to === key)!) : view.edges;
  return { nodes, edges: edges.map(e => ({ ...e, key: e.from + '-' + e.to, reversedForLayout: ordered && isFeedback(e.label),
    v: ordered && isFeedback(e.label) ? e.to : e.from, w: ordered && isFeedback(e.label) ? e.from : e.to })) };
}
export function makeDagre(view: GraphView, compact: boolean, ordered: boolean) {
  // 뒤집은 피드백과 같은 방향의 본 흐름은 별개 관계이므로 named multigraph로 보존한다.
  const g = new dagre.graphlib.Graph(ordered ? { multigraph: true } : undefined);
  g.setGraph({ rankdir: 'TB', nodesep: compact ? 16 : 24, ranksep: compact ? 48 : 68 });
  g.setDefaultEdgeLabel(() => ({}));
  const input = dagreInput(view, ordered);
  for (const n of input.nodes) g.setNode(n.id, { width: n.shape === 'hexagon' ? 294 : 260, height: 42 + Math.max(1, n.labelLines.length) * 16 });
  for (const e of input.edges) g.setEdge(e.v, e.w, {}, ordered ? e.key : undefined);
  return { g, input };
}

// d3 curveBasis と同じ端点補間・三次 B-spline の重みを使う。各 View は最大 8px。
export function basisPoints(points: Point[]): Point[] {
  if (points.length < 3) return points.map(p => ({ ...p }));
  const result: Point[] = [{ ...points[0] }];
  const blend = (a: Point, b: Point, wa: number, wb: number, divisor: number) => ({ x: (a.x * wa + b.x * wb) / divisor, y: (a.y * wa + b.y * wb) / divisor });
  const addLine = (to: Point) => {
    const from = result.at(-1)!, count = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 8));
    for (let i = 1; i <= count; i++) result.push({ x: from.x + (to.x - from.x) * i / count, y: from.y + (to.y - from.y) * i / count });
  };
  const midpoint = (a: Point, b: Point) => blend(a, b, 1, 1, 2);
  const flatness = (p: Point, a: Point, b: Point) => {
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    return span ? Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / span : Math.hypot(p.x - a.x, p.y - a.y);
  };
  const cubic = (a: Point, b: Point, c: Point, d: Point) => {
    const length = Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y) + Math.hypot(d.x - c.x, d.y - c.y);
    if (length <= 8 && Math.max(flatness(b, a, d), flatness(c, a, d)) <= 0.2) { result.push(d); return; }
    const ab = midpoint(a, b), bc = midpoint(b, c), cd = midpoint(c, d), abc = midpoint(ab, bc), bcd = midpoint(bc, cd), middle = midpoint(abc, bcd);
    cubic(a, ab, abc, middle); cubic(middle, bcd, cd, d);
  };
  addLine(blend(points[0], points[1], 5, 1, 6));
  const addBasis = (a: Point, b: Point, c: Point) => cubic(result.at(-1)!, blend(a, b, 2, 1, 3), blend(a, b, 1, 2, 3),
    { x: (a.x + 4 * b.x + c.x) / 6, y: (a.y + 4 * b.y + c.y) / 6 });
  for (let i = 2; i < points.length; i++) addBasis(points[i - 2], points[i - 1], points[i]);
  addBasis(points.at(-2)!, points.at(-1)!, points.at(-1)!);
  addLine(points.at(-1)!);
  return result;
}
export function curveSegments(points: Point[], key: string): EdgeSegment[] {
  return points.slice(1).flatMap((b, i) => {
    const a = points[i], width = Math.hypot(b.x - a.x, b.y - a.y);
    return width < 1e-8 ? [] : [{ key: key + '-' + i, left: a.x, top: a.y - 1, width, deg: Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI }];
  });
}
export function round2Layout(view: GraphView, compact: boolean, candidate: Round2Candidate) {
  const { g, input } = makeDagre(view, compact, candidate.order);
  dagre.layout(g);
  const boxes = new Map<string, NodeBox>(), rawPoints: Record<string, Point[]> = {};
  for (const n of input.nodes) {
    const position = g.node(n.id) as { x: number; y: number; width: number; height: number };
    boxes.set(n.id, { id: n.id, left: Math.round(position.x - position.width / 2) + 16, top: Math.round(position.y - position.height / 2) + 16, width: position.width, height: position.height });
  }
  for (const e of input.edges) {
    const edge = g.edge(e.v, e.w, candidate.order ? e.key : undefined) as { points: Point[] };
    rawPoints[e.key] = (e.reversedForLayout ? [...edge.points].reverse() : edge.points).map(p => ({ x: p.x + 16, y: p.y + 16 }));
  }
  const ranks = [...new Set(input.nodes.map(n => (g.node(n.id) as { rank: number }).rank))].sort((a, b) => a - b).map(rank => ({ rank,
    nodes: input.nodes.filter(n => (g.node(n.id) as { rank: number }).rank === rank).sort((a, b) => boxes.get(a.id)!.left - boxes.get(b.id)!.left).map(n => n.id) }));
  let placed: PlacedGraph;
  if (!candidate.order) {
    placed = layoutGraph(null, view.nodes, view.edges, compact);
    const first = input.nodes[0].id, shift = placed.boxes.get(first)!.left - boxes.get(first)!.left;
    for (const points of Object.values(rawPoints)) for (const p of points) p.x += shift;
  } else {
    const paths = input.edges.map(e => ({ ...e, key: e.key, from: e.from, to: e.to, segments: segments(rawPoints[e.key], e.key) }));
    let canvasWidth = Math.max(...[...boxes.values()].map(b => b.left + b.width)) + 16;
    const positions = edgeLabelPlacements(paths), end = [...positions.values()].filter(p => p.align === 'end');
    if (end.length) {
      const shift = Math.max(0, 4 - Math.min(...end.map(p => p.x - 160)));
      const extend = Math.max(0, Math.max(...[...positions.values()].filter(p => p.align === 'start').map(p => p.x + 160)) + 4 - canvasWidth);
      for (const b of boxes.values()) b.left += shift;
      for (const p of paths) for (const s of p.segments) s.left += shift;
      for (const points of Object.values(rawPoints)) for (const p of points) p.x += shift;
      canvasWidth += shift + extend;
    }
    placed = { boxes, paths, rootBox: null, entryIds: [], segments: paths.flatMap(p => p.segments), canvasWidth,
      canvasHeight: Math.max(...[...boxes.values()].map(b => b.top + b.height)) + 16 };
  }
  if (candidate.curve) {
    const paths = placed.paths.map(p => ({ ...p, segments: curveSegments(basisPoints(rawPoints[p.key]), p.key) }));
    placed = { ...placed, paths, segments: paths.flatMap(p => p.segments) };
  }
  return { placed, ranks, input, rawPoints };
}
