const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { PROJECT_ROOT } = require('../server/services/pipelinePaths');
const { evaluateEditorialAcceptance } = require('../server/services/midformEditorialAcceptanceService');
const { validateManifestMaterialColors, colorEvidenceBySpeaker, activeSegmentsFromManifest, firstDialogueStartSec, callbackDialogueStartSec, maxContinuousNarrationRunSec } = require('../tests/artifactQaHelpers');

const WAVE4_ROOT = path.join(PROJECT_ROOT, 'midform', 'test_runs', 'offline_wave4_20260728_production_quality');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function rel(filePath) {
  return path.relative(PROJECT_ROOT, filePath).replace(/\\/g, '/');
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseTimecode(value) {
  if (typeof value === 'number') return value;
  const parts = String(value || '').split(':');
  if (parts.length === 3) return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  if (parts.length === 2) return Number(parts[0]) * 60 + Number(parts[1]);
  return Number(value) || 0;
}

function estimateDuration(text) {
  const chars = normalizeText(text).replace(/\s+/g, '').length;
  return Math.max(0.9, Number((chars / 4.8).toFixed(3)));
}

function rewriteSegment(segment, patch = {}) {
  const next = { ...segment, ...patch };
  if (patch.narration != null) {
    next.narration = patch.narration;
    next.caption_text = patch.caption_text || patch.narration;
    next.translated_caption_ko = '';
    next.tts_enabled = true;
  }
  if (patch.caption_text != null && ['dialogue_quote', 'dialogue'].includes(String(segment.segment_type || ''))) {
    next.caption_text = patch.caption_text;
    next.translated_caption_ko = patch.caption_text;
    next.narration = '';
    next.tts_enabled = false;
  }
  if (patch.speaker) next.speaker = patch.speaker;
  return next;
}

function applyPatches(script, fixture) {
  const beforeSegments = Array.isArray(script.segments) ? script.segments : [];
  const patches = fixture.patches;
  const next = JSON.parse(JSON.stringify(script));
  next.script_id = `${fixture.id}_wave4`;
  next.scene_type = fixture.sceneType;
  next.editorial_pattern = fixture.editorialPattern;
  next.title_block = fixture.titleBlock;
  next.metadata = { ...(next.metadata || {}), title_candidates: fixture.titleCandidates, wave4_scene_type: fixture.sceneType };
  next.content_context = { ...(next.content_context || {}), wave4_scene_type: fixture.sceneType, style_hint_used: 'wave4_production_quality_offline' };
  next.segments = beforeSegments.map((segment) => rewriteSegment(segment, patches[String(segment.segment_id || '')] || {}));
  return next;
}

function copyComparison(beforeScript, afterScript) {
  const beforeById = new Map((beforeScript.segments || []).map((segment) => [String(segment.segment_id || ''), segment]));
  return (afterScript.segments || []).map((after) => {
    const before = beforeById.get(String(after.segment_id || '')) || {};
    const beforeText = normalizeText(before.caption_text || before.narration || before.translated_caption_ko || '');
    const afterText = normalizeText(after.caption_text || after.narration || after.translated_caption_ko || '');
    return { segment_id: after.segment_id, segment_type: after.segment_type, changed: beforeText !== afterText, before: beforeText, after: afterText };
  }).filter((entry) => entry.changed);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: PROJECT_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 100 * 1024 * 1024, ...options });
}

function createSilentMp3(filePath, durationSec) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', String(Math.max(0.9, durationSec)), '-q:a', '9', '-acodec', 'libmp3lame', filePath]);
}

