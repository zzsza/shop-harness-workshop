import { ApiErrorResponseSchema, buildPath, InventoryMovementsResponseSchema, MyOrderResponseSchema, OrderResponseSchema, RefundResponseSchema, ROUTES } from "@grabmarket/contracts";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { FREE_SHIPPING_THRESHOLD, SHIPPING_FEE } from "../apps/api/src/orders/domain/shipping-fee.ts";
import { ACCOUNT, createTestApp, loginAs, orderBody, PRODUCT } from "./support/test-app.ts";

// 예시 숫자는 PRD(배송비 3,000원, 기준 30,000원)지만 기대값은 상수에서 계산한다.
type Agent = Awaited<ReturnType<typeof loginAs>>;
type Line = { productId: number; quantity: number };
const SOCKS = 5_000;
const CHARGER = 14_900;
const FEE = Number(SHIPPING_FEE);
const SOCKS_AT_THRESHOLD = Math.ceil(Number(FREE_SHIPPING_THRESHOLD) / SOCKS);

async function place(customer: Agent, items: Line[]) {
  return OrderResponseSchema.parse((await customer.post(ROUTES.orders).send(orderBody(items)).expect(201)).body).order;
}

const refundPath = (orderId: number) => buildPath(ROUTES.orderRefunds, { orderId });

async function refund(customer: Agent, orderId: number, items: Line[], status = 201) {
  return RefundResponseSchema.parse((await customer.post(refundPath(orderId)).send({ idempotencyKey: crypto.randomUUID(), items }).expect(status)).body);
}

async function refused(customer: Agent, orderId: number, items: Line[]): Promise<string> {
  return ApiErrorResponseSchema.parse((await customer.post(refundPath(orderId)).send({ idempotencyKey: crypto.randomUUID(), items }).expect(409)).body).error.code;
}

async function stockOf(admin: Agent, productId: number): Promise<number> {
  return InventoryMovementsResponseSchema.parse((await admin.get(buildPath(ROUTES.adminInventoryMovements, { productId })).expect(200)).body).item.quantity;
}

describe("부분 환불 금액", () => {
  it("partial-refund AC-1 배송비를 낸 주문은 상품 금액만 환불한다", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const order = await place(customer, [{ productId: PRODUCT.socks, quantity: 3 }]);

    expect((await refund(customer, order.id, [{ productId: PRODUCT.socks, quantity: 1 }])).refund).toMatchObject({ amount: SOCKS, shippingFeeCharged: 0 });
  });

  it("partial-refund AC-2 무료배송 주문에서 남은 금액이 기준보다 적어지면 배송비를 빼고 환불한다", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const socks = Math.ceil((Number(FREE_SHIPPING_THRESHOLD) - CHARGER) / SOCKS);
    const order = await place(customer, [
      { productId: PRODUCT.charger, quantity: 1 },
      { productId: PRODUCT.socks, quantity: socks },
    ]);

    const { refund: made } = await refund(customer, order.id, [{ productId: PRODUCT.charger, quantity: 1 }]);

    expect(made).toMatchObject({ amount: CHARGER - FEE, shippingFeeCharged: FEE, items: [{ productId: PRODUCT.charger, quantity: 1, lineTotal: CHARGER }] });
  });

  it("partial-refund AC-3 남은 금액이 무료배송 기준과 같으면 배송비를 빼지 않는다", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const order = await place(customer, [{ productId: PRODUCT.socks, quantity: SOCKS_AT_THRESHOLD + 1 }]);

    expect((await refund(customer, order.id, [{ productId: PRODUCT.socks, quantity: 1 }])).refund).toMatchObject({ amount: SOCKS, shippingFeeCharged: 0 });
  });

  it("partial-refund AC-4 기준 아래로 내려가는 환불에서 배송비를 한 번만 뺀다", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const order = await place(customer, [{ productId: PRODUCT.socks, quantity: SOCKS_AT_THRESHOLD + 1 }]);
    const one = [{ productId: PRODUCT.socks, quantity: 1 }];
    await refund(customer, order.id, one);

    expect((await refund(customer, order.id, one)).refund).toMatchObject({ amount: SOCKS - FEE, shippingFeeCharged: FEE });
    expect((await refund(customer, order.id, one)).refund).toMatchObject({ amount: SOCKS, shippingFeeCharged: 0 });
  });
});

