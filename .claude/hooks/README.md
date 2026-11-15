# Hook 판정 범위

이 폴더의 Hook은 공격자를 막는 장치가 아닙니다.
에이전트가 실수로 위험한 일을 하려 할 때 실행 전에 멈추는 안전장치입니다.
그래서 "에이전트가 평소에 쓰는 모양의 명령"을 기준으로 판정합니다.
아래 범위는 `hooks.test.mjs`의 '막는다' 표와 '통과한다' 표로 고정되어 있습니다.

## 막는 것

| Hook | 막는 일 | 예 |
| --- | --- | --- |
| `guard-bash.mjs` | force push | `git push -f`, `git push --force-with-lease`, `git push origin +main` |
| `guard-bash.mjs` | 대량 삭제(빌드 산출물 밖의 재귀 삭제) | `rm -rf apps/api`, `git clean -fd`, `find . -delete` |
| `protect-files.mjs` | `.env` 읽기·쓰기(`.env.example`은 괜찮음) | `cat .env`, `echo X=1 >> .env`, Read·Edit 도구로 `.env` 열기 |
| `protect-files.mjs` | 이미 커밋된 마이그레이션 수정·삭제·이동 | `sed -i ... 0001_init.sql`, `git diff --output=0001_init.sql`, `rm -r packages/db` |
| `stop-verify.mjs` | 코드를 바꾼 뒤 전체 `npm run verify` 없이 끝내기 | `--only`로 일부만 돌린 것, verify 뒤에 다시 고친 것 |
| `lint-saved-file.mjs` | 막지 않음. 저장한 파일의 lint 결과를 돌려줌 | 25초를 넘으면 건너뛰었다고 알림 |
| `stop-ac-tests.mjs` (implement Skill frontmatter의 Stop) | `/implement`가 PRD의 AC마다 이름에 `<slug> AC-n`이 든 테스트 없이, 또는 지금 코드로 전체 verify 통과 없이 끝내기 | 테스트 이름 `order-cancel AC-4 ...`에서 AC 번호를 지우면 "AC-4에 테스트 없음"으로 돌려보냄. 레포의 테스트 파일 전부에서 찾음 |
| `check-review-commit.mjs` (PreToolUse Bash) | `gh pr create` 때 `run/review.md`의 검증한 커밋이 HEAD가 아니거나, 전체 판정이 PASS가 아니거나, review.md가 없음 | 리뷰 뒤에 커밋을 하나 더 하고 PR 열기 |
| `subagent-evidence.mjs` (프로젝트 settings의 SubagentStop) | 검증자 셋이 "검증한 커밋: <HEAD>" 줄이나 판정 줄마다의 근거 없이 끝내기 | 근거 칸이 `-`인 PASS 줄, 화면 칸이 빈 웹 확인 PASS 줄 |

명령을 읽을 때 앞뒤에 붙은 것을 벗겨서 실제로 실행되는 명령을 봅니다.

- 이어 붙인 명령: `;`, `&&`, `||`, `|`, 줄바꿈, `( ... )`, `{ ...; }`, `$( ... )`, 백틱
- 셸에 넘긴 문자열: `bash -c "..."`, `sh -c`, `eval "..."`, 셸이나 node에 넘긴 heredoc
- 실행 접두어와 그 옵션: `VAR=값`, `env`, `command`, `sudo -u x`, `sudo --user x`, `nohup`, `timeout 30`, `xargs`
- git 전역 옵션: `git -C dir`, `git -c k=v`, `git --git-dir x`, `git --work-tree x`
- 작업 폴더: `cd`, `eval "cd ..."`, `git -C dir`, `env -C dir`를 따라가서 상대 경로를 풉니다.
- Windows 경로 구분자(`packages\db\migrations\0001_init.sql`)도 같은 경로로 봅니다.
- 마이그레이션은 "보호 파일이 쓰기 대상으로 나타나는가"로 봅니다.
  쓰기 대상은 출력 리다이렉션(`>`, `>>`), 파일을 쓰는 옵션(`git diff --output=`), 파일을 고치는 명령의 인자(`sed -i`, `cp`의 목적지, `rm`, `mv`), `node -e`·`python -c` 스크립트 안의 파일 경로입니다.
  폴더째 지우거나 옮기는 명령(`rm -r`, `mv`, `git rm -r`)은 그 폴더 안에 커밋된 마이그레이션이 있으면 막습니다.
  `find <폴더> -exec sed -i ... {}`·`find <폴더> -delete`도 그 폴더 아래 `.sql`을 고를 수 있으면 막습니다(`-name '*.ts'`면 통과).

## 허용하는 것 (오탐이 없어야 하는 정상 명령)

