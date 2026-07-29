const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildLocaleDraftInput,
  generateLocaleDraftArtifacts,
  placementBySlot,
  replanJaDraftSpecForFinalOverlap,
  secondsToTimecode
} = require('../server/services/midformLocaleDraftService');

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function secondsFromTimecode(value) {
  const parts = String(value || '').split(':').map(Number);
  if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  if (parts.length === 2) return (parts[0] * 60) + parts[1];
  return Number(value || 0);
}

function videoSegmentFromSourceScene(segment, index) {
  const scene = segment.source_scenes?.[0] || {};
  const startSec = secondsFromTimecode(scene.start);
  const endSec = secondsFromTimecode(scene.end);
  const targetStartSec = index * 4;
  const durationSec = Math.max(0.001, endSec - startSec);
  return {
    id: segment.locale_clip_id || segment.segment_id,
    material_id: 'source-video-material',
    source_timerange: { start: Math.round(startSec * 1_000_000), duration: Math.round(durationSec * 1_000_000) },
    target_timerange: { start: Math.round(targetStartSec * 1_000_000), duration: Math.round(durationSec * 1_000_000) }
  };
}

test('secondsToTimecode formats locale source ranges for CapCut source_scenes', () => {
  assert.equal(secondsToTimecode(4.2), '00:04.200');
  assert.equal(secondsToTimecode(65.125), '01:05.125');
  assert.equal(secondsToTimecode(3661.5), '01:01:01.500');
});

test('placementBySlot maps locale clip ids back to base slot ids', () => {
  const map = placementBySlot({
    clip_placement: [
      { clip_id: 'ko_slot_01', source_range: [10, 14] },
      { clip_id: 'ko_slot_02_L01', source_range: [30, 32] }
    ]
  });

  assert.deepEqual(map.get('slot_01').source_range, [10, 14]);
  assert.deepEqual(map.get('slot_02_L01').source_range, [30, 32]);
});

test('buildLocaleDraftInput rewrites video source_scenes from draft_spec without changing caption units', () => {
  const baseDraftInput = {
    segments: [
      {
        segment_id: 'slot_01_L01',
        parent_slot_id: 'slot_01',
        caption_text: '첫 대사',
        speaker_id: 'jobs',
        speaker_alias: 'Jobs',
        speaker_color_key: '남주',
        caption_kind: 'dialogue',
        source_utterance_id: 'utt_001',
        source_scenes: [{ start: '00:01.000', end: '00:03.000' }],
        story_anchor: { source_range_hint: [1, 1] }
      },
      {
        segment_id: 'slot_02',
        caption_text: '나레이션',
        source_scenes: [{ start: '00:10.000', end: '00:20.000' }],
        story_anchor: { source_range_hint: [10, 10] }
      }
    ],
    captionUnits: [{ caption_id: 'cap_001', segment_id: 'slot_01_L01', segment_type: 'dialogue_quote', text: '첫 대사' }],
    ttsFiles: [],
    resolution: { width: 1080, height: 1920 },
    fps: 30
  };
  const draftSpec = {
    locale: 'ja',
    clip_placement: [
      { clip_id: 'ja_slot_01', source_range: [40, 44], visual_role: 'cold_open' },
      { clip_id: 'ja_slot_02', source_range: [80, 90], visual_role: 'bridge' }
    ]
  };

  const localeInput = buildLocaleDraftInput(baseDraftInput, draftSpec, 'ja');

  assert.equal(localeInput.locale, 'ja');
  assert.equal(localeInput.draftName, 'draft_ja');
  assert.equal(localeInput.draft_output_mode, 'folder_only');
  assert.equal(localeInput.package_zip, false);
  assert.equal(localeInput.captionUnits.length, baseDraftInput.captionUnits.length);
  assert.equal(localeInput.captionUnits[0].text, baseDraftInput.captionUnits[0].text);
  assert.equal(localeInput.segments[0].source_scenes[0].start, '00:40.000');
  assert.equal(localeInput.segments[0].source_scenes[0].end, '00:44.000');
  assert.equal(localeInput.segments[0].source_clips[0].start, '00:40.000');
  assert.equal(localeInput.segments[0].source_clips[0].source, 'locale_draft_spec');
  assert.deepEqual(localeInput.segments[0].story_anchor.source_range_hint, [40, 44]);
  assert.equal(localeInput.segments[0].speaker_id, 'jobs');
  assert.equal(localeInput.captionUnits[0].speaker_id, 'jobs');
  assert.equal(localeInput.captionUnits[0].speaker_color_key, '남주');
  assert.equal(localeInput.captionUnits[0].caption_color, '#00A9F7');
  assert.equal(localeInput.captionUnits[0].source_utterance_id, 'utt_001');
  assert.equal(localeInput.segments[1].source_scenes[0].start, '01:20.000');
  assert.equal(localeInput.segments[1].source_scenes[0].end, '01:30.000');
  assert.equal(localeInput.segments[1].source_clips[0].end, '01:30.000');
  assert.equal(localeInput.segments[0].locale_source_override, true);
});

