import { useRef, useState } from "react";
import { Animated, PanResponder, Pressable, Text, View } from "react-native";
import { Block, Segment, SpikeScreen, rotateOf } from "./kit";
import type { SpikeGuide, SpikeScreenProps } from "./types";

const CELL = 100;
const DASH = 8;
const GAP = 6;
/** 축소 상태를 보는 배율. 스파이크 8과 같은 0.5배를 쓴다. */
const SHRINK = 0.5;

interface Shape {
  readonly label: string;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

const SHAPES: readonly Shape[] = [
  { label: "짧은 선", x1: 40, y1: 50, x2: 70, y2: 50 },
  { label: "긴 선", x1: 2, y1: 50, x2: 98, y2: 50 },
  { label: "수평 선", x1: 10, y1: 50, x2: 90, y2: 50 },
  { label: "비스듬한 선", x1: 10, y1: 90, x2: 66.6, y2: 33.4 },
  { label: "수직 선", x1: 50, y1: 10, x2: 50, y2: 90 },
];

type Variant = "solid" | "border-dashed" | "pieces";

const VARIANTS: ReadonlyArray<{ readonly key: Variant; readonly label: string }> = [
  { key: "solid", label: "실선 (기준)" },
  { key: "border-dashed", label: "가. borderStyle dashed" },
  { key: "pieces", label: "나. 조각 View" },
];

const GUIDE: SpikeGuide = {
  question:
    "borderStyle dashed와 조각 View 중 하나가 실선과 한눈에 구분되는가. 네 가지 선 모양 모두에서 점선으로 보이고, 조각 방식이 이동 조작을 무겁게 만들지 않는가.",
  how:
    "각 줄의 실선·가안·나안을 나란히 비교해 점선이 실제로 그려지는지, 각도에 따라 사라지지 않는지, 선 양 끝이 조각 중간에서 끊기지 않는지 본다. 축소 상태 블록에서 같은 선을 0.5배로 줄여 실선과 점선이 여전히 구분되는지 본다. 8개/32개 버튼으로 점선 엣지 수를 바꾸고 아래 캔버스를 손으로 끌어 옮기며 조각들이 한 직선 위에 남는지, 끊김이나 잔상이 생기는지 본다. 늘어난 조각 View 개수는 캔버스 위 문구에 있다.",
  pass:
    "통과 — 두 방안 중 하나가 네 모양 모두에서 점선으로 보이고, 축소 상태에서도 실선 엣지와 구분되며, 전체 엣지를 점선으로 바꿔도 끌어 옮기는 동안 끊김이 없다. 중단 — 조각 수가 이동을 무겁게 만들면 조각 방식을 버린다. 가안이 실선으로 렌더되거나 각도에 따라 점선이 사라지면 불성립이다. 같은 구분을 선 색을 연하게 하거나 선을 얇게 해 내는 방안으로 후퇴하고도 일반 엣지와 구분되지 않으면 점선 엣지의 의미를 다른 표현으로 옮길지를 스펙 소유자에게 올린다.",
};

/**
 * 스파이크 9 — 회전된 View 기반 점선 엣지.
 * 네 가지 선 모양마다 실선·가안·나안을 나란히 놓고, 조각 방식의 View 증가량을 함께 센다.
 */
export function Spike09DashedEdge(props: SpikeScreenProps) {
  const { theme, layout } = props;
  const colors = theme.colors;
  const [dense, setDense] = useState(false);
  const thickness = 2;

  return (
    <SpikeScreen
      {...props}
      title="스파이크 9 — 점선 엣지"
      hint="각 줄은 같은 길이·같은 각도의 선 세 개입니다. 조각 방식은 조각 길이 8px, 간격 6px로 고정했습니다. 선 양 끝이 조각 중간에서 끊기는지도 함께 보세요."
      guide={GUIDE}
    >
      <Block {...props} title="비교하는 세 표현">
        <Text style={{ color: colors.foregroundMuted, fontSize: layout.compact ? 10 : 11, lineHeight: layout.compact ? 14 : 15 }}>
          {"기준 — 지금 쓰는 실선 엣지 한 줄(회전한 View 하나)."}
        </Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: layout.compact ? 10 : 11, lineHeight: layout.compact ? 14 : 15 }}>
          {"가 — 선 View에 borderStyle \"dashed\"를 준 것. 대시 길이·간격을 정할 수단이 없고 플랫폼에 따라 무시될 수 있다."}
        </Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: layout.compact ? 10 : 11, lineHeight: layout.compact ? 14 : 15 }}>
          {"나 — 선 한 줄을 짧은 조각 View 여러 개로 쪼개 간격을 둔 것. 선 길이에 비례해 View 개수가 늘어난다."}
        </Text>
      </Block>

      {SHAPES.map((shape) => (
        <View key={shape.label} style={{ gap: 6 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: layout.compact ? 11 : 12, fontWeight: "600" }}>
            {shape.label + " (" + String(Math.round(rotateOf(shape.x1, shape.y1, shape.x2, shape.y2).length)) + "px)"}
          </Text>
          <View style={{ flexDirection: "row", gap: 6 }}>
            {VARIANTS.map((variant) => (
              <View key={variant.key} style={{ gap: 4 }}>
                <Text style={{ color: colors.foregroundMuted, fontSize: 10 }}>{variant.label}</Text>
                <View style={{ width: CELL, height: CELL, backgroundColor: colors.surface0 }}>
                  <Edge
                    x1={shape.x1}
                    y1={shape.y1}
                    x2={shape.x2}
                    y2={shape.y2}
                    color={colors.border}
                    thickness={thickness}
                    variant={variant.key}
                  />
                </View>
              </View>
            ))}
          </View>
        </View>
      ))}

      <Block
        {...props}
        title="축소 상태 — 실선과 점선의 구분"
        note="같은 선을 0.5배로 줄여 나란히 놓았습니다. 축소한 상태에서도 가안·나안이 실선 엣지와 구분되는지 봅니다."
      >
        {SHAPES.map((shape) => (
          <View key={shape.label} style={{ gap: 4 }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: layout.compact ? 11 : 12, fontWeight: "600" }}>
              {shape.label}
            </Text>
            <View style={{ flexDirection: "row", gap: 6 }}>
              {VARIANTS.map((variant) => (
                <View key={variant.key} style={{ gap: 4 }}>
                  <Text style={{ color: colors.foregroundMuted, fontSize: 10 }}>{variant.label}</Text>
                  <View
                    style={{
                      width: CELL * SHRINK,
                      height: CELL * SHRINK,
                      transform: [{ scale: SHRINK }],
                      transformOrigin: "0 0",
                    }}
                  >
                    <View style={{ width: CELL, height: CELL, backgroundColor: colors.surface0 }}>
                      <Edge
                        x1={shape.x1}
                        y1={shape.y1}
                        x2={shape.x2}
                        y2={shape.y2}
                        color={colors.border}
                        thickness={thickness}
                        variant={variant.key}
                      />
                    </View>
                  </View>
                </View>
              ))}
            </View>
          </View>
        ))}
      </Block>

      <View style={{ gap: 6 }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: layout.compact ? 11 : 12, fontWeight: "600" }}>
          {"조각 방식의 View 증가량 — 엣지 " + String(dense ? 32 : 8) + "개"}
        </Text>
        <View style={{ flexDirection: "row", gap: 6 }}>
          {[8, 32].map((count) => (
            <Pressable
              key={String(count)}
              onPress={() => setDense(count === 32)}
              accessibilityRole="button"
              style={{
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: (count === 32) === dense ? colors.accent : colors.border,
                backgroundColor: (count === 32) === dense ? colors.accent : colors.surface2,
              }}
            >
              <Text
                style={{
                  color: (count === 32) === dense ? colors.accentForeground : colors.foreground,
                  fontSize: 11,
                }}
              >
                {String(count) + "개"}
              </Text>
            </Pressable>
          ))}
        </View>
        <DensityCanvas theme={theme} count={dense ? 32 : 8} />
      </View>
    </SpikeScreen>
  );
}

