import dagre from "./vendor/dagre";
import type { PluginTheme } from "@getpaseo/plugin";
import type { GraphNodeShape, GraphNodeStatus } from "../shared/graphs";

export type NodeBox = { id: string; left: number; top: number; width: number; height: number };

export type EdgeSegment = { key: string; left: number; top: number; width: number; deg: number };

export type EdgePath = {
  key: string;
  from: string;
  to: string;
  segments: EdgeSegment[];
  dashed: boolean;
  label: string | null;
};

export type PlacedGraph = {
  boxes: Map<string, NodeBox>;
  rootBox: NodeBox | null;
  entryIds: string[];
  segments: EdgeSegment[];
  paths: EdgePath[];
  canvasWidth: number;
  canvasHeight: number;
};

export type NodeStatus = GraphNodeStatus;

export type GraphThemeColors = PluginTheme["colors"];

export const LINE_HEIGHT = 16;
export const BADGE_HEIGHT = 22;
export const NODE_RADIUS = 12;
export const STATUS_BAR_WIDTH = 3;
export const EDGE_LABEL_MAX_WIDTH = 160;
const EDGE_LABEL_GAP = 8;
const EDGE_LABEL_MARGIN = 4;
/** 육각형 게이트 카드의 좌우 삼각형 폭. 카드 상자를 이만큼 넓혀 배치한다. */
export const GATE_ARM_WIDTH = 17;

export const NODE_SHADOW = { offsetX: 0, offsetY: 2, blurRadius: 8, color: "#00000026" } as const;

export const STATUS_SCALE: Record<NodeStatus, number> = {
  대기: 1,
  "실행 중": 1.04,
  완료: 1.025,
  실패: 1.03,
  생략: 1,
};

export const STATUS_ICON: Record<NodeStatus, string> = {
  대기: "Clock",
  "실행 중": "Play",
  완료: "Check",
  실패: "X",
  생략: "SkipForward",
};

export const STATUS_MOTION_MS = 280;
export const LAYOUT_MOVE_MS = 400;
export const INTRO_STAGGER_MS = 70;
export const INTRO_FADE_MS = 200;
export const EXIT_FADE_MS = 280;
export const PULSE_MS = 700;
export const FLOW_PERIOD_MS = 1600;

const ROOT_WIDTH = 400;
const NODE_PAD_Y = 10;
const ROOT_HEIGHT = BADGE_HEIGHT + NODE_PAD_Y * 2 + LINE_HEIGHT * 2 + 12;
const NODE_WIDTH = 260;
const PAD = 16;

function segmentMetrics(ax: number, ay: number, bx: number, by: number): EdgeSegment | null {
  const dx = bx - ax;
  const dy = by - ay;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length < 1) {
    return null;
  }
  return {
    key: "",
    left: ax,
    top: ay - 1,
    width: Math.round(length),
    // dagre routes with diagonal bends, so the rotation is the real angle of the segment.
    deg: (Math.atan2(dy, dx) * 180) / Math.PI,
  };
}

function segmentsFromPoints(keyBase: string, points: Array<{ x: number; y: number }>) {
  const drawn: EdgeSegment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const follow = segmentMetrics(points[i].x, points[i].y, points[i + 1].x, points[i + 1].y);
    if (follow == null) {
      continue;
    }
    drawn.push({ ...follow, key: `${keyBase}-${i}` });
  }
  return drawn;
}

function nodeHeight(lineCount: number) {
  return BADGE_HEIGHT + NODE_PAD_Y * 2 + Math.max(1, lineCount) * LINE_HEIGHT;
}

/** 육각형 게이트는 좌우 삼각형만큼 넓은 상자에 담긴다. 선은 그 상자 경계에서 멈춘다. */
function nodeWidth(shape: GraphNodeShape) {
  return shape === "hexagon" ? NODE_WIDTH + GATE_ARM_WIDTH * 2 : NODE_WIDTH;
}

