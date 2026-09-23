"""T11 규칙 대조표의 변경 전 단위 누락과 새 위치 인용을 검사한다."""

from __future__ import annotations

import argparse
import collections
import difflib
import re
import subprocess
import sys
from pathlib import Path


RUN = Path(__file__).resolve().parent
ROOT = RUN.parents[2]
SKILL = ROOT / "plugins/paseo-toolkit/skills/agent-orchestration"
OLD_REV = "5e833be"
OLD_FILES = (
    "SKILL.md",
    "assets/review-briefing.md",
    "references/FORM.md",
    "references/brainstorming.md",
    "references/failure-handling.md",
    "references/level1.md",
    "references/level2.md",
)
NEW_FILES = tuple(sorted(
    str(path.relative_to(SKILL)).replace("\\", "/")
    for path in SKILL.rglob("*.md")
)) + ("../../references/presets.md",)
TABLE = RUN / "rule-audit.md"
SENTENCE_END = re.compile(r"(?<=[다까])\.(?=\s|$)")
LIST_START = re.compile(r"^\s*(?:[-*]\s+|\d+\.\s+)")
TABLE_RULE = re.compile(r"^\|?\s*:?-{3,}")
SECTION = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
ALLOWED = {"동일", "축약", "통합"}
ALLOWED_R = {"R1", "R2", "R6", "R7", "R8"}

