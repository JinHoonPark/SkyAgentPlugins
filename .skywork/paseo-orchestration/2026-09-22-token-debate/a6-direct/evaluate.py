"""Measure the first Claude tool call with a project skill installed in isolation."""

from __future__ import annotations

import argparse
import ctypes
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
import queue
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time

MODEL = "claude-opus-5-5"
SKILL_NAME = "agent-orchestration"
RUN = Path(__file__).resolve().parent.parent
LOGS = Path(__file__).resolve().parent / "logs-short"
LAUNCHER = Path(__file__).resolve().with_name("start-claude.ps1")


def read_description(skill_path: Path) -> str:
    lines = (skill_path / "SKILL.md").read_text(encoding="utf-8").splitlines()
    assert lines[0] == "---"
    for line in lines[1:]:
        if line == "---":
            break
        if line.startswith("description: "):
            value = line.removeprefix("description: ").strip()
            if value.startswith("'") and value.endswith("'"):
                return value[1:-1].replace("''", "'")
            return value.strip('"')
    raise ValueError("description missing")


def pid_alive(pid: int) -> bool:
    kernel = ctypes.windll.kernel32
    kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    kernel.WaitForSingleObject.restype = ctypes.c_ulong
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel.OpenProcess(0x00100000, 0, pid)
    if not handle:
        return False
    try:
        return kernel.WaitForSingleObject(handle, 0) == 0x00000102
    finally:
        kernel.CloseHandle(handle)


def kill_process_tree(pid: int) -> dict:
    if not pid_alive(pid):
        return {"attempted": False, "returncode": None, "stderr": ""}
    done = subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15,
                          creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    message = done.stderr.decode("cp949", errors="replace").strip()[:500]
    return {"attempted": True, "returncode": done.returncode,
            "stderr": message}


def pump(pipe, kind: str, messages: queue.Queue) -> None:
    try:
        for line in pipe:
            messages.put((kind, line))
    except Exception as exc:
        messages.put(("pump_error", f"{kind}: {exc}"))
    finally:
        messages.put((kind, None))


def input_summary(value: dict) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)[:300]


def skill_triggered(tool: dict | None, installed_skill: Path, work: Path) -> bool:
    if not tool:
        return False
    name = tool["name"]
    inputs = tool["input"]
    if name == "Skill":
        return SKILL_NAME in json.dumps(inputs, ensure_ascii=False)
    if name == "Read":
        filename = inputs.get("file_path") or inputs.get("path") or ""
        if not isinstance(filename, str) or not filename:
            return False
        path = Path(filename)
        if not path.is_absolute():
            path = work / path
        return path.resolve() == (installed_skill / "SKILL.md").resolve()
    return False


