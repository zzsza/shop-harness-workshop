import type { Clock } from "@grabmarket/shared";
import type { UnitOfWork } from "../../shared/application/unit-of-work.ts";
import { DomainError, type DomainErrorCode, notFound } from "../../shared/domain/domain-error.ts";
import { nextStatusOf, type OrderStatus, transitionStatus } from "../domain/order-status.ts";
import type { AdminOrderRow, Order, OrderRepository } from "../domain/order.ts";

export interface AdminOrderView {
  order: Order;
  /** 넘길 수 있는 다음 상태. 배송완료면 null */
  nextStatus: OrderStatus | null;
}

/** 일괄 변경에서 주문 한 건의 결과. status는 처리한 뒤 상태(없는 주문이면 null) */
export interface BulkStatusOutcome {
  orderId: number;
  ok: boolean;
  status: OrderStatus | null;
  code: DomainErrorCode | null;
}

export class AdminOrderService {
  readonly #orders: OrderRepository;
  readonly #uow: UnitOfWork;
  readonly #clock: Clock;

  constructor(orders: OrderRepository, uow: UnitOfWork, clock: Clock) {
    this.#orders = orders;
    this.#uow = uow;
    this.#clock = clock;
  }

  list(): AdminOrderRow[] {
    return this.#orders.listAll();
  }

  get(orderId: number): AdminOrderView {
    return view(this.#require(orderId));
  }

  /** 바로 다음 단계로만 넘긴다. 이미 그 상태면 아무것도 바꾸지 않는다. */
  changeStatus(orderId: number, requested: OrderStatus): AdminOrderView {
    return this.#uow.run(() => {
      const order = this.#require(orderId);
      if (order.status === requested) return view(order);
      this.#orders.saveStatus(orderId, transitionStatus(order.status, requested), this.#clock.now());
      return view(this.#require(orderId));
    });
  }

  /**
   * 여러 주문을 한 건씩 changeStatus와 같은 규칙으로 바꾼다. 주문마다 따로 트랜잭션이라
   * 한 건이 실패해도 나머지는 바뀐다. 결과는 요청한 순서대로다.
   */
  changeStatusMany(orderIds: readonly number[], requested: OrderStatus): BulkStatusOutcome[] {
    return orderIds.map((orderId) => {
      try {
        return { orderId, ok: true, status: this.changeStatus(orderId, requested).order.status, code: null };
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        return { orderId, ok: false, status: this.#orders.findById(orderId)?.status ?? null, code: error.code };
      }
    });
  }

  #require(orderId: number): Order {
    const order = this.#orders.findById(orderId);
    if (order === undefined) throw notFound("주문");
    return order;
  }
}

function view(order: Order): AdminOrderView {
  return { order, nextStatus: nextStatusOf(order.status) };
}
