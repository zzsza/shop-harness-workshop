// Hook 판정 함수의 테스트. 판정 범위는 README.md에 있고, 그 범위를 아래 '막는다'·'통과한다' 표로 고정한다.
// 표의 출처: 리뷰1(3acdb3d 리뷰), 재리뷰1(36b6ef4 재리뷰), 재리뷰2(그 재리뷰의 인접 입력과 고치기 지시).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decide as guardBash } from "./guard-bash.mjs";
import * as lintSavedFile from "./lint-saved-file.mjs";
import { decide as protectFiles } from "./protect-files.mjs";
import { decide as stopVerify } from "./stop-verify.mjs";
import { decide as checkReviewCommit } from "./check-review-commit.mjs";
import { decide as stopAcTests } from "./stop-ac-tests.mjs";
import { decide as subagentEvidence } from "./subagent-evidence.mjs";

const { lintTarget } = lintSavedFile;
const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
const file = (tool_name, file_path) => ({ tool_name, tool_input: { file_path } });
const denied = (output) => output?.hookSpecificOutput?.permissionDecision === "deny";

/** 커밋 하나가 있는 임시 git 저장소. 끝나면 지운다. */
function tempRepo(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hooks-test-"));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  // 전역 설정의 커밋 서명(commit.gpgsign)이 켜져 있으면 키 에이전트 없이 커밋이 실패하므로 끈다.
  git("config", "commit.gpgsign", "false");
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return { dir, git, write: (name, text) => writeFileSync(path.join(dir, name), text) };
}

// 가짜 프로젝트: /work/shop, HEAD에 있는 마이그레이션은 0001_init.sql 하나.
const CWD = "/work/shop";
const COMMITTED = ["packages/db/migrations/0001_init.sql"];
const committed = (relative) => COMMITTED.some((entry) => entry === relative || entry.startsWith(`${relative}/`));
const HOOKS = {
  "guard-bash": (payload) => guardBash({ cwd: CWD, ...payload }),
  "protect-files": (payload) => protectFiles(payload, CWD, committed),
};

