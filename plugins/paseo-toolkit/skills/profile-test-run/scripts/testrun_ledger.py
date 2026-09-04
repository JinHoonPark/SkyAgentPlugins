#!/usr/bin/env python3
"""프로필 테스트 진행 상태를 들고 있다가 보고 form을 그린다.

에이전트를 띄우는 것은 MCP `create_agent`이므로 이 스크립트가 하지 않는다.
이 스크립트는 대기·실행·완료를 세어 동시 실행 상한을 지키게 하고, 세 축의
판정을 모아 두었다가 마지막에 form 하나로 출력한다. 긴 실행 도중 맥락이
잘려도 상태가 파일에 남아 있어 이어서 진행할 수 있다.

종료 코드: 0 정상, 2 입력·실행 오류.
"""

from __future__ import annotations

import argparse
import ast
import json
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

# 동시 실행 상한은 사용자가 정한 제약이라 옵션으로 넘길 수 없다. 더 작은 값은
# 부하를 줄이려는 선택이므로 허용하고, 더 큰 값은 이 값으로 끌어내린다.
HARD_CAP = 5
MAX_CONCURRENT = HARD_CAP
RULE = "━" * 16


def clamp_concurrency(value, *, quiet: bool = False) -> int:
    """상한을 넘는 값을 HARD_CAP으로 끌어내린다. 상태 파일을 손으로 고쳐도 뚫리지 않게
    설정할 때와 읽을 때 양쪽에서 건다."""
    try:
        number = int(value)
    except (TypeError, ValueError):
        return HARD_CAP
    if number < 1:
        if not quiet:
            print(f"경고: 동시 실행 상한 {number}은 1보다 작아 1로 올립니다.", file=sys.stderr)
        return 1
    if number > HARD_CAP:
        if not quiet:
            print(f"경고: 동시 실행 상한 {number}은 허용치를 넘어 {HARD_CAP}으로 제한합니다.",
                  file=sys.stderr)
        return HARD_CAP
    return number

# 품질 상세 표의 열 폭. 넘치는 칸은 잘리지 않고 다음 줄로 흐른다.
ITEM_WIDTH = 34
EVIDENCE_WIDTH = 40

# icon → 이모지 매핑은 플러그인 공용 manage_profiles.py가 원본이다. 같은 프로필이
# 두 스킬에서 다른 이모지로 보이면 안 되므로 값을 베끼지 않고 그 파일에서 읽어온다.
MAPPING_SOURCE = (Path(__file__).resolve().parents[3]
                  / "scripts" / "manage_profiles.py")
# 심판 프롬프트에 실을 루브릭의 원천. 이 스킬 안의 참조 문서다.
BRIEF_DOC = Path(__file__).resolve().parent.parent / "references" / "judge-brief.md"
FALLBACK_ICON_EMOJI = {"search": "🔍", "flask": "🧪", "eye": "👁️", "code": "💻",
                       "terminal": "⌨️", "bug": "🐛", "pencil": "📝",
                       "fileText": "📄", "boxes": "🗃️", "layers": "🗂️", "compass": "🧭"}
FALLBACK_DEFAULT_EMOJI = "🔹"


_ICON_CACHE: tuple[dict, str] | None = None


def load_icon_emoji() -> tuple[dict, str]:
    """manage_profiles.py에서 ICON_EMOJI와 기본값을 정적으로 읽는다.

    import하지 않고 ast로 상수만 꺼낸다. 그 파일은 CLI라 import하면 top-level이
    실행되고, 다른 작업이 그 파일을 고치는 중이면 실행이 실패할 수 있다. 상수만
    읽으면 그런 영향을 받지 않는다. 읽지 못하면 축소된 사본으로 폴백하되,
    폴백이 조용히 일어나면 두 스킬의 이모지가 어긋난 것을 아무도 모르므로
    발동 이유를 stderr에 남긴다. stdout은 보고 form이 쓰므로 건드리지 않는다.
    """
    global _ICON_CACHE
    if _ICON_CACHE is not None:
        return _ICON_CACHE

    def fallback(reason: str) -> tuple[dict, str]:
        print(f"경고: icon 이모지 매핑을 {MAPPING_SOURCE.name}에서 읽지 못해 축소된 사본을 씁니다 "
              f"({reason}). profile-setup과 이모지가 다를 수 있습니다.", file=sys.stderr)
        return dict(FALLBACK_ICON_EMOJI), FALLBACK_DEFAULT_EMOJI

    try:
        tree = ast.parse(MAPPING_SOURCE.read_text(encoding="utf-8"))
    except OSError as exc:
        _ICON_CACHE = fallback(f"파일을 열 수 없음: {exc.__class__.__name__}")
        return _ICON_CACHE
    except (SyntaxError, ValueError) as exc:
        _ICON_CACHE = fallback(f"파싱 실패: {exc.__class__.__name__}")
        return _ICON_CACHE

    mapping, default = None, None
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if not isinstance(target, ast.Name):
                continue
            try:
                if target.id == "ICON_EMOJI":
                    mapping = ast.literal_eval(node.value)
                elif target.id == "DEFAULT_PROFILE_ICON_EMOJI":
                    default = ast.literal_eval(node.value)
            except ValueError:
                pass  # 상수가 리터럴이 아니면 아래 타입 검사에서 폴백으로 걸린다.

    if mapping is None:
        _ICON_CACHE = fallback("ICON_EMOJI 상수가 없음")
    elif not isinstance(mapping, dict):
        _ICON_CACHE = fallback(f"ICON_EMOJI가 dict가 아님: {type(mapping).__name__}")
    elif not isinstance(default, str) or not default:
        # 매핑은 살아 있으니 그것만 쓰고 기본 이모지는 자체 값으로 채운다.
        print(f"경고: DEFAULT_PROFILE_ICON_EMOJI를 {MAPPING_SOURCE.name}에서 읽지 못해 "
              f"'{FALLBACK_DEFAULT_EMOJI}'를 씁니다.", file=sys.stderr)
        _ICON_CACHE = (mapping, FALLBACK_DEFAULT_EMOJI)
    else:
        _ICON_CACHE = (mapping, default)
    return _ICON_CACHE


