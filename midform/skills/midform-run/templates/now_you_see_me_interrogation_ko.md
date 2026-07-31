---
profile: production
analysis_mode: auto
source:
  url: https://youtu.be/REPLACE_ME
  content_type: movie_midform_recap
output:
  target_length_sec: 120
tone: 긴박하고 호기심을 끌되, 과설명은 피하는 한국어 영화 리캡 톤
must_keep:
  - 초반 20초 안에 인물 관계와 현재 갈등을 이해할 수 있는 핵심 교환
  - teaser 질문을 실제 장면 근거로 회수하는 callback 대사 또는 payoff 구간
  - 장면을 뒤집는 결정적 감정 변화, 위협 신호, reveal, 또는 선택의 순간
prohibitions:
  - 검증되지 않은 인과, 의도, 관계 날조 금지
  - 클립 밖 후속 사건이나 결말을 근거 없이 앞당겨 설명하지 않기
  - cold open에서 답을 먼저 말하는 설명형 도입 금지
  - closing을 사건 요약문처럼 길게 마무리하는 방식 금지
opener_policy:
  strategy: auto
  prefer_cold_open_callback: true
  incident_first: true
callback_required: true
subtitle_limits:
  max_chars: 16
  max_units_per_segment: 5
spoiler_boundary: teaser의 정답은 callback/payoff 이전 narration에서 먼저 풀지 않는다
render:
  preview_frame_proof: true
  preview_limit: 8
  use_capcut_template: true
  audio_path_mode: absolute
  video_placement_mode: source_clips
---
Source

  - clip_url:

  - target_length_sec: 120

  - optional_title: The Illusionists Interrogation

  - optional_episode_or_scene_name: Now You See Me FBI interrogation scene

  - optional_language_of_source_audio: English

  - optional_subtitle_source: YouTube generated English transcript

Fixed Facts

  - title_year: Now You See Me (2013)

  - one_line_premise: 체포된 마술사들이 FBI 조사실에서 여유로운 태도로 요원들을 조롱하며 반격을 준비한다.

  - scene_position_in_story: 마술사들이 체포된 후 진행되는 본격적인 취조 및 심리전 국면.

  - verified_characters:

      - name: Dylan Rhodes role: 사건을 쫓는 FBI 요원 relationship_note: 마술사들의 태도에 분노하며

        통제하려 한다

      - name: Alma Dray role: Dylan과 함께하는 FBI 요원 relationship_note: 이성적으로 상황을

        분석하며 간극을 좁히려 한다

      - name: Thaddeus Bradley role: 마술의 비밀을 파헤치는 인물 relationship_note: 마술사들의

        과거와 속내를 짚어준다

      - name: J. Daniel Atlas role: 체포된 마술사 리더 relationship_note: 수갑을 찬 채로 요원들을

        역으로 도발한다

      - name: Merritt McKinney role: 체포된 멘탈리스트 relationship_note: 심리전과 비아냥으로

        요원들을 흔든다

      - name: Henley Reeves role: 체포된 여성 마술사 relationship_note: 마술사들의 여유를 뒷받침한다

  - verified_events:

      - FBI는 마술사들을 체포해 각각 심문하지만 증거 부족으로 압박을 주지 못한다

      - 마술사들은 오히려 요원들의 약점을 짚으며 여유를 부린다

      - Daniel은 소다 캔과 휴대전화 트릭을 이용해 수갑을 풀고 상황을 역전시킨다

      - 마술사들은 당당하게 걸어나간다

  - common_misunderstandings_to_avoid:

      - 단순한 범죄자 자백 장면으로 오해하지 말 것

      - 마술사들이 궁지에 몰린 상태라고 착각하지 말 것

  - unknown_or_ambiguous_points:

      - 자막과 화면 연출상 트릭의 세부 물리적 과정은 함축되어 있다

Recap Intent

  - one_line_recap_goal: 체포되어 갇힌 줄 알았던 마술사들이 오히려 FBI를 조롱하며 완벽하게 판을 뒤집는 장면을 압축한다.

  - cold_open_hook: 네가 뭔가를 안다고 생각하겠지만, 우리는 언제나 한 발 앞서 있다.

  - emotional_tone:

      - smug

      - tense

      - playful

  - viewer_question_to_sismatch: 왜 체포된 범인들이 조사실에서 저토록 여유로울 수 있는가

  - what_must_be_understood_within_first_20_seconds:

      - 마술사들은 체포되었지만 주도권을 쥐고 있다

      - FBI 요원들은 이들의 태도에 극도로 분노해 있다

      - 이 조사는 단순한 심문이 아니라 심리전이다

  - what_must_be_paid_off_by_callback:

      - 초반의 허세처럼 보이던 대화가 결국 탈출 트릭으로 완성된다는 점

      - 소다 캔 트릭으로 수갑과 휴대폰을 확보하는 역전 과정

  - preferred_ending: cliff

