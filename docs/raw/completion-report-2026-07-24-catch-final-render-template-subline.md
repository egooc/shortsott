# Catch 최종 Render 완료 보고서 — TEMPLATE_TITLE_SUBLINE 템플릿 교체

## 결과 요약

- 최종 CapCut draft 생성 완료: `server/output/drafts/pipeline_1784871582`
- ZIP 생성 완료: `server/output/drafts/pipeline_1784871582.zip`
- render 실행 횟수: 1회
- render warnings: 없음
- 오디오 모드: absolute path mode
- TTS 재사용 상태: 기존 `draft_input.json` 기반, audio track 11개 생성

## 템플릿 교체 내용

- 사용자 수정 샘플 draft: `server/output/drafts/pipeline_1784828787`
- 적용 대상 템플릿: `templates/capcut/channel_default/실패한 아내를 질책한 남편의 숨겼던 진심`
- rollback 백업: `templates/capcut/channel_default/실패한 아내를 질책한 남편의 숨겼던 진심_backup_20260724_143315`

사용자 샘플 draft는 render 결과 폴더 구조였고, 기존 템플릿은 CapCut 프로젝트 폴더 구조였기 때문에 폴더 전체 교체 대신 기존 템플릿 폴더를 유지하고 `draft_content.json`만 사용자 수정본 기반으로 교체했습니다. 이 방식으로 기존 CapCut 보조 리소스는 보존하면서 사용자 수정 위치/스타일이 반영된 text track 구조를 적용했습니다.

## Render 전 marker 확인

최종 템플릿 위치의 `draft_content.json`에서 아래 marker가 확인됐습니다.

- `TEMPLATE_TITLE`: 있음, y=`0.58`
- `TEMPLATE_TITLE_SUBLINE`: 있음, y=`0.43`
- `TEMPLATE_SUBTITLE`: 있음, y=`-0.26675079176563754`

따라서 title subline은 `TEMPLATE_SUBTITLE` fallback이 아니라 별도 `TEMPLATE_TITLE_SUBLINE` marker에서 탐지되는 상태로 render를 실행했습니다.

## 최종 draft 검증

최종 draft: `server/output/drafts/pipeline_1784871582`

확인 파일:

- `server/output/drafts/pipeline_1784871582/capcut_notes.md`
- `server/output/drafts/pipeline_1784871582/edit_manifest.json`
- `server/output/drafts/pipeline_1784871582/draft_content.json`

확인 결과:

- 고정 title top: `쫓던 보안관이`
- 고정 title bottom: `미끼가 된 날`
- title top track 위치: y=`0.58`
- title bottom track 위치: y=`0.43`
- timed subtitle 위치: y=`-0.26675079176563754`
- subtitle segment 수: 48
- audio track 수: 11
- 전체 길이: `107.276999`초
- warnings: 없음

대사 자막 색상도 material style에 반영됐습니다.

- `제드`/`챠스카`/`남조연` 계열: `#A8D96C`
- `브릿` 계열: `#7EC8E3`

## 검증 명령

아래 검증을 완료했습니다.

```bash
npm run verify
```

결과:

- `check:encoding`: 통과
- `verify:js`: 통과
- `verify:py`: 통과
- `verify:fixture`: 통과

참고: `verify:fixture`의 caption balance reporter는 기존 fixture 통계에서 `status: failed`를 JSON으로 출력하지만, npm 검증 명령 자체는 정상 종료했습니다. 이는 이번 최종 render 변경으로 새로 발생한 실패가 아닙니다.
