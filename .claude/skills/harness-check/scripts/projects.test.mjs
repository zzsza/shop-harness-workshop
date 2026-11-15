// 점검 대상 후보는 평소 계정에서 최근에 많이 쓴 git 프로젝트다. 실습 레포·임시 폴더·git 아닌 폴더는 빼고, worktree는 원래 레포로 모은다.
import { afterAll, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listProjects } from "./projects.mjs";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".harness-check-projects-test-")));
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const now = Date.parse("2026-11-15T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function project(rel, { git = "dir", sessions = [] } = {}) {
  const dir = path.join(home, rel);
  fs.mkdirSync(dir, { recursive: true });
  if (git === "dir") fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  else if (git) fs.writeFileSync(path.join(dir, ".git"), `gitdir: ${git}\n`);
  const store = path.join(home, ".claude", "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(store, { recursive: true });
  sessions.forEach((daysAgo, i) => {
    const file = path.join(store, `s${i}.jsonl`);
    fs.writeFileSync(file, "{}\n");
    const t = new Date(now - daysAgo * DAY);
    fs.utimesSync(file, t, t);
  });
  return dir;
}

test("최근 90일 세션이 많은 git 프로젝트 순으로, 실습 레포와 git 아닌 폴더는 빼고 worktree는 원래 레포로 모은다", () => {
  const shop = project("work/shop", { sessions: [1, 2] });
  const worktree = project("wt/shop-fix", { git: path.join(shop, ".git", "worktrees", "shop-fix"), sessions: [0, 0, 0] });
  const api = project("work/api", { sessions: [5, 6, 7, 8] });
  const old = project("work/old", { sessions: [200] });
  const notGit = project("notes", { git: null, sessions: [1] });
  const practice = project("class/shop-harness-workshop", { sessions: [0, 0, 0, 0, 0, 0] });
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ projects: Object.fromEntries([shop, worktree, api, old, notGit, practice, path.join(home, "gone")].map((p) => [p, {}])) }));

  const { configDir, candidates } = listProjects({ home, exclude: practice, now });

  expect(configDir).toBe(path.join(home, ".claude"));
  expect(candidates.map((c) => [c.name, c.sessions, c.lastUsed])).toEqual([
    ["shop", 5, "2026-11-15"],
    ["api", 4, "2026-11-10"],
  ]);
});

test("~/.claude.json이 없으면 후보가 없다", () => {
  const empty = fs.mkdtempSync(path.join(home, "empty-"));
  expect(listProjects({ home: empty, now }).candidates).toEqual([]);
});
