# 롱투숏 A(지구관측소) 인계 (2026-10-19)

## 10-20 07:00 재부팅 대비 (10-19 마감)

- **재정비안:** `docs/longshort-reset-20261019.md`. 소유주 결정은 «예약 유지, 새 영상 퀄 승인 날 때까지 예약 유지»다.
  - 해설형은 소유주 승인 뒤에만 예약 편을 대체한다. 대체할 때는 예약 편을 내리고 retracted를 기록한다.
- **해설형 첫 편 lx02(크랜베리 40초판):** 편집표는 `D:/volcano-runs/lx02/plan.json`. 아직 렌더 전이다.
  - 재개: `bash D:/volcano-runs/lx02/render.sh > D:/volcano-runs/lx02/render.log 2>&1` (백그라운드).
  - 정치 lock 없음, 빈 메모리 8GB+, 08:30~18:00일 때만 시작한다. 06:50~08:30에는 스스로 나간다.
  - 끝나면 frame_dup 첫 3컷을 보고, 30MB 이하 `lx02_preview.mp4`를 관리자에게 보내 소유주 승인을 받는다.
- **음량:** `ls_tools/ship.py`가 `loudnorm_final`로 -14 LUFS를 맞춘다(10-19). 해설형은 `ff_render` 안에 -14가 들어 있다.
- **자동 작업**
  - schtasks(재부팅 뒤 자동): 저조회 비공개(`midform-low-views-private` 매시 :50, `low-views-cleanup` 07:40), 페북·네이버 발행(`midform-facebook_profile-lsNN`, `midform-naverclip-lsNN`).
  - 세션 손 점검(루프 없음): 태그 삽입·확인은 `publish_ko.sh` 업로드 관문 안에서 하고, 6h-0 점검은 `yt_zero6h_ko.js`로 한다.
  - 포장 교체: 롱투숏은 아직 없다(재정비안 제안 단계).
- **수익 현황:** `node D:/volcano-runs/ls_tools/yt_monetize_ko.js`.

## 정리 상태 — 취소(10-19, 관리자 오독)

10-19 오전 «숏폼 정리·롱투숏 중단» 지시는 관리자가 소유주 말을 잘못 읽은 것이라 같은 날 취소됐다.
소유주 원문은 «아직 확정은 아닌데. 팬튜브랑 롱투숏·린박스·롱폼·쇼핑 가져간다니까»이다.
**롱투숏은 유지**하고 제작·업로드를 재개한다(하루 3편). 해설형 lx01b는 소유주 «섞어» 답을 기다린다(§5 31).
아래 예약 목록·재개 명령·P1·도구 위치는 그대로 유효한 운영 정보다.

### 예약된 유튜브 편(그대로 공개, 시각은 KST)

| 편 | 영상 ID | 공개 |
|---|---|---|
| ls15 | 3TlNZ18uFtI | 10-19 12:00 |
| ls16 | hrgQP4C4iY4 | 10-19 18:00 |
| ls35 | bKy2o17hCUg | 10-20 08:00 |
| ls19 | 9B7UY8f0HfM | 10-20 12:00 |
| ls13 | cEa2rmfA6NQ | 10-20 18:00 |
| ls21 | fQekm2XdG7w | 10-21 08:00 |
| ls28 | ESnHr4Mh-HM | 10-21 12:00 |
| ls31 | JQuT0Cf9cgo | 10-21 18:00 |
| ls30 | MHxpDpuhzeY | 10-22 08:00 |
| ls18 | ZF4zauHJCbQ | 10-22 12:00 |
| ls23 | yYhht-StoAo | 10-22 18:00 |
| ls25 | 4mX-mMORqVQ | 10-23 08:00 |
| ls26 | 0y81lFcFCnU | 10-23 12:00 |
| ls27 | vdL11jIMmrU | 10-23 18:00 |
| ls29 | m82sbvL_O14 | 10-24 08:00 (P1 FAIL, 소유주 «그냥 대기 냅둬») |
| ls32 | yGN33fXDr_g | 10-24 12:00 |
| ls33 | ItmlG1sbTg4 | 10-24 18:00 |
| ls34 | AH9vBWypnb4 | 10-25 08:00 |
| ls36 | 0U9eYwt-83E | 10-25 12:00 |
| ls37 | sHfEjBtChqk | 10-25 18:00 |
| ls38 | eJFixlJ4tf0 | 10-26 08:00 |
| ls39 | rUQ6KPxllKQ | 10-26 12:00 |
| ls40 | VZ11U1khTvE | 10-26 18:00 |
| ls41 | uzLjPFAi_6Q | 10-27 08:00 |
| ls42 | NrzcPDn3J3k | 10-27 12:00 |

