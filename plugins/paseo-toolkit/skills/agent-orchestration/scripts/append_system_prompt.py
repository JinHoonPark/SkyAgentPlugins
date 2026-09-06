#!/usr/bin/env python3
"""Append one line to daemon.appendSystemPrompt with backup, reload, and rollback.

Default is dry-run: print the four presentation fields and write nothing.
Pass --apply only after an explicit user approval (SPEC.md §4.5 steps 4–6).
"""

from __future__ import annotations

import argparse
import codecs
import difflib
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any, Iterator, Mapping, Sequence


EXIT_OK = 0
EXIT_VALIDATION_ERROR = 2
EXIT_APPLY_FAILURE = 3
EXIT_UNVERIFIED = 4

UTF8_BOM = codecs.BOM_UTF8
EXPECTED_RELOAD_STDOUT = "Configuration reloaded."
EFFECT_FROM = (
    "새 세션부터 적용된다고 보되, 실행 중 세션 반영 여부는 "
    "SPIKE.md 게이트 2팔 관측으로 확정한다."
)

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError, OSError):
        pass


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ValueError(message)


def path_text(path: Path | None) -> str | None:
    if path is None:
        return None
    try:
        return str(path.resolve(strict=False))
    except OSError:
        return str(path)


def same_path(left: Path, right: Path) -> bool:
    return os.path.normcase(str(path_text(left))) == os.path.normcase(str(path_text(right)))


def sha256_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def emit_utf8(stream: Any, text: str) -> None:
    payload = text.encode("utf-8")
    binary = getattr(stream, "buffer", None)
    if binary is not None:
        binary.write(payload)
        binary.flush()
        return
    stream.write(text)
    stream.flush()


def stderr_line(text: str) -> None:
    emit_utf8(sys.stderr, text + "\n")


def emit_json(result: Mapping[str, Any]) -> None:
    payload = json.dumps(result, ensure_ascii=False, allow_nan=False, sort_keys=True) + "\n"
    emit_utf8(sys.stdout, payload)


def decode_utf8(raw: bytes, label: str) -> str:
    if raw.startswith(UTF8_BOM):
        raise ValueError(f"{label} must be UTF-8 without a BOM")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError(f"{label} must be valid UTF-8: {exc}") from exc


def parse_json(text: str) -> Any:
    return json.loads(text, parse_constant=_reject_nonstandard_json_constant)


def _reject_nonstandard_json_constant(value: str) -> None:
    raise ValueError(f"JSON does not permit the constant {value!r}")


def load_json_bytes(path: Path, label: str) -> tuple[bytes, Any]:
    raw = path.read_bytes()
    document = parse_json(decode_utf8(raw, label))
    return raw, document


def _skip_ws(text: str, index: int) -> int:
    length = len(text)
    while index < length and text[index] in " \t\r\n":
        index += 1
    return index


def _indent_of(text: str, index: int) -> str:
    line_start = text.rfind("\n", 0, index)
    if line_start == -1:
        return text[:index]
    return text[line_start + 1 : index]


def iter_object_properties(
    text: str, open_brace: int
) -> Iterator[tuple[str, int, int, int]]:
    decoder = json.JSONDecoder()
    index = _skip_ws(text, open_brace + 1)
    while index < len(text) and text[index] != "}":
        if text[index] == ",":
            index = _skip_ws(text, index + 1)
            continue
        if text[index] != '"':
            raise ValueError("JSON object key must be a string")
        key_start = index
        key, key_end = decoder.raw_decode(text, index)
        index = _skip_ws(text, key_end)
        if index >= len(text) or text[index] != ":":
            raise ValueError("JSON object key must be followed by a colon")
        index = _skip_ws(text, index + 1)
        value_start = index
        _, value_end = decoder.raw_decode(text, index)
        yield key, key_start, value_start, value_end
        index = _skip_ws(text, value_end)
    if index >= len(text) or text[index] != "}":
        raise ValueError("unterminated JSON object")


def locate_top_level_property(text: str, key: str) -> tuple[int, int, int] | None:
    index = _skip_ws(text, 0)
    if index >= len(text) or text[index] != "{":
        raise ValueError("top-level JSON must be an object")
    found: tuple[int, int, int] | None = None
    for name, key_start, value_start, value_end in iter_object_properties(text, index):
        if name == key:
            found = (key_start, value_start, value_end)
    return found


