// 점검표(references/checklist.md)를 읽어 항목 목록으로 바꾼다. scan.mjs와 report.mjs가 같이 쓴다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CHECKLIST_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "references", "checklist.md");

export const KINDS = ["빈곳", "안티"];
// 칸이 쌓이는 층이다. 아래(바탕)부터 위(넓히기)로 쌓는다.
export const TIERS = ["바탕", "흐름", "넓히기"];
export const OWNERS = ["스캔", "기록", "읽기"];
export const GAP_RESULTS = ["있음", "일부", "없음", "확인불가", "해당없음"];
export const ANTI_RESULTS = ["걸림", "의심", "깨끗", "확인불가", "해당없음"];

/** 표 한 줄을 칸으로 나눈다. `\|`는 칸 구분이 아니라 글자다. */
function splitRow(line) {
  const cells = [];
  let cell = "";
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && body[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (body[i] === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += body[i];
    }
  }
  cells.push(cell.trim());
  return cells;
}

export function parseChecklist(text) {
  const areas = [];
  const items = [];
  let area = null;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const areaMatch = /^## ([a-z0-9-]+) · (.+) · (\S+)$/.exec(line);
    if (areaMatch) {
      if (!TIERS.includes(areaMatch[3])) throw new Error(`점검표 ${index + 1}줄: 층 "${areaMatch[3]}"는 ${TIERS.join("·")} 중 하나여야 합니다.`);
      area = { id: areaMatch[1], title: areaMatch[2].trim(), tier: areaMatch[3], role: "", items: [] };
      areas.push(area);
      continue;
    }
    const roleMatch = /^역할: (.+)$/.exec(line);
    if (roleMatch && area) {
      area.role = roleMatch[1].trim();
      continue;
    }
    if (line.startsWith("## ")) {
      area = null;
      continue;
    }
    if (!line.startsWith("|")) continue;
    const cells = splitRow(line);
    if (cells[0] === "id" || /^-+$/.test(cells[0])) continue;
    if (!area) throw new Error(`점검표 ${index + 1}줄: 칸(## id · 이름 · 층) 밖에 항목이 있습니다.`);
    if (cells.length !== 8) throw new Error(`점검표 ${index + 1}줄: 칸이 ${cells.length}개입니다. 8개여야 합니다.`);
    const [id, kind, title, refs, owner, rule, firstStep, why] = cells;
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`점검표 ${index + 1}줄: id "${id}"가 형식에 맞지 않습니다.`);
    if (!KINDS.includes(kind)) throw new Error(`점검표 ${index + 1}줄: 종류 "${kind}"는 ${KINDS.join("·")} 중 하나여야 합니다.`);
    if (!OWNERS.includes(owner)) throw new Error(`점검표 ${index + 1}줄: 담당 "${owner}"는 ${OWNERS.join("·")} 중 하나여야 합니다.`);
    if (items.some((item) => item.id === id)) throw new Error(`점검표 ${index + 1}줄: id "${id}"가 두 번 나옵니다.`);
    const item = { id, kind, title, refs, owner, rule, firstStep, why, area: area.id, tier: area.tier };
    area.items.push(item);
    items.push(item);
  }
  if (!areas.length) throw new Error("점검표에 칸이 하나도 없습니다.");
  const roleless = areas.filter((a) => !a.role).map((a) => a.id);
  if (roleless.length) throw new Error(`점검표: ${roleless.join(", ")} 칸에 「역할:」 줄이 없습니다.`);
  return { areas, items };
}

export function loadChecklist(file = CHECKLIST_PATH) {
  return parseChecklist(fs.readFileSync(file, "utf8"));
}

export function allowedResults(kind) {
  return kind === "안티" ? ANTI_RESULTS : GAP_RESULTS;
}
