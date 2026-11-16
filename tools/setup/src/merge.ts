// npm run merge <브랜치>: 지금 브랜치에 <브랜치>를 합치기 전에, PR 검사(npm run ci)와 같은 검사를 그 브랜치의 커밋에 돌린다.
// GitHub를 못 쓸 때 "검사를 통과해야 머지"를 내 컴퓨터에서 대신한다. 채점 기준은 지금 브랜치다(npm run ci -- <커밋> --base <지금 브랜치>).
// Node 확인(scripts/merge.mjs가 먼저 함) → 지금 상태 확인 → 검사 → 합치기(git merge --no-ff).
// 검사가 실패하거나 돌릴 수 없으면 합치지 않는다.
// 커밋 안 한 변경이 있거나, 브랜치가 아닌 커밋에 있거나, <브랜치>가 없거나 이미 합쳐졌으면 아무것도 바꾸지 않고 멈춘다.
// 합치다 충돌이 나면 git merge --abort로 합치기 전으로 되돌린다.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { capture, type Captured } from "./command.ts";
import { REPO_ROOT } from "./paths.ts";
import { runSteps, StepFailure, type Step } from "./report.ts";

const SCRIPT = "merge.mjs";
export const TOTAL_STEPS = 4;
const USAGE = "쓰는 법: npm run merge <브랜치> (예: npm run merge feat/order-cancel)";
const UNCHANGED = "아무것도 바꾸지 않았습니다.";

/** npm run ci의 종료 코드(0 통과, 1 실패, 2 돌릴 수 없음, 128+신호 중간에 멈춤)와, 실패했으면 그 단계 키(scripts/ci.mjs의 steps). */
export interface CheckResult {
  code: number;
  failed: string | null;
}

export type RunCheck = (repo: string, commit: string, base: string) => Promise<CheckResult>;

/** ci.mjs 단계 키별 이름과, 그 단계만 다시 돌려 보는 명령. */
function stepHelp(key: string, base: string): { name: string; command: string | null } {
  switch (key) {
    case "checkout":
      return { name: "커밋 꺼내기", command: null };
    case "dependencies":
      return { name: "의존성", command: "npm ci" };
    case "node":
      return { name: "Node 확인", command: "node --version" };
    case "typecheck":
      return { name: "타입 검사", command: "npm run typecheck" };
    case "lint":
      return { name: "lint", command: "npm run lint" };
    case "test":
      return { name: "테스트", command: "npm test" };
    case "build":
      return { name: "빌드", command: "npm run build" };
    case "grade":
      return { name: "채점", command: `npm run grade -- --since ${base}` };
    default:
      throw new Error(`npm run ci가 모르는 단계 키(${key})를 실패로 남겼습니다.`);
  }
}

/** 진짜 검사: scripts/ci.mjs를 그 커밋에 돌리고, 결과 파일에서 실패한 단계를 읽는다. 출력은 터미널에 그대로 보인다. */
export const runCi: RunCheck = async (repo, commit, base) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "shop-merge-"));
  const resultFile = path.join(dir, "result.json");
  // Ctrl+C는 같은 터미널의 ci도 받는다. ci가 임시 폴더를 치우고 끝날 때까지 기다렸다가 그 종료 코드로 알린다.
  const waitForCi = (): void => undefined;
  process.on("SIGINT", waitForCi);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join("scripts", "ci.mjs"), commit, "--base", base, "--result", resultFile], { cwd: repo, stdio: "inherit" });
      child.on("error", reject);
      child.on("exit", (exitCode, signal) => {
        resolve(exitCode ?? (signal === null ? 1 : 128 + os.constants.signals[signal]));
      });
    });
    if (code !== 1) return { code, failed: null };
    if (!existsSync(resultFile)) throw new Error("npm run ci가 실패했는데 결과 파일을 남기지 않았습니다.");
    const result = JSON.parse(readFileSync(resultFile, "utf8")) as { failed: string | null };
    return { code, failed: result.failed };
  } finally {
    process.off("SIGINT", waitForCi);
    rmSync(dir, { recursive: true, force: true });
  }
};

function run(repo: string, args: readonly string[]): Captured {
  return capture("git", args, { cwd: repo });
}