def locate_daemon_property(text: str, key: str) -> tuple[int, int, int] | None:
    daemon = locate_top_level_property(text, "daemon")
    assert daemon is not None
    _key_start, value_start, _value_end = daemon
    assert text[value_start] == "{"
    found: tuple[int, int, int] | None = None
    for name, key_start, prop_value_start, prop_value_end in iter_object_properties(
        text, value_start
    ):
        if name == key:
            found = (key_start, prop_value_start, prop_value_end)
    return found


def raw_daemon_property_bytes(raw: bytes, key: str) -> bytes:
    text = decode_utf8(raw, "config.json")
    located = locate_daemon_property(text, key)
    if located is None:
        return b""
    _key_start, value_start, value_end = located
    return text[value_start:value_end].encode("utf-8")


def encode_json_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def _insert_style(
    text: str, open_brace: int, close_brace: int, key_starts: Sequence[int]
) -> tuple[str, bool]:
    pretty = "\n" in text[open_brace : close_brace + 1]
    if key_starts:
        return _indent_of(text, key_starts[0]), pretty
    if pretty:
        return _indent_of(text, close_brace) + "  ", True
    return "", False


def splice_prompt_value(text: str, new_value: str) -> tuple[str, dict[str, Any]]:
    encoded = encode_json_string(new_value)
    located = locate_daemon_property(text, "appendSystemPrompt")
    if located is not None:
        _key_start, value_start, value_end = located
        updated = text[:value_start] + encoded + text[value_end:]
        return updated, {
            "kind": "replace",
            "beforeSpan": (value_start, value_end),
            "afterSpan": (value_start, value_start + len(encoded)),
        }

    daemon = locate_top_level_property(text, "daemon")
    assert daemon is not None
    _daemon_key, daemon_start, daemon_end = daemon
    assert text[daemon_start] == "{"
    close_brace = daemon_end - 1
    assert text[close_brace] == "}"
    props = list(iter_object_properties(text, daemon_start))
    key_json = encode_json_string("appendSystemPrompt")
    inner, pretty = _insert_style(
        text, daemon_start, close_brace, [item[1] for item in props]
    )
    if not props:
        if pretty:
            chunk = f"\n{inner}{key_json}: {encoded}\n{_indent_of(text, close_brace)}"
        elif close_brace == daemon_start + 1:
            chunk = f"{key_json}: {encoded}"
        else:
            chunk = f" {key_json}: {encoded} "
        insert_at = daemon_start + 1
    else:
        insert_at = props[-1][3]
        if pretty:
            chunk = f",\n{inner}{key_json}: {encoded}"
        else:
            chunk = f", {key_json}: {encoded}"
    updated = text[:insert_at] + chunk + text[insert_at:]
    return updated, {
        "kind": "insert",
        "insertAt": insert_at,
        "inserted": chunk,
    }


def remainder_preserved(before_text: str, after_text: str, meta: dict[str, Any]) -> bool:
    if meta["kind"] == "replace":
        before_start, before_end = meta["beforeSpan"]
        after_start, after_end = meta["afterSpan"]
        return (
            before_text[:before_start] + before_text[before_end:]
            == after_text[:after_start] + after_text[after_end:]
        )
    insert_at = meta["insertAt"]
    chunk = meta["inserted"]
    return (
        after_text[insert_at : insert_at + len(chunk)] == chunk
        and after_text[:insert_at] + after_text[insert_at + len(chunk) :] == before_text
    )


def prompt_value(document: Any) -> str | None:
    if not isinstance(document, dict):
        return None
    daemon = document.get("daemon")
    if not isinstance(daemon, dict):
        return None
    if "appendSystemPrompt" not in daemon:
        return ""
    value = daemon["appendSystemPrompt"]
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return None


def append_line(current: str, line: str) -> str:
    if current == "":
        return line
    if current.endswith("\n"):
        return current + line
    return current + "\n" + line


def already_has_line(current: str, proposed: str) -> bool:
    """AC-58: a routing line already present is a no-op."""

    if current == proposed:
        return True
    proposed_line = proposed.strip("\r\n")
    if "\n" in proposed_line or "\r" in proposed_line:
        return False
    for line in current.splitlines():
        if line.strip() == proposed_line.strip():
            return True
    return False


def unified_prompt_diff(before: str, after: str) -> str:
    before_lines = before.splitlines()
    after_lines = after.splitlines()
    if before_lines == after_lines:
        return ""
    return "\n".join(
        difflib.unified_diff(
            before_lines,
            after_lines,
            fromfile="daemon.appendSystemPrompt",
            tofile="daemon.appendSystemPrompt",
            lineterm="",
            n=0,
        )
    )


def backup_path_for(config_path: Path, purpose: str, raw: bytes) -> Path:
    digest = sha256_bytes(raw)[:16]
    name = f"{config_path.name}.append-system-prompt.{purpose}.{digest}.bak"
    return config_path.with_name(name)


