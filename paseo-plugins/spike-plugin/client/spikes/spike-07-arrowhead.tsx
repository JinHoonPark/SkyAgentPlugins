import { useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { Segment, SpikeScreen } from "./kit";
import type { SpikeScreenProps } from "./types";

const ANGLES = [0, 45, 90, 135, 180, 270] as const;

const CELL = 104;
const CENTER = CELL / 2;
const TARGET_DISTANCE = 40;
const HALF = 10;

type ArrowKind = "border-triangle" | "rotated-chevron" | "text-glyph";

const KINDS: ReadonlyArray<{ readonly key: ArrowKind; readonly label: string }> = [
  { key: "border-triangle", label: "가. 테두리 삼각형" },
  { key: "rotated-chevron", label: "나. 45도 회전 꺾쇠" },
  { key: "text-glyph", label: "다. 글리프 ▶" },
];

/**
 * 스파이크 7 — View 기반 화살촉.
 * 여섯 각도마다 세 방안을 나란히 놓고, 선 굵기와 화살촉 색을 바꿔가며 본다.
 * 화살촉은 선의 방향과 같은 각도로 돌려 도착 카드 경계에 꼭짓점을 맞춘다.
 */
export function Spike07Arrowhead(props: SpikeScreenProps) {
  const { theme, layout } = props;
  const colors = theme.colors;
  const [thickness, setThickness] = useState<1 | 2>(1);
  const [accentHead, setAccentHead] = useState(false);

  const lineColor = colors.border;
  const headColor = accentHead ? colors.accent : colors.border;

  return (
    <SpikeScreen
      {...props}
      title="스파이크 7 — View 기반 화살촉"
      hint="각 칸은 왼쪽 가운데의 출발 카드에서 여섯 방향으로 뻗는 선 하나입니다. 화살촉 꼭짓점이 도착 카드 경계에 닿는지, 선 방향을 가리키는지, 카드 글자를 덮는지 보세요. 가안은 투명 테두리 대신 배경색 테두리를 씁니다(투명 색 문자열을 쓰지 않기 위함)."
    >
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Toggle
          theme={theme}
          layout={layout}
          label="선 굵기"
          options={[
            { label: "1px", on: thickness === 1, set: () => setThickness(1) },
            { label: "2px", on: thickness === 2, set: () => setThickness(2) },
          ]}
        />
        <Toggle
          theme={theme}
          layout={layout}
          label="화살촉 색"
          options={[
            { label: "선과 같게", on: !accentHead, set: () => setAccentHead(false) },
            { label: "accent", on: accentHead, set: () => setAccentHead(true) },
          ]}
        />
      </View>

      {ANGLES.map((angle) => (
        <View key={String(angle)} style={{ gap: 6 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: layout.compact ? 11 : 12, fontWeight: "600" }}>
            {String(angle) + "도"}
          </Text>
          <View style={{ flexDirection: "row", gap: 6 }}>
            {KINDS.map((kind) => (
              <View key={kind.key} style={{ gap: 4 }}>
                <Text style={{ color: colors.foregroundMuted, fontSize: 10 }}>{kind.label}</Text>
                <View style={{ width: CELL, height: CELL, backgroundColor: colors.surface0 }}>
                  <ArrowCell
                    theme={theme}
                    angle={angle}
                    kind={kind.key}
                    lineColor={lineColor}
                    headColor={headColor}
                    thickness={thickness}
                  />
                </View>
              </View>
            ))}
          </View>
        </View>
      ))}
    </SpikeScreen>
  );
}

function ArrowCell({
  theme,
  angle,
  kind,
  lineColor,
  headColor,
  thickness,
}: {
  theme: SpikeScreenProps["theme"];
  angle: number;
  kind: ArrowKind;
  lineColor: string;
  headColor: string;
  thickness: number;
}) {
  const colors = theme.colors;
  const radians = (angle * Math.PI) / 180;
  const ux = Math.cos(radians);
  const uy = Math.sin(radians);

  const targetLeft = CENTER + ux * TARGET_DISTANCE - HALF;
  const targetTop = CENTER + uy * TARGET_DISTANCE - HALF;

  // 선이 도착 카드 사각형과 만나는 지점. 이 자리에 화살촉 꼭짓점을 맞춘다.
  const hit = Math.min(
    Math.abs(ux) < 1e-6 ? Number.POSITIVE_INFINITY : HALF / Math.abs(ux),
    Math.abs(uy) < 1e-6 ? Number.POSITIVE_INFINITY : HALF / Math.abs(uy),
  );
  const boundaryX = CENTER + ux * (TARGET_DISTANCE - hit);
  const boundaryY = CENTER + uy * (TARGET_DISTANCE - hit);

  const shape = shapeOf(kind, headColor, colors.surface0, colors.surface2, thickness);

  return (
    <View style={{ position: "absolute", left: 0, top: 0, width: CELL, height: CELL }}>
      <Segment
        x1={CENTER}
        y1={CENTER}
        x2={boundaryX}
        y2={boundaryY}
        color={lineColor}
        thickness={thickness}
      />
      <View
        style={{
          position: "absolute",
          left: boundaryX - ux * shape.apexOffset - shape.width / 2,
          top: boundaryY - uy * shape.apexOffset - shape.height / 2,
          width: shape.width,
          height: shape.height,
          transform: [{ rotate: angle + "deg" }],
        }}
      >
        {shape.node}
      </View>
      <View
        style={{
          position: "absolute",
          left: CENTER - 14,
          top: CENTER - 11,
          width: 28,
          height: 22,
          backgroundColor: colors.surface2,
          borderColor: colors.border,
          borderWidth: 1,
          borderRadius: 4,
        }}
      />
      <View
        style={{
          position: "absolute",
          left: targetLeft,
          top: targetTop,
          width: HALF * 2,
          height: HALF * 2,
          backgroundColor: colors.surface2,
          borderColor: colors.border,
          borderWidth: 1,
          borderRadius: 3,
        }}
      />
    </View>
  );
}

interface ShapeSpec {
  readonly width: number;
  readonly height: number;
  /** 래퍼 중심에서 꼭짓점까지의 거리. 이 값으로 경계에 꼭짓점을 맞춘다. */
  readonly apexOffset: number;
  readonly node: ReactElement;
}

function shapeOf(
  kind: ArrowKind,
  headColor: string,
  canvasColor: string,
  diagnosticColor: string,
  thickness: number,
): ShapeSpec {
  if (kind === "border-triangle") {
    const width = 9;
    const height = Math.max(8, thickness * 5);
    return {
      width,
      height,
      apexOffset: width,
      node: (
        <View
          style={{
            width: 0,
            height: 0,
            borderLeftWidth: width,
            borderTopWidth: height / 2,
            borderBottomWidth: height / 2,
            borderLeftColor: headColor,
            borderTopColor: canvasColor,
            borderBottomColor: canvasColor,
          }}
        />
      ),
    };
  }

  if (kind === "rotated-chevron") {
    const size = Math.max(12, thickness * 6);
    return {
      width: size,
      height: size,
      apexOffset: size * Math.SQRT1_2,
      node: (
        <View
          style={{
            width: size,
            height: size,
            borderTopWidth: thickness,
            borderRightWidth: thickness,
            borderColor: headColor,
            transform: [{ rotate: "45deg" }],
          }}
        />
      ),
    };
  }

  const size = 16;
  return {
    width: size,
    height: size,
    apexOffset: size / 2,
    node: (
      <View
        style={{
          width: size,
          height: size,
          alignItems: "center",
          justifyContent: "center",
          // 글리프가 상자 안에서 어디에 앉는지 확인하기 위한 진단용 배경.
          backgroundColor: diagnosticColor,
        }}
      >
        <Text style={{ color: headColor, fontSize: 12, lineHeight: 14 }}>{"▶"}</Text>
      </View>
    ),
  };
}

function Toggle({
  theme,
  layout,
  label,
  options,
}: {
  theme: SpikeScreenProps["theme"];
  layout: SpikeScreenProps["layout"];
  label: string;
  options: ReadonlyArray<{ label: string; on: boolean; set: () => void }>;
}) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: layout.compact ? 10 : 11 }}>{label}</Text>
      <View style={{ flexDirection: "row", gap: 6 }}>
        {options.map((option) => (
          <Pressable
            key={option.label}
            onPress={option.set}
            accessibilityRole="button"
            style={{
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: option.on ? theme.colors.accent : theme.colors.border,
              backgroundColor: option.on ? theme.colors.accent : theme.colors.surface2,
            }}
          >
            <Text
              style={{
                color: option.on ? theme.colors.accentForeground : theme.colors.foreground,
                fontSize: 11,
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
