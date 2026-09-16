import { Modal as SheetModal } from "@getpaseo/plugin/client/react-native";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { PanResponder, Pressable, Text, View } from "react-native";
import { Block, Segment, SpikeScreen } from "./kit";
import type { SpikeGuide, SpikeScreenProps } from "./types";

/** 그래프 뷰포트 크기. 캔버스가 더 커서 드래그로 움직일 여지가 있다. */
const VIEWPORT_W = 320;
const VIEWPORT_H = 300;
const CANVAS_W = 420;
const CANVAS_H = 360;
/** 실제 엣지 라벨과 같은 제한. 폭 160px·두 줄을 넘으면 …로 잘린다. */
const LABEL_MAX_W = 160;
const LABEL_LINES = 2;
const TOOLTIP_W = 200;
const CARD_W = 44;
const CARD_H = 26;
/** 드래그로 캔버스가 움직일 수 있는 범위. 뷰포트가 항상 캔버스 안에 있게 잡는다. */
const PAN_MIN_X = VIEWPORT_W - CANVAS_W;
const PAN_MIN_Y = VIEWPORT_H - CANVAS_H;

const SHORT_TEXT = "승인";
/** 두 줄 경계에 걸치는 길이. 잘림 여부를 눈으로 보는 대상이다. */
const CUT_TEXT = "승인 대기 중이며 담당자 확인이 끝나지 않았습니다";
const LONG_TEXT = "승인 대기 중이며 담당자 확인이 끝나지 않아 게이트가 열리지 않았습니다";
const RIGHT_TEXT = "승인 대기";
const BOTTOM_TEXT = "담당자 확인이 끝나지 않았습니다";

/** 이 호스트 타입에서 컴파일되는 감지 수단만 남겼다. 판정 안내에도 같은 사실을 적었다. */
type DetectMode = "가" | "다";
/** 툴팁 상자를 놓는 방식. */
type BoxMode = "A" | "B" | "C";

interface LabelSpec {
  readonly id: string;
  /** 라벨 중심의 캔버스 좌표. */
  readonly x: number;
  readonly y: number;
  readonly text: string;
}

/** 짧은·딱 잘리는·아주 긴 라벨 셋과, 뷰포트 오른쪽 끝·아래쪽 끝 라벨 둘. */
const LABELS: readonly LabelSpec[] = [
  { id: "short", x: 195, y: 80, text: SHORT_TEXT },
  { id: "cut", x: 195, y: 120, text: CUT_TEXT },
  { id: "long", x: 195, y: 160, text: LONG_TEXT },
  { id: "right", x: 287, y: 205, text: RIGHT_TEXT },
  { id: "bottom", x: 160, y: 283, text: BOTTOM_TEXT },
];

const EDGES = [
  { x1: 90, y1: 70, x2: 300, y2: 110 },
  { x1: 90, y1: 110, x2: 300, y2: 150 },
  { x1: 90, y1: 150, x2: 300, y2: 190 },
  { x1: 90, y1: 190, x2: 330, y2: 215 },
  { x1: 100, y1: 235, x2: 220, y2: 300 },
];

/** 노드 카드 두 개. 하나는 아래쪽 끝 라벨 아래에 겹쳐 두어 가림 여부를 바로 본다. */
const CARDS = [
  { x: 80, y: 50 },
  { x: 215, y: 288 },
];

