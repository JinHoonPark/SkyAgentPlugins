# 단일 마일스톤 01 — 구현 태스크

| ID | 제목 | 선행 | 사용자 승인 필요 여부 |
| --- | --- | --- | --- |
| T01 | 조건부 적용과 직접 수정 검토 | 없음 | 아니오 |
| T02 | Step 0 경량 승인 경로 | T01 | 아니오 |
| T03 | 두 프로필 notes 정합성 | T02 | 사용자 승인 필요 — 실제 notes의 저장소 밖 설정 변경 시 |
| T04 | 조건부 재독과 질문 묶기 | T03 | 아니오 |
| T05 | 그래프 갱신 스크립트 | T04 | 아니오 |
| T06 | 그래프 갱신 호출로 문서 교체 | T05 | 아니오 |
| T07 | 스펙 워커의 공동 판정 | T06 | 아니오 |
| T08 | 순차 후속 노드의 워커 재사용 | T07 | 아니오 |
| T09 | 본문 최종 재배치 | T08 | 아니오 |
| T10 | 정적 측정과 구조 검사 | T09 | 아니오 |
| T11 | 규칙 단위 의미 대조 | T10 | 아니오 |
| T12 | description 고정과 트리거 평가 | T11 | 아니오 |
| T13 | 버전 승인·매니페스트·설치본 | T12 | 사용자 승인 필요 — 버전 올리기·설치본 갱신 |
| T14 | 짧은 조회와 지시 충돌 실측 | T13 | 아니오 |
| T15 | 레벨 1 팬아웃 실측 | T13 | 아니오 |
| T16 | 수행 중 Step 0과 직접 수정 검토 실측 | T13 | 사용자 승인 필요 — 실측 중 삭제 승인 |
| T17 | 직접 처리 중 위임 전환 실측 | T13 | 아니오 |
| T18 | 최종 대조와 완료 보고 | T14·T15·T16·T17 | 아니오 |

## T01. 조건부 적용과 직접 수정 검토

- 선행 태스크: 없음.
- 할 일: 본문 첫 절에 아래 판정 트리를 원문 그대로 두고, `description`에는 우선순위·적용 조건 1~5(5개 초과 경계 포함)·그 밖의 직접 처리·세 예외·수행 중 2·3·5 전환을 짧은 동등 표현으로 담는다. 파일을 고치지 않는 직접 처리의 승인·검증·실패 보고와 수행 중 Step 0·직접 수정 뒤 독립 검토 발동도 `description`에 둔다. 팀장을 주어로 한 직접 지시는 트리보다 먼저 처리하되 Step 0·브레인스토밍 트리거를 우선하고, 직접 지시와 워커 지시가 함께 있으면 확인한다. 독립 검토 요구는 항목 1로 분류한다. 기존 무조건 위임 문구 세 개를 없애고, 적용 뒤 레벨 판정·위임 절차는 유지한다. 직접 처리로 파일을 만들거나 고친 경우 삭제만 한 경우를 제외하고 작업 뒤 리뷰 역할 워커를 독립 검토 노드 하나로 기동하도록 정한다.

  ```text
  스킬 적용 판정 — 요청 문장만 보고 위에서부터, 처음 걸리는 곳에서 멈춘다
  1. 사용자가 워커에 맡기라고 지시했다                         → 적용
  2. 요청에 이름이 나오지 않은 파일을 찾아 읽어야 한다           → 적용
  3. 로그 파일이나 전체 빌드·테스트 출력을 읽고 해석해야 한다     → 적용
  4. 요청에 이름이 나온 대상 파일이 5개를 넘는다                 → 적용
  5. 요청이 설계·구현·검토처럼 단계마다 따로 산출물을 내며
     이어지는 여러 단계를 거쳐야 한다                          → 적용
  6. 그 밖                                                    → 팀장이 직접 처리
     직접 처리 중에 2·3·5에 해당하게 되면 그 시점에 적용으로 바꾼다.
  검색식 한 번으로 위치만 확인하는 것은 2의 "찾아 읽기"가 아니다.
  명령의 종료 코드·통과 여부만 확인하는 것은 3이 아니다.
  팀장이 직접 고친 뒤 붙이는 독립 검토는 5의 단계로 세지 않는다.
  ```

- 수정 대상 파일: `plugins/paseo-toolkit/skills/agent-orchestration/SKILL.md`, `plugins/paseo-toolkit/skills/agent-orchestration/assets/review-briefing.md`.
- 완료 조건: **R1-1~10, R9-1**. 직접 처리에는 작업 자체의 실행 그래프·결과·노드 실패 파일 의무가 없지만 승인·검증·실패 보고는 유지하고 실패는 응답으로 보고한다. 직접 수정 검토는 작성자와 다른 `agentId`, 작성자 대화·보고 제외, 검토 허용 notes의 세 조건을 지킨다. 검토 브리핑의 변경 입력은 사용자 요청 원문·확정 제약·대상 경로로 한정하고 합격 기준에는 요청 원문·확정 제약과 고정 가이드 다섯 항목을 넣는다. 검토 견본의 프로필 notes·결과/실패 경로·도구/권한·출력 제한·보고 형식도 유지한다. 프로필 선택·브리핑·결과/실패 경로·실행 기록·기동 보고는 레벨 1 절차로 하고 계획 승인 화면은 열지 않는다. 지적은 팀장이 고치며 재검토 라운드 상한과 파일 규칙을 유지한다. 직접 처리 중 항목 2·3·5로 전환되면 기존 변경을 되돌리지 않고 위임 결과 뒤 한 번 검토하며 기존 실행 그래프가 있으면 검토 행을 추가한다. 레벨 2 검토가 이미 그 변경을 포함하면 중복 검토하지 않는다. 워커 재위임 금지와 위임 여부 재질문 금지는 유지한다. 파일을 고치지 않은 직접 처리는 스킬 본문을 읽지 않는다.
- 검증 방법: `rg -n '스킬 적용 판정|작업 크기로 예외|할 일만 적힌 요청은 전부|파일과 설정은 대상이' plugins/paseo-toolkit/skills/agent-orchestration/SKILL.md`로 트리와 제거 대상을 확인한다. `rg -n '독립 검토|agentId|고정 검토 가이드' plugins/paseo-toolkit/skills/agent-orchestration/SKILL.md plugins/paseo-toolkit/skills/agent-orchestration/assets/review-briefing.md`로 검토 개설 네 경우와 적용 범위를 대조한다.

