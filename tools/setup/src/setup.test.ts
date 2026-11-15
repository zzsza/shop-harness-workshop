import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "./paths.ts";
import { createFixture, TEST_PLATFORM, type Fixture } from "./test-fixture.ts";

let fixture: Fixture | null = null;
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

describe("npm run setup", () => {
  it("지원하지 않는 Node(20)면 첫 단계에서 설치 안내(Windows zip 포함)와 함께 0이 아닌 코드로 멈춘다", () => {
    fixture = createFixture();
    const fakeNode = path.join(fixture.root, "node-20.mjs");
    writeFileSync(
      fakeNode,
      'Object.defineProperty(process.versions, "node", { value: "20.11.0" });\nObject.defineProperty(process, "version", { value: "v20.11.0" });\n',
    );
    const result = fixture.run({ nodeArgs: ["--import", pathToFileURL(fakeNode).href] });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("[1/5] Node 확인: 실패");
    expect(result.stderr).toContain("v20.11.0");
    expect(result.stderr).toContain("https://nodejs.org/ko/download");
    expect(result.stderr).toContain("Windows 바이너리 .zip");
    expect(result.stderr).toContain('setup.mjs가 "Node 확인" 단계에서 멈췄습니다');
    expect(result.stdout + result.stderr).not.toContain("[2/5]");
    expect(fixture.claudeLog()).toEqual([]);
  });

  it.each([
    ["22.17.0", "실패"],
    ["22.18.0", "통과 (v22.18.0)"],
  ])("Node %s는 첫 단계가 %s", (version, outcome) => {
    fixture = createFixture();
    const fakeNode = path.join(fixture.root, `node-${version}.mjs`);
    writeFileSync(
      fakeNode,
      `Object.defineProperty(process.versions, "node", { value: "${version}" });\nObject.defineProperty(process, "version", { value: "v${version}" });\n`,
    );
    const result = fixture.run({ nodeArgs: ["--import", pathToFileURL(fakeNode).href] });

    expect(result.stdout + result.stderr).toContain(`[1/5] Node 확인: ${outcome}`);
  });

  it("24보다 새 Node(26)도 첫 단계를 통과한다", () => {
    fixture = createFixture();
    const fakeNode = path.join(fixture.root, "node-26.mjs");
    writeFileSync(
      fakeNode,
      'Object.defineProperty(process.versions, "node", { value: "26.1.0" });\nObject.defineProperty(process, "version", { value: "v26.1.0" });\n',
    );
    const result = fixture.run({ nodeArgs: ["--import", pathToFileURL(fakeNode).href] });

    expect(result.stdout).toContain("[1/5] Node 확인: 통과 (v26.1.0)");
  });

  it("claude 명령이 없으면 그 단계에서 설치 링크와 함께 0이 아닌 코드로 멈추고 아무것도 만들지 않는다", () => {
    fixture = createFixture({ claude: false });
    const result = fixture.run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("[2/5] claude 명령 확인: 실패");
    expect(result.stderr).toContain("https://code.claude.com/docs/ko/setup");
    expect(result.stderr).toContain('setup.mjs가 "claude 명령 확인" 단계에서 멈췄습니다');
    expect(result.stdout + result.stderr).not.toContain("[3/5]");
    expect(fixture.npmLog()).toEqual([]);
    expect(existsSync(path.join(fixture.repo, ".env"))).toBe(false);
  });

  it("claude --version이 실패하면 그 단계에서 설치 링크와 함께 멈춘다", () => {
    fixture = createFixture();
    fixture.env.FAKE_CLAUDE_VERSION_EXIT = "3";
    const result = fixture.run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("[2/5] claude 명령 확인: 실패");
    expect(result.stderr).toContain("종료 코드 3");
    expect(result.stderr).toContain("https://code.claude.com/docs/ko/setup");
    expect(result.stdout + result.stderr).not.toContain("[3/5]");
  });

  it("Claude Code가 2.1.69보다 옛 버전이면 그 단계에서 업데이트 안내와 함께 멈춘다", () => {
    fixture = createFixture();
    fixture.env.FAKE_CLAUDE_VERSION = "2.0.74 (Claude Code)";
    const result = fixture.run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("[2/5] claude 명령 확인: 실패");
    expect(result.stderr).toContain("Claude Code가 오래됐습니다: 2.0.74 (Claude Code)");
    expect(result.stderr).toContain("claude update");
    expect(result.stdout + result.stderr).not.toContain("[3/5]");
  });

  it("Claude Code 2.1.69는 통과한다", () => {
    fixture = createFixture();
    fixture.env.FAKE_CLAUDE_VERSION = "2.1.69 (Claude Code)";
    const result = fixture.run();

    expect(result.stdout).toContain("[2/5] claude 명령 확인: 통과 (2.1.69 (Claude Code)");
  });

  it("이미 준비된 컴퓨터에서는 모든 단계를 건너뛰고, claude는 버전만 확인하며 설정 폴더를 정하지 않는다", () => {
    fixture = createFixture();
    writeFileSync(path.join(fixture.repo, ".env"), "API_PORT=4000\n");
    const result = fixture.run();

    expect(result.status, result.stderr).toBe(0);
    for (const line of [
      "[1/5] Node 확인: 통과",
      "[2/5] claude 명령 확인: 통과 (9.9.9 (Claude Code)",
      "[3/5] 의존성: 이미 설치됨, 건너뜀",
      "[4/5] DB: 이미 있음, 건너뜀",
      "[5/5] .env: 이미 있음, 건너뜀",
    ]) {
      expect(result.stdout).toContain(line);
    }
    expect(result.stdout).toContain("npm run claude로 실습을 시작하세요");
    expect(fixture.claudeLog()).toEqual([{ args: ["--version"], configDir: null, cwd: fixture.repo }]);
    expect(fixture.npmLog()).toEqual([]);
    expect(readFileSync(path.join(fixture.repo, ".env"), "utf8")).toBe("API_PORT=4000\n");
  });

  it("처음 실행하면 의존성·DB·.env를 만들고, 다시 실행하면 모두 이미 됐다고 하며 아무것도 다시 하지 않는다", () => {
    fixture = createFixture({ database: false });
    rmSync(fixture.hiddenLockFile);

    const first = fixture.run();
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("[3/5] 의존성: 새로 설치함 (npm ci)");
    expect(first.stdout).toContain("[4/5] DB: 새로 만듦 (npm run db:reset)");
    expect(first.stdout).toContain("[5/5] .env: .env.example에서 복사함");
    expect(fixture.npmLog()).toEqual([
      { args: ["ci"], cwd: fixture.repo },
      { args: ["run", "db:reset"], cwd: fixture.repo },
    ]);
    expect(existsSync(fixture.databaseFile)).toBe(true);
    expect(readFileSync(path.join(fixture.repo, ".env"), "utf8")).toBe(readFileSync(path.join(fixture.repo, ".env.example"), "utf8"));

    const second = fixture.run();
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("[3/5] 의존성: 이미 설치됨, 건너뜀");
    expect(second.stdout).toContain("[4/5] DB: 이미 있음, 건너뜀");
    expect(second.stdout).toContain("[5/5] .env: 이미 있음, 건너뜀");
    expect(fixture.npmLog()).toHaveLength(2);
  });

  it("DB를 만들지 못하면 그 단계에서 멈추고 .env 단계로 가지 않는다", () => {
    fixture = createFixture({ database: false });
    fixture.env.FAKE_NPM_EXIT = "1";
    const result = fixture.run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("[4/5] DB: 실패");
    expect(result.stderr).toContain("npm run db:reset이 실패했습니다");
    expect(result.stderr).toContain('setup.mjs가 "DB" 단계에서 멈췄습니다');
    expect(result.stdout + result.stderr).not.toContain("[5/5]");
    expect(existsSync(path.join(fixture.repo, ".env"))).toBe(false);
  });

  describe("의존성 단계는 파일 시각이 아니라 lock 내용으로 설치 여부를 판정한다", () => {
    it("내용은 같고 시각만 바뀐 경우(압축 해제·checkout·touch)에는 npm ci를 부르지 않는다", () => {
      fixture = createFixture();
      const day = 24 * 3600;
      const now = Date.now() / 1000;
      // 압축 해제처럼 package-lock.json이 설치 기록보다 훨씬 새로워진 상태
      utimesSync(path.join(fixture.repo, "package-lock.json"), now + day, now + day);
      utimesSync(fixture.hiddenLockFile, now - 30 * day, now - 30 * day);
      const result = fixture.run();

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("[3/5] 의존성: 이미 설치됨, 건너뜀");
      expect(fixture.npmLog()).toEqual([]);
    });

    it("이 컴퓨터에 설치되지 않는 optional 바이너리가 숨은 lock에 없어도 설치된 것으로 본다", () => {
      fixture = createFixture();
      const lock = fixture.readLock();
      const skipped = Object.entries(lock.packages).filter(([, entry]) => entry.optional === true && Array.isArray(entry.os) && !entry.os.includes(TEST_PLATFORM.os));
      expect(skipped.length).toBeGreaterThan(0);
      const installed = fixture.readHiddenLock().packages;
      expect(skipped.every(([location]) => !(location in installed))).toBe(true);
      const result = fixture.run();

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("[3/5] 의존성: 이미 설치됨, 건너뜀");
      expect(fixture.npmLog()).toEqual([]);
    });

    it("설치된 패키지 버전이 package-lock.json과 다르면 npm ci를 부르고 이유를 보인다", () => {
      fixture = createFixture();
      const [location] = Object.entries(fixture.readLock().packages).find(([name, entry]) => name !== "" && entry.optional !== true && entry.resolved !== undefined) ?? [];
      if (location === undefined) throw new Error("테스트에 쓸 패키지가 package-lock.json에 없습니다.");
      fixture.editHiddenLock((packages) => {
        packages[location] = { ...packages[location], version: "0.0.1" };
      });
      const result = fixture.run();

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`${location}의 버전이`);
      expect(result.stdout).toContain("설치된 것: 0.0.1");
      expect(result.stdout).toContain("[3/5] 의존성: 새로 설치함 (npm ci)");
      expect(fixture.npmLog()).toEqual([{ args: ["ci"], cwd: fixture.repo }]);
    });

    // libc가 지정된 optional(Linux 바이너리)은 판정하지 않는다. 그 규칙은 dependencies.test.ts가 플랫폼을 넣어 확인한다.
    const hereBinary = Object.entries((JSON.parse(readFileSync(path.join(REPO_ROOT, "package-lock.json"), "utf8")) as { packages: Record<string, Record<string, unknown>> }).packages).find(
      ([, entry]) =>
        entry.optional === true &&
        entry.libc === undefined &&
        Array.isArray(entry.os) &&
        Array.isArray(entry.cpu) &&
        entry.os.includes(TEST_PLATFORM.os) &&
        entry.cpu.includes(TEST_PLATFORM.cpu),
    )?.[0];
    it.skipIf(hereBinary === undefined)("이 컴퓨터용 optional 바이너리가 빠진 node_modules(다른 OS·CPU에서 복사해 온 것)는 npm ci를 부른다", () => {
      fixture = createFixture();
      const missing = hereBinary ?? "";
      fixture.replaceHiddenLockPackages((packages) => Object.fromEntries(Object.entries(packages).filter(([name]) => name !== missing)));
      const result = fixture.run();

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(missing);
      expect(result.stdout).toContain("[3/5] 의존성: 새로 설치함 (npm ci)");
      expect(fixture.npmLog()).toEqual([{ args: ["ci"], cwd: fixture.repo }]);
    });

    it("패키지 폴더가 빠진 node_modules(압축 해제가 건너뜀)는 이유와 함께 npm ci를 부른다", () => {
      fixture = createFixture();
      const location = Object.keys(fixture.readHiddenLock().packages).find((name) => name.startsWith("node_modules/") && !name.startsWith("node_modules/zod"));
      if (location === undefined) throw new Error("테스트에 쓸 패키지가 없습니다.");
      rmSync(path.join(fixture.repo, location), { recursive: true, force: true });
      const result = fixture.run();

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`${location}/package.json이 없습니다`);
      expect(fixture.npmLog()).toEqual([{ args: ["ci"], cwd: fixture.repo }]);
    });

    it("숨은 lock이 없으면 npm ci를 부른다", () => {
      fixture = createFixture();
      rmSync(fixture.hiddenLockFile);
      const result = fixture.run();

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("node_modules/.package-lock.json이 없습니다");
      expect(result.stdout).toContain("[3/5] 의존성: 새로 설치함 (npm ci)");
      expect(fixture.npmLog()).toEqual([{ args: ["ci"], cwd: fixture.repo }]);
    });

    it("고정물에서 npm ci가 돌아도 레포의 진짜 node_modules는 그대로다", () => {
      fixture = createFixture();
      const real = path.join(REPO_ROOT, "node_modules");
      const snapshot = () => ({ entries: readdirSync(real).sort(), hidden: readFileSync(path.join(real, ".package-lock.json"), "utf8") });
      const before = snapshot();
      const fixtureModules = path.join(fixture.repo, "node_modules");
      rmSync(fixture.hiddenLockFile);
      const result = fixture.run();

      expect(result.status, result.stderr).toBe(0);
      expect(fixture.npmLog()).toEqual([{ args: ["ci"], cwd: fixture.repo }]);
      expect(snapshot()).toEqual(before);
      const links = readdirSync(fixtureModules).filter((name) => lstatSync(path.join(fixtureModules, name)).isSymbolicLink());
      expect(links).toEqual([]);
    });

    it("npm ci가 실패하면 네트워크를 확인하라는 안내와 함께 그 단계에서 멈춘다", () => {
      fixture = createFixture();
      rmSync(fixture.hiddenLockFile);
      fixture.env.FAKE_NPM_EXIT = "1";
      const result = fixture.run();

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("[3/5] 의존성: 실패");
      expect(result.stderr).toContain("네트워크(사내망 프록시·방화벽)를 확인한 뒤 다시 시도하세요");
      expect(result.stdout + result.stderr).not.toContain("[4/5]");
    });
  });
});