def profile_emoji(icon) -> str:
    """icon이 없거나 매핑에 없으면 기본 이모지를 준다. 빈 문자열로 두면 정렬이 어긋난다."""
    mapping, default = load_icon_emoji()
    return mapping.get(icon, default) if isinstance(icon, str) else default


# 이모지 조합에 쓰이는 코드포인트. 이것들은 앞 글자에 붙어 한 글자를 이룬다.
_ZWJ = 0x200D
_SKIN_TONES = range(0x1F3FB, 0x1F400)
_KEYCAP = 0x20E3
_VARIATION = (0xFE0E, 0xFE0F)
_REGIONAL = range(0x1F1E6, 0x1F200)


def _clusters(text: str):
    """문자열을 grapheme cluster로 끊는다.

    폭은 글자 단위가 아니라 눈에 보이는 덩어리 단위로 세야 맞다. `⌨️`는 기본 문자
    U+2328(폭 1로 표기됨)에 변이 선택자가 붙어 두 칸으로 그려지고, ZWJ로 이어 붙인
    가족 이모지나 피부색이 붙은 이모지는 여러 코드포인트가 한 칸 덩어리다.
    """
    chars, i, n = list(text), 0, len(text)
    while i < n:
        start = i
        i += 1
        # 국기: 지역 표시자 두 개가 한 덩어리다.
        if ord(chars[start]) in _REGIONAL and i < n and ord(chars[i]) in _REGIONAL:
            i += 1
        while i < n:
            cp = ord(chars[i])
            if (cp in _VARIATION or cp == _KEYCAP or cp in _SKIN_TONES
                    or unicodedata.category(chars[i]) in ("Mn", "Me")):
                i += 1
            elif cp == _ZWJ and i + 1 < n:
                i += 2  # ZWJ와 그 뒤에 이어지는 글자까지 같은 덩어리다.
            else:
                break
        yield "".join(chars[start:i])


def _cluster_width(cluster: str) -> int:
    """덩어리 하나의 표시 폭."""
    base = cluster[0]
    cp = ord(base)
    # 변이 선택자 FE0F가 붙으면 이모지 표현이라 두 칸이다(⌨️·❤️·1️⃣가 여기 해당).
    if any(ord(ch) == 0xFE0F for ch in cluster):
        return 2
    if ord(cluster[-1]) == _KEYCAP or any(ord(ch) in _SKIN_TONES for ch in cluster):
        return 2
    if any(ord(ch) == _ZWJ for ch in cluster) or cp in _REGIONAL:
        return 2
    # 제어문자와 결합 문자는 자리를 차지하지 않는다.
    if unicodedata.category(base) in ("Mn", "Me", "Cf", "Cc"):
        return 0
    if unicodedata.east_asian_width(base) in ("W", "F") or cp >= 0x1F300:
        return 2
    return 1


def dwidth(text: str) -> int:
    """터미널 표시 폭. 한글·전각·이모지는 두 칸, 결합 문자는 앞 글자에 흡수된다."""
    return sum(_cluster_width(c) for c in _clusters(str(text)))


def wrap_cells(text: str, width: int) -> list[str]:
    """표시 폭 기준으로 줄바꿈한다. 근거를 잘라내면 판정의 근거가 사라지므로 흘린다."""
    text = str(text or "")
    if not text:
        return [""]
    lines, current = [], ""
    for word in text.split():
        candidate = f"{current} {word}".strip()
        if dwidth(candidate) <= width:
            current = candidate
            continue
        if current:
            lines.append(current)
        # 한 낱말이 열보다 길면 쪼갠다. 코드포인트가 아니라 grapheme cluster 단위로
        # 끊어야 `❤️`나 `1️⃣` 같은 덩어리가 줄 경계에서 갈라지지 않는다.
        piece = ""
        for cluster in _clusters(word):
            if piece and dwidth(piece + cluster) > width:
                lines.append(piece)
                piece = cluster
            else:
                piece += cluster
        current = piece
    if current:
        lines.append(current)
    return lines or [""]


def pad(text: str, width: int) -> str:
    """표시 폭 기준으로 오른쪽을 채운다. len()으로는 한글 열이 어긋난다."""
    return str(text) + " " * max(0, width - dwidth(text))


def load_json(path: str):
    if path == "-":
        return json.load(sys.stdin)
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def read_state(path: str) -> dict:
    return load_json(path)


def write_state(path: str, state: dict) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2)


def find(state: dict, profile_id: str) -> dict:
    for entry in state["profiles"]:
        if entry["id"] == profile_id:
            return entry
    raise ValueError(f"상태 파일에 프로필 id '{profile_id}'가 없습니다.")


def extract_profiles(payload) -> list[dict]:
    """프로필 배열을 꺼낸다. daemon과 디스크의 최상위 형태가 달라 둘 다 받는다."""
    if isinstance(payload, list):
        return [p for p in payload if isinstance(p, dict)]
    if isinstance(payload, dict):
        for key in ("profiles", "agentProfiles"):
            value = payload.get(key)
            if isinstance(value, list):
                return [p for p in value if isinstance(p, dict)]
    raise ValueError("프로필 배열을 찾지 못했습니다. 배열이거나 profiles/agentProfiles 키가 있어야 합니다.")