// [Hook, 입력, 출처]. 출처가 비어 있으면 처음부터 있던 기본 사례.
const BLOCKED = [
  // force push
  ["guard-bash", bash("git push --force origin main"), ""],
  ["guard-bash", bash("git push -f"), "리뷰1"],
  ["guard-bash", bash("git push --force-with-lease"), "리뷰1"],
  ["guard-bash", bash("git push origin main --force-with-lease"), ""],
  ["guard-bash", bash("git -C ../repo push origin +main"), ""],
  ["guard-bash", bash("git status && git push -fu origin feature"), ""],
  ["guard-bash", bash("env git push -f"), "리뷰1"],
  ["guard-bash", bash("command git push -f"), "리뷰1"],
  ["guard-bash", bash("CI=1 git push -f"), "리뷰1"],
  ["guard-bash", bash("sudo git push --force origin main"), "재리뷰1"],
  ["guard-bash", bash("nohup git push -f &"), "재리뷰1"],
  ["guard-bash", bash("timeout 10 git push -f"), "재리뷰1"],
  ["guard-bash", bash("/usr/bin/git push -f"), ""],
  ["guard-bash", bash("git.exe push -f"), ""],
  ["guard-bash", bash('bash -c "git push -f"'), "재리뷰1"],
  ["guard-bash", bash('eval "git push -f"'), "재리뷰1"],
  ["guard-bash", bash("echo $(git push -f)"), "재리뷰1"],
  ["guard-bash", bash("git -C . push -f"), "재리뷰1"],
  // 값을 받는 옵션 뒤의 실제 명령(재리뷰2 F1)
  ["guard-bash", bash("sudo --user root git push -f"), "재리뷰2"],
  ["guard-bash", bash("sudo --user=root git push -f"), "재리뷰2"],
  ["guard-bash", bash("sudo -u deploy git push -f"), "재리뷰2"],
  ["guard-bash", bash("sudo -Eu deploy git push --force"), "재리뷰2"],
  ["guard-bash", bash("sudo --chdir /tmp --user root git push -f"), "재리뷰2"],
  ["guard-bash", bash("git --git-dir .git push -f"), "재리뷰2"],
  ["guard-bash", bash("git --work-tree . push --force"), "재리뷰2"],
  ["guard-bash", bash("git --work-tree=. push --force"), "재리뷰2"],
  ["guard-bash", bash("git -C apps push --force"), "재리뷰2"],
  ["guard-bash", bash("git -c core.pager=cat push -f"), "재리뷰2"],
  ["guard-bash", bash("git -c user.name=x -C . --no-pager push --force origin main"), "재리뷰2"],
  ["guard-bash", bash("env -u HOME git push -f"), "재리뷰2"],
  ["guard-bash", bash("timeout --signal KILL 30 git push -f"), "재리뷰2"],
  // 대량 삭제
  ["guard-bash", bash("rm -rf /"), ""],
  ["guard-bash", bash("rm -rf ."), ""],
  ["guard-bash", bash("rm -rf apps/api"), ""],
  ["guard-bash", bash("rm -rf docs/tasks apps/api"), "리뷰1"],
  ["guard-bash", bash("rm -rf dist docs/tasks"), "리뷰1"],
  ["guard-bash", bash("rm -r *"), ""],
  ["guard-bash", bash("git clean -fd"), ""],
  ["guard-bash", bash("find . -name '*.ts' -delete"), ""],
  ["guard-bash", bash("env rm -rf docs/tasks"), "리뷰1"],
  ["guard-bash", bash("sudo -u root rm -rf apps"), ""],
  ["guard-bash", bash("(cd docs && rm -rf tasks)"), ""],
  ["guard-bash", bash("sh -c 'rm -rf apps/api'"), ""],
  ["guard-bash", bash("ls | xargs rm -rf"), "재리뷰1"],
  ["guard-bash", bash("find docs -exec rm -rf {} \\;"), "재리뷰1"],
  ["guard-bash", bash("sudo --user root rm -rf docs/tasks"), "재리뷰2"],
  ["guard-bash", bash("xargs -n 1 rm -rf < dirs.txt"), "재리뷰2"],
  ["guard-bash", bash("git -C apps clean -fdx"), "재리뷰2"],
  // .env 읽기·쓰기
  ["protect-files", file("Write", "/work/shop/.env"), ""],
  ["protect-files", file("Edit", ".env.local"), ""],
  ["protect-files", file("Edit", "/work/shop/apps/api/.env"), ""],
  ["protect-files", file("Write", "apps\\api\\.env"), ""],
  ["protect-files", file("Read", "/work/shop/apps/api/.env.development"), ""],
  ["protect-files", bash("echo API_PORT=1 >> .env"), ""],
  ["protect-files", bash("echo x > .env"), "리뷰1"],
  ["protect-files", bash("cat .env"), "리뷰1"],
  ["protect-files", bash("cat .e'nv'"), ""],
  ["protect-files", bash("grep KEY apps/api/.env.local"), ""],
  ["protect-files", bash("cat apps/api/.env.development"), "재리뷰1"],
  ["protect-files", bash("node -e \"require('fs').writeFileSync('.env', 'x')\""), "리뷰1"],
  ["protect-files", bash("python3 -c \"open('.env', 'w').write('x')\""), ""],
  ["protect-files", bash("bash -c 'echo x > .env'"), ""],
  ["protect-files", bash("node <<'EOF'\nrequire('fs').writeFileSync('.env','x')\nEOF"), "재리뷰1"],
  ["protect-files", bash("node <<'EOF'\nrequire('fs').appendFileSync('apps/api/.env', 'x')\nEOF"), ""],
  // 이미 커밋된 마이그레이션 수정·삭제·이동
  ["protect-files", file("Write", "/work/shop/packages/db/migrations/0001_init.sql"), ""],
  ["protect-files", file("Edit", "packages/db/migrations/0001_init.sql"), ""],
  ["protect-files", file("Edit", "packages\\db\\migrations\\0001_init.sql"), ""],
  ["protect-files", bash("sed -i s/a/b/ packages/db/migrations/0001_init.sql"), "리뷰1"],
  ["protect-files", bash("sed -i '' s/a/b/ packages/db/migrations/0001_init.sql"), ""],
  ["protect-files", bash("cd packages/db/migrations && sed -i s/a/b/ 0001_init.sql"), "리뷰1"],
  ["protect-files", bash("cd packages/db && echo x >> migrations/0001_init.sql"), ""],
  ["protect-files", bash("cd /work/shop/packages/db/migrations; rm 0001_init.sql"), ""],
  ["protect-files", bash("cd packages/db/migrations\ncat > 0001_init.sql <<'EOF'\nselect 1;\nEOF"), ""],
  ["protect-files", bash("echo x >> packages\\db\\migrations\\0001_init.sql"), "리뷰1"],
  ["protect-files", bash("cp new.sql packages\\db\\migrations\\0001_init.sql"), ""],
  ["protect-files", bash("node -e \"require('fs').writeFileSync('packages/db/migrations/0001_init.sql', 'x')\""), "재리뷰1"],
  ["protect-files", bash('bash -c "cd packages/db/migrations && sed -i s/a/b/ 0001_init.sql"'), "재리뷰1"],
  ["protect-files", bash("tee packages/db/migrations/0001_init.sql < new.sql"), ""],
  ["protect-files", bash("env FOO=1 sed -i s/a/b/ packages/db/migrations/0001_init.sql"), ""],
  ["protect-files", bash("sed -i s/a/b/ packages/db/migrations/*.sql"), "재리뷰1"],
  ["protect-files", bash("mv packages/db/migrations /tmp/old"), ""],
  ["protect-files", bash("cd $SOMEWHERE && echo x >> 0001_init.sql"), ""],
  // 작업 폴더를 바꾸는 옵션·eval 뒤의 상대 경로(재리뷰2 F3)
  ["protect-files", bash("eval 'cd packages/db/migrations'; sed -i '' s/a/b/ 0001_init.sql"), "재리뷰2"],
  ["protect-files", bash('eval "cd packages/db/migrations" && echo x >> 0001_init.sql'), "재리뷰2"],
  ["protect-files", bash("{ cd packages/db/migrations; sed -i s/a/b/ 0001_init.sql; }"), "재리뷰2"],
  ["protect-files", bash("env --chdir packages/db/migrations sed -i s/a/b/ 0001_init.sql"), "재리뷰2"],
  ["protect-files", bash("env -C packages/db/migrations sed -i s/a/b/ 0001_init.sql"), "재리뷰2"],
  // 파일을 쓰는 git 옵션(재리뷰2 F2)
  ["protect-files", bash("git diff --output=packages/db/migrations/0001_init.sql"), "재리뷰2"],
  ["protect-files", bash("git diff --output packages/db/migrations/0001_init.sql HEAD~1"), "재리뷰2"],
  ["protect-files", bash("git log -p --output=packages/db/migrations/0001_init.sql"), "재리뷰2"],
  ["protect-files", bash("git -C packages/db/migrations diff --output=0001_init.sql"), "재리뷰2"],
  ["protect-files", bash("git --no-pager show HEAD --output=packages\\db\\migrations\\0001_init.sql"), "재리뷰2"],
  // find로 폴더 아래 파일을 한꺼번에 고치기
  ["protect-files", bash("find packages/db/migrations -name '*.sql' -exec sed -i '' s/a/b/ {} +"), "재리뷰2"],
  ["protect-files", bash("find . -name '*.sql' -exec sed -i s/a/b/ {} \\;"), "재리뷰2"],
  ["protect-files", bash("cd packages/db && find migrations -delete"), "재리뷰2"],
  // 폴더째 지우기·옮기기, 이름이 같은 파일 덮어쓰기
  ["protect-files", bash("rm -r packages/db"), "재리뷰2"],
  ["protect-files", bash("git rm -r packages/db/migrations"), "재리뷰2"],
  ["protect-files", bash("mv packages/db /tmp/db-old"), "재리뷰2"],
  ["protect-files", bash("cp /tmp/0001_init.sql packages/db/migrations/"), "재리뷰2"],
  ["protect-files", bash("cd packages/db && cp ~/0001_init.sql migrations"), "재리뷰2"],
];

