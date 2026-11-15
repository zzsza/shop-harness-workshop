-- 0003_order_refunds: 부분 환불 기록. 주문의 결제 값(subtotal·shipping_fee·total)은 주문 당시 그대로 두고 환불을 따로 쌓는다.

CREATE TABLE order_refunds (
  id                   INTEGER PRIMARY KEY,
  order_id             INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  -- 같은 주문에 같은 키로 다시 보내면 새 환불을 만들지 않고 처음 환불을 돌려준다.
  idempotency_key      TEXT    NOT NULL,
  -- 고객에게 돌려준 금액 = 환불 상품 금액 합 - shipping_fee_charged
  amount               INTEGER NOT NULL CHECK (amount > 0),
  -- 이 환불로 남은 금액이 무료배송 기준 아래로 내려가 새로 받은 배송비
  shipping_fee_charged INTEGER NOT NULL CHECK (shipping_fee_charged >= 0),
  created_at           TEXT    NOT NULL,
  UNIQUE (order_id, idempotency_key)
);

CREATE TABLE order_refund_items (
  id         INTEGER PRIMARY KEY,
  refund_id  INTEGER NOT NULL REFERENCES order_refunds (id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products (id),
  quantity   INTEGER NOT NULL CHECK (quantity > 0),
  -- 주문 당시 단가 × 환불 수량
  line_total INTEGER NOT NULL CHECK (line_total >= 0)
);
CREATE INDEX order_refund_items_refund_id ON order_refund_items (refund_id);
