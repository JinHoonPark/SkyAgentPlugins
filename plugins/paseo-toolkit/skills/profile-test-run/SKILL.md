---
name: profile-test-run
description: Paseo 에이전트 프로필이 의도대로 동작하는지 실제로 에이전트를 띄워 확인할 때 사용한다. "프로필 테스트해줘", "프로필 잘 도는지 확인해줘", "프로필대로 뜨는지 봐줘", "프로필 라우팅 검증해줘", "프로필 전체 한 번 돌려봐", "이 프로필 제대로 먹는지 봐줘" 같은 요청에 적용하고, profile-setup으로 프로필을 등록한 직후 "방금 만든 프로필 테스트해볼까요"에 사용자가 동의한 흐름도 이어받는다. 등록된 값이 config.json과 daemon에서 일치하는지, 실제로 뜬 에이전트의 model·mode·thinking·features가 프로필과 같은지, 각 프로필이 notes가 약속한 일을 해내는지를 세 축으로 나눠 판정하고 별도 심판 에이전트로 채점한다. 프로필을 설계·등록·조회·삭제하기만 하는 요청은 이 스킬이 아니라 profile-setup이 맡는다.
---

# Paseo 프로필 테스트 실행

프로필은 사람이 정한 시작 구성 묶음일 뿐이라, 등록했다고 그대로 뜬다는 보장이 없다.
이 스킬은 프로필로 에이전트를 **실제로 띄워** 세 가지를 각각 확인한다.

| 축 | 묻는 것 | 판정 방법 |
| --- | --- | --- |
| 1. 등록 | config.json에 쓴 값을 daemon이 그대로 로드했는가 | 결정론 — `scripts/check_routing.py registration` |
| 2. 라우팅 | 실제로 뜬 에이전트가 프로필 값과 같은가 | 결정론 — `scripts/check_routing.py routing` |
| 3. 품질 | 프로필이 자기 `notes`가 약속한 일을 해내는가 | 별도 심판 에이전트가 채점 |

**세 축을 섞지 않는 것이 이 스킬의 핵심이다.** 라우팅이 어긋난 채로 작업만 잘 나오면
품질 점수에 묻혀 원인을 놓친다. 반대로 라우팅이 맞는데 결과가 나쁘면 그건 프로필
구성이 아니라 `notes`와 모델 선택의 문제다. 원인이 다르면 고칠 곳도 다르다.

## 순서를 지켜야 하는 이유

```
활동 회수(get_agent_activity)  →  심판 채점  →  그다음에 정리(archive_agent)
```

**정리를 먼저 하면 채점 재료가 사라진다.** `archive_agent`는 실행 중이면 중단시키고
목록에서 치운다. 채점은 그 에이전트가 무엇을 했는지를 재료로 삼으므로, 활동을
회수하기 전에 정리하면 축3을 아예 판정할 수 없다. 순서를 뒤집지 마라.

## 절차

### 1. 대상 고르기

현재 프로필 목록을 보여준다. 목록 출력은 `profile-setup`의 스크립트가 단일 원천이다.
서식을 새로 그리지 말고 그 출력을 그대로 보여준다.

```bash
# 스킬 디렉터리 기준 상대 경로다.
python ../profile-setup/scripts/manage_profiles.py --list
```

호출 전에 `--help`로 실제 인자를 확인한다. 그 스크립트는 이 스킬과 따로 개정되므로
인자가 바뀌어 있을 수 있다. `--list --json`은 기계용이고, 사람에게 보여줄 때는 `--list`가
압축형이라 고르기 좋다.

이 명령은 config.json 위치를 `paseo status`에서 얻으므로 `paseo` CLI가 PATH에 없으면
「PATH에서 paseo CLI를 찾지 못했습니다」로 실패한다. 그때는 PATH에 paseo를 올리거나
`--config`로 config.json 경로를 직접 주도록 사용자에게 알린다. 경로를 추측해 하드코딩하지 마라.

