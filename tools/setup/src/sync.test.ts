// npm run sync 테스트: 임시 원격(bare)과 수강생 clone을 만들어 진짜 git으로 돌린다. DB 되돌리기만 가짜로 둔다.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSync } from "./sync.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
}

/** Windows는 git이 체크아웃한 파일의 줄 끝을 CRLF로 바꿀 수 있어(core.autocrlf), 내용만 비교한다. */
function read(file: string): string {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

/** 강사 레포(seed)와 원격(remote.git), 그 원격을 clone한 수강생 레포(student). student는 main과 day1-a를 받아 둔 상태. */
function classroom(): { seed: string; student: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "sync-test-"));
  temps.push(root);
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  const student = path.join(root, "student");
  git(root, "init", "-q", "--bare", remote);
  git(root, "init", "-q", seed);
  writeFileSync(path.join(seed, "a.txt"), "v1\n");
  writeFileSync(path.join(seed, "package-lock.json"), "{}\n");
  writeFileSync(path.join(seed, ".gitignore"), ".env\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "start");
  git(seed, "branch", "day1-a");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-q", "origin", "main", "day1-a");
  git(root, "clone", "-q", remote, student);
  git(student, "branch", "--track", "day1-a", "origin/day1-a");
  return { seed, student };
}

const noDb = (): number => 0;

describe("npm run sync", () => {
  it("바뀐 파일·새 파일·원격에 없는 커밋을 버리고 강사가 올린 최신으로 맞추며, git이 무시하는 파일은 남긴다", async () => {
    const { seed, student } = classroom();
    writeFileSync(path.join(seed, "a.txt"), "v2\n");
    git(seed, "commit", "-q", "-am", "instructor fix");
    git(seed, "push", "-q", "origin", "main");
    writeFileSync(path.join(student, "a.txt"), "broken\n");
    writeFileSync(path.join(student, "new.txt"), "scratch\n");
    writeFileSync(path.join(student, ".env"), "KEEP=1\n");
    git(student, "switch", "-q", "day1-a");
    writeFileSync(path.join(student, "mine.txt"), "x\n");
    git(student, "add", "mine.txt");
    git(student, "commit", "-q", "-m", "student commit");
    git(student, "switch", "-q", "main");

    const code = await runSync(["--yes"], { repo: student, resetDatabase: noDb });

    expect(code).toBe(0);
    expect(read(path.join(student, "a.txt"))).toBe("v2\n");
    expect(existsSync(path.join(student, "new.txt"))).toBe(false);
    expect(read(path.join(student, ".env"))).toBe("KEEP=1\n");
    expect(git(student, "rev-parse", "day1-a")).toBe(git(student, "rev-parse", "origin/day1-a"));
    expect(git(student, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  it("브랜치를 주면 그 브랜치로 옮기고, 아직 받아 두지 않은 브랜치도 원격에서 만든다", async () => {
    const { seed, student } = classroom();
    git(seed, "branch", "day1-b");
    git(seed, "push", "-q", "origin", "day1-b");

    expect(await runSync(["day1-b", "--yes"], { repo: student, resetDatabase: noDb })).toBe(0);
    expect(git(student, "rev-parse", "--abbrev-ref", "HEAD")).toBe("day1-b");
    expect(git(student, "rev-parse", "--abbrev-ref", "day1-b@{upstream}")).toBe("origin/day1-b");
  });

  it("fork를 이어 강사 레포가 upstream이면 내 fork(origin)가 아니라 upstream에서 받아 맞춘다", async () => {
    const { seed, student } = classroom();
    const fork = path.join(path.dirname(student), "fork.git");
    git(path.dirname(student), "clone", "-q", "--bare", path.join(path.dirname(student), "remote.git"), fork);
    git(student, "remote", "rename", "origin", "upstream");
    git(student, "remote", "add", "origin", fork);
    git(student, "fetch", "-q", "origin");
    git(student, "switch", "-q", "-c", "feat/x");
    writeFileSync(path.join(student, "feat.txt"), "mine\n");
    git(student, "add", "feat.txt");
    git(student, "commit", "-q", "-m", "feature");
    git(student, "push", "-q", "-u", "origin", "feat/x");
    git(student, "switch", "-q", "day1-a");
    writeFileSync(path.join(seed, "a.txt"), "v2\n");
    git(seed, "commit", "-q", "-am", "instructor fix");
    git(seed, "branch", "-f", "day1-a", "main");
    git(seed, "push", "-q", "origin", "main", "day1-a");

    expect(await runSync(["--yes"], { repo: student, resetDatabase: noDb })).toBe(0);
    expect(read(path.join(student, "a.txt"))).toBe("v2\n");
    expect(git(student, "rev-parse", "main")).toBe(git(student, "rev-parse", "upstream/main"));
    expect(git(student, "rev-parse", "feat/x")).toBe(git(student, "rev-parse", "origin/feat/x"));
  });

  it("원격에 없는 브랜치를 주면 아무것도 바꾸지 않고 멈춘다", async () => {
    const { student } = classroom();
    writeFileSync(path.join(student, "a.txt"), "keep me\n");

    expect(await runSync(["day9", "--yes"], { repo: student, resetDatabase: noDb })).toBe(1);
    expect(read(path.join(student, "a.txt"))).toBe("keep me\n");
  });
});
