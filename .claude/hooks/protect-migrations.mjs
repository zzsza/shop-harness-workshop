// PreToolUse Hook: 이미 git에 있는 마이그레이션 파일을 고치려 하면 막는다. 새 번호 파일은 통과시킨다.
// 실행기(packages/db/src/migrate.ts)는 적용된 파일의 체크섬이 바뀌면 서버를 멈추므로, 주석 한 줄도 막는다.
import { execFileSync } from "node:child_process";
import path from "node:path";

// ① Claude Code가 도구를 실행하기 전에, 무엇을 하려는지 JSON으로 stdin에 넣어 준다
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd;

// ② 이번 호출이 바꾸려는 파일을 고른다
function targets() {
  const tool = input.tool_name;
  if (tool === "Edit" || tool === "Write") return [input.tool_input?.file_path];
  if (tool === "Bash" || tool === "PowerShell") {
    // 셸 명령은 글자로만 볼 수 있다. 파일을 바꾸는 흔한 모양일 때만 그 안의 마이그레이션 경로를 본다
    const command = String(input.tool_input?.command ?? "");
    const writes = /(^|[^0-9&])>{1,2}(?!&)|\btee\b|\bsed\s+-i|\bmv\b|\brm\b|Set-Content|Add-Content|Out-File|Remove-Item|Move-Item/i;
    if (!writes.test(command)) return [];
    return command.match(/[^\s'"]*packages[\\/]db[\\/]migrations[\\/][^\s'"]+\.sql/g) ?? [];
  }
  return [];
}

// ③ 레포 기준 경로로 바꾸고(Windows의 \ 포함), git에 이미 있는 마이그레이션이면 그 경로를 돌려준다
function committedMigration(file) {
  if (typeof file !== "string") return null;
  const rel = path.relative(root, path.resolve(root, file)).split(path.sep).join("/").replaceAll("\\", "/");
  if (!rel.startsWith("packages/db/migrations/")) return null;
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", rel], { cwd: root, stdio: "ignore" });
    return rel;
  } catch {
    return null; // 새 파일이면 ls-files가 실패한다
  }
}

const blocked = targets().map(committedMigration).find(Boolean);
if (!blocked) process.exit(0);

// ④ exit 2 = 도구 실행을 막고, stderr 문장을 모델에게 돌려준다
process.stderr.write(`${blocked}은(는) 이미 적용된 마이그레이션입니다. 고치지 말고 다음 번호 파일을 새로 만드세요.`);
process.exit(2);
