# midform 파이프라인 레퍼런스 — 단계·게이트의 역할과 실측 상태

> 소유주 요청(2026-09-07): "소스 분석 보내는 단계부터, 게이트·단계 이름만 말고 하는 역할까지".
> 실측 사고는 2026-09-05~07 사흘의 실제 기록에서 가져왔다. 위치: 컷 하나가 지나가는 순서 그대로.

---

## A. 소스 분석 (compress run 생성 — `midform/test_runs/compress_*`)

### A1. 인게스트 (다운로드·전사)
- **역할**: yt-dlp로 `source.mp4`를 받고, 유튜브 자막(vtt)을 `transcript_timed.json` 큐 목록으로 정규화한다. 자막이 없으면 STT 폴백(`stt_transcribe.py`, Groq whisper-large-v3).
- **출력**: `source.mp4`, `transcript_timed.json`(큐: start/end/text), `stt_transcript_raw.json`
- **왜 중요**: 이 큐 좌표가 **대사 창의 1차 진실**이 된다. 이후 모든 대사 클립이 여기서 파생.
- **실측 사고**: 자동자막은 큐를 발화보다 수십 초 길게 스미어함(도쿄 드리프트: 128큐 중 17개가 8초 초과, "[Music]" 21초 큐 / 소림: "기관총" 대사 큐 90→108.5초 — 실발화는 100.7초, **자막이 10초 일찍 뜨는 싱크 결함**의 뿌리). → **정화 전처리(스미어 큐 Groq 단어 리타임)가 다음 과제.**

### A2. 기계 측정 (무LLM)
- **역할**: ffmpeg 장면 전환 감지(`<source>.mp4.shot_boundaries.json`, 임계 0.30) — b-roll 스냅·비전 샘플링 공용. 오디오 에너지 프로파일(`energy_profile.json`) — 액션 피크 좌표. 엔드카드 감지(`detect_visual_endcard.py`) — usable_end 클램프. 화면 자막 감지(`detect_burned_subtitles.py`) — 원본에 박힌 남의 자막·저작권 라인·워터마크의 상하좌우 크롭 비율 산출.
- **실측**: 안정적. 크롭은 **B6 드래프트 조립**에서 소비됨(디렉터 상하 12.96% 등).

### A3. 비전 지도 (`vision_scene_map.json`)
- **역할**: `plan_scene_samples.py`(컷 대표 프레임+3~5초 보충의 합집합) → `build_contact_sheets.py`(타임코드 박은 5×4 컨택트 시트) → 멀티모달 모델이 셀마다 `visible_action` 한 문장 판독. **파이프라인 전체의 "눈"** — 작가(A6)와 기계 눈(B3)이 모두 이 지도로 화면을 본다. ※공통 원인 실패 위험: 지도의 오류를 작가가 쓰고 같은 지도를 보는 검수기가 통과시킬 수 있다 → 검수기는 앵커 전후 실제 프레임을 원본에서 새로 추출해 독립 판정해야 함(P1 과제).
- **한계(실측)**: 서술이 "~가 서 있다/바라보고 있다" 수준의 정지 사실 — 사건·인과·감정이 없다. 이 빈약한 시력이 하류 전부의 상한선. compress run당 1회 생성이라 재구축해도 갱신 안 됨(이름 환각이 박히면 계속 삶).
- **금지 형태**(소유주 확립): 긴 이미지 1장 ❌, 낱장 프레임 수백 장 ❌ — 시트+타임스탬프 STT가 표준.

### A4. 비트 추출 (`narrative_beats.json`)
- **역할**: LLM이 전사+지도에서 이야기 비트(B01…)를 뽑는다 — 각 비트의 구간, 요약, **key_dialogue/anchor_dialogue**(살릴 명대사의 좌표). 플랜의 원료.
- **실측**: 비트 해상도가 굵으면(도쿄 B01=52초) 플랜 창도 굵어진다. 앵커 대사가 자동자막에서 여러 큐로 쪼개지면 deadlock — `mergeAnchorCuesInTranscript`가 자동 병합.

