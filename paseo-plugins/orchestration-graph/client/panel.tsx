import dagre from "@dagrejs/dagre";
import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useAgent, usePaseo, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, PanResponder, Text, View } from "react-native";
import {
  GRAPH_WAITING_LABEL,
  PARENT_AGENT_ID_LABEL,
  findGraphByAgentRpc,
  getGraphRpc,
  graphFileEquals,
  layoutSignature,
  readGraphFileRpc,
  type GraphAgentSnapshot,
  type GraphView,
} from "../shared/graphs";
import { registerStop } from "./cleanup";
import { GraphCanvas } from "./graph-canvas";
import { applyLiveGraph, toAgentSnapshot } from "./live-graph";
import {
  BADGE_HEIGHT,
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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function panBounds(
  canvasWidth: number,
  canvasHeight: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  const keepX = Math.min(canvasWidth, viewportWidth, PAN_KEEP_PX);
  const keepY = Math.min(canvasHeight, viewportHeight, PAN_KEEP_PX);
  return {
    minX: keepX - canvasWidth,
    maxX: viewportWidth - keepX,
    minY: keepY - canvasHeight,
    maxY: viewportHeight - keepY,
  };
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

function layoutGraph(
  root: { id: string } | null,
  nodes: Array<{ id: string; labelLines: string[] }>,
  edges: Array<{ from: string; to: string }>,
  compact: boolean,
) {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({
    rankdir: "TB",
    nodesep: compact ? 16 : 24,
    ranksep: compact ? 28 : 40,
  });
  graph.setDefaultEdgeLabel(() => ({}));
  const sizes = new Map(
    nodes.map((node) => [node.id, { width: NODE_WIDTH, height: nodeHeight(node.labelLines.length) }]),
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
  const addPath = (key: string, from: string, to: string) => {
    const label = graph.edge(from, to) as { points?: Array<{ x: number; y: number }> } | undefined;
    const points = (label?.points ?? []).map((point) => ({ x: point.x + PAD, y: point.y + PAD }));
    if (points.length < 2) {
      return;
    }
    const segments = segmentsFromPoints(key, points);
    if (segments.length > 0) {
      paths.push({ key, from, to, segments });
    }
  };
  for (const edge of edges) {
    addPath(`${edge.from}-${edge.to}`, edge.from, edge.to);
  }
  if (root != null) {
    for (const id of entryIds) {
      addPath(`root-${id}`, root.id, id);
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
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_event, gesture) => Math.abs(gesture.dx) + Math.abs(gesture.dy) > 2,
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => false,
        onPanResponderGrant: () => {
          baseCamera.current = { ...cameraValue.current };
        },
        onPanResponderMove: (_event, gesture) => {
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
  const found = useQuery({
    queryKey: [findGraphByAgentRpc.name, directory, agentId],
    queryFn: () => findGraphByAgent({ directory: directory!, agentId }),
    enabled: directory != null,
  });
  const graphName = found.data?.name ?? null;
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
    const file = fileView ?? graph.data;
    if (file == null) {
      return null;
    }
    return { ...file, root: file.root ?? graph.data?.root ?? null };
  }, [fileView, graph.data]);
  const view = useMemo(
    () => (source == null ? null : applyLiveGraph(source, snapshots)),
    [source, snapshots],
  );
  const graphRootAgentId = view?.root?.id ?? null;
  const handleNodePress = useCallback(
    (pressedAgentId: string) => {
      if (graphRootAgentId == null) {
        return;
      }
      navigation?.openAgent({ agentId: pressedAgentId });
    },
    [navigation, graphRootAgentId],
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
      },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 18 : 22 },
      label: { color: theme.colors.foregroundMuted },
      canvasWrap: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        overflow: "hidden" as const,
      },
      graphViewport: { flex: 1, overflow: "hidden" as const },
    }),
    [theme, layout.compact],
  );
  if (found.isSuccess && found.data.name == null) {
    return (
      <View style={styles.screen}>
        <View style={styles.content}>
          <Text style={styles.label}>이 에이전트에 연결된 오케스트레이션 그래프가 없습니다</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.content}>
        <Text style={styles.title}>{graphName}</Text>
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
      </View>
      {view != null && placed != null ? (
        <View
          style={styles.graphViewport}
          onLayout={(event) => {
            const { width, height } = event.nativeEvent.layout;
            setViewport((prev) =>
              prev.width === width && prev.height === height ? prev : { width, height },
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
              onNodePress={graphRootAgentId == null ? undefined : handleNodePress}
            />
          </Animated.View>
        </View>
      ) : null}
    </View>
  );
}
