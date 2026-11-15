#!/usr/bin/env node
// 하네스 점검 보고서. scan.mjs의 facts.json과 점검 담당 결과(parts.json)를 합쳐
// merged.json, report.md, report.html을 같은 폴더에 쓴다. 같은 레포·같은 설정 폴더의 지난 결과가 있으면 비교한다.
//
// node report.mjs --out <scan.mjs가 알려 준 결과 폴더> [--open]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { loadChecklist, allowedResults } from "./checklist.mjs";

const GAP_SCORE = { 있음: 1, 일부: 0.5, 없음: 0 };
// 사용자가 꼽은 불편과 이어지는 영역이다. 먼저 고칠 곳을 고를 때 같은 등급 안에서 앞에 둔다.
const PAIN_AREAS = [
  [/들쭉|품질|일관|엉뚱/, ["guide", "flow"]],
  [/지켜|오래|맡기|중간/, ["verify", "flow"]],
  [/검증|확인|리뷰|테스트/, ["verify"]],
  [/설명|반복|매번/, ["guide", "tools"]],
];

export function parseArgs(argv) {
  const index = argv.indexOf("--out");
  if (index < 0 || !argv[index + 1]) throw new Error("--out <결과 폴더>가 필요합니다.");
  return { out: path.resolve(argv[index + 1]), open: argv.includes("--open") };
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${label}(${file})를 읽지 못했습니다: ${error.message}`, { cause: error });
  }
}

/** 담당 결과를 점검표 기준으로 검사해 합친다. 형식이 틀린 결과는 버리고 이유를 남긴다. */
export function merge(checklist, facts, parts) {
  const merged = {};
  const problems = [];
  for (const item of checklist.items) {
    const scanned = facts.results[item.id];
    merged[item.id] = scanned ? { ...scanned } : { result: "확인불가", evidence: [], note: "점검 담당이 결과를 남기지 않음", by: item.owner };
  }
  for (const [group, part] of Object.entries(parts ?? {})) {
    const list = Array.isArray(part) ? part : part?.results;
    if (!Array.isArray(list)) {
      problems.push(`${group} 결과가 목록이 아님`);
      continue;
    }
    const waiting = facts.waiting?.[group] ?? [];
    for (const entry of list) {
      const item = checklist.items.find((i) => i.id === entry?.id);
      if (!item) {
        problems.push(`${group}: 점검표에 없는 id ${entry?.id}`);
        continue;
      }
      if (!waiting.includes(item.id)) {
        problems.push(`${group}: ${item.id}는 이 담당에게 맡긴 항목이 아님`);
        continue;
      }
      if (!allowedResults(item.kind).includes(entry.result)) {
        problems.push(`${group}: ${item.id}의 결과 "${entry.result}"가 허용 값이 아님`);
        continue;
      }
      merged[item.id] = {
        result: entry.result,
        evidence: (Array.isArray(entry.evidence) ? entry.evidence : []).map(String).slice(0, 8),
        note: String(entry.note ?? "").slice(0, 300),
        by: "점검 담당",
        scan: facts.results[item.id]?.result,
      };
    }
  }
  return { merged, problems };
}

function fill(items, merged) {
  const gaps = items.filter((i) => i.kind === "빈곳" && merged[i.id].result in GAP_SCORE);
  return gaps.length ? gaps.reduce((n, i) => n + GAP_SCORE[merged[i.id].result], 0) / gaps.length : null;
}

function areaScores(checklist, merged) {
  const scores = {};
  for (const area of checklist.areas) {
    scores[area.id] = {
      score: fill(area.items, merged),
      hits: area.items.filter((i) => merged[i.id].result === "걸림").length,
      doubts: area.items.filter((i) => merged[i.id].result === "의심").length,
      missing: area.items.filter((i) => merged[i.id].result === "없음").length,
    };
  }
  return scores;
}

export function painAreas(pain = "") {
  return [...new Set(PAIN_AREAS.filter(([re]) => re.test(pain)).flatMap(([, areas]) => areas))];
}

export function pickTop(checklist, merged, pain = "") {
  const boosted = new Set(painAreas(pain));
  const tier = (item) => ({ 걸림: 0, 없음: 1, 의심: 2, 일부: 3 })[merged[item.id].result] ?? null;
  const ranked = checklist.items
    .map((item, order) => ({ item, order, tier: tier(item) }))
    .filter((x) => x.tier !== null)
    .sort((a, b) => a.tier - b.tier || Number(boosted.has(b.item.area)) - Number(boosted.has(a.item.area)) || a.order - b.order)
    .map((x) => x.item);
  // 한 영역에서 셋이 다 나오지 않게 영역마다 하나씩 먼저 고르고, 모자라면 순서대로 채운다.
  const picked = [];
  for (const item of ranked) if (picked.length < 3 && !picked.some((p) => p.area === item.area)) picked.push(item);
  for (const item of ranked) if (picked.length < 3 && !picked.includes(item)) picked.push(item);
  return picked;
}

// 같은 레포·같은 설정 폴더의 바로 앞 결과. 설정 폴더가 다르면(평소 계정과 실습 계정) 사용자 범위가 달라 비교하면 틀린 말이 된다.
export function findPrevious(out, configDir) {
  const parent = path.dirname(out);
  const current = path.basename(out);
  const sameConfig = (name) => readJson(path.join(parent, name, "facts.json"), "지난 스캔 결과").configDir === configDir;
  const earlier = fs
    .readdirSync(parent, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name < current && fs.existsSync(path.join(parent, e.name, "merged.json")) && fs.existsSync(path.join(parent, e.name, "facts.json")))
    .map((e) => e.name)
    .filter(sameConfig)
    .sort();
  if (!earlier.length) return null;
  const name = earlier[earlier.length - 1];
  return { name, data: readJson(path.join(parent, name, "merged.json"), "지난 결과") };
}

const RANK = { 있음: 2, 일부: 1, 없음: 0, 깨끗: 2, 의심: 1, 걸림: 0 };

function compare(checklist, merged, previous) {
  if (!previous) return null;
  const better = [];
  const worse = [];
  for (const item of checklist.items) {
    const before = previous.data.results?.[item.id]?.result;
    const after = merged[item.id].result;
    if (!(before in RANK) || !(after in RANK) || before === after) continue;
    (RANK[after] > RANK[before] ? better : worse).push({ item, before, after });
  }
  return { name: previous.name, overall: previous.data.overall ?? null, scores: previous.data.scores ?? {}, better, worse };
}

// ---------- 출력 ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const rich = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
const pct = (score) => (score === null || score === undefined ? "–" : `${Math.round(score * 100)}%`);

const TIER_TEXT = {
  바탕: { subject: "바탕은", object: "바탕을", role: "에이전트가 일할 자리" },
  흐름: { subject: "흐름은", object: "흐름을", role: "맡기고 확인하는 방식" },
  넓히기: { subject: "넓히기는", object: "넓히기를", role: "큰 코드와 팀으로" },
};

// 칸 하나가 보고서에서 어떻게 보이는지: [불 모양, 쉬운 이름]
const LAMP = {
  있음: ["on", "하고 있음"],
  일부: ["half", "절반쯤"],
  없음: ["off", "아직 없음"],
  걸림: ["hit", "손볼 곳"],
  의심: ["doubt", "한번 볼 곳"],
  깨끗: ["clean", "괜찮음"],
  확인불가: ["na", "확인 못 함"],
  해당없음: ["na", "해당 없음"],
};

const JUDGED_BY = { 스캔: "스캔으로 판정", 기록: "세션 기록으로 판정", 읽기: "점검 담당이 읽고 판정", "점검 담당": "점검 담당이 읽고 판정" };

function level(score) {
  if (score >= 0.7) return "잘 갖춰져 있어요";
  if (score >= 0.4) return "절반쯤 갖췄어요";
  return "아직 비어 있어요";
}

/** 층별 채움을 보고 한 줄 진단을 만든다. 층은 아래부터 쌓으므로 다 비었으면 바탕부터 권한다. */
export function diagnose(checklist, merged) {
  const tiers = [...new Set(checklist.areas.map((a) => a.tier))]
    .map((tier) => ({ tier, score: fill(checklist.items.filter((i) => i.tier === tier), merged) }))
    .filter((t) => t.score !== null);
  const hits = checklist.items.filter((i) => merged[i.id].result === "걸림").length;
  let headline;
  if (!tiers.length) headline = "점검할 수 있는 칸이 없었어요.";
  else {
    const sorted = [...tiers].sort((a, b) => b.score - a.score);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    if (best.score < 0.4) headline = "아직 대부분 비어 있어요. 바탕부터 하나씩 불을 켜 보세요.";
    else if (best.score - worst.score < 0.15) headline = `세 층 모두 ${level(best.score)}.`;
    else headline = `${TIER_TEXT[best.tier].subject} ${level(best.score)}. ${TIER_TEXT[worst.tier].object} 채울 차례예요.`;
  }
  const warning = hits ? `손보면 좋은 곳이 ${hits}군데 있어요. 여기부터 살펴봐요.` : "";
  return { headline, warning, tiers };
}

function stampText(name) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(name);
  return m ? `${Number(m[2])}월 ${Number(m[3])}일 ${m[4]}:${m[5]}` : name;
}

function lamp(item, r, index, isNew) {
  const [cls, label] = LAMP[r.result];
  const tip = `${label}: ${item.title}`;
  return `<span class="lamp ${item.kind === "안티" ? "warn" : "win"} ${cls}${isNew ? " new" : ""}" style="--k:${index}" tabindex="0" role="img" aria-label="${esc(tip)}" data-tip="${esc(tip)}"></span>`;
}

function itemRow(item, r) {
  const [cls, label] = LAMP[r.result];
  const body = [
    `<p class="why">${rich(item.why)}</p>`,
    ["걸림", "의심", "없음", "일부"].includes(r.result) ? `<p class="how"><b>이렇게 시작</b>${rich(item.firstStep)}</p>` : "",
    r.evidence.length ? `<ul class="ev">${r.evidence.map((e) => `<li>${rich(e)}</li>`).join("")}</ul>` : "",
    r.note ? `<p class="note">${rich(r.note)}</p>` : "",
    `<p class="meta">${esc(JUDGED_BY[r.by] ?? r.by)}${r.scan && r.scan !== r.result ? `(스캔은 ${esc(r.scan)})` : ""}. 기준: ${rich(item.rule)}</p>`,
  ].join("");
  return `<details class="row ${cls}"><summary><span class="lamp ${item.kind === "안티" ? "warn" : "win"} ${cls}"></span><span class="t">${rich(item.title)}</span><span class="lab">${esc(label)}</span></summary><div class="body">${body}</div></details>`;
}

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");
const picture = (name) => `data:image/png;base64,${fs.readFileSync(path.join(ASSETS, `${name}.png`)).toString("base64")}`;

const flagged = (merged, item) => ["걸림", "의심"].includes(merged[item.id].result);

function renderHtml(model) {
  const { facts, checklist, merged, top, cmp, problems, pained, diagnosis } = model;
  const gaps = checklist.items.filter((i) => i.kind === "빈곳");
  const lit = gaps.filter((i) => merged[i.id].result === "있음").length;
  const half = gaps.filter((i) => merged[i.id].result === "일부").length;
  const checkable = gaps.filter((i) => ["있음", "일부", "없음"].includes(merged[i.id].result)).length;
  const areaTitle = (id) => checklist.areas.find((a) => a.id === id)?.title ?? id;
  const newly = new Set(cmp ? cmp.better.map((x) => x.item.id) : []);
  const created = new Date(facts.createdAt);
  const when = `${created.getMonth() + 1}월 ${created.getDate()}일 ${String(created.getHours()).padStart(2, "0")}:${String(created.getMinutes()).padStart(2, "0")}`;
  const tiersBottomUp = [...new Set(checklist.areas.map((a) => a.tier))];
  const floorNo = (tier) => tiersBottomUp.indexOf(tier) + 1;

  const since = cmp ? ` 지난 점검(${esc(stampText(cmp.name))})보다` : "";
  const changed = !cmp ? "" : cmp.better.length && cmp.worse.length
    ? `${since} <b class="up">${cmp.better.length}칸 좋아졌고</b> <b class="down">${cmp.worse.length}칸 나빠졌어요</b>.`
    : cmp.better.length ? `${since} <b class="up">${cmp.better.length}칸 좋아졌어요</b>.`
    : cmp.worse.length ? `${since} <b class="down">${cmp.worse.length}칸 나빠졌어요</b>.` : "";

  // 지도: 창문은 있어야 할 것, 주황·점선 동그라미는 손볼 습관만 그린다. 괜찮은 습관까지 그리면 지도가 시끄러워진다.
  const floors = [...tiersBottomUp]
    .reverse()
    .map((tier) => {
      const f = floorNo(tier) - 1;
      const rooms = checklist.areas
        .filter((a) => a.tier === tier)
        .map((a) => {
          const g = a.items.filter((i) => i.kind === "빈곳");
          const bad = a.items.filter((i) => i.kind === "안티" && flagged(merged, i));
          const score = fill(a.items, merged);
          const litHere = g.filter((i) => merged[i.id].result === "있음").length;
          const hits = bad.filter((i) => merged[i.id].result === "걸림").length;
          let k = 0;
          const lamps = [...g, ...bad].map((i) => lamp(i, merged[i.id], k++, newly.has(i.id))).join("");
          return `<a class="room${score !== null && score >= 0.7 ? " bright" : ""}" href="#z-${a.id}"><span class="rtop"><span class="rname">${esc(a.title)}${pained.includes(a.id) ? `<em>요즘 불편한 곳</em>` : ""}</span><span class="cnt">${litHere}/${g.length}</span></span><span class="lamps">${lamps}</span>${hits ? `<span class="alarm">손볼 곳 ${hits}</span>` : ""}</a>`;
        })
        .join("");
      return `<div class="floor" style="--f:${f}"><div class="rail"><b>${f + 1}층</b><span>${esc(tier)}</span><small>${esc(TIER_TEXT[tier]?.role ?? "")}</small></div><div class="rooms">${rooms}</div></div>`;
    })
    .join("");

  const nextCards = top
    .map((item) => {
      const r = merged[item.id];
      const state = item.kind === "안티" ? `<span class="bad">${r.result === "의심" ? "한번 볼 곳" : "손볼 곳"}</span>` : "";
      return `<li><p class="where"><a href="#z-${item.area}">${esc(areaTitle(item.area))}</a>${state}</p><h3>${rich(item.title)}</h3><p class="why">${rich(item.why)}</p><p class="how"><b>이렇게 시작</b>${rich(item.firstStep)}</p></li>`;
    })
    .join("");

  const areaBlock = (a) => {
    const g = a.items.filter((i) => i.kind === "빈곳");
    const anti = a.items.filter((i) => i.kind === "안티");
    const bad = anti.filter((i) => flagged(merged, i));
    const rest = anti.filter((i) => !flagged(merged, i));
    const litHere = g.filter((i) => merged[i.id].result === "있음").length;
    const restLabel = bad.length ? `나머지 조심할 습관 ${rest.length}가지` : `조심할 습관 ${rest.length}가지는 모두 괜찮아요`;
    return `<section class="area" id="z-${a.id}"><header><h3>${esc(a.title)}</h3><span class="cnt">불 ${litHere}/${g.length}</span></header><p class="role">${esc(a.role)}</p>${g.map((i) => itemRow(i, merged[i.id])).join("")}${bad.map((i) => itemRow(i, merged[i.id])).join("")}${rest.length ? `<details class="rest"><summary>${restLabel}</summary>${rest.map((i) => itemRow(i, merged[i.id])).join("")}</details>` : ""}</section>`;
  };
  const byFloor = tiersBottomUp
    .map((tier) => `<div class="fl"><h4>${floorNo(tier)}층 ${esc(tier)}<span>${esc(TIER_TEXT[tier]?.role ?? "")}</span></h4><div class="areas">${checklist.areas.filter((a) => a.tier === tier).map(areaBlock).join("")}</div></div>`)
    .join("");

  const s = facts.sessions;
  const habitNote = s ? `세션 기록 ${s.sessions}개(최근 30일)에서 내 메시지 ${s.userMessages}개의 개수와 반복만 셌어요.` : "세션 기록은 읽지 않아서 습관 칸은 「확인 못 함」으로 두었어요.";

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light">
<title>하네스 점검 지도 ${esc(facts.repo.name)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
<style>
:root{
  --t1:40px;--t3:24px;--t4:18px;--t5:16px;--t6:14.5px;--t7:13px;--t8:12px;
  --lh-display:1.2;--lh-head:1.4;--lh-body:1.65;
  --bg:#fff;--ink:#191f28;--sub:#4e5968;--muted:#8b95a1;--line:#e5e8eb;--soft:#f6f7f9;
  --lamp:#f5a300;--glow:rgba(245,163,0,.45);--lampink:#a86400;--off:#d1d6db;--hit:#f2784b;--hitink:#c4562c;--doubt:#f5a623;--up:#12a150;
}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:400 var(--t5)/var(--lh-body) "Pretendard Variable",Pretendard,-apple-system,"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;word-break:keep-all;-webkit-font-smoothing:antialiased}
main{max-width:1080px;margin:0 auto;padding:56px 24px 80px}
a{color:inherit;text-decoration:none}
a:focus-visible,.lamp:focus-visible,summary:focus-visible{outline:2px solid var(--lamp);outline-offset:2px;border-radius:4px}
code{font:var(--t7) ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--soft);padding:1px 5px;border-radius:4px}
h1{font-size:var(--t1);line-height:var(--lh-display);letter-spacing:-.02em;font-weight:600;margin:0}
h2{font-size:var(--t3);line-height:var(--lh-head);letter-spacing:-.015em;font-weight:600;margin:0 0 6px}
.who{margin:10px 0 0;color:var(--muted);font-size:var(--t6)}
.hero{display:grid;grid-template-columns:1fr auto;gap:32px;align-items:end}.hero .txt{grid-row:1;grid-column:1}
.art{grid-row:1;grid-column:2;position:relative;width:250px;height:230px}
.art .bldg{position:absolute;right:0;bottom:0;height:220px}
.art .bot{position:absolute;left:0;bottom:0;height:150px;transform-origin:50% 100%;animation:peek 3.6s ease-in-out infinite}
@keyframes peek{0%,100%{transform:translateY(0) rotate(0)}30%{transform:translateY(-6px) rotate(-3deg)}60%{transform:translateY(0) rotate(2deg)}}
.lead{margin:28px 0 0;font-size:var(--t4);line-height:var(--lh-head);max-width:40em}
.lead .alert{color:var(--hitink);font-weight:500}
.count{margin:6px 0 0;color:var(--sub);font-size:var(--t6)}.count .up{color:var(--up);font-weight:500}.count .down{color:var(--hitink);font-weight:500}
.warnbox{margin:8px 0 0;color:var(--doubt);font-size:var(--t7)}
section.sec{margin-top:88px}.sec>.sub{margin:0 0 28px;color:var(--sub);font-size:var(--t6)}

/* 지도 */
.map{margin-top:56px}
.roof{position:relative;height:56px;margin:0 -10px -1.5px}
.roof svg{display:block;width:100%;height:100%}.roof polygon{fill:var(--soft);stroke:var(--ink);stroke-width:1.5px;stroke-linejoin:round}
.chimney{position:absolute;right:11%;top:-14px;width:30px;height:34px;background:var(--soft);border:1.5px solid var(--ink);border-bottom:0;border-radius:3px 3px 0 0}
.building{border:1.5px solid var(--ink);border-bottom:4px solid var(--ink);overflow:visible}
.floor{display:grid;grid-template-columns:150px 1fr}.floor+.floor{border-top:1px solid var(--line)}
.rail{padding:20px 18px;background:var(--soft);display:flex;flex-direction:column;gap:2px}
.rail b{font-size:var(--t7);font-weight:500;color:var(--muted)}.rail span{font-size:var(--t5);font-weight:600}.rail small{font-size:var(--t8);line-height:1.4;color:var(--muted)}
.rooms{display:flex}.room{flex:1;min-width:0;padding:20px 20px 18px;display:flex;flex-direction:column;gap:14px;transition:background .15s}
.room+.room{border-left:1px solid var(--line)}.room:hover{background:var(--soft)}
.room.bright{background:#fffaee}.room.bright:hover{background:#fff4d9}
.rtop{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.rname{font-size:var(--t5);font-weight:600}.rname em{font-style:normal;font-size:var(--t8);font-weight:500;color:var(--doubt);margin-left:8px}
.cnt{font-size:var(--t7);color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.lamps{display:flex;flex-wrap:wrap;gap:7px;align-items:center}
.alarm{font-size:var(--t8);font-weight:500;color:var(--hitink);margin-top:-6px}
.legend{display:flex;flex-wrap:wrap;gap:8px 20px;margin-top:14px;color:var(--muted);font-size:var(--t7);align-items:center}
.legend span{display:inline-flex;align-items:center;gap:7px}.legend .hint{margin-left:auto}

/* 불 하나 = 점검 항목 하나 */
.lamp{position:relative;display:inline-block;flex:none;--o:1;opacity:var(--o)}
.lamp.win{width:18px;height:22px;border-radius:3px;border:1.5px solid var(--off)}
.lamp.win.on{background:var(--lamp);border-color:var(--lamp);box-shadow:0 0 10px var(--glow)}
.lamp.win.half{border-color:var(--lamp);background:linear-gradient(to top,var(--lamp) 50%,transparent 50%)}
.lamp.win.na{border-style:dashed;--o:.6}
.lamp.warn{width:12px;height:12px;border-radius:50%;background:var(--off)}
.lamp.warn.hit{background:var(--hit);box-shadow:0 0 0 3px rgba(242,120,75,.18)}
.lamp.warn.doubt{background:transparent;border:2.5px solid var(--doubt)}
.lamp.warn.na{background:transparent;border:1.5px dashed var(--off)}
.lamp[data-tip]:hover::after,.lamp[data-tip]:focus::after{content:attr(data-tip);position:absolute;left:50%;bottom:calc(100% + 8px);transform:translateX(-50%);width:max-content;max-width:240px;padding:6px 9px;border-radius:6px;background:var(--ink);color:#fff;font-size:var(--t8);line-height:1.4;font-weight:400;z-index:5;pointer-events:none;white-space:normal}

/* 한 번의 움직임: 페이지가 열리면 1층부터 불이 켜진다. 끝나면 완성된 지도로 멈춘다 */
.building .lamp{opacity:.15}
.go .building .lamp{animation:appear .35s ease-out both;animation-delay:calc(var(--f) * 600ms + var(--k) * 55ms)}
.go .building .lamp.win.on,.go .building .lamp.win.half{animation-name:switchon;animation-duration:.6s}
.go .building .lamp.warn.hit{animation-name:alarm;animation-duration:.8s}
.go .building .lamp.new{animation:switchon .6s ease-out both,twinkle 1.2s ease-in-out 3;animation-delay:calc(var(--f) * 600ms + var(--k) * 55ms),calc(var(--f) * 600ms + var(--k) * 55ms + .6s)}
@keyframes appear{from{opacity:.15}to{opacity:var(--o)}}
@keyframes switchon{0%{opacity:.15;box-shadow:none}30%{opacity:.55}40%{opacity:.2}65%{opacity:1;box-shadow:0 0 22px 3px var(--glow)}100%{opacity:1}}
@keyframes alarm{0%{opacity:.15}40%{opacity:1;transform:scale(1.5)}100%{opacity:1;transform:scale(1)}}
@keyframes twinkle{50%{box-shadow:0 0 0 5px rgba(18,161,80,.35),0 0 18px var(--glow)}}
@media (prefers-reduced-motion:reduce){.building .lamp{opacity:var(--o)!important;animation:none!important}.art .bot{animation:none}}

/* 다음에 해 볼 세 가지 */
.next{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,1fr);gap:40px;counter-reset:n}
.next li{counter-increment:n}
.next li::before{content:counter(n);display:block;font-size:var(--t3);font-weight:600;line-height:1;color:var(--lamp);margin-bottom:14px}
.where{display:flex;gap:10px;margin:0 0 6px;font-size:var(--t7);color:var(--muted)}.where a:hover{color:var(--ink)}.where .bad{color:var(--hitink);font-weight:500}
.next h3{font-size:var(--t4);line-height:var(--lh-head);font-weight:600;letter-spacing:-.01em;margin:0 0 10px}
.why{margin:0 0 10px;color:var(--sub);font-size:var(--t6)}
.how{margin:0;font-size:var(--t6)}.how b{font-weight:500;color:var(--lampink);margin-right:8px}

/* 영역별로 보기 */
.fl+.fl{margin-top:64px}
.fl h4{margin:0 0 4px;font-size:var(--t7);font-weight:500;color:var(--muted)}.fl h4 span{margin-left:8px;font-weight:400}
.areas{display:grid;grid-template-columns:1fr 1fr;gap:8px 56px}
.area{padding-top:18px;border-top:1px solid var(--ink);margin-top:12px;scroll-margin-top:24px}
.area header{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.area h3{margin:0;font-size:var(--t4);font-weight:600;letter-spacing:-.01em}
.area .role{margin:2px 0 12px;font-size:var(--t7);color:var(--muted)}
.area:target h3{color:var(--lampink)}
.row summary,.rest summary{list-style:none;cursor:pointer}.row summary::-webkit-details-marker,.rest summary::-webkit-details-marker{display:none}
.row summary{display:flex;gap:12px;align-items:center;padding:7px 10px;margin:0 -10px;border-radius:8px}.row summary:hover{background:var(--soft)}.row summary::after{content:"";flex:none;width:6px;height:6px;margin:0 2px 2px 4px;border-right:1.5px solid var(--muted);border-bottom:1.5px solid var(--muted);transform:rotate(-45deg);transition:transform .15s}.row[open]>summary::after{transform:rotate(45deg)}.row[open]{margin:6px 0 10px}.row[open]>summary{background:var(--soft);border-radius:8px 8px 0 0}.row[open]>summary .t{font-weight:500}
.row .lamp.win{width:13px;height:16px}.row .lamp.warn{width:11px;height:11px}
.row .t{flex:1;font-size:var(--t6);line-height:1.45}.lab{font-size:var(--t7);color:var(--muted);white-space:nowrap}
.row.off .t{color:var(--sub)}.row.hit .t,.row.hit .lab{color:var(--hitink)}.row.doubt .lab{color:var(--doubt)}.row.clean .t,.row.na .t{color:var(--muted)}
.body{margin:0 -10px;padding:2px 14px 14px 35px;background:var(--soft);border-radius:0 0 8px 8px;box-shadow:inset 3px 0 0 var(--lamp)}.body p{margin:4px 0}.body .why{font-size:var(--t6)}.body code{background:#fff}.row.hit .body,.row.doubt .body{box-shadow:inset 3px 0 0 var(--hit)}.row[open]>summary{box-shadow:inset 3px 0 0 var(--lamp)}.row.hit[open]>summary,.row.doubt[open]>summary{box-shadow:inset 3px 0 0 var(--hit)}
.ev{margin:6px 0;padding-left:18px;color:var(--sub);font-size:var(--t7)}.ev li{overflow-wrap:anywhere}
.note{color:var(--sub);font-size:var(--t7)}.meta{color:var(--muted);font-size:var(--t8);margin-top:10px!important;padding-top:8px;border-top:1px solid var(--line)}
.rest{margin-top:6px}.rest>summary{font-size:var(--t7);color:var(--muted);padding:6px 0}.rest>summary::after{content:" 보기";color:var(--sub)}.rest[open]>summary::after{content:" 접기"}
footer{margin-top:88px;padding-top:20px;border-top:1px solid var(--line);font-size:var(--t7);color:var(--muted);max-width:46em}

@media (max-width:820px){
  :root{--t1:30px;--t3:21px;--t4:17px}
  main{padding:36px 16px 64px}
  .hero{grid-template-columns:1fr;gap:12px}.art{grid-column:1;width:170px;height:156px}.art .bldg{height:150px}.art .bot{height:102px}.hero .txt{grid-row:2}
  .roof{height:36px;margin:0 -6px -1.5px}.chimney{width:22px;height:24px;top:-10px}
  .floor{grid-template-columns:1fr}.rail{flex-direction:row;align-items:baseline;gap:8px;padding:12px 16px}
  .rooms{flex-direction:column}.room{padding:14px 16px;gap:10px}.room+.room{border-left:0;border-top:1px solid var(--line)}
  .legend .hint{margin-left:0}
  .next{grid-template-columns:1fr;gap:40px}.areas{grid-template-columns:1fr}
}
</style></head><body><main>
<header class="hero">
<div class="art" aria-hidden="true"><img class="bldg" src="${picture("building")}" alt=""><img class="bot" src="${picture("robot")}" alt=""></div>
<div class="txt">
<h1>하네스 점검 지도</h1>
<p class="who">${esc(facts.repo.name)} 레포, ${esc(when)} 점검</p>
<p class="lead">${esc(diagnosis.headline)}${diagnosis.warning ? ` <span class="alert">${esc(diagnosis.warning)}</span>` : ""}</p>
<p class="count">있어야 할 ${checkable}곳 가운데 ${lit}곳에 불이 켜져 있어요${half ? `, 절반쯤 켜진 곳은 ${half}곳이에요` : ""}.${changed}</p>
${problems.length ? `<p class="warnbox">점검 담당 결과 ${problems.length}개를 쓰지 못했어요: ${esc(problems.slice(0, 2).join(" / "))}</p>` : ""}
</div>
</header>
<div class="map" id="map">
<div class="roof" aria-hidden="true"><svg viewBox="0 0 1000 64" preserveAspectRatio="none"><polygon points="2,63 70,2 930,2 998,63" vector-effect="non-scaling-stroke"/></svg><i class="chimney"></i></div>
<div class="building">${floors}</div>
<div class="legend"><span><i class="lamp win on"></i>하고 있음</span><span><i class="lamp win half"></i>절반쯤</span><span><i class="lamp win off"></i>아직 없음</span><span><i class="lamp warn hit"></i>손볼 곳</span>${checklist.items.some((i) => merged[i.id].result === "의심") ? `<span><i class="lamp warn doubt"></i>한번 볼 곳</span>` : ""}<span class="hint">창문 하나가 점검 항목 하나예요. 칸을 누르면 아래에서 자세히 보여요.</span></div>
</div>
<section class="sec"><h2>다음에 해 볼 세 가지</h2><p class="sub">손볼 곳을 먼저, 그다음 빈 곳을 영역이 겹치지 않게 골랐어요.</p><ol class="next">${nextCards || "<li><h3>지금은 고칠 곳이 보이지 않아요.</h3></li>"}</ol></section>
<section class="sec"><h2>영역별로 보기</h2><p class="sub">줄을 누르면 왜 필요한지, 무엇을 보았는지, 어떻게 시작하는지 열려요.</p>${byFloor}</section>
<footer>${esc(habitNote)} 이 점검은 파일과 설정을 읽기만 했고 아무것도 바꾸지 않았어요. 키와 토큰 값은 적지 않았지만 내부 경로가 들어 있으니 공유하기 전에 확인하세요. 같은 레포에서 다시 점검하면 이번 결과와 비교해요.</footer>
</main>
<script>
(() => {
  const map = document.getElementById("map");
  const go = () => map.classList.add("go");
  if (!("IntersectionObserver" in window)) return go();
  const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { go(); io.disconnect(); } }, { threshold: 0.3 });
  io.observe(map);
})();
</script>
</body></html>`;
}

