import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import type { GenerateOptions } from "./models";

type Cli = "codex" | "claude";
type Command = { file: string; args: string[] };

/** 회수가 확인되지 않은 후보는 공유 슬롯을 계속 점유한다. */
export class CliCleanupError extends Error {}

function pathDirectories() {
  return (process.env.PATH ?? "").split(delimiter).map((path) => path.replace(/^"|"$/g, ""))
    .filter((path) => isAbsolute(path));
}

function executable(name: string) {
  return pathDirectories().map((directory) => join(directory, name + ".exe"))
    .find((file) => existsSync(file));
}

/** npm shim은 실행하지 않는다. PATH의 설치 디렉터리에서 실제 런처/실행 파일을 찾는다. */
function command(cli: Cli): Command {
  const native = executable(cli);
  if (native) return { file: native, args: [] };
  for (const directory of pathDirectories()) {
    const entry = cli === "codex"
      ? join(directory, "node_modules", "@openai", "codex", "bin", "codex.js")
      : join(directory, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (!existsSync(entry)) continue;
    if (cli === "claude") return { file: entry, args: [] };
    const node = executable("node");
    if (node) return { file: node, args: [entry] };
  }
  throw new Error(cli + " executable not found");
}

function cliArguments(cli: Cli) {
  return cli === "codex" ? [
    "exec", "--model", "gpt-5.6-luna", "--json", "--ephemeral",
    "--sandbox", "read-only", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
    "--strict-config", "-c", 'model_reasoning_effort="low"', "-c", "project_doc_max_bytes=0",
    "-c", 'approval_policy="never"', "-",
  ] : [
    "-p", "--model", "claude-haiku-4-5", "--tools", "", "--no-session-persistence",
    "--safe-mode", "--output-format", "stream-json", "--verbose", "--permission-prompts", "none",
  ];
}

/*
 * Windows 소유 프로세스 감시. 루트 확인 전에는 모델 입력을 보내지 않는다.
 * 관측한 PID·생성 시각·부모 관계로만 자손을 확장한다. 재사용된 PID는 종료하지 않는다.
 * 자연 종료도 소유 트리 전체가 사라져야 완료다. 타임아웃에는 루트부터 막고 자손을 회수한다.
 */
const PROCESS_GUARD = String.raw`
$ErrorActionPreference = 'Stop'
function Emit($value) { [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress -Depth 5)) }
Emit @{ kind = 'ready' }
$spec = [Console]::In.ReadLine() | ConvertFrom-Json
$owned = @{}
$rootSeen = $false
$stopping = $false
$stopAt = 0L
try {
  while ($true) {
    $rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate, Name)
    $live = @{}
    foreach ($row in $rows) {
      $created = ([DateTimeOffset]$row.CreationDate).ToUnixTimeMilliseconds()
      $live[[int]$row.ProcessId] = @{ id = [int]$row.ProcessId; parent = [int]$row.ParentProcessId; created = $created; name = $row.Name }
    }
    if (-not $rootSeen) {
      $root = $live[[int]$spec.root]
      if ($null -eq $root) { Emit @{ kind = 'done'; timeout = $false; owned = @(); remaining = 0 }; exit 0 }
      if ($root.parent -ne $spec.parent -or $root.created -lt $spec.started -or $root.created -gt $spec.deadline) { throw 'root ownership mismatch' }
      $owned[$root.id] = $root
      $rootSeen = $true
      Emit @{ kind = 'owned'; process = $root }
    }
    do {
      $added = $false
      foreach ($entry in $live.Values) {
        if ($owned.ContainsKey($entry.id)) { continue }
        $ancestor = $owned[$entry.parent]
        $currentAncestor = $live[$entry.parent]
        if ($null -ne $ancestor -and $null -ne $currentAncestor -and $ancestor.created -eq $currentAncestor.created -and $entry.created -ge $ancestor.created) {
          $owned[$entry.id] = $entry; $added = $true
          Emit @{ kind = 'descendant'; process = $entry }
        }
      }
    } while ($added)
    $remaining = @($owned.Values | Where-Object { $null -ne $live[$_.id] -and $live[$_.id].created -eq $_.created })
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($remaining.Count -eq 0) { Emit @{ kind = 'done'; timeout = $stopping; owned = @($owned.Values); remaining = 0 }; exit 0 }
    if (-not $stopping -and $now -ge $spec.deadline) {
      $stopping = $true; $stopAt = $now
      Emit @{ kind = 'stopping'; elapsed = ($now - $spec.started); owned = @($owned.Values) }
    }
    if ($stopping) {
      foreach ($entry in ($remaining | Sort-Object created)) {
        $target = Get-Process -Id $entry.id -ErrorAction SilentlyContinue
        if ($null -ne $target) {
          try {
            $null = $target.Handle
            if (([DateTimeOffset]$target.StartTime).ToUnixTimeMilliseconds() -eq $entry.created) {
              $target.Kill()
              $null = $target.WaitForExit(1000)
            }
          } catch {
            if (-not $target.HasExited) { throw }
          } finally { $target.Dispose() }
        }
      }
      if ($now - $stopAt -gt 5000) { throw 'owned process cleanup unconfirmed' }
    }
    Start-Sleep -Milliseconds 100
  }
} catch { Emit @{ kind = 'error'; message = $_.Exception.Message }; exit 1 }
`;

export async function runCliCandidate(cli: Cli, options: GenerateOptions): Promise<string> {
  if (options.signal?.aborted) throw new Error("aborted");
  const launch = command(cli);
  const powershell = executable("pwsh") ?? executable("powershell");
  if (!powershell) throw new Error("process guard unavailable");
  const cwd = mkdtempSync(join(tmpdir(), "paseo-summary-" + cli + "-"));
  const guard = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PROCESS_GUARD], {
    cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  return new Promise<string>((resolve, reject) => {
    let child: ReturnType<typeof spawn> | undefined;
    let childClosed = false;
    let guardClosed = false;
    let guardDone = false;
    let timedOut = false;
    let failure: Error | undefined;
    let output = "";
    let guardBuffer = "";
    let started = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (!guardClosed) return;
      if (guardDone && child && !childClosed) return;
      if (timer) clearTimeout(timer);
      if (!guardDone && child?.pid) reject(new CliCleanupError(cli + " process cleanup unconfirmed"));
      else if (timedOut) reject(new Error("timeout"));
      else if (failure) reject(failure);
      else {
        try { resolve(finalText(cli, output)); } catch (error) { reject(error); }
      }
    };
    guard.stdin.on("error", () => {});
    guard.stderr.resume();
    guard.on("error", () => { failure = new Error("process guard failed"); });
    guard.on("close", () => { guardClosed = true; finish(); });
    guard.stdout.setEncoding("utf8");
    guard.stdout.on("data", (chunk: string) => {
      guardBuffer += chunk;
      let newline: number;
      while ((newline = guardBuffer.indexOf("\n")) >= 0) {
        const line = guardBuffer.slice(0, newline).trim();
        guardBuffer = guardBuffer.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.kind === "ready") {
          started = Date.now();
          child = spawn(launch.file, [...launch.args, ...cliArguments(cli)], {
            cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
            // 설치 CLI 도움말의 safe-mode 환경값을 초기화 전부터 적용한다. 인증은 그대로 상속한다.
            env: cli === "claude" ? { ...process.env, CLAUDE_CODE_SAFE_MODE: "1" } : process.env,
          });
          child.stdin!.on("error", () => {});
          child.stdout!.setEncoding("utf8");
          child.stdout!.on("data", (text: string) => { output += text; });
          // 진단은 요약 본문에 섞거나 인증 정보를 포함해 로그로 옮기지 않는다.
          child.stderr!.resume();
          child.on("error", () => { failure = new Error(cli + " spawn failed"); });
          child.on("close", (code) => {
            childClosed = true;
            if (Date.now() - started >= options.timeoutMs) timedOut = true;
            if (timer) clearTimeout(timer);
            if (code !== 0) failure = new Error(cli + " exit " + code);
            finish();
          });
          if (!child.pid) { guard.stdin.end(); return; }
          // OS 회수 확인이 늦어져도 20초 뒤 도착한 본문을 성공으로 채택하지 않는다.
          timer = setTimeout(() => { timedOut = true; }, Math.max(0, options.timeoutMs - (Date.now() - started)));
          guard.stdin.end(JSON.stringify({ root: child.pid, parent: process.pid, started, deadline: started + options.timeoutMs }) + "\n");
        } else if (event.kind === "owned") {
          child!.stdin!.end(options.prompt);
        } else if (event.kind === "stopping") {
          timedOut = true;
        } else if (event.kind === "done") {
          guardDone = event.remaining === 0;
          timedOut ||= event.timeout;
          guard.stdin.end();
        } else if (event.kind === "error") {
          failure = new CliCleanupError(cli + " process cleanup unconfirmed");
        }
      }
    });
  });
}

/** 실제 JSONL의 최종 응답만 채택한다. 도구 실행·실패·중간 텍스트는 결과가 아니다. */
function finalText(cli: Cli, output: string): string {
  let text: string | undefined;
  let completed = false;
  for (const line of output.split(/\r?\n/).filter((line) => line.trim())) {
    const event = JSON.parse(line);
    if (cli === "codex") {
      if (event.type === "error" || event.type === "turn.failed") throw new Error("codex failed");
      if (event.item && !["agent_message", "reasoning"].includes(event.item.type)) throw new Error("codex tool event");
      if (event.type === "item.completed" && event.item?.type === "agent_message") text = event.item.text;
      if (event.type === "turn.completed") completed = true;
    } else {
      if (event.type === "assistant" && event.message?.content?.some((part: { type: string }) => part.type === "tool_use")) throw new Error("claude tool event");
      if (event.type === "result") {
        if (event.is_error || event.subtype !== "success") throw new Error("claude failed");
        text = event.result;
        completed = true;
      }
    }
  }
  if (!completed || typeof text !== "string" || !text.trim()) throw new Error(cli + " missing final text");
  return text;
}
