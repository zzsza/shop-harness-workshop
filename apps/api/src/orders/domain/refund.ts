import { type Money, multiplyMoney, sumMoney, won, ZERO_WON } from "@grabmarket/shared";
import { DomainError } from "../../shared/domain/domain-error.ts";
import { canCancel, type OrderStatus } from "./order-status.ts";
import { calculateShippingFee } from "./shipping-fee.ts";

export interface RefundLineRequest {
  productId: number;
  quantity: number;
}

export interface RefundRequest {
  idempotencyKey: string;
  items: RefundLineRequest[];
}

export interface RefundLine {
  productId: number;
  quantity: number;
  /** 주문 당시 단가 × 환불 수량 */
  lineTotal: Money;
}

export interface Refund {
  id: number;
  idempotencyKey: string;
  /** 고객에게 돌려준 금액 = 줄 합계 - shippingFeeCharged */
  amount: Money;
  /** 이 환불로 남은 금액이 무료배송 기준 아래로 내려가 새로 받은 배송비 */
  shippingFeeCharged: Money;
  items: RefundLine[];
  createdAt: Date;
}

/** 환불 계산에 필요한 주문의 모양 */
export interface RefundableOrder {
  status: OrderStatus;
  shippingFee: Money;
  items: { productId: number; productName: string; unitPrice: Money; quantity: number }[];
  refunds: Refund[];
}

export interface RefundPlan {
  amount: Money;
  shippingFeeCharged: Money;
  items: (RefundLine & { productName: string })[];
}

/** 부분 환불은 취소와 같은 상태(결제완료·배송준비)에서만 한다. */
export function canRefundStatus(status: OrderStatus): boolean {
  return canCancel(status);
}

/** 상품별로 지금까지 환불한 수량 */
export function refundedQuantity(order: Pick<RefundableOrder, "refunds">, productId: number): number {
  let total = 0;
  for (const refund of order.refunds) for (const line of refund.items) if (line.productId === productId) total += line.quantity;
  return total;
}

/** 아직 환불하지 않은 상품별 수량 */
export function remainingQuantity(order: Pick<RefundableOrder, "refunds" | "items">, productId: number): number {
  const ordered = order.items.find((item) => item.productId === productId)?.quantity ?? 0;
  return ordered - refundedQuantity(order, productId);
}

export function refundedAmount(order: Pick<RefundableOrder, "refunds">): Money {
  return sumMoney(order.refunds.map((refund) => refund.amount));
}

/** 지금 부분 환불할 수 있는지: 상태가 맞고, 하나 이상 남기고도 환불할 상품이 있어야 한다(남은 수량 합 2개 이상). */
export function isRefundable(order: RefundableOrder): boolean {
  const remaining = order.items.reduce((sum, item) => sum + remainingQuantity(order, item.productId), 0);
  return canRefundStatus(order.status) && remaining >= 2;
}

/** 같은 요청 번호의 다시 보낸 요청인지: 상품과 수량이 처음 환불과 같아야 한다. */
export function isSameRefund(refund: Refund, request: RefundRequest): boolean {
  const key = (lines: RefundLineRequest[]): string =>
    lines
      .map((line) => `${String(line.productId)}x${String(line.quantity)}`)
      .sort()
      .join(",");
  return key(refund.items) === key(request.items);
}

/**
 * 환불 금액을 정한다. 배송비 규칙은 calculateShippingFee 한 곳을 그대로 쓴다:
 * 처음 무료배송이던 주문에서 남은 상품 금액에 배송비가 붙게 되면 그 배송비를 한 번 뺀다.
 * 상태·수량·금액이 맞지 않으면 던진다.
 */
export function planRefund(order: RefundableOrder, request: RefundRequest): RefundPlan {
  if (!canRefundStatus(order.status)) throw new DomainError("ORDER_NOT_REFUNDABLE", "배송이 시작됐거나 취소된 주문은 부분 환불할 수 없습니다.");
  const items = request.items.map((line) => {
    const item = order.items.find((candidate) => candidate.productId === line.productId);
    if (item === undefined || line.quantity > remainingQuantity(order, line.productId)) {
      throw new DomainError("REFUND_QUANTITY_EXCEEDED", "환불할 수 있는 수량보다 많습니다.");
    }
    return { productId: item.productId, productName: item.productName, quantity: line.quantity, lineTotal: multiplyMoney(item.unitPrice, line.quantity) };
  });
  const left = order.items.map((item) => ({
    unitPrice: item.unitPrice,
    quantity: remainingQuantity(order, item.productId) - (items.find((line) => line.productId === item.productId)?.quantity ?? 0),
  }));
  if (left.every((item) => item.quantity === 0)) {
    throw new DomainError("REFUND_ALL_ITEMS", "모든 상품을 환불하려면 주문 취소를 이용해 주세요.");
  }
  const leftSubtotal = sumMoney(left.map((item) => multiplyMoney(item.unitPrice, item.quantity)));
  const wasFree = order.shippingFee === ZERO_WON;
  const alreadyCharged = order.refunds.some((refund) => refund.shippingFeeCharged > 0);
  const shippingFeeCharged = wasFree && !alreadyCharged ? calculateShippingFee(leftSubtotal) : ZERO_WON;
  const net = sumMoney(items.map((line) => line.lineTotal)) - shippingFeeCharged;
  if (net <= 0) throw new DomainError("REFUND_AMOUNT_NOT_POSITIVE", "배송비를 빼면 환불할 금액이 없습니다.");
  return { amount: won(net), shippingFeeCharged, items };
}