// 두 PreToolUse Hook을 모두 통과해야 하는 정상 입력. 수업에서 흔히 쓰는 명령.
const ALLOWED = [
  // 검증·실행
  bash("npm ci"),
  bash("npm run verify"),
  bash("npm test"),
  bash("npm test -- packages/db"),
  bash("npm run dev"),
  bash("npm run lint"),
  bash("npm run typecheck"),
  bash("npm run build"),
  bash("npm run grade"),
  bash("npm run db:reset"),
  bash("env CI=1 npm test"),
  bash("env FOO=1 npm run verify"),
  bash('bash -c "npm run verify"'),
  bash("node scripts/verify.mjs"),
  bash("node scripts/setup.mjs"),
  bash('node -e "console.log(process.version)"'),
  bash("npx vitest run"),
  bash("npx vitest run packages/db"),
  bash("npx vitest run apps/api/src/orders"),
  bash("npx tsc --noEmit"),
  bash("npx eslint apps/api/src/app.ts"),
  // git 일상 작업
  bash("git status"),
  bash("git status --short"),
  bash("git diff"),
  bash("git diff --stat day2-a day2-b"),
  bash("git diff -- packages/db/migrations/0001_init.sql"),
  bash("git diff > /tmp/changes.patch"),
  bash("git diff --output=/tmp/changes.patch"),
  bash("git log --oneline -5"),
  bash("git --no-pager log -3"),
  bash("git -c core.pager=cat log -1"),
  bash("git -C ../other status"),
  bash("git show HEAD:packages/db/migrations/0001_init.sql"),
  bash("git add apps/api/src/app.ts"),
  bash("git add -A"),
  bash("git add packages/db/migrations/0002_low_stock.sql"),
  bash('git commit -m "상품 조회 조건 수정"'),
  bash('git commit -m "force push 금지 문서 추가"'),
  bash("git commit -m \"git push -f 설명\""),
  bash('git commit -m "env git push -f 막기"'),
  bash('git commit -m "Keep .env out of commits"'),
  bash('git add -A && git commit -m "안전재고 알림 추가"'),
  bash("git push"),
  bash("git push origin day2-a"),
  bash("git push origin feature"),
  bash("git push -u origin feature"),
  bash("sudo -u deploy git push origin main"),
  bash("git switch -c low-stock"),
  bash("git merge main"),
  bash("git fetch origin"),
  bash("git restore apps/api/src/app.ts"),
  // 파일 만들기·읽기
  bash("mkdir -p apps/api/src/alerts"),
  bash("touch apps/api/src/alerts/low-stock.ts"),
  bash("cat README.md"),
  bash("cat .env.example"),
  bash("head -20 packages/db/migrations/0001_init.sql"),
  bash('rg -n "Money" packages'),
  bash("ls packages/db/migrations"),
  bash("cat packages/db/migrations/0001_init.sql"),
  bash("cd packages/db/migrations && cat 0001_init.sql"),
  bash("cd packages/db/migrations && sed -n 1p 0001_init.sql"),
  bash("sed -n '1,20p' packages/db/migrations/0001_init.sql"),
  bash("cp packages/db/migrations/0001_init.sql /tmp/backup.sql"),
  bash("echo hi > notes.txt"),
  bash('echo "rm -rf apps"'),
  bash('echo "git push -f"'),
  bash("cd docs && echo x > 0001_init.sql"),
  // 소스 고치기
  bash("sed -i '' 's/old/new/' apps/api/src/app.ts"),
  bash("sed -i 's/a/b/' apps/web/src/App.tsx"),
  file("Edit", "apps/api/src/config.ts"),
  file("Write", "/work/shop/.env.example"),
  file("Read", "packages/db/migrations/0001_init.sql"),
  // 새 마이그레이션 만들고 고치기(재리뷰2 F4)
  bash("mkdir -p packages/db/migrations"),
  bash("mkdir packages/db/migrations"),
  bash("mkdir -p packages/db/migrations && cat > packages/db/migrations/9999_review_fixture.sql <<'EOF'\n-- new migration\nEOF"),
  bash("node -e \"require('fs').mkdirSync('packages/db/migrations', {recursive: true})\""),
  bash("touch packages/db/migrations/0002_low_stock.sql"),
  bash("cat > packages/db/migrations/0002_low_stock.sql <<'EOF'\nalter table products add column safety_stock integer;\nEOF"),
  bash("echo x > packages/db/migrations/0002_add_memo.sql"),
  bash("echo '-- memo' >> packages/db/migrations/0002_low_stock.sql"),
  bash("cp /tmp/0002_low_stock.sql packages/db/migrations/"),
  bash("cp /tmp/draft.sql packages/db/migrations/0002_low_stock.sql"),
  bash("cd packages/db/migrations && sed -i '' s/a/b/ 0002_low_stock.sql"),
  file("Write", "packages/db/migrations/0002_add_memo.sql"),
  file("Edit", "packages/db/migrations/0002_low_stock.sql"),
  // 빌드 산출물·파일 하나 지우기
  bash("rm -rf node_modules"),
  bash("rm -rf dist node_modules"),
  bash("rm -rf apps/web/dist"),
  bash("rm dist/old.js"),
  bash("rm apps/api/src/old.ts"),
  bash("rm -f notes.txt"),
  bash("rm packages/db/migrations/0002_low_stock.sql"),
  bash("rm /tmp/scratch.txt"),
  bash("find apps/api -name '*.ts' -exec sed -i '' s/a/b/ {} +"),
  bash("find . -name '*.ts' -exec sed -i s/a/b/ {} \\;"),
  bash("find packages/db/migrations -name '*.sql' -exec cat {} +"),
  bash("find . -name '*.sql' -print"),
  bash("mv /tmp/0002_low_stock.sql packages/db/migrations/"),
  bash("git mv apps/api/src/a.ts apps/api/src/b.ts"),
  bash("git rm apps/api/src/old.ts"),
];

describe("막는다", () => {
  it.each(BLOCKED.map(([hook, payload, source]) => [hook, source || "기본", payload.tool_input.command ?? `${payload.tool_name} ${payload.tool_input.file_path}`, payload]))(
    "%s [%s] %s",
    (hook, _source, _label, payload) => {
      expect(denied(HOOKS[hook](payload))).toBe(true);
    },
  );
});

describe("통과한다(오탐 없음)", () => {
  it.each(ALLOWED.map((payload) => [payload.tool_input.command ?? `${payload.tool_name} ${payload.tool_input.file_path}`, payload]))("%s", (_label, payload) => {
    expect(HOOKS["guard-bash"](payload)).toBeNull();
    expect(HOOKS["protect-files"](payload)).toBeNull();
  });
});

