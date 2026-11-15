# <slug> 리뷰

전체 판정: **PASS | FAIL | BLOCKED**
검증한 커밋: <HEAD 커밋 id> (기준 <base 커밋 id>)
PRD: docs/tasks/<slug>/prd.md
verify: 통과 | 실패(<단계>) | 미실행  (evidence/verify.txt)

## 완료 기준

| AC | 확인 방법 | 판정 | 근거 | 화면 |
| --- | --- | --- | --- | --- |
| AC-1 | 테스트 | PASS | `tests/x.test.ts` "<slug> AC-1 ..." 1 passed (evidence/spec-AC-1.txt) | - |
| AC-2 | 화면 확인 | PASS | 해 본 순서와 보인 글자 | evidence/web-AC-2.png |

## 코드 리뷰 (docs/review-guide.md)

기본 /code-review: 불렀음 | 못 부름(<이유>)
grade: 통과 | 위반 N개 (evidence/grade.txt)

### 막을 것

| # | 판정 | 근거 |
| --- | --- | --- |

### 꼭 볼 곳

| 항목 | 결과 | 근거 |
| --- | --- | --- |

### 의견

- 

## 바뀐 파일

`git diff --stat` 요약. 돈·재고·권한 파일은 따로 표시한다.

## 한계

직접 확인하지 못한 것과 이유.
