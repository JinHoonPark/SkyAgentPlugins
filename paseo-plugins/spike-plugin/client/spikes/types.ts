import type { PluginHostProps } from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import type { SPIKE_ITEMS } from "../../shared/checklist";

/** 판정 화면이 패널에서 받는 값. 패널이 넘겨주는 것만 쓴다. */
export type SpikeScreenProps = Pick<PluginHostProps, "theme" | "layout">;

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
