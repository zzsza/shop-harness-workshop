#!/usr/bin/env node
// 하네스 점검 스캔. 레포와 평소 설정 폴더를 읽기만 하고, 결과 폴더에 facts.json을 쓴다.
// 표준 출력에는 결과 폴더와 점검 담당(day1·day2·day3)에게 넘길 브리프를 JSON 한 덩어리로 낸다.
//
// node scan.mjs [--repo <폴더>] [--config <설정 폴더>] [--sessions yes|no]
//               [--pain <글>] [--out-root <폴더>]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadChecklist } from "./checklist.mjs";

const MAX_FILES = 50_000;
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_SESSION_FILES = 200;
const SESSION_DAYS = 30;
const LIST_CAP = 30;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".venv", "venv", "target", ".next", ".turbo", "__pycache__"]);
// 담당 에이전트가 파일을 열어 의심을 걸림·깨끗으로 확정하는 스캔 항목이다(점검표 판정 칸의 「담당이 확정」).
const CONFIRMABLE = new Set(["a-claude-dump", "a-stale-ref", "a-skill-desc", "a-stop-loop", "a-hook-matcher-all", "a-map-stale"]);
const NUDGE = /^(계속|계속해|계속해줘|계속 진행|계속 진행해|이어서|이어서 해|다시|다시 해|다시해|다시 해줘|재시도|진행해|진행해줘|continue|keep going|go on|go ahead|retry|try again)[.!~ ]*$/i;
const SECRET_VALUE = /^(sk-|sk_|ghp_|gho_|ghs_|github_pat_|xox[abps]-|AKIA|AIza|glpat-|npm_)/;

// 이 점검 자신. 레포 안(.claude/skills)이나 내 설정 폴더에 들어 있어도 점검 대상으로 세지 않는다.
const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWN_SKILL = "harness-check";
const OWN_AGENT = "harness-inspector";
const OWN_AGENT_FILE = `.claude/agents/${OWN_AGENT}.md`;

class UsageError extends Error {}

// ---------- 인자 ----------

export function parseArgs(argv) {
  const args = { repo: process.cwd(), config: null, sessions: "no", pain: "", outRoot: path.join(os.homedir(), ".harness-check") };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    const need = () => {
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${key} 뒤에 값이 필요합니다.`);
      i++;
      return value;
    };
    if (key === "--repo") args.repo = need();
    else if (key === "--config") args.config = need();
    else if (key === "--sessions") args.sessions = need();
    else if (key === "--pain") args.pain = need();
    else if (key === "--out-root") args.outRoot = need();
    else throw new UsageError(`모르는 옵션 ${key}입니다.`);
  }
  if (!["yes", "no"].includes(args.sessions)) throw new UsageError("--sessions는 yes나 no입니다.");
  args.repo = path.resolve(args.repo);
  if (!fs.existsSync(args.repo) || !fs.statSync(args.repo).isDirectory()) throw new UsageError(`레포 폴더 ${args.repo}가 없습니다.`);
  return args;
}

// ---------- 작은 도구 ----------

const toPosix = (p) => p.split(path.sep).join("/");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, "$2");

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readJson(file) {
  if (!fs.existsSync(file)) return { exists: false, data: null, error: null };
  const text = readText(file);
  if (text === null) return { exists: true, data: null, error: "읽을 수 없음" };
  try {
    return { exists: true, data: JSON.parse(text), error: null };
  } catch (error) {
    return { exists: true, data: null, error: `JSON 형식 오류: ${error.message}` };
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walk(root, limit = MAX_FILES) {
  const out = [];
  const stack = [""];
  while (stack.length && out.length < limit) {
    const rel = stack.pop();
    for (const entry of listDir(path.join(root, rel))) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(child);
      } else if (entry.isFile()) {
        out.push(child);
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

export function parseFrontmatter(text) {
  if (!text.startsWith("---")) return { data: {}, body: text };
  const firstBreak = text.indexOf("\n");
  const end = text.indexOf("\n---", firstBreak);
  if (firstBreak < 0 || end < 0) return { data: {}, body: text };
  const lines = text.slice(firstBreak + 1, end).split(/\r?\n/);
  const data = {};
  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const [, key, raw] = match;
    const value = raw.trim();
    if (["", "|", ">", "|-", ">-"].includes(value)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1] === "")) block.push(lines[++i]);
      const items = block.map((line) => /^\s*-\s+(.*)$/.exec(line)).filter(Boolean);
      if (value === "" && items.length && items.length === block.filter((line) => line.trim()).length) data[key] = items.map((m) => unquote(m[1]));
      else if (value === "") data[key] = block.join("\n");
      else data[key] = block.map((line) => line.trim()).join(value.startsWith(">") ? " " : "\n").trim();
    } else if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = value.slice(1, -1).split(",").map(unquote).filter(Boolean);
    } else {
      data[key] = unquote(value);
    }
  }
  return { data, body: text.slice(end + 4) };
}

export function globToRegExp(glob) {
  const g = glob.trim().replace(/^\.\//, "").replace(/^\//, "");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        if (g[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const close = g.indexOf("}", i);
      if (close > i) {
        re += `(?:${g.slice(i + 1, close).split(",").map(escapeRe).join("|")})`;
        i = close;
      } else re += "\\{";
    } else if (c === "[") {
      const close = g.indexOf("]", i);
      if (close > i) {
        re += `[${g.slice(i + 1, close).replace(/^!/, "^")}]`;
        i = close;
      } else re += "\\[";
    } else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`);
}

