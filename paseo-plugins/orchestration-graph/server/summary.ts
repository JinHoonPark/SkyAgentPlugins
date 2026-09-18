/**
 * 그래프 하나의 요약 두 자리(100자·30자)를 만들고 캐시에 남긴다.
 *
 * 생성 단계는 항상 둘이고 순차 실행한다. 첫 단계가 실패하면 둘째 단계는 시작하지 않는다.
 * 같은 그래프에 대해 동시에 도는 작업은 하나뿐이고, 진행 중에 입력이 바뀌면 그 변화들은
 * 진행 중인 작업이 끝난 뒤 가장 최신 입력 하나로 한 번만 합쳐진다.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LIST_SUMMARY_MAX_CHARS, SUMMARY_MAX_CHARS, type GraphSummaryPhase } from "../shared/graphs";
import type { ParsedGraphRow, ParsedMermaid } from "./graphs";
import { CANDIDATE_TIMEOUT_MS, cleanCandidateText, generate } from "./models";

/**
 * 100자 단계 프롬프트가 노리는 길이. 상한에 딱 맞추라고 하면 실제 모델은 자주 넘긴다.
 * 상한보다 낮은 목표를 주어야 상한 안에 들어온다.
 */
const SUMMARY_TARGET_CHARS = 70;

/** 캐시 파일 이름. 그래프 디렉터리마다 한 개다. */
const CACHE_FILE = ".summary-cache.json";

/** 한 노드의 요약 입력. 상태는 노드 표의 `상태` 칸 값만 쓴다. */
type SummaryNode = {
  id: string;
  /** 노드가 무슨 작업인지 적은 한 줄. 어디에도 없으면 빈 문자열(작업 내용 미기재)이다. */
  task: string;
  /** 노드 표의 `상태` 칸 원문. 표에 그 노드가 없으면 빈 문자열(미기재)이다. */
  status: string;
};

export type SummaryInput = {
  graphName: string;
  nodes: SummaryNode[];
  /** mermaid 노드 라벨. 노드 ID별 라벨 줄들이다. */
  mermaidLabels: Array<{ id: string; lines: string[] }>;
};

export type SummaryObservation = {
  summary: string | null;
  listSummary: string | null;
  summaryPhase: GraphSummaryPhase;
  summaryFresh: boolean;
};

type CacheEntry = { text: string; createdAt: number };
type SummaryCache = { signature: string; summary: CacheEntry; listSummary: CacheEntry };

type GraphJobState = {
  running: { signature: string } | null;
  /** 진행 중에 들어온 가장 최신 입력. 작업이 끝나면 이 하나로 한 번만 다시 만든다. */
  pending: { signature: string; input: SummaryInput } | null;
  /** 후보를 모두 거치고도 만들지 못한 서명. 같은 서명으로는 자동으로 다시 부르지 않는다. */
  failed: string | null;
  /**
   * 마지막으로 만들어 낸 서명과 그 두 요약, 그리고 그것을 캐시 파일에도 남겼는지.
   * 캐시를 쓰지 못했을 때만 이 값을 쓴다. 캐시가 지워지거나 깨진 경우에는 그 사실을 모르므로
   * 파일을 다시 만들도록 생성을 한 번 더 돌린다.
   */
  done: { signature: string; summary: string; listSummary: string; persisted: boolean } | null;
};

const jobs = new Map<string, GraphJobState>();

// ── 요약 입력과 서명 ────────────────────────────────────────────────────────

