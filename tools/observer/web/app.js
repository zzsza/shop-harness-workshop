// 세션 뷰어 화면. 빌드 없이 브라우저가 바로 읽는다.
// 서버(tools/observer/src/server.ts)의 JSON API를 읽고, /events(SSE)로 기록이 바뀌었다는 알림을 받으면 그 부분만 다시 읽는다.
// --export로 만든 파일에서는 window.OBSERVER_SNAPSHOT에 미리 담긴 자료를 쓴다.
/* global window, document, fetch, EventSource */

const snapshot = window.OBSERVER_SNAPSHOT ?? null;
const app = document.getElementById("app");
const live = document.getElementById("live");

const REASONS = {
  session_start: "세션 시작",
  nested_traversal: "하위 폴더 진입",
  path_glob_match: "경로 규칙 일치",
  include: "@ 가져오기",
  compact: "압축 뒤 다시 읽음",
};

const state = {
  sessions: null,
  configDir: "",
  selectedId: null,
  /** 사람이 세션을 고르기 전에는 가장 최근 세션을 따라간다. */
  followLatest: true,
  detail: null,
  compare: null,
  parentDetail: null,
  selectedRequest: null,
  instructions: null,
  loadError: null,
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

async function api(path) {
  if (snapshot !== null) {
    if (path in snapshot.responses) return snapshot.responses[path];
    throw new Error("내보낸 기록에 없는 자료예요");
  }
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path} ${response.status}`);
  return response.json();
}

const shortId = (id) => id.slice(0, 6);
const pad = (n) => String(n).padStart(2, "0");
function clock(iso) {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function day(iso) {
  const d = new Date(iso);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function tokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
function seconds(ms) {
  return ms === null ? "" : `${(ms / 1000).toFixed(1)}초`;
}
function toolNames(request) {
  if (request === undefined) return "없음";
  if (request.tools.length === 0) return request.reply ? "응답" : "도구 없음";
  const counts = new Map();
  for (const tool of request.tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  return [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(" · ");
}

// ── 자료 읽기 ─────────────────────────────────────────

async function loadSessions() {
  const body = await api("/api/sessions");
  state.sessions = body.sessions;
  state.configDir = body.configDir;
  const ids = new Set(state.sessions.map((session) => session.id));
  if (state.selectedId !== null && !ids.has(state.selectedId)) {
    state.selectedId = null;
    state.followLatest = true;
  }
  if (state.followLatest) state.selectedId = state.sessions[0]?.id ?? null;
}

async function loadSelected() {
  state.detail = null;
  state.compare = null;
  state.parentDetail = null;
  state.instructions = null;
  const id = state.selectedId;
  if (id === null) return;
  const summary = state.sessions.find((session) => session.id === id);
  const [detail, instructions, compare] = await Promise.all([
    api(`/api/sessions/${id}`),
    api(`/api/sessions/${id}/instructions`),
    summary?.branch ? api(`/api/sessions/${id}/compare`) : Promise.resolve(null),
  ]);
  if (state.selectedId !== id) return;
  state.detail = detail;
  state.instructions = instructions;
  state.compare = compare;
  const last = detail.requests.at(-1);
  if (state.selectedRequest === null || !detail.requests.some((request) => request.index === state.selectedRequest) || state.followLatest) {
    state.selectedRequest = last?.index ?? null;
  }
}

async function refreshAll() {
  try {
    await loadSessions();
    await loadSelected();
    state.loadError = null;
  } catch (error) {
    state.loadError = error.message;
  }
  render();
}

// ── 세션 탭 ───────────────────────────────────────────

function emptySessions() {
  return `<section class="panel empty">
    <h2>아직 세션이 없어요</h2>
    <p>실습 설정 폴더에서 이 레포의 세션 기록을 찾지 못했어요. 아래 명령으로 Claude Code를 띄우면 요청이 생기는 대로 여기에 나타나요.</p>
    <code class="command">npm run claude</code>
    <div class="actions"><span class="muted mono">찾는 곳 · ${escapeHtml(state.configDir)}</span></div>
  </section>`;
}

function sessionList() {
  const children = new Map();
  for (const session of state.sessions) {
    if (session.branch === null) continue;
    const list = children.get(session.branch.parentId) ?? [];
    list.push(session);
    children.set(session.branch.parentId, list);
  }
  const known = new Set(state.sessions.map((session) => session.id));
  const item = (session, depth) => {
    const branchTag = session.branch === null ? "" : `<span class="badge tag">${session.branch.kind === "branch" ? "/branch" : "fork"}</span>`;
    const parentTag = children.has(session.id) ? '<span class="badge tag">원본</span>' : "";
    const fork = session.branch === null ? "" : `<span class="meta">요청 ${session.branch.sharedRequests} 뒤에서 갈라짐</span>`;
    const unreadable = session.unreadableCount > 0 ? ` · <span class="badge warn">읽지 못한 줄 ${session.unreadableCount}</span>` : "";
    const rows = [
      `<li><button type="button" class="session-item${depth > 0 ? " child" : ""}" data-session="${escapeHtml(session.id)}" aria-current="${session.id === state.selectedId}">
        <span class="id">${escapeHtml(shortId(session.id))}</span>${parentTag}${branchTag}
        <span class="meta">${session.updatedAt ? `마지막 ${day(session.updatedAt)}` : "시각 없음"} · 요청 ${session.requestCount}${unreadable}</span>${fork}
      </button></li>`,
    ];
    for (const child of children.get(session.id) ?? []) rows.push(item(child, depth + 1));
    return rows.join("");
  };
  const roots = state.sessions.filter((session) => session.branch === null || !known.has(session.branch.parentId));
  return `<ul class="panel sessions">${roots.map((session) => item(session, 0)).join("")}</ul>`;
}

/** 토큰 막대. 마우스를 올리거나 키보드로 고르면 종류별 토큰 수와 비율이 뜬다. */
function bar(request, max) {
  const scale = (n) => `${(n / max) * 100}%`;
  const t = request.tokens;
  const share = (n) => (request.total === 0 ? "0%" : `${((n / request.total) * 100).toFixed(n / request.total < 0.1 ? 1 : 0)}%`);
  const row = (kind, label, n) => `<span class="tip-row"><i class="${kind}"></i><span>${label}</span><b class="num">${n.toLocaleString()}</b><em class="num">${share(n)}</em></span>`;
  return `<div class="bar-wrap" tabindex="0" aria-label="토큰 ${request.total.toLocaleString()}">
    <div class="bar" style="width:${scale(request.total)}">
      <span class="input" style="flex:${t.input}"></span><span class="cache-write" style="flex:${t.cacheWrite}"></span><span class="cache-read" style="flex:${t.cacheRead}"></span><span class="output" style="flex:${t.output}"></span>
    </div>
    <div class="tip" role="tooltip">
      ${row("input", "새 입력", t.input)}${row("cache-write", "캐시 쓰기", t.cacheWrite)}${row("cache-read", "캐시 읽기", t.cacheRead)}${row("output", "출력", t.output)}
      <span class="tip-row total"><span></span><span>합계</span><b class="num">${request.total.toLocaleString()}</b><em></em></span>
    </div>
  </div>`;
}

const LEGEND = `<div class="legend end">
  <span><i style="background:var(--bar-input)"></i>새 입력</span>
  <span><i style="background:var(--bar-cache-write)"></i>캐시 쓰기</span>
  <span><i style="background:var(--bar-cache-read)"></i>캐시 읽기</span>
  <span><i style="background:var(--bar-output);outline:1px solid var(--color-ink);outline-offset:-1px"></i>출력</span>
</div>`;

/** 지침 읽기 기록이 있으면 요청 번호별로, 그 요청 바로 전에 새로 읽힌 지침을 모은다. 요청 N 전에 읽힌 지침은 요청 N에 함께 실려 간다. */
function loadsByRequest() {
  const map = new Map();
  if (state.instructions === null || state.instructions.status !== "ok") return map;
  for (const file of state.instructions.files) {
    for (const load of file.loads) {
      const index = load.afterRequest + 1;
      const list = map.get(index) ?? [];
      list.push({ file, load });
      map.set(index, list);
    }
  }
  return map;
}

const HOOK_OUTCOME = { ok: "통과", blocked: "막음", error: "오류" };

/** Hook이 언제 돌았는지를 쉬운 말로. name은 "이벤트:대상"(예: PreToolUse:Edit, SessionStart:startup). */
const HOOK_WHEN = {
  SessionStart: () => "세션을 열 때",
  UserPromptSubmit: () => "요청을 보낼 때",
  PreToolUse: (target) => `${target} 하기 전`,
  PostToolUse: (target) => `${target} 한 뒤`,
  PostToolUseFailure: (target) => `${target} 실패한 뒤`,
  PermissionRequest: (target) => `${target} 권한을 물을 때`,
  Stop: () => "답을 끝낼 때",
  SubagentStart: () => "서브에이전트를 띄울 때",
  SubagentStop: () => "서브에이전트가 끝날 때",
  PreCompact: () => "대화를 압축하기 전",
  Setup: () => "설정할 때",
};

/** 표준 출력이 Claude의 맥락에 들어가는 이벤트. 나머지는 막을 때만 Claude에게 글이 간다. */
const HOOK_TO_CONTEXT = new Set(["SessionStart", "UserPromptSubmit"]);

function hookWhen(hook) {
  const target = hook.name.slice(hook.event.length + 1);
  return HOOK_WHEN[hook.event]?.(target) ?? hook.name;
}

/** 명령에서 실행하는 스크립트 파일 이름만 뽑는다(예: protect-migrations.mjs). 못 찾으면 명령 전체. */
function hookScript(hook) {
  if (!hook.command) return "";
  return hook.command.match(/[\w.-]+\.(?:mjs|cjs|js|ts|sh|py|ps1)\b/g)?.at(-1) ?? hook.command;
}

function hookChip(request) {
  if (request.hooks.length === 0) return "";
  const counts = new Map();
  for (const hook of request.hooks) {
    const blocked = hook.outcome !== "ok";
    const label = blocked ? `${hook.name.slice(hook.event.length + 1) || hook.event} ${HOOK_OUTCOME[hook.outcome]}` : hookWhen(hook);
    const key = `${blocked}|${label}`;
    counts.set(key, { blocked, label, count: (counts.get(key)?.count ?? 0) + 1 });
  }
  const title = request.hooks.map((hook) => `${hookWhen(hook)} · ${hookScript(hook)} · ${HOOK_OUTCOME[hook.outcome]}`).join("\n");
  const chips = [...counts.values()].map(({ blocked, label, count }) => `<span class="badge ${blocked ? "danger" : "hook"}">${escapeHtml(label)}${count > 1 ? ` ×${count}` : ""}</span>`);
  return `<span class="hook-chips" title="${escapeHtml(title)}">${chips.join("")}</span>`;
}

function requestRow(request, max, loads) {
  const selected = request.index === state.selectedRequest;
  // 질문(사람이 보낸 메시지)과 응답(도구 없이 Claude가 쓴 답)을 줄로 나눠 보인다. 둘 다 없으면 도구를 부르며 이어서 진행한 요청이다.
  const lines = [];
  if (request.prompt) lines.push(`<span class="msg q"><b>질문</b>${escapeHtml(request.prompt)}</span>`);
  if (request.reply && request.tools.length === 0) lines.push(`<span class="msg a"><b>응답</b>${escapeHtml(request.reply)}</span>`);
  else if (request.reply) lines.push(`<span class="msg note">${escapeHtml(request.reply)}</span>`);
  const prompt = lines.length === 0 ? '<span class="muted">이어서 진행</span>' : lines.join("");
  const chips = loads === undefined ? "" : `<span class="badge read" title="이 요청부터 새로 들어간 지침&#10;${escapeHtml(loads.map(({ file }) => file.path).join("\n"))}">+지침 ${loads.length}</span>`;
  const answer = request.reply && request.tools.length === 0;
  return `<tr class="request${request.prompt ? " turn" : ""}${answer ? " answer" : ""}" data-request="${request.index}" aria-selected="${selected}">
    <td class="col-index num">${request.index}</td>
    <td class="col-time num">${clock(request.at)}</td>
    <td class="prompt-cell">${prompt}</td>
    <td class="col-bar">${bar(request, max)}</td>
    <td class="col-total right num">${tokens(request.total)}</td>
    <td class="tools-cell">${answer ? '<span class="badge answer">응답</span>' : escapeHtml(toolNames(request))}</td>
    <td class="col-instr">${chips}</td>
    <td class="col-hook">${hookChip(request)}</td>
  </tr>`;
}

function requestTable(detail) {
  const max = Math.max(1, ...detail.requests.map((request) => request.total));
  const loads = loadsByRequest();
  const gapsAfter = new Map();
  for (const problem of detail.unreadable) {
    const list = gapsAfter.get(problem.afterRequest) ?? [];
    list.push(problem.line);
    gapsAfter.set(problem.afterRequest, list);
  }
  const gapRow = (after) => {
    const lines = gapsAfter.get(after);
    if (lines === undefined) return "";
    return `<tr class="gap"><td colspan="8">줄 ${lines.join(" · ")} 읽지 못했어요 · 이 줄의 토큰은 합계에 없어요</td></tr>`;
  };
  const rows = [gapRow(0)];
  for (const request of detail.requests) rows.push(requestRow(request, max, loads.get(request.index)), gapRow(request.index));
  const body = detail.requests.length === 0 ? '<tr class="missing"><td colspan="8">아직 요청이 없어요. Claude Code에 첫 요청을 보내면 여기에 나타나요.</td></tr>' : rows.join("");
  return `<table class="panel requests">
    <thead><tr><th>#</th><th>시각</th><th>메시지</th><th>토큰</th><th class="right">합계</th><th>도구 호출</th><th>새 지침</th><th>Hook</th></tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function loadLine(file, load) {
  const why = REASONS[load.reason] ?? "알 수 없는 이유";
  const trigger = load.trigger ? ` · <span class="mono">${escapeHtml(load.trigger)}</span> 때문에` : "";
  return `<li><span class="name mono">${escapeHtml(file.path)}</span><span class="what">${escapeHtml(why)}${trigger}</span></li>`;
}

