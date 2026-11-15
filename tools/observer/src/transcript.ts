// Claude Code 세션 기록(JSONL) 한 파일을 읽어 요청·도구 호출·읽지 못한 줄로 바꾼다.
// 기록 형식은 Claude Code 내부 형식이라 버전마다 바뀔 수 있다. 이 파일이 쓰는 줄의 모양을 알아보지 못하면
// 건너뛰지 않고 읽지 못한 줄(줄 번호·이유)로 남긴다.
//
// 요청 하나 = API 응답 하나 = message.id 하나. Claude Code는 응답의 내용 블록(thinking·text·tool_use)마다
// 줄을 따로 쓰고 각 줄에 같은 usage를 싣기 때문에, 같은 message.id는 한 번만 센다.

export interface TokenUsage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export type ToolStatus = "running" | "done" | "error";

export interface ToolCall {
  id: string;
  name: string;
  summary: string;
  startedAt: string;
  durationMs: number | null;
  status: ToolStatus;
  /** 이 도구 호출을 Hook이 막았으면 그 Hook 이름(예: PreToolUse:Edit). */
  blockedBy: string | null;
}

export type HookOutcome = "ok" | "blocked" | "error";

/**
 * 기록에 남은 Hook 실행. Claude Code는 출력을 남긴 Hook(예: SessionStart가 알려 준 글)과 도구 호출을 막은 Hook만 기록한다.
 * 아무 출력 없이 통과한 Hook은 기록에 없어서 여기에도 없다.
 */
export interface HookRun {
  at: string;
  /** Hook 이벤트(SessionStart·PreToolUse 등). */
  event: string;
  /** 이벤트와 대상(예: SessionStart:startup, PreToolUse:Edit). */
  name: string;
  command: string | null;
  outcome: HookOutcome;
  durationMs: number | null;
  /** Hook이 낸 글(앞 TEXT_MAX자). */
  output: string | null;
}

export interface Request {
  index: number;
  messageId: string;
  at: string;
  /** 이 요청을 시작하게 한 사람의 메시지(앞 TEXT_MAX자). 도구 결과에 이어지는 요청이면 null. */
  prompt: string | null;
  /** 이 요청에서 Claude가 쓴 글(앞 TEXT_MAX자). 도구만 부르고 글이 없으면 null. */
  reply: string | null;
  /** 이 요청 앞뒤로 기록에 남은 Hook 실행. 세션 시작·프롬프트 Hook은 다음 요청에, 도구 Hook은 그 도구를 부른 요청에 붙는다. */
  hooks: HookRun[];
  tokens: TokenUsage;
  total: number;
  tools: ToolCall[];
}

export interface UnreadableLine {
  line: number;
  afterRequest: number;
  reason: string;
}

/** 다른 세션에서 복사해 온 줄(/branch는 forkedFrom을, --fork-session은 같은 uuid를 남긴다)을 알아보는 데 쓴다. */
export interface SessionTranscript {
  lineCount: number;
  startedAt: string | null;
  updatedAt: string | null;
  requests: Request[];
  unreadable: UnreadableLine[];
  /** 대화 줄(user·assistant·system 등)의 uuid. 갈라진 세션은 원본의 uuid를 그대로 복사한다. */
  uuids: string[];
  /** /branch가 남긴 원본 세션 id. 없으면 null. */
  forkedFromSessionId: string | null;
  /** 시각이 있는 줄마다 uuid(없으면 null)와 시각. 갈라진 세션에서 어느 쪽이 먼저 시작했는지 가릴 때 쓴다. */
  stamps: { uuid: string | null; timestamp: string }[];
}

const UNREADABLE = {
  json: "JSON으로 읽을 수 없어요",
  shape: "알 수 없는 줄 형식이에요",
  usage: "토큰 정보가 없는 응답 줄이에요",
} as const;

type Json = Record<string, unknown>;

/** 요청이 나가기 전에 도는 Hook 이벤트. 이 Hook의 실행은 다음 요청에 붙인다. */
const BEFORE_REQUEST_EVENTS: ReadonlySet<string> = new Set(["SessionStart", "UserPromptSubmit", "Setup"]);