const GUIDE: SpikeGuide = {
  question:
    "엣지 라벨은 폭 160px·두 줄로 접히고 넘치는 부분이 …로 잘린다. 자른 라벨에 마우스를 올려 전체 문구를 띄울 수 있고, 그 상태에서 라벨 아래 노드 카드를 누르면 카드가 여전히 반응하는가. 툴팁 상자는 뷰포트 가장자리에서 잘리거나 노드 카드 뒤로 숨지 않는가. 캔버스를 드래그하는 동안 툴팁이 라벨을 따라오는가.",
  how:
    "감지 수단 버튼으로 (가) Pressable의 onHoverIn/onHoverOut과 (다) 라벨 View의 onPointerEnter/onPointerLeave를 바꿔 가며 같은 다섯 라벨에 적용합니다 — 라벨에 마우스를 올렸을 때 테두리가 강조되는지가 반응 표시입니다. (나) onMouseEnter/onMouseLeave는 이 호스트 타입에 없어 타입 검사 오류가 나서 화면에서 뺐습니다. 툴팁 상자 버튼으로 (A) 캔버스 안 형제 절대 좌표, (B) 캔버스 바깥 뷰포트 최상위 절대 좌표, (C) Modal을 바꿔 가며 오른쪽 끝·아래쪽 끝 라벨의 툴팁을 봅니다. 라벨을 올린 채 캔버스를 드래그해 툴팁이 라벨을 따라오는지 보고, 라벨 아래 카드를 눌러 '카드 누름' 횟수가 오르는지 봅니다. 화면 아래 (라)·(마)에서 자르지 않는 대안 둘을 나란히 봅니다.",
  pass:
    "통과 — (가)·(다) 중 하나에서 마우스를 올리면 전체 문구가 뜨고 벗어나면 사라지며 그 상태에서 카드 누름이 오르고, (A)·(B)·(C) 중 하나에서 오른쪽 끝·아래쪽 끝 라벨의 툴팁도 잘리지 않고 노드 카드에 가리지 않는다. 중단 — 감지는 되는데 라벨이 카드 누름을 가로채면 그 방식을 버린다. 드래그 중 툴팁이 엉뚱한 자리에 남으면 '팬 시작 시 툴팁 숨기기'를 켜고, 그래도 잔상이 남으면 그 상자 방식을 버린다. (라)가 이웃 라벨이나 카드를 가리면 (마)만 남긴다.",
};

/**
 * 스파이크 11 — 잘린 엣지 라벨의 전체 문구를 호버 툴팁으로 보여줄 수 있는가.
 * 감지 수단 둘과 툴팁 상자 셋을 버튼으로 바꿔 가며 같은 다섯 라벨에 적용하고,
 * 캔버스는 드래그로 움직인다. 자르지 않는 대안 (라)·(마)를 화면 아래에 나란히 둔다.
 */
