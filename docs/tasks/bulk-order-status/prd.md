# bulk-order-status

확정 여부: **확정**

관리자가 주문 목록에서 여러 주문을 골라 한 번에 상태를 바꾼다.
이슈: `docs/issues/6.md`

## 문제 / 범위

물류팀은 결제완료 주문 수십 건을 하나씩 열어 배송준비로 넘긴다.

- `POST /api/admin/orders/bulk-status`가 주문 여러 건을 한 건씩 같은 규칙으로 바꾸고, 주문마다 결과를 요청 순서대로 돌려준다.
- 관리자 주문 목록에 행마다 체크박스와 "N건 선택 / 바꿀 상태 / 선택한 주문 바꾸기"가 있다. 안 넘어간 주문은 그 행에 이유가 보이고 선택된 채 남는다.

## 비범위 / 보존 동작

- 한 건씩 바꾸는 `POST /api/admin/orders/:orderId/status`의 동작과 응답은 그대로다.
- 일괄 취소는 없다. 취소는 고객의 취소 요청으로만 한다.
- 전부 성공해야만 바꾸는 방식(전부 아니면 전무)은 쓰지 않는다.

## 결정

| ID | 결정 | 근거 |
| --- | --- | --- |
| D-1 | 주문마다 `AdminOrderService.changeStatus`를 그대로 부른다. 상태 규칙은 `transitionStatus` 한 곳이다 | `docs/rules/03-order-status-transition.md` |
| D-2 | 주문마다 따로 트랜잭션이다. 한 건이 실패해도 나머지는 바뀐다 | 이슈: "몇 건이 안 넘어가도 나머지는 넘어가야" |
| D-3 | 실패한 주문의 `code`는 한 건씩 바꿀 때의 오류 코드(`INVALID_STATUS_TRANSITION`, `NOT_FOUND`)다 | 이슈의 API 약속 |
| D-4 | 바뀐 시각은 주입한 `Clock`에서 온다 | `docs/rules/04-clock-injection.md` |
| D-5 | 1~100건, 같은 번호 두 번은 400 | 이슈의 API 약속 |

## 완료 조건

| ID | 상황·입력 → 행동 → 관찰할 결과 | 확인 방법 |
| --- | --- | --- |
| AC-1 | 결제완료 2건을 배송준비로 보내면 둘 다 `ok: true, status: "preparing"`이고 `updatedAt`이 지금 시각이다 | 테스트: API 통합 |
| AC-2 | 결제완료·배송중·없는 주문을 섞어 배송준비로 보내면 결제완료만 바뀌고, 배송중은 `INVALID_STATUS_TRANSITION`, 없는 주문은 `NOT_FOUND`로 요청 순서대로 돌아온다 | 테스트: API 통합 |
| AC-3 | 이미 그 상태인 주문은 `ok: true`이고 그대로다 | 테스트: API 통합 |
| AC-4 | `cancelled`로 보내면 모든 주문이 `INVALID_STATUS_TRANSITION`이다 | 테스트: API 통합 |
| AC-5 | 고객은 403, 로그인하지 않으면 401, 같은 번호 두 번·0건·101건은 400이다 | 테스트: API 통합 |
| AC-6 | 목록에서 두 건을 골라 바꾸면 바뀐 행의 뱃지가 바뀌고, 안 넘어간 행에는 이유가 보이며 결과 줄이 "1건을 바꿨고 1건은 바꾸지 못했어요"다 | 테스트: 컴포넌트 |

## 검증 범위

| 영역 | 적용 | 이유 |
| --- | --- | --- |
| tests | required | 새 API와 목록 화면 테스트, `npm run verify` |
| api | required | 새 엔드포인트 |
| ui | required | 관리자 주문 목록 |

## 질문

미해결 질문 없음.
