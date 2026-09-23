/**
 * 요약을 만드는 모델 호출. 생성 단계 하나가 이 모듈의 `generate` 하나를 부른다.
 *
 * 로컬 HTTP와 두 CLI 후보가 같은 순서와 실행 슬롯을 공유한다.
 */
import { CliCleanupError, runCliCandidate } from "./cli";
import { lookup } from "node:dns/promises";
import { createConnection } from "node:net";

const DEFAULT_BASE_URL = "http://172.20.67.201:8000/v1";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_API_KEY = "EMPTY";

/** 로컬 후보의 엔드포인트 하나. `/v1/completions`나 `/v1/responses`로 바꾸지 않는다. */
const LOCAL_CHAT_PATH = "/chat/completions";
const LOCAL_MAX_TOKENS = 256;

/** 연결 실패나 응답 시간 초과 뒤 local 후보를 건너뛰는 시간. */
const LOCAL_SKIP_MS = 5 * 60 * 1000;
const LOCAL_CONNECT_TIMEOUT_MS = 2000;

/** 한 후보에 한 번 보낼 때의 상한. 후보가 실제로 시작된 뒤부터 센다. */
export const CANDIDATE_TIMEOUT_MS = 20000;

/** 모든 그래프를 합쳐 동시에 진행하는 후보 실행 수의 상한. */
const MAX_ACTIVE_CANDIDATES = 3;

/** 후보 순회 또는 한 후보의 요약 검사가 끝내 실패하면 `generate`가 던진다. */
export class SummaryModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummaryModelError";
  }
}

/** 후보에 연결하거나 응답 원문을 받는 과정에서 실패한 까닭. */
class CandidateError extends Error {}
class LocalConnectionCheckError extends CandidateError {}

export type GenerateOptions = {
  prompt: string;
  maxChars: number;
  timeoutMs: number;
  signal?: AbortSignal;
  validate?: (raw: string) => string;
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
 * 후보를 고정 순서로 돌린다. 원문을 받은 뒤 검사에 실패하면 같은 후보에 최대 두 번 재요청한다.
 * 연결 실패에만 다음 후보로 넘어가고, 검사 실패 동안은 실행 슬롯을 유지한다.
 */
export async function generate(options: GenerateOptions): Promise<string> {
  const failures: string[] = [];
  for (const candidate of candidates()) {
    if (candidate.name === "local" && isLocalSkipped()) {
      logCall(candidate.name, "ok=false reason=skipped");
      failures.push(candidate.name + ": skipped");
      continue;
    }
    const release = await acquireCandidateSlot();
    let releaseAllowed = true;
    try {
      if (candidate.name === "local" && isLocalSkipped()) {
        logCall(candidate.name, "ok=false reason=skipped");
        failures.push(candidate.name + ": skipped");
        continue;
      }
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        let raw: string;
        try {
          raw = await candidate.run(options);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          if (candidate.name === "local" && startsLocalSkip(error)) {
            startLocalSkip();
          }
          logCall(candidate.name, "ok=false reason=" + reason);
          if (error instanceof CliCleanupError) {
            // 소유 프로세스 종료가 확인되지 않으면 슬롯과 후속 후보를 멈춘다.
            releaseAllowed = false;
            throw new SummaryModelError(candidate.name + ": " + reason);
          }
          failures.push(candidate.name + ": " + reason);
          break;
        }
        try {
          const text = options.validate == null ? cleanCandidateText(raw, options.maxChars) : options.validate(raw);
          logCall(candidate.name, "ok=true chars=" + [...text].length);
          return text;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          logCall(candidate.name, "ok=false reason=" + reason);
          if (attempt === 3) {
            throw new SummaryModelError(candidate.name + ": " + reason);
          }
        }
      }
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

let localSkippedUntil = 0;

function isLocalSkipped() {
  return Date.now() < localSkippedUntil;
}

function startsLocalSkip(error: unknown) {
  return error instanceof LocalConnectionCheckError || (error instanceof Error && error.message === "timeout");
}

function startLocalSkip() {
  localSkippedUntil = Date.now() + LOCAL_SKIP_MS;
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
    await checkLocalConnection(config.baseUrl, controller.signal);
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
      throw new CandidateError(controller.signal.aborted ? "timeout" : "unreachable " + connectionReason(error));
    }

    if (!response.ok) {
      throw new CandidateError("http " + response.status);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new CandidateError(controller.signal.aborted ? "timeout" : "invalid json");
    }

    if (controller.signal.aborted) {
      throw new CandidateError("timeout");
    }
    return readCandidateContent(payload);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

async function checkLocalConnection(baseUrl: string, signal: AbortSignal) {
  let endpoint: URL;
  try {
    endpoint = new URL(baseUrl);
  } catch {
    throw new LocalConnectionCheckError("unreachable invalid baseUrl");
  }
  const port = endpoint.port.length > 0 ? Number(endpoint.port) : endpoint.protocol === "https:" ? 443 : 80;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOCAL_CONNECT_TIMEOUT_MS);
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort);
  try {
    const address = await waitForAbort(lookup(endpoint.hostname), controller.signal);
    await connectAndClose(address.address, port, controller.signal);
  } catch (error) {
    if (signal.aborted) {
      throw new CandidateError("timeout");
    }
    throw new LocalConnectionCheckError("unreachable " + connectionReason(error));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

function waitForAbort<T>(value: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("aborted"));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    void value.then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function connectAndClose(host: string, port: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port });
    const abort = () => socket.destroy(new Error("aborted"));
    const done = (error?: Error) => {
      signal.removeEventListener("abort", abort);
      socket.destroy();
      error == null ? resolve() : reject(error);
    };
    signal.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => done());
    socket.once("error", (error) => done(error));
  });
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
