# 오픈소스 숏폼 파이프라인 8종 코드 분석 및 채택 계획 (2026-08-08)

클론 위치: `C:\Users\sejun\Documents\Codex\2026-05-26\opensource-research\` (프로덕션 레포 밖).
분석 방법: 저장소별 전담 에이전트 4개가 파일/함수/라인 단위로 정밀 분석.

## 0. 라이선스 실물 확인 결과 (전제)

| 저장소 | 주장 | 실물 확인 | 코드 이식 |
|---|---|---|---|
| clippyme | MIT | **MIT 확인** (표준 전문) | 가능 |
| openshorts | MIT | **MIT + 예외**: `cloud/` 디렉터리는 상용 라이선스. 우리가 쓸 모듈은 전부 루트라 문제 없음 | 가능 |
| chopify | MIT | **MIT 확인** | 가능 |
| autoshorts | MIT | **MIT 확인** | 가능 (단, 코드 자체는 이식 비권장 — 아래) |
| clipsai | MIT | **MIT 확인** (2024-01 이후 방치) | 가능하나 채택 안 함 |
| AI-Youtube-Shorts-Generator | MIT | **LICENSE 파일 없음** — README 문구뿐. 코드 출처도 제3자 포팅 명시 | **재구현 권장** (필요분이 19줄이라 저렴) |
| clips-studio | AGPL-3.0 | **AGPL 확인** | **금지 — 알고리즘 스펙 참고만** |
| hotclip | AGPL-3.0 | **AGPL 확인** | **금지 — 알고리즘 스펙 참고만** |

AGPL 2종은 우리 서버가 네트워크 서비스라 §13(네트워크 소스공개)이 걸린다.
`opensource-research/` 클론은 읽기 전용 참고자료로만 두고, **어떤 파일도 이 레포로 복사하지 않는다.**
AGPL 스펙을 재구현할 때는 이 문서를 독립 구현 근거(derivation trail)로 삼는다.

## 1. 사용자 원본 리서치 대비 정정 사항

- **Chopify의 "AI 점수화"는 코드에 존재하지 않는다.** `segments.json`을 읽기만 하고 쓰는 코드가 없다 — README가 말하는 "제로 API 비용 LLM 점수화"는 저자가 채팅 LLM에 수동으로 시키는 것. 8개 기준·8점 컷도 README 산문에만 있다.
- **OpenShorts의 `verify_hooks.py` / `verify_aesthetic.py`는 검증 모듈이 아니라 PIL 스모크 테스트**(36~37 LOC), `quality_probe.py`는 yt-dlp 해상도 사전 점검이다. **8개 저장소 어디에도 "선정된 창을 되보여주고 훅을 검증하는" 패스는 없다** — 이건 우리가 직접 만들어야 하는 공백.
- **AI-Youtube-Shorts-Generator의 청킹 코드에는 실버그 2개**: ① 오버랩 60초 구간의 세그먼트를 모델에 보여주고는 선택 불가능하게 클램프, ② 청크 경계에 걸친 세그먼트 통째 드롭. 상수(20분/60초)만 취하고 구현은 openshorts 방식을 쓴다.
- **AutoShorts는 Windows에서 사실상 실행 불가**: `decord`를 CUDA와 함께 소스 빌드해야 하며(리눅스 전용 Dockerfile), torch+cupy 스택에 강결합. 코드가 아니라 산식 표를 가져온다.

## 2. 채택 목록 — 우선순위순

### A군. MIT 코드 직접 이식 (독립 스크립트로 격리)

**A1. `openshorts/scene_detection.py` → `scripts/scene_detect_transnet.py`** — 전 저장소 통틀어 최고 가치 148 LOC.
TransNetV2 신경망 샷 감지(48×27 프레임, 임계값 0.5) + 0.4초 미세장면 이전-병합 + PySceneDetect 폴백.
임계값 방식 ContentDetector가 약한 "조명 일정 + 완만한 기계 모션" 공정 영상에 정확히 유효.
API가 `detect_scenes(path) -> (scene_list, fps)` 하나뿐이라 그대로 이식.
따라올 정확성 디테일 2개: inclusive→exclusive 끝 변환, cv2 프레임카운트 vs ffmpeg 디코드 불일치 보정.
주의: `transnetv2-pytorch` 패키지(모델 가중치)의 라이선스는 openshorts MIT와 별개 — 이식 전 확인.

**A2. `clippyme` 컷 경계 보정 → `scripts/refine_cut_points.py`** — `cut_ops.py`(606 LOC, **의존성 제로 순수 함수**) + `media_probe.py`의 silencedetect 래퍼(76 LOC).
3단 보정: 단어 경계 스냅(±0.6s) → 문장 경계 스냅(뒤로 2.5s/앞으로 1.5s, 약어 44종 가드) → **무음 트로프 스냅(±0.35s, 시작은 소리 나기 40ms 전 / 끝은 소리 멎고 60ms 후)**.
무발화 소스에는 3단계(무음 스냅)만으로도 즉시 유효. ffmpeg 호출: `silencedetect=noise=-30dB:d=0.08`, 소스당 1회.
이식 시 필수 수정 4개:
1. `snap_clips_to_transcript`의 `words` 없으면 통째 스킵하는 가드 → 단계별 가드로 분리 (무발화 소스가 무음 스냅을 받도록)
2. `DEFAULT_MAX_CLIP_DURATION` 60 → 우리 24초 상한
3. 기계음용 적응형 노이즈 플로어 (-30dB 고정 → `volumedetect` 평균 -12dB 등)
4. **원저장소 버그 수정**: 이웃 클램프가 raw 구간 기준이라 클립 간격 <4초일 때 보정 후 겹칠 수 있음 → 시간순 처리 + 보정 후 값 기준 클램프
KO/JA 확장: 문장 종결 문자에 `。！？` 및 한국어 종결 추가, 필러 사전에 ko/ja 없음(추가 필요).

**A3. `openshorts/clip_selection.py` → 그대로 (stdlib-only 202 LOC)**.
- `build_transcript_windows`(90s/30s 오버랩, 경계 스냅 탐욕 성장, 전진 보장) — **Whisper 세그먼트 대신 A1의 장면 경계로 성장하는 버전으로 ~30줄 개조**하면 무발화 소스용 청킹이 된다.
- `snap_clip_to_words` — `min_duration=6, max_duration=24`로 호출.
- `clip_count_targets` docstring의 운영 데이터(클립 1-3개 수신 유저 익일 복귀 0.4% vs 4-9개 16.1%)는 우리 3-5컷 정책의 외부 근거.

**A4. 중복 제거 `dedupe_highlights` — 19줄 재구현** (AIYT 라이선스 불명이므로 재작성).
점수 내림차순 탐욕 스윕. **원본의 비대칭 버그 수정 필수**: `overlap > 0.5 * h_dur`(후보 기준만) → 24초 후보가 채택된 10초 컷을 품어도 통과(42%)하는 문제. `0.5 * min(h_dur, k_dur)` 또는 IoU로.
우리 `pickHighlightWindows` 앞단이 아니라 **실험 격리 스크립트에서 Gemini 후보 정리용**으로 시작.

**A5. `chopify/render_clips.py::smooth_track` (30 LOC, 무의존성) → CapCut 위치 키프레임 생성기**.
EMA(α=0.20) + 컷 감지 시 순간이동(점프 > 0.22×W) + 엣지 가드(0.18×crop_w) + 중앙값 시드.
얼굴 검출(YuNet) 대신 **모션 에너지 중심점**(A6의 프레임 diff 맵 가중 중심)을 입력으로 바꾸면:
모션 중심 추적 → smooth_track → `[(t, x)]` 트랙 → **`draft_content.json` 위치 키프레임** — mp4 렌더 없이 동적 리프레임.
5fps/640px 프록시에서 검출하는 패턴도 함께 채택. (`sendcmd` 자체는 ffmpeg 렌더 전용이라 미사용)

**A6. `openshorts/ffmpeg_utils.py` 일부** — `LOUDNORM_FILTER = loudnorm=I=-14:TP=-2.0:LRA=11`(TP -2.0 선택 근거 벤치마크 주석 포함), `METADATA_SCRUB`(유튜브 "produced by Google Inc." 핸들러 제거). 즉시 유용한 소품.

### B군. 산식만 재구현 (코드 이식 불가/비권장)

**B1. `scripts/audio_motion_score.py` 신규 (~150 LOC, numpy만)** — AutoShorts 산식 표 기반, torch/decord 없이:

| 항목 | 값 |
|---|---|
| 오디오 입력 | `ffmpeg -vn -ac 1 -ar 16000 -f s16le -` 파이프 |
| RMS | frame 2048 / hop 512, `sqrt(mean(frame²))` |
| Spectral flux | `sqrt(Σ_f (|X_t|-|X_{t-1}|)²)` — **공정 영상용은 half-wave 정류 + RMS 0.4 / flux 0.6으로 뒤집기** (기계 이벤트는 '큰 소리'가 아니라 '스펙트럼 변화') |
| 정규화 | 전체 z-score (편차 큰 소스는 롤링 중앙값 기준 고려) |
| 스무딩 | box 필터 ~0.22s(오디오) / 1s(모션) |
| 모션 입력 | `ffmpeg -vf fps=6,scale=256:-2,format=gray -f rawvideo -` 파이프 → `abs(diff).mean()` |
| A/V 결합 | 0.6 오디오 + 0.4 모션 (출발값) |
| 출력 | `{"fps":1, "audio":[], "motion":[], "excitement":[]}` JSON |

`_best_window_single`류 cumsum 슬라이딩 argmax(AutoShorts에서 가장 깨끗한 ~50 LOC 순수 numpy)는 그대로 포팅 가능.
**용도: Gemini 창의 교차 검증(2차 의견)** — 일치하면 신뢰 상승, 불일치하면 QA 플래그. 프로덕션 선택 로직 대체가 아님.

**B2. Most Replayed 곡선** — clips-studio가 쓰는 방법 자체는 단순 사실: `yt_dlp.YoutubeDL({skip_download:True}).extract_info(url)["heatmap"]` → `{start_time,end_time,value}` 세그먼트 → 초당 배열 채우고 피크 정규화. yt-dlp 사용법이므로 자유 구현 가능. Phase 1 소재 발굴에서 이미 yt-dlp를 쓰므로 저비용. 후보 가점(+0..8 상한, 콘텐츠 신호보다 낮게)과 독립 후보 피크 소스 두 용도.

### C군. AGPL 스펙 재구현 (코드 절대 미복사 — 이 문서가 독립 구현 근거)

**C1. 드래프트 QA 패스 (hotclip qa.ts 스펙)** — 8개 저장소에서 가장 이식 가치 높은 '설계'.
한 번의 ffmpeg 디코드: `-vf blackdetect=d=0.5:pix_th=0.10 -af silencedetect=n=-50dB:d=2,ebur128=peak=true -f null -` + ffprobe 길이.
검사 임계값 세트: 블랙 ≥0.5s / 무음 -50dB ≥2s / 라우드니스 -14 LUFS ±2 LU / 트루피크 > -1 dBTP / 길이 오차 > 0.75s / (발화 시) 단어 중간 컷 ±0.05s.
판정은 **pass/warn 2단 — fail 없음** (QA는 알려주되 막지 않는다: 우리 skip-not-fail 정책과 동일 철학).
수리 루프: 가장자리 무음/블랙 트림 + 라우드니스만 자동 수정, **재검사에서 이슈 수가 '엄격히 감소'할 때만 채택**. 중간 블랙/무음은 사람 결정으로 남김.
우리 적용처: CapCut 내보내기 mp4를 Phase 3 매칭 시 검사 → 카드에 QA 배지, 또는 드래프트 생성 직후 소스 컷 구간 검사.

**C2. 신호 융합 원칙 4개 (clips-studio + hotclip이 독립적으로 도달한 결론)**
1. **영상 내 percentile-rank 정규화** (`argsort().argsort()/(n-1)`) — 조용한 영상에도 상대적 피크가 생긴다.
2. **포화 할인**: 커버리지 55% 초과 채널은 가중치 `0.55/coverage`로 축소, 90% 초과 시 채널 폐기 — **연속 기계소음이 도는 공정 영상에서 나이브 라우드니스가 정확히 이렇게 포화된다.**
3. **발화 밀도 적응 가중**: speech ratio < 0.35면 텍스트 가중을 시각/리액션으로 이전(오디오로는 이전 금지 — 조용한 구간의 저점수는 percentile 부작용이므로).
4. **절대 점수 불신**: 두 프로젝트 모두 LLM 절대점수가 뭉친다고 결론 — listwise 상대 순위(배치 8개, +0..6 단조 상승 보너스, 순위는 절대 점수를 내리지 않음) 또는 순위를 76-99/50-70 구간에 사상. 우리 3-5 최종 컷에 순서 재평가 1콜은 저비용.
5. (보너스) **리액션은 후행 지표**: 오디오 스파이크는 원인 장면 '뒤에' 온다 — 신호를 Gemini에 줄 때 프롬프트에 명시하지 않으면 반응부터 시작하는 창이 나온다.

**C3. 프롬프트 자산 (텍스트, 자유 사용)**
- openshorts(MIT) `VISUAL_PROMPT_TEMPLATE`의 **TIME CONTRACT** 문구(절대 초, ≤3자리, `0<=start<end<=duration`, 장면 전환에서 컷, 모션 중간 금지) — 무발화 영상용 Gemini 프롬프트에 즉시 이식 가능.
- openshorts "2-SECOND TEST" / "STANDS ALONE"(시작을 앞으로 당길지언정 페이오프를 자르지 말 것) / DIVERSITY 규칙.
- AutoShorts(MIT) 게임 7분류 프롬프트 + Deep Analysis 프롬프트(MM:SS moments JSON) — 게임 브랜치용 그대로 보관.
- clips-studio의 원칙 문장 "문장 경계는 선호, 길이 범위는 약속" — `_fit_to_segments` 설계 원칙으로 채용.

### 스킵 (근거 포함)

- **clipsai 전체**: TextTiling이 100% 트랜스크립트 기반 — 무발화 소스에 원리적으로 부적용. resize는 화자분리(HF 게이트 모델) 필수. 2024-01 이후 방치, 의존성 부패.
- **AIYT `local/clipper.py`**: Haar cascade + 풀해상도 파이썬 프레임 루프 — 3사 중 최약체, openshorts가 명시적으로 버린 v1 아키텍처.
- **openshorts `reframe_v2.py`의 render부**: 2,000 LOC `main.py`에 강결합. 순수 헬퍼(43-145행)와 0.42 콘텐츠 높이 발견만 취함.
- **chopify 점수화**: 존재하지 않음. ASS 자막 생성기는 CapCut 드래프트 체제에선 불필요(향후 TTS 브랜치 시 재고).

## 3. 통합 제약 (CLAUDE.md 준수)

1. **프로덕션 하이라이트 선택 경로(`pickHighlightWindows` 등)는 이번 작업에서 일절 수정하지 않는다.** 모든 신규 코드는 독립 `scripts/*.py` + 필요시 별도 서비스/라우트로 격리 (Highlight Pattern 연구와 동일한 격리 규칙).
2. 신규 스크립트는 JSON in/out 계약으로 만들어 단독 실행 가능하게 한다 (`child_process` 호출 전제).
3. 프로덕션 결합(예: 후보 dedupe를 실제 생성 경로에 연결, QA를 업로드 게이트로)은 실험 데이터 확보 후 **사용자 명시 승인**을 받아 별도 커밋으로.
4. AGPL 클론에서 코드를 복사하는 커밋은 금지. 재구현 시 이 문서의 스펙만 참조.

## 4. 제안 실행 순서

| 단계 | 내용 | 산출물 | 프로덕션 영향 |
|---|---|---|---|
| P1 | A1 장면 감지 + B1 오디오/모션 점수 스크립트 | `scripts/scene_detect_transnet.py`, `scripts/audio_motion_score.py` | 없음 (독립 실행) |
| P2 | A2 컷 경계 보정 스크립트 (무음 스냅 우선) | `scripts/refine_cut_points.py` | 없음 |
| P3 | C1 QA 패스 재구현 | `scripts/qa_probe_clip.py` (+ Phase 3 카드 배지 옵션) | 옵션 연결 시 승인 |
| P4 | A4 dedupe + C2 융합 원칙으로 후보 교차검증 리포트 | 실험 서비스 (기존 highlightSlicer류와 동급 격리) | 없음 |
| P5 | 실험 결과 평가 후 프로덕션 결합 여부 결정 | — | **승인 필요** |
