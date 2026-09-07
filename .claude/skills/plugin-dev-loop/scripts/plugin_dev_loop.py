#!/usr/bin/env python3
"""Inspect, register, and loop-install this worktree as a local plugin marketplace.

Default is read-only ``check``. Mutations require ``--yes``.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import subprocess
import sys
from typing import Any
from urllib.parse import unquote, urlparse

EXIT_OK = 0
EXIT_NEEDS_APPROVAL = 2
EXIT_ERROR = 3
AGENTS = ("claude", "codex")
TIMEOUT_READ = 60
TIMEOUT_MUTATE = 180
EXTENDED_PREFIX = "\\\\?\\"
CLAUDE_LOCAL_SOURCES = {"directory", "local"}
_SUBPROCESS_FNS = ("run", "Popen", "call", "check_call", "check_output")
_OS_SPAWN_FNS = (
    "system", "popen", "startfile",
    "spawnl", "spawnle", "spawnlp", "spawnlpe",
    "spawnv", "spawnve", "spawnvp", "spawnvpe",
    "execl", "execle", "execlp", "execlpe",
    "execv", "execve", "execvp", "execvpe",
    "posix_spawn", "posix_spawnp",
)


class ProcessExecutionBlocked(RuntimeError):
    """Raised when a real process would be created during self-test."""


_PROCESS_EXECUTION_BLOCKED = False
_PROCESS_CALLS: list[list[str]] = []
_PROCESS_ENVS: list[dict[str, str | None]] = []
_ACTIVE_ENV: IsolatedEnv | None = None
_RESTORE_MARKETPLACE_LOOKUP: dict[str, str] = {}
ENV_MARKER_NAME = ".plugin-dev-loop-env"
ENV_MARKER_CREATED_BY = "plugin-dev-loop"
ENV_SUBDIR_CODEX = "codex-home"
ENV_SUBDIR_CLAUDE = "claude-config"
ENV_SUBDIR_STATE = "state"
COMMANDS = ("check", "register", "loop", "restore", "init-env", "cleanup-env")
ENV_REQUIRED_ERROR = (
    "워크트리 루트를 구하지 못해 격리 환경을 자동 유도하지 못했습니다. "
    "--env 에 격리 환경 루트를 지정하세요. "
    "형식은 {LOCALAPPDATA}\\plugin-dev-loop\\environments\\<이름> 의 직속 하위입니다."
)


class IsolatedEnv:
    def __init__(self, root: Path, codex_home: Path, claude_config: Path, state_dir: Path) -> None:
        self.root = root
        self.codex_home = codex_home
        self.claude_config = claude_config
        self.state_dir = state_dir


def _blocked_process_call(*args: Any, **kwargs: Any) -> Any:
    argv = args[0] if args else kwargs.get("args")
    raise ProcessExecutionBlocked(
        "self-test isolation: real process creation is blocked"
        + (f": {argv!r}" if argv is not None else "")
    )


def block_process_execution() -> None:
    global _PROCESS_EXECUTION_BLOCKED
    _PROCESS_EXECUTION_BLOCKED = True
    for attr in _SUBPROCESS_FNS:
        setattr(subprocess, attr, _blocked_process_call)
    for attr in _OS_SPAWN_FNS:
        if hasattr(os, attr):
            setattr(os, attr, _blocked_process_call)


def run_process(
    argv: list[str], *, timeout: int | None = None, env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    if _PROCESS_EXECUTION_BLOCKED:
        _PROCESS_CALLS.append(list(argv))
        _PROCESS_ENVS.append({
            "CODEX_HOME": None if env is None else env.get("CODEX_HOME"),
            "CLAUDE_CONFIG_DIR": None if env is None else env.get("CLAUDE_CONFIG_DIR"),
        })
        raise ProcessExecutionBlocked(
            "self-test isolation: real process creation is blocked: " + repr(list(argv))
        )
    return subprocess.run(
        argv, capture_output=True, text=True, encoding="utf-8",
        errors="replace", check=False, timeout=timeout, env=env,
    )


def git_root() -> Path:
    starts = [Path.cwd()]
    script_dir = Path(__file__).resolve().parent
    if script_dir not in starts:
        starts.append(script_dir)
    last_err = ""
    for start in starts:
        proc = run_process(["git", "-C", str(start), "rev-parse", "--show-toplevel"])
        if proc.returncode == 0:
            text = proc.stdout.strip()
            if text:
                return Path(normalize_path_text(text))
        last_err = (proc.stderr or proc.stdout or "").strip()
    raise RuntimeError(
        "git rev-parse --show-toplevel 로 저장소 루트를 구하지 못했습니다"
        + (f": {last_err}" if last_err else "")
    )


def _looks_like_fs_path(value: str) -> bool:
    text = value.strip()
    if not text:
        return False
    if text.casefold().startswith("file:"):
        return True
    if text.startswith(EXTENDED_PREFIX) or text.startswith("//?/"):
        return True
    if len(text) >= 3 and text[1] == ":" and text[0].isalpha():
        return True
    if text.startswith("\\\\") or text.startswith("//"):
        return True
    return text.startswith("/") or text.startswith("./") or text.startswith(".\\")


def decode_path_input(value: str) -> str | None:
    text = value.strip().strip('"')
    if not text:
        return None
    if text.casefold().startswith("file:"):
        parsed = urlparse(text.replace("\\", "/"))
        if parsed.scheme.casefold() != "file":
            return None
        netloc = unquote(parsed.netloc or "")
        path = unquote(parsed.path or "")
        if os.name == "nt" and len(netloc) == 2 and netloc[1] == ":" and netloc[0].isalpha():
            text = netloc + path
        elif netloc and netloc.casefold() not in {"localhost", "localhost."}:
            text = f"//{netloc}{path}"
        else:
            text = path
            if (
                os.name == "nt" and len(text) >= 3
                and text[0] in "/\\" and text[2] == ":" and text[1].isalpha()
            ):
                text = text[1:]
        text = text.strip()
        if not text:
            return None
    elif not _looks_like_fs_path(text):
        return None
    if os.name == "nt":
        alt = text.replace("/", "\\")
        unc_prefix = "\\\\?\\UNC\\"
        if alt.upper().startswith(unc_prefix):
            text = "\\\\" + alt[len(unc_prefix) :]
        elif alt.startswith(EXTENDED_PREFIX):
            text = alt[len(EXTENDED_PREFIX) :]
        else:
            text = alt
    elif text.startswith("//?/UNC/") or text.startswith("//?/unc/"):
        text = "//" + text[8:]
    elif text.startswith("//?/"):
        text = text[4:]
    return text or None


def _is_unc_path(text: str) -> bool:
    if os.name == "nt":
        compact = text.replace("/", "\\")
        return compact.startswith("\\\\") and not compact.startswith("\\\\?\\")
    return text.startswith("//") and not text.startswith("//?/")


def filesystem_path_text(value: str) -> str | None:
    decoded = decode_path_input(value)
    if decoded is None:
        return None
    text = decoded.replace("/", "\\") if os.name == "nt" else decoded
    if os.name == "nt":
        is_drive = len(text) >= 2 and text[1] == ":" and text[0].isalpha()
        if not is_drive and not text.startswith("\\\\"):
            return None
    elif not text.startswith("/"):
        return None
    if _is_unc_path(text):
        return os.path.normcase(text.rstrip("\\")) if os.name == "nt" else text.rstrip("/")
    try:
        text = str(Path(text).resolve())
    except (OSError, ValueError):
        text = str(Path(text))
    if os.name == "nt":
        return os.path.normcase(text.rstrip("\\"))
    return text.rstrip("/")


def normalize_path_text(value: str) -> str:
    fs = filesystem_path_text(value)
    if fs is not None:
        return fs
    text = value.strip().strip('"')
    try:
        text = str(Path(text).resolve())
    except (OSError, ValueError):
        text = str(Path(text))
    return os.path.normcase(text.rstrip("\\")) if os.name == "nt" else text.rstrip("/")


def paths_equal(left: str | Path | None, right: str | Path | None) -> bool:
    if left is None or right is None:
        return False
    first, second = filesystem_path_text(str(left)), filesystem_path_text(str(right))
    return first is not None and second is not None and first == second


def path_is_under(child: str | Path | None, root: str | Path | None) -> bool:
    if child is None or root is None:
        return False
    first, second = filesystem_path_text(str(child)), filesystem_path_text(str(root))
    if first is None or second is None:
        return False
    if first == second:
        return True
    sep = "\\" if os.name == "nt" else "/"
    return first.startswith(second + sep)


def resolve_cli(name: str) -> list[str] | None:
    candidates = (f"{name}.cmd", f"{name}.exe", name) if os.name == "nt" else (name,)
    found = next((shutil.which(c) for c in candidates if shutil.which(c)), None)
    if found is None:
        return None
    path = Path(found)
    if os.name == "nt" and path.suffix.casefold() in {".cmd", ".bat"}:
        comspec = os.environ.get("ComSpec")
        return [comspec, "/d", "/s", "/c"] if comspec else None
    return [found]


def run_cli(name: str, args: list[str], timeout: int = TIMEOUT_READ) -> dict[str, Any]:
    resolved = resolve_cli(name)
    record: dict[str, Any] = {
        "cli": name, "args": args, "ok": False, "returncode": None,
        "stdout": "", "stderr": "", "error": None, "argv": None,
    }
    if resolved is None:
        record["error"] = f"PATH에서 {name} CLI를 찾지 못했습니다."
        return record
    if os.name == "nt" and len(resolved) >= 3 and resolved[1:3] == ["/d", "/s"]:
        exe = shutil.which(f"{name}.cmd") or shutil.which(name)
        argv = [*resolved, subprocess.list2cmdline([exe, *args])]
    else:
        argv = [*resolved, *args]
    record["argv"] = argv
    try:
        proc = run_process(argv, timeout=timeout, env=isolated_child_env())
    except (OSError, subprocess.TimeoutExpired) as exc:
        record["error"] = str(exc)
        return record
    record["returncode"] = proc.returncode
    record["stdout"] = proc.stdout or ""
    record["stderr"] = proc.stderr or ""
    record["ok"] = proc.returncode == 0
    if not record["ok"] and not record["error"]:
        record["error"] = (proc.stderr or proc.stdout or "종료 코드 비0").strip()[:500]
    return record


def parse_json_output(text: str) -> Any:
    stripped = text.strip()
    if not stripped:
        raise ValueError("출력이 비어 있습니다")
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        pass
    for index, char in enumerate(stripped):
        if char not in "{[":
            continue
        try:
            return json.loads(stripped[index:])
        except json.JSONDecodeError:
            continue
    raise ValueError("JSON을 찾지 못했습니다")


def marketplace_manifest(root: Path, agent: str) -> Path:
    if agent == "claude":
        return root / ".claude-plugin" / "marketplace.json"
    return root / ".agents" / "plugins" / "marketplace.json"


def read_plugin_version(root: Path, plugin: str, agent: str) -> str | None:
    folder = ".claude-plugin" if agent == "claude" else ".codex-plugin"
    path = root / "plugins" / plugin / folder / "plugin.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    version = data.get("version")
    return version.strip() if isinstance(version, str) and version.strip() else None


def shell_unsafe_name_reason(value: str) -> str | None:
    for char in value:
        if char in _SHELL_META_CHARS:
            return f"셸 메타문자 {char!r}"
    return None


def load_declared(root: Path, agent: str) -> tuple[str, list[str], dict[str, str | None]]:
    path = marketplace_manifest(root, agent)
    data = json.loads(path.read_text(encoding="utf-8"))
    name = data.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ValueError(f"{path} 에 name이 없습니다")
    name = name.strip()
    unsafe = shell_unsafe_name_reason(name)
    if unsafe is not None:
        raise ValueError(f"{path} 마켓플레이스 이름에 {unsafe} 가 있습니다")
    plugins: list[str] = []
    for entry in data.get("plugins") or []:
        if not isinstance(entry, dict) or not isinstance(entry.get("name"), str):
            continue
        plugin = entry["name"]
        unsafe = shell_unsafe_name_reason(plugin)
        if unsafe is not None:
            raise ValueError(f"{path} 플러그인 이름에 {unsafe} 가 있습니다")
        plugins.append(plugin)
    return name, plugins, {item: read_plugin_version(root, item, agent) for item in plugins}


def _fs_path_field(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    return text if _looks_like_fs_path(text) else None


def marketplace_path_from_entry(agent: str, entry: dict[str, Any]) -> str | None:
    if agent == "claude":
        source = entry.get("source")
        if not isinstance(source, str):
            raise ValueError("claude marketplace 항목 스키마를 찾지 못했습니다")
        if source.casefold() in CLAUDE_LOCAL_SOURCES:
            return _fs_path_field(entry.get("path"))
        return None
    if not isinstance(entry.get("root"), str) or not entry["root"].strip():
        raise ValueError("codex marketplace 항목 스키마를 찾지 못했습니다")
    nested = entry.get("marketplaceSource")
    if nested is None:
        return _fs_path_field(entry["root"])
    if not isinstance(nested, dict) or not isinstance(nested.get("source"), str):
        raise ValueError("codex marketplace 항목 스키마를 찾지 못했습니다")
    return None


def _list_payload(agent: str, payload: Any, *, wrapper: str, label: str) -> list[Any]:
    if agent == "codex":
        if not isinstance(payload, dict) or wrapper not in payload:
            raise ValueError(f"codex {label} 스키마를 찾지 못했습니다")
        items = payload.get(wrapper)
        if not isinstance(items, list):
            raise ValueError(f"codex {label} 스키마를 찾지 못했습니다")
        return items
    if not isinstance(payload, list):
        raise ValueError(f"claude {label} 스키마를 찾지 못했습니다")
    return payload


def parse_marketplaces(agent: str, payload: Any) -> list[dict[str, Any]]:
    items = _list_payload(agent, payload, wrapper="marketplaces", label="marketplace list")
    result: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            raise ValueError("marketplace 항목을 해석하지 못했습니다")
        unsafe = shell_unsafe_name_reason(item["name"])
        if unsafe is not None:
            raise ValueError(f"marketplace 이름에 {unsafe} 가 있습니다")
        result.append({"name": item["name"], "path": marketplace_path_from_entry(agent, item), "raw": item})
    return result


def parse_plugins(agent: str, payload: Any) -> list[dict[str, Any]]:
    items = _list_payload(agent, payload, wrapper="installed", label="plugin list")
    result: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("plugin 항목을 해석하지 못했습니다")
        if agent == "claude":
            ident = item.get("id")
            if not isinstance(ident, str) or not ident:
                raise ValueError("plugin 항목을 해석하지 못했습니다")
            name, market = ident.split("@", 1) if "@" in ident else (ident, "")
            path = _fs_path_field(item.get("installPath"))
        else:
            ident = item.get("pluginId") or ""
            name = item.get("name")
            market = item.get("marketplaceName") or ""
            if isinstance(ident, str) and "@" in ident:
                left, right = ident.split("@", 1)
                name = name or left
                market = market or right
            if not isinstance(name, str):
                raise ValueError("plugin 항목을 해석하지 못했습니다")
            ident = ident if isinstance(ident, str) and ident else f"{name}@{market}"
            source = item.get("source")
            path = _fs_path_field(source.get("path")) if isinstance(source, dict) else None
        for part, label in ((name, "플러그인"), (market if isinstance(market, str) else "", "마켓플레이스")):
            if not part:
                continue
            unsafe = shell_unsafe_name_reason(part)
            if unsafe is not None:
                raise ValueError(f"{label} 이름에 {unsafe} 가 있습니다")
        version = item.get("version")
        result.append({
            "selector": ident,
            "name": name,
            "marketplace": market if isinstance(market, str) else "",
            "version": version if isinstance(version, str) else None,
            "path": path,
        })
    return result


def find_marketplace(listings: list[dict[str, Any]], name: str) -> dict[str, Any] | None:
    return next((item for item in listings if item["name"] == name), None)


def collect_agent(root: Path, agent: str) -> dict[str, Any]:
    report: dict[str, Any] = {
        "agent": agent, "cliFound": resolve_cli(agent) is not None,
        "marketplaceName": None, "declaredPlugins": [], "declaredVersions": {},
        "marketplace": None, "pointsAtWorktree": False, "plugins": [], "errors": [],
    }
    try:
        name, declared, versions = load_declared(root, agent)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        report["errors"].append(f"매니페스트를 읽지 못했습니다: {exc}")
        return report
    report["marketplaceName"] = name
    report["declaredPlugins"] = declared
    report["declaredVersions"] = versions
    if not report["cliFound"]:
        report["errors"].append(f"PATH에서 {agent} CLI를 찾지 못했습니다.")
        return report
    market_run = run_cli(agent, ["plugin", "marketplace", "list", "--json"])
    plugin_run = run_cli(agent, ["plugin", "list", "--json"])
    if not market_run["ok"]:
        report["errors"].append(market_run["error"] or "marketplace list 실패")
    else:
        try:
            listings = parse_marketplaces(agent, parse_json_output(market_run["stdout"]))
            lookup = _RESTORE_MARKETPLACE_LOOKUP.get(agent)
            find_name = lookup if isinstance(lookup, str) and lookup.strip() else name
            report["marketplace"] = find_marketplace(listings, find_name)
        except ValueError as exc:
            report["errors"].append(f"marketplace list JSON 파싱 실패: {exc}")
    if not plugin_run["ok"]:
        report["errors"].append(plugin_run["error"] or "plugin list 실패")
    else:
        try:
            report["plugins"] = parse_plugins(agent, parse_json_output(plugin_run["stdout"]))
        except ValueError as exc:
            report["errors"].append(f"plugin list JSON 파싱 실패: {exc}")
    hit = report["marketplace"]
    if hit and hit.get("path"):
        report["pointsAtWorktree"] = paths_equal(hit["path"], root)
    return report


def _restore_lookup_from_saved(saved: dict[str, Any] | None) -> dict[str, str]:
    result: dict[str, str] = {}
    if not isinstance(saved, dict):
        return result
    for agent, saved_a in (saved.get("agents") or {}).items():
        if not isinstance(saved_a, dict) or saved_a.get("known") is not True:
            continue
        market = saved_a.get("marketplaceName")
        if isinstance(market, str) and market.strip():
            result[str(agent)] = market.strip()
    return result


def _collect_agents_for_restore(
    root: Path, agents: tuple[str, ...], saved: dict[str, Any] | None
) -> dict[str, dict[str, Any]]:
    global _RESTORE_MARKETPLACE_LOOKUP
    previous = _RESTORE_MARKETPLACE_LOOKUP
    _RESTORE_MARKETPLACE_LOOKUP = _restore_lookup_from_saved(saved)
    try:
        return {agent: collect_agent(root, agent) for agent in agents}
    finally:
        _RESTORE_MARKETPLACE_LOOKUP = previous


def restore_path_text(path: str | None) -> str | None:
    return None if path is None else filesystem_path_text(path)


class SnapshotCorrupt(ValueError):
    """스냅샷 파일이 있으나 스키마·JSON이 유효하지 않다."""


def environments_root() -> Path:
    if os.name == "nt":
        raw = os.environ.get("LOCALAPPDATA")
        if not raw or not str(raw).strip():
            raise RuntimeError("LOCALAPPDATA 가 없어 격리 환경 경계를 계산하지 못했습니다.")
        base = Path(raw)
    else:
        raw = os.environ.get("XDG_DATA_HOME")
        if not raw or not str(raw).strip():
            raise RuntimeError("XDG_DATA_HOME 가 없어 격리 환경 경계를 계산하지 못했습니다.")
        base = Path(raw)
    return (base / "plugin-dev-loop" / "environments").resolve(strict=False)


def derived_env_name(worktree: Path | str) -> str:
    normalized = normalize_path_text(str(worktree))
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:8]
    return f"{Path(normalized).name}-{digest}"


def derived_env_root(worktree: Path | str) -> Path:
    return environments_root() / derived_env_name(worktree)


def _require_active_env() -> IsolatedEnv:
    if _ACTIVE_ENV is None:
        raise RuntimeError("격리 환경이 지정되지 않았습니다. --env 로 대상 환경을 지정하세요.")
    return _ACTIVE_ENV


def snapshot_path() -> Path:
    return _require_active_env().state_dir / "snapshot.json"


def env_lock_path() -> Path:
    isolated = _require_active_env()
    return environments_root().parent / "locks" / (isolated.root.name + ".lock")


def isolated_child_env() -> dict[str, str]:
    isolated = _require_active_env()
    merged = os.environ.copy()
    merged["CODEX_HOME"] = str(isolated.codex_home)
    merged["CLAUDE_CONFIG_DIR"] = str(isolated.claude_config)
    return merged


_DELETABLE_PATHS: set[str] = set()
_CREATED_RECORDER: Any = None
_FILE_ATTRIBUTE_REPARSE_POINT = 0x400
_IO_REPARSE_TAG_MOUNT_POINT = 0xA0000003
_IO_REPARSE_TAG_SYMLINK = 0xA000000C
_REPARSE_TREE_PREFIX = "symlink, junction, or reparse point: "
_SHELL_META_CHARS = frozenset("&|<>^\"%()!;,=`'$\n\r\t*?[]{}\\")


def script_worktree_root() -> Path:
    return Path(__file__).resolve().parents[4]


def register_deletable(path: Path | str) -> str | None:
    raw = str(path) if path is not None else ""
    if not raw.strip():
        return "empty or None path"
    target = Path(raw)
    reason = _reparse_in_chain_reason(target)
    if reason is not None:
        print(f"register_deletable refused: {target}: {reason}", file=sys.stderr)
        return reason
    key = str(target.resolve(strict=False))
    _DELETABLE_PATHS.add(key)
    recorder = _CREATED_RECORDER
    if callable(recorder):
        recorder(key)
    return None


def _stat_is_reparse(st: os.stat_result) -> bool:
    if stat.S_ISLNK(st.st_mode):
        return True
    attrs = getattr(st, "st_file_attributes", 0)
    return bool(attrs & _FILE_ATTRIBUTE_REPARSE_POINT)


def _reparse_in_chain_reason(target: Path) -> str | None:
    current = target if target.is_absolute() else (Path.cwd() / target)
    seen: set[str] = set()
    while True:
        ident = str(current)
        if ident in seen:
            break
        seen.add(ident)
        try:
            st = os.lstat(current)
        except OSError as exc:
            return f"lstat failed: {current}: {exc}"
        if _stat_is_reparse(st):
            return f"symlink, junction, or reparse point: {current}"
        parent = current.parent
        if parent == current:
            break
        current = parent
    return None


def _write_chain_reason(target: Path) -> str | None:
    current = target if target.is_absolute() else (Path.cwd() / target)
    seen: set[str] = set()
    while True:
        ident = str(current)
        if ident in seen:
            break
        seen.add(ident)
        try:
            st = os.lstat(current)
        except FileNotFoundError:
            parent = current.parent
            if parent == current:
                break
            current = parent
            continue
        except OSError as exc:
            return f"lstat failed: {current}: {exc}"
        if _stat_is_reparse(st):
            return f"symlink, junction, or reparse point: {current}"
        parent = current.parent
        if parent == current:
            break
        current = parent
    return None


def _is_self_or_ancestor(candidate: Path, of_base: Path) -> bool:
    return candidate == of_base or candidate in of_base.parents


def _protected_reason(target: Path) -> str | None:
    if target.anchor == str(target):
        return "drive root"
    for label, base in (
        ("home", Path.home().resolve(strict=False)),
        ("cwd", Path.cwd().resolve(strict=False)),
        ("worktree", script_worktree_root()),
    ):
        if _is_self_or_ancestor(target, base):
            return label
    return None


def gated_delete(path: str | Path | None) -> str | None:
    if path is None:
        return "empty or None path"
    raw = str(path)
    if not raw.strip():
        return "empty or None path"
    target = Path(raw)
    chain_reason = _reparse_in_chain_reason(target)
    if chain_reason is not None:
        return chain_reason
    try:
        st = os.lstat(target)
    except OSError as exc:
        return f"lstat failed: {exc}"
    if _stat_is_reparse(st):
        return "symlink, junction, or reparse point"
    resolved = target.resolve(strict=False)
    protected = _protected_reason(resolved)
    if protected is not None:
        return protected
    key = str(resolved)
    if key not in _DELETABLE_PATHS:
        return "path is not in the registered deletable set"
    try:
        if stat.S_ISDIR(st.st_mode):
            os.rmdir(target)
        else:
            os.remove(target)
    except OSError as exc:
        return f"delete failed: {exc}"
    return None


def _plugin_install_root(agent: str) -> Path:
    isolated = _require_active_env()
    if agent == "claude":
        return (isolated.claude_config / "plugins").resolve(strict=False)
    return isolated.codex_home.resolve(strict=False)


def should_plan_plugin_remove(
    agent: str,
    plugin_name: str,
    install_path: str | None,
    snapshot_plugin_names: set[str],
) -> tuple[bool, str]:
    if install_path is not None and str(install_path).strip():
        resolved = Path(str(install_path)).resolve(strict=False)
        root = _plugin_install_root(agent)
        try:
            resolved.relative_to(root)
        except ValueError:
            return False, f"{plugin_name}: install path is not under {root}"
        if resolved == root:
            return False, f"{plugin_name}: install path is the plugins root"
        return True, ""
    if plugin_name in snapshot_plugin_names:
        return True, ""
    return False, f"{plugin_name}: list has no install path and name is not in the snapshot"


def cleanup_self_test_tmp(tmp_root: Path, created: set[str]) -> list[str]:
    tmp_key = str(Path(tmp_root).resolve(strict=False))
    try:
        root_st = os.lstat(tmp_root)
    except OSError as exc:
        print(f"self-test leftover (no delete): {tmp_key}: {exc}", file=sys.stderr)
        return [tmp_key]
    if _stat_is_reparse(root_st):
        print(f"self-test leftover (no delete): {tmp_key}", file=sys.stderr)
        return [tmp_key]
    problems: list[str] = []
    stack = [Path(tmp_root)]
    while stack:
        current = stack.pop()
        try:
            entries = list(os.scandir(current))
        except OSError as exc:
            problems.append(f"{current}: scandir failed: {exc}")
            continue
        for entry in entries:
            try:
                st = entry.stat(follow_symlinks=False)
            except OSError as exc:
                problems.append(f"{entry.path}: lstat failed: {exc}")
                continue
            if _stat_is_reparse(st):
                problems.append(f"{entry.path}: reparse/symlink/junction")
                continue
            key = str(Path(entry.path).resolve(strict=False))
            if key not in created:
                problems.append(f"{entry.path}: not in created list")
            if stat.S_ISDIR(st.st_mode):
                stack.append(Path(entry.path))
    if problems:
        print(f"self-test leftover (no delete): {tmp_key}", file=sys.stderr)
        for item in problems:
            print(f"  {item}", file=sys.stderr)
        return [tmp_key]
    leftovers: list[str] = []
    files: list[Path] = []
    dirs: list[Path] = []
    for item in created:
        path = Path(item)
        try:
            st = os.lstat(path)
        except OSError:
            continue
        if _stat_is_reparse(st):
            print(f"self-test leftover (no delete): {tmp_key}", file=sys.stderr)
            return [tmp_key]
        if stat.S_ISDIR(st.st_mode):
            dirs.append(path)
        else:
            files.append(path)
    for path in files:
        reason = gated_delete(path)
        if reason is not None:
            leftovers.append(f"{path}: {reason}")
    for path in sorted(dirs, key=lambda p: len(str(p)), reverse=True):
        reason = gated_delete(path)
        if reason is not None:
            leftovers.append(f"{path}: {reason}")
    if leftovers:
        print("self-test leftover:", file=sys.stderr)
        for item in leftovers:
            print(f"  {item}", file=sys.stderr)
    return leftovers


def _resolve_env_root(root: Path, *, must_exist: bool) -> Path:
    raw = str(root).strip()
    if not raw:
        raise RuntimeError("격리 환경 경로가 비어 있습니다.")
    decoded = decode_path_input(raw)
    text = decoded if decoded is not None else raw
    if os.name == "nt":
        text = text.replace("/", "\\")
    path = Path(text)
    if not path.is_absolute():
        path = Path.cwd() / path
    chain = _reparse_in_chain_reason(path) if must_exist else _write_chain_reason(path)
    if chain is not None:
        raise RuntimeError(f"격리 환경 경로를 사용할 수 없습니다: {chain}")
    try:
        path = path.resolve(strict=False)
    except (OSError, ValueError) as exc:
        raise RuntimeError(f"격리 환경 절대 경로를 구하지 못했습니다: {exc}") from exc
    return path


def _assert_env_in_allowed_boundary(root: Path) -> None:
    parent = environments_root()
    if not paths_equal(root.parent, parent):
        raise RuntimeError(f"격리 환경이 허용된 상위 경계의 직속 하위가 아닙니다: {root}")
    protected = _protected_reason(root)
    if protected is not None:
        raise RuntimeError(f"격리 환경 경로가 보호 대상입니다: {protected}")


def validate_isolated_env_layout(root: Path) -> IsolatedEnv:
    if not root.is_dir():
        raise RuntimeError(f"격리 환경이 없습니다: {root}")
    subdirs: dict[str, Path] = {}
    for name in (ENV_SUBDIR_CODEX, ENV_SUBDIR_CLAUDE, ENV_SUBDIR_STATE):
        sub = root / name
        chain = _reparse_in_chain_reason(sub)
        if chain is not None:
            raise RuntimeError(f"격리 환경 구조가 맞지 않습니다: {name}: {chain}")
        try:
            st = os.lstat(sub)
        except OSError as exc:
            raise RuntimeError(f"격리 환경 구조가 맞지 않습니다: {name}: {exc}") from exc
        if not stat.S_ISDIR(st.st_mode):
            raise RuntimeError(f"격리 환경 구조가 맞지 않습니다: {name} 가 디렉터리가 아닙니다")
        subdirs[name] = sub.resolve(strict=False)
    isolated = IsolatedEnv(
        root=root.resolve(strict=False),
        codex_home=subdirs[ENV_SUBDIR_CODEX],
        claude_config=subdirs[ENV_SUBDIR_CLAUDE],
        state_dir=subdirs[ENV_SUBDIR_STATE],
    )
    _files, _dirs, tree_reason = _collect_env_tree(isolated.root)
    if tree_reason is not None:
        raise RuntimeError(format_isolated_env_tree_error(isolated.root, tree_reason))
    return isolated


def env_marker_reason(root: Path) -> str | None:
    path = root / ENV_MARKER_NAME
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return "tool marker missing"
    except OSError as exc:
        return f"marker lstat failed: {exc}"
    if _stat_is_reparse(st):
        return "marker is reparse"
    if not stat.S_ISREG(st.st_mode):
        return "marker is not a regular file"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        return f"marker read failed: {exc}"
    except (ValueError, json.JSONDecodeError):
        return "marker is not valid JSON"
    if (
        not isinstance(data, dict)
        or data.get("created_by") != ENV_MARKER_CREATED_BY
        or data.get("kind") != "isolated-env"
    ):
        return "marker is not a plugin-dev-loop environment"
    return None


def write_env_marker(root: Path) -> str | None:
    path = root / ENV_MARKER_NAME
    reason = _write_chain_reason(path)
    if reason is not None:
        return reason
    payload = {"created_by": ENV_MARKER_CREATED_BY, "kind": "isolated-env"}
    try:
        path.write_text(json.dumps(payload, ensure_ascii=False) + "\n", encoding="utf-8")
    except OSError as exc:
        return f"marker write failed: {exc}"
    register_deletable(path)
    return None


def _inherited_env_mismatch_reason(isolated: IsolatedEnv) -> str | None:
    mapping = (
        ("CODEX_HOME", isolated.codex_home),
        ("CLAUDE_CONFIG_DIR", isolated.claude_config),
    )
    for key, expected in mapping:
        raw = os.environ.get(key)
        if raw is None:
            continue
        if not str(raw).strip() or not paths_equal(raw, expected):
            return f"{key} 가 지정 환경과 일치하지 않습니다"
    return None


def inspect_env_for_use(root: Path) -> IsolatedEnv:
    resolved = _resolve_env_root(root, must_exist=True)
    _assert_env_in_allowed_boundary(resolved)
    return validate_isolated_env_layout(resolved)


def activate_isolated_env(root: Path) -> IsolatedEnv:
    isolated = inspect_env_for_use(root)
    mismatch = _inherited_env_mismatch_reason(isolated)
    if mismatch is not None:
        raise RuntimeError(mismatch)
    global _ACTIVE_ENV
    _ACTIVE_ENV = isolated
    return isolated


def resolve_env_root_from_args(args: argparse.Namespace) -> Path:
    raw = getattr(args, "env", None)
    if raw is not None and str(raw).strip():
        return Path(str(raw))
    try:
        worktree = git_root()
    except ProcessExecutionBlocked:
        raise
    except RuntimeError as exc:
        raise RuntimeError(ENV_REQUIRED_ERROR) from exc
    return derived_env_root(worktree)


def bind_isolated_env_from_args(args: argparse.Namespace) -> IsolatedEnv:
    return activate_isolated_env(resolve_env_root_from_args(args))


def _collect_env_tree(env_root: Path) -> tuple[list[Path], list[Path], str | None]:
    files: list[Path] = []
    dirs: list[Path] = []
    stack = [env_root]
    seen: set[str] = set()
    bound = env_root.resolve(strict=False)
    while stack:
        current = stack.pop()
        ident = str(current)
        if ident in seen:
            continue
        seen.add(ident)
        try:
            st = os.lstat(current)
        except OSError as exc:
            return [], [], f"lstat failed: {current}: {exc}"
        if _stat_is_reparse(st):
            return [], [], f"{_REPARSE_TREE_PREFIX}{current}"
        resolved = current.resolve(strict=False)
        if not path_is_under(resolved, bound):
            return [], [], f"path resolves outside the environment: {current}"
        if stat.S_ISDIR(st.st_mode):
            dirs.append(current)
            try:
                entries = list(os.scandir(current))
            except OSError as exc:
                return [], [], f"scandir failed: {current}: {exc}"
            for entry in entries:
                stack.append(Path(entry.path))
        else:
            files.append(current)
    return files, dirs, None


def _cmd_quoted_path(path: str) -> str:
    return '"' + path.replace('"', '""') + '"'


def _reparse_kind(st: os.stat_result) -> str:
    tag = int(getattr(st, "st_reparse_tag", 0) or 0)
    if tag == _IO_REPARSE_TAG_MOUNT_POINT:
        return "junction"
    if stat.S_ISLNK(st.st_mode) or tag == _IO_REPARSE_TAG_SYMLINK:
        return "symlink"
    return "reparse point"


def _unlink_link_command(abs_link: str, st: os.stat_result) -> str:
    quoted = _cmd_quoted_path(abs_link)
    if os.name == "nt":
        if stat.S_ISDIR(st.st_mode):
            return f"cmd.exe /d /c rmdir {quoted}"
        return f"cmd.exe /d /c del /f /q {quoted}"
    return f"rm -- {quoted}"


def format_isolated_env_tree_error(env_root: Path, tree_reason: str) -> str:
    lines = [
        "격리 환경 하위에 junction/symlink/reparse point 가 있거나 트리를 확인하지 못해 거부합니다. --yes 가 있어도 거부합니다.",
    ]
    link: Path | None = None
    if tree_reason.startswith(_REPARSE_TREE_PREFIX):
        link = Path(tree_reason[len(_REPARSE_TREE_PREFIX):])
    if link is None:
        lines.append(f"검사 실패 이유: {tree_reason}")
    else:
        abs_link = os.path.abspath(str(link))
        lines.append(f"링크 절대경로: {abs_link}")
        try:
            st = os.lstat(link)
        except OSError as exc:
            lines.append("링크 종류: (lstat 실패)")
            lines.append("연결 대상 경로: (읽지 못함)")
            lines.append(f"검사 실패 이유: lstat failed: {exc}")
            st = None
        else:
            kind = _reparse_kind(st)
            lines.append(f"링크 종류: {kind}")
            try:
                target = os.readlink(link)
                lines.append(f"연결 대상 경로: {target}")
                lines.append("검사 실패 이유: 없음 (링크를 확인했습니다)")
            except OSError as exc:
                lines.append("연결 대상 경로: (읽지 못함)")
                lines.append(f"검사 실패 이유: 연결 대상을 읽지 못했습니다: {exc}")
            lines.append(f"링크만 비재귀 제거 (연결 대상은 건드리지 않음): {_unlink_link_command(abs_link, st)}")
    snap = env_root / ENV_SUBDIR_STATE / "snapshot.json"
    snap_abs = os.path.abspath(str(snap))
    snap_state = "있음" if snap.is_file() else "없음"
    lines.append(f"스냅샷 위치: {snap_abs} ({snap_state})")
    lines.append("재개 절차: 위 제거 명령을 사람이 실행한 뒤 같은 plugin_dev_loop 명령을 다시 실행하세요.")
    lines.append("예: python scripts/plugin_dev_loop.py check")
    lines.append("예: python scripts/plugin_dev_loop.py restore --yes")
    return "\n".join(lines)


def inspect_cleanup_target(
    root: Path,
) -> tuple[IsolatedEnv | None, list[Path], list[Path], str | None]:
    try:
        resolved = _resolve_env_root(root, must_exist=True)
        _assert_env_in_allowed_boundary(resolved)
        isolated = validate_isolated_env_layout(resolved)
    except RuntimeError as exc:
        return None, [], [], str(exc)
    marker_reason = env_marker_reason(isolated.root)
    if marker_reason is not None:
        return None, [], [], marker_reason
    files, dirs, tree_reason = _collect_env_tree(isolated.root)
    if tree_reason is not None:
        return None, [], [], tree_reason
    return isolated, files, dirs, None


def run_init_env(args: argparse.Namespace) -> int:
    raw = resolve_env_root_from_args(args)
    try:
        target = _resolve_env_root(Path(str(raw)), must_exist=False)
        _assert_env_in_allowed_boundary(target)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return EXIT_ERROR
    try:
        st = os.lstat(target)
        exists = True
    except FileNotFoundError:
        exists = False
        st = None
    except OSError as exc:
        print(f"격리 환경 경로를 확인할 수 없습니다: {exc}", file=sys.stderr)
        return EXIT_ERROR
    if exists:
        if _stat_is_reparse(st) or not stat.S_ISDIR(st.st_mode):
            print("격리 환경 경로가 디렉터리가 아닙니다.", file=sys.stderr)
            return EXIT_ERROR
        marker_reason = env_marker_reason(target)
        if marker_reason is not None:
            print(
                f"init-env 거부: 기존 경로를 도구 환경으로 바꾸지 않습니다: {marker_reason}",
                file=sys.stderr,
            )
            return EXIT_ERROR
        try:
            validate_isolated_env_layout(target)
        except RuntimeError as exc:
            print(str(exc), file=sys.stderr)
            return EXIT_ERROR
        print(f"init-env: 이미 도구 환경입니다: {target}")
        return EXIT_OK
    if not args.yes:
        print(f"init-env 계획: {target} 에 격리 환경을 만듭니다. --yes 가 필요합니다.")
        return EXIT_NEEDS_APPROVAL
    parent = environments_root()
    try:
        parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        print(f"허용된 상위 경계를 만들지 못했습니다: {exc}", file=sys.stderr)
        return EXIT_ERROR
    register_deletable(parent)
    try:
        target.mkdir(parents=False, exist_ok=False)
    except OSError as exc:
        print(f"격리 환경을 만들지 못했습니다: {exc}", file=sys.stderr)
        return EXIT_ERROR
    register_deletable(target)
    for name in (ENV_SUBDIR_CODEX, ENV_SUBDIR_CLAUDE, ENV_SUBDIR_STATE):
        sub = target / name
        try:
            sub.mkdir()
        except OSError as exc:
            print(f"격리 환경 하위 디렉터리를 만들지 못했습니다: {exc}", file=sys.stderr)
            return EXIT_ERROR
        register_deletable(sub)
    marker_reason = write_env_marker(target)
    if marker_reason is not None:
        print(f"도구 마커를 쓰지 못했습니다: {marker_reason}", file=sys.stderr)
        return EXIT_ERROR
    print(f"init-env: {target}")
    return EXIT_OK


def run_cleanup_env(args: argparse.Namespace) -> int:
    raw = resolve_env_root_from_args(args)
    isolated, files, dirs, reason = inspect_cleanup_target(Path(str(raw)))
    if reason is not None or isolated is None:
        print(f"cleanup-env 거부: {reason}", file=sys.stderr)
        return EXIT_ERROR
    global _ACTIVE_ENV
    previous = _ACTIVE_ENV
    _ACTIVE_ENV = isolated
    lock = SnapshotLock()
    try:
        lock.acquire()
    except RuntimeError as exc:
        _ACTIVE_ENV = previous
        print(f"cleanup-env 거부: {exc}", file=sys.stderr)
        return EXIT_ERROR
    try:
        isolated, files, dirs, reason = inspect_cleanup_target(isolated.root)
        if reason is not None or isolated is None:
            print(f"cleanup-env 거부: {reason}", file=sys.stderr)
            return EXIT_ERROR
        if not args.yes:
            print(f"cleanup-env 계획: {isolated.root} 를 삭제합니다. --yes 가 필요합니다.")
            return EXIT_NEEDS_APPROVAL
        for path in files:
            register_reason = register_deletable(path)
            if register_reason is not None:
                print(f"cleanup-env 거부: {path}: {register_reason}", file=sys.stderr)
                return EXIT_ERROR
        for path in dirs:
            register_reason = register_deletable(path)
            if register_reason is not None:
                print(f"cleanup-env 거부: {path}: {register_reason}", file=sys.stderr)
                return EXIT_ERROR
        for path in files:
            delete_reason = gated_delete(path)
            if delete_reason is not None:
                print(f"cleanup-env 거부: {path}: {delete_reason}", file=sys.stderr)
                return EXIT_ERROR
        for path in sorted(dirs, key=lambda item: len(str(item)), reverse=True):
            delete_reason = gated_delete(path)
            if delete_reason is not None:
                print(f"cleanup-env 거부: {path}: {delete_reason}", file=sys.stderr)
                return EXIT_ERROR
        print(f"cleanup-env: {isolated.root}")
        return EXIT_OK
    finally:
        lock.release()
        _ACTIVE_ENV = previous


def plugin_add_cmd(agent: str, plugin: str, market: str) -> list[str]:
    unsafe = shell_unsafe_name_reason(plugin) or shell_unsafe_name_reason(market)
    if unsafe is not None:
        raise ValueError(f"플러그인 선택자에 {unsafe} 가 있습니다")
    selector = f"{plugin}@{market}"
    if agent == "claude":
        return ["plugin", "install", selector, "-y"]
    return ["plugin", "add", selector]


def plugin_remove_cmd(agent: str, plugin: str, market: str) -> list[str]:
    unsafe = shell_unsafe_name_reason(plugin) or shell_unsafe_name_reason(market)
    if unsafe is not None:
        raise ValueError(f"플러그인 선택자에 {unsafe} 가 있습니다")
    selector = f"{plugin}@{market}"
    if agent == "claude":
        return ["plugin", "uninstall", selector, "-y"]
    return ["plugin", "remove", selector]


def validate_snapshot_schema(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise SnapshotCorrupt("최상위가 객체가 아닙니다")
    if not isinstance(data.get("worktree"), str) or not data["worktree"].strip():
        raise SnapshotCorrupt("worktree 가 없습니다")
    agents = data.get("agents")
    if not isinstance(agents, dict):
        raise SnapshotCorrupt("agents 가 없습니다")
    for agent, entry in agents.items():
        if agent not in AGENTS:
            continue
        if not isinstance(entry, dict) or not isinstance(entry.get("known"), bool):
            raise SnapshotCorrupt(f"{agent} 항목에 known 이 없습니다")
        if not entry["known"]:
            continue
        if not isinstance(entry.get("registered"), bool) or not isinstance(entry.get("plugins"), list):
            raise SnapshotCorrupt(f"{agent} 의 registered/plugins 가 없습니다")
        for index, plugin in enumerate(entry["plugins"]):
            if not isinstance(plugin, dict) or not isinstance(plugin.get("name"), str) or not plugin["name"].strip():
                raise SnapshotCorrupt(f"{agent} plugins[{index}] 이 객체가 아닙니다")
            if plugin.get("marketplace") is not None and not isinstance(plugin.get("marketplace"), str):
                raise SnapshotCorrupt(f"{agent} plugins[{index}] marketplace 타입이 아닙니다")
            if plugin.get("version") is not None and not isinstance(plugin.get("version"), str):
                raise SnapshotCorrupt(f"{agent} plugins[{index}] version 타입이 아닙니다")
        market_name = entry.get("marketplaceName")
        if not isinstance(market_name, str) or not market_name.strip():
            raise SnapshotCorrupt(f"{agent} 의 marketplaceName 이 없습니다")
    if not any(key in AGENTS for key in agents):
        raise SnapshotCorrupt("agents 에 claude/codex 가 없습니다")
    if "completed" in data and not isinstance(data.get("completed"), bool):
        raise SnapshotCorrupt("completed 타입이 아닙니다")
    return data


def capture_agent_entry(snap: dict[str, Any]) -> dict[str, Any] | None:
    if snap.get("errors"):
        return None
    hit = snap.get("marketplace")
    market = snap.get("marketplaceName") or ""
    plugins = []
    for item in snap.get("plugins") or []:
        if item.get("marketplace") == market:
            plugins.append({
                "name": item.get("name"),
                "version": item.get("version"),
                "marketplace": item.get("marketplace") or market,
                "path": item.get("path"),
            })
    return {
        "known": True,
        "marketplaceName": market or None,
        "registered": hit is not None,
        "path": hit.get("path") if isinstance(hit, dict) else None,
        "plugins": plugins,
    }


def capture_snapshot(root: Path, snapshots: dict[str, dict[str, Any]]) -> dict[str, Any]:
    agents: dict[str, Any] = {}
    for agent, snap in snapshots.items():
        entry = capture_agent_entry(snap)
        if entry is not None:
            agents[agent] = entry
    return {"worktree": str(root), "agents": agents}


def snapshot_is_active(data: dict[str, Any] | None) -> bool:
    return isinstance(data, dict) and data.get("completed") is not True


def _load_snapshot_file() -> dict[str, Any] | None:
    path = snapshot_path()
    if not path.is_file():
        return None
    try:
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise SnapshotCorrupt("JSON을 읽지 못했습니다") from exc
    return validate_snapshot_schema(data)


def load_snapshot() -> dict[str, Any] | None:
    data = _load_snapshot_file()
    if data is None:
        return None
    register_deletable(snapshot_path())
    if not snapshot_is_active(data):
        return None
    return data


def save_snapshot(data: dict[str, Any]) -> str | None:
    path = snapshot_path()
    tmp = path.with_name(path.name + ".tmp")
    for candidate in (path, tmp):
        reason = _write_chain_reason(candidate)
        if reason is not None:
            return reason
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        return f"mkdir failed: {exc}"
    try:
        os.lstat(path)
        path_exists = True
    except FileNotFoundError:
        path_exists = False
    except OSError as exc:
        return f"lstat failed: {path}: {exc}"
    if path_exists:
        reason = register_deletable(path)
        if reason is not None:
            return reason
    try:
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except OSError as exc:
        return f"write failed: {exc}"
    reason = register_deletable(tmp)
    if reason is not None:
        return reason
    try:
        os.replace(tmp, path)
    except OSError as exc:
        return f"replace failed: {exc}"
    register_deletable(path)
    return None


def mark_snapshot_completed() -> str | None:
    try:
        data = _load_snapshot_file()
    except SnapshotCorrupt as exc:
        return f"snapshot corrupt: {exc}"
    if data is None:
        return "snapshot file not found"
    if data.get("completed") is True:
        return None
    return save_snapshot({**data, "completed": True})


def delete_snapshot() -> str | None:
    path = snapshot_path()
    if path.is_file():
        return gated_delete(path)
    try:
        os.lstat(path)
    except FileNotFoundError:
        return None
    except OSError as exc:
        return f"lstat failed: {exc}"
    return "snapshot path exists but is not a regular file"


def _nt_lock_file_ex():
    import ctypes
    from ctypes import wintypes
    import msvcrt

    class OVERLAPPED(ctypes.Structure):
        _fields_ = [
            ("Internal", ctypes.c_void_p),
            ("InternalHigh", ctypes.c_void_p),
            ("Offset", wintypes.DWORD),
            ("OffsetHigh", wintypes.DWORD),
            ("hEvent", wintypes.HANDLE),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    lock = kernel32.LockFileEx
    lock.argtypes = [
        wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
        wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(OVERLAPPED),
    ]
    lock.restype = wintypes.BOOL
    unlock = kernel32.UnlockFileEx
    unlock.argtypes = [
        wintypes.HANDLE, wintypes.DWORD,
        wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(OVERLAPPED),
    ]
    unlock.restype = wintypes.BOOL
    return ctypes, msvcrt, lock, unlock, OVERLAPPED


def _nt_file_lock(fd: int, *, exclusive: bool) -> None:
    ctypes, msvcrt, lock, _unlock, overlapped_cls = _nt_lock_file_ex()
    flags = 0x00000001
    if exclusive:
        flags |= 0x00000002
    ov = overlapped_cls()
    if not lock(msvcrt.get_osfhandle(fd), flags, 0, 1, 0, ctypes.byref(ov)):
        err = ctypes.get_last_error()
        raise OSError(13, "LockFileEx failed", None, err)


def _nt_file_unlock(fd: int) -> None:
    ctypes, msvcrt, _lock, unlock, overlapped_cls = _nt_lock_file_ex()
    ov = overlapped_cls()
    unlock(msvcrt.get_osfhandle(fd), 0, 1, 0, ctypes.byref(ov))


class SnapshotLock:
    def __init__(self, *, shared: bool = False) -> None:
        self._fd: int | None = None
        self._shared = shared

    def acquire(self) -> None:
        try:
            lock_path = env_lock_path()
            lock_path.parent.mkdir(parents=True, exist_ok=True)
            register_deletable(lock_path.parent)
            self._fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR)
            register_deletable(lock_path)
            if os.fstat(self._fd).st_size == 0:
                os.write(self._fd, b"0")
                os.lseek(self._fd, 0, os.SEEK_SET)
            if os.name == "nt":
                _nt_file_lock(self._fd, exclusive=not self._shared)
            else:
                import fcntl
                flags = fcntl.LOCK_SH if self._shared else fcntl.LOCK_EX
                fcntl.flock(self._fd, flags | fcntl.LOCK_NB)
        except OSError as exc:
            if self._fd is not None:
                try:
                    os.close(self._fd)
                except OSError:
                    pass
                self._fd = None
            winerr = getattr(exc, "winerror", None)
            if winerr == 33 or getattr(exc, "errno", None) in {11, 13, 16, 35}:
                raise RuntimeError("스냅샷이 다른 실행에서 사용 중입니다.") from exc
            raise RuntimeError("스냅샷 잠금 파일을 준비하지 못했습니다.") from exc

    def release(self) -> None:
        if self._fd is None:
            return
        try:
            if os.name == "nt":
                _nt_file_unlock(self._fd)
            else:
                import fcntl
                fcntl.flock(self._fd, fcntl.LOCK_UN)
        except OSError:
            pass
        os.close(self._fd)
        self._fd = None


def _saved_plugins(saved_a: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        item for item in saved_a.get("plugins") or []
        if isinstance(item, dict) and isinstance(item.get("name"), str) and item["name"].strip()
    ]


def _plugins_for_market(items: list[dict[str, Any]] | None, market: str) -> list[dict[str, Any]]:
    return [
        item for item in items or []
        if item.get("name") and (item.get("marketplace") or "") == market
    ]


def _plugin_diff(saved_a: dict[str, Any], current: dict[str, Any]) -> tuple[set[str], set[str], bool]:
    market = saved_a.get("marketplaceName") or ""
    expected = _saved_plugins(saved_a)
    current_here = _plugins_for_market(current.get("plugins") or [], market)
    expected_names = {item["name"] for item in expected}
    current_names = {item["name"] for item in current_here}
    version_mismatch = False
    for item in expected:
        name = item["name"]
        item_market = item.get("marketplace") or market
        found = next(
            (
                cur for cur in current_here
                if cur.get("name") == name and (cur.get("marketplace") or "") == item_market
            ),
            None,
        )
        if found is not None and item.get("version") and found.get("version") != item.get("version"):
            version_mismatch = True
    return expected_names - current_names, current_names - expected_names, version_mismatch


def snapshot_drift(root: Path, snapshots: dict[str, dict[str, Any]], saved: dict[str, Any]) -> str | None:
    origin = saved.get("worktree")
    notes: list[str] = []
    for agent, saved_a in (saved.get("agents") or {}).items():
        if not isinstance(saved_a, dict) or saved_a.get("known") is not True:
            continue
        cur = snapshots.get(agent) or {}
        if cur.get("errors"):
            notes.append(f"{agent}: 현재 조회가 실패했습니다")
            continue
        hit = cur.get("marketplace")
        current_path = hit.get("path") if isinstance(hit, dict) else None
        saved_path = saved_a.get("path")
        at_saved = bool(saved_path) and bool(current_path) and paths_equal(current_path, saved_path)
        at_origin = bool(origin) and bool(current_path) and paths_equal(current_path, origin)
        missing, extra, version_mismatch = _plugin_diff(saved_a, cur)
        if at_saved:
            if missing:
                continue
            if extra or version_mismatch:
                notes.append(f"{agent}: 원본 경로이지만 스냅샷 밖 플러그인 변경이 있습니다")
            continue
        if at_origin:
            if missing:
                continue
            declared = {name for name in (cur.get("declaredPlugins") or []) if isinstance(name, str)}
            current_names = {
                item["name"] for item in _plugins_for_market(
                    cur.get("plugins") or [], saved_a.get("marketplaceName") or ""
                )
            }
            expected_names = {item["name"] for item in _saved_plugins(saved_a)}
            extra_loop = current_names - declared
            missing_loop = (declared - current_names) - expected_names
            if extra_loop or missing_loop:
                notes.append(f"{agent}: 워크트리 경로에서 스냅샷 밖 플러그인 변경이 있습니다")
            continue
        if current_path:
            notes.append(f"{agent}: 현재 경로가 스냅샷 원본도 출처 워크트리도 아닙니다")
    return "; ".join(notes) if notes else None


def restore_matches(saved_a: dict[str, Any], current: dict[str, Any]) -> bool:
    if saved_a.get("known") is not True:
        return True
    if current.get("errors"):
        return False
    hit = current.get("marketplace")
    current_path = hit.get("path") if isinstance(hit, dict) else None
    if saved_a.get("registered"):
        saved_path = saved_a.get("path")
        if not current_path or not saved_path or not paths_equal(current_path, saved_path):
            return False
        expected = [
            item for item in saved_a.get("plugins") or []
            if isinstance(item, dict) and isinstance(item.get("name"), str)
        ]
        current_here = [
            cur for cur in current.get("plugins") or []
            if cur.get("name") and (cur.get("marketplace") or "") in {
                item.get("marketplace") or saved_a.get("marketplaceName") or ""
                for item in expected
            } | {saved_a.get("marketplaceName") or ""}
        ]
        expected_names = {item["name"] for item in expected}
        extra = [cur.get("name") for cur in current_here if cur.get("name") not in expected_names]
        if extra:
            return False
        for item in expected:
            name = item["name"]
            market = item.get("marketplace") or saved_a.get("marketplaceName") or ""
            found = next(
                (
                    cur for cur in current.get("plugins") or []
                    if cur.get("name") == name and (cur.get("marketplace") or "") == market
                ),
                None,
            )
            if found is None:
                return False
            if item.get("version") and found.get("version") != item.get("version"):
                return False
            if current.get("agent") == "claude" and not found.get("path"):
                return False
            if current.get("agent") == "codex":
                found_path = found.get("path")
                if not found_path:
                    return False
                expected_path = item.get("path")
                if isinstance(expected_path, str) and expected_path.strip():
                    if not paths_equal(found_path, expected_path):
                        return False
                else:
                    saved_root = saved_a.get("path")
                    if not saved_root or not path_is_under(found_path, saved_root):
                        return False
        return True
    return current.get("marketplace") is None and not current.get("errors")


def _fatal_step(step: dict[str, Any] | None) -> bool:
    return bool(step) and bool(step.get("fatal") or step.get("action") in {"refuse", "error"})


def _parse_failure_detail(hit: dict[str, Any], current: str | None) -> str:
    raw = hit.get("raw")
    if raw is not None:
        try:
            return json.dumps(raw, ensure_ascii=False)[:500]
        except (TypeError, ValueError):
            return str(raw)[:500]
    return str(current)[:500] if current else "(경로 없음)"


def _step(kind: str, action: str, **kw: Any) -> dict[str, Any]:
    step = {
        "kind": kind, "action": action, "summary": kw.pop("summary", ""),
        "commands": kw.pop("commands", []),
        "needsApproval": kw.pop("needsApproval", False), "overwrite": kw.pop("overwrite", False),
    }
    step.update(kw)
    return step


def _target_plugins(snapshot: dict[str, Any], plugins: list[str] | None, kind: str) -> list[Any]:
    declared = list(snapshot.get("declaredPlugins") or [])
    if plugins:
        unknown = [name for name in plugins if name not in declared]
        if unknown:
            return [_step(kind, "error", fatal=True, summary=f"매니페스트에 없는 플러그인: {', '.join(unknown)}")]
        return list(plugins)
    if not declared:
        return [_step(kind, "error", fatal=True, summary="대상 플러그인이 없습니다.")]
    return declared


def plan_register(root: Path, snapshot: dict[str, Any]) -> dict[str, Any]:
    agent, name, next_path = snapshot["agent"], snapshot.get("marketplaceName"), str(root)
    if snapshot.get("errors"):
        summary = "CLI가 없어 등록 계획을 세우지 않습니다." if not snapshot.get("cliFound") else "조회·파싱 오류가 있어 등록 계획을 세우지 않습니다."
        return _step("register", "skip", summary=summary)
    if not name:
        return _step("register", "skip", summary="마켓플레이스 이름이 없어 등록할 수 없습니다.")
    hit = snapshot.get("marketplace")
    if hit is None:
        return _step(
            "register", "add",
            summary=f"{name} 이 없습니다. 이 워크트리를 add 합니다.",
            commands=[["plugin", "marketplace", "add", next_path]],
            needsApproval=True, currentPath=None, nextPath=next_path,
        )
    current = hit.get("path")
    restored = restore_path_text(current if isinstance(current, str) else None)
    if current and restored and paths_equal(current, root):
        if agent == "claude":
            return _step(
                "register", "update",
                summary=f"{name} 이 이미 이 워크트리를 가리킵니다. update 합니다.",
                commands=[["plugin", "marketplace", "update", name]], needsApproval=True,
                currentPath=current, nextPath=next_path,
            )
        return _step(
            "register", "skip",
            summary=f"{name} 이 이미 이 워크트리를 가리킵니다. 로컬 경로라 upgrade는 하지 않습니다.",
            currentPath=current, nextPath=next_path,
        )
    if restored is None:
        return _step(
            "register", "refuse", fatal=True,
            summary=f"{name} 이 등록돼 있지만 원래 소스를 파싱하지 못해 경로를 바꾸지 않습니다.",
            warning=f"파싱하지 못한 항목: {_parse_failure_detail(hit, current)}",
            manual=[
                "plugin marketplace list 로 현재 등록을 확인한 뒤 원래 소스를 수동으로 처리하세요.",
            ],
            currentPath=current, nextPath=next_path,
        )
    shown = current or restored
    return _step(
        "register", "retarget", overwrite=True,
        summary=f"{name} 이 다른 경로를 가리킵니다. 같은 이름이라 기존 등록이 이 워크트리로 바뀝니다.",
        commands=[["plugin", "marketplace", "remove", name], ["plugin", "marketplace", "add", next_path]],
        recoverCommand=["plugin", "marketplace", "add", restored], needsApproval=True,
        warning=f"현재 {shown} → 변경 {root}", currentPath=current, nextPath=next_path,
    )


def installed_here(snapshot: dict[str, Any], plugin: str) -> dict[str, Any] | None:
    market = snapshot.get("marketplaceName") or ""
    for item in snapshot.get("plugins") or []:
        if item.get("name") != plugin:
            continue
        if (item.get("marketplace") or "") != market:
            continue
        if snapshot.get("agent") == "claude" and not item.get("path"):
            continue
        return item
    return None


def plan_install(root: Path, snapshot: dict[str, Any], plugins: list[str] | None) -> list[dict[str, Any]]:
    targets = _target_plugins(snapshot, plugins, "install")
    if targets and isinstance(targets[0], dict):
        return targets
    agent, market = snapshot["agent"], snapshot.get("marketplaceName")
    versions = snapshot.get("declaredVersions") or {}
    blocked = not snapshot.get("pointsAtWorktree")
    steps: list[dict[str, Any]] = []
    for plugin in targets:
        if not isinstance(plugin, str):
            continue
        if not market:
            steps.append(_step("install", "skip", plugin=plugin, summary=f"{plugin}: 마켓플레이스 이름이 없습니다."))
            continue
        if blocked:
            steps.append(_step(
                "install", "skip", plugin=plugin, blockedBy="register",
                summary=(
                    f"{plugin}: 마켓플레이스가 이 워크트리를 가리키지 않습니다. "
                    "register 승인 시 설치 예정. register를 먼저 승인해야 설치가 이 워크트리 소스를 씁니다."
                ),
            ))
            continue
        selector = f"{plugin}@{market}"
        existing = installed_here(snapshot, plugin)
        if agent != "claude":
            summary = (
                f"{selector} 가 설치돼 있습니다. plugin add 로 갱신합니다."
                if existing else f"{selector} 를 plugin add 합니다."
            )
            steps.append(_step(
                "install", "add", plugin=plugin, needsApproval=True,
                summary=summary, commands=[["plugin", "add", selector]],
            ))
            continue
        declared_ver = versions.get(plugin)
        installed_ver = existing.get("version") if existing else None
        if existing and declared_ver and installed_ver == declared_ver:
            install_cmd = ["plugin", "install", selector, "-y"]
            steps.append(_step(
                "install", "reinstall", plugin=plugin, needsApproval=True,
                summary=(
                    f"{selector} 는 선언 버전 {declared_ver} 과 같습니다. "
                    "uninstall 후 install 로 캐시를 강제 갱신합니다."
                ),
                commands=[
                    plugin_remove_cmd(agent, plugin, market),
                    install_cmd,
                ],
                recoverCommand=install_cmd,
            ))
            continue
        if existing:
            steps.append(_step(
                "install", "update", plugin=plugin, needsApproval=True,
                summary=(
                    f"{selector} 가 설치돼 있습니다. "
                    f"설치 {installed_ver or '(버전 없음)'} → 선언 {declared_ver or '(버전 없음)'}. plugin update 합니다."
                ),
                commands=[["plugin", "update", plugin, "-y"]],
            ))
        else:
            steps.append(_step(
                "install", "install", plugin=plugin, needsApproval=True,
                summary=f"{selector} 를 plugin install 합니다.",
                commands=[["plugin", "install", selector, "-y"]],
            ))
    return steps


def plan_validate(root: Path, snapshot: dict[str, Any], plugins: list[str] | None) -> list[dict[str, Any]]:
    targets = _target_plugins(snapshot, plugins, "validate")
    if targets and isinstance(targets[0], dict):
        return targets
    names = [item for item in targets if isinstance(item, str)]
    if snapshot["agent"] != "claude":
        return [_step(
            "validate", "list",
            summary="codex plugin list 에서 선언 플러그인이 이 워크트리 설치본인지 확인",
            commands=[["plugin", "list", "--json"]],
            expectPlugins=names,
        )]
    steps = [_step(
        "validate", "validate-marketplace", summary="claude plugin validate <저장소 루트>",
        commands=[["plugin", "validate", str(root), "--json"]],
    )]
    for plugin in names:
        steps.append(_step(
            "validate", "validate-plugin", plugin=plugin,
            summary=f"claude plugin validate plugins/{plugin}",
            commands=[["plugin", "validate", str(root / "plugins" / plugin), "--json"]],
        ))
    steps.append(_step(
        "validate", "list", summary="claude plugin list 에서 선언 플러그인 버전을 확인",
        commands=[["plugin", "list", "--json"]], expectPlugins=names,
    ))
    return steps


def plan_restore_agent(
    root: Path, agent: str, current: dict[str, Any], saved_a: dict[str, Any] | None
) -> list[dict[str, Any]]:
    if current.get("errors"):
        detail = "; ".join(str(item) for item in current["errors"] if item)
        return [_step(
            "restore", "refuse", fatal=True,
            summary=f"현재 상태를 확인하지 못해 되돌리지 않습니다: {detail}",
        )]
    if not saved_a or saved_a.get("known") is not True:
        return [_step("restore", "skip", summary="스냅샷에 확실한 기록이 없어 이 에이전트는 건드리지 않습니다.")]
    name = saved_a.get("marketplaceName")
    if not isinstance(name, str) or not name.strip():
        return [_step("restore", "skip", summary="마켓플레이스 이름이 없어 되돌리지 않습니다.")]
    unsafe = shell_unsafe_name_reason(name)
    if unsafe is not None:
        return [_step(
            "restore", "refuse", fatal=True,
            summary=f"{name} 에 {unsafe} 가 있어 되돌리지 않습니다.",
        )]
    saved_plugins = {
        item["name"]: item
        for item in saved_a.get("plugins") or []
        if isinstance(item, dict) and isinstance(item.get("name"), str)
    }
    current_plugins = [
        item for item in current.get("plugins") or []
        if item.get("name") and (item.get("marketplace") or "") == name
    ]
    current_by_name = {item["name"]: item for item in current_plugins}
    hit = current.get("marketplace")
    current_path = hit.get("path") if isinstance(hit, dict) else None
    saved_registered = saved_a.get("registered") is True
    market_steps: list[dict[str, Any]] = []
    market_will_change = False
    if saved_registered:
        restored = restore_path_text(saved_a.get("path") if isinstance(saved_a.get("path"), str) else None)
        if restored is None:
            return [_step(
                "restore", "refuse", fatal=True,
                summary=f"{name} 스냅샷 경로를 파싱하지 못해 되돌리지 않습니다.",
            )]
        if current_path and paths_equal(current_path, restored):
            market_steps.append(_step("restore", "skip", summary=f"{name} 이 이미 스냅샷 경로입니다."))
        elif hit is None:
            market_will_change = True
            market_steps.append(_step(
                "restore", "add", needsApproval=True,
                summary=f"{name} 을 스냅샷 경로로 add 합니다.",
                commands=[["plugin", "marketplace", "add", restored]],
            ))
        else:
            current_restored = restore_path_text(current_path if isinstance(current_path, str) else None)
            if current_restored is None:
                return [_step(
                    "restore", "refuse", fatal=True,
                    summary=f"{name} 현재 등록 경로를 파싱하지 못해 되돌리지 않습니다.",
                )]
            market_will_change = True
            market_steps.append(_step(
                "restore", "retarget", needsApproval=True, overwrite=True,
                summary=f"{name} 을 스냅샷 경로로 되돌립니다.",
                commands=[
                    ["plugin", "marketplace", "remove", name],
                    ["plugin", "marketplace", "add", restored],
                ],
                recoverCommand=["plugin", "marketplace", "add", current_restored],
                currentPath=current_path,
            ))
    elif hit is not None:
        market_will_change = True
        market_steps.append(_step(
            "restore", "remove", needsApproval=True,
            summary=f"{name} 이 스냅샷에 원래 없어 remove 합니다.",
            commands=[["plugin", "marketplace", "remove", name]],
        ))
    steps: list[dict[str, Any]] = []
    for item in current_plugins:
        pname = item["name"]
        saved_meta = saved_plugins.get(pname)
        version_mismatch = bool(saved_meta) and saved_meta.get("version") and item.get("version") != saved_meta.get("version")
        extra = pname not in saved_plugins
        if extra or market_will_change or version_mismatch:
            verb = "remove" if agent != "claude" else "uninstall"
            item_market = item.get("marketplace") or name
            allowed, skip_reason = should_plan_plugin_remove(
                agent, pname, item.get("path") if isinstance(item.get("path"), str) else None,
                set(saved_plugins),
            )
            if not allowed:
                steps.append(_step(
                    "restore", "skip", plugin=pname,
                    summary=f"{pname} 제거를 계획하지 않습니다. {skip_reason}",
                ))
                continue
            steps.append(_step(
                "restore", "remove-plugin", plugin=pname, needsApproval=True,
                summary=f"{pname}@{item_market} 을 마켓플레이스 변경 전에 {verb} 합니다.",
                commands=[plugin_remove_cmd(agent, pname, item_market)],
            ))
    steps.extend(market_steps)
    if saved_registered:
        for pname, meta in saved_plugins.items():
            saved_market = meta.get("marketplace") or name
            cur = current_by_name.get(pname)
            same_market = cur is not None and (cur.get("marketplace") or "") == saved_market
            same_ver = cur is not None and (not meta.get("version") or cur.get("version") == meta.get("version"))
            if not market_will_change and same_market and same_ver:
                continue
            add_cmd = plugin_add_cmd(agent, pname, saved_market)
            steps.append(_step(
                "restore", "add-plugin", plugin=pname, needsApproval=True,
                summary=f"{pname}@{saved_market} 을 스냅샷 소속·버전으로 다시 넣습니다.",
                commands=[add_cmd],
                recoverCommand=add_cmd,
            ))
    if not steps:
        steps.append(_step("restore", "skip", summary="되돌릴 마켓플레이스·플러그인 변경이 없습니다."))
    return steps


def _apply_result(
    step: dict[str, Any], runs: list[dict[str, Any]], ok: bool,
    *, skipped: bool = False, recovered: bool = False, notes: list[str] | None = None,
) -> dict[str, Any]:
    return {"step": step, "runs": runs, "ok": ok, "skipped": skipped, "recovered": recovered, "notes": notes or []}


def _apply_retarget(agent: str, step: dict[str, Any]) -> dict[str, Any]:
    remove_cmd, add_cmd = step["commands"][0], step["commands"][1]
    runs: list[dict[str, Any]] = []
    remove_run = run_cli(agent, remove_cmd, timeout=TIMEOUT_MUTATE)
    runs.append(remove_run)
    if not remove_run["ok"]:
        return _apply_result(step, runs, False, notes=[remove_run.get("error") or "remove 실패"])
    add_run = run_cli(agent, add_cmd, timeout=TIMEOUT_MUTATE)
    runs.append(add_run)
    if add_run["ok"]:
        return _apply_result(step, runs, True)
    notes = [add_run.get("error") or "add 실패"]
    recover_run = run_cli(agent, step["recoverCommand"], timeout=TIMEOUT_MUTATE)
    runs.append(recover_run)
    if recover_run["ok"]:
        notes.append("add 실패 후 원래 경로로 복구했습니다.")
        return _apply_result(step, runs, False, recovered=True, notes=notes)
    notes.append(recover_run.get("error") or "자동 복구 실패")
    notes.append("원래 경로 재등록에 실패했습니다. restore 로 스냅샷을 적용하세요.")
    return _apply_result(step, runs, False, notes=notes)


def _apply_reinstall(agent: str, step: dict[str, Any]) -> dict[str, Any]:
    uninstall_cmd, install_cmd = step["commands"][0], step["commands"][1]
    runs: list[dict[str, Any]] = []
    uninstall_run = run_cli(agent, uninstall_cmd, timeout=TIMEOUT_MUTATE)
    runs.append(uninstall_run)
    if not uninstall_run["ok"]:
        return _apply_result(step, runs, False, notes=[uninstall_run.get("error") or "uninstall 실패"])
    install_run = run_cli(agent, install_cmd, timeout=TIMEOUT_MUTATE)
    runs.append(install_run)
    if install_run["ok"]:
        return _apply_result(step, runs, True)
    notes = [install_run.get("error") or "install 실패"]
    recover_run = run_cli(agent, step["recoverCommand"], timeout=TIMEOUT_MUTATE)
    runs.append(recover_run)
    if recover_run["ok"]:
        notes.append("install 실패 후 복구 install 을 실행했습니다.")
        return _apply_result(step, runs, True, recovered=True, notes=notes)
    notes.append(recover_run.get("error") or "복구 install 실패")
    notes.append("플러그인이 제거된 상태입니다. restore 로 스냅샷을 적용하세요.")
    return _apply_result(step, runs, False, notes=notes)


def _apply_add_plugin(agent: str, step: dict[str, Any]) -> dict[str, Any]:
    add_cmd = step["commands"][0]
    recover = step.get("recoverCommand") or add_cmd
    runs: list[dict[str, Any]] = []
    add_run = run_cli(agent, add_cmd, timeout=TIMEOUT_MUTATE)
    runs.append(add_run)
    if add_run["ok"]:
        return _apply_result(step, runs, True)
    notes = [add_run.get("error") or "add 실패"]
    recover_run = run_cli(agent, recover, timeout=TIMEOUT_MUTATE)
    runs.append(recover_run)
    if recover_run["ok"]:
        notes.append("add 실패 후 복구 add 를 실행했습니다.")
        return _apply_result(step, runs, True, recovered=True, notes=notes)
    notes.append(recover_run.get("error") or "복구 add 실패")
    notes.append("플러그인이 없는 상태입니다. 스냅샷이 남아 있으면 restore --yes 로 미완료 복원을 이어 가세요.")
    return _apply_result(step, runs, False, notes=notes)


def apply_steps(agent: str, steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for step in steps:
        if _fatal_step(step):
            results.append(_apply_result(step, [], False, skipped=True))
            break
        if step.get("action") in {"skip", None} or not step.get("commands"):
            results.append(_apply_result(step, [], True, skipped=True))
            continue
        if step.get("action") == "retarget":
            result = _apply_retarget(agent, step)
            results.append(result)
            if not result.get("ok"):
                break
            continue
        if step.get("action") == "reinstall":
            result = _apply_reinstall(agent, step)
            results.append(result)
            if not result.get("ok"):
                break
            continue
        if step.get("action") == "add-plugin":
            result = _apply_add_plugin(agent, step)
            results.append(result)
            if not result.get("ok"):
                break
            continue
        runs, ok = [], True
        for command in step["commands"]:
            run = run_cli(agent, command, timeout=TIMEOUT_MUTATE)
            runs.append(run)
            if not run["ok"]:
                ok = False
                break
        results.append(_apply_result(step, runs, ok))
        if not ok:
            break
    return results


def _confirm_worktree(root: Path, agent: str, document: dict[str, Any]) -> dict[str, Any] | None:
    snap = collect_agent(root, agent)
    document["snapshots"][agent] = snap
    if snap.get("errors") or not snap.get("pointsAtWorktree"):
        document["errors"].append(f"{agent}: 등록 후 이 워크트리를 가리키지 않습니다.")
        document["blocked"].setdefault(agent, []).append("등록 후 이 워크트리를 가리키지 않습니다.")
        return None
    return snap


def apply_agent(args: argparse.Namespace, document: dict[str, Any], agent: str) -> None:
    root = Path(document["repoRoot"])
    plan = document["plans"][agent]
    document["applied"].setdefault(agent, [])
    if args.command in {"register", "loop"}:
        reg = plan.get("register")
        if reg:
            results = apply_steps(agent, [reg])
            document["applied"][agent].extend(results)
            if any(not item.get("ok") for item in results):
                return
        snap = _confirm_worktree(root, agent, document)
        if snap is None or args.command == "register":
            return
        plan["install"] = plan_install(root, snap, args.plugin)
        install_results = apply_steps(agent, plan["install"])
        document["applied"][agent].extend(install_results)
        if any(not item.get("ok") for item in install_results):
            return
        snap = collect_agent(root, agent)
        document["snapshots"][agent] = snap
        plan["validate"] = plan_validate(root, snap, args.plugin)
    if args.command == "loop":
        document["validated"][agent] = run_validate_steps(
            root, agent, plan["validate"], document["snapshots"][agent]
        )


def _plugin_scope_files(plugin_root: Path, agent: str) -> tuple[dict[str, Path], list[str]]:
    files: dict[str, Path] = {}
    errors: list[str] = []
    manifest = plugin_root / (".claude-plugin" if agent == "claude" else ".codex-plugin") / "plugin.json"

    def add_file(path: Path) -> None:
        try:
            is_file = path.is_file()
        except OSError as exc:
            errors.append(f"{path}: {exc}")
            return
        if not is_file:
            return
        try:
            rel = path.relative_to(plugin_root).as_posix()
        except ValueError as exc:
            errors.append(f"{path}: {exc}")
            return
        files[rel] = path

    def on_walk_error(exc: OSError) -> None:
        location = getattr(exc, "filename", None) or "?"
        errors.append(f"{location}: {exc}")

    for base in (plugin_root / "skills", plugin_root / "scripts"):
        try:
            is_dir = base.is_dir()
        except OSError as exc:
            errors.append(f"{base}: {exc}")
            continue
        if not is_dir:
            continue
        for dirpath, _dirnames, filenames in os.walk(base, followlinks=False, onerror=on_walk_error):
            for filename in filenames:
                add_file(Path(dirpath) / filename)
    add_file(manifest)
    return files, errors


def compare_plugin_install(
    root: Path, agent: str, plugin: str, install_root: str | Path,
) -> tuple[bool, list[str]]:
    source_root = root / "plugins" / plugin
    dest_root = Path(str(install_root))
    if not dest_root.is_dir():
        return False, [f"{plugin}: 설치본 경로가 없습니다."]
    source_files, source_errors = _plugin_scope_files(source_root, agent)
    dest_files, dest_errors = _plugin_scope_files(dest_root, agent)
    notes: list[str] = []
    for item in source_errors:
        notes.append(f"{plugin}: 소스를 탐색하지 못했습니다: {item}")
    for item in dest_errors:
        notes.append(f"{plugin}: 설치본을 탐색하지 못했습니다: {item}")
    if source_errors or dest_errors:
        return False, notes
    dest_only = sorted(set(dest_files) - set(source_files))
    source_only = sorted(set(source_files) - set(dest_files))
    if dest_only:
        notes.append(f"{plugin}: 캐시에만 있는 파일: {', '.join(dest_only)}")
    if source_only:
        notes.append(f"{plugin}: 설치본에 없는 파일: {', '.join(source_only)}")
    mismatched: list[str] = []
    for rel in sorted(set(source_files) & set(dest_files)):
        try:
            if source_files[rel].read_bytes() != dest_files[rel].read_bytes():
                mismatched.append(rel)
        except OSError as exc:
            notes.append(f"{plugin}: {rel} 을 읽지 못했습니다: {exc}")
    if mismatched:
        notes.append(f"{plugin}: 바이트가 다른 파일: {', '.join(mismatched)}")
    if notes:
        return False, notes
    return True, [f"{plugin}: 설치본이 소스와 바이트 일치합니다."]


def assess_listed_plugins(
    root: Path, agent: str, expect: list[str], found: list[dict[str, Any]],
    declared_versions: dict[str, str | None] | None = None,
    marketplace: str = "",
) -> tuple[bool, list[str]]:
    if not expect:
        return False, ["검증 대상 플러그인이 없습니다."]
    notes: list[str] = []
    ok = True
    versions = declared_versions or {}
    missing: list[str] = []
    for name in expect:
        matches = [item for item in found if item.get("name") == name]
        if agent == "claude":
            ours = [
                item for item in matches
                if (item.get("marketplace") or "") == marketplace and item.get("path")
            ]
            if not ours:
                same = matches
                if not same:
                    missing.append(name)
                elif not any((item.get("marketplace") or "") == marketplace for item in same):
                    ok = False
                    notes.append(f"{name}: 이 마켓플레이스 소속이 아닙니다.")
                else:
                    ok = False
                    notes.append(f"{name}: installPath 가 없습니다.")
                continue
            declared_ver = versions.get(name)
            installed_vers = [item.get("version") for item in ours]
            if not declared_ver:
                ok = False
                notes.append(f"{name}: 선언 버전을 읽지 못했습니다.")
                continue
            if declared_ver not in installed_vers:
                ok = False
                notes.append(f"{name}: 설치 버전 {', '.join(str(v) for v in installed_vers)} ≠ 선언 {declared_ver}")
                continue
            chosen_list = [item for item in ours if item.get("version") == declared_ver]
            any_mismatch = False
            success_notes: list[str] = []
            for chosen in chosen_list:
                match_ok, match_notes = compare_plugin_install(root, agent, name, chosen["path"])
                if not match_ok:
                    any_mismatch = True
                    ok = False
                    notes.extend(match_notes)
                else:
                    success_notes.extend(match_notes)
            if not any_mismatch:
                notes.extend(success_notes)
            continue
        ours = [item for item in matches if (item.get("marketplace") or "") == marketplace]
        if not ours:
            if not matches:
                missing.append(name)
            else:
                ok = False
                notes.append(f"{name}: 이 마켓플레이스 소속이 아닙니다.")
            continue
        here = [item for item in ours if item.get("path") and path_is_under(item["path"], root)]
        if not here:
            ok = False
            notes.append(f"{name}: 설치본이 이 워크트리 경로에서 오지 않았습니다.")
            continue
        ok = False
        notes.append(f"{name}: codex 설치본은 대조 불가")
    if missing:
        ok = False
        notes.append(f"list에 없음: {', '.join(missing)}")
    elif ok:
        notes.append("선언한 플러그인이 캐시에 있고 버전이 일치합니다.")
    return ok, notes


def run_validate_steps(
    root: Path, agent: str, steps: list[dict[str, Any]], snapshot: dict[str, Any]
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for step in steps:
        if _fatal_step(step):
            results.append({"step": step, "runs": [], "ok": False, "notes": [step.get("summary") or "검증 오류"]})
            continue
        runs, ok, notes = [], True, []
        for command in step.get("commands") or []:
            run = run_cli(agent, command, timeout=TIMEOUT_READ)
            runs.append(run)
            if not run["ok"]:
                ok = False
                notes.append(run.get("error") or "실패")
                continue
            if step.get("action") == "list":
                try:
                    found = parse_plugins(agent, parse_json_output(run["stdout"]))
                except ValueError as exc:
                    ok = False
                    notes.append(str(exc))
                    continue
                list_ok, list_notes = assess_listed_plugins(
                    root, agent, list(step.get("expectPlugins") or []), found,
                    snapshot.get("declaredVersions") or {},
                    snapshot.get("marketplaceName") or "",
                )
                ok = ok and list_ok
                notes.extend(list_notes)
            elif str(step.get("action") or "").startswith("validate"):
                try:
                    payload = parse_json_output(run["stdout"])
                except ValueError as exc:
                    ok = False
                    notes.append(f"validate JSON 파싱 실패: {exc}")
                    continue
                notes.append("validate JSON 수신")
                if not isinstance(payload, dict) or payload.get("ok") is False:
                    ok = False
        results.append({"step": step, "runs": runs, "ok": ok, "notes": notes})
    return results


def _set_apply_ok(document: dict[str, Any]) -> None:
    apply_ok = True
    for bucket in ("applied", "validated"):
        for runs in document.get(bucket, {}).values():
            for item in runs:
                if not item.get("ok"):
                    apply_ok = False
    document["applyOk"] = apply_ok


def run_phases(args: argparse.Namespace, document: dict[str, Any]) -> None:
    root = Path(document["repoRoot"])
    worked = False
    if args.yes and args.command in {"register", "loop"} and not document.get("snapshotCorrupt"):
        existing = document["savedSnapshot"] if "savedSnapshot" in document else load_snapshot()
        if not snapshot_is_active(existing):
            full = {agent: collect_agent(root, agent) for agent in AGENTS}
            lost = [
                agent for agent in document["agents"]
                if not (document["snapshots"].get(agent) or {}).get("errors")
                and (full.get(agent) or {}).get("errors")
            ]
            if lost:
                msg = f"저장 직전 재조회가 실패해 적용하지 않습니다 ({', '.join(lost)})"
                document["errors"].append(msg)
                document["reinspectFailed"] = True
                for agent in document["agents"]:
                    document["blocked"].setdefault(agent, []).append(msg)
                _set_apply_ok(document)
                return
            captured = capture_snapshot(root, full)
            if any(key in AGENTS for key in captured.get("agents") or {}):
                save_reason = save_snapshot(captured)
                if save_reason is not None:
                    msg = f"스냅샷 저장을 거부했습니다: {save_reason}"
                    document["errors"].append(msg)
                    for agent in document["agents"]:
                        document["blocked"].setdefault(agent, []).append(msg)
                    _set_apply_ok(document)
                    return
                document["snapshotWrote"] = True
                document["savedSnapshot"] = captured
                for agent in document["agents"]:
                    snap = full.get(agent)
                    if snap is None:
                        continue
                    document["snapshots"][agent] = snap
                    plan = document["plans"].setdefault(
                        agent, {"register": None, "install": [], "validate": [], "restore": []}
                    )
                    if args.command in {"register", "loop"}:
                        plan["register"] = plan_register(root, snap)
                    if args.command == "loop":
                        plan["install"] = plan_install(root, snap, args.plugin)
                    if args.command in {"check", "loop"}:
                        plan["validate"] = plan_validate(root, snap, args.plugin)
        else:
            document["snapshotKept"] = True
            document["savedSnapshot"] = existing
            if existing.get("worktree") and not paths_equal(existing.get("worktree"), root):
                document["snapshotForeign"] = True
            else:
                agents_map = dict(existing.get("agents") or {})
                filled = False
                for agent in document["agents"]:
                    entry = agents_map.get(agent)
                    if isinstance(entry, dict) and entry.get("known") is True:
                        continue
                    snap = document["snapshots"].get(agent)
                    captured_a = capture_agent_entry(snap) if isinstance(snap, dict) else None
                    if captured_a is None:
                        continue
                    agents_map[agent] = captured_a
                    filled = True
                if filled:
                    pending = {**existing, "agents": agents_map}
                    save_reason = save_snapshot(pending)
                    if save_reason is None:
                        existing = pending
                        document["savedSnapshot"] = existing
                    else:
                        print(f"snapshot save refused: {save_reason}", file=sys.stderr)
    for agent in document["agents"]:
        if document.get("blocked", {}).get(agent):
            continue
        plan = document["plans"][agent]
        if args.command == "check":
            document["validated"][agent] = run_validate_steps(
                root, agent, plan.get("validate") or [], document["snapshots"][agent]
            )
            worked = True
        elif args.command == "loop" and not args.yes:
            document["validated"][agent] = run_validate_steps(
                root, agent, plan.get("validate") or [], document["snapshots"][agent]
            )
        elif args.yes and args.command in {"register", "loop"}:
            saved_a = ((document.get("savedSnapshot") or {}).get("agents") or {}).get(agent)
            if not isinstance(saved_a, dict) or saved_a.get("known") is not True:
                continue
            apply_agent(args, document, agent)
            worked = True
        elif args.command == "restore" and args.yes:
            document["applied"].setdefault(agent, [])
            document["applied"][agent].extend(apply_steps(agent, plan.get("restore") or []))
            worked = True
    if worked:
        document["appliedAny"] = True
        if args.yes:
            document["needsApproval"] = False
    _set_apply_ok(document)
    if args.command == "restore" and any(
        (document.get("snapshots") or {}).get(agent, {}).get("errors")
        for agent in document["agents"]
    ):
        document["applyOk"] = False
    if args.command == "restore" and args.yes and document.get("appliedAny"):
        saved = document.get("savedSnapshot") or {}
        needed = [agent for agent in (saved.get("agents") or {}) if isinstance((saved.get("agents") or {}).get(agent), dict)]
        if not needed:
            needed = list(document["agents"])
        restore_ok = bool(document.get("applyOk")) and not document.get("errors")
        for agent in needed:
            if agent not in document["agents"]:
                restore_ok = False
                continue
            if document.get("blocked", {}).get(agent):
                restore_ok = False
            for item in document.get("applied", {}).get(agent) or []:
                if not item.get("ok"):
                    restore_ok = False
        if restore_ok:
            saved_agents = saved.get("agents") or {}
            global _RESTORE_MARKETPLACE_LOOKUP
            previous_lookup = _RESTORE_MARKETPLACE_LOOKUP
            _RESTORE_MARKETPLACE_LOOKUP = _restore_lookup_from_saved({"agents": saved_agents})
            try:
                for agent in needed:
                    saved_a = saved_agents.get(agent) or {}
                    if saved_a.get("known") is not True:
                        continue
                    current = collect_agent(root, agent)
                    document["snapshots"][agent] = current
                    if not restore_matches(saved_a, current):
                        restore_ok = False
                        document["errors"].append(f"{agent}: 되돌린 뒤 상태가 스냅샷과 다릅니다.")
                        document["applyOk"] = False
            finally:
                _RESTORE_MARKETPLACE_LOOKUP = previous_lookup
        if restore_ok:
            complete_reason = mark_snapshot_completed()
            if complete_reason is None:
                document["snapshotCompleted"] = True
                saved_doc = document.get("savedSnapshot")
                if isinstance(saved_doc, dict):
                    document["savedSnapshot"] = {**saved_doc, "completed": True}
            else:
                document["snapshotCompleted"] = False
                document["reason"] = complete_reason
                document["applyOk"] = False
                document["errors"].append(f"스냅샷 완료 표시에 실패했습니다: {complete_reason}")
                print(
                    f"snapshot complete mark refused: {snapshot_path()}: {complete_reason}",
                    file=sys.stderr,
                )


def selected_agents(value: str) -> tuple[str, ...]:
    return AGENTS if value == "both" else (value,)


def format_human(document: dict[str, Any]) -> str:
    lines = [f"저장소: {document['repoRoot']}", f"명령: {document['command']}"]
    if document.get("isolatedEnv"):
        lines.append(f"격리 환경: {document['isolatedEnv']}")
    command = document["command"]
    saved = document.get("savedSnapshot")
    if saved:
        lines.append(f"스냅샷 출처 워크트리: {saved.get('worktree') or '?'}")
        if document.get("snapshotForeign"):
            lines.append("  다른 워크트리의 스냅샷입니다. 덮어쓰지 않습니다. restore 는 이 스냅샷의 원본으로 돌아갑니다.")
        if document.get("snapshotDrift"):
            lines.append(f"  경고: {document['snapshotDrift']}")
        if document.get("snapshotKept"):
            lines.append("  기존 스냅샷을 유지합니다.")
        if document.get("snapshotWrote"):
            lines.append("  스냅샷을 저장했습니다.")
        if document.get("snapshotCompleted"):
            lines.append("  restore 성공으로 스냅샷을 완료 표시했습니다.")
        elif document.get("snapshotCompleted") is False:
            lines.append(f"  스냅샷 완료 표시에 실패했습니다: {document.get('reason') or '?'}")
        for agent, saved_a in (saved.get("agents") or {}).items():
            if not isinstance(saved_a, dict):
                continue
            if saved_a.get("known") is False:
                lines.append(f"  스냅샷 {agent}: 알 수 없음 — 건드리지 않습니다")
                continue
            path = saved_a.get("path") or "(미등록)"
            plugins = ", ".join(
                f"{item.get('name')}={item.get('version') or '?'}"
                for item in saved_a.get("plugins") or []
                if isinstance(item, dict)
            ) or "(없음)"
            lines.append(f"  스냅샷 {agent}: {path} / 플러그인 {plugins}")
    elif document.get("snapshotCorrupt"):
        lines.append("스냅샷이 손상됐습니다. 없음으로 취급하지 않습니다.")
    elif command == "restore":
        lines.append("스냅샷이 없습니다.")
    for agent in document["agents"]:
        snap = document["snapshots"][agent]
        lines += ["", f"== {agent} =="]
        for err in snap.get("errors") or []:
            lines.append(f"  오류: {err}")
        for err in document.get("blocked", {}).get(agent) or []:
            if err not in (snap.get("errors") or []):
                lines.append(f"  오류: {err}")
        name = snap.get("marketplaceName") or "-"
        hit = snap.get("marketplace")
        if hit is None:
            lines.append(f"  마켓플레이스 {name}: 미등록")
        else:
            flag = "이 워크트리" if snap.get("pointsAtWorktree") else "다른 경로"
            lines.append(f"  마켓플레이스 {name}: {hit.get('path') or '(경로 없음)'}  [{flag}]")
        declared = ", ".join(snap.get("declaredPlugins") or []) or "(없음)"
        lines.append(f"  선언 플러그인: {declared}")
        versions = snap.get("declaredVersions") or {}
        if versions:
            lines.append("  선언 버전: " + ", ".join(f"{k}={v or '?'}" for k, v in versions.items()))
        relevant = [
            item for item in snap.get("plugins") or []
            if item.get("marketplace") == snap.get("marketplaceName")
            or item.get("name") in (snap.get("declaredPlugins") or [])
        ]
        if relevant:
            for item in relevant:
                extra = " ".join(part for part in (item.get("version"), item.get("path")) if part)
                lines.append(f"  설치: {item.get('selector')} {extra}".rstrip())
        else:
            lines.append("  설치: 이 마켓플레이스 플러그인 없음")
        plan = document["plans"].get(agent) or {}
        steps = ([plan["register"]] if plan.get("register") else []) + list(plan.get("install") or []) + list(plan.get("validate") or []) + list(plan.get("restore") or [])
        for step in steps:
            kind = step.get("kind")
            if command == "check" and kind != "validate":
                continue
            if command == "register" and kind != "register":
                continue
            if command == "restore" and kind != "restore":
                continue
            if step.get("blockedBy") == "register":
                mark = "승인 시 설치 예정"
            elif step.get("overwrite"):
                mark = "덮어씀"
            else:
                mark = step.get("action")
            lines.append(f"  계획[{kind}/{mark}]: {step.get('summary')}")
            if step.get("warning"):
                lines.append(f"    경고: {step['warning']}")
            for line in step.get("manual") or []:
                lines.append(f"    수동: {line}")
        for item in document.get("applied", {}).get(agent) or []:
            status = "복구" if item.get("recovered") else ("생략" if item.get("skipped") else ("성공" if item.get("ok") else "실패"))
            lines.append(f"  적용 {status}: {item['step'].get('summary')}")
            for note in item.get("notes") or []:
                lines.append(f"    {note}")
            if not item.get("ok"):
                for run in item.get("runs") or []:
                    if run.get("error"):
                        lines.append(f"    {run['error']}")
        if command == "restore" and document.get("appliedAny") and document.get("applyOk") is False:
            lines.append("  되돌리기가 끝나지 않았습니다. 스냅샷이 남아 있으면 restore --yes 로 미완료 복원을 이어 가세요.")
        for item in document.get("validated", {}).get(agent) or []:
            lines.append(f"  검증 {'통과' if item.get('ok') else '실패'}: {item['step'].get('summary')}")
            for note in item.get("notes") or []:
                lines.append(f"    {note}")
    if document.get("needsApproval") and not document.get("yes"):
        lines += [
            "",
            "적용하지 않았습니다. 위 현재 경로와 변경을 확인한 뒤 같은 명령에 --yes 를 붙여 실행하세요.",
            "특히 이름이 같은 마켓플레이스를 다른 경로로 바꾸면 기존 등록이 사라집니다.",
            "테스트가 끝나면 restore --yes 로 스냅샷의 원본 등록을 되돌리세요.",
        ]
    return "\n".join(lines) + "\n"


def execute(args: argparse.Namespace) -> dict[str, Any]:
    root = git_root()
    agents = selected_agents(args.agent)
    if args.command == "check":
        lock = SnapshotLock(shared=True)
    elif args.command in {"register", "loop", "restore"}:
        lock = SnapshotLock()
    else:
        lock = None
    if lock is not None:
        lock.acquire()
    try:
        snapshots = {agent: collect_agent(root, agent) for agent in agents}
        document: dict[str, Any] = {
            "repoRoot": str(root), "command": args.command, "agents": list(agents),
            "snapshots": snapshots, "plans": {}, "needsApproval": False, "overwrite": False,
            "appliedAny": False, "applied": {}, "validated": {}, "errors": [],
            "yes": bool(args.yes), "blocked": {},
        }
        if _ACTIVE_ENV is not None:
            document["isolatedEnv"] = str(_ACTIVE_ENV.root)
        return _execute_locked(args, root, agents, snapshots, document)
    finally:
        if lock is not None:
            lock.release()


def _execute_locked(
    args: argparse.Namespace,
    root: Path,
    agents: tuple[str, ...],
    snapshots: dict[str, dict[str, Any]],
    document: dict[str, Any],
) -> dict[str, Any]:
    relevant: list[dict[str, Any]] = []
    saved = None
    try:
        saved = load_snapshot()
    except SnapshotCorrupt as exc:
        document["snapshotCorrupt"] = True
        document["errors"].append(f"스냅샷이 손상됐습니다: {exc}")
    document["savedSnapshot"] = saved
    if args.command == "restore" and snapshot_is_active(saved):
        snapshots.update(_collect_agents_for_restore(root, agents, saved))
        document["snapshots"] = snapshots
    if snapshot_is_active(saved):
        if saved.get("worktree") and not paths_equal(saved.get("worktree"), root):
            document["snapshotForeign"] = True
        drift = snapshot_drift(root, snapshots, saved)
        if drift:
            document["snapshotDrift"] = drift
            if args.command == "restore" and not getattr(args, "force_drift", False):
                document["errors"].append(
                    f"현재 상태가 스냅샷과 어긋납니다. --force-drift 없이 적용하지 않습니다. {drift}"
                )
    if args.command == "restore" and not snapshot_is_active(saved) and not document.get("snapshotCorrupt"):
        document["errors"].append("스냅샷이 없습니다. 추측해서 되돌리지 않습니다.")
    for agent in agents:
        snap = snapshots[agent]
        plan = {"register": None, "install": [], "validate": [], "restore": []}
        if args.command in {"register", "loop"}:
            plan["register"] = plan_register(root, snap)
        if args.command == "loop":
            plan["install"] = plan_install(root, snap, args.plugin)
        if args.command in {"check", "loop"}:
            plan["validate"] = plan_validate(root, snap, args.plugin)
        if args.command == "restore" and snapshot_is_active(saved):
            saved_a = (saved.get("agents") or {}).get(agent)
            plan["restore"] = plan_restore_agent(root, agent, snap, saved_a)
        document["plans"][agent] = plan
        blocked = list(snap.get("errors") or [])
        for step in [plan["register"], *plan["install"], *plan["validate"], *plan["restore"]]:
            if _fatal_step(step) and step.get("summary"):
                blocked.append(step["summary"])
        if document.get("snapshotCorrupt") and args.command in {"register", "loop", "restore"}:
            blocked.append("스냅샷이 손상돼 적용하지 않습니다.")
        if args.command == "restore" and not snapshot_is_active(saved) and not document.get("snapshotCorrupt"):
            blocked.append("스냅샷이 없습니다. 추측해서 되돌리지 않습니다.")
        if args.command == "restore" and document.get("snapshotDrift") and not getattr(args, "force_drift", False):
            blocked.append("drift 차단: --force-drift 가 필요합니다.")
        document["blocked"][agent] = blocked
        for err in blocked:
            tagged = f"{agent}: {err}"
            if err not in document["errors"] and tagged not in document["errors"]:
                document["errors"].append(tagged)
        if plan["register"]:
            relevant.append(plan["register"])
        relevant.extend(plan["install"])
        relevant.extend(plan["restore"])
    document["needsApproval"] = any(step.get("needsApproval") for step in relevant)
    document["overwrite"] = any(step.get("overwrite") for step in relevant)
    run_phases(args, document)
    return document


def exit_code(args: argparse.Namespace, document: dict[str, Any]) -> int:
    if document.get("appliedAny"):
        return EXIT_ERROR if document.get("errors") or not document.get("applyOk", True) else EXIT_OK
    if document.get("errors"):
        return EXIT_ERROR
    if document.get("needsApproval") and not args.yes:
        return EXIT_NEEDS_APPROVAL
    return EXIT_OK


HELP_EPILOG = """
명령:
  check             등록·설치 상태를 조회하고 설치본을 검증합니다. 기본값. 읽기 전용입니다.
  register          이 워크트리를 마켓플레이스로 add/update/retarget 할 계획을 만듭니다.
  register --yes    등록 계획을 적용합니다.
  loop              등록+설치+검증 계획을 만듭니다.
  loop --yes        등록+설치+검증을 적용합니다. 적용 전에 원본 등록을 --env 환경의 state 아래 스냅샷으로 저장합니다.
  restore           스냅샷의 원본 등록으로 되돌릴 계획을 만듭니다.
  restore --yes     스냅샷으로 직접 되돌립니다. 재조회가 스냅샷과 맞을 때만 완료 표시합니다.
  init-env --env P  허용된 상위 경계 아래 격리 환경을 만들고 도구 마커를 씁니다.
  init-env --yes    격리 환경을 실제로 만듭니다.
  cleanup-env --env P  검증된 도구 생성 환경만 삭제할 계획을 만듭니다.
  cleanup-env --yes 검증이 끝난 뒤에만 그 환경을 삭제합니다.