- 10-27 18:00 자리는 비어 있다(재개 뒤 다음 생산분으로 채운다).
- ls11(U-0ogQ8IxWI)은 10-18에 비공개로 되물렸다(조회 0 = 가이드 위반). IG·FB 사본은 소유주 «냅둬».

### 끈 작업

- **없음.** 롱투숏 제작은 세션이 손으로 돌렸고, 제작을 만드는 예약 작업은 처음부터 없었다.
- 남아 있는 예약 작업은 전부 발행이나 점검이라 **유지**한다.
  - `midform-facebook_profile-lsNN-ko.mp4`, `midform-naverclip-lsNN-ko.mp4`(ls04~42): 페북·네이버 클립 발행.
  - `midform-low-views-private`, `low-views-cleanup`: 저조회 자동 비공개.
  - `midform-auto-publish*` 3개는 원래 Disabled다.
- 손으로 돌리던 점검인 6h-0(공개 6시간 뒤 조회 0이면 비공개)은 아래 명령으로 계속 돌릴 수 있다.

### 재개 명령(소유주가 다시 열 때)

- 한 편 업로드(관문 포함):
  `bash D:/volcano-runs/ls_tools/publish_ko.sh NN 2026-MM-DDTHH:MM:00+09:00`
  - 관문은 가이드 낱말(exit 5) → P1 화면(exit 6) → 업로드(exit 3) → 태그 0이면 예약 취소(exit 4) 순서다.
- 6h-0 점검: `node D:/volcano-runs/ls_tools/yt_zero6h_ko.js`
  - 조회 0인 공개 편을 비공개로 돌리려면 `--retract`를 붙인다. 기록은 `D:/volcano-runs/_gate_log.jsonl`에 남는다.
- 태그 점검: `node D:/volcano-runs/ls_tools/yt_tags_ko.js --recent 7 --fix --unschedule-zero`
- 제작 순서(원음형):
  1. 전사(`rinbox_transcribe.py`)
  2. `mkplan.mk(..., grammar=[...])`
  3. `render_queue.sh`(잠금 파일과 빈 메모리 8GB 관문)
  4. 눈 검사
  5. `p1_check.py`
  6. `ship.py`
  7. `rinbox-publish.js --approve`
  8. `publish_ko.sh`
- 해설형 시험편 lx01b(`D:/volcano-runs/lx01/`, 24초, «밭을 물에 잠그는 이유»)는 소유주 «섞어» 답이 올 때까지 업로드하지 않는다(오면 10-26 이후 빈 슬롯부터).
  - 렌더는 `python D:/midform/scripts/ff_render.py D:/volcano-runs/lx01/plan.json`(쇼핑 렌더러 import, 수정 없음)으로 하고, 첫 2초 화살표는 따로 덮어썼다.
  - 편집표 4칸은 `plan.json` media의 grammar에 있다.

### P1 화면 소급 FAIL 5편(10-18, 신뢰도 0.4+)

| 편 | 상태 |
|---|---|
| ls02 | 손대지 않음. 소유주 10-18 15:0x 결정 |
| ls05 | 손대지 않음. 같은 결정 |
| ls07 | 손대지 않음. 같은 결정 |
| ls14 | 손대지 않음(10-18 12:00 공개). 같은 결정 |
| ls29 | 10-24 08:00 예약 유지. 소유주 «그냥 대기 냅둬» |

기록은 `_gate_log.jsonl`(kind `p1_retro`, `m1_band`)과 `ls_tools/p1_retro_20261018.txt`(PASS 목록)에 있다.

### 도구 위치

- `guide_check`: `D:/volcano-runs/ls_tools/guide_check.py`
  - 낱말 정본은 `D:/midform/config/guide_words.json`이고, 판정은 `D:/midform/scripts/guide_words.hits()`로 한다(둘 다 도구개발 소유).
- P1 화면 검사: `D:/volcano-runs/ls_tools/p1_check.py`. 1.5초 컨택트 시트를 GPT로 판독한다.
- 이미지 중복도: `D:/volcano-runs/ls_tools/frame_dup.py`. **10-19에 소유를 도구개발로 넘겼다**(쇼핑·린박스 ja가 계속 쓴다). 보정 기록은 파일 머리 주석과 `ls_tools/README.md`에 있다.
- 공익 고지 문구(발굴 표준안 대기)는 미반영이다. 반영할 자리는 `ship.py`의 «원본 영상» 줄 다음, 가이드·P1에 걸린 편만이다.
