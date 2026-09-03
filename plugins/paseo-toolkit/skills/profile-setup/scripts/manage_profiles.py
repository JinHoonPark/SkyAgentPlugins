#!/usr/bin/env python3
"""Validate, preview, apply, and roll back Paseo agent profile changes.

Every run writes one UTF-8 JSON document to stdout, with one deliberate
exception: ``--help`` prints argparse's plain-text usage instead.  A compact,
human-readable summary is written only to stderr so callers can safely pipe
stdout to a JSON parser.
"""

from __future__ import annotations

import argparse
import codecs
import copy
import ctypes
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Sequence


EXIT_OK = 0
EXIT_VALIDATION_ERROR = 2
EXIT_APPLY_FAILURE = 3

# Paseo's profile-editor registry.  These values intentionally do not come
# from a daemon response: the editor recognizes this fixed set of keys.
ICON_REGISTRY = frozenset(
    {
        "code",
        "terminal",
        "bug",
        "wrench",
        "hammer",
        "flask",
        "testTube",
        "microscope",
        "search",
        "eye",
        "palette",
        "feather",
        "pencil",
        "fileText",
        "book",
        "rocket",
        "package",
        "boxes",
        "server",
        "database",
        "cpu",
        "cloud",
        "globe",
        "gitBranch",
        "layers",
        "compass",
        "brain",
        "sparkles",
        "shield",
    }
)
COLOR_REGISTRY = frozenset(
    {
        "none",
        "violet",
        "sky",
        "emerald",
        "orange",
        "pink",
        "indigo",
        "teal",
        "red",
        "amber",
        "blue",
    }
)

REQUIRED_PROFILE_KEYS = ("id", "name", "provider")
OPTIONAL_PROFILE_KEYS = (
    "model",
    "modeId",
    "thinkingOptionId",
    "featureValues",
    "icon",
    "color",
    "notes",
)
KNOWN_PROFILE_KEYS = frozenset(REQUIRED_PROFILE_KEYS + OPTIONAL_PROFILE_KEYS)
KNOWN_MODE_IDS = {
    "claude": frozenset({"plan", "default", "acceptEdits", "auto", "bypassPermissions"}),
    "codex": frozenset({"auto", "auto-review", "full-access"}),
}

# Python's len() counts Unicode code points.  That is the deterministic
# definition used for this command's "Unicode character" threshold.
MAX_NOTES_UNICODE_CHARS = 160
NOTES_LENGTH_WARNING_REASON = (
    "짧은 두 문장 정도를 허용하면서 list_profiles 전체 반환 시 선택 정확도를 "
    "지키기 위함"
)

SAFE_PROVIDER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")

# --rollback restores a whole config file, so the requested file must be one
# this script produced.  This pattern is exactly what backup_path_for() appends
# to the target config file name.
BACKUP_PURPOSES = ("apply", "rollback")
BACKUP_NAME_SUFFIX = re.compile(
    r"\.profile-setup\.(?:" + "|".join(BACKUP_PURPOSES) + r")\.\d{8}-\d{9}\.[0-9a-f]{32}\.bak$"
)
UTF8_BOM = codecs.BOM_UTF8


@dataclass
class Problems:
    """Structured findings that can be emitted without parsing stderr."""

    errors: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[dict[str, Any]] = field(default_factory=list)

    def error(self, code: str, message: str, path: str | None = None) -> None:
        item: dict[str, Any] = {"code": code, "message": message}
        if path is not None:
            item["path"] = path
        self.errors.append(item)

    def warning(self, code: str, message: str, path: str | None = None) -> None:
        item: dict[str, Any] = {"code": code, "message": message}
        if path is not None:
            item["path"] = path
        self.warnings.append(item)


@dataclass(frozen=True)
class JsonSnapshot:
    path: Path
    raw: bytes
    document: Any
    sha256: str


@dataclass
class RuntimePaths:
    home: Path | None
    log_path: Path | None


@dataclass
class Candidate:
    index: int
    profile: Mapping[str, Any] | None
    identifier: str | None = None
    provider: str | None = None
    model: str | None = None
    mode_id: str | None = None
    thinking_option_id: str | None = None


@dataclass
class ProfilePlan:
    profiles: list[Any]
    added: list[str]
    replaced: list[str]


class JsonArgumentParser(argparse.ArgumentParser):
    """Keep normal invocation errors in the JSON result instead of stdout."""

    def error(self, message: str) -> None:
        raise ValueError(message)


def path_text(path: Path | None) -> str | None:
    if path is None:
        return None
    try:
        return str(path.resolve(strict=False))
    except OSError:
        return str(path)


def sha256_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _reject_nonstandard_json_constant(value: str) -> None:
    raise ValueError(f"JSON does not permit the constant {value!r}")


def _reject_duplicate_json_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"JSON object contains duplicate key {key!r}")
        result[key] = value
    return result


def parse_strict_json(text: str) -> Any:
    """Parse RFC-style JSON and reject ambiguous duplicate object keys."""

    return json.loads(
        text,
        parse_constant=_reject_nonstandard_json_constant,
        object_pairs_hook=_reject_duplicate_json_keys,
    )


def decode_utf8(raw: bytes, label: str) -> str:
    if raw.startswith(UTF8_BOM):
        raise ValueError(f"{label} must be UTF-8 without a BOM")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError(f"{label} must be valid UTF-8: {exc}") from exc


def load_json_snapshot(path: Path, label: str) -> JsonSnapshot:
    raw = path.read_bytes()
    text = decode_utf8(raw, label)
    try:
        document = parse_strict_json(text)
    except (json.JSONDecodeError, ValueError) as exc:
        raise ValueError(f"{label} is not valid JSON: {exc}") from exc
    return JsonSnapshot(path=path, raw=raw, document=document, sha256=sha256_bytes(raw))


def load_snapshot_safely(path: Path, label: str, problems: Problems) -> JsonSnapshot | None:
    try:
        return load_json_snapshot(path, label)
    except OSError as exc:
        problems.error("FILE_READ", f"{label}을 읽을 수 없습니다: {exc}", path_text(path))
    except ValueError as exc:
        problems.error("JSON", str(exc), path_text(path))
    return None


def read_input_bytes(source: str) -> bytes:
    if source == "-":
        binary_stream = getattr(sys.stdin, "buffer", None)
        if binary_stream is not None:
            return binary_stream.read()
        return sys.stdin.read().encode("utf-8")
    return Path(source).read_bytes()