describe("protect-files", () => {
  describe("새 마이그레이션은 HEAD 기준으로 판단한다(R4)", () => {
    let repo;
    beforeAll(() => {
      repo = tempRepo({ "packages/db/migrations/0001_init.sql": "create table a(id int);\n" });
      repo.write("packages/db/migrations/0002_new.sql", "-- new\n");
    });
    afterAll(() => rmSync(repo.dir, { recursive: true, force: true }));

    it("만든 직후 아직 커밋하지 않은 번호 파일은 고칠 수 있다", () => {
      expect(protectFiles(file("Edit", "packages/db/migrations/0002_new.sql"), repo.dir)).toBeNull();
      expect(protectFiles(bash("echo x >> packages/db/migrations/0002_new.sql"), repo.dir)).toBeNull();
    });

    it("HEAD에 있는 번호 파일은 막고, 막은 이유에 그 파일을 적는다", () => {
      expect(denied(protectFiles(file("Edit", "packages/db/migrations/0001_init.sql"), repo.dir))).toBe(true);
      const output = protectFiles(bash("cd packages/db/migrations && sed -i '' 's/a/b/' 0001_init.sql"), repo.dir);
      expect(output.hookSpecificOutput.permissionDecisionReason).toContain("packages/db/migrations/0001_init.sql");
    });
  });
});

