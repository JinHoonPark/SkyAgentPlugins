#!/usr/bin/env python3
"""config.json(디스크)과 daemon이 실제로 로드한 프로필을 대조한다.

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

# 프로필의 모든 필드를 본다. notes가 팀장 라우팅의 유일한 근거이므로
# 라우팅 필드만 맞고 notes가 어긋나면 프로필은 제 역할을 못 한다. 아래는 비교 순서를
# 정하기 위한 목록이고, 여기 없는 키도 양쪽 중 하나에 있으면 전부 비교한다.
REGISTRATION_FIELD_ORDER = (
    "id", "name", "provider", "model", "modeId", "thinkingOptionId",
    "notes", "icon", "color", "featureValues",
)


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


def cmd_registration(args) -> int:
    """디스크에 쓴 것과 daemon이 로드한 것이 같은가."""
    disk = {p.get("id"): p for p in extract_profiles(load_json(args.disk))}
    daemon = {p.get("id"): p for p in extract_profiles(load_json(args.daemon))}

    results = []
    for pid in sorted(set(disk) | set(daemon), key=lambda x: (x is None, str(x))):
        on_disk, loaded = disk.get(pid), daemon.get(pid)
        if on_disk is None:
            results.append({
                "id": pid, "passed": False, "kind": "daemon-only",
                "reason": "daemon에만 있고 config.json에 없다. 디스크 반영이 빠졌거나 다른 config를 읽고 있다.",
                "fields": [],
            })
            continue
        if loaded is None:
            results.append({
                "id": pid, "passed": False, "kind": "disk-only",
                "reason": "config.json에만 있고 daemon이 로드하지 않았다. reload가 안 됐을 수 있다.",
                "fields": [],
            })
            continue

        # 양쪽에 있는 모든 키를 비교한다. 알려진 키를 먼저, 나머지를 이름순으로 붙여
        # 스키마가 늘어나도 새 필드가 검증에서 빠지지 않게 한다.
        keys = [k for k in REGISTRATION_FIELD_ORDER if k in on_disk or k in loaded]
        keys += sorted((set(on_disk) | set(loaded)) - set(keys))

        fields = []
        for key in keys:
            if key == "featureValues":
                fields.append(diff(key, normalize_features(on_disk.get(key)),
                                   normalize_features(loaded.get(key))))
            else:
                fields.append(diff(key, on_disk.get(key), loaded.get(key)))

        bad = [f for f in fields if not f["match"]]
        results.append({
            "id": pid,
            "passed": not bad,
            "kind": "both",
            "reason": "" if not bad else "디스크 값과 daemon이 로드한 값이 다르다.",
            "fields": fields,
        })

    return emit("registration", results, args.json)


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
    parser = argparse.ArgumentParser(description="config.json과 daemon 로드 상태를 대조합니다.")
    parser.add_argument("--disk", required=True, help="manage_profiles.py --list --json 출력 경로. '-'면 stdin.")
    parser.add_argument("--daemon", required=True, help="MCP list_profiles 출력 경로. '-'면 stdin.")
    parser.add_argument("--json", action="store_true", help="사람이 읽는 요약 대신 JSON으로 출력합니다.")

    args = parser.parse_args()
    try:
        return cmd_registration(args)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        # 판정 실패는 진단으로 남기고 종료 코드로만 알린다. 세션을 중단시키지 않는다.
        print(f"오류: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
