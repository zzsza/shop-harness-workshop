# shop-harness-workshop

가상의 교육용 쇼핑몰 "그랩마켓"으로 하는 Claude Code 실습 레포입니다.

## 강의 전 준비

### 1. 필요한 것

| 프로그램 | 확인 명령 | 설치 |
| --- | --- | --- |
| Node 22.18 이상 (24 권장) | `node --version` → `v22.18` 이상 | https://nodejs.org/ko/download |
| git | `git --version` | https://git-scm.com/downloads |
| Claude Code 최신 버전 | `claude --version` | https://code.claude.com/docs/ko/setup |

Node가 18·20처럼 낮으면 위 링크에서 LTS를 받아 설치하면 됩니다. Node 22에서는 DB를 쓸 때 `SQLite is an experimental feature` 경고가 한 줄 보이는데 무시해도 됩니다. 다른 일 때문에 옛 Node를 남겨야 하면 nvm(Windows는 nvm-windows) 같은 버전 관리 도구로 이 레포에서만 새 Node를 쓰세요.
Claude Code는 최신 버전으로 설치하고, 이미 깔려 있으면 `claude update`로 올려 두세요.
Windows에서 관리자 권한이 없으면 Node 다운로드 페이지에서 Windows 바이너리 .zip(x64)을 받아 `C:\Users\<이름>\node` 같은 곳에 풀고, "계정의 환경 변수 편집"에서 그 폴더를 사용자 Path 맨 위에 넣은 뒤 터미널을 새로 엽니다.
Windows에서는 npm 대신 Claude Code 공식 설치 명령(PowerShell `irm https://claude.ai/install.ps1 | iex`)을 권합니다.

#### Windows: 어느 터미널에서 하나요

