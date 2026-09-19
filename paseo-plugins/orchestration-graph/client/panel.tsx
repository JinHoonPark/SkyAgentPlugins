import dagre from "./vendor/dagre";
import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useAgent, usePaseo, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Animated, PanResponder, Pressable, ScrollView, Text, View } from "react-native";
import {
  GRAPH_WAITING_LABEL,
  GRAPH_SUMMARY_FAILED_LABEL,
  PARENT_AGENT_ID_LABEL,
  findGraphByAgentRpc,
  getGraphRpc,
  graphFileEquals,
  layoutSignature,
  readGraphFileRpc,
  retryGraphSummaryRpc,
  type GraphAgentSnapshot,
  type GraphListItem,
  type GraphNodeShape,
  type GraphView,
} from "../shared/graphs";
import { registerStop } from "./cleanup";
import { GraphCanvas, type LabelHover } from "./graph-canvas";
import { applyLiveGraph, toAgentSnapshot } from "./live-graph";
import {
  BADGE_HEIGHT,
  GATE_ARM_WIDTH,
  LINE_HEIGHT,
  type EdgePath,
  type EdgeSegment,
  type NodeBox,
  type PlacedGraph,
} from "./motion-logic";

const ROOT_WIDTH = 400;
const NODE_PAD_Y = 10;
const ROOT_HEIGHT = BADGE_HEIGHT + NODE_PAD_Y * 2 + LINE_HEIGHT * 2 + 12;
const NODE_WIDTH = 260;
const PAD = 16;
const FILE_POLL_MS = 2000;
const PAN_KEEP_PX = 64;
const PAN_MOVE_THRESHOLD = 2;
const NO_GRAPH_ITEMS: GraphListItem[] = [];
/** 잘린 라벨 툴팁의 폭과, 실측 전에 쓰는 높이 어림값. */
const TOOLTIP_WIDTH = 220;
const TOOLTIP_ESTIMATED_HEIGHT = 34;
const TOOLTIP_MARGIN = 8;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function axisBounds(contentSize: number, viewportSize: number) {
  const keep = Math.min(contentSize, viewportSize, PAN_KEEP_PX);
  return { min: keep - contentSize, max: viewportSize - keep };
}

// Bounds for the camera translate, in viewport pixels, over the raw canvas.
function panBounds(
  canvasWidth: number,
  canvasHeight: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  const x = axisBounds(canvasWidth, viewportWidth);
  const y = axisBounds(canvasHeight, viewportHeight);
  return { minX: x.min, maxX: x.max, minY: y.min, maxY: y.max };
}

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

