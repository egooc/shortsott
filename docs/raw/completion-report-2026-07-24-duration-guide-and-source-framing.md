# draft 길이 가이드 추가 및 소스 영상 프레이밍 조사 보고

## 파일 위치

- 보고서: `docs/raw/completion-report-2026-07-24-duration-guide-and-source-framing.md`
- 길이 설정: `midform/config/duration.json`
- preflight 길이 경고: `midform/scripts/preflight_material_gate.py`, `server/services/midformBootstrapAdapterService.js`
- compress 기본 목표: `server/services/midformCompressionService.js`, `scripts/midform.js`
- render 후 실측 보고: `scripts/capcut_draft.py`
- 조사 대상 최종 draft: `server/output/drafts/pipeline_1784898451/draft_content.json`
- 조사 대상 notes: `server/output/drafts/pipeline_1784898451/capcut_notes.md`

## 적용한 길이 가이드

`midform/config/duration.json`을 추가했습니다.

```json
{
  "min_duration_sec": 60,
  "max_duration_sec": 160
}
```

적용 내용은 다음과 같습니다.

1. preflight 길이 검사는 차단이 아니라 WARN으로 처리합니다.
   - `midform/scripts/preflight_material_gate.py`는 선택 입력 `--edit-plan`, `--tts-manifest`를 받을 수 있게 했고, 있으면 `estimated_total_sec` 또는 TTS 실측 합산을 기준으로 경고를 기록합니다.
   - compression bootstrap preflight(`server/services/midformBootstrapAdapterService.js`)는 `edit_plan.duration_budget.estimated_total_sec`가 160초 초과 또는 60초 미만이면 warning에 추가합니다.
2. render 후 실측 보고를 추가했습니다.
   - `scripts/capcut_draft.py`가 최종 `total_tts_duration_sec` 기준으로 `duration_guide`를 생성합니다.
   - 최종 길이가 160초 초과 또는 60초 미만이면 `warnings`와 `capcut_notes.md`에 명시됩니다.
3. compress 기본 목표치를 180초에서 160초로 변경했습니다.
   - `server/services/midformCompressionService.js`: `DEFAULT_TARGET_SEC = 160`
   - `scripts/midform.js` usage 예시도 `--target 160`으로 갱신했습니다.

## 최종 draft 프레이밍 조사 결과

### 1. 캔버스 크기/비율

`server/output/drafts/pipeline_1784898451/draft_content.json` 기준:

```json
{
  "width": 1080,
  "height": 1920,
  "ratio": "original"
}
```

즉 최종 draft는 1080x1920 세로 캔버스입니다.

### 2. source_video 클립 배치

소스 영상은 `ffprobe` 기준 1920x1080, 즉 16:9 가로 영상입니다. 최종 draft의 `source_video` track에는 18개 segment가 있으며, crop rectangle은 없습니다. 대신 `clip.scale`, `clip.transform`, `uniform_scale`으로 확대/이동합니다.

요약:

- scale 값: `1.5` 또는 `1.8`
- transform.x: 전부 `0.0`
- transform.y: scale 1.5 구간은 `0.028`, scale 1.8 구간은 `0.0455`
- crop: 전부 `null`
- uniform_scale: 전부 `{ "on": true, "value": scale }`

대표 덤프:

| index | timeline start | duration | source start | source duration | scale | transform |
|---:|---:|---:|---:|---:|---:|---|
| 0 | 0.000 | 3.291 | 77.435 | 3.291 | 1.5 | `{x:0.0, y:0.028}` |
| 1 | 3.291 | 10.240 | 111.880 | 10.240 | 1.5 | `{x:0.0, y:0.028}` |
| 2 | 13.531 | 4.870 | 92.160 | 4.870 | 1.8 | `{x:0.0, y:0.0455}` |
| 7 | 32.210 | 12.000 | 220.509 | 12.000 | 1.8 | `{x:0.0, y:0.0455}` |
| 8 | 44.210 | 19.383 | 240.550 | 19.383 | 1.5 | `{x:0.0, y:0.028}` |
| 16 | 95.182 | 9.850 | 588.350 | 9.850 | 1.5 | `{x:0.0, y:0.028}` |

