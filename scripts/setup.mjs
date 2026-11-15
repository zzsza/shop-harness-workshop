// 실습 준비: npm run setup
// Node 확인 → claude 명령 → 의존성 → DB → .env. claude는 띄우지 않는다.
// 이 파일은 지원하지 않는 Node에서도 돌아 "Node 확인" 실패를 보여야 하므로, Node를 확인한 뒤에만 TypeScript 모듈을 불러온다.
import { checkNode } from "../tools/setup/node-check.mjs";

if (!checkNode("setup.mjs", 5)) process.exit(1);

import("../tools/setup/src/setup.ts")
  .then((setup) => setup.runSetup())
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("setup.mjs: 예상하지 못한 오류로 멈췄습니다.", error);
    process.exit(1);
  });