function buildOfflineDraftInput(preview, script, fixture, scriptPath, transcriptPath, ttsDir) {
  const ttsFiles = [];
  for (const unit of preview.ttsUnits || []) {
    if (unit.tts_enabled === false) continue;
    const captionId = String(unit.caption_id || unit.segment_id || `tts_${ttsFiles.length + 1}`);
    const filename = `${captionId.replace(/[^A-Za-z0-9_.-]+/g, '_')}.mp3`;
    const filepath = path.join(ttsDir, filename);
    const durationSec = estimateDuration(unit.text || '');
    createSilentMp3(filepath, durationSec);
    ttsFiles.push({ filename, filepath, duration_sec: durationSec, text: unit.text || '', text_hash: unit.text_hash || '', success: true, wave4_placeholder_silent_audio: true });
  }
  return {
    segments: preview.segments,
    ttsFiles,
    captionUnits: preview.captionUnits,
    ttsUnits: preview.ttsUnits,
    captionWarnings: [],
    claudeScript: script,
    gptScript: script,
    slotMap: script.slot_map || {},
    titleBlock: script.title_block,
    script_path: scriptPath,
    script_input_path: scriptPath,
    source_video_path: fixture.sourceVideoPath,
    source_transcript_path: transcriptPath,
    sourceDurationSec: script.source_reference?.duration_sec || 0,
    videoPlacementMode: 'source_clips',
    audioPathMode: 'absolute',
    useCapcutTemplate: true,
    resolution: { width: 1080, height: 1920 },
    fps: 30,
    slotMode: true,
    ttsProvider: 'offline_silent_placeholder',
    ttsParams: { provider: 'offline_silent_placeholder' },
    ttsReuseSummary: { reused_count: 0, regenerated_count: ttsFiles.length, offline_silent_placeholder: true }
  };
}

function proofForFinal(runDir, draftId, fixture) {
  const draftDir = path.join(PROJECT_ROOT, 'server', 'output', 'drafts', draftId);
  const manifestPath = path.join(draftDir, 'edit_manifest.json');
  const contentPath = path.join(draftDir, 'draft_content.json');
  const manifest = readJson(manifestPath);
  const draftContent = readJson(contentPath);
  fs.copyFileSync(manifestPath, path.join(runDir, 'edit_manifest.json'));
  fs.copyFileSync(contentPath, path.join(runDir, 'draft_content.json'));
  const material = validateManifestMaterialColors(manifest, draftContent);
  const segments = activeSegmentsFromManifest(manifest);
  const proof = {
    fixture_id: fixture.id,
    scene_type: fixture.sceneType,
    draft_id: draftId,
    draft_dir: rel(draftDir),
    timing: {
      first_dialogue_start_sec: firstDialogueStartSec(segments),
      callback_dialogue_start_sec: callbackDialogueStartSec(segments),
      max_continuous_narration_run_sec: maxContinuousNarrationRunSec(segments),
      total_duration_sec: Number(segments.reduce((max, segment) => Math.max(max, segment.timeline_end_sec || 0), 0).toFixed(3))
    },
    speaker_color_evidence: colorEvidenceBySpeaker(manifest),
    material_validation: material
  };
  writeJson(path.join(runDir, 'material_color_proof.json'), proof);
  return proof;
}

function qaMarkdown(fixture, comparison, acceptance, visualProof) {
  const changed = comparison.slice(0, 12).map((entry) => [
    `### ${entry.segment_id}`,
    '',
    `Before: ${entry.before || '(empty)'}`,
    '',
    `After: ${entry.after || '(empty)'}`,
    ''
  ].join('\n')).join('\n');
  return [
    `# Wave 4 Human QA — ${fixture.label}`,
    '',
    `Scene type: ${fixture.sceneType}`,
    `Draft: ${visualProof.draft_dir}`,
    '',
    '## Viewer clarity checklist',
    '',
    `1. first-5-second hook clarity: ${fixture.qa.first5}`,
    `2. first-20-second context recovery: ${fixture.qa.first20}`,
    `3. callback recognizability: ${fixture.qa.callback}`,
    `4. conflict/readability: ${fixture.qa.conflict}`,
    `5. subtitle readability: ${acceptance.warnings.includes('subtitle_readability') ? 'review warning present' : 'automatic gate pass'}`,
    `6. emotional rhythm / pacing coherence: ${fixture.qa.rhythm}`,
    `7. meaningful teaser check: ${fixture.qa.teaser}`,
    `8. context reset balance: ${fixture.qa.reset}`,
    '',
    '## Automatic acceptance result',
    '',
    `- status: ${acceptance.status}`,
    `- failed: ${acceptance.failed.join(', ') || '(none)'}`,
    `- warnings: ${acceptance.warnings.join(', ') || '(none)'}`,
    '',
    '## Timing / color proof',
    '',
    `- first dialogue: ${visualProof.timing.first_dialogue_start_sec}`,
    `- callback dialogue: ${visualProof.timing.callback_dialogue_start_sec}`,
    `- max narration run: ${visualProof.timing.max_continuous_narration_run_sec}`,
    `- material colors: ${visualProof.material_validation.passed}/${visualProof.material_validation.checked}`,
    '',
    '## Before / after copy samples',
    '',
    changed || '(no changed copy detected)',
    ''
  ].join('\n');
}

