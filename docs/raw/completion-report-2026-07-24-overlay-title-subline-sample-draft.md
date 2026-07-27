# 완료 보고서 — overlay_title 확정 반영, TEMPLATE_TITLE_SUBLINE 지원, 수정용 샘플 draft 생성

## 요약

사용자 확정 사항을 반영했습니다.

화면 오버레이 제목:

```text
top: 쫓던 보안관이
bottom: 미끼가 된 날
```

미정 화자 4건과 같은 슬롯의 나머지 미지정 대사는 모두 `남조연`으로 지정했습니다. `남조연`은 기존 색상 규칙에 따라 연두 `#A8D96C`가 적용됩니다.

또한 코드에 `TEMPLATE_TITLE_SUBLINE` marker를 지원하도록 추가했습니다. 이제 새 템플릿에 `TEMPLATE_TITLE_SUBLINE` marker가 있으면 고정 제목 아랫줄은 그 marker를 사용하고, timed 자막 style source는 계속 `TEMPLATE_SUBTITLE`을 사용합니다.

## 생성된 수정용 샘플 draft

CapCut에서 열어 수정할 샘플 draft:

- `server/output/drafts/pipeline_1784828787`

샘플 ZIP:

- `server/output/drafts/pipeline_1784828787.zip`

샘플 입력 JSON:

- `midform/test_runs/run_20260723_220404_Chaska_Kept_Jed_Alive_Long_Enough_to_Make_Him_Pa/template_edit_sample_draft_input.json`

샘플 draft 내용:

- 제목 윗줄: `더미제목상`
- 제목 아랫줄: `더미제목하`
- timed 자막 48개
- 기존 ElevenLabs TTS 11개 재사용
- 화자 색상 포함

샘플 생성 결과:

```json
{
  "audioTrackCount": 11,
  "subtitleTrackCount": 48,
  "warnings": []
}
```

주의:

- 현재 기존 템플릿에는 아직 `TEMPLATE_TITLE_SUBLINE` marker가 없습니다.
- 그래서 이번 샘플 draft는 `TEMPLATE_SUBTITLE`을 fallback으로 사용해 제목 아랫줄을 만들었습니다.
- CapCut에서 템플릿을 수정할 때는 제목 아랫줄용 text marker를 새로 만들고, 텍스트를 정확히 `TEMPLATE_TITLE_SUBLINE`으로 저장해야 다음 pipeline 생성부터 fallback 없이 분리됩니다.

## 코드 변경 내용

### 1. `TEMPLATE_TITLE_SUBLINE` marker 지원

파일:

- `scripts/capcut_draft.py`

변경:

- marker detection 목록에 `TEMPLATE_TITLE_SUBLINE` 추가
- 고정 제목 아랫줄 overlay가 `TEMPLATE_TITLE_SUBLINE`을 우선 사용하도록 변경
- 기존 템플릿 호환을 위해 `TEMPLATE_TITLE_SUBLINE`이 없으면 `TEMPLATE_SUBTITLE`로 fallback
- timed 자막 rebuild는 계속 `TEMPLATE_SUBTITLE`을 style source로 사용

새 구조:

```text
TEMPLATE_TITLE          -> 고정 제목 윗줄
TEMPLATE_TITLE_SUBLINE  -> 고정 제목 아랫줄
TEMPLATE_SUBTITLE       -> timed 자막 style source
```

### 2. `overlay_title` 필드 지원

파일:

- `server/services/midformCompressionService.js`
- `midform/schemas/midform_slot_fills_schema.json`
- `server/services/midformBootstrapAdapterService.js`
- `scripts/capcut_draft.py`

변경:

- `upload_text.overlay_title` 추가
- schema에서 `overlay_title.top`, `overlay_title.bottom` 필수화
- 각 줄 `maxLength: 8`
- upload_text markdown에 `화면 오버레이 제목` 섹션 추가
- bootstrap script 생성 시 `upload_text.overlay_title`을 `script.title_block.overlay_title`로 전달
- CapCut draft 생성 시 `title_block.overlay_title.top/bottom`을 우선 사용

프롬프트 규칙 추가:

```text
upload_text.overlay_title is required and must be separate from YouTube title_candidates.
It must be an object with top and bottom strings, each 8 Korean characters or fewer.
```

### 3. 이번 run 확정 title/speaker 반영

파일:

- `midform/test_runs/run_20260723_220404_Chaska_Kept_Jed_Alive_Long_Enough_to_Make_Him_Pa/script.json`

반영 title:

```json
{
  "overlay_title": {
    "top": "쫓던 보안관이",
    "bottom": "미끼가 된 날"
  }
}
```

반영 speaker:

| 대사 | speaker | 색상 |
|---|---|---|
| 우린 미끼였소. | 남조연 | `#A8D96C` |
| 이제 쌤쌤이라는 게 대체 무슨 뜻이었을까? | 남조연 | `#A8D96C` |
| 인디언이요? 그래, 조금 전에 습격당했어. | 남조연 | `#A8D96C` |
| 죽은 줄 알았는데. | 남조연 | `#A8D96C` |
| 저 뒤에서 시체들을 태우고 있더군. | 남조연 | `#A8D96C` |

검증 summary:

```json
{
  "overlay": {
    "top": "쫓던 보안관이",
    "bottom": "미끼가 된 날"
  },
  "speakerCounts": {
    "제드": 5,
    "브릿": 4,
    "챠스카": 1,
    "남조연": 8
  }
}
```

## TTS 재사용

이번 run의 `draft_input.json` 재생성 결과:

```json
{
  "reused_count": 11,
  "regenerated_count": 0,
  "changed_segment_ids": []
}
```

즉, 새 TTS 호출은 없었습니다.

## 사용자가 CapCut에서 해야 할 작업

샘플 draft 열기:

- `server/output/drafts/pipeline_1784828787`

수정 권장:

1. `더미제목상` 위치/크기 조정
2. `더미제목하` 위치/크기 조정
3. timed 자막 track 위치/크기 조정
4. 제목 아랫줄용 marker를 `TEMPLATE_TITLE_SUBLINE`으로 저장
5. timed 자막 style source marker는 `TEMPLATE_SUBTITLE`로 따로 유지

템플릿 교체 방식:

- 수정한 CapCut draft folder를 현재 template folder와 같은 구조로 저장/복사합니다.
- 현재 template root:
  - `templates/capcut/channel_default/실패한 아내를 질책한 남편의 숨겼던 진심`
- 교체 후 다음 pipeline render에서 `scripts/capcut_draft.py`가 새 marker를 자동 탐지합니다.

## 최종 Catch render 상태

최종 Catch render 1회는 아직 실행하지 않았습니다.

이유:

- 사용자 요청 순서가 “사용자 템플릿 수정·교체 후 → 위 제목/화자 반영해서 Catch 최종 render 1회”였기 때문입니다.
- 현재는 코드와 run 데이터, 샘플 draft까지 준비 완료 상태입니다.

템플릿 수정/교체가 끝나면 다음 단계에서 최종 render 1회를 실행하면 됩니다.

## 검증

실행 명령:

```bash
npm run verify
```

결과:

- `check:encoding` 통과
- `verify:js` 통과
- `verify:py` 통과
- `verify:fixture` 종료 코드 0으로 통과

참고:

- `scripts/capcut_draft.py`는 기존 대형 Python 파일의 Pyright 타입 경고가 다수 표시되지만, 이번 변경은 `py_compile` 및 전체 verify를 통과했습니다.

## 보고서 위치

- `docs/raw/completion-report-2026-07-24-overlay-title-subline-sample-draft.md`