/** 표의 행과 mermaid 노드를 합친 목록에서 요약 입력을 만든다. */
export function buildSummaryInput(
  graphName: string,
  rows: ParsedGraphRow[],
  mermaid: ParsedMermaid,
): SummaryInput {
  const nodes: SummaryNode[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    nodes.push({
      id: row.id,
      task: taskPhrase(mermaid.labels[row.id], row.profile),
      status: row.tableStatus,
    });
    seen.add(row.id);
  }
  for (const id of mermaid.nodeIds) {
    if (seen.has(id)) {
      continue;
    }
    nodes.push({ id, task: taskPhrase(mermaid.labels[id], ""), status: "" });
    seen.add(id);
  }

  const mermaidLabels: SummaryInput["mermaidLabels"] = [];
  for (const node of nodes) {
    const lines = mermaid.labels[node.id];
    if (lines != null && lines.length > 0) {
      mermaidLabels.push({ id: node.id, lines });
    }
  }

  return { graphName, nodes, mermaidLabels };
}

/**
 * 요약 무효화 서명. 노드 ID·작업 문구·표 상태만 넣는다.
 * 모델명이나 프로필 이름 같은 라벨의 메타데이터, agentId, 표의 행 순서, 파일 수정 시각은 넣지 않는다.
 */
export function summarySignature(input: SummaryInput) {
  const canonical = JSON.stringify(
    input.nodes
      .map((node) => [node.id, node.task, node.status])
      .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

/** mermaid 라벨 셋째 줄부터를 합친 문구, 프로필 칸의 ` — ` 뒤 문구 순으로 처음 얻어지는 값. */
function taskPhrase(labelLines: string[] | undefined, profile: string) {
  if (labelLines != null && labelLines.length > 2) {
    const fromLabel = labelLines.slice(2).join(" ").trim();
    if (fromLabel.length > 0) {
      return fromLabel;
    }
  }
  const separator = profile.indexOf(" — ");
  if (separator >= 0) {
    const fromProfile = profile.slice(separator + " — ".length).trim();
    if (fromProfile.length > 0) {
      return fromProfile;
    }
  }
  return "";
}

// ── 캐시 파일 ───────────────────────────────────────────────────────────────

function cachePath(directory: string, name: string) {
  return join(resolve(directory), ".skywork", "paseo-orchestration", name, CACHE_FILE);
}

/** 없거나 깨졌으면 캐시가 없는 것으로 본다. 읽기 실패도 같은 경로를 쓴다. */
function readCache(path: string): SummaryCache | null {
  try {
    if (!existsSync(path)) {
      return null;
    }
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isCache(parsed)) {
      return null;
    }
    return {
      signature: parsed.signature,
      summary: { ...parsed.summary, text: cleanCandidateText(parsed.summary.text, SUMMARY_MAX_CHARS) },
      listSummary: { ...parsed.listSummary, text: cleanCandidateText(parsed.listSummary.text, LIST_SUMMARY_MAX_CHARS) },
    };
  } catch {
    return null;
  }
}

function isCache(value: unknown): value is SummaryCache {
  if (value == null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<SummaryCache>;
  return (
    typeof candidate.signature === "string" &&
    isEntry(candidate.summary) &&
    isEntry(candidate.listSummary)
  );
}

function isEntry(value: unknown): value is CacheEntry {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as CacheEntry).text === "string" &&
    typeof (value as CacheEntry).createdAt === "number"
  );
}

/** 캐시 쓰기 실패는 그래프 조회와 캔버스를 막지 않는다. 진단만 stderr로 남기고 결과를 알린다. */
function writeCache(path: string, cache: SummaryCache) {
  try {
    writeFileSync(path, JSON.stringify(cache), "utf8");
    return true;
  } catch (error) {
    console.error(
      "[orchestration-graph] summary cache write failed: " +
        (error instanceof Error ? error.message : String(error)),
    );
    return false;
  }
}

// ── 그래프별 작업 ───────────────────────────────────────────────────────────

/**
 * 목록 조회가 부르는 자리. 지금 입력의 서명과 캐시를 견주어 요약 상태를 돌려주고,
 * 만들 대상이면 생성을 시작한다. 생성이 끝나기를 기다리지 않는다.
 */
