/**
 * 요약을 만드는 모델 호출. 생성 단계 하나가 이 모듈의 `generate` 하나를 부른다.
 *
 * 두 CLI 후보를 고정 순서로 돌리고 같은 실행 슬롯을 공유한다.
 */
import { CliCleanupError, runCliCandidate } from "./cli";

/** 한 후보에 한 번 보낼 때의 상한. 후보가 실제로 시작된 뒤부터 센다. */
export const CANDIDATE_TIMEOUT_MS = 20000;

/** 모든 그래프를 합쳐 동시에 진행하는 후보 실행 수의 상한. */
const MAX_ACTIVE_CANDIDATES = 3;

/** 모든 후보가 실패하거나 소유 프로세스 회수가 실패하면 `generate`가 던진다. */
export class SummaryModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummaryModelError";
  }
}

/** 후보에 연결하거나 응답 원문을 받는 과정에서 실패한 까닭. */
class CandidateError extends Error {}

export type GenerateOptions = {
  prompt: string;
  maxChars: number;
  timeoutMs: number;
  signal?: AbortSignal;
  validate?: (raw: string) => string;
};

/**
 * 후보를 고정 순서로 돌린다. 원문을 받은 뒤 검사에 실패하면 같은 후보에 최대 두 번 재요청한다.
 * 호출 실패나 세 번의 검사 실패 뒤 다음 후보로 넘어가고, 검사 재시도 동안은 실행 슬롯을 유지한다.
 */
export async function generate(options: GenerateOptions): Promise<string> {
  const failures: string[] = [];
  for (const candidate of candidates()) {
    const release = await acquireCandidateSlot();
    let releaseAllowed = true;
    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        let raw: string;
        try {
          raw = await candidate.run(options);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
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
            failures.push(candidate.name + ": " + reason);
            break;
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
