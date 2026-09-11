import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useAgent, usePaseo, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanResponder, ScrollView, Text, View } from "react-native";
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
const LANE_PITCH = 18;
const LANE_INSET = 14;
const SKIP_STUB = 8;
const SKIP_STAGGER = 6;
const EDGE_STAGGER = 6;

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
    deg: Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : 180) : dy >= 0 ? 90 : -90,
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

function bottomCenter(node: NodeBox) {
  return { x: node.left + node.width / 2, y: node.top + node.height };
}

function topCenter(node: NodeBox) {
  return { x: node.left + node.width / 2, y: node.top };
}

function staggerOffset(index: number, count: number) {
  return (index - (count - 1) / 2) * EDGE_STAGGER;
}

function orthoPoints(from: NodeBox, to: NodeBox, midOffset: number): Array<{ x: number; y: number }> {
  const start = bottomCenter(from);
  const end = topCenter(to);
  const midY = start.y + (end.y - start.y) / 2 + midOffset;
  const points = [
    { x: start.x, y: start.y },
    { x: start.x, y: midY },
  ];
  if (Math.abs(end.x - start.x) >= 1) {
    points.push({ x: end.x, y: midY });
  }
  points.push({ x: end.x, y: end.y });
  return points;
}

function layoutGraph(
  root: { id: string } | null,
  nodes: Array<{ id: string; labelLines: string[] }>,
  edges: Array<{ from: string; to: string }>,
  compact: boolean,
) {
  const colGap = compact ? 16 : 24;
  const rowGap = compact ? 28 : 40;
  const incoming = new Map<string, string[]>();
  for (const node of nodes) {
    incoming.set(node.id, []);
  }
  for (const edge of edges) {
    incoming.get(edge.to)?.push(edge.from);
  }
  const entryIds = nodes.map((node) => node.id).filter((id) => (incoming.get(id)?.length ?? 0) === 0);
  const orderIndex = new Map(nodes.map((node, index) => [node.id, index]));
  const sizes = new Map(
    nodes.map((node) => [node.id, { width: NODE_WIDTH, height: nodeHeight(node.labelLines.length) }]),
  );
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const dep = (id: string): number => {
    const cached = depth.get(id);
    if (cached != null) {
      return cached;
    }
    if (visiting.has(id)) {
      return 0;
    }
    visiting.add(id);
    const preds = incoming.get(id) ?? [];
    const value = preds.length === 0 ? 0 : 1 + Math.max(...preds.map(dep));
    visiting.delete(id);
    depth.set(id, value);
    return value;
  };
  for (const node of nodes) {
    dep(node.id);
  }
  const layers: string[][] = [];
  for (const node of nodes) {
    const layer = depth.get(node.id) ?? 0;
    while (layers.length <= layer) {
      layers.push([]);
    }
    layers[layer].push(node.id);
  }
  const predX = new Map<string, number>();
  const avgPredX = (id: string) => {
    const xs = (incoming.get(id) ?? [])
      .map((pred) => predX.get(pred))
      .filter((x): x is number => x != null);
    if (xs.length === 0) {
      return orderIndex.get(id) ?? 0;
    }
    return xs.reduce((sum, x) => sum + x, 0) / xs.length;
  };
  const orderedLayers: string[][] = [];
  for (let layerIndex = 0; layerIndex < layers.length; layerIndex++) {
    const layer = layers[layerIndex];
    const ordered =
      layerIndex === 0
        ? [...layer].sort((a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0))
        : [...layer].sort((a, b) => {
            const delta = avgPredX(a) - avgPredX(b);
            if (delta !== 0) {
              return delta;
            }
            return (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0);
          });
    ordered.forEach((id, index) => {
      predX.set(id, index);
    });
    orderedLayers.push(ordered);
  }
  const layerWidths = orderedLayers.map((layer) =>
    layer.length === 0 ? 0 : layer.length * NODE_WIDTH + (layer.length - 1) * colGap,
  );
  let canvasWidth = Math.max(PAD * 2 + ROOT_WIDTH, PAD * 2, ...layerWidths.map((width) => width + PAD * 2));
  const boxes = new Map<string, NodeBox>();
  if (root != null) {
    boxes.set(root.id, {
      id: root.id,
      left: Math.round((canvasWidth - ROOT_WIDTH) / 2),
      top: PAD,
      width: ROOT_WIDTH,
      height: ROOT_HEIGHT,
    });
  }
  let top = PAD + (root == null ? 0 : ROOT_HEIGHT + rowGap);
  for (const layer of orderedLayers) {
    const width = layer.length === 0 ? 0 : layer.length * NODE_WIDTH + (layer.length - 1) * colGap;
    const rowLeft = Math.round((canvasWidth - width) / 2);
    let rowHeight = nodeHeight(1);
    layer.forEach((id, index) => {
      const size = sizes.get(id) ?? { width: NODE_WIDTH, height: nodeHeight(1) };
      rowHeight = Math.max(rowHeight, size.height);
      boxes.set(id, {
        id,
        left: rowLeft + index * (NODE_WIDTH + colGap),
        top,
        width: size.width,
        height: size.height,
      });
    });
    top += rowHeight + rowGap;
  }
  const skipEdges = edges.filter((edge) => (depth.get(edge.to) ?? 0) - (depth.get(edge.from) ?? 0) >= 2);
  const gutter = skipEdges.length === 0 ? 0 : LANE_INSET + skipEdges.length * LANE_PITCH + LANE_INSET;
  if (gutter > 0) {
    for (const box of boxes.values()) {
      box.left += gutter;
    }
    canvasWidth += gutter;
  }
  let maxBottom = PAD + (root == null ? 0 : ROOT_HEIGHT);
  for (const box of boxes.values()) {
    maxBottom = Math.max(maxBottom, box.top + box.height);
  }
  const rootBox = root == null ? null : (boxes.get(root.id) ?? null);
  const paths: EdgePath[] = [];
  const skipKeys = new Set(skipEdges.map((edge) => `${edge.from}-${edge.to}`));
  skipEdges.forEach((edge, index) => {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    if (from == null || to == null) {
      return;
    }
    const start = bottomCenter(from);
    const end = topCenter(to);
    const laneX = LANE_INSET + LANE_PITCH * index + LANE_PITCH / 2;
    const y1 = from.top + from.height + SKIP_STUB + index * SKIP_STAGGER;
    const y2 = to.top - SKIP_STUB - index * SKIP_STAGGER;
    const segments = segmentsFromPoints(`${edge.from}-${edge.to}`, [
      { x: start.x, y: start.y },
      { x: start.x, y: y1 },
      { x: laneX, y: y1 },
      { x: laneX, y: y2 },
      { x: end.x, y: y2 },
      { x: end.x, y: end.y },
    ]);
    paths.push({ key: `${edge.from}-${edge.to}`, from: edge.from, to: edge.to, segments });
  });
  const grouped = new Map<string, Array<{ from: string; to: string; key: string }>>();
  const addOrtho = (from: string, to: string, key: string) => {
    const list = grouped.get(from) ?? [];
    list.push({ from, to, key });
    grouped.set(from, list);
  };
  if (root != null) {
    for (const id of entryIds) {
      addOrtho(root.id, id, `root-${id}`);
    }
  }
  for (const edge of edges) {
    if (skipKeys.has(`${edge.from}-${edge.to}`)) {
      continue;
    }
    addOrtho(edge.from, edge.to, `${edge.from}-${edge.to}`);
  }
  const incomingCount = new Map<string, number>();
  const incomingSeen = new Map<string, number>();
  for (const list of grouped.values()) {
    for (const edge of list) {
      incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1);
    }
  }
  for (const list of grouped.values()) {
    list.forEach((edge, index) => {
      const from = boxes.get(edge.from);
      const to = boxes.get(edge.to);
      if (from == null || to == null) {
        return;
      }
      const inIndex = incomingSeen.get(edge.to) ?? 0;
      incomingSeen.set(edge.to, inIndex + 1);
      const midOffset =
        staggerOffset(index, list.length) + staggerOffset(inIndex, incomingCount.get(edge.to) ?? 1);
      const segments = segmentsFromPoints(edge.key, orthoPoints(from, to, midOffset));
      if (segments.length > 0) {
        paths.push({ key: edge.key, from: edge.from, to: edge.to, segments });
      }
    });
  }
  const segments = paths.flatMap((path) => path.segments);
  const placed: PlacedGraph = {
    boxes,
    rootBox,
    entryIds,
    segments,
    paths,
    canvasWidth,
    canvasHeight: maxBottom + PAD,
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

export function OrchestrationGraphPanel({ theme, layout, workspaceId, agentId }: PluginAgentPanelProps) {
  const directory = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const paseo = usePaseo();
  const [snapshots, setSnapshots] = useState<Map<string, GraphAgentSnapshot>>(() => new Map());
  const [fileView, setFileView] = useState<GraphView | null>(null);
  const vScroll = useRef<ScrollView>(null);
  const hScroll = useRef<ScrollView>(null);
  const offsetX = useRef(0);
  const offsetY = useRef(0);
  const baseX = useRef(0);
  const baseY = useRef(0);
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_event, gesture) => Math.abs(gesture.dx) + Math.abs(gesture.dy) > 2,
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => false,
        onPanResponderGrant: () => {
          baseX.current = offsetX.current;
          baseY.current = offsetY.current;
        },
        onPanResponderMove: (_event, gesture) => {
          hScroll.current?.scrollTo({ x: baseX.current - gesture.dx, animated: false });
          vScroll.current?.scrollTo({ y: baseY.current - gesture.dy, animated: false });
        },
      }),
    [],
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
    offsetX.current = 0;
    offsetY.current = 0;
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
      graphViewport: { flex: 1 },
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
        <ScrollView
          ref={vScroll}
          style={styles.graphViewport}
          nestedScrollEnabled
          onScroll={(event) => {
            offsetY.current = event.nativeEvent.contentOffset.y;
          }}
        >
          <ScrollView
            ref={hScroll}
            horizontal
            nestedScrollEnabled
            onScroll={(event) => {
              offsetX.current = event.nativeEvent.contentOffset.x;
            }}
          >
            <View
              style={[styles.canvasWrap, { width: placed.canvasWidth, height: placed.canvasHeight }]}
              {...panResponder.panHandlers}
            >
              <GraphCanvas key={graphName} view={view} placed={placed} colors={theme.colors} />
            </View>
          </ScrollView>
        </ScrollView>
      ) : null}
    </View>
  );
}
