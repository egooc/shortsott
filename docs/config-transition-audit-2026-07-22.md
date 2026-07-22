# 구성 전환 전수 감사 (읽기 전용, 원문 인용) — 필드 O/X 표

작성일: 2026-07-22
방식: grep census(에이전트) + 직접 원문 리드. **수정 없음.**
확정 구성: 하이라이트=일본어(JP 발행) / 풀=한국어(KR 발행, SRT+사용자 TTS) /
report_description(_ko/_ja)=검수·업로드매칭 / 24s+=HL+Full, 24s미만=HL만.

## 4. OUTPUT_CONFIG 상태 → 단일 config 정착됨 (흩어진 하드코딩 아님)

`processMetadataService.js:88-108` (Object.freeze):
```
highlight:  { lang:'ja', metadataKey:'highlight_metadata', reviewMetadataKey:'highlight_metadata_ko',
              captionMode:'long_bottom_explainer', label:'JP Highlight' }
full_draft: { lang:'ko', metadataKey:'full_metadata_ko', scriptKey:'full_caption_script_ko',
              captionMode:'scene_based_short_subtitles', label:'KR Full', caption:{...} }
```
- `outputLanguageForVariant`(115): full→ko, else→ja. `fullProductionIsKorean = OUTPUT_CONFIG.full_draft.lang==='ko'`(4982, 5293).
- **프롬프트도 config에서 언어를 뽑는다**: `:1540,1571,1572,2061`(예: "Full Draft production language is
  ${OUTPUT_CONFIG.full_draft.lang.toUpperCase()} only"). 즉 언어 정책이 **한 곳에서 파생**됨.
- config 읽는 곳: `:116,1540,1571,1572,2061,4982,5293`, `processQueueService.js:9427,9472`.
- **예외(잔재)**: `OUTPUT_CONFIG`에 **midform 키 없음** → midform은 `*_ja/*_ko` 필드 직접 사용(아래 △).
→ **핵심 언어 정책은 단일 config에 박혀 정착. 잔여 하드코딩은 midform + 아래 dormant 브랜치뿐.**

## 2. 필드별 언어/용도 O/X 표

| 필드 | 언어 | 용도 | 현재 검증(원문 위치) | 일치 |
|---|---|---|---|---|
| `full_caption_script_ko` | KO | **발행** (SRT+온스크린+TTS) | `validateFullCaptionScript(...,true)` 6925-6926, style/budget/anchor 6617-6808 | **O** |
| `full_caption_script_ja` | JA | 미사용 | `includeJapaneseFull` 뒤 6913-6915(=false 어디서나); 프롬프트 금지 1622; fallback read 5084 | **△ 잔재(비활성)** |
| `full_metadata_ko` | KO | **발행** 설명/온스크린 | requireKoreanField 6988-6997 + `validateMetadataSubtitles(...,true)` | **O** |
| `full_metadata_ko.report_description` | KO | 검수/업로드설명 | requireKoreanField + **allowEmbeddedLatin**(4b35a5a) | **O** |
| `full_metadata_ko.onscreen_subtitles` | KO | **발행** 온스크린 | `validateMetadataSubtitles` strict | **O** |
| `full_metadata`(JA) | JA | 미발행(full=KO) | requireJapaneseField 6938-6947 (`includeJapaneseFull`=false); 이슈 억제 4994 | **△ 잔재(비활성)** |
| `highlight_metadata`(JA) | JA | **발행** JP 업로드메타 | strictHighlightMetadata requireJapaneseField 6964-6987 + `validateHighlightCaptionBlock(...,false)` | **O** |
| `highlight_metadata.report_description` | JA | 검수/업로드설명 | requireJapaneseField + **allowEmbeddedLatin**(4b35a5a) | **O** |
| `highlight_metadata.onscreen_caption_block` | JA | **발행** 번인자막 | `validateHighlightCaptionBlock(...,false)` 120-340 strict | **O** |
| `highlight_metadata_ko` | KO | **검수 전용**(reviewMetadataKey; 프롬프트 "not upload metadata" 1546/1577/1715/1765) | strictHighlightMetadata requireKoreanField 7008-7031 + `validateHighlightCaptionBlock(...,true)` | **X 잔재후보** |
| `highlight_metadata_ko.report_description` | KO | 검수/매칭 | requireKoreanField + **allowEmbeddedLatin**(4b35a5a) | **O** |
| `highlight_metadata_ko.onscreen_caption_block` | KO | **검수 전용(미발행)** — capcut/srt 소비 없음, 리뷰블록 빌더(4272/4298)에서만 생성 | `validateHighlightCaptionBlock(...,true)` **발행급** 120-340 long_bottom_explainer | **X 잔재후보** |
| `highlight_metadata_ko.{short_description,summary_caption,upload_title}` | KO | 검수 전용 | requireKoreanField(**hasLongLatinWord strict**) 7011-7014 | **X 잔재후보** |
| `onscreen_subtitles`(full) | KO발행/JA off | 발행 | KO strict; JA는 `includeJapaneseFull` off | **O** |
| `midform_metadata` / `_ko` | JA/KO | **확정 구성에 없음**(롱폼 전용 120s) | `validateLongformVariantFinalGuide` 둘 다 존재 요구 4109-4110 | **△ 구성 미언급** |
| top-level `*_ko`(short/titles/report/explainer) | KO | 검수/발행 | baseRequiredKeys 7564-7569 + schema required 690 | **O** |

## 1. 함수명이 언어를 박은 곳 → 2개 중앙 검증기가 오해 소지(기능은 정상)

- `collectJapaneseCaptionIssues`(6487) — **이름은 Japanese지만 한/일 공용 검증기**. 내부 스위치
  `includeJapanese`(6493)/`includeJapaneseFull`(6494)/`includeKorean`(6495); 한국어 브랜치
  6540/6925/6988/7008. → **X(네이밍 잔재)**: 동작은 맞으나 이름이 실체를 가림.
- `validateOrRepairJapaneseCaptions`(7781) — 이름은 Japanese지만 **한국어 풀 원고를 검증/재생성**
  (`includeKorean:true, includeJapaneseFull:false` 8034-8038; `full_caption_script_ko` 카운트
  7831/repair 7875). → **X(네이밍 잔재)**.
- `assertOttogiGuideLanguage`(7615) — 공용(위임). 나머지 `*Japanese*/*Korean*` 함수는 전부 진짜
  단일 언어(2287/2312 등) → 정상.
- **필드 레벨 교차 오적용은 없음**: KO 필드→requireKoreanField, JA 필드→requireJapaneseField로
  접미사대로 라우팅. "일본어 검증이 한국어 필드에" 같은 버그는 발견 안 됨(함수명만 오해 소지).

## 3. 이미 잡은 2건과 같은 잔재 패턴 — 추가 발견

**(a) 발행용 가드가 검수 필드에 (report_description과 동일 패턴, 미해결분):**
- `highlight_metadata_ko`는 **명시적으로 검수 전용**(reviewMetadataKey 92; 프롬프트 "This is not
  upload metadata" 1546/1577/1715/1765; capcut/srt 소비 없음, 리뷰블록 4272/4298에서만 생성).
- 그런데 `strictHighlightMetadata`가 **발행급 guard**를 그대로 적용:
  - `onscreen_caption_block`에 `validateHighlightCaptionBlock(...,true)` = long_bottom_explainer +
    120~340자 강제 (미발행 리뷰 블록인데 번인자막 구조 요구).
  - `short_description/summary_caption/upload_title`에 `hasLongLatinWord` strict (영어 기법명이면
    검수 필드 때문에 하이라이트 실패 — **방금 고친 report_description과 똑같은 원인**).
- **판단**: report_description만 이번에 풀었고, **같은 검수 필드의 나머지 하위필드는 아직 발행급
  guard**. → **잔재(구성 전환 전 KO도 발행하던 시절 흔적) 가능성 높음.** 단, "리뷰어가 읽을 블록의
  최소 형태 보장" 의도가 일부 있을 수 있어 **완화 범위는 사용자 결정** 필요.

**(b) 안 쓰는 언어를 필수로 요구 (dormant dead branch):**
- JA-full 필수 브랜치가 물리적으로 남음: `full_caption_script_ja` 6913-6915, JA `full_metadata`
  6938-6947, `short_description_200/explainer_text` 6531-6536. **전부 `includeJapaneseFull` 게이트**.
- 그런데 `includeJapaneseFull`는 정의(6494) + 명시적 `false`(7596, 8038) 외 **true로 세팅하는
  호출자가 grep상 전무**. → **비활성 dead code**. 동작상 무해하나 **혼란·잔재**. 제거는 명료성용(저위험).

**(c) OUTPUT_CONFIG 밖 midform:**
- 확정 구성(HL+Full)에 midform 없음. `validateLongformVariantFinalGuide`는 midform_metadata(JA)+
  midform_metadata_ko(KO) **둘 다 존재 요구**(4109-4110). 롱폼 전용 실험/레거시. → **의도/폐기 판단 필요.**

## X 항목 판단 요약

| X/△ 항목 | 잔재 vs 의도 | 근거 |
|---|---|---|
| highlight_metadata_ko.onscreen_caption_block 발행급 guard | **잔재 유력** | reviewMetadataKey·프롬프트 "not upload metadata"·발행 경로 미소비인데 번인자막 구조 강제 |
| highlight_metadata_ko.{short_desc,summary,upload_title} EN strict | **잔재 유력** | 검수 필드에 hasLongLatinWord = report_description과 동일 원인. 완화 범위만 결정 필요 |
| full_caption_script_ja / full_metadata(JA) 필수 브랜치 | **잔재(비활성)** | includeJapaneseFull true 호출자 전무. dead code |
| midform_metadata(_ko) 필수 | **판단 필요** | OUTPUT_CONFIG·확정 구성에 없음. 롱폼 전용 잔존 |
| collect/validate…Japanese… 함수명 | **네이밍 잔재** | 한/일 공용인데 이름이 일본어. 기능 정상, 개명은 선택 |

## 다음 (수정은 이 표 검토 후 별도 턴)

우선순위 제안(수정 아님, 참고): ① highlight_metadata_ko 하위필드 완화(report_description과 동일
패턴, 실사용 실패 유발) → 가장 실효. ② JA-full dead 브랜치 정리(저위험·명료성). ③ midform 존치/폐기
결정. ④ 중앙 검증기 개명(선택). 발행 자막(full_caption_script_ko, highlight_metadata JA
onscreen_caption_block)·window·2층 프리셋은 **불변 유지**.