# 자동 연결에서 짧은 문장이 다른 규칙을 가리킨 자리와 의도 변경 판정을 교정한다.
# 각 인용은 아래 seed()에서 실제 새 절에 포함되는지 확인한다.
FIXUPS = {
    "SKILL.md:3#1": ("SKILL.md:description", '요청 문장을 위에서부터 판정해 처음 맞으면 멈춘다', "의도 변경 R1"),
    "SKILL.md:3#2": ("SKILL.md:description", '해당하면 적용, 나머지는 팀장 직접 처리.', "의도 변경 R1"),
    "SKILL.md:3#3": ("SKILL.md:description", '"브레인스토밍하자"·"아이디어 좀 내보자"·"뭘 만들면 좋을까"·"방향 좀 잡아줘"도 별도 발동.', "축약"),
    "SKILL.md:3#4": ("SKILL.md:description", '되돌리기 어려운 행동·브레인스토밍이 우선, 그다음 팀장 직접 지시("네가 직접 해")를 우선한다.', "의도 변경 R1"),
    "SKILL.md:3#5": ("SKILL.md:## 적용 판정과 Step 0", "위임 여부는 다시 묻지 않으며", "축약"),
    "SKILL.md:3#6": ("SKILL.md:## 적용 판정과 Step 0", "라우팅은 팀장만 수행하고 워커는 재위임하지 않는다.", "축약"),
    "SKILL.md:8#1": ("SKILL.md:## 적용 판정과 Step 0", "6. 그 밖                                                    → 팀장이 직접 처리", "의도 변경 R1"),
    "SKILL.md:8#2": ("SKILL.md:## 리더가 직접 하는 일", "위임 경로에서 팀장이 직접 맡는 일은 세션 대화 맥락 자체를 근거로 삼는 일, 사용자 확인 문답, 워커 결과 취합과 보고", "의도 변경 R1"),
    "SKILL.md:9#1": ("SKILL.md:## 적용 판정과 Step 0", "4. 요청에 이름이 나온 대상 파일이 5개를 넘는다", "제거 R1"),
    "SKILL.md:16#1": ("SKILL.md:## 리더가 직접 하는 일", "직접 처리로 판정된 작업은 팀장이 수행한다.", "의도 변경 R1"),
    "SKILL.md:23#1": ("SKILL.md:## 리더가 직접 하는 일", "직접 처리로 판정된 작업은 팀장이 수행한다.", "의도 변경 R1"),
    "SKILL.md:23#2": ("SKILL.md:## 리더가 직접 하는 일", "사용자 브레인스토밍과 `BRAINSTORMING.md` 작성(10절)", "의도 변경 R1"),
    "SKILL.md:92#2": ("SKILL.md:## 2. 레벨 판정 게이트", "워커 노드 하나. 맥락이 다른 일은 나눈다", "의도 변경 R7"),
    "SKILL.md:101#1": ("SKILL.md:### 개발 워크플로우 단계", "개발은 스펙 작성·사용자 피드백 → 스펙 확정 → 스파이크 필요성 공동 판정", "축약"),
    "SKILL.md:115#1": ("SKILL.md:### 개발 워크플로우 단계", "독립 검토 노드를 여는 경우는 **넷뿐이다**", "의도 변경 R1-7"),
    "SKILL.md:117#1": ("SKILL.md:### 개발 워크플로우 단계", "실제 `notes` 허용 범위에서 스펙 워커가 별도 판정안 노드로 이어 맡고, 허용하지 않으면 각 설계 역할이 맡는다.", "의도 변경 R6"),
    "SKILL.md:121#1": ("SKILL.md:### 개발 워크플로우 단계", "답이 서로 독립인 질문은 번호를 붙여 한 번에 묻고 질문↔답 원문 대응을 보존한다.", "의도 변경 R8"),
    "SKILL.md:144#1": ("SKILL.md:## 적용 판정과 Step 0", "직접 처리 여부와 무관하게 git 커밋·스테이징·푸시·태그·브랜치 삭제", "의도 변경 R2"),
    "SKILL.md:167#1": ("SKILL.md:## 적용 판정과 Step 0", "레벨 1 경로나 워커 한 명 요청에서도 Step 0을 건너뛰지 않는다.", "의도 변경 R2"),
    "SKILL.md:169#1": ("SKILL.md:## 적용 판정과 Step 0", "git 커밋·스테이징·푸시·태그·브랜치 삭제, 외부 전송, 파일·디렉터리 삭제, 저장소 밖 설정 변경", "의도 변경 R2"),
    "SKILL.md:181#1": ("SKILL.md:## 3. 레벨 1 — 팬아웃", "2절에서 레벨 1로 판정된 요청과 팀장 직접 수정 뒤 5절의 검토 노드가 이 절로 온다.", "의도 변경 R1-7"),
    "SKILL.md:193#1": ("SKILL.md:### 활성 큐와 대기 큐", "대기·활성 큐가 모두 비면 최종 상태를 `set`으로 확정하고 7절로 보고한다.", "축약"),
    "SKILL.md:220#1": ("SKILL.md:### 활성 큐와 대기 큐", "판정 즉시 `python scripts/graph_update.py set`으로 `상태`를 기록하고 mermaid는 건드리지 않는다.", "통합"),
    "SKILL.md:223#1": ("SKILL.md:### 활성 큐와 대기 큐", "빈 슬롯만큼 대기 큐 선두를 기동해 `실행 중`을 기록한다.", "축약"),
    "SKILL.md:305#1": ("SKILL.md:## 5. 워커 브리핑", "**요약하지 않은 원본 합격 기준**", "축약"),
    "SKILL.md:327#1": ("SKILL.md:### 검토는 만든 에이전트에게 맡기지 않는다", "독립 검토는 작성자와 다른 리뷰 워커에게 맡긴다.", "축약"),
    "SKILL.md:330#1": ("SKILL.md:### 개발 워크플로우 단계", "독립 검토 노드를 여는 경우는 **넷뿐이다**", "의도 변경 R1-7"),
    "SKILL.md:339#1": ("references/level2.md:## 설계", "검토를 시작하기 전에 상한과 사용 횟수를 적는다.", "통합"),
    "SKILL.md:339#2": ("references/level2.md:### 두 예산 — 사용자 왕복과 검토 라운드", "남은 지적과 각 라운드 검토 결과 파일 경로를 보고한 뒤 멈춘다.", "축약"),
    "SKILL.md:339#3": ("references/level2.md:### 두 예산 — 사용자 왕복과 검토 라운드", "예산의 연장은 횟수와 대상을 정한", "축약"),
    "SKILL.md:393#1": ("SKILL.md:### 주입 — 승인이 필요한 것과 아닌 것", "사후 통지는 승인이 아니다.", "축약"),
    "SKILL.md:174#1": ("SKILL.md:## 적용 판정과 Step 0", "같은 범위의 명시적 지시는 승인으로 재사용한다.", "축약"),
    "SKILL.md:409#2": ("SKILL.md:### 결과 파일로 받는다", "실패 보고를 결과 파일보다 앞세운다.", "축약"),
    "SKILL.md:421#1": ("SKILL.md:## 7. 취합과 보고", "새 워커를 기동하면 크기와 무관하게 반드시 보고한다.", "의도 변경 R7"),
    "SKILL.md:421#2": ("SKILL.md:## 7. 취합과 보고", "새 워커를 기동하면 크기와 무관하게 반드시 보고한다.", "축약"),
    "SKILL.md:425#2": ("references/FORM.md:## 기동 보고", "라벨은 `이름` / `모델` / `모드` / `작업`이다.", "통합"),
    "SKILL.md:450#1": ("SKILL.md:### 결과 인수", "역할 변경(4절 프로필 해석, 실제 `notes`가 허용하는 스펙 판정은 같은 워커)", "의도 변경 R6"),
    "SKILL.md:496#2": ("SKILL.md:## 10. 브레인스토밍 진입", "갈리면 물어본다.", "축약"),
    "SKILL.md:497#2": ("SKILL.md:## 10. 브레인스토밍 진입", "[references/brainstorming.md](references/brainstorming.md)의 절차를 따른다", "통합"),
    "assets/review-briefing.md:5#1": ("assets/review-briefing.md:# 작업", "대상 경로의 내용이 원본 합격 기준을 만족하는지 판정한다.", "의도 변경 R1-7"),
    "assets/review-briefing.md:5#2": ("assets/review-briefing.md:# 작업", "작성자의 보고서·전제·요약은 받지 않는다.", "의도 변경 R1-7"),
    "assets/review-briefing.md:18#1": ("assets/review-briefing.md:# 고정 검토 가이드", "기본 검토와 팀장 직접 수정 뒤 검토는 아래 다섯 항목을 모두 확인한다.", "의도 변경 R1-7"),
    "assets/review-briefing.md:67#1": ("assets/review-briefing.md:# 경계", "작성자의 대화·보고·요약·해결 방향을 읽지 않는다.", "의도 변경 R1-7"),
    "references/level2.md:4#1": ("references/level2.md:# 레벨 2 — 그래프 실행", "첫 기동은 `create_agent`, 순차 후속 노드의 재사용은 아래 「순차 후속 노드의 워커 재사용」을 따른다.", "의도 변경 R7"),
    "references/level2.md:111#1": ("references/level2.md:## 설계", "순차 후속 노드에 같은 워커를 쓰면 후속 행에 재사용 `agentId`를 채운다.", "의도 변경 R7"),
    "references/level2.md:125#1": ("references/level2.md:### 공동 판정과 판정안", "같은 스펙 워커가 별도 노드에서 판정안을 낸다.", "의도 변경 R6"),
    "references/level2.md:127#1": ("references/level2.md:### 공동 판정과 판정안", "그 밖에는 마일스톤 역할 워커가 판정안을 낸다.", "의도 변경 R6"),
    "references/level2.md:130#2": ("references/level2.md:### 공동 판정과 판정안", "불일치하면 그 차이만 판정안 작성 워커에", "의도 변경 R6"),
    "references/level2.md:133#1": ("references/level2.md:### 공동 판정과 판정안", "판정안 작성 워커는 종료 요약에 판정(필요·생략·정보 부족)", "의도 변경 R6"),
    "references/level2.md:138#1": ("SKILL.md:### 개발 워크플로우 단계", "답이 서로 독립인 질문은 번호를 붙여 한 번에 묻고 질문↔답 원문 대응을 보존한다.", "의도 변경 R8"),
    "references/level2.md:140#1": ("references/level2.md:### 스펙 문답", "중계하는 것은 질문과 답변뿐이며 스펙 본문과 작성자의 분석 과정은 옮기지 않는다.", "축약"),
    "references/level2.md:145#1": ("references/level2.md:### 마일스톤 생략과 스펙 변경", "마일스톤 판정안을 작성한 워커와 팀장이 단일 마일스톤 번호를 확정하고", "의도 변경 R6"),
    "references/failure-handling.md:220#1": ("references/failure-handling.md:## 재개", "`agentId`를 중복 제거해 실제 상태를 조회한다.", "의도 변경 R7"),
    "references/FORM.md:263#3": ("references/FORM.md:## 사용자 확정 게이트", "출력을 낸 시점에 `python scripts/graph_update.py set`으로 `GRAPH.md`의 그 게이트 행 `상태`를 `실행 중`으로 바꾸고", "통합"),
    "references/level2.md:275#1": ("references/level2.md:### 기록 시점", "재작업으로 상태를 `완료`에서 `실행 중`으로 되돌리는 기록은 재지시를 보내기 **전에** 한다.", "축약"),
    "references/level2.md:274#1": ("references/level2.md:### 기록 시점", "검토 라운드 사용 횟수는 검토를 시작하기 **전에** `set`으로 올린다.", "통합"),
    "references/level2.md:278#1": ("references/level2.md:### 기록 시점", "사용자 게이트를 열거나 확정받은 시점에도 해당 행을 갱신한다.", "축약"),
    "references/level2.md:434#1": ("references/failure-handling.md:## 재개", "`list_agents`로 자식 에이전트를 조회한다.", "통합"),
    "references/level2.md:443#1": ("references/failure-handling.md:## 실패 보고 우선", "결과 파일 경로의 파일과 그 노드의 합격 기준 한 줄을 대조해 맞으면 `완료`.", "통합"),
    "references/level2.md:444#1": ("references/level2.md:## 재개", "앞 시도 실패로 다시 띄우지 않는다.", "축약"),
    "references/level2.md:447#1": ("references/failure-handling.md:## 재개", "`대기`는 기동한다.", "통합"),
    "references/level2.md:263#1": ("references/level1.md:### 버전 줄", "기존 `GRAPH.md`에 없으면 소급해 고치지 않는다.", "축약"),
    "references/level1.md:7#1": ("SKILL.md:### 결과 파일로 받는다", "실행 디렉터리는 `.skywork/paseo-orchestration/{날짜}-{슬러그}/`다.", "통합"),
    "references/level1.md:15#1": ("references/level1.md:## 공통 `GRAPH.md` 기록", "바꿀 `열=값`만 넘긴다.", "통합"),
    "references/level1.md:44#2": ("references/FORM.md:## 기동 보고", "워커 하나당 코드블록 하나다.", "축약"),
    "references/level1.md:44#1": ("SKILL.md:## 7. 취합과 보고", "레벨 1 첫 기동 때만 목적 머리말과 `GRAPH.md` 경로를 블록 앞에 내고", "통합"),
    "references/level2.md:254#1": ("references/level1.md:### 버전 줄", "`버전 : {플러그인 버전}`으로 적는다.", "통합"),
}