def load_input_profiles(source: str, problems: Problems) -> list[Any] | None:
    label = "stdin" if source == "-" else f"입력 파일 {source}"
    try:
        raw = read_input_bytes(source)
        text = decode_utf8(raw, label)
        document = parse_strict_json(text)
    except OSError as exc:
        problems.error("INPUT_READ", f"{label}을 읽을 수 없습니다: {exc}", source)
        return None
    except ValueError as exc:
        # json.JSONDecodeError subclasses ValueError, so this one clause covers
        # both malformed JSON and the strict-parser rejections above.
        problems.error("JSON", f"{label} JSON 오류: {exc}", source)
        return None

    if isinstance(document, dict):
        return [document]
    if isinstance(document, list):
        return document
    problems.error("INPUT_TOP_LEVEL", f"{label}은 JSON 객체 또는 배열이어야 합니다.", source)
    return None


def make_parser() -> JsonArgumentParser:
    parser = JsonArgumentParser(
        description="Paseo daemon.agentProfiles를 검증하고 안전하게 반영합니다."
    )
    parser.add_argument(
        "input_path",
        nargs="?",
        default=None,
        metavar="INPUT",
        help="프로필 JSON 객체/배열 파일 경로. 생략하면 stdin을 읽습니다.",
    )
    parser.add_argument("--apply", action="store_true", help="검증된 변경을 실제로 반영합니다.")
    parser.add_argument(
        "--update",
        action="store_true",
        help="동일 id가 있을 때 정확히 하나의 기존 프로필을 교체합니다.",
    )
    parser.add_argument(
        "--config",
        metavar="PATH",
        help="테스트 또는 명시적 대상용 config.json 경로 override입니다.",
    )
    parser.add_argument(
        "--rollback",
        metavar="BACKUP",
        help="지정한 백업 JSON을 config.json으로 복원합니다. --apply가 없으면 dry-run입니다.",
    )
    return parser


def normal_string(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value
    return None


def command_diagnostic(result: subprocess.CompletedProcess[str]) -> str:
    text = (result.stderr or result.stdout or "").strip().replace("\r", " ").replace("\n", " ")
    return text[:500] if text else "출력 없음"


def paseo_command(arguments: Sequence[str]) -> list[str]:
    """Resolve only through PATH and explicitly launch a Windows .cmd shim."""

    executable = shutil.which("paseo") or shutil.which("paseo.cmd")
    if executable is None:
        raise FileNotFoundError("PATH에서 paseo CLI를 찾지 못했습니다.")

    if os.name == "nt" and Path(executable).suffix.casefold() in {".cmd", ".bat"}:
        # subprocess does not need a shell for ordinary executables.  A batch
        # shim is the deliberate exception: invoke cmd.exe explicitly rather
        # than relying on implicit shell behavior or a guessed shim location.
        command_shell = os.environ.get("ComSpec")
        if not command_shell:
            raise FileNotFoundError("Paseo .cmd shim을 실행할 ComSpec 환경 변수가 없습니다.")
        batch_line = subprocess.list2cmdline([executable, *arguments])
        return [command_shell, "/d", "/s", "/c", batch_line]

    return [executable, *arguments]


def run_paseo(arguments: Sequence[str]) -> subprocess.CompletedProcess[str]:
    command = paseo_command(arguments)
    return subprocess.run(
        command,
        check=False,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        text=True,
        timeout=30,
    )


def run_paseo_json(
    arguments: Sequence[str], label: str, problems: Problems
) -> Any | None:
    try:
        result = run_paseo(arguments)
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired) as exc:
        problems.error("PASEO_COMMAND", f"{label} 실행 실패: {exc}")
        return None
    if result.returncode != 0:
        problems.error(
            "PASEO_COMMAND",
            f"{label}가 종료 코드 {result.returncode}로 실패했습니다: {command_diagnostic(result)}",
        )
        return None
    try:
        return parse_strict_json(result.stdout)
    except (json.JSONDecodeError, ValueError) as exc:
        problems.error("PASEO_JSON", f"{label}의 stdout이 유효한 JSON이 아닙니다: {exc}")
        return None


def discover_runtime_paths(
    problems: Problems, *, require_home: bool, require_log_path: bool
) -> RuntimePaths:
    status = run_paseo_json(("status", "--json"), "paseo status --json", problems)
    if not isinstance(status, dict):
        if status is not None:
            problems.error("PASEO_STATUS", "paseo status --json은 JSON 객체여야 합니다.")
        return RuntimePaths(home=None, log_path=None)

    # Deliberately read only these two status values.  config.json is derived
    # from home; daemon log verification is derived from logPath.
    home_value = normal_string(status.get("home"))
    log_value = normal_string(status.get("logPath"))
    if home_value is None and require_home:
        problems.error("PASEO_STATUS", "paseo status --json에 문자열 home이 없습니다.")
    if log_value is None and require_log_path:
        problems.error("PASEO_STATUS", "paseo status --json에 문자열 logPath가 없습니다.")
    return RuntimePaths(
        home=Path(home_value) if home_value is not None else None,
        log_path=Path(log_value) if log_value is not None else None,
    )


def list_providers(problems: Problems) -> dict[str, Mapping[str, Any]] | None:
    response = run_paseo_json(("provider", "ls", "--json"), "paseo provider ls --json", problems)
    if response is None:
        return None
    if isinstance(response, dict):
        response = response.get("providers")
    if not isinstance(response, list):
        problems.error("PASEO_PROVIDERS", "paseo provider ls --json은 provider 배열이어야 합니다.")
        return None

    providers: dict[str, Mapping[str, Any]] = {}
    for index, item in enumerate(response):
        if not isinstance(item, dict):
            problems.error("PASEO_PROVIDERS", f"provider[{index}]가 JSON 객체가 아닙니다.")
            continue
        identifier = normal_string(item.get("provider"))
        if identifier is None:
            problems.error("PASEO_PROVIDERS", f"provider[{index}].provider가 비어 있습니다.")
            continue
        if identifier in providers:
            problems.error("PASEO_PROVIDERS", f"provider 목록에 {identifier!r}가 중복되었습니다.")
            continue
        providers[identifier] = item
    return providers