export function Spike11LabelTooltip(props: SpikeScreenProps) {
  const { theme, layout } = props;
  const colors = theme.colors;
  const [mode, setMode] = useState<DetectMode>("가");
  const [box, setBox] = useState<BoxMode>("A");
  const [hovered, setHovered] = useState<string | null>(null);
  const [hideOnPan, setHideOnPan] = useState(false);
  const [presses, setPresses] = useState(0);
  const [measures, setMeasures] = useState<Record<string, { y: number; height: number }>>({});
  const [pan, setPan] = useState({ x: 0, y: 0 });

  const panValue = useRef({ x: 0, y: 0 });
  const basePan = useRef({ x: 0, y: 0 });
  const hideRef = useRef(false);
  hideRef.current = hideOnPan;

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        // 카드와 라벨의 누름을 가로채지 않도록 시작에는 응답자가 되지 않고, 2px 넘게 움직일 때만 팬을 시작한다.
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_event, gesture) => Math.abs(gesture.dx) + Math.abs(gesture.dy) > 2,
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => false,
        onPanResponderGrant: () => {
          basePan.current = { ...panValue.current };
          if (hideRef.current) {
            setHovered(null);
          }
        },
        onPanResponderMove: (_event, gesture) => {
          const next = {
            x: clamp(basePan.current.x + gesture.dx, PAN_MIN_X, 0),
            y: clamp(basePan.current.y + gesture.dy, PAN_MIN_Y, 0),
          };
          panValue.current = next;
          setPan(next);
        },
      }),
    [],
  );

  const hoveredLabel = hovered == null ? null : (LABELS.find((entry) => entry.id === hovered) ?? null);
  const labelY = hoveredLabel == null ? 0 : (measures[hoveredLabel.id]?.y ?? hoveredLabel.y);
  const labelHeight = hoveredLabel == null ? 0 : (measures[hoveredLabel.id]?.height ?? 16);

  const tooltipFor = (entry: LabelSpec) => (
    <Tooltip theme={theme} text={entry.text} />
  );

  return (
    <SpikeScreen
      {...props}
      title="스파이크 11 — 잘린 라벨 툴팁"
      hint="캔버스는 드래그로 움직입니다. 라벨에 마우스를 올려 전체 문구가 뜨는지, 그 상태에서 라벨 아래 카드를 누르면 반응하는지 보세요."
      guide={GUIDE}
    >
      <Block
        {...props}
        title="감지 수단 — 같은 라벨에 바꿔 적용"
        note="(가) 라벨을 Pressable로 감싸고 onHoverIn/onHoverOut. (다) 라벨 View에 onPointerEnter/onPointerLeave. 마우스를 올렸을 때 라벨 테두리가 강조되면 그 수단이 반응한 것이다."
      >
        <Choice
          theme={theme}
          layout={layout}
          label={"감지 수단 " + mode}
          options={["가", "다"]}
          active={mode}
          onPick={(next) => {
            setHovered(null);
            setMode(next as DetectMode);
          }}
        />
      </Block>

      <Block
        {...props}
        title="툴팁 상자 — 같은 라벨에 바꿔 적용"
        note="(A) 라벨과 형제인 절대 좌표 View를 캔버스 좌표계 안에 둔다. (B) 캔버스 바깥 뷰포트 최상위에 절대 좌표 View를 두고 라벨의 화면 좌표를 실측해 그 자리에 띄운다. (C) Modal로 띄운다."
      >
        <Choice
          theme={theme}
          layout={layout}
          label={"툴팁 상자 " + box}
          options={["A", "B", "C"]}
          active={box}
          onPick={(next) => setBox(next as BoxMode)}
        />
      </Block>

      <Block
        {...props}
        title="캔버스 — 다섯 라벨과 노드 카드 둘"
        note="위 라벨 셋은 짧은·딱 잘리는·아주 긴 문구다. 오른쪽 끝 라벨은 뷰포트 오른쪽 경계에, 아래쪽 끝 라벨은 아래쪽 경계에 붙어 있고 그 아래에 노드 카드가 겹쳐 있다. 카드는 라벨보다 zIndex가 높다."
      >
        <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: layout.compact ? 10 : 11 }}>
            {"카드 누름 " + String(presses) + "회"}
          </Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: layout.compact ? 10 : 11 }}>
            {"캔버스 위치 " + String(Math.round(pan.x)) + ", " + String(Math.round(pan.y))}
          </Text>
        </View>
        <View
          style={{
            width: VIEWPORT_W,
            height: VIEWPORT_H,
            overflow: "hidden",
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface0,
          }}
        >
          <View
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: CANVAS_W,
              height: CANVAS_H,
              transform: [{ translateX: pan.x }, { translateY: pan.y }],
            }}
            {...panResponder.panHandlers}
          >
            {EDGES.map((edge, index) => (
              <Segment
                key={String(index)}
                x1={edge.x1}
                y1={edge.y1}
                x2={edge.x2}
                y2={edge.y2}
                color={colors.border}
                thickness={1}
              />
            ))}
            {CARDS.map((card, index) => (
              <Pressable
                key={String(index)}
                onPress={() => setPresses((current) => current + 1)}
                accessibilityRole="button"
                style={{
                  position: "absolute",
                  left: card.x - CARD_W / 2,
                  top: card.y - CARD_H / 2,
                  width: CARD_W,
                  height: CARD_H,
                  // 카드가 라벨·툴팁보다 위에 온다. 실제 캔버스와 같은 순서다.
                  zIndex: 2,
                  borderWidth: 1,
                  borderColor: colors.border,
                  borderRadius: 4,
                  backgroundColor: colors.surface2,
                }}
              >
                <Text style={{ color: colors.foregroundMuted, fontSize: 9 }}>노드</Text>
              </Pressable>
            ))}
            {LABELS.map((entry) => (
              <EdgeLabel
                key={entry.id}
                theme={theme}
                layout={layout}
                mode={mode}
                entry={entry}
                onHover={setHovered}
                onMeasure={(id, y, height) =>
                  setMeasures((current) =>
                    current[id] != null && current[id].y === y && current[id].height === height
                      ? current
                      : { ...current, [id]: { y, height } },
                  )
                }
              />
            ))}
            {box === "A" && hoveredLabel != null ? (
              <View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  left: hoveredLabel.x - TOOLTIP_W / 2,
                  top: labelY + labelHeight / 2 + 4,
                  // 카드(zIndex 2)보다 아래에 둔다. 가리면 그대로 보인다.
                  zIndex: 1,
                }}
              >
                {tooltipFor(hoveredLabel)}
              </View>
            ) : null}
          </View>
          {box === "B" && hoveredLabel != null ? (
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                left: pan.x + hoveredLabel.x - TOOLTIP_W / 2,
                top: pan.y + labelY + labelHeight / 2 + 4,
                zIndex: 3,
              }}
            >
              {tooltipFor(hoveredLabel)}
            </View>
          ) : null}
        </View>
        <Choice
          theme={theme}
          layout={layout}
          label={hideOnPan ? "팬 시작 시 툴팁 숨김 켜짐" : "팬 시작 시 툴팁 숨김 꺼짐"}
          options={["켜기", "끄기"]}
          active={hideOnPan ? "켜기" : "끄기"}
          onPick={(next) => setHideOnPan(next === "켜기")}
        />
      </Block>

      <SheetModal
        open={box === "C" && hoveredLabel != null}
        onOpenChange={(open) => {
          if (!open) {
            setHovered(null);
          }
        }}
        title="엣지 라벨 전체 문구"
      >
        <SheetModal.Content>
          <Text style={{ color: colors.foreground, fontSize: 13, lineHeight: 19 }}>
            {hoveredLabel?.text ?? ""}
          </Text>
        </SheetModal.Content>
      </SheetModal>

      <Block
        {...props}
        title="자르지 않는 대안 둘 — (라) 전체 펼침, (마) 눌러 펼침"
        note="같은 긴 문구를 (라)에서는 폭·줄 수 제한 없이 그대로 펼치고, (마)에서는 자른 채 두었다가 누르면 펼친다. 두 대안에서 긴 라벨이 이웃 라벨이나 노드 카드를 가리는지 본다."
      >
        <View style={{ flexDirection: "row", gap: 10 }}>
          <FallbackPanel theme={theme} layout={layout} title="(라) 펼침" note="제한 없음">
            <View style={{ position: "absolute", left: 8, top: 62, right: 8 }}>
              <Text style={{ color: colors.foreground, fontSize: 11, lineHeight: 14 }}>{LONG_TEXT}</Text>
            </View>
          </FallbackPanel>
          <FallbackPanel theme={theme} layout={layout} title="(마) 눌러 펼침" note="누르면 접히고 펴진다">
            <TapLabel theme={theme} text={LONG_TEXT} />
          </FallbackPanel>
        </View>
      </Block>
    </SpikeScreen>
  );
}

