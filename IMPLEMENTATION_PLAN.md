# IMPLEMENTATION_PLAN.md

## 1. 구현 목표

현재 프로젝트를 폐기하지 않고 `ultra_efficiency_process` 모드를 추가한다.

기본 목표:

- movie recap 기존 기능 유지
- process edit mode 추가
- source_clean.mp4 기반 CapCut draft 생성 강화
- 설명형 자막 블록과 BGM 중심 편집 지원
- TTS/SRT는 optional로 유지

## 2. MVP-1: 설계/템플릿 기반 정리

### 목표

코드 대규모 변경 전에 새 모드의 입력/출력/템플릿 구조를 고정한다.

### 작업

1. Claude template 폴더 추가

```text
prompts/claude_templates/ultra_efficiency_process/
  template.json
  prompt.md
  review_checklist.md
```

2. CapCut process template 폴더 추가

```text
templates/capcut/process_default/
  draft_content.json
  draft_meta_info.json
```

3. process template marker 확정

```text
TEMPLATE_CHANNEL_TAG
TEMPLATE_EXPLAINER
TEMPLATE_STEP_LABEL
TEMPLATE_METRIC
TEMPLATE_CALLOUT
TEMPLATE_SOURCE_NOTE
```

4. process edit plan schema 초안 추가

예상 산출물:

```text
script/ultra_efficiency_process_plan.json
```

### 변경 예상 파일

- `prompts/claude_templates/ultra_efficiency_process/template.json`
- `prompts/claude_templates/ultra_efficiency_process/prompt.md`
- `prompts/claude_templates/ultra_efficiency_process/review_checklist.md`
- `templates/capcut/process_default/*`
- 문서 파일

### 검증

- 템플릿 파일 존재
- marker 이름 일관성 확인
- 기존 movie_recap 템플릿 유지

## 3. MVP-2: CapCut process mode 생성

### 목표

Phase5에서 `ultra_efficiency_process` draft를 생성할 수 있게 한다.

### 작업

1. `/api/capcut/generate-draft` 입력에 `editMode` 추가

```json
{
  "editMode": "ultra_efficiency_process",
  "processProject": {},
  "explainerBlocks": [],
  "videoTransformPreset": {},
  "bgmPreset": {},
  "ttsConfig": {}
}
```

2. `scripts/capcut_draft.py`에 process mode 분기 추가

- source video 복사
- process template 탐색
- `TEMPLATE_CHANNEL_TAG` clone
- `upload_title` metadata record
- `TEMPLATE_EXPLAINER` block별 clone
- BGM track 배치
- optional TTS/SRT 유지

3. `edit_manifest.json` 확장

```json
{
  "edit_mode": "ultra_efficiency_process",
  "explainer_blocks_count": 0,
  "video_transform_preset": {},
  "bgm_preset": {},
  "tts_enabled": false,
  "template_markers_found": [],
  "missing_template_markers": []
}
```

4. `capcut_notes.md` 확장

- process mode 사용 여부
- 템플릿 marker 탐지 결과
- BGM 사용 여부
- TTS 사용 여부
- 영상 변형 preset 요약

### 변경 예상 파일

- `server/routes/capcut.js`
- `server/services/capcutService.js`
- `scripts/capcut_draft.py`
- `client/src/pages/Phase5Draft.jsx`

### 검증

- `npm run build`
- source_clean.mp4만으로 draft ZIP 생성
- ZIP 내부에 video/audio/manifest/notes 포함
- CapCut에서 영상 + explainer block + BGM 수동 확인 가능

## 4. MVP-3: Process Editor UI

### 목표

사용자가 movie recap 파이프라인을 거치지 않고 process draft를 만들 수 있게 한다.

### UI 방향

새 화면 또는 Phase5 내부 모드:

- Edit Mode 선택
- Source video 상태 표시
- Explainer block editor
- Video transform preset 선택
- BGM preset 선택
- TTS 사용 여부 toggle
- CapCut process template 상태 표시
- Generate Draft 버튼

### 변경 예상 파일

- `client/src/pages/Phase5Draft.jsx`
- 새 파일 후보: `client/src/pages/ProcessEditor.jsx`
- 새 컴포넌트 후보:
  - `ProcessExplainerBlockEditor.jsx`
  - `VideoTransformPresetSelector.jsx`
  - `BgmPresetSelector.jsx`
  - `CapCutTemplateStatus.jsx`

