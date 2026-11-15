---
name: issue-dispatch
description: claude agents --json으로 도는 이슈 세션을 보고, PR이 머지된 이슈 세션은 claude rm으로 지우고, 도는 세션이 2개 미만이면 대기 이슈 하나를 claude --bg 세션으로 띄운다. 같은 파일을 건드리는 이슈는 같이 띄우지 않는다. 한 바퀴만 하고 끝나며 /loop로 되풀이한다.
argument-hint: "[이슈 번호...]"
allowed-tools: Bash(claude agents --json), Bash(claude agents --json --all), Bash(claude stop *), Bash(claude rm *), Bash(claude --bg *), Bash(gh pr list *)
---

고른 이슈: $ARGUMENTS (비었으면 `docs/issues/`의 번호 붙은 이슈 전부)

빌려 온 곳: 이 레포의 `npm run loop`(동시에 2개, "주로 건드릴 곳"이 겹치면 뒤로)를 `claude --bg` 세션으로 옮겼습니다. 바깥 저장소에서 가져온 것은 없습니다.

한 번 부르면 아래를 한 바퀴만 하고 끝납니다. 띄운 세션을 기다리지 않습니다.
되풀이는 `/loop 2m /issue-dispatch 2 3 4 5 6`처럼 합니다(1번은 내 세션에서 `/goal`로 합니다).
명령은 한 번에 하나씩 돌립니다.
`claude agents --json` 출력은 그대로 읽습니다. `python3 -c`·`node -e` 같은 스크립트로 거르지 않습니다. 스크립트는 파일을 쓸 수 있어 코드를 바꾼 것으로 쳐서 끝낼 때 `npm run verify`를 요구받습니다(stop-verify Hook).

## 1. 지금 상태 읽기

1. `claude agents --json --all`: 이름이 `issue-<번호>`인 세션만 이슈 세션입니다.
   쓰는 칸: `id`, `name`, `state`(`working` 일하는 중, `blocked` 사람을 기다림: 승인 창이면 `waitingFor`가 `permission prompt`, 질문을 남기고 멈춘 세션도 `blocked`, `done` 이번 차례를 끝냄), `cwd`(그 세션의 worktree).
2. `gh pr list --state all --limit 100 --json number,state,url,body`: 본문에 `이슈: docs/issues/<번호>.md`가 있는 PR이 그 이슈의 PR입니다.
   gh가 없거나 로그인하지 않았으면 PR 없이 진행하고, 머지된 세션은 사람이 `npm run claude -- rm <id>`로 지운다고 보고에 적습니다.
3. 고른 이슈마다 `docs/issues/<번호>.md`의 "주로 건드릴 곳" 목록을 읽습니다. 폴더 경로는 그 아래 파일과 겹칩니다. 칸이 없는 이슈는 모두와 겹친다고 봅니다.

## 2. 머지된 이슈 세션 지우기

PR이 MERGED인 이슈 세션마다 `claude stop <id>` 뒤 `claude rm <id>`를 돌립니다. 세션의 worktree와 그 브랜치도 같이 지워집니다(git 제외인 `run/`이 있어도 지웁니다).
rm이 지우지 않고 남기면 그 메시지를 보고에 옮기고 넘어갑니다. 세션 프로세스가 아직 끝나지 않았다는 이유면 다음 바퀴에 다시 rm 합니다. 커밋하지 않은 변경이 있다는 이유면 사람에게 넘깁니다. `--discard-unpushed`나 `--force-remove-worktree`는 쓰지 않습니다. 버릴지는 사람이 정합니다.

## 3. 하나 띄우기

- 도는 세션: 남은 이슈 세션 중 `state`가 `working`인 것. 2개 이상이면 띄우지 않습니다. `blocked`(사람을 기다림)와 `done`은 자리를 차지하지 않습니다.
- 대기 이슈: 고른 이슈 중 이슈 세션도 PR도 없는 것. 번호 순으로 봅니다.
- 남은 이슈 세션(state와 상관없이, PR이 아직 머지되지 않은 것)의 이슈와 "주로 건드릴 곳"이 겹치는 대기 이슈는 건너뜁니다. 그 세션의 PR이 머지되면 다음 바퀴에 뜹니다.
- 띄울 이슈가 정해지면 하나만 띄웁니다.

  ```bash
  claude --bg -w issue-<번호> -n issue-<번호> "/issue-to-pr docs/issues/<번호>.md"
  ```

  `-w`로 세션마다 `.claude/worktrees/issue-<번호>` worktree를 따로 씁니다. 없으면 세션이 지금 폴더에서 돌아 서로의 브랜치를 바꿉니다.
  worktree는 지금 커밋에서 따집니다(`.claude/settings.json`의 `worktree.baseRef: "head"`). issue-to-pr Skill이 커밋되어 있지 않으면 띄우지 않고 커밋하라고 알립니다.

## 4. 보고

이슈 세션과 대기 이슈를 한 표로 보입니다: 이슈 / 세션 id / state(`waitingFor`) / PR(번호, 상태) / 사람이 할 일.
사람이 할 일의 명령은 `npm run claude -- <명령>`으로 적습니다. 세션들이 실습 설정 폴더에 있어서 그냥 `claude`로는 보이지 않습니다. 이 세션 안에서는 ←(왼쪽 화살표)로 세션 목록을 열어도 됩니다.

- `blocked`: `npm run claude -- attach <id>`로 승인하거나(승인 창) 답합니다(질문).
- `done`이고 PR이 없음: 멈춘 이유가 남아 있습니다. `npm run claude -- logs <id>`로 보고 `npm run claude -- attach <id>`로 이어 가거나 `npm run claude -- rm <id>`로 버립니다.
- PR이 열려 있음: 리뷰하고 머지합니다(항상 사람).

대기 이슈도 없고 `working`이나 `blocked`인 이슈 세션도 없으면 "이슈를 모두 맡겼고 도는 세션이 없습니다. 끝났습니다."라고 말하고, `/loop`로 돌고 있으면 멈춰도 된다고 알립니다.