옵션:
  --env PATH                    격리 환경 루트. 생략하면 현재 git 워크트리 루트에서 자동 유도합니다. 명시하면 그 경로를 씁니다.
  --agent {claude,codex,both}   대상 에이전트. 기본 both.
  --plugin NAME                 설치·검증할 플러그인. 반복 가능. 매니페스트에 없으면 오류.
  --yes                         등록·설치·되돌리기·환경 생성·정리를 실제로 적용합니다.
  --force-drift                 restore 시 스냅샷 밖 변경(drift)을 강행합니다. 미완료 복원은 이 옵션 없이 이어집니다.
  --json                        JSON만 stdout에 씁니다.
  --self-test                   파서·계획 단위 테스트. 실제 CLI는 호출하지 않습니다.

승인:
  --yes 없이 돌리면 적용하지 않고, 변경이 있으면 종료 코드 2를 줍니다.
  같은 이름의 마켓플레이스가 다른 경로를 가리키면 remove 후 add 합니다.
  원래 소스를 파싱해 되돌릴 수 없으면 --yes 가 있어도 거부하고 종료 코드 3입니다.
  격리 환경 하위에 junction/symlink/reparse point 가 있으면 등록·설치·restore 를 --yes 가 있어도 거부합니다.
  플러그인·마켓플레이스 이름에 셸 메타문자가 있으면 거부합니다.
  retarget 중 remove 성공 후 add 가 실패하면 원래 경로로 add 를 시도합니다.
  한쪽 에이전트 실패가 다른 쪽의 등록·설치·검증을 막지 않습니다.

