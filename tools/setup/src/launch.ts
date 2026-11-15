// npm run loop(scripts/loop.mjs)가 이슈 worktree에서 claude를 띄울 때 쓴다.
// 설정 파일 모양은 npm run claude(claude.ts)가 내보내는 것을 그대로 써서 두 길이 같은 지침만 읽는다.
// claude.ts는 main과 같게 둔다. 그 실행 함수는 레포 폴더에서만 띄우므로 worktree에서 띄우는 것만 여기 있다.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LAUNCH_SETTINGS_FILE, outsideInstructionExcludes } from "./claude.ts";
import { spawnInteractive } from "./command.ts";
import { claudeEnv } from "./paths.ts";

/**
 * npm run claude와 같은 실습 설정 파일(레포 바깥 위쪽 폴더의 지침 빼기)을 실습 설정 폴더에 쓰고 `--settings` 인자를 돌려준다.
 * cwd는 세션이 뜰 폴더다. 그 위쪽 폴더의 지침을 뺀다.
 * 내용이 같으면 다시 쓰지 않는다. 옆에서 도는 세션이 막 읽는 파일을 비우지 않기 위해서다.
 */
export function launchSettingsArgs(configDir: string, cwd: string): string[] {
  const file = path.join(configDir, LAUNCH_SETTINGS_FILE);
  const content = `${JSON.stringify({ claudeMdExcludes: outsideInstructionExcludes(cwd) }, null, 2)}\n`;
  if (!existsSync(file) || readFileSync(file, "utf8") !== content) writeFileSync(file, content);
  return ["--settings", file];
}

/**
 * claude를 실습 설정 파일과 함께 터미널에 그대로 붙여 cwd에서 띄우고 종료 코드를 돌려준다.
 * Ctrl+C는 터미널이 부모와 claude 모두에게 보내므로 부모는 SIGINT를 무시해 claude보다 먼저 죽지 않는다.
 * 터미널이 닫히거나(SIGHUP) 종료 요청(SIGTERM)을 받으면 claude에 넘기고 claude가 끝나기를 기다린다.
 */
export function launchClaudeIn(cwd: string, claude: string, configDir: string, claudeArgs: readonly string[]): Promise<number> {
  const args = [...launchSettingsArgs(configDir, cwd), ...claudeArgs];
  console.log(`claude 실행: CLAUDE_CONFIG_DIR=${configDir} claude ${args.join(" ")}\n`);

  return new Promise((resolve) => {
    const child = spawnInteractive(claude, args, { cwd, env: claudeEnv(configDir) });
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
      console.error(`\nclaude를 시작하지 못했습니다. ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      release();
      if (code !== null) resolve(code);
      else resolve(128 + (signal === null ? 0 : os.constants.signals[signal]));
    });
  });
}