해석: 현재는 명시 crop이 아니라 균일 확대 방식입니다. 16:9 원본을 세로 캔버스에 넣을 때 완전한 세로 fill이 되려면 기하학적으로 약 `3.16x`가 필요하지만, 현재 코드 cap은 `1.8x`입니다. 따라서 완전 세로 fill/좌우 크롭이라기보다, 1.5~1.8배 확대 후 캔버스 안에서 위쪽으로 약간 올리는 방식입니다.

### 3. 값이 어디서 오는가

템플릿의 `source_video` segment 값을 그대로 복제하는 구조가 아닙니다. 최종 source framing은 코드가 계산합니다.

핵심 위치:

- `scripts/capcut_draft.py`
  - 상수:
    - `MIDFORM_CROP_FINAL_SCALE_CAP = 1.8`
    - `MIDFORM_NARRATION_FINAL_SCALE_MIN = 1.2`
    - `MIDFORM_NARRATION_FINAL_SCALE_TARGET = 1.5`
    - `MIDFORM_DIALOGUE_FINAL_SCALE_MIN = 1.4`
    - `MIDFORM_DIALOGUE_FINAL_SCALE_TARGET = 1.8`
    - `MIDFORM_DIALOGUE_SHOT_SCALE_BONUS = 0.1`
    - `MIDFORM_SHOT_TYPE_SCALE_TARGETS`
  - 함수:
    - `apply_midform_portrait_crops_to_draft(...)`

해당 함수가 draft 저장 후 `source_video` track을 찾아 각 segment에 다음 값을 직접 씁니다.

```python
clip["scale"] = {"x": applied_scale, "y": applied_scale}
clip["transform"] = {"x": transform_x, "y": transform_y}
segment["uniform_scale"] = {"on": True, "value": applied_scale}
```

### 4. 세로를 더 채우려면 어디를 바꾸는가

현재 구조에서는 템플릿 수정만으로 source_video 확대율을 바꾸기 어렵습니다. 이유는 render 후반에 `apply_midform_portrait_crops_to_draft()`가 `source_video` segment의 `clip.scale`과 `clip.transform`을 코드에서 덮어쓰기 때문입니다.

변경 지점은 코드입니다.

- 더 크게 확대하려면:
  - `MIDFORM_CROP_FINAL_SCALE_CAP`을 `1.8`보다 크게 조정
  - `MIDFORM_NARRATION_FINAL_SCALE_TARGET`, `MIDFORM_DIALOGUE_FINAL_SCALE_TARGET`, `MIDFORM_SHOT_TYPE_SCALE_TARGETS` 조정
- 완전 세로 fill에 가깝게 하려면:
  - 1920x1080 → 1080x1920 기준 기하학적 fill scale이 약 `3.16`이므로, 현재 cap `1.8`은 부족합니다.
  - 다만 3.16까지 올리면 좌우가 크게 잘리고 인물/대사 위치 손실이 커질 수 있어, shot type별/대사별로 다르게 올리는 방식이 안전합니다.
- 상하 위치를 바꾸려면:
  - `anchor_y` 계산과 `transform_y = round((0.5 - anchor_y) * 0.35, 6)` 부분 조정

이번 요청의 프레이밍 파트는 “수정 금지, 조사만”이므로 source framing 코드는 변경하지 않았습니다.

## 검증

- `python -m py_compile midform/scripts/preflight_material_gate.py scripts/capcut_draft.py`: 통과
- `node --check server/services/midformCompressionService.js`: 통과
- `node --check server/services/midformBootstrapAdapterService.js`: 통과
- 최종 `npm run verify`: 별도 실행 결과를 완료 메시지에 기록합니다.

## 비고

이번 작업은 API 호출과 full render를 수행하지 않았습니다. 길이 가이드와 프레이밍 조사는 로컬 파일/코드 기준으로만 처리했습니다.