def old_text(rel: str) -> str:
    path = f"plugins/paseo-toolkit/skills/agent-orchestration/{rel}"
    return subprocess.check_output(["git", "show", f"{OLD_REV}:{path}"], cwd=ROOT).decode("utf-8-sig")


def split_sentences(text: str) -> list[str]:
    cuts = [0, *(match.end() for match in SENTENCE_END.finditer(text)), len(text)]
    return [text[a:b].strip() for a, b in zip(cuts, cuts[1:]) if text[a:b].strip()]


def paragraph_sentences(parts: list[tuple[int, str]]) -> list[tuple[int, str]]:
    joined = " ".join(part for _, part in parts)
    starts = []
    position = 0
    for number, part in parts:
        starts.append((position, number))
        position += len(part) + 1
    cuts = [0, *(match.end() for match in SENTENCE_END.finditer(joined)), len(joined)]
    result = []
    for start, end in zip(cuts, cuts[1:]):
        piece = joined[start:end].strip()
        if piece:
            actual = start + len(joined[start:end]) - len(joined[start:end].lstrip())
            number = next(number for offset, number in reversed(starts) if offset <= actual)
            result.append((number, piece))
    return result


def units(rel: str) -> list[tuple[str, str]]:
    """목록 항목, 표 본문 행, 문장 및 본문에 실린 규칙형 코드 줄."""
    lines = old_text(rel).splitlines()
    found: list[tuple[int, str]] = []
    fenced = False
    index = 0
    if rel == "SKILL.md" and lines[:1] == ["---"]:
        for number in range(1, len(lines)):
            if lines[number] == "---":
                index = number + 1
                break
            if lines[number].startswith("description:"):
                description = lines[number].split(":", 1)[1].strip().strip("'")
                found.extend((number + 1, sentence) for sentence in split_sentences(description))
    while index < len(lines):
        line = lines[index]
        number = index + 1
        if line.startswith("```"):
            fenced = not fenced
            index += 1
            continue
        if fenced:
            if rel == "SKILL.md" and line.strip():
                found.append((number, line.strip()))
            index += 1
            continue
        if not line.strip() or SECTION.match(line):
            index += 1
            continue
        if line.lstrip().startswith("|"):
            if index + 1 < len(lines) and TABLE_RULE.match(lines[index + 1]):
                index += 1  # 표 헤더
                continue
            if not TABLE_RULE.match(line):
                found.append((number, line.strip()))
            index += 1
            continue
        if LIST_START.match(line):
            parts = [line.strip()]
            index += 1
            while index < len(lines) and lines[index].strip() and not (
                LIST_START.match(lines[index]) or SECTION.match(lines[index])
                or lines[index].startswith("```") or lines[index].lstrip().startswith("|")
            ):
                parts.append(lines[index].strip())
                index += 1
            found.append((number, " ".join(parts)))
            continue
        parts = [(number, line.strip())]
        index += 1
        while index < len(lines) and lines[index].strip() and not (
            LIST_START.match(lines[index]) or SECTION.match(lines[index])
            or lines[index].startswith("```") or lines[index].lstrip().startswith("|")
        ):
            parts.append((index + 1, lines[index].strip()))
            index += 1
        found.extend(paragraph_sentences(parts))
    ordinal: collections.Counter[tuple[str, int]] = collections.Counter()
    result = []
    for number, text in found:
        ordinal[(rel, number)] += 1
        result.append((f"{rel}:{number}#{ordinal[(rel, number)]}", text))
    return result


