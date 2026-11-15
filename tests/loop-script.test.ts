// npm run loop(scripts/loop.mjs) 테스트. 기대값은 loop.mjs 머리말의 약속에서 왔다:
// 대기 이슈마다 worktree에서 claude -p "/issue-to-pr <이슈>"를 상한과 함께 돌린다, 동시에 2개까지, 같은 파일을 건드리는 이슈는 같이 띄우지 않는다,
// 한 번 맡긴 이슈는 다시 돌리지 않는다, 상한이 없으면 돌리지 않는다, issue-to-pr Skill이 지금 커밋에 없으면 돌리지 않는다,
// --resume <번호>는 기록된 세션을 그 worktree에서 같은 계정·권한 모드로 이어 간다. 두 길 모두 npm run claude와 같은 설정 파일을 --settings로 붙이고 부모 Claude Code 세션 변수는 넘기지 않는다.
// 작은 git 저장소에 진짜 loop.mjs를 넣고, PATH 위의 claude와 npm 자리에는 부른 인자와 시각만 남기는 대역을 둔다.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cases: string[] = [];
const strays: number[] = [];

// claude 대역: 부른 인자·폴더·시작과 끝 시각을 남기고, 세션 결과를 claude -p --output-format json 모양으로 찍는다.
// 이슈 5는 승인이 필요한 세션처럼 거절된 도구를 담는다. FAKE_CLAUDE_EXIT가 있으면 아무것도 찍지 않고 그 코드로 끝난다.
// 세션 길이는 300ms, FAKE_CLAUDE_MS_<번호>로 이슈마다 바꾼다. --resume session-<번호>로 부르면 "resume"만 남기고 바로 끝난다.
const fakeClaude = `import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const resume = args.indexOf("--resume");
const issue = resume === -1 ? Number(/issues\\/(\\d+)\\.md/.exec(args[args.indexOf("-p") + 1])[1]) : Number(args[resume + 1].replace("session-", ""));
const log = (entry) => appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ issue, at: Date.now(), ...entry }) + "\\n");
log({ event: resume === -1 ? "start" : "resume", args, cwd: process.cwd(), configDir: process.env.CLAUDE_CONFIG_DIR, parentSession: [process.env.CLAUDECODE ?? null, process.env.CLAUDE_CODE_SESSION_ID ?? null] });
if (resume !== -1) {
  process.exit(0);
} else if (process.env.FAKE_CLAUDE_HOLD) {
  writeFileSync(process.env.FAKE_CLAUDE_HOLD, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  setTimeout(() => {
    log({ event: "end" });
    if (process.env.FAKE_CLAUDE_EXIT) process.exit(Number(process.env.FAKE_CLAUDE_EXIT));
    const denials = issue === 5 ? [{ tool_name: "Edit" }] : [];
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 3, total_cost_usd: 0.25, session_id: "session-" + issue, permission_denials: denials, result: issue === 5 ? "배송비 파일을 고치려면 승인이 필요해요" : "PR을 열었어요" }));
  }, Number(process.env["FAKE_CLAUDE_MS_" + issue] ?? "300"));
}
`;

// npm 대역(npm_execpath 자리): 부른 인자와 폴더만 남긴다.
const fakeNpm = `import { appendFileSync } from "node:fs";
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
`;

interface Fixture {
  repo: string;
  home: string;
  bin: string;
  claudeLog: string;
  npmLog: string;
  npm: string;
}

interface ClaudeEntry {
  issue: number;
  at: number;
  event: "start" | "end" | "resume";
  args?: string[];
  configDir?: string;
  cwd?: string;
  parentSession?: [string | null, string | null];
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=loop-test", "-c", "user.email=loop@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}

function write(root: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
}

const issue = (title: string, paths: string[] | null) =>
  `# ${title}\n\n본문\n${paths === null ? "" : `\n## 주로 건드릴 곳\n\n${paths.map((file) => `- \`${file}\``).join("\n")}\n`}`;

