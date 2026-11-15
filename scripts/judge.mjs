// npm run judge: 정답 브랜치(day2-c-answers)의 숨은 테스트를 지금 작업 트리에 대고 돌려 이슈별로 맞춰 본다.
// 숨은 테스트는 git show로 꺼내 tests/judge-run-<PID>/에 잠깐 두고, 어떤 길로 끝나도 지운다(커밋할 일이 없다).
// 규칙 채점기 결과(가장 가까운 start/* 태그 이후 바뀐 것)도 함께 보인다.
//
//   npm run judge                       정답 브랜치는 day2-c-answers(내 브랜치, 없으면 origin/·upstream/ 순서)
//   npm run judge -- --answers <ref>    정답을 꺼낼 브랜치나 커밋을 직접 정한다
//   npm run judge -- --base <ref>       채점 기준점을 직접 정한다
// 숨은 테스트 파일은 정답 브랜치의 tests/judge/issue-<번호>.test.ts이고, 번호는 docs/issues/<번호>.md의 번호다.
// 종료 코드: 0 숨은 테스트와 채점 모두 통과, 1 하나라도 실패, 2 돌릴 수 없음, 128+신호 번호 중간에 멈춤(Ctrl+C 130).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = realpathSync.native(path.resolve(import.meta.dirname, ".."));
const ANSWERS_BRANCH = "day2-c-answers";
const HIDDEN_DIR = "tests/judge";
const HIDDEN_FILE = /^tests\/judge\/issue-(\d+)\.test\.ts$/;
// 숨은 테스트를 잠깐 두는 곳. 기존 테스트와 같은 깊이라 숨은 테스트의 ../support/ import가 그대로 맞는다.
const RUN_PARENT = path.join(root, "tests");
const RUN_NAME = /^judge-run-(\d+)$/;
const CHILD_STOP_GRACE_MS = 10_000;
const FAILURES_PER_ISSUE = 3;

function git(args) {
  const result = spawnSync("git", ["-c", "core.quotepath=off", ...args], { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout.trimEnd(), stderr: result.stderr.trim() };
}

function stop(message) {
  console.error(`\n[judge] 채점할 수 없어요: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { answers: null, base: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--answers" || arg === "--base") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) stop(`${arg} 뒤에 브랜치나 커밋을 적으세요.`);
      options[arg.slice(2)] = value;
      index += 1;
    } else stop(`알 수 없는 옵션 ${arg}. 쓸 수 있는 옵션: --answers <ref>, --base <ref>`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

const MISSING_ANSWERS = `숨은 테스트가 있는 ${ANSWERS_BRANCH} 브랜치를 이 폴더에서 찾지 못했어요.
  fork를 만들 때 "Copy the main branch only"를 켜 두면 fork에 main 말고 다른 브랜치가 없어서 이 브랜치도 없어요.
  다시 받는 방법(둘 중 하나):
    1. fork를 "Copy the main branch only" 체크를 풀고 다시 만든 뒤: git fetch origin ${ANSWERS_BRANCH}
    2. 원래 레포를 upstream으로 이어 두었다면(docs/github.md 2절): git fetch upstream ${ANSWERS_BRANCH}
  받은 뒤 npm run judge를 다시 돌리세요.`;

/** 정답 브랜치: 내 브랜치 → origin → upstream → 다른 원격 순서로 찾는다. */
function findAnswers() {
  if (options.answers !== null) {
    if (git(["rev-parse", "--verify", "--quiet", `${options.answers}^{commit}`]).status !== 0) stop(`${options.answers}라는 브랜치나 커밋이 없어요.`);
    return options.answers;
  }
  const refs = git(["for-each-ref", "--format=%(refname)", `refs/heads/${ANSWERS_BRANCH}`, `refs/remotes/*/${ANSWERS_BRANCH}`]).stdout.split("\n").filter((ref) => ref !== "");
  const rank = (ref) => (ref.startsWith("refs/heads/") ? 0 : ref === `refs/remotes/origin/${ANSWERS_BRANCH}` ? 1 : ref === `refs/remotes/upstream/${ANSWERS_BRANCH}` ? 2 : 3);
  const [best] = refs.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  if (best === undefined) {
    console.error(`\n[judge] ${MISSING_ANSWERS}`);
    process.exit(2);
  }
  return best.replace(/^refs\/(heads|remotes)\//, "");
}

const answers = findAnswers();
const answersCommit = git(["rev-parse", "--short", `${answers}^{commit}`]).stdout;

/** 정답 브랜치의 숨은 테스트: 이슈 번호 → 파일 경로 */
const hidden = new Map(
  git(["ls-tree", "-r", "--name-only", answers, "--", `${HIDDEN_DIR}/`])
    .stdout.split("\n")
    .map((file) => [HIDDEN_FILE.exec(file), file])
    .filter(([match]) => match !== null)
    .map(([match, file]) => [Number(match[1]), file]),
);
if (hidden.size === 0) stop(`${answers}에 숨은 테스트(${HIDDEN_DIR}/issue-<번호>.test.ts)가 없어요. 정답 브랜치를 다시 받으세요.`);

/** 지금 작업 트리의 이슈 제목: docs/issues/<번호>.md의 첫 줄 "# 제목" */
function issueTitles() {
  const dir = path.join(root, "docs", "issues");
  const titles = new Map();
  if (!existsSync(dir)) return titles;
  for (const name of readdirSync(dir)) {
    const match = /^(\d+)\.md$/.exec(name);
    if (match === null) continue;
    const heading = readFileSync(path.join(dir, name), "utf8").split(/\r?\n/).find((line) => line.startsWith("# "));
    titles.set(Number(match[1]), heading === undefined ? name : heading.slice(2).trim());
  }
  return titles;
}

const vitest = path.join(root, "node_modules", "vitest", "vitest.mjs");
if (!existsSync(vitest)) stop("node_modules에 vitest가 없어요. npm ci로 의존성을 설치한 뒤 돌리세요.");

// 지금 돌고 있는 자식과 받은 신호. 신호를 받으면 자식(과 그 자식들)을 멈추고, 끝나기를 기다린 뒤 치우고 나간다.
let current = null;
let interrupted = null;
let runDir = null;

function stopChild(child, signal) {
  // Mac·Linux에서는 자식을 자기 프로세스 그룹으로 띄웠으니 그룹째 보낸다(vitest의 일꾼까지).
  if (process.platform === "win32") {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    // ESRCH: 그룹이 이미 모두 끝났다. 바라던 상태다.
    if (error.code !== "ESRCH") throw error;
  }
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    current = child;
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      current = null;
      resolve({ code: code ?? (signal === null ? 1 : 128 + os.constants.signals[signal]), output });
    });
  });
}

