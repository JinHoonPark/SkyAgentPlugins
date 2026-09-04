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
| `grok` | `default` | `default` |

- grok은 `modes[].id`가 빈 배열이라 `default` 외에 다른 값이 없다(2026-09-04 확인). 판별
  기준과 처리 방법은 아래 「전용 어댑터 없이 CLI에만 붙는 provider」를 본다.
- `../../scripts/manage_profiles.py`의 검증용 스냅샷 상수 `KNOWN_MODE_IDS`에는 claude와 codex
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
  하는 프로필에 쓰지 않는다. `../../scripts/manage_profiles.py`가 `CLAUDE_PLAN` 경고를 낸다.

### 전용 어댑터 없이 CLI에만 붙는 provider

claude·codex는 Paseo가 전용 어댑터로 붙어 mode·thinking을 어댑터 차원에서 옮겨 준다. 일부
provider는 어댑터 없이 일반 ACP로 그 CLI의 stdio에만 붙는다 — Paseo 쪽에 mode·thinking을
옮길 통로 자체가 없다.

**판별 기준.** `inspect_provider`의 `modes`와 그 모델의 `thinkingOptions`가 **둘 다 빈
배열**이고, `list_providers`/`provider ls --json`에는 `defaultMode` 하나만 값으로 남으면 이
경우다. mode가 하나뿐인 경우(위 「권한 등급 대응」의 "mode가 하나뿐이면" 문단)와는 다르다 —
하나뿐이면 `modes[].id`에 그 값이라도 있지만, 이 경우는 `modes[].id` 자체가 비어 있다.
(2026-09-04 기준 `grok`이 이 상태다.)

이 경우의 처리:

- **`modeId`는 `defaultMode` 값 하나를 세 등급 모두에 쓴다.** 그 provider 안에서 권한 등급을
  나눌 방법이 없어 **이 값을 넣어도 그 provider의 동작은 바뀌지 않는다.** 그래도 필드를
  비워 두면 provider가 다른 `create_agent` 호출이 `cannot inherit mode ... from caller`로
  거절되므로 값 자체는 채운다.
- **`thinkingOptionId`는 넣지 않는다.** 다른 provider에서 쓰던 값(예: codex의 `xhigh`,
  `max`)을 그대로 옮기지 않는다. 처리는 「함정 — 옵션이 빈 배열인 모델」과 같지만 원인은
  다르다 — 그 절의 모델들은 모델 자체에 사고 깊이가 없고, 여기는 모델엔 있어도 Paseo가 그
  값을 받아올 통로가 없는 것이다.
- **`featureValues`의 토글은 이름이 같아 보여도 다른 provider의 것과 같다고 가정하지
  않는다.** 아래 「featureValues」의 `auto_accept` 항목을 본다.
- **사고 깊이·권한 세부·스킬·MCP·로그인처럼 실제 동작을 바꾸는 값은 Paseo 프로필이 아니라 그
  CLI 자체 설정에 있다.** 프로필로 흉내 내려 하지 말고 설정 위치를 사용자에게 안내한다.
  grok은 `~/.grok/config.toml`의 `[models] default_reasoning_effort`가 실제 제어 지점이다 —
  `grok-4.6` 허용값은 `low`/`medium`/`high`/`xhigh`, 기본은 `high`, 최대는 `xhigh`다. CLI
  플래그는 `--reasoning-effort`/`--effort`, API wire는 `reasoning.effort`이고, 로컬
  `~/.grok/models_cache.json`도 같은 메뉴를 광고한다.

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

grok-4.6도 `thinkingOptions`가 빈 배열로 온다(2026-09-04 확인). 원인은 다르다 — 모델 자체에
사고 깊이가 없는 게 아니라, Paseo가 grok을 전용 어댑터 없이 일반 ACP로만 붙여 그 값을 받아올
통로가 없는 것이다. 처리는 같다: `thinkingOptionId`를 넣지 않는다. 원인과 다른 필드까지
함께 보려면 「provider별 mode」의 「전용 어댑터 없이 CLI에만 붙는 provider」를 본다.

`../../scripts/manage_profiles.py`는 모델의 `thinkingOptionIds`에 없는 값을 **경고가 아니라
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
| `grok/grok-4.6` | `auto_accept` | toggle | 미확인 |

- feature 집합은 **모델마다 다르다.** 같은 provider라도 모델이 바뀌면 다시 확인한다.
  근거는 `inspect_provider`가 돌려준 `features[].id`다.
- Paseo CLI(`paseo run`, `paseo agent update`)에는 feature 관련 플래그가 **없다.**
  feature를 지정해 에이전트를 띄워야 하면 MCP `create_agent`의 `settings.features`를 쓴다.
- **이름이 비슷해도 다른 provider의 기능과 같다고 가정하지 않는다.** grok의 `auto_accept`는
  권한 확인 프롬프트에 Allow를 대신 눌러주는 feature 토글이다. codex의 `auto-review`는 이름이
  비슷해 보여도 **feature가 아니라 `modeId`**이고, 승인을 건너뛰는 게 아니라 리뷰
  서브에이전트로 우회하는 것이다. 뜻이 같다고 가정하지 말고 `inspect_provider`의
  `features[].id`로 그 provider·모델에 실제로 있는 기능인지 먼저 확인한다.
