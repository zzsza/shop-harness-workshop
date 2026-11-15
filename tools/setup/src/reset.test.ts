import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture, originalClaudeState, type Fixture } from "./test-fixture.ts";

let fixture: Fixture | null = null;
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

/** 로그인해서 대화 기록이 쌓인 실습 계정 */
function loggedIn(): Fixture {
  const f = createFixture();
  mkdirSync(path.join(f.practiceDir, "projects"), { recursive: true });
  writeFileSync(path.join(f.practiceDir, ".credentials.json"), "{}");
  writeFileSync(path.join(f.practiceDir, "projects", "session.jsonl"), "{}\n");
  return f;
}

const logoutCalls = (f: Fixture) => f.claudeLog().filter((e) => e.args?.[0] === "auth");

describe("npm run claude:reset", () => {
  it("--yes면 실습 계정만 로그아웃하고 실습 설정 폴더를 지우며, 원래 ~/.claude는 그대로다", () => {
    fixture = loggedIn();
    const before = originalClaudeState(fixture);
    const result = fixture.run({ script: "claude-reset", args: ["--yes"] });

    expect(result.status).toBe(0);
    for (const step of ["[1/4] Node 확인", "[2/4] 실습 설정 폴더 위치", "[3/4] 실습 계정 로그아웃", "[4/4] 실습 설정 폴더 지우기"]) {
      expect(result.stdout).toContain(step);
    }
    expect(logoutCalls(fixture)).toEqual([{ args: ["auth", "logout"], configDir: fixture.practiceDir, cwd: fixture.repo }]);
    expect(existsSync(fixture.practiceDir)).toBe(false);
    expect(originalClaudeState(fixture)).toEqual(before);
    expect(result.stdout).toContain("npm run claude를 실행하면 로그인부터 다시 나옵니다");
  });

  it("확인을 받을 수 없고 --yes도 없으면 아무것도 지우지 않고 멈춘다", () => {
    fixture = loggedIn();
    const result = fixture.run({ script: "claude-reset" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("npm run claude:reset -- --yes");
    expect(logoutCalls(fixture)).toEqual([]);
    expect(existsSync(path.join(fixture.practiceDir, "projects", "session.jsonl"))).toBe(true);
  });

  it("로그아웃이 실패하면 폴더를 지우지 않고 그 단계에서 멈춘다", () => {
    fixture = loggedIn();
    fixture.env.FAKE_CLAUDE_LOGOUT_EXIT = "2";
    const result = fixture.run({ script: "claude-reset", args: ["--yes"] });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("[3/4] 실습 계정 로그아웃: 실패");
    expect(result.stderr).toContain("폴더는 지우지 않았습니다");
    expect(existsSync(path.join(fixture.practiceDir, "projects", "session.jsonl"))).toBe(true);
  });

  it("실습 설정 폴더가 원래 ~/.claude로 연결돼 있으면 위치 확인 단계에서 거부하고 아무것도 지우지 않는다", () => {
    fixture = createFixture();
    symlinkSync(fixture.originalClaudeDir, fixture.practiceDir, "junction");
    const before = originalClaudeState(fixture);
    const result = fixture.run({ script: "claude-reset", args: ["--yes"] });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("[2/4] 실습 설정 폴더 위치: 실패");
    expect(logoutCalls(fixture)).toEqual([]);
    expect(originalClaudeState(fixture)).toEqual(before);
  });
});