def create_backup(config_path: Path, backup_path: Path) -> Path:
    shutil.copyfile(config_path, backup_path)
    return backup_path


def atomic_write_bytes(path: Path, raw: bytes, expected_current_hash: str | None = None) -> None:
    temporary_name: str | None = None
    descriptor: int | None = None
    try:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
        )
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = None
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        if expected_current_hash is not None:
            current_hash = sha256_bytes(path.read_bytes())
            if current_hash != expected_current_hash:
                raise RuntimeError("config.json이 최종 교체 직전에 변경되었습니다.")
        os.replace(temporary_name, path)
        temporary_name = None
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if temporary_name is not None:
            try:
                os.unlink(temporary_name)
            except OSError as exc:
                stderr_line(f"임시 파일 {temporary_name}을 지우지 못했습니다: {exc}")


def restore_bytes(config_path: Path, backup_path: Path) -> bytes:
    raw = backup_path.read_bytes()
    atomic_write_bytes(config_path, raw)
    written = config_path.read_bytes()
    if written != raw:
        raise RuntimeError("복원된 config.json의 바이트가 백업과 다릅니다.")
    return written


def paseo_command(arguments: Sequence[str]) -> list[str]:
    executable = shutil.which("paseo") or shutil.which("paseo.cmd")
    if executable is None:
        raise FileNotFoundError("PATH에서 paseo CLI를 찾지 못했습니다.")
    if os.name == "nt" and Path(executable).suffix.casefold() in {".cmd", ".bat"}:
        command_shell = os.environ.get("ComSpec")
        if not command_shell:
            raise FileNotFoundError("Paseo .cmd shim을 실행할 ComSpec 환경 변수가 없습니다.")
        batch_line = subprocess.list2cmdline([executable, *arguments])
        return [command_shell, "/d", "/s", "/c", batch_line]
    return [executable, *arguments]


def run_paseo(arguments: Sequence[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        paseo_command(arguments),
        check=False,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        text=True,
        timeout=30,
    )


def try_status() -> dict[str, Any] | None:
    try:
        result = run_paseo(("status", "--json"))
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    try:
        payload = parse_json(result.stdout)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    return payload


def runtime_from_status(status: Mapping[str, Any] | None) -> tuple[Path | None, Path | None]:
    if status is None:
        return None, None
    home_value = status.get("home")
    log_value = status.get("logPath")
    home = Path(home_value) if isinstance(home_value, str) and home_value.strip() else None
    log_path = Path(log_value) if isinstance(log_value, str) and log_value.strip() else None
    return home, log_path


def should_reload(config_path: Path, daemon_config: Path | None) -> bool:
    if daemon_config is None:
        return False
    return same_path(config_path, daemon_config)


def log_lines(log_path: Path) -> list[str]:
    if not log_path.exists():
        return []
    return decode_utf8(log_path.read_bytes(), f"데몬 로그 {log_path}").splitlines()


def assess_reload_logs(new_lines: list[str]) -> dict[str, Any]:
    loaded = False
    loaded_messages: list[str] = []
    for raw_line in new_lines:
        try:
            record = json.loads(raw_line)
        except json.JSONDecodeError:
            if "loaded from" in raw_line.casefold():
                loaded = True
                loaded_messages.append(raw_line)
            continue
        if not isinstance(record, dict):
            continue
        message = record.get("msg")
        message_text = message if isinstance(message, str) else ""
        level = record.get("level")
        if (level == 30 or level == "info") and "loaded from" in message_text.casefold():
            loaded = True
            loaded_messages.append(message_text)
    return {
        "ok": loaded,
        "loadedFromConfig": loaded,
        "loadedMessages": loaded_messages[:10],
        "newLineCount": len(new_lines),
    }


def wait_for_reload_logs(log_path: Path, baseline_line_count: int) -> dict[str, Any]:
    last_result: dict[str, Any] | None = None
    deadline = time.monotonic() + 2.0
    while True:
        try:
            lines = log_lines(log_path)
        except (OSError, ValueError) as exc:
            return {
                "ok": False,
                "loadedFromConfig": False,
                "errorMessages": [f"reload 뒤 daemon log를 읽을 수 없습니다: {exc}"],
                "loadedMessages": [],
                "newLineCount": 0,
            }
        if len(lines) < baseline_line_count:
            return {
                "ok": False,
                "loadedFromConfig": False,
                "errorMessages": ["reload 중 daemon log가 축소 또는 교체되었습니다."],
                "loadedMessages": [],
                "newLineCount": 0,
            }
        last_result = assess_reload_logs(lines[baseline_line_count:])
        if last_result["ok"]:
            return last_result
        if time.monotonic() >= deadline:
            break
        time.sleep(0.1)
    if last_result is None:
        last_result = {
            "ok": False,
            "loadedFromConfig": False,
            "errorMessages": [],
            "loadedMessages": [],
            "newLineCount": 0,
        }
    last_result["ok"] = False
    last_result["errorMessages"] = list(last_result.get("errorMessages", [])) + [
        "reload 뒤 신규 daemon log에서 'Loaded from' 재적재를 찾지 못했습니다."
    ]
    return last_result


def reload_stdout_matches(stdout: str) -> bool:
    return stdout.strip("\r\n") == EXPECTED_RELOAD_STDOUT


def reload_and_verify(log_path: Path | None) -> dict[str, Any]:
    result: dict[str, Any] = {"attempted": True, "skipped": False, "command": None, "log": None, "ok": False}
    baseline: int | None = None
    if log_path is None:
        result["log"] = {"ok": False, "errorMessages": ["paseo status의 logPath가 없습니다."]}
    else:
        try:
            baseline = len(log_lines(log_path))
        except (OSError, ValueError) as exc:
            result["log"] = {"ok": False, "errorMessages": [f"reload 전 daemon log를 읽을 수 없습니다: {exc}"]}
            return result
    try:
        command = run_paseo(("daemon", "reload"))
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired) as exc:
        result["command"] = {"ok": False, "error": str(exc)}
        return result
    stdout = command.stdout
    stdout_ok = reload_stdout_matches(stdout)
    result["command"] = {
        "ok": command.returncode == 0 and stdout_ok,
        "returnCode": command.returncode,
        "stdout": stdout.strip("\r\n"),
        "stderr": command.stderr.strip(),
        "expectedStdout": EXPECTED_RELOAD_STDOUT,
        "successMessageFound": stdout_ok,
    }
    if command.returncode != 0 or not stdout_ok:
        return result
    if baseline is not None and log_path is not None:
        result["log"] = wait_for_reload_logs(log_path, baseline)
    else:
        result["log"] = {"ok": False, "errorMessages": ["paseo status의 logPath가 없습니다."]}
    result["ok"] = bool(result["command"]["ok"] and result["log"] and result["log"].get("ok"))
    return result


