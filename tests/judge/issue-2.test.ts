// 숨은 채점: 이슈 2 부분 환불. 기대값은 docs/tasks/partial-refund/prd.md의 API 절과 AC-1~11에서 왔다.
// 배송비와 무료배송 기준은 shipping-fee.ts의 상수에서 계산한다. 기준을 바꿔도(이슈 5) 같은 경계를 본다.
import request from "supertest";
import { describe, expect, it } from "vitest";
import { FREE_SHIPPING_THRESHOLD, SHIPPING_FEE } from "../../apps/api/src/orders/domain/shipping-fee.ts";
import { ACCOUNT, createTestApp, loginAs, orderBody, PRODUCT } from "../support/test-app.ts";

type Agent = Awaited<ReturnType<typeof loginAs>>;
type Line = { productId: number; quantity: number };

const SOCKS_PRICE = 5_000;
const CHARGER_PRICE = 14_900;
const FEE = Number(SHIPPING_FEE);
const THRESHOLD = Number(FREE_SHIPPING_THRESHOLD);

interface OrderView {
  id: number;
  orderNumber: string;
  status: string;
  subtotal: number;
  shippingFee: number;
  total: number;
  refundedAmount: number;
  refundable: boolean;
  items: { productId: number; quantity: number; refundedQuantity: number }[];
}
interface RefundView {
  id: number;
  amount: number;
  shippingFeeCharged: number;
  items: { productId: number; quantity: number; lineTotal: number }[];
}

async function place(customer: Agent, items: Line[]): Promise<OrderView> {
  return ((await customer.post("/api/orders").send(orderBody(items)).expect(201)).body as { order: OrderView }).order;
}

function refund(customer: Agent, orderId: number, items: Line[], idempotencyKey: string = crypto.randomUUID()) {
  return customer.post(`/api/orders/${String(orderId)}/refunds`).send({ idempotencyKey, items });
}

async function refunded(customer: Agent, orderId: number, items: Line[]): Promise<{ refund: RefundView; order: OrderView }> {
  return (await refund(customer, orderId, items).expect(201)).body as { refund: RefundView; order: OrderView };
}

async function stockOf(admin: Agent, productId: number): Promise<number> {
  const body = (await admin.get("/api/admin/inventory").expect(200)).body as { items: { productId: number; quantity: number }[] };
  const item = body.items.find((candidate) => candidate.productId === productId);
  if (item === undefined) throw new Error(`재고 목록에 상품 ${String(productId)}이 없습니다`);
  return item.quantity;
}

const errorCode = (body: unknown) => (body as { error: { code: string } }).error.code;

/** 양말만으로 무료배송 기준을 막 넘기는 개수: 이만큼이면 기준 이상, 하나 적으면 기준 미만 */
const SOCKS_AT_THRESHOLD = Math.ceil(THRESHOLD / SOCKS_PRICE);

