// setup.mjs의 단계 줄. 모양은 tools/setup/node-check.mjs와 같다.
import { createInterface } from "node:readline/promises";

/** 단계를 멈추게 하는 실패. 이유와 사용자가 할 일(설치 링크 등)을 담는다. */
export class StepFailure extends Error {
  readonly help: readonly string[];
  constructor(reason: string, help: readonly string[] = []) {
    super(reason);
    this.name = "StepFailure";
    this.help = help;
  }
}

export interface Step {
  name: string;
  /** 성공하면 결과 한 줄(예: "새로 만듦: data/grabmarket.sqlite")을 돌려준다. 실패는 StepFailure로 던진다. */
  run: () => string | Promise<string>;
}

/**
 * 단계를 차례로 돌리며 결과 줄을 찍는다. 하나라도 실패하면 단계 이름·이유·할 일을 찍고 false.
 * firstIndex는 화면에 보일 첫 단계 번호다(Node 확인은 .mjs가 먼저 찍는다).
 */
export async function runSteps(script: string, steps: readonly Step[], firstIndex: number, total: number): Promise<boolean> {
  for (const [offset, step] of steps.entries()) {
    const label = `[${firstIndex + offset}/${total}] ${step.name}`;
    try {
      const detail = await step.run();
      console.log(`${label}: ${detail}`);
    } catch (error) {
      console.error(`${label}: 실패`);
      if (error instanceof StepFailure) {
        console.error(`  이유: ${error.message}`);
        for (const line of error.help) console.error(`  ${line}`);
      } else {
        console.error(`  이유: 예상하지 못한 오류입니다. ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      }
      console.error(`\n${script}가 "${step.name}" 단계에서 멈췄습니다.`);
      return false;
    }
  }
  return true;
}

/**
 * 무엇을 바꾸는지 보여 주고 y/N을 묻는다. --yes면 묻지 않고, 물을 수 없는 실행(TTY 아님)이면 바꾸지 않고 멈춘다.
 * yesCommand는 확인 없이 다시 실행하는 명령(예: "npm run sync -- --yes")이다.
 */
export async function confirmChange(lines: readonly string[], yes: boolean, yesCommand: string): Promise<boolean> {
  console.log("");
  for (const line of lines) console.log(line);
  if (yes) return true;
  if (!process.stdin.isTTY) {
    console.error(`\n확인을 받을 수 없는 실행이라 멈춥니다. 진행하려면 ${yesCommand} 로 실행하세요.`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("계속할까요? (y/N) ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
