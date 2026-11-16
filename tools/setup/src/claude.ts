// npm run claude [-- claude에 넘길 옵션...]: 실습 설정 폴더(~/.claude-workshop)로 claude를 띄운다. 원래 ~/.claude는 건드리지 않는다.
// Node 확인(scripts/claude.mjs가 먼저 함) → 실습 설정 폴더 위치 → claude 명령 → 준비 확인 → claude 실행.
// 위치 확인은 부작용이 있는 어떤 단계보다 먼저 한다. 설치·DB·.env는 만들지 않고, 안 돼 있으면 npm run setup을 먼저 하라고 알린다.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnInteractive } from "./command.ts";
import { claudeEnv, REPO_ROOT, resolvePracticeConfigDir } from "./paths.ts";
import { runSteps, StepFailure, type Step } from "./report.ts";
import { checkClaude, databasePath, gatewayHint, relative } from "./setup.ts";

const SCRIPT = "claude.mjs";
export const TOTAL_STEPS = 4;
const SETUP_FIRST = ["먼저 `npm run setup`을 실행한 뒤 다시 `npm run claude`를 실행하세요."];

/** 설치(node_modules)·DB·.env가 준비됐는지만 본다. 하나라도 없으면 npm run setup을 먼저 하라고 멈춘다. */
async function checkPrepared(): Promise<string> {
  const missing: string[] = [];
  const installed = existsSync(path.join(REPO_ROOT, "node_modules", ".package-lock.json"));
  if (!installed) missing.push("의존성(node_modules)");
  if (!existsSync(path.join(REPO_ROOT, ".env"))) missing.push(".env");
  // DB 경로는 설정 코드(zod 필요)가 구하므로 설치돼 있을 때만 본다. 설정이 깨졌으면 그 오류가 그대로 멈춘다.
  if (installed) {
    const file = await databasePath();
    if (!existsSync(file)) missing.push(`DB(${relative(file)})`);
  }
  if (missing.length > 0) throw new StepFailure(`준비가 안 됐습니다. 없는 것: ${missing.join(", ")}.`, SETUP_FIRST);
  return "통과 (의존성·DB·.env 있음)";
}

/** npm run claude가 실습 설정 폴더에 써 두고 --settings로 붙이는 파일. 띄울 때마다 다시 쓴다. */
export const LAUNCH_SETTINGS_FILE = "workshop-settings.json";

/**
 * 레포 바깥 위쪽 폴더들의 지침 파일 경로(Claude Code의 claudeMdExcludes 형식).
 * Claude Code는 레포에서 위로 올라가며 폴더마다 CLAUDE.md·CLAUDE.local.md·.claude/CLAUDE.md·.claude/rules를 프로젝트 지침으로 읽는다.
 * 레포가 홈 아래 있으면 평소 계정의 ~/.claude/CLAUDE.md가 이 길로 섞이므로, 실습 세션에는 레포 안 지침만 읽히게 뺀다.
 */
export function outsideInstructionExcludes(repoRoot: string): string[] {
  const patterns: string[] = [];
  let dir = path.dirname(repoRoot);
  for (;;) {
    const base = dir.replaceAll("\\", "/").replace(/\/$/, "");
    patterns.push(`${base}/CLAUDE.md`, `${base}/CLAUDE.local.md`, `${base}/.claude/CLAUDE.md`, `${base}/.claude/rules/**`);
    const parent = path.dirname(dir);
    if (parent === dir) return patterns;
    dir = parent;
  }
}

/**
 * claude를 터미널에 그대로 붙여 띄우고 종료 코드를 돌려준다.
 * Ctrl+C는 터미널이 부모와 claude 모두에게 보내므로 부모는 SIGINT를 무시해 claude보다 먼저 죽지 않는다.
 * 터미널이 닫히거나(SIGHUP) 종료 요청(SIGTERM)을 받으면 claude에 넘기고 claude가 끝나기를 기다린다.
 */
function launchClaude(claude: string, configDir: string, claudeArgs: readonly string[]): Promise<number> {
  const settingsFile = path.join(configDir, LAUNCH_SETTINGS_FILE);
  writeFileSync(settingsFile, `${JSON.stringify({ claudeMdExcludes: outsideInstructionExcludes(REPO_ROOT) }, null, 2)}\n`);
  const args = ["--settings", settingsFile, ...claudeArgs];
  console.log(`claude 실행: CLAUDE_CONFIG_DIR=${configDir} claude ${args.join(" ")}`);
  console.log("(레포 바깥 폴더의 CLAUDE.md는 읽지 않게 했습니다. 이 레포의 지침만 읽힙니다.)\n");

  return new Promise((resolve) => {
    const child = spawnInteractive(claude, args, { cwd: REPO_ROOT, env: claudeEnv(configDir) });
    const ignoreInterrupt = (): void => undefined;
    const forward = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };
    process.on("SIGINT", ignoreInterrupt);
    process.on("SIGTERM", forward);
    process.on("SIGHUP", forward);
    const release = (): void => {
      process.off("SIGINT", ignoreInterrupt);
      process.off("SIGTERM", forward);
      process.off("SIGHUP", forward);
    };
    child.on("error", (error) => {
      release();
      console.error(`\n${SCRIPT}: claude를 시작하지 못했습니다. ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      release();
      if (code !== null) resolve(code);
      else resolve(128 + (signal === null ? 0 : os.constants.signals[signal]));
    });
  });
}

/** scripts/claude.mjs가 Node를 확인한 뒤 부른다. claude의 종료 코드(준비 단계가 멈추면 1)를 돌려준다. */
export async function runClaude(argv: readonly string[]): Promise<number> {
  let claude = "";
  let configDir = "";
  // 단계 콜백 안에서 바꾸므로, 상수로 좁혀지지 않게 객체에 담는다.
  const practiceDir = { created: false };
  const steps: Step[] = [
    {
      name: "실습 설정 폴더 위치",
      run: () => {
        configDir = resolvePracticeConfigDir();
        const existed = existsSync(configDir);
        practiceDir.created = !existed;
        mkdirSync(configDir, { recursive: true });
        return `통과 (${configDir}, ${existed ? "있음" : "새로 만듦"}, 원래 설정·레포와 겹치지 않음)`;
      },
    },
    {
      name: "claude 명령 확인",
      run: () => {
        const found = checkClaude(claudeEnv(configDir));
        claude = found.claude;
        return found.detail;
      },
    },
    { name: "준비 확인", run: checkPrepared },
  ];
  if (!(await runSteps(SCRIPT, steps, 2, TOTAL_STEPS))) return 1;
  // 실습 폴더를 처음 만든 때는 곧 로그인 화면이 나온다. setup의 안내를 놓친 게이트웨이 사용자를 위해 한 번 더 알린다.
  if (practiceDir.created) for (const line of gatewayHint(path.join(configDir, "settings.json"))) console.log(`(${line})`);
  return launchClaude(claude, configDir, argv);
}
