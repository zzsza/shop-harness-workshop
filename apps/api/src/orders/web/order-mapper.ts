import type {
  AdminOrderListResponse,
  AdminOrderResponse,
  BulkChangeOrderStatusResponse,
  MyOrderResponse,
  OrderDetail,
  OrderQuoteResponse,
  OrderResponse,
  OrderSummary,
  RefundResponse,
} from "@grabmarket/contracts";
import type { AdminOrderView, BulkStatusOutcome } from "../application/admin-order-service.ts";
import type { Quote, RefundResult } from "../application/order-service.ts";
import { isRefundable, refundedAmount, refundedQuantity } from "../domain/refund.ts";
import type { AdminOrderRow, Order } from "../domain/order.ts";
import { canCancel } from "../domain/order-status.ts";

export function toOrderDetailDto(order: Order): OrderDetail {
  return {
    id: order.id,
    orderNumber: order.number,
    status: order.status,
    cancellable: canCancel(order.status),
    refundable: isRefundable(order),
    refundedAmount: refundedAmount(order),
    items: order.items.map((item) => ({
      productId: item.productId,
      productName: item.productName,
      imageUrl: item.imagePath,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      lineTotal: item.lineTotal,
      refundedQuantity: refundedQuantity(order, item.productId),
    })),
    subtotal: order.subtotal,
    shippingFee: order.shippingFee,
    total: order.total,
    paymentMethod: order.paymentMethod,
    shipping: order.shipping,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}

export function toOrderResponse(order: Order): OrderResponse {
  return { order: toOrderDetailDto(order) };
}

/** 내 주문 상세. 경과 일수는 서비스가 계산한 값을 받는다. */
export function toMyOrderResponse(order: Order, elapsedDays: number): MyOrderResponse {
  return { order: { ...toOrderDetailDto(order), elapsedDays } };
}

/** 내 주문 목록의 한 줄 */
export function toOrderSummaryDto(order: Order): OrderSummary {
  const [first] = order.items;
  if (first === undefined) throw new Error(`주문 ${order.number}에 품목이 없습니다`);
  return {
    id: order.id,
    orderNumber: order.number,
    status: order.status,
    total: order.total,
    itemCount: order.items.length,
    firstItemName: first.productName,
    firstItemImageUrl: first.imagePath,
    createdAt: order.createdAt.toISOString(),
  };
}

export function toQuoteDto(quote: Quote): OrderQuoteResponse {
  return {
    items: quote.items.map((item) => ({
      productId: item.productId,
      productName: item.productName,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      lineTotal: item.lineTotal,
    })),
    subtotal: quote.subtotal,
    shippingFee: quote.shippingFee,
    total: quote.total,
    shortages: quote.shortages,
  };
}

export function toAdminOrderListDto(rows: AdminOrderRow[]): AdminOrderListResponse {
  return {
    orders: rows.map((row) => ({
      id: row.id,
      orderNumber: row.number,
      customerName: row.customerName,
      status: row.status,
      total: row.total,
      itemCount: row.itemCount,
      firstItemName: row.firstItemName,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

export function toAdminOrderDto({ order, nextStatus }: AdminOrderView): AdminOrderResponse {
  return { order: { ...toOrderDetailDto(order), customer: order.customer, nextStatus } };
}

export function toBulkStatusDto(outcomes: BulkStatusOutcome[]): BulkChangeOrderStatusResponse {
  return { results: outcomes.map(({ orderId, ok, status, code }) => ({ orderId, ok, status, code })) };
}

export function toRefundResponse({ refund, order }: RefundResult): RefundResponse {
  return {
    refund: {
      id: refund.id,
      amount: refund.amount,
      shippingFeeCharged: refund.shippingFeeCharged,
      items: refund.items.map((item) => ({ productId: item.productId, quantity: item.quantity, lineTotal: item.lineTotal })),
      createdAt: refund.createdAt.toISOString(),
    },
    order: toOrderDetailDto(order),
  };
}
