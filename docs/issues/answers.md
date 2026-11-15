# 이슈 정답

`npm run judge`가 이 브랜치(`day2-c-answers`)의 숨은 테스트(`tests/judge/issue-<번호>.test.ts`)를 꺼내 내 작업 트리에 대고 돌린다.
숨은 테스트는 이슈와 PRD에 적힌 약속(API 모양, 상태 규칙, 배송비 경계)만 본다. 화면 글자는 보지 않는다.

| 번호 | 이슈 | 정상 끝 | 정답 결과 | 숨은 테스트 |
| --- | --- | --- | --- | --- |
| 1 | 안전재고 알림 | 검사 초록 PR | 재고 API의 `safetyStock`·`lowStock`, 재고 화면 뱃지·알림 줄·필터 (`docs/tasks/low-stock-alert/prd.md`) | `issue-1.test.ts`: 경계(4·5·6 대 5), 품절, 주문·입고 뒤 값, 권한 |
| 2 | 부분 환불 | 검사 초록 PR | `POST /api/orders/:orderId/refunds`, 마이그레이션 `0003`, 내 주문 상세의 부분 환불 창 (`docs/tasks/partial-refund/prd.md`) | `issue-2.test.ts`: 무료배송 기준 경계(같으면 무료, 아래로 내려가면 배송비 한 번), 환불 뒤 취소의 재고, 거절 코드, 권한, 같은 요청 번호 |
| 3 | 내 주문 목록 상태 필터 | 검사 초록 PR. 2번과 같은 화면이라 같이 띄우지 않는다 | `GET /api/orders?status=`, 주소에 남는 상태 필터 (`docs/tasks/order-status-filter/prd.md`) | `issue-3.test.ts`: 상태별 목록과 순서, 없는 상태 400, 남의 주문, 권한 |
| 4 | 단골 고객 배송비 무료 | 묻고 멈춤. PR 없음 | 단골의 정의를 묻는 인터뷰 (`docs/tasks/regular-free-shipping/interview.md`) | 없음 |
| 5 | 무료배송 기준 5만 원 | 승인 대기. 사람이 승인하기 전에는 PR 없음 | `shipping-fee.ts`를 고치기 직전 승인을 기다리는 PRD (`docs/tasks/free-shipping-50000/prd.md`) | 없음. 승인해 머지해도 2번 숨은 테스트는 상수에서 경계를 계산하므로 그대로 맞다 |
| 6 | 관리자 주문 일괄 상태 변경 | 검사 초록 PR | `POST /api/admin/orders/bulk-status`, 주문 목록의 체크박스와 일괄 변경 (`docs/tasks/bulk-order-status/prd.md`) | `issue-6.test.ts`: 한 건씩 같은 전이 규칙, 부분 성공과 요청 순서, 취소로는 못 바꿈, 바뀐 시각은 Clock, 400·403·401 |

## 틀리기 쉬운 곳

- 2번: 남은 금액이 무료배송 기준과 같을 때 배송비를 빼는 것, 두 번째 환불에서 배송비를 또 빼는 것, 부분 환불 뒤 주문 취소가 처음 수량을 통째로 되돌리는 것.
- 2번: 기존 `migrate.test.ts`의 기대를 고쳐 새 마이그레이션을 끼우는 것. 이 브랜치의 시작점은 그 테스트가 적용할 마이그레이션을 직접 고르게 해 두었다.
- 6번: 일괄 변경만 따로 상태를 대입해 두 단계 건너뛰기나 취소를 허용하는 것. 한 건씩 바꾸는 서비스의 전이 함수를 그대로 거쳐야 한다.
- 4번: 단골을 "주문 N건 이상"처럼 에이전트가 정해 버리는 것.
