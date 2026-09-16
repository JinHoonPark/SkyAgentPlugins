import { Icon } from "@getpaseo/plugin/client/react-native";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, Text, View, type ViewStyle } from "react-native";
import type { GraphNodeShape, GraphView } from "../shared/graphs";
import { registerStop } from "./cleanup";
import {
  BADGE_HEIGHT,
  EXIT_FADE_MS,
  FLOW_PERIOD_MS,
  GATE_ARM_WIDTH,
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
  /** 지금까지 이 조각이 가졌던 최대 길이. 점선 조각을 미리 만들어 두는 상한이다. */
  peak: number;
  exiting: boolean;
};

type Ghost = {
  id: string;
  mode: "root" | "worker";
  status: NodeStatus | null;
  name: string;
  labelLines: string[];
  shape: GraphNodeShape;
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
  shape: GraphNodeShape;
  width: number;
  height: number;
  pos: NodePos;
  colors: GraphThemeColors;
  agentId: string | null;
  onPress?: (agentId: string) => void;
};

/**
 * 화살촉의 가로·세로 크기. 꼭짓점은 상자의 오른쪽 중앙이라, 상자의 왼쪽 변에서 오른쪽으로
 * HEAD_WIDTH만큼 떨어진 자리에 온다.
 */
const HEAD_WIDTH = 9;
const HEAD_HEIGHT = 8;
/** 엣지 라벨 한 줄의 최대 폭과 최대 줄 수. 노드 카드(260)보다 좁게 잡아 카드를 덮지 않는다. */
const LABEL_MAX_WIDTH = 160;
const LABEL_MAX_LINES = 2;
const LABEL_PAD_X = 3;
const LABEL_PAD_Y = 1;
/** 점선 엣지의 조각 길이와 간격. */
const DASH_LENGTH = 8;
const DASH_GAP = 6;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

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
    peak: segment.width,
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
  function NodeBoxView({
    mode,
    status,
    name,
    labelLines,
    shape,
    width,
    height,
    pos,
    colors,
    agentId,
    onPress,
  }: NodeBoxProps) {
    const press = agentId != null && onPress != null;
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

    if (shape === "hexagon") {
      // 게이트 카드는 정지해 있다 — 테두리·글로우·왼쪽 막대가 없고 상태 줄도 그리지 않는다.
      return (
        <AnimatedPressable
          disabled={!press}
          onPress={press ? () => onPress(agentId) : undefined}
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
          <View style={{ flexDirection: "row", width, height }}>
            <GateArm side="left" height={height} colors={colors} />
            <View
              style={{
                width: width - GATE_ARM_WIDTH * 2,
                height,
                backgroundColor: colors.surface2,
                borderColor: colors.border,
                borderWidth: 1,
                alignItems: "center",
                justifyContent: "center",
                paddingHorizontal: 10,
              }}
            >
              {labelLines.map((line, lineIndex) => {
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
              })}
            </View>
            <GateArm side="right" height={height} colors={colors} />
          </View>
        </AnimatedPressable>
      );
    }

    return (
      <AnimatedPressable
        disabled={!press}
        onPress={press ? () => onPress(agentId) : undefined}
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
      </AnimatedPressable>
    );
  },
  (prev, next) =>
    prev.mode === next.mode &&
    prev.status === next.status &&
    prev.name === next.name &&
    prev.shape === next.shape &&
    prev.width === next.width &&
    prev.height === next.height &&
    prev.pos === next.pos &&
    prev.colors === next.colors &&
    prev.agentId === next.agentId &&
    prev.onPress === next.onPress &&
    sameLines(prev.labelLines, next.labelLines),
);

/**
 * 육각형 게이트의 좌우 삼각형 날개.
 * 보이지 않아야 할 두 변은 캔버스 배경색으로 칠한다(투명 색 문자열을 쓰지 않기 위함).
 * 왼쪽 날개는 꼭짓점이 왼쪽, 오른쪽 날개는 꼭짓점이 오른쪽이다.
 */
