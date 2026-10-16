# 공유 도구·관문 목록 (shared-tools)

소유주 2026-10-15: «각 세션에서 필요에 의해 만들어진 고유 코드나 게이트, 스킬들을 목록화해서 각 세션이 가져다 쓰고 참고하고 반영할지 제안하거나 반영하기 쉽게 — 매번 내가 생각하고 제안하지 않아도 되게».

규칙
- 세션이 새 도구·관문·스킬을 만들거나 공용 코드를 고치면 **변경 보고와 함께 이 표에 한 줄** 넣는다(관리자에게 보내면 관리자가 적어도 된다). 기계용 사본은 `server/data/tool_registry.json`.
- 관리자는 매일 07:40 성과 보고 6장에 «이번에 새로 생긴 것 / 다른 레인에 옮길 만한 것 / 볼케이노에서 온 후보»를 적고, 옮길 레인 담당 세션에 바로 제안한다. 소유주는 «해» 한 마디면 된다.
- 상태: `제안` → `시험` → `채택`(그 레인이 씀) / `보류`(이유 적기). 공용 파일을 고치는 일은 쓰는 세션들끼리 먼저 합의한다.
- 원칙: **복사하지 말고 import·호출**한다(`check-the-other-session-first`). 복사본이 생기면 여기 «중복» 표시.

## 1. 렌더·편집

