# 완료 보고서 — Catch compress-apply B/C 규칙 점검 및 재생성

## 요약

요청하신 두 가지를 직접 확인했습니다.

1. `slot_fills` 프롬프트에 B(사건 먼저 시작)와 C(대사 반복 금지) 규칙이 실제로 들어가도록 코드 레벨에서 명시했습니다.
2. Catch the Bullet 런(`compress_20260720213249_3e-5BAhZQ5w`)에 `context.md`를 채워 넣고 `compress-apply`를 재생성해 결과를 검증했습니다.

재생성 최종 결과에서는:

- 첫 나레이션이 인물 소개가 아니라 사건형 훅으로 시작했습니다.
- `upload_text.md`가 생성됐습니다.
- 제목 후보 3개를 모두 궁금증 문장(질문형 훅)으로 다시 뽑았습니다.
- `에드 라이언`, `연인`, `자작극`, `계략` 같은 기존 날조/오기 표현은 최종 `compression_slot_fills.json`에 남지 않았습니다.
- `caption_kr_dialogue`는 각 `dialogue_focus_lines`와 1:1 개수를 유지합니다.

## 프롬프트에 실제 들어간 B / C 줄

파일: `server/services/midformCompressionService.js`

### B 규칙 (사건 먼저 시작)

line 1263:

```js
'- Start with the incident/hook before backstory. Do not open a narration slot by explaining who someone is if a more immediate event, reversal, threat, or question can lead the sentence first.',
```

### C 규칙 (대사 반복 금지)

line 1280:

```js
'- Do not repeat a preserved dialogue line in narration with the same informational content. If KEEP_DIALOGUE already says the core beat, narration must add setup, consequence, stakes, or interpretation instead of paraphrasing the same line.',
```

## 이번에 추가한 보강 사항

프롬프트만으로는 모델이 KEEP_DIALOGUE 슬롯에 불필요한 나레이션을 다시 붙이는 경우가 있어, 검증기에서도 막도록 했습니다.

파일: `server/services/midformCompressionService.js`

- 비-`payoff` `KEEP_DIALOGUE` 슬롯은 `narration`, `caption_kr`, `caption_units`가 비어 있어야만 통과
- 제목 후보 3개는 모두 궁금증 문장(질문형/의문형 훅)이어야만 통과
- 제목 후보에는 과한 인과 단정(예: `계략`, `자작극`)을 유도하지 않도록 프롬프트를 보강

## 재생성 실행 정보

실행 명령:

```bash
node scripts/midform.js compress-apply compress_20260720213249_3e-5BAhZQ5w
```

컨텍스트 파일:

- `midform/test_runs/compress_20260720213249_3e-5BAhZQ5w/context.md`

생성 산출물:

- `midform/test_runs/compress_20260720213249_3e-5BAhZQ5w/compression_slot_fills.json`
- `midform/test_runs/compress_20260720213249_3e-5BAhZQ5w/upload_text.md`
- `midform/test_runs/compress_20260720213249_3e-5BAhZQ5w/compress_apply_state.json`

## 최종 검증 결과

### 1) 첫 나레이션이 사건으로 시작하는지 (B 효과)

최종 `slot_01.narration`:

```text
쫓던 사냥꾼이, 어쩌다 사냥감이 되었을까?
```

판정:

- **통과** — 인물 배경 설명으로 시작하지 않고, 바로 사건/역전 질문으로 시작합니다.

### 2) upload_text.md 생성 여부 + 제목 후보 3개가 궁금증 문장인지

생성 파일:

- `midform/test_runs/compress_20260720213249_3e-5BAhZQ5w/upload_text.md`

최종 제목 후보 3개:

1. `쫓던 보안관이 어쩌다 적들의 미끼가 되었나?`
2. `아들을 구하려던 아버지는 왜 사냥감이 되었을까?`
3. `인질범의 위험한 제안, 대체 무슨 꿍꿍이였나?`

판정:

- **통과** — 3개 모두 질문형/궁금증 훅으로 생성됐습니다.

### 3) 기존 유지: 채드/제드/챠스카 정확, 인과 날조 0, caption 1:1

#### 이름/사실성

최종 `compression_slot_fills.json`에서 확인:

- `제드` 표기 유지
- `브릿` 표기 유지
- 잘못된 `에드 라이언` 없음
- 잘못된 `연인` 없음
- `자작극`, `계략`, `꾸몄다` 같은 단정형 날조 표현 없음
- `차스카`/`Chaska`는 최종 narration 본문에는 직접 등장하지 않지만, 잘못된 다른 이름으로 치환되지는 않았음

#### caption 1:1

`validateSlotFillsDialogueCaptions()`와 최종 산출물 기준으로, KEEP_DIALOGUE 슬롯들의 `caption_kr_dialogue` 개수는 `dialogue_focus_lines`와 일치합니다.

예시:

- `slot_03`: 3줄 ↔ 3줄
- `slot_06`: 4줄 ↔ 4줄
- `slot_10`: 4줄 ↔ 4줄

판정:

- **통과**

## 재생성 최종 나레이션 전문

최종 `compression_slot_fills.json` 기준, 비어 있지 않은 나레이션만 적었습니다.

### slot_01

```text
쫓던 사냥꾼이, 어쩌다 사냥감이 되었을까?
```

### slot_02

```text
연방보안관 브릿은 납치된 아들을 구하기 위해 무법자 제드를 추격합니다. 마침내 오두막으로 몰아넣지만, 제드는 브릿의 약점을 파고들며 위험한 협상을 제안합니다.
```

나머지 KEEP_DIALOGUE 슬롯(`slot_03`, `slot_04`, `slot_05`, `slot_06`, `slot_07`, `slot_08`, `slot_10`)은 이번 보강 검증에 따라 나레이션 없이 대사 자막만 유지됩니다.

## 코드 검증

실행 명령:

```bash
npm run verify
```

결과:

- `check:encoding` ✅
- `verify:js` ✅
- `verify:py` ✅
- `verify:fixture` ✅ 명령 종료 성공

참고로 `verify:fixture` 출력 안에는 기존 fixture 리포트의 `status: failed` 문자열이 그대로 보이지만, 저장소의 필수 검증 명령 전체는 종료 코드 0으로 성공했습니다.

## 관련 경로

- 프롬프트/검증 로직: `server/services/midformCompressionService.js`
- Catch 컨텍스트: `midform/test_runs/compress_20260720213249_3e-5BAhZQ5w/context.md`
- 최종 slot fills: `midform/test_runs/compress_20260720213249_3e-5BAhZQ5w/compression_slot_fills.json`
- 최종 업로드 텍스트: `midform/test_runs/compress_20260720213249_3e-5BAhZQ5w/upload_text.md`
- 이 보고서: `docs/raw/completion-report-2026-07-23-catch-compress-apply-bc-check.md`
