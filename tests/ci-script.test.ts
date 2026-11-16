// npm run ci(scripts/ci.mjs) 테스트. 기대값은 ci.mjs 머리말의 약속에서 왔다:
// 커밋한 코드만 검사한다, 끝나면 임시 폴더를 치운다, 종료 코드 0·1·2·128+신호.
// 작은 git 저장소에 진짜 ci.mjs를 넣고, verify·채점 자리에는 금방 끝나는 대역 스크립트를 둔다.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ciScript = path.resolve(import.meta.dirname, "..", "scripts", "ci.mjs");
const cases: string[] = [];
const strays: number[] = [];

// verify 대역: 작업 공간 패키지(@fixture/pkg)의 값을 출력한다. HOLD가 있으면 자기 PID를 적고 멈추지 않고 기다린다.
// --only 단계가 CI_FIXTURE_FAIL과 같으면 그 단계에서 실패한다.
const verifyStub = `import { readFileSync, writeFileSync } from "node:fs";
const seen = readFileSync("node_modules/@fixture/pkg/value.txt", "utf8").trim();
console.log("seen=" + seen);
if (process.argv[process.argv.indexOf("--only") + 1] === process.env.CI_FIXTURE_FAIL) process.exit(1);
if (process.env.CI_FIXTURE_HOLD) {
  writeFileSync(process.env.CI_FIXTURE_HOLD, String(process.pid));
  setInterval(() => {}, 1000);
}
`;

interface Fixture {
  repo: string;
  tmp: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=ci-test", "-c", "user.email=ci@example.test", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  });
}

function write(root: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
}

