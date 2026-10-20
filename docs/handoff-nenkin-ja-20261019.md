# 연금 JA 인계 (2026-10-19)

담당 세션: rebuild-midform-baseline-recovery-ac(연금JA). 10-19부터 정본 담당이고, 그 전 제작은 도구개발 세션이 맡았다.
근거 자료: 관리자 인계 메시지(10-19), ja-nenkin/NEXT.md, 카테고리 카드(docs/category-cards/2026-10-16-longform-first-category-cards.md 카드 1), 관리자 인계 docs/handoff-manager-20261014.md §5·§7·§10.

## 1. 레인 한 줄

ja 年金·給付金·相続 해설 롱폼(20~30분, 65세 이상 일본 시청자). 카드 1 ★: 신규 채널이 가장 쉽게 뚫는 ja 카테고리이고, 2026-09 개설 채널이 14일 중앙값 30.8만을 냈다. 광고 단가도 가장 높은 축이다.

## 2. 현재 상태

| 항목 | 상태 |
|---|---|
| ①편 영상 | ja-nenkin/ep01/episode.mp4 (25.3분), 등급 «업로드 가능(채널 연결 뒤)» |
| 포장 | ep01/packages.json 3묶음 — 썸네일 A(서류명)·B(금액 훅)·C(서류 실물+今年はじめて, 10-19 추가), 0번=B로 업로드. packages_gate.py 통과(10-19 재확인) |
| 부속 | keywords.json · description.txt · thumb/(thumb.png·thumb_b.png) · human_check.md(숫자 출처 대조) · audit/ |
| 렌더러 | ja-nenkin/render/nenkin_render.py — 10-19 11:48 도구개발이 자막 띠 경계 공백을 고쳤다. **①편은 재렌더하지 않는다. 지금 파일이 업로드본이다.** 2편부터 반영 |
| 채널 | **새 채널 «年金書類の読み方教室»(연금 서류 읽는 법 교실, 소유주 10-20 00:40 확정) · 핸들 @nenkinshorui 권장(대안 @nenkin-yomikata)**. 10-19 확정했던 «年金と給付金の手続きノート»는 레퍼런스 채널 «年金・給付金 手続きノート»와 사실상 같아 폐기. 생성·전화 인증은 소유주 손(요청됨) |
| 업로드본 | **ep01/episode_v3_lufs14.mp4 (10-20 02시 재렌더 뒤 확정)** — 채널명 낭독 장면 삭제 + 0장 띠의 남의 채널명을 새 이름으로. 이전 승인본 ep01/episode_lufs14.mp4(음성만 -14.0 LUFS·TP -1.1, 영상 스트림 복사 — 관리자 10-19 승인). episode.mp4 는 원본 보존 |
| 2편 | 소재·원고 착수 전(도구개발 10-19 인계 확인) |
| 소유 도구 | 렌더러 nenkin_render.py · TTS supertonic_worker.py · 숫자 역전사 num_audit.py — 10-19부터 이 세션 소유 |

## 3. 다음 편에 반영할 것 (NEXT.md)

도구개발 10-19: 아래 1·2와 자막 띠 경계는 렌더러에 반영 완료(no_blank 92dc03a, 자막 띠 23c4d9f). 2편 첫 렌더에서 경계만 눈으로 확인.

1. 같은 표가 연속 장면으로 이어질 때 처음부터 다시 그려진다 → 이전 장면에서 보이던 행은 유지(직전 블록과 vid 가 같으면 이어받기 표시).
2. 장면 경계에서 본문 카드가 1초쯤 빈다 → 다음 장면 첫 요소를 전환 안에 미리 깐다(11:48 렌더러 수정과 겹치는지 2편 렌더 때 확인).
3. 포장: 금액 훅 제목 + 썸네일 B 조합을 권장(발굴). packages.json 1번 묶음(«夫婦で年11万円損» + thumb_b)이 그 조합이다.

## 4. 채널 연결 순서