def cmd_init(args) -> int:
    # 기존 원장을 덮어쓰면 제외·판정 불가로 끝난 항목을 큐로 되돌릴 수 있다.
    # 새 테스트는 새 state 경로에서 시작해야 한다.
    existing = read_state(args.state) if Path(args.state).exists() else None
    reason = validate_ledger_change(
        existing, None, command="init", changes={"values": {"profiles": True}, "findings": []},
    )
    if reason:
        print(f"오류: {reason}", file=sys.stderr)
        return 2

    daemon = {p.get("id"): p for p in extract_profiles(load_json(args.daemon))}

    # 큐를 daemon 기준으로만 만들면 config.json에만 있는 프로필이 ledger에 없어
    # 등록 실패인데도 보고에서 통째로 빠진다. 합집합으로 만들어 그런 증발을 막는다.
    if args.disk:
        disk = {p.get("id"): p for p in extract_profiles(load_json(args.disk))}
    else:
        disk = {}
        print("경고: --disk가 없어 config.json 쪽을 대조하지 못합니다. "
              "등록 검증(축1)은 '판정 불가'로 남습니다.", file=sys.stderr)

    entries = []
    for pid in sorted(set(daemon) | set(disk), key=lambda x: (x is None, str(x))):
        in_daemon, in_disk = pid in daemon, pid in disk
        source = "both" if (in_daemon and in_disk) else ("daemon-only" if in_daemon else "disk-only")
        base = daemon.get(pid) or disk.get(pid) or {}
        entry = {
            "id": pid, "name": base.get("name") or pid, "icon": base.get("icon"),
            "notes": base.get("notes", ""), "source": source,
            "state": "queued", "agentId": None, "blocked": None,
            "registration": None, "routing": None, "quality": None,
            "unresolved": None, "findings": [],
        }
        # 한쪽에만 있다는 것 자체가 등록 검증 실패다. 이 판정은 init이 소유한다.
        # 나중에 record --registration-file이 같은 finding을 다시 넣지 않게 막는다.
        if source != "both" and args.disk:
            entry["registration"] = "FAIL"
            entry["findings"].append({
                "axis": "registration",
                "text": ("config.json에만 있고 daemon이 로드하지 않았다. reload가 안 됐을 수 있다."
                         if source == "disk-only"
                         else "daemon에만 있고 config.json에 없다. 디스크 반영이 빠졌거나 다른 config를 읽고 있다."),
            })
            # 한쪽에만 있는 프로필은 띄울 수 없다. daemon에 없으면 프로필 값을 못 읽고,
            # 디스크에 없으면 테스트해도 설정에 남지 않는다. 실행 대상에서 빼되
            # 보고에는 남겨야 하므로 별도 상태로 표시하고 사유를 붙인다.
            # blocked는 init에서만 서고 이후 어떤 호출로도 풀리지 않는다. 등록이 깨진
            # 프로필이 뒤늦은 기록으로 PASS처럼 보이는 것을 막는 불변식이다.
            entry["state"] = "excluded"
            entry["blocked"] = source
            entry["unresolved"] = ("한쪽에만 등록돼 있어 에이전트를 띄우지 못했다"
                                   f" ({source}). 등록을 맞춘 뒤 다시 테스트한다.")
        entries.append(entry)

    if args.only:
        wanted = [x.strip() for x in args.only.split(",") if x.strip()]
        known = {e["id"] for e in entries}
        missing = [w for w in wanted if w not in known]
        if missing:
            # 목록에 없는 것을 조용히 버리면 사용자는 테스트된 줄 안다.
            print(f"오류: 목록에 없는 프로필 id: {', '.join(missing)}", file=sys.stderr)
            print(f"      사용 가능: {', '.join(sorted(x for x in known if x))}", file=sys.stderr)
            return 2
        entries = [e for e in entries if e["id"] in wanted]

    cap = clamp_concurrency(args.max_concurrent)
    state = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "maxConcurrent": cap,
        "requested": len(entries),
        "profiles": entries,
    }
    write_state(args.state, state)
    runnable = [e for e in entries if e["state"] == "queued"]
    print(f"프로필 {len(entries)}개 중 {len(runnable)}개를 큐에 넣었습니다. 동시 실행 상한 {cap}개.")
    print("대상: " + ", ".join(str(e["id"]) for e in runnable))
    odd = [e for e in entries if e["source"] != "both"]
    if odd and args.disk:
        print("한쪽에만 등록돼 등록 검증 실패, 실행 대상에서 제외: "
              + ", ".join(f"{e['id']}({e['source']})" for e in odd))
    elif odd:
        # --disk가 없으면 대조 자체를 못 했으므로 실패라고 부르면 안 된다.
        print("등록 검증 미판정(--disk 없음): " + ", ".join(str(e["id"]) for e in odd))
    return 0


def cmd_next(args) -> int:
    """상한을 넘지 않는 선에서 지금 띄울 프로필을 알려준다."""
    state = read_state(args.state)
    # 상태 파일에 적힌 값도 다시 건다. 손으로 고쳐 상한을 넘겨도 통하지 않게 한다.
    cap = clamp_concurrency(state.get("maxConcurrent", MAX_CONCURRENT))
    running = [p for p in state["profiles"] if p["state"] == "running"]
    queued = [p for p in state["profiles"] if p["state"] == "queued"]
    # 판정 불가로 끝난 항목은 슬롯은 돌려주지만 완료 수에는 넣지 않는다.
    done = [p for p in state["profiles"]
            if p["state"] == "done" and not p.get("unresolved")]
    unresolved = [p for p in state["profiles"]
                  if p["state"] == "done" and p.get("unresolved")]
    excluded = [p for p in state["profiles"] if p["state"] == "excluded"]

    slots = max(0, cap - len(running))
    launch = queued[:slots]

    # 실행하고 끝난 것과 애초에 실행 대상이 아닌 것을 따로 센다. 둘을 합쳐 세면
    # 돌지도 않은 프로필이 완료로 집계돼 숫자가 사실과 어긋난다.
    line = f"실행 중 {len(running)}/{cap} · 대기 {len(queued)} · 완료 {len(done)}"
    if unresolved:
        line += f" · 판정 불가 {len(unresolved)}"
    if excluded:
        line += f" · 실행 대상 아님 {len(excluded)}"
    print(line)
    if not queued and not running:
        print("남은 작업이 없습니다. report로 넘어가세요.")
    elif not queued:
        print("대기 중인 프로필이 없습니다. 실행 중인 에이전트의 완료 알림을 기다리세요.")
    elif not launch:
        print("빈 자리가 없습니다. 하나가 끝나 자리가 나면 다시 부르세요.")
    else:
        print("지금 띄울 프로필: " + ", ".join(p["id"] for p in launch))
    return 0


