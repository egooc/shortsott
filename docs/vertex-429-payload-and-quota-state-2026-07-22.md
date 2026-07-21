# Vertex 429 응답 원문 + 실제 쿼터 상태 (라이브 프로브, 추측 없음)

작성일: 2026-07-22

로그엔 429 body가 저장되지 않아, 실제 Vertex 엔드포인트에 라이브 호출을 날려
응답 원문을 캡처함 (동일 project/auth/config).

## 1. 429 응답 전체 원문 (verbatim)

25개 동시 호출 버스트 → **200: 18개, 429: 7개**. 잡힌 429 body 원문:
```json
{
  "error": {
    "code": 429,
    "message": "Resource exhausted. Please try again later. Please refer to https://cloud.google.com/vertex-ai/generative-ai/docs/error-code-429 for more details.",
    "status": "RESOURCE_EXHAUSTED"
  }
}
```

- **error.status**: `RESOURCE_EXHAUSTED`
- **error.code**: `429`
- **error.message**: 위 한 줄 (generic + error-code-429 문서 링크)
- **quotaMetric**: **없음** (body에 미포함)
- **quotaId**: **없음**
- **quotaValue**: **없음**
- **retryDelay**: **없음**
- → **어느 한도(TPM/RPM/RPD)인지 응답에 안 적혀 있음.** bare RESOURCE_EXHAUSTED.

**엔드포인트/프로젝트/리전** (프로브 원문):
- PROJECT: `project-b341a363-4d35-4813-a99`
- LOCATION: `global`
- MODEL: `gemini-2.5-flash`
- ENDPOINT: `https://aiplatform.googleapis.com/v1/projects/project-b341a363-4d35-4813-a99/locations/global/publishers/google/models/gemini-2.5-flash:generateContent`
- 정상 호출과 **동일** project/location/model/auth(ADC).

## 2. 실제 쿼터 상태 → 비어있지 않음 (사용 가능)

단일 프로브 호출 (버스트 아님):
```
HTTP STATUS: 200 OK
usageMetadata.trafficType: "ON_DEMAND"     ← 핵심
finishReason: STOP
```
- **지금 단일 호출은 200으로 성공** → 쿼터가 지속 소진된 상태가 아님. **간헐적**이다.
- **`trafficType: "ON_DEMAND"`** = 프로비저닝 처리량이 아니라 **on-demand = Dynamic Shared
  Quota(DSQ)**. DSQ는 전역 공유 풀이라, 풀이 붐빌 때만 429가 나고 프로젝트별 quota metric이
  없다(위 429 body에 metric 이름이 없는 이유).
- 버스트 25개 중 7개만 429 → **동시성/순간 부하가 높을 때만 429**. 낮은 rate/단일 호출은 통과.
- **라이브 배치 잔여**: 현재 job **1개 running + 9개 queued**(script_review_live). 이들이
  돌 때 DSQ를 소비하지만, 프로젝트 한도를 "다 쓴" 상태는 아님(프로브 200).

→ **"쿼터 비었다"가 아니라, DSQ 공유 풀이 순간 붐빌 때 간헐적 RESOURCE_EXHAUSTED.**
   프로젝트/일일 한도를 hard-hit한 게 아니다.

## 3. 하이라이트 실패는 429가 아님 (검증 실패)

- 최근 하이라이트 실패 로그 원문: `highlight 포맷 실패: Gemini metadata output still contains
  invalid Japanese/Korean captions after repair attempts: highlight_metadata_ko.report_description`
  / `Gemini 최종 검증 실패: full, highlight 포맷만 실패 처리`.
- item_008 저장 상태: `highlight_generation_error: ... invalid ... captions ...
  highlight_metadata_ko.report_description`, details의 invalid field = `full_caption_script_ko: []`.
- → **하이라이트 실패 사유는 429가 아니라 한국어 자막/리뷰 메타데이터 검증 실패(content).**
  (`longform_final_highlight`의 429 22건은 롱폼 재실행에서만, 별개.)
- **최근 커밋 영향?** 없음:
  - 하이라이트 2층(2df2913): **wide 롱폼 프리셋 선택만**. 이 실패건은 shortform이라 미해당,
    `classifyHighlightHook`/`buildHighlightPresetById` byte-identical 유지.
  - rate limiter(11b8940): `throttleGeminiCall`은 콜 앞에 sleep만 추가, 검증/출력 로직 불변.
  - ja-fix(96c23cc): `validateLongformVariantFinalGuide('full')` 롱폼 full만. shortform 검증
    (validateGuide) 미변경.
  - → **내 커밋들은 shortform 하이라이트 검증에 손대지 않음.** 하이라이트 검증 실패는 한국어
    자막 content 문제(파편/무효)로, 기존 계열. 단 **DSQ 429가 repair/regeneration 콜을 죽이면
    한국어 자막을 못 고쳐 검증 실패로 이어질 수 있음**(간접). 즉 429가 원인이 아니라, 429가
    자막 수리를 방해해 검증 실패를 유발하는 연쇄는 가능.

## 산출 (질문 직접 답)

| 질문 | 응답 원문 기준 답 |
|---|---|
| 429 error.status/message | `RESOURCE_EXHAUSTED` / "Resource exhausted. Please try again later. ...error-code-429..." |
| quotaMetric/quotaId/quotaValue | **없음** (body에 미포함) |
| retryDelay | **없음** |
| project/region/endpoint | `project-b341a363-4d35-4813-a99` / `global` / gemini-2.5-flash / aiplatform.googleapis.com (정상 호출과 동일) |
| 지금 쿼터 비었나 | **아니오 — 단일 호출 200 성공.** DSQ 공유 풀 간헐적 429. 라이브 배치 1 running+9 queued 잔여 |
| 하이라이트 실패가 429인가 | **아니오 — 한국어 자막 검증 실패(content).** 내 커밋들과 무관 |
| trafficType | **ON_DEMAND (Dynamic Shared Quota)** |

## 함의

- 429 body에 metric이 없는 건 **버그가 아니라 DSQ 특성**. Vertex error-code-429 문서(429 body가
  가리키는 링크)는 ON_DEMAND/DSQ 429를 다룸: 백오프 재시도 또는 **Provisioned Throughput**으로
  전환이 정공법. 프로젝트별 "한도 상향"할 named quota가 DSQ엔 없음.
- rate limiter(콜 간격)는 **동시성/순간 부하를 낮춰 DSQ 429 확률을 줄이는** 올바른 완화책
  (버스트 25→7×429 처럼 동시성이 429를 유발하므로). 단 전역 공유 풀이라 **완전 제거는 불가**.
- 안정적 완주가 최우선이면: (a) 라이브 배치를 1개씩·간격 크게, (b) 필요 시 Provisioned
  Throughput 검토.