def list_models(provider: str, problems: Problems) -> dict[str, Mapping[str, Any]] | None:
    # Provider IDs first came from paseo provider ls.  Rejecting unusual IDs
    # protects the explicit cmd.exe batch-shim path from command metacharacters.
    if SAFE_PROVIDER_ID.fullmatch(provider) is None:
        problems.error(
            "PASEO_PROVIDER_ID",
            f"provider ls가 반환한 provider id {provider!r}는 안전한 CLI 인수가 아닙니다.",
        )
        return None
    response = run_paseo_json(
        ("provider", "models", provider, "--json"),
        f"paseo provider models {provider} --json",
        problems,
    )
    if response is None:
        return None
    if isinstance(response, dict):
        response = response.get("models")
    if not isinstance(response, list):
        problems.error(
            "PASEO_MODELS",
            f"paseo provider models {provider} --json은 모델 배열이어야 합니다.",
        )
        return None

    models: dict[str, Mapping[str, Any]] = {}
    for index, item in enumerate(response):
        if not isinstance(item, dict):
            problems.error("PASEO_MODELS", f"{provider} model[{index}]가 JSON 객체가 아닙니다.")
            continue
        identifier = normal_string(item.get("id"))
        if identifier is None:
            problems.error("PASEO_MODELS", f"{provider} model[{index}].id가 비어 있습니다.")
            continue
        if identifier in models:
            problems.error("PASEO_MODELS", f"{provider} 모델 목록에 {identifier!r}가 중복되었습니다.")
            continue
        models[identifier] = item
    return models


def validate_config_document(
    document: Any, label: str, problems: Problems, path: Path | None = None
) -> list[Any] | None:
    location = path_text(path)
    if not isinstance(document, dict):
        problems.error("CONFIG_OBJECT", f"{label}의 최상위 값은 JSON 객체여야 합니다.", location)
        return None
    daemon = document.get("daemon")
    if not isinstance(daemon, dict):
        problems.error("CONFIG_DAEMON", f"{label}.daemon은 JSON 객체여야 합니다.", location)
        return None
    profiles = daemon.get("agentProfiles")
    if not isinstance(profiles, list):
        problems.error("CONFIG_ARRAY", f"{label}.daemon.agentProfiles는 배열이어야 합니다.", location)
        return None
    return profiles


def validate_profile_shape(profiles: list[Any], problems: Problems) -> list[Candidate]:
    candidates: list[Candidate] = []
    for index, value in enumerate(profiles):
        profile_path = f"profiles[{index}]"
        if not isinstance(value, dict):
            problems.error("PROFILE_OBJECT", "프로필은 JSON 객체여야 합니다.", profile_path)
            candidates.append(Candidate(index=index, profile=None))
            continue

        candidate = Candidate(index=index, profile=value)
        for key in REQUIRED_PROFILE_KEYS:
            candidate_value = normal_string(value.get(key)) if key in value else None
            if candidate_value is None:
                problems.error(
                    "REQUIRED_FIELD",
                    f"필수 필드 {key!r}는 비어 있지 않은 문자열이어야 합니다.",
                    f"{profile_path}.{key}",
                )
            elif key == "id":
                candidate.identifier = candidate_value
            elif key == "provider":
                candidate.provider = candidate_value

        for key in sorted(set(value) - KNOWN_PROFILE_KEYS):
            problems.warning(
                "UNKNOWN_KEY",
                f"알 수 없는 프로필 키 {key!r}는 Paseo 스키마가 통과시켜도 사용하지 않을 수 있습니다.",
                f"{profile_path}.{key}",
            )

        for key, attribute in (
            ("model", "model"),
            ("modeId", "mode_id"),
            ("thinkingOptionId", "thinking_option_id"),
        ):
            if key not in value:
                continue
            candidate_value = normal_string(value[key])
            if candidate_value is None:
                problems.error(
                    "PROFILE_FIELD",
                    f"선택 필드 {key!r}가 있으면 비어 있지 않은 문자열이어야 합니다.",
                    f"{profile_path}.{key}",
                )
            else:
                setattr(candidate, attribute, candidate_value)

        if "featureValues" in value and not isinstance(value["featureValues"], dict):
            problems.error(
                "PROFILE_FIELD",
                "featureValues가 있으면 JSON 객체여야 합니다.",
                f"{profile_path}.featureValues",
            )

        if "icon" in value:
            icon = normal_string(value["icon"])
            if icon is None or icon not in ICON_REGISTRY:
                problems.error(
                    "ICON",
                    f"icon은 고정 레지스트리의 29개 키 중 하나여야 합니다: {', '.join(sorted(ICON_REGISTRY))}",
                    f"{profile_path}.icon",
                )

        if "color" in value:
            color = normal_string(value["color"])
            if color is None or color not in COLOR_REGISTRY:
                problems.error(
                    "COLOR",
                    f"color는 고정 레지스트리의 11개 값 중 하나여야 합니다: {', '.join(sorted(COLOR_REGISTRY))}",
                    f"{profile_path}.color",
                )

        if "notes" in value:
            notes = value["notes"]
            if not isinstance(notes, str):
                problems.error(
                    "PROFILE_FIELD",
                    "notes가 있으면 문자열이어야 합니다.",
                    f"{profile_path}.notes",
                )
            elif len(notes) > MAX_NOTES_UNICODE_CHARS:
                problems.warning(
                    "NOTES_LENGTH",
                    f"notes는 Unicode 문자 {len(notes)}자입니다. {MAX_NOTES_UNICODE_CHARS}자를 초과하면 "
                    f"{NOTES_LENGTH_WARNING_REASON}.",
                    f"{profile_path}.notes",
                )

        candidates.append(candidate)
    return candidates


def validate_batch_duplicates(candidates: Iterable[Candidate], problems: Problems) -> None:
    by_id: dict[str, list[Candidate]] = {}
    for candidate in candidates:
        if candidate.identifier is not None:
            by_id.setdefault(candidate.identifier, []).append(candidate)
    for identifier, matches in by_id.items():
        if len(matches) < 2:
            continue
        for candidate in matches:
            problems.error(
                "BATCH_DUPLICATE",
                f"입력 배열에 id {identifier!r}가 중복되었습니다.",
                f"profiles[{candidate.index}].id",
            )


