import { Icon } from "@getpaseo/plugin/client/react-native";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Text, View } from "react-native";
import type { GraphView } from "../shared/graphs";
import { registerStop } from "./cleanup";
import {
  BADGE_HEIGHT,
  EXIT_FADE_MS,
  FLOW_DOT,
  FLOW_PERIOD_MS,
  INTRO_FADE_MS,
  INTRO_STAGGER_MS,
  LAYOUT_MOVE_MS,
  LINE_HEIGHT,
  NODE_RADIUS,
  PULSE_MS,
  STATUS_BAR_WIDTH,
  STATUS_ICON,
  STATUS_MOTION_MS,
  incomingPaths,
  introEdgeDelayMs,
  layoutMoveNeeded,
  pointAlongSegments,
  runningNodeIds,
  shouldPlayIntro,
  shouldRunProgressLoop,
  statusVisual,
  type EdgeSegment,
  type GraphThemeColors,
  type NodeBox,
  type NodeStatus,
  type PlacedGraph,
} from "./motion-logic";

type NodePos = {
  tx: Animated.Value;
  ty: Animated.Value;
  opacity: Animated.Value;
  left: number;
  top: number;
  width: number;
  height: number;
  exiting: boolean;
};

type SegPos = {
  left: Animated.Value;
  top: Animated.Value;
  width: Animated.Value;
  deg: Animated.Value;
  opacity: Animated.Value;
  leftN: number;
  topN: number;
  widthN: number;
  degN: number;
  exiting: boolean;
};

type Ghost = {
  id: string;
  mode: "root" | "worker";
  status: NodeStatus | null;
  name: string;
  labelLines: string[];
  width: number;
  height: number;
  pos: NodePos;
};

type SegGhost = {
  key: string;
  pos: SegPos;
};

type Paint = ReturnType<typeof statusVisual>;

type NodeBoxProps = {
  mode: "root" | "worker";
  status: NodeStatus | null;
  name: string;
  labelLines: string[];
  width: number;
  height: number;
  pos: NodePos;
  colors: GraphThemeColors;
};

function sameLines(left: string[], right: string[]) {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  return left.every((line, index) => line === right[index]);
}

function ensureNodePos(map: Map<string, NodePos>, id: string, box: NodeBox): NodePos {
  const existing = map.get(id);
  if (existing) {
    if (!existing.exiting) {
      existing.width = box.width;
      existing.height = box.height;
    }
    return existing;
  }
  const created: NodePos = {
    tx: new Animated.Value(box.left),
    ty: new Animated.Value(box.top),
    opacity: new Animated.Value(0),
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    exiting: false,
  };
  map.set(id, created);
  return created;
}

function ensureSegPos(map: Map<string, SegPos>, segment: EdgeSegment, hidden: boolean): SegPos {
  const existing = map.get(segment.key);
  if (existing) {
    return existing;
  }
  const created: SegPos = {
    left: new Animated.Value(segment.left),
    top: new Animated.Value(segment.top),
    width: new Animated.Value(segment.width),
    deg: new Animated.Value(segment.deg),
    opacity: new Animated.Value(hidden ? 0 : 1),
    leftN: segment.left,
    topN: segment.top,
    widthN: segment.width,
    degN: segment.deg,
    exiting: false,
  };
  map.set(segment.key, created);
  return created;
}

function trackAnimation(pending: Set<() => void>, anim: Animated.CompositeAnimation) {
  const unreg = registerStop(() => anim.stop());
  const finish = () => {
    pending.delete(finish);
    unreg();
  };
  pending.add(finish);
  anim.start(finish);
  return finish;
}

function trackTimeout(pending: Set<() => void>, fn: () => void, delay: number) {
  let unreg = () => {};
  const timer = setTimeout(() => {
    pending.delete(clear);
    unreg();
    fn();
  }, delay);
  unreg = registerStop(() => {
    clearTimeout(timer);
  });
  const clear = () => {
    pending.delete(clear);
    unreg();
  };
  pending.add(clear);
  return clear;
}

function flushPending(pending: Set<() => void>) {
  for (const clear of [...pending]) {
    clear();
  }
  pending.clear();
}

function stopTracked(stops: Map<string, () => void>, id: string) {
  const stop = stops.get(id);
  if (stop == null) {
    return;
  }
  stops.delete(id);
  stop();
}

