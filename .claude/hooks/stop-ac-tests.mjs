// Stop Hook(implement Skill의 frontmatter에서 건다): /implement가 끝내려 할 때
// docs/tasks/<slug>/prd.md의 AC-n마다 이름에 "<slug> AC-n"이 든 테스트가 있고, 지금 작업 트리로 전체 `npm run verify`가 통과했는지 본다.
//
// - 어느 작업인가: 세션 기록에서 마지막으로 부른 이 레포의 Skill이 implement면 그 인자의 slug, 인자가 없으면 브랜치 feat/<slug>.
//   Skill frontmatter의 Hook은 Skill을 부른 뒤 세션이 끝날 때까지 남는다. 그 뒤에 /review 같은 다른 Skill을 불렀으면 implement 차례가 아니므로 보지 않는다.
// - PRD가 없거나 초안이면 보지 않는다. implement가 구현하지 않고 /prd로 돌려보내는 자리다.
// - 어느 테스트인가: 레포의 테스트 파일 전부(커밋 안 한 것과 새 파일 포함, .gitignore로 빠진 것 제외).
//   이름에 slug를 함께 쓰므로 다른 작업의 "AC-1 ..." 테스트와 섞이지 않는다.
// - 테스트 이름: it·test·describe(…)의 첫 문자열과 it.each(…)(…)의 첫 문자열. 이름 어디든 "<slug> AC-n"이 있으면 그 AC의 테스트로 친다.
// - verify: stop-verify.mjs와 같은 판정(세션 기록의 전체 통과 줄 = 지금 작업 트리 지문).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { git, worktreeId } from "../../scripts/worktree-id.mjs";
import { emit, isMain, readPayload } from "./hook-io.mjs";
import { verifyStatus } from "./stop-verify.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const AC_ROW = /^\|\s*AC-(\d+)\s*\|/gm;
const TEST_NAME = /(?:\b(?:it|test|describe)(?:\.\w+)*|\))\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
const COMMAND = /<command-name>\/?([\w:.-]+)<\/command-name>(?:\s*<command-args>([\s\S]*?)<\/command-args>)?/g;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** PRD 완료 기준 표의 AC 번호. */
export function acNumbers(prdText) {
  return [...new Set([...prdText.matchAll(AC_ROW)].map((match) => Number(match[1])))].sort((a, b) => a - b);
}

/** 테스트 파일 내용에서 이름에 "<slug> AC-n"으로 든 AC 번호. */
export function acNumbersInTestNames(source, slug) {
  const pattern = new RegExp(`(?:^|[^\\w-])${slug.replaceAll("-", "\\-")} AC-(\\d+)\\b`, "g");
  const found = new Set();
  for (const match of source.matchAll(TEST_NAME)) {
    for (const ac of match[2].matchAll(pattern)) found.add(Number(ac[1]));
  }
  return found;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
  return "";
}

/** 세션 기록에서 마지막으로 부른 이 레포의 Skill과 인자. 슬래시 명령과 Skill 도구 둘 다 본다. */
export function lastSkillCall(transcriptText, isProjectSkill) {
  let last = null;
  for (const line of transcriptText.split("\n")) {
    if (line.trim() === "") continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry?.message;
    if (message?.role === "user") {
      for (const match of textOf(message.content).matchAll(COMMAND)) {
        if (isProjectSkill(match[1])) last = { name: match[1], args: (match[2] ?? "").trim() };
      }
    }
    if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (part?.type === "tool_use" && part.name === "Skill" && isProjectSkill(String(part.input?.skill ?? ""))) {
          last = { name: String(part.input.skill), args: String(part.input.args ?? "").trim() };
        }
      }
    }
  }
  return last;
}

function slugOf(call, root) {
  const first = call.args.split(/\s+/)[0] ?? "";
  if (SLUG.test(first)) return first;
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return branch.startsWith("feat/") ? branch.slice("feat/".length) : null;
}

/** 레포의 테스트 파일(커밋한 것, 커밋 안 한 것, 새 파일. .gitignore로 빠진 것 제외). */
function testFiles(root) {
  const files = git(root, ["ls-files", "--cached", "--others", "--exclude-standard"]).split("\n");
  return [...new Set(files)].filter((file) => TEST_FILE.test(file) && existsSync(path.join(root, file)));
}

function stopOrWarn(payload, why) {
  if (payload.stop_hook_active === true) {
    return { systemMessage: `${why} 이미 한 번 돌려보냈기 때문에 더 막지 않습니다(계속 막으면 끝내기가 끝없이 반복됩니다).` };
  }
  return { decision: "block", reason: why };
}

const HOW_TO =
  "AC마다 이름 맨 앞에 slug와 AC 번호를 단 테스트를 두고(예: `it(\"order-cancel AC-4 ...\", ...)`) `npm run verify` 전체 통과를 확인한 뒤 끝내세요. 기존 테스트의 기대값을 바꿔서 통과시키지 마세요.";

/**
 * @param payload Stop Hook 입력
 * @param env { root, readTranscript(path), currentTree() }
 */
export function decide(payload, env) {
  const { root } = env;
  try {
    const transcript = env.readTranscript(payload.transcript_path);
    const call = lastSkillCall(transcript, (name) => existsSync(path.join(root, ".claude", "skills", name, "SKILL.md")));
    if (call?.name !== "implement") return null;
    const slug = slugOf(call, root);
    if (slug === null) return null;
    const prdPath = path.join(root, "docs", "tasks", slug, "prd.md");
    if (!existsSync(prdPath)) return null;
    const prd = readFileSync(prdPath, "utf8");
    if (!/확정 여부:\s*\*\*확정\*\*/.test(prd)) return null;

    const problems = [];
    const acs = acNumbers(prd);
    if (acs.length === 0) problems.push(`docs/tasks/${slug}/prd.md 완료 기준 표에 AC-n 줄이 없습니다.`);
    const found = new Set();
    for (const file of testFiles(root)) {
      for (const ac of acNumbersInTestNames(readFileSync(path.join(root, file), "utf8"), slug)) found.add(ac);
    }
    const missing = acs.filter((ac) => !found.has(ac));
    if (missing.length > 0) {
      problems.push(`${missing.map((ac) => `AC-${ac}`).join(", ")}에 테스트 없음(이름에 "${slug} AC-n"이 든 테스트를 찾았습니다).`);
    }
    const { passedTree } = verifyStatus(transcript);
    if (passedTree !== env.currentTree()) {
      problems.push(
        passedTree === null
          ? "이 세션에서 전체 통과한 `npm run verify`가 없습니다."
          : "마지막으로 전체 통과한 `npm run verify` 뒤에 코드가 바뀌었습니다.",
      );
    }
    if (problems.length === 0) return null;
    return stopOrWarn(payload, `/implement ${slug}를 끝낼 수 없습니다. ${problems.join(" ")} ${HOW_TO}`);
  } catch (error) {
    return stopOrWarn(payload, `완료 기준을 확인하지 못했습니다(${error.message}).`);
  }
}

if (isMain(import.meta.url)) {
  emit(
    decide(await readPayload(), {
      root: projectRoot,
      readTranscript: (file) => readFileSync(file, "utf8"),
      currentTree: () => worktreeId(projectRoot),
    }),
  );
}
