// /review의 웹 확인용 서버. 개발 서버(3001·5173)와 겹치지 않는 포트와 run 폴더의 임시 DB로 API와 웹을 띄운다.
//   node .claude/skills/review/scripts/serve.mjs start <run 폴더>         띄우고 주소와 끄는 명령을 보인다
//   node .claude/skills/review/scripts/serve.mjs stop <run 폴더> <웹 포트>  그 서버를 끈다
// 띄운 서버는 스스로 30분 뒤에 꺼진다(끄는 걸 잊어도 포트가 남지 않게).
// 리뷰 둘이 동시에 돌면 다음 빈 포트 쌍(3102·5274 ...)을 쓴다.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const FIRST_API_PORT = 3101;
const FIRST_WEB_PORT = 5273;
const PORT_TRIES = 20;
const READY_TIMEOUT_MS = 90_000;
const LIFETIME_MS = 30 * 60_000;
const STOP_GRACE_MS = 5_000;

function fail(message) {
  console.error(`[review-server] ${message}`);
  process.exit(1);
}

function stateFile(runDir, webPort) {
  return path.join(runDir, `review-server-${webPort}.json`);
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function freePorts() {
  for (let offset = 0; offset < PORT_TRIES; offset += 1) {
    const api = FIRST_API_PORT + offset;
    const web = FIRST_WEB_PORT + offset;
    if ((await portFree(api)) && (await portFree(web))) return { api, web };
  }
  return fail(`${FIRST_API_PORT}~${FIRST_API_PORT + PORT_TRIES - 1} 포트가 모두 쓰이고 있습니다. 남은 리뷰 서버를 stop으로 끄세요.`);
}

async function responds(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killTree(pid) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  // 감독 프로세스는 detached라 자기 프로세스 그룹의 우두머리다. 그룹 전체에 신호를 보낸다.
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // 이미 끝난 그룹
  }
}

/** 그 포트의 서버를 끈다. 상태 파일이 없으면(이미 스스로 꺼졌거나 끈 뒤) 할 일이 없으므로 false. */
async function stopServer(runDir, webPort) {
  const file = stateFile(runDir, webPort);
  if (!existsSync(file)) return false;
  const { pid } = JSON.parse(readFileSync(file, "utf8"));
  if (alive(pid)) {
    if (process.platform === "win32") killTree(pid);
    else {
      process.kill(pid, "SIGTERM");
      const deadline = Date.now() + STOP_GRACE_MS;
      while (alive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
      if (alive(pid)) killTree(pid);
    }
  }
  rmSync(file, { force: true });
  return true;
}

async function stop(runDir, webPort) {
  const stopped = await stopServer(runDir, webPort);
  console.log(stopped ? `[review-server] 껐습니다(웹 포트 ${webPort}).` : `[review-server] 이미 꺼졌습니다(웹 포트 ${webPort}).`);
}

async function start(runDir) {
  mkdirSync(runDir, { recursive: true });
  const ports = await freePorts();
  const database = path.join(runDir, `review-${ports.web}.sqlite`);
  const env = { ...process.env, API_PORT: String(ports.api), WEB_PORT: String(ports.web), DATABASE_PATH: database };

  const reset = spawnSync(process.execPath, [path.join(root, "apps", "api", "scripts", "db-reset.ts")], { cwd: root, env, encoding: "utf8" });
  if (reset.status !== 0) fail(`임시 DB를 만들지 못했습니다.\n${reset.stderr || reset.stdout}`);

  const log = path.join(runDir, `review-server-${ports.web}.log`);
  const logFd = openSync(log, "w");
  const supervisor = spawn(process.execPath, [import.meta.filename, "run", runDir, String(ports.web)], { cwd: root, env, detached: true, stdio: ["ignore", logFd, logFd], windowsHide: true });
  closeSync(logFd);
  supervisor.unref();
  writeFileSync(stateFile(runDir, ports.web), JSON.stringify({ pid: supervisor.pid, apiPort: ports.api, webPort: ports.web, database }, null, 2));

  const webUrl = `http://127.0.0.1:${ports.web}`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await responds(`${webUrl}/api/health`)) && (await responds(webUrl))) {
      console.log(`[review-server] 주소: ${webUrl}`);
      // Windows에서도 슬래시로 찍는다. Git Bash에 그대로 붙여 넣으면 역슬래시가 사라지기 때문이다.
      const runDirShown = (path.relative(root, runDir) || ".").split(path.sep).join("/");
      console.log(`[review-server] 끄기: node .claude/skills/review/scripts/serve.mjs stop ${runDirShown} ${ports.web}`);
      return;
    }
    if (!alive(supervisor.pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await stopServer(runDir, ports.web);
  fail(`서버가 ${READY_TIMEOUT_MS / 1000}초 안에 뜨지 않았습니다. 로그: ${log}\n${readFileSync(log, "utf8").slice(-2_000)}`);
}

// 감독 프로세스: API와 웹을 자식으로 띄우고, 하나가 끝나거나 신호를 받거나 수명이 다하면 둘 다 끝낸다.
// 끝날 때 자기 상태 파일을 지운다. 남겨 두면 나중에 stop이 다른 프로세스가 쓰게 된 낡은 pid에 신호를 보낼 수 있다.
function run(runDir, webPort) {
  const webDir = path.join(root, "apps", "web");
  const viteBin = path.join(path.dirname(createRequire(path.join(webDir, "package.json")).resolve("vite/package.json")), "bin", "vite.js");
  const children = [
    spawn(process.execPath, [path.join(root, "apps", "api", "src", "main.ts")], { cwd: root, stdio: "inherit" }),
    spawn(process.execPath, [viteBin, "--strictPort"], { cwd: webDir, stdio: "inherit" }),
  ];
  let stopping = false;
  function stopAll(code) {
    if (stopping) return;
    stopping = true;
    rmSync(stateFile(runDir, webPort), { force: true });
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    setTimeout(() => process.exit(code), STOP_GRACE_MS).unref();
    Promise.all(children.map((child) => (child.exitCode !== null || child.signalCode !== null ? null : new Promise((resolve) => child.once("exit", resolve))))).then(() => process.exit(code));
  }
  for (const child of children) child.on("exit", () => stopAll(1));
  process.on("SIGTERM", () => stopAll(0));
  process.on("SIGINT", () => stopAll(0));
  setTimeout(() => {
    console.error(`[review-server] ${LIFETIME_MS / 60_000}분이 지나 스스로 끕니다.`);
    stopAll(0);
  }, LIFETIME_MS).unref();
}

const [command, runDirArg, webPortArg] = process.argv.slice(2);
const usage = "쓰는 법: serve.mjs start <run 폴더> | serve.mjs stop <run 폴더> <웹 포트>";
if (command === "run" && runDirArg && webPortArg) run(runDirArg, Number(webPortArg));
else if (command === "start" && runDirArg) await start(path.resolve(runDirArg));
else if (command === "stop" && runDirArg && webPortArg) await stop(path.resolve(runDirArg), Number(webPortArg));
else fail(usage);
