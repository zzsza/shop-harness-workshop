import { ApiErrorResponseSchema, MyOrderListResponseSchema, OrderResponseSchema, ROUTES } from "@grabmarket/contracts";
import { describe, expect, it } from "vitest";
import { ACCOUNT, createTestApp, loginAs, orderBody, PRODUCT } from "./support/test-app.ts";

type Agent = Awaited<ReturnType<typeof loginAs>>;

async function place(customer: Agent): Promise<number> {
  return OrderResponseSchema.parse((await customer.post(ROUTES.orders).send(orderBody([{ productId: PRODUCT.socks, quantity: 1 }])).expect(201)).body).order.id;
}

async function ids(customer: Agent, query: string): Promise<number[]> {
  return MyOrderListResponseSchema.parse((await customer.get(`${ROUTES.orders}${query}`).expect(200)).body).orders.map((order) => order.id);
}

describe("내 주문 목록 상태 필터", () => {
  it("order-status-filter AC-1 order-status-filter AC-2 status=paid는 결제완료만, status가 없으면 전부를 최신순으로 준다", async () => {
    const { app, clock } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const first = await place(customer);
    clock.advance(60_000);
    const second = await place(customer);
    clock.advance(60_000);
    const cancelled = await place(customer);
    await customer.post(`/api/orders/${String(cancelled)}/cancel`).expect(200);

    expect(await ids(customer, "?status=paid")).toEqual([second, first]);
    expect(await ids(customer, "")).toEqual([cancelled, second, first]);
  });

  it("order-status-filter AC-3 없는 상태 값은 400 VALIDATION_FAILED다", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);

    const refused = await customer.get(`${ROUTES.orders}?status=refunded`).expect(400);

    expect(ApiErrorResponseSchema.parse(refused.body).error.code).toBe("VALIDATION_FAILED");
  });

  it("order-status-filter AC-4 다른 고객의 주문은 같은 상태여도 나오지 않는다", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const other = await loginAs(app, ACCOUNT.customerB);
    await place(other);

    expect(await ids(customer, "?status=paid")).toEqual([]);
  });
});
