# 회사 GitLab에서 MR 실습하기 (Day2부터)

GitHub 대신 회사 GitLab을 쓰는 경우입니다.
강사 레포를 내 GitLab 프로젝트로 가져오고, MR은 **내 프로젝트 안에서** 열고 내 프로젝트 안에서 머지합니다.
하는 일은 [github.md](github.md)와 같고, `gh` 대신 `glab`, PR 대신 MR을 씁니다.

## 필요한 것

| 프로그램 | 확인 명령 | 설치 |
| --- | --- | --- |
| 회사 GitLab 계정 | 회사 GitLab 로그인 | 사내 안내를 따릅니다 |
| GitLab CLI | `glab --version` | Mac은 `brew install glab`, 그 밖은 https://gitlab.com/gitlab-org/cli#installation |

회사 GitLab 주소로 한 번 로그인합니다.
토큰을 물으면 GitLab의 Preferences > Access tokens에서 `api`, `write_repository` 권한으로 만든 토큰을 붙여 넣습니다.

```bash
glab auth login --hostname <회사 GitLab 주소>
glab auth status
```

## 1. 강사 레포 가져오기

둘 중 하나로 합니다.

- **주소로 가져오기**: New project > Import project > Repository by URL에 `https://github.com/yansfil/shop-harness-workshop.git`을 넣습니다. 실습 브랜치(day2-a 등)와 시작 태그가 모두 옵니다.
- **회사 GitLab이 GitHub에 닿지 않으면**: New project > Create blank project로 빈 프로젝트를 만듭니다("Initialize repository with a README"는 끕니다). 2번을 한 뒤 내 폴더에서 올립니다.

  ```bash
  git push origin upstream/main:refs/heads/main upstream/day2-a:refs/heads/day2-a upstream/day2-b:refs/heads/day2-b upstream/day2-c:refs/heads/day2-c
  git push origin --tags
  ```

  HTTPS push가 `RPC failed; HTTP 500`으로 끊기면 한 번에 보내는 크기를 키우고 다시 올립니다(레포가 40MB쯤이라 기본값으로는 끊길 수 있습니다).

  ```bash
  git config http.postBuffer 524288000
  ```

## 2. 내 폴더를 GitLab 프로젝트에 잇기

이미 clone한 폴더에서 그대로 합니다.

```bash
git remote rename origin upstream
git remote add origin https://<회사 GitLab 주소>/<내 그룹>/shop-harness-workshop.git
git fetch upstream --tags --force
git fetch origin
```

이렇게 이은 뒤에도 `npm run sync`는 `upstream`(강사 레포)에서 받아 실습 브랜치를 맞춥니다. GitHub fork와 같습니다.

## 3. 보호 브랜치와 머지 조건

프로젝트의 Settings에서 한 번 정합니다. 머지는 사람이 MR 화면에서 검사 결과를 보고 합니다.

| 어디 | 무엇 |
| --- | --- |
| Settings > Repository > Protected branches | `main`과 `day2-*`: Allowed to merge는 Maintainers, Allowed to push and merge는 No one |
| Settings > Merge requests > Merge checks | "Pipelines must succeed" 켜기 |
| Settings > CI/CD > Runners | 이 프로젝트에 쓸 수 있는 Runner가 있는지 확인 |

검사는 `node:24` 이미지로 돕니다. Runner가 이 이미지를 받지 못하면 아래 "폐쇄망에서 미리 확인할 것"을 봅니다.

## 4. MR을 열면

```bash
git push -u origin feat/order-cancel
glab mr create --target-branch day2-a --title "주문 취소" --description-file agents/runs/order-cancel/pr.md
```

MR의 Pipelines에 `check`가 돕니다(`.gitlab-ci.yml`).
하는 일은 로컬의 `npm run ci`와 같습니다: 커밋한 코드만 받아 타입 검사·lint·테스트·빌드를 하고, target 브랜치에서 갈라진 뒤 바뀐 코드를 채점합니다.
결과 표는 그 job의 로그 끝에 나옵니다.

`/pr-ship`은 origin 주소에 `github.com`이 없고 `glab`이 있으면 이 길로 MR을 엽니다.
`glab`에 로그인하지 않았으면 MR 본문(`agents/runs/<slug>/pr.md`)까지 쓰고 멈춥니다.

MR 본문 틀은 `.gitlab/merge_request_templates/Default.md`입니다(Day2-A부터, GitHub의 PR 틀과 같은 내용).
MR을 손으로 열 때 Description의 템플릿에서 고릅니다.

## 실습 B를 GitLab으로

장치는 GitHub와 같고, 4층 CI가 `.github/workflows/pr.yml` 대신 `.gitlab-ci.yml`입니다.
시작 전에 3번의 보호 브랜치와 "Pipelines must succeed"가 켜져 있어야 B-2가 의미가 있습니다.

| 슬라이드 | GitHub | GitLab |
| --- | --- | --- |
| B-0 4층 CI | `.github/workflows/pr.yml` | `.gitlab-ci.yml`의 `check` job |
| B-1 "열린 PR을 머지해줘" | `gh pr merge` 거절 | `glab mr merge`·`glab mr accept`·`glab api …/merge` 거절(`settings.json` deny와 `guard-bash.mjs`) |
| B-2 검사 필수 | fork Settings → Rules: `day2-*`에 상태 검사 필수 | Settings > Merge requests > Merge checks: "Pipelines must succeed" |
| B-2 이게 보이면 정상 | PR 검사 빨강, Merge 버튼 잠김 → 초록, 버튼 열림 | MR의 파이프라인 빨강, Merge 버튼 자리에 파이프라인이 성공해야 한다는 안내 → 초록, Merge 버튼 열림 |
| B-3 4층 확인 | PR Checks에 새 칸이 빨강 | MR 파이프라인에 새 job이 빨강(`check`는 초록) |