### A5. 플랜 (`edit_plan.json`)
- **역할**: LLM이 비트를 슬롯 타임라인으로 컴파일 — 슬롯마다 `decision`(KEEP_DIALOGUE=원음 대사 재생 / NARRATE=해설 b-roll / DROP), 창(start/end), `visual_source_mode`(source_window·source_broll·**source_audio_teaser/action**=원음 훅), 콜드오픈/콜백 배선, 대사별 `dialogue_line_windows`(**대사 클립 시각의 유일한 진실** — cue·dialogue_unit·bootstrap_transcript를 고쳐도 소용없음, 실측 3연속 헛발질).
- **실측 사고(구조)**: **플래너가 게이트 예산을 모른다** — 콜백 35s·첫대사 30s·대사연속 10s를 계획 단계에서 안 지켜 "다 만들고 게이트에서 폐기"가 반복(top-gun 58s, furiosa 61s 무해설 오프닝, wolf 68s). 대사 예산도 극단(도쿄: KEEP 2/NARRATE 14 — 디렉터 초판 "대사 3줄" 병의 재생산). → **게이트 예산의 하드 제약화가 다음 과제.**

### A6. fills 작문 (`compression_slot_fills.json` + `.ja.json`) — **텍스트 권위**
- **역할**: LLM(codex/Vertex)이 슬롯마다 나레이션·caption_units(TTS 문장 분할)·대사 자막(`caption_kr_dialogue`, 화자 배열)·업로드 패키지(제목 후보·설명·**overlay_title** 상단 타이틀)를 쓴다. 여기가 **원고의 원본** — 파이프라인 산출물을 고쳐도 재구축 때 여기서 다시 만들어져 덮인다(수술은 반드시 여기에, `authored:true`로 보호).
- **2026-09-07 재설계(장면 우선 작문)**: 종전 프롬프트는 "TRANSCRIPT ONLY — footage 못 봄"이라 선언한 장님 작가 + 그를 단속하는 규칙 수십 줄(슬롭의 뿌리). 이제 ①비전 지도가 작가의 눈으로 선언되고 ②**문장마다 `narration_anchor_secs`(이 문장을 얹을 소스 초)를 출력할 의무** — "문장이 화면을 데려온다". 첫 실전(도쿄): 12슬롯 전부 문장수=앵커수 출력 확인.
- **여전한 함정**: 밀도(레퍼런스 6.5문장/분, 상한 게이트 10) — 생성기는 아직 상한을 모름(게이트가 잡을 뿐). 낡은 overlay_title이 수술 후 갱신 안 되는 문제(소림 "찢어진 장갑" 상시 표시 사고).

### A7. finalize / compress-refresh
- **역할**: 플랜·fills 위에 결정론 패스 — 창 해석, 무성 액션 슬롯 삽입, 겹침 안전망, KEEP 줄 선택 재도출. `compress-refresh <run>`으로 단독 재실행.
- **함정**: refresh는 KEEP 줄 선택과 fills를 **재도출**한다 — 수기 수정은 `authored_lines`(플랜)·`authored`(fills)로만 살아남는다. 창 시각만 옮길 땐 `retime_plan_windows.js`.

---

## B. 재구축 (템플릿 run — `template_runs/auto_template_*`)

### B1. 부트스트랩 어댑터 (`bootstrap_script.json`)
- **역할**: 플랜+fills를 파이프라인 계약(세그먼트 목록)으로 변환. 대사 슬롯→줄별 `dialogue_quote` 세그먼트(utterance 창 그대로), 훅 슬롯→`scene_hook`(원음 재생; **나레이션이 있으면 말도 함** — narratedActionBeat, 09-05 수정), NARRATE 슬롯→recap 세그먼트+b-roll.
- **b-roll 선택**: fills에 앵커가 있으면 **앵커 좌표 그대로 문장별 클립**(09-07 신설 — 어긋남이 태어날 자리 제거). 앵커가 없으면 종전 픽커(`pickNarrationBroll`: 창 안에서 대사 클립 피해 한 덩이) — 문장 의미를 모르는 추론이라 다이어트 수술 후 화면이 통째로 어긋난 원흉(소림 "들것" 밑 선글라스).