/** 라벨 하나. 감지 수단에 따라 Pressable이거나 맨 View다. */
function EdgeLabel({
  theme,
  layout,
  mode,
  entry,
  onHover,
  onMeasure,
}: {
  theme: SpikeScreenProps["theme"];
  layout: SpikeScreenProps["layout"];
  mode: DetectMode;
  entry: LabelSpec;
  onHover: (id: string | null) => void;
  onMeasure: (id: string, y: number, height: number) => void;
}) {
  const colors = theme.colors;
  const [hovering, setHovering] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const box = {
    position: "absolute" as const,
    left: entry.x - size.width / 2,
    top: entry.y - size.height / 2,
    zIndex: 1,
    paddingHorizontal: 3,
    paddingVertical: 1,
    borderWidth: 1,
    borderColor: hovering ? colors.accent : colors.border,
    backgroundColor: colors.surface0,
  };
  const mark = (next: boolean) => {
    setHovering(next);
    onHover(next ? entry.id : null);
  };

  if (mode === "가") {
    return (
      <Pressable
        onHoverIn={() => mark(true)}
        onHoverOut={() => mark(false)}
        accessibilityLabel={"엣지 라벨 " + entry.id}
        style={box}
        onLayout={(event) => {
          const next = event.nativeEvent.layout;
          setSize({ width: next.width, height: next.height });
          onMeasure(entry.id, next.y, next.height);
        }}
      >
        <Text
          numberOfLines={LABEL_LINES}
          ellipsizeMode="tail"
          style={{ maxWidth: LABEL_MAX_W, color: colors.foreground, fontSize: 11, lineHeight: 14 }}
        >
          {entry.text}
        </Text>
      </Pressable>
    );
  }

  return (
    <View
      onPointerEnter={() => mark(true)}
      onPointerLeave={() => mark(false)}
      style={box}
      onLayout={(event) => {
        const next = event.nativeEvent.layout;
        setSize({ width: next.width, height: next.height });
        onMeasure(entry.id, next.y, next.height);
      }}
    >
      <Text
        numberOfLines={LABEL_LINES}
        ellipsizeMode="tail"
        style={{ maxWidth: LABEL_MAX_W, color: colors.foreground, fontSize: 11, lineHeight: 14 }}
      >
        {entry.text}
      </Text>
    </View>
  );
}