def rollback_command(script_path: str, config_path: str, backup_path: str) -> str:
    return (
        f'python -X utf8 "{script_path}" --config "{config_path}" '
        f'--rollback "{backup_path}" --apply'
    )


def presentation_fields(
    *,
    config_path: str,
    proposed: str,
    diff_text: str,
    backup_path: str | None,
    restore: str,
) -> dict[str, Any]:
    return {
        "configPath": config_path,
        "proposedLine": proposed,
        "diff": diff_text,
        "restore": {
            "backupPath": backup_path,
            "command": restore,
        },
    }


def emit_presentation(presentation: Mapping[str, Any]) -> None:
    restore = presentation.get("restore") if isinstance(presentation.get("restore"), dict) else {}
    stderr_line("(a) 경로: " + str(presentation.get("configPath") or ""))
    stderr_line("(b) 추가할 한 줄 원문: " + str(presentation.get("proposedLine") or ""))
    stderr_line("(c) diff:")
    diff_text = presentation.get("diff") or "(변경 없음)"
    for line in str(diff_text).splitlines() or ["(변경 없음)"]:
        stderr_line(line)
    backup = restore.get("backupPath")
    command = restore.get("command") or ""
    stderr_line("(d) 되돌리는 방법: 백업 " + str(backup))
    if command:
        stderr_line(command)


def skipped_reload_result() -> dict[str, Any]:
    return {
        "attempted": False,
        "skipped": True,
        "ok": False,
        "reason": "--config 대상이 데몬 config.json이 아니라 reload를 건너뛰었습니다.",
    }


def make_parser() -> JsonArgumentParser:
    parser = JsonArgumentParser(
        description="daemon.appendSystemPrompt에 한 줄을 백업·추가·reload·롤백합니다. 기본은 dry-run입니다."
    )
    parser.add_argument("--value", default=None, help="추가할 한 줄. 빈 문자열은 허용하지 않습니다.")
    parser.add_argument("--apply", action="store_true", help="사용자 승인 뒤에만 실제 반영합니다.")
    parser.add_argument("--config", metavar="PATH", help="config.json 경로 override. 테스트용.")
    parser.add_argument(
        "--rollback",
        metavar="BACKUP",
        help="지정한 백업 JSON을 config.json으로 복원합니다. --apply가 없으면 dry-run입니다.",
    )
    return parser