function requestPanel(detail) {
  const request = detail.requests.find((candidate) => candidate.index === state.selectedRequest);
  if (request === undefined) return "";
  const running = request.tools.some((tool) => tool.status === "running");
  const prompt = request.prompt ? `<div class="side-sub">질문</div><p class="side-prompt">${escapeHtml(request.prompt)}</p>` : "";
  const reply = request.reply ? `<div class="side-sub">${request.tools.length === 0 ? "응답" : "Claude가 쓴 글"}</div><p class="side-prompt">${escapeHtml(request.reply)}</p>` : "";
  const loads = loadsByRequest().get(request.index) ?? [];
  const loaded =
    loads.length === 0
      ? ""
      : `<div class="side-sub">이 요청 전에 새로 읽힌 지침 ${loads.length}개</div><ul class="loads">${loads.map(({ file, load }) => loadLine(file, load)).join("")}</ul>`;
  const steps = flowSteps(request);
  const title = request.hooks.length === 0 ? "도구 호출 흐름" : "도구 호출과 Hook, 일어난 순서";
  return `<section class="panel">
    <div class="side-head"><span>요청 ${request.index} · ${clock(request.at)}</span>${running ? '<span class="badge running">진행 중</span>' : ""}</div>
    ${prompt}${reply}${loaded}
    <div class="side-sub">${title}</div>
    ${steps.length === 0 ? '<p class="side-empty">이 요청은 도구를 부르지 않았어요.</p>' : `<ol class="flow">${steps.map(flowStep).join("")}</ol>`}
  </section>`;
}