def validate_ledger_change(state: dict | None, entry: dict | None, *, command: str,
                           changes: dict) -> str | None:
    """원장 상태 전이와 결과 기록을 한 곳에서 검증한다.

    각 진입부는 외부 파일을 읽어 변경 계획만 만든 뒤 이 함수를 통과한 계획만 반영한다.
    그래서 종료 뒤 재실행·재기록과 상충하는 결과 플래그가 명령마다 다르게 열리지 않는다.
    """
    if command == "init":
        if state is not None:
            return "기존 원장을 덮어쓸 수 없습니다. 새 --state 경로로 테스트를 다시 시작하세요."
        return None

    if entry is None:
        return "변경할 프로필 항목이 없습니다."

    has_changes = bool(changes.get("values") or changes.get("findings"))
    if entry.get("state") == "excluded" or entry.get("blocked"):
        terminal = "등록 검증 실패로 집계에서 제외된 상태"
    elif entry.get("state") == "done" and entry.get("unresolved"):
        terminal = "판정 불가로 종료된 상태"
    elif entry.get("state") == "done":
        terminal = "완료로 종료된 상태"
    else:
        terminal = None
    if terminal and has_changes:
        return f"'{entry['id']}'은 {terminal}라 상태나 기록을 바꿀 수 없습니다."

    if command == "launched":
        if entry.get("state") != "queued":
            return f"'{entry['id']}'은 queued 상태에서만 띄울 수 있습니다 (현재 {entry.get('state')!r})."
        cap = clamp_concurrency(state.get("maxConcurrent", MAX_CONCURRENT))
        running = sum(p.get("state") == "running" for p in state["profiles"])
        if running >= cap:
            return f"동시 실행 상한 {cap}개에 도달해 '{entry['id']}'을 띄울 수 없습니다."
        return None

    if command == "record":
        sources = changes.get("sources", {})
        if len(sources.get("registration", [])) > 1:
            return "등록 판정은 --registration 또는 --registration-file 중 하나만 지정하세요."
        if len(sources.get("routing", [])) > 1:
            return "라우팅 판정은 --routing 또는 --routing-file 중 하나만 지정하세요."

        requested = changes.get("requested", {})
        if requested.get("quality") and requested.get("unresolved"):
            return "품질 채점과 --unresolved는 한 명령에 함께 기록할 수 없습니다."

        # 판정은 축마다 한 번만 반영한다. 맥락이 잘린 뒤 이어서 진행하다 같은 축을
        # 다시 기록하는 것은 예상된 흐름이라, 값이 같아도(PASS→PASS) 다시 뒤집는
        # 방향이어도(FAIL→PASS) 조용히 통과시키면 먼저 기록된 판정과 그 finding이
        # 새 값에 말없이 덮인다. --unresolved가 품질을 지우는 것은 이 축 자체를
        # 다시 겨냥한 것이 아니라 종료 판정이 채점을 대신하는 것이라 여기 걸리지 않는다.
        attempted_axis = {
            "registration": bool(sources.get("registration")),
            "routing": bool(sources.get("routing")),
            "quality": bool(requested.get("quality")),
        }
        already_recorded = [f"{axis}={entry.get(axis)!r}"
                            for axis, wants in attempted_axis.items()
                            if wants and entry.get(axis) is not None]
        if already_recorded:
            return (f"'{entry['id']}'은 이미 판정이 있는 축을 다시 기록할 수 없습니다: "
                    f"{', '.join(already_recorded)}.")

        needs_running = any(requested.get(key)
                            for key in ("routing", "quality", "unresolved", "done"))
        if needs_running and entry.get("state") != "running":
            return (f"'{entry['id']}'의 라우팅·품질·종료 기록은 running 상태에서만 가능합니다 "
                    f"(현재 {entry.get('state')!r}).")
    return None


def cmd_launched(args) -> int:
    state = read_state(args.state)
    entry = find(state, args.profile_id)
    changes = {"values": {"state": "running", "agentId": args.agent_id}, "findings": []}
    reason = validate_ledger_change(state, entry, command="launched", changes=changes)
    if reason:
        print(f"오류: '{args.profile_id}'는 띄울 수 없습니다 — {reason}", file=sys.stderr)
        return 2
    entry.update(changes["values"])
    write_state(args.state, state)
    print(f"{args.profile_id} → running (agent {args.agent_id})")
    return 0


def axis_result_for_profile(path: str, *, axis: str, profile_id: str,
                            expected_agent_id: str | None = None) -> tuple[dict | None, str | None]:
    """축 결과 파일에서 이 프로필의 항목을 찾는다. 못 찾으면 항목 대신 사유를 돌려준다.

    check_routing.py의 출력은 {"axis": ..., "results": [{"id": ..., ...}]} 형태다. 파일이
    다른 축에서 나왔거나 다른 프로필의 것이면 값은 그럴듯해 보여도 이 판정의 근거가
    아니다. registration-file과 routing-file 양쪽이 이 함수 하나로 대조하므로 기준이
    갈라지지 않는다.

    axis="routing"은 실제로 뜬 에이전트를 측정한 결과라 결과 항목에 agentId가 함께
    실린다. expected_agent_id(launched로 ledger에 기록된 그 프로필의 agentId)와 다르면
    다른 에이전트를 측정한 결과이고, 결과 항목에 agentId 자체가 없으면 무엇을 측정했는지
    알 수 없다 — cmd_brief가 활동 기록의 출처를 agentId로 대조해 거부하는 것과 같은
    기준이다. axis="registration"은 에이전트를 띄우기 전에 판정하므로 agentId가 없고,
    이 대조를 하지 않는다.
    """
    payload = load_json(path)
    if not isinstance(payload, dict):
        return None, f"{path}: 최상위가 객체가 아닙니다 ({type(payload).__name__})."

    got_axis = payload.get("axis")
    results = payload.get("results")
    ids = (sorted({r.get("id") for r in results if isinstance(r, dict)}, key=lambda x: (x is None, str(x)))
           if isinstance(results, list) else [])

    if got_axis != axis:
        return None, (f"{path}: 축이 다릅니다. 기대 axis={axis!r} profile={profile_id!r} → "
                      f"실제 axis={got_axis!r} profile={ids!r}.")
    if not ids:
        return None, f"{path}: results가 비어 있습니다. 판정을 만들 근거가 없습니다."

    mine = [r for r in results if isinstance(r, dict) and r.get("id") == profile_id]
    if not mine:
        return None, (f"{path}: 프로필 id가 다릅니다. 기대 axis={axis!r} profile={profile_id!r} → "
                      f"실제 axis={got_axis!r} profile={ids!r}.")

    if axis == "routing":
        actual_agent_id = mine[0].get("agentId")
        if not actual_agent_id:
            return None, (f"{path}: 결과 항목에 agentId가 없습니다. 어느 에이전트를 측정했는지 "
                          f"알 수 없어 받지 않습니다.")
        if actual_agent_id != expected_agent_id:
            return None, (f"{path}: agentId가 ledger와 다릅니다. 기대 agentId={expected_agent_id!r} → "
                          f"실제 agentId={actual_agent_id!r}. 다른 에이전트를 측정한 결과입니다.")

    return mine[0], None


