"""Print the current attempt's failure report and only the result's conclusion."""

import argparse
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path


def print_conclusion(path, stdout, stderr):
    found = False
    fence = None
    try:
        with path.open(encoding="utf-8-sig") as source:
            for number, line in enumerate(source, 1):
                marker = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line.rstrip("\r\n"))
                if fence:
                    if marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence) and not marker[2].strip():
                        fence = None
                elif marker:
                    fence = marker[1]
                else:
                    if not found and re.fullmatch(r"##[ \t]+결론[ \t]*", line.rstrip("\r\n")):
                        found = True
                        print(f"[결론] {path}:{number}", file=stdout)
                    elif found and re.match(r"^#{1,2}(?:[ \t]+|$)", line):
                        break
                if found:
                    print(line, end="", file=stdout)
        if not found:
            print(f"결론 절 없음: {path}", file=stderr)
    except (OSError, UnicodeError) as exc:
        print(f"결과 파일 확인 불가: {path}: {exc}", file=stderr)


def intake(failure, result, stdout, stderr):
    if failure is None:
        print("현재 시도의 실패 보고 경로가 필요합니다.", file=stderr)
        return 0
    try:
        # Opening directly distinguishes absence from an unreadable report.
        with failure.open(encoding="utf-8-sig") as source:
            print(f"[실패 보고 있음] {failure}", file=stdout)
            content = source.read()
            print(content, end="" if content.endswith("\n") else "\n", file=stdout)
    except FileNotFoundError:
        print(f"[실패 보고 없음] {failure}", file=stdout)
    except (OSError, UnicodeError) as exc:
        print(f"실패 보고 확인 불가: {failure}: {exc}", file=stderr)
    if result is not None:
        print_conclusion(result, stdout, stderr)
    return 0


def self_test(stdout, stderr):
    """Exercise the CLI with retained fixtures; no files are deleted."""
    directory = Path(tempfile.mkdtemp(prefix="intake-result-test-"))
    print(f"검증 입력 경로(보존): {directory}", file=stdout)
    result = directory / "result.md"
    result.write_text("# 결과\n본문 앞부분 제외\n## 결론\n압축한 답 — UTF-8\n### 상세\n기준별 근거\n## 증빙\n본문 뒷부분 제외\n", encoding="utf-8")
    failure = directory / "failure.md"
    failure.write_text("시도 번호: 1\n실패 사유\n", encoding="utf-8")
    no_conclusion = directory / "no-conclusion.md"
    no_conclusion.write_text("# 결과\n## 증빙\n전체 본문 제외\n", encoding="utf-8")
    fenced = directory / "fenced.md"
    fenced.write_text("```md\n## 결론\n가짜 결론 제외\n```\n## 결론\n압축한 답\n~~~md\n## 증빙\n코드 안 제목 유지\n~~~\n# 다음\n다음 본문 제외\n", encoding="utf-8")
    crlf = directory / "crlf.md"
    crlf.write_bytes("## 결론\r\n마지막 답".encode("utf-8"))
    missing = directory / "missing.md"
    cases = [
        ("실패 없음 + 결론", [missing, result], ["[실패 보고 없음]", "압축한 답 — UTF-8", "기준별 근거"], ["본문 앞부분 제외", "본문 뒷부분 제외"], ""),
        ("실패 있음 + 결론", [failure, result], ["[실패 보고 있음]", "실패 사유", "[결론]"], ["본문 뒷부분 제외"], ""),
        ("결과 없음", [missing, missing], ["[실패 보고 없음]"], ["[결론]"], "결과 파일 확인 불가"),
        ("결론 없음", [missing, no_conclusion], ["[실패 보고 없음]"], ["전체 본문 제외", "[결론]"], "결론 절 없음"),
        ("입력 없음", [], [], ["[결론]", "[실패 보고 없음]"], "실패 보고 경로가 필요"),
        ("파일 수정 결과", [missing], ["[실패 보고 없음]"], ["[결론]"], ""),
        ("코드 블록 제목", [missing, fenced], ["압축한 답", "코드 안 제목 유지"], ["가짜 결론 제외", "다음 본문 제외"], ""),
        ("CRLF + 파일 끝 결론", [missing, crlf], ["마지막 답"], [], ""),
        ("실패 보고 읽기 불가", [directory, result], ["[결론]"], ["[실패 보고 없음]"], "실패 보고 확인 불가"),
    ]
    environment = dict(os.environ)
    environment.pop("PYTHONIOENCODING", None)
    environment.pop("PYTHONUTF8", None)
    environments = [
        ("옵션·인코딩 환경변수 없음", environment),
        ("cp949 강제", dict(environment, PYTHONIOENCODING="cp949", PYTHONUTF8="0")),
    ]
    failures = 0
    for encoding_name, child_environment in environments:
        for name, arguments, included, excluded, diagnostic in cases:
            completed = subprocess.run([sys.executable, str(Path(__file__).resolve()),
                                        *map(str, arguments)], capture_output=True, env=child_environment)
            try:
                output = completed.stdout.decode("utf-8")
                diagnostics = completed.stderr.decode("utf-8")
            except UnicodeError as exc:
                failures += 1
                print(f"{encoding_name} / {name}: 실패 · 종료 코드 {completed.returncode}", file=stdout)
                print(f"UTF-8 출력 아님: {exc}", file=stderr)
                continue
            valid = (completed.returncode == 0
                     and all(value in output for value in included)
                     and all(value not in output for value in excluded)
                     and (diagnostic in diagnostics if diagnostic else not diagnostics))
            if name == "실패 있음 + 결론":
                valid = valid and output.index("실패 사유") < output.index("[결론]")
            failures += not valid
            print(f"{encoding_name} / {name}: {'통과' if valid else '실패'} · 종료 코드 {completed.returncode}", file=stdout)
            if not valid:
                print(output + diagnostics, file=stderr)
    return 1 if failures else 0


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("failure", nargs="?", type=Path, help="current attempt's failure report")
    parser.add_argument("result", nargs="?", type=Path, help="result report with a ## 결론 section")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return self_test(sys.stdout, sys.stderr)
    return intake(args.failure, args.result, sys.stdout, sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