def validate_provider_model_and_thinking(
    candidates: list[Candidate], providers: dict[str, Mapping[str, Any]] | None, problems: Problems
) -> None:
    provider_ready: dict[str, bool] = {}
    providers_needing_models: set[str] = set()

    for candidate in candidates:
        profile_path = f"profiles[{candidate.index}]"
        if candidate.provider is None:
            continue
        provider_info = providers.get(candidate.provider) if providers is not None else None
        if provider_info is None:
            problems.error(
                "PROVIDER",
                f"provider {candidate.provider!r}가 paseo provider ls --json 결과에 없습니다.",
                f"{profile_path}.provider",
            )
            provider_ready[candidate.provider] = False
        else:
            status = normal_string(provider_info.get("status"))
            available = status is not None and status.casefold() == "available"
            if not available:
                problems.error(
                    "PROVIDER_STATUS",
                    f"provider {candidate.provider!r}의 status가 available이 아닙니다: {status!r}.",
                    f"{profile_path}.provider",
                )
            provider_ready[candidate.provider] = available

        if candidate.mode_id is not None:
            default_mode = (
                normal_string(provider_info.get("defaultMode"))
                if provider_info is not None
                else None
            )
            known_modes = KNOWN_MODE_IDS.get(candidate.provider, frozenset())
            if candidate.mode_id != default_mode and candidate.mode_id not in known_modes:
                problems.warning(
                    "MODE_UNVERIFIED",
                    f"modeId {candidate.mode_id!r}는 0.7.2 스냅샷에 없고 provider의 "
                    f"defaultMode {default_mode!r}와도 일치하지 않습니다. CLI는 전체 mode ID를 열거하지 않습니다.",
                    f"{profile_path}.modeId",
                )

        if candidate.provider == "claude" and candidate.mode_id == "plan":
            problems.warning(
                "CLAUDE_PLAN",
                "Claude plan 모드는 코드 수정과 도구 실행을 막아 문서 산출까지 막습니다.",
                f"{profile_path}.modeId",
            )

        if provider_ready.get(candidate.provider, False) and candidate.model is not None:
            providers_needing_models.add(candidate.provider)

    model_catalogs: dict[str, dict[str, Mapping[str, Any]] | None] = {}
    for provider in sorted(providers_needing_models):
        model_catalogs[provider] = list_models(provider, problems)

    for candidate in candidates:
        profile_path = f"profiles[{candidate.index}]"
        if candidate.thinking_option_id is not None and candidate.model is None:
            # The schema makes both fields independently optional.  Without a
            # model there is no thinkingOptionIds list to check against, so this
            # stays a warning instead of rejecting a profile Paseo accepts.
            problems.warning(
                "THINKING_UNVERIFIED",
                "model이 없어 thinkingOptionId를 모델별 thinkingOptionIds와 대조할 수 없습니다. "
                "model을 비우면 Paseo 기본 모델이 쓰이며, 그 모델이 이 값을 지원하는지는 검증되지 않았습니다.",
                f"{profile_path}.thinkingOptionId",
            )

        if candidate.model is None:
            continue
        if candidate.provider is None or not provider_ready.get(candidate.provider, False):
            problems.error(
                "MODEL_PROVIDER",
                "provider가 available 상태가 아니어서 model을 검증할 수 없습니다.",
                f"{profile_path}.model",
            )
            if candidate.thinking_option_id is not None:
                problems.error(
                    "THINKING_MODEL",
                    "model을 검증할 수 없어 thinkingOptionId도 검증할 수 없습니다.",
                    f"{profile_path}.thinkingOptionId",
                )
            continue

        catalog = model_catalogs.get(candidate.provider)
        if catalog is None:
            problems.error(
                "MODEL_CATALOG",
                f"provider {candidate.provider!r}의 모델 목록을 읽지 못해 model을 검증할 수 없습니다.",
                f"{profile_path}.model",
            )
            if candidate.thinking_option_id is not None:
                problems.error(
                    "THINKING_MODEL",
                    "모델 목록을 읽지 못해 thinkingOptionId를 검증할 수 없습니다.",
                    f"{profile_path}.thinkingOptionId",
                )
            continue

        model_info = catalog.get(candidate.model)
        if model_info is None:
            problems.error(
                "MODEL",
                f"model {candidate.model!r}이 provider {candidate.provider!r}의 현재 모델 목록에 없습니다.",
                f"{profile_path}.model",
            )
            if candidate.thinking_option_id is not None:
                problems.error(
                    "THINKING_MODEL",
                    "알 수 없는 model에는 thinkingOptionId를 검증할 수 없습니다.",
                    f"{profile_path}.thinkingOptionId",
                )
            continue

        if candidate.thinking_option_id is not None:
            options = model_info.get("thinkingOptionIds")
            if not isinstance(options, list) or candidate.thinking_option_id not in options:
                problems.error(
                    "THINKING",
                    f"thinkingOptionId {candidate.thinking_option_id!r}는 model "
                    f"{candidate.model!r}의 현재 thinkingOptionIds에 없습니다.",
                    f"{profile_path}.thinkingOptionId",
                )


def validate_conflicts(
    candidates: list[Candidate], existing_profiles: list[Any] | None, update: bool, problems: Problems
) -> None:
    existing_by_id: dict[str, list[int]] = {}
    if existing_profiles is not None:
        for index, item in enumerate(existing_profiles):
            if isinstance(item, dict):
                identifier = normal_string(item.get("id"))
                if identifier is not None:
                    existing_by_id.setdefault(identifier, []).append(index)

    for candidate in candidates:
        if candidate.identifier is None:
            continue
        matches = existing_by_id.get(candidate.identifier, [])
        if not matches:
            continue
        if not update:
            problems.error(
                "CONFLICT",
                f"id {candidate.identifier!r}가 기존 agentProfiles에 이미 있습니다. 교체하려면 --update가 필요합니다.",
                f"profiles[{candidate.index}].id",
            )
        elif len(matches) != 1:
            problems.error(
                "CONFLICT_AMBIGUOUS",
                f"--update는 id {candidate.identifier!r}와 일치하는 기존 프로필이 정확히 하나여야 합니다. 현재 {len(matches)}개입니다.",
                f"profiles[{candidate.index}].id",
            )


def build_profile_plan(
    candidates: list[Candidate], existing_profiles: list[Any], update: bool
) -> ProfilePlan:
    planned_profiles = copy.deepcopy(existing_profiles)
    existing_by_id: dict[str, int] = {}
    for index, item in enumerate(existing_profiles):
        if isinstance(item, dict):
            identifier = normal_string(item.get("id"))
            if identifier is not None:
                existing_by_id[identifier] = index

    added: list[str] = []
    replaced: list[str] = []
    for candidate in candidates:
        # All validation has succeeded before this function is called.
        assert candidate.profile is not None
        assert candidate.identifier is not None
        if update and candidate.identifier in existing_by_id:
            planned_profiles[existing_by_id[candidate.identifier]] = copy.deepcopy(candidate.profile)
            replaced.append(candidate.identifier)
        else:
            planned_profiles.append(copy.deepcopy(candidate.profile))
            added.append(candidate.identifier)
    return ProfilePlan(profiles=planned_profiles, added=added, replaced=replaced)