def cmd_record(args) -> int:
    state = read_state(args.state)
    entry = find(state, args.profile_id)

    # 외부 입력을 읽는 동안에는 entry를 건드리지 않는다. 모든 결과를 계획에 모은 뒤
    # 중앙 가드가 수용한 경우에만 마지막에 한 번 반영해야 복합 플래그도 원자적이다.
    changes = {
        "values": {}, "findings": [],
        "sources": {
            "registration": [name for name, present in (
                ("--registration", bool(args.registration)),
                ("--registration-file", bool(args.registration_file)),
            ) if present],
            "routing": [name for name, present in (
                ("--routing", bool(args.routing)),
                ("--routing-file", bool(args.routing_file)),
            ) if present],
        },
        "requested": {
            "routing": bool(args.routing or args.routing_file),
            "quality": bool(args.quality_file),
            "unresolved": bool(args.unresolved),
            "done": bool(args.done),
        },
    }

    if args.registration_file:
        mine, error = axis_result_for_profile(args.registration_file, axis="registration",
                                              profile_id=args.profile_id)
        if error:
            print(f"오류: {error}", file=sys.stderr)
            return 2
        changes["values"]["registration"] = "PASS" if mine.get("passed") else "FAIL"
        bad = [f for f in mine.get("fields", []) if not f.get("match")]
        for field in bad:
            changes["findings"].append({
                "axis": "registration", "field": field.get("field"),
                "expected": field.get("expected"), "actual": field.get("actual"),
            })
        # 한쪽에만 있는 경우의 사유는 init이 이미 기록했다. 여기서 또 넣으면 같은
        # finding이 두 건이 된다. 양쪽에 있는데 필드 비교가 비어 있을 때만 남긴다.
        if not mine.get("passed") and not bad and entry.get("source") == "both":
            changes["findings"].append({"axis": "registration", "text": mine.get("reason", "")})
    elif args.registration:
        changes["values"]["registration"] = args.registration

    if args.routing_file:
        mine, error = axis_result_for_profile(args.routing_file, axis="routing",
                                              profile_id=args.profile_id,
                                              expected_agent_id=entry.get("agentId"))
        if error:
            print(f"오류: {error}", file=sys.stderr)
            return 2
        changes["values"]["routing"] = "PASS" if mine.get("passed") else "FAIL"
        for field in mine.get("fields", []):
            if not field.get("match"):
                changes["findings"].append({
                    "axis": "routing", "field": field.get("field"),
                    "expected": field.get("expected"), "actual": field.get("actual"),
                })
    elif args.routing:
        changes["values"]["routing"] = args.routing

    if args.quality_file:
        verdict = load_json(args.quality_file)
        problems = validate_quality(verdict)
        if problems:
            # 형식이 어긋난 채점을 그대로 실으면 9.0/5 같은 값이 보고에 나간다.
            print(f"오류: 심판 채점 JSON이 규격에 맞지 않습니다 ({args.quality_file}):", file=sys.stderr)
            for problem in problems:
                print(f"  - {problem}", file=sys.stderr)
            print("  references/judge-brief.md의 출력 규격을 확인하세요.", file=sys.stderr)
            return 2
        changes["values"]["quality"] = verdict

    if args.unresolved:
        # 중단·회수 실패도 종료로 기록해 슬롯을 돌려준다. 판정 불가는 품질보다 우선하므로
        # 먼저 들어와 있던 채점을 지운다. 위의 거부 규칙과 짝이 되어 순서를 무의미하게 만든다.
        changes["values"].update({"unresolved": args.unresolved, "quality": None, "state": "done"})

    if args.note:
        changes["findings"].append({"axis": "note", "text": args.note})

    if args.done:
        changes["values"]["state"] = "done"

    reason = validate_ledger_change(state, entry, command="record", changes=changes)
    if reason:
        print(f"오류: {reason}", file=sys.stderr)
        return 2

    entry.update(changes["values"])
    entry["findings"].extend(changes["findings"])

    write_state(args.state, state)
    print(f"{args.profile_id} 기록됨" + (" (done)" if args.done else ""))
    return 0


council = """너는 심판이다. Paseo 프로필 하나가 자기 notes가 약속한 일을 해냈는지 채점한다.

채점 대상 프로필: {pid} ({name})

이 프로필의 notes 원문 — 채점 기준은 전적으로 이 문장이다:
{notes}

이 프로필로 띄운 에이전트에게 준 지시:
{probe}

--- 활동 기록 시작 (출처: agentId {agent_id} / 회수 시각 {retrieved_at}) ---
{activity}
--- 활동 기록 끝 ---

이 기록은 에이전트가 실제로 한 일이지, 스스로 잘했다고 주장한 보고가 아니다.
기록에 없는 것은 일어나지 않은 것으로 본다. 위 구분선 밖의 내용은 채점 근거가 아니다.

아래에 채점 기준과 출력 규격을 그대로 실어 둔다. 파일을 열 필요가 없다.

{rubric}

{spec}

결과 JSON을 다음 경로에 저장한다: {result_path}
본문에는 두 점수와 한 줄 총평만 적는다.
"""