describe("lint-saved-file", () => {
  it("프로젝트 안의 소스 파일만 린트 대상이다", () => {
    const edit = (file_path) => ({ tool_name: "Edit", tool_input: { file_path } });
    expect(lintTarget(edit("/work/shop/apps/api/src/app.ts"), "/work/shop")).toBe("apps/api/src/app.ts");
    expect(lintTarget(edit("/work/shop/README.md"), "/work/shop")).toBeNull();
    expect(lintTarget(edit("/elsewhere/a.ts"), "/work/shop")).toBeNull();
    expect(lintTarget(edit("/work/shop/node_modules/x/index.js"), "/work/shop")).toBeNull();
    expect(lintTarget({ tool_name: "Read", tool_input: { file_path: "/work/shop/a.ts" } }, "/work/shop")).toBeNull();
  });

  it("lint가 시간 예산을 넘으면 기다리지 않고 건너뛴다고 알린다(R5)", () => {
    const slow = { command: [process.execPath, "-e", "setTimeout(() => {}, 10000)"], timeoutMs: 300 };
    const started = Date.now();
    const output = lintSavedFile.lintSavedFile({ tool_name: "Edit", tool_input: { file_path: "apps/api/src/app.ts" } }, slow);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(output.hookSpecificOutput.additionalContext).toContain("시간 초과로 lint를 건너뛰었습니다");
  });

  it("세션을 붙잡는 시간 예산은 30초 이하다(R5)", () => {
    expect(lintSavedFile.LINT_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});

describe("stop-verify", () => {
  const use = (id, name, input) => JSON.stringify({ message: { content: [{ type: "tool_use", id, name, input }] } });
  const result = (id, content, is_error = false) => JSON.stringify({ message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] } });
  const passed = (tree) => `[verify] 통과: Node 확인 → 타입 검사 → lint → 테스트 → 빌드\n[verify] 전체 통과 · 작업 트리 ${tree}`;
  const T1 = "1".repeat(40);
  const T2 = "2".repeat(40);
  const lines = (...entries) => entries.join("\n");
  const stop = (text, tree = T1, extra = {}) => stopVerify({ transcript_path: "t", ...extra }, () => text, () => tree);
  const verifyRun = (id, tree, command = "npm run verify") => [use(id, "Bash", { command }), result(id, passed(tree))];

  it("고친 파일이 없으면 verify 없이 끝내도 된다", () => {
    expect(stop(lines(use("a", "Read", { file_path: "x.ts" })), T2)).toBeNull();
  });

  it("읽기만 한 Bash 명령은 작업 트리가 지저분해도 verify를 요구하지 않는다", () => {
    const text = lines(use("a", "Bash", { command: "git status && cat apps/api/src/app.ts | head -5" }), use("b", "Bash", { command: "rg -n Money packages" }));
    expect(stop(text, T2)).toBeNull();
  });

  it("코드를 고치고 verify를 돌리지 않았으면 막는다", () => {
    expect(stop(lines(use("a", "Edit", { file_path: "apps/api/src/app.ts" })))).toMatchObject({ decision: "block" });
  });

  it("verify가 통과한 작업 트리가 지금과 같으면 끝내도 된다", () => {
    expect(stop(lines(use("a", "Edit", { file_path: "a.ts" }), ...verifyRun("b", T1)), T1)).toBeNull();
  });

  it("verify가 통과한 뒤에 코드를 또 고쳤으면 다시 막는다", () => {
    expect(stop(lines(...verifyRun("b", T1), use("a", "Write", { file_path: "a.ts" })), T2)).toMatchObject({ decision: "block" });
  });

  it("verify 뒤 커밋만 했으면 작업 트리 내용이 같으므로 끝내도 된다", () => {
    const text = lines(use("a", "Edit", { file_path: "a.ts" }), ...verifyRun("b", T1), use("c", "Bash", { command: "git add -A && git commit -m 'x'" }));
    expect(stop(text, T1)).toBeNull();
  });

  it("verify가 실패했거나 일부 단계만 돌렸으면 통과로 치지 않는다", () => {
    const failed = lines(use("a", "Edit", { file_path: "a.ts" }), use("b", "Bash", { command: "npm run verify" }), result("b", "[verify] 실패: lint", true));
    const partial = lines(use("a", "Edit", { file_path: "a.ts" }), use("b", "Bash", { command: "npm run lint" }), result("b", "[verify] 통과: lint"));
    expect(stop(failed)).toMatchObject({ decision: "block" });
    expect(stop(partial)).toMatchObject({ decision: "block" });
  });

  it("R1: verify.mjs --only로 일부 단계만 돈 것은 verify로 치지 않는다", () => {
    const text = lines(
      use("a", "Edit", { file_path: "a.ts" }),
      use("b", "Bash", { command: "node scripts/verify.mjs --only node" }),
      result("b", "[verify 1/1] Node 확인\nNode v24.22.1\n\n[verify] 통과: Node 확인"),
    );
    expect(stop(text)).toMatchObject({ decision: "block" });
  });

  it("R1: verify 문구를 echo로 찍은 것은 verify로 치지 않는다", () => {
    const text = lines(use("a", "Edit", { file_path: "a.ts" }), ...verifyRun("b", T1, `echo "${passed(T1)}"`));
    expect(stop(text, T1)).toMatchObject({ decision: "block" });
  });

  it("R1: Bash로만 코드를 고치고 verify를 돌리지 않았으면 막는다", () => {
    expect(stop(lines(use("a", "Bash", { command: "sed -i '' s/a/b/ apps/api/src/app.ts" })), T2)).toMatchObject({ decision: "block" });
  });

  it("R1: 전체 verify 뒤 Bash로 코드를 고쳤으면 다시 막는다", () => {
    const text = lines(use("a", "Edit", { file_path: "a.ts" }), ...verifyRun("b", T1), use("c", "Bash", { command: "sed -i '' s/a/b/ apps/api/src/app.ts" }));
    expect(stop(text, T2)).toMatchObject({ decision: "block" });
  });

  it("재리뷰2: git diff --output으로 소스를 덮어쓴 것도 코드 변경으로 본다", () => {
    expect(stop(lines(use("a", "Bash", { command: "git diff --output=apps/api/src/app.ts" })), T2)).toMatchObject({ decision: "block" });
    expect(stop(lines(use("a", "Bash", { command: "git diff --stat" })), T2)).toBeNull();
  });

  it("폴더만 만들었으면(mkdir) 코드가 바뀌지 않았으므로 verify를 요구하지 않는다", () => {
    expect(stop(lines(use("a", "Bash", { command: "mkdir -p packages/db/migrations" })), T2)).toBeNull();
    expect(stop(lines(use("a", "Bash", { command: "touch apps/api/src/new.ts" })), T2)).toMatchObject({ decision: "block" });
  });

  it("문서(.md)만 고쳤으면 verify를 요구하지 않는다", () => {
    expect(stop(lines(use("a", "Write", { file_path: "docs/tasks/x.md" })), T2)).toBeNull();
  });

  it("셸로 문서나 작업 폴더의 실행 결과만 썼으면 verify를 요구하지 않는다", () => {
    expect(stop(lines(use("a", "Bash", { command: "mkdir -p docs/tasks/x && cat > docs/tasks/x/interview.md <<'EOF'\n# x\nEOF" })), T2)).toBeNull();
    expect(stop(lines(use("a", "Bash", { command: "git diff abc..HEAD > docs/tasks/x/run/evidence/diff.patch" })), T2)).toBeNull();
    expect(stop(lines(use("a", "Write", { file_path: "docs/tasks/x/run/status.json" })), T2)).toBeNull();
  });

  it("셸로 쓴 곳에 코드 파일이 하나라도 있거나 쓰는 곳을 알 수 없으면 verify를 요구한다", () => {
    expect(stop(lines(use("a", "Bash", { command: "cat > apps/api/src/x.ts <<'EOF'\nexport {};\nEOF" })), T2)).toMatchObject({ decision: "block" });
    expect(stop(lines(use("a", "Bash", { command: "cp docs/tasks/x/run/a.ts apps/api/src/a.ts" })), T2)).toMatchObject({ decision: "block" });
    expect(stop(lines(use("a", "Bash", { command: "npm install left-pad" })), T2)).toMatchObject({ decision: "block" });
    expect(stop(lines(use("a", "Bash", { command: "./gen.sh > docs/tasks/x/run/out.txt" })), T2)).toMatchObject({ decision: "block" });
    expect(stop(lines(use("a", "Bash", { command: "make > notes.md" })), T2)).toMatchObject({ decision: "block" });
  });

  it("/review가 쓰는 git·gh 명령은 코드를 바꾼 것으로 치지 않는다", () => {
    for (const command of [
      "git merge-base HEAD start/day2-a",
      "git merge-base HEAD origin/day2-a",
      "gh pr view 12 --json headRefName,baseRefName,url",
      "gh pr diff 12",
      "gh pr comment 12 --body-file docs/tasks/x/run/review.md",
      "gh pr checks 12",
      // 남이 이미 커밋한 PR 브랜치로 옮길 뿐 이 세션이 코드를 쓴 것이 아니다. 그 코드의 검사는 PR 검사가 한다.
      "gh pr checkout 12",
    ]) {
      expect(stop(lines(use("a", "Bash", { command })), T2), command).toBeNull();
    }
  });

  it("백그라운드 세션을 보고·띄우고·지우는 claude 명령은 코드를 바꾼 것으로 치지 않는다", () => {
    for (const command of [
      "claude agents --json --all",
      'claude --bg -w issue-3 -n issue-3 "/issue-to-pr docs/issues/3.md"',
      "claude rm 49530251",
      "claude stop 49530251",
      "claude logs issue-3",
      "gh pr list --state all --limit 100 --json number,state,url,body",
      `claude agents --json --all | jq '.[] | select(.name == "issue-3") | .state'`,
    ]) {
      expect(stop(lines(use("a", "Bash", { command })), T2), command).toBeNull();
    }
  });

  it("자기 worktree 없이 띄운 백그라운드 세션과 그 밖의 claude 명령은 코드 변경으로 친다", () => {
    for (const command of [
      'claude --bg -n issue-3 "/issue-to-pr docs/issues/3.md"',
      'claude -p "고쳐줘"',
      // 스크립트는 파일을 쓸 수 있다. 목록을 거르는 데 써도 코드를 돌린 것으로 친다(issue-dispatch는 출력을 그대로 읽는다).
      `claude agents --json --all | python3 -c "import json,sys; print(len(json.load(sys.stdin)))"`,
    ]) {
      expect(stop(lines(use("a", "Bash", { command })), T2), command).toMatchObject({ decision: "block" });
    }
  });

  it("커밋된 브랜치로 옮기기만 하는 git switch는 코드를 바꾼 것으로 치지 않는다", () => {
    for (const command of ["git switch day2-a", "git switch -", "git switch -c feat/order-cancel", "git switch --detach abc123"]) {
      expect(stop(lines(use("a", "Bash", { command })), T2), command).toBeNull();
    }
  });

  it("고친 내용을 버리는 git switch와 파일을 되돌릴 수 있는 git checkout은 코드 변경으로 친다", () => {
    for (const command of ["git switch --discard-changes day2-a", "git switch -f day2-a", "git checkout day2-a", "git checkout -- apps/api/src/app.ts"]) {
      expect(stop(lines(use("a", "Bash", { command })), T2), command).toMatchObject({ decision: "block" });
    }
  });

  it("gh라도 내 폴더에 파일을 쓰는 명령은 코드 변경으로 친다", () => {
    expect(stop(lines(use("a", "Bash", { command: "gh repo clone o/r apps/api/vendor" })), T2)).toMatchObject({ decision: "block" });
    expect(stop(lines(use("a", "Bash", { command: "gh run download 1 -D apps/api" })), T2)).toMatchObject({ decision: "block" });
  });

  it("한 번 막은 뒤에도 그대로면 무한히 막지 않고 그 이유를 남긴다", () => {
    const output = stop(lines(use("a", "Edit", { file_path: "a.ts" })), T1, { stop_hook_active: true });
    expect(output).not.toHaveProperty("decision");
    expect(output.systemMessage).toContain("verify");
    expect(output.systemMessage).toContain("반복");
  });

  it("세션 기록을 읽지 못하면 확인된 것으로 치지 않고 막는다", () => {
    const output = stopVerify({ transcript_path: "t" }, () => {
      throw new Error("ENOENT");
    }, () => T1);
    expect(output).toMatchObject({ decision: "block" });
  });

  it("작업 트리 지문을 만들지 못하면 확인된 것으로 치지 않고 막는다", () => {
    const text = lines(use("a", "Edit", { file_path: "a.ts" }), ...verifyRun("b", T1));
    const output = stopVerify({ transcript_path: "t" }, () => text, () => {
      throw new Error("git 없음");
    });
    expect(output).toMatchObject({ decision: "block" });
  });
});

describe("작업 트리 지문", () => {
  let repo;
  let worktreeId;
  beforeAll(async () => {
    ({ worktreeId } = await import("../../scripts/worktree-id.mjs"));
    repo = tempRepo({ "a.ts": "export const a = 1;\n", "README.md": "# x\n" });
  });
  afterAll(() => rmSync(repo.dir, { recursive: true, force: true }));

  it("코드가 바뀌면 달라지고, 커밋해도 내용이 같으면 그대로이며, 문서 변경은 무시한다", () => {
    const clean = worktreeId(repo.dir);
    repo.write("README.md", "# changed\n");
    expect(worktreeId(repo.dir)).toBe(clean);
    repo.write("a.ts", "export const a = 2;\n");
    const edited = worktreeId(repo.dir);
    expect(edited).not.toBe(clean);
    repo.write("b.ts", "export const b = 1;\n");
    const withNew = worktreeId(repo.dir);
    expect(withNew).not.toBe(edited);
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "change");
    expect(worktreeId(repo.dir)).toBe(withNew);
    expect(repo.git("status", "--porcelain")).toBe("");
  });
});

