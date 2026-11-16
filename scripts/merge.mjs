// 검사를 통과한 브랜치만 지금 브랜치에 합치기: npm run merge <브랜치>
// Node 확인 → 지금 상태 확인 → 검사(npm run ci와 같음) → 합치기(git merge --no-ff).
// 이 파일은 지원하지 않는 Node에서도 돌아 "Node 확인" 실패를 보여야 하므로, Node를 확인한 뒤에만 TypeScript 모듈을 불러온다.
import { checkNode } from "../tools/setup/node-check.mjs";

if (!checkNode("merge.mjs", 4)) process.exit(1);

import("../tools/setup/src/merge.ts")
  .then((merge) => merge.runMerge(process.argv.slice(2)))
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("merge.mjs: 예상하지 못한 오류로 멈췄습니다.", error);
    process.exit(1);
  });