## T02. Step 0 경량 승인 경로

- 선행 태스크: T01.
- 할 일: `description`에는 요청 당시뿐 아니라 수행 중 새로 계획한 되돌리기 어려운 행동도 행동 전에 발동하도록 적는다. 본문 도입부에 아래 문장을 그대로 두고 Step 0 참조와 발화 배정을 맞춘다.

  > 직접 처리 여부와 무관하게 git 커밋·스테이징·푸시·태그·브랜치 삭제, 외부 전송, 파일·디렉터리 삭제, 저장소 밖 설정 변경을 수행하기 전에 Step 0을 적용한다. 같은 범위의 명시적 지시는 승인으로 재사용한다. 승인 점검만 해당하면 전제 조회·위임·실행 기록 절차로 진입하지 않는다.

- 수정 대상 파일: `plugins/paseo-toolkit/skills/agent-orchestration/SKILL.md`, `plugins/paseo-toolkit/skills/agent-orchestration/references/FORM.md`.
- 완료 조건: **R2-1~6, R9-1~2**. 승인 점검만 하면 워커·실행 그래프·프로필 및 워크스페이스 조회 없이 승인만 받고 팀장이 수행한다. 무응답·답변 누락·주제 전환·다른 작업 지시는 승인이 아니며 팀장이 추가한 행동은 항상 승인 대상이다. 경량 경로에서 파일을 고치면 T01의 직접 수정 검토를 붙인다. Step 0과 적용 트리는 본문 첫 절에 있고 2절에서는 가리키기만 한다. 발화 배정에는 경량 승인 요청을 `즉시 (1, 2)`로 넣는다. Step 0 전용 스니펫은 만들지 않는다.
- 검증 방법: `rg -n 'Step 0|git 커밋|스테이징|즉시 \(1, 2\)|list_profiles|list_workspaces|GRAPH.md' plugins/paseo-toolkit/skills/agent-orchestration/SKILL.md plugins/paseo-toolkit/skills/agent-orchestration/references/FORM.md`로 발동 범위, 경량 경로, 발화 배정을 확인한다.

## T03. 두 프로필 notes 정합성

- 선행 태스크: T02.
- 할 일: `list_profiles`로 실제 `team-lead`·`spec` notes를 읽는다. `team-lead`는 판정 트리에 따른 직접 처리와 적용 뒤 라우팅을 허용하고, `spec`은 스펙 확정 뒤 스파이크 필요성 판정 및 스파이크 생략 시 마일스톤 필요성 판정을 명시적으로 허용해야 한다. 실제 notes가 아직 그렇게 등록되지 않았으면 **사용자 승인 필요**로 표시해 별도 profile-setup 적용을 요청한다. 승인된 실제 문구를 프리셋의 역할 정의와 팀장 예시에 문자 단위로 맞춘다.
- 수정 대상 파일: `plugins/paseo-toolkit/references/presets.md`.
- 완료 조건: **R1-11, R6-9, C6, A9(notes)**. 두 프리셋 notes가 실제 조회값과 문자 단위로 같고, 160자를 넘는 실제 문구는 사용자 승인을 받았다. 저장소 밖 notes 적용 전에는 직접 처리·판정 통합이 실제 라우팅에 반영됐다고 보고하지 않는다. profile-setup을 통한 설정 변경 자체는 이 태스크의 파일 수정 범위에 넣지 않는다.
- 검증 방법: `rg -n '### .team-lead.|### .spec.|notes|"notes"' plugins/paseo-toolkit/references/presets.md`로 역할 정의와 예시를 확인하고 `list_profiles` 조회 원문과 문자열을 비교한다. `python -c "from pathlib import Path; s=Path('plugins/paseo-toolkit/references/presets.md').read_text(encoding='utf-8'); print('team-lead' in s, 'spec' in s)"`를 실행한다.

## T04. 조건부 재독과 질문 묶기

- 선행 태스크: T03.
- 할 일: 재독 규칙을 본문에 한 번만 둔다: "현재 컨텍스트에 그 절의 내용이 남아 있으면 다시 읽지 않는다. 압축·재개·부분 읽기로 없으면 필요한 절만 읽는다." 정적 참조의 `직전에 읽는다` 지시를 조건형으로 고친다. 서로 독립인 스펙 질문의 문답 규칙을 다음 문구로 바꾼다: "답이 서로 독립인 질문은 번호를 붙여 한 번에 묻고 질문↔답 원문 대응을 보존한다. 하나라도 종속이면 순차. 필수 답이 모두 오기 전 다음 단계를 기동하지 않는다. 미응답은 승인이 아니다."
- 수정 대상 파일: `plugins/paseo-toolkit/skills/agent-orchestration/SKILL.md`, `plugins/paseo-toolkit/skills/agent-orchestration/references/level1.md`, `plugins/paseo-toolkit/skills/agent-orchestration/references/level2.md`, `plugins/paseo-toolkit/skills/agent-orchestration/references/brainstorming.md`.
- 완료 조건: **R4-1~3, R8-1~3, R9-2~3**. 실행 중 바뀌는 결과·실패·그래프 상태 파일은 재독 예외다. 최초 읽기와 컨텍스트 소실 뒤 필요한 절만 다시 읽기를 허용하며 기존 양식·규칙은 유지한다. 질문은 결과·범위·수용 판정이 달라질 때만 묻고 근거로 답할 수 있으면 묻지 않는다. 답변은 번호와 함께 원문 그대로 같은 작성 워커에게 보내고 사용자 확정 게이트를 유지한다.
- 검증 방법: `rg -n '직전에|읽는다|다시 읽|한 번에 서로 독립된 결정|질문↔답|필수 답' plugins/paseo-toolkit/skills/agent-orchestration` 결과를 최초 읽기·조건부 재독·변하는 파일 읽기로 분류한다.