function Tooltip({ theme, text }: { theme: SpikeScreenProps["theme"]; text: string }) {
  const colors = theme.colors;
  return (
    <View
      style={{
        width: TOOLTIP_W,
        paddingHorizontal: 8,
        paddingVertical: 6,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
        // 그림자는 배열 형식으로만 전처리를 통과한다.
        boxShadow: [{ offsetX: 0, offsetY: 2, blurRadius: 8, color: colors.border }],
      }}
    >
      <Text style={{ color: colors.foregroundMuted, fontSize: 9, lineHeight: 12 }}>전체 문구</Text>
      <Text style={{ color: colors.foreground, fontSize: 11, lineHeight: 15 }}>{text}</Text>
    </View>
  );
}

/** (마) 눌러 펼치고 다시 누르면 접힌다. */
function TapLabel({ theme, text }: { theme: SpikeScreenProps["theme"]; text: string }) {
  const colors = theme.colors;
  const [open, setOpen] = useState(false);
  return (
    <Pressable
      onPress={() => setOpen((current) => !current)}
      accessibilityRole="button"
      style={{
        position: "absolute",
        left: 8,
        top: 62,
        right: 8,
        paddingHorizontal: 3,
        paddingVertical: 1,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface0,
      }}
    >
      <Text
        numberOfLines={open ? undefined : LABEL_LINES}
        ellipsizeMode="tail"
        style={{ color: colors.foreground, fontSize: 11, lineHeight: 14 }}
      >
        {text}
      </Text>
    </Pressable>
  );
}

/** 자르지 않는 대안을 보는 작은 판. 이웃 라벨과 노드 카드를 함께 두어 가림을 본다. */
function FallbackPanel({
  theme,
  layout,
  title,
  note,
  children,
}: {
  theme: SpikeScreenProps["theme"];
  layout: SpikeScreenProps["layout"];
  title: string;
  note: string;
  children: ReactNode;
}) {
  const colors = theme.colors;
  return (
    <View style={{ flex: 1, gap: 4 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: layout.compact ? 10 : 11 }}>{title}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 9 }}>{note}</Text>
      <View
        style={{
          height: 150,
          overflow: "hidden",
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface0,
        }}
      >
        <Segment x1={0} y1={100} x2={200} y2={100} color={colors.border} thickness={1} />
        <View
          style={{
            position: "absolute",
            left: 122,
            top: 42,
            paddingHorizontal: 3,
            paddingVertical: 1,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface0,
          }}
        >
          <Text style={{ color: colors.foreground, fontSize: 11, lineHeight: 14 }}>검토 필요</Text>
        </View>
        <View
          style={{
            position: "absolute",
            left: 30,
            top: 92,
            width: CARD_W,
            height: CARD_H,
            zIndex: 2,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: 4,
            backgroundColor: colors.surface2,
          }}
        >
          <Text style={{ color: colors.foregroundMuted, fontSize: 9 }}>노드</Text>
        </View>
        {children}
      </View>
    </View>
  );
}

/** 같은 줄에서 하나만 고르는 버튼 묶음. */
function Choice({
  theme,
  layout,
  label,
  options,
  active,
  onPick,
}: {
  theme: SpikeScreenProps["theme"];
  layout: SpikeScreenProps["layout"];
  label: string;
  options: readonly string[];
  active: string;
  onPick: (next: string) => void;
}) {
  const colors = theme.colors;
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: layout.compact ? 10 : 11 }}>{label}</Text>
      <View style={{ flexDirection: "row", gap: 6 }}>
        {options.map((option) => {
          const on = option === active;
          return (
            <Pressable
              key={option}
              onPress={() => onPick(option)}
              accessibilityRole="button"
              style={{
                paddingHorizontal: 10,
                paddingVertical: 5,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: on ? colors.accent : colors.border,
                backgroundColor: on ? colors.accent : colors.surface2,
              }}
            >
              <Text style={{ color: on ? colors.accentForeground : colors.foreground, fontSize: 11 }}>
                {option}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