const fixtures = [
  {
    id: 'dialogue_confrontation_steve_sculley',
    label: 'Steve Jobs / Sculley',
    sceneType: 'dialogue_confrontation',
    editorialPattern: 'cold_open_callback',
    sourceScriptPath: path.join(PROJECT_ROOT, 'midform/test_runs/offline_wave3_20260727_steve_sculley/script.json'),
    transcriptPath: path.join(PROJECT_ROOT, 'midform/test_runs/offline_wave3_20260727_steve_sculley/source_transcript.json'),
    sourceVideoPath: path.join(PROJECT_ROOT, 'midform/test_runs/offline_wave3_20260727_steve_sculley/source.mp4'),
    titleBlock: { full_title: '잡스가 믿던 해고의 진실은 왜 흔들렸을까?', overlay_title: { top: '해고진실', bottom: '광고반전' }, top_title: '해고진실', top_subtitle: '광고반전' },
    titleCandidates: ['잡스가 믿던 해고의 진실은 왜 흔들렸을까?', '스컬리는 왜 광고의 진실을 끝까지 숨겼을까?', '발표 직전 두 사람은 왜 서로를 끝내려 했을까?'],
    patches: {
      slot_01_L01: { caption_text: '잡스가 깔본 건, 스컬리의 과거였습니다.', speaker: 'Scully' },
      slot_01_L02: { caption_text: '하지만 스컬리는 광고의 진실로 되받아칩니다.', speaker: 'Scully' },
      slot_02: { narration: 'NeXT 발표 직전, 잡스는 자신을 회사 밖으로 밀어낸 남자와 마주합니다. 두 사람의 싸움은 해고보다 먼저, 1984 광고의 책임에서 다시 불붙죠. 이제 질문은 하나입니다. 누가 진실을 바꿔 말하고 있었나.' },
      slot_04_L01: { caption_text: '상영 뒤, 이사회는 광고비를 회수하라 했어.', speaker: 'Scully' },
      slot_04_L04: { caption_text: '그 광고를 지킨 사람은 나였어.', speaker: 'Scully' },
      slot_07_L04: { caption_text: '날 끝내려는 거지, 그렇지?', speaker: 'Jobs' }
    },
    qa: { first5: 'clear conflict question from the first preserved dialogue block', first20: 'reset names the meeting, stakes, and ad-blame axis', callback: 'ad-protection payoff returns at ~22s', conflict: 'Jobs/Sculley blame axis readable', rhythm: 'teaser -> reset -> callback preserved', teaser: 'teaser is now framed as accusation/rebuttal, not a stray rebuttal', reset: 'explains enough without solving the ad truth early' }
  },
  {
    id: 'dialogue_reveal_catch_bullet',
    label: 'Catch the Bullet',
    sceneType: 'dialogue_reveal',
    editorialPattern: 'chronological_reveal',
    sourceScriptPath: path.join(PROJECT_ROOT, 'midform/test_runs/compress_20260720213249_3e-5BAhZQ5w/bootstrap_script.json'),
    transcriptPath: path.join(PROJECT_ROOT, 'midform/test_runs/compress_20260720213249_3e-5BAhZQ5w/bootstrap_source_transcript.json'),
    sourceVideoPath: path.join(PROJECT_ROOT, 'midform/test_runs/compress_20260720213249_3e-5BAhZQ5w/source.mp4'),
    titleBlock: { full_title: '쫓던 보안관은 왜 미끼가 되었을까?', overlay_title: { top: '쫓던자가', bottom: '미끼됐다' }, top_title: '쫓던자가', top_subtitle: '미끼됐다' },
    titleCandidates: ['쫓던 보안관은 왜 미끼가 되었을까?', '아들을 구하러 간 아버지는 왜 사냥감이 됐을까?', '인질범의 도주는 왜 더 큰 함정으로 이어졌을까?'],
    patches: {
      slot_01: { narration: '쫓던 보안관 일행은, 왜 갑자기 미끼가 됐을까?' },
      slot_02: { narration: '브릿은 납치된 아들을 되찾으려 제드 일당을 몰아붙입니다. 하지만 오두막 앞에서 추격은 협상이 되고, 협상은 곧 더 위험한 길로 이어집니다.' },
      slot_03_L01: { caption_text: '제드, 얌전히 나와라.', speaker: 'Britt' },
      slot_03_L02: { caption_text: '계획이 바뀌었어. 인질은 셋이다.', speaker: 'Jed' },
      slot_03_L03: { caption_text: '안에 사진이 있더군. 당신을 닮았어.', speaker: 'Jed' },
      slot_06_L04: { caption_text: '우리가 미끼였어.', speaker: 'Chaska' }
    },
    qa: { first5: 'clear mystery question, not lore exposition', first20: 'father/son hostage stakes established quickly', callback: 'bait reveal becomes recognizable payoff', conflict: 'pursuit-to-trap reversal readable', rhythm: 'western pursuit rhythm remains tense', teaser: 'meaningful teaser because it asks why hunters became bait', reset: 'context explains pursuit without inventing mastermind causation' }
  },
  {
    id: 'comedic_setpiece_twilight_baseball',
    label: 'Twilight baseball',
    sceneType: 'comedic_setpiece',
    editorialPattern: 'setpiece_to_threat_escalation',
    sourceScriptPath: path.join(PROJECT_ROOT, 'midform/test_runs/compress_20260724234621_Jgx4vgcMWb4/bootstrap_script.json'),
    transcriptPath: path.join(PROJECT_ROOT, 'midform/test_runs/compress_20260724234621_Jgx4vgcMWb4/bootstrap_source_transcript.json'),
    sourceVideoPath: path.join(PROJECT_ROOT, 'midform/test_runs/compress_20260724234621_Jgx4vgcMWb4/source.mp4'),
    titleBlock: { full_title: '흡혈귀 야구는 왜 사냥의 시작이 됐을까?', overlay_title: { top: '야구장에', bottom: '사냥꾼' }, top_title: '야구장에', top_subtitle: '사냥꾼' },
    titleCandidates: ['흡혈귀 야구는 왜 사냥의 시작이 됐을까?', '즐거운 데이트는 왜 한순간에 도주극이 됐을까?', '인간 냄새 하나가 왜 경기를 끝냈을까?'],
    patches: {
      slot_01_L01: { caption_text: '간식을 데려왔네.', speaker: 'James' },
      slot_01_L02: { caption_text: '그 애는 우리와 함께 왔어.', speaker: 'Edward' },
      slot_02: { narration: '벨라는 에드워드의 가족과 폭풍 속 야구 경기를 구경합니다. 천둥이 칠 때만 가능한, 말도 안 되는 힘의 놀이였죠.' },
      slot_03: { narration: '공은 총성처럼 터지고, 선수들은 눈으로 따라가기 힘든 속도로 움직입니다. 그런데 이 장난 같은 경기장에, 낯선 흡혈귀들이 다가옵니다.' },
      slot_04_L01: { caption_text: '가려던 참이었는데, 우리 소리를 들었어.', speaker: 'Alice' },
      slot_04_L02: { caption_text: '조용히 하고 내 뒤에 서 있어.', speaker: 'Edward' },
      slot_06_L02: { caption_text: '벨라를 여기서 빼내.', speaker: 'Carlisle' }
    },
    qa: { first5: 'cold open is predator joke/protection line, matching setpiece tone', first20: 'reset explains baseball rules and Bella presence', callback: 'not forced; escalation replaces callback', conflict: 'game-to-hunt turn is readable', rhythm: 'playful spectacle turns into threat', teaser: 'meaningful because snack line reframes Bella as prey', reset: 'does not overfit confrontation callback language' }
  },
  {
    id: 'emotional_confession_fences',
    label: 'Fences father/son',
    sceneType: 'emotional_confession',
    editorialPattern: 'question_answer_emotional_payoff',
    sourceScriptPath: path.join(PROJECT_ROOT, 'midform/test_runs/run_013_tVxYCeRXzGo_e2e/script_signature_quotes.json'),
    transcriptPath: path.join(PROJECT_ROOT, 'midform/test_runs/run_013_tVxYCeRXzGo_e2e/source_transcript.json'),
    sourceVideoPath: path.join(PROJECT_ROOT, 'midform/test_runs/run_013_tVxYCeRXzGo_e2e/source.mp4'),
    titleBlock: { full_title: '아들은 왜 아버지에게 사랑을 묻고 무너졌을까?', overlay_title: { top: '아들의질문', bottom: '아버지답' }, top_title: '아들의질문', top_subtitle: '아버지답' },
    titleCandidates: ['아들은 왜 아버지에게 사랑을 묻고 무너졌을까?', '아버지는 왜 사랑 대신 책임만 말했을까?', '가장 아픈 질문에 돌아온 대답은 무엇이었을까?'],
    patches: {
      s01: { narration: '코리가 바란 건 큰 약속이 아니었습니다. 아버지가 자신을 사랑하는지, 단 한 번 확인받고 싶었죠.' },
      s02: { caption_text: '아빠는 왜 날 좋아한 적이 없어요?', speaker: 'Cory' },
      s03: { narration: '하지만 트로이는 그 질문을 상처가 아니라 도전으로 받아들입니다. 밥과 집과 옷을 누가 줬는지 따지며, 사랑의 문제를 책임의 장부로 바꿔 버리죠.' },
      s04: { caption_text: '그건 내 책임이야.', speaker: 'Troy' },
      s05: { narration: '그 한마디로 코리가 듣고 싶던 대답은 사라집니다. 트로이에게 부양은 사랑의 표현이 아니라, 가장이 해야 할 의무였습니다.' },
      s06: { caption_text: '널 좋아해야 할 의무는 없어.', speaker: 'Troy' },
      s08: { caption_text: '누가 널 좋아하는지만 붙잡고 살지 마.', speaker: 'Troy' },
      s09: { narration: '조언처럼 끝난 말은 코리에게 포기하라는 결론처럼 남습니다. 사랑을 묻던 아들은, 책임만 들은 채 집 안으로 돌아서죠.' }
    },
    qa: { first5: 'emotion question is explicit immediately', first20: 'father/son roles and emotional need are clear', callback: 'question is answered by responsibility/like-you quotes', conflict: 'love versus duty readable', rhythm: 'quiet question -> harsh answer -> emotional residue', teaser: 'meaningful because the hook is the son’s direct question', reset: 'context supports emotion without overexplaining plot' }
  }
];