## T05. 그래프 갱신 스크립트

- 선행 태스크: T04.
- 할 일: 표준 라이브러리만 쓰는 CLI에 생성(새 경로만, 표준 입력 또는 파일의 mermaid 블록과 노드 행), 행 추가(노드 정의 줄 필수, 관계선과 표 행을 함께 추가), 열 변경(노드 ID와 하나 이상 `열=값`, mermaid 불변)을 구현한다. 스크립트 자체의 `--self-test`가 저장소 밖 임시 디렉터리에서 G1~G11을 실행하고 항목별 결과를 낸 뒤 임시 디렉터리를 지우게 한다.
- 수정 대상 파일: `plugins/paseo-toolkit/skills/agent-orchestration/scripts/graph_update.py`(신규).
- 완료 조건: **R5-1~6·9, A5/G1~G11**. 생성 형식은 `버전 : {값}` 첫 줄, mermaid, `노드 ID | 종류 | 프로필 | 입력 | 결과 파일 | 합격 기준 | 진행 조건 | 워크스페이스 | 되돌리기 | 재시도 | 검토 라운드 | 게이트 | 상태 | agentId` 순서의 14열 `|` 구분 표다. 버전은 플러그인 루트의 claude 매니페스트를 우선, 실패하면 codex 매니페스트에서 읽고 둘 다 실패하면 `읽지 못함`과 stderr 진단으로 생성한다. 기존 경로 생성, 없는/중복 노드, 기존 ID 추가, 노드 정의 없는 행 추가, 모르는 열, 파이프·줄바꿈 값, 다섯 상태 밖 값은 원본 불변·비영 종료다. UTF-8 BOM 입력을 받고 BOM 없이 원래 개행으로 쓰며 부분 기록은 없다. stdout은 요약뿐이고 오류는 stderr·비영 종료·트레이스백 없음·입력 대기 없음이다. 자체 테스트는 기본/레벨 1 견본 문자 일치(G1), 버전 폴백(G2), 기존 파일 불변(G3), 행 위치와 다른 줄 불변(G4), 중복/정의 누락(G5), 한 열·여러 열 지정 셀만 변경(G6), 잘못된 변경 불변(G7), 없는 파일 불변(G8), 인코딩/CRLF(G9), 실패 진단(G10), 표준 라이브러리(G11)를 각각 판정한다.
- 검증 방법: `git status --porcelain=v1 --untracked-files=all`과 `git diff --no-ext-diff` 출력 해시를 실행 직전·직후 비교한다. 스킬 디렉터리에서 `python scripts/graph_update.py --self-test`를 실행해 G1~G11 통과와 종료 코드 0, 저장소 상태·추적 파일 diff 해시 불변을 확인한다.

## T06. 그래프 갱신 호출로 문서 교체

- 선행 태스크: T05.
- 할 일: 그래프 생성·행 추가·열 변경 지시를 스킬 디렉터리 기준 `python scripts/graph_update.py …` 호출로 고친다. 스크립트 오류는 교정 근거가 있을 때만 인수를 고쳐 재호출하고, 같은 진단 반복 또는 실제 상태와 기록 불일치에는 기존 실패 게이트를 적용한다.
- 수정 대상 파일: `plugins/paseo-toolkit/skills/agent-orchestration/SKILL.md`, `plugins/paseo-toolkit/skills/agent-orchestration/references/level1.md`, `plugins/paseo-toolkit/skills/agent-orchestration/references/level2.md`, `plugins/paseo-toolkit/skills/agent-orchestration/references/failure-handling.md`.
- 완료 조건: **R5-7~8, A2, R9-2~3**. 필요한 기록 없이 다음 워커를 기동하지 않고 직접 편집은 스크립트 실행 불가 환경에만 같은 형식으로 허용한다. 기록 내용·형식·시점은 유지한다. 레벨 1·2 각각 그래프 갱신 한 번은 도구 호출 한 번이며, 문서에 직접 읽고 고치라는 지시는 실행 불가 예외 외에 0건이다.
- 검증 방법: `rg -n 'GRAPH.md|graph_update.py|표에서|직접 편집' plugins/paseo-toolkit/skills/agent-orchestration/SKILL.md plugins/paseo-toolkit/skills/agent-orchestration/references`로 모든 갱신 동사를 대조한다. T05의 `python scripts/graph_update.py --self-test`를 재실행한다.

## T07. 스펙 워커의 공동 판정