def extract_sections(titles: list[str]) -> str:
    """judge-brief.md에서 지정한 절을 그대로 떼어 온다.

    심판은 다른 세션에서 뜨므로 이 저장소의 상대 경로가 해석되지 않는다. 그래서
    루브릭을 프롬프트에 직접 실어야 하는데, 문구를 스크립트에 복사해 두면 문서와
    두 벌이 되어 갈라진다. 문서를 원천으로 두고 필요한 절만 읽어 붙인다.
    """
    text = BRIEF_DOC.read_text(encoding="utf-8")
    lines = text.splitlines()

    def heading_level(line: str) -> int:
        """Markdown 제목의 단계. 세 칸까지 들여써도 제목이므로 경계로 인정한다."""
        if len(line) - len(line.lstrip(" ")) > 3:
            return 0
        stripped = line.lstrip(" ")
        hashes = len(stripped) - len(stripped.lstrip("#"))
        return hashes if hashes and stripped[hashes:hashes + 1] in (" ", "") else 0

    chunks = []
    for title in titles:
        start = None
        for i, line in enumerate(lines):
            if heading_level(line) == 2 and line.strip().lstrip("#").strip() == title:
                start = i
                break
        if start is None:
            raise ValueError(f"{BRIEF_DOC.name}에서 '## {title}' 절을 찾지 못했습니다.")
        end = len(lines)
        for j in range(start + 1, len(lines)):
            # 같은 단계 이상의 제목이 나오면 그 절은 거기서 끝난다.
            if 0 < heading_level(lines[j]) <= 2:
                end = j
                break
        chunks.append("\n".join(lines[start:end]).rstrip())
    return "\n\n".join(chunks)

# 활동 기록이 이보다 짧으면 원문이 아니라 요약을 넘겼을 가능성이 크다.
MIN_ACTIVITY_CHARS = 400

# 워커가 자기 작업을 회고할 때 쓰는 말투. 활동 기록에는 잘 나오지 않는다.
SELF_REPORT_PHRASES = (
    "요약하면", "정리하면", "결론적으로", "성공적으로", "잘 수행", "문제없이",
    "완료했습니다", "확인했습니다", "수행했습니다", "제대로 동작",
)


def summary_smells(activity: str) -> list[str]:
    """활동 원문 대신 워커의 자기 보고가 들어왔을 징후를 찾는다.

    완전한 판별은 불가능하다. 활동을 넘기는 주체가 에이전트이고, 잘 쓰인 자기 보고는
    기록과 구별되지 않는다. 값싸게 잡히는 신호만 경고로 남기고 흐름은 막지 않는다.
    """
    warnings = []
    if len(activity) < MIN_ACTIVITY_CHARS:
        warnings.append(f"활동 기록이 {len(activity)}자로 짧습니다. "
                        "워커의 요약이 아니라 get_agent_activity 원문인지 확인하세요.")

    # 원문은 보통 JSON이거나 도구 호출·타임스탬프가 섞인 구조를 갖는다.
    stripped = activity.strip()
    structured = (stripped.startswith(("{", "[")) or '"' in stripped
                  or "tool" in activity.lower() or ":" in activity)
    if not structured:
        warnings.append("활동 기록에 구조(JSON·도구 호출·타임스탬프)가 보이지 않습니다. "
                        "회수한 원문 그대로인지 확인하세요.")

    hits = [p for p in SELF_REPORT_PHRASES if p in activity]
    if hits:
        warnings.append(f"자기 보고에서 쓰이는 표현이 있습니다({', '.join(hits[:3])}). "
                        "워커의 결과 보고를 넣은 것은 아닌지 확인하세요.")
    return warnings


def cmd_brief(args) -> int:
    """심판 브리핑을 생성한다.

    호출자가 브리핑을 손으로 조립하면 테스트 워커의 자기 보고가 끼어들 자리가 생긴다.
    스크립트가 템플릿을 채우게 해서 그 자리를 없애고, 활동 원문의 출처를 필수로 요구한다.
    """
    state = read_state(args.state)
    entry = find(state, args.profile_id)

    try:
        activity = Path(args.activity).read_text(encoding="utf-8")
    except OSError as exc:
        print(f"오류: 활동 기록 파일을 읽지 못했습니다: {exc}", file=sys.stderr)
        return 2

    if not activity.strip():
        print("오류: 활동 기록이 비어 있습니다. get_agent_activity 결과를 그대로 저장해 주세요.",
              file=sys.stderr)
        return 2

    # 출처 표식이 없으면 어느 에이전트의 기록인지 확인할 수 없어 채점을 시작하지 않는다.
    recorded = entry.get("agentId")
    if not recorded:
        print(f"오류: '{args.profile_id}'에 기록된 agentId가 없습니다. launched로 먼저 등록하세요.",
              file=sys.stderr)
        return 2
    if args.agent_id != recorded:
        print(f"오류: agentId가 ledger와 다릅니다. 기대 {recorded!r} → 받은 {args.agent_id!r}. "
              f"다른 에이전트의 기록이거나 출처가 틀렸습니다.", file=sys.stderr)
        return 2

    for warning in summary_smells(activity):
        print(f"경고: {warning}", file=sys.stderr)

    # 프로브가 없으면 심판은 무엇을 시켰는지 모른 채 채점하게 된다.
    try:
        probe = Path(args.probe).read_text(encoding="utf-8").strip()
    except OSError as exc:
        print(f"오류: 프로브 지시를 읽지 못했습니다: {exc}", file=sys.stderr)
        return 2
    if not probe:
        print("오류: 프로브 지시가 비어 있습니다. 그 프로필에 실제로 준 지시를 넣으세요.",
              file=sys.stderr)
        return 2

    try:
        rubric = extract_sections(["루브릭"])
        spec = extract_sections(["출력 규격"])
    except (OSError, ValueError) as exc:
        print(f"오류: 채점 기준을 {BRIEF_DOC.name}에서 읽지 못했습니다: {exc}", file=sys.stderr)
        return 2

    text = council.format(
        pid=entry["id"], name=entry["name"],
        notes=entry.get("notes") or "(notes 없음)",
        probe=probe, agent_id=args.agent_id,
        retrieved_at=args.retrieved_at or datetime.now(timezone.utc).isoformat(),
        activity=activity.strip(), rubric=rubric, spec=spec,
        result_path=args.result_out,
    )
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"심판 브리핑을 {args.out}에 저장했습니다. 이 파일을 그대로 initialPrompt로 쓰세요.")
    else:
        print(text)
    return 0


