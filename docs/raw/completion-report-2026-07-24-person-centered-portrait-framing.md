# 인물 중심 180% 소스 영상 프레이밍 적용 보고

## 파일 위치

- 수정 파일: `scripts/capcut_draft.py`
- 보고서 파일: `docs/raw/completion-report-2026-07-24-person-centered-portrait-framing.md`
- 관련 함수: `apply_midform_portrait_crops_to_draft()`

## 결론

진행 가능했고, 적용했습니다. 기존에도 대사 구간은 대부분 `180%` 확대(`clip.scale = 1.8`)였지만, 인물/화자 중심 배치는 없었습니다. 이번 수정으로 대사 구간에서 OpenCV 얼굴 검출이 가능하면 검출된 얼굴 위치를 기준으로 `clip.transform.x/y`를 계산합니다. 검출 실패 시에는 기존 top-third fallback을 그대로 사용합니다.

## 적용 내용

1. `source_video` 대사 구간은 180% 확대를 유지/강제합니다.
   - `dialogue` / `dialogue_quote` segment는 최소 목표 scale을 `MIDFORM_DIALOGUE_FINAL_SCALE_TARGET = 1.8`로 맞춥니다.
   - 기존 cap `MIDFORM_CROP_FINAL_SCALE_CAP = 1.8`은 유지했습니다.

2. 화자/인물 중심 anchor를 추가했습니다.
   - 각 대사 segment의 source 중간 프레임을 샘플링합니다.
   - OpenCV Haar cascade(`frontalface`, `profileface`)로 얼굴 후보를 찾습니다.
   - 가장 크고 중심에 가까운 얼굴을 선택합니다.
   - 선택된 얼굴 중심을 `anchor_x`, `anchor_y`로 변환하고, 기존 CapCut transform 공식에 넣습니다.

3. 안전 fallback을 유지했습니다.
   - OpenCV가 없거나 cascade가 없거나 얼굴 검출에 실패하면 기존 방식으로 돌아갑니다.
   - 기존 방식: dialogue는 top-third anchor, narration은 기본 상단 anchor, wide/action/text shot은 center anchor.

## 기술 메모

추가된 주요 helper:

- `load_opencv_face_cascades()`
- `sample_video_frame()`
- `detect_primary_face_anchor()`
- `clamp_float()`

`apply_midform_portrait_crops_to_draft()`의 method는 다음으로 바뀌었습니다.

```text
portrait_180pct_face_anchor_with_fallback
```

각 crop record에는 이제 segment별 `face_detection` 결과가 들어갑니다.

## 로컬 smoke test 결과

기존 최종 draft `pipeline_1784898451`의 임시 복사본에 대해 render 없이 helper만 호출했습니다.

- 처리 records: 18개
- OpenCV 사용 가능: true
- 얼굴 anchor 적용 segment: 11개
- 검출 실패 segment: 기존 fallback 사용
- API 호출: 없음
- full render: 없음

예시 결과:

```json
{
  "method": "portrait_180pct_face_anchor_with_fallback",
  "face_detection": {
    "attempted": true,
    "available": true,
    "detected_segments": 11,
    "reason": "opencv face anchor enabled"
  }
}
```

## 주의점

이 방식은 “화자 음성 식별”까지 하는 것은 아닙니다. 현재 구현은 대사 구간 프레임에서 보이는 얼굴 중 가장 유력한 인물 얼굴을 잡는 방식입니다. 여러 명이 동시에 크게 보이는 장면에서는 실제 화자와 다른 인물을 잡을 수 있으므로, 향후 더 정밀하게 하려면 다음 단계가 필요합니다.

- 입 움직임/오디오 기반 active speaker detection
- Gemini scene metadata에 인물 위치 힌트 추가
- segment별 수동 anchor override

이번 단계에서는 안정성과 로컬 실행 가능성을 우선해 “얼굴 검출 기반 인물 중심 + 실패 시 기존 fallback”으로 적용했습니다.

## 검증

- `python -m py_compile scripts/capcut_draft.py`: 통과
- 기존 draft 임시 복사본 smoke test: 통과
- 최종 `npm run verify`: 별도 실행 결과를 완료 메시지에 기록합니다.

## 비고

이번 작업은 API 호출과 full render를 수행하지 않았습니다.