function GateArm({
  side,
  height,
  colors,
}: {
  side: "left" | "right";
  height: number;
  colors: GraphThemeColors;
}) {
  const half = height / 2;
  const style: ViewStyle =
    side === "left"
      ? {
          width: 0,
          height: 0,
          borderTopWidth: half,
          borderBottomWidth: half,
          borderTopColor: colors.surface1,
          borderBottomColor: colors.surface1,
          borderRightWidth: GATE_ARM_WIDTH,
          borderRightColor: colors.surface2,
        }
      : {
          width: 0,
          height: 0,
          borderTopWidth: half,
          borderBottomWidth: half,
          borderTopColor: colors.surface1,
          borderBottomColor: colors.surface1,
          borderLeftWidth: GATE_ARM_WIDTH,
          borderLeftColor: colors.surface2,
        };
  return <View style={style} />;
}

/** 점선 엣지의 조각들. 길이 상한까지 미리 만들고, 넘치는 조각은 선 상자가 잘라 낸다. */
function dashPieces(peak: number, thickness: number, color: string) {
  const pieces = [];
  for (let left = 0; left < peak; left += DASH_LENGTH + DASH_GAP) {
    pieces.push(
      <View
        key={String(left)}
        style={{
          position: "absolute",
          left,
          top: 0,
          width: DASH_LENGTH,
          height: thickness,
          backgroundColor: color,
        }}
      />,
    );
  }
  return pieces;
}

/**
 * 화살촉 하나. 테두리 삼각형이고 꼭짓점은 상자의 오른쪽 중앙이다.
 * 보이지 않아야 할 두 변은 캔버스 배경색으로 칠한다(투명 색 문자열을 쓰지 않기 위함).
 * 도착 지점의 고정 화살촉과 실행 중 선을 흐르는 화살표가 이 모양을 함께 쓴다.
 */
function arrowHeadStyle(colors: GraphThemeColors) {
  return {
    width: 0,
    height: 0,
    borderLeftWidth: HEAD_WIDTH,
    borderTopWidth: HEAD_HEIGHT / 2,
    borderBottomWidth: HEAD_HEIGHT / 2,
    borderLeftColor: colors.accent,
    borderTopColor: colors.surface1,
    borderBottomColor: colors.surface1,
  } as const;
}

function EdgeSegmentView({
  color,
  pos,
  thickness,
  dashed,
  head,
  colors,
}: {
  color: string;
  pos: SegPos;
  thickness: number;
  dashed: boolean;
  head: boolean;
  colors: GraphThemeColors;
}) {
  const rotate = pos.deg.interpolate({
    inputRange: [-360, 360],
    outputRange: ["-360deg", "360deg"],
  });
  return (
    <Animated.View
      // 장식이라 터치를 받지 않는다. 이 상자는 폭이 수백 px인 회전 상자여서, 터치를 받으면
      // 그 아래 노드 카드의 누름을 가로챈다.
      pointerEvents="none"
      style={{
        position: "absolute",
        left: pos.left,
        top: pos.top,
        width: pos.width,
        height: thickness,
        opacity: pos.opacity,
        transform: [{ rotate }],
        transformOrigin: "0 50%",
        zIndex: 1,
      }}
    >
      <Animated.View
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: pos.width,
          height: thickness,
          backgroundColor: dashed ? undefined : color,
          overflow: dashed ? "hidden" : "visible",
        }}
      >
        {dashed ? dashPieces(pos.peak, thickness, color) : null}
      </Animated.View>
      {head ? (
        // 꼭짓점이 선의 끝, 즉 도착 노드 경계에 닿는다. 회전은 선 상자가 이미 하고 있으므로
        // 조각의 세로 위치만 선 중심에 맞추면 된다. 조각의 오른쪽 끝에 붙이는 이유는 폭이
        // Animated 값이라 `left`로는 계산할 수 없기 때문이다 — 일반 View는 Animated 값을
        // 풀지 못해 `left`가 무효가 되고 화살촉이 조각 시작점, 즉 엣지가 꺾이는 자리에 선다.
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            right: 0,
            top: thickness / 2 - HEAD_HEIGHT / 2,
            width: HEAD_WIDTH,
            height: HEAD_HEIGHT,
          }}
        >
          <View style={arrowHeadStyle(colors)} />
        </View>
      ) : null}
    </Animated.View>
  );
}

