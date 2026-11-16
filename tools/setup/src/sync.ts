// npm run sync [-- <브랜치>] [--yes]: 실습 브랜치를 원격의 최신 상태로 새로 맞춘다.
// 실습하다 꼬였을 때, 또는 강사가 자료를 고친 뒤 새로 받을 때 쓴다.
// 받는 곳은 강사 레포다. docs/github.md대로 fork를 이어 강사 레포가 upstream이 됐으면 upstream에서, 아니면 origin에서 받는다.
// Node 확인(scripts/sync.mjs가 먼저 함) → 원격 받기 → 지금 상태 확인 → 확인(y/N) → 브랜치 맞추기 → DB 되돌리기.
// 바뀐 파일과 원격에 없는 커밋은 보관하지 않고 버린다. 그래서 무엇을 버리는지 먼저 보여 주고 확인을 받는다.
// git이 무시하는 파일(node_modules·.env·data·.observer)은 그대로 둔다.
import { capture, runVisible } from "./command.ts";
import { REPO_ROOT } from "./paths.ts";
import { confirmChange, runSteps, StepFailure, type Step } from "./report.ts";
import { npmPath } from "./setup.ts";

const SCRIPT = "sync.mjs";
export const TOTAL_STEPS = 5;

function git(repo: string, args: readonly string[]): string {
  const result = capture("git", args, { cwd: repo });
  if (result.status !== 0) throw new StepFailure(`git ${args.join(" ")}이 실패했습니다. ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "");
}

export interface SyncPlan {
  /** 받은 원격 이름(upstream 또는 origin). */
  source: string;
  /** 지금 브랜치. 브랜치가 아닌 커밋에 있으면 null. */
  current: string | null;
  /** 끝나고 있을 브랜치. */
  target: string;
  /** 지금 바뀐 파일(새 파일 포함). 버린다. */
  changed: string[];
  /** 원격 브랜치를 따라가는 로컬 브랜치. 모두 원격 최신으로 맞춘다. */
  tracked: string[];
  /** 그중 원격에 없는 커밋이 있는 브랜치. 그 커밋은 버린다. */
  ahead: string[];
}

/** 강사 레포를 가리키는 원격. fork를 이었으면(docs/github.md) 강사 레포는 upstream이고 origin은 내 fork다. */
export function sourceRemote(repo: string): string {
  return lines(git(repo, ["remote"])).includes("upstream") ? "upstream" : "origin";
}

/** 강사 레포의 브랜치와 태그를 받는다. 이미 있는 태그도 원격 값으로 바꾼다(강사가 시작 태그를 옮겼을 수 있다). */
export function fetchSource(repo: string, source: string): void {
  git(repo, ["fetch", source, "--prune", "--tags", "--force"]);
}

export function planSync(repo: string, source: string, target: string | undefined): SyncPlan {
  const head = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const current = head === "HEAD" ? null : head;
  const prefix = `${source}/`;
  const remote = new Set(lines(git(repo, ["for-each-ref", "--format=%(refname:short)", `refs/remotes/${source}`])).map((ref) => ref.slice(prefix.length)));
  const goal = target ?? current;
  if (goal === null) throw new StepFailure("지금은 브랜치가 아닌 커밋에 있어서 어느 브랜치로 맞출지 모릅니다.", ["브랜치를 지정하세요. 예: npm run sync -- day1-a"]);
  if (!remote.has(goal)) {
    const names = Array.from(remote).filter((name) => name !== "HEAD" && name !== "" && name !== source).sort();
    throw new StepFailure(`${source}에 ${goal} 브랜치가 없습니다.`, [`있는 브랜치: ${names.join(", ")}`]);
  }
  const tracked: string[] = [];
  const ahead: string[] = [];
  for (const row of lines(git(repo, ["for-each-ref", "--format=%(refname:short) %(upstream:short)", "refs/heads"]))) {
    const [branch, upstream] = row.split(" ");
    // fork를 이은 뒤에는 같은 이름 브랜치가 upstream이나 내 fork(origin)를 따라간다. 어느 쪽이든 강사 레포 최신으로 맞춘다.
    if (branch === undefined || (upstream !== `${source}/${branch}` && upstream !== `origin/${branch}`) || !remote.has(branch)) continue;
    tracked.push(branch);
    if (git(repo, ["rev-list", "--count", `${source}/${branch}..${branch}`]) !== "0") ahead.push(branch);
  }
  const changed = lines(capture("git", ["status", "--porcelain"], { cwd: repo }).stdout).map((line) => line.slice(3));
  return { source, current, target: goal, changed, tracked, ahead };
}

/** 바뀐 파일을 버리고, 따라가는 브랜치를 모두 강사 레포 최신으로 맞춘 뒤 target으로 옮긴다. */
export function alignBranches(repo: string, plan: SyncPlan): void {
  const source = plan.source;
  git(repo, ["reset", "--hard"]);
  git(repo, ["clean", "-fd"]);
  for (const branch of plan.tracked) {
    if (branch === plan.current) git(repo, ["reset", "--hard", `${source}/${branch}`]);
    else git(repo, ["branch", "-f", branch, `${source}/${branch}`]);
  }
  if (plan.target === plan.current) return;
  if (plan.tracked.includes(plan.target)) git(repo, ["switch", plan.target]);
  else git(repo, ["switch", "--track", "-c", plan.target, `${source}/${plan.target}`]);
}

function parseArgs(argv: readonly string[]): { target: string | undefined; yes: boolean } {
  const yes = argv.includes("--yes");
  const rest = argv.filter((arg) => arg !== "--yes");
  if (rest.some((arg) => arg.startsWith("-")) || rest.length > 1) throw new StepFailure(`모르는 옵션 ${rest.join(" ")}. 쓰는 법: npm run sync [-- <브랜치>] [--yes]`);
  return { target: rest[0], yes };
}

export interface SyncOptions {
  repo?: string;
  /** DB 되돌리기를 부르는 함수. 테스트는 가짜를 넣는다. */
  resetDatabase?: (repo: string) => number;
}

/** scripts/sync.mjs가 Node를 확인한 뒤 부른다. 종료 코드를 돌려준다. */
export async function runSync(argv: readonly string[], options: SyncOptions = {}): Promise<number> {
  const repo = options.repo ?? REPO_ROOT;
  const resetDatabase = options.resetDatabase ?? ((cwd: string) => runVisible(npmPath(), ["run", "db:reset"], { cwd }));
  let args: { target: string | undefined; yes: boolean };
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`${SCRIPT}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const found: { source: string; plan: SyncPlan | null } = { source: "origin", plan: null };
  const inspect: Step[] = [
    {
      name: "원격 받기",
      run: () => {
        found.source = sourceRemote(repo);
        fetchSource(repo, found.source);
        return `통과 (${found.source}에서 브랜치·시작 태그 최신으로 받음)`;
      },
    },
    {
      name: "지금 상태 확인",
      run: () => {
        const plan = planSync(repo, found.source, args.target);
        found.plan = plan;
        return `지금 ${plan.current ?? "브랜치 아님"} · 바뀐 파일 ${plan.changed.length}개 · 원격에 없는 커밋이 있는 브랜치 ${plan.ahead.length}개`;
      },
    },
  ];
  if (!(await runSteps(SCRIPT, inspect, 2, TOTAL_STEPS)) || found.plan === null) return 1;
  const plan = found.plan;
  const shown = plan.changed.slice(0, 5).join(", ") + (plan.changed.length > 5 ? ` 외 ${plan.changed.length - 5}개` : "");
  const notice = [
    `실습 브랜치 ${plan.tracked.length}개를 ${plan.source} 최신으로 새로 맞추고 ${plan.target} 브랜치로 옮깁니다. DB도 시드 상태로 되돌립니다.`,
    plan.changed.length > 0 ? `바뀐 파일 ${plan.changed.length}개(${shown})는 버립니다.` : "바뀐 파일은 없습니다.",
    plan.ahead.length > 0 ? `원격에 없는 커밋이 있는 브랜치(${plan.ahead.join(", ")})의 그 커밋도 버립니다.` : "원격에 없는 커밋은 없습니다.",
  ];
  if (!(await confirmChange(notice, args.yes, "npm run sync -- --yes"))) {
    console.log("아무것도 바꾸지 않았습니다.");
    return 1;
  }
  const lockBefore = git(repo, ["rev-parse", "HEAD:package-lock.json"]);
  const apply: Step[] = [
    {
      name: "브랜치 맞추기",
      run: () => {
        alignBranches(repo, plan);
        return `${plan.target} (${git(repo, ["rev-parse", "--short", "HEAD"])}) · 브랜치 ${plan.tracked.length}개 ${plan.source} 최신`;
      },
    },
    {
      name: "DB 되돌리기",
      run: () => {
        const code = resetDatabase(repo);
        if (code !== 0) throw new StepFailure(`npm run db:reset이 실패했습니다(종료 코드 ${code}). 위 출력을 확인하세요.`, ["브랜치는 이미 맞췄습니다. DB만 다시 되돌리려면 npm run db:reset을 실행하세요."]);
        return "시드 상태로 되돌림";
      },
    },
  ];
  if (!(await runSteps(SCRIPT, apply, 4, TOTAL_STEPS))) return 1;
  console.log(`\n${plan.target} 브랜치를 ${plan.source} 최신 상태로 새로 맞췄습니다.`);
  if (git(repo, ["rev-parse", "HEAD:package-lock.json"]) !== lockBefore) console.log("의존성 목록이 바뀌었습니다. npm ci를 실행한 뒤 시작하세요.");
  return 0;
}
