# 인수인계: agent-orchestration 토큰 효율화 — 리뷰 결과 수령부터 이어서

작업 위치: 워크트리 D:\Paseo-Worktrees\27pr31l5\moody-wolf (브랜치 agent-orchestration-token-efficiency, 기준 커밋 5e833be)
실행 디렉터리 RUN: .skywork/paseo-orchestration/2026-09-22-token-debate/ (git 무시 경로)
먼저 읽을 것: AGENTS.md, RUN/GRAPH.md(실행 기록 — 노드·상태·agentId 정본), RUN/SPEC.md, RUN/MILESTONE01-Tasks.md

## 다른 PC에서 이어갈 때
- RUN 폴더는 .gitignore 대상이지만 이 작업 폴더만 `git add -f`로 커밋돼 있다(원시 로그 a6-direct/logs·a6-direct/logs-short·spike-logs 제외). 이후 RUN 파일 변경도 추적된다. 머지 전에 `git rm -r`로 정리한다(사용자가 직접).
- Paseo 프로필 notes는 PC별 설정이다. 시작 전에 list_profiles로 team-lead·spec notes가 plugins/paseo-toolkit/references/presets.md의 두 notes와 문자 단위로 같은지 확인하고, 다르면 사용자 승인 뒤 profile-setup으로 등록한다(C6 전제, 다르면 실측이 새 규칙으로 라우팅되지 않는다).
- 설치 경로: 경로 B는 그 PC의 체크아웃 경로로 마켓플레이스를 임시 전환한다(아래 절대 경로·설정 줄 번호는 원래 PC 기준이므로 그 PC에서 다시 조회). 브랜치가 원격에 있으므로 경로 A(마켓플레이스를 이 브랜치로 전환)도 가능하다 — 어느 쪽으로 할지 사용자에게 한 번 확인한다.
- 원래 PC(D:\Paseo-Worktrees\27pr31l5\moody-wolf)의 설치본·마켓플레이스는 바꾸지 않았다. 되돌릴 것 없음.
- RUN/.gset.py, RUN/a6-direct/evaluate.py는 상대 경로 기반이라 그대로 쓸 수 있다. evaluate.py는 로그 폴더를 스스로 만든다.

## 확정 상태
- SPEC.md 재확정 sha256 a1acb66b465ab3db (description은 트리 원문 복제 대신 의미 보존 축약, A6는 실제 스킬 설치 직접 측정)
- MILESTONE01-Tasks.md 재확정 607c4972a82a167f
- 백업: RUN/backup/ (SPEC.md.84e9f02b, MILESTONE01-Tasks.md.da5a024e, SKILL.md.desc987)
- T01~T12 완료. description 753자 축약판 채택(A6 통과: 1차 26/26, 재실행 13/13). team-lead·spec 실제 notes 등록 완료(C6 충족).
- 측정 도구: RUN/a6-direct/evaluate.py (claude-opus-5-5)

## 현재 상태
- 독립 리뷰(N39) 종료. 1라운드 지적 2건(A4 인용, C2 참조 깊이)은 N40 patch로 해결. 2라운드 지적 1건(patch가 git 무시 경로 RUN/.gitattributes를 범위 밖으로 추가)은 사용자 판단으로 비차단 수용했다(RUN/nodes/N39.round2.md). 검토 라운드 3 중 2 사용.
- 리뷰 종료 뒤 중간 커밋 완료(3893e78, 아래 승인 1).
- T13 1단계(N29) 완료: 두 plugin.json version 0.12.0(미커밋, 최종 커밋에 포함). claude.cmd plugin validate 플러그인·마켓플레이스 모두 종료 0·오류 0, 두 매니페스트 name·version·description 일치, codex skills 유지.
- 다음: T13 2단계 N41(GRAPH에 행 있음, 대기) — 아래 승인 3의 경로 B로 마켓플레이스 로컬 전환·설치본 갱신·원래 출처 기록·injectIntoAgents 확인.

## 사용자 승인 완료(재질문 불필요)
1. 리뷰 합격 뒤 중간 커밋: 스킬 변경 전부(수정 8 + 신규 references/system-prompt.md, scripts/graph_update.py) + references/presets.md + AGENTS.md 미커밋 수정 + 루트 handoff.md(사용자가 나중에 직접 지운다). 버전 변경은 제외. 한국어 커밋 메시지. push는 승인 범위 밖.
2. T13: 두 plugin.json version 0.11.0 → 0.12.0(minor). claude plugin validate(플러그인·.claude-plugin/marketplace.json) 오류 0, 두 매니페스트 name·version·description 일치, codex skills 필드 확인.
3. 설치 경로 B: sky-agent-plugins 마켓플레이스 출처가 claude(~/.claude/plugins/known_marketplaces.json)·codex(~/.codex/config.toml:133-135) 모두 GitHub다. 두 쪽을 이 워크트리 로컬 경로로 임시 전환해 설치본을 갱신하고, 실측이 끝나면 GitHub 출처로 되돌린다. 전환 전에 원래 설정값을 기록한다. 실측 전에 daemon.mcp.injectIntoAgents=true인지 읽어서 확인만 한다(바꿔야 하면 멈추고 승인).

## 남은 순서
T13 → T14~T17 병렬 실측(T16은 삭제 직전에 사용자 승인 G8) → 마켓플레이스 GitHub 복원 → T18 최종 보고 → 최종 커밋은 다시 승인받는다.

## 운영 메모
- codex 워커는 %TEMP%\skill-trigger-eval-* 임시 폴더를 지우지 못한다. 결과가 RUN에 옮겨진 것을 확인한 뒤 팀장이 지운다(사용자 허용).
- 이 PC에서 claude 실행 파일은 claude.cmd로 확정한다. 다른 Claude·codex 세션도 함께 돌고 있으므로 감시는 저장소·settings.json·설치 플러그인 목록만 한다.
- GRAPH.md 셀 갱신 보조 스크립트: python RUN/.gset.py <노드ID> "열=값" ...
- 새 노드 번호는 N42, G11부터 이어 붙인다(N41은 설치 노드로 이미 등록).

## 최종 보고에 넣을 후속 항목
- presets.md:215 team-lead "권한 근거" 문장이 새 notes(직접 처리)와 어긋난다(범위 밖이라 그대로 둠).
- AGENTS.md §6의 트리거 평가 규칙(~/.skywork/skill-trigger-eval 사본)은 발동을 거의 못 잡는 것으로 확인됐다(0.11.0 기준선 1/16).
- codex 쪽 발동 평가는 추가하지 않기로 함(사용자 결정).
- 독립 리뷰 2라운드 지적 1건(RUN/.gitattributes 범위 밖 추가)을 사용자 판단으로 비차단 수용함.
- description이 325자에서 753자로 늘어 모든 세션에 상시 비용이 붙는다. 효율 결론은 "워커 생략·재독 감소 확인, 전체 토큰/비용 절감률 미입증"으로 한정한다.
