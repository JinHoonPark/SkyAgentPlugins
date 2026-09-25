"""Create and update the single Mermaid diagram and node table in GRAPH.md."""

import argparse
import ast
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


COLUMNS = (
    "노드 ID", "종류", "프로필", "입력", "결과 파일", "합격 기준", "진행 조건",
    "워크스페이스", "되돌리기", "재시도", "검토 라운드", "게이트", "상태", "agentId",
)
HEADER = "| " + " | ".join(COLUMNS) + " |"
SEPARATOR = "| " + " | ".join(["---"] * len(COLUMNS)) + " |"
STATES = frozenset(("대기", "실행 중", "완료", "실패", "생략"))
NODE_ID = re.compile(r"[A-Za-z][A-Za-z0-9_]*\Z")
DEFINITION = re.compile(r"^\s*([A-Za-z][A-Za-z0-9_]*)\s*(?=[\[\{(])")
EDGE = re.compile(r"^\s*([A-Za-z][A-Za-z0-9_]*)\s*((?:--|==|-\.)[^\r\n]*?)\s*([A-Za-z][A-Za-z0-9_]*)\s*$")


class GraphError(Exception):
    """A user-correctable graph input or file error."""


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise GraphError(message)


def _plain(line):
    return line.rstrip("\r\n")


def _newline(text):
    match = re.search(r"\r\n|\n|\r", text)
    return match.group() if match else "\n"


def _one_line(value, label):
    if "\n" in value or "\r" in value:
        raise GraphError(f"{label}에 줄바꿈이 있습니다")


def _row(raw):
    _one_line(raw, "노드 행")
    if not raw.startswith("|") or not raw.endswith("|"):
        raise GraphError("노드 행은 앞뒤에 |가 있어야 합니다")
    cells = [cell.strip() for cell in raw[1:-1].split("|")]
    if len(cells) != len(COLUMNS):
        raise GraphError(f"노드 행은 {len(COLUMNS)}열이어야 합니다")
    if not NODE_ID.fullmatch(cells[0]):
        raise GraphError(f"잘못된 노드 ID: {cells[0]}")
    if cells[COLUMNS.index("상태")] not in STATES:
        raise GraphError(f"허용되지 않는 상태: {cells[COLUMNS.index('상태')]}")
    return cells


def _format_row(cells):
    return "| " + " | ".join(cells) + (" |" if cells[-1] else "|")


def _definitions(lines):
    found = set()
    for line in lines:
        match = DEFINITION.match(_plain(line))
        if match:
            node_id = match.group(1)
            if node_id in found:
                raise GraphError(f"중복된 mermaid 노드 정의: {node_id}")
            found.add(node_id)
    return found


def _edge_endpoints(line):
    match = EDGE.fullmatch(_plain(line))
    if match and any(arrow in match.group(2) for arrow in ("-->", "==>", "-.->", "---", "--o", "--x")):
        return match.group(1), match.group(3)
    return None


def _mermaid(text):
    text = text.lstrip("\ufeff").rstrip("\r\n")
    lines = text.splitlines()
    if len(lines) < 3 or lines[0] != "```mermaid" or lines[-1] != "```":
        raise GraphError("mermaid 입력은 ```mermaid 블록 하나여야 합니다")
    definitions = _definitions(lines[1:-1])
    if not definitions:
        raise GraphError("mermaid 노드 정의가 없습니다")
    return text, definitions


def _version(plugin_root):
    errors = []
    for agent in ("claude", "codex"):
        manifest = plugin_root / f".{agent}-plugin" / "plugin.json"
        try:
            data = json.loads(manifest.read_text(encoding="utf-8-sig"))
            value = data["version"]
            if not isinstance(value, str) or not value.strip():
                raise ValueError("version이 빈 문자열이거나 문자열이 아님")
            return value, None
        except (OSError, UnicodeError, ValueError, KeyError, TypeError) as exc:
            errors.append(f"{agent}: {type(exc).__name__}: {exc}")
    return "읽지 못함", "플러그인 버전 읽기 실패 (" + "; ".join(errors) + ")"