interface EdgeProps {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly color: string;
  readonly thickness: number;
  readonly variant: Variant;
}

/** 세 가지 표현을 같은 좌표계에서 그린다. */
function Edge({ x1, y1, x2, y2, color, thickness, variant }: EdgeProps) {
  const { length, deg } = rotateOf(x1, y1, x2, y2);

  if (variant === "solid") {
    return <Segment x1={x1} y1={y1} x2={x2} y2={y2} color={color} thickness={thickness} />;
  }

  if (variant === "border-dashed") {
    return (
      <View
        style={{
          position: "absolute",
          left: x1,
          top: y1,
          width: length,
          height: 0,
          borderTopWidth: thickness,
          borderStyle: "dashed",
          borderTopColor: color,
          transform: [{ rotate: deg + "deg" }],
          transformOrigin: "0 50%",
        }}
      />
    );
  }

  return (
    <View
      style={{
        position: "absolute",
        left: x1,
        top: y1 - thickness / 2,
        width: length,
        height: thickness,
        transform: [{ rotate: deg + "deg" }],
        transformOrigin: "0 50%",
      }}
    >
      {piecesOf(length, DASH, GAP).map((piece, index) => (
        <View
          key={String(index)}
          style={{
            position: "absolute",
            left: piece.left,
            top: 0,
            width: piece.width,
            height: thickness,
            backgroundColor: color,
          }}
        />
      ))}
    </View>
  );
}

