// 실습 시작: npm run claude [-- claude에 넘길 옵션...]
// Node 확인 → 실습 설정 폴더 위치 → claude 명령 → 준비 확인 → 실습 설정 폴더(~/.claude-workshop)로 claude 실행.
// 이 파일은 지원하지 않는 Node에서도 돌아 "Node 확인" 실패를 보여야 하므로, Node를 확인한 뒤에만 TypeScript 모듈을 불러온다.
import { checkNode } from "../tools/setup/node-check.mjs";

if (!checkNode("claude.mjs", 4)) process.exit(1);

import("../tools/setup/src/claude.ts")
  .then((claude) => claude.runClaude(process.argv.slice(2)))
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("claude.mjs: 예상하지 못한 오류로 멈췄습니다.", error);
    process.exit(1);
  });
