# N100 미니PC 이전 킷 (2026-08-11)

전용 상시가동 미니PC로 전체 자동화(03:00 수집·배치 / 09:30 내보내기·업로드)를
이전하기 위한 체크리스트. JP 12 + KR 12 = 24개/일 체제 기준.

## 0. 디스플레이 — HDMI 더미 플러그 해상도 설정

화면 자동화(pyautogui + CapCut)는 "실제로 렌더링되는 화면"이 필요하다.
더미 플러그는 EDID로 지원 해상도 목록을 알려주고, Windows가 그중 하나로
렌더링한다. 설정 방법:

1. 더미 플러그 꽂고 부팅 → 설정 > 시스템 > 디스플레이
2. **해상도 1920×1080, 배율 100%로 고정** (권장 표준 — 대부분의 더미가
   1080p60을 기본 지원. 4K 더미라면 목록에서 1920×1080 선택)
3. 배율(스케일)은 반드시 100% — 125%면 좌표계가 논리/물리 픽셀로 갈라져
   자동화 좌표가 틀어진다.
4. 한 번 설정하면 더미의 EDID가 고정이라 재부팅해도 유지된다.
5. **관리는 Claude Code 세션으로** (별도 원격 도구 없음). 세션에서
   스크린샷 캡처→확인→좌표 보정, 잡 모니터링/복구, 스코어카드까지 전부
   가능(2026-08-11 세션에서 실증). 혹시라도 RDP로 접속하면 세션 해상도가
   바뀌고 접속 종료 시 콘솔이 잠겨 화면 자동화가 죽으니 금지.
6. 전원 설정: 절전/최대 절전 끔, 화면 끄기는 무방(잠금만 아니면 됨),
   **화면 잠금 해제** + 자동 로그인(netplwiz) 설정.
7. **Claude Code 세션 운영 규칙 (2026-08-11 실사고 교훈)**:
   - 배치/내보내기 등 장기 실행 작업을 Claude 셸에서 직접 띄우지 말 것 —
     세션이 재시작되면 Windows가 프로세스 트리째 정리해서 분리 워커까지
     죽는다 (08-11 새벽 harvest 배치가 정확히 이걸로 죽어 schtasks로 복구).
     항상 `schtasks /run /tn <작업명>` 경유 또는 서버 API 경유로 시작.
   - Claude 세션이 닫혀도 파이프라인은 전부 Task Scheduler 소속이라 무관.
     세션은 관리 창구일 뿐이다.
   - 이 리포의 CLAUDE.md가 전체 컨텍스트를 담고 있고, Claude 메모리
     (`%USERPROFILE%\.claude\projects\<경로-슬러그>\memory\`)는 리포 경로가
     같으면 복사로 이전 가능 — 다르면 새 세션에서 자연 재축적된다.

좌표는 `scripts/capcut_export_coords.json`에 해상도별 프로파일로 분리돼
있다. 1920×1080 프로파일이 없으면 비례 스케일 폴백으로 돌지만, 미니PC
세팅 날 CapCut 스크린샷 1~2장으로 실좌표를 보정해 프로파일을 추가할 것
(감독 실행 1회로 확인).

## 1. 소프트웨어 설치 순서

1. Windows 11 + 자동 로그인 + 잠금 해제 + 절전 끔 (위 0번)
2. Git, Node.js LTS, Python 3.12, ffmpeg(+ffprobe), yt-dlp — PATH 등록
3. 리포 클론 → `npm install` 루트/`server/`/`client/` 3곳
4. `python -m pip install -r scripts/requirements.txt pywinauto pyautogui pillow silero-vad onnxruntime`
5. CapCut 설치 + **Pro 계정 로그인** + 드래프트 라이브러리 경로를 이 머신의
   드래프트 출력 폴더로 지정 (Settings의 output_root와 일치시킬 것)
6. `.env` 복사 (GEMINI_API_KEY 등 — 원본 PC에서 가져오기)

## 2. 데이터 이전 (이력 유지)

- `server/data/` 통째 복사: `process_jobs.db`(잡 이력), `source_harvest_history.json`
  (수집 중복 장부 — **이거 없으면 과거 소스 재수집됨**), `harvest_config.json`,
  `youtube_upload_profiles.json`, 업로드 카드/이력 JSON들
- `queue/process/` (선택 — 진행 중 큐 유지 시)
- 바탕화면 출력 폴더 구조 재현: `CapCut Drafts/`, `CapCut Drafts/_automation factory/`,
  `_automation factory/uploaded/`, `_metadata_exports/`
- 경로가 달라지면: `queue_config.json`의 `output_root`,
  `scripts/daily-export-upload.js`의 `EXPORT_DIR` 갱신

## 3. 신규 계정 2개 (한국어/일본어) 토큰

- **기존 Google Cloud OAuth 클라이언트/프로젝트 재사용** (신규 프로젝트는
  미검증 앱 감사 전까지 API 업로드가 비공개로 잠길 수 있음. 쿼터도 기존
  프로젝트는 35업로드/일 실증됨 — 2026-08-06 업로드 잡 35/35)
- Phase 3 UI에서 프로파일 추가 → 신규 일본어 계정 인증 → purpose `jp_highlight`
  → 신규 한국어 계정 인증 → purpose `ko_highlight`
- 업로드 오케스트레이터는 variant별로 해당 purpose 프로파일을 자동 선택
- **램프업**: 신규 채널은 스팸 필터가 민감하니 첫 주는 채널당 3~4개/일로
  시작해 12개까지 점증 권장 (`harvest_config.json`의 `locale_plan` 수량 +
  스코어카드 ok 수로 자연 조절)

## 4. 스케줄 등록 (관리자 아님, 로그온 사용자 세션)

```
schtasks /create /tn "OttogiDailyPipeline" /sc daily /st 03:00 /tr "cmd /c cd /d <repo> && npm run daily:pipeline >> server\output\daily-reports\cron.log 2>&1" /f
schtasks /create /tn "OttogiDailyExportUpload" /sc daily /st 09:30 /tr "cmd /c cd /d <repo> && npm run daily:export-upload >> server\output\daily-reports\export-upload-cron.log 2>&1" /f
```

## 5. 24개/일 체제 수치

- 예약 발행은 **채널별 독립 슬롯**: 각 채널 첫 업로드 +60분, 이후 120분
  간격 → 채널당 12개 = 정확히 24시간. JP/KR 병행으로 24개/일.
- 배치 24소재 예상 소요(N100): 8~12시간 (Gemini API 대기가 지배) —
  03:00 시작 → 오후 완료 → 09:30 내보내기는 **전일 완료 배치** 기준으로
  동작하므로 일정 충돌 없음.
- 디스크: 소스 ~7GB/일 유입, retention 스윕이 스테이징 자동 정리.
  큐 소스 원본은 수동 정리 대상 (추후 업로드 완료 아이템 자동 정리 검토).

## 6. 이전 후 첫 검증 순서

1. `npm run verify`
2. `node scripts/daily-pipeline.js` 수동 1회 (dry 아님 — 실수집 12개)
3. 배치 완료 후 `npm run scorecard:highlight-arc`
4. `python scripts/capcut_export_one.py --draft-name <아무 드래프트> --export-dir <_automation factory>` 감독 실행 — 좌표 검증
5. `npm run daily:export-upload` — 예약 업로드까지 확인
6. 이틀간 데일리 리포트(`server/output/daily-reports/`) 모니터링
