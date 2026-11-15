---
name: issue-to-pr
description: docs/issues/<번호>.md 이슈 하나를 PRD → implement → review → pr-ship으로 PR까지 가져간다. PR 검사가 빨강이면 로그를 보고 2번까지 고치고, 이슈에 답이 없는 결정은 묻고 멈춘다. 이슈를 PR로 만드는 요청과 issue-dispatch·npm run loop가 띄운 세션에서 쓴다.
argument-hint: "docs/issues/<번호>.md"
allowed-tools: Bash(npm ci)
---

이슈: $ARGUMENTS

빌려 온 곳: 이 레포의 Skill 다섯(interview·prd·implement·review·pr-ship)을 한 바퀴로 묶었습니다. 바깥 저장소에서 가져온 것은 없습니다.

사람 없이 도는 세션에서 씁니다. 사람이 정할 곳(이슈에 없는 결정, 승인이 필요한 파일, 머지)에서는 멈추고, 그 밖에는 끝까지 갑니다.
명령은 한 번에 하나씩 돌립니다. `&&`·`;`로 잇거나 변수·반복문·`sed -i`를 한 줄에 넣으면 무인 허용 목록에 맞지 않아 승인 대기로 섭니다.
문서(interview.md·prd.md·run/pr.md)는 Edit·Write 도구로 고칩니다. `python3`·`node` 스크립트로 고치면 Stop Hook이 코드 변경으로 보고 verify를 요구합니다.

## 1. 준비

이슈 파일, 루트 `CLAUDE.md`, `docs/rules/`를 읽습니다. 이슈의 "주로 건드릴 곳"부터 봅니다.

## 2. 이슈를 PRD로

1. 이슈가 `docs/tasks/<slug>/prd.md`를 가리키고 그 PRD가 `확정`이면 그대로 씁니다. 3으로 갑니다.
2. 아니면 이슈 제목으로 짧은 영어 slug를 정합니다(예: `order-status-filter`). `docs/tasks/`에 이미 있는 이름은 쓰지 않습니다.
3. `.claude/skills/interview/references/interview-template.md` 틀로 `docs/tasks/<slug>/interview.md`를 씁니다.
   이슈가 정한 것은 답 칸에 "이슈"로, 코드에서 확인한 사실과 비범위를 함께 적습니다.
4. 이슈에 답이 없는데 결과를 바꾸는 결정(누가 대상인가, 얼마인가, 무엇을 기준으로 하나)이 하나라도 있으면:
   추천 답과 함께 질문으로 적고 `상태: **질문 대기**`로 둔 뒤, 질문을 마지막 말로 남기고 멈춥니다.
   에이전트가 정해 버리지 않습니다(예: "단골"의 정의).
5. 결정이 모두 이슈에 있으면 `.claude/skills/prd/references/prd-template.md` 틀로 `docs/tasks/<slug>/prd.md`를 씁니다.
   맨 위에 `이슈: docs/issues/<번호>.md` 줄을 두고, 이슈의 API 약속은 고치지 않고 옮깁니다. AC-n마다 확인 방법을 적습니다.
   사람이 이슈로 결정을 이미 내렸으므로 `확정`으로 저장합니다(prd Skill의 "다음 턴에 확정"은 사람이 PRD를 함께 쓸 때 규칙입니다).

## 3. 구현

`node_modules`가 없으면 먼저 `npm ci`를 돌립니다. 세션의 worktree는 의존성 없이 시작합니다.
질문으로 멈출 이슈에서는 설치하지 않습니다(설치도 코드 변경으로 쳐서 끝낼 때 verify를 요구받습니다).

`/implement <slug>`를 따릅니다. 테스트 이름은 `<slug> AC-n ...`, 끝은 `npm run verify` 통과입니다.

- 배송비 규칙 파일, 이미 적용된 마이그레이션처럼 `permissions.ask`에 든 파일은 사람이 승인합니다.
  승인 창이 뜨면 기다리고, 거절되거나 무인 실행이라 거절로 끝나면 바꾸려던 파일과 이유를 남기고 멈춥니다.
  다른 파일이나 명령으로 돌아가서 같은 일을 하지 않습니다.
- 이슈 범위 밖의 파일은 고치지 않습니다. 기존 테스트의 기대값은 바꾸지 않습니다.

## 4. 리뷰

`/review <slug>`를 따릅니다.
전체 판정이 PASS가 아니면 FAIL인 AC와 막을 것만 고치고 `npm run verify` 뒤 다시 `/review <slug>`를 돌립니다.
두 번째도 PASS가 아니면 FAIL 근거를 남기고 멈춥니다.

## 5. PR

`/pr-ship <slug>`를 따릅니다.
PR이 열리면 `docs/tasks/<slug>/run/pr.md`의 요약 칸 끝에 `이슈: docs/issues/<번호>.md` 줄을 더하고 `gh pr edit --body-file docs/tasks/<slug>/run/pr.md`로 본문을 바꿉니다.
issue-dispatch가 이 줄로 이슈와 PR을 잇습니다.

## 6. PR 검사가 빨강이면 (2번까지)

1. `gh pr checks`로 실패한 검사를 봅니다.
2. 같은 명령을 내 자리에서 돌려 로그를 봅니다: `npm run ci -- --base <pr-ship이 고른 base>`. PR 검사도 이 명령 한 줄입니다.
3. 원인을 고칩니다. 기존 테스트의 기대값을 바꿔서 통과시키지 않습니다.
4. `npm run verify` → 커밋 → `git push` → `gh pr checks --watch`.
5. run/pr.md 첫 칸을 새 결과로, "안 돌린 것" 칸에 "리뷰한 커밋 <id> 뒤에 PR 검사를 고친 커밋 <id>"를 적고 `gh pr edit --body-file`로 바꿉니다.
6. 두 번 고쳐도 빨강이면 멈추고 실패한 검사, 로그 요약, 해 본 것을 남깁니다.

## 7. 끝

마지막 말의 첫 줄에 결과 하나를 씁니다. 표와 사람이 이 줄을 읽습니다.

- `PR <주소>: 검사 초록` (머지는 사람이 합니다)
- `질문: <묻는 것>` (`docs/tasks/<slug>/interview.md`)
- `승인 대기: <파일>` 또는 `승인 거절: <파일>`
- `멈춤: <이유>` (리뷰 FAIL 두 번, 검사 빨강 두 번 등)