def validate_quality(verdict) -> list[str]:
    """심판 채점 JSON을 검사한다. 규격 밖의 값이 보고까지 흘러가지 않게 막는다."""
    problems = []
    if not isinstance(verdict, dict):
        return [f"최상위가 객체가 아닙니다: {type(verdict).__name__}"]

    # judge-brief.md의 「출력 규격」이 원천이다. 그 문서가 두 축을 1~5 정수로,
    # items와 summary를 필수로 규정하므로 여기서도 그대로 막는다.
    for key in ("fulfillment", "boundary"):
        value = verdict.get(key)
        if value is None:
            problems.append(f"'{key}'가 없습니다.")
        elif isinstance(value, bool) or not isinstance(value, int):
            problems.append(f"'{key}'는 1~5 정수여야 합니다: {value!r}")
        elif not 1 <= value <= 5:
            problems.append(f"'{key}'는 1~5여야 합니다: {value!r}")

    if not isinstance(verdict.get("summary"), str) or not verdict.get("summary", "").strip():
        problems.append("'summary'가 비어 있습니다. 한 줄 총평은 필수입니다.")

    if "score" in verdict:
        score = verdict["score"]
        if not isinstance(score, (int, float)) or isinstance(score, bool):
            problems.append(f"'score'가 숫자가 아닙니다: {score!r}")
        elif not 0 <= score <= 5:
            problems.append(f"'score'는 0~5여야 합니다: {score!r}")

    items = verdict.get("items")
    if items is None:
        problems.append("'items'가 없습니다.")
    elif not isinstance(items, list):
        problems.append(f"'items'가 배열이 아닙니다: {type(items).__name__}")
    elif not 2 <= len(items) <= 5:
        # judge-brief.md의 「출력 규격」이 2~5개로 규정한다. 그 문서가 원천이다.
        problems.append(f"'items'는 2~5개여야 합니다: {len(items)}개. "
                        "1개면 근거가 한쪽뿐이고, 너무 많으면 notes와 무관한 항목이 섞입니다.")
    else:
        for index, item in enumerate(items):
            if not isinstance(item, dict):
                problems.append(f"items[{index}]가 객체가 아닙니다: {type(item).__name__}")
                continue
            if not isinstance(item.get("text"), str) or not item.get("text"):
                problems.append(f"items[{index}].text가 비어 있거나 문자열이 아닙니다.")
            if not isinstance(item.get("passed"), bool):
                problems.append(f"items[{index}].passed가 true/false가 아닙니다.")
            if not isinstance(item.get("evidence"), str) or not item.get("evidence"):
                problems.append(f"items[{index}].evidence가 비어 있습니다. 근거 없는 판정은 받지 않습니다.")
    return problems


def quality_score(quality) -> float | None:
    """판정 JSON에서 점수를 꺼낸다. 심판이 준 score를 그대로 쓰고,
    없으면 하위 점수의 평균을 낸다."""
    if not isinstance(quality, dict):
        return None
    if isinstance(quality.get("score"), (int, float)):
        return float(quality["score"])
    subs = [v for v in (quality.get("fulfillment"), quality.get("boundary"))
            if isinstance(v, (int, float))]
    return round(sum(subs) / len(subs), 1) if subs else None