function layoutGraph(
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

function AgentSnapshotTap({
  agentId,
  onSnapshot,
}: {
  agentId: string;
  onSnapshot: (snapshot: GraphAgentSnapshot) => void;
}) {
  const selected = useAgent(agentId, (agent) => ({
    id: agent.id,
    title: agent.title,
    status: agent.status,
    labels: agent.labels,
  }));
  useEffect(() => {
    if (selected != null) {
      onSnapshot(selected);
    }
  }, [onSnapshot, selected]);
  return null;
}

function GraphListRow({
  item,
  theme,
  compact,
  height,
  selected = false,
  expanded,
  retrying,
  onSelect,
  onRetry,
  showSummaryLine = true,
}: {
  item: GraphListItem;
  theme: PluginAgentPanelProps["theme"];
  compact: boolean;
  height?: number;
  selected?: boolean;
  expanded?: boolean;
  retrying?: boolean;
  onSelect?: () => void;
  onRetry?: () => void;
  /** 머리 줄에서는 30자 요약 줄을 그리지 않는다. 바로 아래 요약란의 100자 요약과 같은 그래프를 두 번 설명한다. */
  showSummaryLine?: boolean;
}) {
  const baseHeight = compact ? 84 : 96;
  const scale = height == null ? 1 : Math.min(1, height / baseHeight);
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 * scale, lineHeight: 18 * scale };
  return (
    <View
      style={{
        width: "100%",
        // 고정 높이는 제목 줄과 요약 줄 두 줄을 담는 값이다. 요약 줄을 그리지 않는 머리 줄에서는
        // 내용 높이에 맡긴다.
        height: showSummaryLine ? (height ?? baseHeight) : undefined,
        justifyContent: "center",
        gap: 4 * scale,
        paddingHorizontal: 8 * scale,
        paddingVertical: 6 * scale,
        borderLeftWidth: 3,
        borderLeftColor: selected ? theme.colors.foreground : theme.colors.border,
        backgroundColor: selected ? theme.colors.surface2 : theme.colors.surface1,
      }}
    >
      <Pressable
        disabled={onSelect == null}
        onPress={onSelect}
        accessibilityRole={onSelect == null ? undefined : "button"}
        accessibilityLabel={item.name}
        accessibilityState={{ selected, ...(expanded == null ? {} : { expanded }) }}
        style={{ minWidth: 0, flexDirection: "row", alignItems: "center" }}
      >
        <Text
          numberOfLines={2}
          ellipsizeMode="tail"
          style={{
            color: theme.colors.foreground,
            fontSize: (compact ? 18 : 22) * scale,
            lineHeight: (compact ? 24 : 28) * scale,
            fontWeight: "700",
            textAlign: "left",
            flex: 1,
          }}
        >
          {item.name}
        </Text>
        {expanded != null ? (
          <Text style={{ color: theme.colors.foregroundMuted, paddingLeft: 8 }}>{expanded ? "▴" : "▾"}</Text>
        ) : null}
      </Pressable>
      {showSummaryLine ? (
        <View style={{ paddingLeft: 8 * scale, flexDirection: "row", alignItems: "center" }}>
          <Pressable
            disabled={onSelect == null}
            onPress={onSelect}
            accessibilityRole={onSelect == null ? undefined : "button"}
            accessibilityLabel={item.name}
            style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6 * scale }}
          >
            {item.summaryPhase === "generating" ? (
              <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
            ) : null}
            <Text numberOfLines={1} ellipsizeMode="tail" style={[muted, { flex: 1 }]}>
              {item.summaryPhase === "generating"
                ? "요약 중..."
                : item.summaryPhase === "failed"
                  ? GRAPH_SUMMARY_FAILED_LABEL
                  : item.listSummary}
            </Text>
          </Pressable>
          {item.summaryPhase === "failed" && onRetry != null ? (
            <Pressable
              onPress={onRetry}
              disabled={retrying}
              accessibilityRole="button"
              accessibilityLabel={`${item.name} 요약 다시 시도`}
              accessibilityState={{ disabled: retrying }}
              style={{ paddingLeft: 8 * scale }}
            >
              <Text style={muted}>[ 다시 시도 ]</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export function OrchestrationGraphPanel({
  theme,
  layout,
  workspaceId,
  agentId,
  navigation,
}: PluginAgentPanelProps) {
  const directory = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const paseo = usePaseo();
  const [snapshots, setSnapshots] = useState<Map<string, GraphAgentSnapshot>>(() => new Map());
  const [fileView, setFileView] = useState<GraphView | null>(null);
  const camera = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const cameraValue = useRef({ x: 0, y: 0 });
  const baseCamera = useRef({ x: 0, y: 0 });
  const cameraBounds = useRef({ minX: 0, maxX: 0, minY: 0, maxY: 0 });
  const didPan = useRef(false);
  const [viewport, setViewport] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [panelSize, setPanelSize] = useState({ width: 0, height: 0 });
  const [hoverLabel, setHoverLabel] = useState<LabelHover | null>(null);
  const [tooltipHeight, setTooltipHeight] = useState(TOOLTIP_ESTIMATED_HEIGHT);
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponderCapture: () => {
          didPan.current = false;
          return false;
        },
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_event, gesture) =>
          Math.abs(gesture.dx) + Math.abs(gesture.dy) > PAN_MOVE_THRESHOLD,
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => false,
        onPanResponderGrant: () => {
          didPan.current = false;
          baseCamera.current = { ...cameraValue.current };
          // 캔버스가 움직이면 툴팁이 붙어 있던 자리가 어긋난다. 팬이 시작되면 숨긴다.
          setHoverLabel(null);
        },
        onPanResponderMove: (_event, gesture) => {
          if (Math.abs(gesture.dx) + Math.abs(gesture.dy) > PAN_MOVE_THRESHOLD) {
            didPan.current = true;
          }
          const limit = cameraBounds.current;
          const next = {
            x: clamp(baseCamera.current.x + gesture.dx, limit.minX, limit.maxX),
            y: clamp(baseCamera.current.y + gesture.dy, limit.minY, limit.maxY),
          };
          cameraValue.current = next;
          camera.setValue(next);
        },
      }),
    [camera],
  );
  const findGraphByAgent = useRpc(findGraphByAgentRpc);
  const getGraph = useRpc(getGraphRpc);
  const readGraphFile = useRpc(readGraphFileRpc);
  const retryGraphSummary = useRpc(retryGraphSummaryRpc);
  const putSnapshot = useCallback((snapshot: GraphAgentSnapshot) => {
    setSnapshots((prev) => {
      const existing = prev.get(snapshot.id);
      if (
        existing &&
        existing.status === snapshot.status &&
        existing.title === snapshot.title &&
        existing.labels[PARENT_AGENT_ID_LABEL] === snapshot.labels[PARENT_AGENT_ID_LABEL] &&
        existing.labels.profile === snapshot.labels.profile
      ) {
        return prev;
      }
      const next = new Map(prev);
      next.set(snapshot.id, snapshot);
      return next;
    });
  }, []);
  const [pickedName, setPickedName] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(true);
  const listScroll = useRef<ScrollView>(null);
  const pendingRetries = useRef(new Set<string>());
  const [retryingNames, setRetryingNames] = useState<ReadonlySet<string>>(() => new Set());
  const found = useQuery({
    queryKey: [findGraphByAgentRpc.name, directory, agentId],
    queryFn: () => findGraphByAgent({ directory: directory!, agentId }),
    enabled: directory != null,
    // Polled like the file it feeds: a graph that appears while the panel is open has to show up in
    // the picker without closing and reopening it.
    refetchInterval: FILE_POLL_MS,
  });
  const graphItems = found.data?.items ?? NO_GRAPH_ITEMS;
  // A pick sticks while its graph is still listed; without one the newest graph is shown, which is
  // what the panel showed before the picker existed. A newer graph must not override a pick.
  const graphName =
    pickedName != null && graphItems.some((item) => item.name === pickedName)
      ? pickedName
      : (graphItems[0]?.name ?? null);
  const selectedItem = graphItems.find((item) => item.name === graphName);
  const listRowHeight = Math.min(layout.compact ? 84 : 96, panelSize.height * 0.6 / 5);
  const listHeight = Math.min(graphItems.length, 5) * listRowHeight;
  const selectedOffset = Math.max(0, graphItems.findIndex((item) => item.name === graphName)) * listRowHeight;
  useEffect(() => {
    if (found.isSuccess && pickedName != null && !graphItems.some((item) => item.name === pickedName)) {
      setPickedName(null);
    }
    if (graphItems.length < 2) {
      setListOpen(false);
    }
  }, [found.isSuccess, graphItems, pickedName]);
  useEffect(() => {
    setPickedName(null);
    setListOpen(false);
  }, [directory, agentId]);
  useEffect(() => {
    if (listOpen) {
      listScroll.current?.scrollTo({ y: selectedOffset, animated: false });
    }
  }, [listOpen, selectedOffset]);
  const handleRetry = useCallback(async (name: string) => {
    if (directory == null) {
      return;
    }
    const key = JSON.stringify([directory, name]);
    if (pendingRetries.current.has(key)) {
      return;
    }
    pendingRetries.current.add(key);
    setRetryingNames(new Set(pendingRetries.current));
    try {
      await retryGraphSummary({ directory, name });
    } catch {
      // RPC 실패로 목록 선택이나 파일 조회를 막지 않는다. 표시 상태는 다음 목록 응답을 따른다.
    } finally {
      pendingRetries.current.delete(key);
      setRetryingNames(new Set(pendingRetries.current));
    }
  }, [directory, retryGraphSummary]);
  const graph = useQuery({
    queryKey: [getGraphRpc.name, directory, graphName],
    queryFn: () => getGraph({ directory: directory!, name: graphName! }),
    enabled: directory != null && graphName != null,
  });
  useEffect(() => {
    if (graphName == null) {
      setSnapshots(new Map());
      return;
    }
    setSnapshots(new Map());
    const stop = paseo.agents.subscribe((update) => {
      if (update.kind !== "upsert") {
        return;
      }
      if (update.agent.workspaceId != null && update.agent.workspaceId !== workspaceId) {
        return;
      }
      putSnapshot(toAgentSnapshot(update.agent));
    });
    const unregister = registerStop(stop);
    return unregister;
  }, [paseo, putSnapshot, graphName, workspaceId]);
  useEffect(() => {
    setFileView(null);
    setHoverLabel(null);
    cameraValue.current = { x: 0, y: 0 };
    camera.setValue({ x: 0, y: 0 });
    if (graphName == null || directory == null) {
      return;
    }
    let cancelled = false;
    let seq = 0;
    const requestedName = graphName;
    const timer = setInterval(() => {
      const thisSeq = ++seq;
      void readGraphFile({ directory, name: requestedName }).then(
        (next) => {
          if (cancelled || thisSeq !== seq || next.name !== requestedName) {
            return;
          }
          setFileView((prev) => (graphFileEquals(prev, next) ? prev : next));
        },
        () => {},
      );
    }, FILE_POLL_MS);
    return registerStop(() => {
      cancelled = true;
      seq = -1;
      clearInterval(timer);
    });
  }, [directory, readGraphFile, graphName]);
  const source = useMemo(() => {
    const file = fileView?.name === graphName ? fileView : graph.data;
    if (file == null) {
      return null;
    }
    return { ...file, root: file.root ?? graph.data?.root ?? null };
  }, [fileView, graph.data, graphName]);
  const view = useMemo(
    () => (source == null ? null : applyLiveGraph(source, snapshots)),
    [source, snapshots],
  );
  // 노드 누름은 루트 판정에 기대지 않는다. 표의 부모가 하나로 모이지 않는 그래프(예: 부모가
  // 표 밖에 있는 행이 하나 섞인 확인용 그래프)에서는 루트가 null이 되는데, 그때 루트로 막으면
  // agentId가 있는 노드까지 전부 disabled가 되어 누름이 죽는다. agentId 없는 노드는
  // GraphCanvas 쪽에서 이미 눌리지 않으므로, 막을 것은 아직 시작하지 않은 그래프뿐이다.
  const nodePressEnabled = view != null && !view.waiting;
  const handleNodePress = useCallback(
    (pressedAgentId: string) => {
      if (didPan.current) {
        return;
      }
      navigation?.openAgent({ agentId: pressedAgentId });
    },
    [navigation],
  );
  const tapIds = useMemo(() => {
    const ids: string[] = [];
    const seen = new Set<string>();
    const add = (id: string | null | undefined) => {
      if (!id || seen.has(id)) {
        return;
      }
      seen.add(id);
      ids.push(id);
    };
    if (source != null) {
      add(source.root?.id);
      for (const node of source.nodes) {
        add(node.agentId);
      }
    }
    if (view != null) {
      add(view.root?.id);
      for (const node of view.nodes) {
        add(node.agentId);
      }
    }
    return ids;
  }, [source, view]);
  const layoutKey =
    view == null ? "" : layoutSignature(view.root?.id ?? null, view.nodes, view.edges, layout.compact);
  const placed = useMemo(() => {
    if (view == null) {
      return null;
    }
    return layoutGraph(view.root, view.nodes, view.edges, layout.compact);
    // layoutKey already encodes root, node ids, label-line counts, edges, and compact.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- view identity changes on status ticks
  }, [layoutKey]);
  useEffect(() => {
    if (placed == null) {
      return;
    }
    const limit = panBounds(placed.canvasWidth, placed.canvasHeight, viewport.width, viewport.height);
    cameraBounds.current = limit;
    const next = {
      x: clamp(cameraValue.current.x, limit.minX, limit.maxX),
      y: clamp(cameraValue.current.y, limit.minY, limit.maxY),
    };
    if (next.x !== cameraValue.current.x || next.y !== cameraValue.current.y) {
      cameraValue.current = next;
      camera.setValue(next);
    }
  }, [placed, viewport, camera]);
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        backgroundColor: theme.colors.surface0,
      },
      content: {
        padding: layout.compact ? 16 : 24,
        gap: 12,
        zIndex: 10,
      },
      label: { color: theme.colors.foregroundMuted },
      canvasWrap: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        overflow: "hidden" as const,
      },
      graphViewport: { flex: 1, overflow: "hidden" as const },
      tooltip: {
        width: TOOLTIP_WIDTH,
        paddingHorizontal: 8,
        paddingVertical: 6,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.foregroundMuted,
        backgroundColor: theme.colors.surface2,
        // 그림자는 배열 형식으로만 전처리를 통과한다. 문자열은 단위 없는 CSS가 되어 선언째 버려진다.
        // 앞은 아래로 지는 그림자, 뒤는 테두리를 따라 번지는 회색 글로우다. 글로우가 배경과 상자를 갈라
        // 상자 안 글자가 어디까지인지 읽힌다.
        boxShadow: [
          { offsetX: 0, offsetY: 2, blurRadius: 8, color: theme.colors.border },
          { offsetX: 0, offsetY: 0, blurRadius: 6, color: theme.colors.foregroundMuted },
        ],
      },
      tooltipCaption: { color: theme.colors.foregroundMuted, fontSize: 9, lineHeight: 12 },
      tooltipText: { color: theme.colors.foreground, fontSize: 11, lineHeight: 15 },
    }),
    [theme, layout.compact],
  );
  // 툴팁은 그래프 뷰포트(overflow hidden) 바깥인 패널 최상위에 그린다. 뷰포트 안에 두면 가장자리
  // 라벨의 툴팁이 잘리고, zIndex로는 피할 수 없다. 노드 카드(zIndex 3)보다도 위에 온다.
  const tooltipBox =
    hoverLabel == null || viewport.width === 0
      ? null
      : {
          left: clamp(
            viewport.left + cameraValue.current.x + hoverLabel.left + hoverLabel.width / 2 - TOOLTIP_WIDTH / 2,
            TOOLTIP_MARGIN,
            Math.max(TOOLTIP_MARGIN, panelSize.width - TOOLTIP_WIDTH - TOOLTIP_MARGIN),
          ),
          top: clamp(
            viewport.top + cameraValue.current.y + hoverLabel.top + hoverLabel.height + 6,
            TOOLTIP_MARGIN,
            Math.max(TOOLTIP_MARGIN, panelSize.height - tooltipHeight - TOOLTIP_MARGIN),
          ),
        };
  if (found.isSuccess && graphItems.length === 0) {
    return (
      <View style={styles.screen}>
        <View style={styles.content}>
          <Text style={styles.label}>이 에이전트에 연결된 오케스트레이션 그래프가 없습니다</Text>
        </View>
      </View>
    );
  }

  return (
    <View
      style={styles.screen}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setPanelSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
      }}
    >
      <View style={styles.content}>
        {selectedItem != null ? (
          <View style={{ width: "100%", zIndex: 10 }}>
            <GraphListRow
              item={selectedItem}
              theme={theme}
              compact={layout.compact}
              expanded={graphItems.length > 1 ? listOpen : undefined}
              onSelect={graphItems.length > 1 ? () => setListOpen((open) => !open) : undefined}
              showSummaryLine={false}
            />
            {listOpen && graphItems.length > 1 ? (
              <ScrollView
                ref={listScroll}
                style={{
                  position: "absolute",
                  top: "100%",
                  left: 0,
                  right: 0,
                  height: listHeight,
                  maxHeight: panelSize.height * 0.6,
                  backgroundColor: theme.colors.surface1,
                }}
                contentOffset={{ x: 0, y: selectedOffset }}
                onContentSizeChange={() => listScroll.current?.scrollTo({ y: selectedOffset, animated: false })}
              >
                {graphItems.map((item) => (
                  <GraphListRow
                    key={item.name}
                    item={item}
                    theme={theme}
                    compact={layout.compact}
                    height={listRowHeight}
                    selected={item.name === graphName}
                    retrying={retryingNames.has(JSON.stringify([directory, item.name]))}
                    onSelect={() => {
                      setPickedName(item.name);
                      setListOpen(false);
                    }}
                    onRetry={() => void handleRetry(item.name)}
                  />
                ))}
              </ScrollView>
            ) : null}
          </View>
        ) : null}
        {tapIds.map((id) => (
          <AgentSnapshotTap key={id} agentId={id} onSnapshot={putSnapshot} />
        ))}
        {view?.waiting ? <Text style={styles.label}>{GRAPH_WAITING_LABEL}</Text> : null}
        {found.isError ? (
          <Text style={styles.label}>{found.error instanceof Error ? found.error.message : "그래프를 찾지 못했습니다"}</Text>
        ) : null}
        {graph.isError ? (
          <Text style={styles.label}>{graph.error instanceof Error ? graph.error.message : "그래프를 읽지 못했습니다"}</Text>
        ) : null}
        {found.isPending || (graphName != null && graph.isPending) ? <Text style={styles.label}>불러오는 중</Text> : null}
        {selectedItem != null ? (
          <View style={{ width: "100%", gap: 6 }}>
            <Pressable
              onPress={() => setSummaryOpen((open) => !open)}
              accessibilityRole="button"
              accessibilityState={{ expanded: summaryOpen }}
              accessibilityLabel="그래프 요약 펼치기 또는 접기"
            >
              <Text style={styles.label}>{summaryOpen ? "▾ 요약" : "▸ 요약"}</Text>
            </Pressable>
            {summaryOpen ? (
              selectedItem.summaryPhase === "generating" ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
                  <Text style={styles.label}>요약 중...</Text>
                </View>
              ) : (
                <View style={{ gap: 6 }}>
                  {selectedItem.summaryPhase === "failed" ? (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <Text style={styles.label}>{GRAPH_SUMMARY_FAILED_LABEL}</Text>
                      <Pressable
                        onPress={() => void handleRetry(selectedItem.name)}
                        disabled={retryingNames.has(JSON.stringify([directory, selectedItem.name]))}
                        accessibilityRole="button"
                        accessibilityLabel={`${selectedItem.name} 요약 다시 시도`}
                        accessibilityState={{
                          disabled: retryingNames.has(JSON.stringify([directory, selectedItem.name])),
                        }}
                      >
                        <Text style={styles.label}>[ 다시 시도 ]</Text>
                      </Pressable>
                    </View>
                  ) : null}
                  {selectedItem.summary != null ? (
                    <Text style={{ color: theme.colors.foreground }}>{selectedItem.summary}</Text>
                  ) : null}
                </View>
              )
            ) : null}
          </View>
        ) : null}
      </View>
      {view != null && placed != null ? (
        <View
          style={styles.graphViewport}
          onLayout={(event) => {
            // left·top은 패널 최상위 기준 좌표다. 툴팁을 패널에 띄울 때 캔버스 좌표에 더한다.
            const { x, y, width, height } = event.nativeEvent.layout;
            setViewport((prev) =>
              prev.left === x && prev.top === y && prev.width === width && prev.height === height
                ? prev
                : { left: x, top: y, width, height },
            );
          }}
        >
          <Animated.View
            style={[
              styles.canvasWrap,
              {
                width: placed.canvasWidth,
                height: placed.canvasHeight,
                transform: [{ translateX: camera.x }, { translateY: camera.y }],
              },
            ]}
            {...panResponder.panHandlers}
          >
            <GraphCanvas
              key={graphName}
              view={view}
              placed={placed}
              colors={theme.colors}
              onNodePress={nodePressEnabled ? handleNodePress : undefined}
              onLabelHover={setHoverLabel}
            />
          </Animated.View>
        </View>
      ) : null}
      {tooltipBox != null ? (
        <View
          pointerEvents="none"
          onLayout={(event) => {
            const { height } = event.nativeEvent.layout;
            setTooltipHeight((prev) => (prev === height ? prev : height));
          }}
          style={[styles.tooltip, { position: "absolute", left: tooltipBox.left, top: tooltipBox.top, zIndex: 30 }]}
        >
          <Text style={styles.tooltipCaption}>전체 문구</Text>
          <Text style={styles.tooltipText}>{hoverLabel?.text}</Text>
        </View>
      ) : null}
    </View>
  );
}