격리 환경:
  --env 를 생략하면 git rev-parse --show-toplevel 로 워크트리 루트를 구해
  {LOCALAPPDATA}\\plugin-dev-loop\\environments\\<디렉터리이름>-<경로해시8자> 를 씁니다.
  같은 워크트리는 항상 같은 값이고, 경로가 다르면 다른 값입니다. 대소문자·후행 슬래시 차이는 정규화합니다.
  워크트리 루트를 구하지 못하면 --env 가 필요합니다. 실행할 때 쓰는 격리 환경 경로를 한 줄로 출력합니다.
  지정 경로가 실제 구조와 맞지 않으면 실행 전에 중단합니다. 기본 홈으로 진행하지 않습니다.
  도구가 대상 환경을 확인하고, 하위 트리의 junction/symlink/reparse point 도 거부합니다.
  claude/codex 자식 프로세스에 CODEX_HOME 과 CLAUDE_CONFIG_DIR 을 env= 로 전달합니다.
  cleanup-env 는 절대 경로·도구 마커·허용된 상위 경계·사용 중 여부·트리 경계를 확인합니다.
  홈·드라이브 루트·작업공간·다른 환경·경계 밖 연결·도구가 만들지 않은 경로는 삭제 호출에 도달하지 않습니다.
  확인이 불가능하거나 오류가 나면 정리를 중단합니다.