/** 도구 결과 글이 "PreToolUse:Edit hook error: [명령]: 메시지" 모양이면 그 도구를 막은 Hook 실행으로 읽는다. */
function blockingHook(content: unknown, at: string): HookRun | null {
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (isObject(part) && typeof part.text === "string" ? part.text : "")).join("\n") : "";
  const match = /^(?:Error: )?(\w+):(\S+) hook error: \[([\s\S]+?)\]: ([\s\S]*)$/.exec(text.trim());
  if (match === null) return null;
  const [, event = "", target = "", command = "", message = ""] = match;
  return { at, event, name: `${event}:${target}`, command, outcome: "blocked", durationMs: null, output: clip(message) };
}

/** 화면에 싣는 메시지·응답 길이 상한. 긴 붙여넣기나 긴 답도 알아볼 만큼만 남긴다. */
export const TEXT_MAX = 600;

function clip(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  return trimmed.length > TEXT_MAX ? `${trimmed.slice(0, TEXT_MAX - 1)}…` : trimmed;
}

/**
 * 사람이 보낸 메시지 글자. 슬래시 명령은 명령 이름만 남기고, 명령 출력·안내처럼 사람이 쓰지 않은 줄은 null.
 * 이미지와 함께 보낸 메시지처럼 블록 배열이면 text 블록을 잇는다(도구 결과가 섞이면 사람 메시지가 아니다).
 */
