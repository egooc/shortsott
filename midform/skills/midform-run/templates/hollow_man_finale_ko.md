---
profile: production
analysis_mode: auto
source:
  url: "https://www.youtube.com/watch?v=6Gd4JbJxaf4"
  content_type: movie_midform_recap
output:
  target_length_sec: 100
review:
  pause_before_tts: true
subtitle_limits:
  max_chars: 16
tone: 보이지 않는 위협과의 최후 대치. 공포는 설명이 아니라 빈 공간과 절규가 만든다. 나레이션은 최소한의 위치 정보만
opener_policy: cold_open_callback
spoiler_boundary: clip이 보여주는 범위 안에서만 전개하고, 이후 전개나 결말을 미리 설명하지 않는다
must_keep:
  - 핵심 축 - 보이지 않는 습격 → 몸싸움과 절규 → 조롱("마지막 키스") → 거부("지옥에나 가") → 반격과 최후
  - 제목 대사 - "One last kiss, for old time's sake"와 그에 대한 응수 "Go to hell"
  - 몸싸움 절규("Get off of me!")의 원음 강도
  - 반전 선언("Not anymore")
prohibitions:
  - 검증되지 않은 인물 관계나 동기 날조 금지 - 두 사람의 과거 관계는 대사가 말한 만큼만("old time's sake"가 유일한 근거)
  - clip 밖 사건이나 결말 확장 금지 - 본편 설정(투명화 실험 경위 등) 언급 금지
  - 공포 포인트를 나레이션이 앞질러 설명하는 것 금지
  - 감정을 이름 붙여 해석하는 나레이션 금지
  - 인물 소개 나레이션 금지
  - 살상·부상 절차적 묘사 금지 - 반응과 컷 전환으로만 (노딱 안전 어휘 준수)
  - 렌더 결과물의 speaker-color mismatch 금지
render:
  preview_frame_proof: true
  use_capcut_template: true
  audio_path_mode: absolute
  video_placement_mode: source_clips
---

# Source
- clip url: https://www.youtube.com/watch?v=6Gd4JbJxaf4
- target length: 100s (상한 - 클립 내부 아크가 길이를 정한다)
- title: Hollow Man (2000) - For Old Times' Sake Scene (10/10) | Movieclips
- source audio language: English
- subtitle source: **STT 폴백 (faster-whisper)** — Movieclips 업로드, 자막 전무. 큐는 기계가 들은 것 — 게이트에서 전 줄 프레임 대조 필수
- speech density: 극희소 (~0.12 추정, 정찰 실측 — 스미어 스팬 감안). 액션 파이 ~30% 예상
- 정찰 특이점: 66~95s 구간 세그먼트가 15s로 스미어됨(음악 위) — 파이프라인 워드 타임스탬프가 조일 것, 게이트에서 창 확인
- promo tail: Movieclips 엔드카드 가능성 높음 — 게이트에서 프레임 실측 후 선언할 것

# Editorial Preferences
- keep_dialogue_policy: preserve_scene_force — 조롱·거부·절규·반전 선언은 무조건 살린다
- dialogue_unit_preference: micro_exchange — 조롱("마지막 키스")과 응수("지옥에나 가")는 한 호흡의 교환
- narration_density: low — 보이지 않는 위협은 원음(절규·정적·충돌음)이 끌고 간다
- cut_anchor: 습격 개시 / "마지막 키스" 조롱 / "지옥에나 가" / 반전의 순간
- 리듬 목표: 습격 → 몸싸움 → 조롱과 거부(정점 대사) → 반격 → 최후
- 편집 교리: 덜어내기 — 몸싸움의 반복 리듬에서 파편을 덜고 국면 전환만 남긴다

# Fixed Facts
- title / year: Hollow Man (2000)
- one-line premise: 보이지 않는 남자의 최후 습격을 상대가 맞받아치는 클라이맥스 장면
- scene position in story: 클립 시리즈 10/10 — 마지막 장면. 단 "결말"이라는 표현은 클립이 보여주는 범위까지만
- common misunderstanding to avoid:
  - 인물 이름은 대사에서 확실히 들릴 때만 (STT 정찰에서 이름 미검출 — 이름 미사용)
  - 두 사람의 과거 관계는 "old time's sake" 한 줄이 유일한 근거 — 연인이었다고 단정하지 말 것
  - 투명인간의 원리·경위는 본편 설정 — 언급 금지, 화면의 현상만
- unknown or ambiguous points:
  - STT 큐라 화자 구분 없음 — 화면(비전+프레임)으로만 화자 판단, 불확실하면 미표기
  - 66~95s 스미어 스팬은 창 재검증 필수
  - "Get off of me!" 3연속은 실제 반복 절규일 수 있음 (환각 루프 캡이 2로 자름 — 게이트에서 프레임 대조)

# Recap Intent
- one-line recap goal: 보이지 않는 상대와의 마지막 대치를, 조롱과 거부의 대사 한 쌍으로 꿰어 전달한다
- cold-open hook: "마지막 키스" 조롱 직전의 정적, 또는 절규의 정점
- emotional tone:
  - invisible dread
  - defiant fury
  - last-stand tension
- viewer question to sustain: 보이지 않는 상대를 어떻게 이길 것인가
- what must be paid off by callback:
  - 조롱("마지막 키스")이 거부("지옥에나 가")로 되돌아오는 구조
- preferred ending:
  - cliff
- title-hook note: 제목 후보는 후킹 패턴 프로세스로 — 이 소스는 forbidden/witness_pov/wrong_target/last_stand 계열이 유력, 확정은 요소 추출 후

# Dialogue Handling
- preserve original dialogue when:
  - 조롱과 응수 교환 ("One last kiss..." / "Go to hell")
  - 몸싸움 절규
  - 반전 선언 ("Not anymore")
- bridge narration allowed when:
  - 공간·국면이 바뀌어 한 문장 복구가 필요할 때만
- downgrade to narration when:
  - STT 신뢰도가 낮거나 프레임 대조로 확인 불가한 줄

# Narration Rules
- narration should:
  - 눈이 못 보는 것만 말한다 - 단, 이 소스는 "보이지 않는 것" 자체가 소재이므로 화면에 없는 위협의 위치를 단정하지 말 것
  - 감정을 이름 붙이지 않고 상황만 짚는다
  - 한 문장 한 아이디어, 짧게 끊어 읽힌다
- narration should not:
  - 인물을 소개하지 말 것
  - 공포 포인트를 앞질러 설명하지 말 것
  - 부상·살상을 절차적으로 묘사하지 말 것

# Output Preference
- desired opening feel: 보이지 않는 것이 방 안에 있다
- desired midpoint feel: 잡을 수 없는 상대, 물러설 수 없는 사람
- desired ending feel: 조롱의 대가
- pacing preference:
  - dread build then strike
- viewer takeaway in one sentence: 보이지 않는 힘보다 무서운 건, 물러서지 않기로 한 사람이다
