# 확인 보고서 — 템플릿 TITLE/SUBTITLE 구조와 제목 이원화 준비

## 요약

현재 CapCut 템플릿과 최신 draft를 확인한 결과, **고정 제목 오버레이와 실제 timed 자막 track은 이미 별도 track으로 생성**되고 있습니다.

다만 중요한 제약이 하나 있습니다.

- 화면 상단 제목 아랫줄은 `TEMPLATE_SUBTITLE` marker를 사용합니다.
- timed 자막 track도 스타일 원본으로 `TEMPLATE_SUBTITLE` material을 복제합니다.

즉, 위치/크기만 수정하는 목적이라면 CapCut에서 템플릿 marker를 수정하면 됩니다. 하지만 **상단 제목 아랫줄 스타일과 timed 자막 스타일을 완전히 독립적으로 관리하려면 코드/템플릿 marker를 분리하는 변경이 필요**합니다.

## 확인한 파일

템플릿 원본:

- `templates/capcut/channel_default/실패한 아내를 질책한 남편의 숨겼던 진심/draft_content.json`

최신 생성 draft:

- `server/output/drafts/pipeline_1784826254/draft_content.json`
- `server/output/drafts/pipeline_1784826254/edit_manifest.json`
- `server/output/drafts/pipeline_1784826254/capcut_notes.md`

생성 코드:

- `scripts/capcut_draft.py`
- `midform/scripts/assemble_slot_draft_input.py`

## 템플릿 원본 구조

템플릿 원본의 text marker는 아래처럼 서로 다른 text track에 있습니다.

| marker | template track index | segment id | material id | y |
|---|---:|---|---|---:|
| `TEMPLATE_SUBTITLE` | 2 | `25C6394F-8300-4e1a-B5EA-68DE50BDF291` | `81D11076-F143-436f-8331-36A9871B0352` | `-0.26675079176563754` |
| `TEMPLATE_MOVIE_TITLE` | 3 | `DF30A91E-640E-4d6a-8E8D-B7A94C6D3E96` | `14C95602-B67E-4bee-88E0-918BD7ABD72C` | `-0.5469107551487413` |
| `TEMPLATE_TITLE` | 4 | `C39683EA-423C-4b2b-AD93-5AD597421731` | `E22A978B-15E5-4bf2-AF0B-E5EDAD42093F` | `0.5491990846681922` |
| `TEMPLATE_PRETITLE` | 5 | `C383FA6A-2FBB-49b0-9025-E63BF3378518` | `7C666191-3E9F-43ce-82CF-44690EF84D87` | `0.6910755148741419` |

판단:

- `TEMPLATE_TITLE`과 `TEMPLATE_SUBTITLE`은 같은 track에 묶여 있지 않습니다.
- 각 marker는 별도 material/segment입니다.
- 따라서 CapCut에서 title/subtitle marker의 위치/크기를 직접 수정할 수 있습니다.

## 최신 draft 구조

최신 draft `pipeline_1784826254`에서는 track이 아래처럼 생성됐습니다.

| 목적 | draft track name | track index | 설명 |
|---|---|---:|---|
| timed 자막 | `subtitle` | 2 | 48개 caption segment가 들어가는 실제 자막 track |
| 고정 제목 윗줄 | `template_title_4` | 4 | `TEMPLATE_TITLE`에서 복제된 고정 overlay |
| 고정 제목 아랫줄 | `template_subtitle_2` | 5 | `TEMPLATE_SUBTITLE`에서 복제된 고정 overlay |

즉, 생성 draft 내부에서도 timed 자막과 고정 제목 overlay는 track이 분리되어 있습니다.

현재 fixed overlay text:

```json
{
  "title": "아들을 쫓던",
  "subtitle": "보안관은 왜 수우족의"
}
```

문제 원인:

- `scripts/capcut_draft.py::derive_overlay_texts(...)`가 `top_title`을 11자, `top_subtitle`을 14자로 잘라냅니다.
- 그래서 전체 제목 `아들을 쫓던 보안관은 왜 수우족의 미끼가 되었나?` 중 `미끼가 되었나?`가 overlay에 들어가지 못했습니다.

## 코드 구조 확인

관련 함수:

- `scripts/capcut_draft.py::derive_overlay_texts(...)`
- `scripts/capcut_draft.py::clone_template_text_segments(...)`
- `scripts/capcut_draft.py::rebuild_midform_caption_track_from_template(...)`
- `midform/scripts/assemble_slot_draft_input.py::derive_title_block(...)`

핵심 코드 의도:

```python
# Timed captions remain on the generated subtitle track. TEMPLATE_SUBTITLE is reserved
# for the fixed top subtitle line in the sealed midform layout.
```

현재 의도는 “timed 자막은 generated subtitle track에 있고, `TEMPLATE_SUBTITLE`은 고정 상단 subtitle line”입니다.