스냅샷:
  위치는 --env 환경의 state/snapshot.json 입니다.
  기존 스냅샷은 덮어쓰지 않습니다. restore 가 전부 성공했을 때만 완료 표시하고 활성에서 제외합니다.
  스냅샷이 없으면 restore 는 추측하지 않고 거부합니다.
  손상된 스냅샷은 없음이 아니라 오류입니다. loop 가 그 위에 새 원본을 쓰지 않습니다.
  조회에 실패한 에이전트는 스냅샷에 기록하지 않고 변경하지 않습니다.
  스냅샷에 원본이 없는 에이전트는 조회가 성공하면 그때 원본을 기록한 뒤 변경합니다.
  다른 워크트리의 스냅샷이 있으면 출처를 알리고 유지합니다.
  플러그인을 먼저 제거한 뒤 마켓플레이스를 되돌립니다.
  Claude 제거는 uninstall name@marketplace, Codex 제거는 plugin remove 입니다.
  스냅샷이 요구하는 플러그인이 없으면 미완료 복원입니다. restore --yes 로 이어집니다.
  워크트리에서 스냅샷에 없는 플러그인을 수동으로 바꾸면 drift 입니다.

검증:
  검증 대상이 0개이면 실패입니다.
  Claude는 이 마켓플레이스 소속(id의 name@marketplace)과 installPath 존재, 선언 버전을 봅니다.
  같은 버전이면 uninstall 후 install 로 캐시를 강제 갱신합니다.
  Codex는 installed 만 보고, 설치 경로가 이 워크트리 아래여야 합니다.