test('generateLocaleDraftArtifacts creates separate folder-only KO/JA draft artifacts and final overlap report', async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'midform-locale-drafts-'));
  const baseDraftInputPath = path.join(workspaceDir, 'draft_input.json');
  writeJson(baseDraftInputPath, {
    segments: [
      { segment_id: 'slot_01', caption_text: '첫 장면', source_scenes: [{ start: '00:01.000', end: '00:05.000' }] },
      { segment_id: 'slot_02', caption_text: '두 번째 장면', source_scenes: [{ start: '00:08.000', end: '00:12.000' }] },
      { segment_id: 'slot_03', caption_text: '세 번째 장면', source_scenes: [{ start: '00:14.000', end: '00:18.000' }] }
    ],
    captionUnits: [],
    ttsFiles: [],
    sourceDurationSec: 180
  });
  writeJson(path.join(workspaceDir, 'draft_spec.ko.json'), {
    locale: 'ko',
    clip_placement: [
      { clip_id: 'ko_slot_01', source_range: [10, 14], visual_role: 'cold_open' },
      { clip_id: 'ko_slot_02', source_range: [20, 24], visual_role: 'body' },
      { clip_id: 'ko_slot_03', source_range: [30, 34], visual_role: 'payoff' }
    ]
  });
  writeJson(path.join(workspaceDir, 'draft_spec.ja.json'), {
    locale: 'ja',
    clip_placement: [
      { clip_id: 'ja_slot_01', source_range: [60, 64], visual_role: 'bridge' },
      { clip_id: 'ja_slot_02', source_range: [80, 84], visual_role: 'cold_open' },
      { clip_id: 'ja_slot_03', source_range: [100, 104], visual_role: 'payoff' }
    ]
  });

  const rendered = [];
  const result = await generateLocaleDraftArtifacts({
    workspaceDir,
    baseDraftInputPath,
    draftGenerator: async (locale, localeDraftInput, draftWorkspaceDir) => {
      rendered.push({ locale, input: localeDraftInput });
      const draftFolder = path.join(draftWorkspaceDir, `draft_${locale}`);
      fs.mkdirSync(draftFolder, { recursive: true });
      const draftContent = {
        tracks: [{
          type: 'video',
          name: 'source_video',
          segments: localeDraftInput.segments.map(videoSegmentFromSourceScene)
        }]
      };
      const sourceDraftContentPath = path.join(draftFolder, 'draft_content.json');
      const workspaceDraftContentPath = path.join(draftWorkspaceDir, `draft_content.${locale}.json`);
      writeJson(sourceDraftContentPath, draftContent);
      writeJson(workspaceDraftContentPath, draftContent);
      return {
        locale,
        result: { draftPath: draftFolder, draftOutputMode: 'folder_only', packageZip: false, zipPath: '' },
        draft_folder_path: draftFolder,
        draft_content_path: workspaceDraftContentPath,
        source_draft_content_path: sourceDraftContentPath,
        replan_attempt: localeDraftInput.finalDraftReplanAttempt || 0
      };
    }
  });

  assert.deepEqual(rendered.map((item) => item.locale), ['ko', 'ja']);
  assert.equal(fs.existsSync(path.join(workspaceDir, 'draft_input.ko.json')), true);
  assert.equal(fs.existsSync(path.join(workspaceDir, 'draft_input.ja.json')), true);
  assert.equal(fs.existsSync(path.join(workspaceDir, 'draft_content.ko.json')), true);
  assert.equal(fs.existsSync(path.join(workspaceDir, 'draft_content.ja.json')), true);
  assert.equal(fs.existsSync(path.join(workspaceDir, 'draft_ko')), true);
  assert.equal(fs.existsSync(path.join(workspaceDir, 'draft_ja')), true);
  assert.equal(fs.existsSync(path.join(workspaceDir, 'overlap_report_final_draft.ko_vs_ja.json')), true);
  assert.equal(result.finalOverlapReport.final_status, 'pass');
  assert.equal(result.finalOverlapReport.source_range_overlap_ratio, 0);
  assert.equal(result.finalOverlapReport.top_highlight_cluster_ordering.identical, false);
  assert.equal(Object.keys(result.outputPaths).some((key) => key.includes('zip')), false);
  assert.match(result.outputPaths.draft_folder_ko, /draft_ko$/);
  assert.match(result.outputPaths.draft_folder_ja, /draft_ja$/);
});

test('replanJaDraftSpecForFinalOverlap changes JA video source ranges instead of caption-only retrying', () => {
  const draftSpec = {
    locale: 'ja',
    clip_placement: [
      { clip_id: 'ja_slot_01', source_range: [10, 14], visual_role: 'cold_open' },
      { clip_id: 'ja_slot_02', source_range: [20, 24], visual_role: 'body' },
      { clip_id: 'ja_slot_03', source_range: [30, 34], visual_role: 'payoff' }
    ]
  };

  const replanned = replanJaDraftSpecForFinalOverlap(draftSpec, {
    failed_gates: ['three_shot_identical_chain'],
    shared_contiguous_blocks: [{ ja_start_index: 0, length: 3, clips: [] }]
  }, 1, { sourceDurationSec: 180 });

  assert.notDeepEqual(replanned.clip_placement.map((clip) => clip.source_range), draftSpec.clip_placement.map((clip) => clip.source_range));
  assert.equal(replanned.final_draft_replan.strategy, 'ja_video_chain_reselection');
  assert.equal(replanned.clip_placement.every((clip) => clip.final_draft_replan_attempt === 1), true);
});