| 도구 | 만든 세션 | 경로 | 하는 일 | 쓰는 레인 | 옮길 후보 레인 | 상태 |
|---|---|---|---|---|---|---|
| rinbox_render.py | C 린박스 | scripts/rinbox_render.py | 자체 숏폼 렌더러(컷·내레이션 그림·자막·-17 LUFS) | ja, ko_longshort(import), politics_short(import) | fantube(자체 fantube.py와 비교) | 채택 |
| longshort_render.py | A 롱투숏 | scripts/longshort_render.py | rinbox_render 를 import, 화면 틀만 교체(HUD·REC 타임코드·nar_cap_y) | ko_longshort, politics_short(briefing_render 가 frame_html·render_frame·_write_ass·narration_events 를 바꿔 끼움) | — | 채택 · **함수 이름 바꾸면 정치 깨짐** |
| briefing_render.py | 정치 | politics-hour/shorts/briefing_render.py | 롱폼 요소(남색·노랑·NEWS·페이퍼로지/공군체) 세로 틀, 자막은 하이퍼프레임이 직접 그림(ASS 비움, CAP_MAX ko 18), 화자 정당색 상자·hot 낱말, 화면 밖 목소리 말풍선(voices [초,키,l|r]+중립 라벨), 이름 카드·끝 카드·티커 | politics_short | fantube(화자색). A 는 보류(원음 대화 그대로) | 제안 |
| longshort_bed.py | A 롱투숏 | scripts/longshort_bed.py | Demucs 로 목소리 뺀 현장음을 해설 밑에 -3dB 깔개 | ko_longshort | ja(현장음 있는 時代劇), shop(원음 끄면 BGM 필요) | 제안 |
| shift_plan.py | A 롱투숏 | D:/volcano-runs/ls_tools/shift_plan.py(저장소 밖) | 편집표를 잘라 낸 조각 영상 기준으로 옮김(시간·전사 이동). 소스를 미리 잘라 쓰는 레인에 유용 | ko_longshort | ja(크롭·조각 소재), fantube(짜집기 조각) | 제안(10-15) |
| autocap.py | A 롱투숏 | D:/volcano-runs/ls_tools/autocap.py | 컷 구간 전사 토큰을 12자 칸으로 자동 분할. cut(maxlen=, show=[…]) 지원, 영어 원음은 26자로 묶고 칸마다 한국어 번역(10-15) | ko_longshort | ja(일본어 원음 번역). B·정치는 자기 분절기 유지 | 채택(A) · B·정치 보류 |
| mkplan.py (중간 내레이션 'N') | A 롱투숏 | D:/volcano-runs/ls_tools/mkplan.py | 편집표 생성, 장면 사이 상황 설명 내레이션 ('N', id, 카드) | ko_longshort | ja(명화관식 연결 해설이 필요할 때) | 제안 |
| render_queue.sh | A 롱투숏 | D:/volcano-runs/ls_tools/render_queue.sh | RENDERING.lock 기다렸다 한 편씩 렌더. 큐 잇기는 앞 큐 로그의 QUEUE DONE 대기 | ko_longshort, politics_short(10-15 채택) | ja, fantube | 채택 |
| fantube.py one_line() | B 팬튜브 | D:/midform/fantube/fantube.py | 자막 한 칸 한 줄·어절 16자·칸 길이 균형·*강조* 덩어리 안에서 끊으면 벌점 | fantube | — (16자는 띠 폭·글꼴 기준이라 12자로 통일 안 함) | 채택 |
| outro_pool (말 끝 +0.3~0.5s) | B 팬튜브 | D:/midform/fantube/outro_pool.json | 엔딩 움짤이 말 끝까지 담기게 | fantube | — | 채택 |
| subject_pos.py (5×9 시트) | N100 | volcano-runs/tools/subject_pos.py | 완성 화면을 5×9 칸으로 나눈 시트를 보고 글자를 피사체 옆에 둔다(자동 판독은 실패, 사람·모델이 칸 선택) | N100 5채널 | shop(배지·효과음 글자 위치), fantube | 제안 |
| cold_overlay.py / COLD_OPEN | 정치 | politics-hour/overlay/cold_overlay.py | 롱폼 첫머리 콜드오픈(큰 자막 전용 장면) | politics_long | — | 채택 |
| ff_render.py | 쇼핑 | scripts/ff_render.py | 쇼핑쇼츠 자체 렌더러(후킹→경험→비밀→원리→증거→CTA) | shop | — | 채택 |
| ship.py | A 롱투숏 | D:/volcano-runs/ls_tools/ship.py | final.mp4 → lsNN-ko.mp4 복사 + 사이드카(크레딧→카탈로그 work, 원작 유도 설명란) | ko_longshort | fantube·shop 중 rinbox-publish 쓰는 레인 | 제안 |
| shots.sh | A 롱투숏 | D:/volcano-runs/ls_tools/shots.sh | 구간 샷 경계(scene>0.25) 빠른 측정, 편집표 쓸 때 | ko_longshort | 전 레인 — rinbox_edges 와 겹쳐 합치기 후보 | 제안 |
| 쇼츠 자막 분절 cut() | 정치 | politics-hour/shorts/ls/make_plans_20261015.py | 8~14자, 문장 끝 즉시·조사/연결어미 뒤·넘치면 마지막 어절로·부정/보조 서술 안 뗌·감탄사 한 칸·화자 바뀜·쉼 — 린박스 손 분절 관행 자동화 | politics_short | ko_longshort(autocap 대체 후보), fantube | 제안 |
| make_thumb.py | 정치 | politics-hour/episodes/<날짜>/thumb/make_thumb.py | 두 얼굴+그라데이션, 윗줄 노랑 발언·아랫줄 흰 궁금증, 반응 부호·빨간 칩(vidIQ 국감 상위 30편 실측) | politics_long | ko_longshort(롱폼 썸네일 있으면) | 채택 |
| outro_swap.py | B 팬튜브 | D:/midform/fantube/outro_swap.py | 엔딩 움짤 풀 교체 + closer·sparkle 끝 이동 | fantube | — | 채택 |
| member_id.py | B 팬튜브 | D:/midform/fantube/member_id.py | YuNet+SFace 특정 인물 얼굴 유사도 스캔·기준 임베딩 | fantube | ko_longshort(출연자 확인), N100(subject_pos 1차 후보) | 제안 |
| fantube.py member_cam() | B 팬튜브 | D:/midform/fantube/fantube.py | 대화 장면에서 지정 인물 기본, 자막 화자가 다르면 그 사람으로 카메라 | fantube | ko_longshort(투샷 토크) | 제안 |
| stage_track.py | B 팬튜브 | D:/midform/fantube/stage_track.py | 무대 단체 샷에서 한 멤버 추적(얼굴+상의 색+위치) | fantube | N100 | 제안 |
| cell_sheet.py | B 팬튜브 | D:/midform/fantube/cell_sheet.py | 추적기가 놓친 샷을 8×5 칸 시트로(N100 subject_pos 응용) | fantube | shop, N100 | 제안 |
| _trend/locate.py | B 팬튜브 | D:/volcano-runs/fantube/_trend/locate.py | 남의 쇼츠 소리 포락선을 원본 롱폼에 맞대어 원본 시각 찾기(전사 0원) | fantube | ko_longshort(터진 쇼츠의 원본 구간), N100 | 제안 |
| scout_source.py | B 팬튜브 | D:/midform/fantube/scout_source.py | 공식 영상 받기·다시보기 정점·구간 전사·장면/자막 시트 | fantube | ko_longshort | 제안 |
| brand.py | B 팬튜브 | D:/midform/fantube/brand.py | 채널 프로필·배너(PIL) | fantube | A brand_art.py 와 중복 — 통일 검토 | 중복 |
| recaption.py | N100 | volcano-runs/tools/recaption.py | 자막 글꼴·색·테두리 교체, TTS 단어 비율로 단어별 이펙트 | N100 | ko_longshort·정치(아래 자막) | 제안 |
| tpl_render.py | N100 | volcano-runs/tools/tpl_render.py | 채널 템플릿 5종(pop/box/soft/sweep/bounce, 하이퍼프레임 제목), subject_pos 반영 | N100 | 새 채널 만드는 레인 | 제안 |
| motion.py / tempo.py | N100 | volcano-runs/tools/ | 콜드오픈 펀치·반전 흔들림 / 완성본 1.12배(사슬 맨 끝) | N100, 정치(motion) | 숏폼 레인 전부 | 제안 |
| mix_ambient.py | N100 | volcano-runs/tools/mix_ambient.py | 현장음을 내레이션 아래로(−3dB·덕킹) | N100 | ko_longshort·fantube — longshort_bed 와 같은 일, 통일 검토 | 중복 후보 |
| contact_sheet.py | N100 | volcano-runs/tools/contact_sheet.py | 영상 → 1fps 타임코드 시트(장면 고르기) | N100 | 전부(각 레인에 비슷한 시트 도구 있음 — 통일 검토) | 제안 |
| own_check / own_tts / own_gate | N100 | volcano-runs/tools/ | 편집표 검사(10-15부터 엔진 source_shots 직접 읽음) · Typecast 직접 TTS · 볼케이노 엔진 코드(film_editor.py) 로컬 반려 검사 · own_gate.spec_checks(채널별 원고 규격·금지 상투구) | N100 | 볼케이노 엔진 규격 쓰는 레인 | 채택 |
| own_policy.py + own_text.py | N100 | volcano-runs/tools/ | 10-15 신설. facts.json(숫자 문장은 출처·확인 필수) · P1 가이드 6항목(컨택트 시트 p1.json 판독, 욕설 사전, 애매하면 FAIL) · S1 국내 중복도(제목 검색 10만+ 경고 → _gate_log) · 박힌 글자·로고(own_text, rinbox_screen 이식) | N100 5채널 | shop(facts·P1), ko_longshort(P1), politics(P1), 전 레인(S1 — 메인 PC는 yt-search.js 기반 dup-check 로) | 채택 → 공용 후보 |
| mix_bgm.py | N100 | volcano-channel/tools/ (own_render.py 마무리 사슬: 현장음 다음·템플릿 앞) | 10-16 신설. 채널별 CC BY 4.0 곡(assets/bgm/<채널>_<레인>/ + license.json)을 해설 −20dB로 깔고 말할 때 더 눌림(ducking), 1.2초 페이드인·2.5초 페이드아웃, 시작 자리 회차마다 다름, channel.json bgm.off로 끔, 곡 없으면 그대로 진행. bgm.json → volcano-upload.js가 설명란에 Music 출처 자동 | — | N100 5채널 | 채택(N100). 쇼핑(원음 끄면 BGM 필요)·정치 쇼츠 후보. Blotato 확산 캡션 출처 줄 확인 중 |
| script-frames.json + script-guides/*.md | N100 | volcano-channel/config, recipes | 채널별 원고 틀(문장 수·글자·어미·길이·금지 구절) + 벤치 1위 기반 지침서 5개. «다섯 채널이 달라져야» 소유주 지시의 구현 | N100 5채널 | 레인별 지침서 틀(R8)로 전 레인 참고 | 채택 |
| brand_art.py | A 롱투숏 | D:/volcano-runs/ls_tools/brand_art.py | 채널 로고·배너 생성 | ko_longshort | 새 채널 전부(라이드랩·엔진룸·どうぶつ劇場 이름 바뀔 때) | 제안 |

## 2. 검사·관문

| 도구 | 만든 세션 | 경로 | 하는 일 | 쓰는 레인 | 옮길 후보 레인 | 상태 |
|---|---|---|---|---|---|---|
| rinbox_screen.py (+보조 경계 검사 10-15) | C 린박스 | scripts/rinbox_screen.py | 컷 경계·깜빡임 화면 검사. 10-15부터 ffmpeg scene>0.12 로 덩어리 앞뒤 15프레임 안 경계면 FAIL | ja, ko_longshort, politics_short, fantube(pieces.json), 명화관 shot_focus(shot_cuts import) | shop(시험 중), N100 채택(10-15, 글자 검출부만 ~/volcano-runs/tools/own_text.py 로 이식, own_check 경고, 편당 +30~56초) | **채택(공용)** |
| rinbox_edges.py | C 린박스 | scripts/rinbox_edges.py | 흑백·저대비 컷 경계 재검사(10-15 ls18·ls23 잡음). 렌더 전 단독 검사로도 씀(편집표만으로 앞뒤 경계 확인) | ja, ko_longshort | 보조 검사로 rinbox_screen 에 흡수됨 | 채택 |
| rinbox_names.py | C 린박스 | scripts/rinbox_names.py | 이름 관문(배역표·asr_fixes 와 자막·설명 대조, 승인이 부름) | ja | ko_longshort, politics_short(인물명) | 제안 |
| rinbox_reuse.py | C 린박스 | scripts/rinbox_reuse.py | 재사용 관문(전사 12-gram 으로 이미 쓴 대사 구간 막음) | ja | ko_longshort, fantube | 제안 |
| rinbox_faces.py | C 린박스 | scripts/rinbox_faces.py | YuNet 얼굴 추적 카메라(샷별 cx, 화자=입 움직임) | ja, 명화관 shot_focus(import) | politics_short(자막 x 좌표). N100 은 동물 소재라 제외(10-15 판단) | 제안 |
| rinbox_flashfix.py | C 린박스 | scripts/rinbox_flashfix.py | 깜빡임 자리 도우미(경계·걸친 낱말·dB) | ja | ko_longshort | 제안 |
| rinbox_transcribe.py | C 린박스 | scripts/rinbox_transcribe.py | Speechmatics 전사(낱말 시각) | ja, ko_longshort | 전 레인 | 채택 |
| strobe_check.py | C 린박스 | D:/volcano-runs/_preset_trials/strobe_check.py (시험 폴더) | TTS 결제 전 스트로브(깜빡임) 검사 | ja | B(무대 편 광과민 검사로 나중에)·정치(무료 TTS 라 불필요) | 보류 |
| snap_captions.py | C 린박스 | D:/volcano-runs/_preset_trials/snap_captions.py (시험 폴더, scripts/ 에 없음) | 자막을 전사 토큰 경계에 맞춤(손으로 끊으면 반려) | ja | A·정치 보류(각자 분절기가 토큰 경계) | 제안 |
| 이름표·깜빡임 도우미(rinbox-machine-gates) | C 린박스 | scripts/ (메모리 rinbox-machine-gates) | 승인이 FAIL 을 막는 기계 관문 묶음 | ja | — | 채택 |
| burned-subtitle 검사(.venv-vision) | C/쇼핑 | D:/midform/.venv-vision | 박힌 자막 구조 검사(밝기 말고 구조) | ja, shop | ko_longshort(박힌 예능 자막 소스) | 제안 |
| ocr_lama_erase.py | 쇼핑 | scripts/ocr_lama_erase.py | 박힌 자막 LaMa 지우기(원본). crop 복사본 `_night_tools/ocr_lama_erase_crop.py` 는 화질 비교 전까지 안 씀 | shop, ko_longshort(--grow 60, 10-15 Mike Okay 영어 자막 207초에 2시간). ★구간·영역 옵션 없음(옵션: --fps 6 · --grow 60 · --engine lama|propainter · --max-len) — 자막 구간만 ffmpeg 로 잘라 지우고 원본과 concat, 제품 글자·옷 글자가 있는 컷은 지우기에 넣지 말 것(쇼핑·A 10-15 합의, A 는 seg_mix 로 원본 컷 되돌림). 개선 후보: --range/--roi 옵션 | fantube | 채택 · **중복(crop 판) 보류** |
| 화면 검사 두 단계 렌더(--no-finish/--finish-only) | N100 | volcano-runs/tools/own_render.py | 시트 판독 뒤 마무리만 다시 | N100 | — | 채택 |
| 쇼츠 분절 card_times 검사 | 정치 | politics-hour/shorts/ | 자막 칸이 토큰 경계인지 검사 | politics_short | — | 채택 |
| factcheck 폴더 규칙 | 정치 | politics-hour/episodes/<날짜>/factcheck/script_N.md | gpt-ask 결과 원문 저장, 개수 = 장부 gpt_calls | politics_long | 전 레인(GPT 결과 보관 규칙) | 채택 |
| ff_sheet.py | 쇼핑 | scripts/ff_sheet.py | ff_render 용 «실제로 나갈 모습» 샷 시트(잘라 확대 후) | shop | — | 채택 |
| GPT 사실 확인 틀 | 관리자 | docs/gpt-ask-samples/factcheck-prompt-template.md | 원고 주장 10개 출처 판정 + 주장/사실 구분 | politics_long | fantube(화제 확인), shop(제품 원리) | 채택(정치) · 제안 |

## 3. 발행·운영·측정

| 도구 | 만든 세션 | 경로 | 하는 일 | 쓰는 레인 | 옮길 후보 레인 | 상태 |
|---|---|---|---|---|---|---|
| rinbox-publish.js (+장부 자동 기록 10-15) | C 린박스 | scripts/rinbox-publish.js | 승인→예약 업로드→장부 | ja, ko_longshort | fantube(yt-upload.js 직접), politics, shop(각자 업로드) — 통일 검토 | 채택 |
| rinbox-social.js / rinbox-web | C 린박스 | scripts/ | 인스타·페북 Blotato, 네이버 클립·페북 프로필 예약 | ja, ko_longshort, shop(별도) | — | 채택 |
| rinbox-coverage.js | C 린박스 | scripts/rinbox-coverage.js | 슬롯·플랫폼별 예약 빈칸 점검(권리자 플랫폼 차단 반영) | ja, ko_longshort | — | 채택 |
| rinbox-web.js / rinbox-webpackage.js | C 린박스 | scripts/ | 네이버 클립·페북 프로필 예약(1회성 작업 생성) | ja, ko_longshort | — | 채택 |
| yt-low-views.js | C 린박스 | scripts/yt-low-views.js | 공개 24h 뒤 100 미만 비공개 | ja, ko_longshort, fantube(유예) | N100 은 자체 private-low.js(중복, PC 다름) | 채택 |
| trend_scout.py | B 팬튜브 | D:/midform/fantube/trend_scout.py | 엔믹스 전용 래퍼 — 검색 본체는 A 의 longform_competition.search(innertube)를 import, 시간당 조회수 정렬 추가 | fantube | 다른 레인은 원 함수 scripts/longform_competition.py 를 직접 쓴다(A 10-15 판단, N100 도 동일 권고) | 채택(B) |
| longform_scout / longform_competition | A 롱투숏(명화관에서 승계) | scripts/ | 롱폼 발굴·경쟁 강도(API 0원) | ko_longshort | fantube, N100 | 제안 |
| gpt-ask.js | 관리자 | scripts/gpt-ask.js | GPT Pro(Codex) 공용 창구: 조사·사실 확인·이미지, 토큰·한도 기록 | 전 레인 | N100(로그인 대기) | 채택 |
| resource-sample.ps1 | 관리자 | scripts/resource-sample.ps1 | 5분 자원 샘플(CPU·RAM·GPU·프로세스) | 메인 PC | N100(10-15 복제함) | 채택 |
| manager-report.js | 관리자 | scripts/manager-report.js | 일일 성과 보고서 | 관리자 | — | 채택 |
| production_ledger | 관리자 | server/data/production_ledger.jsonl | 편당 제작 시간 장부(규격 docs/production-ledger.md) | 전 레인 | N100(JSON 메시지로 대체) | 채택 |
| shop-produce-guard.js + shop-produce-prompt.md + tasks/shop-produce.cmd | 쇼핑 | scripts/ | 밤 무인 생산(재고 목표 4·하루 2편·잠금·낡은 잠금 정리) + 헤드리스 claude -p 지시문 | shop | fantube·N100(무인 밤 생산 틀) | 제안 |
| shop_schedule.js + shop_fanout.js | 쇼핑 | scripts/ | 재고→유튜브 08·18 예약 + Blotato·Zernio·네이버 동시, 장부 자동 기록 | shop | — | 채택 |
| social_grab.py | 쇼핑 | scripts/social_grab.py | 더우인·콰이쇼우·샤오홍슈·틱톡 영상 받아 H.264 + 출처 json | shop | fantube·N100·ko_longshort(해외 소스) | 제안 |
| shop_social_plan.py | 쇼핑 | scripts/ | 유튜브 판 plan → 인스타·소셜 판(끝 CTA 분기) | shop | — | 채택 |
| coupang_search.js / coupang_api.js | 쇼핑 | scripts/ | 쿠팡 검색(로켓·리뷰)·파트너스 딥링크 | shop | N100(제품 소재면) | 제안 |
| inpock_add.js / inpock_dm*.js | 쇼핑 | scripts/ | 인포크 상품 블록 추가 / 댓글 키워드→DM(발송 0건) | shop | N100 | 채택 |
| shop_ref_discover.js / shop_ref_remake.js | 쇼핑 | scripts/ | 인스타 쇼핑 레퍼런스 계정 발굴 → 터진 릴스 «다시 만들 후보» 표 | shop | fantube(레퍼런스 발굴 틀) | 제안 |
| angle.js (+angle-snapshot) | N100 | volcano-channel/scripts/angle.js | 카테고리 각도 48h 중앙값 보고, 검색 API 키 여러 개 429 자동 전환 | N100 | 카테고리 조사 레인 | 제안 |
| yt-search.js | N100 | volcano-channel/scripts/ops/yt-search.js | innertube 쇼츠 검색(검색 API 할당량 0). A 의 longform_competition.search 규격을 node 로 다시 쓴 것 — 원본 A, N100 재작성본. 관련도순, 게시 시각·길이 없음 | N100 | — | 채택(10-15 시험 «로봇» 23건·429 없음) |
| reddit-scout.js | N100 | volcano-channel/scripts/reddit-scout.js | 레딧 RSS 소재 정찰(길이·음량·해상도 거름) | N100 | 소재 찾는 숏폼 레인 | 제안 |
| channel-guard.js | N100 | volcano-channel/scripts/channel-guard.js | 헤드리스 제작 회차를 시간·채널 슬롯으로 배정·잠금·환불 | N100 | 무인 생산 레인(쇼핑 guard 와 통일 검토) | 제안 |
| social-fanout.js / social-captions.js | N100 | volcano-channel/scripts/ | Blotato 소셜 확산(유튜브 시각 동시·계정별 끔) | N100 | — (메인은 rinbox-social) | 중복(PC 다름) |
| connect-upload.js | N100 | volcano-channel/scripts/ops/connect-upload.js | 새 OAuth 프로젝트로 업로드 프로필 추가(이미 쓰는 프로젝트 거부) | N100 | 할당량 늘릴 때 | 제안 |
| daily-report.js | N100 | volcano-channel/scripts/ops/daily-report.js | 하루 편수·부하·회복 판정 JSON → 관리자 | N100 | — | 채택 |
| volcano-watch.py | C 린박스 | scripts/volcano-watch.py | 매일 볼케이노 실행기 새 판 받아 diff·관심분야 표시 | 관리자가 매일 읽음 | — | 채택 |
| ledger.js | B 팬튜브 | D:/midform/fantube/ledger.js | 업로드 직후 장부 한 줄(spec.started_at·out.mp4 시각) | fantube | 정치·쇼핑(각자 업로드하는 레인) | 채택 |
| ls_tools/ledger.js | A 롱투숏 | D:/volcano-runs/ls_tools/ledger.js | 장부 백필용. rinbox-publish 가 대신 쓰므로 | — | — | 폐기 후보 |
| shop_metrics.js / 대시보드 | 쇼핑 | scripts/shop_metrics.js | 쇼핑 편 성과·네이버 조회 수집 | shop | manager-report 가 대체 가능 | 채택 |

## 4. 볼케이노에서 온 후보 (volcano-watch)

| 날짜 | 바뀐 파일 | 관심 분야 | 검토 담당 | 결론 |
|---|---|---|---|---|
| 2026-10-08 | 샷별 확대 창(crop [w,h] + cx·cy) | 카메라·구도 | C 린박스 | rinbox_render cx 로 반영(채택) |
| 2026-10-15 | volcano_run.py 글꼴 gzip·그림체 검사 안내·사용자 소재 파생본 | 렌더 | C 린박스 | 안 옮김(설치 글꼴 사용 / 이미지 생성 채널 전용) |
| 2026-10-15 | longform_engine estimated_duration(0.1141초/자+0.53초/블록 ±7%) | 음성 | C 린박스 | 참고만 — Typecast 로 긴 해설을 사는 레인이 생기면 |
| 2026-10-15 | longform_engine 로그 꼬리 · longform_audio 무음 판정 · longform_state digest | 검사, 음성 | C 린박스 | 안 옮김(볼케이노 롱폼 TTS 전용 / 우리 규모 불필요) |
| 2026-10-15 | longform_state 윈도우 JSON 읽기 재시도(EACCES·winerror 5/32/33, 0.05~0.8초 5회) | 상태 파일 | C 린박스 | **옮길 만함** — 여러 세션이 같이 쓰는 rinbox_publish_state·approvals·장부. 사고 나면 rinbox-publish readJson 에 붙임 |

## 4-1. 채택 결정 기록

| 날짜 | 도구 | 레인 | 결정 | 이유 |
|---|---|---|---|---|
| 10-15 | render_queue.sh | 정치 쇼츠 | 채택 | 낮 쇼츠 렌더 lock 대기 |
| 10-15 | rinbox_screen.py | 쇼핑 | 시험 | 남은 이모지·박힌 자막을 기계가 못 잡음, ff_render 출력 맞춤 뒤 밤 지시문 |
| 10-15 | rinbox_screen.py | B 팬튜브 | 이미 채택 | pieces.json → screen.txt, shot_cuts import |
| 10-15 | trend_scout.py | A 롱투숏 | 보류 | 엔믹스 전용 래퍼, 원 함수 longform_competition.search 를 이미 씀 |
| 10-15 | briefing 말풍선 | A | 보류 | 원음 대화 그대로, 필요한 편 생기면 |
| 10-15 | snap_captions | A·정치 | 보류 | 각자 분절기가 토큰 경계 |
| 10-15 | strobe_check | B·정치 | 보류 | B 는 결제 없음(무대 편 광과민용 나중), 정치는 무료 TTS |
| 10-15 | autocap | B | 보류 | 원본 자막 문구라 토큰 분할과 안 맞음 |
| 10-15 | subject_pos | 쇼핑 | 보류 | clean·deco A/B 끝(1~2주) 뒤 |
| 10-15 | longshort_bed | 쇼핑 | 보류 | 더우인 현장음에 중국어·음악, BGM 이미 깖 |
| 10-15 | rinbox_edges 방식 경계 검사 | N100 | 시험 뒤 보류 | 통과한 편(ott164·167·168)에서도 편마다 2~3개 헛경보. 진짜 원인은 own_check(scene 0.30) 경계가 엔진 source_shots 와 안 맞는 것(편마다 1~19개 차이) → own_check 가 엔진 source_shots 를 직접 읽는 개선안 제안(소유주 결정 대기) |
| 10-15 | longform_competition·rinbox_faces | N100 | 요청 | 저장소 푸시 대기(미커밋 파일) |

## 5. 세션별 스킬(.claude/skills)

| 스킬 | 어디 | 내용 | 다른 세션 참고 |
|---|---|---|---|
| source-scout | 저장소 .claude/skills | 소스 채널 정찰→조사 큐→카탈로그 등록 | A(새 크리에이터), B(화제), N100 |
| rinbox-standard-recipe (메모리) | 공용 메모리 | 화면검사→모았캐치→ASR→편집표→카메라→눈검사 | A, 정치 쇼츠 |
| draft-verify · rebuild-loop · run-diagnose · run-source · script-review | 저장소 .claude/skills | 옛 midform 영화 파이프라인용 | (명화관 중단으로 휴면) |

## 6. 전자책 규칙에서 나온 도구 후보 (10-15, 근거 docs/ebook-rules-20261015.md)

소유주가 공유한 유료 전자책 9권에서 뽑은 규칙 중 기계로 만들 수 있는 것. 상태는 전부 «제안». 구현 후보 세션이 받아 만들면 1~3장으로 옮긴다.

| 도구 | 소유 | 경로 | 하는 일 | 쓰는 레인 | 후보 레인 | 상태 |
|---|---|---|---|---|---|---|
| dup-check | 도구개발 | scripts/dup-check.js (+ midform/config/own_channels.json, tests/dupCheck.test.js) | 10-15 구현. 제목 후보·키워드 → yt-search.js 쇼츠(관련도순 상위 30) → «남의 채널 · 10만+ · 제목 2-gram 겹침 0.5+»면 WARN(종료 코드 4), 우리 편은 «자기 잠식» 상위10 수로 따로. --lane ko|ja · --threshold · --log(기본 server/data/dup_check_log.jsonl, 쇼핑 _gate_log 형식). 장면 동일 판정은 사람 — 작품명 키워드와 제목 후보를 같이 넣어라 | — | ja(C), ko_longshort, shop, N100 | 참고용으로 격하(10-15 밤 소유주, 도구 세션에 직접: «숏폼은 제목·해시태그로는 안 된다, 이미지 검색 아니면». 게이트 아님, 코드는 유지, 정리는 소유주 결정) |
| tag-share | 도구개발 | scripts/tag-share.js (+ tests/tagShare.test.js) | 10-15 구현. 검색 결과의 양산 꼬리표(#worker #process 등, --tags로 변경) 비율·한국어 제목+꼬리표 비율·조회 점유·꼬리표 채널 수·꼬리표 편/나머지 중앙값·3채널+ 공통 영어 꼬리표 쌍. 문턱 없음(숫자만), --from으로 기존 yt-search --json 결과 재집계(네트워크 0). 실측 10-15 «대장간 장인» 51편 중 16편(31%)을 16채널이 한 편씩 → 양산망 신호 | — | 발굴, N100 | 채택(발굴, 10-15 카드 3)에 기본 항목) |
| rinbox_caps.py (← C autocap·checkcap) | 도구개발 | scripts/rinbox_caps.py (+ tests 5건) | 10-16 이식(12c1c64). draft <transcript.json> <in> <out> [--lang ja] = 구간 전사 토큰으로 자막 칸 초안; check <plan.json>... = 렌더 전 토큰 대조(불일치·글자 수 초과 → 종료 코드 4, 남은 토큰은 참고). card_times·CAP_MAX(ja 11·ko 12)·JOIN은 rinbox_render import(복제 없음). C 원본 대비: 한도 11 고정→CAP_MAX, 불일치는 클립당 첫 건만. rinbox100~122ja 23편 결과 C와 동일. 명화관 card_times는 규칙이 달라 미지원 | — | ja(C) 사용, ko_longshort 후보 | 채택(C, 스크래치 원본 대체) |
| shorts_safe.py | 도구개발 | scripts/shorts_safe.py (+ tests 12건) | 10-16 구현(N100 요청, 소유주 지시). 렌더된 ASS 글자 상자를 쇼츠 UI 안전 영역(아래 UI·오른쪽 버튼 열·위 UI·좌우 여백)과 맞댐, 하나라도 걸리면 FAIL(종료 코드 4), qc/shorts_safe.jpg 미리보기, check_template으로 템플릿 정의 검사. 발단: N100 템플릿 made y=1745·home 1790·zou 1600 자막이 UI에 가림. 정치 옛 쇼츠 s1_kkori 11줄 중 5줄 걸림. 4fa7caa: 글자 폭을 글꼴 파일(assets/fonts·시스템·--fonts-dir)로 libass 줄 높이 기준 실측(못 찾으면 «폭 어림»), 템플릿 "grade":"decor"/--decor-style → WARN, --tpl 틀 글자 상자({name,box}) 판정 | — | N100(own_render·own_check에 부착), 린박스·롱투숏·팬튜브·정치 쇼츠 후보 | 채택(N100·정치·C — C는 --fonts-dir assets/fonts/rinbox --decor-style CR) · A 참고(틀 변경 시) |
| jidaigeki_watch.py | 도구개발 | scripts/jidaigeki_watch.py + midform/config/jidaigeki_watch.json (+ tests 7건) | 10-16 구현(bda95b6). 時代劇 공식 채널(松竹シネマPLUSシアター·東映時代劇YouTube) 업로드 목록·videos.list(발굴용 키, 회당 몇 단위)로 새 본편·配信期間(제목·설명란 파싱)·한국 가시성(regionRestriction) 감시, 알림만(영상 안 받음). 기준선 10-16: 본편 228 중 한국 가시 75, 激闘編 30 기간 경과, 柳生 11話 10-27까지, 必殺 맛보기 6 기한 없음, 東映 가시 30. 도구 세션 CronCreate 수·토 21:33(7일마다 재등록; 상시화는 작업 스케줄러 안) | — | C, 발굴 | 채택(C·발굴 알림 수신) |
| thread_report.js | 도구개발 | scripts/thread_report.js (+ tests 3건) → manager-report.js 6장이 import | 10-16 구현(0271bf3). 레인별 결 탐지: production_ledger + 채널 토큰 videos.list(검색 없음, 429·403 멈춤), 공개 72h 경과분만, 레인 중앙값 3배 넘은 편의 공통 속성(작품·출연·제목 길이·시각). 첫 실측 ja 55편 중앙값 2,102 → 近衛十四郎 11편 중 10편 3배 초과(91%), 暴れん坊将軍 6/8, 제목 ≤12자 75%. 한계: 출연 이름을 설명란에서 뽑아 원작자 오탐, 쇼핑은 장부 youtube_id 쌓여야. docs/reports/<날짜>-threads.md | — | 관리자(07:40 보고), C, A, 쇼핑 | 채택(관리자) — 3ae4169: N100 레인 n100_* 포함(조회는 발굴용 키 videos.list, 쓸모연구소 제외) |
| silence_gap.py + title_lint.py | 도구개발 | scripts/silence_gap.py, scripts/title_lint.py (+ tests 4건) | 10-16 구현(a1727b1). silence_gap = −40dBFS 이하 0.35초+ 무음 갭 FAIL(종료 4), 앞뒤 0.5초·--allow a-b/end:N/start:N 제외. title_lint = « | » 하나·앞뒤 공백·25~35자(40 초과 반려)·금지어(ko·ja 소형 사전, N100 own_policy 사전 합치기 대기)·숫자 유무, lang 옵션, --lane politics_ja(7ecdf51: 16~30자·감정·조롱어 FAIL). 회귀: 정치 10/15·10/16 롱폼 둘 다 FAIL(갭 14%·0.8~1.5초 169개, 제목 75~77자) → 정치 판단 대기 | — | 정치 ko·JA, 롱폼 전반 | 시험(정치 회신 대기) |
| ja_politics_script_check.py | 도구개발 | scripts/ja_politics_script_check.py (+ tests 6건) | 10-16 구현(6a23a39). ja 정치 원고 검사 — 명예훼손 D1~D7·F1, 소재 정책(官邸 PDL 주력·衆参 중계 인용 한 구간 ≤20초), 편 비율(소유주 60:40 → 해설 ≥40%·20~40분; --shorts 해설 ≥85%·원음 ≤15초·60~75초, 7ecdf51), q_pair 없으면 WARN. 쇼츠 원칙(a04923e): shorts_from이 롱폼 인용 구간 밖이면 FAIL, 끝 롱폼 유도 없으면 WARN. 회의록 미등재 시 D3는 WARN. 틀 midform/config/ja_politics_script_frames.json과 짝 | 정치JA(샘플 1편부터) | 정치 ko(요소가 다르면 ko 판 분기) | 시험 — 정치JA 첫 3편 통과 뒤 채택 |
| tools-commit.js | 도구개발 | scripts/tools-commit.js (+ tests/toolsCommit.test.js) | 10-16 구현(479155e). 커밋 래퍼 — check:encoding → --test 명령들 차례로 실행, 출력 안 거르고 종료 코드만 봄, 하나라도 0 아니면 커밋 안 하고 그 코드로 종료. 통과 시 git add -- <경로> → commit -F -- <경로>, --push 선택. 실패 테스트 단 채 커밋(61dfa18·275fd89) 재발 방지 장치 | 도구개발(의무) | 모든 세션(테스트 있는 커밋에 권장) | 채택 도구개발 |
| n100-ledger-intake.js | 관리자 | scripts/n100-ledger-intake.js | 10-16 구현. N100 하루 성과 JSON(server/data/n100_daily/YYYY-MM-DD.json) → production_ledger.jsonl 행 추가(lane n100_<키>, session N100, 같은 lane/id 건너뜀). N100은 midform이 없어 JSON을 메시지로 보내고 관리자가 저장·실행 | 관리자(N100 집계) | — | 채택 관리자 |
| yt_tags.js | 정치 ko | politics-hour/yt_tags.js | 10-16 구현(9f685ff). 업로드 뒤 upload.json의 tags를 videos.update로 넣고 API로 다시 읽어 확인. yt-upload.js가 태그를 안 넣어 10/16 롱폼이 태그 0개로 나간 사고의 재발 방지 | 정치 ko(업로드 직후 고정 단계) | 정치JA · 쇼핑 · 롱투숏 · 팬튜브(yt-upload.js 쓰는 레인 전부 — 태그 누락 점검용) | **채택(10-16 밤 전 레인 게이트)** — 구현 6종(+ B fantube/publish.js·yt_tags.js b2b4c77; 관리자 보고 §7이 --list로 매일 감사): 정치 ko yt_tags.js --gate(8c8efc9) · 쇼핑 scripts/shop_yt_tags.js --audit(전 레인용 감사) · A ls_tools/publish_ko.sh+yt_tags_ko.js · C rinbox-publish.js 내장(d2f4398) · N100 volcano-upload.js 내장. 10-16 전수: 쟁점브리핑 롱폼 1+쇼츠 2, 쇼핑 13편·팬튜브 7편이 0개였음(총 23편). 함정: 갓 올린 영상은 snippet 수정 403·30초+ 0개로 읽힘 → 20초 간격 재시도·2~3분 재확인 뒤 판정 |
| gap_check.py | 정치 ko | politics-hour/gap_check.py | 10-16 구현(9f685ff). 렌더 직후 무음 갭 검사 — silence_gap.py를 호출해 인용·첫머리·조각 경계는 빼고 해설 무음 0.65초 초과면 FAIL. 10/16편 FAIL 120개 적중(Supertonic 문장 앞뒤 0.5초 무음+0.3초 쉼이 원인 → supertonic_worker 앞뒤 무음 자르기·gap 0.4로 0.44~0.48초) | 정치 ko | 정치JA(같은 Supertonic worker) | 시험 |
| source_blocklist.json + 설명란 확인 단계 | 정치 ko | politics-hour/source_blocklist.json (BRIEF «받기 전 설명란 확인») | 10-16 신설. 소재 받기 전에 채널 설명란의 권리 문구를 보고, «출처를 밝혀도 재가공·재배포 불허» 류 채널을 ID·확인 날짜·문구로 쌓아 다음 편에서 자동 제외. 10/15~17 소재 78개 전수에서 시사포커스TV 1곳 적발. 상투 «무단 전재·재배포 금지»는 인용과 별개로 보고 안 넣음(소유주 기준 결정 대기 §5 11번) | 정치 ko | 롱투숏 · 팬튜브 · 정치JA · 발굴(소재 카드에 권리 문구 열) — 남의 영상을 인용하는 레인 전부 권장 | 시험 |
| arabshot_kit.py | 도구개발 | scripts/arabshot_kit.py, kits/arabshot/<레인>/ (+ tests 4건) | 10-16 구현(f7eacb5). 어랍숏 새 카테고리 투입 키트 생성·형식 검사(check|build <kit.json>) — script-frames 레인 블록·지침서 md·TPL 한 줄(check_template)·channels.json 항목 + BGM license·설명란 예·고정 규칙 체크리스트. 첫 키트 ko_factory(제조 공정, 도구의쓸모 교체 1순위; P1 위험 행위·제조사 공식 영상 금지). N100 실제 샘플(ko_mon) 통과를 회귀로. 벤치 대본 실측 칸은 ref_analyze 뒤 | N100(회복 판정 뒤 연결) | 다른 포맷 키트의 본보기 | 시험 — N100 연결 뒤 채택 |
| thread-report | (제안) 관리자 | manager-report.js 확장 | 결 탐지 주간 리포트: 날짜순 조회수, 중앙값 3배 튀는 편의 공통 속성, 다음 주 큐 비중 | — | 전 레인 | 제안 |
| emotion-label | (제안) 쇼핑 | gpt-ask 라벨링 | 감정/정보 라벨 게이트: 비중 40~55%, 첫·예고·끝 문장 감정, 화면 묘사 그대로 ≤30%, 탈요약 수치(인용 ≤30%·형용사 ≤20%·문장 ≤45자·의견 1·질문 1) | — | shop, N100, ko_longshort(해설), politics_short | 제안 |
| kill-shot | (제안) A | 비전 지도 점수 + cuts | 첫 0~3초 컷이 상위 10% 자극 장면인지, 내레이션보다 먼저인지 | — | ko_longshort, N100, shop | 제안 |
| guide-6 | (제안) N100 own_check 확장 | rinbox_screen 틀 + 텍스트 사전 | 가이드 6항목(아이·노출·성적·욕설·피·폭력) 사전 검사, 애매하면 FAIL, 회복 시험 채널 소급 | — | N100(1순위), ko_longshort, politics | 제안 |
| ledger-hourly | (제안) 관리자 | production_ledger + manager-report | 레인별 시급(제작시간×조회×RPM 계수)·원가 8% 표시, 시급 5만 미만 2주면 경고 | — | 전 레인 | 제안 |
| source-floor | (제안) A | longform_scout·longform_competition | 롱→숏 소스 하한 10만+·30일, 소스 채널 조회/영상 수 등급, 라이징 채널(구독 ≤1만·일 100만·1개월), 복제형 채널명 비율 40% | — | ko_longshort, fantube, N100 | 제안 |
| ref-9dim | (제안) A | longform_competition 확장 | 레퍼런스 9차원(문장 길이·종결어미·후킹까지 문장 수·엔딩 유형·제목 글자수/숫자/느낌표·평균 컷 길이·킬샷 위치)을 상·하위 조회수군으로 | — | 전 레인 지침서 | 제안 |
| timecode-guard | (제안) 각 렌더러 | cuts + ffprobe | 편집표 행 3요소(소스 ID·ms·내용) 결측·소스 길이 초과 컷 폐기 | — | 전 레인 | 제안 |
| silence-gap | (제안) 정치 | ffmpeg silencedetect | 본문 중 −40 dBFS 이하 0.35초 이상 연속이면 FAIL | — | politics, shop, N100 | 제안 |
| title-lint | (제안) 정치 | 문자열 검사 | 롱폼 제목 `좌측 후킹 \| 우측 정리`, 공백 포함 25~35자, 40자 초과 반려 | — | politics_long | 제안 |
| trend-kr | (제안) 정치 또는 B | 구글 트렌드 KR RSS | 당일 논란 토픽 수집 → 정치/아이돌 분류, 24h 만료 | — | politics, fantube(18시) | 제안 |
| comment-pairs | (제안) B | vidiq_video_comments / API | 댓글에서 인물 쌍·반복 구절 → 다음 편 큐·지침서 반복 구절 | — | fantube, N100 | 제안 |
| appeal-template | (제안) 관리자 | docs/appeal-template.md | 수익 정지(재사용·독창성) 항소문 5요소 | — | 전 레인 | 제안 |
| desc-template | (제안) N100·쇼핑 | 원고·장면 | 설명란 200자 요약 → 리포트형 → «교육적 목적» → 영어 태그 5개 | — | N100, shop | 제안 |
| exp-quota | (제안) 관리자 | 장부 structure 필드 | 2군 시험 슬롯(주 1편)·새 구조 실험 쿼터(8편 중 2편) 카운터 | — | 전 레인 | 제안 |
