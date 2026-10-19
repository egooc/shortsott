# 팬튜브(최애모먼트, idol_fantube_ko) 인계 (2026-10-19)

## 10-20 07:00 재부팅 대비 (10-19 밤 기록)
- **★10-19 23:1x 소유주 «보류»: 00:37 렌더 취소(릴스 밤샘 렌더), 크론 ae0f16f4 삭제. 재부팅 뒤 오전 릴스 종료·lock 없음·8GB 확인 → 아래 재개 명령으로 렌더·발행, 10/20 18:00 교체 그대로.** (옛 계획) **00:37 ep18 렌더·발행:** lock 없음·빈 메모리 8GB+ 확인 → `python fantube/tpl_b.py D:/volcano-runs/fantube/ep18/spec.json` → 0.25초 장면 검사·눈 검사 → `node fantube/publish.js ep18 D:/volcano-runs/fantube/_upload/ep18_jypbook.json 2026-10-20T18:00:00+09:00` → 태그 통과 시 `node fantube/yt_tags.js HbFqC4IS1ro <meta> --unschedule`(ep11) · `node fantube/ledger.js ep11 --youtube-id HbFqC4IS1ro --retracted "..."`. lock 이면 15분마다 재확인, **06:30 넘으면 시작 안 함**(재부팅 뒤 같은 명령 그대로, 공개 시각만 18:00 전이면 유지).
- **재개 명령 한 줄(재부팅 뒤 ep18 미완일 때):** `python fantube/tpl_b.py D:/volcano-runs/fantube/ep18/spec.json && node fantube/publish.js ep18 D:/volcano-runs/fantube/_upload/ep18_jypbook.json 2026-10-20T18:00:00+09:00`
- **자동화 구분:** 저조회 비공개 = schtasks `midform-low-views-private`(매시 :50, 자동 복귀). 태그 삽입·게이트·장부 = publish.js 안에서 업로드와 같이(세션 손 작업, 루프 없음). 예약 교체(ep11→ep18) = 세션 크론(00:37 일회성, 재부팅 전 끝남). 포장 교체 = 팬튜브엔 루프 없음(쇼츠, 수동). «공개 6h 조회 0 → 비공개» = 세션 수동 점검(루프 없음). 재부팅 뒤 다시 걸 세션 크론: 없음.
- **다음 할 일:** ep09 -FZp2Z-6wWc(10/21 08:00, 규진 단독) 교체할 새 편(PDF 규칙·20~30초·첫 줄 해설, tpl_b.py). 소유주 답 대기: ep18 규진 미포함 허용·ep17 KBS 소스·ep15z/ep16 승인.

## 정리 상태 — ★취소(10-19, 관리자 오독)
소유주 원문 «아직 확정은 아닌데. 팬튜브랑 롱투숏·린박스·롱폼·쇼핑 가져간다니까» → 팬튜브 유지. 제작·업로드 재개(08시 정규+18시 트렌드), 예약분 그대로, ep15z·ep16 시안은 소유주 승인 대기로 복귀. 아래는 취소된 정리 당시 기록(재개 명령·실측·자료 위치는 그대로 유효).

소유주 결정(10-19, 관리자 경유): 성과 기준(최근 발행 중앙 21~50회·구독 0) 미달로 레인 정리.
- 새 제작·업로드 중단. 채널·영상 삭제 없음. 자동 비공개(low-views-cleanup / midform-low-views-private)는 그대로.
- 돌던 렌더·GPT 작업: 없음(정리 시점 팬튜브 프로세스 0).

### 남은 예약(그대로 공개, 취소 없음) — 10-19 정리 시점 4편
| videoId | 공개(KST) | 편 |
|---|---|---|
| Kb2IacuOUo8 | 10/19 18:00 | ep14 「긴 소원」 아카펠라 |
| qC6h_vSzNbc | 10/20 08:00 | ep03 헬스장 5kg 덤벨 |
| HbFqC4IS1ro | 10/20 18:00 | ep11 바르셀로나 무대 규진 파트 |
| -FZp2Z-6wWc | 10/21 08:00 | ep09 빈티지샵 |
관리자 지시의 «5편» 중 34rkwCBoexY(ep07)는 10/19 08:00 이미 공개, dkTOaOhksaY(ep13)는 10/18 18:00 공개.

### 끈 작업
- 새 제작을 만드는 schtasks: 없음(팬튜브 생산은 전부 세션 손 작업이었다). 세션 크론: 0개(일회성 ep15·ep16 예약은 이미 실행됨).
- 유지: low-views-cleanup(매시 :50 저조회 비공개), 발행·점검 작업 전부.

### 승인 대기였다가 폐기된 시안(올리지 않음)
- ep15 줌판 D:/volcano-runs/fantube/ep15z/out.mp4 (자막 회피 확대·풀기 camera:"shots")
- ep16 한복 D:/volcano-runs/fantube/ep16/out.mp4 + _upload/ep16_hanbok.json

### 재개 명령
1. 소재: `python fantube/trend_scout.py` 또는 longform_competition.search(q,'month',pages=2), 기획은 ref/top2/GUIDE.md 유형 5개.
2. 조립: `python fantube/fantube.py <workdir>`(spec.json, camera track/shots), 눈 검사 후
3. 발행: `node fantube/publish.js <epNN> <upload.json> <ISO>` — 가이드 점검(guide_check.py+미성년 낱말, 걸리면 exit 4) → frame_dup 경고 기록 → 업로드 → 태그 게이트 → 장부. 미리 보기만은 `--check-only`.
4. 무거운 작업 전: RENDERING.lock·RENDERING-ja.lock 없음 + 빈 메모리 8GB+, 18:30~00:30 금지.

### frame_dup 실측(ls_tools/frame_dup.py, 경고선 ≤10/64)
- ep16 한복(검색어 «엔믹스 해원»·«엔믹스 한복 해원»): 16편 대조·경고 0, 최소 13/64, 166초. 기록 _upload/frame_dup.jsonl, ep16/out.frame_dup.json.
- **양성 미검출:** ep16 이 실제로 쓴 원본 직캠 AoZm-6kLOb4 도 14/64 로 통과 — 크롭(760 창)·위 제목 띠가 붙으면 선에 안 걸린다. 롱투숏이 보정함(10/19): 보정판으로 다시 돌리니 AoZm-6kLOb4 7.3/64 → 경고(맞는 판정). ep16/out.frame_dup.json 은 보정판 결과로 덮어써짐. frame_dup.py 소유는 10/19부터 도구개발 세션.

### 자료 위치
- 기획 가이드: D:/volcano-runs/fantube/ref/top2/GUIDE.md (상위 2채널 쮸뀨미연구실·설유니버스 × 인기 12편, 원본 v/, 시트 sheet_0~5.jpg, GPT 분석 analysis.md)
- 주간 트렌드: ref/gpt/trend_1018.md · CANDIDATES_1018.md / 한복 레퍼런스: ref/hb/ANALYSIS.md
- 도구: D:/midform/fantube/(fantube.py·member_id.py·stage_track.py·band_erase.py·publish.js·yt_tags.js·ledger.js)
