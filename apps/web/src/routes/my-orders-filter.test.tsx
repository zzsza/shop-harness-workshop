import type { OrderSummary } from "@grabmarket/contracts";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { installFakeApi } from "../test/fake-api.ts";
import { renderApp } from "../test/render-app.tsx";

const api = installFakeApi();

function summary(id: number, status: OrderSummary["status"]): OrderSummary {
  return {
    id,
    orderNumber: `GM-20261114-000${String(id)}`,
    status,
    total: 20_000,
    itemCount: 1,
    firstItemName: "면 양말 3켤레",
    firstItemImageUrl: "/images/products/p4.webp",
    createdAt: "2026-11-14T03:00:00.000Z",
  };
}

const ORDERS = [summary(1, "paid"), summary(2, "shipping"), summary(3, "shipping")];

function openOrders(path: string) {
  api.on("GET /api/auth/me", () => ({ json: { user: { id: 2, email: "customer1@grabmarket.test", name: "김하늘", role: "customer", phone: null, address: null } } }));
  api.on("GET /api/orders", ({ url }) => {
    const status = url.searchParams.get("status");
    return { json: { orders: status === null ? ORDERS : ORDERS.filter((order) => order.status === status) } };
  });
  renderApp(path);
}

describe("내 주문 목록 상태 필터", () => {
  it("order-status-filter AC-5 필터를 누르면 그 상태로 다시 불러오고 머리글이 상태별 건수가 된다", async () => {
    openOrders("/orders");
    expect(await screen.findByRole("heading", { name: /전체 3건/ })).toBeInTheDocument();

    await userEvent.click(within(screen.getByRole("navigation", { name: "주문 상태" })).getByRole("link", { name: "배송중" }));

    expect(await screen.findByRole("heading", { name: /배송중 2건/ })).toBeInTheDocument();
    expect(api.requests).toContain("GET /api/orders?status=shipping");
    expect(within(screen.getByRole("navigation", { name: "주문 상태" })).getByRole("link", { name: "배송중" })).toHaveAttribute("aria-current", "page");
  });

  it("order-status-filter AC-5 주소의 상태로 바로 열면 그 필터가 켜진 채로 보인다", async () => {
    openOrders("/orders?status=paid");

    expect(await screen.findByRole("heading", { name: /결제완료 1건/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "결제완료" })).toHaveAttribute("aria-current", "page");
  });

  it("order-status-filter AC-6 고른 상태의 주문이 없으면 빈 상태와 전체 보기를 보인다", async () => {
    openOrders("/orders?status=delivered");

    expect(await screen.findByText("배송완료 주문이 없어요")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "전체 보기" }));
    expect(await screen.findByRole("heading", { name: /전체 3건/ })).toBeInTheDocument();
  });
});
