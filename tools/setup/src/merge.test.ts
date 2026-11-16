// npm run merge 테스트: 임시 git 레포에서 진짜 git으로 합친다. 검사 실행(npm run ci)만 가짜로 둔다.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMerge, type CheckResult } from "./merge.ts";

const temps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
}

function commitFile(repo: string, file: string, content: string, message: string): void {
  writeFileSync(path.join(repo, file), content);
  git(repo, "add", file);
  git(repo, "commit", "-q", "-m", message);
}

/** 실습 브랜치 day2-a와, 거기서 딴 feat/x(커밋 하나 더). 지금은 day2-a에 있다. 합치기 커밋에 쓸 이름을 레포 설정에 둔다. */
function practiceRepo(): { repo: string; feature: string } {
  const repo = mkdtempSync(path.join(os.tmpdir(), "merge-test-"));
  temps.push(repo);
  git(repo, "init", "-q", "-b", "day2-a");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "commit.gpgsign", "false");
  commitFile(repo, "a.txt", "v1\n", "start");
  git(repo, "switch", "-q", "-c", "feat/x");
  commitFile(repo, "feat.txt", "cancel\n", "feature");
  const feature = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "-q", "day2-a");
  return { repo, feature };
}

/** 가짜 검사. 부른 인자를 남기고 정해 둔 결과를 돌려준다. */
function fakeCheck(result: CheckResult): { calls: string[][]; runCheck: (repo: string, commit: string, base: string) => Promise<CheckResult> } {
  const calls: string[][] = [];
  return { calls, runCheck: (repo, commit, base) => { calls.push([repo, commit, base]); return Promise.resolve(result); } };
}

/** 화면에 찍은 줄을 모은다. */
function output(): () => string {
  const printed: string[] = [];
  const keep = (...args: unknown[]): void => { printed.push(args.join(" ")); };
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
  return () => printed.join("\n");
}

describe("npm run merge", () => {
  it("검사가 통과하면 그 브랜치의 커밋을 지금 브랜치 기준으로 검사한 뒤 --no-ff로 합친다", async () => {
    const { repo, feature } = practiceRepo();
    const before = git(repo, "rev-parse", "HEAD");
    const check = fakeCheck({ code: 0, failed: null });
    const printed = output();

    expect(await runMerge(["feat/x"], { repo, runCheck: check.runCheck })).toBe(0);

    expect(check.calls).toEqual([[repo, feature, "day2-a"]]);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("day2-a");
    expect(git(repo, "rev-parse", "HEAD^1", "HEAD^2")).toBe(`${before}\n${feature}`);
    expect(printed()).toContain("feat/x 브랜치를 day2-a에 합쳤습니다.");
  });

  it("검사가 실패하면 합치지 않고 실패한 단계와 다시 할 일을 보인다", async () => {
    const { repo } = practiceRepo();
    const before = git(repo, "rev-parse", "HEAD");
    const printed = output();

    expect(await runMerge(["feat/x"], { repo, runCheck: fakeCheck({ code: 1, failed: "test" }).runCheck })).toBe(1);

    expect(git(repo, "rev-parse", "HEAD")).toBe(before);
    expect(printed()).toContain('"테스트" 단계에서 실패해서 feat/x 브랜치를 day2-a에 합치지 않았습니다.');
    expect(printed()).toContain("feat/x 브랜치로 옮겨(git switch feat/x) 고치고 커밋한 뒤");
    expect(printed()).toContain("npm test");
  });

  it("커밋하지 않은 변경이 있으면 검사도 합치기도 하지 않고 멈춘다", async () => {
    const { repo } = practiceRepo();
    const before = git(repo, "rev-parse", "HEAD");
    writeFileSync(path.join(repo, "a.txt"), "editing\n");
    const check = fakeCheck({ code: 0, failed: null });
    const printed = output();

    expect(await runMerge(["feat/x"], { repo, runCheck: check.runCheck })).toBe(1);

    expect(check.calls).toEqual([]);
    expect(git(repo, "rev-parse", "HEAD")).toBe(before);
    expect(printed()).toContain("커밋하지 않은 변경 1개가 있습니다(a.txt).");
  });

  it("이미 합친 브랜치나 없는 브랜치는 검사하지 않고 멈춘다", async () => {
    const { repo } = practiceRepo();
    const check = fakeCheck({ code: 0, failed: null });
    const printed = output();
    expect(await runMerge(["feat/x"], { repo, runCheck: check.runCheck })).toBe(0);

    expect(await runMerge(["feat/x"], { repo, runCheck: check.runCheck })).toBe(1);
    expect(await runMerge(["feat/nope"], { repo, runCheck: check.runCheck })).toBe(1);

    expect(check.calls).toHaveLength(1);
    expect(printed()).toContain("이미 day2-a에 합쳐져 있습니다.");
    expect(printed()).toContain("feat/nope 브랜치가 없습니다.");
  });

  it("합치다 충돌하면 git merge --abort로 합치기 전으로 되돌린다", async () => {
    const { repo } = practiceRepo();
    git(repo, "switch", "-q", "feat/x");
    commitFile(repo, "a.txt", "feature side\n", "feature edit");
    git(repo, "switch", "-q", "day2-a");
    commitFile(repo, "a.txt", "base side\n", "base edit");
    const before = git(repo, "rev-parse", "HEAD");
    const printed = output();

    expect(await runMerge(["feat/x"], { repo, runCheck: fakeCheck({ code: 0, failed: null }).runCheck })).toBe(1);

    expect(git(repo, "rev-parse", "HEAD")).toBe(before);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(printed()).toContain("충돌했습니다(a.txt). git merge --abort로 합치기 전으로 되돌렸습니다.");
  });
});