def one_run(stage: str, number: int, repeat: int, item: dict,
            skill_path: Path, claude_exe: Path, timeout: int) -> dict:
    run_id = f"{stage}-q{number:02d}-r{repeat}"
    work = Path(tempfile.mkdtemp(prefix="skill-trigger-eval-direct-"))
    installed = work / ".claude" / "skills" / SKILL_NAME
    installed.parent.mkdir(parents=True)
    shutil.copytree(skill_path, installed)
    LOGS.mkdir(parents=True, exist_ok=True)
    raw_path = LOGS / f"{run_id}.jsonl"
    stderr_path = LOGS / f"{run_id}.stderr.log"
    meta_path = LOGS / f"{run_id}.meta.json"
    config_path = work / "launcher.json"
    config_path.write_text(json.dumps({"query": item["query"], "claude": str(claude_exe)},
                                      ensure_ascii=False), encoding="utf-8")
    args = [str(claude_exe), "-p", item["query"], "--output-format", "stream-json",
            "--verbose", "--include-partial-messages", "--setting-sources",
            "project,local", "--strict-mcp-config", "--no-session-persistence",
            "--model", MODEL, "--max-turns", "1"]
    wrapper_args = ["pwsh", "-NoProfile", "-File", str(LAUNCHER),
                    "-ConfigPath", str(config_path)]
    env = dict(os.environ)
    env.pop("CLAUDECODE", None)
    env.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8", PYTHONDONTWRITEBYTECODE="1")
    messages: queue.Queue = queue.Queue()
    started = time.monotonic()
    init = None
    current = None
    first_tool = None
    stop_reason = None
    error = None
    stdout_done = False
    stderr_done = False
    kill_info = {"attempted": False, "returncode": None, "stderr": ""}
    process = None
    threads = []
    with raw_path.open("w", encoding="utf-8", newline="\n") as raw, \
            stderr_path.open("w", encoding="utf-8", newline="\n") as err:
        try:
            process = subprocess.Popen(wrapper_args, cwd=work, env=env,
                                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, text=True, encoding="utf-8",
                                       errors="replace", bufsize=1,
                                       creationflags=(getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                                                      | getattr(subprocess, "CREATE_NO_WINDOW", 0)))
            threads = [threading.Thread(target=pump, args=(process.stdout, "stdout", messages), daemon=True),
                       threading.Thread(target=pump, args=(process.stderr, "stderr", messages), daemon=True)]
            for thread in threads:
                thread.start()
            deadline = started + timeout
            while True:
                if time.monotonic() >= deadline:
                    stop_reason = "timeout"
                    error = f"timeout after {timeout}s"
                    break
                try:
                    kind, line = messages.get(timeout=min(1, max(0.01, deadline - time.monotonic())))
                except queue.Empty:
                    if process.poll() is not None and stdout_done:
                        stop_reason = "process_exited"
                        break
                    continue
                if kind == "pump_error":
                    error = line
                    stop_reason = "stream_read_error"
                    break
                if line is None:
                    if kind == "stdout":
                        stdout_done = True
                    else:
                        stderr_done = True
                    if stdout_done and process.poll() is not None:
                        stop_reason = "process_exited"
                        break
                    continue
                if kind == "stderr":
                    err.write(line)
                    err.flush()
                    continue
                raw.write(line)
                raw.flush()
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if event.get("type") == "system" and event.get("subtype") == "init":
                    init = event
                elif event.get("type") == "stream_event":
                    detail = event.get("event", {})
                    kind2 = detail.get("type")
                    if kind2 == "content_block_start" and first_tool is None:
                        block = detail.get("content_block", {})
                        if block.get("type") == "tool_use":
                            current = {"name": block.get("name", ""), "id": block.get("id", ""),
                                       "raw": "", "input": block.get("input", {})}
                    elif kind2 == "content_block_delta" and current is not None:
                        delta = detail.get("delta", {})
                        if delta.get("type") == "input_json_delta":
                            current["raw"] += delta.get("partial_json", "")
                    elif kind2 == "content_block_stop" and current is not None:
                        if current["raw"]:
                            try:
                                current["input"] = json.loads(current["raw"])
                            except json.JSONDecodeError:
                                error = "first tool input is incomplete JSON"
                        first_tool = current
                        current = None
                        stop_reason = "first_tool_recorded"
                        break
                elif event.get("type") == "assistant" and first_tool is None and current is None:
                    for block in event.get("message", {}).get("content", []):
                        if block.get("type") == "tool_use":
                            first_tool = {"name": block.get("name", ""), "id": block.get("id", ""),
                                          "input": block.get("input", {}), "raw": ""}
                            stop_reason = "first_tool_full_message"
                            break
                    if first_tool is not None:
                        break
                elif event.get("type") == "result":
                    stop_reason = "completed_without_tool"
                    break
            if process.poll() is None:
                kill_info = kill_process_tree(process.pid)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                error = (error + "; " if error else "") + "wrapper did not exit after stop"
            if kill_info["attempted"] and kill_info["returncode"] != 0 and process.poll() is None:
                error = (error + "; " if error else "") + "process tree termination failed: " + kill_info["stderr"]
        except Exception as exc:
            error = (error + "; " if error else "") + f"{type(exc).__name__}: {exc}"
            stop_reason = stop_reason or "exception"
            if process is not None and process.poll() is None:
                kill_info = kill_process_tree(process.pid)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    pass
        finally:
            for thread in threads:
                thread.join(timeout=2)
            while not messages.empty():
                kind, line = messages.get_nowait()
                if line is not None and kind == "stdout":
                    raw.write(line)
                elif line is not None and kind == "stderr":
                    err.write(line)
    skills = init.get("skills", []) if init else []
    plugins = init.get("plugins", []) if init else []
    slash_commands = init.get("slash_commands", []) if init else []
    target_loaded = any(SKILL_NAME == str(x) or str(x).endswith("/" + SKILL_NAME) for x in skills)
    exposed = json.dumps({"skills": skills, "plugins": plugins, "slash_commands": slash_commands}, ensure_ascii=False)
    installed_plugin_present = "paseo-toolkit:agent-orchestration" in exposed or "paseo-toolkit@" in exposed
    if init is None:
        error = (error + "; " if error else "") + "init event missing"
    elif not target_loaded:
        error = (error + "; " if error else "") + "target skill absent from init.skills"
    if installed_plugin_present:
        error = (error + "; " if error else "") + "installed paseo-toolkit present in init"
    if first_tool is not None and "\ufffd" in input_summary(first_tool["input"]):
        error = (error + "; " if error else "") + "replacement character in first tool input"
    if current is not None and first_tool is None:
        error = (error + "; " if error else "") + "first tool input incomplete"
    triggered = skill_triggered(first_tool, installed, work) if not error else False
    meta = {
        "run_id": run_id, "query": item["query"], "should_trigger": item["should_trigger"],
        "temp_path": str(work), "installed_skill_path": str(installed),
        "command": args, "wrapper_command": wrapper_args,
        "seconds": round(time.monotonic() - started, 2),
        "stop_reason": stop_reason, "wrapper_exit_code": process.returncode if process else None,
        "pid": process.pid if process else None,
        "kill": kill_info, "error": error, "init_model": init.get("model") if init else None,
        "init_skills": skills, "init_plugins": plugins, "init_slash_commands": slash_commands,
        "target_loaded": target_loaded, "installed_plugin_present": installed_plugin_present,
        "first_tool_name": first_tool["name"] if first_tool else None,
        "first_tool_input": first_tool["input"] if first_tool else None,
        "first_tool_input_summary": input_summary(first_tool["input"]) if first_tool else None,
        "triggered": triggered, "raw_jsonl": str(raw_path), "stderr_log": str(stderr_path),
    }
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return meta


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", required=True, choices=["baseline", "baseline2", "baseline3", "initial", "rerun"])
    parser.add_argument("--eval-set", type=Path, required=True)
    parser.add_argument("--skill-path", type=Path, required=True)
    parser.add_argument("--result", type=Path, required=True)
    parser.add_argument("--stderr", type=Path, required=True)
    parser.add_argument("--claude", type=Path, required=True)
    parser.add_argument("--runs-per-query", type=int, required=True)
    parser.add_argument("--timeout", type=int, default=90)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    if args.claude.name.lower() != "claude.cmd" or not args.claude.is_file():
        parser.error("--claude must be the Get-Command claude.cmd application")
    if args.result.exists() or args.stderr.exists():
        parser.error("result or stderr already exists")
    items = json.loads(args.eval_set.read_text(encoding="utf-8"))
    if len(items) != len({x["query"] for x in items}):
        parser.error("duplicate queries")
    if args.runs_per_query not in (1, 3):
        parser.error("runs-per-query must be 1 or 3")
    skill_path = args.skill_path.resolve()
    description = read_description(skill_path)
    tasks = [(i, repeat, item) for i, item in enumerate(items, 1)
             for repeat in range(1, args.runs_per_query + 1)]
    print(f"stage={args.stage} queries={len(items)} calls={len(tasks)} model={MODEL}", flush=True)
    details = []
    # Validate the actual skill exposure before launching the remaining calls.
    i, repeat, item = tasks[0]
    first = one_run(args.stage, i, repeat, item, skill_path, args.claude, args.timeout)
    details.append(first)
    print(f"preflight={first['run_id']} model={first['init_model']} target={first['target_loaded']} "
          f"installed_plugin={first['installed_plugin_present']} first_tool={first['first_tool_name']}", flush=True)
    if (first["init_model"] != MODEL or not first["target_loaded"]
            or first["installed_plugin_present"]
            or "\ufffd" in (first["first_tool_input_summary"] or "")):
        (LOGS / f"{args.stage}-preflight-failure.json").write_text(
            json.dumps(first, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("Warning: query failed: preflight isolation/model check failed", file=sys.stderr)
        return 2
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(one_run, args.stage, i, repeat, item, skill_path,
                                   args.claude, args.timeout): (i, repeat)
                   for i, repeat, item in tasks[1:]}
        for future in as_completed(futures):
            details.append(future.result())
    by_query = {item["query"]: [] for item in items}
    for meta in details:
        by_query[meta["query"]].append(meta)
    results = []
    for item in items:
        runs = by_query[item["query"]]
        runs.sort(key=lambda x: int(x["run_id"].rsplit("r", 1)[1]))
        count = sum(x["triggered"] for x in runs)
        rate = count / len(runs)
        expected = item["should_trigger"]
        passed = rate >= 0.5 if expected else rate < 0.5
        results.append({"query": item["query"], "should_trigger": expected,
                        "trigger_rate": rate, "triggers": count, "runs": len(runs),
                        "pass": passed, "first_tool_names": [x["first_tool_name"] for x in runs],
                        "first_tool_input_summaries": [x["first_tool_input_summary"] for x in runs],
                        "run_ids": [x["run_id"] for x in runs]})
    failed = sum(not x["pass"] for x in results)
    output = {"skill_name": SKILL_NAME, "description": description,
              "measurement": "direct project skill first tool", "model_requested": MODEL,
              "init_models": dict(Counter(str(x["init_model"]) for x in details)),
              "target_skill_loaded_all": all(x["target_loaded"] for x in details),
              "installed_plugin_absent_all": all(not x["installed_plugin_present"] for x in details),
              "init_skills_first": first["init_skills"], "call_count": len(details),
              "temp_paths": [x["temp_path"] for x in details], "results": results,
              "summary": {"total": len(results), "passed": len(results) - failed, "failed": failed}}
    args.result.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with args.stderr.open("w", encoding="utf-8", newline="\n") as aggregate:
        for meta in sorted(details, key=lambda x: x["run_id"]):
            if meta["error"]:
                aggregate.write(f"Warning: query failed: id={meta['run_id']} "
                                f"query={meta['query']} reason={meta['error']}\n")
    (LOGS / f"{args.stage}-manifest.json").write_text(
        json.dumps(details, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"summary={output['summary']} warnings={sum(bool(x['error']) for x in details)} "
          f"temp_dirs={len(details)}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