def section_ranges(rel: str) -> dict[str, str]:
    lines = (SKILL / rel).read_text(encoding="utf-8-sig").splitlines()
    ranges: dict[str, str] = {}
    headings: list[tuple[int, int, str]] = []
    if rel == "SKILL.md":
        ranges["description"] = lines[2] if len(lines) > 2 else ""
    for number, line in enumerate(lines):
        match = SECTION.match(line)
        if match:
            headings.append((number, len(match[1]), line))
    ranges["preamble"] = "\n".join(lines[:headings[0][0]]) if headings else "\n".join(lines)
    for idx, (start, level, heading) in enumerate(headings):
        end = next((item[0] for item in headings[idx + 1:] if item[1] <= level), len(lines))
        ranges[heading] = "\n".join(lines[start:end])
    return ranges


def parse_cells(line: str) -> list[str]:
    if not line.startswith("|") or not line.endswith("|"):
        return []
    return [cell.strip().replace("\\|", "|") for cell in re.split(r"(?<!\\)\|", line[1:-1])]


def location_parts(location: str) -> tuple[str, str]:
    for rel in sorted(NEW_FILES, key=len, reverse=True):
        if location.startswith(rel + ":"):
            return rel, location[len(rel) + 1:]
    raise ValueError(f"알 수 없는 새 파일: {location}")