function promptText(record: Json, content: unknown): string | null {
  if (record.isMeta === true) return null;
  let text: string;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content) && content.every((block) => isObject(block) && block.type !== "tool_result")) {
    text = content.flatMap((block) => (isObject(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("\n");
  } else return null;
  const command = /<command-name>([^<]+)<\/command-name>/.exec(text);
  if (command !== null) return command[1]?.trim() ?? null;
  if (/^\s*<(local-command-|system-reminder|bash-)/.test(text)) return null;
  // 터미널이 붙여넣기를 감싼 태그(<pasted_content id="…">)는 빼고 안의 글만 남긴다.
  return clip(text.replace(/<\/?pasted_content[^>]*>/g, ""));
}

/**
 * Claude Code 2.1.323이 세션 기록에 쓰는 줄 종류(본체의 기록 종류 표에서 옮겼다).
 * 이 뷰어는 assistant(요청·도구 호출)와 user(도구 결과)만 쓰고 나머지는 읽고 넘긴다.
 * 표에 없는 종류는 새 버전의 형식일 수 있으므로 읽지 못한 줄로 드러낸다.
 */
const KNOWN_TYPES: ReadonlySet<string> = new Set(
  [
    "user assistant system attachment progress",
    "queue-operation api-request api-request-shape api-request-blob frame-link observer-ref continued-in resume-head-vouch",
    "file-history-snapshot file-history-delta attribution-snapshot",
    "custom-title ai-title tag relocated agent-name agent-color agent-setting mode repl-mode permission-mode",
    "session-owner isolation-latch dev-mods atis-latch worktree-state bridge-session tools-used",
    "data-flow-records data-flow-incomplete derived-from summary pr-link history-suppression ended-by-model",
    "cost-state last-prompt content-replacement memory-mode artifact-comment-monitor artifact-autoreact-ledger fork-context-ref",
  ].flatMap((group) => group.split(" ")),
);

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readUsage(value: unknown): TokenUsage | null {
  if (!isObject(value)) return null;
  const pick = (key: string): number | null => {
    const n = value[key];
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  };
  const input = pick("input_tokens");
  const output = pick("output_tokens");
  if (input === null || output === null) return null;
  // 캐시 필드는 캐시를 쓰지 않은 응답에서 빠질 수 있다. 빠진 것은 0토큰이라는 뜻이다.
  return { input, cacheWrite: pick("cache_creation_input_tokens") ?? 0, cacheRead: pick("cache_read_input_tokens") ?? 0, output };
}

function relativeTo(cwd: string | null, filePath: string): string {
  if (cwd !== null && filePath.startsWith(cwd)) return filePath.slice(cwd.length).replace(/^[/\\]/, "");
  return filePath;
}

function summarizeToolInput(name: string, input: unknown, cwd: string | null): string {
  if (!isObject(input)) return "";
  const text = (key: string): string | null => (typeof input[key] === "string" ? input[key] : null);
  const filePath = text("file_path") ?? text("notebook_path");
  if (filePath !== null) return relativeTo(cwd, filePath);
  const pattern = text("pattern");
  if (pattern !== null) return name === "Grep" ? `"${pattern}"` : pattern;
  const command = text("command");
  if (command !== null) return command.length > 80 ? `${command.slice(0, 79)}…` : command;
  return text("description") ?? text("url") ?? text("query") ?? "";
}

/** 줄이 끝난(줄바꿈으로 닫힌) 기록 줄을 차례로 받아 세션 모양을 쌓는다. 파일에 줄이 붙으면 이어서 넣는다. */
export class TranscriptBuilder {
  #lineCount = 0;
  #startedAt: string | null = null;
  #updatedAt: string | null = null;
  readonly #requests: Request[] = [];
  readonly #requestById = new Map<string, Request>();
  readonly #toolById = new Map<string, ToolCall>();
  readonly #unreadable: UnreadableLine[] = [];
  readonly #uuids: string[] = [];
  #forkedFromSessionId: string | null = null;
  readonly #stamps: { uuid: string | null; timestamp: string }[] = [];
  #cwd: string | null = null;
  /** 아직 요청으로 이어지지 않은 사람 메시지. 다음에 생기는 요청에 붙는다. */
  #pendingPrompt: string | null = null;
  /** 요청(message.id)마다 Claude가 쓴 글 조각. 응답의 text 블록이 줄마다 따로 온다. */
  readonly #replyParts = new Map<string, string[]>();
  /** 아직 요청으로 이어지지 않은 Hook 실행(세션 시작·프롬프트 Hook). 다음에 생기는 요청에 붙는다. */
  #pendingHooks: HookRun[] = [];
  readonly #requestByToolId = new Map<string, Request>();

  addLine(raw: string): void {
    this.#lineCount += 1;
    const line = this.#lineCount;
    if (raw.trim() === "") return;
    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch {
      this.#markUnreadable(line, UNREADABLE.json);
      return;
    }
    if (!isObject(record) || typeof record.type !== "string") {
      this.#markUnreadable(line, UNREADABLE.shape);
      return;
    }
    if (!KNOWN_TYPES.has(record.type)) {
      this.#markUnreadable(line, `알 수 없는 줄 종류예요(${record.type})`);
      return;
    }
    this.#addRecord(record, record.type, line);
  }

  build(): SessionTranscript {
    return {
      lineCount: this.#lineCount,
      startedAt: this.#startedAt,
      updatedAt: this.#updatedAt,
      requests: this.#requests.map((request) => ({ ...request, tokens: { ...request.tokens }, tools: request.tools.map((tool) => ({ ...tool })), hooks: request.hooks.map((hook) => ({ ...hook })) })),
      unreadable: [...this.#unreadable],
      uuids: [...this.#uuids],
      forkedFromSessionId: this.#forkedFromSessionId,
      stamps: [...this.#stamps],
    };
  }

  #markUnreadable(line: number, reason: string): void {
    this.#unreadable.push({ line, afterRequest: this.#requests.length, reason });
  }

  #addRecord(record: Json, type: string, line: number): void {
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : null;
    if (timestamp !== null) {
      this.#startedAt ??= timestamp;
      this.#updatedAt = timestamp;
      this.#stamps.push({ uuid: typeof record.uuid === "string" ? record.uuid : null, timestamp });
    }
    if (typeof record.cwd === "string") this.#cwd ??= record.cwd;
    if (typeof record.uuid === "string") this.#uuids.push(record.uuid);
    if (isObject(record.forkedFrom) && typeof record.forkedFrom.sessionId === "string") {
      this.#forkedFromSessionId ??= record.forkedFrom.sessionId;
    }
    // 서브에이전트 대화는 따로 센다(이 화면은 본 대화의 요청만 보인다).
    if (record.isSidechain === true) return;
    if (type === "assistant") this.#addAssistant(record, timestamp, line);
    else if (type === "user") this.#addUser(record, timestamp, line);
    else if (type === "attachment" && timestamp !== null) this.#addAttachment(record, timestamp);
  }

  #addAssistant(record: Json, timestamp: string | null, line: number): void {
    const message = record.message;
    if (!isObject(message) || typeof message.id !== "string" || timestamp === null) {
      this.#markUnreadable(line, UNREADABLE.shape);
      return;
    }
    // "<synthetic>"은 Claude Code가 API를 부르지 않고 직접 만든 응답(오류 안내 등)이다. 요청이 아니다.
    if (message.model === "<synthetic>") return;
    const usage = readUsage(message.usage);
    if (usage === null) {
      this.#markUnreadable(line, UNREADABLE.usage);
      return;
    }
    let request = this.#requestById.get(message.id);
    if (request === undefined) {
      request = { index: this.#requests.length + 1, messageId: message.id, at: timestamp, prompt: this.#pendingPrompt, reply: null, hooks: this.#pendingHooks, tokens: usage, total: 0, tools: [] };
      this.#pendingPrompt = null;
      this.#pendingHooks = [];
      this.#requests.push(request);
      this.#requestById.set(message.id, request);
    }
    // 같은 응답의 뒤 줄이 더 늦게 쓰이므로 마지막 줄의 usage를 쓴다(대개 모두 같다).
    request.tokens = usage;
    request.total = usage.input + usage.cacheWrite + usage.cacheRead + usage.output;
    if (!Array.isArray(message.content)) return;
    const texts = message.content.flatMap((block) => (isObject(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []));
    if (texts.length > 0) {
      const parts = this.#replyParts.get(message.id) ?? [];
      parts.push(...texts);
      this.#replyParts.set(message.id, parts);
      request.reply = clip(parts.join("\n"));
    }
    for (const block of message.content) {
      if (!isObject(block) || block.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string") continue;
      if (this.#toolById.has(block.id)) continue;
      const tool: ToolCall = {
        id: block.id,
        name: block.name,
        summary: summarizeToolInput(block.name, block.input, this.#cwd),
        startedAt: timestamp,
        durationMs: null,
        status: "running",
        blockedBy: null,
      };
      request.tools.push(tool);
      this.#toolById.set(block.id, tool);
      this.#requestByToolId.set(block.id, request);
    }
  }

  /** Hook 실행이 남긴 첨부(hook_success 등). 모양이 다르면 Hook이 아닌 첨부로 보고 넘긴다. */
  #addAttachment(record: Json, timestamp: string): void {
    const attachment = record.attachment;
    if (!isObject(attachment) || typeof attachment.type !== "string" || !attachment.type.startsWith("hook_")) return;
    const name = typeof attachment.hookName === "string" ? attachment.hookName : attachment.type;
    const event = typeof attachment.hookEvent === "string" ? attachment.hookEvent : (name.split(":")[0] ?? name);
    const exitCode = typeof attachment.exitCode === "number" ? attachment.exitCode : null;
    const output = [attachment.stdout, attachment.stderr, attachment.content].find((value) => typeof value === "string" && value.trim() !== "");
    const run: HookRun = {
      at: timestamp,
      event,
      name,
      command: typeof attachment.command === "string" ? attachment.command : null,
      outcome: attachment.type === "hook_success" && (exitCode === null || exitCode === 0) ? "ok" : attachment.type.includes("blocking") ? "blocked" : "error",
      durationMs: typeof attachment.durationMs === "number" ? attachment.durationMs : null,
      output: typeof output === "string" ? clip(output) : null,
    };
    const last = this.#requests.at(-1);
    if (BEFORE_REQUEST_EVENTS.has(event) || last === undefined) this.#pendingHooks.push(run);
    else last.hooks.push(run);
  }

  #addUser(record: Json, timestamp: string | null, line: number): void {
    const message = record.message;
    // 사람이 쓴 프롬프트는 content가 글자, 도구 결과는 블록 배열이다. 그 밖의 모양은 새 형식일 수 있다.
    if (!isObject(message) || timestamp === null || !(typeof message.content === "string" || Array.isArray(message.content))) {
      this.#markUnreadable(line, UNREADABLE.shape);
      return;
    }
    const prompt = promptText(record, message.content);
    if (prompt !== null) this.#pendingPrompt = prompt;
    if (typeof message.content === "string") return;
    for (const block of message.content) {
      if (!isObject(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const tool = this.#toolById.get(block.tool_use_id);
      if (tool === undefined) continue;
      tool.status = block.is_error === true ? "error" : "done";
      tool.durationMs = Math.max(0, Date.parse(timestamp) - Date.parse(tool.startedAt));
      const blocked = block.is_error === true ? blockingHook(block.content, timestamp) : null;
      if (blocked !== null) {
        tool.blockedBy = blocked.name;
        this.#requestByToolId.get(block.tool_use_id)?.hooks.push(blocked);
      }
    }
  }
}

/** 파일 내용 전체를 한 번에 읽을 때 쓴다. 줄바꿈으로 닫히지 않은 마지막 조각은 아직 쓰는 중인 줄이라 넣지 않는다. */
export function parseTranscript(text: string): SessionTranscript {
  const builder = new TranscriptBuilder();
  const lines = text.split("\n");
  lines.pop();
  for (const line of lines) builder.addLine(line);
  return builder.build();
}