소유주 손:
1. 채널 이름 결정
2. 채널 생성(구글 계정·브랜드 계정은 소유주 선택)
3. 전화 인증 youtube.com/verify — 15분 넘는 영상과 맞춤 썸네일 권한. **인증 전에는 업로드하지 않는다**(ko 10-14·ja 10-18 두 번 처리 거절).
4. **웜업 여부(결정 대기, 큰제로 Z10 · §5 47 B1)** — 권고: 채널 생성일부터 그 계정으로 폰 10분/일 타겟 영상 시청·좋아요, 3일 뒤 업로드
5. 연결 동의 화면에서 새 채널 선택(폰으로도 가능 — `--url-only` → 콜백 주소 전달)

세션:
1. `node scripts/yt-connect.js nenkin_ja` (또는 `--url-only` / `--code`)
2. 연결 직후 channels.list(mine)로 채널 id·이름·권한 확인. **resumable init 으로 권한을 시험하지 않는다**(빈 비공개 영상이 생긴다, 10-19 정치JA 사례)
3. 채널 기본 정보(설명·키워드·언어·국가=일본)를 일본어로 채운다
4. 저조회 자동 비공개는 새 채널 연결 후 14일 유예

## 5. ①편 업로드 절차

1. 업로드(scripts/yt-upload.js) — 메타데이터(제목·설명·태그·자막·고정 댓글) 100% 일본어, VPN 안 씀, 설명란에 소스 URL 넣지 않음
2. videos.list processingDetails.processingStatus = `succeeded` 확인. failed 면 예약·점검 등록 안 함
3. 태그 게이트: politics-hour/yt_tags.js 로 태그 삽입 → API 재확인. **0개면 공개 금지**
4. 썸네일 업로드(인증 안 됐으면 403 — 그때는 공개 보류하고 보고)
5. 공개 시각: 일본 시간 저녁(정치JA 18:00 JST 관행) — 소유주 확인
6. views_check 자동 포장 교체 등록: politics-hour/views_check.js 를 import(새로 만들지 않음), +4/8/12/24h·매일, FLOOR 는 ko×0.5 틀. 1주 뒤에도 바닥 아래면 하루 1회 점검·주 1회 교체, 3묶음 다 떨어지면 소유주에게 새 후보
7. 고정 댓글(일본어)

## 6. 렌더·자원

- 렌더 창 13~17시. 정치 ko 락(18:30~00:30)과 정치JA(04:30~07:00)는 피한다.
- 시작 전 RENDERING.lock·RENDERING-ja.lock 없음 + 빈 메모리 8GB 이상 확인.
- 출력 -14 LUFS(도구개발이 측정).

## 7. 이 레인 규칙

- 글씨 크게: 자막 92px·도표 56px 이상(노인 시청자).
- 디자인은 레퍼런스 복제 금지. 구조·길이·밀도는 레퍼런스에서, 디자인은 고령층 매체(잡지·전단·관공서 안내문)에서. 일본어 줄바꿈은 구(어절) 경계만.
- TTS(Supertonic ja): 숫자·조수사는 전부 히라가나 입력, 고유명사는 yomi.json 히라가나(高市→«壊し» 사례). 업로드 전 역전사 대조 관문은 숫자+고유명사 둘 다.
- 숫자는 human_check.md 처럼 원문(일본연금기구·지자체 PDF)과 대조해 출처를 적는다. K7 E-E-A-T: 고유명사·전문 용어 밀도 검수(docs/kaian-column-rules-20261019.md).
- 제목 틀(S7, docs/sky-column-rules-20261019.md): 서류명/제도명 머리 + 쉬운 풀이 한 구절 + 손해/이득. ①편 포장은 유지(관리자 10-19), 2편부터 3묶음 전부.
- 포장: 키워드 먼저(keywords.json 3~5개) → 제목 첫 낱말 = 썸네일 1위 큰 낱말 → 첫 30초 안에 등장 → upload_gate. 포장 3묶음 없이는 업로드 관문 불통.
- 영상 삭제 금지(비공개만). 재업로드 금지.
- **레퍼런스 채널명·문구는 렌더 틀 상수·원고에 절대 넣지 않는다**(10-20, 1편 띠·13행에 남의 채널명이 들어갔던 사고). 채널명·제목 후보엔 중복 검색 결과를 붙인다.
- 콜드오픈 70초(10-19 §7): 0~5초 썸네일 낱말·인사/채널명 낭독 삭제·질문 한 줄 15초 안·서류 장면 40초 안·첫 답 70초 안. ①편 기준선은 NEXT.md. 공개 +24h 지속 곡선 첫 70초 보고.
- 2편 기획 가이드 ja-nenkin/ep02/planning_guide.md: 머리에 레인 대리만족 한 문장·5W1H 방향 문장, 24편마다 7항목 시트(큰제로 Z1·Z2, docs/keunzero-column-rules-20261019.md).
- 기획 가이드 표준: 2편 원고 전에 상위 2채널×인기 12편 분석(planning-guide-top2x12).
- 오늘 10-19 PC 전체 유튜브 자막 요청 금지(429).
- GPT(gpt-ask) 아끼지 말고 쓰고 건수만 보고.
- 키·토큰 값 출력 금지.
- 소유주 보고는 한국어만(일본어 제목·채널명도 번역), 경로·도구명은 이 문서에만. 변경 즉시 관리자 보고 + 하루 마감 한 줄.