export function globMatchesAny(glob, files) {
  const pattern = glob.trim().replace(/^\.\//, "").replace(/^\//, "");
  if (!pattern) return true;
  const re = globToRegExp(pattern);
  const noSlash = !pattern.includes("/");
  const dirPrefix = pattern.replace(/\/$/, "") + "/";
  return files.some((file) => re.test(file) || (noSlash && re.test(file.split("/").pop())) || (!/[*?{[]/.test(pattern) && file.startsWith(dirPrefix)));
}

/** 코드 블록과 코드 칸을 뺀 글과, 코드 블록 줄 수를 돌려준다. */
function splitCode(text) {
  const prose = [];
  const blocks = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (current) {
        blocks.push(current);
        current = null;
      } else current = [];
      continue;
    }
    if (current) current.push(line);
    else prose.push(line);
  }
  if (current) blocks.push(current);
  return { prose: prose.join("\n"), blocks };
}

function backtickPaths(text) {
  const out = new Set();
  for (const match of text.matchAll(/`([^`\s]+)`/g)) {
    const candidate = match[1].replace(/[:#].*$/, "").replace(/[.,]$/, "");
    if (!candidate.includes("/")) continue;
    if (/^(https?:|\/\/|~|\$|-|@)/.test(candidate)) continue;
    if (/[*?<>{}()=|]/.test(candidate)) continue;
    if (!/^[\w.@/-]+$/.test(candidate)) continue;
    if (/^\d+\/\d+$/.test(candidate)) continue;
    out.add(candidate);
  }
  return [...out];
}

// 문서의 백틱 경로가 실제로 있는지. 기준 폴더에서 바로 찾고, 없으면 레포 파일 중 그 경로로 끝나는 것을 찾는다.
// 구조 문서는 "apps/api의 `src/main.ts`"처럼 앱 폴더 기준으로 줄여 쓰는 일이 많아서, 바로 찾기만 하면 있는 파일을 없다고 한다.
function pathExists(candidate, repo, fromDirs) {
  if (fromDirs.some((dir) => fs.existsSync(path.resolve(dir, candidate)))) return true;
  const rel = candidate.replace(/^\.\//, "");
  if (rel.startsWith("../")) return false;
  const needle = `/${rel.replace(/\/$/, "")}`;
  return repo.files.some((f) => {
    const full = `/${f}`;
    return rel.endsWith("/") ? full.includes(`${needle}/`) : full.endsWith(needle) || full.includes(`${needle}/`);
  });
}

function jaccard(a, b) {
  const words = (s) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((w) => !["the", "and", "for", "use", "when", "this", "with", "한다", "쓴다", "때", "있는"].includes(w)));
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}

function managedSettingsPath() {
  if (process.platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (process.platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}

function encodeProjectDir(root) {
  return root.replace(/[^a-zA-Z0-9]/g, "-");
}

function stamp(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

// ---------- 수집 ----------

const hookLabel = (h) => h.script ?? (h.command.length > 60 ? `${h.command.slice(0, 60)}…` : h.command);

/** Hook 본문이 실행을 막을 수 있는지 본다. 종료 코드 2나 block 결정을 내지 않으면 알림용이라 끝없이 막을 일이 없다. */
function canBlock(body) {
  return /exit\s*\(?\s*2\b|exitCode\s*=\s*2|"decision"|decision\s*:|permissionDecision|"block"/.test(body);
}

function collectRepo(repoArg) {
  const top = git(["rev-parse", "--show-toplevel"], repoArg);
  const root = top ? path.resolve(top.trim()) : repoArg;
  const isGit = Boolean(top);
  let files;
  let tracked;
  let capped = false;
  if (isGit) {
    files = (git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root) ?? "").split("\0").filter(Boolean);
    tracked = new Set((git(["ls-files", "-z"], root) ?? "").split("\0").filter(Boolean));
    if (files.length > MAX_FILES) {
      files = files.slice(0, MAX_FILES);
      capped = true;
    }
  } else {
    files = walk(root);
    capped = files.length >= MAX_FILES;
    tracked = new Set();
  }
  // 이 점검이 점검 대상 레포 안에 있으면(실습 레포) 점검 스킬과 점검 담당 파일을 근거로도, Skill·에이전트로도 세지 않는다.
  const ownRel = path.relative(root, SKILL_ROOT);
  const ownPaths = !ownRel.startsWith("..") && !path.isAbsolute(ownRel) ? [`${toPosix(ownRel)}/`, OWN_AGENT_FILE] : [];
  const isOwn = (f) => ownPaths.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p));
  files = files.filter((f) => !isOwn(f));
  tracked = new Set([...tracked].filter((f) => !isOwn(f)));
  const count = (args) => {
    const out = isGit ? git(args, root) : null;
    return out === null ? null : Number(out.trim() || 0);
  };
  const harnessPaths = ["--", "CLAUDE.md", "AGENTS.md", ".claude", ":(glob)**/CLAUDE.md", ...ownPaths.map((p) => `:(exclude)${p}`)];
  const lines = (args) => {
    const out = isGit ? git(args, root) : null;
    return out === null ? null : out.split("\n").filter(Boolean).length;
  };
  const worktrees = isGit ? (git(["worktree", "list", "--porcelain"], root) ?? "").split("\n").filter((l) => l.startsWith("worktree ")).length : 0;
  return {
    root,
    name: path.basename(root),
    isGit,
    files,
    tracked,
    ownPaths,
    capped,
    commits90: count(["rev-list", "--count", "--since=90.days", "HEAD"]),
    harnessCommits30: lines(["log", "--since=30.days", "--format=%H", ...harnessPaths]),
    harnessCommits90: lines(["log", "--since=90.days", "--format=%H", ...harnessPaths]),
    worktrees,
  };
}

function collectSettings(repo, configDir) {
  const scopes = [
    { scope: "사용자", file: path.join(configDir, "settings.json") },
    { scope: "프로젝트", file: path.join(repo.root, ".claude", "settings.json") },
    { scope: "로컬", file: path.join(repo.root, ".claude", "settings.local.json") },
    { scope: "관리", file: managedSettingsPath() },
  ];
  return scopes.map((s) => ({ ...s, ...readJson(s.file) }));
}

function display(file, repo, home) {
  const abs = path.resolve(file);
  const rel = path.relative(repo.root, abs);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return toPosix(rel);
  const fromHome = path.relative(home, abs);
  if (!fromHome.startsWith("..") && !path.isAbsolute(fromHome)) return `~/${toPosix(fromHome)}`;
  return toPosix(abs);
}

function collectSkills(repo, configDir, settings, show) {
  const skills = [];
  const add = (scope, file) => {
    const text = readText(file);
    if (text === null) return;
    const { data } = parseFrontmatter(text);
    const isCommand = !file.endsWith("SKILL.md");
    const name = data.name || (isCommand ? path.basename(file, ".md") : path.basename(path.dirname(file)));
    const description = typeof data.description === "string" ? data.description.trim() : "";
    const hooksBlock = typeof data.hooks === "string" ? data.hooks : "";
    skills.push({ scope, name, description, path: show(file), hooksBlock, command: isCommand });
  };
  for (const rel of repo.files) {
    if (/^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(rel) || /^\.claude\/commands\/.+\.md$/.test(rel)) add("프로젝트", path.join(repo.root, rel));
  }
  for (const entry of listDir(path.join(configDir, "skills"))) if (entry.isDirectory() && entry.name !== OWN_SKILL) add("사용자", path.join(configDir, "skills", entry.name, "SKILL.md"));
  for (const entry of listDir(path.join(configDir, "commands"))) if (entry.isFile() && entry.name.endsWith(".md")) add("사용자", path.join(configDir, "commands", entry.name));
  const enabled = new Set();
  for (const s of settings) for (const [key, on] of Object.entries(s.data?.enabledPlugins ?? {})) if (on) enabled.add(key);
  const installed = readJson(path.join(configDir, "plugins", "installed_plugins.json")).data?.plugins ?? {};
  for (const key of enabled) {
    const installPath = installed[key]?.[0]?.installPath;
    if (!installPath) continue;
    for (const entry of listDir(path.join(installPath, "skills"))) if (entry.isDirectory()) add(`플러그인 ${key.split("@")[0]}`, path.join(installPath, "skills", entry.name, "SKILL.md"));
  }
  return skills;
}

function collectAgents(repo, configDir, show) {
  const agents = [];
  const add = (scope, file) => {
    const text = readText(file);
    if (text === null) return;
    const { data } = parseFrontmatter(text);
    agents.push({ scope, name: data.name || path.basename(file, ".md"), description: String(data.description ?? "").slice(0, 200), model: data.model ?? null, tools: data.tools ?? null, maxTurns: data.maxTurns ?? null, path: show(file) });
  };
  for (const rel of repo.files) if (/^\.claude\/agents\/[^/]+\.md$/.test(rel)) add("프로젝트", path.join(repo.root, rel));
  for (const entry of listDir(path.join(configDir, "agents"))) if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== `${OWN_AGENT}.md`) add("사용자", path.join(configDir, "agents", entry.name));
  return agents;
}

function scriptPathFrom(command, repo) {
  const expanded = command.replace(/\$\{?CLAUDE_PROJECT_DIR\}?/g, repo.root).replace(/(^|\s)~\//g, `$1${os.homedir()}/`);
  for (const token of expanded.match(/"[^"]+"|'[^']+'|\S+/g) ?? []) {
    const t = unquote(token);
    if (/\.(mjs|cjs|js|ts|py|sh|ps1)$/.test(t)) {
      const abs = path.isAbsolute(t) ? t : path.resolve(repo.root, t);
      if (fs.existsSync(abs)) return abs;
    }
  }
  return null;
}

function collectHooks(settings, skills, repo, show) {
  const hooks = [];
  for (const s of settings) {
    for (const [event, groups] of Object.entries(s.data?.hooks ?? {})) {
      for (const group of Array.isArray(groups) ? groups : []) {
        for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
          const command = typeof hook.command === "string" ? hook.command : "";
          const script = command ? scriptPathFrom(command, repo) : null;
          const body = (script ? readText(script) : null) ?? command;
          hooks.push({ scope: s.scope, event, matcher: group.matcher ?? "", command: command.slice(0, 120), script: script ? show(script) : null, stopActive: body.includes("stop_hook_active"), canBlock: canBlock(body) });
        }
      }
    }
  }
  for (const skill of skills) {
    if (!skill.hooksBlock) continue;
    const events = [...skill.hooksBlock.matchAll(/^\s+([A-Z][A-Za-z]+):/gm)].map((m) => m[1]).filter((e) => /^(PreToolUse|PostToolUse|Stop|SubagentStop|UserPromptSubmit|SessionStart|Notification|PreCompact)$/.test(e));
    const commands = [...skill.hooksBlock.matchAll(/command:\s*(.+)$/gm)].map((m) => unquote(m[1]));
    for (const event of new Set(events)) {
      const command = commands[0] ?? "";
      const script = command ? scriptPathFrom(command, repo) : null;
      const body = (script ? readText(script) : null) ?? command;
      hooks.push({ scope: `Skill ${skill.name}`, event, matcher: "", command: command.slice(0, 120), script: script ? show(script) : null, stopActive: body.includes("stop_hook_active"), canBlock: canBlock(body) });
    }
  }
  return hooks;
}

function collectMcp(repo, configDir) {
  const servers = [];
  const project = readJson(path.join(repo.root, ".mcp.json")).data?.mcpServers ?? {};
  for (const [name, def] of Object.entries(project)) servers.push({ scope: "프로젝트", name, env: def?.env ?? {} });
  const claudeJsonPath = path.resolve(configDir) === path.join(os.homedir(), ".claude") ? path.join(os.homedir(), ".claude.json") : path.join(configDir, ".claude.json");
  const claudeJson = readJson(claudeJsonPath).data ?? {};
  for (const name of Object.keys(claudeJson.mcpServers ?? {})) servers.push({ scope: "사용자", name, env: {} });
  const projects = claudeJson.projects ?? {};
  const entry = projects[repo.root] ?? projects[toPosix(repo.root)];
  for (const name of Object.keys(entry?.mcpServers ?? {})) servers.push({ scope: "로컬", name, env: {} });
  return servers;
}

function collectInstructionFiles(repo, configDir, show) {
  const files = [];
  const add = (scope, file) => {
    const text = readText(file);
    if (text === null) return;
    const { prose, blocks } = splitCode(text);
    files.push({ scope, file, path: show(file), dir: path.dirname(file), text, prose, lines: text.split(/\r?\n/).length, codeLines: blocks.reduce((n, b) => n + b.length, 0), blocks });
  };
  for (const rel of repo.files) if (/(^|\/)(CLAUDE|CLAUDE\.local)\.md$/.test(rel)) add("프로젝트", path.join(repo.root, rel));
  add("사용자", path.join(configDir, "CLAUDE.md"));
  return files;
}

function collectRules(repo, configDir, show) {
  const rules = [];
  const add = (scope, file) => {
    const text = readText(file);
    if (text === null) return;
    const { data } = parseFrontmatter(text);
    let paths = data.paths ?? [];
    if (typeof paths === "string") paths = paths.split(",").map((p) => p.trim()).filter(Boolean);
    rules.push({ scope, path: show(file), text, paths });
  };
  for (const rel of repo.files) if (/^\.claude\/rules\/.+\.md$/.test(rel)) add("프로젝트", path.join(repo.root, rel));
  for (const rel of walk(path.join(configDir, "rules"), 500)) if (rel.endsWith(".md")) add("사용자", path.join(configDir, "rules", rel));
  return rules;
}

async function collectSessions(repo, configDir, mcpNames) {
  const dir = path.join(configDir, "projects", encodeProjectDir(repo.root));
  const since = Date.now() - SESSION_DAYS * 24 * 3600 * 1000;
  const files = listDir(dir)
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => path.join(dir, e.name))
    .filter((f) => fs.statSync(f).mtimeMs >= since)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .slice(0, MAX_SESSION_FILES);
  const stats = { sessions: files.length, userMessages: 0, planMessages: 0, bypassMessages: 0, slash: {}, subagentCalls: 0, worktreeUses: 0, maxCompactions: 0, sessionsWith2Compactions: 0, nudges: 0, repeated: [], mcpUsed: {} };
  const repeats = new Map();
  for (const file of files) {
    let compactions = 0;
    const stream = fs.createReadStream(file, { encoding: "utf8" });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"') && !line.includes("compact_boundary")) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type === "system" && entry.subtype === "compact_boundary") compactions++;
      if (entry.isSidechain) continue;
      if (entry.type === "assistant" && Array.isArray(entry.message?.content)) {
        for (const block of entry.message.content) {
          if (block?.type !== "tool_use") continue;
          if (block.name === "Agent" || block.name === "Task") stats.subagentCalls++;
          if (block.name === "EnterWorktree") stats.worktreeUses++;
          const mcp = /^mcp__(.+?)__/.exec(block.name ?? "");
          if (mcp) stats.mcpUsed[mcp[1]] = (stats.mcpUsed[mcp[1]] ?? 0) + 1;
        }
      }
      if (entry.type !== "user" || entry.isMeta) continue;
      const content = entry.message?.content;
      const text = typeof content === "string" ? content : Array.isArray(content) && !content.some((b) => b?.type === "tool_result") ? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : null;
      if (text === null) continue;
      const command = /^<command-name>\/?([\w:-]+)<\/command-name>/.exec(text.trim());
      if (command) {
        stats.slash[command[1]] = (stats.slash[command[1]] ?? 0) + 1;
        continue;
      }
      if (text.trim().startsWith("<")) continue;
      stats.userMessages++;
      if (entry.permissionMode === "plan") stats.planMessages++;
      if (entry.permissionMode === "bypassPermissions") stats.bypassMessages++;
      const normalized = text.trim().replace(/\s+/g, " ");
      if (NUDGE.test(normalized)) stats.nudges++;
      if (normalized.length > 30 && repeats.size < 5000) {
        const key = normalized.toLowerCase();
        repeats.set(key, (repeats.get(key) ?? 0) + 1);
      }
    }
    stats.maxCompactions = Math.max(stats.maxCompactions, compactions);
    if (compactions >= 2) stats.sessionsWith2Compactions++;
  }
  stats.repeated = [...repeats.values()].filter((count) => count >= 3).sort((a, b) => b - a).slice(0, 5);
  const normalize = (n) => n.replace(/[^a-zA-Z0-9_-]/g, "_");
  const used = new Set(Object.keys(stats.mcpUsed).map(normalize));
  stats.unusedMcp = mcpNames.filter((n) => !used.has(normalize(n)));
  return stats;
}

// ---------- 판정 ----------

function judge(ctx) {
  const { repo, settings, skills, agents, hooks, mcp, instructions, rules, memory, sessions, home } = ctx;
  const results = {};
  const set = (id, result, evidence = [], note = "") => {
    results[id] = { result, evidence: evidence.slice(0, 8), note, by: "스캔" };
  };
  const projectInstructions = instructions.filter((f) => f.scope === "프로젝트");
  const rootClaude = instructions.find((f) => f.scope === "프로젝트" && (f.path === "CLAUDE.md" || f.path === ".claude/CLAUDE.md"));
  const rootAgents = repo.files.includes("AGENTS.md") ? readText(path.join(repo.root, "AGENTS.md")) : null;
  const allowed = settings.flatMap((s) => (s.data?.permissions?.allow ?? []).map((rule) => ({ scope: s.scope, rule: String(rule) })));
  const denied = settings.flatMap((s) => (s.data?.permissions?.deny ?? []).map((rule) => ({ scope: s.scope, rule: String(rule) })));
  const asked = settings.flatMap((s) => (s.data?.permissions?.ask ?? []).map((rule) => ({ scope: s.scope, rule: String(rule) })));
  const brokenSettings = settings.filter((s) => s.error);
  const settingsNote = brokenSettings.length ? `읽지 못한 설정: ${brokenSettings.map((s) => `${s.scope}(${s.error})`).join(", ")}` : "";

  // Day1 · Claude Code 기본기
  set("perm-allow", allowed.length ? "있음" : "없음", allowed.length ? [`allow 규칙 ${allowed.length}개 (${[...new Set(allowed.map((a) => a.scope))].join("·")})`] : [], settingsNote);
  const statusLine = settings.find((s) => s.data?.statusLine);
  set("tools-statusline", statusLine ? "있음" : "없음", statusLine ? [`${statusLine.scope} 설정 statusLine`] : []);

  // Day1 · 컨텍스트와 메모리
  const userClaude = instructions.find((f) => f.scope === "사용자");
  if (rootClaude) set("guide-root", "있음", [`${rootClaude.path} ${rootClaude.lines}줄`]);
  else if (rootAgents !== null) set("guide-root", "일부", ["AGENTS.md만 있음"], "Claude Code는 CLAUDE.md를 읽는다. CLAUDE.md에 @AGENTS.md 한 줄을 두면 같이 읽힌다");
  else if (userClaude) set("guide-root", "일부", [`${userClaude.path}만 있음`], "이 레포만의 명령과 함정은 레포 CLAUDE.md에 둔다");
  else set("guide-root", "없음");
  const nested = projectInstructions.filter((f) => f.path.includes("/") && f.path !== ".claude/CLAUDE.md");
  const scopedRules = rules.filter((r) => r.scope === "프로젝트" && r.paths.length);
  set("guide-scoped", nested.length || scopedRules.length ? "있음" : "없음", [...nested.map((f) => f.path), ...scopedRules.map((r) => `${r.path} (paths ${r.paths.length}개)`)]);
  const handoffFiles = repo.files.filter((f) => /handoff|인계/i.test(f.split("/").pop()));
  const handoffRule = instructions.find((f) => /handoff|인계/i.test(f.text));
  set("guide-handoff", handoffFiles.length || handoffRule ? "있음" : "없음", [...handoffFiles.slice(0, 3), ...(handoffRule ? [`${handoffRule.path}에 인계 규칙`] : [])]);

  if (!instructions.length) {
    for (const id of ["a-claude-long", "a-claude-dump", "a-stale-ref"]) set(id, "해당없음", [], "CLAUDE.md가 없음");
  } else {
    const long = instructions.filter((f) => f.lines > 200);
    set("a-claude-long", long.length ? "걸림" : "깨끗", long.map((f) => `${f.path} ${f.lines}줄`));
    const dump = instructions.filter((f) => f.codeLines >= 40);
    set("a-claude-dump", dump.length ? "의심" : "깨끗", dump.map((f) => `${f.path} 코드 블록 ${f.codeLines}줄`));
    const sure = [];
    const maybe = [];
    const pkg = readJson(path.join(repo.root, "package.json")).data;
    const rootScripts = new Set(Object.keys(pkg?.scripts ?? {}));
    const workspaceScripts = new Set();
    for (const rel of repo.files) {
      if (rel !== "package.json" && rel.endsWith("/package.json")) for (const name of Object.keys(readJson(path.join(repo.root, rel)).data?.scripts ?? {})) workspaceScripts.add(name);
    }
    for (const f of instructions) {
      const plain = f.prose.replace(/`[^`]*`/g, " ");
      for (const m of plain.matchAll(/(?:^|\s)@([~./\w-][^\s)\]]*)/g)) {
        const target = m[1].startsWith("~/") ? path.join(home, m[1].slice(2)) : path.resolve(f.dir, m[1]);
        if (!m[1].includes("/") && !m[1].includes(".")) continue;
        if (!fs.existsSync(target)) sure.push(`${f.path}: @${m[1]} 없음`);
      }
      if (pkg && f.scope === "프로젝트") {
        for (const line of f.text.split(/\r?\n/)) {
          if (/\bcd\s|--workspace|\s-w\s|--prefix/.test(line)) continue;
          for (const m of line.matchAll(/npm run ([\w:.-]+)/g)) {
            if (rootScripts.has(m[1])) continue;
            if (workspaceScripts.has(m[1])) maybe.push(`${f.path}: npm run ${m[1]} (하위 패키지에만 있음)`);
            else sure.push(`${f.path}: npm run ${m[1]} 없음`);
          }
        }
      }
      // 사용자 범위 지침의 백틱 경로는 "어느 레포든"을 뜻하므로 이 레포 기준으로 따지지 않는다.
      for (const candidate of f.scope === "프로젝트" ? backtickPaths(f.text) : []) {
        if (!pathExists(candidate, repo, [repo.root, f.dir])) maybe.push(`${f.path}: \`${candidate}\` 없음`);
      }
    }
    set("a-stale-ref", sure.length ? "걸림" : maybe.length ? "의심" : "깨끗", [...new Set([...sure, ...maybe])]);
  }
  const projectRulesWithPaths = rules.filter((r) => r.scope === "프로젝트" && r.paths.length);
  if (!projectRulesWithPaths.length) set("a-rules-dead", "해당없음", [], "paths가 있는 프로젝트 Rules가 없음");
  else {
    const dead = projectRulesWithPaths.flatMap((r) => r.paths.filter((p) => !globMatchesAny(p, repo.files)).map((p) => `${r.path}: ${p}`));
    set("a-rules-dead", dead.length ? "걸림" : "깨끗", dead);
  }
  if (!memory) set("a-memory-long", "해당없음", [], "이 레포의 자동 메모리가 없음");
  else set("a-memory-long", memory.lines > 200 || memory.bytes > 25 * 1024 ? "걸림" : "깨끗", [`${memory.path} ${memory.lines}줄, ${Math.round(memory.bytes / 1024)}KB`]);

  // Day1 · Skill · 서브에이전트 · MCP
  set("tools-skill", skills.length ? "있음" : "없음", skills.length ? [`Skill ${skills.length}개 (${[...new Set(skills.map((s) => s.scope))].join("·")})`] : []);
  set("tools-agent", agents.length ? "있음" : "없음", agents.map((a) => a.path));
  if (!agents.length) set("tools-agent-model", "해당없음", [], "담당자 파일이 없음");
  else {
    const withModel = agents.filter((a) => a.model);
    set("tools-agent-model", withModel.length ? "있음" : "일부", withModel.map((a) => `${a.path} model: ${a.model}`), withModel.length ? "" : "담당자 파일은 있는데 모델을 정한 것이 없음");
  }
  const ownSkills = skills.filter((s) => s.scope === "프로젝트" || s.scope === "사용자");
  if (!ownSkills.length) set("a-skill-desc", "해당없음", [], "직접 만든 Skill이 없음");
  else {
    const empty = ownSkills.filter((s) => s.description.length < 20).map((s) => `${s.path}: 설명 ${s.description.length}자`);
    const pairs = [];
    for (let i = 0; i < ownSkills.length; i++) {
      for (let j = i + 1; j < ownSkills.length; j++) {
        if (jaccard(ownSkills[i].description, ownSkills[j].description) >= 0.5) pairs.push(`${ownSkills[i].name} ↔ ${ownSkills[j].name}`);
      }
    }
    set("a-skill-desc", empty.length ? "걸림" : pairs.length ? "의심" : "깨끗", [...empty, ...pairs.map((p) => `설명이 비슷함: ${p}`)]);
  }
  const byName = new Map();
  for (const s of skills) byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
  const dups = [...byName.entries()].filter(([, list]) => new Set(list.map((s) => s.scope)).size > 1);
  set("a-skill-dup", !skills.length ? "해당없음" : dups.length ? "걸림" : "깨끗", dups.map(([name, list]) => `${name}: ${list.map((s) => s.scope).join(", ")}`));
  const mcpAll = allowed.filter((a) => /^mcp__/.test(a.rule) && (a.rule.split("__").length === 2 || (a.rule.split("__").length === 3 && a.rule.endsWith("__*"))));
  set("a-mcp-allow-all", !allowed.some((a) => a.rule.startsWith("mcp__")) ? "해당없음" : mcpAll.length ? "걸림" : "깨끗", mcpAll.map((a) => `${a.scope} allow: ${a.rule}`));

  // Day1 · 권한
  const secretRule = (r) => /\.env|secret|credential|\.pem|id_rsa|\.key\b/i.test(r.rule);
  const denySecrets = denied.filter(secretRule);
  set("perm-deny", denySecrets.length ? "있음" : "없음", denySecrets.map((d) => `${d.scope} deny: ${d.rule}`));
  const pushRules = [...asked, ...denied].filter((r) => /git push/.test(r.rule));
  set("perm-ask-push", pushRules.length ? "있음" : "없음", pushRules.map((r) => `${r.scope}: ${r.rule}`));
  const sandbox = settings.find((s) => s.data?.sandbox?.enabled === true);
  set("perm-sandbox", sandbox ? "있음" : "없음", sandbox ? [`${sandbox.scope} 설정 sandbox.enabled`] : []);
  if (!repo.isGit) set("perm-shared", "확인불가", [], "git 레포가 아님");
  else {
    const project = settings.find((s) => s.scope === "프로젝트");
    const rules = ["allow", "deny", "ask"].reduce((n, k) => n + (project?.data?.permissions?.[k]?.length ?? 0), 0);
    if (!rules) set("perm-shared", "없음", project?.data ? [".claude/settings.json에 권한 규칙이 없음"] : []);
    else if (repo.tracked.has(".claude/settings.json")) set("perm-shared", "있음", [`.claude/settings.json 권한 규칙 ${rules}개 커밋됨`]);
    else set("perm-shared", "일부", [`.claude/settings.json 권한 규칙 ${rules}개, 커밋 안 됨`]);
  }
  const wide = allowed.filter((a) => /^Bash(\((\*|:\*|\*\*)\))?$/.test(a.rule));
  set("a-allow-wide", wide.length ? "걸림" : "깨끗", wide.map((a) => `${a.scope} allow: ${a.rule}`));
  const bypass = settings.filter((s) => s.scope !== "관리" && s.data?.permissions?.defaultMode === "bypassPermissions");
  const bypassShare = sessions && sessions.userMessages >= 20 ? sessions.bypassMessages / sessions.userMessages : null;
  if (bypass.length) set("a-bypass", "걸림", bypass.map((s) => `${s.scope} 설정 defaultMode: bypassPermissions`));
  else if (bypassShare !== null && bypassShare >= 0.5) set("a-bypass", "걸림", [`최근 기록의 사용자 메시지 ${Math.round(bypassShare * 100)}%가 bypass 모드`]);
  else if (settings.some((s) => s.data?.skipDangerousModePermissionPrompt === true)) set("a-bypass", "의심", ["bypass 경고 창을 꺼 둠(skipDangerousModePermissionPrompt)"]);
  else set("a-bypass", "깨끗");
  const envMentions = [...instructions, ...rules].filter((f) => /\.env\b/.test(f.text));
  const envRules = [...denied, ...asked].filter((r) => /\.env/.test(r.rule));
  set("a-env-ask-only", !envMentions.length ? "해당없음" : envRules.length ? "깨끗" : "걸림", envMentions.map((f) => `${f.path}에 .env 언급, deny·ask 규칙 없음`).slice(0, envRules.length ? 0 : 8));

  // Day2 · 검증 명령
  const pkg = readJson(path.join(repo.root, "package.json")).data;
  const verifyCommands = [];
  for (const name of ["verify", "test", "check", "ci", "lint", "typecheck"]) if (pkg?.scripts?.[name]) verifyCommands.push(name === "test" ? "npm test" : `npm run ${name}`);
  const makefile = readText(path.join(repo.root, "Makefile"));
  for (const target of ["test", "check", "verify"]) if (makefile && new RegExp(`^${target}:`, "m").test(makefile)) verifyCommands.push(`make ${target}`);
  if (repo.files.includes("gradlew")) verifyCommands.push("./gradlew test");
  if (repo.files.includes("pom.xml")) verifyCommands.push("mvn test");
  if (repo.files.some((f) => /(^|\/)(pytest\.ini|conftest\.py)$/.test(f)) || /\[tool\.pytest/.test(readText(path.join(repo.root, "pyproject.toml")) ?? "")) verifyCommands.push("pytest");
  const mentioned = verifyCommands.filter((c) => projectInstructions.some((f) => f.text.includes(c)));
  set("verify-cmd", !verifyCommands.length ? "없음" : mentioned.length ? "있음" : "일부", mentioned.length ? mentioned.map((c) => `CLAUDE.md에 ${c}`) : verifyCommands.map((c) => `${c} 있음, 지침에 없음`));

  // Day2 · 가드레일
  const pre = hooks.filter((h) => h.event === "PreToolUse");
  set("verify-hook-pre", pre.length ? "있음" : "없음", pre.map((h) => `${h.scope} PreToolUse ${h.matcher || "(전체)"}`));
  const stops = hooks.filter((h) => h.event === "Stop" || h.event === "SubagentStop");
  set("verify-hook-stop", stops.length ? "있음" : "없음", stops.map((h) => `${h.scope} ${h.event}`));
  if (!stops.length) set("a-stop-loop", "해당없음", [], "Stop Hook이 없음");
  else {
    const noExit = stops.filter((h) => h.canBlock && !h.stopActive);
    set("a-stop-loop", noExit.length ? "의심" : "깨끗", noExit.map((h) => `${h.scope} ${h.event}: ${hookLabel(h)}`));
  }
  const toolHooks = hooks.filter((h) => h.event === "PreToolUse" || h.event === "PostToolUse");
  if (!toolHooks.length) set("a-hook-matcher-all", "해당없음", [], "도구 Hook이 없음");
  else {
    const all = toolHooks.filter((h) => !h.matcher || h.matcher === "*" || h.matcher === ".*");
    set("a-hook-matcher-all", all.length ? "의심" : "깨끗", all.map((h) => `${h.scope} ${h.event}: ${hookLabel(h)}`));
  }
  const GUARD_EVENTS = new Set(["PreToolUse", "PostToolUse", "Stop", "SubagentStop"]);
  const localHooks = hooks.filter((h) => h.scope === "로컬" && GUARD_EVENTS.has(h.event));
  const projectHooks = hooks.filter((h) => h.scope === "프로젝트" && GUARD_EVENTS.has(h.event));
  set("a-hook-local-only", !localHooks.length ? (projectHooks.length ? "깨끗" : "해당없음") : projectHooks.length ? "깨끗" : "걸림", localHooks.map((h) => `.claude/settings.local.json ${h.event}`));
  const ciFiles = repo.files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f) || /^(\.gitlab-ci\.yml|Jenkinsfile|azure-pipelines\.yml|bitbucket-pipelines\.yml)$/.test(f));
  if (!ciFiles.length) set("a-ci-bypass", "해당없음", [], "CI 설정이 없음");
  else {
    const sure = [];
    const maybe = [];
    for (const rel of ciFiles) {
      const lines = (readText(path.join(repo.root, rel)) ?? "").split(/\r?\n/);
      lines.forEach((line, i) => {
        if (/continue-on-error:\s*true/.test(line)) sure.push(`${rel}:${i + 1} continue-on-error: true`);
        else if (/\|\|\s*true\b/.test(line)) maybe.push(`${rel}:${i + 1} || true`);
      });
    }
    set("a-ci-bypass", sure.length ? "걸림" : maybe.length ? "의심" : "깨끗", [...sure, ...maybe]);
  }

  // Day2 · 루프 · 병렬 · 비용
  if (repo.worktrees > 1 || (sessions && sessions.worktreeUses > 0)) set("flow-parallel", "있음", [repo.worktrees > 1 ? `git worktree ${repo.worktrees}개` : `기록에서 worktree ${sessions.worktreeUses}번`]);
  else set("flow-parallel", repo.isGit ? "없음" : "확인불가", [], repo.isGit ? "" : "git 레포가 아님");
  const maxEffort = settings.filter((s) => ["max", "xhigh"].includes(s.data?.effortLevel));
  set("a-max-default", maxEffort.length ? "의심" : "깨끗", maxEffort.map((s) => `${s.scope} 설정 effortLevel: ${s.data.effortLevel}`));
  const mcpNames = [...new Set(mcp.map((s) => s.name))];
  if (!mcpNames.length) set("a-mcp-many", "해당없음", [], "MCP 서버가 없음");
  else if (sessions && sessions.sessions >= 5 && sessions.unusedMcp.length) set("a-mcp-many", "걸림", [`최근 ${SESSION_DAYS}일 안 쓴 서버: ${sessions.unusedMcp.slice(0, 8).join(", ")}`]);
  else set("a-mcp-many", mcpNames.length >= 5 ? "의심" : "깨끗", [`MCP 서버 ${mcpNames.length}개`]);

  // Day3 · 큰 코드베이스
  const structureDocs = repo.files.filter((f) => /(^|\/)(architecture|codemap|code-map|code_map|structure|구조)[^/]*\.md$/i.test(f) && !f.startsWith(".claude/"));
  const pointed = structureDocs.filter((doc) => [rootClaude?.text ?? "", rootAgents ?? ""].some((t) => t.includes(doc) || t.includes(doc.split("/").pop())));
  set("code-map", !structureDocs.length ? "없음" : pointed.length ? "있음" : "일부", pointed.length ? pointed.map((d) => `${d} (지침이 가리킴)`) : structureDocs.slice(0, 5));
  if (!structureDocs.length) set("a-map-stale", "해당없음", [], "구조 문서가 없음");
  else {
    const missing = [];
    for (const doc of structureDocs.slice(0, 20)) {
      const abs = path.join(repo.root, doc);
      for (const candidate of backtickPaths(readText(abs) ?? "")) if (!pathExists(candidate, repo, [repo.root, path.dirname(abs)])) missing.push(`${doc}: \`${candidate}\` 없음`);
    }
    set("a-map-stale", missing.length ? "의심" : "깨끗", missing);
  }
  if (!repo.isGit) set("a-generated-committed", "확인불가", [], "git 레포가 아님");
  else {
    const strong = [...repo.tracked].filter((f) => /(^|\/)(node_modules|coverage|\.cache|\.dev|\.next|__pycache__|\.pytest_cache|\.turbo)\//.test(f));
    const weak = [...repo.tracked].filter((f) => /(^|\/)(dist|build)\//.test(f));
    const dirs = (list) => [...new Set(list.map((f) => f.split("/").slice(0, f.split("/").findIndex((p) => /^(node_modules|coverage|\.cache|\.dev|\.next|__pycache__|\.pytest_cache|\.turbo|dist|build)$/.test(p)) + 1).join("/")))];
    set("a-generated-committed", strong.length ? "걸림" : weak.length ? "의심" : "깨끗", [...dirs(strong).map((d) => `${d}/ 커밋됨`), ...dirs(weak).map((d) => `${d}/ 커밋됨`)]);
  }

  // Day3 · 팀 하네스
  if (!repo.isGit) set("team-commit", "확인불가", [], "git 레포가 아님");
  else {
    const sharedClaude = [...repo.tracked].filter((f) => f.startsWith(".claude/") && !f.endsWith("settings.local.json"));
    const claudeTracked = repo.tracked.has("CLAUDE.md") || repo.tracked.has(".claude/CLAUDE.md");
    set("team-commit", claudeTracked && sharedClaude.length ? "있음" : claudeTracked || sharedClaude.length ? "일부" : "없음", [...(claudeTracked ? ["CLAUDE.md 커밋됨"] : []), ...(sharedClaude.length ? [`.claude/ 아래 ${sharedClaude.length}개 커밋됨`] : [])]);
  }
  const pluginFiles = repo.files.filter((f) => /(^|\/)\.claude-plugin\/(plugin|marketplace)\.json$/.test(f));
  const projectPlugins = settings.filter((s) => s.scope === "프로젝트" && (Object.keys(s.data?.enabledPlugins ?? {}).length || Object.keys(s.data?.extraKnownMarketplaces ?? {}).length));
  set("team-plugin", pluginFiles.length || projectPlugins.length ? "있음" : "없음", [...pluginFiles.slice(0, 3), ...projectPlugins.map(() => "프로젝트 설정이 플러그인을 켬")]);
  const managed = settings.find((s) => s.scope === "관리");
  set("team-policy", managed.exists ? "있음" : "없음", managed.exists ? ["관리 설정 파일 있음"] : [], managed.exists ? "" : "회사 관리자가 정하는 설정이라 개인이 만들 것은 아님");
  if (!repo.isGit) set("a-secret-committed", "확인불가", [], "git 레포가 아님");
  else {
    const leaked = [...repo.tracked].filter((f) => {
      const base = f.split("/").pop();
      return (/^\.env(\..+)?$/.test(base) && !/\.(example|sample|template|dist|defaults)$/.test(base)) || base === "settings.local.json" || /\.(pem|p12|pfx)$/.test(base) || /^id_(rsa|ed25519|ecdsa)$/.test(base);
    });
    set("a-secret-committed", leaked.length ? "걸림" : "깨끗", leaked.map((f) => `${f} 커밋됨`));
  }
  const envHits = [];
  for (const s of settings) {
    for (const [key, value] of Object.entries(s.data?.env ?? {})) {
      if (typeof value === "string" && (SECRET_VALUE.test(value) || (/(TOKEN|SECRET|PASSWORD|API_KEY)$/i.test(key) && value.length >= 16 && !value.startsWith("$")))) envHits.push(`${s.scope} 설정 env.${key}`);
    }
  }
  for (const server of mcp) {
    for (const [key, value] of Object.entries(server.env ?? {})) {
      if (typeof value === "string" && (SECRET_VALUE.test(value) || (/(TOKEN|SECRET|PASSWORD|API_KEY)$/i.test(key) && value.length >= 16 && !value.startsWith("$")))) envHits.push(`.mcp.json ${server.name}.env.${key}`);
    }
  }
  set("a-env-secret", envHits.length ? "걸림" : "깨끗", envHits, envHits.length ? "값은 보고서에 쓰지 않았다" : "");
  if (!rootClaude || rootAgents === null) set("a-two-sources", "해당없음", [], "CLAUDE.md와 AGENTS.md가 둘 다 있지는 않음");
  else {
    const agentsLines = rootAgents.split(/\r?\n/).length;
    const linked = rootClaude.text.includes("AGENTS.md") || rootAgents.includes("CLAUDE.md");
    set("a-two-sources", rootClaude.lines >= 20 && agentsLines >= 20 && !linked ? "걸림" : "깨끗", [`CLAUDE.md ${rootClaude.lines}줄, AGENTS.md ${agentsLines}줄${linked ? ", 서로 가리킴" : ""}`]);
  }

  // Day3 · 믿고 내보내기 · 개선 루프
  const codeowners = repo.files.find((f) => /^(\.github\/|docs\/|\.gitlab\/)?CODEOWNERS$/.test(f));
  set("team-owner", codeowners ? "있음" : "없음", codeowners ? [codeowners] : []);
  const harnessExists = instructions.some((f) => f.scope === "프로젝트") || repo.files.some((f) => f.startsWith(".claude/"));
  if (!repo.isGit || repo.harnessCommits30 === null) set("loop-fresh", "확인불가", [], "git 기록을 읽지 못함");
  else set("loop-fresh", repo.harnessCommits30 > 0 ? "있음" : "없음", [`최근 30일 지침·.claude 커밋 ${repo.harnessCommits30}개`]);
  if (!repo.isGit || repo.commits90 === null) set("a-harness-stale", "확인불가", [], "git 기록을 읽지 못함");
  else if (!harnessExists) set("a-harness-stale", "해당없음", [], "레포에 지침·.claude가 없음");
  else set("a-harness-stale", repo.commits90 > 20 && repo.harnessCommits90 === 0 ? "의심" : "깨끗", [`90일 커밋 ${repo.commits90}개 중 지침·.claude 커밋 ${repo.harnessCommits90}개`]);

  // 사용 습관
  const habitIds = ["flow-plan", "flow-explore", "a-repeat-ask", "a-long-session", "a-nudge"];
  if (!sessions) for (const id of habitIds) set(id, "확인불가", [], "기록 읽기에 동의하지 않음");
  else if (!sessions.sessions) for (const id of habitIds) set(id, "확인불가", [], `이 레포의 최근 ${SESSION_DAYS}일 기록이 없음`);
  else {
    const planCount = sessions.planMessages + (sessions.slash.plan ?? 0);
    set("flow-plan", planCount ? "있음" : "없음", [`계획 모드 메시지 ${sessions.planMessages}개, /plan ${sessions.slash.plan ?? 0}번`]);
    set("flow-explore", sessions.subagentCalls ? "있음" : "없음", [`서브에이전트 호출 ${sessions.subagentCalls}번`]);
    set("a-repeat-ask", sessions.repeated.length ? "의심" : "깨끗", sessions.repeated.length ? [`30자 넘는 같은 요청 ${sessions.repeated.length}가지를 3번 이상 보냄, 가장 많이 보낸 것 ${sessions.repeated[0]}번`] : [], sessions.repeated.length ? "어떤 요청인지는 옮기지 않았어요. 자주 하는 설명을 떠올려 지침 한 줄이나 Skill로 옮겨 보세요." : "");
    set("a-long-session", sessions.sessionsWith2Compactions ? "의심" : "깨끗", [`압축 두 번 이상인 세션 ${sessions.sessionsWith2Compactions}개 (최대 ${sessions.maxCompactions}번)`]);
    const share = sessions.userMessages ? sessions.nudges / sessions.userMessages : 0;
    set("a-nudge", sessions.userMessages < 20 ? "확인불가" : share >= 0.15 ? "의심" : "깨끗", [`사용자 메시지 ${sessions.userMessages}개 중 재촉 ${sessions.nudges}개`], sessions.userMessages < 20 ? "메시지가 20개 미만이라 비율을 보지 않음" : "");
  }
  return results;
}

// ---------- 브리프 ----------

/** 영역마다 점검 담당이 먼저 볼 후보 파일과 설정 요약이다. */
function areaHints(area, results, ctx) {
  const { repo, skills, agents, hooks, instructions } = ctx;
  const ownSkills = () => skills.filter((s) => !s.scope.startsWith("플러그인")).map((s) => ({ name: s.name, scope: s.scope, path: s.path, description: s.description.slice(0, 160) })).slice(0, LIST_CAP);
  const pick = (re) => repo.files.filter((f) => re.test(f)).slice(0, LIST_CAP);
  if (area === "guide") {
    const outside = instructions.filter((f) => f.scope === "사용자" && f.codeLines >= 40);
    return {
      instructionFiles: instructions.map((f) => ({ path: f.path, scope: f.scope, lines: f.lines, codeLines: f.codeLines })),
      ...(outside.length ? { userCodeBlocks: outside.map((f) => ({ path: f.path, blocks: f.blocks.slice(0, 3).map((b) => b.slice(0, 15).join("\n")) })) } : {}),
    };
  }
  if (area === "tools") return results["a-skill-desc"]?.result === "의심" ? { skills: ownSkills() } : {};
  if (area === "flow") return { specDocs: pick(/\.md$/).filter((f) => /(prd|spec|requirement|요구|기획|docs\/tasks\/|adr)/i.test(f)), skills: ownSkills(), agents: agents.slice(0, LIST_CAP), hooks: hooks.slice(0, LIST_CAP) };
  if (area === "verify") {
    return {
      templates: pick(/(pull_request_template|PULL_REQUEST_TEMPLATE|merge_request_templates|REVIEW\.md$)/i),
      ciFiles: pick(/^\.github\/workflows\/|^(\.gitlab-ci\.yml|Jenkinsfile|azure-pipelines\.yml|bitbucket-pipelines\.yml)$/),
      skills: ownSkills(),
      pluginSkills: skills.filter((s) => s.scope.startsWith("플러그인")).map((s) => `${s.scope}:${s.name}`).slice(0, LIST_CAP),
      agents: agents.slice(0, LIST_CAP),
      hooks: hooks.slice(0, LIST_CAP),
      verifyCommands: results["verify-cmd"]?.evidence ?? [],
    };
  }
  if (area === "code") return { boundaryCandidates: pick(/(eslint\.config\.|\.eslintrc|\.dependency-cruiser|depcruise|archunit|importlinter|project\.json$|nx\.json$|boundar)/i), structureDocs: pick(/(^|\/)(architecture|codemap|code-map|structure|구조|adr)[^/]*\.md$/i), instructionFiles: instructions.filter((f) => f.scope === "프로젝트").map((f) => f.path) };
  if (area === "team") return { issueTemplates: pick(/(ISSUE_TEMPLATE|issue_templates)/i), opsDocs: pick(/\.md$/).filter((f) => /(runbook|deploy|release|rollback|operat|운영|배포|롤백)/i.test(f)) };
  if (area === "loop") return { lessonCandidates: pick(/(lesson|learning|retro|postmortem|회고|교훈|mistake)/i), instructionFiles: instructions.filter((f) => f.scope === "프로젝트").map((f) => f.path) };
  return {};
}

/**
 * 파일을 읽어야 정할 항목을 점검 담당 몇 명에게 나눈다. 담당 하나가 다섯 항목쯤 맡도록 최대 세 명까지 두고,
 * 관련 있는 영역끼리 같은 담당이 보도록 점검표 순서대로 이어 붙여 자른다.
 */
function buildBriefs(checklist, results, ctx) {
  const work = checklist.areas
    .map((area) => ({
      area,
      items: area.items
        .filter((item) => item.owner === "읽기" || (CONFIRMABLE.has(item.id) && results[item.id]?.result === "의심"))
        .map((item) => ({ id: item.id, kind: item.kind, title: item.title, rule: item.rule, ...(results[item.id] ? { scan: results[item.id] } : {}) })),
    }))
    .filter((w) => w.items.length);
  const total = work.reduce((n, w) => n + w.items.length, 0);
  if (!total) return {};
  const groups = Math.min(3, Math.ceil(total / 5), work.length);
  const target = total / groups;
  // 영역의 가운데가 몇 번째 몫에 떨어지는지로 담당을 정한다. 순서는 지키고 크기는 고르게 된다.
  const buckets = Array.from({ length: groups }, () => []);
  let before = 0;
  for (const w of work) {
    const middle = before + w.items.length / 2;
    buckets[Math.min(groups - 1, Math.floor(middle / target))].push(w);
    before += w.items.length;
  }
  const briefs = {};
  buckets
    .filter((bucket) => bucket.length)
    .forEach((bucket, i) => {
      const id = `g${i + 1}`;
      const hints = {};
      for (const w of bucket) Object.assign(hints, areaHints(w.area.id, results, ctx));
      briefs[id] = { group: id, areas: bucket.map((w) => w.area.title), repoRoot: ctx.repo.root, skip: ctx.repo.ownPaths, items: bucket.flatMap((w) => w.items), hints };
    });
  return briefs;
}

// ---------- 실행 ----------

export async function scan(args, now = new Date()) {
  const home = os.homedir();
  const configDir = path.resolve(args.config ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"));
  const checklist = loadChecklist();
  const repo = collectRepo(args.repo);
  const show = (file) => display(file, repo, home);
  const settings = collectSettings(repo, configDir);
  const skills = collectSkills(repo, configDir, settings, show);
  const agents = collectAgents(repo, configDir, show);
  const hooks = collectHooks(settings, skills, repo, show);
  const mcp = collectMcp(repo, configDir);
  const instructions = collectInstructionFiles(repo, configDir, show);
  const rules = collectRules(repo, configDir, show);
  const memoryFile = path.join(configDir, "projects", encodeProjectDir(repo.root), "memory", "MEMORY.md");
  const memoryText = readText(memoryFile);
  const memory = memoryText === null ? null : { path: show(memoryFile), lines: memoryText.split(/\r?\n/).length, bytes: Buffer.byteLength(memoryText) };
  const sessions = args.sessions === "yes" ? await collectSessions(repo, configDir, [...new Set(mcp.map((s) => s.name))]) : null;
  const ctx = { repo, settings, skills, agents, hooks, mcp, instructions, rules, memory, sessions, home };
  const results = judge(ctx);
  const briefs = buildBriefs(checklist, results, ctx);

  const outDir = path.join(args.outRoot, repo.name.replace(/[^\w.-]/g, "_"), stamp(now));
  fs.mkdirSync(outDir, { recursive: true });
  const facts = {
    version: 1,
    createdAt: now.toISOString(),
    repo: { root: repo.root, name: repo.name, isGit: repo.isGit, files: repo.files.length, capped: repo.capped, commits90: repo.commits90 },
    configDir: show(configDir),
    answers: { pain: args.pain, sessions: args.sessions },
    counts: { instructions: instructions.length, rules: rules.length, skills: skills.length, agents: agents.length, hooks: hooks.length, mcp: mcp.length, settings: settings.filter((s) => s.exists).map((s) => s.scope) },
    sessions: sessions && { ...sessions, mcpUsed: Object.keys(sessions.mcpUsed).length, repeated: sessions.repeated },
    results,
    waiting: Object.fromEntries(Object.entries(briefs).map(([group, brief]) => [group, brief.items.map((i) => i.id)])),
  };
  fs.writeFileSync(path.join(outDir, "facts.json"), JSON.stringify(facts, null, 2));
  return { outDir, briefs, facts };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`scan.mjs: ${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }
  const { outDir, briefs, facts } = await scan(args);
  const tally = {};
  for (const r of Object.values(facts.results)) tally[r.result] = (tally[r.result] ?? 0) + 1;
  process.stdout.write(`${JSON.stringify({ out: outDir, repo: facts.repo.root, config: facts.configDir, scanned: tally, briefs })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