def _write_new(path, content):
    if path.exists():
        raise GraphError(f"이미 있는 경로: {path}")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".graph-update-", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(content.encode("utf-8"))
        os.link(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _replace(path, content):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".graph-update-", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(content.encode("utf-8"))
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def create(path, mermaid_text, raw_rows, plugin_root):
    mermaid_text, definitions = _mermaid(mermaid_text)
    if not raw_rows:
        raise GraphError("노드 행을 하나 이상 지정해야 합니다")
    rows = {}
    for raw in raw_rows:
        cells = _row(raw)
        if cells[0] in rows:
            raise GraphError(f"중복된 노드 ID 행: {cells[0]}")
        rows[cells[0]] = _format_row(cells)
    if definitions != rows.keys():
        raise GraphError("mermaid 노드 정의와 표의 노드 ID가 일치하지 않습니다")
    version, warning = _version(plugin_root)
    newline = _newline(mermaid_text)
    content = (f"버전 : {version}{newline}{newline}{mermaid_text}{newline}{newline}"
               f"{HEADER}{newline}{SEPARATOR}{newline}"
               + "".join(row + newline for row in rows.values()))
    path.parent.mkdir(parents=True, exist_ok=True)
    _write_new(path, content)
    return len(rows), warning


def _graph(path):
    text = path.read_bytes().decode("utf-8-sig")
    lines = text.splitlines(keepends=True)
    plain = [_plain(line) for line in lines]
    if plain.count("```mermaid") != 1:
        raise GraphError("mermaid 블록을 하나만 찾을 수 있어야 합니다")
    opening = plain.index("```mermaid")
    try:
        closing = plain.index("```", opening + 1)
    except ValueError as exc:
        raise GraphError("mermaid 닫는 펜스가 없습니다") from exc
    definitions = _definitions(lines[opening + 1:closing])
    if plain.count(HEADER) != 1:
        raise GraphError("14열 노드 표 헤더를 하나만 찾을 수 있어야 합니다")
    header = plain.index(HEADER)
    if header <= closing or header + 1 >= len(lines) or plain[header + 1] != SEPARATOR:
        raise GraphError("노드 표 위치 또는 구분 행이 잘못되었습니다")
    rows = {}
    end = header + 2
    while end < len(lines) and plain[end].startswith("|"):
        cells = _row(plain[end])
        if cells[0] in rows:
            raise GraphError(f"중복된 노드 ID 행: {cells[0]}")
        rows[cells[0]] = end
        end += 1
    return lines, closing, end, rows, definitions, _newline(text)


def add_row(path, raw_row, node_line, edges):
    cells = _row(raw_row)
    node_id = cells[0]
    _one_line(node_line, "노드 정의")
    match = DEFINITION.match(node_line)
    if not match or match.group(1) != node_id:
        raise GraphError(f"{node_id}의 mermaid 노드 정의 줄이 필요합니다")
    for edge in edges:
        _one_line(edge, "관계선")
        if not edge.strip() or edge.strip().startswith("```"):
            raise GraphError("잘못된 mermaid 관계선")
    lines, closing, end, rows, definitions, newline = _graph(path)
    if node_id in rows or node_id in definitions:
        raise GraphError(f"이미 있는 노드 ID: {node_id}")
    additions = [node_line + newline] + [edge + newline for edge in edges]
    lines[closing:closing] = additions
    end += len(additions)
    if end and not lines[end - 1].endswith(("\r", "\n")):
        lines[end - 1] += newline
    lines.insert(end, _format_row(cells) + newline)
    _replace(path, "".join(lines))


def set_cells(path, node_id, assignments):
    if not NODE_ID.fullmatch(node_id):
        raise GraphError(f"잘못된 노드 ID: {node_id}")
    changes = {}
    for assignment in assignments:
        name, separator, value = assignment.partition("=")
        if not separator or name not in COLUMNS or name == "노드 ID":
            raise GraphError(f"모르는 열 또는 변경 불가 열: {name}")
        if name in changes:
            raise GraphError(f"중복 지정한 열: {name}")
        _one_line(value, name)
        if "|" in value:
            raise GraphError(f"{name} 값에 |가 있습니다")
        if name == "상태" and value not in STATES:
            raise GraphError(f"허용되지 않는 상태: {value}")
        changes[name] = value
    if not changes:
        raise GraphError("변경할 열을 하나 이상 지정해야 합니다")
    lines, _, _, rows, _, _ = _graph(path)
    if node_id not in rows:
        raise GraphError(f"대상 노드 없음: {node_id}")
    index = rows[node_id]
    original = lines[index]
    body = _plain(original)
    ending = original[len(body):]
    parts = body.split("|")
    for name, value in changes.items():
        parts[COLUMNS.index(name) + 1] = f" {value} " if value else " "
    lines[index] = "|".join(parts) + ending
    _replace(path, "".join(lines))
    return len(changes)


def remove_node(path, node_id):
    if not NODE_ID.fullmatch(node_id):
        raise GraphError(f"잘못된 노드 ID: {node_id}")
    lines, closing, _, rows, definitions, _ = _graph(path)
    if node_id not in rows and node_id not in definitions:
        raise GraphError(f"대상 노드 없음: {node_id}")
    remove = {rows[node_id]} if node_id in rows else set()
    for index in range(closing):
        definition = DEFINITION.match(_plain(lines[index]))
        endpoints = _edge_endpoints(lines[index])
        if (definition and definition.group(1) == node_id) or (endpoints and node_id in endpoints):
            remove.add(index)
    _replace(path, "".join(line for index, line in enumerate(lines) if index not in remove))


def remove_edge(path, edge):
    _one_line(edge, "관계선")
    if not _edge_endpoints(edge):
        raise GraphError("잘못된 mermaid 관계선")
    lines, closing, _, _, _, _ = _graph(path)
    for index in range(closing):
        if _plain(lines[index]) == edge:
            del lines[index]
            _replace(path, "".join(lines))
            return
    raise GraphError(f"대상 관계선 없음: {edge}")


def add_edge(path, edge):
    _one_line(edge, "관계선")
    if not _edge_endpoints(edge):
        raise GraphError("잘못된 mermaid 관계선")
    lines, closing, _, _, _, newline = _graph(path)
    if any(_plain(line) == edge for line in lines[:closing]):
        raise GraphError(f"이미 있는 관계선: {edge}")
    lines.insert(closing, edge + newline)
    _replace(path, "".join(lines))


def _parser():
    parser = Parser(description="GRAPH.md의 mermaid와 14열 노드 표를 갱신합니다")
    commands = parser.add_subparsers(dest="command", required=True, parser_class=Parser)
    creation = commands.add_parser("create", help="새 GRAPH.md 생성")
    creation.add_argument("path", type=Path)
    source = creation.add_mutually_exclusive_group(required=True)
    source.add_argument("--mermaid-file", type=Path)
    source.add_argument("--mermaid-stdin", action="store_true")
    creation.add_argument("--row", action="append", default=[], help="14열 | 구분 행; 반복 가능")
    addition = commands.add_parser("add-row", help="mermaid 노드와 표 행 동시 추가")
    addition.add_argument("path", type=Path)
    addition.add_argument("--row", required=True)
    addition.add_argument("--node-line", required=True)
    addition.add_argument("--edge", action="append", default=[], help="관계선; 반복 가능")
    removal = commands.add_parser("remove-node", help="노드 정의·끝점 관계선·표 행 삭제")
    removal.add_argument("path", type=Path)
    removal.add_argument("node_id")
    edge_removal = commands.add_parser("remove-edge", help="지정 관계선 삭제")
    edge_removal.add_argument("path", type=Path)
    edge_removal.add_argument("--edge", required=True)
    edge_addition = commands.add_parser("add-edge", help="관계선 추가")
    edge_addition.add_argument("path", type=Path)
    edge_addition.add_argument("--edge", required=True)
    change = commands.add_parser("set", help="기존 노드 행의 지정 열 변경")
    change.add_argument("path", type=Path)
    change.add_argument("node_id")
    change.add_argument("assignments", nargs="+", metavar="열=값")
    return parser


def run_cli(argv, stdin, stdout, stderr, plugin_root=None):
    try:
        if argv == ["--self-test"]:
            return self_test(stdout, stderr)
        args = _parser().parse_args(argv)
        if args.command == "create":
            if args.mermaid_file is not None:
                mermaid_text = args.mermaid_file.read_bytes().decode("utf-8-sig")
            else:
                if stdin.isatty():
                    raise GraphError("대화형 표준 입력은 읽지 않습니다; 파일이나 리다이렉션을 쓰세요")
                mermaid_text = stdin.read().decode("utf-8-sig")
            root = plugin_root or Path(__file__).resolve().parents[3]
            count, warning = create(args.path, mermaid_text, args.row, root)
            if warning:
                print(warning, file=stderr)
            print(f"생성: {args.path} ({count}개 노드)", file=stdout)
        elif args.command == "add-row":
            add_row(args.path, args.row, args.node_line, args.edge)
            print(f"행 추가: {args.path} ({_row(args.row)[0]})", file=stdout)
        elif args.command == "remove-node":
            remove_node(args.path, args.node_id)
            print(f"노드 삭제: {args.path} ({args.node_id})", file=stdout)
        elif args.command == "remove-edge":
            remove_edge(args.path, args.edge)
            print(f"관계선 삭제: {args.path} ({args.edge})", file=stdout)
        elif args.command == "add-edge":
            add_edge(args.path, args.edge)
            print(f"관계선 추가: {args.path} ({args.edge})", file=stdout)
        else:
            count = set_cells(args.path, args.node_id, args.assignments)
            print(f"열 변경: {args.path} ({args.node_id}, {count}개 열)", file=stdout)
        return 0
    except SystemExit as exc:
        return int(exc.code)
    except BaseException as exc:
        message = " ".join(str(exc).splitlines()) or type(exc).__name__
        print(f"오류: {message}", file=stderr)
        return 1


def self_test(stdout, stderr):
    """Exercise G1-G16 using disposable files outside the repository."""
    failures = []
    failed_calls = []

    def check(condition, message):
        if not condition:
            raise AssertionError(message)

    def invoke(argv, source=b"", root=None, stdin=None):
        output = io.StringIO()
        diagnostics = io.StringIO()
        code = run_cli(argv, stdin or io.BytesIO(source), output, diagnostics, root)
        result = (code, output.getvalue(), diagnostics.getvalue())
        if code != 0:
            failed_calls.append(result)
        return result

    def succeeded(result):
        check(result[0] == 0, f"종료 코드 {result[0]}: {result[2]}")

    def rejected(result):
        check(result[0] != 0, "잘못된 입력이 성공했습니다")
        check(bool(result[2].strip()), "실패 진단이 없습니다")

    try:
        form = (Path(__file__).resolve().parents[1] / "references" / "FORM.md")
        section = form.read_bytes().decode("utf-8-sig").split("## 실행 기록", 1)[1]
        section = section.split("## 기동 보고", 1)[0]
        samples = re.findall(r"````text\r?\n(.*?)\r?\n````", section, re.DOTALL)
        check(len(samples) >= 2, "FORM 실행 기록의 두 견본을 찾지 못했습니다")
        basic, level_one = samples[:2]
        mermaid_pattern = r"```mermaid\r?\n.*?\r?\n```"
        basic_mermaid = re.search(mermaid_pattern, basic, re.DOTALL).group()
        level_mermaid = re.search(mermaid_pattern, level_one, re.DOTALL).group()
        basic_lines = basic.splitlines()
        row_start = basic_lines.index(SEPARATOR) + 1
        sample_rows = [line for line in basic_lines[row_start:] if line.startswith("|")]
        check(len(sample_rows) == 5, "기본 견본의 노드 행 수가 예상과 다릅니다")
        root = Path(__file__).resolve().parents[3]
        version, _ = _version(root)
        with tempfile.TemporaryDirectory(prefix="graph-update-test-") as disposable:
            temp = Path(disposable).resolve()
            repository = Path(__file__).resolve().parents[5]
            check(temp != repository and repository not in temp.parents,
                  "자체 테스트 임시 디렉터리가 저장소 안에 있습니다")

            def area(name):
                directory = temp / name
                directory.mkdir()
                return directory

            def base_graph(name):
                path = area(name) / "GRAPH.md"
                path.write_bytes(basic_graph)
                return path

            def new_row(node_id):
                cells = [node_id] + ["—"] * 11 + ["대기", ""]
                return _format_row(cells)

            def unchanged_failure(argv, path):
                before = path.read_bytes() if path.exists() else None
                rejected(invoke(argv))
                after = path.read_bytes() if path.exists() else None
                check(after == before, "거부한 명령이 대상 파일을 변경했습니다")

            def g1():
                directory = area("g1")
                source = directory / "mermaid.md"
                source.write_bytes(basic_mermaid.encode("utf-8"))
                target = directory / "GRAPH.md"
                succeeded(invoke(["create", str(target), "--mermaid-file", str(source)]
                                 + [part for row in sample_rows for part in ("--row", row)]))
                expected = basic.replace("{플러그인 버전}", version) + _newline(basic)
                check(target.read_bytes() == expected.encode("utf-8"),
                      "기본 견본과 생성 결과가 문자 단위로 다릅니다")
                level_source = directory / "level1.md"
                level_source.write_bytes(level_mermaid.encode("utf-8"))
                level_target = directory / "LEVEL1-GRAPH.md"
                level_rows = [row for row in sample_rows if _row(row)[0] != "G1"]
                succeeded(invoke(["create", str(level_target), "--mermaid-file", str(level_source)]
                                 + [part for row in level_rows for part in ("--row", row)]))
                newline = _newline(level_mermaid)
                expected = (f"버전 : {version}{newline}{newline}{level_mermaid}{newline}{newline}"
                            f"{HEADER}{newline}{SEPARATOR}{newline}"
                            + "".join(row + newline for row in level_rows))
                check(level_target.read_bytes() == expected.encode("utf-8"),
                      "레벨 1 견본의 mermaid 또는 노드 행이 다릅니다")
                return target.read_bytes()

            basic_graph = b""

            def test_g1():
                nonlocal basic_graph
                basic_graph = g1()

            def test_g2():
                directory = area("g2")
                cases = (
                    ("claude-first", '{"version":"1.2.3"}', '{"version":"9.9.9"}', "1.2.3", False),
                    ("codex-fallback", None, '{"version":"2.3.4"}', "2.3.4", False),
                    ("json-fallback", "{broken", '{"version":"3.4.5"}', "3.4.5", False),
                    ("both-missing", None, None, "읽지 못함", True),
                    ("both-invalid", "{broken", "{broken", "읽지 못함", True),
                    ("version-missing", "{}", "{}", "읽지 못함", True),
                )
                for name, claude, codex, expected, warning in cases:
                    fixture = directory / name
                    fixture.mkdir()
                    for agent, data in (("claude", claude), ("codex", codex)):
                        if data is not None:
                            manifest = fixture / f".{agent}-plugin" / "plugin.json"
                            manifest.parent.mkdir()
                            manifest.write_text(data, encoding="utf-8")
                    target = fixture / "GRAPH.md"
                    result = invoke(["create", str(target), "--mermaid-stdin"]
                                    + [part for row in sample_rows for part in ("--row", row)],
                                    basic_mermaid.encode("utf-8"), fixture)
                    succeeded(result)
                    check(target.read_text(encoding="utf-8").splitlines()[0] == f"버전 : {expected}",
                          f"{name}: 버전 우선순위 오류")
                    check(bool(result[2].strip()) == warning, f"{name}: 진단 출력 오류")

            def test_g3():
                target = base_graph("g3")
                source = target.parent / "mermaid.md"
                source.write_bytes(basic_mermaid.encode("utf-8"))
                unchanged_failure(["create", str(target), "--mermaid-file", str(source)]
                                  + [part for row in sample_rows for part in ("--row", row)], target)

            def test_g4():
                target = base_graph("g4")
                before = target.read_bytes().decode("utf-8")
                newline = _newline(before)
                node = '    N5["[ N5 · 검증 ]<br/>gpt-5.6-sol<br/>추가 작업"]'
                edge = "    N4 -->|통과| N5"
                row = new_row("N5")
                succeeded(invoke(["add-row", str(target), "--row", row,
                                  "--node-line", node, "--edge", edge]))
                marker = f"```{newline}{newline}{HEADER}"
                check(before.count(marker) == 1, "견본의 mermaid와 표 경계가 다릅니다")
                expected = before.replace(marker, f"{node}{newline}{edge}{newline}{marker}", 1)
                expected += row + newline
                check(target.read_bytes() == expected.encode("utf-8"),
                      "행 위치, mermaid 위치 또는 다른 줄 보존 오류")

            def test_g5():
                target = base_graph("g5-row")
                unchanged_failure(["add-row", str(target), "--row", sample_rows[0],
                                  "--node-line", '    N1["중복"]'], target)
                target = base_graph("g5-definition")
                text = target.read_bytes().decode("utf-8")
                newline = _newline(text)
                text = text.replace(f"```{newline}{newline}{HEADER}",
                                    f'    N6["기존 정의"]{newline}```{newline}{newline}{HEADER}', 1)
                target.write_bytes(text.encode("utf-8"))
                unchanged_failure(["add-row", str(target), "--row", new_row("N6"),
                                  "--node-line", '    N6["새 정의"]'], target)
                target = base_graph("g5-no-definition")
                unchanged_failure(["add-row", str(target), "--row", new_row("N6")], target)
                unchanged_failure(["add-row", str(target), "--row", new_row("N6"),
                                  "--node-line", "    N6 --> N1"], target)

            def test_g6():
                target = base_graph("g6")
                before = target.read_bytes().decode("utf-8")
                succeeded(invoke(["set", str(target), "N1", "상태=완료"]))
                changed = sample_rows[0].replace("| 실행 중 |", "| 완료 |", 1)
                expected = before.replace(sample_rows[0], changed, 1)
                check(target.read_bytes() == expected.encode("utf-8"),
                      "단일 열 이외의 바이트가 바뀌었습니다")
                succeeded(invoke(["set", str(target), "N2", "상태=실행 중",
                                  "agentId=agent-2", "검토 라운드=상한 3 · 사용 1"]))
                changed = sample_rows[1].replace("| 대기 |", "| 실행 중 |", 1)
                changed = changed.replace("| 상한 3 · 사용 0 |", "| 상한 3 · 사용 1 |", 1)
                changed = changed[:-1] + "agent-2 |"
                expected = expected.replace(sample_rows[1], changed, 1)
                check(target.read_bytes() == expected.encode("utf-8"),
                      "여러 열 외의 바이트가 바뀌었습니다")

            def test_g7():
                target = base_graph("g7")
                for node_id, assignment in (("N99", "상태=완료"), ("N1", "없는 열=값"),
                                            ("N1", "입력=a|b"), ("N1", "입력=a\nb"),
                                            ("N1", "상태=검토 중")):
                    unchanged_failure(["set", str(target), node_id, assignment], target)
                duplicate = base_graph("g7-duplicate")
                duplicate.write_bytes(duplicate.read_bytes() +
                                      (sample_rows[0] + _newline(basic)).encode("utf-8"))
                unchanged_failure(["set", str(duplicate), "N1", "상태=완료"], duplicate)

            def test_g8():
                target = area("g8") / "GRAPH.md"
                unchanged_failure(["add-row", str(target), "--row", new_row("N6"),
                                  "--node-line", '    N6["새 노드"]'], target)
                unchanged_failure(["set", str(target), "N1", "상태=완료"], target)
                check(not target.exists(), "없는 GRAPH.md가 만들어졌습니다")

            def test_g9():
                directory = area("g9")
                mermaid = basic_mermaid.replace("\r\n", "\n").replace("\n", "\r\n")
                source = directory / "mermaid.md"
                source.write_bytes(b"\xef\xbb\xbf" + mermaid.encode("utf-8"))
                target = directory / "GRAPH.md"
                succeeded(invoke(["create", str(target), "--mermaid-file", str(source)]
                                 + [part for row in sample_rows for part in ("--row", row)]))
                created = target.read_bytes()
                check(not created.startswith(b"\xef\xbb\xbf") and "합격 기준" in created.decode("utf-8"),
                      "한글 보존 또는 BOM 없는 생성 실패")
                check(b"\r\n" in created and b"\n" not in created.replace(b"\r\n", b""),
                      "생성 시 CRLF가 유지되지 않았습니다")
                target.write_bytes(b"\xef\xbb\xbf" + created)
                succeeded(invoke(["set", str(target), "N1", "상태=완료"]))
                changed = target.read_bytes()
                check(not changed.startswith(b"\xef\xbb\xbf") and b"\n" not in changed.replace(b"\r\n", b""),
                      "BOM 입력 처리 또는 열 변경의 CRLF 유지 실패")
                succeeded(invoke(["add-row", str(target), "--row", new_row("N6"),
                                  "--node-line", '    N6["한글 추가"]']))
                changed = target.read_bytes()
                check("한글 추가" in changed.decode("utf-8") and
                      b"\n" not in changed.replace(b"\r\n", b""),
                      "행 추가의 한글 또는 CRLF 유지 실패")

            def test_g10():
                check(len(failed_calls) >= 10, "실패 사례가 충분히 실행되지 않았습니다")
                for code, _, diagnostic in failed_calls:
                    check(code != 0 and diagnostic.strip() and "Traceback" not in diagnostic,
                          "실패 종료 코드, 진단 또는 트레이스백 오류")
                process = subprocess.run([sys.executable, str(Path(__file__).resolve()), "create"],
                                         input=b"", capture_output=True, timeout=3, check=False)
                check(process.returncode != 0 and process.stderr and
                      b"Traceback" not in process.stderr,
                      "CLI 실패 진단 또는 입력 대기 오류")

                class Interactive(io.BytesIO):
                    def isatty(self):
                        return True

                    def read(self, *args):
                        raise AssertionError("대화형 입력을 읽었습니다")

                target = temp / "never-created.md"
                rejected(invoke(["create", str(target), "--mermaid-stdin", "--row", sample_rows[0]],
                                stdin=Interactive()))
                check(not target.exists(), "대화형 입력 오류 후 파일이 만들어졌습니다")

            def test_g11():
                tree = ast.parse(Path(__file__).read_text(encoding="utf-8"))
                imported = set()
                for node in ast.walk(tree):
                    if isinstance(node, ast.Import):
                        imported.update(alias.name.split(".", 1)[0] for alias in node.names)
                    elif isinstance(node, ast.ImportFrom) and node.module:
                        imported.add(node.module.split(".", 1)[0])
                stdlib = getattr(sys, "stdlib_module_names", frozenset(
                    "argparse ast io json os pathlib re subprocess sys tempfile".split()))
                check(imported <= stdlib,
                      f"표준 라이브러리 밖 import: {sorted(imported - stdlib)}")

            def test_g12():
                target = base_graph("g12")
                before = target.read_text(encoding="utf-8")
                newline = _newline(before)
                removed = ['    N1["[ N1 · 단순 탐색 ]<br/>gpt-5.6-luna<br/>UI 변경 파일 수집"]',
                           '    N1 -->|확정 요청| G1', '    G1 -->|피드백| N1',
                           '    N1 -->|통과| N2', '    N1 -->|통과| N3',
                           '    N2 -->|피드백: 수정 필요, 잔여 2회| N1', sample_rows[0]]
                succeeded(invoke(["remove-node", str(target), "N1"]))
                expected = before
                for line in removed:
                    check(line + newline in expected, f"삭제 확인용 줄 없음: {line}")
                    expected = expected.replace(line + newline, "", 1)
                check(target.read_text(encoding="utf-8") == expected,
                      "노드 정의·끝점 관계선·표 행 삭제 또는 다른 줄 보존 오류")

            def test_g13():
                target = base_graph("g13")
                before = target.read_text(encoding="utf-8")
                old = "    N1 -->|통과| N2"
                new = "    N3 -->|재검토| N2"
                newline = _newline(before)
                succeeded(invoke(["remove-edge", str(target), "--edge", old]))
                check(target.read_text(encoding="utf-8") == before.replace(old + newline, "", 1),
                      "지정 관계선만 삭제하지 않았습니다")
                succeeded(invoke(["add-edge", str(target), "--edge", new]))
                expected = before.replace(old + newline, "", 1)
                expected = expected.replace(f"```{newline}{newline}{HEADER}",
                                            f"{new}{newline}```{newline}{newline}{HEADER}", 1)
                check(target.read_text(encoding="utf-8") == expected,
                      "새 관계선 추가 또는 다른 관계선 보존 오류")

            def test_g14():
                target = base_graph("g14")
                before = target.read_text(encoding="utf-8")
                newline = _newline(before)
                definition = '    N2["[ N2 · 리뷰·검증 ]<br/>gpt-5.6-sol<br/>변경분 검토"]'
                check(definition + newline in before, "정의 제거용 줄 없음")
                before = before.replace(definition + newline, "", 1)
                target.write_text(before, encoding="utf-8")
                succeeded(invoke(["set", str(target), "N2", "상태=완료"]))
                expected = before.replace(sample_rows[1],
                                          sample_rows[1].replace("| 대기 |", "| 완료 |", 1), 1)
                check(target.read_text(encoding="utf-8") == expected,
                      "mermaid 정의 없는 표 행의 열 변경 실패")

            def test_g15():
                directory = area("g15")
                target = directory / "nested" / "GRAPH.md"
                succeeded(invoke(["create", str(target), "--mermaid-stdin"]
                                 + [part for row in sample_rows for part in ("--row", row)],
                                 basic_mermaid.encode("utf-8")))
                check(target.is_file() and target.parent.is_dir(),
                      "없는 부모 디렉터리 또는 GRAPH.md를 만들지 않았습니다")

            def test_g16():
                target = base_graph("g16")
                unchanged_failure(["create", str(target), "--mermaid-stdin"]
                                  + [part for row in sample_rows for part in ("--row", row)], target)

            tests = (test_g1, test_g2, test_g3, test_g4, test_g5, test_g6,
                     test_g7, test_g8, test_g9, test_g10, test_g11,
                     test_g12, test_g13, test_g14, test_g15, test_g16)
            for number, test in enumerate(tests, 1):
                try:
                    test()
                    print(f"G{number} 통과", file=stdout)
                except BaseException as exc:
                    failures.append(number)
                    message = " ".join(str(exc).splitlines()) or type(exc).__name__
                    print(f"G{number} 실패: {message}", file=stderr)
    except BaseException as exc:
        message = " ".join(str(exc).splitlines()) or type(exc).__name__
        print(f"자체 테스트 준비 실패: {message}", file=stderr)
        return 1
    return 1 if failures else 0


def main():
    return run_cli(sys.argv[1:], sys.stdin.buffer, sys.stdout, sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
