// SubagentStop Hook: /review의 검증자 셋(spec-checker·web-checker·code-reviewer)이 끝내려 할 때 마지막 답을 본다.
// - "검증한 커밋: <id>" 줄이 있고 그 id가 지금 HEAD여야 한다.
// - 판정 표의 줄마다 근거 칸(근거, 웹 확인은 해 본 것)이 비어 있지 않아야 한다. "웹 확인 몫"처럼 다른 검증자에게 넘긴 줄과 "diff에 없음"은 뺀다.
//   웹 확인의 PASS 줄은 화면 칸도 비어 있으면 안 된다(찍은 화면이 근거다).
// - 판정 표가 하나도 없으면 막는다. 웹 확인이 "화면 확인 AC 없음"이라고 답한 경우만 괜찮다.
// 프로젝트 settings에 건다. `claude -p`에서는 서브에이전트 파일(.claude/agents)의 Hook이 돌지 않기 때문이다.
import path from "node:path";
import { git } from "../../scripts/worktree-id.mjs";
import { emit, isMain, readPayload } from "./hook-io.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");
export const CHECKERS = new Set(["spec-checker", "web-checker", "code-reviewer"]);
const REVIEWED = /^검증한 커밋:\s*`?([0-9a-fA-F]{7,64})\b/m;
const EVIDENCE_HEADERS = ["근거", "해 본 것"];
const HANDED_OVER = /몫$|^diff에 없음$/;
const EMPTY = /^(-|없음)?$/;

function cells(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

/** 마크다운 표들. 머리 줄 다음의 구분 줄(| --- |)은 건너뛴다. */
function tables(text) {
  const out = [];
  let current = null;
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("|")) {
      current = null;
      continue;
    }
    const row = cells(line);
    if (current === null) {
      current = { header: row, rows: [] };
      out.push(current);
    } else if (!row.every((cell) => /^:?-{2,}:?$/.test(cell))) {
      current.rows.push(row);
    }
  }
  return out;
}

/** 근거가 빈 판정 줄의 첫 칸(AC-n, 규칙 번호 등) 목록과 판정 줄 수. */
export function rowsWithoutEvidence(text) {
  const missing = [];
  let judged = 0;
  for (const { header, rows } of tables(text)) {
    const evidence = header.findIndex((cell) => EVIDENCE_HEADERS.includes(cell));
    if (evidence < 0) continue;
    const screen = header.indexOf("화면");
    for (const row of rows) {
      if (row.some((cell) => HANDED_OVER.test(cell))) continue;
      judged += 1;
      const passWithoutScreen = screen >= 0 && row.includes("PASS") && EMPTY.test(row[screen] ?? "");
      if (EMPTY.test(row[evidence] ?? "") || passWithoutScreen) missing.push(row[0] || "(이름 없는 줄)");
    }
  }
  return { missing, judged };
}

function stopOrWarn(payload, why) {
  if (payload.stop_hook_active === true) {
    return { systemMessage: `${why} 이미 한 번 돌려보냈기 때문에 더 막지 않습니다(계속 막으면 끝내기가 끝없이 반복됩니다).` };
  }
  return { decision: "block", reason: why };
}

/**
 * @param payload SubagentStop Hook 입력(agent_type, last_assistant_message, stop_hook_active)
 * @param head 지금 HEAD 커밋 id를 돌려주는 함수
 */
export function decide(payload, head) {
  if (!CHECKERS.has(payload.agent_type)) return null;
  const answer = payload.last_assistant_message;
  if (typeof answer !== "string" || answer.trim() === "") {
    return stopOrWarn(payload, "마지막 답을 읽지 못했습니다. 판정 표와 근거, 검증한 커밋을 답으로 돌려주세요.");
  }
  const problems = [];
  const reviewed = REVIEWED.exec(answer)?.[1].toLowerCase();
  if (reviewed === undefined) {
    problems.push('"검증한 커밋: <HEAD 커밋 id>" 줄이 없습니다.');
  } else {
    let current;
    try {
      current = head();
    } catch (error) {
      return stopOrWarn(payload, `지금 HEAD를 읽지 못했습니다(${error.message}).`);
    }
    if (!current.startsWith(reviewed)) problems.push(`검증한 커밋 ${reviewed.slice(0, 7)}가 지금 HEAD ${current.slice(0, 7)}와 다릅니다.`);
  }
  const { missing, judged } = rowsWithoutEvidence(answer);
  const noScreenAc = payload.agent_type === "web-checker" && answer.includes("화면 확인 AC 없음");
  if (judged === 0 && !noScreenAc) problems.push("기준마다 판정과 근거를 적은 표가 없습니다.");
  if (missing.length > 0) problems.push(`근거가 빈 줄: ${missing.join(", ")}.`);
  if (problems.length === 0) return null;
  return stopOrWarn(
    payload,
    `${payload.agent_type}의 답에 근거가 모자랍니다. ${problems.join(" ")} 기준마다 근거(파일:줄, 명령 출력 파일, 화면 사진)를 채우고 "검증한 커밋: <HEAD>" 줄을 넣어 다시 답하세요. 확인하지 못한 기준은 BLOCKED와 이유를 근거 칸에 적습니다.`,
  );
}

if (isMain(import.meta.url)) {
  const payload = await readPayload();
  emit(decide(payload, () => git(payload.cwd ?? projectRoot, ["rev-parse", "HEAD"])));
}
