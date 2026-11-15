import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture, originalClaudeState, type Fixture } from "./test-fixture.ts";

let fixture: Fixture | null = null;
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

/** npm run setup을 마친 레포: 설치 기록·DB는 fixture에 있고 .env만 더한다. */
function prepared(options: Parameters<typeof createFixture>[0] = {}): Fixture {
  const f = createFixture(options);
  writeFileSync(path.join(f.repo, ".env"), "API_PORT=4000\n");
  return f;
}

function launchEntries(f: Fixture) {
  return f.claudeLog().filter((entry) => entry.args !== undefined && entry.args[0] !== "--version");
}

describe("npm run claude", () => {
  it("지원하지 않는 Node(20)면 첫 단계에서 멈추고 claude를 부르지 않는다", () => {
    fixture = prepared();
    const fakeNode = path.join(fixture.root, "node-20.mjs");
    writeFileSync(fakeNode, 'Object.defineProperty(process.versions, "node", { value: "20.11.0" });\nObject.defineProperty(process, "version", { value: "v20.11.0" });\n');
    const result = fixture.run({ script: "claude", nodeArgs: ["--import", `file://${fakeNode}`] });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("[1/4] Node 확인: 실패");
    expect(result.stderr).toContain('claude.mjs가 "Node 확인" 단계에서 멈췄습니다');
    expect(fixture.claudeLog()).toEqual([]);
    expect(existsSync(fixture.practiceDir)).toBe(false);
  });

  it("실습 설정 폴더를 만들고, 그 폴더와 넘긴 옵션으로 레포에서 claude를 띄우며, 원래 ~/.claude는 그대로다", () => {
    fixture = prepared();
    const before = originalClaudeState(fixture);
    const result = fixture.run({ script: "claude", args: ["--continue", "--model", "opus"] });

    expect(result.status, result.stderr).toBe(0);
    for (const step of ["[1/4] Node 확인", "[2/4] 실습 설정 폴더 위치", "[3/4] claude 명령 확인", "[4/4] 준비 확인"]) {
      expect(result.stdout).toContain(step);
    }
    const launchSettings = path.join(fixture.practiceDir, "workshop-settings.json");
    expect(result.stdout).toContain(`claude 실행: CLAUDE_CONFIG_DIR=${fixture.practiceDir} claude --settings ${launchSettings} --continue --model opus`);
    // 레포 바깥 위쪽 폴더의 지침(예: 홈의 .claude/CLAUDE.md)은 빼고, 레포 안 지침은 하나도 빼지 않는다.
    const { claudeMdExcludes: excludes } = JSON.parse(readFileSync(launchSettings, "utf8")) as { claudeMdExcludes: string[] };
    const slash = (p: string): string => p.replaceAll("\\", "/");
    expect(excludes).toContain(`${slash(path.dirname(fixture.repo))}/.claude/CLAUDE.md`);
    expect(excludes).toContain(`${slash(path.dirname(fixture.repo))}/CLAUDE.md`);
    const repoPrefix = `${slash(fixture.repo)}/`;
    expect(excludes.filter((p) => p.startsWith(repoPrefix))).toEqual([]);
    // claude를 부르는 모든 곳(--version 포함)이 실습 설정 폴더를 쓰고, 띄울 때만 이 설정 파일을 --settings로 붙인다(Hook은 레포 .claude/settings.json에 있다).
    expect(fixture.claudeLog()).toEqual([
      { args: ["--version"], configDir: fixture.practiceDir, cwd: fixture.repo },
      { args: ["--settings", launchSettings, "--continue", "--model", "opus"], configDir: fixture.practiceDir, cwd: fixture.repo },
    ]);
    expect(existsSync(path.join(fixture.practiceDir, ".credentials.json"))).toBe(true);
    expect(fixture.npmLog()).toEqual([]);
    expect(originalClaudeState(fixture)).toEqual(before);
  });

  it("claude의 종료 코드로 끝난다", () => {
    fixture = prepared();
    fixture.env.FAKE_CLAUDE_EXIT = "7";
    const result = fixture.run({ script: "claude" });

    expect(result.status, result.stderr).toBe(7);
    expect(launchEntries(fixture)).toHaveLength(1);
  });

  it("claude 명령이 없으면 그 단계에서 설치 링크와 함께 멈춘다", () => {
    fixture = prepared({ claude: false });
    const result = fixture.run({ script: "claude" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("[3/4] claude 명령 확인: 실패");
    expect(result.stderr).toContain("https://code.claude.com/docs/ko/setup");
    expect(result.stdout + result.stderr).not.toContain("[4/4]");
  });

  describe("레포가 준비되지 않았으면 설치하지 않고 npm run setup을 먼저 하라며 멈춘다", () => {
    it.each([
      ["의존성(node_modules)", (f: Fixture) => {
        rmSync(f.hiddenLockFile);
      }],
      ["DB", (f: Fixture) => {
        rmSync(f.databaseFile);
      }],
      [".env", (f: Fixture) => {
        rmSync(path.join(f.repo, ".env"));
      }],
    ] as const)("%s가 없을 때", (missing, remove) => {
      fixture = prepared();
      remove(fixture);
      const result = fixture.run({ script: "claude" });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("[4/4] 준비 확인: 실패");
      expect(result.stderr).toContain(missing);
      expect(result.stderr).toContain("npm run setup");
      expect(result.stderr).toContain('claude.mjs가 "준비 확인" 단계에서 멈췄습니다');
      expect(fixture.npmLog()).toEqual([]);
      expect(launchEntries(fixture)).toEqual([]);
    });
  });

  it("실습 설정 폴더가 원래 ~/.claude로 연결돼 있으면 아무것도 바꾸지 않고 위치 확인 단계에서 거부한다", () => {
    fixture = prepared();
    symlinkSync(fixture.originalClaudeDir, fixture.practiceDir, "junction");
    const before = originalClaudeState(fixture);
    const result = fixture.run({ script: "claude" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("[2/4] 실습 설정 폴더 위치: 실패");
    expect(result.stderr).toContain("원래 설정");
    expect(fixture.claudeLog()).toEqual([]);
    expect(originalClaudeState(fixture)).toEqual(before);
  });

  it("실습 설정 폴더가 레포로 연결돼 있으면 레포에 아무것도 만들지 않고 위치 확인 단계에서 거부한다", () => {
    fixture = prepared();
    symlinkSync(fixture.repo, fixture.practiceDir, "junction");
    const before = readdirSync(fixture.repo).sort();
    const result = fixture.run({ script: "claude" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("[2/4] 실습 설정 폴더 위치: 실패");
    expect(result.stderr).toContain("레포");
    expect(fixture.claudeLog()).toEqual([]);
    expect(readdirSync(fixture.repo).sort()).toEqual(before);
  });

  const badHomes = process.platform === "win32" ? ["relative-home"] : ["relative-home", ""];
  it.each(badHomes)("홈 폴더 값이 %j처럼 절대 경로가 아니면 위치 확인 단계에서 거부하고 아무것도 만들지 않는다", (home) => {
    fixture = prepared();
    fixture.env.HOME = home;
    fixture.env.USERPROFILE = home;
    const before = readdirSync(fixture.repo).sort();
    const result = fixture.run({ script: "claude" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("[2/4] 실습 설정 폴더 위치: 실패");
    expect(fixture.claudeLog()).toEqual([]);
    expect(readdirSync(fixture.repo).sort()).toEqual(before);
  });

  it.skipIf(process.platform === "win32")("Ctrl+C에 claude.mjs가 claude보다 먼저 죽지 않고 claude의 종료 코드로 끝난다", async () => {
    fixture = prepared();
    const f = fixture;
    f.env.FAKE_CLAUDE_WAIT_FOR_INTERRUPT = "1";
    // 터미널의 Ctrl+C처럼 부모와 claude가 든 프로세스 그룹 전체에 SIGINT를 보낸다.
    const parent = spawn(process.execPath, [path.join(f.repo, "scripts", "claude.mjs")], { cwd: f.repo, env: f.env, detached: true, stdio: "ignore" });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      parent.on("exit", (code, signal) => {
        resolve({ code, signal });
      });
    });
    const deadline = Date.now() + 20_000;
    while (!f.claudeLog().some((entry) => entry.ready === true)) {
      if (Date.now() > deadline) throw new Error("가짜 claude가 준비되지 않았습니다.");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (parent.pid === undefined) throw new Error("claude.mjs를 시작하지 못했습니다.");
    process.kill(-parent.pid, "SIGINT");

    expect(await exited).toEqual({ code: 42, signal: null });
  }, 30_000);
});
