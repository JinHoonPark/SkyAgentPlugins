import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { Canvas, Segment, SpikeScreen } from "./kit";
import type { SpikeGuide, SpikeScreenProps } from "./types";

const ANGLES = [0, 45, 90, 135, 180, 270] as const;

/** 판 한 칸의 크기. 두 카드와 글로우가 안에 들어가고 그 사이 선은 길게 남을 만큼 잡는다. */
const CELL = 156;
const CENTER = CELL / 2;
/** 출발 카드 중심에서 도착 카드 중심까지의 거리. */
const TARGET_DISTANCE = 58;
/** 도착 카드의 반폭·반높이. */
const HALF = 10;
/** 출발 카드 크기. 선의 시작점을 가리는 자리 표시다. */
const SOURCE_WIDTH = 18;
const SOURCE_HEIGHT = 14;

/** 화살촉(가안 삼각형 상자)의 크기. 꼭짓점은 이 상자의 오른쪽 중앙이다. */
const HEAD_WIDTH = 9;
const HEAD_HEIGHT = 8;
/** 래퍼 중심에서 꼭짓점까지의 거리. 상자 중심에서 오른쪽 변까지다. */
const HEAD_APEX_OFFSET = HEAD_WIDTH / 2;
const LINE_THICKNESS = 1;
/** 실행 중 도착 카드에 두르는 accent 글로우의 번짐 반경. */
const GLOW_BLUR = 14;

const LEFT_LABEL = "도착 노드 평상시";
const RIGHT_LABEL = "도착 노드 실행 중 — accent 글로우";

const GUIDE: SpikeGuide = {
  question:
    "가안(테두리 삼각형) 화살촉의 꼭짓점이 선이 도착 카드 경계와 만나는 지점에 놓이는가. 여섯 각도에서 화살촉이 선 방향과 같은 방향을 가리키고 카드 글자를 가리지 않는가. 그리고 도착 카드에 실행 중 accent 글로우가 깔렸을 때 그 위에서도 화살촉이 구분되는가.",
  how:
    "한 줄이 한 각도이고, 그 줄의 왼쪽 칸은 라벨 「" +
    LEFT_LABEL +
    "」, 오른쪽 칸은 「" +
    RIGHT_LABEL +
    "」다. 카드 사이 선이 화살촉보다 훨씬 길게 나오므로, 각 칸에서 화살촉 꼭짓점이 도착 카드 테두리에 닿아 있는지, 꼭짓점이 카드 안쪽으로 들어가거나 선 끝에서 떨어져 있지 않은지, 선이 향하는 쪽과 꼭짓점이 향하는 쪽이 같은지 본다. 여섯 각도를 세로로 훑으면서 같은 어긋남이 반복되는지도 본다.",
  pass:
    "통과 — 여섯 각도 모두 꼭짓점이 도착 카드 경계에 닿고 방향이 선과 일치하며 카드 글자를 가리지 않고, 글로우가 깔린 카드에서도 화살촉이 배경에 묻히지 않고 구분된다. 중단 — 가안이 렌더되지 않으면 즉시 버린다(테두리 색 처리에 의존해 조정 여지가 없다). 화살촉으로 방향이 읽히지 않으면 선 끝 쪽 일정 구간만 두껍게 하거나 색을 진하게 하는 방향으로 후퇴하고, 그것도 안 되면 화살촉을 빼고 방향 표시를 다른 수단으로 낼지를 스펙 소유자에게 올린다.",
};

/**
 * 스파이크 7 — View 기반 화살촉.
 * 가안(테두리 삼각형) 하나만, 선 1px·화살촉 accent 고정으로 여섯 각도를 그린다.
 * 각 각도마다 도착 카드가 평상시인 칸과 실행 중 글로우가 깔린 칸을 나란히 놓는다.
 */
export function Spike07Arrowhead(props: SpikeScreenProps) {
  const { theme, layout } = props;
  const colors = theme.colors;
  const labelStyle = {
    width: CELL,
    color: colors.foregroundMuted,
    fontSize: 10,
    lineHeight: 13,
  } as const;

  return (
    <SpikeScreen
      {...props}
      title="스파이크 7 — View 기반 화살촉"
      hint="방안은 가안(테두리 삼각형)으로 정해졌고, 선은 1px·화살촉은 accent로 고정했습니다. 한 줄이 한 각도이고, 왼쪽 칸은 「도착 노드 평상시」, 오른쪽 칸은 「도착 노드 실행 중 — accent 글로우」입니다. 각 칸 아래 라벨이 그 칸이 무엇인지 적습니다. 화살촉 꼭짓점이 도착 카드 테두리에 닿는지, 꼭짓점이 선 방향을 가리키는지, 글로우 위에서도 화살촉이 보이는지 보세요."
      guide={GUIDE}
    >
      {ANGLES.map((angle) => (
        <View key={String(angle)} style={{ gap: 4 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: layout.compact ? 11 : 12, fontWeight: "600" }}>
            {String(angle) + "도"}
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <LabelledPanel theme={theme} label={LEFT_LABEL} style={labelStyle}>
              <ArrowCell theme={theme} angle={angle} glow={false} />
            </LabelledPanel>
            <LabelledPanel theme={theme} label={RIGHT_LABEL} style={labelStyle}>
              <ArrowCell theme={theme} angle={angle} glow />
            </LabelledPanel>
          </View>
        </View>
      ))}
    </SpikeScreen>
  );
}

