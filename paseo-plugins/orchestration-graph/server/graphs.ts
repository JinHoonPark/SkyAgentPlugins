import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { getGraphRpc, listGraphsRpc } from "../shared/graphs";

const REQUIRED_COLUMNS = ["노드 ID", "프로필", "상태", "agentId"] as const;
const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

type DisplayStatus = RpcOutput<typeof getGraphRpc>["nodes"][number]["status"];

export type ParsedGraphRow = {
  id: string;
  profile: string;
  tableStatus: string;
  agentId: string | null;
};

export type ParseGraphTableResult =
  | { ok: true; rows: ParsedGraphRow[] }
  | { ok: false; missingColumns: string[] };

type ListedAgent = {
  id: string;
  title: string | null;
  status: "initializing" | "idle" | "running" | "error" | "closed";
  labels: Readonly<Record<string, string>>;
};

export function listGraphs({ directory }: RpcInput<typeof listGraphsRpc>) {
  const orchestrationDir = join(resolve(directory), ".skywork", "paseo-orchestration");
  if (!existsSync(orchestrationDir)) {
    return { names: [] };
  }

  const names: string[] = [];
  for (const entry of readdirSync(orchestrationDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (existsSync(join(orchestrationDir, entry.name, "GRAPH.md"))) {
      names.push(entry.name);
    }
  }
  return { names };
}

export function isGraphName(name: string) {
  return name.length > 0 && name !== "." && !name.includes("..") && !name.includes("/") && !name.includes("\\");
}

export function parseGraphTable(markdown: string): ParseGraphTableResult {
  const lines = markdown.split(/\r?\n/);
  let headerCells: string[] | null = null;
  let headerIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const cells = splitCells(lines[i]);
    if (cells.length === 0) {
      continue;
    }
    if (cells.includes("노드 ID")) {
      headerCells = cells;
      headerIndex = i;
      break;
    }
  }

  if (headerCells == null) {
    return { ok: false, missingColumns: [...REQUIRED_COLUMNS] };
  }

  const missingColumns = REQUIRED_COLUMNS.filter((column) => !headerCells.includes(column));
  if (missingColumns.length > 0) {
    return { ok: false, missingColumns };
  }

  const indexOf = {
    id: headerCells.indexOf("노드 ID"),
    profile: headerCells.indexOf("프로필"),
    tableStatus: headerCells.indexOf("상태"),
    agentId: headerCells.indexOf("agentId"),
  };

  const rows: ParsedGraphRow[] = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith("|")) {
      break;
    }
    const cells = splitCells(line);
    if (cells.length === 0) {
      break;
    }
    const id = cells[indexOf.id] ?? "";
    if (id.length === 0 || /^-+$/.test(id)) {
      continue;
    }
    const agentIdRaw = (cells[indexOf.agentId] ?? "").trim();
    rows.push({
      id,
      profile: cells[indexOf.profile] ?? "",
      tableStatus: cells[indexOf.tableStatus] ?? "",
      agentId: agentIdRaw.length === 0 ? null : agentIdRaw,
    });
  }

  return { ok: true, rows };
}

export function assembleGraph(
  name: string,
  rows: ParsedGraphRow[],
  listed: { entries: Array<{ agent: ListedAgent }> },
): RpcOutput<typeof getGraphRpc> {
  const agents = new Map<string, ListedAgent>();
  for (const entry of listed.entries) {
    agents.set(entry.agent.id, entry.agent);
  }

  const waiting = rows.every((row) => row.agentId == null);
  const nodes = rows.map((row) => {
    const snapshot = row.agentId == null ? undefined : agents.get(row.agentId);
    return {
      id: row.id,
      profile: row.profile,
      tableStatus: row.tableStatus,
      agentId: row.agentId,
      displayName: displayName(row.profile, row.agentId, snapshot),
      status: synthesizeStatus(row.agentId, row.tableStatus, snapshot),
    };
  });

  return {
    name,
    waiting,
    root: waiting ? null : resolveRoot(rows, agents, nodes.map((node) => node.status)),
    nodes,
  };
}

export async function getGraph(
  { directory, name }: RpcInput<typeof getGraphRpc>,
  context: PluginHandlerContext,
) {
  if (!isGraphName(name)) {
    throw new Error("invalid graph name: " + name);
  }

  const graphFile = join(resolve(directory), ".skywork", "paseo-orchestration", name, "GRAPH.md");
  if (!existsSync(graphFile)) {
    throw new Error(name + ": GRAPH.md not found");
  }

  const parsed = parseGraphTable(readFileSync(graphFile, "utf8"));
  if (!parsed.ok) {
    throw new Error(name + ": missing columns " + parsed.missingColumns.join(", "));
  }

  const listed = await context.paseo.agents.list();
  return assembleGraph(name, parsed.rows, listed);
}

function splitCells(line: string) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) {
    return [];
  }
  const parts = trimmed.split("|");
  const end = parts[parts.length - 1] === "" ? parts.length - 1 : parts.length;
  return parts.slice(1, end).map((cell) => cell.trim());
}

function displayName(profile: string, agentId: string | null, snapshot: ListedAgent | undefined) {
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

function synthesizeStatus(
  agentId: string | null,
  tableStatus: string,
  snapshot: ListedAgent | undefined,
): DisplayStatus {
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

function asDisplayStatus(tableStatus: string): DisplayStatus {
  if (tableStatus === "대기" || tableStatus === "실행 중" || tableStatus === "완료" || tableStatus === "실패") {
    return tableStatus;
  }
  return "대기";
}

function foldNodeStatuses(statuses: DisplayStatus[]): DisplayStatus {
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

function resolveRoot(
  rows: ParsedGraphRow[],
  agents: Map<string, ListedAgent>,
  nodeStatuses: DisplayStatus[],
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
