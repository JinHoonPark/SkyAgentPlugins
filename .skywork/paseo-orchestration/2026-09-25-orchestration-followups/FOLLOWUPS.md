# agent-orchestration 후속 개선 — 스펙 입력 목록

새 세션에서 스펙 작성의 입력으로 쓴다. 항목은 후보이며, 무엇을 범위에 넣을지는 스펙 단계에서 사용자와 정한다.

- 대상: `plugins/paseo-toolkit/skills/agent-orchestration/`와 `plugins/paseo-toolkit/references/presets.md`, `plugins/paseo-toolkit/skills/profile-setup/SKILL.md`
- 기준 판본: paseo-toolkit 0.12.0, 커밋 `621e94b`(브랜치 `agent-orchestration-token-efficiency`, main 미머지·미푸시), SKILL.md sha256 앞 16자 `8b4fc8139826703d`, 18,175자, description 1,010자
- 이전 실행 기록: `.skywork/paseo-orchestration/2026-09-22-token-debate/`(이하 PREV). 근거 파일: `PREV/nodes/N99.md`(최종 대조), `PREV/nodes/N100.md`(자문 분석), `PREV/nodes/N101.md`(Opus 5.5 max 분석)
- 아래 `S/`는 `plugins/paseo-toolkit/skills/agent-orchestration/`, `P/`는 `plugins/paseo-toolkit/`다. 줄 번호는 `621e94b` 기준이다.

## 이전 작업에서 사용자가 확정한 결정

새 스펙에서 바꾸려면 사용자 승인을 다시 받는다.

- 작업 도중 전환은 사용자 명시 전환("이제 워커한테 맡겨", "오케스트레이션으로 전환해")으로 한다. 훅과 appendSystemPrompt는 쓰지 않는다.
- 삭제 전 스킬 로드는 기록만 한다. 승인 전 멈춤은 필수다.
- 검토 순서는 순차 규칙을 유지한다(위임한 실행·테스트 결과 뒤 검토).
- 경미한 수정 = 한 파일의 기존 상수·설정값 한 줄 변경을 실행·테스트로 확인한 경우. 검토를 생략하고 생략 사실과 증빙을 보고한다. 정의는 `S/SKILL.md:41` 한 곳에만 둔다.
- 규칙 문구에는 이유·설명을 넣지 않고 규칙 문장만 쓴다.
- 직접 지시 과발동(4/15)은 한계로 기록했다.
- 스킬 문구 축약은 "부작용 없음"(발동 조건, 규칙·예외·순서, 읽는 파일·절·시점, 링크·헤딩, 브리핑 내용, 행동이 모두 불변)을 조건으로 했다.

## 제약

- description은 1,024자 상한까지 14자 남았다. description을 늘리는 항목은 다른 문구를 줄이는 것과 함께 정해야 하고, 발동 조건을 바꾸면 트리거 평가를 다시 해야 한다(AGENTS.md §6).
- SKILL.md 길이는 이전 스펙에서 변경 전 판본 이하를 조건으로 했다. 새 스펙에서 기준을 다시 정한다.

## A. 문서 결함 (고치는 방법이 거의 하나)

| ID | 내용 | 근거 |
| --- | --- | --- |
| F01 | profile-setup이 "notes는 워커에 전달되지 않는다"고 설명하지만, 현재 브리핑은 notes 원문을 첫 줄에 싣는다. | `P/skills/profile-setup/SKILL.md:203-205`, `S/SKILL.md:213`, `PREV/nodes/N99.md:120` |
| F02 | team-lead 프리셋의 권한 등급 "읽기·확인"과 권한 근거 "파일을 직접 고칠 이유가 없다"가 직접 처리·직접 수정 경로와 맞지 않는다. | `P/references/presets.md:188`, `P/references/presets.md:215`, `S/SKILL.md:39-41`, `PREV/nodes/N99.md:121`, `PREV/nodes/N100.md:37-38`, `PREV/nodes/N101.md:98-99` |
| F03 | brainstorming 참조가 「리더가 직접 하는 일」 4를 가리키지만 그 절은 번호 목록이 아니다. | `S/references/brainstorming.md:29`, `S/SKILL.md:39`, `PREV/nodes/N101.md:100` |
| F04 | 문서가 `python scripts/...`로 실행하라고 한다. [관찰] 이 Mac에는 `python`이 없고 `python3`만 있어 실측 팀장 로그에서 `command not found: python`이 3건 났다(모두 `python3`로 자가 복구). [미검증] Windows 등 다른 환경의 명령 이름은 확인하지 않았다. | `S/SKILL.md:35,161,258`, `S/references/level1.md:11-13`, `S/references/level2.md:261`, `S/references/failure-handling.md:13`, `S/references/brainstorming.md:28`, `S/references/FORM.md:267-268`, `S/references/system-prompt.md:12,22`, `PREV/nodes/N101.md:59-61`, `PREV/nodes/N101.md:118`, `PREV/final-live2/M4/r3/leader-session.jsonl:77` |