def base_result(args: argparse.Namespace | None) -> dict[str, Any]:
    return {
        "ok": False,
        "exitCode": EXIT_VALIDATION_ERROR,
        "action": "blocked",
        "dryRun": not bool(args and args.apply),
        "applyRequested": bool(args and args.apply),
        "alreadyPresent": False,
        "configPath": None,
        "backupPath": None,
        "reload": None,
        "rollback": None,
        "presentation": None,
        "effectFrom": EFFECT_FROM,
        "agentProfilesSha256Before": None,
        "agentProfilesSha256After": None,
        "configSha256Before": None,
        "configSha256After": None,
        "message": None,
        "errors": [],
        "warnings": [],
    }


def finish(result: dict[str, Any], errors: list[dict[str, Any]], exit_code: int) -> int:
    result["errors"] = errors
    result["exitCode"] = exit_code
    result["ok"] = exit_code == EXIT_OK
    emit_json(result)
    action = result.get("action") or "unknown"
    stderr_line(f"append_system_prompt: {action}; 오류 {len(errors)}건.")
    if result.get("alreadyPresent"):
        stderr_line("이미 있다")
    if result.get("message") and result.get("action") != "already-present":
        stderr_line(str(result["message"]))
    for item in errors:
        location = f" [{item['path']}]" if item.get("path") else ""
        stderr_line(f"오류{location}: {item['message']}")
    for item in result.get("warnings") or []:
        location = f" [{item['path']}]" if item.get("path") else ""
        stderr_line(f"경고{location}: {item['message']}")
    return exit_code


def error_item(code: str, message: str, path: str | None = None) -> dict[str, Any]:
    item = {"code": code, "message": message}
    if path is not None:
        item["path"] = path
    return item


def validate_config_document(document: Any, label: str) -> str | None:
    if not isinstance(document, dict):
        return f"{label}의 최상위 값은 JSON 객체여야 합니다."
    daemon = document.get("daemon")
    if not isinstance(daemon, dict):
        return f"{label}.daemon은 JSON 객체여야 합니다."
    if "appendSystemPrompt" in daemon and daemon["appendSystemPrompt"] is not None:
        if not isinstance(daemon["appendSystemPrompt"], str):
            return f"{label}.daemon.appendSystemPrompt는 문자열이어야 합니다."
    profiles = daemon.get("agentProfiles")
    if profiles is not None and not isinstance(profiles, list):
        return f"{label}.daemon.agentProfiles는 배열이어야 합니다."
    return None


def validate_value_line(value: str) -> str | None:
    if value == "":
        return "--value는 비어 있지 않은 한 줄이어야 합니다."
    if "\n" in value or "\r" in value:
        return "--value는 개행이 없는 한 줄이어야 합니다."
    return None


def resolve_config_path(
    args: argparse.Namespace, errors: list[dict[str, Any]]
) -> tuple[Path | None, Path | None, Path | None]:
    status = try_status()
    home, log_path = runtime_from_status(status)
    override = Path(args.config) if args.config else None
    if override is not None:
        return override, home / "config.json" if home is not None else None, log_path
    if home is None:
        errors.append(
            error_item("CONFIG_PATH", "paseo status의 home 또는 --config가 필요합니다.")
        )
        return None, None, log_path
    return home / "config.json", home / "config.json", log_path


