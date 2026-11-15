import { AdminOrderResponseSchema, BulkChangeOrderStatusResponseSchema, buildPath, OrderResponseSchema, ROUTES } from "@grabmarket/contracts";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { ACCOUNT, createTestApp, loginAs, orderBody, PRODUCT } from "./support/test-app.ts";

type Agent = Awaited<ReturnType<typeof loginAs>>;

async function place(customer: Agent): Promise<number> {
  return OrderResponseSchema.parse((await customer.post(ROUTES.orders).send(orderBody([{ productId: PRODUCT.socks, quantity: 1 }])).expect(201)).body).order.id;
}

async function results(admin: Agent, orderIds: number[], status: string) {
  return BulkChangeOrderStatusResponseSchema.parse((await admin.post(ROUTES.adminOrderBulkStatus).send({ orderIds, status }).expect(200)).body).results;
}

async function orderOf(admin: Agent, orderId: number) {
  return AdminOrderResponseSchema.parse((await admin.get(buildPath(ROUTES.adminOrder, { orderId })).expect(200)).body).order;
}

describe("관리자 주문 일괄 상태 변경", () => {
  it("bulk-order-status AC-1 결제완료 2건을 배송준비로 보내면 둘 다 바뀌고 바뀐 시각은 지금이다", async () => {
    const { app, clock } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const admin = await loginAs(app, ACCOUNT.admin);
    const first = await place(customer);
    const second = await place(customer);
    clock.advance(120_000);

    expect(await results(admin, [first, second], "preparing")).toEqual([
      { orderId: first, ok: true, status: "preparing", code: null },
      { orderId: second, ok: true, status: "preparing", code: null },
    ]);
    expect((await orderOf(admin, first)).updatedAt).toBe("2026-11-14T03:02:00.000Z");
  });

  it("bulk-order-status AC-2 bulk-order-status AC-3 섞어 보내면 되는 것만 바꾸고 이미 그 상태인 주문은 그대로 두며 결과를 요청 순서대로 준다", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const admin = await loginAs(app, ACCOUNT.admin);
    const paid = await place(customer);
    const preparing = await place(customer);
    const shipping = await place(customer);
    await results(admin, [preparing, shipping], "preparing");
    await results(admin, [shipping], "shipping");

    expect(await results(admin, [shipping, 4_242, preparing, paid], "preparing")).toEqual([
      { orderId: shipping, ok: false, status: "shipping", code: "INVALID_STATUS_TRANSITION" },
      { orderId: 4_242, ok: false, status: null, code: "NOT_FOUND" },
      { orderId: preparing, ok: true, status: "preparing", code: null },
      { orderId: paid, ok: true, status: "preparing", code: null },
    ]);
  });

  it("bulk-order-status AC-4 취소 상태로는 보낼 수 없다", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const admin = await loginAs(app, ACCOUNT.admin);
    const paid = await place(customer);

    expect(await results(admin, [paid], "cancelled")).toEqual([{ orderId: paid, ok: false, status: "paid", code: "INVALID_STATUS_TRANSITION" }]);
    expect((await orderOf(admin, paid)).status).toBe("paid");
  });

  it("bulk-order-status AC-5 고객 403, 로그인 안 함 401, 잘못된 목록 400", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const admin = await loginAs(app, ACCOUNT.admin);
    const paid = await place(customer);

    await customer.post(ROUTES.adminOrderBulkStatus).send({ orderIds: [paid], status: "preparing" }).expect(403);
    await request(app).post(ROUTES.adminOrderBulkStatus).send({ orderIds: [paid], status: "preparing" }).expect(401);
    for (const orderIds of [[paid, paid], [], Array.from({ length: 101 }, (_, index) => index + 1)]) {
      await admin.post(ROUTES.adminOrderBulkStatus).send({ orderIds, status: "preparing" }).expect(400);
    }
  });
});
