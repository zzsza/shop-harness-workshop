// npm run claude:reset [-- --yes]: 실습 계정을 처음 상태로 돌린다. 원래 ~/.claude와 레포는 건드리지 않는다.
// Node 확인(scripts/claude-reset.mjs가 먼저 함) → 실습 설정 폴더 위치 → 확인(y/N) → 실습 계정 로그아웃 → 실습 설정 폴더 지우기.
// 로그아웃을 먼저 하는 까닭: Mac은 로그인을 폴더가 아니라 키체인에 설정 폴더별로 저장해서, 폴더만 지우면 같은 경로로 다시 열 때 로그인이 살아 있다.
import { existsSync, rmSync } from "node:fs";
import { capture } from "./command.ts";
import { claudeEnv, REPO_ROOT, resolvePracticeConfigDir } from "./paths.ts";
import { confirmChange, runSteps, StepFailure, type Step } from "./report.ts";
import { checkClaude } from "./setup.ts";

const SCRIPT = "claude-reset.mjs";
export const TOTAL_STEPS = 4;

/** scripts/claude-reset.mjs가 Node를 확인한 뒤 부른다. 종료 코드를 돌려준다. */
export async function runReset(argv: readonly string[]): Promise<number> {
  const unknown = argv.filter((a) => a !== "--yes");
  if (unknown.length > 0) {
    console.error(`${SCRIPT}: 모르는 옵션 ${unknown.join(" ")}. 쓸 수 있는 옵션은 --yes 하나입니다.`);
    return 1;
  }
  let configDir = "";
  const locate: Step = {
    name: "실습 설정 폴더 위치",
    run: () => {
      configDir = resolvePracticeConfigDir();
      return `통과 (${configDir}, ${existsSync(configDir) ? "있음" : "없음"}, 원래 설정·레포와 겹치지 않음)`;
    },
  };
  if (!(await runSteps(SCRIPT, [locate], 2, TOTAL_STEPS))) return 1;
  const lines = [`실습 계정(${configDir})에서 로그아웃하고 그 폴더를 지웁니다. 실습 대화 기록도 함께 지워집니다.`, "평소 계정(~/.claude)과 레포 파일은 그대로입니다."];
  if (!(await confirmChange(lines, argv.includes("--yes"), "npm run claude:reset -- --yes"))) {
    console.log("아무것도 바꾸지 않았습니다.");
    return 1;
  }
  const steps: Step[] = [
    {
      name: "실습 계정 로그아웃",
      run: () => {
        const { claude } = checkClaude(claudeEnv(configDir));
        const result = capture(claude, ["auth", "logout"], { cwd: REPO_ROOT, env: claudeEnv(configDir) });
        if (result.status !== 0) {
          throw new StepFailure(`claude auth logout이 실패했습니다(종료 코드 ${result.status}). ${result.stderr.trim()}`, [
            "폴더는 지우지 않았습니다. npm run claude로 열어 /logout을 입력한 뒤 다시 실행하세요.",
          ]);
        }
        return "통과 (실습 계정만 로그아웃, 평소 계정은 그대로)";
      },
    },
    {
      name: "실습 설정 폴더 지우기",
      run: () => {
        if (!existsSync(configDir)) return "없음, 건너뜀";
        rmSync(configDir, { recursive: true, force: true });
        return `지움 (${configDir})`;
      },
    },
  ];
  if (!(await runSteps(SCRIPT, steps, 3, TOTAL_STEPS))) return 1;
  console.log("\n실습 계정을 처음 상태로 돌렸습니다. npm run claude를 실행하면 로그인부터 다시 나옵니다.");
  return 0;
}