def validate() -> int:
    expected = dict(unit for rel in OLD_FILES for unit in units(rel))
    present: collections.Counter[str] = collections.Counter()
    verdicts: collections.Counter[str] = collections.Counter()
    errors: list[str] = []
    sections = {rel: section_ranges(rel) for rel in NEW_FILES}
    rows = TABLE.read_text(encoding="utf-8-sig").splitlines()
    tracked = subprocess.check_output(
        ["git", "diff", "--name-only", OLD_REV, "--", "plugins/paseo-toolkit/skills/agent-orchestration"],
        cwd=ROOT,
    ).decode("utf-8").splitlines()
    actual_old_files = {
        path.removeprefix("plugins/paseo-toolkit/skills/agent-orchestration/")
        for path in tracked if path.endswith(".md")
    }
    if actual_old_files != set(OLD_FILES):
        errors.append(f"변경 전 대조 파일 목록 불일치: {sorted(actual_old_files ^ set(OLD_FILES))}")
    untracked = subprocess.check_output(
        ["git", "ls-files", "--others", "--exclude-standard", "--", "plugins/paseo-toolkit/skills/agent-orchestration"],
        cwd=ROOT,
    ).decode("utf-8").splitlines()
    new_files = {
        path.removeprefix("plugins/paseo-toolkit/skills/agent-orchestration/") for path in untracked
    }
    if new_files != {"references/system-prompt.md", "scripts/graph_update.py"}:
        errors.append(f"신규 파일 목록 불일치: {sorted(new_files)}")
    for line_number, line in enumerate(rows, 1):
        cells = parse_cells(line)
        if len(cells) != 4 or cells[0] in {"변경 전 위치(파일:줄)", "---"}:
            continue
        old_location, new_location, quote, verdict = cells
        if old_location not in expected:
            errors.append(f"표 {line_number}: 변경 전 단위 없음 {old_location}")
            continue
        present[old_location] += 1
        verdicts[verdict] += 1
        rule_number = verdict.removeprefix("의도 변경 ").removeprefix("제거 ")
        if verdict not in ALLOWED and not (
            (verdict.startswith("의도 변경 ") or verdict.startswith("제거 "))
            and re.fullmatch(r"R\d+(?:-\d+)?", rule_number)
            and rule_number.split("-", 1)[0] in ALLOWED_R
        ):
            errors.append(f"표 {line_number}: 허용 밖 판정 {verdict}")
        try:
            rel, heading = location_parts(new_location)
            section = sections[rel][heading]
        except (ValueError, KeyError) as exc:
            errors.append(f"표 {line_number}: 새 위치 없음 {exc}")
            continue
        if not quote or quote not in section:
            errors.append(f"표 {line_number}: 새 위치 인용 불일치 {new_location}: {quote[:70]}")
    missing = sorted(set(expected) - set(present))
    errors.extend(f"누락: {location} {expected[location][:90]}" for location in missing)
    # R3-4에서 본문 유지가 명시된 기존 본문 규칙의 새 위치를 검사한다.
    keep = {
        "SKILL.md:3#6": "도입 재위임 금지",
        "SKILL.md:31#3": "도입 침묵 원칙",
        "SKILL.md:67#1": "1절 notes 경계",
        "SKILL.md:79#1": "1절 워크스페이스",
        "SKILL.md:87#1": "1절 대기 수단",
        "SKILL.md:115#1": "2절 독립 검토 조건",
        "SKILL.md:133#1": "2절 묶음 경계",
        "SKILL.md:188#1": "3절 기록 시점",
        "SKILL.md:204#1": "3절 큐 상한",
        "SKILL.md:238#1": "4절 역할 해석",
        "SKILL.md:257#1": "4절 값 이관 표",
        "SKILL.md:297#1": "5절 브리핑 포함 범위",
        "SKILL.md:327#2": "5절 검토 독립성",
        "SKILL.md:348#1": "5절 결과 파일",
        "SKILL.md:409#2": "5·6절 실패 우선",
        "SKILL.md:391#1": "6절 범위 변경 승인",
        "SKILL.md:408#1": "6절 재시도 조건",
        "SKILL.md:421#1": "7절 기동 보고",
        "SKILL.md:445#1": "7절 증빙 대조",
        "SKILL.md:453#1": "7절 인수·독립 검토 구분",
        "SKILL.md:457#1": "8절 요청 한정",
        "SKILL.md:469#1": "8절 명시 승인",
        "SKILL.md:485#1": "9절 레벨 2 진입",
        "SKILL.md:491#1": "10절 브레인스토밍 진입",
    }
    for old_location, label in keep.items():
        mapped = [parse_cells(line)[1] for line in rows if len(parse_cells(line)) == 4 and parse_cells(line)[0] == old_location]
        if not mapped or any(not place.startswith("SKILL.md:") for place in mapped):
            errors.append(f"R3-4 본문 배치 불일치: {label} {old_location}")
    print(f"변경 전 규칙 단위 {len(expected)}건, 대조 행 {sum(present.values())}건")
    print("판정: " + ", ".join(f"{key} {value}" for key, value in sorted(verdicts.items())))
    print(f"누락 {len(missing)}건, 검사 오류 {len(errors) - len(missing)}건")
    for error in errors[:80]:
        print(error, file=sys.stderr)
    if len(errors) > 80:
        print(f"나머지 오류 {len(errors) - 80}건", file=sys.stderr)
    return 1 if errors else 0


