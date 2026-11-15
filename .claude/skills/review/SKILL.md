---
name: review
description: 구현을 PRD와 리뷰 가이드로 검증하고 코드 리뷰한다. 스펙 대조·웹 확인·코드 리뷰 서브에이전트 셋을 한꺼번에 돌려 docs/tasks/<slug>/run/review.md 하나로 합친다. 인자가 PR 번호면 결과를 PR 댓글로 단다.
argument-hint: "<slug 또는 PR 번호>"
---

대상: $ARGUMENTS

빌려 온 곳: Addy Osmani의 agent-skills 저장소(doubt-driven-development: 만든 쪽을 믿지 않고 다시 확인), pstack(코드를 안 쓴 쪽의 판정만 받기), Matt Pocock의 skills 저장소(code-review: 스펙과 규칙을 따로 보기). 원본은 복사하지 않고 생각만 가져왔습니다.

검증과 코드 리뷰를 한 번에 합니다. 기준은 대화가 아니라 PRD와 `docs/review-guide.md`입니다.
이 Skill은 코드를 고치지 않습니다. 쓰는 곳은 `run/review.md`와 `run/evidence/`뿐입니다(웹 확인의 리뷰 서버 파일은 run 폴더에 남습니다).

## 1. 대상 정하기

- 인자가 slug면: PRD는 `docs/tasks/<slug>/prd.md`입니다.
  기준 커밋은 `run/status.json`의 `base`, 없으면 `git merge-base HEAD <가장 가까운 start 태그>`(`git describe --tags --abbrev=0 --match "start/*"`)입니다.
- 인자가 숫자면 PR입니다.
  `gh pr view <번호> --json headRefName,baseRefName,url`로 브랜치를 보고, 지금 브랜치 이름을 적어 둔 뒤 `gh pr checkout <번호> --detach`로 옮깁니다.
  `--detach`인 까닭: 그 PR을 만든 세션이 다른 worktree에서 `feat/<slug>` 브랜치를 쥐고 있으면 같은 브랜치로는 옮길 수 없습니다.
  slug는 `headRefName`의 `feat/<slug>`에서 얻고, 기준 커밋은 `git merge-base HEAD origin/<baseRefName>`입니다.
- `git status --porcelain`에 문서(`.md`)가 아닌 파일의 커밋하지 않은 변경이 있으면 멈추고 커밋하라고 알립니다. 리뷰는 커밋한 코드만 봅니다.
  `docs/review-guide.md`에 막 더한 기준처럼 문서만 바뀐 것은 그대로 진행합니다.
- PRD가 없거나 **초안**이면 멈춥니다.
- HEAD 커밋 id를 적어 둡니다(`git rev-parse --short HEAD`).

## 2. 넘길 것 만들기

```bash
mkdir -p docs/tasks/<slug>/run/evidence
git diff <기준 커밋>..HEAD > docs/tasks/<slug>/run/evidence/diff.patch
git diff --stat <기준 커밋>..HEAD
```

## 3. 서브에이전트 셋을 한꺼번에

한 메시지에서 Agent 도구를 세 번 불러 동시에 돌립니다: `spec-checker`, `web-checker`, `code-reviewer`.
셋에게 똑같이 이것만 넘깁니다.

```
PRD: docs/tasks/<slug>/prd.md
기준 커밋: <base>   HEAD: <head>
diff: docs/tasks/<slug>/run/evidence/diff.patch
run 폴더: docs/tasks/<slug>/run
evidence 폴더: docs/tasks/<slug>/run/evidence
```

구현 과정, 이 대화의 요약, 예상 판정, "테스트가 통과했다" 같은 말은 넘기지 않습니다.
검증자가 구현한 대화를 모르게 하는 것이 이 단계의 목적입니다.

코드 리뷰어는 기본 `/code-review`를 Skill 도구로 부른 뒤 `docs/review-guide.md`로 다시 봅니다.
부르지 못하면 가이드를 직접 따르고, 그 사실을 한계에 적습니다.

## 4. 합치기

셋의 결과를 `references/review-template.md` 틀로 `docs/tasks/<slug>/run/review.md`에 씁니다(이전 것은 덮어씁니다).

- AC마다 한 줄: 스펙 대조와 웹 확인 중 그 AC를 맡은 쪽의 판정과 근거.
- 리뷰 가이드의 칸마다 코드 리뷰의 지적.
- 전체 판정: FAIL이 하나라도 있으면 FAIL, 아니고 BLOCKED가 있으면 BLOCKED, 모두 PASS면 PASS.
- 맨 위에 검증한 커밋 id를 적습니다. 그 뒤에 코드가 바뀌면 이 review.md는 낡은 것입니다.
- 셋이 직접 하지 못한 것을 한계에 모읍니다.

검증자의 판정을 고치거나 FAIL을 PASS로 바꾸지 않습니다. 이상해 보이면 한계에 적습니다.

## 5. 끝내기

- PR이면 `gh pr comment <번호> --body-file docs/tasks/<slug>/run/review.md`로 댓글을 달고, 적어 둔 원래 브랜치로 돌아갑니다(`git switch <원래 브랜치>`).
  화면 사진은 댓글에 붙지 않으니 파일 경로만 남깁니다.
- 전체 판정, FAIL인 AC와 막을 것, review.md 경로를 보고합니다. 고치는 일은 하지 않습니다.