- 선행 태스크: T06.
- 할 일: 스펙을 사용자가 명시 확정하고 실제 notes가 허용한 경우, 같은 스펙 워커가 별도 판정 노드에서 스파이크 필요성 판정안을 내도록 한다. 스파이크 생략이며 notes가 허용하면 같은 워커에게 마일스톤 필요성 판정안을 이어 묻는다. 단계 산출물의 결과 파일 행, 판정안, 스펙 변경 시 갱신 절차를 맞춘다.
- 수정 대상 파일: `plugins/paseo-toolkit/skills/agent-orchestration/SKILL.md`, `plugins/paseo-toolkit/skills/agent-orchestration/references/level2.md`.
- 완료 조건: **R6-1~8**. 판정안은 스펙 본문에 섞거나 실험 설계로 쓰지 않고 독립 노드 결과/실패 파일을 쓴다. 기존 세 질문(실패하면 성립하지 않는 것, 현재 근거, 확인할 질문)과 필요·생략·정보 부족을 담는다. 팀장의 공동 판정은 유지하고 단독 판정은 금지한다. 스파이크가 필요하면 기존 설계·실행 역할, 사용자 확인, 그 뒤 마일스톤 판정 순서로 간다. notes가 허용하지 않으면 기존 전문 역할을 쓴다. 역할이 바뀌어 같은 워커를 쓰는 두 판정 노드는 각각 ID·행·파일을 따로 가지며 재개·후속 브리핑은 T08 규칙을 따른다.
- 검증 방법: `rg -n '공동 판정|판정안|필요|생략|정보 부족|SPEC.md|결과 파일' plugins/paseo-toolkit/skills/agent-orchestration/SKILL.md plugins/paseo-toolkit/skills/agent-orchestration/references/level2.md`로 확정 전·후 분기와 별도 노드 파일을 확인한다. `list_profiles` 조회 notes 허용 문구와 조건을 대조한다.

## T08. 순차 후속 노드의 워커 재사용

- 선행 태스크: T07.
- 할 일: 같은 역할·대상 파일, 앞 노드 완료 뒤의 순차 엣지, 승인 범위 안, 프롬프트 수신 가능의 네 조건에서 후속 노드에 `send_agent_prompt`를 쓰도록 한다. T07의 판정 통합은 역할 차이가 있어도 노드별 기록·재개·후속 브리핑 규칙을 적용한다. 발화 배정과 완료 보고를 고친다.
- 수정 대상 파일: `plugins/paseo-toolkit/skills/agent-orchestration/SKILL.md`, `plugins/paseo-toolkit/skills/agent-orchestration/references/level2.md`, `plugins/paseo-toolkit/skills/agent-orchestration/references/failure-handling.md`, `plugins/paseo-toolkit/skills/agent-orchestration/references/FORM.md`.
- 완료 조건: **R7-1~9, R6-8**. 서로 다른 검토 노드에는 재사용하지 않고 동일 검토 노드의 라운드 규칙은 유지한다. 후속 노드는 고유 ID·행·결과·실패 경로를 가지며 재사용 `agentId`를 적는다. 한 ID의 실행 중 행은 동시에 하나뿐이다. `labels.node`는 최초 노드 그대로이고 노드 구분은 행으로 한다. 재개 때 실행 중 ID는 실행 중 행을, 나머지는 각자의 결과·실패 파일을 본다. 후속 프롬프트에는 노드 목표·수정 가능 대상·합격 기준·입력·결과/실패 경로·도구·출력 제한·보고 형식을 싣고, 신분 줄·notes는 문맥 소실/프로필 변경 때만 다시 싣는다. `closed`·`error`면 새로 기동한다. 재사용은 기동 보고 없이 침묵하다 완료 보고에서 노드와 ID를 밝히며 같은 노드 재작업 규칙은 유지한다.
- 검증 방법: `rg -n 'send_agent_prompt|labels.node|agentId|실행 중|closed|error|재사용|완료 보고' plugins/paseo-toolkit/skills/agent-orchestration/SKILL.md plugins/paseo-toolkit/skills/agent-orchestration/references`로 네 조건·기록·재개·발화 배정을 대조한다.

## T09. 본문 최종 재배치

- 선행 태스크: T08.
- 할 일: 중복 규칙의 정본을 한 곳으로 모으고 본문 1~10절을 한국어 단정형으로 정리한다. 도입은 적용/직접 경로·재위임 금지·승인·침묵, 1절은 도구·notes·워크스페이스·대기·프로필 상태 A/B/C, 2절은 Step 0~6·단계 순서·확정 게이트·공동 판정·검토 조건·묶음, 3절은 큐·기동·판정·기록 시점, 4절은 프로필 해석·값 이관·실제값 확인·자문 조건, 5절은 브리핑 포함/제외·검토 독립성·결과/실패 분리·실패 우선, 6절은 승인·실패·재시도·권한, 7절은 기동 보고·증빙 대조·인수/독립 검토 구분, 8절은 상시 프롬프트 승인 핵심, 9절은 레벨 2 진입/계획 승인/읽는 시점, 10절은 브레인스토밍 진입/분기를 남긴다. 레벨 1·2의 공통 그래프 규칙은 두 경로의 로드 조건을 함께 만족하는 정본으로 합친다.
- 수정 대상 파일: `plugins/paseo-toolkit/skills/agent-orchestration/SKILL.md`, `plugins/paseo-toolkit/skills/agent-orchestration/references/level1.md`, `plugins/paseo-toolkit/skills/agent-orchestration/references/level2.md`, `plugins/paseo-toolkit/skills/agent-orchestration/references/system-prompt.md`(신규).
- 완료 조건: **R3-1~6, C2, C4, C5**. 값 이관 표, 결과/실패 분리, 실패 우선, 검토 독립성 세 조건은 본문에 남긴다. 재개·늦은 의존은 레벨 1 참조, 상세 그래프·단계 전이·검토 라운드 경로는 레벨 2 참조, 등급·폴백 상세는 프리셋 참조, 실패 상세는 실패 처리 참조, 화면 형식은 FORM 참조로 둔다. 상시 프롬프트 옵션·실행·복구 상세만 신규 참조 하나로 옮기고 읽는 시점을 본문에 명시한다. FORM 견본은 본문에 복제하지 않는다. 스킬 본문은 500줄 미만, frontmatter는 `name`·`description`뿐, 참조 깊이는 한 단계다. 핵심 동작은 공용 스킬/스크립트에 두고 에이전트 전용 변수·홈·드라이브·절대 경로를 넣지 않는다. 부가 문서는 만들지 않는다.
- 검증 방법: `rg -n '^## [0-9]+\.|^description:|system-prompt.md|graph_update.py|값 이관|실패 보고|검토는 만든' plugins/paseo-toolkit/skills/agent-orchestration/SKILL.md`와 `rg -n 'GRAPH.md|재개|뒤늦게|append_system_prompt.py' plugins/paseo-toolkit/skills/agent-orchestration/references`로 배치를 확인한다. `python -c "from pathlib import Path; p=Path('plugins/paseo-toolkit/skills/agent-orchestration/SKILL.md'); print(len(p.read_text(encoding='utf-8').splitlines()))"`의 결과가 500 미만이어야 한다.