def document_with_profiles(document: Mapping[str, Any], profiles: list[Any]) -> dict[str, Any]:
    updated = copy.deepcopy(document)
    daemon = updated["daemon"]
    assert isinstance(daemon, dict)
    daemon["agentProfiles"] = copy.deepcopy(profiles)
    return updated


def document_without_profiles(document: Mapping[str, Any]) -> dict[str, Any]:
    copied = copy.deepcopy(document)
    daemon = copied.get("daemon")
    if isinstance(daemon, dict):
        daemon.pop("agentProfiles", None)
    return copied


def verify_exact_change(
    before: Mapping[str, Any], after: Any, expected_profiles: list[Any], problems: Problems, label: str
) -> bool:
    after_profiles = validate_config_document(after, label, problems)
    if after_profiles is None:
        return False
    ok = True
    if after_profiles != expected_profiles:
        problems.error("ARRAY_CHANGE", "agentProfiles 배열 변화가 계획한 값과 정확히 일치하지 않습니다.")
        ok = False
    if document_without_profiles(before) != document_without_profiles(after):
        problems.error("CONFIG_PRESERVATION", "agentProfiles 밖의 config 값이 변경되었습니다.")
        ok = False
    return ok


def backup_path_for(config_path: Path, purpose: str) -> Path:
    timestamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S%f")[:-3]
    name = f"{config_path.name}.profile-setup.{purpose}.{timestamp}.{uuid.uuid4().hex}.bak"
    return config_path.with_name(name)


def create_backup(config_path: Path, purpose: str) -> Path:
    backup_path = backup_path_for(config_path, purpose)
    shutil.copyfile(config_path, backup_path)
    return backup_path


def is_script_backup_of(backup_path: Path, config_path: Path) -> bool:
    """Recognize only the sibling backup names create_backup() produces.

    Both names are compared as the filesystem holds them, not as they were
    typed.  Windows paths are case-insensitive, so the same file reached
    through a differently-cased argument must still be recognized.
    """

    backup_real = Path(str(path_text(backup_path)))
    config_real = Path(str(path_text(config_path)))
    match = BACKUP_NAME_SUFFIX.search(backup_real.name)
    if match is None or backup_real.name[: match.start()] != config_real.name:
        return False
    backup_directory = os.path.normcase(str(backup_real.parent))
    config_directory = os.path.normcase(str(config_real.parent))
    return backup_directory == config_directory


def set_windows_file_attributes(path: str, attributes: int) -> None:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.SetFileAttributesW.argtypes = (ctypes.c_wchar_p, ctypes.c_uint32)
    kernel32.SetFileAttributesW.restype = ctypes.c_int
    if not kernel32.SetFileAttributesW(path, attributes):
        raise ctypes.WinError(ctypes.get_last_error())


def carry_file_metadata(source: Path, destination: str) -> None:
    """Carry the replaced file's permission bits and Windows file attributes.

    Timestamps are deliberately not carried: the replacement holds new content.
    A metadata failure is reported on stderr rather than discarding an
    otherwise valid config write.
    """

    try:
        status = source.stat()
        os.chmod(destination, stat.S_IMODE(status.st_mode))
        attributes = getattr(status, "st_file_attributes", None)
        if attributes is not None:
            set_windows_file_attributes(destination, attributes)
    except OSError as exc:
        stderr_line(f"{source}의 파일 속성을 {destination}로 옮기지 못했습니다: {exc}")


def atomic_write_bytes(path: Path, raw: bytes, expected_current_hash: str | None = None) -> None:
    """Replace one file after a last hash identity check, preserving no BOM."""

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
        carry_file_metadata(path, temporary_name)
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


def serialize_json(document: Any) -> bytes:
    text = json.dumps(document, ensure_ascii=False, allow_nan=False, indent=2)
    return (text + "\n").encode("utf-8")


def log_lines(log_path: Path) -> list[str]:
    raw = log_path.read_bytes()
    return decode_utf8(raw, f"데몬 로그 {log_path}").splitlines()


def line_level(value: Any) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().casefold()
        if lowered in {"fatal", "error"}:
            return 50
        if lowered in {"warn", "warning"}:
            return 40
        if lowered in {"info", "information"}:
            return 30
        try:
            return int(lowered)
        except ValueError:
            return None
    return None


def assess_reload_logs(new_lines: list[str]) -> dict[str, Any]:
    loaded = False
    parsed_lines = 0
    unparsed_lines = 0
    error_messages: list[str] = []
    info_messages: list[str] = []
    for raw_line in new_lines:
        try:
            record = json.loads(raw_line)
        except json.JSONDecodeError:
            unparsed_lines += 1
            continue
        if not isinstance(record, dict):
            unparsed_lines += 1
            continue
        parsed_lines += 1
        level = line_level(record.get("level"))
        message = record.get("msg")
        message_text = message if isinstance(message, str) else ""
        message_folded = message_text.casefold()
        profile_validation_context = any(
            token in message_folded for token in ("agentprofiles", "schema", "validation")
        )
        profile_validation_error = profile_validation_context and any(
            token in message_folded
            for token in ("error", "invalid", "fail", "reject", "must", "required")
        )

        if level is not None and level >= 40:
            error_messages.append(message_text or f"level {level} 로그")
        elif profile_validation_error:
            error_messages.append(message_text or "프로필 스키마 관련 로그")

        if level == 30 and "loaded from" in message_folded:
            loaded = True
            info_messages.append(message_text)

    return {
        "ok": loaded and not error_messages,
        "newLineCount": len(new_lines),
        "parsedJsonLineCount": parsed_lines,
        "unparsedLineCount": unparsed_lines,
        "loadedFromConfig": loaded,
        "errorMessages": error_messages[:10],
        "loadedMessages": info_messages[:10],
    }