/** 잘린 엣지 라벨의 전체 문구를 띄우는 데 필요한 값. 좌표는 캔버스 기준이고, 화면 좌표로 옮기는
 * 일은 그래프 뷰포트 바깥에 툴팁을 그리는 패널이 맡는다. */
export type LabelHover = {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
};

/** 선 위에 놓이는 라벨. 선과 형제인 절대 좌표라 기울지 않고, 폭을 실측해 중심을 선 중점에 맞춘다. */
function EdgeLabelView({
  text,
  x,
  y,
  colors,
  onHover,
}: {
  text: string;
  x: number;
  y: number;
  colors: GraphThemeColors;
  onHover?: (hover: LabelHover | null) => void;
}) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [shownHeight, setShownHeight] = useState(0);
  const [fullHeight, setFullHeight] = useState(0);
  const left = x - size.width / 2;
  const top = y - size.height / 2;
  // 자르지 않은 사본은 같은 폭으로 접히므로, 줄 수가 늘어난 것이 곧 `…`로 잘렸다는 뜻이다.
  // 문구가 전부 보이는 라벨에는 툴팁이 뜨지 않는다.
  const truncated = fullHeight > shownHeight + 0.5;
  const textStyle = { color: colors.foregroundMuted, fontSize: 11, lineHeight: 14 } as const;
  return (
    <Pressable
      // 호버만 받는다. 누름 처리자를 두지 않아 라벨 위에서도 캔버스 드래그 팬이 이어진다.
      onHoverIn={() => {
        if (truncated) {
          onHover?.({ text, left, top, width: size.width, height: size.height });
        }
      }}
      onHoverOut={() => onHover?.(null)}
      // 실측한 폭으로 가운데를 맞추므로 줄 수가 늘어도 중심은 선 중점에 그대로 남는다.
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
      }}
      style={{
        position: "absolute",
        left,
        top,
        maxWidth: LABEL_MAX_WIDTH,
        paddingHorizontal: LABEL_PAD_X,
        paddingVertical: LABEL_PAD_Y,
        backgroundColor: colors.surface1,
        zIndex: 1,
      }}
    >
      <View
        // 잘림 판정용 사본. 줄 수 제한만 빼고 폭을 같게 두어 접히는 자리를 맞춘다.
        pointerEvents="none"
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: LABEL_MAX_WIDTH - LABEL_PAD_X * 2,
          opacity: 0,
        }}
      >
        <Text
          selectable={false}
          style={textStyle}
          onLayout={(event) => setFullHeight(event.nativeEvent.layout.height)}
        >
          {text}
        </Text>
      </View>
      <Text
        selectable={false}
        numberOfLines={LABEL_MAX_LINES}
        ellipsizeMode="tail"
        style={textStyle}
        onLayout={(event) => setShownHeight(event.nativeEvent.layout.height)}
      >
        {text}
      </Text>
    </Pressable>
  );
}