def normalize(text: str) -> str:
    return re.sub(r"[^0-9A-Za-z가-힣]+", "", text).lower()


def score(old: str, candidate: str, same_file: bool) -> float:
    a, b = normalize(old), normalize(candidate)
    if not a or not b:
        return 0.0
    if a in b:
        return 2.0 + min(len(a) / max(len(b), 1), 1)
    grams_a = {a[i:i + 3] for i in range(max(len(a) - 2, 0))}
    grams_b = {b[i:i + 3] for i in range(max(len(b) - 2, 0))}
    overlap = len(grams_a & grams_b) / max(len(grams_a), 1)
    ratio = difflib.SequenceMatcher(None, a, b, autojunk=False).ratio()
    return overlap * 0.65 + ratio * 0.35 + (0.03 if same_file else 0)


def seed() -> None:
    candidates = []
    new_sections = {rel: section_ranges(rel) for rel in NEW_FILES}
    for rel in NEW_FILES:
        lines = (SKILL / rel).read_text(encoding="utf-8-sig").splitlines()
        heading = "description" if rel == "SKILL.md" else "preamble"
        top = ""
        for number, line in enumerate(lines, 1):
            if rel == "SKILL.md" and number == 3:
                candidates.append((rel, "description", line, number, "description"))
            match = SECTION.match(line)
            if match:
                heading = line
                if len(match[1]) == 2:
                    top = line
            if not line.strip() or match or line.startswith("```") or TABLE_RULE.match(line):
                continue
            candidates.append((rel, heading, line, number, top))
    output = [
        "# T11 규칙 단위 대조표",
        "",
        "변경 전 판본: `5e833be`. `#n`은 같은 줄에서 분리한 문장 순서다.",
        "",
        "| 변경 전 위치(파일:줄) | 새 위치(파일:절) | 새 위치 인용 | 판정 |",
        "| --- | --- | --- | --- |",
    ]
    for rel in OLD_FILES:
        old_lines = old_text(rel).splitlines()
        old_tops = {}
        old_headings = {}
        top = ""
        heading = ""
        for number, line in enumerate(old_lines, 1):
            match = SECTION.match(line)
            if match:
                heading = line
                if len(match[1]) == 2:
                    top = line
            old_tops[number] = top
            old_headings[number] = heading
        for location, old in units(rel):
            number = int(location.split(":", 1)[1].split("#", 1)[0])
            old_top = old_tops[number]
            old_heading = old_headings[number]
            if rel == "SKILL.md" and number == 3:
                pool = [c for c in candidates if c[0] == "SKILL.md" and c[1] == "description"]
            elif rel == "SKILL.md" and (not old_top or old_heading == "### Step 0 — 되돌리기 어려운 작업"):
                pool = [c for c in candidates if c[0] == "SKILL.md" and c[4] == "## 적용 판정과 Step 0"]
            elif rel == "SKILL.md" and old_top.startswith("## 8."):
                pool = [c for c in candidates if c[0] == "references/system-prompt.md" or (c[0] == "SKILL.md" and c[4].startswith("## 8."))]
            elif rel == "SKILL.md":
                pool = [c for c in candidates if c[0] == "SKILL.md" and c[4] == old_top]
            elif rel == "references/level2.md" and old_top == "## GRAPH.md":
                pool = [c for c in candidates if (c[0] == rel and c[4] == old_top) or (c[0] == "references/level1.md" and c[4] == "## 공통 `GRAPH.md` 기록")]
            else:
                pool = [c for c in candidates if c[0] == rel and (c[4] == old_top or rel == "references/level1.md")]
            if not pool:
                pool = [c for c in candidates if c[0] == rel]
            exact = [c for c in pool if c[2].strip() == old_lines[number - 1].strip()]
            if exact:
                pool = exact
            elif old_heading and old_heading != old_top and not (rel == "SKILL.md" and old_heading == "### Step 0 — 되돌리기 어려운 작업"):
                same_heading = [c for c in pool if c[1] == old_heading]
                if same_heading:
                    pool = same_heading
            ranked = sorted(pool, key=lambda c: score(old, c[2], rel == c[0]), reverse=True)
            dest, heading, quote, _, _ = ranked[0]
            verdict = "동일" if normalize(old) in normalize(new_sections[dest][heading]) else "통합"
            if location in FIXUPS:
                new_location, quote, verdict = FIXUPS[location]
                dest, heading = location_parts(new_location)
                if quote not in new_sections[dest][heading]:
                    raise ValueError(f"교정 인용 불일치: {location}: {quote}")
            quote = quote.strip().replace("|", "\\|")
            output.append(f"| {location} | {dest}:{heading} | {quote} | {verdict} |")
    TABLE.write_text("\n".join(output) + "\n", encoding="utf-8", newline="\n")
    print(f"초안 {len(output) - 6}행 생성: {TABLE}")


