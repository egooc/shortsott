# docs/gemini_analysis_schema_and_review_policy.md

## 1. Gemini Analysis JSON 기본 스키마

```json
{
  "source": {
    "source_id": "S-01",
    "filename": "source.mp4",
    "duration_sec": 0,
    "duration_timecode": "MM:SS.mmm",
    "aspect_ratio": "9:16",
    "resolution": "unknown",
    "fps": "unknown",
    "has_burned_subtitles": false,
    "subtitle_position": "none",
    "has_watermark": false,
    "watermark_position": "none",
    "has_top_title_overlay": false,
    "top_title_position": "none",
    "overall_summary": "",
    "content_type": "movie_recap"
  },
  "selected_source": {
    "platform": "",
    "url": "",
    "creator": "",
    "handle": "",
    "views": 0,
    "viralityScore": 0,
    "publishedAt": "",
    "comet_id": "",
    "comet_name": ""
  },
  "source_cleanup_scan": {
    "cleanup_required": false,
    "detected_issues": [],
    "recommended_cleanup_actions": [],
    "safe_caption_zones": ["bottom"],
    "manual_review_required": false,
    "notes": ""
  },
  "safety_scan": {
    "violence": {
      "exists": false,
      "timecodes": [],
      "note": ""
    },
    "sexual_content": {
      "exists": false,
      "timecodes": [],
      "note": ""
    },
    "gore_or_shocking": {
      "exists": false,
      "timecodes": [],
      "note": ""
    },
    "child_safety": {
      "exists": false,
      "timecodes": [],
      "note": ""
    },
    "sensitive_topic": {
      "exists": false,
      "timecodes": [],
      "note": ""
    },
    "monetization_risk": "low",
    "risk_note": ""
  },
  "characters": [
    {
      "character_id": "P-01",
      "display_name": "",
      "safe_display_name": "주인공",
      "visual_description": "",
      "role_in_story": "protagonist",
      "do_not_use_real_name": true
    }
  ],
  "story_structure": {
    "hook": {
      "timecode": "00:00.000",
      "visual_evidence": "",
      "reason": ""
    },
    "setup": {
      "timecode_range": "00:00.000~00:00.000",
      "summary": ""
    },
    "conflict": {
      "timecode_range": "00:00.000~00:00.000",
      "summary": ""
    },
    "turning_point": {
      "timecode_range": "00:00.000~00:00.000",
      "summary": ""
    },
    "reveal_or_climax": {
      "timecode_range": "00:00.000~00:00.000",
      "summary": ""
    },
    "ending": {
      "timecode_range": "00:00.000~00:00.000",
      "summary": ""
    }
  },
  "clips": [
    {
      "clip_id": "C-01",
      "source_id": "S-01",
      "raw_in": "00:00.000",
      "raw_out": "00:03.000",
      "safe_in": "00:00.100",
      "safe_out": "00:02.900",
      "duration_sec": 2.8,
      "visual_evidence": "15자 이상 구체적인 장면 묘사",
      "characters": ["P-01"],
      "action": "",
      "emotion": "unknown",
      "story_role": "hook",
      "angle": "MS",
      "camera_motion": "static",
      "visual_strength": 3,
      "story_importance": 3,
      "dopamine_strength": 3,
      "usable": true,
      "unusable_reason": "",
      "crop_mode_recommendation": "center",
      "manual_review_required": false,
      "risk_flags": []
    }
  ],
  "dopamine_anchors": [
    {
      "rank": 1,
      "clip_id": "C-01",
      "timecode": "00:00.000",
      "type": "shock",
      "strength": 5,
      "visual_evidence": "15자 이상 구체적인 장면 묘사",
      "why_it_works": ""
    }
  ],
  "recommended_story_angles": [
    {
      "angle_id": "A-01",
      "title": "",
      "core_argument": "",
      "recommended_duration_sec": 90,
      "reason": "",
      "required_clip_ids": ["C-01"],
      "risk_level": "low"
    }
  ],
  "unusable_ranges": [
    {
      "start": "00:00.000",
      "end": "00:00.000",
      "reason": ""
    }
  ],
  "algorithm_analysis": {
    "likely_positive_reactions": [],
    "likely_negative_reactions": [],
    "first_3_seconds_risk": "",
    "retention_driver": "",
    "completion_driver": "",
    "share_driver": "",
    "channel_fit_score": 0
  },
  "wow_point_extraction": {
    "wow_point_candidates": [
      {
        "scene": "",
        "emotion": "",
        "why_it_stops_scroll": "",
        "can_be_opening_hook": true,
        "risk": ""
      }
    ],
    "selected_opening_wow_point": "",
    "recommended_sequence": []
  },
  "guideline_review": {
    "risk_level": "low",
    "risky_phrases": [],
    "safe_replacements": [],
    "advertiser_friendly_score": 0,
    "policy_notes": [],
    "final_decision": "pass"
  },
  "integrity_check": {
    "all_timecodes_within_source_duration": true,
    "all_timecode_ranges_have_separator": true,
    "all_clips_have_visual_evidence": true,
    "all_visual_evidence_min_15_chars": true,
    "uncertain_items": [],
    "notes": ""
  }
}
```

