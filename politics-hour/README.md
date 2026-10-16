# politics-hour

1시간 정치 롱폼 조립기. 해설 화면(하이퍼프레임 모션그래픽 + TTS + 자막)과
인용 장면(인물 당겨 잡기 + 인물 반대편 오버레이 + 원음)을 번갈아 잇는다.

- `overlay/assemble_hour.py <episode.json> --tts google|none` : 조립 실행. 조각별 결과를 저장해 두고 다시 돌리면 건너뛴다.
  `--tts none` 은 episode 에 미리 만든 음성(audio + captions)이 있을 때만 쓴다.
- `overlay/quote_overlay.py`, `narration_overlay.py`, `chrome.py` : 템플릿(인용 / 해설 issue·facts·timeline·versus·number·followup / 방송 요소)
- `overlay/person_side.py` : YuNet 얼굴 인식으로 인물 위치와 빈 쪽을 고른다
- `overlay/tts.py` : Google Cloud TTS(결제 계정 연결 필요, 무료 사용량 안에서 무과금)
- `config.json` : 기계별 설정(파이썬 경로, 하이퍼프레임 버전, 구글 프로젝트). `config.example.json` 을 복사해 쓴다.
- `setup.ps1` : 도구 확인, 시험 소스 받기, 시험 렌더

출처 표기(왼쪽 아래 "영상: …")는 지우지 않는다. 로고를 숨기려고 출처까지 지우는 편집은 하지 않는다.
