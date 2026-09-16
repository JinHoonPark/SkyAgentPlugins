import type { PluginHostProps } from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import type { SPIKE_ITEMS } from "../../shared/checklist";

/** 판정 화면이 패널에서 받는 값. 패널이 넘겨주는 것만 쓴다. */
export type SpikeScreenProps = Pick<PluginHostProps, "theme" | "layout">;

/**
 * 화면 상단에 싣는 판정 안내. 설계 원문(SPIKE.md)의 검증 질문·실험 절차·판정 기준을
 * 그 화면에 실제로 있는 조작을 가리키도록 줄인 것이다. 판정 자체는 하지 않는다.
 */
export interface SpikeGuide {
  /** 무엇을 확인하는가 — 그 스파이크의 검증 질문. */
  readonly question: string;
  /** 어떻게 보는가 — 화면에서 누르고 비교하는 것. */
  readonly how: string;
  /** 무엇이면 통과인가 — 판정 기준과 중단 기준. */
  readonly pass: string;
}

export interface SpikePrototype {
  /**
   * shared/checklist.ts의 SPIKE_ITEMS 항목 문자열과 같아야 한다.
   * 목록 문구가 바뀌면 여기서 타입 오류가 나므로 조용히 어긋나지 않는다.
   */
  readonly item: (typeof SPIKE_ITEMS)[number];
  /** 화면 상단에 붙는 이름. 판정 결과가 아니라 무엇을 보는 화면인지만 적는다. */
  readonly title: string;
  readonly Component: ComponentType<SpikeScreenProps>;
}
