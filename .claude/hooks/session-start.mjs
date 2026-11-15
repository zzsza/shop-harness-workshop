// SessionStart Hook: 세션을 열 때마다 달라지는 "지금 상태"를 Claude에게 알려 준다.
// 바뀌지 않는 정보(명령어, 폴더)는 CLAUDE.md에 있고, 여기에는 열 때마다 새로 읽어야 하는 것만 둔다.
//   1. 개발 서버(API·웹)가 떠 있는지
//   2. 커밋 안 된 변경과 최근 커밋
//   3. DB의 주문·상품 수와 가장 최근 주문 시각
// 표준 출력이 Claude에게 참고 정보로 들어간다. 하나를 못 읽으면 그 줄에 까닭을 적고 나머지는 그대로 알린다.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const PORT_TIMEOUT_MS = 300;
const SHOWN_FILES = 3;

/** 레포의 환경 변수 계약(apps/api/src/config.ts)으로 포트와 DB 경로를 구한다. .env가 없으면 기본값. */
async function readConfig() {
  const { loadConfig } = await import(pathToFileURL(path.join(root, "apps", "api", "src", "config.ts")).href);
  const envFile = path.join(root, ".env");
  const fromFile = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
  return loadConfig({ ...fromFile, ...process.env });
}

function isListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (up) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(PORT_TIMEOUT_MS, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function serverLine(config) {
  const api = `API(127.0.0.1:${config.apiPort})`;
  const web = `웹(127.0.0.1:${config.webPort})`;
  const [apiUp, webUp] = await Promise.all([isListening(config.apiPort), isListening(config.webPort)]);
  if (apiUp && webUp) return `개발 서버: ${api}와 ${web}이 이미 떠 있습니다. npm run dev를 다시 띄우지 말고 이 주소로 확인하세요.`;
  if (!apiUp && !webUp) return `개발 서버: 떠 있지 않습니다. 화면이나 API를 확인하려면 npm run dev로 띄우세요.`;
  const [up, down] = apiUp ? [api, web] : [web, api];
  return `개발 서버: ${up}만 떠 있고 ${down}은 꺼져 있습니다. npm run dev를 껐다가 다시 띄우세요.`;
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trimEnd();
}

function gitLine() {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const changed = git(["status", "--porcelain"]).split("\n").filter(Boolean).map((line) => line.slice(3));
  const commits = git(["log", "-3", "--no-merges", "--format=%s"]).split("\n").filter(Boolean);
  const shown = changed.slice(0, SHOWN_FILES).join(", ");
  const more = changed.length > SHOWN_FILES ? ` 외 ${changed.length - SHOWN_FILES}개` : "";
  const changes = changed.length === 0 ? "커밋 안 된 변경 없음" : `커밋 안 된 변경 ${changed.length}개 파일(${shown}${more})`;
  return `git: 브랜치 ${branch}. ${changes}. 최근 커밋: ${commits.join(" / ")}`;
}

function since(iso) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (Number.isNaN(minutes)) return iso;
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}시간 전`;
  return iso.slice(0, 10);
}

async function dbLine(config) {
  const file = path.relative(root, config.databasePath);
  if (!existsSync(config.databasePath)) return `DB: 파일이 없습니다(${file}). npm run db:reset으로 만드세요.`;
  // Node 22의 node:sqlite는 실험 기능 경고를 내므로, Hook 출력이 지저분해지지 않게 경고만 끈다.
  process.removeAllListeners("warning");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(config.databasePath, { readOnly: true });
  try {
    const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    const latest = db.prepare("SELECT MAX(created_at) AS at FROM orders").get().at;
    const last = latest ? `, 가장 최근 주문 ${since(latest)}` : "";
    return `DB: 주문 ${count("orders")}건, 상품 ${count("products")}개${last} (${file}).`;
  } finally {
    db.close();
  }
}

async function attempt(label, read) {
  try {
    return await read();
  } catch (error) {
    return `${label}: 읽지 못했습니다(${error instanceof Error ? error.message.split("\n")[0] : String(error)}).`;
  }
}

const lines = [await attempt("git", gitLine)];
const config = await attempt("설정", readConfig);
if (typeof config === "string") lines.push(`${config} npm run setup을 먼저 실행했는지 확인하세요.`);
else lines.push(await attempt("개발 서버", () => serverLine(config)), await attempt("DB", () => dbLine(config)));

console.log(["지금 상태(세션을 열 때 읽음):", ...lines.map((line) => `- ${line}`)].join("\n"));