## 8. 소유주 대기

1. ~~채널 이름~~ → «年金書類の読み方教室» 확정(10-20, 10-19안 폐기)
2. 채널 생성
3. 전화 인증
4. 첫 공개 시각(가안: 일본 시간 18:00)
5. 새 채널 웜업 여부(업로드를 3일 늦출지)

질문은 관리자 세션으로.

## 8-1. 10-20 07:00 재부팅 (docs/reboot-20261020.md) — ★보류(소유주, 릴스 먼저)

- 보류 동안: 채널 생성 알림이 오면 연결·업로드(처리 대기 포함)는 바로 진행. 2편 렌더는 «릴스 끝» 알림 뒤.

- 채널 생성 알림이 재부팅 전에 와도 **업로드는 재부팅 뒤**(처리 대기 중 끊기면 안 됨).
- 06:30 이후 새 렌더·TTS 시작 금지. 지금 돌고 있는 연금 프로세스 없음.
- 10-20 13~17시 렌더 창은 기업 흥망과 공유 — 먼저 락 건 쪽 우선.
- 재부팅 뒤 첫 일: 관리자에게 새 주소로 첫 메시지 → 이 문서 §2·§8 확인.
- 재개 명령(채널 생성·인증 끝난 뒤):
  `node scripts/yt-connect.js nenkin_ja` → channels.list(mine) 확인 → packages.json purpose 를 nenkin_ja 로 맞춤 → `PYTHONIOENCODING=utf-8 python scripts/packages_gate.py ja-nenkin/ep01 --lang ja --lane nenkin` → yt-upload.js 로 ep01/episode_lufs14.mp4 업로드(비공개) → processingStatus succeeded → yt_tags → 썸네일 B → 공개 예약 18:00 JST → views_check 등록 → 고정 댓글.
- 2편: 기획 가이드(상위 2채널×12편) 분석부터, 아직 산출물 없음.

## 9. 변경 기록

