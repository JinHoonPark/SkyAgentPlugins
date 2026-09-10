# SkyAgentPlugins

Claude Code와 Codex CLI 양쪽에서 쓰는 개인 에이전트 플러그인 마켓플레이스다. 마켓플레이스 매니페스트는 에이전트별로 따로 있다.

- Claude Code용: [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json)
- Codex CLI용: [`.agents/plugins/marketplace.json`](.agents/plugins/marketplace.json)

## 설치

### Claude Code

```
claude plugin marketplace add https://github.com/JinHoonPark/SkyAgentPlugins.git
claude plugin install paseo-toolkit@sky-agent-plugins
```

### Codex CLI

```
codex plugin marketplace add https://github.com/JinHoonPark/SkyAgentPlugins.git
codex plugin add paseo-toolkit@sky-agent-plugins
codex plugin add codex-skill-creator@sky-agent-plugins
```

로컬 클론을 그대로 쓰려면 URL 대신 저장소 경로를 넘기면 된다.

## 등록·설치·사용 흐름

```mermaid
flowchart LR
    A["마켓플레이스 매니페스트<br/>(.claude-plugin 또는 .agents/plugins)"] -->|marketplace add| B[마켓플레이스 등록]
    B -->|plugin install / plugin add| C[플러그인 설치]
    C --> D[SKILL.md description 매칭]
    D -->|사용자 발화가 트리거와 일치| E[스킬 발동]
```

## 플러그인 목록

| 플러그인 | 대상 | 버전 | 설명 |
|---|---|---|---|
| [`paseo-toolkit`](plugins/paseo-toolkit/.claude-plugin/plugin.json) | Claude Code, Codex CLI | 0.5.5 | Paseo 에이전트·데몬 운영: 단계별 워크플로 오케스트레이션, 에이전트 프로필 구성, 결과 보고 |
| [`codex-skill-creator`](plugins/codex-skill-creator/.codex-plugin/plugin.json) | Codex CLI 전용 | 1.0.0 | 스킬 생성·개선·성능 측정. Claude Code에는 동일 기능의 공식 `skill-creator` 플러그인이 이미 있어 등록하지 않음 |

## `paseo-toolkit` 스킬

`paseo-toolkit`의 스킬은 Paseo 앱·데몬과의 MCP 연결을 전제한다. `agent-orchestration`은 호출 전에 `ToolSearch`로 `mcp__paseo__*` 도구 스키마를 먼저 로드하며, 라우팅은 `profile-setup`으로 등록해 둔 에이전트 프로필을 대상으로 한다.

| 스킬 | 요약 |
|---|---|
| [`agent-orchestration`](plugins/paseo-toolkit/skills/agent-orchestration/SKILL.md) | 팀장(리더) 에이전트가 작업 요청에 착수하기 전 항상 읽는 라우팅 규칙. 할 일만 적힌 요청을 워커에 위임하고 결과를 취합해 보고한다. 예외는 사용자가 팀장을 직접 지목했을 때뿐이며, 워커는 다시 위임하지 않는다. |
| [`profile-setup`](plugins/paseo-toolkit/skills/profile-setup/SKILL.md) | Paseo 에이전트 프로필(작업 종류별 provider·model·mode·thinking 묶음)을 설계·등록·변경·조회·삭제하고, 설정 파일과 데몬에 기록된 값이 의도대로 들어갔는지 확인한다. |
| [`profile-test-run`](plugins/paseo-toolkit/skills/profile-test-run/SKILL.md) | 등록된 프로필이 notes가 약속한 대로 동작하는지 실제 작업을 시켜 확인한다. 실행된 에이전트의 model·mode·thinking·features가 프로필과 일치하는지 본 뒤, 결과 품질을 별도 심판 에이전트로 채점해 합불을 낸다. |
| [`profile-copy`](plugins/paseo-toolkit/skills/profile-copy/SKILL.md) | 이 PC의 Paseo 에이전트 프로필을 다른 사람에게 전달할 수 있는 핸드오프 프롬프트로 추출한다. 설정 파일을 읽기만 하며 바꾸거나 데몬을 재시작하지 않는다. |

## `codex-skill-creator` 스킬

| 스킬 | 요약 |
|---|---|
| [`skill-creator`](plugins/codex-skill-creator/skills/skill-creator/SKILL.md) | 새 스킬을 처음부터 만들거나 기존 스킬을 수정·최적화하고, 평가(eval)로 스킬 성능을 측정한다. 스킬을 새로 만들거나, 편집·최적화하거나, 트리거 정확도를 위해 description을 다듬거나, variance 분석으로 벤치마크할 때 쓴다. |
