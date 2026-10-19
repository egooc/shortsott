# 정치 ko(쟁점브리핑) 인계 — 2026-10-19 밤 (10-20 07:00 재부팅 대비)

정본 폴더: `D:/midform/politics-hour`. 롱폼 렌더는 메인 PC, 18:30~00:30 창, `RENDERING.lock`. 06:30 뒤로는 새 렌더·STT를 시작하지 않는다.

## 지금 상태

| 무엇 | 상태 |
|---|---|
| 10/19 롱폼 | **IDFYC2j0dE0** 19:00 공개. 태그 23개 확인, 고정 댓글 달림(고정 표시는 스튜디오 수동). 해설 TTS 숫자 오독 3곳(27.1%·19.0%·1,001명)을 고친 판이다. 옛 판 4nCS41bCGso는 비공개로 두었고 삭제 금지, packages.json `retracted`에 기록. |
| 10/19 쇼츠 | s1 브런슨 **IZLgs_ZmACg** 21:00 예약(태그 14개, +6h 점검, 21:03 댓글 작업). s2 박용진(`shorts/20261019/s2_bigyo.upload.json`, 렌더 완료)은 **10-20에 업로드**. 하루 업로드 한도 때문이다. |
| 10/20 롱폼 | **렌더 끝(21:43)** — `episodes/20261020/work/episode.mp4` 20:05, L컷 23곳, tts_audit OK, -14.05 LUFS, upload_gate PASS. 첫 70초: 질문 14.6초·첫 본문 발췌 35.2초. **아직 업로드 안 함**(10-19 업로드 3건 → 한도 우려) — 10-20 09:00 상승 키워드 재확인 뒤 make_meta→upload.json→업로드(18:00 예약). 포장 3묶음은 자동완성 구문 머리+전문용어 풀이. |
| 10/20 쇼츠 | `shorts/ls/make_plans_20261020.py`(s1_sabeop 김종배·s2_hamkke 정춘생). 계획만 있고 렌더는 아직이다. 렌더하려면 `thumb/thumb_k_<name>.json`도 필요하다. |

## 재부팅 뒤 재개(순서대로)

1. 관리자에게 첫 메시지를 보내 새 주소를 등록한다.
2. 10/20 렌더가 끝났는지 본다: `RENDERING.lock`이 없고 render.log에 `PASS — 길이`가 있으면 끝난 것이다.
   - 렌더가 끊겼으면 **소유주 말을 받은 뒤에** `cd D:/midform/politics-hour && python render_episode.py episodes/20261020` 로 다시 돌린다. 조각은 해시로 캐시돼 있어 남은 조각만 만든다.
3. 09:00에 상승 검색어를 다시 확인한다(`server/data/rising_keywords/politics_ko_latest.json`, 08:00 schtasks 결과). 오전 소식이 있으면 바뀐 문장 조각만 고쳐 `python build_episode.py` → `render_episode.py`(13시 전).
4. 업로드 전 검사를 돌린다: `python -X utf8 politics-hour/overlay/tts_audit.py politics-hour/episodes/20261020`(render_episode가 자동으로 돌림) → `python politics-hour/upload_gate.py politics-hour/episodes/20261020 politics-hour/episodes/20261020/upload.json`.
5. `make_meta.py` → upload.json(packages[0] 제목·tags·썸네일, `pinned_comment`) → `node scripts/yt-upload.js <upload.json> --purpose politics --publish-at 2026-10-20T18:00:00+09:00`
   → `node politics-hour/yt_tags.js <id> <upload.json> --gate` → packages.json `video_id` 채우기
   → `node politics-hour/views_check.js <id> --schedule <publishAt>` → 공개 뒤 `node politics-hour/yt_comment.js <id> <upload.json> --wait`
6. 쇼츠: s2_bigyo 업로드, 그리고 10/20 쇼츠 렌더(`cd shorts/ls && python ../briefing_render.py 20261020/<name>/plan.json`). 쇼츠 썸네일은 `thumb_keyword.py`로 만든다.

## 자동화 종류(세션 루프 아님)

- **views_check(포장 교체)**: schtasks `politics_views_<id>_<h>h`·`_daily`. 모두 StartWhenAvailable이 켜져 있어, 재부팅 때 놓친 07:00 점검은 부팅 뒤 바로 돈다. 로그는 `server/data/politics_views_task_<id>.log`.
- **고정 댓글**: schtasks `politics_comment_<id>`(1회).
- **상승 검색어**: schtasks `midform-rising-keywords` 08:00·14:00(도구개발 소유).
- **태그 삽입**: 업로드 직후 손으로 1회(`yt_tags.js --gate`, 3분 재확인).
- **yt-low-views(저조회 비공개)**: 정치 ko는 대상이 아니다.

## 오늘 바뀐 규칙·도구(커밋)

- 660180f: views_check 작업에 StartWhenAvailable.
- c0558ef: render_episode 끝에 loudnorm_final -14 LUFS.
- 7e1e206·37243e9: `overlay/lcut.py`(L컷), `tts.speak(say=)`+`tts_say`/`tts_keep`, `overlay/tts_audit.py`(역전사 숫자·고유명사 대조, 소수는 한 덩어리로 비교), upload_gate가 audit/result.json을 요구. 공용 이름 표는 `names_ko.json`.
- 659b497: `yt_comment.js`.
- 8ab0324: 렌더 후처리까지 락 유지. 01174a3: tts_audit 조각 재받아쓰기·verified.json·이름 겹쳐 세기 방지.
- 10/19편 포장 6묶음(자동완성 구문 머리·전문용어 풀이), 21:00경 소유주 즉시 교체로 2번(조계원) 적용 중. 노출 2(소유주 스튜디오) — 노출이 없으면 포장 교체 효과 없음.
- b831596: 10/20 쇼츠 계획.
- 주제 선정은 «오르는 검색어»(rising_keywords)로 한다. 첫 70초 규칙: 인사·날짜·목차 낭독 없이 15초 안에 질문, 40초 안에 첫 발췌.

## 소유주 대기

- 오마이TV 사용 여부(§5 30). 그때까지 USE_OHMY=False.
- 스튜디오 «테스트 및 비교»(동적 썸네일·영상 A/B)가 열렸는지 확인.
- 10/19 쇼츠 s2의 «빽 있는 놈들» 표현을 뺄지.
