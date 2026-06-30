# Content Pipeline

현재 버전: **MVP_STABLE_001**

해외 숏폼 영상 분석 결과를 기반으로 한국어 대본/TTS/자막을 만들고, CapCut 드래프트 ZIP까지 생성하는 로컬 앱입니다.

## Stack
- Frontend: React + Vite + TailwindCSS
- Backend: Express
- State: zustand
- Media tools: ffmpeg / ffprobe
- CapCut draft: Python (`scripts/capcut_draft.py`, pyCapCut/pycapcut)

## Quick Start
```bash
npm install
cd client && npm install
cd ../server && npm install
```

실행:
```bash
npm run dev
```

- Client: `http://localhost:5173`
- Server: `http://localhost:3001`
- 루트 `npm run dev`는 실행 전에 `3001`, `5173~5176` 포트를 정리한 뒤 서버/클라이언트를 동시에 실행합니다.

Windows 빠른 실행:
- `start.bat` (cmd 더블클릭/실행)
  - 실행 전 `3001`, `5173~5176` 포트 점유 PID만 정리
  - `http://localhost:3001/api/health` 와 `http://localhost:5173/` 준비 확인 후 브라우저 오픈
  - Node/NPM 버전 출력 후 `npm run dev` 실행 (로그 유지)
- `start-clean.ps1` (PowerShell 버전)
  - 동일하게 포트 정리 + 준비 확인 후 브라우저 오픈 + `npm run dev` 실행

## MVP_STABLE_001 성공 흐름
1. Phase 2에서 Gemini 분석 완료 후 `analysis/gemini_analysis.json` 저장
2. Phase 3에서 Claude JSON 생성 후 `script/claude_midform_story.json` 저장
3. Phase 4에서 `segments[].narration`을 **caption unit(문장 단위)** 으로 분할하여 TTS/SRT 생성
4. Phase 5에서 CapCut draft 생성 (video + TTS + subtitle + template overlay) 후 ZIP 다운로드

## Phase 실행 순서
1. Settings
2. Phase 1 Virlo (선택)
3. Phase 2 Gemini
4. **Phase 2.5 Gemini Review Gate (필수)**
5. Phase 3 Claude
6. Phase 4 TTS/SRT
7. Phase 5 CapCut Draft

## Phase2.5 Gemini Review Gate
- Gemini 분석 결과 파일: `analysis/gemini_analysis.json`
- 검증 승인 파일: `analysis/gemini_review.json`
- Phase3 진행/Claude 생성 조건:
  - `gemini_review.status === "approved"`
  - `gemini_review.checks.ready_for_claude === true`
  - 필수 체크 항목 전체 true
- 미승인 상태에서 `/api/claude/generate-script` 호출 시 400(`GEMINI_ANALYSIS_NOT_APPROVED`)으로 차단됩니다.

## 필요한 입력 파일/설정
### 필수 .env 키
- `VIRLO_API_KEY` (Phase 1 사용 시)
- `GEMINI_API_KEY`
- `CLAUDE_CODE_OAUTH_TOKEN` 또는 `CLAUDE_OAUTH_TOKEN`
- `ELEVENLABS_API_KEY`

### 파일 입력
- `script/claude_midform_story.json` (Phase 3 결과)
- `input/source_clean.mp4` 우선 사용, 없으면 `input/source.mp4`

## caption unit 기본값
**기본 동작은 caption unit 방식입니다.**
- 1 caption unit = 1 TTS mp3 = 1 subtitle text segment
- 긴 문단 자막 대신 문장 단위 자막으로 생성
- 출력 예: `seg_001_cap_001.mp3`, `seg_001_cap_002.mp3`

## 현재 정상 동작하는 ZIP 생성 방식
- 권장: **absolute path mode ZIP** (`recommendedZip`)
- 상대경로(relative) ZIP은 실험용이며 CapCut에서 오디오 미디어 분실 가능
- 다운로드 API: `/api/capcut/download/:zipFile`

## CapCut 템플릿 마커 4개 사용법
템플릿 경로: `templates/capcut/channel_default/`

- `TEMPLATE_PRETITLE`
  - 고정 오버레이 텍스트(0초 ~ 전체 TTS 길이)
- `TEMPLATE_TITLE`
  - 메인 타이틀(0초 ~ 전체 TTS 길이)
- `TEMPLATE_SUBTITLE`
  - caption unit 자막 스타일 복제용
- `TEMPLATE_MOVIE_TITLE`
  - 작품명/소스명 오버레이(0초 ~ 전체 TTS 길이)

마커 텍스트 객체는 템플릿 draft 내부에 실제 텍스트로 존재해야 하며, clone mode에서 스타일/이펙트 참조를 유지합니다.

## 성공 기준 (MVP_STABLE_001)
- Phase 4 결과:
  - caption unit 수 > 0
  - mp3 파일 수 == caption unit 수 (성공분 기준)
  - `subtitles.srt` 생성
- Phase 5 결과:
  - draft ZIP 생성 성공
  - `edit_manifest.json`, `capcut_notes.md` 생성
  - subtitle segment 수가 caption unit 수와 일치
  - fixed overlay 3개(`PRETITLE`, `TITLE`, `MOVIE_TITLE`) 존재
  - `video_timeline_aligned_to_tts: true`

## 현재 제한사항
- 영상 자동 컷 배치는 segment 기준이며, subtitle/TTS는 caption unit 기준
- CapCut import 호환성은 앱 버전에 따라 차이 가능
- 템플릿 구조가 특수(복합 클립 내부 텍스트만 존재 등)한 경우 마커 탐지/복제가 제한될 수 있음
- 외부 API 상태(요금제/쿼터/인증)에 따라 실패 가능

## Known Issues
- ElevenLabs 생성 중 일부 caption unit 실패 시 `partial_success` 가능
- 상대경로 ZIP은 오디오 미디어 분실 가능성 존재
- 템플릿 폴더/마커 구성 불일치 시 fallback 동작 발생
- CapCut 최종 렌더 확인은 수동 검증 필요
