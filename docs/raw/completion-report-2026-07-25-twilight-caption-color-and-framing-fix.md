# Twilight 자막 색상 및 프레이밍 수정 완료 보고서

## 보고서 위치

- `docs/raw/completion-report-2026-07-25-twilight-caption-color-and-framing-fix.md`

## 수정 요약

- Twilight 렌더 입력의 실제 화자명(`Alice`, `Edward`, `James`, `Carlisle`)이 기존 색상 설정에 없어서 발화대사 자막 색상이 비어 있던 문제를 수정했습니다.
- `midform/config/caption_colors.json`에 Twilight 주요 화자 영문/한글 별칭을 추가했습니다.
- `scripts/capcut_draft.py`의 세로 프레이밍 정책을 요청 기준으로 되돌렸습니다.
  - 다인물 감지: `1.8`
  - 단독 인물 감지: `2.0`
  - 최대 확대 상한: `2.0`
  - 세로 기준점: 모든 컷 `0.42`로 고정
- 얼굴 감지는 이제 가로 중심 이동과 단독/다인물 확대율 판정에만 사용하고, 세로 위치는 컷마다 흔들리지 않게 고정했습니다.

## 수정 파일

- `scripts/capcut_draft.py`
- `midform/config/caption_colors.json`

## 색상 확인 결과

다음 실제 Twilight 화자명이 색상으로 정상 해석되는 것을 확인했습니다.

```text
Alice    -> #FFC137
Edward   -> #00A9F7
James    -> #37FF3D
Carlisle -> #37FF3D
Bella    -> #FF55B5
```

## 렌더/API 사용 여부

- 추가 API 호출: 없음
- 추가 전체 render: 없음
- 기존 Twilight draft `server/output/drafts/pipeline_1784905027` 자체를 재렌더하지는 않았습니다.
- 다음 CapCut draft 생성부터 수정된 자막 색상/프레이밍 정책이 적용됩니다.

## 검증

- `python -m py_compile scripts/capcut_draft.py` 통과
- LSP diagnostics: error 없음
- `npm run verify` 통과
  - `npm run check:encoding`
  - `npm run verify:js`
  - `npm run verify:py`
  - `npm run verify:fixture`

## 참고

`npm run verify:fixture` 내부의 caption balance 리포트는 기존 fixture에 대해 `status: failed` JSON을 출력하지만, 해당 스크립트가 비정상 종료하지 않아 전체 `npm run verify` 명령은 성공 종료했습니다. 이번 변경으로 인한 새 오류는 확인되지 않았습니다.
