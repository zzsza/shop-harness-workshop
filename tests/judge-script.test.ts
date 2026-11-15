// npm run judge(scripts/judge.mjs) 테스트. 기대값은 judge.mjs 머리말의 약속에서 왔다:
// 정답 브랜치의 숨은 테스트를 지금 작업 트리에 대고 돌려 이슈별 표를 보인다, 정답 브랜치가 없으면 이유와 받는 방법을 알리고 2로 끝난다,
// 숨은 테스트 파일은 어떤 길로 끝나도 남기지 않는다.
// 작은 git 저장소에 진짜 judge.mjs를 넣고, vitest·채점기 자리에는 금방 끝나는 대역 스크립트를 둔다.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const judgeScript = path.resolve(import.meta.dirname, "..", "scripts", "judge.mjs");
const cases: string[] = [];
const strays: number[] = [];

// vitest 대역: 넘겨받은 폴더의 숨은 테스트마다, 작업 트리에 impl/<번호>.txt가 있으면 통과로 적는다.
// 본 파일 이름을 JUDGE_FIXTURE_SEEN에 남기고, JUDGE_FIXTURE_HOLD가 있으면 자기 PID를 적고 끝나지 않고 기다린다.
const vitestStub = `import { appendFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const output = args.find((arg) => arg.startsWith("--outputFile=")).slice("--outputFile=".length);
const dir = path.resolve(args.at(-1));
const testResults = readdirSync(dir).filter((name) => name.endsWith(".test.ts")).map((name) => {
  appendFileSync(process.env.JUDGE_FIXTURE_SEEN, name + "\\n");
  const issue = /issue-(\\d+)/.exec(name)[1];
  const passed = existsSync(path.join("impl", issue + ".txt"));
  return {
    name: path.join(dir, name),
    status: passed ? "passed" : "failed",
    message: "",
    assertionResults: [{ title: "이슈 " + issue + " 약속", status: passed ? "passed" : "failed", failureMessages: passed ? [] : ["AssertionError: 구현이 없어요"] }],
  };
});
if (process.env.JUDGE_FIXTURE_HOLD) {
  writeFileSync(process.env.JUDGE_FIXTURE_HOLD, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  writeFileSync(output, JSON.stringify({ testResults }));
  process.exit(testResults.every((file) => file.status === "passed") ? 0 : 1);
}
`;

interface Fixture {
  repo: string;
  seen: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=judge-test", "-c", "user.email=judge@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}

function write(root: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
}

/** day2-c 브랜치(이슈 1·2·4, 시작 태그)와 day2-c-answers 브랜치(이슈 1·2의 숨은 테스트)가 있는 저장소 */
function fixture(): Fixture {
  const caseDir = mkdtempSync(path.join(os.tmpdir(), "judge-script-"));
  cases.push(caseDir);
  const repo = path.join(caseDir, "repo");
  write(repo, {
    ".gitignore": "node_modules/\ntests/judge-run-*/\nimpl/\n",
    "package.json": '{ "name": "fixture", "private": true, "type": "module" }\n',
    "docs/issues/1.md": "# 안전재고 알림\n",
    "docs/issues/2.md": "# 부분 환불\n",
    "docs/issues/4.md": "# 단골 고객 배송비 무료\n",
    "tests/support/test-app.ts": "export {};\n",
    "tools/grader/src/cli.ts": 'console.log(JSON.stringify({ violations: [] }));\n',
    "node_modules/vitest/vitest.mjs": vitestStub,
  });
  mkdirSync(path.join(repo, "scripts"));
  copyFileSync(judgeScript, path.join(repo, "scripts", "judge.mjs"));
  git(repo, ["init", "--quiet", "--initial-branch=day2-c"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--quiet", "--no-verify", "-m", "start"]);
  git(repo, ["tag", "start/day2-c"]);
  git(repo, ["switch", "--quiet", "-c", "day2-c-answers"]);
  write(repo, { "tests/judge/issue-1.test.ts": "// 숨은 테스트 1\n", "tests/judge/issue-2.test.ts": "// 숨은 테스트 2\n" });
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--quiet", "--no-verify", "-m", "answers"]);
  git(repo, ["switch", "--quiet", "day2-c"]);
  return { repo, seen: path.join(caseDir, "seen.txt") };
}

function judgeEnv(fx: Fixture, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const outside = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]);
  const inherited = Object.entries(process.env).filter(([key]) => !outside.has(key.toUpperCase()));
  return { ...Object.fromEntries(inherited), JUDGE_FIXTURE_SEEN: fx.seen, ...extra };
}

function judge(fx: Fixture, args: string[] = []): { code: number | null; output: string } {
  const result = spawnSync(process.execPath, [path.join("scripts", "judge.mjs"), ...args], { cwd: fx.repo, env: judgeEnv(fx), encoding: "utf8", timeout: 30_000 });
  return { code: result.status, output: result.stdout + result.stderr };
}

/** 작업 트리에 남은 것: judge가 만든 폴더와 git이 보는 변경 */
function leftovers(fx: Fixture): { runDirs: string[]; status: string } {
  return { runDirs: readdirSync(path.join(fx.repo, "tests")).filter((name) => name.startsWith("judge-run-")), status: git(fx.repo, ["status", "--porcelain"]) };
}

