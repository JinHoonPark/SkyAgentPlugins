import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Block, SpikeScreen, rotateOf } from "./kit";
import type { SpikeScreenProps } from "./types";

const PANEL_WIDTH = 300;
const PANEL_HEIGHT = 150;
const CARD_WIDTH = 30;
const CARD_HEIGHT = 20;

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
    >
      <Block {...props} title="네 각도 — 가안(선의 자식)과 나안(형제 절대 좌표)">
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