function piecesOf(length: number, dash: number, gap: number) {
  const pieces: Array<{ left: number; width: number }> = [];
  for (let left = 0; left < length; left += dash + gap) {
    pieces.push({ left, width: Math.min(dash, length - left) });
  }
  return pieces;
}

const DENSITY_WIDTH = 312;
const DENSITY_HEIGHT = 180;

function DensityCanvas({ theme, count }: { theme: SpikeScreenProps["theme"]; count: number }) {
  const colors = theme.colors;
  const spacing = DENSITY_HEIGHT / count;
  const cardHeight = Math.max(4, Math.min(18, spacing - 3));
  const thickness = 2;
  const rows = Array.from({ length: count }, (_, index) => index);
  const totalPieces = rows.reduce((sum, index) => {
    const from = { x: 58, y: index * spacing + spacing / 2 };
    const to = { x: 254, y: (count - 1 - index) * spacing + spacing / 2 };
    return sum + piecesOf(rotateOf(from.x, from.y, to.x, to.y).length, DASH, GAP).length;
  }, 0);

  // 끌기 전까지 누적된 이동량과 이번 끌기의 시작점. 이동 중에는 Animated.Value만 갱신해 재렌더 없이 옮긴다.
  const pan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const dragged = useRef({ x: 0, y: 0 });
  const start = useRef({ x: 0, y: 0 });
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        start.current = { x: dragged.current.x, y: dragged.current.y };
      },
      onPanResponderMove: (_event, gesture) => {
        pan.setValue({ x: start.current.x + gesture.dx, y: start.current.y + gesture.dy });
      },
      onPanResponderRelease: (_event, gesture) => {
        dragged.current = { x: start.current.x + gesture.dx, y: start.current.y + gesture.dy };
      },
      onPanResponderTerminate: () => {
        pan.setValue({ x: dragged.current.x, y: dragged.current.y });
      },
    }),
  ).current;

  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 10 }}>
        {"엣지 " + String(count) + "개 → 조각 View " + String(totalPieces) + "개 (실선이면 " + String(count) + "개)"}
      </Text>
      <View style={{ width: DENSITY_WIDTH, height: DENSITY_HEIGHT, backgroundColor: colors.surface0, overflow: "hidden" }}>
        <Animated.View
          {...panResponder.panHandlers}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: DENSITY_WIDTH,
            height: DENSITY_HEIGHT,
            transform: [{ translateX: pan.x }, { translateY: pan.y }],
          }}
        >
          {rows.map((index) => {
            const y1 = index * spacing + spacing / 2;
            const y2 = (count - 1 - index) * spacing + spacing / 2;
            return (
              <Edge
                key={String(index)}
                x1={58}
                y1={y1}
                x2={254}
                y2={y2}
                color={colors.border}
                thickness={thickness}
                variant="pieces"
              />
            );
          })}
          {rows.map((index) => (
            <View
              key={"left-" + String(index)}
              style={{
                position: "absolute",
                left: 6,
                top: index * spacing + spacing / 2 - cardHeight / 2,
                width: 46,
                height: cardHeight,
                backgroundColor: colors.surface2,
                borderColor: colors.border,
                borderWidth: 1,
                borderRadius: 3,
              }}
            />
          ))}
          {rows.map((index) => (
            <View
              key={"right-" + String(index)}
              style={{
                position: "absolute",
                left: 260,
                top: index * spacing + spacing / 2 - cardHeight / 2,
                width: 46,
                height: cardHeight,
                backgroundColor: colors.surface2,
                borderColor: colors.border,
                borderWidth: 1,
                borderRadius: 3,
              }}
            />
          ))}
        </Animated.View>
      </View>
      <Text style={{ color: colors.foregroundMuted, fontSize: 10, lineHeight: 15 }}>
        캔버스 안 그래프를 손으로 끌어 옮길 수 있습니다. 끌면서 조각들이 한 직선 위에 남는지, 끊김·잔상이 보이는지 확인하세요.
      </Text>
    </View>
  );
}