그다음 **전체 테스트인지 선별 테스트인지 묻는다.** 선별이면 어느 프로필인지 받는다.
목록에 없는 id를 말하면 그대로 진행하지 말고 다시 입력받는다 — 아래 `init`이 없는 id를
거부하고 사용 가능한 id를 보여주므로 그 출력을 그대로 쓰면 된다.

```bash
python ../profile-setup/scripts/manage_profiles.py --list --json > disk.json
# daemon.json 은 MCP list_profiles 결과를 저장한 파일이다.
python scripts/testrun_ledger.py init --daemon daemon.json --disk disk.json --state state.json
python scripts/testrun_ledger.py init --daemon daemon.json --disk disk.json --state state.json --only explore,review
```

**`--disk`와 `--daemon`을 둘 다 준다.** 큐를 daemon 기준으로만 만들면 config.json에만 있는
프로필이 ledger에 없어서, 등록 실패인데도 보고에서 통째로 빠진다. 실패가 조용히
사라지는 것이 가장 나쁘다. `init`은 두 쪽의 합집합으로 큐를 만들고 한쪽에만 있는
프로필을 그 자리에서 등록 실패로 확정한다.

`--disk`를 생략하면 축1을 대조할 수 없어 등록은 **미판정**으로 남는다. 미판정은 실패가
아니다. `paseo` CLI가 없어 디스크 쪽을 못 읽을 때만 그렇게 진행한다.

**한쪽에만 등록된 프로필은 실행 대상에서 빠진다.** daemon에 없으면 띄울 프로필 값을 읽을
수 없고, 디스크에 없으면 테스트해도 설정에 남지 않기 때문이다. 이런 프로필은 등록
검증 실패로 보고하고 축2·축3은 「판정 불가」로 남기며, 실행 자리를 차지하지 않는다.
보고에는 그대로 남으므로 `대상 N개 · 보고 N개`는 어긋나지 않는다.

상태 파일은 저장소가 아니라 임시 디렉터리에 둔다. 테스트 부산물을 저장소에 커밋하지 않는다.

### 2. 축1 — 등록 검증

디스크에 쓴 값과 daemon이 로드한 값을 대조한다. 둘은 다를 수 있다. config.json을
고쳤는데 reload가 안 됐으면 daemon은 옛 값으로 계속 뜬다. 이 축이 그걸 잡는다.

```bash
python scripts/check_routing.py registration --disk disk.json --daemon daemon.json --json > reg.json
```

이 축은 **프로필의 모든 필드**를 본다 — `id`·`name`·`provider`·`model`·`modeId`·
`thinkingOptionId`·`notes`·`icon`·`color`·`featureValues`, 그리고 스키마가 늘어나 생긴
키까지. 라우팅 필드만 보면 `notes`가 어긋나도 통과하는데, **`notes`는 팀장 라우팅의
유일한 근거**라 그게 잘못 로드되면 프로필은 값이 다 맞아도 제 역할을 못 한다.

축2는 실제로 뜬 에이전트와 비교하는 것이라 런타임이 갖는 값만 본다. 두 축의 비교
범위가 다른 것은 의도된 것이니 섞지 마라.

종료 코드는 0이 일치, 1이 불일치, 2가 입력·실행 오류다. 2가 나오면 판정이 아니라
스크립트가 못 돈 것이니 결과를 PASS로 기록하지 마라.

### 3. 프로브 지시 만들기

각 프로필에 줄 작업을 **그 프로필의 `notes`에서 뽑는다.** `notes`가 라우팅의 유일한
근거이므로, 테스트도 `notes`가 약속한 범위 안의 작은 작업이어야 한다. 프로필마다 맡는
일이 다르니 하나의 프로브를 전체에 돌려 쓸 수 없다.

프로브는 **읽기 전용으로 만든다.** 테스트 에이전트는 사용자의 실제 작업 디렉터리에서
뜨고 `full-access` 모드인 프로필도 있다. 파일을 고치는 프로브를 주면 테스트가 저장소를
바꾼다. 지시문에 파일을 수정하지 말라고 명시하고, 결과는 말로만 답하게 한다.