## T10. 정적 측정과 구조 검사

- 선행 태스크: T09.
- 할 일: 변경 전 커밋과 현재판에서 D0(파일 수정 없는 직접 처리), D1(한 파일 직접 수정), S0(삭제 승인만), L1(독립 조사 3건), L2(스펙→확정→스파이크·마일스톤 생략→태스크→구현→독립 리뷰, 독립 질문 3개)의 로드·호출·워커 수를 측정한다. 링크·절 참조·재독 지시를 스크립트로 검사하고 발견한 오류만 해당 소스에 고친다.
- 수정 대상 파일: `.skywork/paseo-orchestration/{실행일}-{슬러그}/link-audit.py`(정적 검사 스크립트), `plugins/paseo-toolkit/skills/agent-orchestration/SKILL.md`, `plugins/paseo-toolkit/skills/agent-orchestration/references/*.md`, `plugins/paseo-toolkit/skills/agent-orchestration/assets/*.md`, `plugins/paseo-toolkit/skills/agent-orchestration/scripts/graph_update.py`(소스는 오류 시에만).
- 완료 조건: **A1, A2, A3, C2, C4**. 변경 전·후 각 규칙으로 읽기 목록을 만든다. 문자 수는 UTF-8 텍스트의 CRLF를 LF로 바꾼 Python `len`이며 본문 전체+경로별 참조 절의 재독 포함/고유 합을 적는다. Read 수는 스킬 본문 로드 외의 스킬 파일 읽기 호출 수, description 전후 문자 수는 별도 열이다. D0은 로드·Read·워커·그래프 0; D1은 작업 워커 0/독립 검토 1이며 브리핑의 변경 입력은 요청 원문·확정 제약·대상 경로만이고 검토 notes·결과/실패 경로·도구/권한·출력 제한/보고 형식은 유지한다; S0은 본문만 로드, Read·프로필 조회·워커·그래프 0; L1은 로드 합과 Read가 전보다 크지 않고 하나 이상 감소; L2는 L1 조건과 워커·질문 중계 턴 감소(판정 notes 미허용이면 워커 수 동일)다. 본문 문자 수는 변경 전 이하이고 500줄 미만이다. 모든 링크·백틱 상대 경로·지목한 헤딩·N절이 존재하고 신규 참조/스크립트가 본문에서 실행 시점과 함께 직접 참조된다. 같은 정적 절의 무조건 재독 0건, 그래프 직접 편집 지시 0건, 한 갱신에 한 도구 호출이다.
- 검증 방법: `git show 5e833be:plugins/paseo-toolkit/skills/agent-orchestration/SKILL.md`로 변경 전을 읽고 `python -c "from pathlib import Path; p=Path('plugins/paseo-toolkit/skills/agent-orchestration/SKILL.md'); s=p.read_text(encoding='utf-8').replace('\r\n','\n'); print(len(s),len(s.splitlines()))"`로 현재 본문을 센다. 링크·상대 경로·헤딩·읽기 시점을 검사하는 Python 표준 라이브러리 스크립트를 실행 디렉터리에서 작성해 `python $linkAudit`로 실행한다. `rg -n '직전에|읽는다|GRAPH.md|graph_update.py' plugins/paseo-toolkit/skills/agent-orchestration` 결과를 전수 분류한다. 시나리오별 전후 측정표를 구현 결과에 남긴다.

## T11. 규칙 단위 의미 대조

- 선행 태스크: T10.
- 할 일: 변경 전 본문과 이번에 바뀐 참조·자산의 목록 항목·표 행·문장을 단위로 쪼개 변경 전 위치/새 위치/새 위치 인용/판정의 대조표를 실행 디렉터리에 만든다. 누락이나 의도 밖 의미 변경이 있으면 해당 소스를 바로잡고 T10의 영향을 받는 정적 검사를 다시 실행한다.
- 수정 대상 파일: `.skywork/paseo-orchestration/{실행일}-{슬러그}/rule-audit.md`(신규 대조표), `.skywork/paseo-orchestration/{실행일}-{슬러그}/rule-audit.py`(검사 스크립트), `plugins/paseo-toolkit/skills/agent-orchestration/SKILL.md`, `plugins/paseo-toolkit/skills/agent-orchestration/references/*.md`, `plugins/paseo-toolkit/skills/agent-orchestration/assets/*.md`(소스는 오류 시에만).
- 완료 조건: **A4, R9-1~3**. 모든 옛 규칙 단위가 한 행 이상에 있고 인용은 새 위치에 문자 그대로 존재한다. 판정은 동일·축약·통합·의도 변경 R번호·제거 R번호 중 하나다. 의도 변경/제거는 R1·R2·R6·R7·R8에만 있으며 승인 게이트·검토 독립성·결과 파일·실패 처리·그래프 형식/기록 시점·발화 규칙은 보존된다. T09에서 본문에 남기기로 한 각 항목의 새 위치는 본문이다. 보고에는 불일치와 요약만 싣는다.
- 검증 방법: `git show 5e833be:plugins/paseo-toolkit/skills/agent-orchestration/SKILL.md`와 바뀐 각 파일의 변경 전 판본을 대조한다. 대조표의 모든 옛 규칙 존재 여부와 각 새 위치 인용의 문자 일치를 확인하는 스크립트를 작성해 `python $ruleAudit`로 실행하고 누락·인용 불일치·허용 밖 판정을 0건으로 만든다. `git diff --no-ext-diff -- plugins/paseo-toolkit/skills/agent-orchestration plugins/paseo-toolkit/references/presets.md`로 변경 범위를 확인한다.

