import type { OrderDetail } from "@grabmarket/contracts";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { installFakeApi } from "../test/fake-api.ts";
import { renderApp } from "../test/render-app.tsx";

const api = installFakeApi();

function order(overrides: Partial<OrderDetail> = {}): OrderDetail {
  return {
    id: 7,
    orderNumber: "GM-20261114-0007",
    status: "paid",
    cancellable: true,
    refundable: true,
    refundedAmount: 0,
    items: [
      { productId: 1, productName: "제주 감귤 3kg", imageUrl: "/images/products/p1.webp", unitPrice: 17_900, quantity: 1, lineTotal: 17_900, refundedQuantity: 0 },
      { productId: 2, productName: "USB-C 고속 충전기 35W", imageUrl: "/images/products/p2.webp", unitPrice: 14_900, quantity: 1, lineTotal: 14_900, refundedQuantity: 0 },
    ],
    subtotal: 32_800,
    shippingFee: 0,
    total: 32_800,
    paymentMethod: "virtual",
    shipping: { recipientName: "김하늘", phone: "010-1234-5678", address: "서울특별시 한울구 새벽로 12, 302호" },
    createdAt: "2026-11-14T03:00:00.000Z",
    updatedAt: "2026-11-14T03:00:00.000Z",
    ...overrides,
  };
}

function openOrder(initial: OrderDetail) {
  api.on("GET /api/auth/me", () => ({ json: { user: { id: 2, email: "customer1@grabmarket.test", name: "김하늘", role: "customer", phone: null, address: null } } }));
  api.on("GET /api/orders/7", () => ({ json: { order: { ...initial, elapsedDays: 0 } } }));
  renderApp("/orders/7");
}

describe("내 주문 상세의 부분 환불", () => {
  it("partial-refund AC-12 부분 환불할 수 없는 주문에는 버튼이 없다", async () => {
    openOrder(order({ status: "shipping", cancellable: false, refundable: false }));
    await screen.findByRole("heading", { name: /GM-20261114-0007/ });

    expect(screen.queryByRole("button", { name: "부분 환불" })).not.toBeInTheDocument();
  });

  it("partial-refund AC-12 수량을 골라 환불하면 금액과 뺀 배송비, 상품별 환불 수량이 보인다", async () => {
    openOrder(order());
    api.on("POST /api/orders/7/refunds", ({ body }) => {
      expect(body).toMatchObject({ items: [{ productId: 2, quantity: 1 }] });
      const items = order().items.map((item) => (item.productId === 2 ? { ...item, refundedQuantity: 1 } : item));
      return {
        status: 201,
        json: {
          refund: { id: 1, amount: 11_900, shippingFeeCharged: 3_000, items: [{ productId: 2, quantity: 1, lineTotal: 14_900 }], createdAt: "2026-11-14T03:01:00.000Z" },
          order: order({ items, refundedAmount: 11_900, refundable: false }),
        },
      };
    });
    await userEvent.click(await screen.findByRole("button", { name: "부분 환불" }));

    const dialog = screen.getByRole("dialog", { name: "환불할 상품을 골라 주세요" });
    expect(within(dialog).getByRole("button", { name: "환불하기" })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("button", { name: "USB-C 고속 충전기 35W 수량 늘리기" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "환불하기" }));

    expect(await screen.findByRole("status")).toHaveTextContent("11,900원을 환불했어요. 남은 상품이 무료배송 기준보다 적어 배송비 3,000원을 뺐어요.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText(/환불 1개/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "부분 환불" })).not.toBeInTheDocument();
  });

  it("partial-refund AC-13 환불 요청이 실패하면 이유가 창에 보이고 주문은 그대로다", async () => {
    openOrder(order());
    api.on("POST /api/orders/7/refunds", () => ({ status: 409, json: { error: { code: "ORDER_NOT_REFUNDABLE", message: "배송이 시작됐거나 취소된 주문은 부분 환불할 수 없습니다." } } }));
    await userEvent.click(await screen.findByRole("button", { name: "부분 환불" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "제주 감귤 3kg 수량 늘리기" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "환불하기" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("부분 환불할 수 없습니다");
    expect(screen.queryByText(/환불 1개/)).not.toBeInTheDocument();
  });
});
