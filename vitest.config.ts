import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: [
            "packages/*/src/**/*.test.ts",
            "apps/api/src/**/*.test.ts",
            "tools/*/src/**/*.test.ts",
            "tests/**/*.test.ts",
            ".claude/hooks/*.test.mjs",
            ".claude/skills/**/*.test.mjs",
          ],
          exclude: ["tools/setup/**", "**/node_modules/**"],
          // 채점기·점검 테스트는 임시 git 레포를 만든다. Windows 러너에서 첫 테스트가 5초를 넘긴 적이 있어 setup과 같은 예산을 둔다.
          testTimeout: 30_000,
        },
      },
      {
        // 준비 스크립트 테스트는 자식 프로세스와 fixture를 쓴다. Windows 러너에서 한 테스트가 5초를 넘기므로 시간 예산을 따로 둔다.
        test: {
          name: "setup",
          environment: "node",
          include: ["tools/setup/src/**/*.test.ts"],
          testTimeout: 30_000,
        },
      },
      "apps/web",
    ],
  },
});