## B. 스킬 동작 보완 (결정이 필요)

| ID | 내용 | 근거 |
| --- | --- | --- |
| F05 | 경미한 수정 예외가 흔들린다. 생략 사실 보고 누락 2/3(M3 r2·r3), 두 줄 변경에 예외 적용 1건(M4 r1). 생략 보고 의무가 description에 없고 본문에만 있어 본문을 읽지 않고 판정하는 경로가 있다(추정). 작성자와 예외 판정자가 같다(팀장). | `S/SKILL.md:3`, `S/SKILL.md:41`, `PREV/nodes/N99.md:112-113`, `PREV/nodes/N100.md:42-43`, `PREV/nodes/N101.md:50-53` |
| F06 | 전환 뒤 "위임 실행·테스트 결과 뒤 검토" 순서를 지킨 확인 사례가 M4 1/3이다. | `S/references/level2.md:321`, `PREV/nodes/N99.md:114`, `PREV/nodes/N101.md:81-82` |
| F07 | `Agent` 도구·`Workflow`·deep-research 금지가 본문에만 있어, 스킬이 발동하지 않는 직접 처리에서는 적용되지 않을 수 있다(추정). | `S/SKILL.md:42`, `S/SKILL.md:3`, `PREV/nodes/N101.md:88-90` |
| F08 | 팀장 직접 수정 검토의 입력에 변경분(diff)이 없어 범위 밖 변경·회귀 판정이 어렵다(추정). 이전 스펙이 의도적으로 뺀 설계라 뒤집으려면 사용자 결정이 필요하다. | `S/assets/review-briefing.md:7`, `PREV/SPEC.md:43`, `PREV/final-live2/M5/r1/review-N1.md:16`, `PREV/nodes/N101.md:77-79` |
| F09 | 승인된 그래프 재설계에서 기존 관계선 변경·노드 삭제를 할 수단이 `graph_update.py`에 없다(create·add-row·set뿐, create는 기존 파일 거부). 또 `set`은 mermaid 정의가 없는 노드를 "대상 노드 없음"으로 거부한다. | `S/references/level2.md:237,254`, `S/scripts/graph_update.py:105`, `S/scripts/graph_update.py:221-223`, `PREV/nodes/N100.md:45-46` |
| F10 | `graph_update.py create`가 부모 디렉터리가 없으면 실패해 `mkdir -p` 호출이 따로 들고, 실측 팀장 9세션 중 7세션이 `--help`를 따로 불렀다. 도구 호출이 늘어난다. | `S/scripts/graph_update.py:110`, `PREV/nodes/N101.md:60-61` |
| F11 | 재독을 줄인 뒤 출력 형식이 어긋날 수 있다(추정, 형식 준수 실측 없음). | `S/SKILL.md:268-272`, `PREV/nodes/N101.md:92-93` |
| F12 | 축약으로 지운 "순차로 돌린다는 이유만으로 레벨 1로 바꾸지 않는다"가 남은 문장에 명시돼 있는지 재확인이 필요하다(합의 축약 X05, 대조표는 통합으로 분류). | `S/SKILL.md:151`, `PREV/rule-audit.md:117`, `PREV/nodes/N101.md:100` |
| F13 | spec 프로필 지침 "채택 이유·근거는 빼고"가 판정안의 필수 항목 "현재 근거"와 충돌할 수 있다(추정). | `P/references/presets.md:240`, `PREV/nodes/N101.md:101` |
| F14 | 작업 도중 자동 전환은 작동하지 않는다(자동 로드 0). 사용자 결정으로 한계로 받아들였지만, 직접 처리로 잘못 판정된 작업이 커지면 팀장 세션이 로그를 떠안는다(추정). 재검토 여부를 정한다. | `S/SKILL.md:27`, `PREV/nodes/N99.md:117`, `PREV/nodes/N101.md:73-75` |
| F15 | 개선하면서 일부 경로의 정적 비용이 늘었다. description 323→1,010자(모든 세션 상주), 비경미 직접 수정 D1 로드 29,002→31,173자·Read 7→10, L2 고유 로드 49,759→50,955자, references 합계 증가. M5(직접 수정) 비용은 이전 판 비교군이 없다. 비용 상충을 받아들일지, 줄일지 정한다. | `PREV/nodes/N99.md:45,51,54`, `PREV/nodes/N100.md:34-35`, `PREV/nodes/N101.md:55-57`, `PREV/nodes/N101.md:63-65` |