function renderMarkdown(model) {
  const { facts, checklist, merged, scores, top, diagnosis } = model;
  const areaTitle = (id) => checklist.areas.find((a) => a.id === id)?.title ?? id;
  const lines = [`# 하네스 지도 · ${facts.repo.name}`, "", diagnosis.headline, diagnosis.warning, "", `- 레포: \`${facts.repo.root}\``, `- 만든 때: ${facts.createdAt}`, ""];
  lines.push("| 층 | 영역 | 채움 | 손볼 곳 | 한번 볼 곳 |", "|---|---|---|---|---|");
  for (const a of checklist.areas) lines.push(`| ${a.tier} | ${a.title} | ${pct(scores[a.id].score)} | ${scores[a.id].hits} | ${scores[a.id].doubts} |`);
  lines.push("", "## 다음에 해 볼 세 가지", "");
  top.forEach((item, i) => lines.push(`${i + 1}. **${item.title}** (${areaTitle(item.area)}) - ${item.why}. 이렇게 시작: ${item.firstStep}`));
  lines.push("", "## 손볼 곳", "");
  for (const item of checklist.items.filter((i) => ["걸림", "의심"].includes(merged[i.id].result))) lines.push(`- [${merged[item.id].result}] ${item.title}: ${merged[item.id].evidence.join("; ")}`);
  lines.push("", "## 아직 없는 곳", "");
  for (const item of checklist.items.filter((i) => ["없음", "일부"].includes(merged[i.id].result))) lines.push(`- [${merged[item.id].result}] ${areaTitle(item.area)} · ${item.title}`);
  return `${lines.join("\n")}\n`;
}