Must Keep

  - key_conflict_axis: 체포와 심문 → 심리적 도발 → 트릭을 통한 역전 탈출

  - must_keep_dialogue:

      - We will always be one step ahead

      - First rule of magic: always be the smartest guy in the room

  - must_keep_visual_event:

      - 수갑을 찬 채 여유를 부리는 마술사들

      - 소다 캔(산성 용액)으로 수갑을 녹이는 순간

      - 휴대폰을 되찾고 여유롭게 걸어나가는 결말

  - must_keep_emotional_turn:

      - 요원들의 압박이 마술사의 트릭 한 방에 무력화되는 순간

  - must_keep_factual_anchor:

      - 마술사들은 처음부터 끝까지 상황을 통제하고 있었다

Dialogue Handling

  - preserve_original_dialogue_when:

      - 마술사들이 요원들을 도발하는 핵심 대사일 때

      - 규칙과 마술의 본질을 말할 때

  - bridge_narration_allowed_when:

      - 여러 조사실을 오가는 상황을 짧게 묶을 때

  - downgrade_to_narration_when:

      - 반복되는 가벼운 농담들을 압축할 때

Narration Rules

  - narration_style:

      - sharp

      - ironic

      - fast-paced

  - narration_should:

      - 마술사들의 여유와 FBI의 답답함을 대비시킬 것

      - 트릭이 터지는 순간의 쾌감을 살릴 것

  - narration_should_not:

      - 마술의 비밀을 장황하게 설명할 것

      - 극의 긴장감을 개그로만 소비할 것

Scene-Type Guidance

  - if_confrontation:

      - 대립 구조가 피의자 압박에서 마술사의 우위로 역전되는 과정을 강조한다

  - if_reveal:

      - 수갑이 풀리고 휴대폰을 되찾는 순간의 반전을 핵심 페이오프로 둔다

  - if_comedic_setpiece:

      - 해당 없음

  - if_emotional_confession:

      - 해당 없음

  - if_action_escalation:

      - 물리적 싸움 대신 두뇌 싸움과 트릭의 타격감을 우선한다

Prohibitions

  - no_invented_character_relationships

  - no_invented_off_screen_events

  - no_fake_causality_beyond_clip_evidence

  - no_unsupported_spoiler_expansion_beyond_what_the_clip_itself_clearly_supports

  - no_overlong_subtitles_that_damage_readability

  - no_speaker_color_mismatch_in_rendered_output

  - no_debug_tags_in_viewer_facing_subtitles

  - do_not_turn_the_whole_recap_into_lore_explanation

  - do_not_overstate_exact_battle_outcomes_when_transcript_grounding_is_weak

Output Preference

  - desired_opening_feel: 체포된 이들이 오히려 요원들을 내려다보는 오만한 긴장감

  - desired_midpoint_feel: 좁혀지지 않는 간극 속에서 FBI가 분노하는 답답함

  - desired_ending_feel: 단 한 번의 트릭으로 상황을 박살내고 유유히 사라지는 통쾌함

  - pacing_preference:

      - fast

  - viewer_takeaway_in_one_sentence: 이 장면의 핵심은 감금된 마술사들이 심문실마저 자신들의 무대로 만드는

    역전극이다

Optional Notes

  - franchise_or_film_context_note: 나우 유 씨 미 케이퍼 무비의 백미인 조사실 역관광 장면

  - platform_specific_note: 초반 5초 안에 마술사들의 도발 대사를 배치해 이탈을 방지한다

  - pronunciation_note: Dylan / Alma / Thaddeus / Daniel / Merritt / Henley 표기

    통일

  - title_localization_note: 조사실을 무대로 만든 마술사들의 역관광으로 포커스

  - speaker_alias_note: Dylan / Daniel / Merritt 화자 분리 유지

  - anything_the_generator_must_respect:

      - 마술사들의 여유가 허세가 아니라 실제 능력임을 보여주는 결말을 살릴 것
