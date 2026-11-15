// npm run loop: 백그라운드 세션(claude --bg, agent view)을 쓸 수 없을 때 이슈 처리를 대신 돌린다.
// 대기 이슈마다 git worktree를 만들고 그 안에서 claude -p "/issue-to-pr docs/issues/<번호>.md"를 돌린다. 동시에 2개까지.
// 같은 파일을 건드리는 이슈(이슈 파일의 "주로 건드릴 곳")는 같이 띄우지 않고, 앞 이슈가 끝난 뒤 띄운다.
//
//   npm run loop -- --max-turns 40 --max-budget-usd 3          대기 이슈 전부
//   npm run loop -- --max-turns 40 --max-budget-usd 3 2 3 6    고른 이슈만
//   --parallel 1                                               한 번에 하나씩(기본 2, 2보다 크게 할 수 없음)
//   npm run loop -- --resume 4                                 4번 세션을 그 worktree에서 이어 간다(답하기, 승인하기)
// 상한 둘은 꼭 적는다: 세션마다 --max-turns(턴 수), --max-budget-usd(달러)로 claude에 그대로 넘긴다.
// 계정은 npm run claude와 같다: 실습 설정 폴더(CLAUDE_CONFIG_DIR=~/.claude-workshop)와 --settings로 붙이는 workshop-settings.json(레포 바깥 위쪽 폴더의 지침 빼기).
// 관찰 Hook은 worktree의 .claude/settings.json에 있다.
// 권한은 --permission-mode auto: claude -p의 기본 모드는 파일 쓰기를 모두 거절하므로 claude --bg의 기본과 같은 auto로 띄운다.
// settings의 permissions.ask(배송비 규칙 파일 등)는 auto에서도 사람 몫이라 -p에서는 거절로 남고 표에 "승인 필요"로 보인다.
// 대기 이슈: issue-<번호> 브랜치가 아직 없는 이슈. 한 번 맡긴 이슈는 다시 돌리지 않는다.
// 지금 커밋에 .claude/skills/issue-to-pr/SKILL.md가 없으면 띄우지 않는다(worktree에는 커밋한 것만 있다).
// worktree: 레포 폴더 옆 <레포 폴더 이름>-issue-<번호>. 끝나도 지우지 않는다(만든 브랜치와 PR 결과가 거기 있다).
// 기록: .loop/issue-<번호>.json(claude의 JSON 결과), 같은 이름의 .log(설치·오류 출력).
// 이어 가기(--resume <번호>): .loop/issue-<번호>.json의 세션을 그 worktree에서 같은 계정·권한 모드로 대화형으로 연다.
//   그냥 `claude --resume`은 평소 계정(~/.claude)을 봐서 세션을 못 찾고, `npm run claude`는 레포 폴더에서만 뜬다.
// 종료 코드: 0 맡긴 이슈를 모두 돌림(결과는 표), 1 claude나 준비가 실패한 이슈가 있음, 2 돌릴 수 없음, 128+신호 번호 중간에 멈춤.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findHere, spawnSpec } from "../tools/setup/src/command.ts";
import { launchClaudeIn, launchSettingsArgs } from "../tools/setup/src/launch.ts";
import { claudeEnv, resolvePracticeConfigDir } from "../tools/setup/src/paths.ts";

const root = realpathSync.native(path.resolve(import.meta.dirname, ".."));
const ISSUES_DIR = path.join(root, "docs", "issues");
const LOG_DIR = path.join(root, ".loop");
const MAX_PARALLEL = 2;
const CHILD_STOP_GRACE_MS = 10_000;
const USAGE = "npm run loop -- --max-turns <턴 수> --max-budget-usd <달러> [--parallel 1|2] [이슈 번호...] 또는 npm run loop -- --resume <이슈 번호>";

function stop(message) {
  console.error(`\n[loop] 돌릴 수 없어요: ${message}`);
  process.exit(2);
}