def apply_value(
    *,
    config_path: Path,
    initial_raw: bytes,
    planned_raw: bytes,
    expected_value: str,
    remainder_meta: dict[str, Any],
    backup_path: Path,
    do_reload: bool,
    log_path: Path | None,
    errors: list[dict[str, Any]],
) -> dict[str, Any]:
    operation: dict[str, Any] = {
        "attempted": True,
        "backupPath": None,
        "written": False,
        "reload": None,
        "rollback": None,
        "ok": False,
        "unverified": False,
    }
    created_backup: Path | None = None
    try:
        created_backup = create_backup(config_path, backup_path)
        operation["backupPath"] = path_text(created_backup)
        if sha256_bytes(created_backup.read_bytes()) != sha256_bytes(initial_raw):
            raise RuntimeError("생성한 백업의 hash가 최초 config.json과 다릅니다.")
        rechecked_raw = config_path.read_bytes()
        if sha256_bytes(rechecked_raw) != sha256_bytes(initial_raw):
            raise RuntimeError("백업 직후 config.json이 변경되어 적용을 중단했습니다.")

        before_text = decode_utf8(initial_raw, "config.json")
        planned_text = decode_utf8(planned_raw, "계획된 config.json")
        if not remainder_preserved(before_text, planned_text, remainder_meta):
            raise RuntimeError("계획된 문서에서 appendSystemPrompt 값 이외의 바이트가 달라졌습니다.")
        if raw_daemon_property_bytes(planned_raw, "agentProfiles") != raw_daemon_property_bytes(
            initial_raw, "agentProfiles"
        ):
            raise RuntimeError("계획된 문서에서 agentProfiles 원문 바이트가 달라졌습니다.")

        atomic_write_bytes(config_path, planned_raw, sha256_bytes(initial_raw))
        operation["written"] = True
        written_raw = config_path.read_bytes()
        if written_raw != planned_raw:
            raise RuntimeError("기록된 config.json 바이트가 계획과 다릅니다.")
        written_text = decode_utf8(written_raw, "기록된 config.json")
        if not remainder_preserved(before_text, written_text, remainder_meta):
            raise RuntimeError("기록 뒤 appendSystemPrompt 값 이외의 바이트가 달라졌습니다.")
        _, written_document = load_json_bytes(config_path, "기록된 config.json")
        if prompt_value(written_document) != expected_value:
            raise RuntimeError("기록된 appendSystemPrompt가 요청 값과 다릅니다.")
        if raw_daemon_property_bytes(written_raw, "agentProfiles") != raw_daemon_property_bytes(
            initial_raw, "agentProfiles"
        ):
            raise RuntimeError("기록 뒤 daemon.agentProfiles 원문 바이트가 실행 전과 다릅니다.")

        if do_reload:
            operation["reload"] = reload_and_verify(log_path)
            if not operation["reload"].get("ok"):
                raise RuntimeError("paseo daemon reload 또는 데몬 로그 재적재 확인에 실패했습니다.")
            operation["ok"] = True
        else:
            operation["reload"] = skipped_reload_result()
            operation["unverified"] = True
        return operation
    except (OSError, ValueError, RuntimeError, TypeError) as exc:
        errors.append(error_item("APPLY", str(exc), path_text(config_path)))
        if operation["written"] and created_backup is not None:
            rollback_info: dict[str, Any] = {"attempted": True, "ok": False, "backupPath": path_text(created_backup)}
            try:
                restore_bytes(config_path, created_backup)
                rollback_info["restored"] = True
                failed_reload = operation.get("reload") or {}
                command_accepted = bool((failed_reload.get("command") or {}).get("ok"))
                if do_reload and command_accepted:
                    rollback_info["reload"] = reload_and_verify(log_path)
                    rollback_info["ok"] = bool(rollback_info["reload"].get("ok"))
                else:
                    rollback_info["ok"] = True
                if config_path.read_bytes() != initial_raw:
                    rollback_info["ok"] = False
                    raise RuntimeError("롤백 뒤 config.json 바이트가 실행 전과 다릅니다.")
            except (OSError, ValueError, RuntimeError) as rollback_exc:
                rollback_info["error"] = str(rollback_exc)
                errors.append(
                    error_item("ROLLBACK", "적용 실패 뒤 백업 복원에 실패했습니다.", path_text(config_path))
                )
            operation["rollback"] = rollback_info
        return operation


def apply_rollback(
    *,
    config_path: Path,
    backup_path: Path,
    do_reload: bool,
    log_path: Path | None,
    errors: list[dict[str, Any]],
) -> dict[str, Any]:
    operation: dict[str, Any] = {
        "attempted": True,
        "safetyBackupPath": None,
        "restored": False,
        "reload": None,
        "ok": False,
        "unverified": False,
    }
    safety_backup: Path | None = None
    try:
        safety_backup = create_backup(
            config_path, backup_path_for(config_path, "rollback", config_path.read_bytes())
        )
        operation["safetyBackupPath"] = path_text(safety_backup)
        restore_bytes(config_path, backup_path)
        operation["restored"] = True
        if do_reload:
            operation["reload"] = reload_and_verify(log_path)
            if not operation["reload"].get("ok"):
                raise RuntimeError("rollback 뒤 paseo daemon reload 또는 재적재 확인에 실패했습니다.")
            operation["ok"] = True
        else:
            operation["reload"] = skipped_reload_result()
            operation["unverified"] = True
        return operation
    except (OSError, ValueError, RuntimeError, TypeError) as exc:
        errors.append(error_item("ROLLBACK", str(exc), path_text(config_path)))
        if operation["restored"] and safety_backup is not None:
            try:
                restore_bytes(config_path, safety_backup)
            except (OSError, ValueError, RuntimeError) as recovery_exc:
                errors.append(error_item("ROLLBACK_RECOVERY", str(recovery_exc), path_text(config_path)))
        return operation