### B2. 부트스트랩 프리플라이트 — **FATAL, 계보 폴백 금지** (2026-09-07 구현)
- 프리플라이트 실패 = **즉시 실패**. 구계보 자동 폴백은 코드에서 제거됨. 수동 폴백은 `--allow-lineage-fallback` 명시 옵션뿐이며, 사용 시 summary에 `lineage_fallback_used` 표식이 남아 발행 게이트가 거부한다.
| 체크 | 역할 |
|---|---|
| `dialogue_line_window_ok` | 모든 KEEP 슬롯의 대사 창이 매처 신뢰 상태인가 (수기 창은 플래그 명시 필요) |
| `dialogue_lines_all_captioned` | 대사 줄 수 == 자막 배열 수 (어긋나면 자막 밀림/소실) |
| `capcut_cross_segment_overlap` | 세그먼트 소스 구간 상호 겹침 금지 |
| `cold_open_no_reserved_overlap` | 콜드오픈 티저 예약구간 침범 금지 (pre-roll 0.5~0.7s 감안 0.45s 여유) |
| `coverage_slotmap_eq_script` | 슬롯맵과 스크립트 커버리지 일치 |
| `review_draft_exists` / `review_source_type_present` / `no_slot_map_key` | 리뷰 산출물·계약 형식 무결성 |

### B3. 기계 눈 (`narration_visual_match`) — bootstrap 단계 게이트
- **역할**: 나레이션 문장마다 그 창의 프레임(비전 지도 기반)과 대조 — "화면에 없는 것을 말하는가". 실패 시 `narration_mismatch_report.md`에 전 문장+on_screen 사실 — **일괄 수술 후 재빌드 1회**가 교리(문장당 재빌드는 판정 토큰 낭비).
- **맹점(실측)**: ①문장 단위라 스토리 흐름 못 봄 ②**통과 문장 캐시** — 문장이 같으면 화면이 바뀌어도 재판정 안 함(소림 "들것" 통과 사고) ③추상 문장은 무엇도 안 어겨 통과 ④창 단위 샘플이라 **시간축**(이미 벌어진 일을 "시작됩니다"로 중계) 못 봄. → 캐시 키에 창 포함 예정.
- **suggested_rewrite는 증거지 대체문이 아님** — 그대로 붙이면 나레이션이 자막으로 퇴화.