def cmd_report(args) -> int:
    state = read_state(args.state)
    rows = state["profiles"]

    def mark(entry, value) -> str:
        if value in ("PASS", "FAIL"):
            return value
        # 판정 불가와 아직 판정 안 함은 다르다. 둘을 같은 기호로 쓰면 실패가 묻힌다.
        return "N/A" if entry.get("unresolved") else "—"

    scores = {p["id"]: quality_score(p.get("quality")) for p in rows}

    # 한글이 들어가는 name은 맨 뒤에 둔다. 뒤에 아무 열도 없으면 폭이 어긋나도
    # 앞 열의 정렬이 깨지지 않는다.
    headers = ["등록", "라우팅", "품질", "ID", "프로필"]
    def quality_cell(p) -> str:
        score = scores[p["id"]]
        if score is not None:
            # 만점을 함께 적는다. 점수만 있으면 5점 만점인지 알 수 없다.
            return f"{score:.1f}/5"
        return "N/A" if p.get("unresolved") else "—"

    table = [
        [mark(p, p.get("registration")), mark(p, p.get("routing")), quality_cell(p),
         str(p["id"]), f"{profile_emoji(p.get('icon'))} {p['name']}"]
        for p in rows
    ]
    widths = [max(dwidth(h), *(dwidth(r[i]) for r in table)) if table else dwidth(h)
              for i, h in enumerate(headers)]

    passed = sum(1 for p in rows
                 if p.get("registration") == "PASS" and p.get("routing") == "PASS")
    print(RULE)
    print(f"📊 프로필 테스트 결과 — 프로필 {len(rows)}개 중 결정론 2축 통과 {passed}개")
    print(RULE)
    print()
    print("  ".join(pad(h, w) for h, w in zip(headers, widths)).rstrip())
    print("  ".join("─" * w for w in widths))
    for row in table:
        print("  ".join(pad(c, w) for c, w in zip(row, widths)).rstrip())

    def section(axis: str, title: str) -> None:
        hits = [(p, f) for p in rows for f in p.get("findings", []) if f.get("axis") == axis]
        if not hits:
            return
        print(f"\n{RULE}\n{title}\n{RULE}")
        w_id = max(dwidth(p["id"]) for p, _ in hits)
        for p, f in hits:
            if f.get("text"):
                print(f"  {pad(p['id'], w_id)}  {f['text']}")
            else:
                print(f"  {pad(p['id'], w_id)}  {f['field']}: "
                      f"기대 {f['expected']!r} → 실제 {f['actual']!r}")

    section("registration", "⚠️ 등록 불일치 — config.json과 daemon이 다르다")
    section("routing", "⚠️ 라우팅 불일치 — 프로필대로 뜨지 않았다")

    graded = [p for p in rows if p.get("quality")]
    if graded:
        print(f"\n{RULE}\n📝 작업 품질 — 각 프로필의 notes 기준\n{RULE}")
        for p in graded:
            q = p["quality"]
            score = scores[p["id"]]
            # 머리줄 하나에 이모지·name·id·총점·차원별 점수를 모은다.
            head = (f"\n{profile_emoji(p.get('icon'))} {p['name']} ({p['id']})"
                    f" — {'—' if score is None else f'{score:.1f}/5'}")
            if isinstance(q.get("fulfillment"), (int, float)):
                head += f" · 이행 {q['fulfillment']}/5 · 경계 {q.get('boundary', '—')}/5"
            print(head)

            items = q.get("items", [])
            if items:
                cells = [
                    ("PASS" if it.get("passed") else "FAIL",
                     wrap_cells(it.get("text", ""), ITEM_WIDTH),
                     wrap_cells(it.get("evidence", ""), EVIDENCE_WIDTH))
                    for it in items
                ]
                # 판정 열은 맨 앞의 ASCII 고정폭이라 실패가 왼쪽 끝에서 바로 보인다.
                w_item = max([dwidth("항목")] + [dwidth(l) for _, t, _ in cells for l in t])
                w_ev = max([dwidth("근거")] + [dwidth(l) for _, _, e in cells for l in e])
                print(f"\n  {pad('판정', 4)}  {pad('항목', w_item)}  근거")
                print(f"  {'─' * 4}  {'─' * w_item}  {'─' * w_ev}")
                for flag, text_lines, ev_lines in cells:
                    for i in range(max(len(text_lines), len(ev_lines))):
                        # 넘친 줄은 판정 칸을 비우고 같은 열 위치에 이어 붙인다.
                        left = flag if i == 0 else ""
                        text = text_lines[i] if i < len(text_lines) else ""
                        ev = ev_lines[i] if i < len(ev_lines) else ""
                        print(f"  {pad(left, 4)}  {pad(text, w_item)}  {ev}".rstrip())
            if q.get("summary"):
                print(f"\n  총평: {q['summary']}")

    unresolved = [p for p in rows if p.get("unresolved")]
    if unresolved:
        print(f"\n{RULE}\n🚫 판정 불가 — 테스트를 끝내지 못했다\n{RULE}")
        w_id = max(dwidth(p["id"]) for p in unresolved)
        for p in unresolved:
            print(f"  {pad(p['id'], w_id)}  {p['unresolved']}")

    section("note", "🗒️ 메모")

    # 요청한 수와 보고한 수가 어긋나면 어딘가에서 프로필이 증발한 것이다.
    requested = state.get("requested", len(rows))
    print(f"\n대상 {requested}개 · 보고 {len(rows)}개", end="")
    if requested != len(rows):
        print(f" — 불일치. 보고에서 {requested - len(rows)}개가 빠졌다.", end="")
    print()

    pending = [p["id"] for p in rows if p["state"] not in ("done", "excluded")]
    if pending:
        print(f"미완료: {', '.join(str(x) for x in pending)}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="프로필 테스트 진행 상태를 추적하고 보고 form을 출력합니다.")
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init", help="테스트 대상을 큐에 넣습니다.")
    p_init.add_argument("--daemon", required=True, help="MCP list_profiles 출력 경로. '-'면 stdin.")
    p_init.add_argument("--disk", help="manage_profiles.py --list --json 출력 경로. "
                                       "생략하면 등록 검증을 하지 못합니다.")
    p_init.add_argument("--state", required=True, help="상태 파일 경로.")
    p_init.add_argument("--only", help="선별 테스트할 프로필 id를 쉼표로 구분해 지정합니다.")
    p_init.add_argument("--max-concurrent", type=int, default=MAX_CONCURRENT,
                        help=f"동시 실행 상한. 기본이자 최대 {HARD_CAP}. 더 큰 값은 {HARD_CAP}으로 제한됩니다.")
    p_init.set_defaults(func=cmd_init)

    p_next = sub.add_parser("next", help="지금 띄울 프로필을 상한 안에서 알려줍니다.")
    p_next.add_argument("--state", required=True)
    p_next.set_defaults(func=cmd_next)

    p_launched = sub.add_parser("launched", help="띄운 에이전트를 상태에 반영합니다.")
    p_launched.add_argument("--state", required=True)
    p_launched.add_argument("--profile-id", required=True)
    p_launched.add_argument("--agent-id", required=True)
    p_launched.set_defaults(func=cmd_launched)

    p_rec = sub.add_parser("record", help="판정 결과를 기록합니다.")
    p_rec.add_argument("--state", required=True)
    p_rec.add_argument("--profile-id", required=True)
    p_rec.add_argument("--registration", choices=["PASS", "FAIL"], help="축1 판정을 직접 지정합니다.")
    p_rec.add_argument("--registration-file",
                       help="check_routing.py registration --json 출력 경로. 불일치 필드까지 가져옵니다.")
    p_rec.add_argument("--routing", choices=["PASS", "FAIL"], help="축2 판정을 직접 지정합니다.")
    p_rec.add_argument("--routing-file", help="check_routing.py routing --json 출력 경로. 불일치 필드까지 가져옵니다.")
    p_rec.add_argument("--quality-file", help="심판이 낸 채점 JSON 경로.")
    p_rec.add_argument("--note", help="보고에 남길 한 줄 메모.")
    p_rec.add_argument("--unresolved", metavar="사유",
                       help="중단·회수 실패로 판정하지 못했음을 기록합니다. 자리를 돌려주고 "
                            "보고에 '판정 불가'로 남습니다.")
    p_rec.add_argument("--done", action="store_true", help="이 프로필을 완료로 표시하고 자리를 비웁니다.")
    p_rec.set_defaults(func=cmd_record)

    p_brief = sub.add_parser("brief", help="심판 브리핑을 생성합니다. 출처 표식이 없으면 거부합니다.")
    p_brief.add_argument("--state", required=True)
    p_brief.add_argument("--profile-id", required=True)
    p_brief.add_argument("--activity", required=True,
                         help="get_agent_activity 결과를 그대로 저장한 파일.")
    p_brief.add_argument("--agent-id", required=True,
                         help="활동을 회수한 agentId. ledger에 기록된 값과 달라도 거부합니다.")
    p_brief.add_argument("--retrieved-at", help="회수 시각(ISO). 생략하면 현재 시각.")
    p_brief.add_argument("--probe", required=True, help="그 프로필에 준 프로브 지시 파일.")
    p_brief.add_argument("--result-out", required=True,
                         help="심판이 채점 JSON을 저장할 경로. 프롬프트에 그대로 박힙니다.")
    p_brief.add_argument("--out", help="브리핑을 저장할 경로. 생략하면 표준 출력.")
    p_brief.set_defaults(func=cmd_brief)

    p_report = sub.add_parser("report", help="보고 form을 출력합니다.")
    p_report.add_argument("--state", required=True)
    p_report.set_defaults(func=cmd_report)

    args = parser.parse_args()
    try:
        return args.func(args)
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
        print(f"오류: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