### 검증

- movie recap 기존 생성 버튼 유지
- process mode 독립 실행 가능
- TTS off 상태에서도 draft 생성 가능
- TTS on 상태에서는 기존 Phase4 결과 재사용 가능

## 5. MVP-4: Optional AI Assist

### 목표

Gemini/Claude를 필수 파이프라인이 아니라 process edit plan 작성 보조로 사용한다.

### 작업

1. `ultra_efficiency_process` Claude prompt 추가

생성 대상:

- upload title metadata
- channel tag candidate
- explainer blocks
- transform preset recommendation
- BGM preset recommendation
- warnings

2. Gemini 분석 결과가 있으면 활용

- visible actions
- machine/process steps
- text detected in video
- safety/cleanup warning

3. 없으면 수동 입력만으로도 작동

### 변경 예상 파일

- `server/services/claudeTemplateService.js`
- `server/services/claudeCliService.js`
- `server/routes/claude.js`
- `client/src/pages/Phase3Script.jsx` 또는 새 process assist UI

### 검증

- Gemini 없이 process draft 생성 가능
- Gemini/Claude 있으면 explainer block 자동 제안
- 기존 movie_recap template 선택 유지

## 6. 위험 요소

### 6.1 CapCut 스타일 clone 안정성

위험:

- 템플릿의 text material/segment 구조가 CapCut 버전마다 다를 수 있음

대응:

- marker 탐색 debug JSON 유지
- fallback marker style 유지
- process template 구조를 단순하게 권장

### 6.2 BGM track portability

위험:

- BGM 경로가 원본 assets를 참조하면 다른 위치에서 미디어 분실 가능

대응:

- draft 내부 `audio/bgm.mp3`로 복사
- `edit_manifest.json`에 원본 경로와 draft 내부 경로 모두 기록

### 6.3 TTS optional gate 충돌

위험:

- 현재 Phase4 generate가 Claude review gate와 연결되어 있을 수 있음
- process mode에서는 TTS 없이도 진행해야 함

대응:

- process mode에서는 TTS disabled이면 Phase4 gate를 우회
- TTS enabled일 때만 기존 검증 사용

### 6.4 기존 movie recap 기능 회귀

위험:

- CapCut draft script 수정 중 기존 caption unit/movie recap 결과가 깨질 수 있음

대응:

- `editMode` 분기 사용
- 기존 default는 현 동작 유지 후 process mode만 추가
- 같은 입력으로 기존 draft 생성 smoke test 수행

### 6.5 UI 복잡도 증가

위험:

- Phase1~5가 이미 복잡함
- process mode를 덧붙이면 더 혼란스러울 수 있음

대응:

- process mode는 별도 집중 화면으로 분리
- movie recap legacy flow와 시각적으로 분리
- "소재 발굴"보다 "편집 생성" 중심 UX로 재배치

## 7. 우선순위

1. process mode schema 확정
2. process CapCut template marker 확정
3. `templates/capcut/process_default/` 준비
4. `scripts/capcut_draft.py`에 `editMode` 분기 추가
5. BGM 파일 복사/배치
6. explainer block clone 배치
7. Phase5 UI에 process mode 추가
8. TTS off draft 생성 검증
9. TTS on optional 연결
10. Claude ultra_efficiency_process template 추가

## 8. 당장 하지 말 것

- 새 프로젝트 생성
- 기존 movie recap 기능 삭제
- Virlo UI 대규모 재작업
- Gemini/Claude를 process mode 필수 조건으로 만들기
- TTS를 필수 조건으로 만들기
- source cleanup/워터마크 제거/하드자막 제거 자동화 추가
- 고급 beat sync부터 시작

## 9. 성공 기준

MVP 성공 기준:

- `input/source_clean.mp4`만 있어도 process draft ZIP 생성 가능
- 설명형 자막 블록이 CapCut에서 템플릿 스타일로 표시됨
- BGM이 draft에 포함됨
- 영상 track이 draft에 포함됨
- TTS 없이도 결과 생성 가능
- `edit_manifest.json`과 `capcut_notes.md`에 process mode 정보가 기록됨
- 기존 movie recap CapCut 생성이 깨지지 않음

