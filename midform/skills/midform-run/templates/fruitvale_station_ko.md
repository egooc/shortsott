---
profile: production
analysis_mode: auto
source:
  url: "https://www.youtube.com/watch?v=mZ2W1xBnCUY"
  content_type: movie_midform_recap
output:
  target_length_sec: 120
review:
  pause_before_tts: true
subtitle_limits:
  max_chars: 16
tone: 실화 기반 비극의 마지막 밤. 나레이션은 낮고 절제되게, 화면 사실만. 판정도 해석도 하지 않는다
opener_policy: cold_open_callback
spoiler_boundary: clip이 보여주는 범위 안에서만. 영화 밖 실제 사건 경과(재판·판결 등) 언급 금지
must_keep:
  - 핵심 축 - 지하철 몸싸움 → 플랫폼 연행 → 총격 → 직후의 충격
  - 총격 직전·직후의 실제 대사와 절규 원음
  - 오스카가 마지막으로 남긴 말
prohibitions:
  - 실화 왜곡 금지 - 영화가 보여주는 것만, 실제 사건에 대한 추가 사실·의견 금지
  - 누가 옳은지 판정하는 나레이션 금지 - 경찰·오스카 어느 쪽도 단정하지 않는다
  - 총격을 절차적·선정적으로 묘사 금지 - 반응과 컷 전환으로만 (노딱 안전 어휘 엄수)
  - 감정을 이름 붙여 해석하는 나레이션 금지
  - 인물 소개 나레이션 금지
  - clip 밖 사건 확장 금지
  - 렌더 결과물의 speaker-color mismatch 금지
render:
  preview_frame_proof: true
  use_capcut_template: true
  audio_path_mode: absolute
  video_placement_mode: source_clips
---

# Source
- clip url: https://www.youtube.com/watch?v=mZ2W1xBnCUY
- target length: 120s (상한 - 클립 내부 아크가 길이를 정한다)
- title: Oscar Is Fatally Shot During Police Arrest (Subway Fight Scene) | Fruitvale Station
- source audio language: English
- subtitle source: 자동자막 (en) — 소음·절규 구간 오인식 가능, 게이트에서 프레임 대조 필수
- speech density: 중간 추정 - 몸싸움·군중 소음 구간과 대사 구간이 교차
- 실화 주의: 2009년 실제 사건의 영화화 - 장면 사실 외 어떤 추가 서술도 금지

# Editorial Preferences
- keep_dialogue_policy: preserve_scene_force — 연행·총격 전후의 실제 교환은 무조건 원음
- dialogue_unit_preference: micro_exchange
- narration_density: low — 원음(소음·절규·정적)이 끌고 간다. 나레이션은 위치 전환의 이음매만
- cut_anchor: 지하철 싸움 발발 / 플랫폼 연행 / 총격의 순간 / 직후
- 편집 교리: 덜어내기 — 몸싸움의 반복을 덜고 국면 전환만 남긴다

# Fixed Facts
- title / year: Fruitvale Station (2013)
- one-line premise: 지하철역에서의 연행 중 총격이 벌어지는 실화 기반 장면
- common misunderstanding to avoid:
  - 인물 이름은 대사에서 들릴 때만 사용
  - 경찰의 의도(고의/실수)를 단정하지 않는다 - 영화도 단정하지 않는 것을 나레이션이 앞서 판정 금지
- unknown or ambiguous points:
  - 자동자막이라 화자 구분 없음 - 화면으로만 화자 판단, 불확실하면 미표기
  - 군중 소음 구간의 자막 오인식 주의

# Recap Intent
- one-line recap goal: 평범한 귀갓길이 몇 분 만에 비극이 되는 과정을, 화면 사실만으로 전달한다
- cold-open hook: 총격 직전의 긴박한 순간 또는 직후의 정적
- emotional tone:
  - dread
  - helplessness
  - grief
- viewer question to sustain: 어쩌다 여기까지 왔는가
- preferred ending:
  - aftermath silence
- title-hook note: 후킹 패턴 프로세스로 - 실화의 무게를 클릭베이트로 소모하지 않는 선에서 (witness_pov/last_moments 계열 유력)

# Narration Rules
- narration should:
  - 위치·국면 전환만 짚는다
  - 한 문장 한 아이디어, 낮은 톤
- narration should not:
  - 판정·해석·감정 명명 금지
  - 총격 절차 묘사 금지
  - 실제 사건 확장 금지

# Output Preference
- desired opening feel: 평범한 밤이었다
- desired midpoint feel: 걷잡을 수 없이 커지는 상황
- desired ending feel: 되돌릴 수 없는 몇 초
- pacing preference:
  - slow build then sudden break
- viewer takeaway in one sentence: 몇 분의 상황 전개가 한 사람의 마지막 밤이 되었다
