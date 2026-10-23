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

## 편 고르는 순서 (소유주 10-23)

«우리는 뉴스가 아니야, 정치 채널이야. 뉴스인 척하는 거지.» — 주제는 뉴스 의제가 아니라 대중이 미워하는 사람(빌런)에서 나온다. 뉴스·방송 발췌는 그 빌런을 파는 재료이고 말투(중립 해설)는 겉옷이다.

1. `server/data/rising_keywords/politics_ko_latest.json` 상위 5위에서 빌런 한 명(여야 상관없음). 전 편 빌런에게 새 장면이 있으면 그대로 잇는다.
2. 빌런의 하루 새 자동완성(`evidence.new_today`)·기사 제목에서 «사람들이 지금 그에게 화내는 지점»을 한 문장으로 → `keywords.json villain.why`.
3. 그 지점을 찌르는 발언(특히 같은 쪽 사람의 쓴소리)을 토크쇼·국감 원음에서 찾는다 — 뉴스는 사실 확인·출처용.
4. 제목 = 빌런 이름 + 그를 찌르는 따옴표 한마디 + 화자 + 이슈 낱말(10/18 4,175회 틀). 키워드는 제목·해시태그에, «이재명 대통령» 호칭.
5. 검사: `candidate_gate`(빌런 상위 5위·키워드 1순위·썸네일 1순위·전 편 이음) → `upload_gate`.