describe("이슈 2 부분 환불", () => {
  it("partial-refund AC-1 배송비를 낸 주문은 상품 금액만 환불하고 배송비를 빼지 않는다", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const order = await place(customer, [{ productId: PRODUCT.socks, quantity: 3 }]);
    expect(order.shippingFee).toBe(FEE);

    const { refund: made } = await refunded(customer, order.id, [{ productId: PRODUCT.socks, quantity: 1 }]);

    expect(made).toMatchObject({ amount: SOCKS_PRICE, shippingFeeCharged: 0, items: [{ productId: PRODUCT.socks, quantity: 1, lineTotal: SOCKS_PRICE }] });
  });

  it("partial-refund AC-2 무료배송 주문에서 남은 금액이 기준 아래로 떨어지면 배송비를 한 번 빼고 환불한다", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const socks = Math.ceil((THRESHOLD - CHARGER_PRICE) / SOCKS_PRICE);
    const order = await place(customer, [
      { productId: PRODUCT.charger, quantity: 1 },
      { productId: PRODUCT.socks, quantity: socks },
    ]);
    expect(order.shippingFee).toBe(0);

    const { refund: made } = await refunded(customer, order.id, [{ productId: PRODUCT.charger, quantity: 1 }]);

    expect(made).toMatchObject({ amount: CHARGER_PRICE - FEE, shippingFeeCharged: FEE });
  });

  it("partial-refund AC-3 partial-refund AC-4 남은 금액이 기준 이상이면 빼지 않고, 기준 아래로 내려갈 때 한 번만 뺀다", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const order = await place(customer, [{ productId: PRODUCT.socks, quantity: SOCKS_AT_THRESHOLD + 2 }]);
    const one = [{ productId: PRODUCT.socks, quantity: 1 }];

    // 남은 양말 SOCKS_AT_THRESHOLD + 1개: 기준 이상
    expect((await refunded(customer, order.id, one)).refund).toMatchObject({ amount: SOCKS_PRICE, shippingFeeCharged: 0 });
    // 남은 양말 SOCKS_AT_THRESHOLD개: 기준 이상(지금 규칙에서는 기준과 같다)
    expect((await refunded(customer, order.id, one)).refund).toMatchObject({ amount: SOCKS_PRICE, shippingFeeCharged: 0 });
    // 기준 아래로 내려간다
    expect((await refunded(customer, order.id, one)).refund).toMatchObject({ amount: SOCKS_PRICE - FEE, shippingFeeCharged: FEE });
    // 이미 뺐으니 다시 빼지 않는다
    const last = await refunded(customer, order.id, one);
    expect(last.refund).toMatchObject({ amount: SOCKS_PRICE, shippingFeeCharged: 0 });
    expect(last.order.refundedAmount).toBe(4 * SOCKS_PRICE - FEE);
  });

  it("partial-refund AC-5 partial-refund AC-6 환불한 수량만큼 재고와 취소 복구 이력이 남고, 주문 상세가 환불을 보이며 결제 값은 그대로다", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const admin = await loginAs(app, ACCOUNT.admin);
    const order = await place(customer, [
      { productId: PRODUCT.tangerine, quantity: 2 },
      { productId: PRODUCT.charger, quantity: 1 },
    ]);

    await refunded(customer, order.id, [{ productId: PRODUCT.tangerine, quantity: 1 }]);

    expect(await stockOf(admin, PRODUCT.tangerine)).toBe(9);
    const history = (await admin.get(`/api/admin/inventory/${String(PRODUCT.tangerine)}/movements`).expect(200)).body as {
      movements: { kind: string; quantityDelta: number; orderNumber: string | null }[];
    };
    expect(history.movements[0]).toMatchObject({ kind: "restock", quantityDelta: 1, orderNumber: order.orderNumber });
    const after = ((await customer.get(`/api/orders/${String(order.id)}`).expect(200)).body as { order: OrderView }).order;
    expect(after).toMatchObject({ status: order.status, subtotal: order.subtotal, shippingFee: order.shippingFee, total: order.total, refundable: true });
    expect(after.refundedAmount).toBeGreaterThan(0);
    expect(after.items.find((item) => item.productId === PRODUCT.tangerine)).toMatchObject({ quantity: 2, refundedQuantity: 1 });
    expect(after.items.find((item) => item.productId === PRODUCT.charger)).toMatchObject({ quantity: 1, refundedQuantity: 0 });
  });

  it("partial-refund AC-7 부분 환불 뒤 주문을 취소하면 남은 수량만 돌아와 재고가 주문 전과 같다", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const admin = await loginAs(app, ACCOUNT.admin);
    const order = await place(customer, [
      { productId: PRODUCT.tangerine, quantity: 3 },
      { productId: PRODUCT.charger, quantity: 1 },
    ]);
    await refunded(customer, order.id, [{ productId: PRODUCT.tangerine, quantity: 2 }]);

    await customer.post(`/api/orders/${String(order.id)}/cancel`).expect(200);

    expect(await stockOf(admin, PRODUCT.tangerine)).toBe(10);
    expect(await stockOf(admin, PRODUCT.charger)).toBe(3);
  });

  it("partial-refund AC-8 남은 수량보다 많이, 주문에 없는 상품, 남는 상품이 없게 고르면 거절하고 재고는 그대로다", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const admin = await loginAs(app, ACCOUNT.admin);
    const order = await place(customer, [
      { productId: PRODUCT.tangerine, quantity: 2 },
      { productId: PRODUCT.charger, quantity: 1 },
    ]);

    expect(errorCode((await refund(customer, order.id, [{ productId: PRODUCT.tangerine, quantity: 3 }]).expect(409)).body)).toBe("REFUND_QUANTITY_EXCEEDED");
    expect(errorCode((await refund(customer, order.id, [{ productId: PRODUCT.socks, quantity: 1 }]).expect(409)).body)).toBe("REFUND_QUANTITY_EXCEEDED");
    const all = [
      { productId: PRODUCT.tangerine, quantity: 2 },
      { productId: PRODUCT.charger, quantity: 1 },
    ];
    expect(errorCode((await refund(customer, order.id, all).expect(409)).body)).toBe("REFUND_ALL_ITEMS");

    expect(await stockOf(admin, PRODUCT.tangerine)).toBe(8);
    expect(await stockOf(admin, PRODUCT.charger)).toBe(2);
  });

  it("partial-refund AC-9 배송중·취소된 주문은 부분 환불할 수 없다", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const admin = await loginAs(app, ACCOUNT.admin);
    const lines = [{ productId: PRODUCT.tangerine, quantity: 2 }];
    const shipping = await place(customer, lines);
    for (const status of ["preparing", "shipping"]) await admin.post(`/api/admin/orders/${String(shipping.id)}/status`).send({ status }).expect(200);
    const cancelled = await place(customer, lines);
    await customer.post(`/api/orders/${String(cancelled.id)}/cancel`).expect(200);

    for (const order of [shipping, cancelled]) {
      expect(errorCode((await refund(customer, order.id, [{ productId: PRODUCT.tangerine, quantity: 1 }]).expect(409)).body)).toBe("ORDER_NOT_REFUNDABLE");
      expect(((await customer.get(`/api/orders/${String(order.id)}`).expect(200)).body as { order: OrderView }).order.refundable).toBe(false);
    }
  });

  it("partial-refund AC-10 남의 주문은 404, 로그인하지 않으면 401, 관리자는 403이다", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const other = await loginAs(app, ACCOUNT.customerB);
    const admin = await loginAs(app, ACCOUNT.admin);
    const order = await place(customer, [{ productId: PRODUCT.tangerine, quantity: 2 }]);
    const one = [{ productId: PRODUCT.tangerine, quantity: 1 }];

    await refund(other, order.id, one).expect(404);
    await request(app).post(`/api/orders/${String(order.id)}/refunds`).send({ idempotencyKey: crypto.randomUUID(), items: one }).expect(401);
    await refund(admin, order.id, one).expect(403);
    expect(await stockOf(admin, PRODUCT.tangerine)).toBe(8);
  });

  it("partial-refund AC-11 같은 요청 번호로 다시 보내면 처음 환불을 돌려주고 재고는 한 번만 늘어난다", async () => {
    const { app } = createTestApp();
    const customer = await loginAs(app, ACCOUNT.customerA);
    const admin = await loginAs(app, ACCOUNT.admin);
    // 4개를 사서 1개를 환불하면 2개를 더 고르는 다음 요청은 수량·남는 상품 검사에 걸리지 않는다. 요청 번호 재사용만 남는다.
    const order = await place(customer, [{ productId: PRODUCT.tangerine, quantity: 4 }]);
    const key = crypto.randomUUID();
    const one = [{ productId: PRODUCT.tangerine, quantity: 1 }];

    const first = (await refund(customer, order.id, one, key).expect(201)).body as { refund: RefundView };
    const again = (await refund(customer, order.id, one, key).expect(200)).body as { refund: RefundView };

    expect(again.refund.id).toBe(first.refund.id);
    expect(await stockOf(admin, PRODUCT.tangerine)).toBe(7);
    expect(errorCode((await refund(customer, order.id, [{ productId: PRODUCT.tangerine, quantity: 2 }], key).expect(409)).body)).toBe("IDEMPOTENCY_KEY_REUSED");
  });
});
