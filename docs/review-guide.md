# 리뷰 가이드

`/review`의 코드 리뷰와 사람의 PR 리뷰가 같이 쓰는 기준입니다.
칸은 셋입니다: 막을 것, 꼭 볼 곳, 의견.
팀 기준이 바뀌면 Skill이 아니라 이 문서를 고칩니다.

## 막을 것 (위반이면 머지 불가)

이 레포의 규칙 8개입니다. 하나라도 어기면 리뷰 판정은 FAIL입니다.

| # | 막을 것 | 규칙 문서 |
| --- | --- | --- |
| 1 | 재고 수량을 `InventoryService` 밖에서 바꾼다 | [docs/rules/01-inventory-service-only.md](rules/01-inventory-service-only.md) |
| 2 | 금액을 `Money`(정수 원)가 아닌 소수·문자열로 계산한다 | [docs/rules/02-money-integer-won.md](rules/02-money-integer-won.md) |
| 3 | 주문 `status`를 orders 도메인의 전이 함수 밖에서 바꾼다 | [docs/rules/03-order-status-transition.md](rules/03-order-status-transition.md) |
| 4 | 주입받은 `Clock` 대신 `new Date()`·`Date.now()`를 쓴다 | [docs/rules/04-clock-injection.md](rules/04-clock-injection.md) |
| 5 | 고객 ID를 세션이 아닌 요청(본문·주소·쿼리)에서 얻는다 | [docs/rules/05-customer-id-from-session.md](rules/05-customer-id-from-session.md) |
| 6 | 응답 DTO를 web 계층 mapper 밖에서 만든다 | [docs/rules/06-dto-in-web-mapper.md](rules/06-dto-in-web-mapper.md) |
| 7 | `npm run verify`가 실패하거나, 기존 테스트의 기대값을 바꿔 통과시킨다 | [docs/rules/07-verify-and-fixed-expectations.md](rules/07-verify-and-fixed-expectations.md) |
| 8 | 기존 마이그레이션 파일을 고친다(DB 변경은 새 번호 파일로) | [docs/rules/08-new-numbered-migration.md](rules/08-new-numbered-migration.md) |

계층 방향(web → application → domain ← infra)을 거스르는 import도 막습니다([docs/architecture.md](architecture.md)).

## 꼭 볼 곳 (diff에 있으면 열어서 확인)

돈·재고·권한이 걸린 파일입니다. diff에 이 파일이 있으면 아래를 확인하고 결과를 적습니다.

| 영역 | 파일 | 확인할 것 |
| --- | --- | --- |
| 돈 | `apps/api/src/orders/domain/order.ts`, `shipping-fee.ts`, `packages/shared` | 금액을 서버가 계산하나, 견적과 주문이 같은 함수를 쓰나, 배송비 경계 값 |
| 재고 | `apps/api/src/inventory/` | 수량을 바꾸는 길이 `InventoryService` 하나인가, 수량이 0 아래로 가지 않나, 이력이 남나 |
| 주문 상태 | `apps/api/src/orders/domain/order-status.ts` | 새 전이가 허용 표에 있나, 끝난 상태에서 다시 바뀌지 않나 |
| 권한 | `apps/api/src/shared/web/session.ts`, `*-controller.ts` | 로그인·역할 확인이 있나, 남의 주문·데이터에 닿을 수 없나 |
| DB | `packages/db/migrations/` | 새 번호 파일인가, 기존 데이터가 깨지지 않나 |
| 취소·환불 | `apps/api/src/orders/`, `apps/api/src/inventory/` | 취소·환불은 재고 복구까지 본다: 되돌린 수량만큼 재고가 늘고 이력이 남나, 같은 요청을 두 번 보내도 한 번만 되돌리나 |

## 의견 (막지 않음)

이름, 구조, 중복, 더 단순한 방법 같은 제안입니다.
판정에 넣지 않고 "의견"으로만 적습니다.