const NodeBoxView = memo(
  function NodeBoxView({ mode, status, name, labelLines, width, height, pos, colors }: NodeBoxProps) {
    const initial = statusVisual(status, colors);
    const scale = useRef(new Animated.Value(initial.scale)).current;
    const colorT = useRef(new Animated.Value(1)).current;
    const fromRef = useRef<Paint>(initial);
    const [range, setRange] = useState<{ from: Paint; to: Paint }>({ from: initial, to: initial });
    const skip = useRef(true);

    useEffect(() => {
      if (skip.current) {
        skip.current = false;
        fromRef.current = statusVisual(status, colors);
        return;
      }
      const next = statusVisual(status, colors);
      const prevPaint = fromRef.current;
      fromRef.current = next;
      setRange({ from: prevPaint, to: next });
      colorT.setValue(0);
      const color = Animated.timing(colorT, {
        toValue: 1,
        duration: STATUS_MOTION_MS,
        useNativeDriver: false,
      });
      const size = Animated.timing(scale, {
        toValue: next.scale,
        duration: STATUS_MOTION_MS,
        useNativeDriver: true,
      });
      const unregColor = registerStop(() => color.stop());
      const unregSize = registerStop(() => size.stop());
      color.start(() => unregColor());
      size.start(() => unregSize());
      return () => {
        unregColor();
        unregSize();
      };
    }, [status, colors, colorT, scale]);

    const backgroundColor = colorT.interpolate({
      inputRange: [0, 1],
      outputRange: [range.from.backgroundColor, range.to.backgroundColor],
    });
    const borderColor = colorT.interpolate({
      inputRange: [0, 1],
      outputRange: [range.from.borderColor, range.to.borderColor],
    });
    const borderWidth = colorT.interpolate({
      inputRange: [0, 1],
      outputRange: [range.from.borderWidth, range.to.borderWidth],
    });
    const fromBar = range.from.statusColor;
    const toBar = range.to.statusColor;
    const barColor =
      fromBar != null && toBar != null
        ? colorT.interpolate({
            inputRange: [0, 1],
            outputRange: [fromBar, toBar],
          })
        : toBar;
    const badgeColor = toBar;

    return (
      <Animated.View
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width,
          height,
          zIndex: 3,
          opacity: pos.opacity,
          transform: [{ translateX: pos.tx }, { translateY: pos.ty }, { scale }],
        }}
      >
        <Animated.View
          style={{
            flex: 1,
            backgroundColor,
            borderColor,
            borderWidth,
            borderRadius: NODE_RADIUS,
            borderStyle: range.to.dashed ? "dashed" : "solid",
            boxShadow: range.to.boxShadow,
            overflow: "visible",
          }}
        >
          {barColor != null ? (
            <Animated.View
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                width: STATUS_BAR_WIDTH,
                backgroundColor: barColor,
                borderTopLeftRadius: NODE_RADIUS,
                borderBottomLeftRadius: NODE_RADIUS,
              }}
            />
          ) : null}
          {status != null && badgeColor != null ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingLeft: 10,
                paddingRight: 8,
                paddingTop: 6,
                height: BADGE_HEIGHT,
                gap: 4,
              }}
            >
              <Icon name={STATUS_ICON[status]} size={12} color={badgeColor} />
              <Text
                selectable={false}
                style={{ color: badgeColor, fontSize: 11, lineHeight: 14 }}
                numberOfLines={1}
              >
                {status}
              </Text>
            </View>
          ) : null}
          <View
            style={{
              flex: 1,
              justifyContent: "center",
              paddingHorizontal: 10,
              paddingBottom: 10,
            }}
          >
            {mode === "root" ? (
              <Text
                selectable={false}
                style={{
                  color: colors.foreground,
                  textAlign: "center",
                  fontSize: 12,
                  lineHeight: LINE_HEIGHT,
                }}
                numberOfLines={2}
              >
                {name}
              </Text>
            ) : (
              labelLines.map((line, lineIndex) => {
                const primary = lineIndex === 0;
                return (
                  <Text
                    key={lineIndex}
                    selectable={false}
                    style={{
                      color: primary ? colors.foreground : colors.foregroundMuted,
                      textAlign: "center",
                      fontSize: primary ? 13 : 11,
                      ...(primary ? { fontWeight: "600" as const } : {}),
                      lineHeight: LINE_HEIGHT,
                    }}
                    numberOfLines={1}
                  >
                    {line}
                  </Text>
                );
              })
            )}
          </View>
        </Animated.View>
      </Animated.View>
    );
  },
  (prev, next) =>
    prev.mode === next.mode &&
    prev.status === next.status &&
    prev.name === next.name &&
    prev.width === next.width &&
    prev.height === next.height &&
    prev.pos === next.pos &&
    prev.colors === next.colors &&
    sameLines(prev.labelLines, next.labelLines),
);