export function observeGraphSummary(
  directory: string,
  name: string,
  rows: ParsedGraphRow[],
  mermaid: ParsedMermaid,
): SummaryObservation {
  const input = buildSummaryInput(name, rows, mermaid);
  const signature = summarySignature(input);
  const path = cachePath(directory, name);
  const cache = readCache(path);
  const started = jobs.get(path);
  const memory = started?.done != null && !started.done.persisted ? started.done : null;
  // 저장하지 못한 최신 성공 쌍도 생성 중·최종 실패 응답에서 함께 보존한다.
  const stored = memory != null
    ? { summary: memory.summary, listSummary: memory.listSummary }
    : cache == null ? { summary: null, listSummary: null } : storedSummaries(cache);

  if (started != null && started.running != null) {
    // 실행 입력으로 복귀하면 중간 관측을 버리고, 다르면 최신 입력 하나만 기억한다.
    started.pending = started.running.signature === signature ? null : { signature, input };
    return { ...stored, summaryPhase: "generating", summaryFresh: false };
  }

  if (started?.failed === signature) {
    return { ...stored, summaryPhase: "failed", summaryFresh: false };
  }

  if ((memory?.signature ?? cache?.signature) === signature) {
    return { ...stored, summaryPhase: "ready", summaryFresh: true };
  }

  const state = jobState(path);
  startJob(directory, name, path, signature, input, state);
  return { ...stored, summaryPhase: "generating", summaryFresh: false };
}

/**
 * `[ 다시 시도 ]` 버튼이 부르는 자리. 그 그래프를 첫 단계부터 후보 순서의 처음부터 다시 만든다.
 * 이미 도는 작업이 있으면 새로 시작하지 않는다.
 */
export function retryGraphSummary(
  directory: string,
  name: string,
  rows: ParsedGraphRow[],
  mermaid: ParsedMermaid,
) {
  const input = buildSummaryInput(name, rows, mermaid);
  const signature = summarySignature(input);
  const path = cachePath(directory, name);
  const state = jobState(path);

  if (state.running != null) {
    return { started: false };
  }

  state.failed = null;
  startJob(directory, name, path, signature, input, state);
  return { started: true };
}

function storedSummaries(cache: SummaryCache) {
  return { summary: cache.summary.text, listSummary: cache.listSummary.text };
}

function jobState(path: string): GraphJobState {
  const existing = jobs.get(path);
  if (existing != null) {
    return existing;
  }
  const state: GraphJobState = { running: null, pending: null, failed: null, done: null };
  jobs.set(path, state);
  return state;
}

function startJob(
  directory: string,
  name: string,
  path: string,
  signature: string,
  input: SummaryInput,
  state: GraphJobState,
) {
  state.running = { signature };
  state.pending = null;
  void runJob(directory, name, path, signature, input, state);
}

