// npm run ci: PR이 받을 검사를 "커밋한 것만" 가지고 돌린다.
// 커밋 꺼내기 → 의존성 → Node 확인 → 타입 검사 → lint → 테스트 → 빌드 → 채점(기준점 이후 바뀐 것).
// Node 확인부터 빌드까지는 verify.mjs를 단계마다 따로 불러, 어느 단계에서 멈췄는지 표와 결과 파일에 남긴다.
// 내 폴더에서는 커밋을 임시 폴더에 꺼내 돌리므로, 커밋하지 않은 파일은 검사에 들어가지 않는다.
// GitHub Actions와 GitLab CI에서는 체크아웃 자체가 깨끗한 폴더라서 그 자리에서 돈다. 로컬과 CI가 같은 명령을 쓴다.
//
//   npm run ci                        HEAD를 검사, 기준점은 가장 가까운 start/* 태그
//   npm run ci -- --base day2-b       기준점을 직접 정한다(브랜치·태그·커밋)
//   npm run ci -- <커밋>              HEAD 대신 그 커밋을 검사
//   npm run ci -- --result <파일>     끝나면 단계별 결과를 JSON으로 남긴다(npm run merge가 읽는다)
// GitHub의 PR에서는 기준점이 그 PR의 base 브랜치(origin/<base>)다.
// GitLab의 MR 파이프라인에서는 그 MR의 target 브랜치(origin/<target>)다.
// 종료 코드: 0 통과, 1 검사 실패, 2 검사를 돌릴 수 없음, 128+신호 번호 중간에 멈춤(Ctrl+C 130).
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  constants,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const root = realpathSync.native(path.resolve(import.meta.dirname, ".."));
// GitLab은 GITLAB_CI=true를 주고, MR 파이프라인에서만 CI_MERGE_REQUEST_TARGET_BRANCH_NAME을 준다.
const inGitLab = process.env.GITLAB_CI === "true";
const inActions = process.env.GITHUB_ACTIONS === "true" || inGitLab;
// 임시 폴더 이름에 이 실행의 PID를 넣는다. 다음 실행이 주인이 끝난 폴더만 골라 치울 수 있게.
const TEMP_PREFIX = "shop-ci-";
const TEMP_NAME = /^shop-ci-(\d+)-/;
// 멈추라는 신호를 받은 자식이 이 시간 안에 끝나지 않으면 강제로 끝낸다.
const CHILD_STOP_GRACE_MS = 10_000;

