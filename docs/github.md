# GitHub에서 PR 실습하기 (Day2부터)

Day2부터는 만든 기능을 PR로 올리고, PR마다 검사가 돌고, 리뷰하고 머지합니다.
PR은 **내 fork 안에서** 열고 내 fork 안에서 머지합니다.
원래 레포(`yansfil/shop-harness-workshop`)로는 PR을 보내지 않습니다.

## 필요한 것

| 프로그램 | 확인 명령 | 설치 |
| --- | --- | --- |
| GitHub 계정 | github.com 로그인 | https://github.com/signup |
| GitHub CLI | `gh --version` | https://cli.github.com |

`gh auth login`으로 한 번 로그인합니다.

## 1. fork 만들기

1. https://github.com/yansfil/shop-harness-workshop 에서 Fork를 누릅니다.
2. **"Copy the main branch only"의 체크를 풉니다.** 실습 브랜치(day2-a 등)가 모두 있어야 합니다.
3. 만든 fork의 Actions 탭에서 "I understand my workflows, go ahead and enable them"을 누릅니다. fork는 처음에 검사가 꺼져 있습니다.

## 2. 내 폴더를 fork에 잇기

이미 clone한 폴더에서 그대로 합니다.

```bash
git remote rename origin upstream
git remote add origin https://github.com/<내 아이디>/shop-harness-workshop.git
git fetch origin
gh repo set-default <내 아이디>/shop-harness-workshop
```

`gh repo set-default`를 빠뜨리면 `gh pr create`가 원래 레포로 PR을 보냅니다.
`gh repo set-default --view`가 `<내 아이디>/shop-harness-workshop`을 보이면 됩니다.

## 3. PR을 열면

```bash
git push -u origin feat/order-cancel
gh pr create --base day2-a
```

PR의 Checks에 "PR 검사 / 검사"가 돕니다.
하는 일은 로컬의 `npm run ci`와 같습니다: 커밋한 코드만 받아 타입 검사·lint·테스트·빌드를 하고, base 브랜치에서 갈라진 뒤 바뀐 코드를 채점합니다.
결과 표는 검사 화면의 Summary에 나옵니다.

## 로컬에서 먼저 돌리기

```bash
npm run ci
```

커밋을 임시 폴더에 꺼내 같은 검사를 돌립니다.
커밋하지 않은 파일은 검사에 들어가지 않고, 몇 개를 뺐는지 마지막에 알려 줍니다.
채점 기준점은 가장 가까운 시작 태그(`start/day2-a` 등)이고, `npm run ci -- --base day2-a`로 바꿀 수 있습니다.
