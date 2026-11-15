# partial-refund

확정 여부: **확정**

고객이 결제완료·배송준비 상태인 내 주문에서 일부 상품만 환불받는다.
인터뷰 기록: `docs/tasks/partial-refund/interview.md`
이슈: `docs/issues/2.md`

## 문제 / 범위

여러 상품을 함께 산 고객은 하나만 환불받으려 해도 주문 전체를 취소하고 다시 주문해야 한다.

- 고객은 내 주문 상세에서 "부분 환불"을 눌러 상품별 수량을 고르고, 확인 창을 거쳐 환불한다.
- 환불 금액은 서버가 정한다: 고른 상품 금액의 합에서, 이번 환불로 새로 내야 하는 배송비를 뺀 값이다.
- 환불한 수량만큼 재고가 늘고 입출고 이력에 "취소 복구" 줄이 주문 번호와 함께 남는다.
- 주문 상세는 상품별 환불 수량과 지금까지 환불한 금액, 지금 부분 환불할 수 있는지를 서버가 계산해 담는다.

## 비범위 / 보존 동작

- 관리자 대신 환불, 환불 사유, 환불 되돌리기, 반품은 없다.
- 실제 결제 취소는 없다(교육용 가상 결제).
- 주문 상태는 바뀌지 않는다. 부분 환불한 주문도 지금처럼 다음 단계로 넘어가고, 주문 취소도 된다.
- 주문의 `subtotal`·`shippingFee`·`total`은 주문 당시 결제 값 그대로다.
- 주문 생성·견적·주문 취소·관리자 상태 변경의 응답과 기존 테스트 기대값은 그대로다.

## 결정

| ID | 결정 | 근거 |
| --- | --- | --- |
| D-1 | 부분 환불은 주문한 고객 본인만, 결제완료·배송준비 주문에서만 한다. 고객은 세션에서 정한다 | 인터뷰 D-1, `docs/rules/05-customer-id-from-session.md` |
| D-2 | 상품별로 남은 수량(주문 수량 − 이미 환불한 수량)까지 고른다 | 인터뷰 D-2 |
| D-3 | 처음 무료배송이던 주문에서 이번 환불 뒤 남은 상품 금액이 무료배송 기준보다 적어지면 배송비를 환불 금액에서 한 번 뺀다. 남은 금액이 기준과 같으면 빼지 않는다. 앞선 환불에서 이미 뺐으면 다시 빼지 않는다 | 인터뷰 D-3 |
| D-4 | 처음부터 배송비를 낸 주문은 배송비를 빼지도 돌려주지도 않는다 | 인터뷰 D-4 |
| D-5 | 배송비와 무료배송 기준은 `shipping-fee.ts`의 `SHIPPING_FEE`·`FREE_SHIPPING_THRESHOLD`에서 온다. 숫자를 다른 곳에 다시 쓰지 않는다 | 배송비 규칙은 한 곳(`docs/shipping-fee-rule.md`) |
| D-6 | 남는 상품이 없게 되는 요청은 409 `REFUND_ALL_ITEMS`. 전부는 주문 취소로 한다 | 인터뷰 D-5 |
| D-7 | 환불 금액이 0원 이하가 되는 요청은 409 `REFUND_AMOUNT_NOT_POSITIVE` | 인터뷰 D-6 |
| D-8 | 재고 복구는 `InventoryService`로만 하고, 이력 종류는 기존 `restock`(취소 복구)을 쓴다. 환불 기록과 재고 복구는 한 트랜잭션이다 | `docs/rules/01-inventory-service-only.md` |
| D-9 | 부분 환불 뒤 주문을 취소하면 남은 수량만 재고로 되돌린다 | 인터뷰 D-8 |
| D-10 | 같은 고객이 같은 `idempotencyKey`로 같은 내용을 다시 보내면 200과 처음 환불. 다른 내용이면 409 `IDEMPOTENCY_KEY_REUSED` | 인터뷰 D-9, 주문 생성과 같은 방식 |
| D-11 | 환불 기록은 새 표에 둔다. 새 번호 마이그레이션 `0003`이 필요하다 | `docs/rules/08-new-numbered-migration.md` |
| D-12 | 금액은 `Money`(정수 원)로만 계산한다 | `docs/rules/02-money-integer-won.md` |
| D-13 | 환불 시각은 주입한 `Clock`에서 온다 | `docs/rules/04-clock-injection.md` |

현재 코드에서 본 사실: 주문 취소(`OrderService.cancel`)는 주문 품목 수량 전부를 되돌린다. D-9를 지키려면 취소가 환불한 수량을 빼고 되돌려야 한다.

## API

`POST /api/orders/:orderId/refunds` (고객 로그인 필요)

요청 본문:

```json
{ "idempotencyKey": "6f1c2c1e-5b7a-4c2e-9f0e-0d6a4f2b9a11", "items": [{ "productId": 2, "quantity": 1 }] }
```

- `idempotencyKey`: 주문 생성과 같은 형식
- `items`: 1~50줄, 줄마다 `productId`와 `quantity`(1 이상 정수). 같은 상품이 두 줄이면 400 `VALIDATION_FAILED`

응답 201(새 환불), 같은 요청을 다시 보내면 200(처음 환불):

```json
{
  "refund": {
    "id": 1,
    "amount": 11900,
    "shippingFeeCharged": 3000,
    "items": [{ "productId": 2, "quantity": 1, "lineTotal": 14900 }],
    "createdAt": "2026-11-14T03:01:00.000Z"
  },
  "order": { "...": "주문 상세(아래 필드가 더해진 OrderDetail)" }
}
```

- `refund.amount` = `items`의 `lineTotal` 합 − `shippingFeeCharged`
- `refund.shippingFeeCharged`: 이번 환불로 뺀 배송비(D-3). 빼지 않았으면 0
- `refund.items[].lineTotal` = 주문 당시 단가 × 환불 수량