function seen(fx: Fixture): string[] {
  return existsSync(fx.seen) ? readFileSync(fx.seen, "utf8").trim().split("\n").sort() : [];
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const pid of strays.splice(0)) if (isRunning(pid)) process.kill(pid, "SIGKILL");
  for (const caseDir of cases.splice(0)) rmSync(caseDir, { recursive: true, force: true });
});

describe("npm run judge", { timeout: 30_000 }, () => {
  it("구현 전에는 숨은 테스트가 있는 이슈가 틀림으로 나오고 1로 끝나며, 숨은 테스트 파일을 남기지 않는다", () => {
    const fx = fixture();

    const { code, output } = judge(fx);

    expect(code).toBe(1);
    expect(output).toContain("| 1 안전재고 알림 | 실패 0/1 | 틀림 |");
    expect(output).toContain("| 2 부분 환불 | 실패 0/1 | 틀림 |");
    expect(output).toContain("| 4 단골 고객 배송비 무료 | 없음 |");
    expect(output).toContain("AssertionError: 구현이 없어요");
    expect(seen(fx)).toEqual(["issue-1.test.ts", "issue-2.test.ts"]);
    expect(leftovers(fx)).toEqual({ runDirs: [], status: "" });
  });

  it("구현이 있으면 맞음으로 나오고 채점기 결과와 함께 0으로 끝난다", () => {
    const fx = fixture();
    write(fx.repo, { "impl/1.txt": "", "impl/2.txt": "" });

    const { code, output } = judge(fx);

    expect(output).toContain("| 1 안전재고 알림 | 통과 1/1 | 맞음 |");
    expect(output).toContain("| 2 부분 환불 | 통과 1/1 | 맞음 |");
    expect(output).toContain("규칙 채점기 (start/day2-c 이후 바뀐 것): 통과");
    expect(code).toBe(0);
    expect(leftovers(fx)).toEqual({ runDirs: [], status: "" });
  });

  it("정답 브랜치가 없으면 이유와 다시 받는 방법을 알리고 숨은 테스트 없이 2로 끝난다", () => {
    const fx = fixture();
    git(fx.repo, ["branch", "--quiet", "-D", "day2-c-answers"]);

    const { code, output } = judge(fx);

    expect(code).toBe(2);
    expect(output).toContain("Copy the main branch only");
    expect(output).toContain("git fetch origin day2-c-answers");
    expect(seen(fx)).toEqual([]);
    expect(leftovers(fx)).toEqual({ runDirs: [], status: "" });
  });

  it("정답 브랜치가 원격(origin)에만 있어도 찾는다", () => {
    const fx = fixture();
    const remote = path.join(path.dirname(fx.repo), "origin.git");
    git(path.dirname(fx.repo), ["init", "--quiet", "--bare", remote]);
    git(fx.repo, ["remote", "add", "origin", remote]);
    git(fx.repo, ["push", "--quiet", "origin", "day2-c-answers"]);
    git(fx.repo, ["branch", "--quiet", "-D", "day2-c-answers"]);
    git(fx.repo, ["fetch", "--quiet", "origin"]);

    const { code, output } = judge(fx);

    expect(code).toBe(1);
    expect(output).toContain("숨은 테스트: origin/day2-c-answers");
    expect(seen(fx)).toEqual(["issue-1.test.ts", "issue-2.test.ts"]);
  });

  it("지난 실행이 남긴 폴더는 치우고, 아직 도는 실행의 폴더는 둔다", () => {
    const fx = fixture();
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    write(fx.repo, { [`tests/judge-run-${String(dead)}/issue-1.test.ts`]: "// 남은 것\n", [`tests/judge-run-${String(process.pid)}/keep.txt`]: "" });

    const { code } = judge(fx);

    expect(code).toBe(1);
    expect(leftovers(fx).runDirs).toEqual([`judge-run-${String(process.pid)}`]);
  });

  // Windows에는 이 신호들을 한 프로세스에만 보내는 방법이 없다.
  it.skipIf(process.platform === "win32").each(["SIGINT", "SIGTERM"] as const)(
    "%s를 받으면 숨은 테스트를 멈추고 파일을 지운 뒤 128+신호 번호로 끝난다",
    async (signal) => {
      const fx = fixture();
      const marker = path.join(path.dirname(fx.repo), "vitest.pid");
      const child = spawn(process.execPath, [path.join("scripts", "judge.mjs")], { cwd: fx.repo, env: judgeEnv(fx, { JUDGE_FIXTURE_HOLD: marker }), stdio: "ignore" });
      if (child.pid === undefined) throw new Error("judge.mjs를 시작하지 못했습니다(pid 없음)");
      strays.push(child.pid);
      const exited = new Promise<number | string | null>((resolve) => child.on("exit", (code, sig) => { resolve(code ?? sig); }));
      for (let waited = 0; !existsSync(marker) && waited < 15_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
      const vitestPid = Number(readFileSync(marker, "utf8"));
      strays.push(vitestPid);
      expect(leftovers(fx).runDirs).toHaveLength(1);

      process.kill(child.pid, signal);
      const outcome = await Promise.race([exited, new Promise((resolve) => setTimeout(() => { resolve("still running"); }, 15_000))]);

      expect(outcome).toBe(128 + os.constants.signals[signal]);
      expect(isRunning(vitestPid)).toBe(false);
      expect(leftovers(fx)).toEqual({ runDirs: [], status: "" });
    },
    40_000,
  );
});
