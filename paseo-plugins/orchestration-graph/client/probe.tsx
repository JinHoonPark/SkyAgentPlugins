import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { MotionProbes } from "./s4-motion";
import { TenNodeProbe } from "./s5-nodes";

type NodeBox = { id: string; left: number; top: number; width: number; height: number };

const INITIAL_NODES: NodeBox[] = [
  { id: "A", left: 40, top: 80, width: 80, height: 40 },
  { id: "B", left: 180, top: 180, width: 80, height: 40 },
  { id: "C", left: 40, top: 200, width: 80, height: 40 },
];

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

export function Probe({ theme, layout }: PluginSurfaceProps) {
  const [count, setCount] = useState(0);
  const [tx, setTx] = useState(0);
  const [scale, setScale] = useState(1);
  const [layoutText, setLayoutText] = useState("onLayout=none");
  const [dragStartX, setDragStartX] = useState(0);
  const [dragOriginTx, setDragOriginTx] = useState(0);
  const [nodes, setNodes] = useState(INITIAL_NODES);
  const nodeA = nodes[0];
  const nodeB = nodes[1];
  const follow = edgeMetrics(nodeA, nodeB);
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
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24 },
      label: { color: theme.colors.foregroundMuted },
      value: { color: theme.colors.foreground },
      count: { color: theme.colors.foreground, fontSize: layout.compact ? 28 : 36 },
      button: { padding: 12, borderRadius: 10, backgroundColor: theme.colors.accent },
      buttonText: { color: theme.colors.accentForeground, textAlign: "center" as const },
      row: { flexDirection: "row" as const, gap: 8, flexWrap: "wrap" as const },
      canvasWrap: {
        height: 320,
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        overflow: "hidden" as const,
      },
      canvas: {
        flex: 1,
        transform: [{ translateX: tx }, { scale }],
      },
      node: {
        position: "absolute" as const,
        backgroundColor: theme.colors.accent,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        zIndex: 2,
      },
      nodeText: { color: theme.colors.accentForeground },
      followEdge: {
        position: "absolute" as const,
        left: follow.left,
        top: follow.top,
        width: follow.width,
        height: 2,
        backgroundColor: theme.colors.foreground,
        transform: [{ rotate: `${follow.deg}deg` }],
        transformOrigin: "0 50%",
        zIndex: 1,
      },
      fixedEdge: {
        position: "absolute" as const,
        left: 80,
        top: 140,
        width: 160,
        height: 2,
        backgroundColor: theme.colors.statusWarning,
        transform: [{ rotate: "37deg" }],
        transformOrigin: "0 50%",
        zIndex: 1,
      },
      curveEdge: {
        position: "absolute" as const,
        left: 80,
        top: 100,
        width: 140,
        height: 80,
        borderColor: theme.colors.statusSuccess,
        borderTopWidth: 2,
        borderRightWidth: 2,
        borderRadius: 40,
        transform: [{ rotate: "20deg" }],
        zIndex: 1,
      },
    }),
    [theme, layout.compact, tx, scale, follow.left, follow.top, follow.width, follow.deg],
  );
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>S1 probe</Text>
      <Text style={styles.label}>sidebar surface. press Increment. count must rise.</Text>
      <Text style={styles.count}>count={count}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Increment counter, currently ${count}`}
        onPress={() => setCount((value) => value + 1)}
        style={styles.button}
      >
        <Text style={styles.buttonText}>Increment</Text>
      </Pressable>

      <Text style={styles.title}>S2/S3 probe</Text>
      <Text style={styles.label}>absolute nodes + rotate View edges. Move B to test follow.</Text>
      <Text style={styles.value}>tx={tx} scale={scale}</Text>
      <Text style={styles.value}>{layoutText}</Text>
      <Text style={styles.value}>
        followEdge w={follow.width} rotate={follow.deg}deg B.left={nodeB.left} B.top={nodeB.top}
      </Text>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Translate right"
          onPress={() => setTx((value) => value + 20)}
          style={styles.button}
        >
          <Text style={styles.buttonText}>tx +20</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Scale up"
          onPress={() => setScale((value) => Math.round((value + 0.2) * 10) / 10)}
          style={styles.button}
        >
          <Text style={styles.buttonText}>scale +0.2</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Move node B"
          onPress={() =>
            setNodes((current) =>
              current.map((node) =>
                node.id === "B" ? { ...node, left: node.left + 20, top: node.top - 16 } : node,
              ),
            )
          }
          style={styles.button}
        >
          <Text style={styles.buttonText}>move B</Text>
        </Pressable>
      </View>
      <View
        style={styles.canvasWrap}
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          setLayoutText(`onLayout w=${width} h=${height}`);
        }}
        onStartShouldSetResponder={() => true}
        onResponderGrant={(event) => {
          setDragStartX(event.nativeEvent.pageX);
          setDragOriginTx(tx);
        }}
        onResponderMove={(event) => {
          const next = Math.round(dragOriginTx + (event.nativeEvent.pageX - dragStartX));
          setTx(next);
        }}
      >
        <View style={styles.canvas}>
          <View style={styles.followEdge} />
          <View style={styles.fixedEdge} />
          <View style={styles.curveEdge} />
          {nodes.map((node) => (
            <View
              key={node.id}
              style={[
                styles.node,
                { left: node.left, top: node.top, width: node.width, height: node.height },
              ]}
            >
              <Text style={styles.nodeText}>{node.id}</Text>
            </View>
          ))}
        </View>
      </View>
      <MotionProbes
        foreground={theme.colors.foreground}
        muted={theme.colors.foregroundMuted}
        accent={theme.colors.accent}
      />
      <TenNodeProbe
        foreground={theme.colors.foreground}
        muted={theme.colors.foregroundMuted}
        accent={theme.colors.accent}
        accentForeground={theme.colors.accentForeground}
        surface={theme.colors.surface1}
        border={theme.colors.border}
      />
    </ScrollView>
  );
}
