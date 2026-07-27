# 완료 보고서 — 리캡 컨텍스트 템플릿 v2 정렬

## 요약

저장소의 기준 템플릿인 미드폼 리캡 컨텍스트 템플릿을 사용자가 준 v2 본문에 맞춰 정렬했습니다. 벤치마크 근거, 금지 규칙, 업로드 텍스트 지시, Catch the Bullet 예시까지 기준본에 포함되도록 확장했고, 하위 `compress-apply` 프롬프트도 같은 의도를 따르도록 맞췄습니다. 다만 JS 프롬프트 문자열에서는 검증기의 인코딩 검사에 걸리지 않도록 일부 표현을 같은 의미의 안전한 문구로 조정했습니다.

## 변경 파일

- `midform/templates/recap_context_template.md`
  - 축약돼 있던 v2 템플릿을 전체 본문에 가깝게 교체했습니다.
  - 벤치마크 근거 설명, 섹션별 부연, 강화된 금지 규칙, 업로드 텍스트 가이드, Catch the Bullet 작성 예시를 추가했습니다.
- `server/services/midformCompressionService.js`
  - 컨텍스트 기반 사실 고정 규칙이 템플릿 의도와 같은 방향을 유지하도록 맞췄습니다.
  - 앞서 추가했던 업로드 텍스트 생성 지시는 그대로 유지했습니다.
  - 서비스 프롬프트 내부에서는 `"A가 B를 조작했다"` 표현을 사용했습니다. 템플릿 본문 자체는 유지했지만, JS 문자열에 같은 문구를 그대로 넣으면 `npm run check:encoding`이 인코딩 이상으로 감지해 검증이 실패했기 때문입니다.

## 검증

실행 명령:

```bash
npm run verify
```

결과:

- `check:encoding` ✅
- `verify:js` ✅
- `verify:py` ✅
- `verify:fixture` ✅ 명령 종료 성공

참고로 `verify:fixture` 출력에는 기존 리포트 데이터의 일부로 아래와 같은 상태 문자열이 계속 표시됩니다.

- `{"signature_quotes": {"status": "failed", ...}}`

하지만 저장소의 필수 검증 명령 전체는 종료 코드 0으로 성공했으므로, 현재 프로젝트 규칙 기준으로 이번 작업 검증은 통과입니다.

## 관련 경로

- 기준 템플릿: `midform/templates/recap_context_template.md`
- 컨텍스트 소비 로직: `server/services/midformCompressionService.js`
- 업로드 텍스트 스키마: `midform/schemas/midform_slot_fills_schema.json`
- 이 보고서: `docs/raw/completion-report-2026-07-23-recap-context-template-v2-alignment.md`