/** 이슈 5장: 2·3은 같은 화면, 1과 5는 서로 다른 곳, 4는 건드릴 곳이 적혀 있지 않다. */
function fixture(options: { skill?: "committed" | "uncommitted" } = {}): Fixture {
  const skill = options.skill ?? "committed";
  const caseDir = mkdtempSync(path.join(os.tmpdir(), "loop-script-"));
  cases.push(caseDir);
  const repo = path.join(caseDir, "repo");
  const bin = path.join(caseDir, "bin");
  write(repo, {
    ".gitignore": "node_modules/\n.loop/\n",
    "package.json": '{ "name": "fixture", "private": true, "type": "module" }\n',
    "docs/issues/README.md": "# 이슈\n",
    "docs/issues/1.md": issue("안전재고 알림", ["apps/api/src/inventory/"]),
    "docs/issues/2.md": issue("부분 환불", ["apps/web/src/routes/orders-pages.tsx", "apps/api/src/orders/application/order-service.ts"]),
    "docs/issues/3.md": issue("상태 필터", ["apps/web/src/routes/orders-pages.tsx"]),
    "docs/issues/4.md": issue("단골 배송비", null),
    "docs/issues/5.md": issue("무료배송 기준", ["apps/api/src/orders/domain/shipping-fee.ts"]),
    ...(skill === "committed" ? { ".claude/skills/issue-to-pr/SKILL.md": "# issue-to-pr\n" } : {}),
  });
  mkdirSync(path.join(repo, "scripts"));
  copyFileSync(path.join(repoRoot, "scripts", "loop.mjs"), path.join(repo, "scripts", "loop.mjs"));
  mkdirSync(path.join(repo, "tools", "setup", "src"), { recursive: true });
  for (const file of ["claude.ts", "command.ts", "dependencies.ts", "launch.ts", "paths.ts", "report.ts", "setup.ts"]) copyFileSync(path.join(repoRoot, "tools", "setup", "src", file), path.join(repo, "tools", "setup", "src", file));
  git(repo, ["init", "--quiet", "--initial-branch=day2-c"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--quiet", "--no-verify", "-m", "start"]);
  if (skill === "uncommitted") write(repo, { ".claude/skills/issue-to-pr/SKILL.md": "# issue-to-pr\n" });
  // PATH의 claude: Mac·Linux는 실행 권한이 있는 스크립트, Windows는 .cmd(PATHEXT로 찾는다).
  write(bin, { "claude.mjs": fakeClaude, "claude": `#!/usr/bin/env node\nimport("./claude.mjs");\n`, "claude.cmd": `@"${process.execPath}" "%~dp0claude.mjs" %*\r\n`, "npm.mjs": fakeNpm });
  chmodSync(path.join(bin, "claude"), 0o755);
  // 홈 대역: 실습 설정 폴더(~/.claude-workshop)가 있는 홈. 실제 홈은 보지 않는다.
  const home = path.join(caseDir, "home");
  mkdirSync(path.join(home, ".claude-workshop"), { recursive: true });
  return { repo, home, bin, claudeLog: path.join(caseDir, "claude.log"), npmLog: path.join(caseDir, "npm.log"), npm: path.join(bin, "npm.mjs") };
}

function loopEnv(fx: Fixture, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const outside = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "PATH", "NPM_EXECPATH"]);
  const inherited = Object.entries(process.env).filter(([key]) => !outside.has(key.toUpperCase()));
  const pathValue = [fx.bin, path.dirname(process.execPath), process.env.PATH ?? process.env.Path ?? ""].join(path.delimiter);
  return { ...Object.fromEntries(inherited), PATH: pathValue, HOME: fx.home, USERPROFILE: fx.home, npm_execpath: fx.npm, FAKE_CLAUDE_LOG: fx.claudeLog, FAKE_NPM_LOG: fx.npmLog, ...extra };
}

