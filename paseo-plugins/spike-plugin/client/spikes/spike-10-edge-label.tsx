import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Block, SpikeScreen, rotateOf } from "./kit";
import type { SpikeGuide, SpikeScreenProps } from "./types";

const PANEL_WIDTH = 300;
const PANEL_HEIGHT = 150;
const CARD_WIDTH = 30;
const CARD_HEIGHT = 20;
/** 축소 상태를 보는 배율. 스파이크 8과 같은 0.5배를 쓴다. */
const SHRINK = 0.5;

interface Case {
  readonly label: string;
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
}

/** 좌표는 rotateOf가 내는 각도(atan2(dy, dx))가 표시값과 정확히 같도록 잡았다. */
const ANGLES: readonly Case[] = [
  { label: "0도", ax: 30, ay: 75, bx: 270, by: 75 },
  { label: "45도", ax: 70, ay: 25, bx: 180, by: 135 },
  { label: "90도", ax: 150, ay: 24, bx: 150, by: 126 },
  { label: "135도", ax: 230, ay: 25, bx: 120, by: 135 },
];

const LENGTHS: readonly Case[] = [
  { label: "두 자", ax: 30, ay: 75, bx: 270, by: 75 },
  { label: "다섯 자", ax: 30, ay: 75, bx: 270, by: 75 },
  { label: "열 자", ax: 30, ay: 75, bx: 270, by: 75 },
];

const NAMES = ["승인", "승인 대기", "승인 대기 중입니다"] as const;

/** 축소 상태에서 볼 사례. 글자 수 세 가지와 비스듬한 각도 하나. */
const SHRUNK_CASES: ReadonlyArray<{ readonly label: string; readonly geom: Case; readonly text: string }> = [
  { label: "0도 · 두 자", geom: LENGTHS[0], text: NAMES[0] },
  { label: "0도 · 다섯 자", geom: LENGTHS[1], text: NAMES[1] },
  { label: "0도 · 열 자", geom: LENGTHS[2], text: NAMES[2] },
  { label: "45도 · 열 자", geom: ANGLES[1], text: NAMES[2] },
];

const GUIDE: SpikeGuide = {
  question:
    "라벨을 선의 자식으로 두면 글자가 선과 함께 기울고, 선과 형제인 절대 좌표로 선 중점에 놓으면 수평을 유지하는가. 폭을 모르는 상태에서 라벨 중심을 선 중점에 맞출 수 있고, 선·다른 라벨·카드와 겹치지 않는가.",
  how:
    "네 각도 블록의 점은 선의 정확한 중점이다. 점에 나안 라벨의 중심이 맞는지, 네 각도 모두 글자가 수평인지 본다(같은 줄에 가안 기울임 라벨이 겹쳐 있다). 글자 수 세 가지 블록에서 중심 정렬을, 배경 판 블록의 켜기/끄기 버튼으로 선이 글자를 관통하는지와 위쪽 블록의 배경 판 변화를, 겹침 블록에서 짧은 엣지와 라벨 둘이 붙는 교차 구간을 본다. 축소 상태 블록에서 같은 장면을 0.5배로 줄여 글자가 여전히 읽히는지 본다.",
  pass:
    "통과 — 나안에서 네 각도 모두 글자가 수평이고, 세 글자 수 모두 라벨 중심이 선 중점에 맞으며, 배경 판을 깔면 선이 글자를 관통하지 않고 축소 상태에서도 글자가 읽힌다. 중단 — 가안은 글자가 선과 같이 기울면 더 조정하지 않고 버린다. 중앙 정렬이 안 되면 선 중점에서 한쪽으로 띄워 왼쪽 정렬하는 쪽으로 후퇴하고, 짧은 엣지에서 라벨이 카드 글자를 가리면 불성립이다. 배경 판으로도 읽히지 않거나 겹침을 피할 수 없으면 짧은 엣지에서는 라벨을 숨기고, 그래도 읽히지 않으면 라벨을 선 밖 다른 자리에 표시할지를 스펙 소유자에게 올린다.",
};

/**
 * 스파이크 10 — 읽기 쉬운 엣지 라벨 배치.
 * 가안은 라벨을 회전한 선 View의 자식으로, 나안은 선과 형제인 절대 좌표 View로 선 중점에 놓는다.
 * 나안의 가로 위치는 라벨 폭을 실측해 절반만큼 당겨 중점에 맞춘다.
 */
