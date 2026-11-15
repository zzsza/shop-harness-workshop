import type { AdminOrderRow } from "@grabmarket/contracts";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { installFakeApi } from "../test/fake-api.ts";
import { renderApp } from "../test/render-app.tsx";

const api = installFakeApi();

function row(id: number, status: AdminOrderRow["status"]): AdminOrderRow {
  return { id, orderNumber: `GM-20261114-000${String(id)}`, customerName: "김하늘", status, total: 20_000, itemCount: 1, firstItemName: "면 양말 3켤레", createdAt: "2026-11-14T03:00:00.000Z" };
}

describe("관리자 주문 일괄 상태 변경", () => {
  it("bulk-order-status AC-6 고른 주문을 바꾸면 바뀐 행의 뱃지가 바뀌고 안 넘어간 행에 이유가 보인다", async () => {
    api.on("GET /api/auth/me", () => ({ json: { user: { id: 1, email: "admin@grabmarket.test", name: "운영자", role: "admin", phone: null, address: null } } }));
    api.on("GET /api/admin/orders", () => ({ json: { orders: [row(1, "paid"), row(2, "shipping"), row(3, "paid")] } }));
    api.on("POST /api/admin/orders/bulk-status", () => ({
      json: {
        results: [
          { orderId: 1, ok: true, status: "preparing", code: null },
          { orderId: 2, ok: false, status: "shipping", code: "INVALID_STATUS_TRANSITION" },
        ],
      },
    }));
    renderApp("/admin/orders");

    await userEvent.click(await screen.findByRole("checkbox", { name: "GM-20261114-0001 선택" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "GM-20261114-0002 선택" }));
    expect(screen.getByText("2건 선택")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "선택한 주문 바꾸기" }));

    expect(await screen.findByRole("status")).toHaveTextContent("1건을 바꿨고 1건은 바꾸지 못했어요");
    expect(within(screen.getByRole("row", { name: /GM-20261114-0001/ })).getByText("배송준비")).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /GM-20261114-0002/ })).getByText("바로 다음 단계가 아니에요")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "GM-20261114-0002 선택" })).toBeChecked();
    expect(api.requests).toContain("POST /api/admin/orders/bulk-status");
  });
});