def wait_for_reload_logs(log_path: Path, baseline_line_count: int) -> dict[str, Any]:
    """Read only the lines emitted after the reload baseline for up to 2 seconds."""

    last_result: dict[str, Any] | None = None
    last_read_error: str | None = None
    deadline = time.monotonic() + 2.0
    while True:
        try:
            lines = log_lines(log_path)
            if len(lines) < baseline_line_count:
                return {
                    "ok": False,
                    "newLineCount": 0,
                    "parsedJsonLineCount": 0,
                    "unparsedLineCount": 0,
                    "loadedFromConfig": False,
                    "errorMessages": ["reload 중 daemon log가 축소 또는 교체되었습니다."],
                    "loadedMessages": [],
                }
            last_result = assess_reload_logs(lines[baseline_line_count:])
            if last_result["ok"] or last_result["errorMessages"]:
                return last_result
        except (OSError, ValueError) as exc:
            last_read_error = str(exc)
            break

        if time.monotonic() >= deadline:
            break
        time.sleep(0.1)

    if last_read_error is not None:
        return {
            "ok": False,
            "newLineCount": 0,
            "parsedJsonLineCount": 0,
            "unparsedLineCount": 0,
            "loadedFromConfig": False,
            "errorMessages": [f"reload 뒤 daemon log를 읽을 수 없습니다: {last_read_error}"],
            "loadedMessages": [],
        }
    if last_result is None:
        last_result = {
            "ok": False,
            "newLineCount": 0,
            "parsedJsonLineCount": 0,
            "unparsedLineCount": 0,
            "loadedFromConfig": False,
            "errorMessages": [],
            "loadedMessages": [],
        }
    last_result["ok"] = False
    last_result["errorMessages"] = list(last_result["errorMessages"]) + [
        "reload 뒤 신규 daemon log에서 level 30의 'Loaded from' 로그를 찾지 못했습니다."
    ]
    return last_result


def reload_and_verify(log_path: Path | None) -> dict[str, Any]:
    result: dict[str, Any] = {"attempted": True, "command": None, "log": None, "ok": False}
    if log_path is None:
        result["log"] = {"ok": False, "errorMessages": ["paseo status의 logPath가 없습니다."]}
        return result
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
    expected_stdout = "Configuration reloaded."
    stdout = command.stdout.strip()
    stdout_ok = stdout == expected_stdout
    result["command"] = {
        "ok": command.returncode == 0 and stdout_ok,
        "returnCode": command.returncode,
        "stdout": stdout,
        "stderr": command.stderr.strip(),
        "expectedStdout": expected_stdout,
    }
    result["log"] = wait_for_reload_logs(log_path, baseline)
    if command.returncode != 0:
        result["log"]["ok"] = False
        result["log"]["errorMessages"] = list(result["log"].get("errorMessages", [])) + [
            "paseo daemon reload 명령이 실패했습니다."
        ]
        return result
    if not stdout_ok:
        result["log"]["ok"] = False
        result["log"]["errorMessages"] = list(result["log"].get("errorMessages", [])) + [
            "paseo daemon reload stdout이 'Configuration reloaded.'와 일치하지 않습니다."
        ]
        return result
    result["ok"] = bool(result["log"].get("ok"))
    return result


def restore_backup_and_reload(
    config_path: Path, backup_path: Path, log_path: Path | None
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "attempted": True,
        "backupPath": path_text(backup_path),
        "restored": False,
        "reparse": False,
        "reload": None,
        "ok": False,
    }
    try:
        backup = load_json_snapshot(backup_path, "복원 백업")
        validate_problems = Problems()
        if validate_config_document(backup.document, "복원 백업", validate_problems, backup_path) is None:
            result["error"] = validate_problems.errors
            return result
        atomic_write_bytes(config_path, backup.raw)
        restored = load_json_snapshot(config_path, "복원된 config.json")
        result["restored"] = restored.raw == backup.raw
        result["reparse"] = True
        if not result["restored"]:
            result["error"] = "복원된 config.json의 바이트가 백업과 다릅니다."
            return result
        result["reload"] = reload_and_verify(log_path)
        result["ok"] = bool(result["reload"].get("ok"))
        return result
    except (OSError, ValueError, RuntimeError) as exc:
        result["error"] = str(exc)
        return result


def apply_profile_plan(
    config_path: Path,
    initial: JsonSnapshot,
    planned_document: Mapping[str, Any],
    planned_profiles: list[Any],
    log_path: Path | None,
    problems: Problems,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "attempted": True,
        "backupPath": None,
        "identity": {"beforeSha256": initial.sha256, "rechecked": False},
        "written": False,
        "reparse": False,
        "reload": None,
        "rollback": None,
        "ok": False,
    }
    backup_path: Path | None = None
    try:
        # Required order: backup first, then a fresh hash-identity read before
        # writing the exact array-only change.
        backup_path = create_backup(config_path, "apply")
        result["backupPath"] = path_text(backup_path)
        backup_hash = sha256_bytes(backup_path.read_bytes())
        if backup_hash != initial.sha256:
            raise RuntimeError("생성한 백업의 hash가 최초 config.json과 다릅니다.")

        rechecked = load_json_snapshot(config_path, "재확인 config.json")
        result["identity"]["rechecked"] = rechecked.sha256 == initial.sha256
        result["identity"]["recheckedSha256"] = rechecked.sha256
        if rechecked.sha256 != initial.sha256:
            raise RuntimeError("백업 직후 config.json이 변경되어 적용을 중단했습니다.")

        if not verify_exact_change(rechecked.document, planned_document, planned_profiles, problems, "적용 예정 config"):
            raise RuntimeError("적용 예정 config의 배열 변화 검증에 실패했습니다.")

        atomic_write_bytes(config_path, serialize_json(planned_document), rechecked.sha256)
        result["written"] = True
        written = load_json_snapshot(config_path, "기록된 config.json")
        result["reparse"] = True
        if not verify_exact_change(rechecked.document, written.document, planned_profiles, problems, "기록된 config"):
            raise RuntimeError("기록 뒤 config.json의 배열 변화 검증에 실패했습니다.")

        result["reload"] = reload_and_verify(log_path)
        if not result["reload"].get("ok"):
            raise RuntimeError("paseo daemon reload 또는 신규 daemon log 검증에 실패했습니다.")
        result["ok"] = True
        return result
    except (OSError, ValueError, RuntimeError, TypeError) as exc:
        problems.error("APPLY", str(exc), path_text(config_path))
        if result["written"] and backup_path is not None:
            result["rollback"] = restore_backup_and_reload(config_path, backup_path, log_path)
            if not result["rollback"].get("ok"):
                problems.error("ROLLBACK", "적용 실패 뒤 백업 복원 또는 reload 검증에도 실패했습니다.", path_text(config_path))
        return result