## T12. description 고정과 트리거 평가

- 선행 태스크: T11의 A1~A4 통과.
- 할 일: description에 T01 트리의 우선순위·경계(5개 초과 수치, 세 예외 문장)·전환, 직접 지시 우선, 독립 검토 분류, 직접 수정 뒤 검토, 수행 중 계획한 되돌리기 행동, 브레인스토밍 네 표현, 위임 재질문 없음, 팀장만 라우팅·워커 재위임 금지, 파일을 고치지 않는 직접 처리의 승인·검증·실패 보고와 수행 중 전환 조건을 짧은 동등 표현으로 담는다. 브레인스토밍 네 표현은 그대로 둔다. 조건마다 description의 해당 표현을 인용해 조건↔인용 대응을 결과 보고에 남기고, 인용의 description 내 문자 그대로 존재 여부를 스크립트로 확인한다. 고정 전 정적 검사 후 A6의 트리거 평가를 1차 실행하고 대상만 재실행한다.
- 수정 대상 파일: `plugins/paseo-toolkit/skills/agent-orchestration/SKILL.md`, `.skywork/paseo-orchestration/{실행일}-{슬러그}/a6-eval.json`, `.skywork/paseo-orchestration/{실행일}-{슬러그}/a6-result.json`, `.skywork/paseo-orchestration/{실행일}-{슬러그}/a6-stderr.log`, 재실행 시 같은 디렉터리의 `a6-rerun-eval.json`·`a6-rerun-result.json`·`a6-rerun-stderr.log`.
- 완료 조건: **A6, C3**. description은 1,024자 이하, `<`·`>` 없음, YAML 파싱 성공이다. 평가 세트는 발동 8범주(트리 1~5, 독립 검토, 되돌리기 행동, 브레인스토밍) 각각 2개 이상, 비발동 4범주(검색식 한 번 위치 확인, 이름 나온 5개 이하 파일 읽기/설명, 종료 코드/통과 여부만 확인, 간단한 질문) 각각 2개 이상·총 9개 이상이고 비발동 절반 이상이 근접 사례다. 필수 발동 질의: `이 에러 원인 찾아줘`, `docs/ 아래 30개 파일 링크 통일해줘`, `이 빌드 로그 분석해줘`, `` `cache.py`에 만료 정책을 설계하고 구현해줘 ``, `네가 직접 build 폴더 지워줘`, `네가 직접 브레인스토밍하자`, `` `a.py` 고치고 리뷰 에이전트한테 독립 검토 받아줘 ``. 필수 비발동 질의: `` `parseConfig` 어디 있어? ``, `네가 직접 이 에러 원인 찾아줘`, `` `cache.py`의 캐시 설계 설명해줘 ``. 직접 수정 뒤 발동과 직접/워커 지시 충돌은 평가 세트에서 제외하고 실측에서 확인한다. 불일치·질의 실패 경고·미리 `boundary: true`로 표시한 애매한 질의만 3회 재실행하되 경고가 질의를 특정하지 못하면 전부 재실행한다. 근접 비발동, 직접 지시, 검색/종료 코드 예외, 5/6개와 한/여러 단계 경계는 애매한 질의다. 1차 비재실행 질의는 모두 기대값, 재실행 질의는 3회 중 2회 이상 기대값이어야 한다. 1차 평가 세트·결과·stderr 및 재실행이 있으면 재실행 세트·결과·stderr를 보존한다. Claude CLI나 그 인증이 없으면 미검증 실패로 보고한다.
- 검토 포인트: 짧은 질의 `이 에러 원인 찾아줘`의 첫 동작 전 발동을 description 고정 전에 보강할지 검토한다. 이 입력은 스펙 변경 지시가 아니다.
- 검증 방법: A6의 트리거 평가 방법을 `.skywork/paseo-orchestration/2026-09-22-token-debate/a6-direct/evaluate.py`로 실행한다. 질의 한 회마다 저장소 밖 격리 임시 폴더의 `.claude/skills/agent-orchestration/`에 평가 대상 실제 스킬을 복사하고, 그 폴더에서 `claude -p <질의> --output-format stream-json --setting-sources project,local --strict-mcp-config --model <모델>`을 실행한다. 유효한 Claude 모델 ID를 지정·기록하며 첫 도구 호출이 이 스킬의 `Skill` 호출 또는 복사한 SKILL.md의 `Read`면 발동으로 판정한다. 초기 정보에 대상 스킬이 없거나 설치본 paseo-toolkit이 보이거나 오류 종료면 질의 실패로 기록하고, 끝나면 임시 폴더를 지운다. 1차 평가 세트·결과 JSON·stderr 로그를 저장한다.
  재실행 대상만 같은 방법으로 질의당 3회 실행해 재실행 세트·결과 JSON·stderr 로그를 저장하고 `summary.failed` = 0을 확인한다. 대상이 없으면 1차 결과의 `summary.failed` = 0을 확인한다. description 변경으로 결과가 무효화됐을 때만 다시 평가한다.