### B4. 수용 게이트 (`acceptance_gates.json`) — ※실행 시점별 분리 예정(P0-6): 원고·플랜 게이트(TTS 전) / 실제 프레임 검증 / 조립 후 게이트(자막·색·LUFS) / 수출 후 게이트. 현재는 한 덩이로 draft 후 실행되며 `narration_share` 안에 비중·밀도·대사연속·개시선언 린트가 묶여 있음(분리 대상). `narration_broll_semantic_bounds`는 실제론 시간·길이 검사라 temporal_bounds가 정명.
**구성·페이싱**
| 게이트 | 역할 |
|---|---|
| `narration_share` | 해설이 이야기를 끄는가: 비중 하한 50/목표 60/**상한 86**(09-06 신설 — 90%·12문장/분이 통과해 "주저리" 사고), 문장/분 하한 3.5·경고 8·**상한 10**, **대사 연속 ≤10s**, **중계형 개시 선언 금지 린트**("총격이 시작됩니다"는 화면보다 늦게 뜬다 — 09-07 신설). 말하는 scene_hook은 해설로 계산(caption_kind 기준, 09-06 수정) |
| `dramatic_engagement_timing` | 첫 대사까지 나레이션 독주 ≤30s (액션 클립 소스가 여기서 대량 사망) |
| `callback_strength` | 콜드오픈 훅의 페이오프가 실효 35s 안(훅 초는 제외)에 오는가 |
| `first_30_conflict_clarity` | 첫 30초 텍스트가 갈등을 세우는가 |
| `energy_peak_coverage` | 측정된 오디오 피크가 컷에 실렸는가 |
| `plan_continuity` | 소스 점프 평균 크기 (리캡 특성상 경고 잦음) |
| `rebuttal_only_opener` / `high_context_teaser_recovery` | 오프너가 맥락 없는 반박·고맥락 티저로 시작하지 않는가 |
**이야기 판독(LLM, 텍스트만 — 화면 못 봄)**
| 게이트 | 역할 |
|---|---|
| `story_legible` | 영화 안 본 관객이 원고만으로 따라가는가: 미해결 지시어("'이렇게'가 뭔데"), 무설명 등장(대역·타미르), 인과 공백. **판정이 라운드마다 재롤됨** — 같은 문장이 통과↔반려 왕복 실측 |
| `dialogue_pairs_intact` | 문답 짝이 깨지지 않았는가(고아 답변), 나레이션 공백 중 신규 화자 |
| `new_speaker_grounding` | 처음 말하는 인물이 소개됐는가 |
**자막·화자**
| 게이트 | 역할 |
|---|---|
| `subtitle_readability` | 세그먼트당 자막 청크 ≤6 등 판독성 |
| `dialogue_caption_chunk_lateness` | 같은 줄 다음 청크 지연(읽기시간×2+1.5s) |
| `speaker_color_stable` + `dialogue_caption_colors` + `same_speaker_same_color` + `distinct_speakers_not_collapsed` + `rendered_speaker_color_match` + `dialogue_speaker_metadata_present` + `narration_dialogue_color_separation` | 화자↔색 결정론. **색은 `caption_colors.json` 이름 등록이 유일한 진실**(미등록=fallback 해시 충돌 위험) |
**b-roll·경계**
| 게이트 | 역할 |
|---|---|
| `narration_broll_semantic_bounds` | 나레이션 클립이 플랜 창 ±8s·usable_end 안인가, 클립이 문장보다 과하게 긴가(overlong_clip_speedup: 문장+3s 상한) |
| `promo_tail_overrun` / `cut_tail_regression` | 채널 홍보 꼬리 침범·마지막 클립 조각(≥1s) |
**오디오**
| 게이트 | 역할 |
|---|---|
| `narration_dialogue_loudness_delta` | 해설 TTS와 대사 원음의 LUFS 격차 정렬 |

### B5. TTS (ElevenLabs)
- **역할**: caption_units 문장별 mp3. **말하는 scene_hook도 여기서 발화**(무음 placeholder 버그 09-06 수정 — 어셈블·ja 로케일 두 층).
- **운영**: 크레딧 프리플라이트가 야간배치에 있음(고갈 상태로 14소스 태운 09-05 사고 재발 방지). creator 121k/월, PAYG 미활성.

### B6. 드래프트 조립 (`assemble_slot_draft_input.py` → `capcut_draft.py`)
- **역할**: 타임라인 유닛 생성(자막 청크 분할·병합), CapCut draft_content 조립 — 세로 크롭(+화면자막 크롭 상하좌우), **오디오 정책**(대사·무음 훅=원음 100%, 해설·**말하는 훅**=원음 12% 덕킹 — 09-06 "나레이션 하나도 안 들려" 수정), 자막 트랙(화자색·레인), **폭 초과 자막 개별 축소**(한 글자 밀림 방지, 09-07), overlay_title 상시 표시, BGM.
- **ja 로케일**: `compress-regenerate-ja`가 **수술된 ko를 핀**해 ja를 다시 씀(전체 apply는 ko도 덮으니 금지). ja 창은 로케일 시프트 허용. *앵커 승계는 미배선(예정)*.

---

## C. 검수·발행

### C1. 설치·수출
- 설치는 **항상 새 폴더명**(CapCut이 연 폴더를 캐시 — 재사용 금지). 수출은 화면좌표 자동화(`capcut_export_one.py`) — 잠금 해제·CapCut 로그인 필수(로그아웃이면 Pro 페이월이 "export dialog did not open"으로 위장). **실패 빌드 수출 금지 가드**(run_summary status 확인, 09-07 — 실패판을 설치·수출한 사고 후).

### C2. 수출 검증 (auto-publish 안, 업로드 전 — 실패 시 held/로 격리)
| 검증 | 역할 |
|---|---|
| 길이 대조 | ffprobe vs 매니페스트 ±2s — 다른 프로젝트 오수출(실크 사건) 차단 |
| **싱크 감사 게이트** (`audit_sync.py`, 09-07 신설) | 수출 mp4를 Groq STT로 전수: 대사 줄 첫 청크마다 발화 온셋↔자막 시각 ±0.8s, 해설 문장 전수 매칭, **문장별 표시 순간 프레임 시트 자동 생성**(시간축 통독용). fail-closed — 감사가 못 돌아도 업로드 차단. FAIL은 초점 재프로브로 오탐 자가 제거(혼합언어 whisper 함정 3종: 첫 단어 스트레치·한국어 번역-전사·큰 창 절단) |
| 라우드니스 | -14 LUFS 정규화(fail-open) |

### C3. 업로드·확산 — **사람 검수 승인이 예약보다 앞** (2026-09-07 구현)
- 순서: 수출 → 자동 수출 검증(C2) → **사람 검수 승인(`approve-publish.js`, 미승인은 업로드 자체 보류)** → YT 비공개 업로드 → 차단 검사 → 동시 예약. 승인의 build-hash 결속은 P0-2.
- **YouTube**: 비공개+publishAt, 채널별 고정 슬롯 08:00/18:00 KST(리드 45분). 상태 `auto_publish_state.json`(드래프트당 1회 — 중복 방지).
- **소셜 확산**(`blotato-publish.js`): 같은 mp4·같은 publishAt으로 IG/TikTok/Threads/FB(ko), ja 4채널. 과거시각 예약은 +3분 클램프. **유튜브와 반드시 동시**(소유주 확립).

### C4. Content ID 3층 방어
- **층1 (선별)**: 배급사 대장 — `movie_catalog.json` distributor_tier=banned(Lionsgate 계열 등)를 스카우트·큐 재시도에서 제외
- **층2 (정찰)**: 서바이벌 리콘 — 같은 영화의 제3자 클립이 지금 유튜브에 살아있는가
- **층3 (업로드 후, `check-claims.js`)**: 비공개 상태에서 `regionRestriction.blocked` 감지 — 전세계 차단=무조건 중단, 타깃 채널 국가(ko→KR, ja→JP) 차단=중단, 그 외 부분 차단·검사 불능 정책은 미정(P0-5)
- ⚠️ **타이밍 구멍(P0-5)**: 리드 45분 vs 검사 매시간 크론 — 업로드 직후·T-5분 검사 추가 필요. 현재 크론만으로는 공개 전 검사 보장 안 됨
- **역할**: 공개 전 창에서 videos.list의 `regionRestriction.blocked` 감지(전세계/부분 차단). `--unschedule`이면 YT 예약 해제 + **Blotato 예약 동시 취소 시도**(09-06 배선 — 안 되면 리포트에 크게; 09-01 벨라가 소셜에만 나간 사고 후).
- 층1은 배급사 대장(banned=Lionsgate 계열 등 — 스카우트·큐 재시도 모두 적용), 층2는 서바이벌 정찰.

### C5. 사람 검수 (기계가 못 보는 것 — 소유주 확립 절차)
- **원고 전문 통독**(해설+대사 순서대로): 재미·아크·이해 — "상황 설명하느라 재미를 놓치는가". 훅 회수·대사 착지·시임(seam: 장소/시간 점프를 잇는 한 줄 해설이 있는가)·이름-얼굴·결말 5문항.
- **시간축 통독**: 문장별 표시 순간 프레임(싱크 감사가 자동 생성)과 문장을 나란히 — 창 단위가 아니라 **초 단위** 대조. "개시 선언" 류는 여기서만 보였다.
- 나레이션에 **먹거리**(논란 유발 문장) 탑재 여부 — 실명·특정국 없이 시청자·정치·현실을 찌르는 매운맛.

---

## D. 운영 루프
- **야간배치**(00:05, 마감 07:00): TTS 잔량 프리플라이트 → 큐 재시도(TTS 실패분 resume draft, hold·banned 제외) → 스카우트(영화 라운드로빈, "part N"·컴필레이션 후순위/제외) → 소스 2개 성공까지 생산 → 설치 → 발행 → 확산. 실패는 `production_failure_queue.json`(compress 계보 보존 — 재시도 싸게).
- **재구축 루프**: 수술은 compress fills/plan에 authored로 → (플랜 변경 시 refresh) → `run --resume bootstrap --bootstrap-run <핀>` → 게이트 → 필요시 review-resume → draft. 핀 없으면 조용한 구계보 폴백.

## E. 열린 과제 (소유주 재우선순위 2026-09-07)

**P0 — 잘못된 영상 공개 방지**
1. ~~조용한 구계보 폴백 전면 제거~~ ✅ 2026-09-07 구현 (`--allow-lineage-fallback` 명시 옵션만, 표식 남김)
2. 모든 PASS·사람 승인을 build hash에 결속 (`run_manifest.json` 단일 계보 문서: source/plan/fills/tts/draft/export sha)
3. ~~사람 검수를 예약 전 필수 게이트로~~ ✅ 2026-09-07 구현 (`publish_approvals.json` + `approve-publish.js`; hash 결속은 2번에서)
4. YouTube·Blotato를 발행 그룹(publication_group_id) 상태 머신으로 — 부분 실패 보상(PARTIAL_SCHEDULED→재시도/보상취소)
5. 차단 검사 타이밍: 업로드 직후·T-5분 검사 추가, 부분 차단 정책 정의, fail-closed
6. B4 게이트를 실행 시점별 분리 (B3 원고게이트/B4 프레임검증/B7 조립후/C2 수출후), narration_share 복합항목 분해

**P1 — 완성 후 폐기되는 비용 방지**
1. A1 전사 정화(스미어 큐 Groq 리타임) + 원시/정규화 transcript 분리(원시는 불변, 정규화는 원시 참조)
2. A5 플랜 예산 하드 제약(콜백 35s·첫대사 30s·대사연속 10s·대사 하한)
3. 실제 프레임 기반 독립 visual verifier — 검수기는 지도가 아니라 앵커±1s 프레임을 원본에서 새로 추출 (공통 원인 실패 차단)
4. 앵커를 숫자 하나에서 사건 객체로: {center_sec, visual_window, temporal_phase(전/중/후), must_show, must_avoid}
5. visual-match 캐시 키 = 문장+소스ID+창+프레임hash+지도hash+모델·프롬프트 버전
6. story_legible_text(텍스트만 — 프레임 넣으면 시험 목적 소멸) / story_visual_continuity(문장+시간축 프레임) 분리, 판정은 script+prompt+model hash에 고정하고 uncertain은 사람으로

**P2 — 품질·다국어**
1. JA는 의미 앵커 승계 + 클립 길이는 JA 음성 길이로 재배정 (KO 창 복사 금지)
2. 비전 지도 사건·인과 서술 강화 + 강제 재생성 커맨드
3. 최종 원고 hash 변경 시 overlay·제목·설명 업로드 패키지 전체 무효화
4. 자막 최소 축소율·최소 표시시간 게이트
5. 실제 사고 회귀 테스트 세트(스미어/낡은 타이틀/무음 해설/오수출 fingerprint/소셜 단독 발행/캐시 통과)

**진실 계층(용어 정리)**: 원시 증거(영상·VTT·STT words, 불변) → 정규화 증거(정화 transcript) → 편집 시각 권위(edit_plan.dialogue_line_windows) → KO 텍스트 권위(compression_slot_fills) → JA(KO 의미 파생 locale 산출물) → 파생물(bootstrap/TTS/draft/export) → 검증 결과(게이트·감사·검수, 원본 변경 권위 없음). authored:true는 parent hash 결속 필요(부모 창 변경 시 authored_override_stale로 실패).
