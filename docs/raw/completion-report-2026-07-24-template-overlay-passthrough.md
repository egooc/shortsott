# 템플릿 이미지/스티커/비디오 오버레이 passthrough 구현 보고

## 파일 위치

- 수정 파일: `scripts/capcut_draft.py`
- 보고서 파일: `docs/raw/completion-report-2026-07-24-template-overlay-passthrough.md`

## 결론

기존 midform CapCut 생성 경로는 텍스트 마커와 일부 명명된 배경/프레임 처리에 집중되어 있어, 일반 템플릿 이미지/스티커/비디오 오버레이 트랙을 자동 보존하지 못했습니다. 이번 수정으로 템플릿의 일반 오버레이 트랙을 최종 draft에 통과시키는 `apply_template_overlay_passthrough()`를 추가했습니다.

## 적용 내용

- `source_video` 계열 템플릿 트랙은 원본 소스 footage로 판단해 제외합니다.
- `video`, `image`, `sticker` 타입의 비소스 트랙을 passthrough 대상으로 처리합니다.
- 대상 segment의 `images`, `stickers`, `videos` material을 복제합니다.
- material에 파일 경로가 있으면 draft 내부 `overlay/` 폴더로 복사한 뒤, 복제 material의 경로를 복사본 절대경로로 갱신합니다.
- 절대경로/상대경로가 유효하지 않거나 복사 실패하면 `missing_paths`에 기록하고 해당 segment는 건너뜁니다.
- 결과는 `edit_manifest.json`의 `template_overlay_passthrough`와 `capcut_notes.md`의 `Template Overlay Passthrough` 항목에 기록됩니다.

## 현재 템플릿 상태

현재 템플릿 `templates/capcut/channel_default/실패한 아내를 질책한 남편의 숨겼던 진심/draft_content.json`에는 실제 이미지/스티커 material이 없습니다.

- `materials.images`: 0
- `materials.stickers`: 0
- `materials.videos`: 18
- 확인된 video track은 `source_video` 성격이므로 passthrough 대상에서 제외됩니다.

따라서 현재 템플릿만으로는 실제 이미지/스티커 보존 render를 검증할 수 없고, 이미지/스티커가 포함된 새 템플릿이 들어오면 이번 passthrough 로직이 작동합니다.

## 검증

- `python -m py_compile scripts/capcut_draft.py`: 통과
- synthetic passthrough test: 통과
  - 템플릿 이미지 material 1개를 draft `overlay/` 폴더로 복사
  - `source_video` 트랙은 제외
  - `template_passthrough_badge_overlay` 트랙 생성 확인
- `npm run verify`: 통과

## 비고

이번 작업은 API 호출이나 full render를 수행하지 않았습니다. 사용자가 제한한 full render 1회 정책을 지키기 위해, 실제 render는 이미지/스티커가 포함된 템플릿 확정 후 별도로 진행하는 것이 안전합니다.
