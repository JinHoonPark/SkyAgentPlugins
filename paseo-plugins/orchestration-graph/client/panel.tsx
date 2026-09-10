import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { getGraphRpc, listGraphsRpc } from "../shared/graphs";

type NodeBox = { id: string; left: number; top: number; width: number; height: number };
type NodeStatus = "대기" | "실행 중" | "완료" | "실패";

const ROOT_WIDTH = 168;
const ROOT_HEIGHT = 52;
const NODE_WIDTH = 152;
const NODE_HEIGHT = 48;
const COL_GAP = 16;
const ROW_GAP = 72;
const PAD = 16;

const NODE_STATUS_STYLE: Record<
  NodeStatus,
  { backgroundColor: string; borderColor: string; borderWidth: number }
> = {
  대기: { backgroundColor: "#D4D4D8", borderColor: "#52525B", borderWidth: 1 },
  "실행 중": { backgroundColor: "#93C5FD", borderColor: "#1D4ED8", borderWidth: 2 },
  완료: { backgroundColor: "#86EFAC", borderColor: "#166534", borderWidth: 3 },
  실패: { backgroundColor: "#FCA5A5", borderColor: "#991B1B", borderWidth: 4 },
};

const NODE_LABEL_COLOR = "#18181B";

function center(node: NodeBox) {
  return { x: node.left + node.width / 2, y: node.top + node.height / 2 };
}

function edgeMetrics(from: NodeBox, to: NodeBox) {
  const a = center(from);
  const b = center(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const width = Math.round(Math.sqrt(dx * dx + dy * dy));
  const deg = Math.round((Math.atan2(dy, dx) * 180) / Math.PI);
  return { left: a.x, top: a.y - 1, width, deg };
}

function layoutGraph(root: { id: string; name: string } | null, nodeIds: string[], compact: boolean) {
  const maxCols = compact ? 2 : 4;
  const childCount = nodeIds.length;
  const cols = Math.max(1, Math.min(maxCols, childCount || 1));
  const childrenWidth = childCount === 0 ? 0 : cols * NODE_WIDTH + (cols - 1) * COL_GAP;
  const canvasWidth = Math.max(PAD * 2 + ROOT_WIDTH, PAD * 2 + childrenWidth);
  const rootBox: NodeBox | null =
    root == null
      ? null
      : {
          id: root.id,
          left: Math.round((canvasWidth - ROOT_WIDTH) / 2),
          top: PAD,
          width: ROOT_WIDTH,
          height: ROOT_HEIGHT,
        };
  const childTop = PAD + (rootBox == null ? 0 : ROOT_HEIGHT + ROW_GAP);
  const childBoxes = nodeIds.map((id, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const inRow = Math.min(cols, childCount - row * cols);
    const rowWidth = inRow * NODE_WIDTH + (inRow - 1) * COL_GAP;
    const rowLeft = Math.round((canvasWidth - rowWidth) / 2);
    return {
      id,
      left: rowLeft + col * (NODE_WIDTH + COL_GAP),
      top: childTop + row * (NODE_HEIGHT + ROW_GAP),
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
  });
  const last = childBoxes[childBoxes.length - 1];
  const canvasHeight =
    last != null ? last.top + last.height + PAD : PAD + (rootBox == null ? 24 : rootBox.height + PAD);
  return { rootBox, childBoxes, canvasWidth, canvasHeight };
}

export function ProbePanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const directory = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const listGraphs = useRpc(listGraphsRpc);
  const getGraph = useRpc(getGraphRpc);
  const graphs = useQuery({
    queryKey: [listGraphsRpc.name, directory],
    queryFn: () => listGraphs({ directory: directory! }),
    enabled: directory != null,
  });
  const graph = useQuery({
    queryKey: [getGraphRpc.name, directory, selectedName],
    queryFn: () => getGraph({ directory: directory!, name: selectedName! }),
    enabled: directory != null && selectedName != null,
  });
  const placed = useMemo(() => {
    if (graph.data == null) {
      return null;
    }
    return layoutGraph(
      graph.data.root,
      graph.data.nodes.map((node) => node.id),
      layout.compact,
    );
  }, [graph.data, layout.compact]);
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
      name: { color: theme.colors.foreground },
      item: { paddingVertical: 8 },
      back: { paddingVertical: 8, paddingHorizontal: 4, alignSelf: "flex-start" as const },
      backText: { color: theme.colors.accent },
      canvasWrap: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        overflow: "hidden" as const,
      },
      rootNode: {
        position: "absolute" as const,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        paddingHorizontal: 8,
        zIndex: 2,
      },
      rootText: { color: NODE_LABEL_COLOR, textAlign: "center" as const },
      workerNode: {
        position: "absolute" as const,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        paddingHorizontal: 8,
        zIndex: 2,
      },
      workerText: { color: NODE_LABEL_COLOR, textAlign: "center" as const },
    }),
    [theme, layout.compact],
  );
  const names = graphs.data?.names ?? [];

  if (selectedName == null) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Text style={styles.title}>실행 목록</Text>
        {names.map((name) => (
          <Pressable
            key={name}
            accessibilityRole="button"
            accessibilityLabel={name}
            onPress={() => setSelectedName(name)}
            style={styles.item}
          >
            <Text style={styles.name}>{name}</Text>
          </Pressable>
        ))}
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="목록으로"
        onPress={() => setSelectedName(null)}
        style={styles.back}
      >
        <Text style={styles.backText}>목록으로</Text>
      </Pressable>
      <Text style={styles.title}>{selectedName}</Text>
      {graph.data?.waiting ? <Text style={styles.label}>작업 대기중</Text> : null}
      {graph.isError ? (
        <Text style={styles.label}>{graph.error instanceof Error ? graph.error.message : "그래프를 읽지 못했습니다"}</Text>
      ) : null}
      {graph.isPending ? <Text style={styles.label}>불러오는 중</Text> : null}
      {graph.data != null && placed != null ? (
        <View style={[styles.canvasWrap, { width: placed.canvasWidth, height: placed.canvasHeight }]}>
          {placed.rootBox != null
            ? placed.childBoxes.map((child) => {
                const follow = edgeMetrics(placed.rootBox!, child);
                return (
                  <View
                    key={`edge-${child.id}`}
                    style={{
                      position: "absolute",
                      left: follow.left,
                      top: follow.top,
                      width: follow.width,
                      height: 2,
                      backgroundColor: theme.colors.foreground,
                      transform: [{ rotate: `${follow.deg}deg` }],
                      transformOrigin: "0 50%",
                      zIndex: 1,
                    }}
                  />
                );
              })
            : null}
          {placed.rootBox != null && graph.data.root != null ? (
            <View
              style={[
                styles.rootNode,
                NODE_STATUS_STYLE[graph.data.root.status],
                {
                  left: placed.rootBox.left,
                  top: placed.rootBox.top,
                  width: placed.rootBox.width,
                  height: placed.rootBox.height,
                },
              ]}
            >
              <Text style={styles.rootText} numberOfLines={2}>
                {graph.data.root.name}
              </Text>
            </View>
          ) : null}
          {graph.data.nodes.map((node, index) => {
            const box = placed.childBoxes[index];
            if (box == null) {
              return null;
            }
            return (
              <View
                key={node.id}
                style={[
                  styles.workerNode,
                  NODE_STATUS_STYLE[node.status],
                  { left: box.left, top: box.top, width: box.width, height: box.height },
                ]}
              >
                <Text style={styles.workerText} numberOfLines={2}>
                  {node.displayName}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}
    </ScrollView>
  );
}
