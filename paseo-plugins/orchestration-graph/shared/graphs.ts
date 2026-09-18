import { defineRpc, type RpcOutput } from "@getpaseo/plugin";
import { z } from "zod";

export const GRAPH_WAITING_LABEL = "작업 대기중" as const;

/** 요약을 만들지 못한 그래프에 붙는 문구. 목록 항목과 요약란이 이 값을 쓴다. */
export const GRAPH_SUMMARY_FAILED_LABEL = "요약 모델 연결 안 됨." as const;

export const SUMMARY_MAX_CHARS = 100;
/** 목록 요약의 제품 목표는 30자이며, 내부 수용 상한만 35자다. 모델 지시에는 넣지 않는다. */
export const LIST_SUMMARY_MAX_CHARS = 35;

/**
 * 한 그래프의 요약 상태.
 *
 * - `missing` — 저장된 요약이 없고 지금 만드는 작업도 없다.
 * - `generating` — 지금 입력의 요약을 만드는 중이다. 저장된 옛 요약이 있어도 그 사이에는 보여 주지 않는다.
 * - `ready` — 저장된 두 요약이 지금 입력과 같다.
 * - `failed` — 지금 입력의 후보를 모두 거치고도 만들지 못했다. 저장된 옛 요약은 지워지지 않는다.
 */
export const graphSummaryPhase = z.enum(["missing", "generating", "ready", "failed"]);

/** 목록 항목 하나의 그래프 정보. 요약 두 자리의 글과 그 요약들의 최신 여부를 함께 돌려준다. */
export const graphListItem = z.object({
  name: z.string(),
  /** 매칭 후보가 없어 요청 directory의 실행 기록 최신 한 개로 골라낸 그래프인지. */
  fallback: z.boolean(),
  /** 요약란에 보이는 100자 요약. 아직 만든 적이 없으면 null. */
  summary: z.string().refine((text) => [...text].length <= SUMMARY_MAX_CHARS).nullable(),
  /** 목록 항목 둘째 줄 요약. 30자 목표·내부 35자 상한이며 아직 만든 적이 없으면 null. */
  listSummary: z.string().refine((text) => [...text].length <= LIST_SUMMARY_MAX_CHARS).nullable(),
  summaryPhase: graphSummaryPhase,
  /** 저장된 두 요약이 지금 입력과 같아 다시 만들 필요가 없는지. */
  summaryFresh: z.boolean(),
});

export const findGraphByAgentRpc = defineRpc({
  name: "graphs.find-by-agent",
  input: z.object({ directory: z.string(), agentId: z.string() }),
  // Newest first, so the first entry is the graph the panel shows before the user picks one.
  // `names`는 이름만 쓰던 기존 소비자를 위해 남긴 목록이고 `items`가 같은 순서의 확장 정보다.
  output: z.object({
    names: z.array(z.string()),
    items: z.array(graphListItem),
  }),
});

/** 목록 항목의 `[ 다시 시도 ]` 버튼이 부르는 RPC. 그 그래프를 첫 단계·후보 처음부터 다시 만든다. */
export const retryGraphSummaryRpc = defineRpc({
  name: "graphs.summary.retry",
  input: z.object({ directory: z.string(), name: z.string() }),
  output: z.object({ started: z.boolean() }),
});

export const graphNodeStatus = z.enum(["대기", "실행 중", "완료", "실패", "생략"]);

/** Mermaid 노드 표기에서 읽은 모양. `ID["..."]`는 rect, `ID{{"..."}}`는 hexagon이다. */
export const graphNodeShape = z.enum(["rect", "hexagon"]);

const graphRpcInput = z.object({
  directory: z.string(),
  name: z.string(),
});

const graphViewOutput = z.object({
  name: z.string(),
  waiting: z.boolean(),
  root: z
    .object({
      id: z.string(),
      name: z.string(),
      status: graphNodeStatus,
    })
    .nullable(),
  nodes: z.array(
    z.object({
      id: z.string(),
      profile: z.string(),
      tableStatus: z.string(),
      agentId: z.string().nullable(),
      displayName: z.string(),
      status: graphNodeStatus.nullable(),
      fromTable: z.boolean(),
      labelLines: z.array(z.string()),
      shape: graphNodeShape,
    }),
  ),
  edges: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      dashed: z.boolean(),
      label: z.string().nullable(),
    }),
  ),
});

export const getGraphRpc = defineRpc({
  name: "graphs.get",
  input: graphRpcInput,
  output: graphViewOutput,
});

export const readGraphFileRpc = defineRpc({
  name: "graphs.read",
  input: graphRpcInput,
  output: graphViewOutput,
});

export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