def review(rel_filter: str, limit: int, compact: bool, only_changed: bool, old_order: bool, offset: int) -> None:
    expected = dict(unit for rel in OLD_FILES for unit in units(rel))
    pairs = []
    for line in TABLE.read_text(encoding="utf-8-sig").splitlines():
        cells = parse_cells(line)
        if len(cells) != 4 or cells[0] not in expected:
            continue
        old_location, new_location, quote, verdict = cells
        if rel_filter and not old_location.startswith(rel_filter):
            continue
        if only_changed and verdict == "동일":
            continue
        pairs.append((score(expected[old_location], quote, False), old_location, expected[old_location], new_location, quote, verdict))
    if not old_order:
        pairs.sort()
    for value, old_location, old, new_location, quote, verdict in pairs[offset:offset + limit]:
        if compact:
            print(f"{value:.2f} {old_location} [{verdict}] {old[:95]} => {new_location}: {quote[:95]}")
        else:
            print(f"{value:.2f} {old_location} [{verdict}] -> {new_location}")
            print(f"  이전: {old[:240]}")
            print(f"  현재: {quote[:240]}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", action="store_true", help="대조표 초안 생성")
    parser.add_argument("--review", action="store_true", help="낮은 유사도의 대조 행 보기")
    parser.add_argument("--file", default="", help="--review의 변경 전 파일 접두사")
    parser.add_argument("--limit", type=int, default=50, help="--review 출력 행 수")
    parser.add_argument("--compact", action="store_true", help="--review를 한 줄씩 출력")
    parser.add_argument("--only-changed", action="store_true", help="--review에서 동일 판정 제외")
    parser.add_argument("--old-order", action="store_true", help="--review를 변경 전 순서로 출력")
    parser.add_argument("--offset", type=int, default=0, help="--review 시작 행")
    parser.add_argument("--old-at", default="", help="변경 전 단위의 위치 또는 문구 검색")
    args = parser.parse_args()
    if args.seed:
        seed()
    elif args.review:
        review(args.file, args.limit, args.compact, args.only_changed, args.old_order, args.offset)
    elif args.old_at:
        for rel in OLD_FILES:
            for location, old in units(rel):
                if args.old_at in location or args.old_at in old:
                    print(f"{location}: {old}")
    else:
        raise SystemExit(validate())