""".strip()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="이 워크트리를 claude/codex 마켓플레이스로 점검·등록·설치·검증합니다.",
        epilog=HELP_EPILOG, formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("command", nargs="?", default="check", choices=list(COMMANDS),
                        help="check(기본, 조회+검증), register, loop(등록+설치+검증), restore(스냅샷 되돌리기), init-env, cleanup-env")
    parser.add_argument(
        "--env", metavar="PATH",
        help="격리 환경 루트. 생략하면 git 워크트리에서 자동 유도합니다.",
    )
    parser.add_argument("--agent", choices=["claude", "codex", "both"], default="both")
    parser.add_argument("--plugin", action="append", help="설치·검증할 플러그인 이름")
    parser.add_argument("--yes", action="store_true", help="계획을 실제로 적용합니다")
    parser.add_argument("--force-drift", action="store_true", help="restore 시 drift 를 강행합니다")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    return parser


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if not callable(reconfigure):
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (OSError, ValueError):
            pass


def main(argv: list[str] | None = None) -> int:
    configure_stdio()
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.self_test:
        block_process_execution()
        return self_test()
    try:
        env_root = resolve_env_root_from_args(args)
        print(f"격리 환경: {env_root}", file=sys.stderr)
        args.env = str(env_root)
        if args.command == "init-env":
            return run_init_env(args)
        if args.command == "cleanup-env":
            return run_cleanup_env(args)
        bind_isolated_env_from_args(args)
        document = execute(args)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return EXIT_ERROR
    if args.json:
        print(json.dumps(document, ensure_ascii=False, indent=2))
    else:
        print(format_human(document), end="")
    return exit_code(args, document)


def _exit(command: str, document: dict[str, Any], yes: bool = False) -> int:
    return exit_code(argparse.Namespace(command=command, yes=yes), document)


def _ok_run(name: str, args: list[str], stdout: str = "{}") -> dict[str, Any]:
    return {"cli": name, "args": args, "ok": True, "returncode": 0, "stdout": stdout, "stderr": "", "error": None, "argv": [name, *args]}


def _bad_run(name: str, args: list[str], error: str = "fail") -> dict[str, Any]:
    return {"cli": name, "args": args, "ok": False, "returncode": 1, "stdout": "", "stderr": error, "error": error, "argv": [name, *args]}


def _snap(agent: str = "claude", **kw: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "agent": agent, "cliFound": True, "marketplaceName": "sky-agent-plugins",
        "declaredPlugins": ["paseo-toolkit"], "declaredVersions": {"paseo-toolkit": "0.2.0"},
        "marketplace": None, "pointsAtWorktree": False, "plugins": [], "errors": [],
    }
    data.update(kw)
    return data


def self_test() -> int:
    global _CREATED_RECORDER, _ACTIVE_ENV
    block_process_execution()
    real_collect_agent = collect_agent
    orig_snapshot_path = snapshot_path
    orig_environments_root = environments_root
    created_paths: set[str] = set()
    _CREATED_RECORDER = created_paths.add
    tmp_snap_dir = Path(tempfile.mkdtemp())
    register_deletable(tmp_snap_dir)
    fake_envs = tmp_snap_dir / "fake-local" / "plugin-dev-loop" / "environments"
    fake_envs.mkdir(parents=True)
    register_deletable(tmp_snap_dir / "fake-local")
    register_deletable(tmp_snap_dir / "fake-local" / "plugin-dev-loop")
    register_deletable(fake_envs)
    sys.modules[__name__].environments_root = lambda: fake_envs
    dummy_root = tmp_snap_dir / "iso-env"
    dummy_codex = dummy_root / "codex-home"
    dummy_claude = dummy_root / "claude-config"
    dummy_state = dummy_root / "state"
    for path in (dummy_codex, dummy_claude, dummy_state):
        path.mkdir(parents=True)
        register_deletable(path)
    register_deletable(dummy_root)
    _ACTIVE_ENV = IsolatedEnv(dummy_root, dummy_codex, dummy_claude, dummy_state)
    sys.modules[__name__].snapshot_path = lambda: tmp_snap_dir / "snapshot.json"
    failures: list[str] = []

    def check(cond: bool, message: str) -> None:
        if not cond:
            failures.append(message)

    def expect_error(fn: Any, message: str) -> None:
        try:
            fn()
        except ValueError:
            return
        failures.append(message)

    check(_PROCESS_EXECUTION_BLOCKED is True, "self-test 런타임이 프로세스 생성을 차단하지 않았습니다")
    isolation_ok = _PROCESS_EXECUTION_BLOCKED is True
    if isolation_ok:
        try:
            run_process(["__plugin_dev_loop_isolation_probe__"])
            isolation_ok = False
            failures.append("테스트 중 run_process 가 예외를 던지지 않았습니다")
        except ProcessExecutionBlocked:
            pass
    if isolation_ok:
        for attr in _SUBPROCESS_FNS:
            fn = getattr(subprocess, attr)
            try:
                fn(["__plugin_dev_loop_isolation_probe__"])
                isolation_ok = False
                failures.append(f"테스트 중 subprocess.{attr} 가 예외를 던지지 않았습니다")
                break
            except ProcessExecutionBlocked:
                pass
            except Exception:
                isolation_ok = False
                failures.append(f"테스트 중 subprocess.{attr} 가 차단되지 않았습니다")
                break
    if isolation_ok:
        for attr in _OS_SPAWN_FNS:
            fn = getattr(os, attr, None)
            if not callable(fn):
                continue
            try:
                fn()
                isolation_ok = False
                failures.append(f"테스트 중 os.{attr} 가 예외를 던지지 않았습니다")
                break
            except ProcessExecutionBlocked:
                pass
            except Exception:
                isolation_ok = False
                failures.append(f"테스트 중 os.{attr} 가 차단되지 않았습니다")
                break
    if isolation_ok:
        try:
            git_root()
            isolation_ok = False
            failures.append("테스트 중 git_root 가 예외를 던지지 않았습니다")
        except ProcessExecutionBlocked:
            pass
    if isolation_ok:
        accident = {
            "kind": "register", "action": "retarget", "needsApproval": True, "overwrite": True,
            "commands": [
                ["plugin", "marketplace", "remove", "sky-agent-plugins"],
                ["plugin", "marketplace", "add", r"D:\missing-worktree"],
            ],
        }
        try:
            for item in apply_steps("codex", [accident]):
                for run in item.get("runs") or []:
                    if run.get("returncode") is not None:
                        failures.append("테스트 중 apply_steps 가 실제 프로세스를 생성했습니다")
        except ProcessExecutionBlocked:
            pass

    orig_remove = os.remove
    orig_rmdir = os.rmdir
    orig_unlink = Path.unlink
    orig_rmtree = shutil.rmtree
    orig_removedirs = os.removedirs
    delete_hits: list[str] = []

    def boom_remove(name: str, *args: Any, **kwargs: Any) -> None:
        delete_hits.append(str(name))
        raise AssertionError("os.remove called: " + str(name))

    def boom_rmdir(name: str, *args: Any, **kwargs: Any) -> None:
        delete_hits.append(str(name))
        raise AssertionError("os.rmdir called: " + str(name))

    def boom_unlink(self: Path, *args: Any, **kwargs: Any) -> None:
        delete_hits.append(str(self))
        raise AssertionError("Path.unlink called: " + str(self))

    def boom_rmtree(path: Any, *args: Any, **kwargs: Any) -> None:
        delete_hits.append(str(path))
        raise AssertionError("shutil.rmtree called: " + str(path))

    def boom_removedirs(name: str, *args: Any, **kwargs: Any) -> None:
        delete_hits.append(str(name))
        raise AssertionError("os.removedirs called: " + str(name))

    os.remove = boom_remove
    os.rmdir = boom_rmdir
    Path.unlink = boom_unlink
    shutil.rmtree = boom_rmtree
    os.removedirs = boom_removedirs
    try:
        for label, victim in (
            ("home", Path.home()),
            ("drive-root", Path(Path.home().anchor)),
            ("worktree", script_worktree_root()),
            ("cwd", Path.cwd()),
        ):
            delete_hits.clear()
            reason = gated_delete(victim)
            check(reason is not None, f"gated_delete rejects {label}")
            check(not delete_hits, f"gated_delete {label} did not call unlink/rmdir")
        delete_hits.clear()
        reason = gated_delete(None)
        check(reason is not None, "gated_delete rejects None")
        check(not delete_hits, "gated_delete None did not call unlink/rmdir")
        delete_hits.clear()
        reason = gated_delete("   ")
        check(reason is not None, "gated_delete rejects empty")
        check(not delete_hits, "gated_delete empty did not call unlink/rmdir")
        missing = tmp_snap_dir / "gate-child" / "file.txt"
        register_deletable(missing)
        check(
            str(missing.resolve(strict=False)) not in _DELETABLE_PATHS,
            "nonexistent path is not registered",
        )
        child_dir = tmp_snap_dir / "gate-child"
        child_dir.mkdir()
        nested = child_dir / "file.txt"
        nested.write_text("nested", encoding="utf-8")
        register_deletable(nested)
        delete_hits.clear()
        reason = gated_delete(child_dir)
        check(reason is not None, "gated_delete rejects registered parent")
        check(not delete_hits, "parent did not call unlink/rmdir")
        sibling = child_dir / "other.txt"
        sibling.write_text("sib", encoding="utf-8")
        delete_hits.clear()
        reason = gated_delete(sibling)
        check(reason is not None, "gated_delete rejects registered sibling")
        check(not delete_hits, "sibling did not call unlink/rmdir")
        register_deletable(sibling)
        register_deletable(child_dir)
        delete_hits.clear()
        reason = gated_delete(tmp_snap_dir / "gate-unregistered.txt")
        check(reason is not None, "gated_delete rejects unregistered path")
        check(not delete_hits, "unregistered did not call unlink/rmdir")
        reparse_target = tmp_snap_dir / "gate-reparse.txt"
        orig_lstat = os.lstat

        class ReparseStat:
            st_mode = stat.S_IFREG
            st_file_attributes = 0x400

        def fake_lstat(name: Any, *args: Any, **kwargs: Any) -> Any:
            if Path(str(name)) == reparse_target:
                return ReparseStat()
            return orig_lstat(name, *args, **kwargs)

        os.lstat = fake_lstat
        try:
            register_deletable(reparse_target)
            check(
                str(reparse_target.resolve(strict=False)) not in _DELETABLE_PATHS,
                "reparse path is not registered",
            )
            delete_hits.clear()
            reason = gated_delete(reparse_target)
            check(reason is not None, "gated_delete rejects reparse")
            check(not delete_hits, "reparse did not call delete")
        finally:
            os.lstat = orig_lstat
        parent_rp = tmp_snap_dir / "gate-parent-reparse"
        parent_rp.mkdir()
        child_rp = parent_rp / "file.txt"
        child_rp.write_text("nested", encoding="utf-8")
        child2_rp = parent_rp / "other.txt"
        child2_rp.write_text("other", encoding="utf-8")
        register_deletable(parent_rp)
        register_deletable(child_rp)

        class ParentReparseStat:
            st_mode = stat.S_IFDIR
            st_file_attributes = 0x400

        def fake_lstat_parent(name: Any, *args: Any, **kwargs: Any) -> Any:
            if Path(str(name)) == parent_rp:
                return ParentReparseStat()
            return orig_lstat(name, *args, **kwargs)

        os.lstat = fake_lstat_parent
        try:
            register_deletable(child2_rp)
            check(
                str(child2_rp.resolve(strict=False)) not in _DELETABLE_PATHS,
                "path under reparse parent is not registered",
            )
            delete_hits.clear()
            reason = gated_delete(child_rp)
            check(reason is not None, "gated_delete rejects path under reparse parent")
            check(not delete_hits, "reparse parent did not call delete")
        finally:
            os.lstat = orig_lstat
        register_deletable(child2_rp)
    except AssertionError as exc:
        failures.append(str(exc))
    finally:
        os.remove = orig_remove
        os.rmdir = orig_rmdir
        Path.unlink = orig_unlink
        shutil.rmtree = orig_rmtree
        os.removedirs = orig_removedirs

    d2_dir = tmp_snap_dir / "d2-non-file"
    d2_dir.mkdir()
    register_deletable(d2_dir)
    saved_snap = sys.modules[__name__].snapshot_path
    sys.modules[__name__].snapshot_path = lambda: d2_dir
    try:
        d2_reason = delete_snapshot()
        check(d2_reason is not None, "delete_snapshot rejects existing non-file")
        check(d2_dir.exists(), "non-file snapshot path remains")
    finally:
        sys.modules[__name__].snapshot_path = saved_snap
    d2_missing = tmp_snap_dir / "d2-missing.json"
    sys.modules[__name__].snapshot_path = lambda: d2_missing
    try:
        check(delete_snapshot() is None, "delete_snapshot missing path succeeds")
    finally:
        sys.modules[__name__].snapshot_path = saved_snap
    d3_missing = tmp_snap_dir / "d3-missing.json"
    sys.modules[__name__].snapshot_path = lambda: d3_missing
    orig_lstat_d3 = os.lstat
    def fake_lstat_not_found(name: Any, *args: Any, **kwargs: Any) -> Any:
        if Path(str(name)) == d3_missing:
            raise FileNotFoundError("missing")
        return orig_lstat_d3(name, *args, **kwargs)
    os.lstat = fake_lstat_not_found
    try:
        check(delete_snapshot() is None, "delete_snapshot FileNotFoundError succeeds")
    finally:
        os.lstat = orig_lstat_d3
        sys.modules[__name__].snapshot_path = saved_snap
    d3_denied = tmp_snap_dir / "d3-denied.json"
    sys.modules[__name__].snapshot_path = lambda: d3_denied
    def fake_lstat_denied(name: Any, *args: Any, **kwargs: Any) -> Any:
        if Path(str(name)) == d3_denied:
            raise PermissionError("denied")
        return orig_lstat_d3(name, *args, **kwargs)
    os.lstat = fake_lstat_denied
    try:
        d3_reason = delete_snapshot()
        check(d3_reason is not None, "delete_snapshot other OSError fails")
        check("denied" in str(d3_reason) or "lstat" in str(d3_reason), "delete_snapshot other OSError reason")
    finally:
        os.lstat = orig_lstat_d3
        sys.modules[__name__].snapshot_path = saved_snap

    allowed = tmp_snap_dir / "gate-allowed.txt"
    allowed.write_text("ok", encoding="utf-8")
    register_deletable(allowed)
    allowed_reason = gated_delete(allowed)
    check(allowed_reason is None, "gated_delete allows exact registered path")
    check(not allowed.exists(), "gated_delete removed the registered file")

    if os.name == "nt":
        check(normalize_path_text(r"\\?\C:\Windows") == normalize_path_text(r"C:\Windows"), "extended-length prefix")
        check(paths_equal(r"C:\Windows", r"c:\windows"), "Windows 대소문자")
        check(paths_equal(r"\\?\UNC\server\share\repo", r"\\server\share\repo"), "extended UNC")
        check(paths_equal("file:///D:/worktree", r"D:\worktree"), "file: URI")
        check(paths_equal("file:///D:/worktree/", r"D:\worktree"), "file: URI slash")
    check(paths_equal(None, "x") is False, "None 경로")

    claude_dir = parse_marketplaces("claude", [{
        "name": "sky-agent-plugins", "source": "directory", "path": r"D:\worktree",
        "installLocation": r"X:\synth-cache\claude\plugins\marketplaces\sky-agent-plugins",
    }])
    check(claude_dir[0]["path"] == r"D:\worktree", "claude directory path")
    check(parse_marketplaces("claude", [{
        "name": "xr-ai-plugins", "source": "git", "url": "http://example.invalid/repo.git",
        "installLocation": r"X:\synth-cache\claude\plugins\marketplaces\xr-ai-plugins",
    }])[0]["path"] is None, "claude git 은 로컬 경로가 아님")
    check(parse_marketplaces("claude", [{
        "name": "claude-plugins-official", "source": "github", "repo": "anthropics/claude-plugins-official",
        "installLocation": r"X:\synth-cache\claude\plugins\marketplaces\claude-plugins-official",
    }])[0]["path"] is None, "claude github 은 로컬 경로가 아님")
    expect_error(lambda: parse_marketplaces("claude", {"data": [{"name": "x", "source": "directory", "path": r"D:\x"}]}), "claude data 래퍼 거부")
    expect_error(lambda: parse_marketplaces("claude", [{"name": "x", "source": {"source": "directory", "path": r"D:\x"}}]), "claude 중첩 source 거부")
    check(paths_equal(parse_marketplaces("claude", [{
        "name": "sky-agent-plugins", "source": "directory", "path": "file:///D:/worktree",
    }])[0]["path"], r"D:\worktree"), "claude file: URI")

    synth_extended, synth_plain = r"\\?\D:\synth-marketplace", r"D:\synth-marketplace"
    codex_local = parse_marketplaces("codex", {"marketplaces": [{"name": "sky-agent-plugins", "root": synth_extended}]})
    check(codex_local[0]["path"] == synth_extended, "codex 로컬 root")
    check(paths_equal(codex_local[0]["path"], synth_plain), "codex root extended path")
    check(parse_marketplaces("codex", {"marketplaces": [{
        "name": "xr-ai-plugins", "root": r"X:\cache\demo",
        "marketplaceSource": {"sourceType": "git", "source": "https://example.com/repo.git"},
    }]})[0]["path"] is None, "codex git marketplaceSource 는 캐시 root 를 경로로 쓰지 않음")
    expect_error(lambda: parse_marketplaces("codex", {"schema_v2": []}), "codex 알 수 없는 최상위")
    expect_error(lambda: parse_marketplaces("codex", {"marketplaces": [{"name": "x", "source_type": "local", "source": r"D:\x"}]}), "codex TOML 형태 JSON 거부")
    expect_error(lambda: parse_marketplaces("codex", {"marketplaces": [{"root": r"X:\synth-repo"}]}), "이름 없는 marketplace")
    check(parse_marketplaces("codex", {"marketplaces": []}) == [], "빈 marketplaces")

    expect_error(lambda: parse_plugins("claude", {"plugins": []}), "claude plugins 래퍼 거부")
    expect_error(lambda: parse_plugins("claude", {"installed": []}), "claude installed 래퍼 거부")
    expect_error(lambda: parse_plugins("codex", {"schema_v2": []}), "codex plugin 알 수 없는 최상위")
    expect_error(lambda: parse_plugins("codex", {"installed": [False], "available": []}), "installed 항목 오류")
    check(parse_plugins("codex", {"installed": [], "available": []}) == [], "빈 installed")
    check(parse_plugins("codex", {"installed": [], "available": [{"pluginId": "paseo-toolkit@sky-agent-plugins", "name": "paseo-toolkit"}]}) == [], "available-only 제외")

    claude_plugins = parse_plugins("claude", [{
        "id": "paseo-toolkit@sky-agent-plugins", "version": "0.2.0",
        "installPath": r"X:\synth-cache\claude\plugins\paseo-toolkit",
        "scope": "user", "enabled": True, "installedAt": "2026-01-01", "lastUpdated": "2026-01-01",
    }])
    check(claude_plugins[0]["name"] == "paseo-toolkit" and claude_plugins[0]["marketplace"] == "sky-agent-plugins", "claude id@marketplace")
    check(claude_plugins[0]["path"] == r"X:\synth-cache\claude\plugins\paseo-toolkit", "claude installPath")
    check(parse_plugins("codex", {"installed": [{
        "pluginId": "codex-skill-creator@sky-agent-plugins", "name": "codex-skill-creator",
        "marketplaceName": "sky-agent-plugins", "version": "1.0.0", "installed": True, "enabled": True,
        "source": {"source": "local", "path": r"X:\orig\plugins\codex-skill-creator"},
        "marketplaceSource": {"sourceType": "local", "source": r"X:\orig"},
    }], "available": []})[0]["selector"] == "codex-skill-creator@sky-agent-plugins", "codex plugin selector")

    fake_root = Path(normalize_path_text(r"D:\worktree"))
    add_plan = plan_register(fake_root, _snap())
    check(add_plan["action"] == "add" and add_plan["needsApproval"] is True, "미등록 add")
    snap_other = _snap("codex", marketplace={"name": "sky-agent-plugins", "path": r"X:\original"})
    retarget = plan_register(fake_root, snap_other)
    check(retarget["action"] == "retarget" and retarget["overwrite"] is True, "retarget")
    check(retarget.get("recoverCommand") == ["plugin", "marketplace", "add", restore_path_text(r"X:\original")], "recoverCommand")
    space_plan = plan_register(fake_root, _snap("codex", marketplace={"name": "sky-agent-plugins", "path": r"D:\old worktree"}))
    space_restored = restore_path_text(r"D:\old worktree")
    check(space_plan.get("recoverCommand") == ["plugin", "marketplace", "add", space_restored], "공백 경로 recover")
    snap_same = _snap(marketplace={"name": "sky-agent-plugins", "path": str(fake_root)}, pointsAtWorktree=True)
    check(plan_register(fake_root, snap_same)["action"] == "update", "claude 같은 경로 update")
    check(plan_register(fake_root, {**snap_same, "agent": "codex"})["action"] == "skip", "codex 같은 경로 skip")
    if os.name == "nt":
        check(plan_register(fake_root, _snap("codex", marketplace={"name": "sky-agent-plugins", "path": r"\\?\D:\worktree"}))["action"] == "skip", "codex extended root skip")
        unc_plan = plan_register(fake_root, _snap("codex", marketplace={"name": "sky-agent-plugins", "path": r"\\?\UNC\server\share\original-repo"}))
        check(unc_plan["action"] == "retarget", "UNC retarget")
        unc_recover = " ".join(str(part) for part in (unc_plan.get("recoverCommand") or []))
        check("\\\\server\\share\\original-repo" in unc_recover and "UNC\\server" not in unc_recover, "UNC recover 경로")
        check(plan_register(fake_root, _snap(marketplace={"name": "sky-agent-plugins", "path": "file:///D:/worktree"}))["action"] == "update", "file: URI update")

    check(all(s.get("blockedBy") == "register" for s in plan_install(fake_root, snap_other, None) if s.get("plugin")), "install blocked")
    allowed = plan_install(fake_root, snap_same, ["paseo-toolkit"])
    check(allowed[0]["action"] == "install" and "-y" in allowed[0]["commands"][0], "claude install")
    same_ver = plan_install(fake_root, {**snap_same, "plugins": [{
        "name": "paseo-toolkit", "version": "0.2.0", "marketplace": "sky-agent-plugins",
        "selector": "paseo-toolkit@sky-agent-plugins", "path": r"X:\synth-cache\claude\plugins\paseo-toolkit",
    }]}, ["paseo-toolkit"])
    check(same_ver[0]["action"] == "reinstall", "같은 버전은 강제 재설치")
    check(same_ver[0]["commands"] == [
        ["plugin", "uninstall", "paseo-toolkit@sky-agent-plugins", "-y"],
        ["plugin", "install", "paseo-toolkit@sky-agent-plugins", "-y"],
    ], "같은 버전 uninstall+install")
    check(same_ver[0].get("recoverCommand") == ["plugin", "install", "paseo-toolkit@sky-agent-plugins", "-y"], "실패 복구는 install")
    check(plan_install(fake_root, {**snap_same, "plugins": [{
        "name": "paseo-toolkit", "version": "0.1.0", "marketplace": "sky-agent-plugins",
        "selector": "paseo-toolkit@sky-agent-plugins", "path": r"X:\cache\p",
    }]}, ["paseo-toolkit"])[0]["action"] == "update", "다른 버전 update")
    pending = plan_install(fake_root, _snap(), ["paseo-toolkit"])
    check(pending[0].get("blockedBy") == "register" and pending[0].get("commands") == [], "미등록 skip")
    pending_text = format_human({
        "repoRoot": str(fake_root), "command": "loop", "agents": ["claude"], "yes": False,
        "snapshots": {"claude": _snap()},
        "plans": {"claude": {"register": add_plan, "install": pending, "validate": []}},
        "needsApproval": True, "appliedAny": False, "applied": {}, "validated": {}, "errors": [], "blocked": {},
    })
    check("승인 시 설치 예정" in pending_text, "설치 예정 표시")
    check("붙여 실행하세요" in pending_text, "--yes 없는 안내")
    check("붙여 실행하세요" not in format_human({
        "repoRoot": str(fake_root), "command": "loop", "agents": ["claude"], "yes": True,
        "snapshots": {"claude": _snap()},
        "plans": {"claude": {"register": add_plan, "install": pending, "validate": []}},
        "needsApproval": True, "appliedAny": False, "applied": {}, "validated": {}, "errors": [], "blocked": {},
    }), "--yes 있으면 재안내 금지")

    module = sys.modules[__name__]
    loop_cmds: list[tuple[str, list[str]]] = []

    def _fake_loop_run(name: str, args: list[str], timeout: int = TIMEOUT_READ) -> dict[str, Any]:
        loop_cmds.append((name, list(args)))
        if args[:2] == ["plugin", "list"]:
            stdout = "[]" if name == "claude" else '{"installed": [], "available": []}'
        elif args[:2] == ["plugin", "validate"]:
            stdout = '{"ok": true}'
        else:
            stdout = "[]" if name == "claude" else '{"marketplaces": []}'
        return _ok_run(name, args, stdout)

    loop_doc = {
        "repoRoot": str(fake_root), "command": "loop", "agents": ["claude", "codex"],
        "snapshots": {"claude": _snap(), "codex": _snap("codex")},
        "plans": {
            "claude": {"register": add_plan, "install": [dict(s) for s in pending], "validate": plan_validate(fake_root, _snap(), ["paseo-toolkit"])},
            "codex": {"register": plan_register(fake_root, _snap("codex")), "install": [dict(s) for s in plan_install(fake_root, _snap("codex"), ["paseo-toolkit"])], "validate": plan_validate(fake_root, _snap("codex"), ["paseo-toolkit"])},
        },
        "needsApproval": True, "overwrite": False, "appliedAny": False, "applied": {}, "validated": {},
        "errors": [], "blocked": {"claude": [], "codex": []}, "yes": True,
    }
    saved_run, saved_collect = module.run_cli, module.collect_agent
    try:
        module.run_cli = _fake_loop_run
        module.collect_agent = lambda root, agent: _snap(agent, marketplace={"name": "sky-agent-plugins", "path": str(root)}, pointsAtWorktree=True)
        run_phases(argparse.Namespace(command="loop", yes=True, plugin=["paseo-toolkit"]), loop_doc)
    finally:
        module.run_cli, module.collect_agent = saved_run, saved_collect
    check(loop_doc["plans"]["claude"]["install"][0].get("action") == "install", "claude install 재계산")
    check(loop_doc["plans"]["codex"]["install"][0].get("action") == "add", "codex add 재계산")
    check(any(n == "claude" and a[:2] == ["plugin", "install"] for n, a in loop_cmds), "claude install 실행")
    check(any(n == "codex" and a[:2] == ["plugin", "add"] for n, a in loop_cmds), "codex add 실행")
    check(loop_doc.get("needsApproval") is False, "적용 후 needsApproval 은 거짓")

    re_cmds: list[tuple[str, list[str]]] = []
    re_snap = {
        **snap_same,
        "plugins": [{
            "name": "paseo-toolkit", "version": "0.2.0", "marketplace": "sky-agent-plugins",
            "selector": "paseo-toolkit@sky-agent-plugins",
            "path": r"X:\synth-cache\claude\plugins\paseo-toolkit",
        }],
    }
    re_doc = {
        "repoRoot": str(fake_root), "command": "loop", "agents": ["claude"],
        "snapshots": {"claude": re_snap},
        "plans": {"claude": {
            "register": plan_register(fake_root, re_snap),
            "install": [dict(s) for s in plan_install(fake_root, re_snap, ["paseo-toolkit"])],
            "validate": plan_validate(fake_root, re_snap, ["paseo-toolkit"]),
        }},
        "needsApproval": True, "appliedAny": False, "applied": {}, "validated": {},
        "errors": [], "blocked": {"claude": []}, "yes": True,
    }
    saved_run, saved_collect = module.run_cli, module.collect_agent
    try:
        module.run_cli = lambda name, args, timeout=TIMEOUT_READ: re_cmds.append((name, list(args))) or _ok_run(
            name, args,
            "[]" if args[:2] == ["plugin", "list"] else ('{"ok": true}' if args[:2] == ["plugin", "validate"] else "{}"),
        )
        module.collect_agent = lambda root, agent: re_snap
        run_phases(argparse.Namespace(command="loop", yes=True, plugin=["paseo-toolkit"]), re_doc)
    finally:
        module.run_cli, module.collect_agent = saved_run, saved_collect
    check(any(a[:2] == ["plugin", "uninstall"] for _, a in re_cmds), "같은 버전 uninstall 실행")
    check(any(a[:2] == ["plugin", "install"] for _, a in re_cmds), "같은 버전 install 실행")

    recover_installs: list[list[str]] = []
    saved_run = module.run_cli
    try:
        def _fake_re_fail_then_ok(name: str, args: list[str], timeout: int = TIMEOUT_READ) -> dict[str, Any]:
            recover_installs.append(list(args))
            if args[:2] == ["plugin", "uninstall"]:
                return _ok_run(name, args)
            if args[:2] == ["plugin", "install"]:
                if sum(1 for item in recover_installs if item[:2] == ["plugin", "install"]) == 1:
                    return _bad_run(name, args, "install failed")
                return _ok_run(name, args)
            return _ok_run(name, args)
        module.run_cli = _fake_re_fail_then_ok
        recovered_re = apply_steps("claude", [same_ver[0]])
    finally:
        module.run_cli = saved_run
    check(sum(1 for item in recover_installs if item[:2] == ["plugin", "install"]) == 2, "install 실패 후 복구 install")
    check(recovered_re[0].get("recovered") is True and recovered_re[0]["ok"] is True, "복구 install 성공")

    fail_installs: list[list[str]] = []
    saved_run = module.run_cli
    try:
        def _fake_re_both_fail(name: str, args: list[str], timeout: int = TIMEOUT_READ) -> dict[str, Any]:
            fail_installs.append(list(args))
            if args[:2] == ["plugin", "uninstall"]:
                return _ok_run(name, args)
            if args[:2] == ["plugin", "install"]:
                return _bad_run(name, args, "install failed")
            return _ok_run(name, args)
        module.run_cli = _fake_re_both_fail
        failed_re = apply_steps("claude", [same_ver[0]])
    finally:
        module.run_cli = saved_run
    check(failed_re[0]["ok"] is False, "복구 install 실패는 실패")
    fail_notes = "\n".join(failed_re[0].get("notes") or [])
    check("복구 install 실패" in fail_notes or "install failed" in fail_notes, "실패 후 복구 install 기록")
    check("uninstall" not in fail_notes.casefold(), "실패 후 출력이 uninstall 이면 안 됨")

    failopen_cmds: list[tuple[str, list[str]]] = []
    failopen_doc = {
        "repoRoot": str(fake_root), "command": "loop", "agents": ["claude"],
        "snapshots": {"claude": _snap()},
        "plans": {"claude": {"register": add_plan, "install": [dict(s) for s in pending], "validate": []}},
        "needsApproval": True, "appliedAny": False, "applied": {}, "validated": {}, "errors": [],
        "blocked": {"claude": []}, "yes": True,
    }
    saved_run, saved_collect = module.run_cli, module.collect_agent
    try:
        module.run_cli = lambda name, args, timeout=TIMEOUT_READ: failopen_cmds.append((name, list(args))) or _ok_run(name, args)
        module.collect_agent = lambda root, agent: _snap(agent, marketplace={"name": "sky-agent-plugins", "path": None}, pointsAtWorktree=False, errors=["marketplace list JSON 파싱 실패"])
        run_phases(argparse.Namespace(command="loop", yes=True, plugin=["paseo-toolkit"]), failopen_doc)
    finally:
        module.run_cli, module.collect_agent = saved_run, saved_collect
    check(not any(a[:2] in (["plugin", "install"], ["plugin", "add"], ["plugin", "update"], ["plugin", "uninstall"], ["plugin", "remove"]) for _, a in failopen_cmds), "fail-open 설치 금지")
    check(failopen_doc["snapshots"]["claude"].get("pointsAtWorktree") is not True, "fail-open True 강제 금지")

    isolate_cmds: list[tuple[str, list[str]]] = []
    isolate_doc = {
        "repoRoot": str(fake_root), "command": "loop", "agents": ["claude", "codex"],
        "snapshots": {"claude": _snap(), "codex": _snap("codex", errors=["marketplace list JSON 파싱 실패: 스키마"])},
        "plans": {
            "claude": {"register": add_plan, "install": [dict(s) for s in pending], "validate": plan_validate(fake_root, _snap(), ["paseo-toolkit"])},
            "codex": {"register": plan_register(fake_root, _snap("codex", errors=["x"])), "install": [], "validate": []},
        },
        "needsApproval": True, "appliedAny": False, "applied": {}, "validated": {},
        "errors": ["codex: marketplace list JSON 파싱 실패: 스키마"],
        "blocked": {"claude": [], "codex": ["marketplace list JSON 파싱 실패: 스키마"]}, "yes": True,
    }
    saved_run, saved_collect = module.run_cli, module.collect_agent
    try:
        module.run_cli = lambda name, args, timeout=TIMEOUT_READ: isolate_cmds.append((name, list(args))) or _ok_run(
            name, args, "[]" if name == "claude" and args[:2] == ["plugin", "list"] else ('{"ok": true}' if args[:2] == ["plugin", "validate"] else "{}")
        )
        module.collect_agent = lambda root, agent: _snap(agent, marketplace={"name": "sky-agent-plugins", "path": str(root)}, pointsAtWorktree=True) if agent == "claude" else _snap(agent, errors=["x"])
        run_phases(argparse.Namespace(command="loop", yes=True, plugin=["paseo-toolkit"]), isolate_doc)
    finally:
        module.run_cli, module.collect_agent = saved_run, saved_collect
    check(any(n == "claude" and a[:3] == ["plugin", "marketplace", "add"] for n, a in isolate_cmds), "claude 는 격리 후에도 등록")
    check(not any(n == "codex" for n, a in isolate_cmds), "codex 실패가 claude 를 막지 않음 — codex 명령 없음")

    rev_cmds: list[tuple[str, list[str]]] = []
    rev_doc = {
        "repoRoot": str(fake_root), "command": "loop", "agents": ["claude", "codex"],
        "snapshots": {"claude": _snap(errors=["marketplace list JSON 파싱 실패"]), "codex": _snap("codex")},
        "plans": {
            "claude": {"register": plan_register(fake_root, _snap(errors=["x"])), "install": [], "validate": []},
            "codex": {
                "register": plan_register(fake_root, _snap("codex")),
                "install": [dict(s) for s in plan_install(fake_root, _snap("codex"), ["paseo-toolkit"])],
                "validate": plan_validate(fake_root, _snap("codex"), ["paseo-toolkit"]),
            },
        },
        "needsApproval": True, "appliedAny": False, "applied": {}, "validated": {},
        "errors": ["claude: marketplace list JSON 파싱 실패"],
        "blocked": {"claude": ["marketplace list JSON 파싱 실패"], "codex": []}, "yes": True,
    }
    saved_run, saved_collect = module.run_cli, module.collect_agent
    try:
        module.run_cli = lambda name, args, timeout=TIMEOUT_READ: rev_cmds.append((name, list(args))) or _ok_run(
            name, args, '{"installed": [], "available": []}' if args[:2] == ["plugin", "list"] else "{}"
        )
        module.collect_agent = lambda root, agent: (
            _snap(agent, errors=["x"]) if agent == "claude"
            else _snap(agent, marketplace={"name": "sky-agent-plugins", "path": str(root)}, pointsAtWorktree=True)
        )
        run_phases(argparse.Namespace(command="loop", yes=True, plugin=["paseo-toolkit"]), rev_doc)
    finally:
        module.run_cli, module.collect_agent = saved_run, saved_collect
    check(any(n == "codex" and a[:3] == ["plugin", "marketplace", "add"] for n, a in rev_cmds), "claude 실패 후에도 codex 등록")
    check(not any(n == "claude" for n, a in rev_cmds), "claude 실패가 격리되면 claude 명령 없음")

    recover_cmds: list[list[str]] = []
    saved_run = module.run_cli
    try:
        def _fake_recover(name: str, args: list[str], timeout: int = TIMEOUT_READ) -> dict[str, Any]:
            recover_cmds.append(list(args))
            if args[:3] == ["plugin", "marketplace", "add"] and "worktree" in str(args[-1]).casefold():
                return _bad_run(name, args, "add failed")
            return _ok_run(name, args)
        module.run_cli = _fake_recover
        recovered = apply_steps("codex", [retarget])
    finally:
        module.run_cli = saved_run
    check(recovered[0]["ok"] is False and recovered[0].get("recovered") is True, "retarget 복구")
    check(any(a[:3] == ["plugin", "marketplace", "add"] and "original" in str(a[-1]).casefold() for a in recover_cmds), "복구 add")

    refuse = plan_register(fake_root, _snap("codex", marketplace={"name": "sky-agent-plugins", "path": None, "raw": {"name": "sky-agent-plugins", "root": r"X:\cache", "marketplaceSource": {"sourceType": "git", "source": "https://example.com/x"}}}))
    check(refuse["action"] == "refuse" and refuse.get("commands") == [] and _fatal_step(refuse), "복구 불가 거부")
    check(apply_steps("codex", [refuse])[0]["ok"] is False, "--yes 여도 거부")
    remote = parse_marketplaces("codex", {"marketplaces": [{"name": "sky-agent-plugins", "root": r"X:\cache\demo", "marketplaceSource": {"sourceType": "git", "source": "https://example.com/repo.git"}}]})
    check(plan_register(fake_root, _snap("codex", marketplace={"name": "sky-agent-plugins", "path": remote[0]["path"], "raw": remote[0]["raw"]}))["action"] == "refuse", "git 등록 refuse")

    unknown_install = plan_install(fake_root, snap_same, ["ghost-plugin"])
    unknown_validate = plan_validate(fake_root, snap_same, ["ghost-plugin"])
    check(any(_fatal_step(s) for s in unknown_install) and any(_fatal_step(s) for s in unknown_validate), "미선언 plugin")
    check(any(_fatal_step(s) for s in plan_validate(fake_root, {**snap_same, "declaredPlugins": []}, None)), "검증 0개")
    empty_plan = plan_validate(fake_root, {**snap_same, "plugins": []}, ["paseo-toolkit"])
    saved_run = module.run_cli
    try:
        module.run_cli = lambda name, args, timeout=TIMEOUT_READ: _ok_run(name, args, "[]" if args[:2] == ["plugin", "list"] else '{"ok": true}')
        empty_results = run_validate_steps(fake_root, "claude", empty_plan, {**snap_same, "plugins": []})
    finally:
        module.run_cli = saved_run
    check(any(not item.get("ok") for item in empty_results), "빈 목록 Claude 검증 실패")
    check(_exit("check", {"errors": [], "appliedAny": True, "validated": {"claude": empty_results}, "applyOk": False, "needsApproval": False}) == EXIT_ERROR, "빈 설치 check 오류")
    check(_exit("loop", {"errors": ["claude: 매니페스트에 없는 플러그인: ghost-plugin"], "appliedAny": False, "needsApproval": False}) == EXIT_ERROR, "미선언 loop 오류")

    def _write_plugin_tree(base: Path) -> Path:
        plugin = base / "plugins" / "paseo-toolkit"
        (plugin / "skills" / "demo").mkdir(parents=True)
        (plugin / "scripts").mkdir(parents=True)
        (plugin / ".claude-plugin").mkdir(parents=True)
        (plugin / "skills" / "demo" / "SKILL.md").write_bytes(b"skill-body")
        (plugin / "scripts" / "shared.py").write_bytes(b"print(1)\n")
        (plugin / ".claude-plugin" / "plugin.json").write_bytes(b'{"name":"paseo-toolkit","version":"0.2.0"}')
        for path in (
            base, base / "plugins", plugin, plugin / "skills", plugin / "skills" / "demo",
            plugin / "scripts", plugin / ".claude-plugin",
            plugin / "skills" / "demo" / "SKILL.md", plugin / "scripts" / "shared.py",
            plugin / ".claude-plugin" / "plugin.json",
        ):
            register_deletable(path)
        return plugin

    cmp_src = tmp_snap_dir / "cmp-src"
    cmp_cache = tmp_snap_dir / "cmp-cache"
    _write_plugin_tree(cmp_src)
    _write_plugin_tree(cmp_cache)
    matching = parse_plugins("claude", [{
        "id": "paseo-toolkit@sky-agent-plugins", "version": "0.2.0",
        "installPath": str(cmp_cache / "plugins" / "paseo-toolkit"),
    }])
    cache_ok, cache_ok_notes = assess_listed_plugins(
        cmp_src, "claude", ["paseo-toolkit"], matching, {"paseo-toolkit": "0.2.0"}, "sky-agent-plugins"
    )
    check(cache_ok is True, "claude 캐시+버전 통과")
    check(any("바이트 일치" in n for n in cache_ok_notes), "claude 바이트 일치 기록")
    skill_cache = cmp_cache / "plugins" / "paseo-toolkit" / "skills" / "demo" / "SKILL.md"
    skill_cache.write_bytes(skill_cache.read_bytes() + b"x")
    byte_ok, byte_notes = assess_listed_plugins(
        cmp_src, "claude", ["paseo-toolkit"], matching, {"paseo-toolkit": "0.2.0"}, "sky-agent-plugins"
    )
    check(byte_ok is False and any("바이트가 다른" in n for n in byte_notes), "1바이트 차이 실패")
    check(
        _exit("loop", {"errors": [], "appliedAny": True, "applyOk": False, "needsApproval": False}) == EXIT_ERROR,
        "설치본 불일치는 loop --yes 로 통과하지 않음",
    )
    skill_cache.write_bytes(b"skill-body")
    extra_cache = cmp_cache / "plugins" / "paseo-toolkit" / "skills" / "demo" / "extra.md"
    extra_cache.write_bytes(b"only-in-cache")
    register_deletable(extra_cache)
    extra_ok, extra_notes = assess_listed_plugins(
        cmp_src, "claude", ["paseo-toolkit"], matching, {"paseo-toolkit": "0.2.0"}, "sky-agent-plugins"
    )
    check(extra_ok is False and any("캐시에만" in n for n in extra_notes), "캐시 전용 파일 실패")
    extra_cache.unlink()
    stale_dir = cmp_cache / "plugins" / "paseo-toolkit" / "skills" / "old"
    stale_dir.mkdir()
    stale_walk = stale_dir / "old.md"
    stale_walk.write_bytes(b"old")
    register_deletable(stale_walk)
    register_deletable(stale_dir)
    orig_scandir = os.scandir
    def fake_scandir(path: Any) -> Any:
        if os.path.normcase(os.path.normpath(str(path))) == os.path.normcase(os.path.normpath(str(stale_dir))):
            raise PermissionError("denied")
        return orig_scandir(path)
    os.scandir = fake_scandir
    try:
        walk_ok, walk_notes = assess_listed_plugins(
            cmp_src, "claude", ["paseo-toolkit"], matching, {"paseo-toolkit": "0.2.0"}, "sky-agent-plugins"
        )
    finally:
        os.scandir = orig_scandir
    check(walk_ok is False and any("탐색하지 못했습니다" in n for n in walk_notes), "디렉터리 열거 오류는 검증 실패")
    stale_walk.unlink()
    stale_dir.rmdir()
    stale_stat = cmp_cache / "plugins" / "paseo-toolkit" / "skills" / "demo" / "stale.md"
    stale_stat.write_bytes(b"stale")
    register_deletable(stale_stat)
    orig_is_file = Path.is_file
    def fake_is_file(self: Path) -> bool:
        if os.path.normcase(os.path.normpath(str(self))) == os.path.normcase(os.path.normpath(str(stale_stat))):
            raise PermissionError("denied")
        return orig_is_file(self)
    Path.is_file = fake_is_file
    try:
        stat_ok, stat_notes = assess_listed_plugins(
            cmp_src, "claude", ["paseo-toolkit"], matching, {"paseo-toolkit": "0.2.0"}, "sky-agent-plugins"
        )
    finally:
        Path.is_file = orig_is_file
    check(stat_ok is False and any("탐색하지 못했습니다" in n for n in stat_notes), "파일 상태 조회 오류는 검증 실패")
    stale_stat.unlink()
    cache2 = tmp_snap_dir / "cmp-cache-2"
    _write_plugin_tree(cache2)
    extra2 = cache2 / "plugins" / "paseo-toolkit" / "skills" / "demo" / "stale.md"
    extra2.write_bytes(b"stale")
    register_deletable(extra2)
    dual = parse_plugins("claude", [
        {
            "id": "paseo-toolkit@sky-agent-plugins", "version": "0.2.0",
            "installPath": str(cmp_cache / "plugins" / "paseo-toolkit"),
        },
        {
            "id": "paseo-toolkit@sky-agent-plugins", "version": "0.2.0",
            "installPath": str(cache2 / "plugins" / "paseo-toolkit"),
        },
    ])
    dual_ok, dual_notes = assess_listed_plugins(
        cmp_src, "claude", ["paseo-toolkit"], dual, {"paseo-toolkit": "0.2.0"}, "sky-agent-plugins"
    )
    check(dual_ok is False and any("캐시에만" in n for n in dual_notes), "복수 설치 두 번째 불일치")
    script_cache = cmp_cache / "plugins" / "paseo-toolkit" / "scripts" / "shared.py"
    script_cache.write_bytes(b"print(2)\n")
    script_ok, script_notes = assess_listed_plugins(
        cmp_src, "claude", ["paseo-toolkit"], matching, {"paseo-toolkit": "0.2.0"}, "sky-agent-plugins"
    )
    check(script_ok is False and any("scripts/shared.py" in n for n in script_notes), "공용 스크립트 바이트 차이")
    script_cache.write_bytes(b"print(1)\n")
    manifest_cache = cmp_cache / "plugins" / "paseo-toolkit" / ".claude-plugin" / "plugin.json"
    orig_manifest = manifest_cache.read_bytes()
    manifest_cache.write_bytes(orig_manifest + b"\n")
    man_ok, man_notes = assess_listed_plugins(
        cmp_src, "claude", ["paseo-toolkit"], matching, {"paseo-toolkit": "0.2.0"}, "sky-agent-plugins"
    )
    check(man_ok is False and any(".claude-plugin/plugin.json" in n for n in man_notes), "매니페스트 바이트 차이")
    manifest_cache.write_bytes(orig_manifest)
    cache_bad, notes = assess_listed_plugins(
        fake_root, "claude", ["paseo-toolkit"], claude_plugins, {"paseo-toolkit": "0.3.0"}, "sky-agent-plugins"
    )
    check(cache_bad is False and any("0.3.0" in n for n in notes), "claude 버전 불일치")
    no_path = parse_plugins("claude", [{"id": "paseo-toolkit@sky-agent-plugins", "version": "0.2.0"}])
    no_path_ok, no_path_notes = assess_listed_plugins(
        fake_root, "claude", ["paseo-toolkit"], no_path, {"paseo-toolkit": "0.2.0"}, "sky-agent-plugins"
    )
    check(no_path_ok is False and any("installPath" in n for n in no_path_notes), "installPath 누락 실패")
    other_market = parse_plugins("claude", [{
        "id": "paseo-toolkit@other-market", "version": "0.2.0",
        "installPath": r"X:\synth-cache\claude\plugins\paseo-toolkit",
    }])
    other_m_ok, other_m_notes = assess_listed_plugins(
        fake_root, "claude", ["paseo-toolkit"], other_market, {"paseo-toolkit": "0.2.0"}, "sky-agent-plugins"
    )
    check(other_m_ok is False and any("소속" in n for n in other_m_notes), "다른 marketplace 동일 이름 실패")
    missing_ok, missing_notes = assess_listed_plugins(
        fake_root, "claude", ["paseo-toolkit"], [], {"paseo-toolkit": "0.2.0"}, "sky-agent-plugins"
    )
    check(missing_ok is False and any("없음" in n for n in missing_notes), "캐시 부재 실패")
    other = parse_plugins("codex", {"installed": [{"pluginId": "paseo-toolkit@sky-agent-plugins", "name": "paseo-toolkit", "marketplaceName": "sky-agent-plugins", "source": {"source": "local", "path": r"X:\original"}}], "available": []})
    other_ok, other_notes = assess_listed_plugins(fake_root, "codex", ["paseo-toolkit"], other, {}, "sky-agent-plugins")
    check(other_ok is False and any("워크트리" in n for n in other_notes), "다른 경로 실패")
    here = parse_plugins("codex", {"installed": [{"pluginId": "paseo-toolkit@sky-agent-plugins", "name": "paseo-toolkit", "marketplaceName": "sky-agent-plugins", "source": {"source": "local", "path": str(fake_root / "plugins" / "paseo-toolkit")}}], "available": []})
    here_ok, here_notes = assess_listed_plugins(fake_root, "codex", ["paseo-toolkit"], here, {}, "sky-agent-plugins")
    check(here_ok is False and any("대조 불가" in n for n in here_notes), "codex source.path 만 있으면 대조 불가")
    check(assess_listed_plugins(Path(normalize_path_text(r"C:\foo")), "codex", ["paseo-toolkit"], parse_plugins("codex", {"installed": [{"pluginId": "paseo-toolkit@sky-agent-plugins", "name": "paseo-toolkit", "marketplaceName": "sky-agent-plugins", "source": {"source": "local", "path": r"C:\foobar"}}], "available": []}), {}, "sky-agent-plugins")[0] is False, "접두 경로")
    nested_root = Path(normalize_path_text(r"X:\synth-repo"))
    nested_ok, nested_notes = assess_listed_plugins(nested_root, "codex", ["codex-skill-creator"], parse_plugins("codex", {"installed": [{"pluginId": "codex-skill-creator@sky-agent-plugins", "name": "codex-skill-creator", "marketplaceName": "sky-agent-plugins", "source": {"source": "local", "path": r"X:\synth-repo\plugins\codex-skill-creator"}}], "available": []}), {}, "sky-agent-plugins")
    check(nested_ok is False and any("대조 불가" in n for n in nested_notes), "plugins\\name 은 워크트리 하위지만 대조 불가")
    check(not any("워크트리 경로에서 오지" in n for n in nested_notes), "plugins\\name 을 워크트리 밖으로 오판하지 않음")

    err_plan = plan_register(fake_root, _snap(errors=["marketplace list JSON 파싱 실패"]))
    check(err_plan["action"] != "add" and err_plan.get("commands") == [], "파싱 오류 add 금지")
    check(_exit("check", {"errors": ["claude: x"], "appliedAny": False, "needsApproval": False}) == EXIT_ERROR, "check 조회 오류")
    check(_exit("loop", {"errors": [], "appliedAny": False, "needsApproval": True}) == EXIT_NEEDS_APPROVAL, "승인 게이트")

    def _is_mutation(args: list[str]) -> bool:
        head2, head3 = tuple(args[:2]), tuple(args[:3])
        return head2 in {("plugin", "install"), ("plugin", "uninstall"), ("plugin", "add"), ("plugin", "update"), ("plugin", "remove")} or head3 in {
            ("plugin", "marketplace", "add"),
            ("plugin", "marketplace", "remove"),
            ("plugin", "marketplace", "update"),
        }

    dry_cmds: list[tuple[str, list[str]]] = []
    saved_run, saved_collect, saved_root = module.run_cli, module.collect_agent, module.git_root
    _PROCESS_CALLS.clear()
    try:
        module.git_root = lambda: fake_root
        module.collect_agent = lambda root, agent: _snap(agent)
        module.run_cli = lambda name, args, timeout=TIMEOUT_READ: dry_cmds.append((name, list(args))) or _ok_run(
            name, args, "[]" if name == "claude" else '{"installed": [], "available": []}' if args[:2] == ["plugin", "list"] else (
                '{"ok": true}' if args[:2] == ["plugin", "validate"] else ('[]' if name == "claude" else '{"marketplaces": []}')
            ),
        )
        execute(argparse.Namespace(command="loop", yes=False, agent="both", plugin=None, json=False))
    finally:
        module.run_cli, module.collect_agent, module.git_root = saved_run, saved_collect, saved_root
    check(not any(_is_mutation(a) for _, a in dry_cmds), "무승인 loop 는 mutation 0")
    check(not any(_is_mutation(a[a.index("plugin"):] if "plugin" in a else a) for a in _PROCESS_CALLS), "choke point mutation 0")

    saved_run = module.run_cli
    bad_json_plan = [_step("validate", "validate-plugin", commands=[["plugin", "validate", str(fake_root), "--json"]])]
    try:
        module.run_cli = lambda name, args, timeout=TIMEOUT_READ: _ok_run(name, args, "not-json")
        bad_json_results = run_validate_steps(fake_root, "claude", bad_json_plan, snap_same)
    finally:
        module.run_cli = saved_run
    check(any(not item.get("ok") for item in bad_json_results), "validate 비JSON 은 실패")

    repo = None
    for candidate in Path(__file__).resolve().parents:
        if (candidate / ".claude" / "skills" / "plugin-dev-loop").is_dir() and (candidate / ".agents" / "skills" / "plugin-dev-loop").is_dir():
            repo = candidate
            break
    check(repo is not None, "저장소 루트")
    if repo is not None:
        skill_a = repo / ".claude" / "skills" / "plugin-dev-loop" / "SKILL.md"
        skill_b = repo / ".agents" / "skills" / "plugin-dev-loop" / "SKILL.md"
        py_a = repo / ".claude" / "skills" / "plugin-dev-loop" / "scripts" / "plugin_dev_loop.py"
        py_b = repo / ".agents" / "skills" / "plugin-dev-loop" / "scripts" / "plugin_dev_loop.py"
        check(skill_a.is_file() and skill_b.is_file() and skill_a.read_bytes() == skill_b.read_bytes(), "SKILL.md 동일")
        skill_body = skill_a.read_text(encoding="utf-8")
        check("| 의도 | 명령 |" not in skill_body, "SKILL 명령표 없음")
        check("자동으로 갈린다" in skill_body and "지정할 것은 없다" in skill_body, "SKILL 자동 유도")
        check("직속 하위" in skill_body, "SKILL --env 직속 하위")
        check("특별한 위치를 쓰고 싶을 때의 선택지" not in skill_body, "SKILL 옛 --env 문구 제거")
        check("비대화형" in skill_body, "SKILL 비대화형 실행 경로")
        check("approval_policy=never" in skill_body, "SKILL Codex 비대화형 승인")
        check("junction" in skill_body and "--yes" in skill_body, "SKILL junction 거부")
        check(py_a.is_file() and py_b.is_file() and py_a.read_bytes() == py_b.read_bytes(), "스크립트 동일")
        saved_resolve, saved_run = module.resolve_cli, module.run_cli
        try:
            module.resolve_cli = lambda name: [name]
            module.run_cli = lambda name, args, timeout=TIMEOUT_READ: _ok_run(name, args, '{"schema_v2": []}')
            schema_snap = collect_agent(repo, "codex")
        finally:
            module.resolve_cli, module.run_cli = saved_resolve, saved_run
        check(bool(schema_snap.get("errors")) and schema_snap.get("marketplace") is None, "알 수 없는 스키마 오류")
        check(schema_snap.get("declaredVersions", {}).get("codex-skill-creator") == "1.0.0", "선언 버전")
        check(plan_register(repo, schema_snap).get("action") != "add", "스키마 실패 add 금지")

        saved_resolve, saved_run, saved_root = module.resolve_cli, module.run_cli, module.git_root
        try:
            module.git_root = lambda: repo
            module.resolve_cli = lambda name: None
            module.run_cli = lambda name, args, timeout=TIMEOUT_READ: (_ for _ in ()).throw(
                AssertionError("CLI 부재 restore 는 run_cli 를 호출하면 안 됩니다")
            )
            delete_snapshot()
            save_snapshot({
                "worktree": str(repo),
                "agents": {
                    "codex": {
                        "known": True, "registered": True, "marketplaceName": "sky-agent-plugins",
                        "path": r"X:\original", "plugins": [],
                    }
                },
            })
            missing_cli_doc = execute(argparse.Namespace(
                command="restore", yes=True, agent="codex", plugin=None, json=False, force_drift=False,
            ))
        finally:
            module.resolve_cli, module.run_cli, module.git_root = saved_resolve, saved_run, saved_root
        check(_exit("restore", missing_cli_doc, yes=True) == EXIT_ERROR, "CLI 없으면 restore 실패")
        check(missing_cli_doc.get("snapshotCompleted") is not True, "CLI 없으면 스냅샷 미완료")
        check(missing_cli_doc.get("applyOk") is False, "CLI 없으면 applyOk False")
        missing_cli_actions = [
            step.get("action")
            for step in ((missing_cli_doc.get("plans") or {}).get("codex") or {}).get("restore") or []
        ]
        check("refuse" in missing_cli_actions, "CLI 없으면 restore refuse")
        check("add" not in missing_cli_actions, "CLI 없으면 restore 가 미등록 add 로 착각하지 않음")
        check(
            any("확인하지" in err or "CLI" in err for err in missing_cli_doc.get("errors") or []),
            "CLI 없으면 되돌리지 못한 이유를 보고",
        )

    captured = capture_snapshot(fake_root, {
        "codex": _snap("codex", marketplace={"name": "sky-agent-plugins", "path": r"X:\original"}, plugins=[{
            "name": "codex-skill-creator", "version": "1.0.0", "marketplace": "sky-agent-plugins",
        }]),
        "claude": _snap(),
    })
    save_snapshot(captured)
    first = json.loads(snapshot_path().read_text(encoding="utf-8"))
    existing = load_snapshot()
    check(existing is not None and existing.get("worktree") == first.get("worktree"), "스냅샷 로드")
    if existing is not None:
        check((existing.get("agents") or {}).get("codex", {}).get("path") == r"X:\original", "재실행이 최초 스냅샷을 유지")
    save_snapshot(captured)
    check((load_snapshot() or {}).get("agents", {}).get("codex", {}).get("path") == r"X:\original", "명시적 비덮어쓰기 검증용 원본 유지")
    module = sys.modules[__name__]
    saved_load = module.load_snapshot
    try:
        module.load_snapshot = lambda: existing
        second_loop = {
            "repoRoot": str(fake_root), "command": "loop", "agents": ["codex"],
            "snapshots": {"codex": _snap("codex", marketplace={"name": "sky-agent-plugins", "path": str(fake_root)}, pointsAtWorktree=True)},
            "plans": {"codex": {"register": plan_register(fake_root, _snap("codex", marketplace={"name": "sky-agent-plugins", "path": str(fake_root)}, pointsAtWorktree=True)), "install": [], "validate": [], "restore": []}},
            "needsApproval": False, "appliedAny": False, "applied": {}, "validated": {},
            "errors": [], "blocked": {"codex": []}, "yes": True,
        }
        saved_run, saved_collect = module.run_cli, module.collect_agent
        try:
            module.run_cli = lambda name, args, timeout=TIMEOUT_READ: _ok_run(name, args)
            module.collect_agent = lambda root, agent: _snap(agent, marketplace={"name": "sky-agent-plugins", "path": str(root)}, pointsAtWorktree=True)
            run_phases(argparse.Namespace(command="loop", yes=True, plugin=None), second_loop)
        finally:
            module.run_cli, module.collect_agent = saved_run, saved_collect
    finally:
        module.load_snapshot = saved_load
    check((load_snapshot() or {}).get("agents", {}).get("codex", {}).get("path") == r"X:\original", "loop 재실행이 스냅샷을 덮어쓰지 않음")
    check(second_loop.get("snapshotKept") is True, "기존 스냅샷 kept")

    rest_cmds: list[tuple[str, list[str]]] = []
    saved_now = load_snapshot() or {}
    rest_current = {
        "codex": _snap("codex", marketplace={"name": "sky-agent-plugins", "path": str(fake_root)}, pointsAtWorktree=True),
        "claude": _snap(marketplace={"name": "sky-agent-plugins", "path": str(fake_root)}, pointsAtWorktree=True),
    }
    rest_doc = {
        "repoRoot": str(fake_root), "command": "restore", "agents": ["claude", "codex"],
        "snapshots": rest_current,
        "plans": {
            agent: {
                "register": None, "install": [], "validate": [],
                "restore": plan_restore_agent(fake_root, agent, rest_current[agent], (saved_now.get("agents") or {}).get(agent) or {}),
            }
            for agent in ("claude", "codex")
        },
        "needsApproval": True, "appliedAny": False, "applied": {}, "validated": {},
        "errors": [], "blocked": {"claude": [], "codex": []}, "yes": True, "savedSnapshot": saved_now,
    }
    saved_run, saved_collect = module.run_cli, module.collect_agent
    try:
        module.run_cli = lambda name, args, timeout=TIMEOUT_READ: rest_cmds.append((name, list(args))) or _ok_run(name, args)
        def _match_collect(root: Path, agent: str) -> dict[str, Any]:
            saved_a = (saved_now.get("agents") or {}).get(agent) or {}
            if saved_a.get("known") is not True or not saved_a.get("registered"):
                return _snap(agent)
            saved_dir = saved_a.get("path") or r"X:\original"
            plugins = []
            for item in saved_a.get("plugins") or []:
                plugin = {**item, "selector": f"{item.get('name')}@{item.get('marketplace')}"}
                if not plugin.get("path"):
                    plugin["path"] = str(Path(saved_dir) / "plugins" / item["name"])
                plugins.append(plugin)
            return _snap(
                agent,
                marketplace={"name": saved_a.get("marketplaceName"), "path": saved_a.get("path")},
                plugins=plugins,
            )
        module.collect_agent = _match_collect
        run_phases(argparse.Namespace(command="restore", yes=True, plugin=None), rest_doc)
    finally:
        module.run_cli, module.collect_agent = saved_run, saved_collect
    check(rest_doc.get("snapshotCompleted") is True, "restore 성공 시 스냅샷 완료 표시")
    check(snapshot_path().is_file(), "성공 restore 후 스냅샷 파일 유지")
    rest_raw = json.loads(snapshot_path().read_text(encoding="utf-8"))
    check(rest_raw.get("completed") is True, "성공 restore 후 completed 필드")
    check(load_snapshot() is None, "성공 restore 후 활성 스냅샷 없음")

    save_snapshot(captured)
    fail_rest = {
        "repoRoot": str(fake_root), "command": "restore", "agents": ["codex"],
        "snapshots": {"codex": _snap("codex", marketplace={"name": "sky-agent-plugins", "path": str(fake_root)})},
        "plans": {"codex": {"register": None, "install": [], "validate": [], "restore": [_step(
            "restore", "add", needsApproval=True, summary="fail",
            commands=[["plugin", "marketplace", "add", r"X:\original"]],
        )]}},
        "needsApproval": True, "appliedAny": False, "applied": {}, "validated": {},
        "errors": [], "blocked": {"codex": []}, "yes": True, "savedSnapshot": load_snapshot(),
    }
    saved_run = module.run_cli
    try:
        module.run_cli = lambda name, args, timeout=TIMEOUT_READ: _bad_run(name, args, "restore failed")
        run_phases(argparse.Namespace(command="restore", yes=True, plugin=None), fail_rest)
    finally:
        module.run_cli = saved_run
    check(fail_rest.get("snapshotCompleted") is not True, "부분 실패 시 스냅샷 유지")
    check(load_snapshot() is not None, "부분 실패 후 파일 남음")

    delete_snapshot()
    no_snap_doc = {
        "errors": ["스냅샷이 없습니다. 추측해서 되돌리지 않습니다."],
        "appliedAny": False, "needsApproval": False,
        "blocked": {"codex": ["스냅샷이 없습니다. 추측해서 되돌리지 않습니다."]},
        "plans": {"codex": {"restore": []}}, "agents": ["codex"],
    }
    check(_exit("restore", no_snap_doc) == EXIT_ERROR, "스냅샷 없이 restore 거부")

    save_snapshot(captured)
    dry_restore_cmds: list[tuple[str, list[str]]] = []
    _PROCESS_CALLS.clear()
    saved_run, saved_collect, saved_root = module.run_cli, module.collect_agent, module.git_root
    try:
        module.git_root = lambda: fake_root
        module.collect_agent = lambda root, agent: _snap(agent, marketplace={"name": "sky-agent-plugins", "path": str(root)}, pointsAtWorktree=True)
        module.run_cli = lambda name, args, timeout=TIMEOUT_READ: dry_restore_cmds.append((name, list(args))) or _ok_run(name, args)
        execute(argparse.Namespace(command="restore", yes=False, agent="both", plugin=None, json=False))
    finally:
        module.run_cli, module.collect_agent, module.git_root = saved_run, saved_collect, saved_root
    check(not any(_is_mutation(a) for _, a in dry_restore_cmds), "restore --yes 없이 mutation 0")
    check(load_snapshot() is not None, "무승인 restore 가 스냅샷을 지우지 않음")

    check(plugin_remove_cmd("codex", "paseo-toolkit", "sky-agent-plugins") == ["plugin", "remove", "paseo-toolkit@sky-agent-plugins"], "codex plugin remove selector")
    check("-y" not in plugin_remove_cmd("codex", "paseo-toolkit", "sky-agent-plugins"), "codex remove 에 -y 없음")
    check(
        plugin_remove_cmd("claude", "paseo-toolkit", "sky-agent-plugins")
        == ["plugin", "uninstall", "paseo-toolkit@sky-agent-plugins", "-y"],
        "claude uninstall name@marketplace",
    )
    check(plugin_add_cmd("codex", "paseo-toolkit", "sky-agent-plugins") == ["plugin", "add", "paseo-toolkit@sky-agent-plugins"], "codex add")
    check(plugin_add_cmd("claude", "paseo-toolkit", "sky-agent-plugins") == ["plugin", "install", "paseo-toolkit@sky-agent-plugins", "-y"], "claude install")
    check(shell_unsafe_name_reason("paseo-toolkit") is None, "kebab-case 플러그인 통과")
    check(shell_unsafe_name_reason("sky-agent-plugins") is None, "kebab-case 마켓 통과")
    check(shell_unsafe_name_reason("codex-skill-creator") is None, "kebab-case 하이픈 통과")
    check(shell_unsafe_name_reason("p&calc&rem") is not None, "ampersand 거부")
    check(shell_unsafe_name_reason("a|b") is not None, "pipe 거부")
    meta_add_raised = False
    try:
        plugin_add_cmd("codex", "p&calc&rem", "sky-agent-plugins")
    except ValueError:
        meta_add_raised = True
    check(meta_add_raised, "메타문자 add 거부")
    expect_error(
        lambda: parse_marketplaces("codex", {"marketplaces": [{"name": "p&x", "root": r"D:\x"}]}),
        "메타문자 마켓 파싱 거부",
    )
    check(
        parse_marketplaces("codex", {"marketplaces": [{"name": "sky-agent-plugins", "root": r"D:\x"}]})[0]["name"]
        == "sky-agent-plugins",
        "kebab-case 마켓 파싱 통과",
    )

    delete_snapshot()
    save_snapshot({
        "worktree": str(fake_root),
        "agents": {
            "codex": {
                "known": True, "registered": True, "marketplaceName": "old-market",
                "path": r"X:\original", "plugins": [],
            }
        },
    })
    rename_cmds: list[tuple[str, list[str]]] = []
    saved_run, saved_root, saved_resolve, saved_load, saved_collect = (
        module.run_cli, module.git_root, module.resolve_cli, module.load_declared, module.collect_agent,
    )
    try:
        module.collect_agent = real_collect_agent
        module.git_root = lambda: fake_root
        module.resolve_cli = lambda name: [name]
        module.load_declared = lambda root, agent: ("new-market", ["paseo-toolkit"], {"paseo-toolkit": "0.2.0"})

        def _rename_run(name: str, args: list[str], timeout: int = TIMEOUT_READ) -> dict[str, Any]:
            rename_cmds.append((name, list(args)))
            if args[:3] == ["plugin", "marketplace", "list"]:
                return _ok_run(name, args, json.dumps({
                    "marketplaces": [{"name": "old-market", "root": str(fake_root)}],
                }))
            if args[:2] == ["plugin", "list"]:
                return _ok_run(name, args, '{"installed": [], "available": []}')
            return _ok_run(name, args)

        module.run_cli = _rename_run
        rename_doc = execute(argparse.Namespace(
            command="restore", yes=True, agent="codex", plugin=None, json=False, force_drift=False,
        ))
        rename_reg = execute(argparse.Namespace(
            command="register", yes=False, agent="codex", plugin=None, json=False, force_drift=False,
        ))
    finally:
        module.run_cli = saved_run
        module.git_root = saved_root
        module.resolve_cli = saved_resolve
        module.load_declared = saved_load
        module.collect_agent = saved_collect
    restore_plan_cmds = [
        cmd
        for step in ((rename_doc.get("plans") or {}).get("codex") or {}).get("restore") or []
        for cmd in (step.get("commands") or [])
    ]
    check(
        any(cmd[:4] == ["plugin", "marketplace", "remove", "old-market"] for cmd in restore_plan_cmds)
        or any(a[:4] == ["plugin", "marketplace", "remove", "old-market"] for _, a in rename_cmds),
        "restore 는 스냅샷 이름으로 remove",
    )
    check(
        not any(a[:4] == ["plugin", "marketplace", "remove", "new-market"] for _, a in rename_cmds),
        "restore 는 현재 매니페스트 이름으로 remove 하지 않음",
    )
    check((rename_doc.get("plans") or {}).get("codex", {}).get("restore"), "restore 계획 존재")
    check(
        (rename_reg.get("plans") or {}).get("codex", {}).get("register", {}).get("action") == "add",
        "register 는 현재 이름 기준",
    )

    order_cur = _snap(
        "claude",
        marketplace={"name": "sky-agent-plugins", "path": str(fake_root)},
        pointsAtWorktree=True,
        plugins=[{"name": "paseo-toolkit", "version": "0.2.0", "marketplace": "sky-agent-plugins"}],
    )
    order_saved = {
        "known": True, "registered": True, "marketplaceName": "sky-agent-plugins",
        "path": r"X:\original",
        "plugins": [{"name": "paseo-toolkit", "version": "0.1.0", "marketplace": "sky-agent-plugins"}],
    }
    order_steps = plan_restore_agent(fake_root, "claude", order_cur, order_saved)
    order_actions = [step["action"] for step in order_steps]
    check("remove-plugin" in order_actions and "retarget" in order_actions, "restore 에 플러그인 제거와 retarget")
    check(order_actions.index("remove-plugin") < order_actions.index("retarget"), "플러그인 제거가 마켓플레이스보다 앞")
    check(
        any(cmd[:2] == ["plugin", "uninstall"] and "@sky-agent-plugins" in cmd[2] for step in order_steps for cmd in step.get("commands") or []),
        "claude restore uninstall 은 name@marketplace",
    )
    order_codex = plan_restore_agent(fake_root, "codex", {**order_cur, "agent": "codex"}, order_saved)
    check(
        any(cmd == ["plugin", "remove", "paseo-toolkit@sky-agent-plugins"] for step in order_codex for cmd in step.get("commands") or []),
        "codex restore 는 plugin remove selector",
    )
    check(
        not any(cmd[:2] == ["plugin", "uninstall"] for step in order_codex for cmd in step.get("commands") or []),
        "codex restore 에 uninstall 없음",
    )

    snapshot_path().write_text("{", encoding="utf-8")
    register_deletable(snapshot_path())
    corrupt_raised = False
    try:
        load_snapshot()
    except SnapshotCorrupt:
        corrupt_raised = True
    check(corrupt_raised, "손상 JSON 은 SnapshotCorrupt")
    saved_run, saved_collect, saved_root = module.run_cli, module.collect_agent, module.git_root
    try:
        module.git_root = lambda: fake_root
        module.collect_agent = lambda root, agent: _snap(agent)
        module.run_cli = lambda name, args, timeout=TIMEOUT_READ: _ok_run(name, args)
        corrupt_loop = execute(argparse.Namespace(command="loop", yes=True, agent="both", plugin=None, json=False, force_drift=False))
        corrupt_restore = execute(argparse.Namespace(command="restore", yes=True, agent="both", plugin=None, json=False, force_drift=False))
    finally:
        module.run_cli, module.collect_agent, module.git_root = saved_run, saved_collect, saved_root
    check(corrupt_loop.get("snapshotCorrupt") and corrupt_loop.get("snapshotWrote") is not True, "손상 스냅샷은 loop 가 덮어쓰지 않음")
    check(any("손상" in err for err in corrupt_loop.get("errors") or []), "loop 가 손상을 오류로 보고")
    check(any("손상" in err for err in corrupt_restore.get("errors") or []), "restore 가 손상을 오류로 보고")
    check(snapshot_path().read_text(encoding="utf-8") == "{", "손상 파일을 새 원본으로 바꾸지 않음")

    empty_steps = plan_restore_agent(
        fake_root, "codex",
        _snap("codex", marketplace={"name": "sky-agent-plugins", "path": str(fake_root)}, pointsAtWorktree=True,
              plugins=[{"name": "paseo-toolkit", "marketplace": "sky-agent-plugins"}]),
        {},
    )
    check(all(step.get("action") == "skip" for step in empty_steps), "{} 스냅샷은 제거하지 않음")
    check(not any(step.get("commands") for step in empty_steps), "{} 는 mutation 없음")
    unk_steps = plan_restore_agent(fake_root, "claude", order_cur, {"known": False})
    check(all(step.get("action") == "skip" for step in unk_steps), "알 수 없음은 건드리지 않음")
    missing_agent_steps = plan_restore_agent(fake_root, "codex", {**order_cur, "agent": "codex"}, None)
    check(all(step.get("action") == "skip" for step in missing_agent_steps), "누락 에이전트는 건드리지 않음")

    other_root = Path(normalize_path_text(r"D:\other-worktree"))
    drift = snapshot_drift(
        fake_root,
        {"codex": _snap("codex", marketplace={"name": "sky-agent-plugins", "path": r"X:\third"})},
        {"worktree": str(other_root), "agents": {"codex": {"known": True, "path": r"X:\original", "registered": True, "plugins": []}}},
    )
    check(drift is not None and "원본도 출처 워크트리도 아닙니다" in drift, "스냅샷 불일치 감지")
    save_snapshot({
        "worktree": str(other_root),
        "agents": {
            "codex": {
                "known": True, "registered": True, "marketplaceName": "sky-agent-plugins",
                "path": r"X:\original", "plugins": [],
            }
        },
    })
    saved_run, saved_collect, saved_root = module.run_cli, module.collect_agent, module.git_root
    try:
        module.git_root = lambda: fake_root
        module.collect_agent = lambda root, agent: _snap(agent, marketplace={"name": "sky-agent-plugins", "path": r"X:\third"})
        module.run_cli = lambda name, args, timeout=TIMEOUT_READ: _ok_run(name, args)
        blocked_drift = execute(argparse.Namespace(command="restore", yes=True, agent="codex", plugin=None, json=False, force_drift=False))
        forced_drift = execute(argparse.Namespace(command="restore", yes=True, agent="codex", plugin=None, json=False, force_drift=True))
    finally:
        module.run_cli, module.collect_agent, module.git_root = saved_run, saved_collect, saved_root
    check(any("force-drift" in err for err in blocked_drift.get("errors") or []), "drift 기본 차단")
    check(not blocked_drift.get("appliedAny"), "drift 차단 시 미적용")
    check(forced_drift.get("snapshotDrift"), "강행 시 drift 기록은 남김")

    save_snapshot(captured)
    verify_fail = {
        "repoRoot": str(fake_root), "command": "restore", "agents": ["codex"],
        "snapshots": {"codex": _snap("codex", marketplace={"name": "sky-agent-plugins", "path": str(fake_root)})},
        "plans": {"codex": {"register": None, "install": [], "validate": [], "restore": [_step(
            "restore", "skip", summary="noop",
        )]}},
        "needsApproval": False, "appliedAny": False, "applied": {}, "validated": {},
        "errors": [], "blocked": {"codex": []}, "yes": True, "savedSnapshot": load_snapshot(),
    }
    saved_run, saved_collect = module.run_cli, module.collect_agent
    try:
        module.run_cli = lambda name, args, timeout=TIMEOUT_READ: _ok_run(name, args)
        module.collect_agent = lambda root, agent: _snap(agent, marketplace={"name": "sky-agent-plugins", "path": str(fake_root)}, pointsAtWorktree=True)
        run_phases(argparse.Namespace(command="restore", yes=True, plugin=None), verify_fail)
    finally:
        module.run_cli, module.collect_agent = saved_run, saved_collect
    check(verify_fail.get("snapshotCompleted") is not True, "재조회 불일치 시 스냅샷 유지")
    check(load_snapshot() is not None, "재조회 실패 후 파일 남음")

    unparseable = plan_restore_agent(
        fake_root, "codex",
        _snap("codex", marketplace={"name": "sky-agent-plugins", "path": "https://example.com/repo.git"}),
        {"known": True, "registered": True, "marketplaceName": "sky-agent-plugins", "path": r"X:\original", "plugins": []},
    )
    check(any(_fatal_step(step) and step.get("action") == "refuse" for step in unparseable), "restore 도 복구 불가 retarget 거부")

    check(
        not any("--marketplace" in cmd for cmd in plan_validate(fake_root, {**snap_same, "agent": "codex"}, ["paseo-toolkit"])[0].get("commands") or []),
        "codex plugin list 에 --marketplace 없음",
    )
    mixed = capture_snapshot(fake_root, {
        "claude": _snap(
            plugins=[
                {"name": "paseo-toolkit", "version": "0.2.0", "marketplace": "sky-agent-plugins"},
                {"name": "paseo-toolkit", "version": "9.9.9", "marketplace": "other-market"},
            ]
        ),
    })
    captured_names = [(p.get("name"), p.get("marketplace"), p.get("version")) for p in mixed["agents"]["claude"]["plugins"]]
    check(("paseo-toolkit", "sky-agent-plugins", "0.2.0") in captured_names, "소속 마켓만 캡처")
    check(("paseo-toolkit", "other-market", "9.9.9") not in captured_names, "다른 마켓 동명 플러그인 미캡처")
    other_aff = plan_restore_agent(
        fake_root, "codex",
        _snap("codex", marketplace={"name": "sky-agent-plugins", "path": r"X:\original"}),
        {
            "known": True, "registered": True, "marketplaceName": "sky-agent-plugins", "path": r"X:\original",
            "plugins": [{"name": "extra-tool", "version": "1.0.0", "marketplace": "other-market"}],
        },
    )
    check(
        any(cmd == ["plugin", "add", "extra-tool@other-market"] for step in other_aff for cmd in step.get("commands") or []),
        "복원은 저장된 소속 마켓에 add",
    )

    add_fail_cmds: list[list[str]] = []
    add_step = _step(
        "restore", "add-plugin", needsApproval=True,
        commands=[plugin_add_cmd("codex", "codex-skill-creator", "sky-agent-plugins")],
        recoverCommand=plugin_add_cmd("codex", "codex-skill-creator", "sky-agent-plugins"),
    )
    saved_run = module.run_cli
    try:
        def _fake_add_fail_then_ok(name: str, args: list[str], timeout: int = TIMEOUT_READ) -> dict[str, Any]:
            add_fail_cmds.append(list(args))
            if args[:2] == ["plugin", "add"] and sum(1 for item in add_fail_cmds if item[:2] == ["plugin", "add"]) == 1:
                return _bad_run(name, args, "add failed")
            return _ok_run(name, args)
        module.run_cli = _fake_add_fail_then_ok
        add_recovered = apply_steps("codex", [add_step])
    finally:
        module.run_cli = saved_run
    check(sum(1 for item in add_fail_cmds if item[:2] == ["plugin", "add"]) == 2, "add-plugin 실패 후 복구 add")
    check(add_recovered[0].get("recovered") is True, "add-plugin 복구 성공")

    err_match = restore_matches(
        {"known": True, "registered": False, "plugins": []},
        _snap("codex", errors=["plugin list 실패"]),
    )
    check(err_match is False, "재조회 오류는 일치가 아님")
    cli_miss_plan = plan_restore_agent(
        fake_root, "codex",
        _snap("codex", errors=["PATH에서 codex CLI를 찾지 못했습니다."]),
        {
            "known": True, "registered": True, "marketplaceName": "sky-agent-plugins",
            "path": r"X:\original", "plugins": [],
        },
    )
    check(any(_fatal_step(step) and step.get("action") == "refuse" for step in cli_miss_plan), "조회 실패 restore refuse")
    check(not any(step.get("action") == "add" for step in cli_miss_plan), "조회 실패는 미등록 add 가 아님")

    delete_snapshot()
    save_snapshot({
        "worktree": str(fake_root),
        "agents": {
            "claude": {
                "known": True, "registered": True, "marketplaceName": "sky-agent-plugins",
                "path": r"X:\original", "plugins": [],
            },
            "codex": {
                "known": True, "registered": True, "marketplaceName": "sky-agent-plugins",
                "path": r"X:\original", "plugins": [],
            },
        },
    })
    partial_cmds: list[tuple[str, list[str]]] = []
    saved_run, saved_collect, saved_root = module.run_cli, module.collect_agent, module.git_root
    try:
        module.git_root = lambda: fake_root
        module.collect_agent = lambda root, agent: (
            _snap("codex", cliFound=False, errors=["PATH에서 codex CLI를 찾지 못했습니다."])
            if agent == "codex"
            else _snap(agent, marketplace={"name": "sky-agent-plugins", "path": str(root)}, pointsAtWorktree=True)
        )
        module.run_cli = lambda name, args, timeout=TIMEOUT_READ: partial_cmds.append((name, list(args))) or _ok_run(name, args)
        partial_doc = execute(argparse.Namespace(
            command="restore", yes=True, agent="both", plugin=None, json=False, force_drift=True,
        ))
    finally:
        module.run_cli, module.collect_agent, module.git_root = saved_run, saved_collect, saved_root
    check(_exit("restore", partial_doc, yes=True) == EXIT_ERROR, "한쪽 CLI 없으면 restore 전체 실패")
    check(partial_doc.get("applyOk") is False, "한쪽 조회 실패면 applyOk False")
    check(partial_doc.get("snapshotCompleted") is not True, "한쪽 실패면 스냅샷 미완료")
    check(
        any(step.get("action") == "refuse" for step in ((partial_doc.get("plans") or {}).get("codex") or {}).get("restore") or []),
        "실패한 쪽 restore refuse",
    )
    check(any(n == "claude" and _is_mutation(a) for n, a in partial_cmds), "확인된 쪽은 restore 진행")
    check(not any(n == "codex" for n, a in partial_cmds), "조회 실패한 쪽은 CLI 호출 없음")
    no_path = restore_matches(
        {
            "known": True, "registered": True, "path": r"X:\original",
            "marketplaceName": "sky-agent-plugins",
            "plugins": [{"name": "paseo-toolkit", "marketplace": "sky-agent-plugins", "version": "0.2.0"}],
        },
        _snap(
            "claude",
            marketplace={"name": "sky-agent-plugins", "path": r"X:\original"},
            plugins=[{"name": "paseo-toolkit", "marketplace": "sky-agent-plugins", "version": "0.2.0"}],
        ),
    )
    check(no_path is False, "claude installPath 누락은 불일치")

    empty_agents_raised = False
    try:
        validate_snapshot_schema({"worktree": r"D:\worktree", "agents": {}})
    except SnapshotCorrupt:
        empty_agents_raised = True
    check(empty_agents_raised, "agents:{} 는 손상")
    broken_plug_raised = False
    try:
        validate_snapshot_schema({
            "worktree": r"D:\worktree",
            "agents": {"codex": {"known": True, "registered": True, "plugins": ["broken"]}},
        })
    except SnapshotCorrupt:
        broken_plug_raised = True
    check(broken_plug_raised, "plugins 문자열 배열은 손상")

    plug_drift = snapshot_drift(
        fake_root,
        {"codex": _snap(
            "codex",
            marketplace={"name": "sky-agent-plugins", "path": r"X:\original"},
            plugins=[{"name": "paseo-toolkit", "version": "9.9.9", "marketplace": "sky-agent-plugins"}],
        )},
        {
            "worktree": str(fake_root),
            "agents": {"codex": {
                "known": True, "registered": True, "marketplaceName": "sky-agent-plugins",
                "path": r"X:\original",
                "plugins": [{"name": "paseo-toolkit", "version": "1.0.0", "marketplace": "sky-agent-plugins"}],
            }},
        },
    )
    check(plug_drift is not None and "플러그인" in plug_drift, "원본 경로에서 플러그인 상태 drift")

    incomplete_saved = {
        "worktree": str(fake_root),
        "agents": {"codex": {
            "known": True, "registered": True, "marketplaceName": "sky-agent-plugins",
            "path": r"X:\original",
            "plugins": [{"name": "codex-skill-creator", "version": "1.0.0", "marketplace": "sky-agent-plugins"}],
        }},
    }
    incomplete_now = {"codex": _snap(
        "codex",
        marketplace={"name": "sky-agent-plugins", "path": r"X:\original"},
        plugins=[],
    )}
    check(snapshot_drift(fake_root, incomplete_now, incomplete_saved) is None, "원본 경로에서 스냅샷 플러그인 누락은 미완료 복원")
    manual_now = {"codex": _snap(
        "codex",
        marketplace={"name": "sky-agent-plugins", "path": str(fake_root)},
        pointsAtWorktree=True,
        declaredPlugins=["paseo-toolkit", "codex-skill-creator"],
        plugins=[{
            "name": "codex-skill-creator", "version": "1.0.0", "marketplace": "sky-agent-plugins",
            "path": str(fake_root / "plugins" / "codex-skill-creator"),
        }],
    )}
    manual_drift = snapshot_drift(fake_root, manual_now, incomplete_saved)
    check(manual_drift is not None and "스냅샷 밖" in manual_drift, "워크트리에서 선언 플러그인 수동 제거는 drift")
    wiped_now = {"codex": _snap(
        "codex",
        marketplace={"name": "sky-agent-plugins", "path": str(fake_root)},
        pointsAtWorktree=True,
        declaredPlugins=["paseo-toolkit", "codex-skill-creator"],
        plugins=[],
    )}
    check(snapshot_drift(fake_root, wiped_now, incomplete_saved) is None, "워크트리에서 스냅샷 플러그인까지 없으면 미완료 복원")

    missing_name_raised = False
    try:
        validate_snapshot_schema({
            "worktree": r"D:\worktree",
            "agents": {"codex": {"known": True, "registered": False, "plugins": []}},
        })
    except SnapshotCorrupt:
        missing_name_raised = True
    check(missing_name_raised, "known:true 에 marketplaceName 없으면 손상")

    orig_match = {
        "known": True, "registered": True, "path": r"X:\original",
        "marketplaceName": "sky-agent-plugins",
        "plugins": [{"name": "codex-skill-creator", "version": "1.0.0", "marketplace": "sky-agent-plugins"}],
    }
    check(
        restore_matches(orig_match, _snap(
            "codex",
            marketplace={"name": "sky-agent-plugins", "path": r"X:\original"},
            plugins=[{
                "name": "codex-skill-creator", "version": "1.0.0", "marketplace": "sky-agent-plugins",
                "path": str(fake_root / "plugins" / "codex-skill-creator"),
            }],
        )) is False,
        "codex source.path 워크트리면 불일치",
    )
    check(
        restore_matches(orig_match, _snap(
            "codex",
            marketplace={"name": "sky-agent-plugins", "path": r"X:\original"},
            plugins=[{
                "name": "codex-skill-creator", "version": "1.0.0", "marketplace": "sky-agent-plugins",
                "path": r"X:\original\plugins\codex-skill-creator",
            }],
        )) is True,
        "codex source.path 원본이면 일치",
    )

    both_fail_cmds: list[list[str]] = []
    saved_run = module.run_cli
    try:
        def _both_add_fail(name: str, args: list[str], timeout: int = TIMEOUT_READ) -> dict[str, Any]:
            both_fail_cmds.append(list(args))
            if args[:2] == ["plugin", "add"]:
                return _bad_run(name, args, "add failed")
            return _ok_run(name, args)
        module.run_cli = _both_add_fail
        add_double = apply_steps("codex", [add_step])
    finally:
        module.run_cli = saved_run
    check(add_double[0]["ok"] is False, "add 이중 실패")
    check(any("미완료 복원" in note for note in add_double[0].get("notes") or []), "이중 실패 안내가 미완료 복원")

    delete_snapshot()
    save_snapshot(incomplete_saved)
    incomplete_cmds: list[tuple[str, list[str]]] = []
    saved_run, saved_collect, saved_root = module.run_cli, module.collect_agent, module.git_root
    try:
        module.git_root = lambda: fake_root
        module.collect_agent = lambda root, agent: (
            _snap(
                "codex",
                marketplace={"name": "sky-agent-plugins", "path": r"X:\original"},
                plugins=[{
                    "name": "codex-skill-creator", "version": "1.0.0", "marketplace": "sky-agent-plugins",
                    "path": r"X:\original\plugins\codex-skill-creator",
                }],
            ) if agent == "codex" and any(a[:2] == ["plugin", "add"] for _, a in incomplete_cmds)
            else _snap(
                agent,
                marketplace={"name": "sky-agent-plugins", "path": r"X:\original"} if agent == "codex" else None,
                plugins=[],
            )
        )
        module.run_cli = lambda name, args, timeout=TIMEOUT_READ: incomplete_cmds.append((name, list(args))) or _ok_run(name, args)
        incomplete_run = execute(argparse.Namespace(
            command="restore", yes=True, agent="codex", plugin=None, json=False, force_drift=False,
        ))
    finally:
        module.run_cli, module.collect_agent, module.git_root = saved_run, saved_collect, saved_root
    check(not any("force-drift" in err for err in incomplete_run.get("errors") or []), "미완료 복원은 --force-drift 없이 진행")
    check(any(a == ["plugin", "add", "codex-skill-creator@sky-agent-plugins"] for _, a in incomplete_cmds), "미완료 복원이 스냅샷 플러그인을 add")
    check(incomplete_run.get("appliedAny") is True, "미완료 복원 적용")

    delete_snapshot()
    save_snapshot(incomplete_saved)
    manual_cmds: list[tuple[str, list[str]]] = []
    saved_run, saved_collect, saved_root = module.run_cli, module.collect_agent, module.git_root
    try:
        module.git_root = lambda: fake_root
        module.collect_agent = lambda root, agent: _snap(
            agent,
            marketplace={"name": "sky-agent-plugins", "path": str(fake_root)},
            pointsAtWorktree=True,
            declaredPlugins=["paseo-toolkit", "codex-skill-creator"],
            plugins=[{
                "name": "codex-skill-creator", "version": "1.0.0", "marketplace": "sky-agent-plugins",
                "path": str(fake_root / "plugins" / "codex-skill-creator"),
            }],
        )
        module.run_cli = lambda name, args, timeout=TIMEOUT_READ: manual_cmds.append((name, list(args))) or _ok_run(name, args)
        manual_run = execute(argparse.Namespace(
            command="restore", yes=True, agent="codex", plugin=None, json=False, force_drift=False,
        ))
    finally:
        module.run_cli, module.collect_agent, module.git_root = saved_run, saved_collect, saved_root
    check(any("force-drift" in err for err in manual_run.get("errors") or []), "수동 플러그인 변경은 drift 차단")
    check(not manual_run.get("appliedAny"), "수동 변경 restore 미적용")
    check(not any(_is_mutation(a) for _, a in manual_cmds), "수동 변경 restore mutation 0")

    delete_snapshot()
    path_mismatch = {
        "repoRoot": str(fake_root), "command": "restore", "agents": ["codex"],
        "snapshots": {"codex": _snap(
            "codex",
            marketplace={"name": "sky-agent-plugins", "path": r"X:\original"},
            plugins=[{
                "name": "codex-skill-creator", "version": "1.0.0", "marketplace": "sky-agent-plugins",
                "path": str(fake_root / "plugins" / "codex-skill-creator"),
            }],
        )},
        "plans": {"codex": {"register": None, "install": [], "validate": [], "restore": [_step(
            "restore", "skip", summary="noop",
        )]}},
        "needsApproval": False, "appliedAny": False, "applied": {}, "validated": {},
        "errors": [], "blocked": {"codex": []}, "yes": True, "savedSnapshot": incomplete_saved,
    }
    save_snapshot(incomplete_saved)
    saved_run, saved_collect = module.run_cli, module.collect_agent
    try:
        module.run_cli = lambda name, args, timeout=TIMEOUT_READ: _ok_run(name, args)
        module.collect_agent = lambda root, agent: _snap(
            "codex",
            marketplace={"name": "sky-agent-plugins", "path": r"X:\original"},
            plugins=[{
                "name": "codex-skill-creator", "version": "1.0.0", "marketplace": "sky-agent-plugins",
                "path": str(fake_root / "plugins" / "codex-skill-creator"),
            }],
        )
        run_phases(argparse.Namespace(command="restore", yes=True, plugin=None), path_mismatch)
    finally:
        module.run_cli, module.collect_agent = saved_run, saved_collect
    check(path_mismatch.get("snapshotCompleted") is not True, "codex source.path 불일치 시 스냅샷 유지")
    check(load_snapshot() is not None, "codex source.path 불일치 후 파일 남음")

    delete_snapshot()
    re_n = {"n": 0}
    reinspect_cmds: list[tuple[str, list[str]]] = []

    def _reinspect_collect(root: Path, agent: str) -> dict[str, Any]:
        re_n["n"] += 1
        if re_n["n"] > 2:
            return _snap(agent, errors=["재조회 실패"])
        return _snap(agent, marketplace={"name": "sky-agent-plugins", "path": r"X:\original"})

    saved_run, saved_collect, saved_root = module.run_cli, module.collect_agent, module.git_root
    try:
        module.git_root = lambda: fake_root
        module.collect_agent = _reinspect_collect
        module.run_cli = lambda name, args, timeout=TIMEOUT_READ: reinspect_cmds.append((name, list(args))) or _ok_run(name, args)
        reinspect_doc = execute(argparse.Namespace(
            command="loop", yes=True, agent="both", plugin=None, json=False, force_drift=False,
        ))
    finally:
        module.run_cli, module.collect_agent, module.git_root = saved_run, saved_collect, saved_root
    check(reinspect_doc.get("reinspectFailed") is True, "재조회 실패 플래그")
    check(any("재조회" in err for err in reinspect_doc.get("errors") or []), "재조회 실패를 오류로 보고")
    check(reinspect_doc.get("snapshotWrote") is not True, "재조회 실패 시 스냅샷 미저장")
    check(load_snapshot() is None, "재조회 실패 후 파일 없음")
    check(not any(_is_mutation(a) for _, a in reinspect_cmds), "재조회 실패 후 mutation 0")
    check(not reinspect_doc.get("appliedAny"), "재조회 실패 후 미적용")

    omit_cap = capture_snapshot(fake_root, {
        "claude": _snap(errors=["marketplace list 실패"]),
        "codex": _snap("codex", marketplace={"name": "sky-agent-plugins", "path": r"X:\original"}),
    })
    check("claude" not in (omit_cap.get("agents") or {}), "조회 실패 에이전트는 스냅샷에 없음")
    check((omit_cap.get("agents") or {}).get("codex", {}).get("known") is True, "성공한 쪽만 기록")
    check(all(entry.get("known") is True for entry in (omit_cap.get("agents") or {}).values()), "known:false 를 쓰지 않음")

    delete_snapshot()
    first_fail_cmds: list[tuple[str, list[str]]] = []
    saved_run, saved_collect, saved_root = module.run_cli, module.collect_agent, module.git_root
    try:
        module.git_root = lambda: fake_root
        module.collect_agent = lambda root, agent: _snap(agent, errors=["marketplace list 실패"])
        module.run_cli = lambda name, args, timeout=TIMEOUT_READ: first_fail_cmds.append((name, list(args))) or _ok_run(name, args)
        first_fail_doc = execute(argparse.Namespace(
            command="loop", yes=True, agent="both", plugin=None, json=False, force_drift=False,
        ))
    finally:
        module.run_cli, module.collect_agent, module.git_root = saved_run, saved_collect, saved_root
    check(first_fail_doc.get("snapshotWrote") is not True, "첫 조회 실패 시 스냅샷 미저장")
    check(load_snapshot() is None, "첫 조회 실패 후 파일 없음")
    check(not any(_is_mutation(a) for _, a in first_fail_cmds), "첫 조회 실패 후 mutation 0")
    check(not first_fail_doc.get("appliedAny"), "첫 조회 실패 후 미적용")

    delete_snapshot()
    iso_cmds: list[tuple[str, list[str]]] = []

    def _iso_fail_collect(root: Path, agent: str) -> dict[str, Any]:
        if agent == "claude":
            return _snap(agent, errors=["marketplace list 실패"])
        if any(n == "codex" and _is_mutation(a) for n, a in iso_cmds):
            return _snap(
                "codex",
                marketplace={"name": "sky-agent-plugins", "path": str(root)},
                pointsAtWorktree=True,
            )
        return _snap("codex", marketplace={"name": "sky-agent-plugins", "path": r"X:\original"})

    saved_run, saved_collect, saved_root = module.run_cli, module.collect_agent, module.git_root
    try:
        module.git_root = lambda: fake_root
        module.collect_agent = _iso_fail_collect
        module.run_cli = lambda name, args, timeout=TIMEOUT_READ: iso_cmds.append((name, list(args))) or _ok_run(name, args)
        iso_fail_doc = execute(argparse.Namespace(
            command="loop", yes=True, agent="both", plugin=None, json=False, force_drift=False,
        ))
    finally:
        module.run_cli, module.collect_agent, module.git_root = saved_run, saved_collect, saved_root
    iso_saved = load_snapshot() or {}
    iso_agents = iso_saved.get("agents") or {}
    check("claude" not in iso_agents, "실패한 쪽은 스냅샷에 없음")
    check(iso_agents.get("codex", {}).get("known") is True, "성공한 쪽은 스냅샷에 있음")
    check(iso_agents.get("codex", {}).get("path") == r"X:\original", "성공한 쪽 원본 경로 기록")
    check(not any(n == "claude" and _is_mutation(a) for n, a in iso_cmds), "실패한 쪽 mutation 없음")
    check(any(n == "codex" and _is_mutation(a) for n, a in iso_cmds), "성공한 쪽은 진행")
    check(iso_fail_doc.get("appliedAny") is True, "한쪽 실패해도 성공한 쪽 적용")

    delete_snapshot()
    save_snapshot({
        "worktree": str(fake_root),
        "agents": {
            "claude": {
                "known": True, "registered": True, "marketplaceName": "sky-agent-plugins",
                "path": r"X:\original", "plugins": [],
            },
            "codex": {"known": False},
        },
    })
    fill_cmds: list[tuple[str, list[str]]] = []

    def _fill_collect(root: Path, agent: str) -> dict[str, Any]:
        if any(n == agent and _is_mutation(a) for n, a in fill_cmds):
            return _snap(
                agent,
                marketplace={"name": "sky-agent-plugins", "path": str(root)},
                pointsAtWorktree=True,
            )
        return _snap(agent, marketplace={"name": "sky-agent-plugins", "path": r"X:\original"})

    saved_run, saved_collect, saved_root = module.run_cli, module.collect_agent, module.git_root
    try:
        module.git_root = lambda: fake_root
        module.collect_agent = _fill_collect
        module.run_cli = lambda name, args, timeout=TIMEOUT_READ: fill_cmds.append((name, list(args))) or _ok_run(name, args)
        execute(argparse.Namespace(
            command="loop", yes=True, agent="both", plugin=None, json=False, force_drift=False,
        ))
    finally:
        module.run_cli, module.collect_agent, module.git_root = saved_run, saved_collect, saved_root
    filled = load_snapshot() or {}
    filled_codex = (filled.get("agents") or {}).get("codex") or {}
    filled_claude = (filled.get("agents") or {}).get("claude") or {}
    check(filled_codex.get("known") is True, "known:false 는 성공 조회 후 원본으로 채움")
    check(filled_codex.get("path") == r"X:\original", "채운 원본 경로를 유지")
    check(filled_claude.get("path") == r"X:\original", "기존 known:true 원본을 덮어쓰지 않음")
    check(any(n == "codex" and _is_mutation(a) for n, a in fill_cmds), "원본을 채운 뒤 변경")

    delete_snapshot()
    save_snapshot({
        "worktree": str(fake_root),
        "agents": {
            "claude": {
                "known": True, "registered": True, "marketplaceName": "sky-agent-plugins",
                "path": r"X:\original", "plugins": [],
            },
            "codex": {"known": False},
        },
    })
    still_fail_cmds: list[tuple[str, list[str]]] = []

    def _still_fail_collect(root: Path, agent: str) -> dict[str, Any]:
        if agent == "codex":
            return _snap(agent, errors=["marketplace list 실패"])
        if any(n == agent and _is_mutation(a) for n, a in still_fail_cmds):
            return _snap(
                agent,
                marketplace={"name": "sky-agent-plugins", "path": str(root)},
                pointsAtWorktree=True,
            )
        return _snap(agent, marketplace={"name": "sky-agent-plugins", "path": r"X:\original"})

    saved_run, saved_collect, saved_root = module.run_cli, module.collect_agent, module.git_root
    try:
        module.git_root = lambda: fake_root
        module.collect_agent = _still_fail_collect
        module.run_cli = lambda name, args, timeout=TIMEOUT_READ: still_fail_cmds.append((name, list(args))) or _ok_run(name, args)
        execute(argparse.Namespace(
            command="loop", yes=True, agent="both", plugin=None, json=False, force_drift=False,
        ))
    finally:
        module.run_cli, module.collect_agent, module.git_root = saved_run, saved_collect, saved_root
    still = load_snapshot() or {}
    check((still.get("agents") or {}).get("codex", {}).get("known") is False, "조회 실패면 known:false 를 원본으로 바꾸지 않음")
    check((still.get("agents") or {}).get("claude", {}).get("path") == r"X:\original", "known:true 원본 유지")
    check(not any(n == "codex" and _is_mutation(a) for n, a in still_fail_cmds), "known:false 이고 조회 실패면 변경 없음")
    check(any(n == "claude" and _is_mutation(a) for n, a in still_fail_cmds), "known:true 쪽은 진행")

    missing_name_file = {
        "worktree": str(fake_root),
        "agents": {"codex": {"known": True, "registered": False, "plugins": []}},
    }
    snapshot_path().write_text(json.dumps(missing_name_file), encoding="utf-8")
    register_deletable(snapshot_path())
    missing_name_cmds: list[tuple[str, list[str]]] = []
    saved_run, saved_collect, saved_root = module.run_cli, module.collect_agent, module.git_root
    try:
        module.git_root = lambda: fake_root
        module.collect_agent = lambda root, agent: _snap(agent)
        module.run_cli = lambda name, args, timeout=TIMEOUT_READ: missing_name_cmds.append((name, list(args))) or _ok_run(name, args)
        missing_name_restore = execute(argparse.Namespace(
            command="restore", yes=True, agent="codex", plugin=None, json=False, force_drift=False,
        ))
    finally:
        module.run_cli, module.collect_agent, module.git_root = saved_run, saved_collect, saved_root
    check(missing_name_restore.get("snapshotCorrupt") is True, "marketplaceName 누락 스냅샷은 손상")
    check(not any(_is_mutation(a) for _, a in missing_name_cmds), "marketplaceName 누락 restore mutation 0")
    check(json.loads(snapshot_path().read_text(encoding="utf-8")) == missing_name_file, "marketplaceName 누락 원문 보존")

    legacy_snap = {
        "worktree": str(fake_root),
        "agents": {
            "codex": {
                "known": True, "registered": True, "marketplaceName": "sky-agent-plugins",
                "path": r"X:\original", "plugins": [],
            }
        },
    }
    save_snapshot(legacy_snap)
    legacy_loaded = load_snapshot()
    check(legacy_loaded is not None, "완료 필드 없는 기존 스냅샷은 활성")
    check("completed" not in json.loads(snapshot_path().read_text(encoding="utf-8")), "기존 형식에 completed 없음")

    replace_hits: list[Any] = []
    saved_replace = os.replace
    saved_register = sys.modules[__name__].register_deletable
    def refuse_register(path: Path | str) -> str | None:
        return "test refuse"
    def boom_replace(src: Any, dst: Any, *args: Any, **kwargs: Any) -> None:
        replace_hits.append((src, dst))
        raise AssertionError("os.replace called after register refused")
    os.replace = boom_replace
    sys.modules[__name__].register_deletable = refuse_register
    try:
        r2_reason = save_snapshot(legacy_snap)
        check(r2_reason is not None, "등록 거부 시 save_snapshot 사유 반환")
        check(not replace_hits, "등록 거부 시 os.replace 미호출")
    finally:
        os.replace = saved_replace
        sys.modules[__name__].register_deletable = saved_register

    chain_calls: list[str] = []
    tmp_chain_reason = "tmp write chain refused"
    saved_chain = sys.modules[__name__]._write_chain_reason
    tmp_replace_hits: list[Any] = []
    def mock_write_chain(target: Path) -> str | None:
        chain_calls.append(str(target))
        if Path(str(target)).name.endswith(".tmp"):
            return tmp_chain_reason
        return None
    def boom_tmp_replace(src: Any, dst: Any, *args: Any, **kwargs: Any) -> None:
        tmp_replace_hits.append((src, dst))
        raise AssertionError("os.replace called after tmp chain refused")
    os.replace = boom_tmp_replace
    sys.modules[__name__]._write_chain_reason = mock_write_chain
    try:
        tmp_reason = save_snapshot(legacy_snap)
        check(tmp_reason == tmp_chain_reason, "tmp 체인 거부 시 save_snapshot 이 그 사유를 반환")
        check(any(Path(item).name.endswith(".tmp") for item in chain_calls), "tmp 경로로 _write_chain_reason 호출")
        check(any(not Path(item).name.endswith(".tmp") for item in chain_calls), "최종 경로는 _write_chain_reason 허용")
        check(not tmp_replace_hits, "tmp 체인 거부 시 os.replace 미호출")
    finally:
        os.replace = saved_replace
        sys.modules[__name__]._write_chain_reason = saved_chain

    tmp_register_calls: list[str] = []
    tmp_register_reason = "tmp register refused"
    tmp_register_replace_hits: list[Any] = []
    def refuse_tmp_register(path: Path | str) -> str | None:
        tmp_register_calls.append(str(path))
        if Path(str(path)).name.endswith(".tmp"):
            return tmp_register_reason
        return saved_register(path)
    def boom_tmp_register_replace(src: Any, dst: Any, *args: Any, **kwargs: Any) -> None:
        tmp_register_replace_hits.append((src, dst))
        raise AssertionError("os.replace called after tmp register refused")
    os.replace = boom_tmp_register_replace
    sys.modules[__name__].register_deletable = refuse_tmp_register
    try:
        tmp_reg_reason = save_snapshot(legacy_snap)
        check(tmp_reg_reason == tmp_register_reason, "tmp 등록 거부 시 save_snapshot 이 그 사유를 반환")
        check(any(Path(item).name.endswith(".tmp") for item in tmp_register_calls), "tmp 경로로 register_deletable 호출")
        check(any(not Path(item).name.endswith(".tmp") for item in tmp_register_calls), "최종 경로는 register_deletable 허용")
        check(not tmp_register_replace_hits, "tmp 등록 거부 시 os.replace 미호출")
    finally:
        os.replace = saved_replace
        sys.modules[__name__].register_deletable = saved_register

    save_snapshot(captured)
    complete_fail_saved = load_snapshot() or {}
    complete_fail_current = {
        "codex": _snap("codex", marketplace={"name": "sky-agent-plugins", "path": str(fake_root)}, pointsAtWorktree=True),
        "claude": _snap(marketplace={"name": "sky-agent-plugins", "path": str(fake_root)}, pointsAtWorktree=True),
    }
    complete_fail_doc = {
        "repoRoot": str(fake_root), "command": "restore", "agents": ["claude", "codex"],
        "snapshots": complete_fail_current,
        "plans": {
            agent: {
                "register": None, "install": [], "validate": [],
                "restore": plan_restore_agent(fake_root, agent, complete_fail_current[agent], (complete_fail_saved.get("agents") or {}).get(agent) or {}),
            }
            for agent in ("claude", "codex")
        },
        "needsApproval": True, "appliedAny": False, "applied": {}, "validated": {},
        "errors": [], "blocked": {"claude": [], "codex": []}, "yes": True, "savedSnapshot": complete_fail_saved,
    }
    def _complete_fail_collect(root: Path, agent: str) -> dict[str, Any]:
        saved_a = (complete_fail_saved.get("agents") or {}).get(agent) or {}
        if saved_a.get("known") is not True or not saved_a.get("registered"):
            return _snap(agent)
        saved_dir = saved_a.get("path") or r"X:\original"
        plugins = []
        for item in saved_a.get("plugins") or []:
            plugin = {**item, "selector": f"{item.get('name')}@{item.get('marketplace')}"}
            if not plugin.get("path"):
                plugin["path"] = str(Path(saved_dir) / "plugins" / item["name"])
            plugins.append(plugin)
        return _snap(
            agent,
            marketplace={"name": saved_a.get("marketplaceName"), "path": saved_a.get("path")},
            plugins=plugins,
        )
    def boom_complete_replace(src: Any, dst: Any, *args: Any, **kwargs: Any) -> None:
        raise OSError("access denied")
    saved_run, saved_collect = module.run_cli, module.collect_agent
    os.replace = boom_complete_replace
    try:
        module.run_cli = lambda name, args, timeout=TIMEOUT_READ: _ok_run(name, args)
        module.collect_agent = _complete_fail_collect
        run_phases(argparse.Namespace(command="restore", yes=True, plugin=None), complete_fail_doc)
    finally:
        os.replace = saved_replace
        module.run_cli, module.collect_agent = saved_run, saved_collect
    check(complete_fail_doc.get("snapshotCompleted") is False, "완료 표시 실패 시 snapshotCompleted=False")
    check(complete_fail_doc.get("applyOk") is False, "완료 표시 실패 시 applyOk False")
    check(any("완료 표시" in err for err in complete_fail_doc.get("errors") or []), "완료 표시 실패 시 errors")
    check(_exit("restore", complete_fail_doc, yes=True) != EXIT_OK, "완료 표시 실패 시 종료 코드 비0")

    completed_old = {
        "worktree": str(fake_root),
        "completed": True,
        "agents": {
            "codex": {
                "known": True, "registered": True, "marketplaceName": "sky-agent-plugins",
                "path": r"X:\completed-original", "plugins": [],
            }
        },
    }
    save_snapshot(completed_old)
    check(load_snapshot() is None, "완료본은 비활성")
    saved_run, saved_collect, saved_root = module.run_cli, module.collect_agent, module.git_root
    try:
        module.git_root = lambda: fake_root
        module.collect_agent = lambda root, agent: _snap(
            agent, marketplace={"name": "sky-agent-plugins", "path": r"X:\new-original"},
        )
        module.run_cli = lambda name, args, timeout=TIMEOUT_READ: _ok_run(name, args)
        completed_reg = execute(argparse.Namespace(
            command="register", yes=True, agent="both", plugin=None, json=False, force_drift=False,
        ))
    finally:
        module.run_cli, module.collect_agent, module.git_root = saved_run, saved_collect, saved_root
    check(completed_reg.get("snapshotWrote") is True, "완료본 위 새 register 는 교체")
    check(completed_reg.get("snapshotKept") is not True, "완료본을 kept 하지 않음")
    replaced = load_snapshot() or {}
    check(replaced.get("completed") is not True, "새 캡처는 미완료")
    check((replaced.get("agents") or {}).get("codex", {}).get("path") == r"X:\new-original", "새 캡처로 교체")

    saved_active = _ACTIVE_ENV
    sys.modules[__name__].snapshot_path = orig_snapshot_path
    try:
        check(snapshot_path() == dummy_state / "snapshot.json", "snapshot_path 는 지정 환경 state")
        check(
            _plugin_install_root("claude") == (dummy_claude / "plugins").resolve(strict=False),
            "claude 설치 경계는 지정 환경",
        )
        check(
            _plugin_install_root("codex") == dummy_codex.resolve(strict=False),
            "codex 설치 경계는 지정 환경",
        )
        _ACTIVE_ENV = None
        raised = False
        try:
            snapshot_path()
        except RuntimeError:
            raised = True
        check(raised, "활성 환경 없이 snapshot_path 중단")
        raised = False
        try:
            _plugin_install_root("claude")
        except RuntimeError:
            raised = True
        check(raised, "활성 환경 없이 _plugin_install_root 중단")
    finally:
        _ACTIVE_ENV = saved_active
        sys.modules[__name__].snapshot_path = lambda: tmp_snap_dir / "snapshot.json"

    name_a = derived_env_name(r"D:\worktrees\brave-hound")
    check(name_a == derived_env_name(r"D:\worktrees\brave-hound"), "같은 워크트리 유도 동일")
    check(name_a == derived_env_name(r"d:\worktrees\brave-hound\\"), "정규화 후 유도 동일")
    check(name_a != derived_env_name(r"E:\other\brave-hound"), "다른 경로 유도 다름")
    check(name_a.startswith("brave-hound-") and len(name_a.rsplit("-", 1)[-1]) == 8, "유도 이름 형식")
    explicit_got = resolve_env_root_from_args(argparse.Namespace(env=r"X:\explicit-env"))
    check(str(explicit_got) == r"X:\explicit-env", "명시 --env 우선")

    saved_git = module.git_root
    saved_stderr = sys.stderr
    try:
        def _missing_git() -> Path:
            raise RuntimeError("git missing")
        module.git_root = _missing_git
        captured_err = io.StringIO()
        sys.stderr = captured_err
        try:
            missing_check = main(["check"])
            missing_init = main(["init-env"])
            missing_cleanup = main(["cleanup-env", "--yes"])
        finally:
            sys.stderr = saved_stderr
        missing_text = captured_err.getvalue()
        check(missing_check == EXIT_ERROR, "git 실패 시 --env 없이 check 중단")
        check(missing_init == EXIT_ERROR, "git 실패 시 --env 없이 init-env 중단")
        check(missing_cleanup == EXIT_ERROR, "git 실패 시 --env 없이 cleanup-env 중단")
        check("--env" in missing_text and "environments" in missing_text, "git 실패 시 --env 요구")

        module.git_root = lambda: fake_root
        captured_auto = io.StringIO()
        sys.stderr = captured_auto
        try:
            auto_code = main(["check"])
        finally:
            sys.stderr = saved_stderr
        derived = derived_env_root(fake_root)
        check(f"격리 환경: {derived}" in captured_auto.getvalue(), "자동 유도 경로 출력")
        check(auto_code == EXIT_ERROR, "유도 환경이 없으면 중단")
    finally:
        module.git_root = saved_git
        sys.stderr = saved_stderr
    missing_env = fake_envs / "missing-env"
    check(main(["check", "--env", str(missing_env)]) == EXIT_ERROR, "없는 환경이면 중단")
    bad_shape = fake_envs / "bad-shape"
    bad_shape.mkdir()
    register_deletable(bad_shape)
    check(main(["check", "--env", str(bad_shape)]) == EXIT_ERROR, "구조 불일치면 중단")

    env_good = fake_envs / "env-good"
    for name in (ENV_SUBDIR_CODEX, ENV_SUBDIR_CLAUDE, ENV_SUBDIR_STATE):
        (env_good / name).mkdir(parents=True)
        register_deletable(env_good / name)
    register_deletable(env_good)
    saved_codex_home = os.environ.get("CODEX_HOME")
    os.environ["CODEX_HOME"] = str(Path.home())
    try:
        mismatch_code = main(["check", "--env", str(env_good)])
    finally:
        if saved_codex_home is None:
            os.environ.pop("CODEX_HOME", None)
        else:
            os.environ["CODEX_HOME"] = saved_codex_home
    check(mismatch_code == EXIT_ERROR, "CODEX_HOME 불일치면 중단")

    env_junc = fake_envs / "env-junc"
    for name in (ENV_SUBDIR_CODEX, ENV_SUBDIR_CLAUDE, ENV_SUBDIR_STATE):
        (env_junc / name).mkdir(parents=True)
        register_deletable(env_junc / name)
    nested_plugins = env_junc / ENV_SUBDIR_CLAUDE / "plugins"
    nested_plugins.mkdir()
    register_deletable(nested_plugins)
    register_deletable(env_junc)
    write_env_marker(env_junc)
    nested_link = env_junc / ENV_SUBDIR_CLAUDE / "plugins-link"
    created_real_link = False
    try:
        os.symlink(str(env_junc / ENV_SUBDIR_STATE), str(nested_link), target_is_directory=True)
        created_real_link = True
        register_deletable(nested_link)
    except OSError:
        created_real_link = False
    junc_target = nested_link if created_real_link else nested_plugins
    orig_lstat_junc_tree = os.lstat

    class NestedReparseStat:
        st_mode = stat.S_IFDIR
        st_file_attributes = 0x400
        st_reparse_tag = 0xA0000003

    def nested_reparse_lstat(name: Any, *args: Any, **kwargs: Any) -> Any:
        if Path(str(name)) == junc_target and not created_real_link:
            return NestedReparseStat()
        return orig_lstat_junc_tree(name, *args, **kwargs)

    if not created_real_link:
        os.lstat = nested_reparse_lstat
    try:
        layout_raised = False
        layout_text = ""
        try:
            validate_isolated_env_layout(env_junc)
        except RuntimeError as exc:
            layout_raised = True
            layout_text = str(exc)
        check(layout_raised, "하위 링크면 layout 거부")
        check("링크 절대경로:" in layout_text, "진단에 절대경로")
        check("링크 종류:" in layout_text, "진단에 종류")
        check("연결 대상 경로:" in layout_text, "진단에 대상")
        check("검사 실패 이유:" in layout_text, "진단에 검사 이유")
        check("스냅샷 위치:" in layout_text, "진단에 스냅샷")
        check("재개 절차:" in layout_text, "진단에 재개")
        check("rmdir" in layout_text or "rm --" in layout_text, "진단에 비재귀 제거 명령")
        check("-Recurse" not in layout_text and " /S" not in layout_text, "재귀 옵션 없음")
        check(main(["check", "--env", str(env_junc), "--yes"]) == EXIT_ERROR, "하위 링크면 check --yes 거부")
        check(main(["restore", "--env", str(env_junc), "--yes"]) == EXIT_ERROR, "하위 링크면 restore --yes 거부")
        check(main(["loop", "--env", str(env_junc), "--yes"]) == EXIT_ERROR, "하위 링크면 loop --yes 거부")
        print(
            "self-test note: env subtree link used "
            + ("real os.symlink" if created_real_link else "_stat_is_reparse stub"),
            file=sys.stderr,
        )
    finally:
        os.lstat = orig_lstat_junc_tree

    saved_resolve = module.resolve_cli
    _PROCESS_ENVS.clear()
    try:
        module.resolve_cli = lambda name: [str(dummy_root / f"{name}.exe")]
        try:
            run_cli("codex", ["plugin", "list", "--json"])
        except ProcessExecutionBlocked:
            pass
        check(bool(_PROCESS_ENVS), "run_cli 가 프로세스를 시도")
        if _PROCESS_ENVS:
            check(_PROCESS_ENVS[-1]["CODEX_HOME"] == str(dummy_codex), "run_cli 가 CODEX_HOME 전달")
            check(
                _PROCESS_ENVS[-1]["CLAUDE_CONFIG_DIR"] == str(dummy_claude),
                "run_cli 가 CLAUDE_CONFIG_DIR 전달",
            )
    finally:
        module.resolve_cli = saved_resolve

    env_a = fake_envs / "envA"
    check(main(["init-env", "--env", str(env_a)]) == EXIT_NEEDS_APPROVAL, "init-env 무승인")
    check(not env_a.exists(), "무승인 init-env 는 만들지 않음")
    check(main(["init-env", "--env", str(env_a), "--yes"]) == EXIT_OK, "init-env 성공")
    check((env_a / ENV_MARKER_NAME).is_file(), "도구 마커 존재")
    env_b = fake_envs / "envB"
    check(main(["init-env", "--env", str(env_b), "--yes"]) == EXIT_OK, "init-env envB")
    sentinel_b = env_b / "state" / "keep.txt"
    sentinel_b.write_text("keep", encoding="utf-8")
    register_deletable(sentinel_b)

    saved_lock_env = _ACTIVE_ENV
    _ACTIVE_ENV = IsolatedEnv(
        env_a, env_a / ENV_SUBDIR_CODEX, env_a / ENV_SUBDIR_CLAUDE, env_a / ENV_SUBDIR_STATE,
    )
    probe_lock = SnapshotLock()
    probe_lock.acquire()
    try:
        lock_a = env_lock_path()
        check(lock_a.is_file(), "env lock file created")
        check(not path_is_under(lock_a, env_a), "env lock file is outside env tree")
        _iso, files, dirs, reason = inspect_cleanup_target(env_a)
        check(reason is None and _iso is not None, "inspect after lock")
        lock_key = str(lock_a.resolve(strict=False))
        check(all(str(p.resolve(strict=False)) != lock_key for p in files), "lock not in cleanup files")
        check(all(str(p.resolve(strict=False)) != lock_key for p in dirs), "lock not in cleanup dirs")
        _ACTIVE_ENV = IsolatedEnv(
            env_b, env_b / ENV_SUBDIR_CODEX, env_b / ENV_SUBDIR_CLAUDE, env_b / ENV_SUBDIR_STATE,
        )
        check(env_lock_path() != lock_a, "lock files differ per env")
    finally:
        probe_lock.release()
        _ACTIVE_ENV = saved_lock_env

    outside = tmp_snap_dir / "outside-env"
    for name in (ENV_SUBDIR_CODEX, ENV_SUBDIR_CLAUDE, ENV_SUBDIR_STATE):
        (outside / name).mkdir(parents=True)
        register_deletable(outside / name)
    register_deletable(outside)
    write_env_marker(outside)

    foreign = fake_envs / "foreign"
    foreign.mkdir()
    register_deletable(foreign)
    for name in (ENV_SUBDIR_CODEX, ENV_SUBDIR_CLAUDE, ENV_SUBDIR_STATE):
        (foreign / name).mkdir()
        register_deletable(foreign / name)

    orig_remove = os.remove
    orig_rmdir = os.rmdir
    orig_unlink = Path.unlink
    orig_rmtree = shutil.rmtree
    orig_removedirs = os.removedirs
    delete_hits = []

    def boom_remove(name: str, *args: Any, **kwargs: Any) -> None:
        delete_hits.append(str(name))
        raise AssertionError("os.remove called: " + str(name))

    def boom_rmdir(name: str, *args: Any, **kwargs: Any) -> None:
        delete_hits.append(str(name))
        raise AssertionError("os.rmdir called: " + str(name))

    def boom_unlink(self: Path, *args: Any, **kwargs: Any) -> None:
        delete_hits.append(str(self))
        raise AssertionError("Path.unlink called: " + str(self))

    def boom_rmtree(path: Any, *args: Any, **kwargs: Any) -> None:
        delete_hits.append(str(path))
        raise AssertionError("shutil.rmtree called: " + str(path))

    def boom_removedirs(name: str, *args: Any, **kwargs: Any) -> None:
        delete_hits.append(str(name))
        raise AssertionError("os.removedirs called: " + str(name))

    os.remove = boom_remove
    os.rmdir = boom_rmdir
    Path.unlink = boom_unlink
    shutil.rmtree = boom_rmtree
    os.removedirs = boom_removedirs
    try:
        for label, victim in (
            ("home", Path.home()),
            ("drive-root", Path(Path.home().anchor)),
            ("worktree", script_worktree_root()),
            ("cwd", Path.cwd()),
            ("parent", fake_envs),
            ("outside", outside),
            ("foreign", foreign),
        ):
            delete_hits.clear()
            code = main(["cleanup-env", "--env", str(victim), "--yes"])
            check(code == EXIT_ERROR, f"cleanup-env rejects {label}")
            check(not delete_hits, f"cleanup-env {label} did not call delete")
        check(foreign.is_dir(), "non-tool dir remains")
        check(sentinel_b.is_file(), "other env sentinel remains after rejected cleanup")
        check(outside.is_dir(), "outside env remains")

        incomplete = fake_envs / "incomplete-marker"
        for name in (ENV_SUBDIR_CODEX, ENV_SUBDIR_CLAUDE, ENV_SUBDIR_STATE):
            (incomplete / name).mkdir(parents=True)
            register_deletable(incomplete / name)
        register_deletable(incomplete)
        marker_incomplete = incomplete / ENV_MARKER_NAME
        marker_incomplete.write_text(
            json.dumps({"created_by": ENV_MARKER_CREATED_BY}) + "\n",
            encoding="utf-8",
        )
        register_deletable(marker_incomplete)
        check(env_marker_reason(incomplete) is not None, "kind 없는 마커 거부")
        delete_hits.clear()
        code = main(["cleanup-env", "--env", str(incomplete), "--yes"])
        check(code == EXIT_ERROR, "cleanup-env rejects incomplete marker")
        check(not delete_hits, "incomplete marker did not call delete")
        check(incomplete.is_dir(), "incomplete marker env remains")

        inner = env_a / "state" / "file.txt"
        inner.write_text("x", encoding="utf-8")
        register_deletable(inner)
        orig_lstat = os.lstat

        class ReparseStat:
            st_mode = stat.S_IFREG
            st_file_attributes = 0x400

        def fake_lstat(name: Any, *args: Any, **kwargs: Any) -> Any:
            if Path(str(name)) == inner:
                return ReparseStat()
            return orig_lstat(name, *args, **kwargs)

        os.lstat = fake_lstat
        try:
            delete_hits.clear()
            code = main(["cleanup-env", "--env", str(env_a), "--yes"])
            check(code == EXIT_ERROR, "cleanup-env rejects reparse inside")
            check(not delete_hits, "reparse inside did not call delete")
        finally:
            os.lstat = orig_lstat

        orig_lstat_junc = os.lstat
        orig_path_resolve = Path.resolve
        env_a_parent = os.path.normcase(str(env_a.parent))

        class JunctionDirStat:
            st_mode = stat.S_IFDIR
            st_file_attributes = 0x400

        def _path_is_env_a(name: Any) -> bool:
            current = Path(str(name))
            return current.name == env_a.name and os.path.normcase(str(current.parent)) == env_a_parent

        def junction_lstat(name: Any, *args: Any, **kwargs: Any) -> Any:
            if _path_is_env_a(name):
                return JunctionDirStat()
            return orig_lstat_junc(name, *args, **kwargs)

        def junction_resolve(self: Path, strict: bool = False) -> Path:
            if _path_is_env_a(self):
                return env_b
            return orig_path_resolve(self, strict=strict)

        os.lstat = junction_lstat
        Path.resolve = junction_resolve
        try:
            delete_hits.clear()
            junction_rejected = False
            try:
                _resolve_env_root(env_a, must_exist=True)
            except RuntimeError as exc:
                text = str(exc)
                junction_rejected = "reparse" in text or "junction" in text or "symlink" in text
            check(junction_rejected, "_resolve_env_root rejects junction before resolve")
            code = main(["cleanup-env", "--env", str(env_a), "--yes"])
            check(code == EXIT_ERROR, "cleanup-env rejects junction alias")
            check(not delete_hits, "junction alias did not call delete")
            check(env_b.is_dir(), "junction target envB remains")
            check(sentinel_b.is_file(), "junction target sentinel remains")
        finally:
            os.lstat = orig_lstat_junc
            Path.resolve = orig_path_resolve

        saved_under = path_is_under

        def fake_under(child: str | Path | None, root: str | Path | None) -> bool:
            if child is not None and "keep-out" in str(child):
                return False
            return saved_under(child, root)

        outsider = env_a / "state" / "keep-out.txt"
        outsider.write_text("no", encoding="utf-8")
        register_deletable(outsider)
        sys.modules[__name__].path_is_under = fake_under
        try:
            delete_hits.clear()
            code = main(["cleanup-env", "--env", str(env_a), "--yes"])
            check(code == EXIT_ERROR, "cleanup-env rejects path outside")
            check(not delete_hits, "outside resolve did not call delete")
        finally:
            sys.modules[__name__].path_is_under = saved_under

        held_active = _ACTIVE_ENV
        try:
            _ACTIVE_ENV = IsolatedEnv(
                env_a, env_a / ENV_SUBDIR_CODEX, env_a / ENV_SUBDIR_CLAUDE, env_a / ENV_SUBDIR_STATE,
            )
            held = SnapshotLock()
            held.acquire()
            try:
                delete_hits.clear()
                code = main(["cleanup-env", "--env", str(env_a), "--yes"])
                check(code == EXIT_ERROR, "cleanup-env rejects in-use env")
                check(not delete_hits, "in-use did not call delete")
            finally:
                held.release()
        finally:
            _ACTIVE_ENV = held_active
    except AssertionError as exc:
        failures.append(str(exc))
    finally:
        os.remove = orig_remove
        os.rmdir = orig_rmdir
        Path.unlink = orig_unlink
        shutil.rmtree = orig_rmtree
        os.removedirs = orig_removedirs

    check(main(["cleanup-env", "--env", str(env_b)]) == EXIT_NEEDS_APPROVAL, "cleanup-env 무승인")
    check(sentinel_b.is_file(), "무승인 cleanup 은 삭제하지 않음")
    check(main(["cleanup-env", "--env", str(env_a), "--yes"]) == EXIT_OK, "cleanup-env 허용된 도구 환경 삭제")
    check(not env_a.exists(), "envA 삭제됨")
    check(sentinel_b.is_file(), "다른 환경 envB 유지")

    help_text = build_parser().format_help()
    check("register --yes" in help_text and "loop --yes" in help_text and "check" in help_text, "--help 명령")
    check("restore --yes" in help_text, "--help 에 restore")
    check("init-env" in help_text and "cleanup-env" in help_text, "--help 에 환경 명령")
    check("--env" in help_text, "--help 에 --env")
    check("자동 유도" in help_text, "--help 에 자동 유도")
    env_action = next((a for a in build_parser()._actions if a.dest == "env"), None)
    check(env_action is not None and env_action.required is not True, "--env 선택 옵션")
    check("  install " not in help_text, "독립 install 없음")
    command_action = next((a for a in build_parser()._actions if a.dest == "command"), None)
    check(
        command_action is not None
        and set(command_action.choices or []) == set(COMMANDS),
        "서브커맨드",
    )
    check(command_action is not None and command_action.default == "check", "기본 check")

    sys.modules[__name__].snapshot_path = orig_snapshot_path
    sys.modules[__name__].environments_root = orig_environments_root
    _ACTIVE_ENV = None
    _CREATED_RECORDER = None
    leftovers = cleanup_self_test_tmp(tmp_snap_dir, created_paths)
    if leftovers:
        print("잔존 경로:")
        for item in leftovers:
            print(item)
    if failures:
        for item in failures:
            print(f"FAIL {item}")
        return EXIT_ERROR
    print("self-test ok")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
