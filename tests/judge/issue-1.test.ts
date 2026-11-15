// 숨은 채점: 이슈 1 안전재고 알림. 기대값은 docs/tasks/low-stock-alert/prd.md의 AC-1~4·9에서 왔다.
// npm run judge가 이 파일을 꺼내 지금 작업 트리에 대고 돌린다. 테스트 상품의 안전재고는 모두 5다.
import request from "supertest";
import { describe, expect, it } from "vitest";
import { ACCOUNT, createTestApp, loginAs, PRODUCT } from "../support/test-app.ts";

type Agent = Awaited<ReturnType<typeof loginAs>>;
interface Item {
  productId: number;
  quantity: number;
  safetyStock?: unknown;
  lowStock?: unknown;
}

async function itemOf(admin: Agent, productId: number): Promise<Item | undefined> {
  const body = (await admin.get("/api/admin/inventory").expect(200)).body as { items: Item[] };
  return body.items.find((item) => item.productId === productId);
}

describe("이슈 1 안전재고 알림", () => {
  it.each([
    { quantity: 4, lowStock: true },
    { quantity: 5, lowStock: false },
    { quantity: 6, lowStock: false },
  ])("low-stock-alert AC-2 안전재고 5에 수량 $quantity 이면 lowStock은 $lowStock 이다", async ({ quantity, lowStock }) => {
    const { app, db } = createTestApp();
    db.prepare("UPDATE inventory SET quantity = ? WHERE product_id = ?").run(quantity, PRODUCT.tangerine);
    const admin = await loginAs(app, ACCOUNT.admin);

    expect(await itemOf(admin, PRODUCT.tangerine)).toMatchObject({ quantity, safetyStock: 5, lowStock });
  });

  it("low-stock-alert AC-3 품절 상품은 안전재고 미만이다", async () => {
    const { app } = createTestApp();
    const admin = await loginAs(app, ACCOUNT.admin);

    expect(await itemOf(admin, PRODUCT.rice)).toMatchObject({ quantity: 0, lowStock: true });
  });

  it("low-stock-alert AC-1 주문으로 안전재고 아래로 내려가면 목록에서 바로 미만이 된다", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const admin = await loginAs(app, ACCOUNT.admin);
    expect((await itemOf(admin, PRODUCT.tangerine))?.lowStock).toBe(false);

    await customer
      .post("/api/orders")
      .send({ idempotencyKey: crypto.randomUUID(), items: [{ productId: PRODUCT.tangerine, quantity: 6 }], shipping: { recipientName: "김하늘", phone: "010-1234-5678", address: "서울특별시 한울구 새벽로 12, 302호" }, paymentMethod: "virtual" })
      .expect(201);

    expect(await itemOf(admin, PRODUCT.tangerine)).toMatchObject({ quantity: 4, lowStock: true });
  });

  it("low-stock-alert AC-4 입고로 안전재고 이상이 되면 입고 응답과 목록, 이력 응답이 모두 미만이 아니다", async () => {
    const { app } = createTestApp();
    const admin = await loginAs(app, ACCOUNT.admin);
    expect(await itemOf(admin, PRODUCT.charger)).toMatchObject({ quantity: 3, lowStock: true });

    const inbound = await admin.post(`/api/admin/inventory/${String(PRODUCT.charger)}/inbound`).send({ idempotencyKey: crypto.randomUUID(), quantity: 2 }).expect(201);

    expect((inbound.body as { item: Item }).item).toMatchObject({ quantity: 5, safetyStock: 5, lowStock: false });
    expect((await itemOf(admin, PRODUCT.charger))?.lowStock).toBe(false);
    const history = await admin.get(`/api/admin/inventory/${String(PRODUCT.charger)}/movements`).expect(200);
    expect((history.body as { item: Item }).item).toMatchObject({ safetyStock: 5, lowStock: false });
  });

  it("low-stock-alert AC-9 고객과 로그인하지 않은 요청은 지금처럼 재고를 볼 수 없다", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);

    await customer.get("/api/admin/inventory").expect(403);
    await request(app).get("/api/admin/inventory").expect(401);
  });
});