function git(args, cwd = root) {
  const result = spawnSync("git", ["-c", "core.quotepath=off", ...args], { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout.trimEnd(), stderr: result.stderr.trim() };
}

function parseArgs(argv) {
  const options = { maxTurns: null, maxBudget: null, parallel: MAX_PARALLEL, issues: [], resume: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) stop(`${arg} 뒤에 값을 적으세요. ${USAGE}`);
      index += 1;
      return next;
    };
    if (arg === "--max-turns") {
      const turns = Number(value());
      if (!Number.isInteger(turns) || turns < 1) stop("--max-turns는 1 이상의 정수예요.");
      options.maxTurns = turns;
    } else if (arg === "--max-budget-usd") {
      const text = value();
      if (!/^\d+(\.\d+)?$/.test(text) || Number(text) <= 0) stop("--max-budget-usd는 0보다 큰 달러 금액이에요(예: 3 또는 2.5).");
      options.maxBudget = text;
    } else if (arg === "--parallel") {
      const parallel = Number(value());
      if (!Number.isInteger(parallel) || parallel < 1 || parallel > MAX_PARALLEL) stop(`--parallel은 1에서 ${MAX_PARALLEL} 사이예요.`);
      options.parallel = parallel;
    } else if (arg === "--resume") {
      const text = value();
      if (!/^\d+$/.test(text)) stop(`--resume 뒤에는 이슈 번호를 적으세요. ${USAGE}`);
      options.resume = Number(text);
    } else if (/^\d+$/.test(arg)) options.issues.push(Number(arg));
    else stop(`알 수 없는 인자 ${arg}. ${USAGE}`);
  }
  if (options.resume !== null) {
    if (options.issues.length > 0 || options.maxTurns !== null || options.maxBudget !== null) stop(`--resume은 이슈 번호 하나만 받아요. ${USAGE}`);
    return options;
  }
  if (options.maxTurns === null || options.maxBudget === null) stop(`상한 둘(--max-turns, --max-budget-usd)을 꼭 적으세요. ${USAGE}`);
  return options;
}

const options = parseArgs(process.argv.slice(2));

