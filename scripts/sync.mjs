// 실습 브랜치를 원격 최신 상태로 맞추기: npm run sync [-- <브랜치>] [--yes]
// Node 확인 → 원격 받기 → 지금 상태 확인 → 확인(y/N) → 브랜치 맞추기 → DB 되돌리기.
// 이 파일은 지원하지 않는 Node에서도 돌아 "Node 확인" 실패를 보여야 하므로, Node를 확인한 뒤에만 TypeScript 모듈을 불러온다.
import { checkNode } from "../tools/setup/node-check.mjs";

if (!checkNode("sync.mjs", 5)) process.exit(1);

import("../tools/setup/src/sync.ts")
  .then((sync) => sync.runSync(process.argv.slice(2)))
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("sync.mjs: 예상하지 못한 오류로 멈췄습니다.", error);
    process.exit(1);
  });