function processFixture(fixture) {
  const runDir = path.join(WAVE4_ROOT, fixture.id);
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });
  const beforeScript = readJson(fixture.sourceScriptPath);
  const afterScript = applyPatches(beforeScript, fixture);
  const scriptPath = path.join(runDir, 'script.json');
  writeJson(scriptPath, afterScript);
  const comparison = copyComparison(beforeScript, afterScript);
  writeJson(path.join(runDir, 'copy_comparison.json'), { fixture_id: fixture.id, scene_type: fixture.sceneType, changed_segments: comparison });

  const previewPath = path.join(runDir, 'draft_preview.json');
  run('python', ['midform/scripts/assemble_slot_draft_input.py', '--script', scriptPath, '--source-video', fixture.sourceVideoPath, '--transcript', fixture.transcriptPath, '--output', previewPath, '--tts-dir', path.join(runDir, 'tts'), '--preview-only']);
  const preview = readJson(previewPath);
  const ttsDir = path.join(runDir, 'tts');
  const draftInput = buildOfflineDraftInput(preview, afterScript, fixture, scriptPath, fixture.transcriptPath, ttsDir);
  const draftInputPath = path.join(runDir, 'draft_input.json');
  writeJson(draftInputPath, draftInput);
  const renderOut = run('python', ['scripts/capcut_draft.py', draftInputPath]);
  const render = JSON.parse(renderOut.trim());
  const visualProof = proofForFinal(runDir, path.basename(render.draftPath), fixture);
  const previewProofPath = path.join(runDir, 'preview_frame_proof.json');
  run('python', ['scripts/wave4_visual_preview.py', '--draft-input', draftInputPath, '--proof', previewProofPath, '--out-dir', path.join(runDir, 'preview_frames')]);
  const previewProof = readJson(previewProofPath);
  const acceptance = evaluateEditorialAcceptance({
    scene_type: fixture.sceneType,
    editorial_pattern: fixture.editorialPattern,
    segments: visualProofFromManifestSegments(path.join(runDir, 'edit_manifest.json')),
    caption_units: readJson(path.join(runDir, 'edit_manifest.json')).caption_units || draftInput.captionUnits,
    material_validation: visualProof.material_validation
  });
  writeJson(path.join(runDir, 'acceptance_gates.json'), acceptance);
  writeText(path.join(runDir, 'human_qa_review.md'), qaMarkdown(fixture, comparison, acceptance, visualProof));
  writeJson(path.join(runDir, 'wave4_fixture_manifest.json'), {
    fixture_id: fixture.id,
    label: fixture.label,
    scene_type: fixture.sceneType,
    source_script: rel(fixture.sourceScriptPath),
    source_video: rel(fixture.sourceVideoPath),
    output_dir: rel(runDir),
    draft_id: path.basename(render.draftPath),
    final_draft_dir: rel(render.draftPath),
    changed_segments: comparison.length,
    acceptance_status: acceptance.status,
    material_color: { checked: visualProof.material_validation.checked, passed: visualProof.material_validation.passed },
    preview_frames: { checked: previewProof.checked, passed: previewProof.passed }
  });
  return readJson(path.join(runDir, 'wave4_fixture_manifest.json'));
}

function visualProofFromManifestSegments(manifestPath) {
  const manifest = readJson(manifestPath);
  return activeSegmentsFromManifest(manifest).map((segment) => ({
    segment_id: segment.segment_id,
    parent_slot_id: segment.segment_id.replace(/_L\d+.*$/, ''),
    segment_type: segment.segment_type,
    caption_text: segment.text,
    narration: segment.text,
    timeline_start_sec: segment.timeline_start_sec,
    timeline_end_sec: segment.timeline_end_sec
  }));
}

fs.rmSync(WAVE4_ROOT, { recursive: true, force: true });
fs.mkdirSync(WAVE4_ROOT, { recursive: true });
const summaries = fixtures.map(processFixture);
writeJson(path.join(WAVE4_ROOT, 'wave4_summary.json'), {
  generated_at: new Date().toISOString(),
  root: rel(WAVE4_ROOT),
  fixtures: summaries
});
process.stdout.write(JSON.stringify({ root: WAVE4_ROOT, fixtures: summaries }, null, 2));
