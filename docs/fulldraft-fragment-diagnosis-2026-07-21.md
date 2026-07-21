# 풀드래프트 파편 진단 보고 (읽기 전용)

작성일: 2026-07-21

코드 수정 없음. 아래는 전부 `item_config.json`, `full_draft_stages/*.json`,
`server/data/process_jobs.db`(process_job_logs/process_jobs 테이블), 소스코드
원문에서 그대로 인용한 것이다.

---

## 1. 검수 게이트가 왜 안 걸렸나 — 우회가 아니라 배선 자체가 안 됨

### item_002.script_review 값

```
$ node -e "console.log(require('./queue/process/item_002/item_config.json').script_review)"
undefined
```

`queue/process/item_002/`, `queue/process/item_006/` 어디에도
`script_review.json` / `script_review.txt` / `script_review_validation.json`
파일 자체가 없다(`find ... -iname "*script_review*"` 결과 0건). 즉 게이트가
"돌았는데 통과시킨" 게 아니라 **이 배치 경로에서 애초에 호출된 적이 없다.**

### 왜 호출이 안 되는지 — 승인 검사 함수의 유일한 호출부

`assertKoreanFullScriptReviewApproved`(processQueueService.js:1287)는
레포 전체에서 **딱 한 곳**에서만 불린다:

```js
// processQueueService.js:1383
async function generateKoreanFullDraftTtsAssets({ itemId, itemConfig = {}, draftConfig = {} }) {
  assertKoreanFullScriptReviewApproved(itemConfig, itemId);
  ...
```

그런데 `generateKoreanFullDraftTtsAssets`는 레포 전체에서 **자기 정의 한 줄
말고 호출부가 0건**이다(`grep -rn "generateKoreanFullDraftTtsAssets" server/ scripts/`
결과 정의 1건뿐). 실제 배치 경로(`generateQueue`)의 KR Full 생성 블록은 이
함수를 거치지 않고 다음을 직접 호출한다:

```js
// processQueueService.js:9272 부근, generateQueue 안
const koreanFullPlan = buildKoreanFullDraftTtsPlan({ itemId, itemConfig: fullDraftItemConfig, draftConfig: koreanFullConfig });
const koreanFullTtsAssets = writeKoreanFullDraftSrtFile({ itemId, itemConfig: fullDraftItemConfig, draftConfig: koreanFullConfig, queueConfig, plan: koreanFullPlan });
```

`assertKoreanFullScriptReviewApproved` 호출이 없다. `createKoreanFullDraftForItem`
(단일 아이템 경로)도 동일하게 `buildKoreanFullDraftTtsPlan` → `writeKoreanFullDraftSrtFile`
직결이다. 이는 `KOREAN_FULL_SRT_DELIVERY_MODE = 'srt_only_external'` /
`use_tts: false` 방식(외부 SRT 전달, 실제 TTS 미호출)에서는 애초에 승인
게이트가 지키는 대상인 "real TTS"가 발생하지 않기 때문이다 — 게이트는
`generateKoreanFullDraftTtsAssets`(ElevenLabs 실TTS 경로) 진입 시에만 막는데,
그 함수 자체가 죽은 코드다.

**결론: script_review 게이트는 "우회"된 게 아니라, SRT-only 배송 경로에는
애초에 배선되어 있지 않다.**

### 파편 성립성 검증(지난주 작업)은 호출됐나 — 됐고, 정확히 걸렸다

이건 `script_review` 게이트와는 다른 코드다. `collectKoreanFullRepairGateIssues`
(processMetadataService.js:6356)가 실제로 호출되고, 실제로 파편을 잡는다.
item_002 로그 원문:

```
2026-07-21T00:46:21.366Z info 2/5 Gemini Full 원고 repair 게이트 차단:
  repair output contains pseudo-sentence groups made only of fragments or noun labels
2026-07-21T01:20:27.609Z info 2/5 Gemini Full 원고 repair 게이트 차단:
  repair output contains pseudo-sentence groups made only of fragments or noun labels
2026-07-21T01:21:46.629Z info 2/5 Gemini Full 원고 repair 게이트 차단:
  repair output contains pseudo-sentence groups made only of fragments or noun labels
```

즉 이 게이트는 **작동한다** — 파편이 오면 그 응답을 버리고 재요청한다.
문제는 이 게이트를 통과 못 하면 어떻게 되냐인데(→ 2번 질문), item_002는
2026-07-21T01:21:46에 재시도가 소진되어 최종적으로:

```
2026-07-21T01:21:46.706Z info 2/5 Gemini 최종 검증 실패: full 포맷만 실패 처리하고 성공 포맷은 보존합니다.
```

로 **"full만 failed, 다른 포맷은 보존"** 처리됐다. 파편 콘텐츠 자체가
production output(SRT/CapCut 자막)으로 새 나가지는 않았다 — 현재
`item_002.ottogi_guide_output.full_caption_script_ko`는 `[]`(빈 배열)이고
`full_generation_status: "failed"`다.

단, item_006은 다르다 — `full_generation_status: "failed"`인데도
`ottogi_guide_output.full_caption_script_ko`에 마지막 시도의 파편 배열
(21개, `scene_id: "0000_0009_02"` 같은 존재하지 않는 anchor ID 포함)이
그대로 남아있다. 이건 draft 생성 단계(`shouldGenerateFullDraft` 체크)에서
`full_generation_status`를 보고 걸러지므로 실제 CapCut 출력물로는 안
나가지만, item_config.json 안에는 파편 잔해가 저장된 채로 남는다.

### script_review.status가 뭐로 찍혔나

`undefined`. `null`도 아니고 `"missing"`도 아니고 필드 자체가 없다 —
`createKoreanFullDraftScriptReview()`가 이 아이템에 대해 한 번도 호출된
적이 없다는 뜻이다(그 함수만이 `item_config.script_review`에 값을 쓴다).

---

## 2. 재생성 루프가 왜 도는가

### item_006 실제 로그 (2026-07-21, 원문)

```
01:00:05 Gemini 강제 재분석 시작
01:05:01 Gemini KO Full 원고 문체 재생성: 금지 문체 3개 감지
01:06:05 Gemini KO Full 원고 재생성 응답: keys=full_caption_script_ko / KO 24개
01:06:05 Gemini KO Full 원고 재생성 미리보기: 평범한 철선이 / 돈 되는 부품으로 / 새롭게 태어나는 과정을 / 보여드릴게요. / 이 작은 나사에도 / 정밀한 단계가 숨어있죠.
01:06:05 Gemini KO Full 원고 재생성 게이트 차단: repair output contains three or more consecutive non-sentence fragments
01:06:05 Gemini KO Full 원고 문체 재생성: 금지 문체 3개 감지        ← 재시도
01:08:25 Gemini KO Full 원고 재생성 응답: keys=full_caption_script_ko / KO 20개
01:08:25 Gemini KO Full 원고 재생성 미리보기: 작은 / 철선도 / 돈 되는 / 부품으로 / 변신해요. / 먼저,
01:08:25 Gemini KO Full 원고 재생성 게이트 차단: repair output contains three or more consecutive non-sentence fragments
01:08:25 Gemini 최종 검증 실패 상세: ...(scene_id 위조), (speech budget 미달 184<191자), (연속 파편 3개 이상)
01:08:25 error Gemini 분석 실패: Gemini 결과 검증 실패
```

이게 사용자가 말한 "파편 감지 → 재생성 → 또 파편 3연속"이다 —
`collectKoreanFullRepairGateIssues`가 매번 정확히 그 이유로 차단했다.

### 재시도 상한 — 있다, 3회

`validateOrRepairJapaneseCaptions`(processMetadataService.js:7733):

```js
for (let attempt = 1; attempt <= 3; attempt += 1) {
  try {
    ...
    return normalizedCurrent;
  } catch (error) {
    ...
    if (attempt >= 3) {
      ...
      throw createHttpError(500, 'OTTOGI_METADATA_LANGUAGE_VALIDATION_FAILED', ...);
    }
    ...
  }
}
```

3회 소진 후 정확히 `held`가 아니라 **`full_generation_status: "failed"`
+ `full`만 실패, 다른 포맷 보존**으로 빠진다(위 로그의
"full 포맷만 실패 처리하고 성공 포맷은 보존합니다." 라인). "3회 후 held로
빠져야 하는데 계속 돈다"는 관찰과 달리, **단일 프로세스 내에서는 3회에서
정확히 멈춘다.** 다만 상태 이름이 `held`가 아니라 `failed`다(이건 코드
동작이지 무한루프가 아니다).

### 그럼 왜 "계속 도는 것"처럼 보였나 — job 단위 재실행 이력