/** 이슈 파일의 "## 주로 건드릴 곳" 아래 `경로` 목록. 칸이 없으면 null(무엇과 겹칠지 모른다). */
function touchedPaths(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "## 주로 건드릴 곳");
  if (start === -1) return null;
  const paths = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("#")) break;
    const match = /^\s*-\s*`([^`]+)`/.exec(line);
    if (match !== null) paths.push(match[1].replace(/\/+$/, ""));
  }
  return paths;
}

function readIssues() {
  if (!existsSync(ISSUES_DIR)) stop("docs/issues 폴더가 없어요. day2-c에서 딴 브랜치에서 돌리세요.");
  const issues = new Map();
  for (const name of readdirSync(ISSUES_DIR)) {
    const match = /^(\d+)\.md$/.exec(name);
    if (match === null) continue;
    const text = readFileSync(path.join(ISSUES_DIR, name), "utf8");
    const title = text.split(/\r?\n/).find((line) => line.startsWith("# "))?.slice(2).trim() ?? name;
    issues.set(Number(match[1]), { number: Number(match[1]), title, file: `docs/issues/${name}`, paths: touchedPaths(text) });
  }
  return issues;
}

const allIssues = readIssues();
for (const number of options.issues) if (!allIssues.has(number)) stop(`docs/issues/${number}.md가 없어요.`);
const chosen = (options.issues.length > 0 ? [...new Set(options.issues)] : [...allIssues.keys()]).sort((a, b) => a - b).map((number) => allIssues.get(number));

const branchOf = (issue) => `issue-${issue.number}`;
const worktreeOf = (issue) => path.join(path.dirname(root), `${path.basename(root)}-issue-${issue.number}`);
const hasBranch = (issue) => git(["rev-parse", "--verify", "--quiet", `refs/heads/${branchOf(issue)}`]).status === 0;

/** 실습 설정 폴더와 claude 명령. 이슈 세션은 npm run claude와 같은 계정으로 돈다. */
function practiceClaude() {
  let configDir;
  try {
    configDir = resolvePracticeConfigDir();
  } catch (error) {
    stop(`실습 설정 폴더를 정하지 못했어요. ${error.message}`);
  }
  if (!existsSync(configDir)) stop(`실습 설정 폴더 ${configDir}가 없어요. npm run claude로 한 번 로그인한 뒤 다시 돌리세요.`);
  const claude = findHere("claude") ?? stop("claude 명령을 PATH에서 찾지 못했어요. npm run setup으로 설치를 확인하세요.");
  return { configDir, claude };
}

/** 맡겼던 이슈 세션을 그 worktree에서 대화형으로 이어 가고 claude의 종료 코드를 돌려준다. */
async function resumeSession(number) {
  const issue = allIssues.get(number) ?? stop(`docs/issues/${number}.md가 없어요.`);
  const record = path.join(LOG_DIR, `issue-${issue.number}.json`);
  if (!existsSync(record)) stop(`${issue.number}번을 돌린 기록(.loop/issue-${issue.number}.json)이 없어요. 먼저 npm run loop로 맡기세요.`);
  let session;
  try {
    session = JSON.parse(readFileSync(record, "utf8")).session_id;
  } catch (error) {
    stop(`.loop/issue-${issue.number}.json을 읽지 못했어요. ${error.message}`);
  }
  if (typeof session !== "string") stop(`.loop/issue-${issue.number}.json에 세션 번호가 없어요. 세션이 결과 없이 끝났으니 .loop/issue-${issue.number}.log를 보세요.`);
  const dir = worktreeOf(issue);
  if (!existsSync(dir)) stop(`${issue.number}번 worktree ${dir}가 없어요.`);
  const { configDir, claude } = practiceClaude();
  console.log(`[loop] ${issue.number}번 세션을 ${dir}에서 이어 갑니다. 답하거나 승인한 뒤 /exit로 나옵니다.`);
  return launchClaudeIn(dir, claude, configDir, ["--permission-mode", "auto", "--resume", session]);
}

if (options.resume !== null) process.exit(await resumeSession(options.resume));

const already = chosen.filter(hasBranch);
for (const issue of already) console.log(`[loop] ${issue.number}번은 이미 맡겼어요(브랜치 ${branchOf(issue)}). 다시 하려면 그 worktree와 브랜치를 지우세요.`);
const queue = chosen.filter((issue) => !hasBranch(issue));
if (queue.length === 0) {
  console.log("[loop] 대기 이슈가 없어요.");
  process.exit(0);
}

const SKILL_FILE = ".claude/skills/issue-to-pr/SKILL.md";
const base = git(["rev-parse", "HEAD"]).stdout || stop("지금 커밋을 읽지 못했어요.");
// worktree는 지금 커밋으로 만들므로 커밋하지 않은 Skill은 세션에 없다.
if (git(["cat-file", "-e", `${base}:${SKILL_FILE}`]).status !== 0) {
  stop(`지금 커밋에 ${SKILL_FILE}이 없어요. 이슈 세션은 지금 커밋으로 만든 worktree에서 돌아서, 커밋하지 않은 Skill은 보이지 않아요. issue-to-pr Skill을 커밋하세요.`);
}
const { configDir, claude } = practiceClaude();
// worktree는 모두 레포 폴더 옆이라 위쪽 폴더가 같다. 세션이 둘 돌아도 파일은 여기서 한 번만 쓴다.
const settingsArgs = launchSettingsArgs(configDir, worktreeOf(queue[0]));
const npm = process.env.npm_execpath ?? stop("npm run loop로 실행하세요(npm 위치를 알 수 없어요).");
mkdirSync(LOG_DIR, { recursive: true });

/** 두 이슈가 같은 파일을 건드리는지. 폴더 경로는 그 아래 파일과 겹친다. 칸이 없는 이슈는 모두와 겹친다고 본다. */
function overlap(a, b) {
  if (a.paths === null || b.paths === null) return "주로 건드릴 곳이 적혀 있지 않음";
  for (const one of a.paths) {
    for (const other of b.paths) {
      if (one === other || one.startsWith(`${other}/`) || other.startsWith(`${one}/`)) return one.length <= other.length ? other : one;
    }
  }
  return null;
}

// 돌고 있는 자식(npm·claude)과 받은 신호. 신호를 받으면 자식을 모두 멈추고 끝나기를 기다린다.
const children = new Set();
let interrupted = null;

function stopChild(child, signal) {
  if (process.platform === "win32") {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

/** 자식 하나를 돌려 출력을 모은다. Mac·Linux에서는 자기 프로세스 그룹으로 띄워 멈출 때 그룹째 멈춘다. */
function run(command, args, cwd, shell = false, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      children.delete(child);
      reject(error);
    });
    child.on("close", (code, signal) => {
      children.delete(child);
      resolve({ code: code ?? (signal === null ? 1 : 128 + os.constants.signals[signal]), stdout, stderr });
    });
  });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (interrupted !== null) return;
    interrupted = signal;
    console.error(`\n[loop] ${signal}를 받아 돌고 있는 세션을 멈춥니다. 만든 worktree는 남겨 둡니다.`);
    if (children.size === 0) process.exit(128 + os.constants.signals[signal]);
    for (const child of children) {
      stopChild(child, signal);
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) stopChild(child, "SIGKILL");
      }, CHILD_STOP_GRACE_MS).unref();
    }
  });
}
// 어떤 길로 끝나도 띄운 자식을 남기지 않는다.
process.on("exit", () => {
  for (const child of children) stopChild(child, "SIGKILL");
});

function firstLine(text) {
  return (text ?? "").split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}

/** claude --output-format json 결과를 표의 한 줄로 */
function summarize(result) {
  const denials = Array.isArray(result.permission_denials) ? result.permission_denials.length : 0;
  const state =
    denials > 0
      ? `승인 필요(거절된 도구 ${denials}개)`
      : result.subtype === "error_max_turns"
        ? "턴 상한에서 멈춤"
        : typeof result.subtype === "string" && result.subtype.includes("budget")
          ? "비용 상한에서 멈춤"
          : result.is_error === true
            ? "오류로 끝남"
            : "끝남";
  return {
    state,
    turns: result.num_turns ?? null,
    cost: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
    last: firstLine(result.result),
    session: typeof result.session_id === "string" ? result.session_id : null,
  };
}

/** 이슈 하나: worktree → 의존성 → claude 세션 → 기록 */
async function work(issue) {
  const dir = worktreeOf(issue);
  const log = path.join(LOG_DIR, `issue-${issue.number}.log`);
  const failed = (state, detail) => {
    writeFileSync(log, detail);
    return { issue, ok: false, state, turns: null, cost: null, last: firstLine(detail.split("\n").slice(-5).join("\n")), session: null, dir };
  };
  const added = git(["worktree", "add", "-b", branchOf(issue), dir, base]);
  if (added.status !== 0) return failed("worktree를 만들지 못함", added.stderr);
  console.log(`[loop] ${issue.number}번 시작: ${dir}`);
  const install = await run(process.execPath, [npm, "ci", "--prefer-offline", "--no-audit", "--no-fund"], dir);
  if (interrupted !== null) return null;
  if (install.code !== 0) return failed("의존성 설치 실패", install.stdout + install.stderr);
  const prompt = `/issue-to-pr ${issue.file}`;
  const args = [...settingsArgs, "-p", prompt, "-n", branchOf(issue), "--permission-mode", "auto", "--max-turns", String(options.maxTurns), "--max-budget-usd", options.maxBudget, "--output-format", "json"];
  const spec = spawnSpec(claude, args, process.platform);
  const session = await run(spec.command, spec.args, dir, spec.shell, claudeEnv(configDir));
  if (interrupted !== null) return null;
  writeFileSync(path.join(LOG_DIR, `issue-${issue.number}.json`), session.stdout);
  let parsed;
  try {
    parsed = JSON.parse(session.stdout);
  } catch {
    return failed(`claude 실패(종료 코드 ${session.code})`, session.stdout + session.stderr);
  }
  if (session.stderr.trim() !== "") writeFileSync(log, session.stderr);
  return { issue, ok: true, ...summarize(parsed), dir };
}

const running = new Map();
const results = [];
const waitingNoted = new Set();

function startable() {
  for (const issue of queue) {
    const blocker = [...running.keys()].map((other) => ({ other, shared: overlap(issue, other) })).find(({ shared }) => shared !== null);
    if (blocker === undefined) return issue;
    if (!waitingNoted.has(issue.number)) {
      waitingNoted.add(issue.number);
      console.log(`[loop] ${issue.number}번은 ${blocker.other.number}번과 같은 곳(${blocker.shared})을 건드려 ${blocker.other.number}번이 끝난 뒤 띄웁니다.`);
    }
  }
  return null;
}

console.log(`[loop] 이슈 ${queue.map((issue) => issue.number).join(", ")}번을 동시에 ${options.parallel}개까지 돌립니다(세션마다 ${options.maxTurns}턴, $${options.maxBudget} 상한).`);
while ((queue.length > 0 || running.size > 0) && interrupted === null) {
  while (running.size < options.parallel) {
    const issue = startable();
    if (issue === null) break;
    queue.splice(queue.indexOf(issue), 1);
    running.set(
      issue,
      work(issue).then((result) => {
        running.delete(issue);
        if (result === null) return;
        results.push(result);
        const cost = result.cost === null ? "" : ` · $${result.cost.toFixed(2)}`;
        console.log(`[loop] ${issue.number}번 끝: ${result.state}${result.turns === null ? "" : ` · ${result.turns}턴`}${cost}`);
      }),
    );
  }
  if (running.size === 0) break;
  await Promise.race(running.values());
}
if (interrupted !== null) {
  await Promise.allSettled(running.values());
  process.exit(128 + os.constants.signals[interrupted]);
}

console.log("\n| 이슈 | 결과 | 턴 | 비용 | 마지막 말 | worktree |");
console.log("| --- | --- | --- | --- | --- | --- |");
for (const result of results.sort((a, b) => a.issue.number - b.issue.number)) {
  const cost = result.cost === null ? "-" : `$${result.cost.toFixed(2)}`;
  console.log(`| ${result.issue.number} ${result.issue.title} | ${result.state} | ${result.turns ?? "-"} | ${cost} | ${result.last.replaceAll("|", "/").slice(0, 80)} | ${result.dir} |`);
}
console.log("\n[loop] 세션 기록은 .loop/에 있어요. 답하거나 승인할 세션은 그 worktree에서 이어 갑니다:");
for (const result of results) if (result.session !== null) console.log(`  ${result.issue.number}번: npm run loop -- --resume ${result.issue.number}`);
process.exit(results.every((result) => result.ok) ? 0 : 1);
