import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  displayName,
  findGraphByAgentRpc,
  getGraphRpc,
  PARENT_AGENT_ID_LABEL,
  readGraphFileRpc,
  resolveRoot,
  synthesizeStatus,
  type GraphAgentSnapshot,
} from "../shared/graphs";

const REQUIRED_COLUMNS = ["노드 ID", "프로필", "상태", "agentId"] as const;

export type ParsedGraphRow = {
  id: string;
  profile: string;
  tableStatus: string;
  agentId: string | null;
};

export type ParseGraphTableResult =
  | { ok: true; rows: ParsedGraphRow[] }
  | { ok: false; missingColumns: string[] };

export type ParsedMermaid = {
  edges: Array<{ from: string; to: string }>;
  labels: Record<string, string[]>;
  nodeIds: string[];
};

type ListedAgent = GraphAgentSnapshot;

export async function findGraphByAgent(
  { directory, agentId }: RpcInput<typeof findGraphByAgentRpc>,
  context: PluginHandlerContext,
) {
  const names = listGraphNames(directory);
  const listed = await context.paseo.agents.list();
  const agents = new Map<string, ListedAgent>();
  for (const entry of listed.entries) {
    agents.set(entry.agent.id, entry.agent);
  }
  let matchedName: string | null = null;
  let matchedMtime = Number.NEGATIVE_INFINITY;
  for (const name of names) {
    const loaded = loadParsedGraph(directory, name);
    const inTable = loaded.rows.some((row) => row.agentId === agentId);
    const isParent = loaded.rows.some((row) => {
      if (row.agentId == null) {
        return false;
      }
      const snapshot = agents.get(row.agentId);
      return snapshot?.labels[PARENT_AGENT_ID_LABEL]?.trim() === agentId;
    });
    if (!inTable && !isParent) {
      continue;
    }
    const graphFile = join(resolve(directory), ".skywork", "paseo-orchestration", name, "GRAPH.md");
    const mtime = statSync(graphFile).mtimeMs;
    if (mtime > matchedMtime) {
      matchedMtime = mtime;
      matchedName = name;
    }
  }
  return { name: matchedName };
}

function listGraphNames(directory: string) {
  const orchestrationDir = join(resolve(directory), ".skywork", "paseo-orchestration");
  if (!existsSync(orchestrationDir)) {
    return [];
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
  return names;
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

export function parseMermaid(markdown: string): ParsedMermaid {
  const body = extractMermaidBody(markdown);
  if (body == null) {
    return { edges: [], labels: {}, nodeIds: [] };
  }

  const labels: Record<string, string[]> = {};
  const nodeIds: string[] = [];
  const seenNodes = new Set<string>();
  const edges: Array<{ from: string; to: string }> = [];
  const seenEdges = new Set<string>();

  const addNode = (id: string) => {
    if (!seenNodes.has(id)) {
      seenNodes.add(id);
      nodeIds.push(id);
    }
  };

  for (const line of body.split(/\r?\n/)) {
    const labelRe = /([A-Za-z][A-Za-z0-9_]*)\["((?:[^"\\]|\\.)*)"\]/g;
    for (const match of line.matchAll(labelRe)) {
      addNode(match[1]);
      if (labels[match[1]] == null) {
        labels[match[1]] = match[2].split("<br/>");
      }
    }
    const edgeRe = /([A-Za-z][A-Za-z0-9_]*)(?:\["(?:[^"\\]|\\.)*"\])?\s*-->\s*([A-Za-z][A-Za-z0-9_]*)/g;
    for (const match of line.matchAll(edgeRe)) {
      addNode(match[1]);
      addNode(match[2]);
      const key = match[1] + "\0" + match[2];
      if (!seenEdges.has(key)) {
        seenEdges.add(key);
        edges.push({ from: match[1], to: match[2] });
      }
    }
  }

  return { edges, labels, nodeIds };
}

export function assembleGraph(
  name: string,
  rows: ParsedGraphRow[],
  mermaid: ParsedMermaid,
  listed: { entries: Array<{ agent: ListedAgent }> },
): RpcOutput<typeof getGraphRpc> {
  const agents = new Map<string, ListedAgent>();
  for (const entry of listed.entries) {
    agents.set(entry.agent.id, entry.agent);
  }

  const waiting = rows.every((row) => row.agentId == null);
  const seen = new Set<string>();
  const nodes: RpcOutput<typeof getGraphRpc>["nodes"] = [];

  for (const row of rows) {
    const snapshot = row.agentId == null ? undefined : agents.get(row.agentId);
    const mermaidLines = mermaid.labels[row.id];
    nodes.push({
      id: row.id,
      profile: row.profile,
      tableStatus: row.tableStatus,
      agentId: row.agentId,
      displayName: displayName(row.profile, row.agentId, snapshot),
      status: synthesizeStatus(row.agentId, row.tableStatus, snapshot),
      fromTable: true,
      labelLines: mermaidLines && mermaidLines.length > 0 ? mermaidLines : [row.profile],
    });
    seen.add(row.id);
  }

  for (const id of mermaid.nodeIds) {
    if (seen.has(id)) {
      continue;
    }
    const mermaidLines = mermaid.labels[id];
    const labelLines = mermaidLines && mermaidLines.length > 0 ? mermaidLines : [id];
    nodes.push({
      id,
      profile: "",
      tableStatus: "",
      agentId: null,
      displayName: labelLines[0] ?? id,
      status: null,
      fromTable: false,
      labelLines,
    });
    seen.add(id);
  }

  const tableStatuses = nodes.flatMap((node) => (node.fromTable && node.status != null ? [node.status] : []));

  return {
    name,
    waiting,
    root: waiting ? null : resolveRoot(rows, agents, tableStatuses),
    nodes,
    edges: mermaid.edges,
  };
}

export function readGraphFile({ directory, name }: RpcInput<typeof readGraphFileRpc>) {
  const loaded = loadParsedGraph(directory, name);
  return assembleGraph(loaded.name, loaded.rows, loaded.mermaid, { entries: [] });
}

export async function getGraph(
  { directory, name }: RpcInput<typeof getGraphRpc>,
  context: PluginHandlerContext,
) {
  const loaded = loadParsedGraph(directory, name);
  const listed = await context.paseo.agents.list();
  return assembleGraph(loaded.name, loaded.rows, loaded.mermaid, listed);
}

function loadParsedGraph(directory: string, name: string) {
  if (!isGraphName(name)) {
    throw new Error("invalid graph name: " + name);
  }

  const graphFile = join(resolve(directory), ".skywork", "paseo-orchestration", name, "GRAPH.md");
  if (!existsSync(graphFile)) {
    throw new Error(name + ": GRAPH.md not found");
  }

  const markdown = readFileSync(graphFile, "utf8");
  const parsed = parseGraphTable(markdown);
  if (!parsed.ok) {
    throw new Error(name + ": missing columns " + parsed.missingColumns.join(", "));
  }

  return { name, rows: parsed.rows, mermaid: parseMermaid(markdown) };
}

function extractMermaidBody(markdown: string) {
  const start = markdown.search(/```mermaid\b/);
  if (start < 0) {
    return null;
  }
  const afterOpen = markdown.indexOf("\n", start);
  if (afterOpen < 0) {
    return null;
  }
  const close = markdown.indexOf("```", afterOpen + 1);
  if (close < 0) {
    return null;
  }
  return markdown.slice(afterOpen + 1, close);
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
