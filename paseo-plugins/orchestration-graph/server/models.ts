/**
 * 요약을 만드는 모델 호출. 생성 단계 하나가 이 모듈의 `generate` 하나를 부른다.
 *
 * 로컬 HTTP와 두 CLI 후보가 같은 순서와 실행 슬롯을 공유한다.
 */
import { CliCleanupError, runCliCandidate } from "./cli";

const DEFAULT_BASE_URL = "http://172.20.67.201:8000/v1";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_API_KEY = "EMPTY";

/** 로컬 후보의 엔드포인트 하나. `/v1/completions`나 `/v1/responses`로 바꾸지 않는다. */
const LOCAL_CHAT_PATH = "/chat/completions";
const LOCAL_MAX_TOKENS = 128;

/** 한 후보에 한 번 보낼 때의 상한. 후보가 실제로 시작된 뒤부터 센다. */
export const CANDIDATE_TIMEOUT_MS = 20000;

/** 모든 그래프를 합쳐 동시에 진행하는 후보 실행 수의 상한. */
const MAX_ACTIVE_CANDIDATES = 3;

/** 후보를 하나도 쓰지 못했을 때 `generate`가 던진다. 부르는 쪽은 이 실패를 그 단계의 실패로 본다. */
export class SummaryModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummaryModelError";
  }
}

/** 후보 하나가 실패한 까닭. 그 후보만 접고 다음 후보로 넘어간다. */
class CandidateError extends Error {}

export type GenerateOptions = {
  prompt: string;
  maxChars: number;
  timeoutMs: number;
  signal?: AbortSignal;
};

type LocalConfig = { baseUrl: string; model: string; apiKey: string };

/**
 * 로컬 접속 기본값을 모아 두는 한 곳. 같은 이름의 환경변수가 있으면 환경변수 값이 이긴다.
 */
export function localModelConfig(): LocalConfig {
  return {
    baseUrl: process.env.PASEO_ORCHESTRATION_GRAPH_LLM_BASE_URL?.trim() || DEFAULT_BASE_URL,
    model: process.env.PASEO_ORCHESTRATION_GRAPH_LLM_MODEL?.trim() || DEFAULT_MODEL,
    apiKey: process.env.PASEO_ORCHESTRATION_GRAPH_LLM_API_KEY?.trim() || DEFAULT_API_KEY,
  };
}

/**
 * 단계 하나를 만든다. 후보를 고정 순서로 한 번씩만 돌리고, 공통 출력 검사를 통과한 본문을 돌려준다.
 * 어느 후보로도 만들지 못하면 `SummaryModelError`를 던진다.
 */
export async function generate(options: GenerateOptions): Promise<string> {
  const failures: string[] = [];
  for (const candidate of candidates()) {
    const release = await acquireCandidateSlot();
    let releaseAllowed = true;
    try {
      const text = cleanCandidateText(await candidate.run(options), options.maxChars);
      logCall(candidate.name, "ok=true chars=" + [...text].length);
      return text;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logCall(candidate.name, "ok=false reason=" + reason);
      if (error instanceof CliCleanupError) {
        // 소유 프로세스 종료가 확인되지 않으면 슬롯과 후속 후보를 멈춘다.
        releaseAllowed = false;
        throw new SummaryModelError(reason);
      }
      failures.push(candidate.name + ": " + reason);
    } finally {
      if (releaseAllowed) release();
    }
  }
  throw new SummaryModelError("요약 후보가 모두 실패했습니다 (" + failures.join(", ") + ")");
}

type Candidate = { name: string; run: (options: GenerateOptions) => Promise<string> };

function candidates(): Candidate[] {
  return [
    { name: "local", run: runLocalCandidate },
    { name: "codex", run: (options) => runCliCandidate("codex", options) },
    { name: "claude", run: (options) => runCliCandidate("claude", options) },
  ];
}

// ── 후보 동시 수 ────────────────────────────────────────────────────────────
// 슬롯을 기다린 시간은 그 후보의 타임아웃에 들어가지 않는다. 슬롯을 얻은 뒤에 타이머를 건다.

let activeCandidates = 0;
const slotWaiters: Array<() => void> = [];