function cleanup() {
  if (current !== null) stopChild(current, "SIGKILL");
  if (runDir === null) return;
  rmSync(runDir, { recursive: true, force: true });
  runDir = null;
}
// 통과·실패·stop()·예외·신호, 어떤 길로 끝나도 숨은 테스트를 지운다.
process.on("exit", cleanup);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (interrupted !== null) return;
    interrupted = signal;
    console.error(`\n[judge] ${signal}를 받아 멈추고 숨은 테스트를 지웁니다.`);
    if (current === null) process.exit(128 + os.constants.signals[signal]);
    const child = current;
    stopChild(child, signal);
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) stopChild(child, "SIGKILL");
    }, CHILD_STOP_GRACE_MS).unref();
  });
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: 있지만 다른 사용자의 프로세스다.
    return error.code === "EPERM";
  }
}

/** 지난 실행이 치우지 못하고 끝난 폴더(강제 종료 등). 이름의 PID가 끝난 것만 지운다. */
function removeStaleRuns() {
  for (const name of readdirSync(RUN_PARENT)) {
    const owner = RUN_NAME.exec(name);
    if (owner === null || isRunning(Number(owner[1]))) continue;
    console.log(`지난 실행이 남긴 숨은 테스트 폴더를 지웁니다: tests/${name}`);
    rmSync(path.join(RUN_PARENT, name), { recursive: true, force: true });
  }
}

