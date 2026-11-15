// 숨은 채점: 이슈 3 내 주문 목록 상태 필터. 기대값은 docs/issues/3.md의 API 약속에서 왔다.
import request from "supertest";
import { describe, expect, it } from "vitest";
import { ACCOUNT, createTestApp, loginAs, orderBody, PRODUCT } from "../support/test-app.ts";

type Agent = Awaited<ReturnType<typeof loginAs>>;
interface Summary {
  id: number;
  status: string;
}

async function place(customer: Agent): Promise<number> {
  return ((await customer.post("/api/orders").send(orderBody([{ productId: PRODUCT.socks, quantity: 1 }])).expect(201)).body as { order: { id: number } }).order.id;
}

async function listed(customer: Agent, query: string): Promise<Summary[]> {
  return ((await customer.get(`/api/orders${query}`).expect(200)).body as { orders: Summary[] }).orders;
}

/** 고객 A: 결제완료 2건, 배송중 1건, 취소 1건. 고객 B: 배송중 1건. 시각은 1분씩 늦게 만든다. */
async function seeded() {
  const { app, clock } = createTestApp();
  const customer = await loginAs(app, ACCOUNT.customerA);
  const other = await loginAs(app, ACCOUNT.customerB);
  const admin = await loginAs(app, ACCOUNT.admin);
  const ids: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    ids.push(await place(customer));
    clock.advance(60_000);
  }
  const [paidOld, shipping, cancelled, paidNew] = ids as [number, number, number, number];
  for (const status of ["preparing", "shipping"]) await admin.post(`/api/admin/orders/${String(shipping)}/status`).send({ status }).expect(200);
  await customer.post(`/api/orders/${String(cancelled)}/cancel`).expect(200);
  const othersShipping = await place(other);
  for (const status of ["preparing", "shipping"]) await admin.post(`/api/admin/orders/${String(othersShipping)}/status`).send({ status }).expect(200);
  return { app, customer, paidOld, shipping, cancelled, paidNew };
}

describe("이슈 3 내 주문 목록 상태 필터", () => {
  it("status를 주면 내 주문 중 그 상태인 것만 최신순으로 준다", async () => {
    const { customer, paidOld, paidNew, shipping, cancelled } = await seeded();

    expect((await listed(customer, "?status=paid")).map((order) => order.id)).toEqual([paidNew, paidOld]);
    expect((await listed(customer, "?status=shipping")).map((order) => order.id)).toEqual([shipping]);
    expect((await listed(customer, "?status=cancelled")).map((order) => order.id)).toEqual([cancelled]);
    expect(await listed(customer, "?status=delivered")).toEqual([]);
  });

  it("status가 없으면 지금처럼 내 주문 전부를 최신순으로 준다", async () => {
    const { customer, paidOld, shipping, cancelled, paidNew } = await seeded();

    expect((await listed(customer, "")).map((order) => order.id)).toEqual([paidNew, cancelled, shipping, paidOld]);
  });

  it("없는 상태 값은 400 VALIDATION_FAILED다", async () => {
    const { customer } = await seeded();

    const refused = await customer.get("/api/orders?status=lost").expect(400);

    expect((refused.body as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
  });

  it("로그인하지 않으면 401, 관리자는 403이다", async () => {
    const { app } = await seeded();
    const admin = await loginAs(app, ACCOUNT.admin);

    await request(app).get("/api/orders?status=paid").expect(401);
    await admin.get("/api/orders?status=paid").expect(403);
  });
});
