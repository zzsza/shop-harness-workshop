# 이슈

팀에 쌓인 이슈 6장입니다.
한 장이 작업 하나이고, 파일 이름의 번호가 이슈 번호입니다.

| 번호 | 이슈 |
| --- | --- |
| 1 | [안전재고 알림](1.md) |
| 2 | [부분 환불](2.md) |
| 3 | [내 주문 목록 상태 필터](3.md) |
| 4 | [단골 고객 배송비 무료](4.md) |
| 5 | [무료배송 기준 5만 원](5.md) |
| 6 | [관리자 주문 일괄 상태 변경](6.md) |

각 이슈의 "주로 건드릴 곳"은 같은 파일을 건드리는 이슈를 동시에 맡기지 않으려고 적어 둔 것입니다.
이슈를 나눠 주는 쪽(`claude --bg` 세션을 띄우는 Skill, `npm run loop`)이 이 칸을 읽습니다.

`claude --bg -w <이름>`은 세션마다 `.claude/worktrees/<이름>`에 worktree를 만듭니다.
`npm run claude`로 연 세션 안에서 띄우면 같은 실습 설정 폴더(`~/.claude-workshop`)를 씁니다.
그래서 사람이 세션을 보고 붙고 지우는 명령도 `npm run claude -- agents`, `npm run claude -- attach <id>`, `npm run claude -- logs <id>`, `npm run claude -- rm <id>`로 합니다. 그냥 `claude`는 평소 계정(`~/.claude`)을 봐서 이 세션들이 보이지 않습니다.
`.claude/settings.json`의 `worktree.baseRef: "head"` 덕분에 원격 기본 브랜치(main)가 아니라 지금 커밋에서 땁니다. 그래서 세션에 필요한 Skill과 설정은 먼저 커밋합니다.

## 대체 루프: `npm run loop`

백그라운드 세션(`claude --bg`, `claude agents`)을 쓸 수 없을 때 같은 일을 합니다.
대기 이슈마다 레포 옆에 worktree(`<레포 폴더>-issue-<번호>`)를 만들고 그 안에서 `claude -p "/issue-to-pr docs/issues/<번호>.md" --permission-mode auto`를 돌립니다.
세션은 `npm run claude`와 같은 실습 설정 폴더(`~/.claude-workshop`)로 뜨고, 레포 바깥 폴더의 CLAUDE.md도 똑같이 읽지 않습니다.
`claude -p`의 기본 권한 모드는 파일 쓰기를 모두 거절하므로 `claude --bg`의 기본과 같은 auto로 띄웁니다. 배송비 규칙 파일처럼 `permissions.ask`에 든 곳은 그래도 사람 몫이라 "승인 필요"로 끝납니다.
동시에 2개까지 돌고, 같은 파일을 건드리는 이슈는 앞 이슈가 끝난 뒤 띄웁니다.

```bash
npm run loop -- --max-turns 40 --max-budget-usd 3 2 3 4 5 6    # 1번(안전재고)은 내 세션에서 /goal로 하므로 빼고
```

상한 둘(세션마다 턴 수, 달러)은 꼭 적습니다.
세션은 지금 커밋으로 만든 worktree에서 돌므로, `.claude/skills/issue-to-pr/SKILL.md`를 커밋하지 않았으면 커밋하라고 알리고 멈춥니다.
끝나면 이슈마다 결과(끝남, 승인 필요, 턴·비용 상한에서 멈춤), 마지막 말, 이어 갈 명령을 표로 보입니다.
질문에 답하거나 승인하려면 `npm run loop -- --resume <번호>`로 그 세션을 worktree에서 같은 계정·권한 모드로 엽니다. 답한 뒤 `/exit`로 나옵니다.
그 worktree를 처음 열면 폴더 신뢰 창이 뜨고 기본 선택이 "No, exit"입니다. "Yes, I trust this folder"를 고릅니다.
한 번 맡긴 이슈(`issue-<번호>` 브랜치가 있는 이슈)는 다시 돌리지 않습니다.
다시 맡기려면 남은 worktree와 브랜치를 지웁니다.

```bash
git worktree remove --force ../<레포 폴더>-issue-<번호>
git branch -D issue-<번호>
```

## 숨은 채점: `npm run judge`

PR을 머지한 뒤 `git pull`로 머지 결과를 받고 돌립니다.
정답 브랜치(`day2-c-answers`)의 숨은 테스트를 내 작업 트리에 대고 돌려 이슈별로 맞춰 봅니다.
숨은 테스트 파일은 잠깐 꺼냈다가 지우므로 작업 트리에 남지 않습니다.
fork를 "Copy the main branch only"로 만들어 정답 브랜치가 없으면, 그 이유와 받는 방법을 알려 주고 멈춥니다.
