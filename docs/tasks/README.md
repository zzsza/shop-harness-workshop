# 작업 폴더

작업 하나가 폴더 하나입니다: `docs/tasks/<slug>/`.
각 Skill은 앞 단계 파일을 읽고 자기 파일을 씁니다.
문서는 쌓고 실행 결과는 버립니다.

```
docs/tasks/<slug>/
  interview.md   /interview가 씀. 커밋: 정한 결정과 이유, 비범위
  prd.md         /prd가 씀. 커밋: 완료 기준(AC-n)과 확인 방법
  run/           git에 올리지 않음(.gitignore): 그 코드 시점에만 맞는 실행 결과
    plan.md        /implement의 계획(AC 열)
    status.json    단계와 결과, 커밋 id
    review.md      /review가 합친 판정
    evidence/      테스트 출력, 화면 사진
    pr.md          PR 본문
```

PRD와 결정은 다음 작업의 입력이자 "왜 이렇게 만들었나"의 근거라 레포에 남깁니다.
계획·리뷰·PR 본문·화면 사진은 그 코드에만 맞는 값이라 커밋하지 않습니다.

## 지금 있는 작업

| 폴더 | 내용 |
| --- | --- |
| `low-stock-alert/` | 안전재고 알림 PRD(확정). 구현은 아직 없음. 이슈 1번 |
| `order-cancel/` | 주문 취소와 재고 복구. 인터뷰와 PRD(확정), 구현까지 끝난 작업 |
| `partial-refund/` | 부분 환불 인터뷰와 PRD(확정, API 모양 포함). 이슈 2번 |

배송비 규칙이 어디에 있고 바꾸면 어디가 같이 움직이는지는 `docs/shipping-fee-rule.md`에 있습니다.
