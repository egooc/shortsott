# -*- coding: utf-8 -*-
"""source_evidence_map.json - 원본 증거 지도 (scene-evidence-architecture 지도 3분리의 1번).

vision_scene_map 의 셀들(각자 action_state: before/onset/peak/result/static)을 시간 순으로
걸어 **사건 객체**로 묶는다. 사건은 시간상 4점(setup/onset/peak/result)과 전후 상태를 가진다
- "명사는 맞는데 동사의 시간상이 틀리는" 나레이션을 원천에서 막는 좌표계다.

  python midform/scripts/build_evidence_map.py <compress_run_dir>

관찰 기록 전용: 요약·내레이션·재미 금지, 조기 제외 금지(제외는 아크 단계의 몫).
action_state 가 전혀 없는 옛 지도는 events=[] + 사유를 남긴다 (지도 재생성 필요).
"""
import io
import json
import os
import sys

ACTION_STATES = ("before", "onset", "peak", "result")


def load(run_dir, name):
    p = os.path.join(run_dir, name)
    if not os.path.exists(p):
        return None
    with io.open(p, encoding="utf-8-sig") as fh:
        return json.load(fh)


def dialogue_refs(cues, start, end):
    refs = []
    for i, cue in enumerate(cues or []):
        cs = float(cue.get("start_sec", cue.get("start", 0)) or 0)
        ce = float(cue.get("end_sec", cue.get("end", 0)) or 0)
        if ce > start and cs < end:
            refs.append({"cue_index": i, "start_sec": cs, "end_sec": ce,
                         "text": str(cue.get("text", ""))[:80]})
    return refs


def build_events(scenes, cues):
    events = []
    current = None

    def close(nxt_scene=None):
        nonlocal current
        if not current:
            return
        pts = current["event_points"]
        # 최소 성립 조건: onset 또는 peak 중 하나는 실제 관측
        if pts.get("onset") is None and pts.get("peak") is None:
            current = None
            return
        start = min(v for v in pts.values() if v is not None)
        end = max(v for v in pts.values() if v is not None)
        # result 가 없으면 마지막 관측 셀 끝까지
        end = max(end, current["last_scene_end"])
        observed = sum(1 for k in ("setup", "onset", "peak", "result") if pts.get(k) is not None)
        current["event"].update({
            "source_window": {"start": round(start, 3), "end": round(end, 3)},
            "after_state": current["event"].get("after_state")
                or (str(nxt_scene.get("visible_action", ""))[:120] if nxt_scene else ""),
            "confidence": round(observed / 4.0, 2),
            "dialogue_refs": dialogue_refs(cues, start, end)
        })
        events.append(current["event"])
        current = None

    prev_static = None
    for scene in scenes:
        state = str(scene.get("action_state", "")).strip()
        at = float(scene.get("sampled_frame_sec", scene.get("start_sec", 0)) or 0)
        scene_end = float(scene.get("end_sec", at) or at)
        action = str(scene.get("visible_action", ""))[:120]

        if state not in ACTION_STATES:
            close(scene)
            prev_static = scene
            continue

        if current is None:
            current = {
                "event": {
                    "event_id": f"E{len(events) + 1:03d}",
                    "event_points": None,  # 아래에서 참조로 대체
                    "visible_action": "",
                    "before_state": str((prev_static or {}).get("visible_action", ""))[:120],
                    "after_state": "",
                    "visible_entities": [],
                    "characters_visible_max": 0
                },
                "event_points": {"setup": None, "onset": None, "peak": None, "result": None},
                "last_scene_end": scene_end
            }
            current["event"]["event_points"] = current["event_points"]

        pts = current["event_points"]
        current["last_scene_end"] = max(current["last_scene_end"], scene_end)
        current["event"]["characters_visible_max"] = max(
            current["event"]["characters_visible_max"], int(scene.get("characters_visible") or 0))

        if state == "before" and pts["onset"] is None:
            pts["setup"] = at if pts["setup"] is None else pts["setup"]
            if not current["event"]["before_state"]:
                current["event"]["before_state"] = action
        elif state == "onset":
            # 이미 result 를 지난 뒤의 새 onset 은 다음 사건이다
            if pts["result"] is not None:
                close(scene)
                continue_scene = scene  # 재진입: 새 사건의 첫 셀로 처리
                # 간단화를 위해 재귀 대신 새 current 생성
                current = {
                    "event": {
                        "event_id": f"E{len(events) + 1:03d}",
                        "event_points": None,
                        "visible_action": action,
                        "before_state": str((prev_static or {}).get("visible_action", ""))[:120],
                        "after_state": "",
                        "visible_entities": [],
                        "characters_visible_max": int(scene.get("characters_visible") or 0)
                    },
                    "event_points": {"setup": None, "onset": at, "peak": None, "result": None},
                    "last_scene_end": scene_end
                }
                current["event"]["event_points"] = current["event_points"]
            elif pts["onset"] is None:
                pts["onset"] = at
                if not current["event"]["visible_action"]:
                    current["event"]["visible_action"] = action
        elif state == "peak":
            if pts["peak"] is None:
                pts["peak"] = at
            current["event"]["visible_action"] = action or current["event"]["visible_action"]
        elif state == "result":
            if pts["result"] is None:
                pts["result"] = at
                current["event"]["after_state"] = action

    close(None)
    return events


def main():
    run_dir = sys.argv[1] if len(sys.argv) > 1 else ""
    vm = load(run_dir, "vision_scene_map.json")
    if not vm:
        print(json.dumps({"error": "vision_scene_map.json missing"}))
        return 2
    scenes = sorted(vm.get("scenes", []), key=lambda s: float(s.get("start_sec", 0) or 0))
    transcript = load(run_dir, "transcript_timed.json") or []
    cues = transcript if isinstance(transcript, list) else transcript.get("cues", [])

    has_states = any(str(s.get("action_state", "")).strip() in ACTION_STATES + ("static",) for s in scenes)
    if not has_states:
        out = {"source_id": vm.get("source_id", ""), "events": [],
               "note": "vision map lacks action_state - regenerate the map with the 2026-09-07 schema"}
    else:
        events = build_events(scenes, cues)
        out = {"source_id": vm.get("source_id", ""),
               "scene_count": len(scenes),
               "events": events,
               "stats": {"events": len(events),
                         "with_full_arc": sum(1 for e in events if e["confidence"] >= 1.0),
                         "avg_confidence": round(sum(e["confidence"] for e in events) / len(events), 2) if events else 0}}

    out_path = os.path.join(run_dir, "source_evidence_map.json")
    with io.open(out_path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)
    print(json.dumps({"events": len(out.get("events", [])), "note": out.get("note", ""),
                      "stats": out.get("stats")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