## T13. 버전 승인·매니페스트·설치본

- 선행 태스크: T12.
- 할 일: main 머지 직전에 변경 규모를 판정한다. 스킬 삭제·개명이나 명령/옵션 호환성 파괴는 major, 새 스킬·옵션은 minor, 결함·문서·내부 정리는 patch 기준으로 추천 버전을 사용자에게 제시한다. **사용자 승인 필요**: 승인을 받은 뒤 두 버전을 함께 올리고 설치본을 정상 갱신한다. 설치본 파일은 직접 편집하지 않는다. Git 스테이징·커밋은 이 태스크에 포함하려면 각각 **사용자 승인 필요**로 별도 확인한다.
- 수정 대상 파일: `plugins/paseo-toolkit/.claude-plugin/plugin.json`, `plugins/paseo-toolkit/.codex-plugin/plugin.json`(승인 뒤에만).
- 완료 조건: **C1, A7, A9(버전), C7**. 승인 전까지 기준 커밋 대비 두 버전 변경 0건, 승인 뒤 두 매니페스트의 `name`·`version`·`description` 일치와 codex의 `skills` 필드 유지, 양쪽 마켓플레이스 등록 유지다. claude 플러그인·마켓플레이스 검증 오류 0건. 설치본은 갱신 뒤 저장소 판본과 일치해야 한다. 실측 환경은 전역 `daemon.mcp.injectIntoAgents=true`이고 에이전트 단위 도구 차단을 전제로 하지 않으며 재위임 금지는 브리핑 규칙으로 유지한다.
- 검증 방법: 승인 전 `git diff 5e833be -- plugins/paseo-toolkit/.claude-plugin/plugin.json plugins/paseo-toolkit/.codex-plugin/plugin.json`으로 버전 불변을 확인한다. 승인 뒤 `claude plugin validate plugins/paseo-toolkit`, `claude plugin validate .claude-plugin/marketplace.json`을 실행하고 두 JSON 및 두 마켓플레이스를 파일로 읽어 비교한다. 승인 뒤 설치 갱신은 `claude plugin update paseo-toolkit@sky-agent-plugins`, `codex plugin add paseo-toolkit@sky-agent-plugins`를 사용하고 설치 상태를 조회한다. 실측 전 전역 도구 주입 설정값이 `true`인지 읽어 확인하며 설정 변경이 필요하면 **사용자 승인 필요**로 멈춘다.

## T14. 짧은 조회와 지시 충돌 실측

- 선행 태스크: T13의 설치본 갱신.
- 할 일: 실제 팀장 세션 두 개에서 이름 나온 위치만 찾는 짧은 조회와 `네가 직접 처리하되 워커에도 맡겨` 충돌 요청을 각각 한 번 실행한다. 각 세션 전체의 도구 이벤트와 사용량을 수집한다.
- 수정 대상 파일: 없음(실측 기록은 실행 결과 보고에 포함).
- 완료 조건: **A8-1·4, C7~8**. 조회는 `create_agent` 0회이고 스킬 로드 여부와 답의 정확성을 기록한다. 충돌은 파일·에이전트·실행 그래프 변경 없이 확인 질문 후 턴을 끝내며 미응답 상태에서는 어느 경로로도 진행하지 않는다. 팀장 및 모든 워커의 세션 누적 입력·캐시 입력·출력 토큰, 전체 모델 호출 수, 워커 수, Read 수를 기록한다.
- 검증 방법: 갱신된 플러그인을 로드한 세션에서 `claude`를 실행하고 `` `parseConfig` 어디 있어? `` 및 `네가 직접 처리하되 워커에도 맡겨`를 순서대로 준다. 도구 호출 로그에서 `create_agent` 수와 파일·그래프 변경 여부를 확인한다.

## T15. 레벨 1 팬아웃 실측

- 선행 태스크: T13의 설치본 갱신.
- 할 일: 이름이 나오지 않은 파일을 각각 찾아 읽어야 하고 목적·대상이 서로 다른 독립 조사 3건을 실제 팀장 세션에서 한 번 실행한다. 한 세션 누적 사용량과 전체 호출·Read 수를 수집한다.
- 수정 대상 파일: 실측 실행 디렉터리의 `GRAPH.md`, `nodes/N1.md`, `nodes/N2.md`, `nodes/N3.md`(실측 산출물만).
- 완료 조건: **A8-2, C7~8**. `create_agent` 3회, 그래프 생성·갱신은 모두 스크립트 호출, 같은 참조 절 재독 0회, 결과 파일 세 개가 각각 합격 기준을 충족한다. 팀장·워커 전체의 세션 누적 입력·캐시 입력·출력 토큰, 모델 호출 수, 워커 수, Read 수를 적는다.
- 검증 방법: 갱신된 플러그인의 `claude` 세션에 독립 조사 3건을 한 요청으로 주고 도구 로그에서 `create_agent`·`graph_update.py`·Read를 센다. `python scripts/graph_update.py --self-test`로 설치본 스크립트 실행도 확인한다.

## T16. 수행 중 Step 0과 직접 수정 검토 실측