async function runJob(
  directory: string,
  name: string,
  path: string,
  signature: string,
  input: SummaryInput,
  state: GraphJobState,
) {
  let created: { summary: string; listSummary: string } | null = null;
  try {
    created = await createSummaries(name, input);
  } catch (error) {
    // 후보 전체 실패는 여기서 끝난다. 예외를 RPC 밖으로 밀어내지 않는다.
    console.log(
      "[orchestration-graph] summary.graph graph=" +
        name +
        " ok=false reason=" +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  if (created != null) {
    const createdAt = Date.now();
    const persisted = writeCache(path, {
      signature,
      summary: { text: created.summary, createdAt },
      listSummary: { text: created.listSummary, createdAt },
    });
    state.done = { signature, summary: created.summary, listSummary: created.listSummary, persisted };
    console.log(
      "[orchestration-graph] summary.graph graph=" +
        name +
        " ok=true summaryChars=" +
        [...created.summary].length +
        " listSummaryChars=" +
        [...created.listSummary].length,
    );
  } else {
    state.failed = signature;
  }

  state.running = null;
  const pending = state.pending;
  state.pending = null;
  if (pending != null && pending.signature !== signature) {
    // 진행 중에 들어온 변화를 가장 최신 입력 하나로 접어 한 번만 다시 만든다.
    startJob(directory, name, path, pending.signature, pending.input, state);
  }
}

/** 100자 요약을 만든 뒤, 그 100자 요약만 입력으로 30자 목록 요약을 만든다. */
async function createSummaries(name: string, input: SummaryInput) {
  const summary = await callStage(1, name, summaryPrompt(input), SUMMARY_MAX_CHARS);
  const listSummary = await callStage(2, name, listSummaryPrompt(summary), LIST_SUMMARY_MAX_CHARS);
  return { summary, listSummary };
}

async function callStage(stage: number, name: string, prompt: string, maxChars: number) {
  console.log(
    "[orchestration-graph] summary.stage stage=" +
      stage +
      " graph=" +
      name +
      " maxChars=" +
      maxChars +
      " input=" +
      JSON.stringify(prompt),
  );
  return generate({ prompt, maxChars, timeoutMs: CANDIDATE_TIMEOUT_MS });
}

// ── 프롬프트 ────────────────────────────────────────────────────────────────
// 한 호출에는 지시를 하나만 준다. 30자를 만드는 호출의 입력은 100자 요약 하나뿐이다.

function summaryPrompt(input: SummaryInput) {
  const nodeLines = input.nodes.map((node) => {
    const task = node.task.length > 0 ? node.task : "미기재";
    const status = node.status.trim().length > 0 ? node.status : "미기재";
    return "- " + node.id + " | 작업: " + task + " | 상태: " + status;
  });
  const labelLines = input.mermaidLabels.map((label) => label.id + ": " + label.lines.join(" / "));

  return [
    "오케스트레이션 그래프의 지금 작업 상태를 한국어로 요약한다.",
    "",
    "지킬 것:",
    "- " +
      SUMMARY_MAX_CHARS +
      "자 이하(공백과 문장부호 포함)로 쓴다. 넘기면 그 답은 쓰지 못한다. " +
      SUMMARY_TARGET_CHARS +
      "자 안팎을 목표로 한다.",
    "- 그래프 이름이나 노드 ID를 문장에 넣지 않는다. 노드가 하는 일만 적는다.",
    "- 노드마다 상태를 따로 적지 않는다. 완료된 일, 실패한 일, 아직 안 끝난 일을 묶어 한 번씩만 적는다.",
    '- 높임말을 쓰지 않는다. "했다", "이다"처럼 짧게 끝낸다.',
    "- 마크다운, 제목 줄, 목록 기호, 굵게 표기, 따옴표, 코드 표기를 쓰지 않는다. 요약 문장만 그대로 출력한다.",
    "- 입력에 없는 사실을 단정하지 않는다. 근거가 없으면 모른다고 적는다.",
    "- `생략` 상태 노드는 완료로도 실패로도 적지 않는다. 이름만 적고 뜻은 풀어 쓰지 않는다.",
    "",
    "그래프 이름: " + input.graphName,
    "",
    "노드 표:",
    ...(nodeLines.length > 0 ? nodeLines : ["- 없음"]),
    "",
    "mermaid 노드 라벨:",
    ...(labelLines.length > 0 ? labelLines : ["- 없음"]),
  ].join("\n");
}

function listSummaryPrompt(summary: string) {
  return [
    "다음 한국어 요약을 목록에 표시할 짧은 한 문장으로 줄인다.",
    "",
    "지킬 것:",
    "- 여러 노드를 다 적지 말고 가장 중요한 진행 상황 하나만 남긴다.",
    "- 마크다운, 제목 줄, 목록 기호, 굵게 표기, 따옴표, 코드 표기를 쓰지 않는다. 줄인 문장만 그대로 출력한다.",
    "- 원문에 없는 사실을 더하지 않는다.",
    "",
    "원문: " + summary,
  ].join("\n");
}