export function GraphCanvas({
  view,
  placed,
  colors,
  onNodePress,
  onLabelHover,
}: {
  view: GraphView;
  placed: PlacedGraph;
  colors: GraphThemeColors;
  onNodePress?: (agentId: string) => void;
  onLabelHover?: (hover: LabelHover | null) => void;
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
  const flowMarkers = useRef(new Map<string, { x: Animated.Value; y: Animated.Value; deg: Animated.Value }>());
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
      if (!flowMarkers.current.has(path.key)) {
        const start = pointAlongSegments(path.segments, 0) ?? { x: 0, y: 0, deg: 0 };
        flowMarkers.current.set(path.key, {
          x: new Animated.Value(start.x - HEAD_WIDTH / 2),
          y: new Animated.Value(start.y - HEAD_HEIGHT / 2),
          deg: new Animated.Value(start.deg),
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
        shape: node?.shape ?? "rect",
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
        pos.peak = Math.max(pos.peak, segment.width);
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
        const marker = flowMarkers.current.get(path.key);
        if (point == null || marker == null) {
          continue;
        }
        marker.x.setValue(point.x - HEAD_WIDTH / 2);
        marker.y.setValue(point.y - HEAD_HEIGHT / 2);
        marker.deg.setValue(point.deg);
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
      {/* 엣지 조각과 흐르는 화살표는 각자 터치를 막는다. 이 층은 라벨만 호버를 받도록 열어 둔다. */}
      <Animated.View pointerEvents="box-none" style={{ opacity: edgesOpacity }}>
        {placed.paths.flatMap((path) =>
          path.segments.map((segment, segmentIndex) => {
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
                color={runningIncoming ? colors.accent : colors.foregroundMuted}
                thickness={runningIncoming ? 2 : 1}
                dashed={path.dashed}
                // 실행 중 엣지는 선을 따라 흐르는 화살표가 방향을 보여 주므로 도착 지점의
                // 고정 화살촉을 겹쳐 그리지 않는다.
                head={segmentIndex === path.segments.length - 1 && !runningIncoming}
                colors={colors}
                pos={pos}
              />
            );
          }),
        )}
        {placed.paths.map((path) => {
          if (path.label == null) {
            return null;
          }
          const mid = pointAlongSegments(path.segments, 0.5);
          if (mid == null) {
            return null;
          }
          return (
            <EdgeLabelView
              key={`label-${path.key}`}
              text={path.label}
              x={mid.x}
              y={mid.y}
              colors={colors}
              onHover={onLabelHover}
            />
          );
        })}
        {segGhosts.map((ghost) => (
          <EdgeSegmentView
            key={`ghost-${ghost.key}`}
            color={colors.border}
            thickness={1}
            dashed={false}
            head={false}
            colors={colors}
            pos={ghost.pos}
          />
        ))}
      </Animated.View>
      {hasRunning
        ? incoming.map((path) => {
            const marker = flowMarkers.current.get(path.key);
            if (marker == null) {
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
                  width: HEAD_WIDTH,
                  height: HEAD_HEIGHT,
                  zIndex: 2,
                  transform: [
                    { translateX: marker.x },
                    { translateY: marker.y },
                    {
                      rotate: marker.deg.interpolate({
                        inputRange: [-360, 360],
                        outputRange: ["-360deg", "360deg"],
                      }),
                    },
                  ],
                }}
              >
                <View style={arrowHeadStyle(colors)} />
              </Animated.View>
            );
          })
        : null}
      {view.root != null && placed.rootBox != null && !ghostIds.has(view.root.id) ? (
        <NodeBoxView
          mode="root"
          status={view.root.status}
          name={view.root.name}
          labelLines={[]}
          shape="rect"
          width={placed.rootBox.width}
          height={placed.rootBox.height}
          pos={nodePos.current.get(view.root.id)!}
          colors={colors}
          agentId={view.root.id}
          onPress={onNodePress}
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
            shape={node.shape}
            width={box.width}
            height={box.height}
            pos={pos}
            colors={colors}
            agentId={node.agentId}
            onPress={onNodePress}
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
          shape={ghost.shape}
          width={ghost.width}
          height={ghost.height}
          pos={ghost.pos}
          colors={colors}
          agentId={null}
        />
      ))}
    </View>
  );
}
