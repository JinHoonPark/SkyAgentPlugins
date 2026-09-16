import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** 육안 판정을 요청할 고정 항목 목록. 사람이 화면에서 확인하는 대상이며 코드가 판정하지 않는다. */
export const SPIKE_ITEMS = [
  "다크 모드 대기 아이콘/텍스트의 느린 밝기 왕복",
  "대기 상태 줄의 정지 유지",
  "실행 중 아이콘만 쓰로버, 텍스트 정지",
  "다수 노드 반복 애니메이션 성능",
  "다크 모드 일반/강조 연결선 가독성 구분",
  "실패 노드 외곽선 정지 유지",
  "View 기반 화살촉",
  "SVG 없는 사용자 게이트 육각형과 텍스트",
  "회전된 View 기반 점선 엣지",
  "읽기 쉬운 엣지 라벨 배치",
  "잘린 엣지 라벨의 호버 툴팁",
] as const;

export const SPIKE_ITEM_COUNT = SPIKE_ITEMS.length;

export const spikeTimelineKind = "spike-check";
export const spikeTimelineVersion = 1;

/** 타임라인 행 본문. 선택된 항목 이름만 담고 판정 결과는 담지 않는다. */
export const spikeTimelineData = z.object({
  items: z.array(z.string()),
});

export type SpikeTimelineData = z.infer<typeof spikeTimelineData>;

export const requestSpikeCheckRpc = defineRpc({
  name: "spike.request-check",
  input: z.object({
    agentId: z.string().min(1),
    // 비어 있는 요청은 서버에서도 거부한다.
    items: z.array(z.string().min(1)).min(1),
  }),
  output: z.object({
    seq: z.number(),
    itemCount: z.number(),
  }),
});
