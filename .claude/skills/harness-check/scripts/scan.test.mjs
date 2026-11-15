// 스캔이 확실하다고 판정하는 안티패턴은 Day1과 Day3 결과를 같은 기준으로 비교하는 바탕이라, 작은 가짜 레포로 고정해 둔다.
import { afterAll, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { scan } from "./scan.mjs";
import { loadChecklist } from "./checklist.mjs";
import { findPrevious, merge, pickTop } from "./report.mjs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-check-"));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

function makeRepo(name, files) {
  const root = path.join(temp, name);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "--no-verify", "-m", "init");
  return root;
}

function makeConfig(name, files = {}) {
  const dir = path.join(temp, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const run = (repo, config) => scan({ repo, config, sessions: "no", pain: "", outRoot: path.join(temp, "out") });

describe("잘못 쓴 하네스", () => {
  const repo = makeRepo("messy", {
    "CLAUDE.md": ["# 레포", "@docs/missing.md", "테스트는 `npm run nope`", ".env는 읽지 마", ...Array.from({ length: 210 }, (_, i) => `줄 ${i}`)].join("\n"),
    "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
    ".env": "SECRET=1\n",
    ".claude/settings.json": JSON.stringify({
      permissions: { allow: ["Bash(*)", "mcp__db"], defaultMode: "bypassPermissions" },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "node .claude/hooks/stop.mjs" }] }] },
    }),
    ".claude/hooks/stop.mjs": "process.exit(2);\n",
    ".claude/rules/api.md": "---\npaths:\n  - apps/api/**\n---\n규칙\n",
    ".claude/skills/report/SKILL.md": "---\nname: report\ndescription: 짧음\n---\n본문\n",
    ".github/workflows/ci.yml": "jobs:\n  t:\n    steps:\n      - run: npm test\n        continue-on-error: true\n",
  });
  const config = makeConfig("messy-config", { "skills/report/SKILL.md": "---\nname: report\ndescription: 주문 리포트를 만든다. 리포트가 필요할 때 쓴다.\n---\n" });

  test("확실한 안티패턴은 걸림으로 잡는다", async () => {
    const { facts } = await run(repo, config);
    const result = (id) => facts.results[id].result;
    for (const id of ["a-claude-long", "a-stale-ref", "a-env-ask-only", "a-allow-wide", "a-mcp-allow-all", "a-bypass", "a-rules-dead", "a-secret-committed", "a-skill-desc", "a-skill-dup", "a-ci-bypass"]) {
      expect([id, result(id)]).toEqual([id, "걸림"]);
    }
    expect(result("a-stop-loop")).toBe("의심");
    expect(result("verify-cmd")).toBe("일부");
    // 의심으로 남은 항목과 읽어야 정할 항목은 점검 담당에게 넘어가고, 담당은 셋을 넘지 않는다.
    const waiting = Object.values(facts.waiting).flat();
    expect(waiting).toContain("a-stop-loop");
    expect(waiting).toContain("flow-spec");
    expect(Object.keys(facts.waiting).length).toBeLessThanOrEqual(3);
  });
});

describe("잘 쓴 하네스", () => {
  const repo = makeRepo("tidy", {
    "CLAUDE.md": "# 레포\n검증은 `npm test`\n",
    "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
    "apps/api/index.ts": "export {};\n",
    ".claude/settings.json": JSON.stringify({
      permissions: { allow: ["Bash(npm test)", "mcp__db__query"], deny: ["Read(./.env*)"], ask: ["Bash(git push *)"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "node .claude/hooks/stop.mjs" }] }] },
    }),
    ".claude/hooks/stop.mjs": "const input = JSON.parse(process.argv[2] ?? '{}'); if (input.stop_hook_active) process.exit(0); process.exit(2);\n",
    ".claude/rules/api.md": "---\npaths:\n  - apps/api/**\n---\n규칙\n",
  });
  const config = makeConfig("tidy-config");

  test("같은 항목이 괜찮거나 있음으로 나온다", async () => {
    const { facts } = await run(repo, config);
    const result = (id) => facts.results[id].result;
    for (const id of ["a-claude-long", "a-stale-ref", "a-allow-wide", "a-mcp-allow-all", "a-bypass", "a-rules-dead", "a-secret-committed", "a-stop-loop"]) {
      expect([id, result(id)]).toEqual([id, "깨끗"]);
    }
    for (const id of ["guide-root", "guide-scoped", "perm-deny", "perm-ask-push", "perm-shared", "verify-cmd", "verify-hook-stop"]) {
      expect([id, result(id)]).toEqual([id, "있음"]);
    }
  });
});

describe("구조 문서의 경로", () => {
  test("앱 폴더 기준으로 줄여 쓴 경로는 있는 파일로 보고, 정말 없는 경로만 의심한다", async () => {
    const repo = makeRepo("map", {
      "apps/api/src/main.ts": "",
      "apps/api/migrations/0001.sql": "",
      "docs/architecture.md": "apps/api: `src/main.ts`, `migrations/`, `src/gone.ts`\n",
    });
    const { facts } = await run(repo, makeConfig("map-config"));
    expect(facts.results["a-map-stale"]).toMatchObject({ result: "의심", evidence: ["docs/architecture.md: `src/gone.ts` 없음"] });
  });
});

describe("지난 결과와 비교", () => {
  test("설정 폴더가 다른 지난 결과와는 비교하지 않는다", () => {
    const parent = path.join(temp, "history");
    const write = (name, configDir) => {
      fs.mkdirSync(path.join(parent, name), { recursive: true });
      fs.writeFileSync(path.join(parent, name, "facts.json"), JSON.stringify({ configDir }));
      fs.writeFileSync(path.join(parent, name, "merged.json"), JSON.stringify({ results: {} }));
    };
    write("20261115-100000", "~/.claude-workshop");
    write("20261115-110000", "~/.claude");
    const out = path.join(parent, "20261115-120000");
    expect(findPrevious(out, "~/.claude-workshop")?.name).toBe("20261115-100000");
    expect(findPrevious(out, "~/.other")).toBeNull();
  });
});

describe("보고서 합치기", () => {
  const checklist = loadChecklist();
  const facts = {
    results: Object.fromEntries(checklist.items.map((i) => [i.id, { result: i.kind === "안티" ? "깨끗" : "있음", evidence: [], note: "", by: "스캔" }])),
    waiting: { g1: ["flow-spec", "a-stop-loop"] },
  };
  facts.results["a-stop-loop"] = { result: "의심", evidence: [], note: "", by: "스캔" };
  facts.results["team-owner"] = { result: "없음", evidence: [], note: "", by: "스캔" };

  test("맡긴 항목의 허용된 값만 받는다", () => {
    const { merged, problems } = merge(checklist, facts, {
      g1: { results: [
        { id: "a-stop-loop", result: "걸림", evidence: ["a:1"], note: "탈출 조건 없음" },
        { id: "flow-spec", result: "좋음" },
        { id: "a-bypass", result: "걸림" },
      ] },
    });
    expect(merged["a-stop-loop"].result).toBe("걸림");
    expect(merged["flow-spec"].result).toBe("있음");
    expect(merged["a-bypass"].result).toBe("깨끗");
    expect(problems).toHaveLength(2);
  });

  test("먼저 고칠 곳은 잘못 쓴 곳이 빈 곳보다 앞이다", () => {
    const { merged } = merge(checklist, facts, { g1: { results: [{ id: "a-stop-loop", result: "걸림" }] } });
    expect(pickTop(checklist, merged).map((i) => i.id)).toEqual(["a-stop-loop", "team-owner"]);
  });
});
