import type { InventoryItem } from "@grabmarket/contracts";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { installFakeApi } from "../test/fake-api.ts";
import { renderApp } from "../test/render-app.tsx";

const api = installFakeApi();

const CHARGER: InventoryItem = { productId: 2, productName: "충전기", categoryName: "전자", quantity: 3, updatedAt: "2026-11-14T03:00:00.000Z" };

describe("관리자 재고 화면의 취소 복구 이력", () => {
  it("order-cancel AC-14 입출고 이력에 취소 복구 줄이 주문 번호와 함께 늘어난 수량으로 보인다", async () => {
    api.on("GET /api/auth/me", () => ({ json: { user: { id: 1, email: "admin@grabmarket.test", name: "운영자", role: "admin", phone: null, address: null } } }));
    api.on("GET /api/admin/inventory", () => ({ json: { items: [CHARGER] } }));
    api.on("GET /api/admin/inventory/2/movements", () => ({
      json: {
        item: CHARGER,
        movements: [{ id: 2, kind: "restock", quantityDelta: 2, quantityAfter: 3, orderNumber: "GM-20261114-0007", memo: null, createdByName: null, createdAt: "2026-11-14T03:05:00.000Z" }],
      },
    }));
    renderApp("/admin/inventory");
    await userEvent.click(await screen.findByRole("button", { name: "충전기" }));

    const history = await screen.findByRole("complementary", { name: "입출고 이력" });
    expect(await within(history).findByText(/취소 복구 · 주문 GM-20261114-0007/)).toBeInTheDocument();
    expect(within(history).getByText("+2")).toBeInTheDocument();
  });
});
