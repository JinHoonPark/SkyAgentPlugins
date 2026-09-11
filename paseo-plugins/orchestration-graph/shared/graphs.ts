import { defineRpc, type RpcOutput } from "@getpaseo/plugin";
import { z } from "zod";

export const GRAPH_WAITING_LABEL = "작업 대기중" as const;

export const findGraphByAgentRpc = defineRpc({
  name: "graphs.find-by-agent",
  input: z.object({ directory: z.string(), agentId: z.string() }),
  output: z.object({ name: z.string().nullable() }),
});

export const graphNodeStatus = z.enum(["대기", "실행 중", "완료", "실패"]);

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
    }),
  ),
  edges: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
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
export type GraphView = RpcOutput<typeof getGraphRpc>;

export function graphFileEquals(left: GraphView | null, right: GraphView) {
  return left != null && JSON.stringify(left) === JSON.stringify(right);
}

export function layoutSignature(
  rootId: string | null,
  nodes: Array<{ id: string; labelLines: string[] }>,
  edges: Array<{ from: string; to: string }>,
  compact: boolean,
) {
  return JSON.stringify({
    compact,
    rootId,
    nodes: nodes.map((node) => [node.id, node.labelLines.length]),
    edges: edges.map((edge) => [edge.from, edge.to]),
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
  agentId: string | null,
  tableStatus: string,
  snapshot: GraphAgentSnapshot | undefined,
): GraphNodeStatus {
  if (agentId == null) {
    return "대기";
  }
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
    if (tableStatus === "완료" || tableStatus === "실패") {
      return tableStatus;
    }
    return "실행 중";
  }
  return asDisplayStatus(tableStatus);
}

export function foldNodeStatuses(statuses: GraphNodeStatus[]): GraphNodeStatus {
  if (statuses.some((status) => status === "실패")) {
    return "실패";
  }
  if (statuses.every((status) => status === "완료")) {
    return "완료";
  }
  if (statuses.every((status) => status === "대기")) {
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
    status: synthesizeStatus(lead.id, tableStatus, lead),
  };
}

function asDisplayStatus(tableStatus: string): GraphNodeStatus {
  if (tableStatus === "대기" || tableStatus === "실행 중" || tableStatus === "완료" || tableStatus === "실패") {
    return tableStatus;
  }
  return "대기";
}
