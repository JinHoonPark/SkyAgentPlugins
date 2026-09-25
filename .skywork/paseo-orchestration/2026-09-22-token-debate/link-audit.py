"""T10 source-link, heading, read-timing and scenario measurement audit."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from collections import defaultdict
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[3]
SKILL = ROOT / "plugins/paseo-toolkit/skills/agent-orchestration"
PREFIX = SKILL.relative_to(ROOT).as_posix()
COMMIT = "5e833be"
PATHS = [SKILL / "SKILL.md", *sorted((SKILL / "references").glob("*.md")), *sorted((SKILL / "assets").glob("*.md"))]
LINK = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)")
INLINE = re.compile(r"`([^`\n]+)`")
RELATIVE = re.compile(r"(?<![\w/])(?:references|assets|scripts)/[\w./-]+\.(?:md|py)")
HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.M)
QUOTED = re.compile(r"「([^」]+)」")
NUMBERED = re.compile(r"(?<!\d)(\d{1,2})절")
ORDINARY_QUOTES = {
    "mermaid 1개와 노드 표 1개만", "다시 확인", "작성자 재확인",
    "재시도 금지", "재시도 가능", "필요", "생략", "즉시", "침묵",
    "진입", "진입 게이트", "범위 변경 주입을 보내야 한다",
    "결론 작성", "쟁점 보고", "수정 필요",
}


def read(path: str, version: str) -> str:
    if version == "before":
        completed = subprocess.run(
            ["git", "show", f"{COMMIT}:{PREFIX}/{path}"], cwd=ROOT,
            check=True, capture_output=True,
        )
        value = completed.stdout.decode("utf-8-sig")
    else:
        value = (SKILL / path).read_text(encoding="utf-8-sig")
    return value.replace("\r\n", "\n")


def intervals(value: str, heading: str | None) -> tuple[list[str], range]:
    lines = value.splitlines(keepends=True)
    if heading is None:
        return lines, range(len(lines))
    found = None
    for index, line in enumerate(lines):
        match = HEADING.match(line.rstrip("\n"))
        if match and match.group(2).strip() == heading:
            found = (index, len(match.group(1)))
            break
    if found is None:
        raise ValueError(f"heading missing: {heading}")
    start, level = found
    stop = len(lines)
    for index in range(start + 1, len(lines)):
        match = HEADING.match(lines[index].rstrip("\n"))
        if match and len(match.group(1)) <= level:
            stop = index
            break
    return lines, range(start, stop)


def source_audit() -> tuple[list[str], dict[str, int]]:
    errors: list[str] = []
    counts: dict[str, int] = defaultdict(int)
    texts = {path: path.read_text(encoding="utf-8-sig").replace("\r\n", "\n") for path in PATHS}
    headings = defaultdict(list)
    preset_path = SKILL.parents[1] / "references/presets.md"
    heading_texts = {**texts, preset_path: preset_path.read_text(encoding="utf-8-sig").replace("\r\n", "\n")}
    for path, value in heading_texts.items():
        for match in HEADING.finditer(value):
            headings[match.group(2).strip()].append(path)
    skill_text = texts[SKILL / "SKILL.md"]
    shared_sources = [*texts.values(), (SKILL / "scripts/graph_update.py").read_text(encoding="utf-8-sig")]
    for banned in ("${CLAUDE_PLUGIN_ROOT}", "C:/Users/", "C:\\Users\\", "D:/", "D:\\"):
        if any(banned in value for value in shared_sources):
            errors.append(f"hard-coded shared path: {banned}")
    frontmatter = skill_text.split("---", 2)[1].strip().splitlines()
    keys = [line.split(":", 1)[0] for line in frontmatter]
    if keys != ["name", "description"]:
        errors.append(f"SKILL.md: frontmatter keys {keys}")
    if len(skill_text.splitlines()) >= 500:
        errors.append(f"SKILL.md: {len(skill_text.splitlines())} lines (maximum 499)")
    for path, value in texts.items():
        rel = path.relative_to(SKILL).as_posix()
        paragraphs = re.split(r"\n\s*\n", value)
        for line_no, line in enumerate(value.splitlines(), 1):
            paragraph = next((p for p in paragraphs if line in p.splitlines()), line)
            targets = {path, SKILL / "SKILL.md"}
            for linked in LINK.findall(paragraph):
                target = (path.parent / unquote(urlsplit(linked.split(maxsplit=1)[0]).path)).resolve()
                if target in heading_texts:
                    targets.add(target)
            for inline in INLINE.findall(paragraph):
                for match in RELATIVE.finditer(inline):
                    target = (SKILL / match.group()).resolve()
                    if target in heading_texts:
                        targets.add(target)
            for match in LINK.finditer(line):
                raw = match.group(1).split(maxsplit=1)[0]
                parsed = urlsplit(raw)
                if parsed.scheme or raw.startswith("#"):
                    continue
                target = (path.parent / unquote(parsed.path)).resolve()
                counts["links"] += 1
                if not target.is_file():
                    errors.append(f"{rel}:{line_no}: missing link {raw}")
            for inline in INLINE.findall(line):
                for match in RELATIVE.finditer(inline):
                    raw = match.group()
                    counts["inline_paths"] += 1
                    if not (SKILL / raw).is_file():
                        errors.append(f"{rel}:{line_no}: missing inline path {raw}")
                if inline.startswith("## "):
                    name = inline[3:].strip()
                    counts["headed_refs"] += 1
                    if not any(target in targets for target in headings.get(name, [])):
                        errors.append(f"{rel}:{line_no}: missing heading ## {name}")
            for quote in QUOTED.findall(line):
                if quote in ORDINARY_QUOTES:
                    counts["ordinary_quotes"] += 1
                    continue
                counts["headed_refs"] += 1
                if not any(target in targets for target in headings.get(quote, [])):
                    errors.append(f"{rel}:{line_no}: missing heading 「{quote}」")
            for number in NUMBERED.findall(line):
                counts["numbered_refs"] += 1
                if not re.search(rf"^## {number}\.\s", skill_text, re.M):
                    errors.append(f"{rel}:{line_no}: missing SKILL.md {number}절")
    for name in ("references/system-prompt.md", "scripts/graph_update.py"):
        paragraphs = re.split(r"\n\s*\n", skill_text)
        matches = [p for p in paragraphs if name in p]
        counts["new_direct_refs"] += len(matches)
        if not matches:
            errors.append(f"SKILL.md: no direct reference to {name}")
        elif not any(re.search(r"직전|전에|때|경우|수행|실행|호출", p) for p in matches):
            errors.append(f"SKILL.md: missing read/execute timing for {name}")
    level1 = texts[SKILL / "references/level1.md"]
    if "각 갱신은 도구 호출 한 번이다." not in level1:
        errors.append("references/level1.md: one update must use one tool call")
    for command in ("create", "add-row", "set"):
        if f"python scripts/graph_update.py {command}" not in level1:
            errors.append(f"references/level1.md: missing {command} invocation")
    return errors, dict(counts)


# Each event is one Read invocation. Heading intervals follow A1; repeated events
# remain in the read-inclusive sum, while the unique sum unions their line spans.
def event(path: str, heading: str | None, source: str) -> tuple[str, str | None, str]:
    return path, heading, source


def scenario_events(version: str, scenario: str) -> list[tuple[str, str | None, str]]:
    old = version == "before"
    if scenario in ("D0a", "D0b"):
        return [
            event("references/level1.md", None, "SKILL.md:197-198"),
            event("assets/worker-briefing.md", None, "SKILL.md:299"),
            event("references/FORM.md", "발화 지점 배정", "SKILL.md:38"),
            event("references/FORM.md", "목적 머리말", "references/level1.md:44"),
            event("references/FORM.md", "실행 기록", "references/level1.md:20"),
            event("references/FORM.md", "기동 보고", "SKILL.md:425"),
            event("references/FORM.md", "완료 보고", "SKILL.md:441"),
        ] if old else []
    if scenario == "S0":
        return [event("references/FORM.md", "발화 지점 배정", "SKILL.md:38")] if old else []
    if scenario in ("L1", "D1"):
        if old:
            events = [event("references/level1.md", None, "SKILL.md:197-198")]
            events += [event("assets/worker-briefing.md", None, "SKILL.md:299") for _ in range(3 if scenario == "L1" else 1)]
        else:
            events = [
                event("references/level1.md", "공통 `GRAPH.md` 기록", "SKILL.md:162"),
                event("references/level1.md", "레벨 1의 `GRAPH.md` 기록", "SKILL.md:162"),
            ]
            if scenario == "L1":
                events.append(event("assets/worker-briefing.md", None, "SKILL.md:212"))
            else:
                events += [
                    event("references/level2.md", "두 예산 — 사용자 왕복과 검토 라운드", "SKILL.md:230"),
                    event("references/level2.md", "팀장 직접 수정 검토", "SKILL.md:233"),
                    event("assets/review-briefing.md", None, "SKILL.md:232"),
                ]
        events += [
            event("references/FORM.md", "발화 지점 배정", f"SKILL.md:{38 if old else 53}"),
            event("references/FORM.md", "목적 머리말", "references/level1.md:44" if old else "SKILL.md:271"),
            event("references/FORM.md", "실행 기록", "references/level1.md:20" if old else "references/level1.md:23"),
        ]
        events += [event("references/FORM.md", "기동 보고", f"SKILL.md:{425 if old else 269}") for _ in range((3 if scenario == "L1" else 1) if old else 1)]
        events += [event("references/FORM.md", "완료 보고", f"SKILL.md:{441 if old else 273}")]
        return events
    if scenario == "L2":
        if old:
            events = [
                event("references/level2.md", None, "SKILL.md:483-487"),
                event("references/graph-patterns.md", None, "references/level2.md:7-8"),
            ]
            workers = 6
            events += [event("assets/worker-briefing.md", None, "SKILL.md:299") for _ in range(5)]
        else:
            events = [event("references/level2.md", heading, "SKILL.md:105,109,292") for heading in (
                "개발 워크플로우 단계", "설계", "계획 승인", "GRAPH.md", "실행", "완료 보고",
            )]
            events += [event("references/graph-patterns.md", heading, "SKILL.md:292") for heading in (
                "표기", "순차", "역할 분화",
            )]
            events += [
                event("references/level1.md", "공통 `GRAPH.md` 기록", "SKILL.md:293"),
                event("assets/worker-briefing.md", None, "SKILL.md:212"),
            ]
            workers = 4
        events += [event("assets/review-briefing.md", None, f"SKILL.md:{343 if old else 232}")]
        events += [
            event("references/FORM.md", "발화 지점 배정", f"SKILL.md:{38 if old else 53}"),
            event("references/FORM.md", "목적 머리말", f"references/level2.md:{174 if old else 195}"),
            event("references/FORM.md", "승인 화면", f"references/level2.md:{169 if old else 190}"),
            event("references/FORM.md", "실행 기록", f"references/level2.md:{266 if old else 261}"),
            event("references/FORM.md", "사용자 확정 게이트", "references/level2.md:단계 전이"),
        ]
        events += [event("references/FORM.md", "기동 보고", f"SKILL.md:{425 if old else 269}") for _ in range(workers if old else 1)]
        events += [event("references/FORM.md", "완료 보고", f"SKILL.md:{441 if old else 273}")]
        return events
    raise ValueError(scenario)


def measure(version: str, scenario: str) -> dict:
    skill_loaded = not (version == "after" and scenario in ("D0a", "D0b"))
    skill_text = read("SKILL.md", version) if skill_loaded else ""
    events = scenario_events(version, scenario)
    total = len(skill_text)
    covered: dict[str, set[int]] = defaultdict(set)
    parts = []
    for path, heading, source in events:
        lines, interval = intervals(read(path, version), heading)
        size = sum(len(lines[index]) for index in interval)
        total += size
        covered[path].update(interval)
        parts.append({"path": path, "heading": heading or "전체", "chars": size, "source": source})
    unique = len(skill_text)
    for path, indexes in covered.items():
        lines = read(path, version).splitlines(keepends=True)
        unique += sum(len(lines[index]) for index in indexes)
    workers = {"D0a": 1 if version == "before" else 0, "D0b": 1 if version == "before" else 0, "D1": 1, "S0": 0, "L1": 3, "L2": 6 if version == "before" else 4}[scenario]
    if version == "after" and scenario == "D1":
        workers = 1
    graph = int(scenario in ("D0a", "D0b", "D1", "L1", "L2") and (version == "before" or scenario not in ("D0a", "D0b")))
    if scenario == "S0":
        graph = 0
    return {
        "version": version, "scenario": scenario, "skill_chars": len(skill_text),
        "load_including_rereads": total, "load_unique": unique,
        "read_calls": len(events), "workers": workers, "graph_files": graph,
        "question_batches": 3 if scenario == "L2" and version == "before" else 1 if scenario == "L2" else 0,
        "parts": parts,
    }


def description_length(version: str) -> int:
    value = read("SKILL.md", version)
    match = re.search(r"^description:\s*'([^']*)'\s*$", value, re.M)
    if match is None:
        raise ValueError(f"description not found: {version}")
    return len(match.group(1))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--measure", action="store_true")
    args = parser.parse_args()
    errors, counts = source_audit()
    print("source audit:", json.dumps(counts, ensure_ascii=False, sort_keys=True))
    print("source errors:", len(errors))
    for item in errors:
        print("ERROR:", item)
    if args.measure:
        summary = {
            "description_chars": {v: description_length(v) for v in ("before", "after")},
            "scenarios": [measure(v, s) for s in ("D0a", "D0b", "D1", "S0", "L1", "L2") for v in ("before", "after")],
        }
        print("MEASUREMENT_JSON=" + json.dumps(summary, ensure_ascii=False))
    return int(bool(errors))


if __name__ == "__main__":
    raise SystemExit(main())