export function Spike10EdgeLabel(props: SpikeScreenProps) {
  const { theme, layout } = props;
  const colors = theme.colors;
  const [plate, setPlate] = useState(true);

  return (
    <SpikeScreen
      {...props}
      title="스파이크 10 — 엣지 라벨 배치"
      hint="점은 선의 정확한 중점입니다. 나안 라벨의 중심이 그 점에 맞는지, 네 각도에서 글자가 수평인지 보세요."
      guide={GUIDE}
    >
      <Block
        {...props}
        title="네 각도 — 가안(선의 자식)과 나안(형제 절대 좌표)"
        note="가안 — 라벨을 회전한 선 View의 자식으로 넣어 글자가 선과 함께 기울고, 나안 — 선과 형제인 절대 좌표 View를 선 중점에 놓아 글자를 수평으로 둔다."
      >
        {ANGLES.map((entry, index) => (
          <View key={entry.label} style={{ gap: 4 }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: layout.compact ? 10 : 11 }}>{entry.label}</Text>
            <LabelCase
              theme={theme}
              entry={entry}
              text={NAMES[1]}
              plate={plate}
              showTilted
              marker={index === 0}
            />
          </View>
        ))}
      </Block>

      <Block {...props} title="글자 수 세 가지 — 나안 중심 정렬">
        {LENGTHS.map((entry, index) => (
          <View key={entry.label} style={{ gap: 4 }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: layout.compact ? 10 : 11 }}>
              {entry.label + " (" + NAMES[index] + ")"}
            </Text>
            <LabelCase theme={theme} entry={entry} text={NAMES[index]} plate={plate} showTilted={false} marker />
          </View>
        ))}
      </Block>

      <Block {...props} title="라벨 뒤 배경 판">
        <View style={{ flexDirection: "row", gap: 6 }}>
          {[true, false].map((on) => (
            <View key={String(on)} style={{ gap: 4 }}>
              <Text style={{ color: colors.foregroundMuted, fontSize: 10 }}>{on ? "배경 판 있음" : "배경 판 없음"}</Text>
              <LabelCase
                theme={theme}
                entry={ANGLES[1]}
                text={NAMES[2]}
                plate={on}
                showTilted={false}
                marker={false}
              />
            </View>
          ))}
        </View>
        <Toggle
          theme={theme}
          layout={layout}
          active={plate}
          onPress={() => setPlate((current) => !current)}
          onLabel="위쪽 블록에 배경 판 켜짐"
          offLabel="위쪽 블록에 배경 판 꺼짐"
        />
      </Block>

      <Block {...props} title="겹침 — 짧은 엣지와 교차 구간">
        <View style={{ gap: 4 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: layout.compact ? 10 : 11 }}>카드가 붙어 있는 짧은 엣지</Text>
          <LabelCase
            theme={theme}
            entry={{ label: "짧음", ax: 120, ay: 50, bx: 176, by: 96 }}
            text={NAMES[2]}
            plate={plate}
            showTilted={false}
            marker
          />
        </View>
        <View style={{ gap: 4 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: layout.compact ? 10 : 11 }}>라벨 둘이 가까이 붙는 교차 구간</Text>
          <CrossCanvas theme={theme} plate={plate} />
        </View>
      </Block>

      <Block
        {...props}
        title="축소 상태 — 라벨 읽힘"
        note="같은 장면을 0.5배로 줄여 놓았습니다. 축소한 상태에서도 라벨 글자가 읽히는지, 선이나 카드에 묻히지 않는지 봅니다."
      >
        {SHRUNK_CASES.map((entry) => (
          <View key={entry.label} style={{ gap: 4 }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: layout.compact ? 10 : 11 }}>{entry.label}</Text>
            <View
              style={{
                width: PANEL_WIDTH * SHRINK,
                height: PANEL_HEIGHT * SHRINK,
                transform: [{ scale: SHRINK }],
                transformOrigin: "0 0",
              }}
            >
              <LabelCase
                theme={theme}
                entry={entry.geom}
                text={entry.text}
                plate={plate}
                showTilted={false}
                marker={false}
              />
            </View>
          </View>
        ))}
      </Block>
    </SpikeScreen>
  );
}

