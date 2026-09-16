import { ScrollView } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import type { SpikeScreenProps } from "./types";

export interface SegmentProps {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly color: string;
  readonly thickness: number;
}

/**
 * 두 점을 잇는 선. 캔버스와 같은 방식으로 회전시킨 직사각형 View 하나다.
 * 시작점을 회전축으로 삼아야 끝점이 정확히 맞으므로 transformOrigin을 왼쪽 중앙에 둔다.
 */
export function Segment({ x1, y1, x2, y2, color, thickness }: SegmentProps) {
  const rotated = rotateOf(x1, y1, x2, y2);
  return (
    <View
      style={{
        position: "absolute",
        left: x1,
        top: y1 - thickness / 2,
        width: rotated.length,
        height: thickness,
        backgroundColor: color,
        transform: [{ rotate: rotated.deg + "deg" }],
        transformOrigin: "0 50%",
      }}
    />
  );
}

export function rotateOf(x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return {
    length: Math.sqrt(dx * dx + dy * dy),
    deg: (Math.atan2(dy, dx) * 180) / Math.PI,
    ux: dx / Math.max(1, Math.sqrt(dx * dx + dy * dy)),
    uy: dy / Math.max(1, Math.sqrt(dx * dx + dy * dy)),
  };
}

interface SpikeScreenShellProps extends SpikeScreenProps {
  readonly title: string;
  readonly hint: string;
  readonly children: ReactNode;
}

/** 모든 판정 화면의 공통 틀. 제목·안내문만 두고 판정 문구는 넣지 않는다. */
export function SpikeScreen({ theme, layout, title, hint, children }: SpikeScreenShellProps) {
  return (
    <ScrollView contentContainerStyle={{ padding: layout.compact ? 12 : 16, gap: 14 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: layout.compact ? 15 : 17, fontWeight: "600" }}>
        {title}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: layout.compact ? 11 : 12, lineHeight: 16 }}>
        {hint}
      </Text>
      {children}
    </ScrollView>
  );
}

interface BlockProps extends SpikeScreenProps {
  readonly title: string;
  readonly children: ReactNode;
}

/** 화면 안의 비교 묶음. 제목 아래에 판정할 조각들을 담는다. */
export function Block({ theme, layout, title, children }: BlockProps) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: layout.compact ? 11 : 12, fontWeight: "600" }}>
        {title}
      </Text>
      {children}
    </View>
  );
}

/** 캔버스 배경 한 판. 안쪽 좌표를 절대값으로 쓰기 위해 크기를 고정한다. */
export function Canvas({ theme, width, height, children }: { theme: SpikeScreenProps["theme"]; width: number; height: number; children: ReactNode }) {
  return (
    <View style={{ width, height, backgroundColor: theme.colors.surface0 }}>{children}</View>
  );
}
