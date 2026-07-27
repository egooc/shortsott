# CapCut 템플릿 회귀 조사 보고서

## 보고서 위치

- `docs/raw/investigation-report-2026-07-24-capcut-template-regression.md`

## 조사 범위

이번 조사는 수정 없이 원인 확인만 수행했다.

- render 실행 없음
- API 호출 없음
- 템플릿/코드 수정 없음
- 최종 draft 및 CapCut 로컬 프로젝트 JSON만 대조

## A. 템플릿 교체가 실제 사용자 수정본이었는지

### 확인된 실제 CapCut 저장 프로젝트 위치

CapCut metadata에서 `pipeline_1784828787`의 실제 프로젝트 위치가 확인됐다.

```text
C:/Users/sejun/Desktop/캡컷아웃풋/CapCut Drafts/pipeline_1784828787/draft_content.json
```

CapCut metadata 근거:

- `draft_name`: `pipeline_1784828787`
- `draft_fold_path`: `C:/Users/sejun/Desktop/캡컷아웃풋/CapCut Drafts/pipeline_1784828787`
- `draft_json_file`: `C:/Users/sejun/Desktop/캡컷아웃풋/CapCut Drafts/pipeline_1784828787\draft_content.json`
- `tm_draft_modified`: `1784870960098692`
- 실제 파일 mtime: `2026-07-24T05:29:19.610Z`

### 현재 템플릿에 들어간 파일과의 대조

비교 대상:

1. workspace 생성본

```text
server/output/drafts/pipeline_1784828787/draft_content.json
```

2. 실제 CapCut 저장본

```text
C:/Users/sejun/Desktop/캡컷아웃풋/CapCut Drafts/pipeline_1784828787/draft_content.json
```

3. 현재 템플릿

```text
templates/capcut/channel_default/실패한 아내를 질책한 남편의 숨겼던 진심/draft_content.json
```

SHA-256 비교 결과:

| 구분 | SHA-256 | 비고 |
|---|---|---|
| workspace 생성본 | `a9ac04b6f385f3a61a1a72bccc9651582ec52f8c29dfaa02359bbb4b688ac37a` | 수정 전 render 산출물 |
| 실제 CapCut 저장본 | `1ffe9305d37ffd64b91a0cd0ba0db696a0b64070fe27f952b21c626067b63f9f` | 사용자가 CapCut에서 저장한 프로젝트 |
| 현재 템플릿 | `bae75990d4eb096748481165523214df5a3c4308fd2300471d04ef3c614f9450` | workspace 산출물 기반에 marker 주입된 버전 |

세 파일은 서로 모두 다르다.

### 핵심 차이

workspace 생성본의 제목 관련 구조:

```json
{
  "trackIndex": 4,
  "trackName": "template_title_4",
  "materialId": "e2cc9e99bd0f470b9b8b3fa7885c198a",
  "text": "더미제목상",
  "y": 0.58
}
```

```json
{
  "trackIndex": 5,
  "trackName": "template_subtitle_2",
  "materialId": "56f155c7eb424048af2d2785fe27832e",
  "text": "더미제목하",
  "y": 0.43
}
```

실제 CapCut 저장본의 제목 관련 구조:

```json
{
  "trackIndex": 4,
  "trackName": "template_title_4",
  "materialId": "e2cc9e99bd0f470b9b8b3fa7885c198a",
  "text": "더미제목상",
  "y": 0.8179421221864952
}
```

```json
{
  "trackIndex": 6,
  "trackName": "",
  "segmentId": "82991FA6-4990-47f7-92FB-C881507E504C",
  "materialId": "A5E1E8F0-A18B-4b06-88E6-18DE6F80FAC7",
  "text": "TEMPLATE_TITLE_SUBLINE",
  "y": 0.6591639871382637
}
```

현재 템플릿의 제목 관련 구조:

```json
{
  "trackIndex": 4,
  "trackName": "template_title_4",
  "materialId": "e2cc9e99bd0f470b9b8b3fa7885c198a",
  "text": "TEMPLATE_TITLE",
  "name": "더미제목상",
  "y": 0.58
}
```