function acquireCandidateSlot(): Promise<() => void> {
  if (activeCandidates < MAX_ACTIVE_CANDIDATES) {
    activeCandidates += 1;
    return Promise.resolve(releaseCandidateSlot);
  }
  return new Promise((resolve) => {
    slotWaiters.push(() => {
      resolve(releaseCandidateSlot);
    });
  });
}

function releaseCandidateSlot() {
  const next = slotWaiters.shift();
  if (next != null) {
    // 기다리던 후보에 슬롯을 그대로 넘긴다. 활성 수는 그대로 두어 한도를 넘지 않는다.
    next();
    return;
  }
  activeCandidates -= 1;
}

// ── 로컬 HTTP 후보 ──────────────────────────────────────────────────────────

async function runLocalCandidate({ prompt, timeoutMs, signal }: GenerateOptions) {
  const config = localModelConfig();
  const url = config.baseUrl.replace(/\/+$/, "") + LOCAL_CHAT_PATH;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort);

  try {
    const body = JSON.stringify({
      model: config.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: LOCAL_MAX_TOKENS,
      stream: false,
    });

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + config.apiKey,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      throw new CandidateError(controller.signal.aborted ? "timeout" : connectionReason(error));
    }

    if (!response.ok) {
      throw new CandidateError("http " + response.status);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new CandidateError("invalid json");
    }

    return readCandidateContent(payload);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

function connectionReason(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? (error.cause as Error | undefined)?.message : undefined;
  return "connect " + (cause ?? message);
}

function readCandidateContent(payload: unknown): string {
  if (payload == null || typeof payload !== "object") {
    throw new CandidateError("invalid json");
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new CandidateError("missing choices[0].message.content");
  }
  const first = choices[0] as { message?: { content?: unknown } } | null;
  const content = first?.message?.content;
  if (typeof content !== "string") {
    throw new CandidateError("missing choices[0].message.content");
  }
  return content;
}

// ── 출력 정리와 제약 검사 ───────────────────────────────────────────────────
// 길이를 맞추려고 잘라내거나 문장을 덧붙이지 않는다. 정리 뒤에도 어기면 그 후보는 실패다.

/** 독립된 머리말 줄·굵게 표기·인라인 코드처럼 명백한 포장만 벗긴다. */
export function stripPackaging(raw: string) {
  let text = raw.replace(/\r\n?/g, "\n").trim();
  for (let round = 0; round < 4; round += 1) {
    const before = text;
    text = text
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*\n]+)\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/`([^`]+)`/g, "$1");
    if (text === before) {
      break;
    }
  }
  return dropLeadingHeadingLine(stripWrappingQuotes(text));
}

function stripWrappingQuotes(text: string) {
  const trimmed = text.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  const paired =
    (first === '"' && last === '"') ||
    (first === "'" && last === "'") ||
    (first === "“" && last === "”") ||
    (first === "‘" && last === "’");
  return paired ? trimmed.slice(1, -1).trim() : trimmed;
}

/** 본문 앞에 붙은 한 줄짜리 머리말은 포장이다. 본문 줄이 남아 있을 때만 떼어 낸다. */
function dropLeadingHeadingLine(text: string) {
  const lines = text.split("\n");
  if (lines.length < 2) {
    return text;
  }
  const first = lines[0].trim();
  const isHeading = /^#{1,6}\s+\S/.test(first) || (first.length <= 24 && first.endsWith(":"));
  return isHeading ? lines.slice(1).join("\n") : text;
}

/** 정리하고 남은 마크다운은 해석이 모호하다. 그런 응답은 성공으로 통과시키지 않는다. */
function hasAmbiguousMarkdown(text: string) {
  return /[`*_#>]|\]\(|(?:^|\s)[-+]\s|\|.*\|/.test(text);
}

/**
 * 공백을 정리한 뒤 Unicode 코드포인트 수로 길이를 검사한다. 제한을 어기면 던진다.
 */
export function cleanCandidateText(raw: string, maxChars: number) {
  const text = stripPackaging(raw)
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0) {
    throw new CandidateError("empty text");
  }
  if (hasAmbiguousMarkdown(text)) {
    throw new CandidateError("ambiguous markdown");
  }
  const length = [...text].length;
  if (length > maxChars) {
    throw new CandidateError("length " + length + " > " + maxChars);
  }
  return text;
}

function logCall(candidate: string, outcome: string) {
  console.log("[orchestration-graph] summary.call candidate=" + candidate + " " + outcome);
}
