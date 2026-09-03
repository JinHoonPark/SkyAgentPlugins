# provider·mode·thinking 스냅샷

프로필의 `provider`, `model`, `modeId`, `thinkingOptionId`, `featureValues`를 정할 때 읽는다.

**이 표는 2026-09-03 실측 스냅샷이며 낡는다.** Paseo가 provider와 모델을 추가·제거하면
값이 달라진다. 실제 등록 직전에는 아래 MCP 도구로 다시 조회하고, 조회 결과와 이 문서가
다르면 **조회 결과를 쓴다.**

## 실시간 조회

| 도구 | 얻는 값 |
| --- | --- |
| MCP `list_providers` | provider 목록, 활성 여부, `modes[].id` |
| MCP `inspect_provider` | 한 provider의 `modes[].id`, `features[].id` |
| MCP `list_models` | 모델 ID, 모델별 `thinkingOptions[].id` |

### CLI로는 mode 전체 목록을 얻을 수 없다

원리적 한계다. mode 목록을 주는 CLI 명령 자체가 존재하지 않는다.

| 명령 | 주는 것 | mode 목록 |
| --- | --- | --- |
| `paseo provider ls --json` | provider 목록, `defaultMode` **하나** | ✗ 기본값 하나뿐 |
| `paseo provider models <provider> --json` | 모델 ID, `thinkingOptionIds` | ✗ 없음 |
| `paseo provider diagnostic --json` | 설치 여부, PATH, 버전 | ✗ 없음 |

MCP를 쓸 수 없는 상황이면 확신할 수 있는 mode는 `defaultMode` 하나뿐이다. 나머지는 이
문서의 스냅샷을 근거로 쓰되, 실시간으로 확인하지 못했다는 사실을 사용자에게 알린다.

## provider별 mode

이름이 겹치는 것은 `auto` 하나뿐이고 **두 provider에서 의미가 서로 다르다.** provider를
바꾸면서 `modeId` 문자열을 그대로 옮기지 않는다.

| provider | 유효 `modeId` | 기본값 |
| --- | --- | --- |
| `claude` | `plan` `default` `acceptEdits` `auto` `bypassPermissions` | `auto` |
| `codex` | `auto` `auto-review` `full-access` | `auto-review` |
| `grok` | **미확인** | 미확인 |

- grok의 mode 목록은 조사되지 않았다. 추측해 채우지 말고 `list_providers` 또는
  `inspect_provider`로 확인한다.
- `scripts/manage_profiles.py`의 검증용 스냅샷 상수 `KNOWN_MODE_IDS`에는 claude와 codex
  두 provider만 있다. 여기 없는 provider는 `defaultMode`가 아닌 모든 값에
  `MODE_UNVERIFIED` **경고**를 받는다. 차단은 아니므로 `--apply`는 통과한다.

### 권한 등급 대응

프로필을 설계할 때 쓰는 **관례적 대응표**다. 두 provider의 mode 의미가 같다는 뜻이 아니다.

| 권한 등급 | claude | codex |
| --- | --- | --- |
| 읽기·확인 중심 | `auto` | `auto` |
| 파일 작성 포함 | `auto` (프롬프트를 줄이려면 `acceptEdits`) | `auto-review` |
| 명령 전권 | `bypassPermissions` | `full-access` |

- **표에 없는 provider도 같은 방식으로 대응시킨다.** `inspect_provider`로 그 provider의
  `modes[].id`를 받아, 가장 제약이 큰 것을 읽기·확인에, 가장 제약이 없는 것을 명령 전권에
  놓는다. mode가 하나뿐이면 세 등급 모두 그 값이 된다. 이름만으로 뜻이 분명하지 않으면
  사용자에게 확인한다.
- codex `full-access`는 **네트워크 접근과 무제한 실행**을 준다. 명령 실행 자체가 목적인
  프로필에만 붙인다. 조사·검색처럼 읽기만 하는 프로필에는 쓰기 권한도 기본으로 주지 않는다.
- claude `plan`은 코드 수정과 도구 실행을 막아 **문서 산출까지 막는다.** 파일을 만들어야
  하는 프로필에 쓰지 않는다. `scripts/manage_profiles.py`가 `CLAUDE_PLAN` 경고를 낸다.

## 활성 provider

사용자의 현재 Paseo 설정 기준 스냅샷이다.

| provider | 상태 | 모델 수 |
| --- | --- | --- |
| Claude | 활성 | 15 |
| Codex | 활성 | 7 |
| Grok | 활성 | 2 |
| Copilot, OpenCode, Pi, Oh My Pi | 비활성 | — |

위 표는 **한 시점의 예시일 뿐 판정 근거가 아니다.** 활성 provider 구성은 사용자마다 다르고
언제든 바뀐다. claude·codex 2종만 가정하지 않는다. 어떤 provider가 후보인지는 항상
`list_providers`의 실조회 결과로 정하며, 이 표에 없는 provider도 활성이면 동등하게 후보다.

