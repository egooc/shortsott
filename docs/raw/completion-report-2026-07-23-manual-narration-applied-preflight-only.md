# 완료 보고서 — 수동 확정본 반영 + preflight-only 확인

## 대상 run

- `midform/test_runs/compress_20260721224323_3e-5BAhZQ5w`

## 이번에 한 일

1. 사용자가 준 수동 확정본으로 `compression_slot_fills.json`의 나레이션을 직접 교체했습니다.
2. 같은 톤의 4개 예시를 `buildSlotFillsPrompt()` 안에 "좋은 나레이션 예시"로 등록했습니다.
3. `bootstrap --preflight-only`를 실행해, 수동 교체본이 실제 bootstrap/render 경로에 그대로 반영되는지 확인했습니다.
4. 저장소 필수 검증 `npm run verify`도 실행했습니다.

## 수정 파일

- `midform/test_runs/compress_20260721224323_3e-5BAhZQ5w/compression_slot_fills.json`
- `server/services/midformCompressionService.js`

## 1) 수동 확정본 반영 내용

아래 슬롯의 `narration`을 수동 확정본으로 교체했습니다.

- `slot_1`
- `slot_2`
- `slot_5`
- `slot_closing`

그리고 downstream 경로에서 자막 텍스트 불일치가 나지 않도록, 같은 슬롯들의:

- `caption_units`
- `caption_kr`

도 새 나레이션에 맞게 같이 정렬했습니다.

## 2) caption_units / render 반영 경로 확인

확인 결과, bootstrap/render 경로의 권위는 `compression_slot_fills.json`입니다.

### bootstrap 단계

파일: `server/services/midformBootstrapAdapterService.js`

- `compression_slot_fills.json`을 직접 읽습니다.
- NARRATE 슬롯은 `fill.narration`과 `fill.caption_kr`를 읽어 `bootstrap_script.json`의 `narration` / `caption_text`로 넘깁니다.

즉, **수동 교체한 narration은 bootstrap에 그대로 반영**됩니다.

### draft/TTS 단계

파일: `midform/scripts/assemble_slot_draft_input.py`

- TTS 문장 분할은 `segment.get("narration")`을 기준으로 다시 이뤄집니다.
- 화면 자막 `captionUnits`도 narration/caption_text를 다시 잘라 만듭니다.

즉, **나레이션 길이가 바뀌어도 TTS 길이와 caption unit은 후단에서 다시 생성**되므로, 수동 교체본이 그대로 최종 오디오 길이 권위가 됩니다.

## 3) 좋은 나레이션 예시 등록

파일: `server/services/midformCompressionService.js`

`buildSlotFillsPrompt()`에 아래 4개를 "Good narration examples (tone target)"로 추가했습니다.

- cold_open 예시
- bridge/setup 예시
- body glue 예시
- closing 예시

의도는 다음 영상부터 규칙 나열보다 **이 예시 톤을 직접 모방**하게 하는 것입니다.

## 4) preflight-only 결과

실행 명령:

```bash
node scripts/midform.js bootstrap compress_20260721224323_3e-5BAhZQ5w --preflight-only
```

결과:

- `preflight_ok: true`
- 모든 gate PASS
- `startRun NOT invoked`

즉, **render 직전 상태까지는 문제 없이 통과**했고, 요청대로 여기서 멈췄습니다.

## 5) 수동 교체본이 bootstrap에 실제 반영됐는지 확인

생성 파일:

- `midform/test_runs/compress_20260721224323_3e-5BAhZQ5w/bootstrap_script.json`

이 파일 안에서 아래 텍스트가 그대로 확인됐습니다.

- `쫓던 쪽이, 왜 사냥당하는 쪽이 됐을까?`
- `아들이 납치됐습니다. 범인은 무법자, 제드. 보안관은 놈들을 건물 하나까지 몰아넣었죠. 하지만 — 순순히 나올 놈이 아니었습니다.`
- `협상은, 비극으로 끝났습니다. 그래도 멈출 수 없습니다. 아들이 저들 손에 있으니까. 그런데 추격 중 — 길잡이가 이상한 걸 발견합니다. 놈들 발자국에 섞인, 다른 흔적. 함정일지도 모른다는 경고. 하지만 보안관에겐, 망설일 시간이 없었습니다.`
- `경고는 현실이 됐습니다. 그 혼란을 틈타, 제드는 아들과 함께 사라졌죠. 쫓던 자는 미끼가 됐고 — 아들은 아직, 저들 손에 있습니다.`

따라서 **수동 교체본은 render 경로로 실제 전달됩니다.**

## 6) 검증

실행 명령:

```bash
npm run verify
```

결과:

- `check:encoding` ✅
- `verify:js` ✅
- `verify:py` ✅
- `verify:fixture` ✅ 명령 종료 성공

참고로 `verify:fixture` 출력에는 기존 fixture 리포트의 `status: failed` 문자열이 계속 보이지만, 저장소의 필수 검증 명령 전체는 종료 코드 0으로 성공했습니다.

## 관련 경로

- 수동 반영 slot fills: `midform/test_runs/compress_20260721224323_3e-5BAhZQ5w/compression_slot_fills.json`
- bootstrap 산출물: `midform/test_runs/compress_20260721224323_3e-5BAhZQ5w/bootstrap_script.json`
- 프롬프트 코드: `server/services/midformCompressionService.js`
- 이 보고서: `docs/raw/completion-report-2026-07-23-manual-narration-applied-preflight-only.md`