def apply_explicit_rollback(
    config_path: Path,
    current: JsonSnapshot,
    requested_backup: JsonSnapshot,
    log_path: Path | None,
    problems: Problems,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "attempted": True,
        "requestedBackupPath": path_text(requested_backup.path),
        "safetyBackupPath": None,
        "identity": {"beforeSha256": current.sha256, "rechecked": False},
        "restored": False,
        "reparse": False,
        "reload": None,
        "recovery": None,
        "ok": False,
    }
    safety_backup: Path | None = None
    try:
        # A rollback is still an --apply write.  Save the current file first so
        # a failed reload can restore exactly what was present at invocation.
        safety_backup = create_backup(config_path, "rollback")
        result["safetyBackupPath"] = path_text(safety_backup)
        if sha256_bytes(safety_backup.read_bytes()) != current.sha256:
            raise RuntimeError("rollback 안전 백업의 hash가 현재 config.json과 다릅니다.")
        rechecked = load_json_snapshot(config_path, "rollback 전 config.json")
        result["identity"]["rechecked"] = rechecked.sha256 == current.sha256
        result["identity"]["recheckedSha256"] = rechecked.sha256
        if rechecked.sha256 != current.sha256:
            raise RuntimeError("안전 백업 직후 config.json이 변경되어 rollback을 중단했습니다.")

        atomic_write_bytes(config_path, requested_backup.raw, rechecked.sha256)
        result["restored"] = True
        restored = load_json_snapshot(config_path, "복원된 config.json")
        result["reparse"] = True
        restoration_problems = Problems()
        if validate_config_document(restored.document, "복원된 config.json", restoration_problems, config_path) is None:
            for error in restoration_problems.errors:
                problems.errors.append(error)
            raise RuntimeError("복원된 config.json 구조 검증에 실패했습니다.")
        if restored.raw != requested_backup.raw:
            raise RuntimeError("복원된 config.json의 바이트가 지정 백업과 다릅니다.")

        result["reload"] = reload_and_verify(log_path)
        if not result["reload"].get("ok"):
            raise RuntimeError("rollback 뒤 paseo daemon reload 또는 신규 daemon log 검증에 실패했습니다.")
        result["ok"] = True
        return result
    except (OSError, ValueError, RuntimeError, TypeError) as exc:
        problems.error("ROLLBACK", str(exc), path_text(config_path))
        if result["restored"] and safety_backup is not None:
            result["recovery"] = restore_backup_and_reload(config_path, safety_backup, log_path)
            if not result["recovery"].get("ok"):
                problems.error("ROLLBACK_RECOVERY", "rollback 실패 뒤 안전 백업 복원 또는 reload 검증에도 실패했습니다.", path_text(config_path))
        return result


def emit_json(result: Mapping[str, Any]) -> None:
    payload = (json.dumps(result, ensure_ascii=False, allow_nan=False, sort_keys=True) + "\n").encode("utf-8")
    stream = getattr(sys.stdout, "buffer", None)
    if stream is not None:
        stream.write(payload)
        stream.flush()
    else:
        sys.stdout.write(payload.decode("utf-8"))
        sys.stdout.flush()


def stderr_line(text: str) -> None:
    payload = (text + "\n").encode("utf-8")
    stream = getattr(sys.stderr, "buffer", None)
    if stream is not None:
        stream.write(payload)
        stream.flush()
    else:
        sys.stderr.write(text + "\n")
        sys.stderr.flush()


def emit_human_summary(result: Mapping[str, Any]) -> None:
    changes = result.get("changes")
    change_text = ""
    if isinstance(changes, dict):
        final_length = changes.get("finalArrayLength")
        final_length_text = (
            f" 최종 배열 {final_length}건."
            if isinstance(final_length, int) and not isinstance(final_length, bool)
            else ""
        )
        change_text = (
            f" 요청 {changes.get('requested', 0)}건, 추가 {len(changes.get('add', []))}건, "
            f"교체 {len(changes.get('replace', []))}건.{final_length_text}"
        )
    stderr_line(
        f"Paseo 프로필 관리: {result.get('action', 'unknown')}; "
        f"오류 {len(result.get('errors', []))}건, 경고 {len(result.get('warnings', []))}건.{change_text}"
    )
    for item in result.get("errors", []):
        location = f" [{item['path']}]" if isinstance(item, dict) and item.get("path") else ""
        message = item.get("message", str(item)) if isinstance(item, dict) else str(item)
        stderr_line(f"오류{location}: {message}")
    for item in result.get("warnings", []):
        location = f" [{item['path']}]" if isinstance(item, dict) and item.get("path") else ""
        message = item.get("message", str(item)) if isinstance(item, dict) else str(item)
        stderr_line(f"경고{location}: {message}")


def base_result(args: argparse.Namespace | None) -> dict[str, Any]:
    return {
        "ok": False,
        "exitCode": EXIT_VALIDATION_ERROR,
        "action": "blocked",
        "dryRun": not bool(args and args.apply),
        "applyRequested": bool(args and args.apply),
        "configPath": None,
        "input": None,
        "changes": {"requested": 0, "add": [], "replace": [], "finalArrayLength": None},
        "backupPath": None,
        "reload": None,
        "errors": [],
        "warnings": [],
    }


def finish(result: dict[str, Any], problems: Problems, exit_code: int) -> int:
    result["errors"] = problems.errors
    result["warnings"] = problems.warnings
    result["exitCode"] = exit_code
    result["ok"] = exit_code == EXIT_OK
    emit_json(result)
    emit_human_summary(result)
    return exit_code


def resolve_argument_state(args: argparse.Namespace, problems: Problems) -> tuple[str | None, Path | None]:
    if args.rollback is not None and args.input_path is not None:
        problems.error("ARGUMENT", "--rollback은 프로필 INPUT과 함께 사용할 수 없습니다.")
    if args.rollback is not None and args.update:
        problems.error("ARGUMENT", "--rollback과 --update는 함께 사용할 수 없습니다.")
    source = args.input_path
    if source is None:
        source = "-"
    config_override = Path(args.config) if args.config else None
    return source, config_override


