// 숨은 채점: 이슈 6 관리자 주문 일괄 상태 변경. 기대값은 docs/issues/6.md의 API 약속과
// docs/rules/03-order-status-transition.md의 상태 규칙(바로 다음 단계로만, 같은 상태는 그대로 성공)에서 왔다.
import request from "supertest";
import { describe, expect, it } from "vitest";
import { ACCOUNT, createTestApp, loginAs, NOW, orderBody, PRODUCT } from "../support/test-app.ts";

type Agent = Awaited<ReturnType<typeof loginAs>>;
interface Result {
  orderId: number;
  ok: boolean;
  status: string | null;
  code: string | null;
}

async function place(customer: Agent): Promise<number> {
  return ((await customer.post("/api/orders").send(orderBody([{ productId: PRODUCT.socks, quantity: 1 }])).expect(201)).body as { order: { id: number } }).order.id;
}

async function advance(admin: Agent, orderId: number, steps: string[]) {
  for (const status of steps) await admin.post(`/api/admin/orders/${String(orderId)}/status`).send({ status }).expect(200);
}

function bulk(agent: Agent, orderIds: number[], status: string) {
  return agent.post("/api/admin/orders/bulk-status").send({ orderIds, status });
}

/** 결과는 요청한 순서대로 한 줄씩. 줄마다 약속한 칸만 보고, 이유를 알리는 칸(message 등)을 더해도 맞다. */
function expectRows(results: Result[], expected: Result[]) {
  expect(results.map((result) => result.orderId)).toEqual(expected.map((row) => row.orderId));
  expected.forEach((row, index) => {
    expect(results[index]).toMatchObject(row);
  });
}

async function statusOf(admin: Agent, orderId: number): Promise<{ status: string; updatedAt: string }> {
  return ((await admin.get(`/api/admin/orders/${String(orderId)}`).expect(200)).body as { order: { status: string; updatedAt: string } }).order;
}

describe("이슈 6 관리자 주문 일괄 상태 변경", () => {
  it("넘길 수 있는 주문은 넘기고, 안 되는 주문은 이유 코드와 함께 요청한 순서대로 알려 준다", async () => {
    const { app, clock } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const admin = await loginAs(app, ACCOUNT.admin);
    const paid = await place(customer);
    const preparing = await place(customer);
    const shipping = await place(customer);
    const cancelled = await place(customer);
    await advance(admin, preparing, ["preparing"]);
    await advance(admin, shipping, ["preparing", "shipping"]);
    await customer.post(`/api/orders/${String(cancelled)}/cancel`).expect(200);
    clock.advance(60_000);

    const response = await bulk(admin, [shipping, paid, 999_999, cancelled, preparing], "preparing").expect(200);

    expectRows((response.body as { results: Result[] }).results, [
      { orderId: shipping, ok: false, status: "shipping", code: "INVALID_STATUS_TRANSITION" },
      { orderId: paid, ok: true, status: "preparing", code: null },
      { orderId: 999_999, ok: false, status: null, code: "NOT_FOUND" },
      { orderId: cancelled, ok: false, status: "cancelled", code: "INVALID_STATUS_TRANSITION" },
      { orderId: preparing, ok: true, status: "preparing", code: null },
    ]);
    expect(await statusOf(admin, paid)).toMatchObject({ status: "preparing", updatedAt: "2026-11-14T03:01:00.000Z" });
    expect((await statusOf(admin, shipping)).status).toBe("shipping");
    expect((await statusOf(admin, cancelled)).status).toBe("cancelled");
  });

  it("두 단계를 건너뛰거나 되돌리는 변경은 하지 않는다", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const admin = await loginAs(app, ACCOUNT.admin);
    const paid = await place(customer);
    const delivered = await place(customer);
    await advance(admin, delivered, ["preparing", "shipping", "delivered"]);

    const response = await bulk(admin, [paid, delivered], "shipping").expect(200);

    expect((response.body as { results: Result[] }).results.map((result) => [result.ok, result.code])).toEqual([
      [false, "INVALID_STATUS_TRANSITION"],
      [false, "INVALID_STATUS_TRANSITION"],
    ]);
    expect((await statusOf(admin, paid)).status).toBe("paid");
    expect((await statusOf(admin, delivered)).status).toBe("delivered");
  });

  it("관리자도 일괄 변경으로 주문을 취소 상태로 만들 수 없다", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const admin = await loginAs(app, ACCOUNT.admin);
    const paid = await place(customer);

    const response = await bulk(admin, [paid], "cancelled").expect(200);

    expectRows((response.body as { results: Result[] }).results, [{ orderId: paid, ok: false, status: "paid", code: "INVALID_STATUS_TRANSITION" }]);
    expect(await statusOf(admin, paid)).toMatchObject({ status: "paid", updatedAt: NOW });
  });

  it("같은 번호가 두 번, 빈 목록, 101건은 400이다", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const admin = await loginAs(app, ACCOUNT.admin);
    const paid = await place(customer);

    await bulk(admin, [paid, paid], "preparing").expect(400);
    await bulk(admin, [], "preparing").expect(400);
    await bulk(admin, Array.from({ length: 101 }, (_, index) => index + 1), "preparing").expect(400);
    expect((await statusOf(admin, paid)).status).toBe("paid");
  });

  it("고객은 403, 로그인하지 않으면 401이다", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const paid = await place(customer);

    await bulk(customer, [paid], "preparing").expect(403);
    await request(app).post("/api/admin/orders/bulk-status").send({ orderIds: [paid], status: "preparing" }).expect(401);
  });
});
