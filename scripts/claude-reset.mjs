// 실습 계정 초기화: npm run claude:reset [-- --yes]
// Node 확인 → 실습 설정 폴더 위치 → 확인(y/N) → 실습 계정 로그아웃 → 실습 설정 폴더(~/.claude-workshop) 지우기.
// 이 파일은 지원하지 않는 Node에서도 돌아 "Node 확인" 실패를 보여야 하므로, Node를 확인한 뒤에만 TypeScript 모듈을 불러온다.
import { checkNode } from "../tools/setup/node-check.mjs";

if (!checkNode("claude-reset.mjs", 4)) process.exit(1);

import("../tools/setup/src/reset.ts")
  .then((reset) => reset.runReset(process.argv.slice(2)))
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("claude-reset.mjs: 예상하지 못한 오류로 멈췄습니다.", error);
    process.exit(1);
  });
