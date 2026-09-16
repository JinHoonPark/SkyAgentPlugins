import { randomUUID } from "node:crypto";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  requestSpikeCheckRpc,
  spikeTimelineKind,
  spikeTimelineVersion,
} from "../shared/checklist";

/**
 * 선택된 항목을 그 에이전트의 타임라인에 확인 요청 행으로 추가한다.
 * 행 본문은 요청 내용뿐이며, 확인 결과는 기록하지 않는다.
 */
export async function requestSpikeCheck(
  { agentId, items }: RpcInput<typeof requestSpikeCheckRpc>,
  context: PluginHandlerContext,
) {
  const appended = await context.paseo.agents.ref(agentId).timeline.append({
    type: "plugin",
    // 행마다 새 id를 쓴다. 같은 id를 재사용하면 이전 요청 행이 교체된다.
    id: randomUUID(),
    kind: spikeTimelineKind,
    version: spikeTimelineVersion,
    data: { items },
  });
  return { seq: appended.seq, itemCount: items.length };
}
