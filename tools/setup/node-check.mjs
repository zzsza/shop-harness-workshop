// scripts/setup.mjs가 가장 먼저 부르는 Node 버전 확인.
// 지원하지 않는 Node에서도 돌아야 하므로 새 문법(import.meta.dirname 등)·TypeScript·의존성 없이 쓴다.
// 줄 모양은 tools/setup/src/report.ts와 같다.

/**
 * 실습이 기대는 가장 낮은 Node 버전. 22.18에서 .ts 파일을 그대로 실행하는 기능이 기본으로 켜졌고, node:sqlite도 22.13부터 플래그 없이 된다.
 * 그보다 옛 Node(20 등)는 .ts 실행과 node:sqlite가 없어 DB 만들기부터 멈춘다. CI는 22와 26을 돌린다.
 */
export const MIN_NODE = [22, 18];
export const MIN_NODE_TEXT = MIN_NODE.join(".");

/** process.versions.node가 MIN_NODE 이상인지. */
export function isSupportedNode(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  return major !== MIN_NODE[0] ? major > MIN_NODE[0] : minor >= MIN_NODE[1];
}

export const NODE_INSTALL_HELP = [
  `설치: https://nodejs.org/ko/download 에서 LTS(Node ${MIN_NODE_TEXT} 이상)를 받으세요.`,
  "nvm·fnm을 쓰면 레포의 .nvmrc대로 `nvm use` 또는 `fnm use`를 먼저 하세요(24를 씁니다).",
  "Windows에서 관리자 권한이 없으면: 같은 페이지에서 Windows 바이너리 .zip(x64)을 받아 C:\\Users\\<이름>\\node 같은 곳에 풀고, " +
    "'계정의 환경 변수 편집'에서 그 폴더를 사용자 Path 맨 위에 넣은 뒤 터미널을 새로 여세요.",
];

/**
 * 지원하는 Node인지 확인하고 결과 줄을 찍는다. 통과하면 true.
 * @param {string} script 멈춘 스크립트 이름(setup.mjs)
 * @param {number} total 전체 단계 수
 */
export function checkNode(script, total) {
  const name = "Node 확인";
  if (isSupportedNode()) {
    console.log(`[1/${total}] ${name}: 통과 (${process.version})`);
    return true;
  }
  console.error(`[1/${total}] ${name}: 실패`);
  console.error(`  이유: Node ${MIN_NODE_TEXT} 이상이 필요합니다. 지금은 ${process.version}입니다.`);
  for (const line of NODE_INSTALL_HELP) console.error(`  ${line}`);
  console.error(`\n${script}가 "${name}" 단계에서 멈췄습니다.`);
  return false;
}
