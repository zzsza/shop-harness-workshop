---
name: pr-ship
description: run/review.md로 PR 본문(PR 검사·AC 표·위험·안 돌린 것·요약)을 docs/tasks/<slug>/run/pr.md에 채우고, FAIL이 없으면 push한 뒤 이 작업이 시작한 day2 브랜치를 base로 PR을 연다. PR 만들기, 올리기 요청에 쓴다.
argument-hint: "<slug>"
---

작업: $ARGUMENTS

빌려 온 곳: 이 레포의 `.github/pull_request_template.md`(사람이 판단하는 순서). 바깥 저장소에서 가져온 것은 없습니다.

PR 본문은 사람이 위에서부터 읽다가 막히면 멈추는 순서로 씁니다. 판정은 review.md의 것을 그대로 옮기고 새로 만들지 않습니다.

## 1. 열어도 되는지

1. `docs/tasks/<slug>/run/review.md`, `docs/tasks/<slug>/prd.md`, `.github/pull_request_template.md`를 읽습니다.
   review.md가 없으면 멈추고 `/review <slug>`를 먼저 돌리라고 알립니다.
2. review.md의 전체 판정이 **PASS**가 아니거나 AC 표·막을 것에 FAIL이 하나라도 있으면 PR을 열지 않습니다.
   FAIL인 AC와 막을 것을 근거와 함께 그대로 옮겨 이유를 말하고 멈춥니다. BLOCKED도 같습니다.
3. 지금 브랜치가 `feat/<slug>`가 아니면 멈춥니다. 시작 브랜치(day2-a 등)나 main을 그대로 올리지 않습니다.
4. PR의 base는 `feat/<slug>`가 갈라져 나온 시작 브랜치입니다. 가장 가까운 시작 태그 이름에서 `start/`를 뗍니다.

   ```bash
   git describe --tags --abbrev=0 --match 'start/day2-*' HEAD
   ```

   `start/day2-a`면 base는 `day2-a`, `start/day2-b`면 `day2-b`입니다.
   태그가 안 나오면(태그를 안 받은 clone) 짐작하지 말고 어느 브랜치에서 시작했는지 묻고 멈춥니다.
5. 고른 base가 맞는지 한 번 더 봅니다. 시작 브랜치마다 HEAD와 갈라진 자리(merge-base)를 구해 비교합니다.

   ```bash
   git branch -r --list 'origin/day2-?'        # 시작 브랜치 목록
   git merge-base HEAD origin/<base>           # base와 갈라진 자리
   git merge-base HEAD origin/<다른 시작 브랜치> # 목록의 나머지마다
   git merge-base --is-ancestor <base 자리> <다른 자리>  # 0이면 다른 자리가 base 자리와 같거나 그 뒤
   ```

   - base와 갈라진 자리가 없으면(merge-base가 아무것도 안 냄) 묻고 멈춥니다.
   - 다른 시작 브랜치의 갈라진 자리가 base 자리와 다르면서 그 뒤(base 자리가 조상)이면 더 나중의 시작 브랜치에서 딴 것입니다(예: 시작 태그를 안 받은 day2-c clone). 묻고 멈춥니다.
   - 그 밖에는 base가 맞습니다. 브랜치 끝이 아니라 갈라진 자리를 보므로, feat를 딴 뒤 다른 PR이 머지돼 시작 브랜치가 앞으로 가도 그대로 통과합니다.
   - origin에 시작 브랜치가 없으면 로컬 브랜치(`git branch --list 'day2-?'`)로 같은 것을 봅니다.

## 2. 본문 채우기

템플릿의 다섯 칸을 순서 그대로 `docs/tasks/<slug>/run/pr.md`에 씁니다(이전 것은 덮어씁니다).

1. **PR 검사**: 템플릿의 체크 줄을 그대로 두고, 그 아래에 review.md의 verify 결과를 적습니다. PR 검사 결과는 PR을 연 뒤 GitHub에서 봅니다.
2. **완료 기준**: PRD 경로와 review.md의 검증한 커밋 id, AC마다 한 줄(AC / 확인 방법 / 결과 / 증거). 증거는 테스트 이름이나 화면 사진 경로입니다. 빈 칸을 두지 않습니다.
3. **위험**: review.md의 바뀐 파일 중 돈·재고·권한·DB 파일과, 꼭 볼 곳에서 확인한 것.
4. **안 돌린 것**: review.md의 한계. 없으면 "없음".
5. **요약**: PRD의 문제·범위로 무엇을 왜 바꿨는지 두세 줄.

## 3. PR 열기

```bash
git push -u origin HEAD
gh pr create --base <base> --title "<PRD 첫 줄 요약>" --body-file docs/tasks/<slug>/run/pr.md
```

- `gh`가 없거나 로그인하지 않았으면 push와 PR은 하지 않고, run/pr.md 경로를 알려 주고 멈춥니다.
- 끝나면 PR 주소를 보고합니다. 머지는 사람이 합니다.