PowerShell(Windows Terminal)을 권합니다. Git Bash나 명령 프롬프트(cmd)에서 해도 같은 Node·Claude Code를 쓰므로 똑같이 됩니다.
PowerShell에서 `npm`이 「npm.ps1 파일을 로드할 수 없습니다」(PSSecurityException)로 막히면, 그 창에서 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`를 한 번 실행한 뒤 다시 합니다. 관리자 권한은 필요 없습니다.
회사 정책 때문에 이 명령도 막히면 `npm` 대신 `npm.cmd`로 하거나(예: `npm.cmd run setup`) 명령 프롬프트(cmd)에서 합니다.
WSL은 터미널이 아니라 Windows 안의 별도 리눅스라서, WSL로 하려면 처음부터 끝까지 WSL 안에서 합니다.

- WSL 안에 Node 22.18 이상, git, Claude Code를 따로 설치합니다. Windows에 깔린 것은 WSL에서 쓰지 않습니다.
- WSL의 내 폴더에서 받습니다(`cd ~` 뒤 `git clone`). `/mnt/c/...` 같은 Windows 드라이브에 받으면 설치와 테스트가 아주 느립니다.
- `npm run setup`과 `npm run claude`도 같은 WSL 창에서 실행합니다. Windows에서 받고 WSL에서 실행하는 식으로 섞지 않습니다.
- 첫 로그인 때 브라우저가 저절로 열리지 않으면, 화면에 나온 주소를 Windows 브라우저에 붙여 넣습니다.
- `npm run dev`로 띄운 쇼핑몰은 Windows 브라우저에서도 같은 주소로 엽니다.
- `/harness-check`의 프로젝트 후보는 WSL 안에서 Claude Code를 쓴 기록에서 나옵니다. Windows 쪽 프로젝트를 점검하려면 경로를 직접 적습니다.

### 2. 받고 준비하기

```bash
git clone https://github.com/yansfil/shop-harness-workshop.git
cd shop-harness-workshop
npm run setup
```

`npm run setup`은 Node → claude 명령 → 의존성(없으면 `npm ci`) → DB(없으면 만들고 시드) → `.env`(없으면 `.env.example`에서 복사)까지 준비하고 결과를 단계마다 보여 줍니다.
이미 된 단계는 건너뛰므로 여러 번 실행해도 됩니다.
실패하면 멈춘 단계 이름, 이유, 할 일이 나옵니다.
Mac·Windows(PowerShell, Git Bash, WSL) 모두 같은 명령입니다.

### 3. 시작하기

```bash
npm run claude
```

Mac·Windows 모두 같은 명령입니다.
Claude Code는 실습 전용 설정 폴더 `~/.claude-workshop`(Windows는 `C:\Users\<이름>\.claude-workshop`)로 뜹니다.
처음이면 로그인 화면이 나오고, 이 폴더를 믿을지 묻습니다. "Yes, I trust this folder"를 고릅니다.
원래 `~/.claude` 설정과 로그인은 바뀌지 않고, 내 평소 지침·Skill·권한 설정이 실습에 섞이지 않습니다.
레포를 홈 폴더 아래에 받아도 레포 바깥 폴더의 CLAUDE.md(예: `~/.claude/CLAUDE.md`)는 읽지 않게 막아 두어, 이 레포의 지침만 읽힙니다.
이 폴더는 레포 밖에 있어서 브랜치를 바꾸거나 다시 clone해도 실습 로그인이 남습니다.
`npm run claude -- --continue`처럼 `--` 뒤에 붙인 옵션은 claude에 그대로 넘어갑니다.
그냥 `claude`로 열면 평소 계정과 설정으로 뜨니, 실습할 때는 꼭 `npm run claude`로 엽니다.
실습 계정을 처음 상태로 돌리려면 `npm run claude:reset`을 실행합니다. 실습 계정만 로그아웃하고 `~/.claude-workshop`을 지운 뒤, 다음 `npm run claude`에서 로그인부터 다시 나옵니다.
실습하다 꼬였거나 강사가 자료를 고쳤다고 하면 `npm run sync`를 실행합니다. 바뀐 파일과 내 커밋은 버리고 모든 실습 브랜치를 원격 최신으로 맞춘 뒤 DB도 처음 상태로 되돌립니다. 다른 브랜치로 바로 옮기려면 `npm run sync -- day1-c`처럼 브랜치를 붙입니다.

실습에 쓰는 두 가지가 함께 켜집니다.

- 기본 설정(`.claude/settings.json`): 검증 명령(`npm run verify`, `npm test`, lint, 타입 검사)과 git 조회는 묻지 않고 실행합니다. Hook 두 개가 걸려 있어 `/hooks`에서 볼 수 있습니다. 실습하면서 이 파일에 권한과 Hook을 더해 갑니다.
  - SessionStart: 세션을 열 때마다 지금 상태(개발 서버가 떠 있는지, 커밋 안 된 변경과 최근 커밋, DB의 주문·상품 수)를 Claude에게 알려 줍니다. 바뀌지 않는 정보는 CLAUDE.md에, 열 때마다 달라지는 정보는 이 Hook에 둡니다.
  - InstructionsLoaded: Claude Code가 어떤 지침 파일을 읽었는지 레포 안 `.observer/`(git이 무시함)에 남깁니다. 세션 뷰어(`npm run viewer`)가 이 기록으로 요청마다 어떤 지침이 새로 읽혔는지 보여 줍니다.
- 하네스 점검 스킬(`.claude/skills/harness-check`): `/harness-check`를 입력하면 점검할 프로젝트(평소 일하는 레포 또는 이 레포)를 고른 뒤, 그 프로젝트와 Claude Code 설정을 읽기만 해서 빈 곳과 손볼 곳을 지도로 보여 줍니다. 결과는 `~/.harness-check/`에 남습니다.

그랩마켓 쇼핑몰은 레포 폴더에서 `npm run dev`로 띄웁니다.
브라우저에서 http://127.0.0.1:5173 을 열면 쇼핑몰이 나오고(API는 127.0.0.1:3001), 끌 때는 그 터미널에서 Ctrl+C를 누릅니다.
로그인 화면에도 적혀 있는 교육용 계정은 아래와 같습니다.

| 역할 | 이메일 | 비밀번호 |
| --- | --- | --- |
| 고객 | `customer1@grabmarket.test` | `grab1234!` |
| 관리자 | `admin@grabmarket.test` | `admin1234!` |

`npm run orders:simulate`는 몇 초마다 새 주문을 만들고, `npm run db:reset`은 데이터를 처음 상태로 되돌립니다.

### GitHub에서 PR 실습하기

Day1에 이미 clone했다면 Day2 시작 전에 `git fetch origin --tags --force`로 새로 옮긴 시작 태그(`start/day2-*`)를 받습니다. 그냥 `git fetch`는 이미 있는 태그를 바꾸지 않아 채점 기준점이 어긋납니다.
Day2부터는 내 fork에서 PR을 열고 PR마다 검사를 돌립니다.
준비는 [docs/github.md](docs/github.md)를 따릅니다.
GitHub를 쓸 수 없으면 같은 검사를 `npm run ci`로 내 컴퓨터에서 돌립니다.
GitHub를 쓰든 못 쓰든 Day2 전에 레포 폴더에서 `npx -y @playwright/mcp@0.0.84 --version`을 한 번 돌려 화면 확인 도구를 미리 받아 둡니다(버전 숫자가 나오면 됩니다).

### 강의 뒤 정리

실습이 끝나면 레포 폴더에서 `npm run claude:reset`을 실행해 실습 계정을 로그아웃하고 `~/.claude-workshop`(Windows는 `C:\Users\<이름>\.claude-workshop`)을 지운 뒤, 레포 폴더를 지우면 됩니다.
원래 `~/.claude`와 평소 로그인은 그대로입니다.
지우기 전에 실습 기록을 HTML 한 파일로 남기려면 레포 폴더에서 다음을 실행합니다.

```bash
npm run viewer -- --export exports
```

`exports/index.html`이 생깁니다.

> day3 브랜치에는 실습용으로 보안 약점을 일부러 넣은 코드가 있습니다. 내 컴퓨터(127.0.0.1)에서만 띄우고, 실제 데이터를 넣거나 외부에 배포하지 마세요.
