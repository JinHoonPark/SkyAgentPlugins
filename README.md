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
| [`paseo-toolkit`](plugins/paseo-toolkit/.claude-plugin/plugin.json) | Claude Code, Codex CLI | 0.18.2 | Paseo 에이전트·데몬 운영: 단계별 워크플로 오케스트레이션, 에이전트 프로필 구성, 결과 보고 |
| [`codex-skill-creator`](plugins/codex-skill-creator/.codex-plugin/plugin.json) | Codex CLI 전용 | 1.0.0 | 스킬 생성·개선·성능 측정. Claude Code에는 동일 기능의 공식 `skill-creator` 플러그인이 이미 있어 등록하지 않음 |
| [`orchestration-graph`](paseo-plugins/orchestration-graph/paseo-plugin.json) | Paseo | 0.8.0 | 오케스트레이션 실행 그래프를 Paseo 패널에 표시. `.skywork`의 GRAPH.md 노드 표와 mermaid 엣지를 한 캔버스로 렌더하고, 노드 클릭으로 해당 에이전트로 이동. 데스크톱·웹에서는 커서 기준 휠 줌(25~200%)과 드래그 이동 지원 |

## `paseo-toolkit` 스킬

`agent-orchestration`, `profile-setup`, `profile-test-run`은 Paseo 앱·데몬의 MCP 연결을 전제한다. `profile-copy`는 로컬 설정에서 프로필을 읽는다. `agent-orchestration`은 위임할 때 호출 전에 `ToolSearch`가 있으면 필요한 `mcp__paseo__*` 도구 스키마를 먼저 로드하고, 없으면 노출된 도구와 현재 검색 수단으로 확인한다. 라우팅은 `profile-setup`으로 등록해 둔 에이전트 프로필을 대상으로 한다.

| 스킬 | 요약 |
|---|---|
| [`agent-orchestration`](plugins/paseo-toolkit/skills/agent-orchestration/SKILL.md) | 팀장(리더) 에이전트가 모든 요청의 첫 도구 호출 전에 읽는 라우팅 절차. 브레인스토밍과 사용자 문답은 팀장이 맡고, 그 밖의 작업은 팀장을 직접 지정하지 않으면 워커에 위임해 결과를 판정·보고한다. 워커는 다시 위임하지 않는다. |
| [`profile-setup`](plugins/paseo-toolkit/skills/profile-setup/SKILL.md) | Paseo 에이전트 프로필(작업 종류별 provider·model·mode·thinking 묶음)을 설계·등록·변경·조회·삭제하고, 설정 파일과 데몬에 기록된 값이 의도대로 들어갔는지 확인한다. |
| [`profile-test-run`](plugins/paseo-toolkit/skills/profile-test-run/SKILL.md) | 등록된 프로필이 notes가 약속한 대로 동작하는지 실제 작업을 시켜 확인한다. 실행된 에이전트의 model·mode·thinking·features가 프로필과 일치하는지 본 뒤, 결과 품질을 별도 심판 에이전트로 채점해 합불을 낸다. |
| [`profile-copy`](plugins/paseo-toolkit/skills/profile-copy/SKILL.md) | 이 PC의 Paseo 에이전트 프로필을 다른 사람에게 전달할 수 있는 핸드오프 프롬프트로 추출한다. 설정 파일을 읽기만 하며 바꾸거나 데몬을 재시작하지 않는다. |

## `codex-skill-creator` 스킬

| 스킬 | 요약 |
|---|---|
| [`skill-creator`](plugins/codex-skill-creator/skills/skill-creator/SKILL.md) | 새 스킬을 처음부터 만들거나 기존 스킬을 수정·최적화하고, 평가(eval)로 스킬 성능을 측정한다. 스킬을 새로 만들거나, 편집·최적화하거나, 트리거 정확도를 위해 description을 다듬거나, variance 분석으로 벤치마크할 때 쓴다. |

## `orchestration-graph` (Paseo 플러그인)

에이전트 오케스트레이션 실행 그래프를 Paseo 패널에 그려 보여 주는 Paseo 플러그인이다. 워크스페이스의 `.skywork/paseo-orchestration/<날짜>-<슬러그>/GRAPH.md`를 읽어, 노드 표의 각 행과 mermaid의 엣지를 하나의 캔버스로 합쳐 렌더한다. 노드를 누르면 그 노드에 배정된 에이전트로 이동한다. 그래프를 드래그해 캔버스를 이동할 수 있다. 데스크톱·웹에서는 휠을 위로 굴리면 커서 위치를 기준으로 확대하고 아래로 굴리면 축소한다. 배율은 25~200%이며 그래프를 바꾸면 100%로 돌아간다. 패널은 2초마다 파일을 다시 읽어 실행 중 바뀐 노드 상태를 반영한다.

Paseo 0.8.0 이상이 필요하다.

### 설치

Git 소스에서 저장소 안 플러그인 경로를 지정해 설치한다.

```
paseo plugin add 'https://github.com/JinHoonPark/SkyAgentPlugins.git:paseo-plugins/orchestration-graph'
```

갱신은 `paseo plugin update orchestration-graph`로 한다. 브랜치·태그·커밋을 고정하려면 `--ref`를 덧붙인다(`paseo plugin add 'https://github.com/JinHoonPark/SkyAgentPlugins.git:paseo-plugins/orchestration-graph' --ref main`).

### 여는 법

에이전트 컴포저의 pill 「그래프」를 누르면 explorer 위치에 「오케스트레이션 그래프」 패널이 열린다. pill은 에이전트마다 등록되며, 그래프 루트를 확인하면 같은 그래프의 pill에서 루트에 고정된 패널 하나를 연다. 루트를 확인하지 못하면 누른 에이전트를 기준으로 패널을 연다. 그래프가 여러 개면 패널 안에서 고른다.

### 알아 둘 제약

- 모바일 앱에서는 패널 탭이 열리지 않는다. 데스크톱 앱에서만 열리는 것을 데몬·앱 0.8.0에서 확인했다.