`notes`에 배제 문구가 있으면(예: 리뷰 프로필의 「수정은 하지 않음」) 그 배제를 건드릴
여지가 있는 프로브가 좋다. 경계를 지키는지가 그때 드러난다.

### 4. 띄우기 — 동시 실행 5개까지

**동시 실행은 최대 5개다.** 5개만 테스트한다는 뜻이 아니라 한 번에 5개까지만 돈다는
뜻이다. 프로필이 11개면 5개를 돌리다가 하나가 끝날 때마다 다음 하나를 채워 결국 11개를
전부 테스트한다. 사용자에게 이 상한을 알리고 시작한다.

5는 옵션으로 넘길 수 없다. `--max-concurrent`에 더 큰 값을 주면 5로 제한되고 경고가
나온다. 더 작은 값은 부하를 줄이려는 선택이므로 그대로 쓴다.

Paseo에는 큐 전용 플래그가 없다. `paseo wait`와 `paseo run --wait-timeout`은 한 건씩
기다릴 뿐이다. 그래서 자리 계산은 ledger가 들고 있고, 띄우는 것은 MCP가 한다.

```bash
python scripts/testrun_ledger.py next --state state.json     # 지금 띄울 프로필을 상한 안에서 알려준다
```

`next`가 알려준 프로필만 띄운다. 다 띄웠으면 완료 알림이 올 때까지 기다렸다가 다시
`next`를 부른다. 실행 중인 에이전트에 프롬프트를 더 보내지 않는다.

**MCP `create_agent`로 띄운다. CLI가 아니다.** 프로필의 `featureValues`는 CLI
`paseo run`·`paseo agent update`에 해당 플래그가 없어서 CLI로는 전달도 검증도 되지
않는다. 프로필 값은 이름이 바뀌어 들어가므로 그대로 옮겨 담는다.

| 프로필 필드 | `create_agent` 인자 |
| --- | --- |
| `provider` + `model` | `provider`에 `"provider/model"`로 합침 |
| `modeId` | `settings.modeId` |
| `thinkingOptionId` | `settings.thinkingOptionId` |
| `featureValues` | `settings.features` |

`title`은 `테스트: {프로필 id}`로, `labels`는 `{"profile": <id>, "task": "profile-test-run"}`로
남긴다. 나중에 목록에서 테스트용 에이전트를 골라내는 근거가 된다.
띄운 뒤 에이전트 id를 ledger에 넣는다.

```bash
python scripts/testrun_ledger.py launched --state state.json --profile-id explore --agent-id <agent id>
```

### 5. 축2 — 라우팅 검증

각 에이전트가 뜨면 MCP `get_agent_status`로 실제 값을 읽어 프로필과 대조한다.
`list_agents`는 `modeId`와 `features`를 주지 않으므로 이 축에 쓸 수 없다.

```bash
# get_agent_status 결과를 status.json에 저장한 뒤
python scripts/check_routing.py routing --daemon daemon.json --status status.json \
  --profile-id explore --json > routing_explore.json
```

스크립트가 대조하는 것은 `provider`, `model`, `modeId`, `thinkingOptionId`,
그리고 프로필이 선언한 `features`다. 모드는 런타임이 스스로 보고하는
`runtimeInfo.modeId`를 우선해서 본다. `thinkingOptionId`와 `effectiveThinkingOptionId`가
다르면 그것도 따로 잡는다 — 요청은 반영됐는데 실효값이 다른 경우라 원인이 다르다.

여기서 실제 불일치가 잡힌다. codex에 `auto`를 요청했는데 `auto-review`로 뜨는 것이
관측된 적이 있다. **알려진 현상이라는 이유로 PASS로 넘기지 마라.** 그대로 불일치로
보고해야 사용자가 프로필을 고칠지 Paseo 쪽 문제로 볼지 판단할 수 있다.

프로필이 `featureValues`를 선언하지 않았으면 그 항목은 판정하지 않고 참고로만 남긴다.
선언하지 않은 값은 provider 기본값이라 불일치가 아니다.

### 6. 축3 — 심판 채점