| 하는 일 | 예 |
| --- | --- |
| 검증·실행 | `npm run verify`, `npm test`, `npm run dev`, `npx vitest run`, `node scripts/verify.mjs` |
| git 일상 작업 | `git status`, `git diff`, `git add -A`, `git commit -m "..."`, `git push`, `git push -u origin feature`, `git log` |
| 파일 만들기·읽기 | `mkdir -p`, `touch`, `cat`, `rg`, `sed -n` |
| 소스 고치기 | `sed -i '' 's/a/b/' apps/api/src/app.ts`, Edit·Write 도구 |
| 새 마이그레이션 | `mkdir -p packages/db/migrations`, 새 번호 파일(예: `0002_low_stock.sql`) Write 뒤 Edit, `cat > 0002_...sql <<'EOF'`, `cp`로 새 파일 넣기 |
| 빌드 산출물 지우기 | `rm -rf node_modules dist`, 파일 하나 `rm` |
| 기존 마이그레이션 읽기 | `cat`, `git diff -- 0001_init.sql`, `cp 0001_init.sql /tmp/backup.sql` |
| 문서·실행 결과만 쓰고 끝내기(verify 요구 없음) | Write나 `cat > docs/tasks/x/interview.md`로 `.md` 쓰기, `git diff > docs/tasks/x/run/evidence/diff.patch` |
| 리뷰가 쓰는 git·gh(코드 변경으로 치지 않음) | `git merge-base`, `gh pr view`·`diff`·`checks`·`comment`, `gh pr checkout`(이미 커밋된 PR 브랜치로 옮길 뿐 파일을 쓰지 않음) |
| 브랜치 옮기기(코드 변경으로 치지 않음) | `git switch <브랜치>`, `git switch -`, `git switch -c <새 브랜치>`. `--discard-changes`·`-f`와 `git checkout`은 코드 변경으로 침 |

`./gen.sh > notes.md`처럼 스스로 어디에 쓸지 모르는 프로그램은 출력을 문서로 돌려도 코드를 바꾼 것으로 봅니다.

새 마이그레이션 판단은 HEAD 기준입니다.
HEAD에 없는 번호 파일은 커밋하기 전까지 고칠 수 있습니다.

## 알려진 한계

아래 모양은 에이전트가 실수로 쓰지 않는 형태라서 일부러 판정하지 않습니다.
막으려면 명령을 실제로 실행해 봐야 하므로, 이 Hook의 목적(실행 전에 멈추기)과 맞지 않습니다.

- 일부러 쪼갠 문자열: `cat .e'nv'`는 잡지만 `F=.e; cat ${F}nv`나 `'.e' + 'nv'`처럼 변수·연산으로 만든 경로는 잡지 않습니다.
- 실행해야 알 수 있는 경로: `cd $(cat dir.txt)`, `eval "$CMD"`처럼 변수에 담긴 명령. 작업 폴더를 모르면 파일 이름만으로 마이그레이션인지 봅니다.
- 다른 파일에 적은 내용: `bash script.sh`, `node tools/x.mjs`, `npm run <스크립트>` 안에서 하는 일, `git apply x.patch`·`patch`가 고칠 파일, `xargs`가 파일 목록에서 읽을 경로는 보지 않습니다.
- 스크립트 안에서 폴더째 지우기·옮기기: `node -e "fs.rmSync('packages/db/migrations', ...)"`. 스크립트 안은 파일 경로만 봅니다(`fs.mkdirSync`로 폴더를 만드는 정상 명령과 구별할 수 없어서).
- 폴더를 통째로 다시 쓰는 도구: `npx prettier --write packages/db/migrations` 같은 형태. 폴더 인자는 지우기·옮기기 명령에서만 봅니다.
- 드문 쓰기 방법: `sed` 스크립트의 `w` 명령, `less -o` 같은 출력 옵션.
- `.env` 읽기 차단은 경로 이름 기준입니다. 심볼릭 링크나 다른 이름으로 복사한 파일은 따라가지 않습니다.

Stop·SubagentStop Hook은 한 번 막은 뒤에도 그대로 끝내려 하면 경고만 남기고 끝내게 둡니다.
계속 막으면 끝내기가 끝없이 반복되기 때문입니다.

## 무인 허용 목록 (settings.json permissions.allow)

사람 없이 `/implement` → `/review` → `/pr-ship`이 끝까지 가도록, 그 길에서 쓰는 명령만 allow에 둡니다. 머지와 force push는 deny입니다.

| 명령 | 까닭 |
| --- | --- |
| `npm run verify`·`npm run ci`·`npm run grade` | 검사 |
| `git add`·`git commit`·`git push` | 커밋하고 올리기. force push는 deny와 `guard-bash.mjs`가 막음 |
| `gh pr create`·`gh pr checks` | PR 열기와 PR 검사 기다리기 |
| `gh pr edit`·`gh pr view` | pr-ship이 PR 검사 결과로 본문 첫 칸을 고치고 PR을 봄 |
| `gh auth status` | pr-ship이 PR을 열기 전에 로그인했는지 봄(읽기만 함) |
| `git rev-parse`·`git describe`·`git branch --list`·`git branch -r --list`·`git merge-base` | pr-ship이 base(시작 브랜치)를 고르고 갈라진 자리로 확인함(읽기만 함) |

## 실습 3 Hook의 한계

- `stop-ac-tests.mjs`는 이름에 slug가 붙은 테스트만 셉니다. `AC-4 ...`처럼 slug 없이 쓴 이름은 다른 작업의 AC-4와 구별할 수 없어서 세지 않습니다.
- Skill frontmatter의 Hook은 Skill을 부른 뒤 세션 끝까지 남습니다. 그래서 마지막으로 부른 이 레포의 Skill이 implement일 때만 봅니다.
- `permissions.ask`는 배송비 규칙 파일 둘(`shipping-fee.ts`, `shipping-policy.ts`)과 이미 적용된 마이그레이션(0001·0002)의 Edit입니다. 새 번호 마이그레이션 추가는 묻지 않습니다. 이미 적용된 마이그레이션은 `protect-files.mjs`가 먼저 막으므로 승인 창보다 거절이 먼저 보입니다.
- `permissions.ask`의 Edit 규칙은 Edit·Write 도구에만 걸립니다. Bash로 파일을 고치는 명령(`sed -i`)은 승인 창 없이 지나가니, 배송비 같은 위험 경로는 PR 리뷰의 꼭 볼 곳에도 둡니다.