function git(repo: string, args: readonly string[]): string {
  const result = run(repo, args);
  if (result.status !== 0) throw new StepFailure(`git ${args.join(" ")}이 실패했습니다. ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "");
}

function refuse(reason: string, help: readonly string[] = []): StepFailure {
  return new StepFailure(reason, [...help, UNCHANGED]);
}

function short(commit: string): string {
  return commit.slice(0, 7);
}

export interface MergePlan {
  /** 지금 브랜치. 합친 결과가 여기에 생기고, 채점 기준점이 된다. */
  current: string;
  /** 합칠 브랜치. */
  branch: string;
  /** 검사하고 합칠 <브랜치>의 커밋. */
  commit: string;
  /** 지금 브랜치의 커밋. */
  head: string;
  /** 지금 브랜치에 없는 <브랜치>의 커밋 수. */
  ahead: number;
}

/** 합칠 수 있는 상태인지 본다. 아니면 이유와 할 일을 담아 멈춘다. 아무것도 바꾸지 않는다. */
export function planMerge(repo: string, branch: string): MergePlan {
  const symbolic = run(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (symbolic.status !== 0) throw refuse("지금은 브랜치가 아닌 커밋에 있어서 어디에 합칠지 모릅니다.", ["합쳐 넣을 실습 브랜치로 먼저 옮기세요. 예: git switch day2-a"]);
  const current = symbolic.stdout.trim();
  const commit = run(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]).stdout.trim();
  if (commit === "") {
    const names = lines(git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])).filter((name) => name !== current);
    throw refuse(`${branch} 브랜치가 없습니다.`, [`합칠 수 있는 브랜치: ${names.length > 0 ? names.join(", ") : "없음"}`]);
  }
  if (branch === current) throw refuse(`${branch} 브랜치는 지금 있는 브랜치입니다. 합칠 다른 브랜치를 적으세요.`, [USAGE]);
  const changed = lines(run(repo, ["-c", "core.quotepath=off", "status", "--porcelain", "--untracked-files=all"]).stdout).map((line) => line.slice(3));
  if (changed.length > 0) {
    const shown = changed.slice(0, 5).join(", ") + (changed.length > 5 ? ` 외 ${changed.length - 5}개` : "");
    throw refuse(`커밋하지 않은 변경 ${changed.length}개가 있습니다(${shown}).`, ["합치기는 커밋한 것끼리만 합니다. 커밋하거나(git add, git commit) 되돌린 뒤 다시 실행하세요."]);
  }
  const head = git(repo, ["rev-parse", "HEAD"]);
  if (run(repo, ["merge-base", "--is-ancestor", commit, head]).status === 0) {
    throw refuse(`${branch} 브랜치(${short(commit)})는 이미 ${current}에 합쳐져 있습니다.`, [`합칠 새 커밋이 없습니다. ${branch}에 고친 것을 커밋했는지 확인하세요.`]);
  }
  const ahead = Number(git(repo, ["rev-list", "--count", `${head}..${commit}`]));
  return { current, branch, commit, head, ahead };
}

function checkFailure(plan: MergePlan, result: CheckResult): StepFailure {
  const { branch, current } = plan;
  const again = `다시 할 일: ${branch} 브랜치로 옮겨(git switch ${branch}) 고치고 커밋한 뒤, ${current} 브랜치로 돌아와(git switch ${current}) npm run merge ${branch}를 다시 실행하세요.`;
  if (result.code === 1) {
    if (result.failed === null) throw new Error("npm run ci가 실패했는데 실패한 단계를 알려 주지 않았습니다.");
    const step = stepHelp(result.failed, current);
    const tryAlone = step.command === null ? [] : [`그 단계만 먼저 돌려 보기: ${branch}에서 ${step.command}`];
    return refuse(`"${step.name}" 단계에서 실패해서 ${branch} 브랜치를 ${current}에 합치지 않았습니다. 실패 내용은 위 검사 출력에 있습니다.`, [again, ...tryAlone]);
  }
  if (result.code === 2) return refuse(`검사를 돌릴 수 없어서 ${branch} 브랜치를 합치지 않았습니다. 이유는 위 [ci] 줄에 있습니다.`);
  return refuse(`검사가 중간에 멈춰서(종료 코드 ${result.code}) ${branch} 브랜치를 합치지 않았습니다.`, [`다시 실행하세요: npm run merge ${branch}`]);
}

/** git merge --no-ff. 충돌하면 git merge --abort로 되돌리고 충돌한 파일과 할 일을 담아 멈춘다. */
function mergeBranch(repo: string, plan: MergePlan): string {
  const { branch, current } = plan;
  if (git(repo, ["rev-parse", `refs/heads/${branch}`]) !== plan.commit || git(repo, ["rev-parse", "HEAD"]) !== plan.head) {
    throw refuse(`검사하는 동안 ${branch}나 ${current}에 새 커밋이 생겼습니다. 검사한 것과 합칠 것이 달라 멈춥니다.`, [`다시 실행하세요: npm run merge ${branch}`]);
  }
  const merged = run(repo, ["merge", "--no-ff", "--no-edit", branch]);
  if (merged.status === 0) return git(repo, ["rev-parse", "HEAD"]);
  const conflicted = lines(git(repo, ["-c", "core.quotepath=off", "diff", "--name-only", "--diff-filter=U"]));
  if (run(repo, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]).status === 0) git(repo, ["merge", "--abort"]);
  if (conflicted.length === 0) throw refuse(`git merge가 실패했습니다. ${(merged.stderr || merged.stdout).trim()}`);
  throw refuse(`${branch} 브랜치와 ${current} 브랜치가 같은 곳을 다르게 고쳐 충돌했습니다(${conflicted.join(", ")}). git merge --abort로 합치기 전으로 되돌렸습니다.`, [
    `다시 할 일: ${branch} 브랜치에서 git merge ${current}를 실행해 ${current}의 변경을 먼저 받고, 충돌을 풀어 커밋한 뒤, ${current} 브랜치로 돌아와(git switch ${current}) npm run merge ${branch}를 다시 실행하세요.`,
  ]);
}

export interface MergeOptions {
  repo?: string;
  /** 검사를 돌리는 함수. 테스트는 가짜를 넣는다. */
  runCheck?: RunCheck;
}

/** scripts/merge.mjs가 Node를 확인한 뒤 부른다. 종료 코드(0 합침, 1 합치지 않음)를 돌려준다. */
export async function runMerge(argv: readonly string[], options: MergeOptions = {}): Promise<number> {
  const repo = options.repo ?? REPO_ROOT;
  const runCheck = options.runCheck ?? runCi;
  if (argv.length !== 1 || argv[0]?.startsWith("-") === true) {
    console.error(`${SCRIPT}: 합칠 브랜치 하나를 적으세요. ${USAGE}`);
    return 1;
  }
  const branch = argv[0] as string;
  const found: { plan: MergePlan | null; merged: string | null } = { plan: null, merged: null };
  const need = (): MergePlan => {
    if (found.plan === null) throw new Error("지금 상태 확인 전에 다음 단계를 돌렸습니다.");
    return found.plan;
  };
  const steps: Step[] = [
    {
      name: "지금 상태 확인",
      run: () => {
        const plan = planMerge(repo, branch);
        found.plan = plan;
        return `${plan.current}에 ${branch} 브랜치(${short(plan.commit)}, 새 커밋 ${plan.ahead}개)를 합칩니다. 커밋 안 한 변경 없음`;
      },
    },
    {
      name: "검사",
      run: async () => {
        const plan = need();
        console.log(`\n${branch}의 커밋 ${short(plan.commit)}에 PR 검사와 같은 검사를 돌립니다. 채점 기준은 ${plan.current}입니다(npm run ci -- ${short(plan.commit)} --base ${plan.current}).`);
        const result = await runCheck(repo, plan.commit, plan.current);
        if (result.code !== 0) throw checkFailure(plan, result);
        return `통과 (커밋 ${short(plan.commit)} · 타입 검사·lint·테스트·빌드·채점)`;
      },
    },
    {
      name: "합치기",
      run: () => {
        const plan = need();
        found.merged = mergeBranch(repo, plan);
        return `통과 (git merge --no-ff ${branch} → ${plan.current} ${short(found.merged)})`;
      },
    },
  ];
  if (!(await runSteps(SCRIPT, steps, 2, TOTAL_STEPS))) return 1;
  const plan = need();
  console.log(`\n${branch} 브랜치를 ${plan.current}에 합쳤습니다. 들어간 커밋 ${short(plan.commit)}는 검사를 통과했습니다.`);
  return 0;
}