작업이 끝나면 MCP `get_agent_activity`로 그 에이전트의 활동을 회수한다.

**테스트 워커의 자기 보고로 채점하지 마라.** 산출물을 만든 에이전트가 스스로 수용
판정을 하면 자기 전제를 물려받아 같은 오류를 통과시킨다. 채점 재료는 워커가 쓴
요약이 아니라 플랫폼이 남긴 활동 기록이다.

채점은 **별도 심판 에이전트**가 한다. 심판에게는 프로필의 `notes`와 프로브 지시와
활동 기록을 직접 주고, 테스트 워커의 결과 보고와 축1·축2 판정은 주지 않는다.

브리핑을 손으로 조립하지 말고 스크립트가 만들게 한다. 호출자가 문장을 짜 넣을수록
워커의 자기 보고가 섞일 자리가 생기기 때문이다.

```bash
# 활동 원문과 프로브 지시를 파일로 저장한 뒤
python scripts/testrun_ledger.py brief --state state.json --profile-id explore \
  --activity activity_explore.json --agent-id <agent id> --probe probe_explore.txt \
  --result-out <채점 JSON을 저장할 경로> --out brief_explore.txt
```

나온 파일을 **그대로** 심판의 `initialPrompt`로 쓴다. 프로필의 `notes`, 프로브 지시,
활동 원문, 루브릭과 출력 규격 전문, 채점 JSON을 저장할 경로가 모두 그 안에 들어 있어
심판이 파일을 열지 않아도 채점할 수 있다. 심판은 다른 세션에서 뜨므로 이 저장소의
상대 경로가 해석되지 않는다는 점이 중요하다 — 그래서 참조가 아니라 전문을 싣는다.

루브릭과 출력 규격의 원천은 [`references/judge-brief.md`](references/judge-brief.md)이고
`brief`가 그 파일에서 읽어 프롬프트에 붙인다. 기준을 고칠 때는 그 문서만 고치면 된다.
**사람이 기준을 확인할 때 읽고**, 프롬프트에 넣으려고 옮겨 적지 마라.

`--result-out`에 줄 경로는 호출자가 정한다. 사용자 홈이나 드라이브 문자를 하드코딩하지
말고 상태 파일과 같은 임시 디렉터리에 둔다.

**무엇이 강제되고 무엇이 아닌지 분명히 해 둔다.** 스크립트가 막는 것은 출처 표식이
빠졌거나 ledger에 `launched`로 기록된 id와 다른 경우, 활동 파일이 비어 있는 경우,
프로브 지시가 없거나 빈 경우, 그리고 브리핑 문구가 임의로 조립되는 경우다. 활동이 너무
짧거나, 구조(JSON·도구 호출) 없이 줄글이거나, 자기 보고에 흔한 표현이 섞여 있으면
경고한다.

**막을 수 없는 것은 활동 파일의 내용이다.** 잘 쓰인 자기 보고는 위 검사를 전부
통과한다. 경고는 값싼 신호를 잡을 뿐 판별이 아니므로, 활동은 `get_agent_activity`에서
회수한 그대로 저장하고 손대지 마라. 이 한 걸음이 절차 신뢰로 남는다.

```bash
python scripts/testrun_ledger.py record --state state.json --profile-id explore \
  --registration-file reg.json --routing-file routing_explore.json \
  --quality-file judge_explore.json --done
```

`record`는 채점 JSON의 점수 범위와 필수 필드를 검사해 규격 밖의 값을 막는다. 형식이
어긋나면 기록하지 않고 무엇이 잘못됐는지 알려준다.

`--done`이 그 프로필의 자리를 비우므로, 기록한 뒤 `next`를 부르면 다음 프로필이 나온다.

### 6-1. 판정하지 못했을 때

에이전트가 중단됐거나 활동을 회수하지 못하면 그 프로필은 채점할 수 없다. 그대로 두면
`running` 자리가 영영 비지 않아 남은 프로필이 시작되지 못한다. 사유를 적어 종료로
기록한다.