// 실습 3 Hook: 아래는 세션 기록 한 줄씩을 만드는 도우미. stop-verify 표와 같은 모양이다.
const entry = {
  command: (name, args) => JSON.stringify({ message: { role: "user", content: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>` } }),
  skillTool: (skill, args) => JSON.stringify({ message: { role: "assistant", content: [{ type: "tool_use", id: "s1", name: "Skill", input: { skill, args } }] } }),
  verifyPassed: (id, tree) => [
    JSON.stringify({ message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "npm run verify" } }] } }),
    JSON.stringify({ message: { content: [{ type: "tool_result", tool_use_id: id, content: `[verify] 전체 통과 · 작업 트리 ${tree}` }] } }),
  ],
};
const put = (dir, name, text) => {
  mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  writeFileSync(path.join(dir, name), text);
};
const prd = (status, acs) =>
  [`# x`, ``, `확정 여부: **${status}**`, ``, `## 완료 기준`, ``, `| AC | 상황 | 확인 방법 |`, `| --- | --- | --- |`, ...acs.map((n) => `| AC-${n} | 무엇 | 테스트 |`), ``].join("\n");

describe("stop-ac-tests (implement의 완료 기준 Stop Hook)", () => {
  let repo;
  let worktreeId;
  const TREE = "a".repeat(40);
  const NEW_TESTS = [
    'it("x AC-1 첫째", () => {});',
    'it.each(["a", "b"])("x AC-2 %s 둘째", (value) => {});',
    "describe(`x AC-3 셋째`, () => {});",
  ].join("\n");
  const run = (transcriptLines, { tree = TREE, active = false } = {}) =>
    stopAcTests({ transcript_path: "t", stop_hook_active: active }, { root: repo.dir, readTranscript: () => transcriptLines.join("\n"), currentTree: () => tree });
  const passed = (...before) => [entry.command("implement", "x"), ...before, ...entry.verifyPassed("v", TREE)];

  beforeAll(async () => {
    ({ worktreeId } = await import("../../scripts/worktree-id.mjs"));
    repo = tempRepo({ "README.md": "# x\n" });
    put(repo.dir, ".claude/skills/implement/SKILL.md", "---\nname: implement\n---\n");
    put(repo.dir, ".claude/skills/review/SKILL.md", "---\nname: review\n---\n");
    put(repo.dir, "docs/tasks/x/prd.md", prd("확정", [1, 2, 3]));
    // 다른 작업의 테스트. AC 번호가 같아도 slug가 달라서 이 작업의 테스트로 세지 않는다.
    put(repo.dir, "tests/other.test.ts", 'it("y AC-1 다른 작업", () => {});\nit("AC-2 slug 없는 이름", () => {});\nit("xx AC-3 비슷한 slug", () => {});\n');
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "base");
    repo.git("switch", "-q", "-c", "feat/x");
  });
  afterAll(() => rmSync(repo.dir, { recursive: true, force: true }));

  it("AC마다 이름에 'x AC-n'이 든 테스트가 있고 지금 코드로 verify가 통과했으면 끝낸다", () => {
    put(repo.dir, "tests/x.test.ts", NEW_TESTS);
    expect(run(passed())).toBeNull();
  });

  it("테스트 이름에서 AC 번호를 지우면 'AC-2에 테스트 없음'으로 돌려보낸다", () => {
    put(repo.dir, "tests/x.test.ts", NEW_TESTS.replace("x AC-2 %s", "x %s"));
    const output = run(passed());
    expect(output).toMatchObject({ decision: "block" });
    expect(output.reason).toContain("AC-2에 테스트 없음");
    expect(output.reason).not.toContain("AC-1");
  });

  it("다른 작업의 slug, slug 없는 이름, 비슷한 slug의 AC 번호는 세지 않는다", () => {
    put(repo.dir, "tests/x.test.ts", "");
    expect(run(passed()).reason).toContain("AC-1, AC-2, AC-3에 테스트 없음");
  });

  it("이미 커밋된 테스트도, 아직 커밋 안 한 새 테스트 파일도 센다(시작 브랜치에 들어 있던 작업을 이어 할 때)", () => {
    put(repo.dir, "tests/x.test.ts", 'it("x AC-1 첫째", () => {});\n');
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "AC-1");
    put(repo.dir, "apps/web/y.test.tsx", 'test("x AC-2 둘째", () => {});\ndescribe("x AC-3 셋째", () => {});\n');
    expect(run(passed())).toBeNull();
    rmSync(path.join(repo.dir, "apps"), { recursive: true, force: true });
  });

  it("verify가 없거나 verify 뒤에 코드가 바뀌었으면 돌려보낸다", () => {
    put(repo.dir, "tests/x.test.ts", NEW_TESTS);
    expect(run([entry.command("implement", "x")]).reason).toContain("전체 통과한 `npm run verify`가 없습니다");
    expect(run(passed(), { tree: "b".repeat(40) }).reason).toContain("verify` 뒤에 코드가 바뀌었습니다");
  });

  it("실제 작업 트리 지문으로도 verify 통과를 확인한다", () => {
    put(repo.dir, "tests/x.test.ts", NEW_TESTS);
    const tree = worktreeId(repo.dir);
    const output = stopAcTests(
      { transcript_path: "t" },
      { root: repo.dir, readTranscript: () => [entry.command("implement", "x"), ...entry.verifyPassed("v", tree)].join("\n"), currentTree: () => worktreeId(repo.dir) },
    );
    expect(output).toBeNull();
  });

  it("Skill 도구로 부른 implement도, 인자 없이 부른 implement(브랜치 feat/x)도 같은 작업으로 본다", () => {
    put(repo.dir, "tests/x.test.ts", NEW_TESTS.replace("x AC-3 셋째", "셋째"));
    expect(run([entry.skillTool("implement", "x"), ...entry.verifyPassed("v", TREE)]).reason).toContain("AC-3에 테스트 없음");
    expect(run([entry.command("implement", ""), ...entry.verifyPassed("v", TREE)]).reason).toContain("AC-3에 테스트 없음");
  });

  it("implement 뒤에 다른 Skill(/review)을 불렀으면 implement 차례가 아니므로 보지 않는다", () => {
    put(repo.dir, "tests/x.test.ts", "");
    expect(run([entry.command("implement", "x"), entry.command("review", "x")])).toBeNull();
    // 레포 Skill이 아닌 내장 명령(/compact 등)은 implement 차례를 끝내지 않는다.
    expect(run([entry.command("implement", "x"), entry.command("compact", "")])).toMatchObject({ decision: "block" });
  });

  it("Windows에서 CRLF로 꺼낸 PRD와 테스트 파일도 같은 AC로 읽는다", () => {
    put(repo.dir, "docs/tasks/x/prd.md", prd("확정", [1, 2, 3]).replaceAll("\n", "\r\n"));
    put(repo.dir, "tests/x.test.ts", NEW_TESTS.replace("x AC-3 셋째", "셋째").replaceAll("\n", "\r\n"));
    expect(run(passed()).reason).toContain("AC-3에 테스트 없음");
    put(repo.dir, "tests/x.test.ts", NEW_TESTS.replaceAll("\n", "\r\n"));
    expect(run(passed())).toBeNull();
    put(repo.dir, "docs/tasks/x/prd.md", prd("확정", [1, 2, 3]));
  });

  it("초안 PRD는 implement가 구현하지 않고 돌려보내는 자리라 보지 않는다", () => {
    put(repo.dir, "docs/tasks/x/prd.md", prd("초안", [1, 2, 3]));
    put(repo.dir, "tests/x.test.ts", "");
    expect(run([entry.command("implement", "x")])).toBeNull();
    put(repo.dir, "docs/tasks/x/prd.md", prd("확정", [1, 2, 3]));
  });

  it("한 번 돌려보낸 뒤에도 그대로면 무한히 막지 않고 이유를 남긴다", () => {
    put(repo.dir, "tests/x.test.ts", "");
    const output = run([entry.command("implement", "x")], { active: true });
    expect(output).not.toHaveProperty("decision");
    expect(output.systemMessage).toContain("AC-1, AC-2, AC-3에 테스트 없음");
  });

  it("작업 트리 지문을 만들지 못하면 확인된 것으로 치지 않고 막는다", () => {
    put(repo.dir, "tests/x.test.ts", NEW_TESTS);
    const output = stopAcTests(
      { transcript_path: "t" },
      { root: repo.dir, readTranscript: () => passed().join("\n"), currentTree: () => { throw new Error("git 없음"); } },
    );
    expect(output).toMatchObject({ decision: "block" });
  });
});

describe("check-review-commit (리뷰 뒤 코드가 바뀌면 PR 만들기를 막는 Hook)", () => {
  let repo;
  const create = (command) => checkReviewCommit({ tool_name: "Bash", tool_input: { command }, cwd: repo.dir });
  const CREATE = "git push -u origin HEAD && gh pr create --base day2-b --title t --body-file docs/tasks/x/run/pr.md";
  const review = (verdict, commit) => put(repo.dir, "docs/tasks/x/run/review.md", `# x 리뷰\n\n전체 판정: **${verdict}**\n검증한 커밋: ${commit} (기준 abc1234)\n`);

  beforeAll(() => {
    repo = tempRepo({ "a.ts": "export const a = 1;\n" });
    repo.git("switch", "-q", "-c", "feat/x");
  });
  afterAll(() => rmSync(repo.dir, { recursive: true, force: true }));

  it("PASS 리뷰가 지금 HEAD를 검증했으면 PR을 연다", () => {
    review("PASS", repo.git("rev-parse", "--short", "HEAD"));
    expect(create(CREATE)).toBeNull();
  });

  it("리뷰 뒤에 커밋이 생겼으면 막고 /review를 다시 돌리라고 한다", () => {
    const reviewed = repo.git("rev-parse", "--short", "HEAD");
    review("PASS", reviewed);
    repo.write("a.ts", "export const a = 2;\n");
    repo.git("commit", "-qam", "after review");
    const output = create(CREATE);
    expect(denied(output)).toBe(true);
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain(`${reviewed}를 검증했는데`);
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain("/review x");
  });

  it("review.md가 없거나 PASS가 아니면 막는다", () => {
    review("FAIL", repo.git("rev-parse", "HEAD"));
    expect(denied(create(CREATE))).toBe(true);
    rmSync(path.join(repo.dir, "docs/tasks/x/run/review.md"));
    expect(create(CREATE).hookSpecificOutput.permissionDecisionReason).toContain("review.md가 없습니다");
  });

  it("--body-file이 없으면 브랜치 feat/<slug>로 작업을 찾고, 옵션이 앞에 와도 gh pr create로 본다", () => {
    review("PASS", "0000000");
    expect(denied(create("gh pr create --fill"))).toBe(true);
    expect(denied(create("gh -R me/shop pr create --fill"))).toBe(true);
    review("PASS", repo.git("rev-parse", "HEAD"));
    expect(create("gh pr create --fill")).toBeNull();
  });

  it("gh pr create가 아닌 명령은 보지 않는다", () => {
    review("FAIL", "0000000");
    for (const command of ["gh pr checks --watch", "gh pr view 3", "git push -u origin HEAD", "echo gh pr create"]) {
      expect(create(command), command).toBeNull();
    }
  });
});

describe("subagent-evidence (검증자가 근거와 커밋 id 없이 끝내지 못하게)", () => {
  const HEAD = "1234567890abcdef1234567890abcdef12345678";
  const stop = (agent_type, last_assistant_message, extra = {}) => subagentEvidence({ agent_type, last_assistant_message, ...extra }, () => HEAD);
  const SPEC = [
    "검증한 커밋: 1234567",
    "verify: 통과  근거: evidence/verify.txt",
    "| AC | 판정 | 테스트 | 근거 |",
    "| --- | --- | --- | --- |",
    '| AC-1 | PASS | tests/x.test.ts "AC-1 ..." | evidence/spec-AC-1.txt: 1 passed |',
    "| AC-2 | FAIL | 없음 | AC-2 테스트 없음 |",
    "| AC-3 | 웹 확인 몫 | - | - |",
    "한계: 없음",
  ].join("\n");

  it("판정 줄마다 근거가 있고 검증한 커밋이 지금 HEAD면 끝낸다", () => {
    expect(stop("spec-checker", SPEC)).toBeNull();
  });

  it("근거가 빈 판정 줄이 있으면 그 줄을 짚어 돌려보낸다", () => {
    const output = stop("spec-checker", SPEC.replace("evidence/spec-AC-1.txt: 1 passed", "-"));
    expect(output).toMatchObject({ decision: "block" });
    expect(output.reason).toContain("근거가 빈 줄: AC-1");
  });

  it("검증한 커밋 줄이 없거나 지금 HEAD가 아니면 돌려보낸다", () => {
    expect(stop("spec-checker", SPEC.replace("검증한 커밋: 1234567\n", "")).reason).toContain("검증한 커밋");
    expect(stop("spec-checker", SPEC.replace("1234567", "abcdef0")).reason).toContain("지금 HEAD 1234567와 다릅니다");
  });

  it("판정 표가 없으면 돌려보내고, 웹 확인이 화면 확인 AC 없음이라고 하면 끝낸다", () => {
    expect(stop("spec-checker", "검증한 커밋: 1234567\n모두 PASS입니다.")).toMatchObject({ decision: "block" });
    expect(stop("web-checker", "검증한 커밋: 1234567\n화면 확인 AC 없음")).toBeNull();
  });

  it("웹 확인의 PASS 줄에 화면이 없으면 돌려보낸다", () => {
    const web = (screen) => `검증한 커밋: 1234567\n| AC | 판정 | 해 본 것 | 화면 |\n| AC-9 | PASS | 로그인 → 주문 취소 → "주문취소" 보임 | ${screen} |`;
    expect(stop("web-checker", web("evidence/web-AC-9.png"))).toBeNull();
    expect(stop("web-checker", web("-")).reason).toContain("근거가 빈 줄: AC-9");
  });

  it("코드 리뷰의 diff에 없는 꼭 볼 곳 줄은 근거 없이도 된다", () => {
    const review = [
      "검증한 커밋: 1234567",
      "| # | 판정 | 근거 |",
      "| 1 | 위반 없음 | evidence/grade.txt 통과 |",
      "| 항목 | 결과 | 근거 |",
      "| 결제 금액 | diff에 없음 | - |",
    ].join("\n");
    expect(stop("code-reviewer", review)).toBeNull();
    expect(stop("code-reviewer", review.replace("evidence/grade.txt 통과", "")).reason).toContain("근거가 빈 줄: 1");
  });

  it("Windows 줄바꿈(CRLF)으로 온 답도 같은 표로 읽는다", () => {
    expect(stop("spec-checker", SPEC.replaceAll("\n", "\r\n"))).toBeNull();
  });

  it("검증자가 아닌 서브에이전트는 보지 않고, 한 번 돌려보낸 뒤에는 이유만 남긴다", () => {
    expect(stop("Explore", "아무 답")).toBeNull();
    const output = stop("spec-checker", "모두 PASS", { stop_hook_active: true });
    expect(output).not.toHaveProperty("decision");
    expect(output.systemMessage).toContain("검증한 커밋");
  });
});

describe("settings.json 위험 경로 승인", () => {
  const root = path.resolve(import.meta.dirname, "..", "..");
  const settings = JSON.parse(readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));

  it("permissions.ask의 Edit 경로가 레포에 실제로 있다(경로가 틀리면 승인 창이 뜨지 않는다)", () => {
    const edits = settings.permissions.ask.filter((rule) => rule.startsWith("Edit("));
    expect(edits.length).toBeGreaterThan(0);
    for (const rule of edits) {
      const target = rule.slice("Edit(./".length, -1).replace(/\/\*\*$/, "");
      expect(existsSync(path.join(root, target)), rule).toBe(true);
    }
  });
});