/** 보고서의 파일 이름과 맞춰 볼 열쇠. Windows는 드라이브 글자와 대소문자가 다르게 올 수 있다. */
function fileKey(file) {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** 숨은 테스트를 꺼내 돌리고 이슈 번호 → { passed, total, failures } 를 돌려준다. */
async function runHidden() {
  if (!existsSync(RUN_PARENT)) stop("tests 폴더가 없어요. day2-c에서 딴 브랜치에서 돌리세요.");
  removeStaleRuns();
  runDir = path.join(RUN_PARENT, `judge-run-${process.pid}`);
  mkdirSync(runDir);
  const issueOf = new Map();
  for (const [issue, file] of hidden) {
    const shown = spawnSync("git", ["show", `${answers}:${file}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    if (shown.status !== 0) stop(`${answers}:${file}를 꺼내지 못했어요: ${String(shown.stderr).trim()}`);
    const target = path.join(runDir, path.basename(file));
    writeFileSync(target, shown.stdout);
    issueOf.set(fileKey(target), issue);
  }
  const report = path.join(runDir, "report.json");
  const relative = path.relative(root, runDir).split(path.sep).join("/");
  console.log(`숨은 테스트 ${hidden.size}개 파일을 지금 작업 트리에 대고 돌립니다 (${answers} ${answersCommit})`);
  const { code, output } = await run([vitest, "run", "--project", "node", "--reporter=json", `--outputFile=${report}`, `${relative}/`]);
  if (interrupted !== null) return null;
  if (!existsSync(report)) {
    console.error(output.trim().split("\n").slice(-20).join("\n"));
    stop(`숨은 테스트를 돌리지 못했어요(vitest 종료 코드 ${code}). 위 출력을 보세요.`);
  }
  const results = new Map();
  for (const file of JSON.parse(readFileSync(report, "utf8")).testResults) {
    const issue = issueOf.get(fileKey(file.name));
    if (issue === undefined) continue;
    const cases = file.assertionResults;
    const failures = cases.filter((test) => test.status !== "passed").map((test) => ({ title: test.title, message: firstLine(test.failureMessages[0] ?? "") }));
    // 파일을 아예 읽지 못하면 테스트 목록이 비고 이유는 message에 있다.
    if (cases.length === 0) failures.push({ title: "테스트 파일을 불러오지 못함", message: firstLine(file.message ?? "") });
    results.set(issue, { passed: cases.filter((test) => test.status === "passed").length, total: cases.length, failures });
  }
  cleanup();
  return results;
}

function firstLine(text) {
  return text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}

/** 규칙 채점기: 기준점 이후 바뀐 것. 기준점이 없으면 그 이유를 돌려준다. */
async function grade() {
  let base = options.base;
  if (base === null) {
    const tag = git(["describe", "--tags", "--match", "start/*", "--abbrev=0", "HEAD"]);
    if (tag.status !== 0) return { base: null, error: "시작 태그(start/*)를 찾지 못했어요. --base <브랜치>로 기준점을 정하세요." };
    base = tag.stdout;
  }
  const { code, output } = await run([path.join("tools", "grader", "src", "cli.ts"), "--json", "--since", base]);
  if (interrupted !== null) return null;
  if (code === 2) return { base, error: output.trim() };
  try {
    return { base, violations: JSON.parse(output).violations };
  } catch {
    return { base, error: `채점기 출력을 읽지 못했어요: ${firstLine(output)}` };
  }
}

const results = await runHidden();
if (interrupted !== null) process.exit(128 + os.constants.signals[interrupted]);
const graded = await grade();
if (interrupted !== null) process.exit(128 + os.constants.signals[interrupted]);

const titles = issueTitles();
const issues = [...new Set([...titles.keys(), ...hidden.keys()])].sort((a, b) => a - b);
const rows = issues.map((issue) => {
  const name = `${issue} ${titles.get(issue) ?? "(이슈 파일 없음)"}`;
  const result = results.get(issue);
  if (!hidden.has(issue)) return { name, hiddenText: "없음", verdict: "숨은 테스트 없음(사람이 정할 이슈)", ok: true };
  if (result === undefined) return { name, hiddenText: "결과 없음", verdict: "틀림", ok: false };
  const ok = result.failures.length === 0;
  return { name, hiddenText: `${ok ? "통과" : "실패"} ${result.passed}/${result.total}`, verdict: ok ? "맞음" : "틀림", ok };
});

console.log(`\n이슈별 결과 (숨은 테스트: ${answers} ${answersCommit})\n`);
console.log("| 이슈 | 숨은 테스트 | 채점 |");
console.log("| --- | --- | --- |");
for (const row of rows) console.log(`| ${row.name} | ${row.hiddenText} | ${row.verdict} |`);

const failed = [...results.entries()].filter(([, result]) => result.failures.length > 0);
if (failed.length > 0) {
  console.log("\n틀린 숨은 테스트");
  for (const [issue, result] of failed) {
    // 이슈마다 앞의 몇 개만 보인다. 나머지 개수는 따로 적는다.
    for (const failure of result.failures.slice(0, FAILURES_PER_ISSUE)) console.log(`  ${issue}번 · ${failure.title}\n      ${failure.message}`);
    const more = result.failures.length - FAILURES_PER_ISSUE;
    if (more > 0) console.log(`  ${issue}번 · 그 밖에 ${more}개`);
  }
}

console.log("");
if (graded.error !== undefined) console.log(`규칙 채점기: 채점할 수 없어요. ${graded.error}`);
else if (graded.violations.length === 0) console.log(`규칙 채점기 (${graded.base} 이후 바뀐 것): 통과`);
else {
  console.log(`규칙 채점기 (${graded.base} 이후 바뀐 것): 위반 ${graded.violations.length}개`);
  for (const violation of graded.violations) console.log(`  ${violation.file}:${violation.line}  ${violation.message}`);
}

const allPassed = rows.every((row) => row.ok) && graded.error === undefined && graded.violations.length === 0;
console.log(allPassed ? "\n[judge] 숨은 테스트와 규칙 채점 모두 통과" : "\n[judge] 틀린 곳이 있어요. 위 표와 PR 본문·리뷰를 다시 보세요.");
process.exit(allPassed ? 0 : 1);