function loop(fx: Fixture, args: string[], extra: Record<string, string> = {}): { code: number | null; output: string } {
  const result = spawnSync(process.execPath, [path.join("scripts", "loop.mjs"), ...args], { cwd: fx.repo, env: loopEnv(fx, extra), encoding: "utf8", timeout: 30_000 });
  return { code: result.status, output: result.stdout + result.stderr };
}

function claudeLog(fx: Fixture): ClaudeEntry[] {
  return existsSync(fx.claudeLog) ? readFileSync(fx.claudeLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as ClaudeEntry) : [];
}

/** 이슈별 [시작, 끝] 시각 */
function spans(fx: Fixture): Map<number, [number, number]> {
  const result = new Map<number, [number, number]>();
  for (const entry of claudeLog(fx)) {
    const span = result.get(entry.issue) ?? [0, 0];
    span[entry.event === "start" ? 0 : 1] = entry.at;
    result.set(entry.issue, span);
  }
  return result;
}

const overlaps = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1];

function worktreeOf(fx: Fixture, number: number): string {
  return path.join(path.dirname(fx.repo), `repo-issue-${String(number)}`);
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

describe("npm run loop", { timeout: 30_000 }, () => {
  it("상한 둘이 없으면 아무것도 띄우지 않고 2로 끝난다", () => {
    const fx = fixture();

    const { code, output } = loop(fx, ["--max-turns", "10"]);

    expect(code).toBe(2);
    expect(output).toContain("--max-budget-usd");
    expect(claudeLog(fx)).toEqual([]);
    expect(git(fx.repo, ["branch", "--list", "issue-*"])).toBe("");
  });

  it("실습 설정 폴더가 없으면 npm run claude로 먼저 로그인하라고 알리고 아무것도 띄우지 않는다", () => {
    const fx = fixture();
    rmSync(path.join(fx.home, ".claude-workshop"), { recursive: true });

    const { code, output } = loop(fx, ["--max-turns", "5", "--max-budget-usd", "1", "1"]);

    expect(code).toBe(2);
    expect(output).toContain("npm run claude");
    expect(claudeLog(fx)).toEqual([]);
  });

  it("issue-to-pr Skill이 지금 커밋에 없으면 커밋하라고 알리고 아무것도 띄우지 않는다", () => {
    const fx = fixture({ skill: "uncommitted" });

    const { code, output } = loop(fx, ["--max-turns", "5", "--max-budget-usd", "1", "1"]);

    expect(code).toBe(2);
    expect(output).toContain("issue-to-pr Skill을 커밋하세요");
    expect(claudeLog(fx)).toEqual([]);
    expect(git(fx.repo, ["branch", "--list", "issue-*"])).toBe("");
  });

  it("이슈마다 worktree에서 상한과 함께 세션을 돌리고, 동시에 2개까지, 같은 파일을 건드리는 이슈는 같이 띄우지 않는다", () => {
    const fx = fixture();

    // 2번 세션을 길게 둔다: 1번이 먼저 끝나 자리가 나도 3번은 2번이 끝날 때까지 기다려야 한다.
    const { code, output } = loop(fx, ["--max-turns", "7", "--max-budget-usd", "0.5", "1", "2", "3"], { FAKE_CLAUDE_MS_2: "2000" });

    expect(code).toBe(0);
    const span = spans(fx);
    const [one, two, three] = [span.get(1), span.get(2), span.get(3)];
    if (one === undefined || two === undefined || three === undefined) throw new Error(`세션이 모두 돌지 않았습니다: ${output}`);
    expect(overlaps(one, two)).toBe(true);
    expect(one[1]).toBeLessThan(two[1]);
    expect(overlaps(two, three)).toBe(false);
    expect(three[0]).toBeGreaterThanOrEqual(two[1]);
    expect(output).toContain("3번은 2번과 같은 곳(apps/web/src/routes/orders-pages.tsx)을 건드려 2번이 끝난 뒤 띄웁니다");
    const starts = claudeLog(fx).filter((entry) => entry.event === "start");
    expect(starts.find((entry) => entry.issue === 1)?.args).toEqual([
      "--settings",
      path.join(fx.home, ".claude-workshop", "workshop-settings.json"),
      "-p",
      "/issue-to-pr docs/issues/1.md",
      "-n",
      "issue-1",
      "--permission-mode",
      "auto",
      "--max-turns",
      "7",
      "--max-budget-usd",
      "0.5",
      "--output-format",
      "json",
    ]);
    for (const entry of starts) expect(entry.configDir).toBe(path.join(fx.home, ".claude-workshop"));
    // Mac의 /var와 /private/var처럼 같은 폴더가 두 이름일 수 있어 실제 경로로 비교한다.
    for (const entry of starts) expect(realpathSync.native(entry.cwd ?? "")).toBe(realpathSync.native(worktreeOf(fx, entry.issue)));
    const installs = readFileSync(fx.npmLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; cwd: string });
    expect(installs.map((entry) => entry.args[0])).toEqual(["ci", "ci", "ci"]);
    expect(git(fx.repo, ["branch", "--list", "issue-*", "--format=%(refname:short)"]).trim().split("\n")).toEqual(["issue-1", "issue-2", "issue-3"]);
    expect(output).toContain("| 2 부분 환불 | 끝남 | 3 | $0.25 | PR을 열었어요 |");
    expect(readFileSync(path.join(fx.repo, ".loop", "issue-2.json"), "utf8")).toContain('"session_id":"session-2"');
  });

  it("건드릴 곳이 적혀 있지 않은 이슈는 다른 이슈와 같이 띄우지 않고, 승인이 필요했던 세션은 그렇게 적는다", () => {
    const fx = fixture();

    const { code, output } = loop(fx, ["--max-turns", "5", "--max-budget-usd", "1", "4", "5"]);

    expect(code).toBe(0);
    const span = spans(fx);
    const [four, five] = [span.get(4), span.get(5)];
    if (four === undefined || five === undefined) throw new Error(`세션이 모두 돌지 않았습니다: ${output}`);
    expect(overlaps(four, five)).toBe(false);
    expect(output).toContain("| 5 무료배송 기준 | 승인 필요(거절된 도구 1개) |");
    expect(output).toContain("5번: npm run loop -- --resume 5");
  });

  it("--resume은 기록된 세션을 그 worktree에서 실습 계정·auto로 이어 간다", () => {
    const fx = fixture();
    loop(fx, ["--max-turns", "5", "--max-budget-usd", "1", "5"]);

    const { code, output } = loop(fx, ["--resume", "5"]);

    expect(code).toBe(0);
    const resumed = claudeLog(fx).filter((entry) => entry.event === "resume");
    expect(resumed).toHaveLength(1);
    const settings = path.join(fx.home, ".claude-workshop", "workshop-settings.json");
    expect(resumed[0]?.args).toEqual([
      "--settings",
      settings,
      "--permission-mode",
      "auto",
      "--resume",
      "session-5",
    ]);
    expect(resumed[0]?.configDir).toBe(path.join(fx.home, ".claude-workshop"));
    expect(realpathSync.native(resumed[0]?.cwd ?? "")).toBe(realpathSync.native(worktreeOf(fx, 5)));
    expect(output).toContain("5번 세션을");
    // npm run claude와 같은 설정 파일: worktree 위쪽 폴더(레포 폴더가 있는 곳 포함)의 지침은 빼고, worktree 안 지침은 하나도 빼지 않는다.
    const { claudeMdExcludes: excludes } = JSON.parse(readFileSync(settings, "utf8")) as { claudeMdExcludes: string[] };
    const slash = (p: string): string => p.replaceAll("\\", "/");
    const worktree = realpathSync.native(worktreeOf(fx, 5));
    expect(excludes).toContain(`${slash(path.dirname(worktree))}/.claude/CLAUDE.md`);
    expect(excludes.filter((p) => p.startsWith(`${slash(worktree)}/`))).toEqual([]);
  });

  it("Claude Code 세션 안에서 열린 터미널에서 돌려도 새 세션과 이어 가는 세션 모두 부모 세션 변수 없이 띄운다", () => {
    const fx = fixture();
    const parent = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "parent-session" };
    loop(fx, ["--max-turns", "5", "--max-budget-usd", "1", "5"], parent);
    loop(fx, ["--resume", "5"], parent);

    const launched = claudeLog(fx).filter((entry) => entry.event !== "end");
    expect(launched.map((entry) => entry.event)).toEqual(["start", "resume"]);
    for (const entry of launched) expect(entry.parentSession).toEqual([null, null]);
  });

  it("--resume은 맡긴 기록이 없거나 다른 인자와 같이 오면 돌리지 않는다", () => {
    const fx = fixture();

    const never = loop(fx, ["--resume", "5"]);
    const mixed = loop(fx, ["--resume", "5", "--max-turns", "5"]);

    expect(never.code).toBe(2);
    expect(never.output).toContain("5번을 돌린 기록(.loop/issue-5.json)이 없어요");
    expect(mixed.code).toBe(2);
    expect(mixed.output).toContain("--resume은 이슈 번호 하나만 받아요");
    expect(claudeLog(fx)).toHaveLength(0);
  });

  it("한 번 맡긴 이슈는 다시 돌리지 않는다", () => {
    const fx = fixture();
    loop(fx, ["--max-turns", "5", "--max-budget-usd", "1", "1"]);

    const { code, output } = loop(fx, ["--max-turns", "5", "--max-budget-usd", "1", "1"]);

    expect(code).toBe(0);
    expect(output).toContain("1번은 이미 맡겼어요(브랜치 issue-1)");
    expect(output).toContain("대기 이슈가 없어요");
    expect(claudeLog(fx).filter((entry) => entry.event === "start")).toHaveLength(1);
  });

  it("세션이 결과 없이 실패하면 그 이슈를 실패로 적고 1로 끝난다", () => {
    const fx = fixture();

    const { code, output } = loop(fx, ["--max-turns", "5", "--max-budget-usd", "1", "1"], { FAKE_CLAUDE_EXIT: "3" });

    expect(code).toBe(1);
    expect(output).toContain("| 1 안전재고 알림 | claude 실패(종료 코드 3) |");
  });

  // Windows에는 이 신호를 한 프로세스에만 보내는 방법이 없다.
  it.skipIf(process.platform === "win32")(
    "SIGTERM을 받으면 돌고 있는 세션을 멈추고 143으로 끝난다",
    async () => {
      const fx = fixture();
      const marker = path.join(path.dirname(fx.repo), "claude.pid");
      const child = spawn(process.execPath, [path.join("scripts", "loop.mjs"), "--max-turns", "5", "--max-budget-usd", "1", "1"], {
        cwd: fx.repo,
        env: loopEnv(fx, { FAKE_CLAUDE_HOLD: marker }),
        stdio: "ignore",
      });
      if (child.pid === undefined) throw new Error("loop.mjs를 시작하지 못했습니다(pid 없음)");
      strays.push(child.pid);
      const exited = new Promise<number | string | null>((resolve) => child.on("exit", (code, sig) => { resolve(code ?? sig); }));
      for (let waited = 0; !existsSync(marker) && waited < 15_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
      const claudePid = Number(readFileSync(marker, "utf8"));
      strays.push(claudePid);

      process.kill(child.pid, "SIGTERM");
      const outcome = await Promise.race([exited, new Promise((resolve) => setTimeout(() => { resolve("still running"); }, 15_000))]);

      expect(outcome).toBe(143);
      expect(isRunning(claudePid)).toBe(false);
    },
    40_000,
  );
});
