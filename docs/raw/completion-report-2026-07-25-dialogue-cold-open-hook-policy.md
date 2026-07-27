# 발화대사형 콜드오픈 훅 정책 수정 완료 보고서

## 보고서 위치

- `docs/raw/completion-report-2026-07-25-dialogue-cold-open-hook-policy.md`

## 판단

사용자 의견대로, 훅 장면이 대사 중심일 때는 나레이션으로 덮는 것보다 원본 발화대사와 한국어 발화대사 자막을 같이 살리는 편이 훅이 더 강합니다.

기존 방식은 콜드오픈을 무조건 `NARRATE`로 강제하고, 원본 대사는 뒤쪽 `body_peak`에서 다시 보여주는 구조였습니다. 이 방식은 설명은 안정적이지만, “간식거리를 데려왔군”처럼 장면 자체의 대사가 훅인 경우에는 첫인상이 약해지는 문제가 있었습니다.

## 수정 내용

수정 파일:

- `server/services/midformCompressionService.js`

적용한 정책:

1. `cold_open` 후보 beat가 다음 조건을 만족하면 `KEEP_DIALOGUE`를 우선합니다.
   - `dialogue_quality === "high"`
   - `hook_potential >= 4`
   - anchor dialogue 중심의 발화 구간이 `16초` 이하
2. `KEEP_DIALOGUE` 콜드오픈은 원본 음성을 보존하고, 한국어 발화대사 자막으로 훅을 전달합니다.
3. 콜드오픈이 이미 원본 대사를 사용한 경우, 뒤쪽 `body_peak`는 같은 소스 대사를 중복 사용하지 않고 이후 맥락/여파 나레이션으로 이어갑니다.
4. 기존 저장된 edit plan을 `refreshCompressionPlan(...)`으로 새 정책에 맞게 갱신할 수 있게 했습니다.
5. 기존 validator의 “콜드오픈은 6.5초 이하” 규칙은 나레이션형 콜드오픈에만 적용하고, 발화대사형 콜드오픈은 최대 `16초`까지 허용하도록 분리했습니다.

## Twilight run 반영 결과

갱신한 파일:

- `midform/test_runs/compress_20260724234621_Jgx4vgcMWb4/edit_plan.json`
- `midform/test_runs/compress_20260724234621_Jgx4vgcMWb4/narrative_beats.md`

Twilight plan의 콜드오픈이 다음처럼 바뀌었습니다.

```text
role: cold_open
decision: KEEP_DIALOGUE
time: 6:42-6:52
visual_source_mode: source_dialogue_hook
dialogue_focus:
- you brought a snack
- the girl is with us
```

뒤쪽 `body_peak`는 같은 대사를 반복하지 않도록 `NARRATE`로 전환했습니다.

```text
role: body_peak
decision: NARRATE
time: 6:52-7:23
reason: Body peak continues the hook beat after the preserved cold-open dialogue, without duplicating the same source lines.
```

중복/겹침 방지를 위해 기존 closing slot은 `DROP` 처리했습니다.

## API / 렌더 사용 여부

- 추가 API 호출: 없음
- 추가 영상 render: 없음
- 수행한 작업은 코드 수정과 로컬 edit plan refresh뿐입니다.

## 검증

- `node --check server/services/midformCompressionService.js` 통과
- LSP diagnostics error 없음
- `npm run verify` 통과
  - `npm run check:encoding`
  - `npm run verify:js`
  - `npm run verify:py`
  - `npm run verify:fixture`

## 참고

이번 작업은 planning policy와 Twilight compression edit plan까지 반영한 상태입니다. 실제 새 드래프트까지 이 구조로 만들려면, 다음 단계에서 slot fills를 새 edit plan 기준으로 다시 생성한 뒤 CapCut draft를 재생성해야 합니다. 그 과정은 GPT/Codex slot fill 호출이 필요할 수 있으므로, API 호출 제한을 확인한 뒤 진행하는 것이 안전합니다.