function git(args, cwd = root) {
  const result = spawnSync("git", ["-c", "core.quotepath=off", ...args], { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  // 앞 공백은 남긴다(status --porcelain의 " M <경로>"처럼 앞자리가 뜻을 가진다).
  return { status: result.status ?? 1, stdout: result.stdout.trimEnd(), stderr: result.stderr.trim() };
}

function stop(message) {
  console.error(`\n[ci] 검사를 돌릴 수 없어요: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  let base = null;
  let commit = "HEAD";
  let result = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base") {
      base = argv[index + 1] ?? stop("--base 뒤에 기준이 될 브랜치나 커밋을 적으세요.");
      index += 1;
    } else if (arg === "--result") {
      result = argv[index + 1] ?? stop("--result 뒤에 결과를 남길 파일 경로를 적으세요.");
      index += 1;
    } else if (arg.startsWith("--")) stop(`알 수 없는 옵션 ${arg}. 쓸 수 있는 옵션: --base <ref>, --result <파일>, <커밋>`);
    else commit = arg;
  }
  return { base, commit, result };
}

function commitOf(ref) {
  return git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).stdout;
}

const { base: baseArg, commit, result: resultFile } = parseArgs(process.argv.slice(2));

const sha = commitOf(commit) || stop(`${commit}라는 커밋이 없어요.`);
const short = sha.slice(0, 7);

function chooseBase() {
  if (baseArg !== null) return baseArg;
  if (process.env.GITHUB_BASE_REF) return `origin/${process.env.GITHUB_BASE_REF}`;
  if (inGitLab && process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME) return `origin/${process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME}`;
  const tag = git(["describe", "--tags", "--match", "start/*", "--abbrev=0", sha]);
  if (tag.status === 0) return tag.stdout;
  return stop("채점 기준점을 찾지 못했어요. 실습 브랜치(day2-a 등)에서 딴 브랜치인지 확인하거나 --base <브랜치>로 정하세요.");
}
const base = chooseBase();
if (!commitOf(base)) stop(`채점 기준점 ${base}를 이 저장소에서 찾지 못했어요. 브랜치 이름을 확인하거나 git fetch 뒤 다시 돌리세요.`);

// 커밋하지 않은 변경. 검사에 들어가지 않는다는 것을 보여 주려고 센다(GitHub·GitLab에는 없다).
const uncommitted = inActions
  ? []
  : git(["status", "--porcelain", "--untracked-files=all"]).stdout.split("\n").filter((line) => line !== "").map((line) => line.slice(3));

function npmCli() {
  // npm run으로 띄우면 npm이 자기 위치를 알려 준다. 셸을 거치지 않고 현재 node로 npm을 돌려 Mac·Windows가 같게 돈다.
  return process.env.npm_execpath || stop("npm run ci로 실행하세요(npm 위치를 알 수 없어요).");
}

// 지금 돌고 있는 자식과 받은 신호. 신호를 받으면 자식(과 그 자식들)을 멈추고, 끝나기를 기다린 뒤 치우고 나간다.
let current = null;
let interrupted = null;

function stopChild(child, signal) {
  // Mac·Linux에서는 자식을 자기 프로세스 그룹으로 띄웠으니 그룹째 보낸다(verify가 띄운 vitest 등까지).
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

function run(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ["ignore", "inherit", "inherit"],
      detached: process.platform !== "win32",
    });
    current = child;
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      current = null;
      resolve(code ?? (signal === null ? 1 : 128 + os.constants.signals[signal]));
    });
  });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (interrupted !== null) return;
    interrupted = signal;
    console.error(`\n[ci] ${signal}를 받아 멈추고 임시 폴더를 치웁니다.`);
    if (current === null) process.exit(128 + os.constants.signals[signal]);
    const child = current;
    stopChild(child, signal);
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) stopChild(child, "SIGKILL");
    }, CHILD_STOP_GRACE_MS).unref();
  });
}

/** 폴더 안의 링크(심볼릭 링크, Windows의 junction)를 모두 찾는다. 링크 안으로는 들어가지 않는다. */
function linksUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isSymbolicLink())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/**
 * 임시 worktree를 지운다. node_modules의 링크를 먼저 끊는다.
 * 링크를 따라 지우면 링크가 가리키는 원본(내 폴더의 packages 등)이 지워질 수 있다.
 */
function removeTempWorktree(dir) {
  for (const link of linksUnder(path.join(dir, "node_modules"))) unlinkSync(link);
  git(["worktree", "remove", "--force", dir]);
  rmSync(dir, { recursive: true, force: true });
}

let dir = root;
function cleanup() {
  if (current !== null) stopChild(current, "SIGKILL");
  if (dir === root) return;
  removeTempWorktree(dir);
  git(["worktree", "prune"]);
  dir = root;
}
// 통과·실패·stop()·예외·신호, 어떤 길로 끝나도 임시 폴더를 치운다.
process.on("exit", cleanup);

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: 있지만 다른 사용자의 프로세스다.
    return error.code === "EPERM";
  }
}

/** 지난 실행이 치우지 못하고 끝난 임시 폴더(강제 종료 등). 이름의 PID가 끝난 것만 지운다. */
function removeStaleRuns() {
  for (const name of readdirSync(os.tmpdir())) {
    const owner = TEMP_NAME.exec(name);
    if (owner === null || isRunning(Number(owner[1]))) continue;
    console.log(`지난 실행이 남긴 임시 폴더를 치웁니다: ${name}`);
    removeTempWorktree(path.join(os.tmpdir(), name));
  }
  git(["worktree", "prune"]);
}

/**
 * node_modules를 링크만 빼고 복사한 뒤, 링크는 꺼낸 폴더 안쪽을 가리키게 다시 만든다.
 * npm은 작업 공간 패키지(@grabmarket/*)를 링크로 두는데, Windows에서는 절대 경로 junction이다.
 * 그대로 복사하면 꺼낸 폴더가 내 폴더의 packages(커밋하지 않은 코드)를 보게 된다.
 */
function copyModules(from, to) {
  const links = linksUnder(from);
  const skip = new Set(links);
  cpSync(from, to, { recursive: true, filter: (source) => !skip.has(source), mode: constants.COPYFILE_FICLONE });
  for (const link of links) {
    const name = path.relative(root, link);
    const pointed = path.resolve(path.dirname(link), readlinkSync(link));
    if (!existsSync(pointed)) stop(`node_modules의 링크 ${name}가 없는 곳(${pointed})을 가리켜요. npm ci로 다시 설치한 뒤 돌리세요.`);
    // 실제 경로로 비교한다(Mac의 /var와 /private/var, Windows의 드라이브 글자 대소문자).
    const target = realpathSync.native(pointed);
    const inRepo = path.relative(root, target);
    if (inRepo.startsWith("..") || path.isAbsolute(inRepo)) {
      stop(`node_modules의 링크 ${name}가 이 폴더 밖(${target})을 가리켜요. npm ci로 다시 설치한 뒤 돌리세요.`);
    }
    const copy = path.join(dir, name);
    const copyTarget = path.join(dir, inRepo);
    const type = statSync(target).isDirectory() ? "junction" : "file";
    symlinkSync(path.relative(path.dirname(copy), copyTarget), copy, type);
  }
}

/** 줄바꿈만 다른 package-lock은 같은 것으로 본다(Windows의 git은 꺼낼 때 줄바꿈을 CRLF로 바꿀 수 있고, npm은 LF로 쓴다). */
function lockText(file) {
  return readFileSync(file, "utf8").replaceAll("\r\n", "\n");
}

/** 의존성: package-lock이 내 폴더와 같으면 설치된 node_modules를 복사하고(인터넷 없이), 다르면 npm ci. */
async function installDependencies() {
  const lock = path.join(dir, "package-lock.json");
  const localModules = path.join(root, "node_modules");
  const sameLock = dir !== root && existsSync(localModules) && lockText(lock) === lockText(path.join(root, "package-lock.json"));
  if (sameLock) {
    console.log("package-lock이 같아 설치된 node_modules를 복사합니다.");
    copyModules(localModules, path.join(dir, "node_modules"));
    return 0;
  }
  if (dir === root && existsSync(localModules)) return 0;
  return run([npmCli(), "ci", "--prefer-offline", "--no-audit", "--no-fund"], dir);
}

const verifyStep = (key, name) => ({ key, name, run: () => run([path.join("scripts", "verify.mjs"), "--only", key], dir) });
const steps = [
  {
    key: "checkout",
    name: inActions ? `체크아웃 확인 (${short})` : `커밋 꺼내기 (${short})`,
    run: () => {
      if (inActions) return 0;
      removeStaleRuns();
      // Windows의 임시 폴더는 짧은 이름(RUNNER~1)으로 올 수 있다. 같은 폴더가 두 이름으로 보이면 vite가 링크 너머 파일을 못 찾으니 실제 경로로 쓴다.
      dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), `${TEMP_PREFIX}${process.pid}-`)));
      const added = git(["worktree", "add", "--detach", dir, sha]);
      if (added.status !== 0) console.error(added.stderr);
      return added.status;
    },
  },
  { key: "dependencies", name: "의존성", run: installDependencies },
  verifyStep("node", "Node 확인"),
  verifyStep("typecheck", "타입 검사"),
  verifyStep("lint", "lint"),
  verifyStep("test", "테스트"),
  verifyStep("build", "빌드"),
  { key: "grade", name: `채점 (${base} 이후 바뀐 것)`, run: () => run([path.join("tools", "grader", "src", "cli.ts"), "--since", base], dir) },
];

function summary(results) {
  const lines = ["| 단계 | 결과 |", "| --- | --- |", ...results.map(({ name, ok }) => `| ${name} | ${ok === null ? "안 돌림" : ok ? "통과" : "실패"} |`)];
  return lines.join("\n");
}

const results = steps.map(({ key, name }) => ({ key, name, ok: null }));
let failed = null;
for (const [index, step] of steps.entries()) {
  console.log(`\n[ci ${index + 1}/${steps.length}] ${step.name}`);
  const code = await step.run();
  if (interrupted !== null) break;
  results[index].ok = code === 0;
  if (code !== 0) {
    failed = step;
    break;
  }
}
cleanup();
if (interrupted !== null) process.exit(128 + os.constants.signals[interrupted]);

console.log(`\n${summary(results)}`);
if (uncommitted.length > 0) {
  console.log(`\n[ci] 커밋하지 않은 변경 ${uncommitted.length}개는 검사하지 않았어요(PR에도 안 올라가요): ${uncommitted.slice(0, 5).join(", ")}${uncommitted.length > 5 ? " ..." : ""}`);
}
if (resultFile !== null) {
  writeFileSync(resultFile, `${JSON.stringify({ commit: sha, base, ok: failed === null, failed: failed?.key ?? null, steps: results }, null, 2)}\n`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## PR 검사 · ${short}\n\n${summary(results)}\n\n채점 기준점: \`${base}\`\n`);
}
if (failed !== null) {
  console.error(`\n[ci] 실패: "${failed.name}" 단계`);
  process.exit(1);
}
console.log(`\n[ci] 통과 · 커밋 ${short}`);