export function buildReport(out) {
  const checklist = loadChecklist();
  const facts = readJson(path.join(out, "facts.json"), "스캔 결과");
  const partsFile = path.join(out, "parts.json");
  const parts = fs.existsSync(partsFile) ? readJson(partsFile, "점검 담당 결과") : {};
  const { merged, problems } = merge(checklist, facts, parts);
  const scores = areaScores(checklist, merged);
  const overall = fill(checklist.items, merged);
  const diagnosis = diagnose(checklist, merged);
  const top = pickTop(checklist, merged, facts.answers.pain);
  const pained = painAreas(facts.answers.pain);
  const cmp = compare(checklist, merged, findPrevious(out, facts.configDir));
  const model = { facts, checklist, merged, scores, overall, top, cmp, problems, pained, diagnosis };
  fs.writeFileSync(path.join(out, "merged.json"), JSON.stringify({ createdAt: facts.createdAt, overall, tiers: diagnosis.tiers, scores, results: merged, problems }, null, 2));
  fs.writeFileSync(path.join(out, "report.html"), renderHtml(model));
  fs.writeFileSync(path.join(out, "report.md"), renderMarkdown(model));
  return { model, html: path.join(out, "report.html"), md: path.join(out, "report.md") };
}

/** 기본 브라우저로 보고서를 연다. 열지 못해도 보고서는 이미 저장돼 있으므로 false만 돌려준다. */
function openInBrowser(file) {
  const [command, args] = process.platform === "darwin" ? ["open", [file]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", file]] : ["xdg-open", [file]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`report.mjs: ${error.message}\n`);
    process.exit(2);
  }
  const { model, html, md } = buildReport(args.out);
  const { checklist, merged, scores, overall, top, problems, cmp, diagnosis } = model;
  const title = (id) => checklist.areas.find((a) => a.id === id)?.title ?? id;
  const gaps = checklist.items.filter((i) => i.kind === "빈곳");
  process.stdout.write(
    `${JSON.stringify({
      html,
      md,
      headline: diagnosis.headline,
      warning: diagnosis.warning,
      lit: `${gaps.filter((i) => merged[i.id].result === "있음").length}/${gaps.filter((i) => ["있음", "일부", "없음"].includes(merged[i.id].result)).length}`,
      overall: pct(overall),
      tiers: Object.fromEntries(diagnosis.tiers.map((t) => [t.tier, pct(t.score)])),
      areas: Object.fromEntries(Object.entries(scores).map(([a, s]) => [title(a), { 채움: pct(s.score), 손볼곳: s.hits, 한번볼곳: s.doubts }])),
      top: top.map((i) => ({ id: i.id, area: title(i.area), title: i.title, why: i.why, firstStep: i.firstStep })),
      compared: cmp ? { with: cmp.name, before: pct(cmp.overall), after: pct(overall), better: cmp.better.length, worse: cmp.worse.length } : null,
      opened: args.open ? openInBrowser(html) : false,
      problems,
    })}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
