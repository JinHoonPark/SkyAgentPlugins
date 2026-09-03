---
name: profile-setup
description: Paseo 앱의 에이전트 프로필을 설계하고 등록·반영할 때 사용한다. "paseo 프로필 만들어줘", "에이전트 프로필 등록", "paseo 세팅", "라우팅용 프로필 추가" 요청에 적용하며, 프로필로 에이전트를 실제 실행해 확인하는 작업은 다루지 않는다.
---

# Paseo 에이전트 프로필 설정

Paseo 프로필은 사람이 정한 시작 구성 묶음이다. 프로필을 설계한 뒤에는 이 스킬의
[`scripts/manage_profiles.py`](scripts/manage_profiles.py)를 실행해 검증·백업·설정
반영·reload·로그 판정·실패 시 롤백을 일관되게 처리한다. 전용 `paseo profile ...`
CLI 명령은 없다.

사용자가 설계만 요청했다면 후보 프로필과 선택 근거만 제시하고 스크립트를
`--apply`로 실행하지 않는다. 등록 또는 반영까지 명시적으로 요청한 경우에만
아래 스크립트를 사용한다.

## 프로필 세트 설계

먼저 사용자의 작업 흐름을 서로 다른 시작 구성으로 나눈다. 각 역할에는 어떤 일을
맡는지, 인접 역할과 무엇으로 갈리는지, 적절한 provider/model/mode를 정한다.
예를 들어 탐색, 구현, 디버깅, 리뷰처럼 결과와 권한 요구가 다른 작업은 분리한다.
역할이 겹치면 프로필을 늘리기보다 선택 경계를 선명하게 만든다.

필수 필드는 `id`, `name`, `provider`이며 선택 필드는 `model`, `modeId`,
`thinkingOptionId`, `featureValues`, `icon`, `color`, `notes`다. 스키마는 알 수 없는
키도 통과시키지만, 오타나 system prompt를 넣는 근거로 쓰지 않는다. 스크립트는
알 수 없는 키를 경고하고 필수 세 필드 누락을 오류로 막는다.

프로필은 자동으로 라우팅되지 않는다. 라우팅을 맡는 팀장(오케스트레이터) 프로필이
하나는 있어야 한다. 팀장은 MCP `list_profiles`로 모든 프로필의 `notes`를 읽어
작업에 맞는 하나를 고른다. 그런 다음 선택한 프로필을 다음 다섯 값으로
`create_agent` 호출에 구체화한다.

- `provider`와 `model` → `create_agent.provider`의 `provider/model`
- `modeId` → `settings.modeId`
- `thinkingOptionId` → `settings.thinkingOptionId`
- `featureValues` → `settings.features`

`create_agent`에는 `profile` 인수가 없다. 프로필 선택을 기억하거나 나중에 설정
차이를 추론하지 말고, 매번 현재 값을 복사한다.

## `notes`는 선택용 설명이다

`notes`의 UI 라벨은 "When to use"(한국어 UI에서는 "사용 시점")다. 팀장이
프로필을 고를 때만 사용하며 워커 에이전트에는 전달되지 않는다. 프로필 스키마에는
의도적으로 system prompt가 없다.

따라서 `notes`에 "~하지 말 것", "~에게 넘길 것" 같은 워커 행동 규칙을 쓰지
않는다. 그런 문구는 아무 동작도 강제하지 않는다. 실제 워커 제약은 다음 중 하나에
둔다.

1. 팀장이 `create_agent`에 주는 `initialPrompt`
2. 저장소의 `CLAUDE.md` 또는 `AGENTS.md`
3. 데몬 전역의 `daemon.appendSystemPrompt`

`notes`는 한두 줄의 선택용 서술문으로 쓴다. UI의 권장 placeholder는
`Use for UI work — components, layout and design tokens.`이다. 같은 형식의 한국어
예는 `"UI 작업에 사용 — 컴포넌트, 레이아웃, 디자인 토큰."`이다. 인접 프로필과의
오선택을 막는 짧은 구절 하나(예: `원인 추적은 디버깅.`)는 허용한다.

`list_profiles`는 모든 등록 프로필의 `notes`를 한꺼번에 반환한다. 따라서 긴
설명은 팀장의 선택 정확도를 낮춘다. 스크립트는 160자를 넘으면 경고한다. 이는
짧은 두 문장 정도는 허용하면서, 설명이 지시문이나 미니 사양으로 커지는 것을
막기 위한 기준이다.

## 런타임 값 선택

스크립트는 `paseo status --json`에서 Paseo home과 로그 경로를 얻고,
`paseo provider ls --json` 및 `paseo provider models <provider> --json`으로 현재
사용 가능한 provider, model ID, thinking option ID를 검증한다. 표시명 대신
반환된 ID를 사용한다. 쉘에서 `paseo`를 찾지 못하면 shim의 절대 경로를 추측하지
말고, PowerShell PATH에서 CLI를 사용할 수 있게 한 뒤 다시 실행한다.

`modeId` 전체 목록을 주는 CLI 명령은 없다. Paseo MCP가 있으면
`inspect_provider`(또는 `list_providers`)의 `modes[].id`로 확인한다. CLI에서는
`paseo provider ls --json`의 `defaultMode` 하나만 ID로 신뢰할 수 있다. 스크립트는
0.7.2 스냅샷에 없는 mode를 경고만 하므로 새 버전의 유효 값을 막지 않는다.