- 10-19: 이 세션이 연금 JA 정본 담당으로 지정됨. 인계 문서 초안 작성.
- 10-19 13:24: 썸네일 C(thumb/thumb_c.html·png, 서류 1쪽 실물) 추가, packages 2번 묶음에 연결(백업 log_packages_v2_20261019.json), 관문 통과.
- 기업 흥망이 렌더러 도식·자막을 import 할 때 분리 지점: 글꼴 CSS 140행(NotoSansJP)·THEME 166행(NotoSerifJP), 색 60행·164행 상수.
- 10-19: 태그 보정(0번 11万円, 2번 今年はじめて·書き方, 백업 log_packages_v3), 렌더러 음량을 loudnorm_final 2패스로 교체, 1편 음성 정규화 사본을 업로드본으로(관리자 승인). 채널 이름 확정.
- 채널 생성 알림 뒤 순서: 연결 → 권한 확인 → 업로드 → 처리 완료 → 태그 → 포장 점검 등록, 단계마다 관리자에 한 줄 보고.
- 10-20 00시대: 채널명 교체(«年金書類の読み方教室»), 1편 채널명 장면 삭제·0장 띠 재렌더 승인, 렌더러 CHANNEL 상수. 2편 24편 표(ep02/top24_refs.md)·소재 후보표(ep02/topic_candidates.md, A 추천)·프레임 시트 도구(render/ref_sheet.py).
- 원고 script.txt 13행(@title_card)은 장면 번호가 바뀌면 전 장면 재합성이 되므로 남겨 두고, 이어 붙이기에서만 뺀다.
- 10-20 02:06 1편 0장 띠 재렌더 완료 → 업로드 후보 ep01/episode_v3_lufs14.mp4 (1517.5초·-14.0 LUFS). ★1편 원고 47문장이 레퍼런스(HSI) 근접 복제로 판명(ep01/audit/ref_overlap.txt) — 다시 쓴 판 ep01/script_v2.txt(일치 0), 소유주 A7(① 31장면 재합성 권고) 답 대기. ①이면 script_v2 → script.txt 로 바꾸고 바뀐 장면만 --tts-only → num_audit → 렌더 → concat(002-title_card 제외) → loudnorm.
- 10-20 2편: 원고 254문장(약 19.3분)·장면 76·포장 3묶음(packages_gate 통과)·음성 합성 끝·역전사 숫자 163/163·고유명사 127/127·레퍼런스 일치 0. 남은 것: 화면 렌더(13~17시) → gap_check·LUFS → description.txt·고정 댓글. 재개: `python ja-nenkin/render/nenkin_render.py ja-nenkin/ep02` (음성 재사용).
- 원고 관문(10-20~): `python ja-nenkin/render/ref_overlap.py <script>` 종료 코드 4면 렌더 금지 · num_audit 종료 코드 3은 «점 빠짐» 청취 확인.
- 소유주 10-20 01:10: 채널 생성·인증되면 바로 연결 / 업로드는 생성 3일 뒤(웜업, 폰 10분/일) / 공개 15~16시 KST / 숫자 사람 확인 생략.

- 10-20 10:50 관리자 #6·#10·#11 반영(f7b563f): 용어 사전 ja-nenkin/jargon.json(25) · 원고 관문에 `python scripts/script_audit.py <script> --lane nenkin_ja --jargon ja-nenkin/jargon.json`(전환 최대 간격 120초 이하) · 업로드 관문에 `python scripts/title_check.py <ep>/packages.json --lane nenkin_ja --jargon ja-nenkin/jargon.json --fail-on-warn`(종료 0). 2편 전환 8곳 추가로 8장면 재합성 필요 — 13시 창에서 `nenkin_render.py ja-nenkin/ep02 --tts-only` → num_audit --only → 렌더. 원본 log_script_pre_transition_20261020.txt.
- 10-20 11:20 관문을 코드에 박음: TTS 전 = nenkin_render.py script_gate()(ref_overlap 4·5·script_audit △·comment_hook 실패면 SystemExit, 우회 플래그 없음) · 업로드 전 = `python ja-nenkin/render/upload_gate.py <편>`(title_check·tag_gate·packages_gate, 실패 종료 4 → 업로드 금지). 편마다 comment_spec.json(expected_comment·pinned_comment) 필수 — at_sec 는 렌더 뒤 실측으로 고칠 것. 1편 A7① 진행(script_v2 채택 + 끝 댓글 줄), 13:00 자동 TTS 잡(스크래치 tts1300.sh).
- 10-20 14:48 ★1편 v4 완성 = 업로드 후보 ep01/episode_v4_lufs14.mp4(1553.8초·-14.01 LUFS·TP -1.4·upload_gate 통과·comment at_sec 1548.8). 2편 화면 렌더는 14:4x 메모리 부족으로 강제 정지(20/78 장면 완료, 기업 ep01 렌더와 동시). 재개는 소유주 말로만 — 관리자 경유 답 대기, 권고는 기업 ep01 뒤 또는 10-21 13시 창. 재개 명령 `python ja-nenkin/render/nenkin_render.py ja-nenkin/ep02`(끝난 장면 재사용) → gap_check·-14 확인·눈검사·comment_spec at_sec 실측.
- 10-20 16:47 ★2편 완성 = ep02/episode_lufs14.mp4(1172.1초·-14.01 LUFS·TP -1.39·무음 경고 0·upload_gate 통과·comment at_sec 1165.7·description.txt 작성). 1·2편 둘 다 채널 연결 대기.
