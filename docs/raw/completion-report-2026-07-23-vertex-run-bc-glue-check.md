# 완료 보고서 — 최신 Vertex run B/C + 접착 나레이션 재검증

## 대상 run

- `midform/test_runs/compress_20260721224323_3e-5BAhZQ5w`

이 run은 사용자가 지정한 최신 Vertex run이며, body NARRATE(`slot_5`)와 closing(`slot_closing`)이 존재하는 구조입니다.

## 이번에 확인/수정한 것

1. **올바른 최신 run으로 `compress-apply` 재실행**
2. **KEEP 슬롯 narration 강제 비움 검증은 유지**하되, NARRATE 슬롯이 접착 서사를 실제로 담당하는지 확인
3. 최신 run의 `context.md`를 v2 형식으로 보강해 B(사건 먼저) 지시를 더 강하게 주입
4. closing에서 **의도/계략/자작극 단정**을 다시 쓰지 못하도록 프롬프트와 검증을 보강

## 코드 보강

파일: `server/services/midformCompressionService.js`

### 1) 사건 먼저(B) 규칙 강화

기존 B 규칙에 더해, cold open 다음 bridge/body 도입도 사건으로 열도록 보강했습니다.

```js
'- If the context implies 사건 훅 먼저, the first bridge/body narration after the cold open must begin with the kidnapping, standoff, chase, attack, trap, or another live event — not with a standalone character-introduction sentence like a nameplate.',
```

### 2) C 규칙 유지 + KEEP 슬롯 반복 방지 검증 유지

- 비-`payoff` `KEEP_DIALOGUE` 슬롯은 `narration`, `caption_kr`, `caption_units`를 비워야 함
- 즉, C 규칙은 **대사와 같은 내용 반복 금지**이지, **NARRATE 슬롯의 접착 나레이션 금지**가 아님

### 3) closing의 잘못된 인과 단정 방지

```js
'- When answering WHY they became bait, prefer grounded situational causes (for example: entering a Sioux war zone, exposing their trail, or being caught in an existing conflict). Do NOT invent mastermind intent such as saying someone deliberately orchestrated, staged, lured, or set up the Sioux attack unless the provided facts explicitly say so.',
```

또한 검증기에서 narration에 `의도적으로/조작/자작극/계략` + `유인/함정/미끼/습격` 조합이 나오면 실패하도록 추가했습니다.

## 최신 run 컨텍스트 보강

파일:

- `midform/test_runs/compress_20260721224323_3e-5BAhZQ5w/context.md`

기존 축약형 컨텍스트를 v2 형식으로 교체했습니다. 특히 아래를 명시했습니다.

- `배경 설명 위치: 사건 훅 먼저 → 인물 배경은 뒤로 미룸`
- 수우족 습격은 실제 공격이며, 제드의 계략/자작극/의도적 유인으로 단정하지 말 것

## 재생성 실행

실행 명령:

```bash
node scripts/midform.js compress-apply compress_20260721224323_3e-5BAhZQ5w
```

최종 산출물:

- `midform/test_runs/compress_20260721224323_3e-5BAhZQ5w/compression_slot_fills.json`
- `midform/test_runs/compress_20260721224323_3e-5BAhZQ5w/upload_text.md`
- `midform/test_runs/compress_20260721224323_3e-5BAhZQ5w/compress_apply_state.json`

## 최종 검증 결과

### 훅(slot_1)

```text
어쩌다 쫓는 자가 사냥감이 되었을까?
```

- **통과**: 사건형 질문 훅

### 도입(slot_2)

```text
무법자 제드 블레이크에게 12살 아들 채드를 납치당한 연방 보안관 브릿 맥마스터스. 그는 아들을 구하기 위해 제드 일당과 대치하지만, 제드의 손에는 아들 말고도 다른 인질들이 있었습니다.
```

- **통과**: 이번에는 이름표 문장으로 시작하지 않고 `납치당한` 사건으로 열립니다.

### 결과 정리 + 챠스카 브릿지(slot_5)

```text
결국 브릿은 인질들을 풀어주는 대가로 제드에게 도망칠 시간을 내주지만, 돌아온 건 로라의 비극적인 죽음이었습니다. 아들을 되찾기 위한 추격은 이제 복수심에 불타오릅니다. 하지만 추적을 이어가던 중, 동행하던 챠스카가 새로운 발자국들을 발견하고는 함정일 수 있다며 경고합니다.
```

