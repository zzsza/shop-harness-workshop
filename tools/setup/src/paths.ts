// setup.mjs·claude.mjs가 함께 쓰는 위치. 실습 설정 폴더는 레포 밖 홈 아래 고정 폴더라
// 브랜치를 바꾸거나 다시 clone해도 실습 로그인이 남고, 원래 ~/.claude와 섞이지 않는다.
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StepFailure } from "./report.ts";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

export const PRACTICE_CONFIG_DIR_NAME = ".claude-workshop";

/** 링크·junction을 따라간 실제 경로. 아직 없는 경로는 있는 가장 가까운 상위 폴더까지 풀고 나머지를 붙인다. */
function realPath(target: string): string {
  let existing = target;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  const real = existsSync(existing) ? realpathSync.native(existing) : existing;
  return path.join(real, ...rest);
}

/**
 * child가 parent와 같거나 그 안(자식·손자…)에 있는지. 이 레포의 경로 포함 판정은 모두 이 함수만 쓴다.
 * 상대 경로의 첫 요소가 정확히 ".."일 때만 밖으로 본다("..linked" 같은 이름은 안이다).
 * Windows는 대소문자(드라이브 문자 포함)를 가리지 않고, 다른 드라이브면 path.relative가 절대 경로를 돌려주므로 밖이다.
 */
export function isInsideOrEqual(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const normalize = (p: string): string => (platform === "win32" ? paths.resolve(p).toLowerCase() : paths.resolve(p));
  const relative = paths.relative(normalize(parent), normalize(child));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative));
}

/** 두 경로가 같은 위치인지. */
export function isSamePath(a: string, b: string): boolean {
  return isInsideOrEqual(a, b) && isInsideOrEqual(b, a);
}

/**
 * CLAUDE_CONFIG_DIR로 넘길 실습 설정 폴더를 확정한다. claude 실행·폴더 생성·로그아웃·삭제보다 먼저 부른다.
 * 홈(Mac은 HOME, Windows는 USERPROFILE)이 절대 경로가 아니거나, 실제 경로가 원래 설정 폴더 ~/.claude·홈 폴더·레포와
 * 겹치면(같음, 안, 위. 링크·junction 포함) 거부한다. 원래 로그인과 설정을 건드리지 않고 로그인 파일이 레포에 섞이지 않게 하려는 것이다.
 */
export function resolvePracticeConfigDir(home: string = os.homedir()): string {
  if (home === "" || !path.isAbsolute(home)) {
    throw new StepFailure(`홈 폴더 값이 절대 경로가 아닙니다: "${home}". 실습 설정 폴더를 정할 수 없어 아무것도 바꾸지 않았습니다.`, [
      "Mac은 HOME, Windows는 USERPROFILE 환경 변수가 내 홈 폴더 전체 경로인지 확인하고 터미널을 새로 여세요.",
    ]);
  }
  const configDir = path.join(home, PRACTICE_CONFIG_DIR_NAME);
  const real = realPath(configDir);
  const guarded = [
    { target: path.join(home, ".claude"), label: "원래 설정 폴더" },
    { target: REPO_ROOT, label: "레포" },
  ];
  for (const { target, label } of guarded) {
    const realTarget = realPath(target);
    if (isInsideOrEqual(real, realTarget) || isInsideOrEqual(realTarget, real)) {
      throw new StepFailure(`실습 설정 폴더 ${configDir}의 실제 위치(${real})가 ${label} ${target}와 겹칩니다. 아무것도 바꾸지 않았습니다.`, [
        `${configDir}가 링크라면 지우고(원래 폴더는 그대로 둡니다) 다시 실행하세요.`,
      ]);
    }
  }
  // 홈 폴더 자체나 그 위면 원래 ~/.claude.json과 겹친다.
  if (isInsideOrEqual(realPath(home), real)) {
    throw new StepFailure(`실습 설정 폴더 ${configDir}의 실제 위치(${real})가 홈 폴더와 같거나 그 위입니다. 아무것도 바꾸지 않았습니다.`, [
      `${configDir}가 링크라면 지우고 다시 실행하세요.`,
    ]);
  }
  return configDir;
}

/**
 * 다른 Claude Code 세션 안에서 열린 터미널이 물려받는 "부모 세션" 변수.
 * 예: Claude Code가 띄운 VS Code의 터미널. 이 변수가 남아 있으면 새 claude가 자신을 그 세션의 하위 세션으로 여겨
 * 세션 기록(~/.claude-workshop/projects/)을 남기지 않아 세션 뷰어에 나오지 않는다. npm run claude는 늘 새 세션으로 띄운다.
 */
export const INHERITED_SESSION_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_PID",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_ENV_FILE",
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_PLUGIN_DATA",
] as const;

/** 실습 설정 폴더로 claude를 부를 때의 환경 변수. claude를 부르는 모든 곳이 이것을 쓴다. */
export function claudeEnv(configDir: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const inherited = new Set<string>(INHERITED_SESSION_VARS);
  const kept = Object.entries(env).filter(([name]) => !inherited.has(name));
  return { ...Object.fromEntries(kept), CLAUDE_CONFIG_DIR: configDir };
}
