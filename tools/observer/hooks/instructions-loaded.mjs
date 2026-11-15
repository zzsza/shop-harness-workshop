// InstructionsLoaded Hook. 레포 .claude/settings.json에 걸려 있다.
// Claude Code가 CLAUDE.md·Rules 파일을 읽을 때마다 stdin으로 받은 내용에 기록 시각을 붙여
// <레포>/.observer/instructions/<session_id>.jsonl에 한 줄씩 남긴다. 세션 뷰어의 지침 지도 탭이 읽는다.
// 기록은 레포 안(git이 무시하는 .observer/)에만 쓰고, 내 Claude Code 설정 폴더(~/.claude)에는 쓰지 않는다.
// 레포 위치는 Claude Code가 넘기는 CLAUDE_PROJECT_DIR로만 정한다. 없으면 아무것도 쓰지 않고 실패한다.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

function fail(message) {
  process.stderr.write(`[instructions-loaded] ${message}\n`);
  process.exit(1);
}

function logDirectory() {
  if (!process.env.CLAUDE_PROJECT_DIR) return fail("CLAUDE_PROJECT_DIR이 없어 기록하지 않았습니다. 레포 폴더에서 npm run claude로 시작하세요.");
  return path.join(process.env.CLAUDE_PROJECT_DIR, ".observer", "instructions");
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));

const sessionId = input.session_id;
if (typeof sessionId !== "string" || !/^[A-Za-z0-9-]+$/.test(sessionId)) fail("session_id가 없거나 형식이 다릅니다.");

const dir = logDirectory();
mkdirSync(dir, { recursive: true });
appendFileSync(path.join(dir, `${sessionId}.jsonl`), `${JSON.stringify({ observed_at: new Date().toISOString(), ...input })}\n`);