function EdgeSegmentView({
  color,
  pos,
  thickness,
}: {
  color: string;
  pos: SegPos;
  thickness: number;
}) {
  const rotate = pos.deg.interpolate({
    inputRange: [-360, 360],
    outputRange: ["-360deg", "360deg"],
  });
  return (
    <Animated.View
      style={{
        position: "absolute",
        left: pos.left,
        top: pos.top,
        width: pos.width,
        height: thickness,
        backgroundColor: color,
        opacity: pos.opacity,
        transform: [{ rotate }],
        transformOrigin: "0 50%",
        zIndex: 1,
      }}
    />
  );
}

export function GraphCanvas({
  view,
  placed,
  colors,
}: {
  view: GraphView;
  placed: PlacedGraph;
  colors: GraphThemeColors;
}) {
  const nodePos = useRef(new Map<string, NodePos>());
  const segPos = useRef(new Map<string, SegPos>());
  const intro = useRef({ started: false, done: false });
  const seenIds = useRef(new Set<string>());
  const booted = useRef(false);
  const mounted = useRef(true);
  const prevPlaced = useRef<PlacedGraph | null>(null);
  const prevView = useRef(view);
  const pulse = useRef(new Animated.Value(0.35)).current;
  const edgesOpacity = useRef(new Animated.Value(shouldPlayIntro("layer2-open") ? 0 : 1)).current;
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [segGhosts, setSegGhosts] = useState<SegGhost[]>([]);
  const viewRef = useRef(view);
  viewRef.current = view;

  const runningIds = useMemo(
    () => runningNodeIds(view.root, view.nodes),
    [view.root, view.nodes],
  );
  const runningSet = useMemo(() => new Set(runningIds), [runningIds]);
  const hasRunning = shouldRunProgressLoop(runningIds.length);
  const incoming = incomingPaths(placed.paths, runningSet);
  const incomingRef = useRef(incoming);
  incomingRef.current = incoming;
  const flowDots = useRef(new Map<string, { x: Animated.Value; y: Animated.Value }>());
  const pendingStops = useRef(new Set<() => void>());
  const nodeExitStops = useRef(new Map<string, () => void>());
  const segExitStops = useRef(new Map<string, () => void>());

  const liveIds: string[] = [];
  if (view.root != null && placed.rootBox != null) {
    liveIds.push(view.root.id);
    ensureNodePos(nodePos.current, view.root.id, placed.rootBox);
  }
  for (const node of view.nodes) {
    const box = placed.boxes.get(node.id);
    if (box == null) {
      continue;
    }
    liveIds.push(node.id);
    ensureNodePos(nodePos.current, node.id, box);
  }
  if (!booted.current) {
    booted.current = true;
    seenIds.current = new Set(liveIds);
  }
  const introDone = intro.current.done;
  for (const path of placed.paths) {
    for (const segment of path.segments) {
      ensureSegPos(segPos.current, segment, introDone && !segPos.current.has(segment.key));
    }
  }
  if (hasRunning) {
    for (const path of incoming) {
      if (!flowDots.current.has(path.key)) {
        const start = pointAlongSegments(path.segments, 0) ?? { x: 0, y: 0 };
        flowDots.current.set(path.key, {
          x: new Animated.Value(start.x - FLOW_DOT / 2),
          y: new Animated.Value(start.y - FLOW_DOT / 2),
        });
      }
    }
  }

  useEffect(() => {
    mounted.current = true;
    const pending = pendingStops.current;
    return registerStop(() => {
      mounted.current = false;
      flushPending(pending);
    });
  }, []);

  useEffect(() => {
    if (!shouldPlayIntro("layer2-open") || intro.current.started) {
      return;
    }
    intro.current.started = true;
    const ids = [...seenIds.current];
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    ids.forEach((id, index) => {
      timeouts.push(
        setTimeout(() => {
          const pos = nodePos.current.get(id);
          if (pos == null) {
            return;
          }
          trackAnimation(
            pendingStops.current,
            Animated.timing(pos.opacity, {
              toValue: 1,
              duration: INTRO_FADE_MS,
              useNativeDriver: true,
            }),
          );
        }, index * INTRO_STAGGER_MS),
      );
    });
    timeouts.push(
      setTimeout(() => {
        trackAnimation(
          pendingStops.current,
          Animated.timing(edgesOpacity, {
            toValue: 1,
            duration: INTRO_FADE_MS,
            useNativeDriver: false,
          }),
        );
        intro.current.done = true;
      }, introEdgeDelayMs(ids.length)),
    );
    return registerStop(() => {
      timeouts.forEach(clearTimeout);
    });
  }, [edgesOpacity]);

  const liveKey = liveIds.join("|");
  useEffect(() => {
    const current = new Set(liveKey.length === 0 ? [] : liveKey.split("|"));
    for (const id of current) {
      if (seenIds.current.has(id)) {
        continue;
      }
      seenIds.current.add(id);
      const pos = nodePos.current.get(id);
      if (pos == null) {
        continue;
      }
      pos.opacity.setValue(0);
      trackAnimation(
        pendingStops.current,
        Animated.timing(pos.opacity, {
          toValue: 1,
          duration: INTRO_FADE_MS,
          useNativeDriver: true,
        }),
      );
    }
  }, [liveKey]);

  useEffect(() => {
    const previous = prevPlaced.current;
    const previousView = prevView.current;
    prevPlaced.current = placed;
    prevView.current = viewRef.current;
    if (previous == null) {
      return;
    }
    const currentView = viewRef.current;
    const currentIds = new Set<string>();
    if (currentView.root != null) {
      currentIds.add(currentView.root.id);
    }
    for (const node of currentView.nodes) {
      currentIds.add(node.id);
    }
    const revivedIds: string[] = [];
    for (const id of currentIds) {
      const pos = nodePos.current.get(id);
      if (pos == null || !pos.exiting) {
        continue;
      }
      stopTracked(nodeExitStops.current, id);
      pos.exiting = false;
      revivedIds.push(id);
      const box =
        currentView.root?.id === id
          ? placed.rootBox
          : (placed.boxes.get(id) ?? null);
      if (box != null) {
        pos.width = box.width;
        pos.height = box.height;
      }
      trackAnimation(
        pendingStops.current,
        Animated.timing(pos.opacity, {
          toValue: 1,
          duration: INTRO_FADE_MS,
          useNativeDriver: true,
        }),
      );
    }
    if (revivedIds.length > 0) {
      const revived = new Set(revivedIds);
      setGhosts((prev) => prev.filter((ghost) => !revived.has(ghost.id)));
    }

    const removed: Ghost[] = [];
    for (const [id, pos] of nodePos.current) {
      if (currentIds.has(id) || pos.exiting) {
        continue;
      }
      pos.exiting = true;
      const wasRoot = previousView.root?.id === id;
      const node = previousView.nodes.find((item) => item.id === id);
      removed.push({
        id,
        mode: wasRoot ? "root" : "worker",
        status: wasRoot ? (previousView.root?.status ?? null) : (node?.status ?? null),
        name: wasRoot ? (previousView.root?.name ?? id) : (node?.displayName ?? id),
        labelLines: node?.labelLines ?? [],
        width: pos.width,
        height: pos.height,
        pos,
      });
      const stopFade = trackAnimation(
        pendingStops.current,
        Animated.timing(pos.opacity, {
          toValue: 0,
          duration: EXIT_FADE_MS,
          useNativeDriver: true,
        }),
      );
      const stopTimer = trackTimeout(
        pendingStops.current,
        () => {
          nodeExitStops.current.delete(id);
          if (!mounted.current) {
            return;
          }
          const current = nodePos.current.get(id);
          if (current != null && !current.exiting) {
            return;
          }
          seenIds.current.delete(id);
          nodePos.current.delete(id);
          setGhosts((prev) => prev.filter((ghost) => ghost.id !== id));
        },
        EXIT_FADE_MS,
      );
      nodeExitStops.current.set(id, () => {
        stopFade();
        stopTimer();
      });
    }
    if (removed.length > 0) {
      setGhosts((prev) => [...prev, ...removed]);
    }

    const move = (id: string, box: NodeBox) => {
      const pos = nodePos.current.get(id);
      if (pos == null || pos.exiting) {
        return;
      }
      if (!layoutMoveNeeded({ left: pos.left, top: pos.top }, box)) {
        return;
      }
      pos.left = box.left;
      pos.top = box.top;
      trackAnimation(
        pendingStops.current,
        Animated.parallel([
          Animated.timing(pos.tx, {
            toValue: box.left,
            duration: LAYOUT_MOVE_MS,
            useNativeDriver: true,
          }),
          Animated.timing(pos.ty, {
            toValue: box.top,
            duration: LAYOUT_MOVE_MS,
            useNativeDriver: true,
          }),
        ]),
      );
    };
    if (currentView.root != null && placed.rootBox != null) {
      move(currentView.root.id, placed.rootBox);
    }
    for (const node of currentView.nodes) {
      const box = placed.boxes.get(node.id);
      if (box != null) {
        move(node.id, box);
      }
    }

    const prevSegKeys = new Set<string>();
    for (const path of previous.paths) {
      for (const segment of path.segments) {
        prevSegKeys.add(segment.key);
      }
    }
    const liveSegs = new Set<string>();
    const revivedSegKeys: string[] = [];
    for (const path of placed.paths) {
      for (const segment of path.segments) {
        liveSegs.add(segment.key);
        const pos = ensureSegPos(segPos.current, segment, false);
        if (pos.exiting) {
          stopTracked(segExitStops.current, segment.key);
          pos.exiting = false;
          revivedSegKeys.push(segment.key);
          trackAnimation(
            pendingStops.current,
            Animated.timing(pos.opacity, {
              toValue: 1,
              duration: INTRO_FADE_MS,
              useNativeDriver: false,
            }),
          );
        } else if (!prevSegKeys.has(segment.key)) {
          pos.opacity.setValue(0);
          trackAnimation(
            pendingStops.current,
            Animated.timing(pos.opacity, {
              toValue: 1,
              duration: INTRO_FADE_MS,
              useNativeDriver: false,
            }),
          );
        }
        if (
          pos.leftN === segment.left &&
          pos.topN === segment.top &&
          pos.widthN === segment.width &&
          pos.degN === segment.deg
        ) {
          continue;
        }
        pos.leftN = segment.left;
        pos.topN = segment.top;
        pos.widthN = segment.width;
        pos.degN = segment.deg;
        trackAnimation(
          pendingStops.current,
          Animated.parallel([
            Animated.timing(pos.left, {
              toValue: segment.left,
              duration: LAYOUT_MOVE_MS,
              useNativeDriver: false,
            }),
            Animated.timing(pos.top, {
              toValue: segment.top,
              duration: LAYOUT_MOVE_MS,
              useNativeDriver: false,
            }),
            Animated.timing(pos.width, {
              toValue: segment.width,
              duration: LAYOUT_MOVE_MS,
              useNativeDriver: false,
            }),
            Animated.timing(pos.deg, {
              toValue: segment.deg,
              duration: LAYOUT_MOVE_MS,
              useNativeDriver: false,
            }),
          ]),
        );
      }
    }
    if (revivedSegKeys.length > 0) {
      const revived = new Set(revivedSegKeys);
      setSegGhosts((prev) => prev.filter((ghost) => !revived.has(ghost.key)));
    }
    const removedSegs: SegGhost[] = [];
    for (const [key, pos] of segPos.current) {
      if (liveSegs.has(key) || pos.exiting) {
        continue;
      }
      pos.exiting = true;
      removedSegs.push({ key, pos });
      const stopFade = trackAnimation(
        pendingStops.current,
        Animated.timing(pos.opacity, {
          toValue: 0,
          duration: EXIT_FADE_MS,
          useNativeDriver: false,
        }),
      );
      const stopTimer = trackTimeout(
        pendingStops.current,
        () => {
          segExitStops.current.delete(key);
          if (!mounted.current) {
            return;
          }
          const current = segPos.current.get(key);
          if (current != null && !current.exiting) {
            return;
          }
          segPos.current.delete(key);
          setSegGhosts((prev) => prev.filter((ghost) => ghost.key !== key));
        },
        EXIT_FADE_MS,
      );
      segExitStops.current.set(key, () => {
        stopFade();
        stopTimer();
      });
    }
    if (removedSegs.length > 0) {
      setSegGhosts((prev) => [...prev, ...removedSegs]);
    }
  }, [placed]);

  useEffect(() => {
    if (!hasRunning) {
      pulse.setValue(0.35);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: PULSE_MS, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.25, duration: PULSE_MS, useNativeDriver: true }),
      ]),
    );
    loop.start();
    let rafId = 0;
    const tick = (now: number) => {
      const t = (now % FLOW_PERIOD_MS) / FLOW_PERIOD_MS;
      for (const path of incomingRef.current) {
        const point = pointAlongSegments(path.segments, t);
        const dot = flowDots.current.get(path.key);
        if (point == null || dot == null) {
          continue;
        }
        dot.x.setValue(point.x - FLOW_DOT / 2);
        dot.y.setValue(point.y - FLOW_DOT / 2);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return registerStop(() => {
      loop.stop();
      pulse.stopAnimation();
      pulse.setValue(0.35);
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafId);
      }
    });
  }, [hasRunning, pulse]);

  const ghostIds = new Set(ghosts.map((ghost) => ghost.id));
  const ghostSegKeys = new Set(segGhosts.map((ghost) => ghost.key));

  return (
    <View style={{ width: placed.canvasWidth, height: placed.canvasHeight }}>
      <Animated.View style={{ opacity: edgesOpacity }}>
        {placed.paths.flatMap((path) =>
          path.segments.map((segment) => {
            if (ghostSegKeys.has(segment.key)) {
              return null;
            }
            const pos = segPos.current.get(segment.key);
            if (pos == null) {
              return null;
            }
            const runningIncoming = runningSet.has(path.to);
            return (
              <EdgeSegmentView
                key={segment.key}
                color={runningIncoming ? colors.accent : colors.border}
                thickness={runningIncoming ? 2 : 1}
                pos={pos}
              />
            );
          }),
        )}
        {segGhosts.map((ghost) => (
          <EdgeSegmentView
            key={`ghost-${ghost.key}`}
            color={colors.border}
            thickness={1}
            pos={ghost.pos}
          />
        ))}
      </Animated.View>
      {hasRunning
        ? incoming.map((path) => {
            const dot = flowDots.current.get(path.key);
            if (dot == null) {
              return null;
            }
            return (
              <Animated.View
                key={`flow-${path.key}`}
                pointerEvents="none"
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: FLOW_DOT,
                  height: FLOW_DOT,
                  borderRadius: FLOW_DOT / 2,
                  backgroundColor: colors.accent,
                  zIndex: 2,
                  transform: [{ translateX: dot.x }, { translateY: dot.y }],
                }}
              />
            );
          })
        : null}
      {view.root != null && placed.rootBox != null && !ghostIds.has(view.root.id) ? (
        <NodeBoxView
          mode="root"
          status={view.root.status}
          name={view.root.name}
          labelLines={[]}
          width={placed.rootBox.width}
          height={placed.rootBox.height}
          pos={nodePos.current.get(view.root.id)!}
          colors={colors}
        />
      ) : null}
      {view.nodes.map((node) => {
        const box = placed.boxes.get(node.id);
        const pos = nodePos.current.get(node.id);
        if (box == null || pos == null || ghostIds.has(node.id)) {
          return null;
        }
        return (
          <NodeBoxView
            key={node.id}
            mode="worker"
            status={node.status}
            name={node.displayName}
            labelLines={node.labelLines}
            width={box.width}
            height={box.height}
            pos={pos}
            colors={colors}
          />
        );
      })}
      {ghosts.map((ghost) => (
        <NodeBoxView
          key={`ghost-${ghost.id}`}
          mode={ghost.mode}
          status={ghost.status}
          name={ghost.name}
          labelLines={ghost.labelLines}
          width={ghost.width}
          height={ghost.height}
          pos={ghost.pos}
          colors={colors}
        />
      ))}
    </View>
  );
}