def execute_rollback(
    args: argparse.Namespace,
    result: dict[str, Any],
    problems: Problems,
    runtime: RuntimePaths,
    config_path: Path | None,
) -> int:
    result["input"] = None
    result["configPath"] = path_text(config_path)
    if config_path is None:
        problems.error("CONFIG_PATH", "config.json 경로를 결정할 수 없습니다.")
        return finish(result, problems, EXIT_VALIDATION_ERROR)

    current = load_snapshot_safely(config_path, "현재 config.json", problems)
    requested_backup = load_snapshot_safely(Path(args.rollback), "지정 rollback 백업", problems)
    if requested_backup is not None:
        validate_config_document(
            requested_backup.document, "지정 rollback 백업", problems, requested_backup.path
        )
        # Valid JSON with a daemon.agentProfiles array is not evidence that the
        # file belongs to this config.  Restoring an unrelated file would
        # replace every setting, so require a backup this script made here.
        if not is_script_backup_of(requested_backup.path, config_path):
            problems.error(
                "ROLLBACK_PROVENANCE",
                f"지정한 파일은 이 스크립트가 {path_text(config_path)} 옆에 만든 백업이 아닙니다. "
                f"같은 디렉터리에 있고 이름이 "
                f"'{config_path.name}.profile-setup.<{'|'.join(BACKUP_PURPOSES)}>."
                "<timestamp>.<uuid>.bak'인 파일만 복원할 수 있습니다.",
                path_text(requested_backup.path),
            )
    if current is not None:
        result["currentConfigSha256"] = current.sha256
    if requested_backup is not None:
        result["requestedBackupSha256"] = requested_backup.sha256
        result["requestedBackupPath"] = path_text(requested_backup.path)

    if problems.errors:
        return finish(result, problems, EXIT_VALIDATION_ERROR)

    assert current is not None
    assert requested_backup is not None
    if not args.apply:
        # No backup, write, or reload is reached on this branch.
        result["action"] = "rollback-dry-run"
        result["wouldRestore"] = path_text(requested_backup.path)
        return finish(result, problems, EXIT_OK)

    operation = apply_explicit_rollback(
        config_path, current, requested_backup, runtime.log_path, problems
    )
    result["rollback"] = operation
    result["backupPath"] = operation.get("safetyBackupPath")
    result["reload"] = operation.get("reload")
    if operation.get("ok"):
        result["action"] = "rolled-back"
        return finish(result, problems, EXIT_OK)
    result["action"] = "rollback-failed"
    return finish(result, problems, EXIT_APPLY_FAILURE)


def execute_profiles(
    args: argparse.Namespace,
    result: dict[str, Any],
    problems: Problems,
    runtime: RuntimePaths,
    config_path: Path | None,
    source: str,
) -> int:
    result["input"] = "stdin" if source == "-" else source
    result["configPath"] = path_text(config_path)
    profiles = load_input_profiles(source, problems)
    if config_path is None:
        problems.error("CONFIG_PATH", "paseo status의 home 또는 --config가 필요합니다.")
    config_snapshot = (
        load_snapshot_safely(config_path, "config.json", problems) if config_path is not None else None
    )
    existing_profiles = (
        validate_config_document(config_snapshot.document, "config.json", problems, config_path)
        if config_snapshot is not None
        else None
    )

    candidates: list[Candidate] = []
    if profiles is not None:
        result["changes"]["requested"] = len(profiles)
        candidates = validate_profile_shape(profiles, problems)
        validate_batch_duplicates(candidates, problems)

    provider_inventory = list_providers(problems)
    if profiles is not None:
        validate_provider_model_and_thinking(candidates, provider_inventory, problems)
    # Run even when other fields already failed: one run reports every
    # collision error before any --apply is considered.
    validate_conflicts(candidates, existing_profiles, args.update, problems)

    if problems.errors:
        return finish(result, problems, EXIT_VALIDATION_ERROR)
    assert config_snapshot is not None
    assert existing_profiles is not None
    plan = build_profile_plan(candidates, existing_profiles, args.update)
    result["changes"] = {
        "requested": len(candidates),
        "add": plan.added,
        "replace": plan.replaced,
        "finalArrayLength": len(plan.profiles),
        "wouldChange": plan.profiles != existing_profiles,
    }

    if not args.apply:
        result["action"] = "dry-run"
        return finish(result, problems, EXIT_OK)

    if plan.profiles == existing_profiles:
        result["action"] = "no-op"
        return finish(result, problems, EXIT_OK)

    planned_document = document_with_profiles(config_snapshot.document, plan.profiles)
    operation = apply_profile_plan(
        config_path,
        config_snapshot,
        planned_document,
        plan.profiles,
        runtime.log_path,
        problems,
    )
    result["apply"] = operation
    result["backupPath"] = operation.get("backupPath")
    result["reload"] = operation.get("reload")
    if operation.get("ok"):
        result["action"] = "applied"
        return finish(result, problems, EXIT_OK)
    result["action"] = "apply-failed"
    return finish(result, problems, EXIT_APPLY_FAILURE)


def main(argv: Sequence[str] | None = None) -> int:
    parser = make_parser()
    try:
        args = parser.parse_args(argv)
    except ValueError as exc:
        problems = Problems()
        problems.error("ARGUMENT", str(exc))
        return finish(base_result(None), problems, EXIT_VALIDATION_ERROR)

    problems = Problems()
    result = base_result(args)
    source, config_override = resolve_argument_state(args, problems)

    # Status is read-only.  Its home/logPath are the only runtime path source;
    # --config deliberately overrides only the config target for tests.
    runtime = discover_runtime_paths(
        problems,
        require_home=True,
        require_log_path=args.apply,
    )
    config_path = config_override
    if config_path is None and runtime.home is not None:
        config_path = runtime.home / "config.json"

    daemon_config_path = runtime.home / "config.json" if runtime.home is not None else None
    if args.apply and config_override is not None and daemon_config_path is not None:
        if path_text(config_override) != path_text(daemon_config_path):
            problems.warning(
                "CONFIG_OVERRIDE_RELOAD_LIMIT",
                "--config 대상에는 쓰지만 paseo daemon reload는 daemon이 실제 config.json을 다시 읽습니다. "
                "따라서 이 적용은 임시 config의 쓰기·복원 검증이지 end-to-end 반영 검증이 아닙니다.",
                path_text(config_override),
            )

    if args.rollback is not None:
        return execute_rollback(args, result, problems, runtime, config_path)
    return execute_profiles(args, result, problems, runtime, config_path, source)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        interrupted = base_result(None)
        problems = Problems()
        problems.error("INTERRUPTED", "사용자 인터럽트로 작업이 중단되었습니다.")
        raise SystemExit(finish(interrupted, problems, EXIT_APPLY_FAILURE))
    except Exception as exc:  # Ensure stdout remains one machine-readable JSON document.
        unexpected = base_result(None)
        problems = Problems()
        problems.error("UNEXPECTED", f"예상하지 못한 내부 오류: {exc}")
        raise SystemExit(finish(unexpected, problems, EXIT_APPLY_FAILURE))