/** 작업 공간 패키지 하나가 있는 저장소. npm이 Windows에서 만드는 것처럼 링크는 절대 경로(junction)다. */
function fixture(): Fixture {
  const caseDir = mkdtempSync(path.join(os.tmpdir(), "ci-script-"));
  cases.push(caseDir);
  const repo = path.join(caseDir, "repo");
  const tmp = path.join(caseDir, "tmp");
  mkdirSync(tmp);
  write(repo, {
    ".gitignore": "node_modules/\n",
    "package.json": '{ "name": "fixture", "private": true, "type": "module" }\n',
    "package-lock.json": "{}\n",
    "packages/pkg/value.txt": "committed\n",
    "scripts/verify.mjs": verifyStub,
    "tools/grader/src/cli.ts": "process.exit(0);\n",
  });
  copyFileSync(ciScript, path.join(repo, "scripts", "ci.mjs"));
  git(repo, ["init", "--quiet"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--quiet", "--no-verify", "-m", "start"]);
  mkdirSync(path.join(repo, "node_modules", "@fixture"), { recursive: true });
  symlinkSync(path.join(repo, "packages", "pkg"), path.join(repo, "node_modules", "@fixture", "pkg"), "junction");
  return { repo, tmp };
}

function ciEnv(tmp: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // GitHub Actions에서 테스트가 돌아도 ci.mjs는 내 폴더 경로로 돌아야 한다.
  // Windows의 환경 변수 이름은 대소문자를 가리지 않는다.
  const outside = new Set(["GITHUB_ACTIONS", "GITHUB_BASE_REF", "GITHUB_STEP_SUMMARY", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]);
  const inherited = Object.entries(process.env).filter(([key]) => !outside.has(key.toUpperCase()));
  return { ...Object.fromEntries(inherited), TMPDIR: tmp, TEMP: tmp, TMP: tmp, ...extra };
}

function ci(fx: Fixture, args: string[], env: NodeJS.ProcessEnv = ciEnv(fx.tmp)): { code: number | null; output: string } {
  const result = spawnSync(process.execPath, [path.join("scripts", "ci.mjs"), ...args], { cwd: fx.repo, env, encoding: "utf8", timeout: 30_000 });
  return { code: result.status, output: result.stdout + result.stderr };
}

function leftovers(fx: Fixture): { temp: string[]; worktrees: number } {
  const worktrees = git(fx.repo, ["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree ")).length;
  return { temp: readdirSync(fx.tmp), worktrees };
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

// 한 테스트가 git·node를 여러 번 띄우므로 Windows 러너에서 기본 5초를 넘길 수 있다. 런처 테스트처럼 시간 예산을 따로 둔다.
describe("npm run ci", { timeout: 30_000 }, () => {
  it("커밋하지 않은 packages 변경을 보지 않고, 그 파일 경로를 온전히 알려 주고, 원본과 임시 폴더를 남기지 않는다", () => {
    const fx = fixture();
    writeFileSync(path.join(fx.repo, "packages", "pkg", "value.txt"), "uncommitted\n");

    const { code, output } = ci(fx, ["--base", "HEAD"]);

    expect(output).toContain("seen=committed");
    expect(code).toBe(0);
    expect(output).toContain("커밋하지 않은 변경 1개는 검사하지 않았어요(PR에도 안 올라가요): packages/pkg/value.txt");
    expect(readFileSync(path.join(fx.repo, "packages", "pkg", "value.txt"), "utf8")).toBe("uncommitted\n");
    expect(leftovers(fx)).toEqual({ temp: [], worktrees: 1 });
  });

  it("--result를 주면 실패한 단계 키와 단계별 결과를 JSON으로 남기고 1로 끝난다", () => {
    const fx = fixture();
    const resultFile = path.join(path.dirname(fx.tmp), "result.json");

    const { code, output } = ci(fx, ["--base", "HEAD", "--result", resultFile], ciEnv(fx.tmp, { CI_FIXTURE_FAIL: "test" }));

    expect(code).toBe(1);
    expect(output).toContain('[ci] 실패: "테스트" 단계');
    const result = JSON.parse(readFileSync(resultFile, "utf8")) as { ok: boolean; failed: string; steps: { key: string; ok: boolean | null }[] };
    expect(result.ok).toBe(false);
    expect(result.failed).toBe("test");
    expect(result.steps.map(({ key, ok }) => `${key}:${String(ok)}`)).toEqual(["checkout:true", "dependencies:true", "node:true", "typecheck:true", "lint:true", "test:false", "build:null", "grade:null"]);
    expect(leftovers(fx)).toEqual({ temp: [], worktrees: 1 });
  });

  it("없는 기준점이면 검사를 돌리지 않고 바로 2로 끝난다", () => {
    const fx = fixture();

    const { code, output } = ci(fx, ["--base", "no-such-branch"]);

    expect(code).toBe(2);
    expect(output).toContain("no-such-branch");
    expect(output).not.toContain("seen=");
    expect(leftovers(fx)).toEqual({ temp: [], worktrees: 1 });
  });

  it("npm 없이 직접 돌려 npm ci가 필요하면 2로 끝나고 임시 폴더를 남기지 않는다", () => {
    const fx = fixture();
    write(fx.repo, { "package-lock.json": '{ "changed": true }\n' });
    git(fx.repo, ["commit", "--quiet", "--no-verify", "-am", "lock"]);
    write(fx.repo, { "package-lock.json": "{}\n" });
    const env = Object.fromEntries(Object.entries(ciEnv(fx.tmp)).filter(([key]) => key.toLowerCase() !== "npm_execpath"));

    const { code, output } = ci(fx, ["--base", "HEAD~1"], env);

    expect(code).toBe(2);
    expect(output).toContain("npm run ci로 실행하세요");
    expect(leftovers(fx)).toEqual({ temp: [], worktrees: 1 });
  });

  it("지난 실행이 남긴 임시 폴더는 링크를 따라가지 않고 치우고, 아직 도는 실행의 폴더는 둔다", () => {
    const fx = fixture();
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    const stale = path.join(fx.tmp, `shop-ci-${dead}-AbCdEf`);
    git(fx.repo, ["worktree", "add", "--quiet", "--detach", stale, "HEAD"]);
    mkdirSync(path.join(stale, "node_modules", "@fixture"), { recursive: true });
    symlinkSync(path.join(fx.repo, "packages", "pkg"), path.join(stale, "node_modules", "@fixture", "pkg"), "junction");
    const live = `shop-ci-${process.pid}-GhIjKl`;
    mkdirSync(path.join(fx.tmp, live));

    const { code } = ci(fx, ["--base", "HEAD"]);

    expect(code).toBe(0);
    expect(leftovers(fx)).toEqual({ temp: [live], worktrees: 1 });
    expect(readFileSync(path.join(fx.repo, "packages", "pkg", "value.txt"), "utf8")).toBe("committed\n");
  });

  // Windows에는 이 신호들을 한 프로세스에만 보내는 방법이 없다(콘솔 닫기·Ctrl+C는 콘솔의 모든 프로세스가 받는다).
  it.skipIf(process.platform === "win32").each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
    "%s를 ci만 받아도 verify를 멈추고 임시 폴더를 치운 뒤 128+신호 번호로 끝난다",
    async (signal) => {
      const fx = fixture();
      const marker = path.join(path.dirname(fx.tmp), "verify.pid");
      const child = spawn(process.execPath, [path.join("scripts", "ci.mjs"), "--base", "HEAD"], {
        cwd: fx.repo,
        env: ciEnv(fx.tmp, { CI_FIXTURE_HOLD: marker }),
        stdio: "ignore",
      });
      if (child.pid === undefined) throw new Error("ci.mjs를 시작하지 못했습니다(pid 없음)");
      const ciPid = child.pid;
      strays.push(ciPid);
      const exited = new Promise<number | string | null>((resolve) => child.on("exit", (code, sig) => { resolve(code ?? sig); }));
      for (let waited = 0; !existsSync(marker) && waited < 15_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
      const verifyPid = Number(readFileSync(marker, "utf8"));
      strays.push(verifyPid);

      process.kill(ciPid, signal);
      const outcome = await Promise.race([exited, new Promise((resolve) => setTimeout(() => { resolve("still running"); }, 15_000))]);

      expect(outcome).toBe(128 + os.constants.signals[signal]);
      expect(isRunning(verifyPid)).toBe(false);
      expect(leftovers(fx)).toEqual({ temp: [], worktrees: 1 });
    },
    40_000,
  );
});
