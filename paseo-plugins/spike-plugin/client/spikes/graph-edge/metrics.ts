import { distanceToPolygon, intersection, pierces, pointDistance, polygon, nodeContour, polygonsOverlap, rectPathDistance, type Experiment, type Point, type Label } from './experiment';
import type { GraphView } from './graph-types';

const length = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
const lineSegments = (points: Point[]) => points.slice(1).map((b, i) => [points[i], b] as const);
const rectangle = (l: Label) => polygon({ id: '', ...l }, 'rect');
function parallel(a: Point, b: Point, c: Point, d: Point) {
  const span = length(a, b), other = length(c, d);
  if (span < 0.001 || other < 0.001) return null;
  const ux = (b.x - a.x) / span, uy = (b.y - a.y) / span;
  if (Math.abs(ux * (d.y - c.y) - uy * (d.x - c.x)) / other > 1e-5) return null;
  const project = (p: Point) => (p.x - a.x) * ux + (p.y - a.y) * uy;
  const low = Math.max(0, Math.min(project(c), project(d))), high = Math.min(span, Math.max(project(c), project(d)));
  return { overlap: Math.max(0, high - low), distance: Math.abs((c.x - a.x) * uy - (c.y - a.y) * ux) };
}
export function metrics(view: GraphView, ex: Experiment) {
  const polys = new Map(view.nodes.map(n => [n.id, nodeContour(ex.placed.boxes.get(n.id)!, view)]));
  const drawnSegments = (key: string) => ex.placed.paths.find(p => p.key === key)!.segments.map(s => [
    { x: s.left, y: s.top + 1 }, { x: s.left + Math.cos(s.deg * Math.PI / 180) * s.width, y: s.top + 1 + Math.sin(s.deg * Math.PI / 180) * s.width },
  ] as const);
  let crossings = 0, densePairs = 0, overlapLength = 0;
  for (let i = 0; i < ex.physical.length; i++) for (let j = i + 1; j < ex.physical.length; j++) {
    const a = ex.physical[i], b = ex.physical[j], points: Point[] = [];
    const shared = [a.directions[0].from, a.directions[0].to].filter(id => [b.directions[0].from, b.directions[0].to].includes(id));
    for (const [p, q] of drawnSegments(a.key)) for (const [r, s] of drawnSegments(b.key)) {
      const hit = intersection(p, q, r, s);
      const normalContact = hit && shared.some(id => distanceToPolygon(hit, polys.get(id)!) <= 1
        && [a.points[0], a.points.at(-1)!].some(v => length(v, hit) <= 1)
        && [b.points[0], b.points.at(-1)!].some(v => length(v, hit) <= 1));
      if (hit && !normalContact && !points.some(v => length(v, hit) <= 1)) points.push(hit);
      const close = parallel(p, q, r, s);
      if (close && close.overlap >= 40 && close.distance < 8) densePairs++;
      if (close && close.distance < 1e-5) overlapLength += close.overlap;
    }
    crossings += points.length;
  }
  const penetratingPairs: string[] = [], invalidEndpoints: string[] = [];
  const contacts = new Map<string, Point[]>();
  let maxBends = 0, totalBends = 0, totalLength = 0;
  for (const p of ex.physical) {
    for (const [id, poly] of polys) if (drawnSegments(p.key).some(([a, b]) => pierces(a, b, poly))) penetratingPairs.push(p.key + ':' + id);
    for (const [id, pt] of [[p.directions[0].from, p.points[0]], [p.directions[0].to, p.points.at(-1)!]] as const) {
      const poly = polys.get(id)!;
      if (distanceToPolygon(pt, poly) > 1) invalidEndpoints.push(p.key + ':' + id);
      const side = poly.map((a, i) => pointDistance(pt, a, poly[(i + 1) % poly.length])).reduce((best, value, i, distances) => value < distances[best] ? i : best, 0);
      const key = id + ':' + side;
      contacts.set(key, [...(contacts.get(key) ?? []), pt]);
    }
    const segs = drawnSegments(p.key);
    let bends = 0;
    segs.forEach(([a, b], i) => {
      totalLength += length(a, b);
      if (!i) return;
      const [c, d] = segs[i - 1];
      const difference = Math.abs((Math.atan2(b.y - a.y, b.x - a.x) - Math.atan2(d.y - c.y, d.x - c.x)) * 180 / Math.PI);
      if (Math.min(difference, 360 - difference) >= 5) bends++;
    });
    totalBends += bends; maxBends = Math.max(maxBends, bends);
  }
  const portDistances: number[] = [];
  for (const list of contacts.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) portDistances.push(length(list[i], list[j]));
  const all = [...polys.values()].flat().concat(ex.physical.flatMap(p => drawnSegments(p.key).flat()));
  // 고정 화살촉(9×8)의 실제 방향 삼각형을 경계에 포함한다.
  for (const p of ex.physical) {
    const ends = [p.points.length - 1, ...(p.directions.length === 2 ? [0] : [])];
    for (const index of ends) {
      const tip = p.points[index], near = p.points[index === 0 ? 1 : index - 1], span = length(near, tip);
      const ux = (tip.x - near.x) / (span || 1), uy = (tip.y - near.y) / (span || 1);
      all.push({ x: tip.x - 9 * ux - 4 * uy, y: tip.y - 9 * uy + 4 * ux }, { x: tip.x - 9 * ux + 4 * uy, y: tip.y - 9 * uy - 4 * ux });
    }
  }
  let labelNode: number | null = null, labelLabel: number | null = null, ambiguous: number | null = null,
    coversOther: number | null = null, maxLabelDistance: number | null = null, p95LabelDistance: number | null = null;
  if (ex.measuredLabels) {
    labelNode = 0; labelLabel = 0; ambiguous = 0; coversOther = 0;
    const distances: number[] = [];
    for (let i = 0; i < ex.labels.length; i++) {
      const l = ex.labels[i], poly = rectangle(l), own = ex.physical.find(p => p.key === l.pathKey)!;
      const distance = rectPathDistance(l, own.points); distances.push(distance); all.push(...poly);
      for (const np of polys.values()) if (polygonsOverlap(poly, np)) labelNode++;
      for (let j = 0; j < i; j++) if (polygonsOverlap(poly, rectangle(ex.labels[j]))) labelLabel++;
      let unclear = false, covered = false;
      for (const p of ex.physical) if (p.key !== l.pathKey) {
        const other = rectPathDistance(l, p.points);
        if (!l.identified && (other < distance || Math.abs(other - distance) < 4)) unclear = true;
        if (lineSegments(p.points).some(([a, b]) => pierces(a, b, poly))) covered = true;
      }
      if (unclear) ambiguous++; if (covered) coversOther++;
    }
    distances.sort((a, b) => a - b);
    maxLabelDistance = distances.at(-1) ?? 0; p95LabelDistance = distances[Math.max(0, Math.ceil(distances.length * 0.95) - 1)] ?? 0;
  }
  const width = Math.max(...all.map(p => p.x)) - Math.min(...all.map(p => p.x));
  const height = Math.max(...all.map(p => p.y)) - Math.min(...all.map(p => p.y));
  const intervals = [...ex.lanes.left, ...ex.lanes.right].length ? [ex.lanes.left, ex.lanes.right].flatMap(side => side.slice(1).map((x, i) => Math.abs(x - side[i]))) : [];
  const logical = ex.physical.flatMap(p => p.directions);
  const missingInformation = view.edges.filter(e => !logical.some(d => JSON.stringify(d) === JSON.stringify(e))).length;
  return { crossings, penetratingPairs: penetratingPairs.length, penetratingDetails: penetratingPairs,
    minPortDistance: portDistances.length ? Math.min(...portDistances) : null, invalidEndpoints: invalidEndpoints.length, invalidEndpointDetails: invalidEndpoints,
    maxLabelDistance, p95LabelDistance, ambiguous, coversOther, labelNode, labelLabel,
    width, height, area: width * height, boundsIncludeMeasuredLabels: ex.measuredLabels,
    lanesLeft: ex.lanes.left.length, lanesRight: ex.lanes.right.length, minLaneDistance: intervals.length ? Math.min(...intervals) : null,
    densePairs, overlapLength, physicalPaths: ex.physical.length, logicalDirections: logical.length,
    totalLength, totalBends, maxBends, missingInformation, routeFailures: ex.routeFailures };
}
export type Metrics = ReturnType<typeof metrics>;
export function thresholds(b: Metrics, c: Metrics, merged: boolean, expectedDirections: number, pairs: number) {
  const labelsKnown = c.boundsIncludeMeasuredLabels && b.boundsIncludeMeasuredLabels;
  return {
    crossings: c.crossings <= (b.crossings ? Math.floor(b.crossings * 0.7) : 0),
    penetration: c.penetratingPairs === 0,
    ports: (c.minPortDistance == null || c.minPortDistance >= 12 && c.minPortDistance >= (b.minPortDistance ?? 0)) && c.invalidEndpoints === 0,
    labelDistance: labelsKnown ? c.maxLabelDistance! <= 16 && c.p95LabelDistance! <= Math.max(b.p95LabelDistance!, 8) : null,
    labelOwnership: labelsKnown ? c.ambiguous === 0 && c.coversOther === 0 : null,
    labelOverlap: labelsKnown ? c.labelNode === 0 && c.labelLabel === 0 : null,
    bounds: labelsKnown ? c.width / b.width <= 1.25 && c.height / b.height <= 1.25 && c.area / b.area <= 1.4 : null,
    bundles: (c.minLaneDistance == null || c.minLaneDistance >= 12) && c.densePairs <= b.densePairs && c.overlapLength <= b.overlapLength + 1e-5,
    paths: c.physicalPaths === expectedDirections - (merged ? pairs : 0) && c.logicalDirections === expectedDirections
      && c.totalLength <= 1.2 * b.totalLength && c.maxBends <= b.maxBends + 2,
    informationData: c.missingInformation === 0,
    informationScreen: null,
    stabilityScreen: null,
  };
}