def execute(argv: Sequence[str] | None = None) -> int:
    parser = make_parser()
    errors: list[dict[str, Any]] = []
    try:
        args = parser.parse_args(argv)
    except ValueError as exc:
        result = base_result(None)
        errors.append(error_item("ARGUMENT", str(exc)))
        return finish(result, errors, EXIT_VALIDATION_ERROR)

    result = base_result(args)
    if args.rollback is not None and args.value is not None:
        errors.append(error_item("ARGUMENT", "--value와 --rollback은 함께 사용할 수 없습니다."))
    if args.rollback is None and args.value is None:
        errors.append(error_item("ARGUMENT", "--value 또는 --rollback이 필요합니다."))
    if args.value is not None:
        value_problem = validate_value_line(args.value)
        if value_problem is not None:
            errors.append(error_item("ARGUMENT", value_problem))
    config_path, daemon_config, log_path = resolve_config_path(args, errors)
    result["configPath"] = path_text(config_path)
    if errors:
        return finish(result, errors, EXIT_VALIDATION_ERROR)
    assert config_path is not None

    if not config_path.is_file():
        errors.append(error_item("FILE_READ", "config.json이 없습니다.", path_text(config_path)))
        stderr_line(f"config.json이 없습니다: {path_text(config_path)}")
        return finish(result, errors, EXIT_VALIDATION_ERROR)

    try:
        raw, document = load_json_bytes(config_path, "config.json")
    except (OSError, ValueError) as exc:
        errors.append(error_item("JSON", str(exc), path_text(config_path)))
        return finish(result, errors, EXIT_VALIDATION_ERROR)

    problem = validate_config_document(document, "config.json")
    if problem is not None:
        errors.append(error_item("CONFIG", problem, path_text(config_path)))
        return finish(result, errors, EXIT_VALIDATION_ERROR)

    result["configSha256Before"] = sha256_bytes(raw)
    result["agentProfilesSha256Before"] = sha256_bytes(raw_daemon_property_bytes(raw, "agentProfiles"))
    script_path = path_text(Path(__file__)) or "append_system_prompt.py"
    config_path_text = path_text(config_path) or str(config_path)
    do_reload = bool(args.apply) and should_reload(config_path, daemon_config)
    text = decode_utf8(raw, "config.json")

    if args.rollback is not None:
        backup_path = Path(args.rollback)
        result["backupPath"] = path_text(backup_path)
        restore = rollback_command(script_path, config_path_text, path_text(backup_path) or str(backup_path))
        if not backup_path.is_file():
            errors.append(error_item("FILE_READ", "백업 파일이 없습니다.", path_text(backup_path)))
            return finish(result, errors, EXIT_VALIDATION_ERROR)
        try:
            backup_raw, backup_document = load_json_bytes(backup_path, "복원 백업")
        except (OSError, ValueError) as exc:
            errors.append(error_item("JSON", str(exc), path_text(backup_path)))
            return finish(result, errors, EXIT_VALIDATION_ERROR)
        backup_problem = validate_config_document(backup_document, "복원 백업")
        if backup_problem is not None:
            errors.append(error_item("CONFIG", backup_problem, path_text(backup_path)))
            return finish(result, errors, EXIT_VALIDATION_ERROR)
        result["presentation"] = presentation_fields(
            config_path=config_path_text,
            proposed=prompt_value(backup_document) or "",
            diff_text=unified_prompt_diff(prompt_value(document) or "", prompt_value(backup_document) or ""),
            backup_path=path_text(backup_path),
            restore=restore,
        )
        emit_presentation(result["presentation"])
        if not args.apply:
            result["action"] = "rollback-dry-run"
            result["configSha256After"] = sha256_bytes(config_path.read_bytes())
            result["agentProfilesSha256After"] = result["agentProfilesSha256Before"]
            return finish(result, errors, EXIT_OK)
        operation = apply_rollback(
            config_path=config_path,
            backup_path=backup_path,
            do_reload=do_reload,
            log_path=log_path,
            errors=errors,
        )
        result["rollback"] = operation
        result["reload"] = operation.get("reload")
        result["backupPath"] = operation.get("safetyBackupPath")
        after_raw = config_path.read_bytes()
        result["configSha256After"] = sha256_bytes(after_raw)
        try:
            result["agentProfilesSha256After"] = sha256_bytes(
                raw_daemon_property_bytes(after_raw, "agentProfiles")
            )
        except (OSError, ValueError):
            result["agentProfilesSha256After"] = None
        if operation.get("ok") and after_raw == backup_raw:
            result["action"] = "rolled-back"
            result["message"] = "백업으로 되돌렸습니다. " + EFFECT_FROM
            return finish(result, errors, EXIT_OK)
        if operation.get("unverified") and operation.get("restored") and after_raw == backup_raw:
            result["action"] = "rolled-back-unverified"
            result["message"] = "적용했으나 반영을 검증하지 않았다. " + EFFECT_FROM
            return finish(result, errors, EXIT_UNVERIFIED)
        result["action"] = "rollback-failed"
        result["message"] = "롤백에 실패했습니다."
        return finish(result, errors, EXIT_APPLY_FAILURE)

    assert args.value is not None
    current = prompt_value(document) or ""
    proposed_line = args.value
    if already_has_line(current, proposed_line):
        result["alreadyPresent"] = True
        result["action"] = "already-present"
        result["message"] = "이미 있다"
        result["configSha256After"] = sha256_bytes(raw)
        result["agentProfilesSha256After"] = result["agentProfilesSha256Before"]
        return finish(result, errors, EXIT_OK)

    new_value = append_line(current, proposed_line)
    planned_text, remainder_meta = splice_prompt_value(text, new_value)
    planned_raw = planned_text.encode("utf-8")
    planned_backup = backup_path_for(config_path, "apply", raw)
    planned_backup_text = path_text(planned_backup) or str(planned_backup)
    restore = rollback_command(script_path, config_path_text, planned_backup_text)
    result["backupPath"] = planned_backup_text
    result["presentation"] = presentation_fields(
        config_path=config_path_text,
        proposed=proposed_line,
        diff_text=unified_prompt_diff(current, new_value),
        backup_path=planned_backup_text,
        restore=restore,
    )
    emit_presentation(result["presentation"])

    if not args.apply:
        result["action"] = "dry-run"
        result["message"] = "승인 전에는 쓰지 않습니다. --apply는 명시 승인 뒤에만 붙입니다."
        result["configSha256After"] = sha256_bytes(config_path.read_bytes())
        result["agentProfilesSha256After"] = result["agentProfilesSha256Before"]
        return finish(result, errors, EXIT_OK)

    operation = apply_value(
        config_path=config_path,
        initial_raw=raw,
        planned_raw=planned_raw,
        expected_value=new_value,
        remainder_meta=remainder_meta,
        backup_path=planned_backup,
        do_reload=do_reload,
        log_path=log_path,
        errors=errors,
    )
    result["backupPath"] = operation.get("backupPath") or planned_backup_text
    result["reload"] = operation.get("reload")
    result["rollback"] = operation.get("rollback")
    if operation.get("backupPath"):
        result["presentation"]["restore"]["backupPath"] = operation["backupPath"]
        result["presentation"]["restore"]["command"] = rollback_command(
            script_path, config_path_text, operation["backupPath"]
        )
    after_raw = config_path.read_bytes()
    result["configSha256After"] = sha256_bytes(after_raw)
    try:
        result["agentProfilesSha256After"] = sha256_bytes(
            raw_daemon_property_bytes(after_raw, "agentProfiles")
        )
    except (OSError, ValueError):
        result["agentProfilesSha256After"] = None

    if operation.get("ok"):
        result["action"] = "applied"
        result["message"] = "daemon.appendSystemPrompt를 반영했습니다. " + EFFECT_FROM
        return finish(result, errors, EXIT_OK)

    if operation.get("unverified") and operation.get("written"):
        result["action"] = "applied-unverified"
        result["message"] = "적용했으나 반영을 검증하지 않았다. " + EFFECT_FROM
        return finish(result, errors, EXIT_UNVERIFIED)

    result["action"] = "apply-failed"
    rolled = operation.get("rollback") or {}
    if rolled.get("ok"):
        result["message"] = "반영이 실패해 백업으로 되돌렸습니다. config 바이트가 실행 전과 같습니다."
    else:
        result["message"] = "반영에 실패했습니다."
    return finish(result, errors, EXIT_APPLY_FAILURE)


def main(argv: Sequence[str] | None = None) -> int:
    try:
        return execute(argv)
    except KeyboardInterrupt:
        result = base_result(None)
        return finish(result, [error_item("INTERRUPTED", "사용자 인터럽트로 작업이 중단되었습니다.")], EXIT_APPLY_FAILURE)
    except Exception as exc:
        result = base_result(None)
        return finish(result, [error_item("UNEXPECTED", f"예상하지 못한 내부 오류: {exc}")], EXIT_APPLY_FAILURE)


if __name__ == "__main__":
    raise SystemExit(main())
