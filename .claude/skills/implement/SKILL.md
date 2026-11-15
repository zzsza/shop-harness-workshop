---
name: implement
description: 확정된 docs/tasks/<slug>/prd.md를 feat/<slug> 브랜치에서 AC마다 실패하는 테스트부터 구현하고 npm run verify 통과에서 멈춘다. 확정 PRD 구현 요청에 쓴다.
argument-hint: "<slug>"
hooks:
  Stop:
    - hooks:
        - type: command
          command: node "$CLAUDE_PROJECT_DIR/.claude/hooks/stop-ac-tests.mjs"
          timeout: 30
---

작업: $ARGUMENTS

빌려 온 곳: Addy Osmani의 agent-skills 저장소(planning: 계획 칸마다 완료 기준과 확인 방법), Matt Pocock의 skills 저장소(tdd: 실패하는 테스트부터). 원본은 복사하지 않고 생각만 가져왔습니다.

## 준비

1. `docs/tasks/<slug>/prd.md`, 루트 `CLAUDE.md`, 건드릴 영역의 하위 `CLAUDE.md`와 `docs/rules/`를 읽습니다.
   `확정 여부`가 **초안**이거나 미해결 질문이 남았으면 구현하지 않고 `/prd <slug>`로 돌려보냅니다.
2. `git status`로 커밋하지 않은 변경을 봅니다. 작업 폴더의 `interview.md`·`prd.md` 말고 다른 변경이 있으면 멈추고 사람에게 알립니다.
3. 지금 브랜치와 커밋을 기준으로 적어 두고 `git switch -c feat/<slug>`로 브랜치를 땁니다.
   이미 `feat/<slug>`에 있으면 그대로 이어 갑니다.
   `interview.md`·`prd.md`가 아직 커밋되지 않았으면 이 브랜치의 첫 커밋으로 올립니다.
4. 관련 코드와 테스트를 조사하고 `references/plan-template.md` 틀로 `docs/tasks/<slug>/run/plan.md`를 씁니다.
   계획의 줄마다 AC 열을 채웁니다. AC가 없는 줄은 PRD 범위 밖이니 빼거나 사람에게 묻습니다.
   PRD의 모든 AC가 계획 어딘가에 있는지 대조합니다.

## 구현 (AC 하나씩)

5. `테스트` AC는 실패하는 테스트를 먼저 씁니다. 테스트 이름 맨 앞에 slug와 AC 번호를 넣습니다(예: `it("low-stock-alert AC-2 수량이 안전재고와 같으면 미만이 아니다", ...)`).
   다른 작업의 AC-2와 헷갈리지 않게 slug를 함께 씁니다.
   그 테스트만 돌려 **실패하는 것을 확인한 뒤** 코드를 고쳐 통과시킵니다.
6. `화면 확인` AC는 화면을 만들고, 화면이 쓰는 API·도메인 동작은 테스트로 받칩니다. 그 테스트 이름에도 `<slug> AC-n`을 넣습니다. 브라우저 확인은 review가 합니다.
7. PRD 범위 안에서만 바꿉니다. 계층 규칙과 고유 규칙 8개를 지킵니다.
   기존 테스트의 기대값은 바꾸지 않습니다. 스키마 변경은 새 번호 마이그레이션으로 합니다.

## 끝내기 (verify까지)

8. `npm run verify`를 돌려 통과시키고 `npm run grade -- --since <기준 커밋>`으로 규칙 위반이 없는지 봅니다.
   작업 브랜치에는 시작 태그가 없으므로 `--since`를 꼭 붙입니다.
9. 바뀐 파일을 `feat/<slug>`에 커밋합니다(무엇을 바꿨는지 쓴 메시지). push와 PR은 하지 않습니다.
10. `docs/tasks/<slug>/run/status.json`에 단계와 결과를 남깁니다.
    ```json
    { "slug": "<slug>", "branch": "feat/<slug>", "base": "<기준 커밋>", "stage": "implemented", "verify": "pass", "commit": "<HEAD 커밋>" }
    ```
11. AC마다 테스트 이름(또는 화면 확인으로 남긴 것), verify 통과 줄, 커밋 id를 보고하고 멈춥니다.
    검증은 하지 않습니다. 다음은 `/review <slug>`입니다. 만든 쪽이 스스로 PASS를 선언하지 않습니다.

끝내려 하면 이 Skill의 Stop Hook(`.claude/hooks/stop-ac-tests.mjs`)이 PRD의 AC마다 이름에 `<slug> AC-n`이 든 테스트가 있는지와 지금 코드로 `npm run verify`가 전체 통과했는지 봅니다.
"AC-4에 테스트 없음"처럼 돌아오면 그 AC의 테스트를 채우고 verify를 다시 돌립니다.

PRD는 고치지 않습니다. PRD가 틀렸다면 사람에게 알리고 `/prd <slug>`로 돌아갑니다.
