# compress LLM Codex → Vertex(Gemini) 이관 — 구현 전 확인 보고

Date: 2026-07-21

착수 규칙대로 코드 수정 없이 3개 확인만 수행. 세 번째(Gemini structured output)는 실제 Vertex 호출로 검증. 이 보고 + 아래 구현 계획 승인 후 착수.

## 확인 1 — 기존 Vertex 호출 경로 (`server/services/geminiMidformService.js`)

- **인증**: `getVertexAccessToken()` — `GoogleAuth`(google-auth-library) ADC 토큰, scope `cloud-platform`. `.env`에 `GEMINI_AUTH_MODE=vertex_adc`, `GOOGLE_CLOUD_PROJECT=project-b341...`, `GOOGLE_CLOUD_LOCATION=us-central1`. **ADC 토큰 획득 실제 성공 확인.**
- **엔드포인트**: `buildVertexEndpoint()` → `https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent`.
- **모델**: 기본 `gemini-2.5-flash` (`GEMINI_MODEL` 상수, env `VERTEX_GEMINI_MODEL`로 override).
- **요청**: `fetch` POST, `Authorization: Bearer <token>`, body =
  `{ contents:[{role:'user', parts:[{inlineData?}, {text:prompt}]}], generationConfig:{responseMimeType:'application/json', responseSchema:<schema>, temperature:0.1} }`.
  (씬분석은 video inlineData 포함. compress 3콜은 텍스트만이라 `parts:[{text}]`만.)
- **응답 파싱**: `extractVertexResponseText(data)` = `candidates[0].content.parts[].text` 합침 → `extractJson(text)` (JSON.parse + 마크다운 펜스 제거 fallback).

## 확인 2 — Gemini structured output (실제 호출로 검증)

**결론: 지원되고, 실제로 edit_plan 수준 JSON을 정확히 채운다.**

- Vertex `responseSchema`는 **OpenAPI subset**. 작동 중인 씬분석 스키마(`gemini_response_schema.json`)는 `additionalProperties`/`$ref`/`$schema` **0개**. 반면 compress 스키마는 `additionalProperties` 사용(edit_plan 5, beats 3, slot_fills 3). → **경미한 스키마 변환 필요**(`additionalProperties`/`$schema`/`$ref`/`definitions` 재귀 제거). core(type/properties/required/enum/items)는 그대로 호환.
- **실측 probe** (scratchpad, 프로덕션 코드 무수정): Catch the Bullet 실제 beats + heatmap + 변환된 edit_plan 스키마로 `gemini-2.5-pro` 1회 호출:
  - **HTTP 200, 78초, 유효한 structured JSON** 반환, JSON.parse 성공.
  - timeline 9슬롯, roles = cold_open/bridge/body×.../body_peak/payoff **전부 존재**.
  - `fallback_used:true`, cold_open `beat_04` (heatmap `heatmap_null` → hook 기반 선택, 정확).
  - **body_peak beat = beat_04 = cold_open beat** → replay 컨벤션 정확히 지킴.
  - **KEEP_DIALOGUE 6슬롯 모두 beat anchor 포함** (anchor-inclusion 6/6, miss 0).
  - KEEP_DIALOGUE 6 / NARRATE 3 / DROP 0.
- **편차 1건**: cold_open decision을 `NARRATE`가 아니라 `KEEP_DIALOGUE`로 냄. 단 `finalizeEditPlan`이 cold_open을 무조건 NARRATE로 강제 정규화하므로 파이프라인상 무해. (Gemini용 프롬프트에서 명시하면 개선 가능 — 검증 단계 항목.)
- **파싱 실패율**: `responseMimeType:'application/json'` + `responseSchema`로 마크다운 펜스 없는 순수 JSON이 나와, Codex보다 파싱 안정성 높을 것으로 보임. 기존 `extractJson` + 재시도 패턴 그대로 재사용 가능.
- **지연**: pro 78초/콜. compress 3콜 순차 = 영상당 ~4분(LLM만). 배치 운영엔 허용 범위. flash는 더 빠르나 품질 미검증.

## 확인 3 — compress Codex 호출 3개 구조

- 공통 추상화 지점: **`runJsonGeneration(prompt, outputSchemaPath, validator)`** (midformCompressionService.js). 내부에서 `runCodexCli(fullPrompt, {outputSchemaPath})`(gptMidformCliService.js) 호출 → `extractJson` → `validator` → 재시도(2 attempt × 3 transport retry + fresh-node fallback).
- 세 호출 모두 이 함수를 통과:
  - 비트분할: `runJsonGeneration(buildBeatsPrompt(...), MIDFORM_COMPRESSION_BEATS_SCHEMA_PATH, validateBeats)`
  - edit_plan: `runJsonGeneration(buildEditPlanPrompt(...), MIDFORM_COMPRESSION_EDIT_PLAN_SCHEMA_PATH, validate...)`
  - 나레이션+caption: `runJsonGeneration(buildSlotFillsPrompt(...), MIDFORM_SLOT_FILLS_SCHEMA_PATH, validateSlotFillsDialogueCaptions)`
- → **provider 분기는 `runJsonGeneration` 한 곳**에 넣으면 세 호출 전부 커버. 게이트/검증/재시도 로직은 그대로.

## 제안 구현 계획 (승인 후 착수)

1. **Vertex JSON 생성 함수** 추가 (신규, `geminiMidformService.js`에 export 또는 소형 util) — 인터페이스는 `runCodexCli`와 동형: `(prompt, {outputSchemaPath, model}) → {outputText}`. 내부: 스키마 변환(`toVertexResponseSchema`) → generateContent(responseSchema) → 텍스트 추출.
2. **`runJsonGeneration`에 provider 스위치** — env `MIDFORM_COMPRESS_LLM=vertex|codex`(줄 범위 스크립트 교체로 수정). vertex면 Vertex 함수, 아니면 기존 runCodexCli. extractJson/validator/재시도 동일.
3. **Codex 경로 유지** (삭제 금지, fallback/선택지).
4. **산출물 메타에 `llm_provider` 기록** (compression_manifest.json + edit_plan). A/B·패턴 분석 시 혼합 방지.
5. **모델 선택**: edit_plan(추론 무거움) → `gemini-2.5-pro` 권장. beats/slot_fills → flash 먼저 시도 후 품질 약하면 pro. (호출별 모델 지정 가능하게.)

## 승인 필요 결정

- **기본 provider**: Codex 쿼터가 근본 문제이므로 **vertex 기본** 제안(품질 재현 확인 후 확정). Codex는 선택지로 유지.
- **모델**: edit_plan pro / beats·slot_fills flash-우선(품질 보고 후 조정) vs 전부 pro(품질 우선, 느림). → 검증에서 flash 품질 보고 후 결정 권장.

## 검증 (착수 후, 품질 재현이 핵심)

Catch + Twilight 둘 다 Vertex로 compress → compress-apply, Codex 결과와 6항목 비교(비트분할/콜드오픈 재프레이밍/anchor 선별/나레이션 후킹/caption 1:1/곁가지 제외). 재현 안 되는 항목만 Gemini용 프롬프트 재조정 후 재검증. Codex 프롬프트 그대로 쓰지 않음.