export type GraphNodeStatus = z.infer<typeof graphNodeStatus>;
export type GraphNodeShape = z.infer<typeof graphNodeShape>;
export type GraphSummaryPhase = z.infer<typeof graphSummaryPhase>;
export type GraphListItem = z.infer<typeof graphListItem>;
export type GraphView = RpcOutput<typeof getGraphRpc>;

export function graphFileEquals(left: GraphView | null, right: GraphView) {
  return left != null && JSON.stringify(left) === JSON.stringify(right);
}

/** 배치와 선 그리기의 입력. 이 값이 그대로면 `layoutGraph`를 다시 돌리지 않고 앞 결과를 그대로 그린다. */
export function layoutSignature(
  rootId: string | null,
  nodes: Array<{ id: string; labelLines: string[]; shape: GraphNodeShape }>,
  edges: Array<{ from: string; to: string; dashed: boolean; label: string | null }>,
  compact: boolean,
) {
  return JSON.stringify({
    compact,
    rootId,
    nodes: nodes.map((node) => [node.id, node.labelLines.length, node.shape]),
    edges: edges.map((edge) => [edge.from, edge.to, edge.label, edge.dashed]),
  });
}

export type GraphAgentSnapshot = {
  id: string;
  title: string | null;
  status: "initializing" | "idle" | "running" | "error" | "closed";
  labels: Readonly<Record<string, string>>;
  requiresAttention?: boolean;
  attentionReason?: "finished" | "error" | "permission" | null;
};

export type GraphNodeRow = {
  id: string;
  profile: string;
  tableStatus: string;
  agentId: string | null;
};

export function displayName(
  profile: string,
  agentId: string | null,
  snapshot: GraphAgentSnapshot | undefined,
) {
  if (agentId == null) {
    return profile;
  }
  const title = snapshot?.title?.trim();
  if (title) {
    return title;
  }
  const fromLabel = snapshot?.labels.profile?.trim();
  if (fromLabel) {
    return fromLabel;
  }
  return profile;
}

export function synthesizeStatus(
  tableStatus: string,
  snapshot: GraphAgentSnapshot | undefined,
): GraphNodeStatus {
  if (snapshot == null) {
    return asDisplayStatus(tableStatus);
  }
  if (snapshot.status === "error") {
    return "실패";
  }
  if (snapshot.status === "running" || snapshot.status === "initializing") {
    return "실행 중";
  }
  if (snapshot.status === "idle" || snapshot.status === "closed") {
    const displayStatus = asDisplayStatus(tableStatus);
    if (displayStatus === "완료" || displayStatus === "실패") {
      return displayStatus;
    }
    return "실행 중";
  }
  return asDisplayStatus(tableStatus);
}

export function foldNodeStatuses(statuses: GraphNodeStatus[]): GraphNodeStatus {
  // 건너뛴 단계(생략)는 진행 판정에서 뺀다. 남는 상태가 없으면 전체도 생략으로 본다.
  const active = statuses.filter((status) => status !== "생략");
  if (active.length === 0) {
    return "생략";
  }
  if (active.some((status) => status === "실패")) {
    return "실패";
  }
  if (active.every((status) => status === "완료")) {
    return "완료";
  }
  if (active.every((status) => status === "대기")) {
    return "대기";
  }
  return "실행 중";
}

export function resolveRoot(
  rows: GraphNodeRow[],
  agents: Map<string, GraphAgentSnapshot>,
  nodeStatuses: GraphNodeStatus[],
) {
  const parentIds = new Set<string>();
  for (const row of rows) {
    if (row.agentId == null) {
      continue;
    }
    const snapshot = agents.get(row.agentId);
    const parentId = snapshot?.labels[PARENT_AGENT_ID_LABEL]?.trim();
    if (parentId) {
      parentIds.add(parentId);
    }
  }
  if (parentIds.size !== 1) {
    return null;
  }
  const parentId = [...parentIds][0];
  const lead = agents.get(parentId);
  if (lead == null) {
    return null;
  }
  const tableStatus = foldNodeStatuses(nodeStatuses);
  return {
    id: lead.id,
    name: displayName(lead.id, lead.id, lead),
    status: synthesizeStatus(tableStatus, lead),
  };
}

/** 표의 상태 칸에는 `완료 (판정: …)`처럼 괄호 주석이 붙을 수 있다. 괄호 주석을 떼고 남은 정식 상태어만 본다. */
function asDisplayStatus(tableStatus: string): GraphNodeStatus {
  const trimmed = tableStatus.replace(/\s*\(.*\)\s*$/, "").trim();
  if (
    trimmed === "대기" ||
    trimmed === "실행 중" ||
    trimmed === "완료" ||
    trimmed === "실패" ||
    trimmed === "생략"
  ) {
    return trimmed;
  }
  return "대기";
}
