---
profile: production
analysis_mode: auto
source:
  url: "https://www.youtube.com/watch?v=U9XwGlu0FO4"
  content_type: movie_midform_recap
  promo_tail_sec: 16.4
output:
  target_length_sec: 100
review:
  pause_before_tts: true
subtitle_limits:
  max_chars: 16
tone: 밀폐 공간 각개격파 액션의 리듬. 말이 아니라 타격음과 정적이 끌고 간다. 나레이션은 최소한의 위치 정보만
opener_policy: cold_open_callback
spoiler_boundary: clip이 보여주는 범위 안에서만 전개하고, 이후 전개나 결말을 미리 설명하지 않는다
must_keep:
  - 핵심 축 - 아이를 숨긴다 → 침입 → 각개격파 → 발각 위기(아이를 찾았다는 외침) → 저지
  - 숨기라고 지시하는 대사 (나올 때까지 나오지 말라는 약속)
  - 아이가 발각되는 순간의 외침과 그 직후의 반전
  - 수색을 지시하는 적측 대사
prohibitions:
  - 검증되지 않은 인물 관계나 동기 날조 금지 - 아이와 주인공의 관계는 대사가 말한 만큼만
  - clip 밖 사건이나 결말 확장 금지 - 본편 설정 언급 금지
  - 액션 포인트를 나레이션이 앞질러 설명하는 것 금지
  - 감정을 이름 붙여 해석하는 나레이션 금지
  - 인물 소개 나레이션 금지 - 관계와 위치는 대사와 장면으로만
  - 타격·살상 절차적 묘사 금지 - 반응과 컷 전환으로만 (노딱 안전 어휘 준수)
  - 렌더 결과물의 speaker-color mismatch 금지
render:
  preview_frame_proof: true
  use_capcut_template: true
  audio_path_mode: absolute
  video_placement_mode: source_clips
---

# Source
- clip url: https://www.youtube.com/watch?v=U9XwGlu0FO4
- target length: 100s (상한 - 클립 내부 아크가 길이를 정한다)
- title: Jason Statham Vs Elite Special Ops Team (2026) Fight Scene | Shelter - Action Movie Clip 4K
- source audio language: English
- subtitle source: **STT 폴백 (faster-whisper)** — 이 업로드는 수동/자동자막이 전혀 없음. 큐는 기계가 들은 것이므로 검수 게이트에서 전 줄 재검증 필수
- speech density: 극희소 (~8줄/325s, 사전 정찰 실측) — Anacondas·Cirque보다도 낮음
- promo tail: 308.9s부터 순수 블랙 16.4s (blackdetect 실측, 프로모 카드 아님) — usable_end ≈ 308.9

# Editorial Preferences
- keep_dialogue_policy: preserve_scene_force — 숨기라는 지시, 발각 외침, 수색 지시는 무조건 살린다
- dialogue_unit_preference: micro_exchange
- narration_density: low — 액션은 원음(타격·정적)이 끌고 간다. 나레이션은 국면 전환에만
- cut_anchor: 아이를 숨기는 순간 / 침입 개시 / 발각 외침 / 저지
- 리듬 목표: 은닉과 약속 → 침입 → 각개격파의 반복 리듬 → 발각 위기 → 저지
- 편집 교리: 덜어내기 — 전투의 반복 구간에서 리듬이 같은 파편을 덜어내고 국면이 바뀌는 순간만 남긴다

# Fixed Facts
- title / year: Shelter (2026)
- one-line premise: 아이를 숨긴 남자가 침입한 특수부대를 밀폐 공간에서 각개격파로 막아내는 장면
- scene position in story: 알 수 없음 - 단정하지 말 것
- common misunderstanding to avoid:
  - 아이의 이름은 대사에서 확실히 들릴 때만 사용 (STT가 들은 이름은 오인 가능 - 확신 없으면 이름 미사용)
  - 침입자들의 소속·목적은 대사가 말한 만큼만 ("아이를 찾았다/데려가라"가 전부)
  - 주인공 캐릭터명을 배우명(스타뎀)으로 대체하지 말 것 - 이름 미상이면 지칭 최소화
- unknown or ambiguous points:
  - STT 큐라 화자 구분 없음 - 화면(비전 장면 지도+프레임 검증)으로만 화자를 판단하고, 불확실하면 화자 미표기
  - 절규·반복 외침 구간("Stop it" 연쇄)은 STT 환각 가능성 - 검수에서 프레임 대조 필수

# Recap Intent
- one-line recap goal: 지키겠다는 약속 하나가 압도적 수적 열세를 버티게 하는 과정을 타격의 리듬으로 전달한다
- cold-open hook: 발각 외침 직전의 정적, 또는 숨기라는 약속의 대사
- emotional tone:
  - controlled menace
  - claustrophobic tension
  - protective fury
- viewer question to sustain: 아이가 발각되기 전에 다 쓰러뜨릴 수 있는가
- what must be paid off by callback:
  - 초반의 약속(나올 때까지 나오지 마라)이 발각 위기에서 시험대에 오른다는 점
- preferred ending:
  - cliff

# Dialogue Handling
- preserve original dialogue when:
  - 숨기라는 지시와 약속
  - 아이 발각 외침과 추출 지시
  - 수색 지시
- bridge narration allowed when:
  - 공간이 바뀌어 한 문장 복구가 필요할 때만
- downgrade to narration when:
  - STT 신뢰도가 낮거나 프레임 대조로 확인 불가한 줄

# Narration Rules
- narration should:
  - 눈이 못 보는 것만 말한다: 시간 도약, 화면 밖 사건
  - 감정을 이름 붙이지 않고 상황만 짚는다
  - 한 문장 한 아이디어, 짧게 끊어 읽힌다
- narration should not:
  - 인물을 소개하지 말 것
  - 액션 포인트를 앞질러 설명하지 말 것
  - 전투 결과를 절차적으로 묘사하지 말 것

# Output Preference
- desired opening feel: 문 하나를 사이에 둔 약속
- desired midpoint feel: 소리 없이 줄어드는 숫자
- desired ending feel: 약속은 아직 유효하다
- pacing preference:
  - rhythmic strikes with silence between
- viewer takeaway in one sentence: 지킬 것이 있는 사람이 가장 위험하다
