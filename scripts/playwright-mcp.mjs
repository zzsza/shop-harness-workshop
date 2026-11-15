// .mcp.json의 playwright 서버: 노트북에 이미 깔린 Edge나 Chrome으로 Playwright MCP를 띄운다. 브라우저는 내려받지 않는다.
// Windows는 Edge를, Mac은 Chrome을 먼저 찾는다. 둘 다 없으면 이유를 말하고 끝난다.
// npx를 직접 적지 않고 이 스크립트를 거치는 까닭: Windows에서 npx는 .cmd라서 셸 없이 띄울 수 없다.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// 2026-10-31에 나온 버전. 수업 중에 새 버전이 끼어들지 않게 고정한다. 바꾸면 README.md와 docs/github.md의 미리 받기 명령도 같이 바꾼다.
const PACKAGE = "@playwright/mcp@0.0.84";
const root = path.resolve(import.meta.dirname, "..");

function windowsPaths(...relative) {
  const bases = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean);
  return bases.flatMap((base) => relative.map((file) => path.join(base, file)));
}

const BROWSERS = {
  win32: [
    { channel: "msedge", paths: windowsPaths(path.join("Microsoft", "Edge", "Application", "msedge.exe")) },
    { channel: "chrome", paths: windowsPaths(path.join("Google", "Chrome", "Application", "chrome.exe")) },
  ],
  darwin: [
    { channel: "chrome", paths: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] },
    { channel: "msedge", paths: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"] },
  ],
  linux: [
    { channel: "chrome", paths: ["/opt/google/chrome/chrome"] },
    { channel: "msedge", paths: ["/opt/microsoft/msedge/msedge"] },
  ],
};

const candidates = BROWSERS[process.platform] ?? [];
const found = candidates.find((browser) => browser.paths.some((file) => existsSync(file)));
if (!found) {
  const looked = candidates.flatMap((browser) => browser.paths).join(", ") || "(이 OS는 찾을 곳을 모릅니다)";
  console.error(`[playwright-mcp] Edge나 Chrome을 찾지 못했습니다. 찾아본 곳: ${looked}. 브라우저를 내려받지 않으므로 Playwright MCP를 띄우지 않습니다.`);
  process.exit(1);
}

// 셸을 거치는 Windows에서 공백 있는 경로가 갈라지지 않게 출력 폴더는 레포 기준 상대 경로로 넘긴다.
const args = ["-y", PACKAGE, "--browser", found.channel, "--isolated", "--output-dir", ".playwright-mcp"];
const child = spawn("npx", args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
child.on("error", (error) => {
  console.error(`[playwright-mcp] npx를 실행하지 못했습니다: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
