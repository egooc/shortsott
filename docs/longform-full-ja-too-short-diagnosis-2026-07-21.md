# 400초 롱폼 풀 원고 `ja_too_short` 원인 진단 (읽기 전용)

작성일: 2026-07-21

코드 수정 없음. item_config / full_draft_stages / job 로그 / 소스코드 원문 인용.

## 산출 (결론 먼저)

**`too_short`는 토큰 문제가 아니다. 프롬프트↔검증기 언어 계약 불일치(코드 버그)다.**
롱폼 full 프롬프트는 "한국어만, 일본어 만들지 마라"고 지시하는데, 롱폼 full 검증기는
"일본어 full_caption_script_ja ≥ 20"을 요구한다. Gemini는 프롬프트대로 KO=20/JA=0을
냈고, 검증기가 일본어 없다고 `ja_too_short`로 거부한다. 소재/토큰과 무관.

## 대상: 현재 큐의 400초대 롱폼 3개

| item | 길이 | full_status | ja_count | ko_count | onscreen_subtitles |
|---|---|---|---|---|---|
| item_001 | 474s | failed | **0** | **20** | 0 |
| item_002 | 727s | failed | 0 | 20 | 0 |
| item_003 | 944s | failed | 0 | 20 | 0 |

세 개 모두 동일 에러: `OTTOGI_FULL_FINAL_VALIDATION_FAILED`
`missing=[missing_full_metadata, full_caption_script_ja_too_short, full_metadata_onscreen_subtitles_too_short]`

## 1. finishReason / 토큰 / truncation

- **finishReason·usageMetadata를 코드가 아예 기록하지 않는다** (geminiService.js /
  processMetadataService.js 에서 `finishReason`/`usageMetadata`/`MAX_TOKENS` grep 0건).
  → 디스크에 exact 토큰 수/사유 없음. `.raw.json`도 롱폼 full 단계엔 미저장.
- **하지만 truncation은 아니다** (간접 증거 확정): item_001 job 로그에서 두 번의 시도 모두
  `longform_final_full 응답 JSON 파싱 완료` (11:45:22, 11:46:37). MAX_TOKENS로 잘렸다면
  JSON이 불완전해 파싱 실패했을 것. **완전한 JSON이 파싱됐다 = STOP, 잘림 아님.**
- 즉 Gemini는 **완결된 응답**을 냈고, 그 안에서 일본어 필드만 비어 있었다(잘려서 빈 게 아님).

## 2. 400초 영상을 풀 원고 생성에 붙이나 → 아니오

- 롱폼 파이프라인 단계별 `includeVideo` (processMetadataService.js):
  - 장면 분석(scene): `includeVideo: true` (line 8487) — 영상 붙임. **이 단계는 성공.**
  - 풀 원고 생성 `longform_final_full`: **`includeVideo: false`** (line 8691) — **영상 안 붙임.**
- 즉 실패한 풀 원고 단계는 **텍스트 프롬프트만** 보낸다. 400초 영상 첨부로 인한 토큰
  폭발은 이 단계에 **존재하지 않는다.** (며칠 전 metadata 영상 제거 수리와 같은 맥락으로
  풀 원고 단계도 이미 영상 미첨부.)

## 3. 왜 ja만 걸리나 — 프롬프트와 검증기가 정반대

### 프롬프트 (buildLongformVariantFinalPrompt, variant 'full') 원문
```
requiredFields: ['full_caption_script_ko', ...]
- Full production language is Korean. full_caption_script_ko and full_metadata_ko
  are the real production output for this variant.
- full_caption_script_ko should be 20 to 24 short Korean connected narration phrases ...
- Do not create Japanese Full metadata, Japanese Full subtitles, or full_caption_script_ja.
  Full drafts are Korean only.
```
→ Gemini에게 **"한국어만, 일본어(full_caption_script_ja) 만들지 마라"**고 명시.

### 검증기 (validateLongformVariantFinalGuide, variant 'full') 원문 (line 4056~4076)
```
if (jaCount < 20) missing.push('full_caption_script_ja_too_short');   // ← 일본어 20개 요구
if (koCount < 20) missing.push('full_caption_script_ko_too_short');
if (!guide.full_metadata) missing.push('missing_full_metadata');       // ← 일본어 metadata 요구
if (metadataSubtitleCount < 8 && jaCount < 20) missing.push('full_metadata_onscreen_subtitles_too_short');
```
→ 검증기는 **일본어 `full_caption_script_ja ≥ 20` + 일본어 `full_metadata` + 일본어
onscreen_subtitles**를 요구.

### 결과
- Gemini는 프롬프트를 정확히 따라 **KO=20(정상), JA=0(프롬프트가 금지)**을 냈다.
- 검증기는 일본어가 0이라 `ja_too_short` + `missing_full_metadata`(JP) +
  `onscreen_subtitles_too_short`(JP) 3개를 던진다.
- **한국어는 20개로 완벽히 생성됨**(ko_count:20). 둘 다 짧은 게 아니라 **한국어는 되고
  일본어만 0**이며, 그 일본어는 프롬프트가 만들지 말라고 한 필드다.

## 확정

| 질문 | 답 (인용) |
|---|---|
| finishReason MAX_TOKENS인가 | 아니오. 코드가 기록 안 하지만, 두 시도 다 JSON 파싱 완료 = 완결 응답(STOP), 잘림 없음 |
| 400초라 입력 토큰 근접/폭발? | 아니오. 풀 원고 단계는 `includeVideo:false`(영상 미첨부), 텍스트만 |
| Gemini가 짧게 뱉었나 잘렸나 | 잘리지 않음. 완결 JSON. 일본어 필드만 비었음(프롬프트가 금지한 필드) |
| ja만 짧은가 둘 다인가 | **KO=20 정상, JA=0. 일본어만.** |
| 토큰 문제인가 소재 문제인가 | **둘 다 아님 — 프롬프트↔검증기 언어 계약 불일치(코드 버그).** 롱폼 full 검증기가 구(舊) 일본어 계약을 그대로 두고 있어, 한국어-only로 이주한 생성 결과를 거부함 |

## 다음 제안 (읽기 전용 — 수정은 승인 후)

1. **`validateLongformVariantFinalGuide('full')`을 한국어 계약으로 정렬**: 프롬프트가 이미
   "Full drafts are Korean only"이므로, 검증기의 `ja_too_short`/`missing_full_metadata`(JP)/
   `onscreen_subtitles_too_short`(JP)를 한국어 필드(`full_caption_script_ko`,
   `full_metadata_ko.onscreen_subtitles`) 기준으로 바꿔야 400초 롱폼 풀 원고가 통과한다.
   (숏폼 표준 파이프라인은 이미 한국어로 이주 완료 — 롱폼 variant final 검증기만 뒤처짐.)
2. **finishReason/usageMetadata 로깅 추가 검토**: 향후 진짜 토큰 이슈(장면 분석 단계의
   영상 첨부 등)를 구분하려면 raw 응답의 finishReason/토큰 수를 stage 아티팩트에 남기는 게
   좋다. 현재는 전무해서 토큰 문제를 직접 확인할 수 없고 간접 추론만 가능.
3. **생성 낭비 인지**: KO 20개가 매번 생성되고도 JA 검증 실패로 폐기된다(재시도까지). 계약
   정렬 시 이 낭비도 사라진다.