```json
{
  "trackIndex": 5,
  "trackName": "template_subtitle_2",
  "materialId": "56f155c7eb424048af2d2785fe27832e",
  "text": "TEMPLATE_TITLE_SUBLINE",
  "name": "더미제목하",
  "y": 0.43
}
```

### A 결론

템플릿에 들어간 `draft_content.json`은 사용자가 CapCut에서 수정·저장한 실제 프로젝트가 아니다.

실제 사용자 수정본은 Desktop 아래 CapCut Drafts에 따로 있었고, 현재 템플릿은 workspace의 수정 전 render 산출물에 `TEMPLATE_TITLE`, `TEMPLATE_TITLE_SUBLINE`, `TEMPLATE_SUBTITLE` marker를 코드로 주입한 버전이다.

특히 실제 CapCut 저장본에는 사용자가 새로 추가한 것으로 보이는 `TEMPLATE_TITLE_SUBLINE` text material이 별도 trackIndex `6`, materialId `A5E1E8F0-A18B-4b06-88E6-18DE6F80FAC7`로 존재한다. 현재 템플릿에는 이 신규 material이 반영되지 않았다.

## B. 제목과 자막이 왜 엮였는지

최종 draft 조사 대상:

```text
server/output/drafts/pipeline_1784871582/draft_content.json
```

### 최종 draft의 text segment 참조 구조

timed subtitle:

```json
{
  "trackIndex": 2,
  "trackName": "subtitle",
  "y": -0.26675079176563754,
  "group_id": ""
}
```

title top:

```json
{
  "text": "쫓던 보안관이",
  "trackIndex": 4,
  "trackName": "template_title_template_subtitle_2",
  "segmentId": "810a50a50f3645f49d493db1d3b736cd",
  "materialId": "e11cf41a60924666920e27b2ac4722f4",
  "y": 0.58,
  "group_id": ""
}
```

title bottom:

```json
{
  "text": "미끼가 된 날",
  "trackIndex": 5,
  "trackName": "template_subtitle_subtitle",
  "segmentId": "2a2f0cbff7604636b6a96bda2595f58f",
  "materialId": "aada32de1c5443019bd663f21d97a55a",
  "y": 0.43,
  "group_id": ""
}
```

### 같은 material 공유 여부

조사 결과, 제목 상단/하단/timed subtitle은 같은 material을 공유하지 않는다.

- timed subtitle: 각 subtitle segment마다 별도 material
- title top material: `e11cf41a60924666920e27b2ac4722f4`
- title bottom material: `aada32de1c5443019bd663f21d97a55a`

### 같은 track 여부

같은 track도 아니다.

- timed subtitle: trackIndex `2`
- title top: trackIndex `4`
- title bottom: trackIndex `5`

### group 여부

JSON상 명시적 grouping도 보이지 않는다.

- title top segment `group_id`: 빈 문자열
- title bottom segment `group_id`: 빈 문자열
- subtitle segment `group_id`: 빈 문자열

### 엮임의 유력 원인

`capcut_notes.md`와 최종 draft track name에서 title source 선택이 꼬인 흔적이 있다.

최종 notes:

```text
Template Clone Title Source: material=56f155c7eb424048af2d2785fe27832e segment=50694c25419541cea88dcb78e27ec629
```

이 material `56f155...`는 현재 템플릿에서 `TEMPLATE_TITLE_SUBLINE`으로 코드 주입된 기존 `더미제목하` material이다.

최종 draft track name도 이를 반영한다.

```text
template_title_template_subtitle_2
template_subtitle_subtitle
```

즉, JSON상으로는 같은 material/group은 아니지만, 생성 단계에서 title top과 title bottom 모두 subtitle/subline 계열 marker/material에서 파생된 구조다.

### B 결론

“같이 움직인다”의 직접 원인은 같은 material 공유나 JSON `group_id`는 아니다.

더 유력한 원인은 실제 CapCut 수정본이 아닌 코드 주입 템플릿을 사용하면서, title source가 `TEMPLATE_TITLE`이 아니라 `TEMPLATE_TITLE_SUBLINE` 계열 material로 잡힌 것이다. 그 결과 제목 상/하가 둘 다 subtitle 계열 복제 구조로 생성됐다.

## C. 색상이 왜 화면에 안 나오는지

