// npm run db:new-migration -- <이름> <SQL 파일>
// 새 마이그레이션을 만드는 유일한 통로다. migrations 폴더 밖에 써 둔 SQL 초안을 다음 번호 파일로 옮긴다.
// 이미 있는 번호 파일은 덮어쓰지 않으므로, 이 통로로는 기존 마이그레이션을 고칠 수 없다.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "packages", "db", "migrations");
// packages/db/src/migrate.ts의 파일 이름 규칙과 같다.
const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const USAGE = [
  "사용법: npm run db:new-migration -- <이름> <SQL 파일>",
  "예: npm run db:new-migration -- add_order_memo tmp/add_order_memo.sql",
].join("\n");

function fail(message) {
  console.error(`${message}\n${USAGE}`);
  process.exit(1);
}

const [name, draft, ...extra] = process.argv.slice(2);
if (name === undefined || draft === undefined || extra.length > 0) fail("이름과 SQL 파일, 두 개를 주세요.");
if (!/^[a-z0-9_]+$/.test(name)) fail(`이름은 영어 소문자 · 숫자 · _만 씁니다: ${name}`);

// npm은 레포 맨 위에서 스크립트를 돌린다. 상대 경로는 명령을 친 폴더(INIT_CWD) 기준으로 읽는다.
const draftPath = path.resolve(process.env.INIT_CWD ?? process.cwd(), draft);
if (path.dirname(draftPath) === MIGRATIONS_DIR) fail("SQL 초안은 migrations 폴더 밖에 두세요.");
if (!existsSync(draftPath)) fail(`SQL 파일이 없습니다: ${draft}`);
const sql = readFileSync(draftPath, "utf8");
if (sql.trim() === "") fail(`SQL 파일이 비었습니다: ${draft}`);

const versions = readdirSync(MIGRATIONS_DIR).flatMap((file) => {
  const version = FILE_PATTERN.exec(file)?.[1];
  return version === undefined ? [] : [Number(version)];
});
const file = `${String(Math.max(0, ...versions) + 1).padStart(4, "0")}_${name}.sql`;
// wx: 같은 이름 파일이 이미 있으면 쓰지 않고 실패한다.
writeFileSync(path.join(MIGRATIONS_DIR, file), sql.endsWith("\n") ? sql : `${sql}\n`, { flag: "wx" });
rmSync(draftPath);

console.log(`새 마이그레이션을 만들었습니다: packages/db/migrations/${file}`);
console.log(`초안(${draft})은 옮겼으니 지웠습니다. 서버를 다시 켜면(npm run dev) 이 번호가 적용됩니다.`);
