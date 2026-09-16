import { Fragment, useMemo } from "react";
import { Text, View } from "react-native";
import {
  contrastRatio,
  estimateAppearance,
  formatNumber,
  formatRgb,
  parseColor,
  relativeLuminance,
  type Rgb,
} from "./color-analysis";
import { Block, Canvas, Segment, SpikeScreen } from "./kit";
import type { SpikeScreenProps } from "./types";

/** 후보 선 색. 테마가 주는 이름만 쓰고 새 색을 만들지 않는다. */
const CANDIDATE_KEYS = ["border", "foregroundMuted", "foreground", "accent"] as const;

type CandidateKey = (typeof CANDIDATE_KEYS)[number];

const SCENE_WIDTH = 330;
const SCENE_HEIGHT = 208;
const CARD_WIDTH = 56;
const CARD_HEIGHT = 29;
const SOURCE_LEFT = 14;
const SOURCE_TOP = 88;
const TARGET_LEFT = 254;
const TARGET_TOPS = [6, 62, 118, 174] as const;

/**
 * 스파이크 5 — 다크 모드에서 일반 연결선과 강조 연결선의 가독성 구분.
 * (가) 현재 테마의 surface0 밝기로 라이트/다크를 추정한 값과 그 근거 색을 그대로 보여준다.
 * (나) 후보 선 색마다 같은 장면을 만들어, 일반 선과 강조 선을 같은 화면에 놓는다.
 */
export function Spike05EdgeContrast(props: SpikeScreenProps) {
  const { theme, layout } = props;
  const colors = theme.colors;

  const analysis = useMemo(() => analyze(colors), [colors]);

  return (
    <SpikeScreen
      {...props}
      title="스파이크 5 — 일반 연결선과 강조 연결선의 구분"
      hint="현재 테마 값을 그대로 읽어 계산한 값과, 같은 장면을 후보 선 색별로 나란히 보여줍니다. 앱 테마를 라이트/다크로 바꿔가며 이 화면을 다시 열어 대조하세요."
    >
      <Block {...props} title="(가) 테마 값에서 읽은 배경 밝기와 추정 결과">
        <View style={{ backgroundColor: colors.surface1, borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: 10, gap: 4 }}>
          <Readout theme={theme} label="surface0 (캔버스 배경)" value={colors.surface0} />
          <Readout theme={theme} label="surface2 (카드 배경)" value={colors.surface2} />
          <Readout theme={theme} label="border" value={colors.border} />
          <Readout theme={theme} label="foregroundMuted" value={colors.foregroundMuted} />
          <Readout theme={theme} label="foreground" value={colors.foreground} />
          <Readout theme={theme} label="accent" value={colors.accent} />
          <Text style={{ color: colors.foreground, fontSize: layout.compact ? 11 : 12, paddingTop: 4 }}>
            {"surface0 상대 휘도 기준 추정: " + analysis.appearance + "  (임계값 " + formatNumber(analysis.threshold, 2) + ")"}
          </Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: layout.compact ? 10 : 11 }}>
            {"라이트/다크를 직접 알려주는 항목은 테마에 없습니다. 위 값은 surface0 밝기만으로 계산한 추정입니다."}
          </Text>
        </View>
      </Block>

      <Block {...props} title="(나) 후보 선 색별 같은 장면 — 왼쪽 카드에서 나가는 세 선과 강조 선 하나">
        {CANDIDATE_KEYS.map((key) => (
          <View key={key} style={{ gap: 4 }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: layout.compact ? 10 : 11 }}>
              {"일반 선 = " + key + " " + colors[key] + " 1px, 대비비 " + formatNumber(analysis.contrast[key], 2) + "  ·  강조 선 = accent 2px"}
            </Text>
            <LightnessScene theme={theme} candidate={colors[key]} />
          </View>
        ))}
      </Block>

      <Block {...props} title="현재 캔버스와 같은 조합 — 비교 기준">
        <Text style={{ color: colors.foregroundMuted, fontSize: layout.compact ? 10 : 11 }}>
          {"graph-canvas가 지금 쓰는 값: 일반 border 1px / 강조 accent 2px"}
        </Text>
        <LightnessScene theme={theme} candidate={colors.border} />
      </Block>
    </SpikeScreen>
  );
}

function analyze(colors: SpikeScreenProps["theme"]["colors"]) {
  const threshold = 0.5;
  const surface0 = parseColor(colors.surface0);
  const contrast = {} as Record<CandidateKey, number>;
  const luminance = {} as Record<CandidateKey, number>;
  for (const key of CANDIDATE_KEYS) {
    const parsed = parseColor(colors[key]);
    contrast[key] = parsed == null || surface0 == null ? Number.NaN : contrastRatio(parsed, surface0);
    luminance[key] = parsed == null ? Number.NaN : relativeLuminance(parsed);
  }
  return {
    threshold,
    appearance: estimateAppearance(colors.surface0, threshold),
    contrast,
    luminance,
  };
}

function Readout({
  theme,
  label,
  value,
}: {
  theme: SpikeScreenProps["theme"];
  label: string;
  value: string;
}) {
  const parsed: Rgb | null = parseColor(value);
  return (
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
      {label + ": " + value + "  " + formatRgb(parsed) + "  휘도 " + (parsed == null ? "-" : formatNumber(relativeLuminance(parsed)))}
    </Text>
  );
}

/** 출발 카드 하나에서 나가는 후보색 선 셋과 강조 선 하나. */
function LightnessScene({ theme, candidate }: { theme: SpikeScreenProps["theme"]; candidate: string }) {
  const colors = theme.colors;
  const sourceRight = SOURCE_LEFT + CARD_WIDTH;
  const sourceMidY = SOURCE_TOP + CARD_HEIGHT / 2;

  return (
    <Canvas theme={theme} width={SCENE_WIDTH} height={SCENE_HEIGHT}>
      <SourceCard theme={theme} />
      {TARGET_TOPS.map((top, index) => {
        const emphasized = index === TARGET_TOPS.length - 1;
        const targetMidY = top + CARD_HEIGHT / 2;
        return (
          <Fragment key={String(top)}>
            <Segment
              x1={sourceRight}
              y1={sourceMidY}
              x2={TARGET_LEFT}
              y2={targetMidY}
              color={emphasized ? colors.accent : candidate}
              thickness={emphasized ? 2 : 1}
            />
            <View
              style={{
                position: "absolute",
                left: TARGET_LEFT,
                top,
                width: CARD_WIDTH,
                height: CARD_HEIGHT,
                backgroundColor: colors.surface2,
                borderColor: colors.border,
                borderWidth: 1,
                borderRadius: 4,
              }}
            />
          </Fragment>
        );
      })}
    </Canvas>
  );
}

function SourceCard({ theme }: { theme: SpikeScreenProps["theme"] }) {
  return (
    <View
      style={{
        position: "absolute",
        left: SOURCE_LEFT,
        top: SOURCE_TOP,
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
