# 인스타 릴스·편집 세션 인계 (2026-10-19)

세션: rebuild-midform-baseline-recovery-a1 · 작업 폴더 D:/midform/reels/ (영상·이미지는 커밋 안 함, reels/.gitignore)

## 범위 (소유주 10-19)
- 인스타 계정을 운영하지 않는다. 편집해서 결과물 파일만 넘긴다. 발행·Blotato 팬아웃 없음.
- 영상 작업 두 종류:
  1. **편집팀 2.0식 편집**: 촬영 원본 → 컷·자막·그래픽 → 화면 기획 승인 → 렌더 → 말로 고치기. 원문은 reels/ref/diripda/edit-team-2.txt
  2. **힉스필드 생성 AI 얼굴 교체**: 레퍼런스는 hairbyzion_zion 릴(reels/ref/Dc6eDuzhsPC/analysis.md). 얼굴 보이는 샷만 교체하고 AI 변경을 표시한다. 관리자 §5 20. 키·월 상한은 소유주 대기.

## 진행 중: academy01 — 락키스북쉘프 학부모 설명회(보강 파트) 유튜브 교부 영상
- 원본: reels/inbox/src_20261019_1446.mp4(7:11 세로, 원장 직접 촬영, 셀카 좌우 반전). 드라이브 링크는 gdown 으로 받았다.
- 소유주 결정
  - 릴스 아님. 박힌 글자는 지우고 새로 디자인한다.
  - 학원 정보 글 없이 로고·분위기만 쓴다.
  - 가로는 **A안**(왼쪽 크림 판: 로고·꼬리표·제목·요점 4개 노란 불 + 오른쪽 세로 영상 액자). 세로도 만든다.
  - 앞 30초 시험본을 보고 고칠 점을 모은 뒤 본 렌더를 한다.
- 파일 (reels/work/academy01/)
  - transcript_v2.json: Speechmatics 전사
  - plan_edit.py → edit_plan.json: 컷 35구간(7:11→6:50), 자막 185개, 파트 2개
  - build_render.py: `edit [--to S]` → `frames` → `h|v [--to S]`
  - head185_clean.mp4: 앞 185초, «Alicia 개인의 상황과 의견입니다» 지운 판(reels/tools/erase_overlays.py)
  - 시험본: out_h_test.mp4 · out_v_test.mp4
- 알려진 문제·다음 수
  - 0~4초 «보강» 스티커와 2:47~3:00 «토요일 수업» 상자는 지우면 맨투맨 «moment» 까지 번진다(2회 실측).
  - 지금은 1.4배 당겨 잡기(ROUTE/PUNCH)로 빼고 있는데, 세로 첫 3초는 얼굴이 아래로 쏠린다.
  - 제안: 그 자리에 새 디자인 배지를 덮는다(소유주 답 대기).
- 렌더 실측: 이 PC의 ffmpeg 는 h264_nvenc 를 못 쓴다(드라이버 API 12.2 < 13.1). libx264 로 30초에 약 1분.
- 재개 명령(cwd reels/work/academy01)

  ```
  python -I plan_edit.py
  python -I build_render.py edit
  python -I build_render.py frames
  python -I build_render.py h
  python -I build_render.py v
  ```

  본 렌더는 RENDERING.lock 이 없고 빈 메모리가 8GB 이상일 때 한다.

## academy01 하이퍼프레임판 (17:xx)
- 그래픽은 hf_build.py(HTML+GSAP → hyperframes 투명 mov → 편집본과 합성)로 짓는다. 옛 build_render.py h|v(PIL 판)는 쓰지 않는다.
- 0~4초 «보강» 스티커와 2:47~3:00 상자는 하단 타이틀 카드(CARDS)로 덮는다. 당겨 잡기는 폐기했다.
- 도식 장면 8개(SCENES): 칩·줄긋기 도장·막대·진도 카운트·토요일 달력·ESL 대 내신·한 주 시간표·기한 없음.
- 자막은 발화 단위로 끊는다(plan_edit.split_by_speech: 쉼·이음 어미 점수, 8~21자, 한 글자 낱말 뒤는 끊지 않음).
- 시험본: 0:48~1:50 demo_*. 본 렌더는 소유주 «대기».
  - 재개 명령: python -I build_render.py edit 다음 python -I hf_build.py h, python -I hf_build.py v
  - 예상 1시간
- 하이퍼프레임 렌더는 크롬을 띄워 메모리를 많이 먹는다(17:0x 메모리 부족으로 강제 종료됨). 정치 렌더와 겹치지 않게 한다.

## 오늘 있었던 일
- 소유주 지시로 정치 ko 렌더를 15:0x~16:28 일시정지했다(NtSuspendProcess, 끄지 않음).
- 재개는 reels/resume_politics.ps1 로 했고, PAUSED_BY_REELS.json 은 재개 때 삭제해 처리를 끝냈다.
- 17:07~17:35 소유주 지시로 2차 일시정지, 17:35 재개.
- 약속한 16:20보다 8분 늦었다. 교훈: paddle 모델 연결 점검 때문에 짧은 지우기도 수십 분이 걸린다. 약속 시각 전에 끝날 일만 돌린다.

## 도구 (reels/tools/)
- transcribe_full.py: Speechmatics 전사 + 구두점 포함 원본. rinbox_transcribe 를 import 한다.
- erase_overlays.py: 시간 창·자리를 정해 박힌 그래픽 글자만 LaMa 로 메운다. ocr_lama_erase.run_lama 를 import 한다. keep_small 로 작은 글자 줄은 남긴다.

## 대기 (소유주)
- academy01 시험본 수정 사항
- 힉스필드 키·월 상한, 작업 2 첫 소재

## 규칙
- 렌더·STT는 RENDERING.lock·RENDERING-ja.lock 이 없을 때만, 빈 메모리 8GB 이상에서 한다. 단 소유주가 직접 지시하면 그 지시가 우선이다.
- 키 값은 출력하지 않는다. 다른 레인 파일은 import 만 한다. 변경은 즉시 관리자에게 보고한다.
