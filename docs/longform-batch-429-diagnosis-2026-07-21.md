# 400초 배치만 429 나는 이유 (읽기 전용)

작성일: 2026-07-21

코드 원문 + job 로그(job_20260721123827_c6b440, 400초 3개) 인용.

## 산출 (결론)

**per-request 토큰 폭발이 아니라, 400초 롱폼 배치의 높은 호출 볼륨 + 429 재시도 누적이
프로젝트/리전 per-minute 쿼터를 순간적으로 소진해서 429가 난다.** 숏폼과 같은
프로젝트/인증/엔드포인트를 쓰고, video 첨부 단계는 이미 `mediaResolution: LOW`가 적용돼
있다. 즉 "Vertex 자체는 정상"인데 이 배치만 429는 **self-inflicted rate**다.

## 1. 429 페이로드 / metric / 엔드포인트

- **quota metric 이름 없음**: 코드 주석(geminiService.js:18-22) — "Gemini's 429 body
  carries no quota-metric name or ...". job 로그에도 429/RESOURCE_EXHAUSTED/quota/metric
  상세 라인 **0건**. → **TPM/RPM/RPD 중 무엇인지 payload로 특정 불가**(bare 429).
- **엔드포인트**: Vertex ADC `https://{location}-aiplatform.googleapis.com/v1/projects/
  {project}/locations/{location}/publishers/google/models/gemini-2.5-flash:generateContent`
  (buildVertexEndpoint, processMetadataService.js:863). location = `PROCESS_METADATA_VERTEX_LOCATION`
  / `GEMINI_VERTEX_LOCATION` / 기본 `global`.
- **다른 정상 호출과 같은 인증/프로젝트인가**: **같다.** 롱폼도 숏폼도 동일 `generateJson`
  (동일 Vertex ADC 토큰, 동일 project/location, 동일 gemini-2.5-flash)를 탄다. 429는
  다른 프로젝트/엔드포인트 문제가 아니라 같은 쿼터를 더 세게 때려서 난다.

## 2. 호출 패턴 (self-inflicted rate)

400초 배치(3개) job의 `요청 시작`(호출 시도) 42회 / 37분. phase별:
```
 12  longform_final_full          (text-only, 대부분 429 재시도)
  9  full_caption_script_regeneration  (text-only, 한국어 파편 재생성)
  8  longform_final_highlight     (text-only)
  8  longform_full_window         (video 첨부, LOW)
  5  longform_highlight_window    (video 첨부, LOW)
```
(+ 별도 scene 분석 호출 = video 첨부, LOW.)

- **롱폼 항목 1개당 호출 수가 숏폼보다 훨씬 많다**: scene → candidate → highlight_window
  → highlight_final → full_window → full_final → (한국어 파편 재생성 ×N) → midform...
  ≈ 10~15콜. 숏폼은 scene → metadata → review ≈ 3~5콜. **3~4배.**
- **429가 재시도를 유발해 콜을 더 쏜다**(compounding): 롱폼 final phase는 최대 5회 재시도
  (`GEMINI_LONGFORM_FINAL_MAX_ATTEMPTS=5`), 429 백오프 `base(60s)×attempt` (60/120/180/240s,
  최대 5분 캡 — retryDelayMs:5809). 로그의 `60초/120초/180초 후 재시도`가 이것.
- **호출 간격**: phase 내 재시도는 백오프(60s+)로 간격이 있다. 하지만 **phase 간, 항목 간
  연속 발사**(한 항목 끝나면 즉시 다음 항목)라, 3개 큰 영상의 video 호출(window×2 + scene)이
  짧은 창에 몰려 per-minute 쿼터를 넘긴다. 넘긴 뒤에는 **text 호출(final/regeneration)도
  429**가 나서(로그에서 longform_final_full이 429 재시도) → video-only 쿼터가 아니라
  프로젝트/리전 RPM 급 공유 쿼터가 소진된 정황.

## 3. mediaResolution LOW 적용 여부 → 적용됨 (토큰 폭발 아님)

- `buildMultimodalGenerationConfig({ responseSchema, includeVideo })` (line 873-877):
  `includeVideo`일 때만 `mediaResolution: MEDIA_RESOLUTION_LOW` 추가. 롱폼 Vertex 호출
  (generateJson, line 9227)이 이걸 쓴다.
- **video 붙는 단계(scene, candidate, highlight_window, full_window)는 전부 LOW 적용.**
- **풀 원고 생성/재생성(longform_final_full, full_caption_script_regeneration)은 video
  미첨부**(`includeVideo:false`, line 8691) — 400초 영상이 안 붙는다.
- → **"400초 영상이 LOW 없이 붙어 토큰 폭발 → TPM 429" 가설은 성립하지 않는다.** LOW는
  붙는 곳마다 적용됐고, 원고 단계엔 영상 자체가 없다. 429는 per-request 토큰 크기가 아니라
  **단위 시간당 호출 수/쿼터 창** 문제다.

## 다른 정상 호출과 뭐가 다른가 (요약)

| | 숏폼 정상 호출 | 400초 롱폼 배치 |
|---|---|---|
| 프로젝트/인증/엔드포인트 | Vertex ADC {project}/{location}/gemini-2.5-flash | **동일** |
| mediaResolution | video면 LOW | **동일 (LOW)** |
| 항목당 호출 수 | ~3~5 | **~10~15 (3~4배)** |
| video 호출 | scene 1회 | scene + candidate + window×2 (큰 400s 영상) |
| 재시도 | 3회/base 10s | **5회/base 60s, 429는 ×attempt (60~240s)** |
| 결과 | 쿼터 창 안 넘김 | **버스트로 per-minute 쿼터 초과 → text 호출까지 429** |

## 다음 제안 (읽기 전용 — 수정은 승인 후)

1. **429 payload 로깅 추가**: 현재 429 body(response.data)가 throw엔 담기지만 job 로그엔
   안 남는다. `retryable status` 로그에 `response.error.status/message`(RESOURCE_EXHAUSTED
   여부, quotaId if any)를 남기면 TPM vs RPM을 확증할 수 있다.
2. **롱폼 호출 rate 스로틀/직렬화**: 항목 간·video-phase 간 최소 간격(예: 항목당 video 콜
   사이 슬립) 또는 배치 동시성 1 유지로 버스트를 눌러 쿼터 창 초과를 피한다.
3. **video 콜 수 축소 검토**: window 선택이 video를 2번(highlight/full) 붙인다. 후보 기반
   window 재사용(candidatePrompt 경로, `includeVideo:false`)을 넓히면 400초 영상 video
   콜을 줄일 수 있다.
4. **쿼터 상향/리전 분산**: 근본은 gemini-2.5-flash per-minute 쿼터. Vertex 콘솔에서 해당
   project/location의 요청/토큰 per-minute 한도를 확인·상향하거나 location을 조정.
