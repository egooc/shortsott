# Twilight 수정값 반영 드래프트 재생성 완료 보고서

## 보고서 위치

- `docs/raw/completion-report-2026-07-25-twilight-draft-regeneration.md`

## 작업 요약

- 기존 Twilight run 입력값을 그대로 사용해 CapCut draft만 재생성했습니다.
- Gemini/GPT/ElevenLabs 등 외부 API 호출은 하지 않았습니다.
- 영상 렌더링도 하지 않았습니다.
- 재생성에는 로컬 명령만 사용했습니다.

```text
python scripts/capcut_draft.py midform/test_runs/run_20260724_235644_The_Cullens_Legendary_Vampire_Baseball_Game_Full/draft_input.json
```

## 생성 결과

- 새 draft 폴더: `server/output/drafts/pipeline_1784906226`
- 새 draft ZIP: `server/output/drafts/pipeline_1784906226.zip`
- manifest: `server/output/drafts/pipeline_1784906226/edit_manifest.json`
- notes: `server/output/drafts/pipeline_1784906226/capcut_notes.md`
- subtitles: `server/output/drafts/pipeline_1784906226/subtitles/subtitles.srt`

## Draft 생성 상태

- 총 길이: `74.653초`
- 오디오 트랙 수: `14`
- 자막 트랙 수: `37`
- 템플릿 사용: `true`
- 템플릿 clone mode: `true`
- CapCut warnings: 없음
- ZIP 생성 확인: 완료

## 수정값 반영 확인

### 프레이밍

- 적용 method: `portrait_180_multi_200_single_uniform_vertical_face_anchor`
- crop record 수: `9`
- scale 분포:
  - `1.8`: 8개 컷
  - `2.0`: 1개 컷
- 세로 anchor 값: 전 컷 `0.42`
- warnings: 없음

### 발화대사 자막 색상

`edit_manifest.json` 기준 발화대사 caption color가 정상 반영됐습니다.

```text
Alice    -> #FFC137
Edward   -> #00A9F7
James    -> #37FF3D
Carlisle -> #37FF3D
```

`draft_content.json` 실제 text material 기준으로도 colored dialogue material `5개`가 확인됐습니다.

```text
#FFC137: 2개
#00A9F7: 1개
#37FF3D: 2개
```

## 검증

- `npm run verify` 통과
  - `npm run check:encoding`
  - `npm run verify:js`
  - `npm run verify:py`
  - `npm run verify:fixture`

## 참고

`npm run verify:fixture` 내부의 caption balance 리포트는 기존 fixture 기준 `status: failed` JSON을 출력하지만, 명령 자체는 정상 종료되어 전체 `npm run verify`는 통과했습니다. 이번 draft 재생성으로 인한 신규 오류는 확인되지 않았습니다.