## 모델별 thinking 옵션

`thinkingOptionId`의 유효 값은 **provider가 아니라 모델 단위로 다르다.** 최상위 값은 이름도
서로 다르다 — claude는 `ultracode`, codex는 `ultra`다.

아래 표도 스냅샷이다. **실제 값은 `list_models`가 돌려준 `thinkingOptions`로 정한다.**
이 표는 값의 생김새와 모델별 편차의 폭을 보여주는 예시로만 읽는다.

| 모델 | `thinkingOptions` |
| --- | --- |
| `claude-opus-5`, Sonnet 5, Opus/Sonnet 4.8·4.7 | `off` `low` `medium` `high` `xhigh` `max` `ultracode` |
| Fable 5, Fable 5.1 | `low` `medium` `high` `xhigh` `max` `ultracode` (`off` 없음) |
| Opus 4.6, Sonnet 4.6 | `off` `low` `medium` `high` `max` (`xhigh` 없음) |
| Haiku 4.5, `opus[1m]` | **없음 (빈 배열)** |
| `gpt-5.6-sol`, `gpt-5.6-terra` | `low` `medium` `high` `xhigh` `max` `ultra` |
| `gpt-5.6-luna` | `low` `medium` `high` `xhigh` `max` (`ultra` 없음) |
| `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark` | `low` `medium` `high` `xhigh` (`max` 없음) |

기본값은 claude 계열이 `high`, codex 계열이 전부 `xhigh`다.

표시명(`Sonnet 5`, `Haiku 4.5`)과 실제 모델 ID는 다를 수 있다. 프로필에는 반드시
`list_models`가 돌려준 **ID**를 넣는다.

### 함정 — 옵션이 빈 배열인 모델

**Haiku 4.5와 `opus[1m]`에는 `thinkingOptionId`를 넣지 않는다. 필드 자체를 생략한다.**
빈 문자열도 `off`도 안 된다. 이 두 모델에는 유효한 값이 하나도 없다.

`scripts/manage_profiles.py`는 모델의 `thinkingOptionIds`에 없는 값을 **경고가 아니라
오류(`THINKING`)로 막는다.** 오류가 하나라도 있으면 `--apply`가 프로필 전체를 쓰지 않는다.

같은 이유로 아래도 전부 오류다.

- Opus 4.6 / Sonnet 4.6에 `xhigh`
- `gpt-5.6-luna`에 `ultra`
- `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`에 `max`
- codex 모델에 `ultracode`, claude 모델에 `ultra`

모델 후보를 여럿 두고 그중 하나를 고르는 방식으로 프로필을 만들 때는, **고른 모델의
`thinkingOptions`를 다시 확인한 뒤** 값을 정한다. 다른 후보에 쓰려던 값을 그대로 옮기지
않는다.

### 스냅샷에 없는 모델

위 표에 없는 모델이 조회 결과에 나오는 것은 정상이다. 새 모델이 추가되었거나 이 문서를
쓸 때 없던 provider가 활성화된 경우다. **표에 없다는 이유로 후보에서 빼지 않는다.**

- `thinkingOptionId`는 그 모델의 `thinkingOptions` 실조회 값으로 정한다. 표를 참고하지
  않아도 정해진다.
- 성능 등급은 [`presets.md`](presets.md)의 등급 판정 규칙으로 정한다. 그 규칙도 조회 결과
  하나만 쓴다.
- 규칙으로 등급이 갈리지 않으면(예: 사고 상한이 같은 모델이 여럿이고 순서로도 우열을
  못 정한다) **추측하지 말고 사용자에게 어느 등급으로 둘지 묻는다.**

## featureValues

provider·모델별 토글 스위치 모음이다. 값은 `{ "<feature id>": <bool> }` 형태다.

**같은 값을 부르는 이름이 두 곳에서 다르다.**

| 위치 | 키 이름 |
| --- | --- |
| 프로필 (`config.json`의 `daemon.agentProfiles[]`) | `featureValues` |
| MCP `create_agent` | `settings.features` |

| provider/model | feature id | 형식 | 기본값 |
| --- | --- | --- | --- |
| `codex/gpt-5.6-luna`, `codex/gpt-5.6-terra`, `codex/gpt-5.6-sol` | `fast_mode`, `plan_mode` | toggle | `false` |
| `claude/claude-opus-5` | `fast_mode` | toggle | `false` |
| `claude/claude-sonnet-5` | 없음 (빈 배열) | — | — |

- feature 집합은 **모델마다 다르다.** 같은 provider라도 모델이 바뀌면 다시 확인한다.
  근거는 `inspect_provider`가 돌려준 `features[].id`다.
- Paseo CLI(`paseo run`, `paseo agent update`)에는 feature 관련 플래그가 **없다.**
  feature를 지정해 에이전트를 띄워야 하면 MCP `create_agent`의 `settings.features`를 쓴다.
