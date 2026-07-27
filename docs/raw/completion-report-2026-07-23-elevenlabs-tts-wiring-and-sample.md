# 완료 보고서 — ElevenLabs TTS 연결, 샘플 검증, render 보류

## 요약

요청하신 순서대로 확인하고 반영했습니다.

1. 현재 sealed render 경로에서 **실제로 쓰이던 기본 TTS는 `edge_tts`** 였고, `server/services/elevenlabsService.js`는 그 경로에 연결돼 있지 않았습니다.
2. `midform/config/tts.json` 설정 파일을 만들고, `assemble_slot_draft_input.py`가 **Edge / ElevenLabs provider 전환**을 읽도록 연결했습니다.
3. 속도 1.1 기준으로 한국어 길이 추정 계수를 **4.8 → 5.28 chars/sec**로 연동 보정했습니다.
4. `slot_5`만 ElevenLabs로 **샘플 1회** 합성했습니다.
5. 샘플은 성공했지만, 실제 길이와 추정 길이 오차가 **약 18.1%**로 요청 조건(±10%)을 넘었습니다.

따라서 사용자 지시에 따라 **전체 render는 진행하지 않고 여기서 멈췄습니다.**

## 1) 코드 수정 전 구조 확인

### 실제 render 경로에서 쓰이던 기본 TTS

- 파일: `midform/scripts/assemble_slot_draft_input.py`
- 기존 상태:
  - `import edge_tts`
  - `TTS_PROVIDER = "Microsoft Edge online TTS via edge-tts"`
  - `edge_tts.Communicate(...).save(...)` 직접 호출

즉 sealed draft/render 경로의 기본 TTS는 **Edge TTS** 였습니다.

### ElevenLabs service가 어디에 있었는지

- 파일: `server/services/elevenlabsService.js`
- 이 서비스는 ElevenLabs API 호출 구현을 갖고 있었지만,
- 현재 sealed midform render 경로(`runTtsAssembly -> assemble_slot_draft_input.py -> capcutService`)에는 **직접 연결돼 있지 않았습니다.**

### provider 선택 지점

기존에는 sealed path 기준 **provider 선택 지점이 없었습니다.**

- `midformPipelineService.js` → `assemble_slot_draft_input.py` 실행
- Python 스크립트 내부에서 무조건 `edge_tts` 사용

이번 작업에서 이 지점을 **설정 파일 기반 provider switch**로 바꿨습니다.

### `.env` 로딩 경로

- API 서버 경로: `server/index.js`
  - `dotenv.config({ path: path.join(__dirname, '../.env') })`
- CLI 경로: `scripts/midform.js`
  - `require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env') })`

그리고 직접 Python 스크립트를 샘플 호출할 때도 동작하게 하려고,

- `midform/scripts/assemble_slot_draft_input.py`

안에 `.env` fallback reader를 추가했습니다.

## 2) 적용한 설정

파일:

- `midform/config/tts.json`

내용:

```json
{
  "provider": "elevenlabs",
  "voice_id": "jB1Cifc2UQbq1gR3wnb0",
  "model_id": "eleven_multilingual_v2",
  "voice_settings": {
    "stability": 1.0,
    "similarity_boost": 1.0,
    "style": 0.2,
    "use_speaker_boost": true,
    "speed": 1.1
  },
  "output_format": "mp3_44100_128"
}
```

## 3) 실제 연결 반영

### Python 조립 경로

파일: `midform/scripts/assemble_slot_draft_input.py`

추가/변경한 내용:

- `midform/config/tts.json` 로드
- provider `edge | elevenlabs` 전환
- ElevenLabs API 직접 호출 구현
- `output_format=mp3_44100_128` 적용
- `voice_settings.speed=1.1` 포함
- `.env`에서 `ELEVENLABS_API_KEY` fallback 로드
- 샘플 1회 합성을 위한 `--sample-segment-id`, `--sample-output` 옵션 추가

### render 경로 반영 확인

`midformPipelineService.js`는 여전히 `assemble_slot_draft_input.py`만 호출하므로, 이번 연결로 sealed render 경로도 같은 provider 설정을 사용하게 됩니다.

## 4) 길이 추정 계수 보정

### `server/services/midformCompressionService.js`

- 기존: `4.8 chars/sec`
- 변경: `BASE_KOREAN_NARRATION_CHARS_PER_SEC * speed`
- 현재 설정 기준: `4.8 * 1.1 = 5.28`

### `server/services/midformPipelineService.js`

- 기존: `visibleLength(text) / 5.5`
- 변경: `visibleLength(text) / (4.8 * speed)`

즉, now both paths are aligned to the same **base 4.8 × speed** rule.

## 5) ElevenLabs 샘플 1회 결과

실행 대상:

- run: `compress_20260721224323_3e-5BAhZQ5w`
- sample segment: `slot_5`

샘플 오디오 파일:

- `midform/test_runs/compress_20260721224323_3e-5BAhZQ5w/tts/slot_5_elevenlabs_sample.mp3`

실행 결과:

- provider: `ElevenLabs API`
- model: `eleven_multilingual_v2`
- actual duration: `23.484s`
- estimated duration (`글자수 ÷ 5.28`): `19.886s`

오차 계산:

- 차이: `3.598s`
- 상대 오차: 약 `18.1%`

판정:

- **실패** — 요청 기준 `±10%` 이내를 넘었습니다.

따라서 전체 render는 진행하지 않았습니다.

## 6) 외부 문서 기준 반영 사항

공식 ElevenLabs 문서 기준으로 확인한 점:

- endpoint: `POST /v1/text-to-speech/{voice_id}`
- `model_id`: `eleven_multilingual_v2` 사용 가능
- `output_format`: query parameter로 `mp3_44100_128` 사용 가능
- `voice_settings.speed`: 1.0 초과 시 더 빠르게 읽음

이 형식에 맞춰 Python 호출을 구성했습니다.

## 7) 검증

실행 명령:

```bash
npm run verify
```

결과:

- `check:encoding` ✅
- `verify:js` ✅
- `verify:py` ✅
- `verify:fixture` ✅ 명령 종료 성공

참고로 `verify:fixture` 출력에는 기존 fixture 리포트의 `status: failed` 문자열이 남아 있지만, 저장소의 필수 검증 명령 전체는 종료 코드 0으로 성공했습니다.

## 결론

현재 상태는 다음과 같습니다.

- ElevenLabs 설정 파일 적용 완료
- sealed render 경로 provider 연결 완료
- speed 1.1 기반 길이 추정 연동 완료
- 샘플 1회 합성 완료
- 하지만 길이 오차가 `18.1%`로 기준 초과

따라서 **전체 render는 아직 실행하지 않았고**, 여기서 멈췄습니다.

## 관련 경로

- TTS 설정: `midform/config/tts.json`
- 조립/TTS provider 코드: `midform/scripts/assemble_slot_draft_input.py`
- 길이 추정(압축): `server/services/midformCompressionService.js`
- 길이 추정(파이프라인): `server/services/midformPipelineService.js`
- 샘플 mp3: `midform/test_runs/compress_20260721224323_3e-5BAhZQ5w/tts/slot_5_elevenlabs_sample.mp3`
- 이 보고서: `docs/raw/completion-report-2026-07-23-elevenlabs-tts-wiring-and-sample.md`