- **통과**
  - 로라 죽음 뒤 결과 정리 있음
  - 챠스카 브릿지 있음
  - KEEP_DIALOGUE 대사 반복이 아니라 결과/전환/위험을 설명하는 접착 나레이션 역할 수행

### 훅 회수 + closing(slot_closing)

```text
챠스카의 경고는 현실이 됐습니다. 추격대는 수우족의 영역에 들어섰고, 이들의 습격으로 큰 피해를 입고 맙니다. 이 혼란을 틈타 제드는 아들 채드를 데리고 유유히 빠져나가고, 브릿은 모든 것을 잃은 채 다시 추격을 시작해야 할 처지에 놓입니다.
```

- **통과**
  - 왜 미끼가 되었는지 훅 회수 있음
  - 설명 방식이 `수우족의 영역에 들어섰고 / 이들의 습격`처럼 **상황적 원인**으로 정리됨
  - 이전처럼 `제드가 의도적으로 유인했다`는 잘못된 인과 단정은 제거됨

## 최종 나레이션 전문

비어 있지 않은 나레이션만 추려 적었습니다.

### slot_1

```text
어쩌다 쫓는 자가 사냥감이 되었을까?
```

### slot_2

```text
무법자 제드 블레이크에게 12살 아들 채드를 납치당한 연방 보안관 브릿 맥마스터스. 그는 아들을 구하기 위해 제드 일당과 대치하지만, 제드의 손에는 아들 말고도 다른 인질들이 있었습니다.
```

### slot_5

```text
결국 브릿은 인질들을 풀어주는 대가로 제드에게 도망칠 시간을 내주지만, 돌아온 건 로라의 비극적인 죽음이었습니다. 아들을 되찾기 위한 추격은 이제 복수심에 불타오릅니다. 하지만 추적을 이어가던 중, 동행하던 챠스카가 새로운 발자국들을 발견하고는 함정일 수 있다며 경고합니다.
```

### slot_closing

```text
챠스카의 경고는 현실이 됐습니다. 추격대는 수우족의 영역에 들어섰고, 이들의 습격으로 큰 피해를 입고 맙니다. 이 혼란을 틈타 제드는 아들 채드를 데리고 유유히 빠져나가고, 브릿은 모든 것을 잃은 채 다시 추격을 시작해야 할 처지에 놓입니다.
```

## upload_text.md 확인

파일:

- `midform/test_runs/compress_20260721224323_3e-5BAhZQ5w/upload_text.md`

제목 후보 3개:

1. `아들을 구하려던 아버지는 왜 적들의 미끼가 되었을까?`
2. `인질범을 쫓던 보안관이 역으로 사냥당하게 된 이유는?`
3. `모든것이 함정이었다면, 이 추격전의 끝은 어떻게 될까?`

## 사실성 확인

최종 `compression_slot_fills.json`에서 아래 금지 표현을 검색했고 **없음**을 확인했습니다.

- `에드 라이언`
- `연인`
- `자작극`
- `계략`
- `꾸몄`
- `의도적으로 ... 유인`

또한 이름/호칭은 아래처럼 정상 유지됩니다.

- `채드`
- `제드 블레이크`
- `챠스카`
- `수우족`

## 검증

실행 명령:

```bash
npm run verify
```

결과:

- `check:encoding` ✅
- `verify:js` ✅
- `verify:py` ✅
- `verify:fixture` ✅ 명령 종료 성공

참고: `verify:fixture` 출력에는 기존 fixture 리포트의 `status: failed` 문자열이 남아 있지만, 저장소의 필수 검증 명령 전체는 종료 코드 0으로 성공했습니다.

## 관련 경로

- 프롬프트/검증 로직: `server/services/midformCompressionService.js`
- 최신 run 컨텍스트: `midform/test_runs/compress_20260721224323_3e-5BAhZQ5w/context.md`
- 최종 slot fills: `midform/test_runs/compress_20260721224323_3e-5BAhZQ5w/compression_slot_fills.json`
- 최종 업로드 텍스트: `midform/test_runs/compress_20260721224323_3e-5BAhZQ5w/upload_text.md`
- 이 보고서: `docs/raw/completion-report-2026-07-23-vertex-run-bc-glue-check.md`
