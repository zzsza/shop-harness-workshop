#!/usr/bin/env node
// 하네스 점검 대상 후보: 평소 계정(~/.claude)으로 최근 90일에 Claude Code를 많이 쓴 git 프로젝트(세션 수가 많은 순).
// 실습 레포에서 점검을 돌리면 실습 레포에는 수강생의 하네스가 없으므로, 평소 일하는 프로젝트를 고르게 한다.
// 읽는 것: ~/.claude.json의 projects 키(폴더 경로)와 ~/.claude/projects/<폴더>/의 세션 파일 개수·마지막 수정 시각. 세션 내용은 열지 않는다.
//
// node projects.mjs [--exclude <폴더>] [--limit <n>]
// 표준 출력: { "configDir": "<평소 설정 폴더>", "candidates": [{ "path", "name", "lastUsed", "sessions" }] }
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_DAYS = 90;

function realPath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** ~/.claude.json에 Claude Code가 적어 둔 프로젝트 폴더 경로. 파일이 없으면 빈 목록. */
function readKnownPaths(file) {
  if (!fs.existsSync(file)) return [];
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}을 읽지 못했습니다: ${error.message}`, { cause: error });
  }
  return Object.keys(data?.projects ?? {});
}

/** 폴더가 속한 git 레포의 원래 폴더. worktree면 원래 레포로 모은다. git 레포가 아니면 null. */
function repoRoot(dir, home) {
  let current = path.resolve(dir);
  if (!fs.existsSync(current) || !fs.statSync(current).isDirectory()) return null;
  for (;;) {
    const git = path.join(current, ".git");
    if (fs.existsSync(git)) {
      if (fs.statSync(git).isDirectory()) return current;
      const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(git, "utf8"))?.[1]?.trim();
      const main = pointer ? pointer.split(/[\\/]\.git[\\/]worktrees[\\/]/)[0] : undefined;
      const mainAbs = main && main !== pointer ? path.resolve(current, main) : undefined;
      return mainAbs && fs.existsSync(mainAbs) ? mainAbs : current;
    }
    const parent = path.dirname(current);
    if (parent === current || current === home) return null;
    current = parent;
  }
}

/** since 이후에 고친 세션 파일(.jsonl) 개수와 가장 최근 수정 시각. */
function sessionUsage(dir, since) {
  let count = 0;
  let last = 0;
  if (!fs.existsSync(dir)) return { count, last };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const mtime = fs.statSync(path.join(dir, entry.name)).mtimeMs;
    if (mtime < since) continue;
    count++;
    last = Math.max(last, mtime);
  }
  return { count, last };
}

export function listProjects({ home = os.homedir(), exclude, limit = 5, now = Date.now() } = {}) {
  const configDir = path.join(home, ".claude");
  const realHome = realPath(home);
  const excluded = exclude ? realPath(exclude) : null;
  const temps = [os.tmpdir(), "/tmp", "/private/tmp", "/private/var/folders"].map(realPath);
  const skip = (root) =>
    root === realHome ||
    isInside(root, realPath(configDir)) ||
    temps.some((t) => isInside(root, t)) ||
    (excluded !== null && (isInside(root, excluded) || isInside(excluded, root) || path.basename(root) === path.basename(excluded)));

  const byRoot = new Map();
  for (const dir of readKnownPaths(path.join(home, ".claude.json"))) {
    const found = repoRoot(dir, home);
    if (found === null) continue;
    const root = realPath(found);
    if (skip(root)) continue;
    const usage = sessionUsage(path.join(configDir, "projects", dir.replace(/[^a-zA-Z0-9]/g, "-")), now - RECENT_DAYS * DAY_MS);
    if (usage.count === 0) continue;
    const seen = byRoot.get(root) ?? { sessions: 0, last: 0 };
    byRoot.set(root, { sessions: seen.sessions + usage.count, last: Math.max(seen.last, usage.last) });
  }
  const candidates = [...byRoot.entries()]
    .sort((a, b) => b[1].sessions - a[1].sessions || b[1].last - a[1].last)
    .slice(0, limit)
    .map(([root, u]) => ({ path: root, name: path.basename(root), lastUsed: new Date(u.last).toISOString().slice(0, 10), sessions: u.sessions }));
  return { configDir, candidates };
}

function parseArgs(argv) {
  const args = { limit: 5 };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${key} 뒤에 값이 필요합니다.`);
    if (key === "--exclude") args.exclude = path.resolve(value);
    else if (key === "--limit") args.limit = Number(value);
    else throw new Error(`모르는 인자: ${key}`);
    i++;
  }
  if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error("--limit은 1 이상의 정수입니다.");
  return args;
}

if (process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url))) {
  try {
    console.log(JSON.stringify(listProjects(parseArgs(process.argv.slice(2)))));
  } catch (error) {
    console.error(`projects.mjs: ${error.message}`);
    process.exit(1);
  }
}