## 2. Timecode 규칙

모든 타임코드는 아래 형식 중 하나를 사용한다.

```txt
MM:SS.mmm
```

또는 range:

```txt
MM:SS.mmm~MM:SS.mmm
```

금지:

```txt
00:05.00000:29.000
```

## 3. 검증 체크리스트

Phase2.5에서 사람이 확인해야 할 항목:

```json
{
  "checks": {
    "timecodes_ok": false,
    "key_scenes_ok": false,
    "dopamine_anchors_ok": false,
    "risks_reviewed": false,
    "cleanup_reviewed": false,
    "story_angles_ok": false,
    "ready_for_claude": false
  }
}
```

## 4. gemini_review.json 스키마

```json
{
  "status": "approved",
  "approved_at": "",
  "reviewer_notes": "",
  "checks": {
    "timecodes_ok": true,
    "key_scenes_ok": true,
    "dopamine_anchors_ok": true,
    "risks_reviewed": true,
    "cleanup_reviewed": true,
    "story_angles_ok": true,
    "ready_for_claude": true
  },
  "blocking_issues": [],
  "warnings": []
}
```

## 5. 승인 조건

Claude로 보낼 수 있는 조건:

```txt
gemini_review.status === approved
checks.timecodes_ok === true
checks.key_scenes_ok === true
checks.dopamine_anchors_ok === true
checks.risks_reviewed === true
checks.cleanup_reviewed === true
checks.story_angles_ok === true
checks.ready_for_claude === true
```

## 6. 반려 조건

아래 중 하나라도 있으면 needs_revision 또는 rejected.

* source duration이 맞지 않음
* timecode가 원본 길이를 초과함
* visual_evidence가 너무 추상적임
* dopamine_anchors가 쓸모없음
* safety risk가 누락됨
* source_cleanup_scan이 실제와 다름
* recommended_story_angles가 부실함
* clips가 너무 적거나 너무 많음
* Gemini가 영상에 없는 내용을 추측함

## 7. Claude 전달 원칙

Claude는 승인된 Gemini JSON만 받는다.

Claude는 다음 필드를 우선 근거로 사용한다.

* clips
* visual_evidence
* safe_in
* safe_out
* dopamine_anchors
* story_structure
* recommended_story_angles
* safety_scan
* source_cleanup_scan

Claude는 selected_source를 운영 메타로만 사용한다.

금지:

* selected_source title/description만 보고 영상 사실을 창작
* Gemini visual_evidence에 없는 장면 추가
* 타임코드 없는 장면 사용
* 원본 대본/자막 복사
* 작품명/실명 과다 사용
