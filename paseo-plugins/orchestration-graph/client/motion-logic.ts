import type { GraphNodeStatus } from "../shared/graphs";

export type NodeBox = { id: string; left: number; top: number; width: number; height: number };

export type EdgeSegment = { key: string; left: number; top: number; width: number; deg: number };

export type EdgePath = {
  key: string;
  from: string;
  to: string;
  segments: EdgeSegment[];
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

export const LINE_HEIGHT = 16;

export const NODE_STATUS_STYLE: Record<
  NodeStatus,
  { backgroundColor: string; borderColor: string; borderWidth: number }
> = {
  대기: { backgroundColor: "#D4D4D8", borderColor: "#52525B", borderWidth: 1 },
  "실행 중": { backgroundColor: "#93C5FD", borderColor: "#1D4ED8", borderWidth: 2 },
  완료: { backgroundColor: "#86EFAC", borderColor: "#166534", borderWidth: 3 },
  실패: { backgroundColor: "#FCA5A5", borderColor: "#991B1B", borderWidth: 4 },
};

export const NEUTRAL_NODE_STYLE = {
  backgroundColor: "#E7E5E4",
  borderColor: "#57534E",
  borderWidth: 1,
  borderStyle: "dashed" as const,
};

export const NODE_LABEL_COLOR = "#18181B";

export const STATUS_SCALE: Record<NodeStatus, number> = {
  대기: 1,
  "실행 중": 1.04,
  완료: 1.025,
  실패: 1.03,
};

export const STATUS_MOTION_MS = 280;
export const LAYOUT_MOVE_MS = 400;
export const INTRO_STAGGER_MS = 70;
export const INTRO_FADE_MS = 200;
export const EXIT_FADE_MS = 280;
export const PULSE_MS = 700;
export const FLOW_PERIOD_MS = 1600;
export const FLOW_DOT = 8;

export function statusVisual(status: NodeStatus | null | undefined) {
  if (status == null) {
    return {
      backgroundColor: NEUTRAL_NODE_STYLE.backgroundColor,
      borderColor: NEUTRAL_NODE_STYLE.borderColor,
      borderWidth: NEUTRAL_NODE_STYLE.borderWidth,
      scale: 1,
      dashed: true,
    };
  }
  const paint = NODE_STATUS_STYLE[status];
  return {
    backgroundColor: paint.backgroundColor,
    borderColor: paint.borderColor,
    borderWidth: paint.borderWidth,
    scale: STATUS_SCALE[status],
    dashed: false,
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

export function pointAlongSegments(
  segments: ReadonlyArray<{ left: number; top: number; width: number; deg: number }>,
  t01: number,
): { x: number; y: number } | null {
  if (segments.length === 0) {
    return null;
  }
  let total = 0;
  for (const segment of segments) {
    total += segment.width;
  }
  if (total < 1) {
    const first = segments[0];
    return { x: first.left, y: first.top + 1 };
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
      };
    }
    dist -= span;
  }
  const last = segments[segments.length - 1];
  const rad = (last.deg * Math.PI) / 180;
  return {
    x: last.left + Math.cos(rad) * last.width,
    y: last.top + 1 + Math.sin(rad) * last.width,
  };
}

export function introEdgeDelayMs(nodeCount: number): number {
  return Math.max(0, nodeCount) * INTRO_STAGGER_MS + INTRO_FADE_MS;
}