item_006의 item_config 백업 파일이 07-21 하루에만 6개
(`024458, 095834, 100825, 101443, 104024, 105359`) 존재한다. 즉 **같은
아이템이 여러 개의 별도 job 실행에 걸쳐 반복 재분석됐다** — 프로세스
내부 루프가 아니라, job이 끝나고 사람/배치가 다시 트리거한 것.

`process_jobs` 테이블에서 이 시간대를 덮는 job 2개:

```
job_20260720174502_972c59: status=cancelled, cancel_requested=1,
  started_at=2026-07-21T00:58:16Z, finished_at=2026-07-21T01:10:09Z
job_20260721011447_a6a672: status=completed_with_warnings, cancel_requested=0,
  started_at=2026-07-21T01:35:12Z, finished_at=2026-07-21T01:59:59Z
```

**첫 번째 job은 `cancelled`다 — 크래시가 아니라 `cancel_requested=1`,
즉 명시적 취소.** item_006이 01:08:25에 실패 처리된 직후(01:10:09) 이
job이 끝났는데 상태가 cancelled인 걸 보면, item_006이 파편 루프를 도는
동안 이 job 전체가 취소된 것으로 보인다. **두 번째 job은 정상
`completed_with_warnings`로 끝났다** — item_006의 두 번째 재시도(01:35-01:40)
에서도 파편이 2연속 나왔지만 그 후 다른 반복 패턴으로 통과했고
(`01:40:24 Gemini 분석 완료`), full만 실패·highlight는 성공 처리된 채
job은 정상 종료됐다.

### Network Error 시 배치 전체가 죽는 구조인가

`process_job_logs` 34,953행 전체에서 영문 "Network Error" 문자열은
**0건**이다. 존재하는 건 "네트워크/JSON 오류"라는 자체 재시도 로그
(예: `item_013 | 1/1 Gemini scene 네트워크/JSON 오류: 10초 후 재시도 (2/3)`)
로, `level: info`로 기록되고 10초/20초 backoff 후 자체 재시도되는
**자가치유형** 메커니즘이지 배치를 죽이는 에러가 아니다. item_002/item_006
로그에서는 이 문자열도 이번 실행 구간엔 안 나온다.

**확인된 사실**: 두 아이템 모두 `full` 실패가 `highlight`/`midform`
성공을 막지 않았다(`success 1/3 Highlight 드래프트 생성 완료`가 `full`
실패 로그 바로 다음 줄에 있음). 아이템 하나의 파편 실패가 배치 전체를
죽이지는 않는다 — 확인된 유일한 "죽음"은 사람/시스템에 의한 job
`cancel_requested=1`이며, 이게 사용자가 "Network Error로 죽음"으로
인지한 사건일 가능성이 높다(정확한 취소 트리거는 job_json/서버 콘솔
로그가 없어 이 데이터만으로는 특정 불가 — process_job_logs에는 취소
사유가 기록되지 않는다).

---

## 3. 근본 원인 — 프롬프트가 파편을 유도한다

### 프롬프트가 "문장으로 써라"와 "파편으로 써라"를 동시에 지시한다

`server/prompts/ottogi_process_metadata.txt` (일반 생성, 130-133행 —
기존 규칙):

```
- Each caption line must be a complete natural phrase that can stand alone on screen.
- Do not split grammar across lines. Never output a line that ends with only a particle or unfinished verb stem.
- Bad Korean fragments: "금속 망치 만드는", "먼저 손잡이를", ...
```

바로 아래 149행(지난주 추가된 "Korean Full narration rewrite rules"):

```
- Prefer natural endings such as `-요`, `-죠`, `-예요`, `-해요`, `-돼요`,
  and short connected fragments that clearly continue the narration.
```

**"완전한 구여야 한다"는 옛 규칙과 "짧은 연결 파편이어도 된다"는 새
규칙이 같은 파일에 공존**한다.

### 실제 실패를 만든 repair/regeneration 프롬프트도 동일 모순 + 나쁜 예시

item_002/item_006 로그에서 실제로 호출된 두 프롬프트
(`buildFullCaptionScriptRepairPrompt` processMetadataService.js:2021,
`buildKoreanFullCaptionScriptRegenerationPrompt` 동 파일:2148)는 둘 다
다음 두 줄을 포함한다:

```
- Prefer endings like -요, -죠, -예요, -해요, -돼요, and connected short fragments.
- Sentence validity rule v2: never output 3 consecutive caption items without
  sentence-closing endings. At least every 1 to 2 short pieces must close or
  complete a Korean sentence with endings like -요, -죠, -예요, -해요, -돼요,
  -합니다, -됩니다, -입니다, -니다, -까, or punctuation.
```

한 줄 위에서 "연결 파편도 좋다"고 하고, 바로 다음 줄에서 "3개 연속
파편 금지"라고 한다. 그리고 두 프롬프트 모두 "Good Korean output rhythm"
few-shot 예시로 **동일한 배열**을 쓴다:

```json
["처음엔 평범해 보여도", "이 부품은 곧", "새 역할을 얻어요",
 "먼저 자리를 맞추고", "흔들리면 안 되니까", "손으로 잡아줘요",
 "여기서 중요한 건", "힘보다 방향이에요", "기계가 눌러도",
 "기준이 틀어지면", "품질이 달라져요",
 "같은 움직임을", "계속 반복하면서", "정밀함이 쌓이고", "마지막 형태가",
 "조용히 완성돼요"]
```

이 예시의 마지막 구간 `"같은 움직임을" → "계속 반복하면서" →
"정밀함이 쌓이고" → "마지막 형태가"`는 **문장 종결 어미 없이 4개
연속**이다 — 바로 위에서 명시한 "3개 연속 금지" 규칙을 예시 자체가
위반한다. `buildFullCaptionScriptRepairPrompt`(2062행)와
`buildKoreanFullCaptionScriptRegenerationPrompt`(2200행) 양쪽에 이
동일한 깨진 예시가 그대로 들어가 있다.

item_006 01:06:05 응답 미리보기 `"평범한 철선이 / 돈 되는 부품으로 /
새롭게 태어나는 과정을 / 보여드릴게요..."`와 item_002 01:20:27 응답
`"이 월급 속에는 / 무엇이 담겨 있을까요? / 단순한 숫자를 넘어 /
숨겨진 가치를 / 찾아봅니다..."`는 리듬상 이 "Good" 예시를 그대로
따라간 형태다.

**결론: Gemini는 "짧은 문장으로 써라"를 어긴 게 아니라, 프롬프트가
준 few-shot 예시(파편 4연속 포함)를 정직하게 따라간 것에 가깝다.
코드 게이트(`sentenceEndinglessRuns` ≥3 연속 차단)가 프롬프트의
텍스트 규칙("3개 연속 금지")과는 일치하지만, 프롬프트의 예시와는
불일치한다.**

---

## 요약 (원문 인용 근거)

| 질문 | 답 | 근거 |
|---|---|---|
| script_review 게이트가 걸렸나 | 아니오 — 우회가 아니라 미배선 | `script_review: undefined`, `assertKoreanFullScriptReviewApproved` 유일 호출부가 죽은 함수 `generateKoreanFullDraftTtsAssets`(호출부 0건) 안에 있음 |
| 파편 검증이 이 경로에 탔나 | 탔고, 정확히 차단함 | `Gemini Full 원고 repair 게이트 차단: ...` 로그 3회 |
| script_review.status | `undefined` (게이트 자체가 안 불림) | item_config.json 원문 |
| 재생성 상한 있나 | 있음, 3회. 3회 후 `held`가 아니라 `full_generation_status: failed`로 정확히 멈춤 | `for (let attempt = 1; attempt <= 3; ...)` |
| 무한 루프였나 | 프로세스 내부는 아님. job이 여러 번 재트리거됨(백업 파일 6개/하루), 그중 1개 job은 `status: cancelled`(사람의 취소, 크래시 아님) | process_jobs 테이블 |
| Network Error가 배치를 죽이나 | 로그에 해당 문자열 0건. 실패는 아이템/포맷 단위로 격리되어 있고(`full`만 실패, highlight 성공), 유일한 "죽음"은 명시적 job 취소 | process_job_logs 34,953행 전수 검색 |
| Gemini가 왜 파편을 계속 뱉나 | 프롬프트가 "완전한 문장" 규칙과 "짧은 연결 파편 허용" 규칙을 동시에 지시하고, repair/regeneration 두 프롬프트의 few-shot "Good" 예시 자체가 자신이 명시한 "3연속 금지" 규칙을 위반함(4연속 파편 포함) | `ottogi_process_metadata.txt:130-133` vs `:149`; `processMetadataService.js:2062`, `:2200` |
