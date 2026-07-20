function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().toLowerCase() !== 'none';
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function unique(values) {
  return Array.from(new Set(values.filter((value) => value !== undefined && value !== null && String(value).trim() !== '')));
}

function sortedScenes(geminiAnalysis) {
  return (Array.isArray(geminiAnalysis?.scenes) ? geminiAnalysis.scenes : [])
    .filter((scene) => isObject(scene))
    .map((scene, index) => ({
      ...scene,
      scene_id: String(scene.scene_id || `scene_${String(index + 1).padStart(3, '0')}`),
      start_sec: toNumber(scene.start_sec, 0),
      end_sec: toNumber(scene.end_sec, toNumber(scene.start_sec, 0)),
      duration_sec: toNumber(scene.duration_sec, Math.max(0, toNumber(scene.end_sec, 0) - toNumber(scene.start_sec, 0)))
    }))
    .sort((a, b) => a.start_sec - b.start_sec);
}

function determineTargetBeatCount(sceneCount, options = {}) {
  const minBeats = clamp(toNumber(options.minBeats, 8), 3, 20);
  const maxBeats = clamp(toNumber(options.maxBeats, 15), minBeats, 20);
  if (Number.isFinite(Number(options.targetBeats))) {
    return clamp(Number(options.targetBeats), minBeats, maxBeats);
  }
  if (sceneCount <= maxBeats) return sceneCount;
  return clamp(Math.ceil(sceneCount / 4), minBeats, maxBeats);
}

function storyRoleForOrder(order, totalBeats) {
  if (totalBeats <= 1) return 'hook';
  const progress = (order - 1) / (totalBeats - 1);
  if (progress < 0.14) return 'hook';
  if (progress < 0.34) return 'setup';
  if (progress < 0.70) return 'conflict';
  if (progress < 0.90) return 'climax';
  return 'ending';
}

function safetyFlagsForScenes(safetyScan, scenes) {
  const flags = [];
  const ranges = scenes.map((scene) => ({ start: scene.start_sec, end: scene.end_sec }));
  for (const [key, item] of Object.entries(safetyScan || {})) {
    if (!item || item.present !== true || !Array.isArray(item.timecodes)) continue;
    const overlaps = item.timecodes.some((timecode) => {
      const value = Number(timecode);
      return Number.isFinite(value) && ranges.some((range) => value >= range.start && value <= range.end);
    });
    if (overlaps) flags.push(key);
  }
  return flags;
}

function summarizeActions(scenes) {
  const actions = scenes
    .map((scene) => String(scene.visible_action || '').trim())
    .filter(Boolean);
  if (actions.length <= 2) return actions.join(' / ');
  return `${actions[0]} / ${actions[Math.floor(actions.length / 2)]} / ${actions[actions.length - 1]}`;
}

function keyDialogues(scenes) {
  return scenes
    .filter((scene) => hasText(scene.dialogue_or_caption))
    .map((scene) => ({
      scene_id: scene.scene_id,
      text: String(scene.dialogue_or_caption).trim(),
      dialogue_importance: String(scene.dialogue_importance || 'none'),
      dialogue_function: String(scene.dialogue_function || 'none'),
      should_preserve_original_dialogue: scene.should_preserve_original_dialogue === true,
      dialogue_preserve_reason: String(scene.dialogue_preserve_reason || ''),
      translated_caption_ko: String(scene.translated_caption_ko || ''),
      recap_bridge_before: String(scene.recap_bridge_before || ''),
      recap_bridge_after: String(scene.recap_bridge_after || '')
    }));
}

function sourceSceneRefs(scenes) {
  return scenes.map((scene) => ({
    scene_id: scene.scene_id,
    start_sec: scene.start_sec,
    end_sec: scene.end_sec,
    duration_sec: scene.duration_sec,
    shot_type: String(scene.shot_type || 'unknown'),
    characters_visible: Array.isArray(scene.characters_visible) ? scene.characters_visible : []
  }));
}