describe("부분 환불의 재고와 주문", () => {
  it("partial-refund AC-5 환불하면 재고가 늘고 취소 복구 이력이 주문 번호와 함께 남는다", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const admin = await loginAs(app, ACCOUNT.admin);
    const order = await place(customer, [
      { productId: PRODUCT.tangerine, quantity: 2 },
      { productId: PRODUCT.charger, quantity: 1 },
    ]);

    await refund(customer, order.id, [{ productId: PRODUCT.tangerine, quantity: 1 }]);

    expect(await stockOf(admin, PRODUCT.tangerine)).toBe(9);
    const history = InventoryMovementsResponseSchema.parse((await admin.get(buildPath(ROUTES.adminInventoryMovements, { productId: PRODUCT.tangerine })).expect(200)).body);
    expect(history.movements[0]).toMatchObject({ kind: "restock", quantityDelta: 1, orderNumber: order.orderNumber });
  });

  it("partial-refund AC-6 이어진 주문 조회가 환불 수량과 금액을 보이고 결제 값은 그대로다", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const order = await place(customer, [
      { productId: PRODUCT.tangerine, quantity: 2 },
      { productId: PRODUCT.charger, quantity: 1 },
    ]);

    const { refund: made } = await refund(customer, order.id, [{ productId: PRODUCT.tangerine, quantity: 1 }]);

    const after = MyOrderResponseSchema.parse((await customer.get(buildPath(ROUTES.order, { orderId: order.id })).expect(200)).body).order;
    expect(after).toMatchObject({ status: "paid", subtotal: order.subtotal, shippingFee: order.shippingFee, total: order.total, refundedAmount: made.amount, refundable: true });
    expect(after.items.map((item) => item.refundedQuantity)).toEqual([1, 0]);
  });

  it("partial-refund AC-7 부분 환불 뒤 취소하면 남은 수량만 돌아온다", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const admin = await loginAs(app, ACCOUNT.admin);
    const order = await place(customer, [
      { productId: PRODUCT.tangerine, quantity: 2 },
      { productId: PRODUCT.charger, quantity: 1 },
    ]);
    await refund(customer, order.id, [{ productId: PRODUCT.tangerine, quantity: 1 }]);

    await customer.post(buildPath(ROUTES.orderCancel, { orderId: order.id })).expect(200);

    expect(await stockOf(admin, PRODUCT.tangerine)).toBe(10);
    expect(await stockOf(admin, PRODUCT.charger)).toBe(3);
  });

  it("partial-refund AC-8 남은 수량보다 많이, 주문에 없는 상품, 전부는 거절한다", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const admin = await loginAs(app, ACCOUNT.admin);
    const order = await place(customer, [{ productId: PRODUCT.tangerine, quantity: 2 }]);

    expect(await refused(customer, order.id, [{ productId: PRODUCT.tangerine, quantity: 3 }])).toBe("REFUND_QUANTITY_EXCEEDED");
    expect(await refused(customer, order.id, [{ productId: PRODUCT.socks, quantity: 1 }])).toBe("REFUND_QUANTITY_EXCEEDED");
    expect(await refused(customer, order.id, [{ productId: PRODUCT.tangerine, quantity: 2 }])).toBe("REFUND_ALL_ITEMS");
    expect(await stockOf(admin, PRODUCT.tangerine)).toBe(8);
  });

  it("partial-refund AC-9 배송중 주문은 부분 환불할 수 없고 refundable이 false다", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const admin = await loginAs(app, ACCOUNT.admin);
    const order = await place(customer, [{ productId: PRODUCT.tangerine, quantity: 2 }]);
    for (const status of ["preparing", "shipping"]) await admin.post(buildPath(ROUTES.adminOrderStatus, { orderId: order.id })).send({ status }).expect(200);

    expect(await refused(customer, order.id, [{ productId: PRODUCT.tangerine, quantity: 1 }])).toBe("ORDER_NOT_REFUNDABLE");
    expect(MyOrderResponseSchema.parse((await customer.get(buildPath(ROUTES.order, { orderId: order.id }))).body).order.refundable).toBe(false);
  });

  it("partial-refund AC-10 남의 주문 404, 로그인 안 함 401, 관리자 403", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const other = await loginAs(app, ACCOUNT.customerB);
    const admin = await loginAs(app, ACCOUNT.admin);
    const order = await place(customer, [{ productId: PRODUCT.tangerine, quantity: 2 }]);
    const body = { idempotencyKey: crypto.randomUUID(), items: [{ productId: PRODUCT.tangerine, quantity: 1 }] };

    await other.post(refundPath(order.id)).send(body).expect(404);
    await request(app).post(refundPath(order.id)).send(body).expect(401);
    await admin.post(refundPath(order.id)).send(body).expect(403);
  });

  it("partial-refund AC-11 같은 요청 번호는 처음 환불을 돌려주고 다른 내용이면 거절한다", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const admin = await loginAs(app, ACCOUNT.admin);
    const order = await place(customer, [{ productId: PRODUCT.tangerine, quantity: 3 }]);
    const idempotencyKey = crypto.randomUUID();
    const send = (quantity: number) => customer.post(refundPath(order.id)).send({ idempotencyKey, items: [{ productId: PRODUCT.tangerine, quantity }] });

    const first = RefundResponseSchema.parse((await send(1).expect(201)).body).refund;
    expect(RefundResponseSchema.parse((await send(1).expect(200)).body).refund).toEqual(first);
    expect(ApiErrorResponseSchema.parse((await send(2).expect(409)).body).error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await stockOf(admin, PRODUCT.tangerine)).toBe(8);
  });
});