export function layoutGraph(
  root: { id: string } | null,
  nodes: Array<{ id: string; labelLines: string[]; shape: GraphNodeShape }>,
  edges: Array<{ from: string; to: string; dashed: boolean; label: string | null }>,
  compact: boolean,
) {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({
    rankdir: "TB",
    nodesep: compact ? 16 : 24,
    // 단계 간격은 엣지 라벨이 들어갈 자리다. 라벨이 도착 노드 경계에 붙어 보이지 않도록
    // 두 줄짜리 라벨 높이(30)보다 넉넉하게 둔다.
    ranksep: compact ? 48 : 68,
  });
  graph.setDefaultEdgeLabel(() => ({}));
  const sizes = new Map(
    nodes.map((node) => [
      node.id,
      { width: nodeWidth(node.shape), height: nodeHeight(node.labelLines.length) },
    ]),
  );
  if (root != null) {
    graph.setNode(root.id, { width: ROOT_WIDTH, height: ROOT_HEIGHT });
  }
  for (const node of nodes) {
    const size = sizes.get(node.id) ?? { width: NODE_WIDTH, height: nodeHeight(1) };
    graph.setNode(node.id, { width: size.width, height: size.height });
  }
  const incomingCount = new Map<string, number>();
  for (const edge of edges) {
    graph.setEdge(edge.from, edge.to);
    incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1);
  }
  const entryIds = nodes
    .map((node) => node.id)
    .filter((id) => (incomingCount.get(id) ?? 0) === 0);
  if (root != null) {
    for (const id of entryIds) {
      graph.setEdge(root.id, id);
    }
  }
  // dagre resolves cycles itself, so a back edge is laid out like any other edge and stays in the
  // drawing. Node coordinates are centers; boxes are top-left based.
  dagre.layout(graph);
  const boxes = new Map<string, NodeBox>();
  const place = (id: string, width: number, height: number) => {
    const node = graph.node(id) as { x: number; y: number } | undefined;
    const box: NodeBox = {
      id,
      left: Math.round((node?.x ?? 0) - width / 2) + PAD,
      top: Math.round((node?.y ?? 0) - height / 2) + PAD,
      width,
      height,
    };
    boxes.set(id, box);
    return box;
  };
  for (const node of nodes) {
    const size = sizes.get(node.id) ?? { width: NODE_WIDTH, height: nodeHeight(1) };
    place(node.id, size.width, size.height);
  }
  const rootBox = root == null ? null : place(root.id, ROOT_WIDTH, ROOT_HEIGHT);
  let canvasWidth = PAD * 2;
  let canvasHeight = PAD * 2;
  for (const box of boxes.values()) {
    canvasWidth = Math.max(canvasWidth, box.left + box.width + PAD);
    canvasHeight = Math.max(canvasHeight, box.top + box.height + PAD);
  }
  const paths: EdgePath[] = [];
  const addPath = (key: string, from: string, to: string, dashed: boolean, label: string | null) => {
    const edge = graph.edge(from, to) as { points?: Array<{ x: number; y: number }> } | undefined;
    const points = (edge?.points ?? []).map((point) => ({ x: point.x + PAD, y: point.y + PAD }));
    if (points.length < 2) {
      return;
    }
    const segments = segmentsFromPoints(key, points);
    if (segments.length > 0) {
      paths.push({ key, from, to, segments, dashed, label });
    }
  };
  for (const edge of edges) {
    addPath(`${edge.from}-${edge.to}`, edge.from, edge.to, edge.dashed, edge.label);
  }
  if (root != null) {
    for (const id of entryIds) {
      addPath(`root-${id}`, root.id, id, false, null);
    }
  }
  const labelPositions = edgeLabelPlacements(paths);
  let minLabelLeft = Infinity;
  let maxLabelRight = -Infinity;
  for (const position of labelPositions.values()) {
    if (position.align === "end") {
      minLabelLeft = Math.min(minLabelLeft, position.x - EDGE_LABEL_MAX_WIDTH);
    } else if (position.align === "start") {
      maxLabelRight = Math.max(maxLabelRight, position.x + EDGE_LABEL_MAX_WIDTH);
    }
  }
  if (minLabelLeft < Infinity) {
    const shift = Math.max(0, EDGE_LABEL_MARGIN - minLabelLeft);
    const extendRight = Math.max(0, maxLabelRight + EDGE_LABEL_MARGIN - canvasWidth);
    for (const box of boxes.values()) {
      box.left += shift;
    }
    for (const path of paths) {
      for (const segment of path.segments) {
        segment.left += shift;
      }
    }
    canvasWidth += shift + extendRight;
  }
  const segments = paths.flatMap((path) => path.segments);
  const placed: PlacedGraph = {
    boxes,
    rootBox,
    entryIds,
    segments,
    paths,
    canvasWidth,
    canvasHeight,
  };
  return placed;
}

function statusPaint(status: NodeStatus, colors: GraphThemeColors): string {
  switch (status) {
    case "완료":
      return colors.statusSuccess;
    case "실행 중":
      return colors.accent;
    case "실패":
      return colors.statusDanger;
    case "대기":
      return colors.foregroundMuted;
    case "생략":
      // 건너뛴 단계는 진행 중이 아니므로 대기와 같은 muted 계열로 낮춘다.
      return colors.foregroundMuted;
  }
}

export function statusVisual(status: NodeStatus | null | undefined, colors: GraphThemeColors) {
  if (status == null) {
    return {
      backgroundColor: colors.surface1,
      // 대기 노드의 테두리는 연결선 색을 쓴다. surface1·surface2 위에서 border보다 대비가 커서
      // 다크 모드에서도 카드 윤곽이 남는다.
      borderColor: colors.foregroundMuted,
      borderWidth: 1,
      scale: 1,
      opacity: 1,
      dashed: true,
      statusColor: null as string | null,
      boxShadow: [NODE_SHADOW],
    };
  }
  const paint = statusPaint(status, colors);
  const running = status === "실행 중";
  const waiting = status === "대기";
  return {
    backgroundColor: colors.surface2,
    borderColor: waiting ? colors.foregroundMuted : running ? colors.accent : colors.border,
    borderWidth: running ? 2 : 1,
    scale: STATUS_SCALE[status],
    // 건너뛴 노드는 돌지 않았다는 것이 한눈에 보이도록 흐리게 그린다.
    opacity: status === "생략" ? 0.45 : 1,
    dashed: false,
    statusColor: paint,
    boxShadow: running
      ? [NODE_SHADOW, { offsetX: 0, offsetY: 0, blurRadius: 14, color: colors.accent }]
      : [NODE_SHADOW],
  };
}

