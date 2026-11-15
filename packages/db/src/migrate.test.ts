import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FixedClock } from "@grabmarket/shared";
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryDatabase } from "./connection.ts";
import { loadMigrations, migrate } from "./migrate.ts";

const clock = new FixedClock("2026-11-01T00:00:00.000Z");
const tempDirs: string[] = [];

function migrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "grabmarket-migrations-"));
  tempDirs.push(dir);
  for (const [name, sql] of Object.entries(files)) writeFileSync(path.join(dir, name), sql);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("migrate", () => {
  it("0001_init으로 앱 테이블을 모두 만든다", () => {
    // 0001만 적용한다. 뒤 마이그레이션이 표를 더해도 이 테스트의 기대는 그대로다.
    const db = openMemoryDatabase();
    const init = loadMigrations().find((migration) => migration.version === 1);
    if (init === undefined) throw new Error("0001 파일이 없습니다");
    migrate(db, clock, migrationsDir({ "0001_init.sql": init.sql }));
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
      (row) => row.name,
    );
    expect(tables).toEqual([
      "categories",
      "inventory",
      "inventory_movements",
      "order_items",
      "orders",
      "products",
      "schema_migrations",
      "sessions",
      "users",
    ]);
  });

  it("적용한 번호는 다시 적용하지 않고 새 번호만 적용한다", () => {
    const db = openMemoryDatabase();
    const first = { "0001_a.sql": "CREATE TABLE a (id INTEGER);" };
    expect(migrate(db, clock, migrationsDir(first))).toEqual([1]);
    expect(migrate(db, clock, migrationsDir({ ...first, "0002_b.sql": "CREATE TABLE b (id INTEGER);" }))).toEqual([2]);
  });

  it("이미 적용한 파일의 내용이 바뀌면 멈춘다", () => {
    const db = openMemoryDatabase();
    migrate(db, clock, migrationsDir({ "0001_a.sql": "CREATE TABLE a (id INTEGER);" }));
    expect(() => migrate(db, clock, migrationsDir({ "0001_a.sql": "CREATE TABLE a (id INTEGER, name TEXT);" }))).toThrow(
      "새 번호 파일로 추가",
    );
  });

  it("실패한 마이그레이션은 되돌리고 기록하지 않는다", () => {
    const db = openMemoryDatabase();
    expect(() => migrate(db, clock, migrationsDir({ "0001_bad.sql": "CREATE TABLE ok (id INTEGER); NOT SQL;" }))).toThrow();
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE name IN ('ok', 'schema_migrations')").all();
    expect(rows).toEqual([{ name: "schema_migrations" }]);
  });

  it("order-cancel AC-15 0002는 기존 이력 행을 그대로 두고 취소 복구 종류를 받는다", () => {
    const db = openMemoryDatabase();
    const [first, second] = [1, 2].map((version) => loadMigrations().find((migration) => migration.version === version));
    if (first === undefined || second === undefined) throw new Error("0001·0002 파일이 없습니다");
    migrate(db, clock, migrationsDir({ "0001_init.sql": first.sql }));
    db.exec(`INSERT INTO categories (id, slug, name, sort_order) VALUES (1, 'food', '식품', 1);
      INSERT INTO products (id, category_id, base_key, name, description, price, image_path, created_at) VALUES (1, 1, 'k', '감귤', '설명', 1000, '/k.webp', '2026-11-01T00:00:00.000Z');
      INSERT INTO inventory (product_id, quantity, safety_stock, updated_at) VALUES (1, 10, 5, '2026-11-01T00:00:00.000Z');
      INSERT INTO inventory_movements (product_id, kind, quantity_delta, quantity_after, memo, idempotency_key, created_at) VALUES (1, 'inbound', 10, 10, '기존 입고', 'key-1', '2026-11-01T00:00:00.000Z');`);

    // 0002까지만 둔다. 뒤에 마이그레이션이 늘어도 이 테스트의 기대는 그대로다.
    expect(migrate(db, clock, migrationsDir({ "0001_init.sql": first.sql, "0002_restock_movement_kind.sql": second.sql }))).toEqual([2]);

    expect(db.prepare("SELECT kind, quantity_delta, memo, idempotency_key FROM inventory_movements").all()).toEqual([
      { kind: "inbound", quantity_delta: 10, memo: "기존 입고", idempotency_key: "key-1" },
    ]);
    db.prepare("INSERT INTO inventory_movements (product_id, kind, quantity_delta, quantity_after, created_at) VALUES (1, 'restock', 2, 12, '2026-11-02T00:00:00.000Z')").run();
    expect(() => db.prepare("INSERT INTO inventory_movements (product_id, kind, quantity_delta, quantity_after, created_at) VALUES (1, 'other', 1, 13, '2026-11-02T00:00:00.000Z')").run()).toThrow();
  });

  it("partial-refund AC-14 0003은 0002까지 적용된 DB에 환불 표를 더하고 기존 주문을 그대로 둔다", () => {
    const db = openMemoryDatabase();
    const files = Object.fromEntries(loadMigrations().filter((migration) => migration.version <= 2).map((migration) => [`${String(migration.version).padStart(4, "0")}_${migration.name}.sql`, migration.sql]));
    migrate(db, clock, migrationsDir(files));

    expect(migrate(db, clock)).toContain(3);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'order_refund%' ORDER BY name").all();
    expect(tables).toEqual([{ name: "order_refund_items" }, { name: "order_refunds" }]);
  });
});
