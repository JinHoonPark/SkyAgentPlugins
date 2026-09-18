import type { PluginTheme } from "@getpaseo/plugin";
import type { GraphNodeStatus } from "../shared/graphs";

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

export function introEdgeDelayMs(nodeCount: number): number {
  return Math.max(0, nodeCount) * INTRO_STAGGER_MS + INTRO_FADE_MS;
}
