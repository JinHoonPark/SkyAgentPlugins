import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { Block, Segment, SpikeScreen } from "./kit";
import type { SpikeScreenProps } from "./types";

const APOTHEM = 24;
const HEX_HEIGHT = APOTHEM * 2;
const FLAT_RECT_WIDTH = 72;
const FLAT_TRIANGLE_WIDTH = 17;
/** 정육각형은 회전한 직사각형 세 장의 합집합으로도 만들어진다. 이때 반폭은 2r/√3. */
const ROTATED_RECT_WIDTH = (4 * APOTHEM) / Math.sqrt(3);
const ROTATED_BOX = 58;
const NAMES = ["게이트", "승인 게이트", "검토가 필요한 아주 긴 이름"] as const;

/**
 * 스파이크 8 — SVG 없는 사용자 게이트 육각형과 텍스트.
 * 가안(직사각형+삼각형)과 나안(회전 직사각형 세 장)을 같은 화면에 놓고,
 * 이음매·안쪽 선·이름 길이·축소 구분·선 연결을 본다.
 */
export function Spike08GateHexagon(props: SpikeScreenProps) {
  const { theme, layout } = props;
  const colors = theme.colors;

  return (
    <SpikeScreen
      {...props}
      title="스파이크 8 — 사용자 게이트 육각형과 텍스트"
      hint="가안은 가운데 직사각형 좌우에 삼각형을 붙인 조합이고, 나안은 같은 직사각형 세 장을 0도·60도·120도로 겹친 조합입니다. 삼각형의 바깥 두 변은 배경색으로 칠했습니다(투명 색 문자열을 쓰지 않기 위함)."
    >
      <Block {...props} title="가안 — 직사각형 + 좌우 삼각형">
        <View style={{ flexDirection: "row", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <HexFlat theme={theme} name={NAMES[1]} outline={false} />
          <HexFlat theme={theme} name={NAMES[1]} outline />
        </View>
        <Text style={{ color: colors.foregroundMuted, fontSize: layout.compact ? 10 : 11 }}>
          {"왼쪽은 테두리 없음, 오른쪽은 가운데 직사각형에만 테두리"}
        </Text>
      </Block>

      <Block {...props} title="나안 — 회전한 직사각형 세 장">
        <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
          <HexRotated theme={theme} name={NAMES[1]} outline={false} />
          <HexRotated theme={theme} name={NAMES[1]} outline />
        </View>
        <Text style={{ color: colors.foregroundMuted, fontSize: layout.compact ? 10 : 11 }}>
          {"왼쪽은 채우기만, 오른쪽은 채우기 + 조각마다 테두리"}
        </Text>
      </Block>

      <Block {...props} title="이름 길이 세 가지 — 두 방식 각각">
        {NAMES.map((name) => (
          <View key={name} style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
            <HexFlat theme={theme} name={name} outline />
            <HexRotated theme={theme} name={name} outline />
          </View>
        ))}
      </Block>

      <Block {...props} title="축소 상태 — 일반 사각형과의 구분">
        <View style={{ flexDirection: "row", gap: 18, alignItems: "flex-start" }}>
          <Shrunk theme={theme}>
            <HexFlat theme={theme} name="게이트" outline />
          </Shrunk>
          <Shrunk theme={theme}>
            <HexRotated theme={theme} name="게이트" outline />
          </Shrunk>
          <Shrunk theme={theme}>
            <PlainCard theme={theme} name="작업자" />
          </Shrunk>
        </View>
      </Block>

      <Block {...props} title="선 연결 — 도착 경계를 사각형 상자로 계산했을 때">
        <View style={{ gap: 8 }}>
          <ConnectionCanvas
            theme={theme}
            width={FLAT_RECT_WIDTH + FLAT_TRIANGLE_WIDTH * 2}
            node={<HexFlat theme={theme} name="게이트" outline />}
          />
          <ConnectionCanvas theme={theme} width={ROTATED_BOX} node={<HexRotated theme={theme} name="게이트" outline />} />
        </View>
        <Text style={{ color: colors.foregroundMuted, fontSize: layout.compact ? 10 : 11 }}>
          {"선을 도형 위에 그렸습니다. 선 끝은 육각형을 감싸는 사각형 상자의 경계에서 멈춥니다."}
        </Text>
      </Block>
    </SpikeScreen>
  );
}

/** 가안. 가운데 직사각형 좌우에 위아래 변을 배경색으로 칠한 삼각형을 붙인다. */
function HexFlat({
  theme,
  name,
  outline,
}: {
  theme: SpikeScreenProps["theme"];
  name: string;
  outline: boolean;
}) {
  const colors = theme.colors;
  const fill = colors.surface2;
  const edge = colors.border;

  return (
    <View style={{ flexDirection: "row", width: FLAT_RECT_WIDTH + FLAT_TRIANGLE_WIDTH * 2, height: HEX_HEIGHT }}>
      <View
        style={{
          width: 0,
          height: 0,
          borderRightWidth: FLAT_TRIANGLE_WIDTH,
          borderTopWidth: HEX_HEIGHT / 2,
          borderBottomWidth: HEX_HEIGHT / 2,
          borderRightColor: fill,
          borderTopColor: colors.surface0,
          borderBottomColor: colors.surface0,
        }}
      />
      <View
        style={{
          width: FLAT_RECT_WIDTH,
          height: HEX_HEIGHT,
          backgroundColor: fill,
          borderColor: edge,
          borderWidth: outline ? 1 : 0,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: colors.foreground, fontSize: 10, lineHeight: 13, textAlign: "center", paddingHorizontal: 4 }}>
          {name}
        </Text>
      </View>
      <View
        style={{
          width: 0,
          height: 0,
          borderLeftWidth: FLAT_TRIANGLE_WIDTH,
          borderTopWidth: HEX_HEIGHT / 2,
          borderBottomWidth: HEX_HEIGHT / 2,
          borderLeftColor: fill,
          borderTopColor: colors.surface0,
          borderBottomColor: colors.surface0,
        }}
      />
    </View>
  );
}

/** 나안. 같은 직사각형 세 장을 0도·60도·120도로 겹친다. */
function HexRotated({
  theme,
  name,
  outline,
}: {
  theme: SpikeScreenProps["theme"];
  name: string;
  outline: boolean;
}) {
  const colors = theme.colors;
  const left = (ROTATED_BOX - ROTATED_RECT_WIDTH) / 2;
  const top = (ROTATED_BOX - HEX_HEIGHT) / 2;

  return (
    <View style={{ width: ROTATED_BOX, height: ROTATED_BOX, alignItems: "center", justifyContent: "center" }}>
      {[0, 60, 120].map((deg) => (
        <View
          key={String(deg)}
          style={{
            position: "absolute",
            left,
            top,
            width: ROTATED_RECT_WIDTH,
            height: HEX_HEIGHT,
            backgroundColor: colors.surface2,
            borderColor: colors.border,
            borderWidth: outline ? 1 : 0,
            transform: [{ rotate: String(deg) + "deg" }],
          }}
        />
      ))}
      <Text style={{ color: colors.foreground, fontSize: 10, lineHeight: 13, textAlign: "center", paddingHorizontal: 3 }}>
        {name}
      </Text>
    </View>
  );
}

function PlainCard({ theme, name }: { theme: SpikeScreenProps["theme"]; name: string }) {
  return (
    <View
      style={{
        width: FLAT_RECT_WIDTH,
        height: HEX_HEIGHT,
        backgroundColor: theme.colors.surface2,
        borderColor: theme.colors.border,
        borderWidth: 1,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 10, lineHeight: 13 }}>{name}</Text>
    </View>
  );
}

function Shrunk({ theme, children }: { theme: SpikeScreenProps["theme"]; children: ReactNode }) {
  return (
    <View
      style={{
        width: 120 * 0.5,
        height: 60 * 0.5,
        transform: [{ scale: 0.5 }],
        transformOrigin: "0 0",
        alignItems: "flex-start",
        justifyContent: "center",
        backgroundColor: theme.colors.surface0,
      }}
    >
      {children}
    </View>
  );
}

const CONNECTION_WIDTH = 250;
const CONNECTION_HEIGHT = 150;
const SHAPE_LEFT = 120;
const SHAPE_TOP = 50;

function ConnectionCanvas({
  theme,
  width,
  node,
}: {
  theme: SpikeScreenProps["theme"];
  width: number;
  node: ReactNode;
}) {
  const colors = theme.colors;
  const box = { left: SHAPE_LEFT, top: SHAPE_TOP, right: SHAPE_LEFT + width, bottom: SHAPE_TOP + HEX_HEIGHT };

  const sources = [
    { x: 12, y: 14 },
    { x: 12, y: 72 },
    { x: 12, y: 128 },
  ];

  return (
    <View style={{ width: CONNECTION_WIDTH, height: CONNECTION_HEIGHT, backgroundColor: colors.surface0 }}>
      <View style={{ position: "absolute", left: SHAPE_LEFT, top: SHAPE_TOP }}>{node}</View>
      {sources.map((source, index) => {
        const entry = boxEntry(source, { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 }, box);
        return (
          <Segment
            key={String(index)}
            x1={source.x + 30}
            y1={source.y}
            x2={entry.x}
            y2={entry.y}
            color={colors.accent}
            thickness={2}
          />
        );
      })}
      {sources.map((source, index) => (
        <View
          key={String(index)}
          style={{
            position: "absolute",
            left: source.x,
            top: source.y - 9,
            width: 30,
            height: 18,
            backgroundColor: colors.surface2,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: 3,
          }}
        />
      ))}
    </View>
  );
}

function boxEntry(
  from: { x: number; y: number },
  center: { x: number; y: number },
  box: { left: number; top: number; right: number; bottom: number },
) {
  const dx = center.x - from.x;
  const dy = center.y - from.y;
  let t = 1;
  if (Math.abs(dx) > 1e-6) {
    t = Math.min(t, ((dx > 0 ? box.left : box.right) - from.x) / dx);
  }
  if (Math.abs(dy) > 1e-6) {
    t = Math.min(t, ((dy > 0 ? box.top : box.bottom) - from.y) / dy);
  }
  return { x: from.x + dx * t, y: from.y + dy * t };
}