/** 도구 호출과 Hook 실행을 시각 순서로 한 줄에 놓는다. 도구를 막은 Hook은 따로 두지 않고 그 도구 칸 안에 붙인다. */
function flowSteps(request) {
  const used = new Set();
  const steps = request.tools.map((tool) => {
    const hook = tool.blockedBy ? (request.hooks.find((candidate) => !used.has(candidate) && candidate.outcome === "blocked" && candidate.name === tool.blockedBy) ?? null) : null;
    if (hook !== null) used.add(hook);
    return { at: tool.startedAt, tool, hook };
  });
  for (const hook of request.hooks) if (!used.has(hook)) steps.push({ at: hook.at, tool: null, hook });
  return steps.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function hookMessage(hook) {
  if (!hook.output) return "";
  const label = hook.outcome === "blocked" ? "Claude가 받은 말" : HOOK_TO_CONTEXT.has(hook.event) ? "Claude에게 넘긴 내용" : "Hook이 낸 글";
  return `<div class="hook-out"><span>${label}</span><p>${escapeHtml(hook.output)}</p></div>`;
}

function hookSource(hook) {
  const script = hookScript(hook);
  return script ? ` · <code title="${escapeHtml(hook.command)}">${escapeHtml(script)}</code>` : "";
}

function flowStep({ tool, hook }) {
  if (tool === null) {
    const took = hook.durationMs === null ? "" : ` · ${seconds(hook.durationMs)}`;
    return `<li class="hook-step" data-outcome="${hook.outcome}">
      <span class="name">Hook</span><span class="badge ${hook.outcome === "ok" ? "hook" : "danger"}">${HOOK_OUTCOME[hook.outcome]}${took}</span>
      <span class="what">${escapeHtml(hookWhen(hook))}${hookSource(hook)}</span>
      ${hookMessage(hook)}
    </li>`;
  }
  const status = tool.blockedBy ? "blocked" : tool.status;
  const took = tool.blockedBy ? "실행 안 됨" : tool.status === "running" ? "진행 중" : tool.status === "error" ? `실패 · ${seconds(tool.durationMs)}` : seconds(tool.durationMs);
  const block =
    hook === null
      ? ""
      : `<div class="hook-block">
          <span class="head"><span class="badge danger">Hook이 막음</span>${escapeHtml(hookWhen(hook))}${hookSource(hook)}</span>
          ${hookMessage(hook)}
        </div>`;
  return `<li data-status="${status}">
    <span class="name">${escapeHtml(tool.name)}</span>
    <span class="took num">${took}</span>
    <span class="what">${escapeHtml(tool.summary)}</span>
    ${block}
  </li>`;
}

function unreadablePanel(detail) {
  if (detail.unreadable.length === 0) return "";
  const items = detail.unreadable
    .map(
      (problem) => `<li><span class="where num">${problem.line}</span><strong>${problem.afterRequest === 0 ? "첫 요청 전" : `요청 ${problem.afterRequest} 뒤`}</strong>
        <span class="why">${escapeHtml(problem.reason)}</span></li>`,
    )
    .join("");
  return `<section class="panel">
    <div class="side-head"><span>읽지 못한 기록 줄 ${detail.unreadable.length}개 <span class="muted">· ${detail.lineCount}줄 중</span></span></div>
    <ul class="problems">${items}</ul>
  </section>`;
}

function sessionView(detail) {
  const warn = detail.unreadable.length > 0 ? `<span class="badge warn">읽지 못한 기록 줄 ${detail.unreadable.length}개</span>` : "";
  return `<div class="heading"><strong>세션 ${escapeHtml(shortId(detail.id))}</strong>
      <span>${detail.startedAt ? `${day(detail.startedAt)} 시작` : ""} · 요청 ${detail.requests.length}개</span>${warn}${LEGEND}</div>
    <div class="with-side">${requestTable(detail)}<div class="side">${requestPanel(detail)}${instructionPanel()}${unreadablePanel(detail)}</div></div>`;
}

function compareCard(id, label, rest, compare, max) {
  const rows = [];
  if (compare.sharedRequests > 0) rows.push(`<tr class="same"><td colspan="4">요청 1–${compare.sharedRequests} 두 세션이 같아요</td></tr>`);
  const length = Math.max(compare.parentRest.length, compare.childRest.length);
  for (let i = 0; i < length; i += 1) {
    const request = rest[i];
    const index = compare.sharedRequests + i + 1;
    if (request === undefined) rows.push(`<tr class="missing"><td colspan="4">요청 ${index} 없음</td></tr>`);
    else
      rows.push(`<tr class="request" aria-selected="${i === 0}"><td class="col-index num">${request.index}</td><td class="col-time num">${clock(request.at)}</td><td>${bar(request, max)}</td><td class="col-total right num">${tokens(request.total)}</td></tr>`);
  }
  if (length === 0) rows.push('<tr class="missing"><td colspan="4">갈라진 뒤 요청이 아직 없어요</td></tr>');
  return `<section class="panel"><div class="card-head">${escapeHtml(shortId(id))} <span class="badge tag">${label}</span></div><table><tbody>${rows.join("")}</tbody></table></section>`;
}

function compareView(compare) {
  const all = [...compare.parentRest, ...compare.childRest];
  const max = Math.max(1, ...all.map((request) => request.total));
  const first = compare.sharedRequests + 1;
  const kind = compare.kind === "branch" ? "/branch" : "fork";
  const diff =
    compare.parentRest.length === 0 && compare.childRest.length === 0
      ? "갈라진 뒤 두 세션 모두 요청이 아직 없어요"
      : `요청 ${first}에서 처음 달라졌어요 · 원본은 ${escapeHtml(toolNames(compare.parentRest[0]))}, 분기는 ${escapeHtml(toolNames(compare.childRest[0]))}`;
  return `<div class="heading"><strong>${escapeHtml(shortId(compare.parentId))} 와 ${escapeHtml(shortId(compare.childId))} 비교</strong><span>· 갈라진 지점부터</span></div>
    <div class="compare">${compareCard(compare.parentId, "원본", compare.parentRest, compare, max)}${compareCard(compare.childId, kind, compare.childRest, compare, max)}</div>
    <p class="first-diff">${diff}</p>`;
}

function sessionTab() {
  if (state.sessions.length === 0) return emptySessions();
  let main = "";
  if (state.compare !== null) main = compareView(state.compare);
  else if (state.detail !== null) main = sessionView(state.detail);
  return `<div class="split">${sessionList()}<div>${main}</div></div>`;
}

// ── 지침 지도(세션 화면 오른쪽) ──────────────────────

function buildTree(files) {
  const root = { name: "", folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    const name = parts.pop();
    let node = root;
    for (const part of parts) {
      if (!node.folders.has(part)) node.folders.set(part, { name: part, folders: new Map(), files: [] });
      node = node.folders.get(part);
    }
    node.files.push({ ...file, name });
  }
  return root;
}

function mapRows(node, depth, selectedLoads) {
  const rows = [];
  const indent = `style="padding-left:${12 + depth * 16}px"`;
  for (const file of node.files) {
    const read = file.loads.length > 0;
    const current = selectedLoads.has(file.path);
    const chips = file.loads
      .map((load) => `<button type="button" class="req-chip" data-request="${load.afterRequest + 1}" aria-pressed="${load.afterRequest + 1 === state.selectedRequest}" title="${escapeHtml(REASONS[load.reason] ?? load.reason)}${load.trigger ? ` · ${escapeHtml(load.trigger)}` : ""}">${load.afterRequest === 0 ? "처음부터" : `요청 ${load.afterRequest + 1}부터`}</button>`)
      .join("");
    rows.push(`<li class="map-file${read ? "" : " unread"}${current ? " current" : ""}" ${indent}>
      <span class="icon"></span><span class="map-name">${escapeHtml(file.name)}</span>
      <span class="map-state">${read ? chips : '<span class="badge unread">안 읽힘</span>'}</span>
    </li>`);
  }
  for (const folder of [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    rows.push(`<li class="map-folder" ${indent}><span class="icon"></span>${escapeHtml(folder.name)}/</li>`, ...mapRows(folder, depth + 1, selectedLoads));
  }
  return rows;
}

function instructionPanel() {
  const map = state.instructions;
  if (map === null) return "";
  if (map.status === "missing") {
    return `<section class="panel"><div class="side-head"><span>지침 지도</span></div>
      <p class="side-empty">이 세션에는 지침 읽기 기록이 없어요. npm run claude로 시작하면 기록돼요.</p></section>`;
  }
  const inside = map.files.filter((file) => file.insideRepo);
  const outside = map.files.filter((file) => !file.insideRepo);
  const loaded = map.files.filter((file) => file.loads.length > 0).length;
  const selectedLoads = new Set((loadsByRequest().get(state.selectedRequest) ?? []).map(({ file }) => file.path));
  const rows = [`<li class="map-folder"><span class="icon"></span>${escapeHtml(map.repoName)}/</li>`, ...mapRows(buildTree(inside), 1, selectedLoads)];
  if (outside.length > 0) {
    rows.push('<li class="map-folder"><span class="icon"></span>레포 밖</li>');
    rows.push(...mapRows({ folders: new Map(), files: outside.map((file) => ({ ...file, name: file.path })) }, 1, selectedLoads));
  }
  const warn = map.unreadable.length > 0 ? ` · <span class="badge warn">읽지 못한 기록 줄 ${map.unreadable.length}개</span>` : "";
  return `<section class="panel">
    <div class="side-head"><span>지침 지도 <span class="muted">· 읽힘 ${loaded} · 안 읽힘 ${map.files.length - loaded}</span>${warn}</span></div>
    <ul class="map">${rows.join("")}</ul>
  </section>`;
}

// ── 그리기와 이벤트 ───────────────────────────────────

function render() {
  if (state.loadError !== null) {
    app.innerHTML = `<section class="panel empty"><h2>기록을 읽지 못했어요</h2><p>${escapeHtml(state.loadError)}</p><p>뷰어 터미널의 오류를 확인하고 npm run viewer를 다시 실행하세요.</p></section>`;
    return;
  }
  if (state.sessions === null) {
    app.innerHTML = '<p class="muted">불러오는 중…</p>';
    return;
  }
  app.innerHTML = sessionTab();
}

document.addEventListener("click", (event) => {
  const target = event.target instanceof window.Element ? event.target : null;
  if (target === null) return;
  const session = target.closest("[data-session]");
  if (session !== null) {
    state.selectedId = session.dataset.session;
    state.followLatest = state.selectedId === state.sessions[0]?.id;
    state.selectedRequest = null;
    void loadSelected().then(render);
    return;
  }
  const request = target.closest("[data-request]");
  if (request !== null) {
    state.selectedRequest = Number(request.dataset.request);
    render();
    return;
  }
});

function connect() {
  const events = new EventSource("/events");
  events.addEventListener("open", () => {
    live.hidden = false;
    live.dataset.state = "on";
    live.textContent = "실시간";
    void refreshAll();
  });
  events.addEventListener("error", () => {
    live.hidden = false;
    live.dataset.state = "off";
    live.textContent = "연결 끊김 · 뷰어를 다시 실행하세요";
  });
  events.addEventListener("change", (event) => {
    const ids = JSON.parse(event.data).ids;
    void (async () => {
      try {
        await loadSessions();
        if (state.followLatest || ids.includes(state.selectedId)) await loadSelected();
        state.loadError = null;
      } catch (error) {
        state.loadError = error.message;
      }
      render();
    })();
  });
}

render();
if (snapshot === null) connect();
else void refreshAll();