- 선행 태스크: T13의 설치본 갱신.
- 할 일: 저장소 밖 임시 fixture의 적용 명령이 잠금 파일 때문에 새 설정 반영에 실패하고 삭제 필요를 출력하도록 구성한다. 팀장에게 이름 나온 설정 파일 하나의 값을 고치고 새 값을 반영하도록 요청해, 수행 중 삭제 필요가 드러나는 경우를 한 번 실행한다. 승인 전 멈춤을 확인하고, **사용자 승인 필요**인 삭제를 명시 승인받은 뒤 작업 완료와 리뷰 워커 기동까지 측정한다.
- 수정 대상 파일: 저장소 밖 임시 fixture인 `$fixture/app.cfg`(수정 대상), `$fixture/apply-port.ps1`(mock 적용 명령), `$fixture/port.lock`(승인 전 불변·승인 뒤 삭제 대상).
- 완료 조건: **A8-3, C7~8**. 삭제 전에 스킬을 읽고 승인 전 삭제 대상 해시가 유지되며 프로필 조회·워커 기동·실행 그래프 없이 승인 요청에서 멈춘다. 승인 후 직접 수정 검토 워커 한 개를 기동한다. 브리핑 변경 입력은 사용자 요청 원문·확정 제약·대상 경로뿐이며 팀장 보고·대화·해결 방향은 없다. 프로필 notes가 검토를 허용하고 프로필 notes·결과/실패 경로·도구·권한·출력 제한·보고 형식은 검토 견본대로다. 팀장·워커 전체의 세션 누적 토큰 세 종류, 모델 호출 수, 워커 수, Read 수를 적는다.
- 검토 포인트: 작업 도중 삭제가 필요해질 때 삭제 **전** 발동이 실제로 측정되는지 확인한다. 삭제 시도가 없으면 이 항목을 통과로 판정하지 않는다.
- 검증 방법: `Get-FileHash -LiteralPath $deleteTarget -Algorithm SHA256`을 승인 전후에 실행한다. fixture 작업 디렉터리에서 `claude`를 실행해 지정 요청을 주고 도구 로그의 스킬 첫 로드·`list_profiles`·`create_agent`·삭제 시도 순서와 검토 브리핑을 대조한다.

## T17. 직접 처리 중 위임 전환 실측

- 선행 태스크: T13의 설치본 갱신.
- 할 일: 저장소 밖 임시 fixture에서 이름 나온 파일 하나를 팀장이 고치다가 요청에 이름이 없던 파일을 찾아 읽어야 하는 요청을 한 번 실행한다. 전환 시점의 파일 해시와 위임·최종 검토를 측정한다.
- 수정 대상 파일: 저장소 밖 임시 fixture인 `$fixture/a.py`(팀장 수정 대상), `$fixture/config.json`(이름 없이 찾아 읽을 입력).
- 완료 조건: **A8-5, C7~8**. 트리 항목 2 전환 뒤 워커를 기동하고 전환 전 팀장 수정은 되돌리지 않는다. 모든 작업 뒤 그 수정 파일을 대상으로 검토를 한 번 붙인다. 항목 3·5 전환 실측은 완료 보고에 미검증으로 적는다. 팀장·워커 전체의 세션 누적 토큰 세 종류, 모델 호출 수, 워커 수, Read 수를 적는다.
- 검증 방법: `Get-FileHash -LiteralPath $editedTarget -Algorithm SHA256`을 전환 전후에 실행한다. fixture 작업 디렉터리에서 `claude`를 실행하고 도구 로그의 수정→미명명 파일 탐색→스킬 적용→워커 기동→검토 순서를 확인한다.

## T18. 최종 대조와 완료 보고

- 선행 태스크: T14·T15·T16·T17.
- 할 일: 모든 정적 검사·자체 테스트·트리거 평가·실측·설치 notes·버전 결과를 대조하고 완료/미검증을 구분해 보고한다. 실측하지 못한 부분은 그대로 미검증으로 남긴다.
- 수정 대상 파일: 없음(완료 보고만 작성).
- 완료 조건: **A1~A9, C6~8, R9**. 시나리오별 전후 측정표와 A6 평가 세트·결과·stderr, G1~G11, 매니페스트 검증, 실측 5건의 누적 지표, C6 두 notes 적용 여부, 남은 미검증을 보고한다. 효율 결론은 `워커 생략·재독 감소 확인, 전체 토큰/비용 절감률 미입증`으로 제한하며 실측 실패/미실행 부분은 `정적 개선, 실제 효율 미검증`으로 적는다. 트리 3·5 전환은 실측 미검증으로 적는다.
- 검증 방법: `git status --short`, `git diff --check`, `git diff 5e833be -- plugins/paseo-toolkit/.claude-plugin/plugin.json plugins/paseo-toolkit/.codex-plugin/plugin.json`을 실행한다. `python scripts/graph_update.py --self-test`, T10~T12의 정적·트리거 검사 결과, T14~T17의 로그·결과를 재확인한다. Git 스테이징·커밋·푸시는 각각 명시적 사용자 승인 전에는 실행하지 않는다.

## SPEC ID 대조표

| ID | 담당 태스크 |
| --- | --- |
| R1-1~10 | T01 |
| R1-11 | T03 |
| R2-1~6 | T02 |
| R3-1~6 | T09 |
| R4-1~3 | T04 |
| R5-1~6, R5-9 | T05 |
| R5-7~8 | T06 |
| R6-1~7 | T07 |
| R6-8 | T07·T08 |
| R6-9 | T03 |
| R7-1~9 | T08 |
| R8-1~3 | T04 |
| R9-1~3 | T01·T02·T04·T06·T11·T18 |
| C1 | T13 |
| C2 | T09·T10 |
| C3 | T12 |
| C4 | T09·T10 |
| C5 | T09 |
| C6 | T03·T18 |
| C7 | T13~T17 |
| C8 | T13~T17 |
| A1 | T10·T18 |
| A2 | T06·T10 |
| A3 | T10 |
| A4 | T11 |
| A5/G1~G11 | T05 |
| A6 | T12 |
| A7 | T13 |
| A8 | T14~T17 |
| A8-1 | T14 |
| A8-2 | T15 |
| A8-3 | T16 |
| A8-4 | T14 |
| A8-5 | T17 |
| A9 | T03·T13·T18 |
