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
  retryGraphSummaryRpc,
  resolveRoot,
  synthesizeStatus,
  type GraphAgentSnapshot,
  type GraphListItem,
  type GraphNodeShape,
} from "../shared/graphs";
import { observeGraphSummary, retryGraphSummary } from "./summary";

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
  edges: Array<{ from: string; to: string; dashed: boolean; label: string | null }>;
  labels: Record<string, string[]>;
  /** 모양을 표기한 노드만 담는다. 표기가 없는 노드는 rect다. */
  shapes: Record<string, GraphNodeShape>;
  nodeIds: string[];
};

type ListedAgent = GraphAgentSnapshot;

type LoadedGraph = {
  name: string;
  rows: ParsedGraphRow[];
  mermaid: ParsedMermaid;
};

export async function findGraphByAgent(
  { directory, agentId }: RpcInput<typeof findGraphByAgentRpc>,
  context: PluginHandlerContext,
) {
  const graphs = listGraphs(directory);
  const listed = await context.paseo.agents.list();
  const agents = new Map<string, ListedAgent>();
  for (const entry of listed.entries) {
    agents.set(entry.agent.id, entry.agent);
  }

  const parsed = new Map<string, LoadedGraph>();
  const matched: GraphFile[] = [];
  for (const graph of graphs) {
    const loaded = loadParsedGraph(directory, graph.name);
    parsed.set(graph.name, loaded);
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
    matched.push(graph);
  }
  // sort is stable, so equal mtimes keep the readdir order the single-pick loop used to keep.
  matched.sort((left, right) => right.mtime - left.mtime);

  const selected =
    matched.length > 0 ? matched.map((graph) => ({ graph, fallback: false })) : fallbackPick(graphs);

  // 매칭 또는 폴백으로 고른 그래프만 요약 대상이다. 반환 목록 밖 그래프는 요약하지 않는다.
  const items: GraphListItem[] = selected.map(({ graph, fallback }) => {
    const loaded = parsed.get(graph.name) ?? loadParsedGraph(directory, graph.name);
    return {
      name: graph.name,
      fallback,
      ...observeGraphSummary(directory, graph.name, loaded.rows, loaded.mermaid),
    };
  });

  return { names: items.map((item) => item.name), items };
}

/**
 * 요청받은 에이전트로 매칭되는 그래프가 하나도 없을 때만 쓰는 폴백.
 * 같은 요청 directory에서 실행 기록을 가진 실행 디렉터리 가운데 수정 시각이 가장 최신인 한 개를 고른다.
 */
function fallbackPick(graphs: GraphFile[]) {
  let newest: GraphFile | null = null;
  for (const graph of graphs) {
    if (newest == null || graph.mtime > newest.mtime) {
      newest = graph;
    }
  }
  return newest == null ? [] : [{ graph: newest, fallback: true }];
}

/** `[ 다시 시도 ]` 버튼이 부르는 자리. 지정한 그래프를 첫 단계·후보 처음부터 다시 만든다. */
export function retryGraphSummaryHandler({ directory, name }: RpcInput<typeof retryGraphSummaryRpc>) {
  const loaded = loadParsedGraph(directory, name);
  return retryGraphSummary(directory, loaded.name, loaded.rows, loaded.mermaid);
}

type GraphFile = { name: string; mtime: number };

function listGraphs(directory: string): GraphFile[] {
  const orchestrationDir = join(resolve(directory), ".skywork", "paseo-orchestration");
  if (!existsSync(orchestrationDir)) {
    return [];
  }

  const graphs: GraphFile[] = [];
  for (const entry of readdirSync(orchestrationDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const graphFile = join(orchestrationDir, entry.name, "GRAPH.md");
    if (existsSync(graphFile)) {
      graphs.push({ name: entry.name, mtime: statSync(graphFile).mtimeMs });
    }
  }
  return graphs;
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
    return { edges: [], labels: {}, shapes: {}, nodeIds: [] };
  }

  const labels: Record<string, string[]> = {};
  const shapes: Record<string, GraphNodeShape> = {};
  const nodeIds: string[] = [];
  const seenNodes = new Set<string>();
  const edges: Array<{ from: string; to: string; dashed: boolean; label: string | null }> = [];
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
      if (token != null && token.kind === "node" && token.shape === "hexagon") {
        shapes[token.id] = "hexagon";
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
        edges.push({ from: from.id, to: to.id, dashed: arrow.dashed, label: arrow.label });
      }
    }
  }

  return { edges, labels, shapes, nodeIds };
}

type MermaidToken =
  | { kind: "node"; id: string; label: string | null; shape: GraphNodeShape }
  | { kind: "arrow"; dashed: boolean; label: string | null };

const NODE_ID_RE = /[A-Za-z][A-Za-z0-9_]*/y;
// Mermaid의 엣지 연산자. 라벨을 포함한 표기가 앞에 와야 `-->` 같은 짧은 표기가 먼저 먹지 않는다.
// 라벨 표기가 있는 셋은 라벨 자리를 캡처 그룹으로 갖고, `-.->`·`-->`는 라벨이 없다.
const ARROW_PATTERNS: ReadonlyArray<{ pattern: RegExp; dashed: boolean }> = [
  { pattern: /-->\s*\|([^|]*)\|/, dashed: false }, // -->|라벨|
  { pattern: /-\.->/, dashed: true }, // -.->
  { pattern: /-\.\s*("(?:[^"\\]|\\.)*"|.*?)\s*\.->/, dashed: true }, // -. 라벨 .->
  { pattern: /-->/, dashed: false }, // -->
  { pattern: /--\s*("(?:[^"\\]|\\.)*"|.*?)\s*-->/, dashed: false }, // -- 라벨 -->
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
      tokens.push({ kind: "node", id: node.id, label: node.label, shape: node.shape });
      index = node.end;
      continue;
    }

    const arrow = readMermaidArrow(line, index);
    if (arrow != null) {
      tokens.push({ kind: "arrow", dashed: arrow.dashed, label: arrow.label });
      index = arrow.end;
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
  let shape: GraphNodeShape = "rect";

  if (line.startsWith("{{", index)) {
    const body = readShapeBody(line, index + 2, "}}");
    if (body != null) {
      label = body.value;
      index = body.end;
      shape = "hexagon";
    }
  } else if (line[index] === "[") {
    const body = readShapeBody(line, index + 1, "]");
    if (body != null) {
      label = body.value;
      index = body.end;
    }
  }

  return { id, label, shape, end: index };
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
  for (const { pattern, dashed } of ARROW_PATTERNS) {
    pattern.lastIndex = start;
    const match = pattern.exec(line);
    if (match != null && match.index === start) {
      return { end: start + match[0].length, dashed, label: readArrowLabel(match[1]) };
    }
  }
  return null;
}

/** 엣지 표기에서 캡처한 라벨 자리. 따옴표로 감싼 표기는 따옴표를 벗기고, 빈 자리는 라벨 없음으로 본다. */
function readArrowLabel(raw: string | undefined) {
  if (raw == null) {
    return null;
  }
  const text = raw.trim();
  const unquoted =
    text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1).trim() : text;
  return unquoted.length === 0 ? null : unquoted;
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
      status: synthesizeStatus(row.tableStatus, snapshot),
      fromTable: true,
      labelLines: mermaidLines && mermaidLines.length > 0 ? mermaidLines : [row.profile],
      shape: mermaid.shapes[row.id] ?? "rect",
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
      shape: mermaid.shapes[id] ?? "rect",
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

function loadParsedGraph(directory: string, name: string): LoadedGraph {
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
