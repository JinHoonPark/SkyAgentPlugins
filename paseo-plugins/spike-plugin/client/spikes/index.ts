import { Spike05EdgeContrast } from "./spike-05-edge-contrast";
import { Spike07Arrowhead } from "./spike-07-arrowhead";
import { Spike08GateHexagon } from "./spike-08-gate-hexagon";
import { Spike09DashedEdge } from "./spike-09-dashed-edge";
import { Spike10EdgeLabel } from "./spike-10-edge-label";
import type { SpikePrototype } from "./types";

/**
 * 판정 화면이 있는 스파이크 목록.
 * 화면을 새로 붙일 때는 스파이크 파일 하나를 만들고 여기에 한 줄만 더한다.
 * 목록 문구는 shared/checklist.ts의 SPIKE_ITEMS와 같아야 하며, 다르면 타입 오류가 난다.
 */
export const SPIKE_PROTOTYPES: readonly SpikePrototype[] = [
  {
    item: "다크 모드 일반/강조 연결선 가독성 구분",
    title: "스파이크 5 — 연결선 가독성",
    Component: Spike05EdgeContrast,
  },
  { item: "View 기반 화살촉", title: "스파이크 7 — 화살촉", Component: Spike07Arrowhead },
  {
    item: "SVG 없는 사용자 게이트 육각형과 텍스트",
    title: "스파이크 8 — 게이트 육각형",
    Component: Spike08GateHexagon,
  },
  { item: "회전된 View 기반 점선 엣지", title: "스파이크 9 — 점선 엣지", Component: Spike09DashedEdge },
  { item: "읽기 쉬운 엣지 라벨 배치", title: "스파이크 10 — 엣지 라벨", Component: Spike10EdgeLabel },
];

export function findPrototype(item: string): SpikePrototype | undefined {
  return SPIKE_PROTOTYPES.find((entry) => entry.item === item);
}

export type { SpikePrototype, SpikeScreenProps } from "./types";