주문 상세(`OrderDetail`, 내 주문 상세·주문 응답·관리자 주문 상세 모두)에 더하는 필드:

| 필드 | 뜻 |
| --- | --- |
| `items[].refundedQuantity` | 그 상품을 지금까지 환불한 수량. 없으면 0 |
| `refundedAmount` | 지금까지 환불한 금액(`refund.amount`) 합. 없으면 0 |
| `refundable` | 지금 부분 환불할 수 있는지. 결제완료·배송준비이고 남은 상품 수량 합이 2개 이상이면 true |

실패:

| 상태 | 코드 | 언제 |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | 본문 형식이 틀림 |
| 401 | `UNAUTHENTICATED` | 로그인하지 않음 |
| 403 | `FORBIDDEN` | 관리자 계정 |
| 404 | `NOT_FOUND` | 없는 주문, 남의 주문 |
| 409 | `ORDER_NOT_REFUNDABLE` | 배송중·배송완료·주문취소 |
| 409 | `REFUND_QUANTITY_EXCEEDED` | 남은 수량보다 많음, 주문에 없는 상품 |
| 409 | `REFUND_ALL_ITEMS` | 환불하면 남는 상품이 없음 |
| 409 | `REFUND_AMOUNT_NOT_POSITIVE` | 환불 금액이 0원 이하 |
| 409 | `IDEMPOTENCY_KEY_REUSED` | 같은 요청 번호로 다른 내용 |

실패하면 주문·환불 기록·재고는 그대로다.

## 완료 조건

예시 숫자는 지금 규칙(배송비 3,000원, 무료배송 기준 30,000원)과 테스트 상품(감귤 17,900원, 충전기 14,900원, 양말 5,000원)으로 쓴 것이다.
테스트는 숫자를 상수에서 계산하고, 이름에 `partial-refund AC-n`을 단다.

| ID | 상황·입력 → 행동 → 관찰할 결과 | 확인 방법 |
| --- | --- | --- |
| AC-1 | 배송비를 낸 주문(양말 3개, 15,000원)에서 양말 1개를 환불하면 201, `amount` 5,000, `shippingFeeCharged` 0 | 테스트: API 통합 |
| AC-2 | 무료배송 주문(감귤 1개 + 충전기 1개, 32,800원)에서 충전기를 환불해 남은 금액(17,900원)이 기준보다 적어지면 `shippingFeeCharged` 3,000, `amount` 11,900 | 테스트: API 통합 |
| AC-3 | 무료배송 주문(양말 7개, 35,000원)에서 1개를 환불해 남은 금액이 기준과 같으면(30,000원) `shippingFeeCharged` 0, `amount` 5,000 | 테스트: API 통합(경계) |
| AC-4 | AC-3에 이어 1개를 더 환불하면 그때 `shippingFeeCharged` 3,000, `amount` 2,000이고, 또 1개를 환불하면 다시 빼지 않아 `amount` 5,000이다 | 테스트: API 통합 |
| AC-5 | 환불하면 상품별 재고가 환불 수량만큼 늘고 입출고 이력에 `restock` 줄(양수, 주문 번호)이 남는다 | 테스트: API 통합 |
| AC-6 | 응답과 이어진 주문 조회의 `items[].refundedQuantity`, `refundedAmount`, `refundable`이 환불을 반영한다. 주문의 `status`·`subtotal`·`shippingFee`·`total`은 그대로다 | 테스트: API 통합 |
| AC-7 | 부분 환불 뒤 주문을 취소하면 남은 수량만 재고로 돌아와 재고가 주문 전과 같다 | 테스트: API 통합 |
| AC-8 | 남은 수량보다 많이, 또는 주문에 없는 상품을 고르면 409 `REFUND_QUANTITY_EXCEEDED`, 남는 상품이 없게 고르면 409 `REFUND_ALL_ITEMS`. 주문과 재고는 그대로다 | 테스트: API 통합 |
| AC-9 | 배송중·배송완료·주문취소 주문은 409 `ORDER_NOT_REFUNDABLE`이고 `refundable`은 false다 | 테스트: API 통합 |
| AC-10 | 남의 주문 404, 로그인하지 않으면 401, 관리자 403. 재고는 그대로다 | 테스트: API 통합 |
| AC-11 | 같은 `idempotencyKey`로 같은 내용을 다시 보내면 200과 같은 환불이고 재고는 한 번만 늘어난다. 다른 내용이면 409 `IDEMPOTENCY_KEY_REUSED` | 테스트: API 통합 |
| AC-12 | 내 주문 상세에서 `refundable`인 주문에만 "부분 환불" 버튼이 있다. 누르면 상품별 수량을 고르는 창이 뜨고, 확인하면 환불 금액(배송비를 뺐으면 뺀 금액도)이 보이고 상품마다 환불 수량이 보인다 | 테스트: 컴포넌트 |
| AC-13 | 환불 요청이 실패하면 이유가 화면에 보이고 주문은 그대로 보인다 | 테스트: 컴포넌트 |
| AC-14 | `0003` 마이그레이션이 새 DB와 기존 DB(0002까지 적용)에서 모두 적용된다 | 테스트: `packages/db/src/migrate.test.ts` |

## 검증 범위

| 영역 | 적용 | 이유 |
| --- | --- | --- |
| tests | required | 새 API·화면·마이그레이션 테스트와 `npm run verify`(기존 테스트 기대값은 그대로) |
| api | required | 새 엔드포인트, 금액 계산, 재고 복구, 주문 응답 필드 |
| ui | required | 내 주문 상세의 부분 환불 흐름 |

## 질문

미해결 질문 없음.