/** 판 하나와 그 판이 무엇인지 적는 라벨. 두 칸이 각각 무엇인지 줄마다 보이게 한다. */
function LabelledPanel({
  theme,
  label,
  style,
  children,
}: {
  theme: SpikeScreenProps["theme"];
  label: string;
  style: { readonly width: number; readonly color: string; readonly fontSize: number; readonly lineHeight: number };
  children: ReactNode;
}) {
  return (
    <View style={{ gap: 3 }}>
      <Canvas theme={theme} width={CELL} height={CELL}>
        {children}
      </Canvas>
      <Text style={style}>{label}</Text>
    </View>
  );
}

function ArrowCell({
  theme,
  angle,
  glow,
}: {
  theme: SpikeScreenProps["theme"];
  angle: number;
  glow: boolean;
}) {
  const colors = theme.colors;
  const radians = (angle * Math.PI) / 180;
  const ux = Math.cos(radians);
  const uy = Math.sin(radians);

  const targetLeft = CENTER + ux * TARGET_DISTANCE - HALF;
  const targetTop = CENTER + uy * TARGET_DISTANCE - HALF;

  // 선이 도착 카드 사각형 경계와 만나는 지점. 화살촉 꼭짓점을 이 자리에 맞춘다.
  const hit = Math.min(
    Math.abs(ux) < 1e-6 ? Number.POSITIVE_INFINITY : HALF / Math.abs(ux),
    Math.abs(uy) < 1e-6 ? Number.POSITIVE_INFINITY : HALF / Math.abs(uy),
  );
  const apexX = CENTER + ux * (TARGET_DISTANCE - hit);
  const apexY = CENTER + uy * (TARGET_DISTANCE - hit);

  return (
    <>
      {/* 도착 카드를 먼저 그린다. 실행 중이면 그 글로우가 선과 화살촉 아래에 깔린다. */}
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
          boxShadow: glow ? glowShadow(colors.accent) : undefined,
        }}
      />
      <Segment
        x1={CENTER}
        y1={CENTER}
        x2={apexX}
        y2={apexY}
        color={colors.border}
        thickness={LINE_THICKNESS}
      />
      <View
        style={{
          position: "absolute",
          left: CENTER - SOURCE_WIDTH / 2,
          top: CENTER - SOURCE_HEIGHT / 2,
          width: SOURCE_WIDTH,
          height: SOURCE_HEIGHT,
          backgroundColor: colors.surface2,
          borderColor: colors.border,
          borderWidth: 1,
          borderRadius: 4,
        }}
      />
      <View
        style={{
          position: "absolute",
          left: apexX - ux * HEAD_APEX_OFFSET - HEAD_WIDTH / 2,
          top: apexY - uy * HEAD_APEX_OFFSET - HEAD_HEIGHT / 2,
          width: HEAD_WIDTH,
          height: HEAD_HEIGHT,
          transform: [{ rotate: angle + "deg" }],
        }}
      >
        {/* 보이지 않아야 할 두 변은 이 칸의 배경색으로 칠한다(투명 색 문자열을 쓰지 않기 위함). */}
        <View
          style={{
            width: 0,
            height: 0,
            borderLeftWidth: HEAD_WIDTH,
            borderTopWidth: HEAD_HEIGHT / 2,
            borderBottomWidth: HEAD_HEIGHT / 2,
            borderLeftColor: colors.accent,
            borderTopColor: colors.surface0,
            borderBottomColor: colors.surface0,
          }}
        />
      </View>
    </>
  );
}

/**
 * 실행 중 카드에 깔리는 accent 글로우.
 * 그림자 객체 배열로 준다 — 이 호스트가 실제로 그리는 형식이며, 캔버스가 실행 중 카드에
 * 쓰는 형식(`paseo-plugins/orchestration-graph/client/motion-logic.ts:93-95`, 그림자 객체 배열)과 같다.
 * CSS 문자열로 주면 이 호스트는 단위 없는 길이를 그대로 넘겨 받아 그리지 않는다.
 */
function glowShadow(accent: string) {
  return [{ offsetX: 0, offsetY: 0, blurRadius: GLOW_BLUR, color: accent }];
}