### 대사 자막 material의 실제 색상 값

최종 draft의 대사 자막 material에는 색상 값이 실제로 들어가 있다.

예시 1 — 제드/남조연 계열:

```json
{
  "text": "인질이 셋 있다.",
  "materialId": "1e47a56aa0014abeb2e95c54f55cef8e",
  "contentFill": [0.6588235294117647, 0.8509803921568627, 0.4235294117647059],
  "text_color": "#A8D96C"
}
```

예시 2 — 브릿 계열:

```json
{
  "text": "로라, 날 떠나지 마.",
  "materialId": "9b98b55e72f84e45882a5009a12b35bc",
  "contentFill": [0.49411764705882355, 0.7843137254901961, 0.8901960784313725],
  "text_color": "#7EC8E3"
}
```

### 동시에 붙어 있는 effect 구조

하지만 대사 자막 material에는 아래 필드도 같이 있다.

```json
{
  "use_effect_default_color": true
}
```

그리고 각 subtitle segment에는 아래 extra effect들이 붙어 있다.

```text
简约-黑投影 / text_effect
빛나는 네온 / bloom
简约-黑投影 / text_effect
```

예시 extra refs:

```json
{
  "extraRefs": [
    "da3295d1a40a4d14bafbc2c5e735ff2a",
    "5c388f49a873407cbb193f9450aac3e9",
    "9d472be45d08445dbaba05a2ffbbb68d",
    "5c388f49a873407cbb193f9450aac3e9"
  ],
  "extraRefEffects": [
    { "name": "简约-黑投影", "type": "text_effect" },
    { "name": "빛나는 네온", "type": "bloom" },
    { "name": "简约-黑投影", "type": "text_effect" }
  ]
}
```

### C 결론

색상 값은 JSON에 박혀 있다. 문제는 색상 주입 실패가 아니라 CapCut 렌더링 우선순위 문제일 가능성이 높다.

`use_effect_default_color: true`와 text effect/bloom 조합 때문에 CapCut이 material의 `text_color`/content fill보다 effect 기본색을 우선 적용할 수 있다.

따라서 화면에서 색상이 안 보이는 원인은 “색상 미주입”이 아니라 “effect default color가 material fill을 덮는 구조”로 보는 것이 맞다.

## 최종 결론

이번 회귀의 핵심 원인은 세 가지다.

1. 템플릿 교체 대상이 실제 사용자 수정본이 아니었다.
   - 실제 수정본은 `C:/Users/sejun/Desktop/캡컷아웃풋/CapCut Drafts/pipeline_1784828787`에 있었다.
   - 현재 템플릿은 workspace 생성본에 marker를 코드 주입한 버전이다.

2. 제목 상/하가 같은 material이나 group을 공유하지는 않지만, title source가 subline/subtitle 계열 material로 잘못 잡힌 흔적이 있다.
   - 이 때문에 CapCut에서 제목/자막이 엮여 보이는 구조가 만들어졌을 가능성이 높다.

3. 대사 색상은 JSON에 정상적으로 들어갔지만, `use_effect_default_color: true`와 text effect/bloom이 material 색을 덮는 구조다.
   - 화면에서 색상이 안 보이는 것은 색상 값 누락이 아니라 effect 우선 적용 문제로 판단된다.

## 다음 조치 제안

수정은 아직 수행하지 않았다. 원인 확정 후 다음 수정 방향이 필요하다.

1. 실제 CapCut 저장본 `C:/Users/sejun/Desktop/캡컷아웃풋/CapCut Drafts/pipeline_1784828787/draft_content.json`을 기준으로 템플릿을 다시 구성한다.
2. 사용자가 새로 만든 `TEMPLATE_TITLE_SUBLINE` material `A5E1E8F0-A18B-4b06-88E6-18DE6F80FAC7`를 보존한다.
3. title source는 `TEMPLATE_TITLE`, title subline source는 `TEMPLATE_TITLE_SUBLINE`, timed subtitle source는 `TEMPLATE_SUBTITLE`로 분리한다.
4. 대사 색상은 `use_effect_default_color` 처리 또는 text effect 제거/복제 정책을 별도로 정해야 한다.
