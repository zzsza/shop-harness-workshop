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
| Settings > CI/CD > Runners | 이 프로젝트에 쓸 수 있는 Runner가 있는지 확인. 없으면 사내 담당자에게 묻습니다 |

검사는 `node:24` 이미지로 돕니다. Runner가 이 이미지를 받지 못하면 검사가 시작하지 않으니 사내 담당자에게 묻습니다.

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

## 로컬에서 먼저 돌리기

```bash
npm run ci
```

GitHub와 같습니다. [github.md](github.md)의 "로컬에서 먼저 돌리기"를 봅니다.

## GitLab을 못 쓰면

MR 대신 실습 브랜치(예: `day2-a`)에서 `npm run merge feat/order-cancel`을 실행합니다.
[github.md](github.md)의 "GitHub를 못 쓰면"과 같습니다.
