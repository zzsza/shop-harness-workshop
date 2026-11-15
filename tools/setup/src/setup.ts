// npm run setup: 수강생이 claude를 띄우기 전 준비를 한다.
// Node 확인(scripts/setup.mjs가 먼저 함) → claude 명령 → 의존성 → DB → .env.
// 이미 된 단계는 그렇다고 말하고 건너뛴다. 어느 단계도 조용히 건너뛰지 않고, 실패하면 단계 이름·이유·할 일을 보이고 1로 끝난다.
import { copyFileSync, constants as fsConstants, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { capture, findHere, runVisible } from "./command.ts";
import { checkInstalledDependencies, LockfileError } from "./dependencies.ts";
import { isInsideOrEqual, isSamePath, REPO_ROOT } from "./paths.ts";
import { runSteps, StepFailure, type Step } from "./report.ts";

const SCRIPT = "setup.mjs";
export const TOTAL_STEPS = 5;

export const CLAUDE_INSTALL_HELP = [
  "설치 안내: https://code.claude.com/docs/ko/setup",
  "Mac: 터미널에서 curl -fsSL https://claude.ai/install.sh | bash",
  "Windows: PowerShell에서 irm https://claude.ai/install.ps1 | iex",
  "설치한 뒤 터미널을 새로 열고 claude --version이 되는지 확인하세요.",
];

/**
 * 실습이 기대는 가장 낮은 Claude Code 버전. 2.1.69에서 InstructionsLoaded Hook이 생겼고, 뷰어의 지침 읽기 기록이 이 Hook에 기댄다.
 * 이보다 옛 버전은 이 Hook이 든 레포 .claude/settings.json을 통째로 버려 권한·Hook이 모두 빠지므로, 띄우기 전에 멈추고 업데이트를 안내한다.
 */
export const MIN_CLAUDE_VERSION = [2, 1, 69] as const;

const CLAUDE_UPDATE_HELP = [
  "터미널에서 claude update를 실행해 최신 버전으로 올리세요.",
  "그래도 버전이 그대로면 옛 설치가 PATH 앞에 있는 것입니다. 위에 나온 경로의 claude를 지우고 아래 방법으로 다시 설치하세요.",
  ...CLAUDE_INSTALL_HELP,
];

/** "2.1.325 (Claude Code)"에서 버전 숫자를 꺼낸다. 형식이 다르면 null. */
export function parseClaudeVersion(text: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isOlder(version: readonly [number, number, number], min: readonly [number, number, number]): boolean {
  const [a, b, c] = version;
  const [x, y, z] = min;
  return a !== x ? a < x : b !== y ? b < y : c < z;
}

/** 레포 안이면 레포 기준 경로, 밖이면 전체 경로. */
export function relative(file: string): string {
  return isInsideOrEqual(file, REPO_ROOT) && !isSamePath(file, REPO_ROOT) ? path.relative(REPO_ROOT, file) : file;
}

/** PATH에서 claude를 찾고 --version으로 실행되는지 본다. 찾은 경로와 결과 줄을 돌려준다. env는 claude를 부를 환경 변수(없으면 지금 그대로). */
export function checkClaude(env?: NodeJS.ProcessEnv): { claude: string; detail: string } {
  const claude = findHere("claude");
  if (claude === null) throw new StepFailure("PATH에서 claude 명령을 찾지 못했습니다.", CLAUDE_INSTALL_HELP);
  const result = capture(claude, ["--version"], { cwd: REPO_ROOT, env });
  if (result.status !== 0) {
    throw new StepFailure(`claude --version이 실패했습니다(종료 코드 ${result.status}). ${result.stderr.trim()}`, CLAUDE_INSTALL_HELP);
  }
  const shown = result.stdout.trim();
  const version = parseClaudeVersion(shown);
  if (version === null) throw new StepFailure(`claude --version의 답(${shown})에서 버전을 읽지 못했습니다. (${claude})`, CLAUDE_UPDATE_HELP);
  if (isOlder(version, MIN_CLAUDE_VERSION)) {
    throw new StepFailure(`Claude Code가 오래됐습니다: ${shown}, ${claude}. 최신 버전으로 올려 주세요(${MIN_CLAUDE_VERSION.join(".")}보다 낮으면 실습 기록이 남지 않습니다).`, CLAUDE_UPDATE_HELP);
  }
  return { claude, detail: `통과 (${shown}, ${claude})` };
}

export function npmPath(): string {
  const npm = findHere("npm");
  if (npm === null) {
    throw new StepFailure("PATH에서 npm 명령을 찾지 못했습니다.", ["npm은 Node와 함께 설치됩니다. Node를 다시 설치하거나 PATH를 확인하세요."]);
  }
  return npm;
}

function ensureDependencies(): string {
  let state;
  try {
    state = checkInstalledDependencies(REPO_ROOT);
  } catch (error) {
    if (error instanceof LockfileError) throw new StepFailure(error.message, ["레포 파일이 깨졌습니다. git status로 확인하거나 레포를 다시 받으세요."]);
    throw error;
  }
  if (state.installed) return "이미 설치됨, 건너뜀";
  console.log(`  ${state.reason}. npm ci를 실행합니다.`);
  const code = runVisible(npmPath(), ["ci"], { cwd: REPO_ROOT });
  if (code !== 0) {
    throw new StepFailure(
      `npm ci가 실패했습니다(종료 코드 ${code}). 위 npm 출력을 확인하세요.`,
      ["네트워크(사내망 프록시·방화벽)를 확인한 뒤 다시 시도하세요."],
    );
  }
  const after = checkInstalledDependencies(REPO_ROOT);
  if (!after.installed) throw new StepFailure(`npm ci가 끝났지만 설치 상태가 package-lock.json과 맞지 않습니다: ${after.reason}.`);
  return "새로 설치함 (npm ci)";
}

/** DB 경로는 API 설정 계약(apps/api/src/config.ts)으로 구한다. 앱처럼 .env 값보다 이미 있는 환경 변수가 앞선다. */
export async function databasePath(): Promise<string> {
  const { loadConfig, ConfigError } = await import("../../../apps/api/src/config.ts");
  const envFile = path.join(REPO_ROOT, ".env");
  const fromFile = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
  try {
    return loadConfig({ ...fromFile, ...process.env }).databasePath;
  } catch (error) {
    if (error instanceof ConfigError) throw new StepFailure(`${error.message}. .env를 확인하세요.`);
    throw error;
  }
}

async function ensureDatabase(): Promise<string> {
  const file = await databasePath();
  if (existsSync(file)) return `이미 있음, 건너뜀 (${relative(file)})`;
  console.log(`  ${relative(file)} 파일이 없어 npm run db:reset으로 만들고 시드를 채웁니다.`);
  const code = runVisible(npmPath(), ["run", "db:reset"], { cwd: REPO_ROOT });
  if (code !== 0) throw new StepFailure(`npm run db:reset이 실패했습니다(종료 코드 ${code}). 위 출력을 확인하세요.`);
  if (!existsSync(file)) throw new StepFailure(`npm run db:reset이 끝났지만 ${relative(file)} 파일이 없습니다.`);
  return `새로 만듦 (npm run db:reset): ${relative(file)}`;
}

function ensureEnvFile(): string {
  const envFile = path.join(REPO_ROOT, ".env");
  if (existsSync(envFile)) return "이미 있음, 건너뜀";
  const example = path.join(REPO_ROOT, ".env.example");
  if (!existsSync(example)) {
    throw new StepFailure(".env.example 파일이 없습니다.", ["레포 파일이 빠졌습니다. git status로 확인하거나 레포를 다시 받으세요."]);
  }
  copyFileSync(example, envFile, fsConstants.COPYFILE_EXCL);
  return ".env.example에서 복사함";
}

/** scripts/setup.mjs가 Node를 확인한 뒤 부른다. 프로세스 종료 코드를 돌려준다. */
export async function runSetup(): Promise<number> {
  const steps: Step[] = [
    { name: "claude 명령 확인", run: () => checkClaude().detail },
    { name: "의존성", run: ensureDependencies },
    { name: "DB", run: ensureDatabase },
    { name: ".env", run: ensureEnvFile },
  ];
  if (!(await runSteps(SCRIPT, steps, 2, TOTAL_STEPS))) return 1;
  console.log("\n준비가 끝났습니다. 이제 npm run claude로 실습을 시작하세요.");
  return 0;
}