```bash
python scripts/testrun_ledger.py record --state state.json --profile-id explore \
  --unresolved "에이전트가 중단돼 활동을 회수하지 못했다"
```

자리가 돌아오고, 그 프로필은 보고에 `N/A`와 「판정 불가」로 남는다. 실패한 것을 조용히
빼지 않는 것이 중요하다 — 사용자는 전체를 요청했으므로 빠진 것이 있으면 알아야 한다.

### 6-2. 맥락이 잘린 뒤 이어서 진행하기

`record`는 축(등록·라우팅·품질)마다 판정을 한 번만 받는다. 이미 기록된 축을 다시
지정하면 값이 같든 다르든 종료 코드 2로 거부한다 — 의도된 동작이며, 이전 판정이
말없이 덮이는 것을 막는다. 묶음 명령은 원자적이라 이 거부에 걸리면 함께 준 `--done`을
포함해 아무것도 반영되지 않는다.

맥락이 잘린 뒤 이어서 진행할 때는 위 예시를 그대로 다시 실행하지 말고, 먼저
`report --state state.json`으로 그 프로필의 등록·라우팅·품질 칸부터 확인한다. 거부
메시지도 어느 축에 무슨 판정이 있는지 그대로 알려준다. 이미 판정이 있는 축의
`--registration-file`/`--routing-file`/`--quality-file`은 빼고, 아직 `—`인 축과 `--done`만
다시 record에 넘긴다.

### 7. 정리

채점까지 끝난 뒤에만 정리한다. 정리는 MCP **`archive_agent`**로 한다.

- `cancel_agent`는 현재 run만 멈추고 에이전트는 남으므로 정리 명령이 아니다.
- `kill_agent`와 CLI `paseo delete`는 되돌릴 수 없다.
- `archive_agent`는 멈춘 뒤 목록에서 치우면서도 기록을 남긴다. 사용자가 나중에 점수에
  이의를 제기하면 `list_agents(includeArchived: true)`로 다시 찾을 수 있다. 채점 근거를
  지우지 않는 유일한 선택지라 이걸 쓴다.

정리 대상은 이 테스트가 띄운 에이전트뿐이다. `labels`의 `task: profile-test-run`으로
확인하고 지운다. 사용자의 다른 작업 에이전트를 건드리지 마라.

### 8. 보고

```bash
python scripts/testrun_ledger.py report --state state.json
```

## 보고 form

`report`가 출력하는 형식이다. 손으로 다시 그리지 말고 이 출력을 그대로 쓴다. 두 표 모두
한글이 들어가는 열을 뒤에 두는데, 한글은 터미널에서 두 칸 폭이고 폰트마다 실제 폭이 달라
그 뒤에 열을 더 두면 정렬이 깨지기 때문이다.

```text
━━━━━━━━━━━━━━━━
📊 프로필 테스트 결과 — 프로필 3개 중 결정론 2축 통과 0개
━━━━━━━━━━━━━━━━

등록  라우팅  품질   ID            프로필
────  ──────  ─────  ────────────  ────────────
PASS  FAIL    4.5/5  explore       🔍 탐색
FAIL  N/A     N/A    ghost-daemon  🐛 유령 데몬
FAIL  PASS    N/A    run-command   ⌨️ 명령 실행

━━━━━━━━━━━━━━━━
⚠️ 등록 불일치 — config.json과 daemon이 다르다
━━━━━━━━━━━━━━━━
  ghost-daemon  daemon에만 있고 config.json에 없다. 디스크 반영이 빠졌거나 다른 config를 읽고 있다.
  run-command   notes: 기대 'NOTES가 디스크에서만 다르다' → 실제 '실행할 명령이 정해진 작업에 사용'

━━━━━━━━━━━━━━━━
⚠️ 라우팅 불일치 — 프로필대로 뜨지 않았다
━━━━━━━━━━━━━━━━
  explore  modeId: 기대 'auto' → 실제 'auto-review'

━━━━━━━━━━━━━━━━
📝 작업 품질 — 각 프로필의 notes 기준
━━━━━━━━━━━━━━━━

🔍 탐색 (explore) — 4.5/5 · 이행 5/5 · 경계 4/5

  판정  항목                              근거
  ────  ────────────────────────────────  ─────────────────────────────────────
  PASS  찾기를 넘어 코드를 고치지 않았다  편집 도구 호출 없음
  FAIL  웹 자료 인용에 출처를 표기했다    URL 3건 중 0건만 출처가 붙어 있고
                                          나머지는 본문에 그대로 인용해 어디서
                                          왔는지 활동 기록으로는 되짚을 수 없다

  총평: 탐색 notes의 범위를 지켰다.

━━━━━━━━━━━━━━━━
🚫 판정 불가 — 테스트를 끝내지 못했다
━━━━━━━━━━━━━━━━
  ghost-daemon  한쪽에만 등록돼 있어 에이전트를 띄우지 못했다 (daemon-only). 등록을 맞춘 뒤 다시 테스트한다.
  run-command   에이전트가 중단돼 활동을 회수하지 못했다

대상 3개 · 보고 3개
```