B-2 요청문의 "PR 올려줘"는 그대로 써도 됩니다. `/pr-ship`과 Claude는 origin이 GitLab이면 `glab mr create`로 MR을 엽니다.

B-4 힌트의 4층 CI 요청문은 GitLab에서는 이렇게 바꿉니다.

| ① 막기 요청문 | ② 새 세션에서 확인 요청문 |
| --- | --- |
| `.gitlab-ci.yml`에 job을 하나 더해서, MR이 apps/ 코드에 console.log를 새로 더하면 빨간불이 되게 해 줘. MR 파이프라인에서만 돌고, target 브랜치와 비교해야 해. 확인은 MR에서 할 테니 .gitlab-ci.yml만 고쳐 줘. | feat/console-check 브랜치를 새로 만들어 apps/api/src/app.ts에 console.log 한 줄을 넣고, 바뀐 .gitlab-ci.yml과 함께 커밋한 다음 origin에 push하고 day2-b로 MR을 열어 줘. |

새 job은 `check`처럼 `GIT_DEPTH: "0"`으로 기록을 다 받고, `CI_MERGE_REQUEST_TARGET_BRANCH_NAME`을 `git fetch`해 그 브랜치와 비교해야 합니다. MR 파이프라인은 target 브랜치를 받아 두지 않기 때문입니다.

## 폐쇄망에서 미리 확인할 것

gitlab.com에서는 위 흐름이 모두 돌았습니다(2026-11-17). 회사 GitLab이 폐쇄망이면 아래가 막힐 수 있으니 실습 전에 확인합니다.
앞의 셋이 막히면 MR 파이프라인이 돌지 않아 B-2·B-3를 GitLab에서 볼 수 없습니다.
"Pipelines must succeed"가 켜져 있으면 파이프라인이 없거나 멈춘 MR도 머지가 잠깁니다.

| 무엇 | 막히면 | 확인·대응 |
| --- | --- | --- |
| Runner가 `node:24` 이미지를 받을 수 있나 | job이 이미지 받기에서 실패 | `.gitlab-ci.yml`은 그대로 두고 프로젝트 Settings > CI/CD > Variables에 `NODE_IMAGE` = 사내 미러의 node:24 주소(예: `nexus.corp:8443/library/node:24`) |
| Runner에서 npm 레지스트리에 닿나 | `npm ci` 단계 실패 | 같은 곳에 `NPM_CONFIG_REGISTRY` = 사내 npm 미러 주소. `package-lock.json`의 npmjs 주소는 npm이 미러 주소로 바꿔 받으므로 lockfile은 고치지 않습니다 |
| 이 프로젝트에 쓸 Runner가 있나 | 파이프라인이 pending에 멈춤("no active runners") | Settings > CI/CD > Runners. Runner의 helper 이미지(`gitlab-runner-helper`)도 사내에서 받을 수 있어야 합니다 |
| 사내 CA 인증서 | `glab`·`git push`·`npm`이 인증서 오류 | `glab config set ca_cert <CA 파일> --host <GitLab 주소>`, `git config --global http.https://<GitLab 주소>/.sslCAInfo <CA 파일>`(Windows는 `git config --global http.sslBackend schannel`), CI의 npm은 변수 `NODE_EXTRA_CA_CERTS` |
| 노트북에서 GitHub에 닿나 | `npm run sync`와 강사 레포 가져오기 불가 | 사내 미러를 `upstream`으로 둡니다 |
| `glab`을 설치할 수 있나 | `/pr-ship`이 MR을 못 엶 | 공식 배포는 gitlab.com 릴리스뿐이라(brew·winget·scoop도 인터넷에서 받음) 미리 받아 사내에 나눠 줍니다. 없으면 MR은 웹에서 열고, `/pr-ship`은 `pr.md`까지 씁니다 |

gitlab.com에서 폐쇄망을 흉내 내 확인한 것: 프로젝트 변수 `NODE_IMAGE`(Docker Hub가 아닌 레지스트리)와 `NPM_CONFIG_REGISTRY`(다른 npm 레지스트리)만 넣었더니 이미지와 npm 패키지를 모두 그쪽에서 받고 `check`가 초록이었습니다.
로컬 `npm run ci`는 lockfile이 바뀌지 않았으면 설치된 `node_modules`를 복사하므로 인터넷 없이 돕니다(npm 레지스트리·프록시를 막고 확인).

그래도 파이프라인이 안 돌면 B-2·B-3의 4층 확인은 로컬 `npm run ci`의 빨강·초록으로 대신하고, 머지는 사람이 `npm run merge`로 합니다.

## 로컬에서 먼저 돌리기

```bash
npm run ci
```

GitHub와 같습니다. [github.md](github.md)의 "로컬에서 먼저 돌리기"를 봅니다.

## GitLab을 못 쓰면

MR 대신 실습 브랜치(예: `day2-a`)에서 `npm run merge feat/order-cancel`을 실행합니다.
[github.md](github.md)의 "GitHub를 못 쓰면"과 같습니다.
