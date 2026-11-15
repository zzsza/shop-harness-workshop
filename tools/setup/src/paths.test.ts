import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeEnv, isInsideOrEqual, PRACTICE_CONFIG_DIR_NAME, REPO_ROOT, resolvePracticeConfigDir } from "./paths.ts";
import { StepFailure } from "./report.ts";

describe("isInsideOrEqual", () => {
  it.each([
    ["같은 경로", "/home/kim/.claude", "/home/kim/.claude", true],
    ["자식", "/home/kim/.claude/projects", "/home/kim/.claude", true],
    ["손자", "/home/kim/.claude/projects/repo", "/home/kim/.claude", true],
    ["부모", "/home/kim", "/home/kim/.claude", false],
    ["'..linked' 이름의 자식", "/home/kim/.claude/..linked", "/home/kim/.claude", true],
    ["'...' 이름의 자식", "/home/kim/.claude/...", "/home/kim/.claude", true],
    ["'..foo' 이름의 손자", "/home/kim/.claude/..foo/bar", "/home/kim/.claude", true],
    ["형제 claude-x", "/home/kim/.claude-x", "/home/kim/.claude", false],
    ["끝 구분자가 붙은 같은 경로", "/home/kim/.claude/", "/home/kim/.claude", true],
  ] as const)("Mac·Linux: %s", (_case, child, parent, expected) => {
    expect(isInsideOrEqual(child, parent, "darwin")).toBe(expected);
  });

  it.each([
    ["대소문자만 다른 같은 경로", "c:\\USERS\\Kim\\.Claude", "C:\\Users\\kim\\.claude", true],
    ["대소문자 다른 자식", "C:\\users\\KIM\\.claude\\Projects", "c:\\Users\\kim\\.claude", true],
    ["'..linked' 이름의 자식", "C:\\Users\\kim\\.claude\\..linked", "C:\\Users\\kim\\.claude", true],
    ["부모", "C:\\Users\\kim", "C:\\Users\\kim\\.claude", false],
    ["다른 드라이브", "D:\\Users\\kim\\.claude", "C:\\Users\\kim\\.claude", false],
    ["형제 claude-x", "C:\\Users\\kim\\.claude-x", "C:\\Users\\kim\\.claude", false],
  ] as const)("Windows: %s", (_case, child, parent, expected) => {
    expect(isInsideOrEqual(child, parent, "win32")).toBe(expected);
  });
});

describe("resolvePracticeConfigDir", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });
  function home(): string {
    const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "paths-")));
    dirs.push(dir);
    mkdirSync(path.join(dir, ".claude"));
    return dir;
  }

  it("홈 아래 .claude-workshop를 돌려주고 폴더를 만들지는 않는다", () => {
    const h = home();
    expect(resolvePracticeConfigDir(h)).toBe(path.join(h, PRACTICE_CONFIG_DIR_NAME));
    expect(existsSync(path.join(h, PRACTICE_CONFIG_DIR_NAME))).toBe(false);
  });

  it("원래 ~/.claude로 연결된 폴더는 거부한다", () => {
    const h = home();
    symlinkSync(path.join(h, ".claude"), path.join(h, PRACTICE_CONFIG_DIR_NAME), "junction");
    expect(() => resolvePracticeConfigDir(h)).toThrow(StepFailure);
  });

  it("원래 ~/.claude 안의 '..linked' 같은 이름의 폴더로 연결돼도 거부한다", () => {
    const h = home();
    const inside = path.join(h, ".claude", "..linked");
    mkdirSync(inside);
    symlinkSync(inside, path.join(h, PRACTICE_CONFIG_DIR_NAME), "junction");
    expect(() => resolvePracticeConfigDir(h)).toThrow(StepFailure);
  });

  it("레포로 연결된 폴더는 거부한다", () => {
    const h = home();
    symlinkSync(REPO_ROOT, path.join(h, PRACTICE_CONFIG_DIR_NAME), "junction");
    expect(() => resolvePracticeConfigDir(h)).toThrow(StepFailure);
  });

  it("홈 폴더 자체로 연결된 폴더는 거부한다", () => {
    const h = home();
    symlinkSync(h, path.join(h, PRACTICE_CONFIG_DIR_NAME), "junction");
    expect(() => resolvePracticeConfigDir(h)).toThrow(StepFailure);
  });

  it.each(["", "relative-home"])("홈 값이 %j처럼 절대 경로가 아니면 거부한다", (value) => {
    expect(() => resolvePracticeConfigDir(value)).toThrow(StepFailure);
  });
});

describe("claudeEnv", () => {
  it("다른 Claude Code 세션에서 물려받은 세션 변수는 빼고, 실습 설정 폴더와 나머지 변수는 넘긴다", () => {
    const inherited = { CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_SESSION_ID: "parent", CLAUDE_PID: "60016", CLAUDE_CONFIG_DIR: "/home/kim/.claude" };
    const env = claudeEnv("/home/kim/.claude-workshop", { ...inherited, PATH: "/usr/bin", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000" });
    expect(env).toEqual({ PATH: "/usr/bin", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000", CLAUDE_CONFIG_DIR: "/home/kim/.claude-workshop" });
  });
});