요약표는 세 축을 각각 다른 열에 두어 한 축의 실패가 다른 축에 묻히지 않게 한다. 품질
점수에 `/5`를 붙이는 것은 점수만으로는 몇 점 만점인지 알 수 없기 때문이다. 불일치는 표
아래에 축별로 모아 무엇이 어떻게 어긋났는지 값까지 적는다.

빈 칸 기호 둘은 뜻이 다르다. `—`는 **아직 판정하지 않았다**는 뜻이고 통과가 아니다.
`N/A`는 **판정할 수 없었다**는 뜻이며 아래 「판정 불가」 블록에 사유가 함께 남는다.
맨 끝의 `대상 N개 · 보고 N개`는 큐에 넣은 수와 보고된 수가 같은지 확인하는 줄이다.
두 수가 다르면 어딘가에서 프로필이 빠진 것이므로 그대로 보고하지 마라.

품질 상세는 프로필마다 머리줄(이모지·name·id·총점·차원별 점수) 하나와 `판정 / 항목 / 근거`
표로 낸다. **`판정` 열이 맨 앞의 ASCII**라 실패가 왼쪽 끝에서 바로 보인다. 근거가 열 폭을
넘치면 잘리지 않고 다음 줄로 흘러 같은 열 위치에 이어진다 — 판정의 근거를 잘라내면
점수를 되짚을 수 없기 때문이다.

프로필 이름 앞 이모지는 프로필의 `icon` 필드에서 온다. 매핑은
`../profile-setup/scripts/manage_profiles.py`의 `ICON_EMOJI`가 원본이고 렌더러가 그 파일에서
직접 읽으므로, 같은 프로필이 두 스킬에서 다른 이모지로 보이지 않는다. `icon`이 없거나
매핑에 없으면 기본 이모지(`🔹`)로 채운다. 비워 두면 정렬이 어긋난다.

보고를 사용자에게 낼 때 세 축의 의미를 한 줄씩 덧붙인다. `등록`과 `라우팅`이 무엇을
구분하는지 모르면 어느 쪽을 고쳐야 할지 판단할 수 없다.

## 반복 횟수

**기본은 프로필당 1회다.** 프로필이 11개면 11회고, 3회씩 돌리면 33개 세션이라
토큰과 시간이 몇 배로 든다. 결정론 두 축은 한 번만 봐도 결론이 같고, 반복이 의미
있는 것은 품질 축뿐이다.

품질 점수가 애매하거나 사용자가 편차를 보고 싶어 하면 그때 같은 프로필을 여러 번
돌린다. 이 트레이드오프를 사용자에게 알리고 정하게 한다.

## 하지 않는 것

프로필을 설계·등록·수정·삭제하는 것은 `profile-setup`이 맡는다. 테스트에서 불일치가
나와도 이 스킬이 config.json을 고치지 않는다. 무엇이 어긋났는지 보고하고, 고치는 것은
사용자 승인 뒤 `profile-setup`으로 넘긴다.
