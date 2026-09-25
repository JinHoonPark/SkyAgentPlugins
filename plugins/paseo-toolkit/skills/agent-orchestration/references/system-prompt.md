# 상시 프롬프트 옵션·실행·복구

대상 필드는 `daemon.appendSystemPrompt` 하나다. 파일 경로는 스크립트가 정한다. 다른 후보를
두지 않는다. 값은 덧붙이기만 하며 제거 경로는 없다. 기본이 dry-run이라 승인 전에 제시할 수
있다.

## 점검·적용

`--value`에 추가할 한 줄만 주고 실행한다. 그 줄이 이미 있으면 `alreadyPresent`가 참으로 오고 아무것도 하지 않는다. 그 사실을 알리고 끝낸다.

```text
python scripts/append_system_prompt.py --value "추가할 한 줄"
```

SKILL.md 8절의 명시 승인을 받은 뒤에만 같은 명령에 `--apply`를 붙인다. 백업·반영·reload·로그 재적재 확인과 실패 시 롤백은 스크립트가 한다.

## 복구

되돌릴 때는 `--rollback`에 백업 경로를 준다. `--apply`가 없으면 이것도 dry-run이다.

```text
python scripts/append_system_prompt.py --rollback "백업 경로" --apply
```
