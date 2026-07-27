# 인물 중심 2.1~2.4배 프레이밍 적용 보고

## 파일 위치

- 수정 파일: `scripts/capcut_draft.py`
- 보고서 파일: `docs/raw/completion-report-2026-07-24-person-centered-210-240-framing.md`
- 관련 함수: `apply_midform_portrait_crops_to_draft()`

## 적용 결론

요청대로 단순 180% 유지가 아니라, 최종 소스 영상 프레이밍을 **2.1~2.4배 확대 + 인물/얼굴 중심 배치**로 바꿨습니다.

## 변경 내용

### 확대율 정책

기존 주요 값:

- cap: `1.8`
- narration target: `1.5`
- dialogue target: `1.8`

변경 후:

- `MIDFORM_CROP_FINAL_SCALE_CAP = 2.4`
- `MIDFORM_NARRATION_FINAL_SCALE_MIN = 2.1`
- `MIDFORM_NARRATION_FINAL_SCALE_TARGET = 2.1`
- `MIDFORM_DIALOGUE_FINAL_SCALE_MIN = 2.1`
- `MIDFORM_DIALOGUE_FINAL_SCALE_TARGET = 2.4`

즉 일반/나레이션 구간은 기본 `2.1x`, 대사/인물 강조 구간은 `2.4x`까지 올라갑니다.

### 인물 중심 배치

이전 수정에서는 얼굴 anchor를 대사 구간 위주로만 적용했습니다. 이번에는 모든 source segment에서 source 중간 프레임을 샘플링하고, 얼굴이 검출되면 해당 얼굴 기준으로 `clip.transform.x/y`를 계산합니다.

검출 실패 시에는 기존 fallback을 유지합니다.

- wide/action/text shot: center anchor
- dialogue: top-third fallback
- narration/default: top-third fallback

## 로컬 smoke test 결과

기존 최종 draft `server/output/drafts/pipeline_1784898451/draft_content.json`의 임시 복사본에 helper만 적용했습니다. 실제 최종 draft 파일은 수정하지 않았고, full render도 하지 않았습니다.

결과:

- 처리 segment: 18개
- scale 범위: `2.1 ~ 2.4`
- scale 배열:
  - `[2.1, 2.1, 2.4, 2.4, 2.4, 2.4, 2.4, 2.4, 2.1, 2.4, 2.4, 2.4, 2.4, 2.4, 2.4, 2.4, 2.1, 2.1]`
- 얼굴 anchor 검출 segment: 16개 / 18개
- OpenCV 사용 가능: true

## 예상 화면 변화

이번 변경은 실제로 프레임에서 영상이 더 크게 보이게 만드는 변경입니다.

- 기존: `1.5~1.8x`
- 변경 후: `2.1~2.4x`

따라서 세로 프레임에서 원본 영상이 차지하는 면적이 증가합니다. 다만 16:9 원본을 9:16 세로 캔버스에 완전 fill하려면 기하학적으로 약 `3.16x`가 필요하므로, 이번 값은 완전 fill까지는 아니고 “더 크게, 인물 위주로” 보는 중간 강도 crop입니다.

## 검증

- `python -m py_compile scripts/capcut_draft.py`: 통과
- 임시 draft smoke test: 통과
- 최종 `npm run verify`: 별도 실행 결과를 완료 메시지에 기록합니다.

## 비고

이번 작업은 API 호출과 full render를 수행하지 않았습니다.
