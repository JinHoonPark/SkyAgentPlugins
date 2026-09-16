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
  const graphNames = listGraphNames(directory);
  const listed = await context.paseo.agents.list();
  const agents = new Map<string, ListedAgent>();
  for (const entry of listed.entries) {
    agents.set(entry.agent.id, entry.agent);
  }
  const matched: Array<{ name: string; mtime: number }> = [];
  for (const name of graphNames) {
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
    matched.push({ name, mtime: statSync(graphFile).mtimeMs });
  }
  // sort is stable, so equal mtimes keep the readdir order the single-pick loop used to keep.
  matched.sort((left, right) => right.mtime - left.mtime);
  return { names: matched.map((entry) => entry.name) };
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
    const tokens = tokenizeMermaidLine(line);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token != null && token.kind === "node" && token.label != null) {
        addNode(token.id);
        if (labels[token.id] == null) {
          labels[token.id] = token.label.split("<br/>");
        }
      }

      const from = tokens[i];
      const arrow = tokens[i + 1];
      const to = tokens[i + 2];
      if (
        from == null ||
        from.kind !== "node" ||
        arrow == null ||
        arrow.kind !== "arrow" ||
        to == null ||
        to.kind !== "node"
      ) {
        continue;
      }
      addNode(from.id);
      addNode(to.id);
      const key = from.id + "\0" + to.id;
      if (!seenEdges.has(key)) {
        seenEdges.add(key);
        edges.push({ from: from.id, to: to.id });
      }
    }
  }

  return { edges, labels, nodeIds };
}

type MermaidToken = { kind: "node"; id: string; label: string | null } | { kind: "arrow" };

const NODE_ID_RE = /[A-Za-z][A-Za-z0-9_]*/y;
// Mermaid의 엣지 연산자. 라벨을 포함한 표기가 앞에 와야 `-->` 같은 짧은 표기가 먼저 먹지 않는다.
const ARROW_PATTERNS: RegExp[] = [
  /-->\s*\|[^|]*\|/, // -->|라벨|
  /-\.->/, // -.->
  /-\.\s*(?:"(?:[^"\\]|\\.)*"|.*?)\s*\.->/, // -. 라벨 .->
  /-->/, // -->
  /--\s*(?:"(?:[^"\\]|\\.)*"|.*?)\s*-->/, // -- 라벨 -->
];

function tokenizeMermaidLine(line: string): MermaidToken[] {
  const tokens: MermaidToken[] = [];
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (char === " " || char === "\t") {
      index++;
      continue;
    }
    if (char === "%") {
      break; // 주석
    }

    const node = readMermaidNode(line, index);
    if (node != null) {
      tokens.push({ kind: "node", id: node.id, label: node.label });
      index = node.end;
      continue;
    }

    const arrowEnd = readMermaidArrow(line, index);
    if (arrowEnd != null) {
      tokens.push({ kind: "arrow" });
      index = arrowEnd;
      continue;
    }

    index++;
  }
  return tokens;
}

function readMermaidNode(line: string, start: number) {
  NODE_ID_RE.lastIndex = start;
  const match = NODE_ID_RE.exec(line);
  if (match == null || match.index !== start) {
    return null;
  }

  const id = match[0];
  let index = start + id.length;
  let label: string | null = null;

  if (line.startsWith("{{", index)) {
    const body = readShapeBody(line, index + 2, "}}");
    if (body != null) {
      label = body.value;
      index = body.end;
    }
  } else if (line[index] === "[") {
    const body = readShapeBody(line, index + 1, "]");
    if (body != null) {
      label = body.value;
      index = body.end;
    }
  }

  return { id, label, end: index };
}

function readShapeBody(line: string, start: number, close: string) {
  if (line[start] === '"') {
    const quoted = readQuoted(line, start);
    if (quoted == null || !line.startsWith(close, quoted.end)) {
      return null;
    }
    return { value: quoted.value, end: quoted.end + close.length };
  }

  const end = line.indexOf(close, start);
  if (end < 0) {
    return null;
  }
  return { value: line.slice(start, end), end: end + close.length };
}

function readQuoted(line: string, start: number) {
  let value = "";
  let index = start + 1;
  while (index < line.length) {
    const char = line[index];
    if (char === "\\" && index + 1 < line.length) {
      value += char + line[index + 1];
      index += 2;
      continue;
    }
    if (char === '"') {
      return { value, end: index + 1 };
    }
    value += char;
    index++;
  }
  return null;
}

function readMermaidArrow(line: string, start: number) {
  for (const pattern of ARROW_PATTERNS) {
    pattern.lastIndex = start;
    const match = pattern.exec(line);
    if (match != null && match.index === start) {
      return start + match[0].length;
    }
  }
  return null;
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
