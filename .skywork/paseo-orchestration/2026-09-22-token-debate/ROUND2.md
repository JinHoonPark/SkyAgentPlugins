# 2라운드 입력 — 팀장이 정리한 쟁점

참가자 1라운드: 팀장 LEAD.md / 자문 nodes/N1.md / 리뷰 nodes/N2.md

## 팀장이 추가로 확인한 사실
- 실측: 리뷰 워커(codex gpt-5.6-sol) 첫 턴 `lastUsage.inputTokens` 31,965, 그중 `cachedInputTokens` 31,232.
  브리핑은 약 2천 자. 즉 codex 워커 1개의 기동 입력 고정비는 약 3만 토큰이고 대부분 캐시 적중(교차 세션 접두부).
- 8번 조사(Paseo 데스크톱 번들 resources/app.asar 코드):
  - `daemon.mcp.injectIntoAgents`는 전역 스위치다. 사용자 설정 값은 true. 켜져 있으면 데몬이 띄운 모든
    에이전트(팀장·워커 구분 없음)에 Paseo 도구가 붙는다(`agentManager.setPaseoToolsEnabled`).
  - 에이전트 단위 차단은 없다. provider 단위 정책이 있다: provider 설정의 `paseoTools: { enabled?: bool,
    disabledTools?: string[] }` (`resolvePaseoToolPolicy(providerId, providerSettings)`). codex 워커만 끄거나
    `create_agent` 같은 특정 도구만 뺄 수 있으나, 같은 provider를 쓰는 팀장(claude)에도 적용된다.
  - 사용자 `daemon.appendSystemPrompt`는 비어 있다(8절 상시 줄 충돌 없음).

## 쟁점 (각자 입장을 밝히고, 상대 논거를 반박하거나 수용한다)
T1. 6번(판정 통합): 자문=조건부 찬성, 리뷰=진행 불가. 팀장 중재안: 스펙 워커는 SPEC.md 확정 시점에
    "스파이크 필요성 판정안"만 함께 낸다(스펙 피드백 루프가 이미 같은 워커라 추가 기동 없음).
    spec notes가 배제하는 것은 "검증 설계"이지 "필요성 판정"이 아니다. 마일스톤 판정은 스파이크 뒤
    그대로 두되, 스파이크 생략 시에는 같은 스펙 워커에 이어 묻는다. 이 안이 단계 역전·프로필 경계를 깨는가?
T2. 2번(Step 0 스니펫): 셋 다 파일 방식 반대. 리뷰안 = description 트리거에 "되돌리기 어려운 행동"을
    넣는다. 이 경우 파일 삭제 한 건에도 SKILL 전체가 로드되는 비용 vs. 안전. 더 나은 대안?
T3. 1번(조건부 적용)의 구체 기준: "탐색량이 크다"를 어떻게 문장으로 정의할지, 애매할 때 직접 처리
    기본값이 Step 5("모르겠다"→레벨 2)와 충돌하지 않게 하는 문구. 사용자 설정의 team-lead 프로필 notes
    ("작업 자체는 담당 워커에게 맡긴다")는 저장소 밖이라 보고만 한다 — 동의?
T4. 3번 지표: 셋 다 "SKILL 50%"는 대리 지표라는 데 동의. 대체 합격 기준을 한 세트로 확정:
    (a) 경로별 실제 로드 문자 합(레벨1·레벨2·직접처리), (b) 경로별 Read 횟수, (c) 가능하면 동일 시나리오의
    reported input tokens. 무엇을 SKILL.md에 남기고 무엇을 옮길지 목록을 확정하자.
T5. 자문 추가안(독립 질문 묶기, patch 흐름 단순화, thinking 등급) 중 이번 범위에 넣을 것과 후속으로 뺄 것.
T6. 버전: 두 참가자 모두 "개발 중 마이너 +1"이 AGENTS.md 버전 규칙과 충돌한다고 봄 — 머지 직전 승인으로
    미룬다. 새 파일(graph_update.py)은 skill-creator 대상. 이의 있으면 제기.