Claude의 `plan`은 코드 수정과 도구 실행을 막아 문서 산출까지 막는다. 문서나
파일을 만들어야 하는 프로필에는 선택하지 않는다.

`featureValues`에는 기능 토글 ID를 키로 쓴다. 예를 들어 Fast 모드는
`{ "fast_mode": true }`지만, 실제 사용 전에는 `inspect_provider`가 반환한 기능인지
확인한다.

`icon`은 이모지가 아니다. 다음 29개 키 중 하나만 사용한다. 다른 값은 런타임에서
오류 없이 기본 아이콘으로 보이므로 스크립트가 적용 전에 오류로 막는다.

```text
code terminal bug wrench hammer flask testTube microscope search eye palette
feather pencil fileText book rocket package boxes server database cpu cloud globe
gitBranch layers compass brain sparkles shield
```

`color`는 `none`, `violet`, `sky`, `emerald`, `orange`, `pink`, `indigo`, `teal`,
`red`, `amber`, `blue` 중 하나다. 다른 값은 오류 없이 `none`이 되므로 스크립트가
적용 전에 오류로 막는다.

## 등록·반영 스크립트

프로필 한 개 JSON 객체 또는 여러 프로필 JSON 배열을 파일 인수로 주거나 표준입력으로
전달한다. 파일·stdin 입력, 기존 ID 교체, backup 복원 모두 다음 스크립트가 처리한다.

```powershell
# 검증만 수행한다. 기본값이며 어떤 파일도 만들거나 바꾸지 않는다.
python scripts/manage_profiles.py profile.json

# 단건 또는 배열 입력을 검증한 뒤 적용한다.
python scripts/manage_profiles.py profiles.json --apply

# 기존 ID를 승인한 내용으로 교체한다.
python scripts/manage_profiles.py profile.json --update --apply

# stdin으로 배열을 전달한다.
Get-Content -Raw profiles.json | python scripts/manage_profiles.py --apply

# 테스트용 설정 사본에만 적용한다. 실제 daemon reload가 실제 설정을 읽는 한계가 있다.
python scripts/manage_profiles.py profile.json --config temp-config.json --apply

# 이번 작업의 backup을 명시적으로 복원한다.
python scripts/manage_profiles.py --rollback backup.json --apply
```

`--apply`가 없으면 완전한 dry-run이다. 스크립트는 검증 결과, 추가/교체될 ID,
최종 배열 길이를 보고하지만 설정·백업·로그를 전혀 바꾸지 않는다. 오류가 하나라도
있으면 `--apply`가 있어도 쓰지 않는다. `--update`가 없는데 기존 ID와 충돌하면
오류이고, `--update`가 있으면 해당 객체 하나만 교체한다.

`--apply`는 고유 이름의 backup을 만든 뒤 원본을 재읽어 검증 시점과 같음을 확인하고,
대상 객체만 삽입 또는 교체한다. 이후 JSON 재파싱, `paseo daemon reload`, reload 뒤의
신규 로그 줄 판정까지 수행한다. reload 실패·검증 로그·재파싱 실패가 나면 backup을
복원하고 다시 reload한다. 기존 `config.json.bak`는 절대 덮어쓰지 않는다.

`--rollback`은 지정한 파일의 이름 규칙과 위치로 대상을 거른다.
`<config 파일명>.profile-setup.<apply|rollback>.<시각>.<uuid>.bak` 이름이 아니거나
대상 설정과 다른 디렉터리에 있으면 파싱에 성공해도 오류로 막는다. 사용자가 직접 만든
`config.json.bak`이나 다른 Paseo 설치의 설정 파일은 이 명령으로 복원할 수 없다.
이름과 위치만 보므로 이 스크립트가 실제로 만들었다는 증거까지 확인하지는 않는다.

Paseo 데스크톱 앱의 프로필 편집기는 배열 전체를 덮어쓴다. 스크립트로 적용하는
동안에는 데스크톱 UI의 프로필 편집기를 열거나 사용하지 않는다. 두 쓰기 경로를
섞어야 하면 먼저 사용자에게 어느 쪽을 기준으로 할지 확인한다.

스크립트는 사람이 읽을 요약과 기계가 읽을 JSON 결과를 함께 출력한다. 종료 코드
`0`은 dry-run 또는 적용이 오류 없이 끝났음을 뜻하며, 오류·롤백 실패·CLI 실패는
0이 아닌 코드다. `errors`는 입력 또는 적용을 고쳐야 하는 차단 조건이고,
`warnings`는 사람이 판단할 조건이다. 적용 실패 시 결과의 backup 경로와 rollback
결과를 확인하고, 추측으로 같은 적용을 반복하지 않는다.

## 최종 확인의 한계

오류 없는 reload는 데몬이 스키마를 받아들였다는 것까지만 보장한다. 데몬이 현재
프로필 배열을 들고 있는지 조회하는 CLI 명령은 없다. 최종 등록 확인은 Paseo
데스크톱 UI 목록 또는 에이전트의 MCP `list_profiles`로 한다. 등록 프로필로
에이전트를 실제 실행해 동작을 검증하는 일은 별도 `profile-check` 작업이다.

`--config`는 임시 사본을 대상으로 파일 파이프라인을 시험할 때 사용한다. 그러나
`paseo daemon reload`는 실제 데몬의 실제 설정을 다시 읽으므로, 임시 사본 적용은
end-to-end reload 검증이 아니다. 실제 `<paseo home>\config.json`에는 이 스킬을
검증하려고 `--apply`를 실행하지 않는다.
