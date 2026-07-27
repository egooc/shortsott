# CapCut 템플릿 회귀 수정 완료 보고서

## 보고서 위치

- `docs/raw/completion-report-2026-07-24-capcut-template-regression-fix.md`

## 최종 산출물

- 최종 draft: `server/output/drafts/pipeline_1784884747`
- 최종 ZIP: `server/output/drafts/pipeline_1784884747.zip`
- 최종 notes: `server/output/drafts/pipeline_1784884747/capcut_notes.md`
- 최종 manifest: `server/output/drafts/pipeline_1784884747/edit_manifest.json`

## 적용 내용

### 1. 실제 사용자 CapCut 수정본 기준으로 템플릿 재구성

기준 파일:

```text
C:/Users/sejun/Desktop/캡컷아웃풋/CapCut Drafts/pipeline_1784828787/draft_content.json
```

적용 대상:

```text
templates/capcut/channel_default/실패한 아내를 질책한 남편의 숨겼던 진심/draft_content.json
```

백업:

```text
templates/capcut/channel_default/실패한 아내를 질책한 남편의 숨겼던 진심/draft_content.before_actual_user_20260724.json
```

사용자 저장본 구조를 기준으로 유지했고, marker 텍스트만 정정했다.

- `TEMPLATE_TITLE`: 기존 사용자 저장본의 `더미제목상` material 사용
  - material: `e2cc9e99bd0f470b9b8b3fa7885c198a`
  - y: `0.8179421221864952`
- `TEMPLATE_TITLE_SUBLINE`: 사용자 신규 material 보존
  - material: `A5E1E8F0-A18B-4b06-88E6-18DE6F80FAC7`
  - y: `0.6591639871382637`
- `TEMPLATE_SUBTITLE`: timed subtitle source로 별도 유지
  - material: `20e73290e03b4386bc4df53c9deca038`
  - y: `-0.34927652733118975`

### 2. title/source 선택 로직 수정

파일:

```text
scripts/capcut_draft.py
```

수정 사항:

- `TEMPLATE_TITLE_SUBLINE`이 `TEMPLATE_TITLE`로 오인되지 않도록 marker 탐지 순서를 긴 marker 우선으로 변경했다.
- `TEMPLATE_TITLE`은 반드시 `TEMPLATE_TITLE` material에서만 생성하도록 fallback을 제거했다.
- `TEMPLATE_TITLE_SUBLINE`은 반드시 `TEMPLATE_TITLE_SUBLINE` material에서만 생성하도록 fallback을 제거했다.
- 생성 track name을 고정했다.
  - title: `template_title`
  - subline: `template_title_subline`
- `template_title_template_subtitle` 같은 혼종 track name이 다시 나오지 않게 했다.
- title/subline y 위치를 코드 상수로 덮지 않고 template marker 위치를 그대로 복제하도록 변경했다.

### 3. 대사 자막 색상 처리 수정

파일:

```text
scripts/capcut_draft.py
```

수정 사항:

- 색 지정된 대사 자막에 한해 `use_effect_default_color=false`를 설정했다.
- 기존 text effect는 유지했다.
  - `简约-黑投影`
  - `빛나는 네온`
- 색은 material fill/text_color를 따르도록 했다.

외부 조사 결과도 같은 방향을 지지했다.

- `use_effect_default_color=true`: effect 기본색 사용
- `use_effect_default_color=false`: `text_color` 또는 `content.styles[].fill`의 custom color 사용
- text effect는 `content.styles[].effectStyle`/extra effect로 독립 저장되므로, `use_effect_default_color=false`로 바꿔도 effect 자체를 제거하지 않는다.

## 최종 render 결과

최종 render:

```text
server/output/drafts/pipeline_1784884747
```

render 결과:

- warnings: 없음
- audio track count: `11`
- subtitle track count: `48`
- duration: `107.276999`초
- TTS: 기존 입력 기반 재사용

최종 marker 탐지:

```text
TEMPLATE_SUBTITLE, TEMPLATE_TITLE, TEMPLATE_TITLE_SUBLINE
```

## 최종 draft 검증

### title/subline track name

혼종 track name 없음.

- title track: `template_title`
- subline track: `template_title_subline`
- timed subtitle track: `subtitle`

### title 위치

사용자 저장본 위치가 유지됐다.

```json
{
  "text": "쫓던 보안관이",
  "trackName": "template_title",
  "y": 0.8179421221864952,
  "text_color": "#f4c70f"
}
```

```json
{
  "text": "미끼가 된 날",
  "trackName": "template_title_subline",
  "y": 0.6591639871382637,
  "text_color": "#cb00ff"
}
```

### 대사 자막 색상

색 지정 대사 자막은 `use_effect_default_color=false`로 생성됐다. effect는 유지됐다.

예시:

```json
{
  "text": "인질이 셋 있다.",
  "text_color": "#A8D96C",
  "use_effect_default_color": false,
  "extraEffects": ["简约-黑投影", "빛나는 네온", "简约-黑投影"]
}
```

```json
{
  "text": "로라, 날 떠나지 마.",
  "text_color": "#7EC8E3",
  "use_effect_default_color": false,
  "extraEffects": ["简约-黑投影", "빛나는 네온", "简约-黑投影"]
}
```

## 검증 명령

최종 수정 후 아래 명령을 다시 실행했다.

```bash
npm run verify
```

결과:

- `check:encoding`: 통과
- `verify:js`: 통과
- `verify:py`: 통과
- `verify:fixture`: 통과

참고: `report_caption_balance.py`는 기존 fixture 통계에서 `status: failed` JSON을 출력하지만, npm 명령 자체는 정상 종료했다. 이번 수정으로 새로 발생한 실패가 아니다.

## 비고

중간 산출물 `pipeline_1784884538`와 `pipeline_1784884678`은 검증 과정에서 실패 조건을 발견한 draft다.

- `pipeline_1784884538`: `TEMPLATE_TITLE_SUBLINE`이 `TEMPLATE_TITLE`로 오인된 문제 확인
- `pipeline_1784884678`: source와 track name은 개선됐지만 title y 위치가 상수로 덮인 문제 확인

최종 사용 대상은 `pipeline_1784884747`이다.
