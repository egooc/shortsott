# KR Full 업그레이드 — midform(무비리캡) 레포 채택 계획 (2026-08-11)

비교 분석: 두 에이전트가 midform 레포(`Codex/2026-05-26/midform`)와 우리
KR Full 경로를 파일:라인 단위로 맵핑한 결과. midform은 내레이션-우선
파이프라인(테스트 279개 통과)이라 TTS·캡션·오디오 믹스가 우리보다 성숙하다.

## P0 — 출고 차단급 버그 (2026-08-11 즉시 수정, 커밋됨)

1. **TTS 오디오가 영상에 없음**: KR Full 드래프트 트랙에 내레이션 트랙
   자체가 없었다 — mp3는 자막 타이밍 계산에만 쓰이고 버려짐. 수정:
   `create_process_draft`에 `tts` 오디오 트랙 추가, 문장 mp3를 캡션
   타임라인과 동일하게 t=0부터 연속 배치. manifest `process_tts` 기록.
2. **TTS가 아예 실행 안 됨(자동화 관점)**: `use_tts`가 스크립트 리뷰 수동
   승인(`approved_for_tts`)에 게이트되어 무인 레인에서 항상 false. 수정:
   kr_full 레인 & 검증 통과(not held) 아이템은 승인 없이 TTS 진행
   ("어설퍼도 차라리" 사인오프). held는 여전히 사람 리뷰로 정지.

## P0-후속 — 타임라인 정합 (2026-08-12 커밋됨)

3. **자막/영상/내레이션 3중 타임라인 분리 버그**: 자막 유닛은 TTS 실측
   길이로 만들어졌지만 파이썬 `sync_full_caption_segments_to_video_timeline`이
   컷 타임라인으로 재배치했고(구 Full 설계용), 영상은 예산(후보 concat
   기반 21초)과 무관하게 45~62초로 조립되어 내레이션 종료 후 20초 무음.
   수정: TTS 모드에서 캡션 재배치 스킵(내레이션 타임라인 유지) + 영상
   트랙을 내레이션 끝+1.5초에서 트림(`trim_video_track_to_narration`) →
   BGM/로고/이펙트는 기존 aux 트림이 자동 정렬.
4. **드래프트 출고 게이트**: `verifyKoreanFullDraftTimelineAlignment` —
   생성된 draft_content.json을 되읽어 tts 트랙 존재, 자막⊆내레이션,
   자막 끝=내레이션 끝(±1s), 영상 끝=내레이션 끝(+0.5~3s), BGM 볼륨
   적용을 검사. 실패 시 아이템 실패(OTTOGI_KR_FULL_DRAFT_MISALIGNED),
   조용한 출고 금지.

## P1 — 이번 주 (품질/비용, 저위험)

0. **발화 예산을 실제 영상 타임라인 기준으로 재보정**: 현재 예산은
   후보 concat(min(60, Σhook_candidates)) 기반이라 실제 조립 영상
   (45~62초)의 절반만 내레이션됨 → 트림 가드로 영상이 ~내레이션 길이로
   잘려 출고 중. 예산 산정을 preflight 실측 타임라인
   (`computeDraftActualVideoTimelineSecForPreflight`)으로 바꾸면 조립
   영상 전체를 내레이션이 커버.
1. **ElevenLabs 설정 실적용 + 발화속도 재보정**: `generateAllTTS`가 5개
   인자만 받아 `KOREAN_FULL_TTS_VOICE_SETTINGS`(stability 1.0, speed 1.1,
   mp3_44100_128)가 통째로 버려지고 있음(기본 0.5/0.75로 발화). midform은
   **동일 보이스+동일 설정**으로 운영하며 실측 `6.03775 chars/sec`
   (`midform/config/tts.json`). 채택: options 파라미터 관통 + 예산 상수
   7.12→6.03775 재보정 + SRT용 5.0 불일치 제거(한 레인에 상수 3개 존재).