## C. 검증 공백 (실측 필요)

| ID | 내용 | 근거 |
| --- | --- | --- |
| F16 | 최종 판본(합의 27건 적용판)으로 A8 실측 전체를 다시 재지 않았다. A8 결과는 이전 판 해시 기준이다. | `PREV/nodes/N99.md:36`, `PREV/nodes/N99.md:40` |
| F17 | A9: 현재 데몬의 `spec` notes를 재조회하지 않아 문자 일치 전체가 미확인이다. | `PREV/nodes/N99.md:37-38` |
| F18 | codex가 팀장일 때 삭제 전 멈춤과 codex 쪽 발동 전반이 미검증이다. 트리거 평가와 실측은 claude만 했다. | `PREV/nodes/N99.md:122`, `PREV/nodes/N101.md:84-86` |
| F19 | 되돌리기 어려운 행동 중 외부 전송·git·저장소 밖 설정 변경은 실측하지 않았다. 삭제 실측의 멈춤은 스킬 로드 없이 일어나 원인(스킬/모델 기본 신중함)을 구분할 수 없다(추정). | `PREV/nodes/N101.md:69-71` |
| F20 | 트리 3·5(로그 해석, 다단계) 전환 실측이 없다. | `PREV/nodes/N99.md:117` |
| F21 | T15(레벨 1 팬아웃)를 최신 판본으로 재측정하지 않았다. 재독 감소의 동적 근거는 이전 판 1회(N31)뿐이다. | `PREV/nodes/N99.md:118`, `PREV/nodes/N101.md:96` |
| F22 | PowerShell·Windows 경로 미검증. | `PREV/nodes/N99.md:119` |
| F23 | 최신 판본(1,010자 description)의 직접 지시 과발동률을 재지 않았다. | `PREV/nodes/N99.md:116`, `PREV/nodes/N101.md:103-104` |
| F24 | 실측 방식 한계: M4에서 계획 승인 질문에 답하지 않아 판정 불가가 나왔다. 실측 Read 수는 네이티브 Read만 셌고 셸 읽기는 세지 않았다. | `PREV/nodes/N99.md:115`, `PREV/nodes/N101.md:96` |
| F25 | 전체 토큰·비용 절감률은 미입증이다. 전후 비교군을 둘지 정한다(이전 스펙은 비범위). | `PREV/nodes/N99.md:123`, `PREV/SPEC.md:176` |

## D. 정리·배포 (각각 사용자 승인 필요)

| ID | 내용 | 근거 |
| --- | --- | --- |
| F26 | 0.12.0(`621e94b`)의 main 머지·푸시. 마켓플레이스 출처가 GitHub로 복원돼 있어 푸시 전에는 다른 PC와 `plugin update`에 반영되지 않는다. 새 작업을 머지 전 브랜치에서 이어 갈지 main에서 새로 딸지 정한다. | `PREV/nodes/N98.md:3-12`, `git log --oneline -1`(`621e94b`) |
| F27 | 실측 fixture 워크스페이스·디렉터리 잔여분 정리. 대상을 다시 식별한 뒤 삭제 승인. | `PREV/nodes/N99.md:124` |
| F28 | `.skywork/`가 gitignore 대상이라 PREV의 N85 이후 결과 파일과 이 파일은 커밋되지 않는다. 다른 PC에서 이어 가려면 `git add -f`가 필요하다. | `.gitignore:29` |
