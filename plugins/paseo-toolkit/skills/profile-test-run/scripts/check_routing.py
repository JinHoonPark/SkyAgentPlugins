#!/usr/bin/env python3
"""프로필 테스트의 결정론 판정(라우팅)을 계산한다.

routing  프로필 값과 실제로 뜬 에이전트의 런타임 값을 대조한다.

입력은 전부 JSON 파일 경로이며 `-`를 주면 stdin에서 읽는다.
종료 코드: 0 일치, 1 불일치 발견, 2 입력·실행 오류.
"""

from __future__ import annotations

import argparse
import json
import sys

# 한글 출력이 cp949 콘솔에서 깨지거나 UnicodeEncodeError로 죽지 않게 한다.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass


def load_json(path: str):
    """파일 또는 stdin에서 JSON을 읽는다."""
    if path == "-":
        return json.load(sys.stdin)
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def extract_profiles(payload) -> list[dict]:
    """프로필 배열을 꺼낸다.

    daemon(`list_profiles`)은 {"profiles": [...]}를 준다. 디스크 쪽
    `manage_profiles.py --list --json`의 최상위 형태는 이 스킬을 쓰는 환경에서
    직접 확인하지 못했으므로, 배열과 흔한 래핑 키를 모두 받아들인다.
    """
    if isinstance(payload, list):
        return [p for p in payload if isinstance(p, dict)]
    if isinstance(payload, dict):
        for key in ("profiles", "agentProfiles", "daemon.agentProfiles"):
            value = payload.get(key)
            if isinstance(value, list):
                return [p for p in value if isinstance(p, dict)]
            if isinstance(value, dict) and isinstance(value.get("agentProfiles"), list):
                return [p for p in value["agentProfiles"] if isinstance(p, dict)]
    raise ValueError("프로필 배열을 찾지 못했습니다. 배열이거나 profiles/agentProfiles 키가 있어야 합니다.")


def normalize_features(value) -> dict:
    """features를 {id: value} 맵으로 맞춘다.

    프로필의 `featureValues`는 객체({"fast_mode": true})지만
    `get_agent_status`의 `features`는 [{"id": ..., "value": ...}] 배열이다.
    두 형태가 그대로는 비교되지 않으므로 한쪽 모양으로 모은다.
    """
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, list):
        out = {}
        for item in value:
            if isinstance(item, dict) and "id" in item:
                out[item["id"]] = item.get("value")
        return out
    return {}


def diff(label: str, expected, actual) -> dict:
    return {
        "field": label,
        "expected": expected,
        "actual": actual,
        "match": expected == actual,
    }


def cmd_routing(args) -> int:
    """축1 — 프로필이 요구한 런타임 값으로 실제 에이전트가 떴는가."""
    profiles = {p.get("id"): p for p in extract_profiles(load_json(args.daemon))}
    profile = profiles.get(args.profile_id)
    if profile is None:
        print(f"오류: 프로필 id '{args.profile_id}'를 찾지 못했습니다.", file=sys.stderr)
        return 2

    status = load_json(args.status)
    snap = status.get("snapshot", status) if isinstance(status, dict) else {}

    fields = [
        diff("provider", profile.get("provider"), snap.get("provider")),
        diff("model", profile.get("model"), snap.get("model")),
    ]

    # 프로필이 선언한 키만 판정한다. 선언하지 않은 것은 provider 기본값이므로
    # 불일치가 아니라 참고 정보로 남긴다.
    undeclared_settings = {}
    actual_mode = (snap.get("runtimeInfo") or {}).get("modeId") or snap.get("currentModeId")
    if "modeId" in profile:
        fields.append(diff("modeId", profile.get("modeId"), actual_mode))
    else:
        undeclared_settings["modeId"] = actual_mode

    actual_thinking = snap.get("thinkingOptionId")
    if "thinkingOptionId" in profile:
        fields.append(diff("thinkingOptionId", profile.get("thinkingOptionId"), actual_thinking))
        # 요청은 반영됐는데 실효값이 다른 경우는 따로 잡아야 원인이 보인다.
        effective = snap.get("effectiveThinkingOptionId")
        if effective is not None and effective != actual_thinking:
            fields.append(diff("effectiveThinkingOptionId", actual_thinking, effective))
    else:
        undeclared_settings["thinkingOptionId"] = actual_thinking

    wanted = normalize_features(profile.get("featureValues"))
    actual = normalize_features(snap.get("features"))
    for key, value in wanted.items():
        fields.append(diff(f"features.{key}", value, actual.get(key)))
    undeclared_features = {k: v for k, v in actual.items() if k not in wanted}

    bad = [f for f in fields if not f["match"]]
    result = {
        "id": args.profile_id,
        "agentId": snap.get("id"),
        "passed": not bad,
        "reason": "" if not bad else "프로필 값과 실제 런타임 값이 다르다.",
        "fields": fields,
        "undeclaredFeatures": undeclared_features,
        "undeclaredSettings": undeclared_settings,
    }
    return emit("routing", [result], args.json)


def emit(axis: str, results: list[dict], as_json: bool) -> int:
    failed = [r for r in results if not r["passed"]]
    if as_json:
        print(json.dumps(
            {"axis": axis, "results": results,
             "summary": {"passed": len(results) - len(failed), "failed": len(failed), "total": len(results)}},
            ensure_ascii=False, indent=2))
    else:
        for r in results:
            mark = "PASS" if r["passed"] else "FAIL"
            print(f"[{mark}] {r['id']}" + (f" — {r['reason']}" if r["reason"] else ""))
            for f in r.get("fields", []):
                if not f["match"]:
                    print(f"       {f['field']}: 기대 {f['expected']!r} → 실제 {f['actual']!r}")
        print(f"\n{axis}: {len(results) - len(failed)}/{len(results)} 통과")
    return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="프로필 테스트의 결정론 판정(라우팅)을 계산합니다.")
    parser.add_argument("--json", action="store_true", help="사람이 읽는 요약 대신 JSON으로 출력합니다.")
    sub = parser.add_subparsers(dest="command", required=True)

    route = sub.add_parser("routing", help="프로필 값과 실제 에이전트 런타임 값을 대조합니다.")
    route.add_argument("--daemon", required=True, help="MCP list_profiles 출력 경로. '-'면 stdin.")
    route.add_argument("--status", required=True, help="MCP get_agent_status 출력 경로. '-'면 stdin.")
    route.add_argument("--profile-id", required=True, help="대조할 프로필 id.")
    route.add_argument("--json", action="store_true", help=argparse.SUPPRESS)
    route.set_defaults(func=cmd_routing)

    args = parser.parse_args()
    try:
        return args.func(args)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        # 판정 실패는 진단으로 남기고 종료 코드로만 알린다. 세션을 중단시키지 않는다.
        print(f"오류: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