export function shouldRunProgressLoop(runningCount: number): boolean {
  return runningCount > 0;
}

export type IntroCause = "layer2-open" | "file-reread" | "status-tick" | "reselect-after-back";

export function shouldPlayIntro(cause: IntroCause): boolean {
  return cause === "layer2-open" || cause === "reselect-after-back";
}

export function layoutMoveNeeded(
  prev: { left: number; top: number } | undefined,
  next: { left: number; top: number },
): boolean {
  if (prev == null) {
    return false;
  }
  return prev.left !== next.left || prev.top !== next.top;
}

export function runningNodeIds(
  root: { id: string; status: NodeStatus } | null | undefined,
  nodes: Array<{ id: string; status: NodeStatus | null }>,
): string[] {
  const ids: string[] = [];
  if (root?.status === "실행 중") {
    ids.push(root.id);
  }
  for (const node of nodes) {
    if (node.status === "실행 중") {
      ids.push(node.id);
    }
  }
  return ids;
}

export function incomingPaths<T extends { to: string }>(paths: readonly T[], runningIds: ReadonlySet<string>): T[] {
  return paths.filter((path) => runningIds.has(path.to));
}

/** 선 위의 한 점. `deg`는 그 점이 놓인 조각의 방향이라, 그 자리에서 선이 향하는 쪽을 알려 준다. */
export function pointAlongSegments(
  segments: ReadonlyArray<{ left: number; top: number; width: number; deg: number }>,
  t01: number,
): { x: number; y: number; deg: number } | null {
  if (segments.length === 0) {
    return null;
  }
  let total = 0;
  for (const segment of segments) {
    total += segment.width;
  }
  if (total < 1) {
    const first = segments[0];
    return { x: first.left, y: first.top + 1, deg: first.deg };
  }
  const wrapped = t01 - Math.floor(t01);
  let dist = wrapped * total;
  for (const segment of segments) {
    const span = Math.max(segment.width, 0);
    if (dist <= span || segment === segments[segments.length - 1]) {
      const rad = (segment.deg * Math.PI) / 180;
      const along = span === 0 ? 0 : Math.min(dist, span);
      return {
        x: segment.left + Math.cos(rad) * along,
        y: segment.top + 1 + Math.sin(rad) * along,
        deg: segment.deg,
      };
    }
    dist -= span;
  }
  const last = segments[segments.length - 1];
  const rad = (last.deg * Math.PI) / 180;
  return {
    x: last.left + Math.cos(rad) * last.width,
    y: last.top + 1 + Math.sin(rad) * last.width,
    deg: last.deg,
  };
}

export type EdgeLabelPlacement = { x: number; y: number; align: "center" | "start" | "end" };

/** 양방향 라벨은 두 선 사이의 경계에 각 상자의 안쪽 변을 맞춘다. */
export function edgeLabelPlacements(paths: readonly EdgePath[]): Map<string, EdgeLabelPlacement> {
  const positions = new Map<string, EdgeLabelPlacement>();
  const labeled = paths.filter((path) => path.label != null);
  for (const path of labeled) {
    if (positions.has(path.key)) {
      continue;
    }
    const mid = pointAlongSegments(path.segments, 0.5);
    if (mid == null) {
      continue;
    }
    const reverse = path.from === path.to
      ? undefined
      : labeled.find((other) => other !== path && other.from === path.to && other.to === path.from);
    const reverseMid = reverse == null ? null : pointAlongSegments(reverse.segments, 0.5);
    if (reverse == null || reverseMid == null) {
      positions.set(path.key, { x: mid.x, y: mid.y, align: "center" });
      continue;
    }
    const seam = (mid.x + reverseMid.x) / 2;
    const pathOnLeft = mid.x < reverseMid.x || (mid.x === reverseMid.x && path.key < reverse.key);
    positions.set(path.key, {
      x: seam + (pathOnLeft ? -EDGE_LABEL_GAP / 2 : EDGE_LABEL_GAP / 2),
      y: mid.y,
      align: pathOnLeft ? "end" : "start",
    });
    positions.set(reverse.key, {
      x: seam + (pathOnLeft ? EDGE_LABEL_GAP / 2 : -EDGE_LABEL_GAP / 2),
      y: reverseMid.y,
      align: pathOnLeft ? "start" : "end",
    });
  }
  return positions;
}

export function introEdgeDelayMs(nodeCount: number): number {
  return Math.max(0, nodeCount) * INTRO_STAGGER_MS + INTRO_FADE_MS;
}
