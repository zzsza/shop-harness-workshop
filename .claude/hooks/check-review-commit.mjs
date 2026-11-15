// PreToolUse Hook(Bash): `gh pr create` 직전에 리뷰가 지금 코드를 본 것인지 확인한다.
// docs/tasks/<slug>/run/review.md의 "검증한 커밋"이 지금 HEAD와 다르면(리뷰 뒤에 코드가 바뀜) 막는다.
// 전체 판정이 PASS가 아니거나 review.md가 없어도 막는다. 낡은 PASS나 없는 PASS로 PR을 열지 않게 하는 장치다.
// slug는 `--body-file docs/tasks/<slug>/run/pr.md`에서, 없으면 브랜치 feat/<slug>에서 얻는다.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { git } from "../../scripts/worktree-id.mjs";
import { commandName, simpleCommands, toSlash } from "./bash-command.mjs";
import { denyTool, emit, isMain, readPayload } from "./hook-io.mjs";

const RUN_FILE = /(?:^|\/)docs\/tasks\/([^/]+)\/run\//;
const REVIEWED = /^검증한 커밋:\s*`?([0-9a-fA-F]{7,64})\b/m;
const VERDICT = /^전체 판정:\s*\*\*(PASS|FAIL|BLOCKED)\*\*/m;

function isPrCreate(argv) {
  if (commandName(argv[0]) !== "gh") return false;
  const index = argv.indexOf("pr");
  return index > 0 && argv[index + 1] === "create";
}

function bodyFile(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--body-file" || token === "-F") return argv[index + 1] ?? null;
    if (token.startsWith("--body-file=")) return token.slice("--body-file=".length);
  }
  return null;
}

function slugOf(argv, cwd) {
  const file = bodyFile(argv);
  const match = file === null ? null : RUN_FILE.exec(toSlash(file));
  if (match !== null) return match[1];
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return branch.startsWith("feat/") ? branch.slice("feat/".length) : null;
}

/** gh pr create 하나를 본다. 막을 이유가 있으면 그 문장, 없으면 null. */
function problemOf(argv, cwd) {
  const slug = slugOf(argv, cwd);
  if (slug === null) return "어느 작업의 PR인지 모릅니다. `--body-file docs/tasks/<slug>/run/pr.md`로 여세요.";
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  const reviewPath = `docs/tasks/${slug}/run/review.md`;
  if (!existsSync(path.join(root, reviewPath))) return `${reviewPath}가 없습니다. \`/review ${slug}\`를 먼저 돌리세요.`;
  const review = readFileSync(path.join(root, reviewPath), "utf8");
  const verdict = VERDICT.exec(review)?.[1];
  if (verdict !== "PASS") return `${reviewPath}의 전체 판정이 ${verdict ?? "없음"}입니다. PASS인 리뷰만 PR로 올립니다.`;
  const reviewed = REVIEWED.exec(review)?.[1].toLowerCase();
  if (reviewed === undefined) return `${reviewPath}에 "검증한 커밋:" 줄이 없습니다. \`/review ${slug}\`를 다시 돌리세요.`;
  const head = git(cwd, ["rev-parse", "HEAD"]);
  if (!head.startsWith(reviewed)) {
    return `${reviewPath}는 ${reviewed.slice(0, 7)}를 검증했는데 지금 HEAD는 ${head.slice(0, 7)}입니다. 리뷰 뒤에 코드가 바뀌었으니 \`/review ${slug}\`를 다시 돌린 뒤 PR을 여세요.`;
  }
  return null;
}

export function decide(payload) {
  if (payload.tool_name !== "Bash") return null;
  const cwd = payload.cwd ?? process.cwd();
  const creates = simpleCommands(String(payload.tool_input?.command ?? ""), cwd).filter((simple) => isPrCreate(simple.argv));
  for (const simple of creates) {
    let problem;
    try {
      problem = problemOf(simple.argv, simple.cwd ?? cwd);
    } catch (error) {
      problem = `리뷰한 커밋을 확인하지 못했습니다(${error.message}).`;
    }
    if (problem !== null) return denyTool(`PR을 열지 않았습니다. ${problem}`);
  }
  return null;
}

if (isMain(import.meta.url)) {
  emit(decide(await readPayload()));
}