2. **한국어 캡션 줄바꿈 이식**: `assemble_slot_draft_input.py:489-659`
   `balanced_partition_words` — 후보 경계 스코어링(구두점+80/연결어+60/
   조사+40) + 금지 경계(관형사, 의존명사, **종성 ㄴ/ㄹ 단음절 수식어**
   한글 분해 판정). 우리 3중 상수(Node 15자/파이썬 12자/프롬프트 16자)
   재분할 체인을 단일 브레이커로 통일.
3. **TTS 콘텐츠 해시 재사용**: sha256(text+voice+settings) 인덱스로 재실행
   시 기존 mp3 복사(`compute_text_hash`/`build_reusable_tts_index`) —
   재생성·재배치 시 ElevenLabs 크레딧 0.
4. **LUFS 내레이션/BGM 밸런스**: `computeLoudnessAlignment` — ebur128로
   내레이션 vs BGM 실측 후 "내레이션 +3LU" 목표로 세그먼트 볼륨 배정.
   현재 BGM 고정 0.18은 소스별 편차에 무방비.

## P1-분석 — 소스 분석 계층 채택 (late_hook 근본 대책)

A. **측정 에너지 피크 주입 + 계획 강제** (`midformCompressionService.js:5378-5509`,
   `runCompression:5708-5713`): ffmpeg-only 피크 검출(오디오 RMS z + 모션
   차분 z, 0.45/0.55 결합, 4초 창, 상위 8개 ≥6초 간격) → 하이라이트 후보
   프롬프트에 실측 피크 목록 주입 + **상위 2개 피크 미커버 시 재시도 거부**.
   우리 스코어카드 실측 late_hook(배치당 15~19건)의 선행 차단책 — 사후
   발견을 사전 강제로 전환. 메타데이터 프롬프트 수정이므로 사인오프 필요,
   적용 후 스코어카드 late_hook 비율로 효과 검증.
B. **소스 해상도 가드** (`:5638`): 720p 미만 수집 거부, 1080p 미만 경고 —
   하베스트 필터에 즉시 적용 (2026-08-11 구현).
C. (P2) **비전-씬 의미 경계 스냅**: 엣지 리파인 스냅 후보에 Gemini
   `scene_transitions` 경계 추가 — 하드컷 없는 연속 모션의 의미 전환
   포착 (`midformLocaleDraftService.js:1034-1042` 패턴).
D. (P2, KR Full) **액션 비트 원본 오디오**: 최고 피크 구간은 내레이션 없이
   소스 기계음 재생 (`insertActionBeatSlots:3630`) — 현재 우리는 소스
   오디오 전량 폐기(-an).

## P2 — 채널 성과 데이터 쌓인 후

5. **내레이션 스타일 하드게이트**: 어미 분포(~했습니다 60-70% 등), 금지
   어미, 시청자 질문 금지, 수익화 위험 어휘 테이블
   (`validateKoreanNarrationStyle`) — 우리 스크립트 검증에 이식.
6. **후킹 패턴 스코어드 타이틀**: `hook_patterns.json` + 채점(호기심갭 20,
   서사긴장 20…, 스포일 −15) — KR Full 업로드 타이틀 3후보 생성.
7. **frame-vs-text 비주얼 저지**: 내레이션 문장별 3프레임 샘플 → Gemini
   temperature 0 판정(`judgeFramesAgainstText`) — KR Full 스코어카드의
   "내레이션이 화면과 맞는가" 차원.
8. preroll hook 캡션 소실 수정: TTS 캡션 유닛이 explainer_blocks를 통째
   교체하면서 후킹 블록이 사라지는데 시간은 늘어나 있음(KR Full 맵 #6).

## 이식 규칙

- midform 코드는 읽고 **이 레포에 재작성**한다 (두 레포 모두 사적 코드라
  라이선스 문제는 없지만, 의존 방향이 생기면 안 됨 — midform은 별도
  진화 중). 이식 시 출처 파일:라인을 커밋 메시지에 남긴다.
- 캡션 브레이커 등 순수 함수는 계약 테스트와 함께 이식.