하지만 실제 timed 자막 rebuild 함수도 다음 marker를 스타일 원본으로 씁니다.

```python
find_template_text_marker_assets(template_doc, ["TEMPLATE_SUBTITLE"])
```

따라서 `TEMPLATE_SUBTITLE`은 현재 두 역할을 동시에 가집니다.

1. 고정 제목 아랫줄 overlay marker
2. timed 자막 style source marker

## 분리 가능 여부

### CapCut 수정만으로 가능한 것

가능합니다.

- 고정 제목 윗줄/아랫줄 위치 조정
- 고정 제목 윗줄/아랫줄 크기 조정
- 고정 제목 marker를 timed subtitle track과 시각적으로 떨어뜨리기
- 현재 템플릿 draft를 CapCut에서 열어 marker 위치를 수정한 뒤 저장하고, 해당 template folder를 교체하는 방식

이 경우 pipeline code는 기존 marker를 다시 찾아 복제하므로, 수정된 위치/스타일을 다음 draft에 반영할 수 있습니다.

### 코드 변경이 필요한 것

다음 요구는 코드/템플릿 marker 변경이 필요합니다.

- 제목 아랫줄(`TEMPLATE_SUBTITLE`)과 timed 자막 style source를 완전히 독립시키기
- 예: `TEMPLATE_TITLE_SUBLINE` 또는 `TEMPLATE_OVERLAY_SUBTITLE`을 제목 아랫줄로 쓰고, `TEMPLATE_SUBTITLE`은 timed 자막 style source로만 유지
- 또는 반대로 `TEMPLATE_SUBTITLE`은 제목 아랫줄로 유지하고, timed 자막용으로 `TEMPLATE_TIMED_SUBTITLE` marker를 새로 추가

추천 구조:

```text
TEMPLATE_TITLE          -> 고정 제목 윗줄
TEMPLATE_TITLE_SUBLINE  -> 고정 제목 아랫줄
TEMPLATE_SUBTITLE       -> timed 자막 style source
```

이 구조가 가장 안전합니다. 기존 `TEMPLATE_SUBTITLE`이 이미 timed caption style source로 쓰이고 있기 때문입니다.

## 제목 이원화 설계

요청 방향은 타당합니다.

권장 데이터 구조:

```json
{
  "title_block": {
    "full_title": "아들을 쫓던 보안관은 왜 수우족의 미끼가 되었나?",
    "overlay_title": {
      "top": "아들을 쫓던",
      "bottom": "수우족 미끼"
    }
  }
}
```

또는 더 명시적으로:

```json
{
  "upload_text": {
    "title_candidates": [
      "아들을 쫓던 보안관은 왜 수우족의 미끼가 되었나?"
    ]
  },
  "overlay_title": {
    "top": "아들을 쫓던",
    "bottom": "수우족 미끼"
  }
}
```

권장 규칙:

- YouTube 제목: 길어도 됨, hook 문장 유지
- 화면 overlay 제목: 2줄, 각 8자 이내
- overlay 제목은 full title과 달라도 됨

이번 run은 사용자 확정 대기 상태로 두는 것이 맞습니다.

예시 후보:

```text
top: 아들을 쫓던
bottom: 수우족 미끼
```

또는:

```text
top: 보안관은 왜
bottom: 미끼가 됐나
```

## 샘플 템플릿 draft 준비 방향

샘플 draft 생성은 다음 단계에서 진행하면 됩니다.

목표:

- 더미 제목 8자/8자
- 더미 timed 자막 몇 개
- 나레이션/대사 색상 포함
- 사용자가 CapCut에서 열어 직접 수정할 수 있는 draft folder 생성

권장 샘플 overlay:

```text
TITLE: 더미제목상
SUBLINE: 더미제목하
```

권장 샘플 caption:

```text
나레이션 자막
제드 대사 색
브릿 대사 색
```

생성 후 사용자는 CapCut에서 해당 draft를 열고:

1. 제목 marker 위치/크기 조정
2. timed 자막 위치/크기 조정
3. 필요하면 `TEMPLATE_TITLE_SUBLINE` 같은 새 marker 추가
4. 저장
5. 저장된 draft folder를 `templates/capcut/channel_default/...` 아래 template으로 교체

## 다음 단계 제안

확인 후 진행 순서:

1. overlay 제목 2줄 최종 문구 확정
2. 샘플 수정용 draft 생성
3. 사용자가 CapCut에서 title/subtitle/timed-caption layout 수정
4. 수정된 draft를 template folder로 교체
5. 코드에서 `overlay_title.top/bottom` 우선 사용
6. 필요 시 `TEMPLATE_TITLE_SUBLINE` marker 지원 추가

## 보고서 위치

- `docs/raw/analysis-report-2026-07-24-template-title-subtitle-structure-and-overlay-title-plan.md`