function LabelCase({
  theme,
  entry,
  text,
  plate,
  showTilted,
  marker,
}: {
  theme: SpikeScreenProps["theme"];
  entry: Case;
  text: string;
  plate: boolean;
  showTilted: boolean;
  marker: boolean;
}) {
  const colors = theme.colors;
  const { length, deg } = rotateOf(entry.ax, entry.ay, entry.bx, entry.by);
  const midX = (entry.ax + entry.bx) / 2;
  const midY = (entry.ay + entry.by) / 2;

  return (
    <View style={{ width: PANEL_WIDTH, height: PANEL_HEIGHT, backgroundColor: colors.surface0 }}>
      {showTilted ? (
        <View
          style={{
            position: "absolute",
            left: entry.ax,
            top: entry.ay - 1,
            width: length,
            height: 2,
            backgroundColor: colors.border,
            transform: [{ rotate: deg + "deg" }],
            transformOrigin: "0 50%",
            overflow: "visible",
          }}
        >
          <Text
            style={{
              position: "absolute",
              left: length / 2 - 40,
              top: -16,
              width: 80,
              textAlign: "center",
              color: colors.foregroundMuted,
              fontSize: 11,
            }}
          >
            {text}
          </Text>
        </View>
      ) : (
        <View
          style={{
            position: "absolute",
            left: entry.ax,
            top: entry.ay - 1,
            width: length,
            height: 2,
            backgroundColor: colors.border,
            transform: [{ rotate: deg + "deg" }],
            transformOrigin: "0 50%",
          }}
        />
      )}

      {marker ? (
        <View
          style={{
            position: "absolute",
            left: midX - 3,
            top: midY - 3,
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: colors.accent,
          }}
        />
      ) : null}

      <MidLabel theme={theme} x={midX} y={midY} text={text} plate={plate} />
      <Card theme={theme} x={entry.ax} y={entry.ay} />
      <Card theme={theme} x={entry.bx} y={entry.by} />
    </View>
  );
}

/** 선 중점에 놓이는 라벨. 폭을 실측한 뒤 절반만큼 당겨 중심을 중점에 맞춘다. */
function MidLabel({
  theme,
  x,
  y,
  text,
  plate,
}: {
  theme: SpikeScreenProps["theme"];
  x: number;
  y: number;
  text: string;
  plate: boolean;
}) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  return (
    <View
      onLayout={(event) => {
        setSize({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height });
      }}
      style={{
        position: "absolute",
        left: x - size.width / 2,
        top: y - size.height / 2,
        paddingHorizontal: 3,
        paddingVertical: 1,
        backgroundColor: plate ? theme.colors.surface0 : undefined,
      }}
    >
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{text}</Text>
    </View>
  );
}

function Card({ theme, x, y }: { theme: SpikeScreenProps["theme"]; x: number; y: number }) {
  return (
    <View
      style={{
        position: "absolute",
        left: x - CARD_WIDTH / 2,
        top: y - CARD_HEIGHT / 2,
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        backgroundColor: theme.colors.surface2,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 4,
      }}
    />
  );
}

function CrossCanvas({ theme, plate }: { theme: SpikeScreenProps["theme"]; plate: boolean }) {
  const colors = theme.colors;
  const first = { x1: 30, y1: 30, x2: 270, y2: 120 };
  const second = { x1: 30, y1: 120, x2: 270, y2: 30 };

  return (
    <View style={{ width: PANEL_WIDTH, height: PANEL_HEIGHT, backgroundColor: colors.surface0 }}>
      {[first, second].map((line, index) => {
        const rotated = rotateOf(line.x1, line.y1, line.x2, line.y2);
        return (
          <View
            key={String(index)}
            style={{
              position: "absolute",
              left: line.x1,
              top: line.y1 - 1,
              width: rotated.length,
              height: 2,
              backgroundColor: colors.border,
              transform: [{ rotate: rotated.deg + "deg" }],
              transformOrigin: "0 50%",
            }}
          />
        );
      })}
      <MidLabel
        theme={theme}
        x={(first.x1 + first.x2) / 2}
        y={(first.y1 + first.y2) / 2}
        text="승인 대기"
        plate={plate}
      />
      <MidLabel
        theme={theme}
        x={(second.x1 + second.x2) / 2}
        y={(second.y1 + second.y2) / 2}
        text="검토 필요"
        plate={plate}
      />
    </View>
  );
}

function Toggle({
  theme,
  layout,
  active,
  onPress,
  onLabel,
  offLabel,
}: {
  theme: SpikeScreenProps["theme"];
  layout: SpikeScreenProps["layout"];
  active: boolean;
  onPress: () => void;
  onLabel: string;
  offLabel: string;
}) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: layout.compact ? 10 : 11 }}>
        {active ? onLabel : offLabel}
      </Text>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        style={{
          alignSelf: "flex-start",
          paddingHorizontal: 10,
          paddingVertical: 6,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface2,
        }}
      >
        <Text style={{ color: theme.colors.foreground, fontSize: 11 }}>배경 판 켜기/끄기</Text>
      </Pressable>
    </View>
  );
}