function createBeat(scenes, order, totalBeats, safetyScan) {
  const first = scenes[0];
  const last = scenes[scenes.length - 1];
  const start = first ? first.start_sec : 0;
  const end = last ? last.end_sec : start;
  const dialogues = keyDialogues(scenes);
  const characters = unique(scenes.flatMap((scene) => Array.isArray(scene.characters_visible) ? scene.characters_visible : []));
  const shotTypes = unique(scenes.map((scene) => String(scene.shot_type || 'unknown')));

  return {
    beat_id: `beat_${String(order).padStart(2, '0')}`,
    order,
    story_role: storyRoleForOrder(order, totalBeats),
    start_sec: start,
    end_sec: end,
    duration_sec: Number(Math.max(0, end - start).toFixed(3)),
    source_scene_ids: scenes.map((scene) => scene.scene_id),
    source_scenes: sourceSceneRefs(scenes),
    primary_characters: characters,
    shot_types: shotTypes,
    visual_summary: summarizeActions(scenes),
    key_dialogue_or_caption: dialogues,
    safety_flags: safetyFlagsForScenes(safetyScan, scenes),
    edit_focus: dialogues.length > 0 ? 'dialogue_and_reaction' : (shotTypes.includes('action') ? 'action_continuity' : 'visual_context')
  };
}

function groupScenesByDuration(scenes, targetBeatCount) {
  if (scenes.length <= targetBeatCount) return scenes.map((scene) => [scene]);

  const totalDuration = scenes.reduce((sum, scene) => sum + Math.max(0, scene.duration_sec), 0);
  const targetDuration = totalDuration > 0 ? totalDuration / targetBeatCount : scenes.length / targetBeatCount;
  const groups = [];
  let current = [];
  let currentDuration = 0;

  scenes.forEach((scene, index) => {
    const remainingScenes = scenes.length - index;
    const remainingGroups = targetBeatCount - groups.length;
    const mustLeaveScenes = remainingScenes <= remainingGroups;
    const shouldClose = current.length > 0
      && groups.length < targetBeatCount - 1
      && currentDuration >= targetDuration
      && !mustLeaveScenes;

    if (shouldClose) {
      groups.push(current);
      current = [];
      currentDuration = 0;
    }

    current.push(scene);
    currentDuration += Math.max(0, scene.duration_sec);
  });

  if (current.length) groups.push(current);

  while (groups.length > targetBeatCount) {
    const last = groups.pop();
    groups[groups.length - 1].push(...last);
  }

  return groups;
}

function buildSceneIndex(scenes) {
  return scenes.map((scene) => ({
    scene_id: scene.scene_id,
    start_sec: scene.start_sec,
    end_sec: scene.end_sec,
    dialogue_or_caption: hasText(scene.dialogue_or_caption) ? String(scene.dialogue_or_caption).trim() : '',
    dialogue_importance: String(scene.dialogue_importance || 'none'),
    dialogue_function: String(scene.dialogue_function || 'none'),
    should_preserve_original_dialogue: scene.should_preserve_original_dialogue === true,
    dialogue_preserve_reason: String(scene.dialogue_preserve_reason || ''),
    translated_caption_ko: String(scene.translated_caption_ko || ''),
    recap_bridge_before: String(scene.recap_bridge_before || ''),
    recap_bridge_after: String(scene.recap_bridge_after || ''),
    visible_action: String(scene.visible_action || '').trim()
  }));
}

function condenseGeminiAnalysis(geminiAnalysis, options = {}) {
  const scenes = sortedScenes(geminiAnalysis);
  const targetBeatCount = determineTargetBeatCount(scenes.length, options);
  const groups = groupScenesByDuration(scenes, targetBeatCount);
  const sceneBeats = groups.map((group, index) => createBeat(group, index + 1, groups.length, geminiAnalysis?.safety_scan || {}));

  return {
    source: geminiAnalysis?.source || {},
    story_context: geminiAnalysis?.story_context || {},
    characters: Array.isArray(geminiAnalysis?.characters) ? geminiAnalysis.characters : [],
    safety_scan: geminiAnalysis?.safety_scan || {},
    scene_condensation: {
      original_scene_count: scenes.length,
      condensed_beat_count: sceneBeats.length,
      target_beat_count: targetBeatCount,
      method: 'duration_balanced_contiguous_scene_beats_v1',
      note: 'Claude should write from scene_beats while preserving original scene_id references in source_scenes.'
    },
    scene_beats: sceneBeats,
    full_scene_index: buildSceneIndex(scenes)
  };
}

module.exports = {
  condenseGeminiAnalysis,
  determineTargetBeatCount,
  groupScenesByDuration
};
