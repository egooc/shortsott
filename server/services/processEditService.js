const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const {
  PROJECT_ROOT,
  PROJECT_DIRS,
  ensureProjectFolders,
  writeJsonWithBackup,
  readJsonIfExists
} = require('./pipelinePaths');
const { generateProcessDraft } = require('./capcutService');
const { renderProcessFinalMp4 } = require('./processRenderService');
const { resolveTool, getToolEnv } = require('../utils/toolPaths');

const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'process_edit_config.json');
const PROCESS_TEMPLATE_DIR = path.join(PROJECT_ROOT, 'templates', 'capcut', 'process_default');
const TEXT_DETECT_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'detect_text_regions.py');

const DEFAULT_VIDEO_TRANSFORM_PRESET_ID = 'steady_zoom_process';

const TEXT_ANIMATION_PRESETS = [
  {
    animation_id: 'template_default',
    name: 'Template default',
    description: 'Preserve the TEMPLATE_EXPLAINER animation from the CapCut template.'
  },
  {
    animation_id: 'slide_up',
    name: 'Slide up',
    description: 'Request a lower-third slide-up style for explainer captions.'
  },
  {
    animation_id: 'fade_in',
    name: 'Fade in',
    description: 'Request a soft fade-in style.'
  },
  {
    animation_id: 'pop_in',
    name: 'Pop in',
    description: 'Request a stronger pop-in emphasis style.'
  },
  {
    animation_id: 'echo_slam',
    name: 'Echo Slam',
    description: 'Use a stronger echo/slam emphasis animation for highlight explainer captions.'
  },
  {
    animation_id: 'type_on',
    name: 'Type on',
    description: 'Request a typing-style explainer reveal.'
  }
];

const VIDEO_TRANSFORM_PRESETS = [
  {
    preset_id: 'steady_zoom_process',
    name: 'Steady Zoom Process',
    display_name: 'Steady Zoom Process',
    description: 'Stronger full-draft baseline: mirror, 1.22 base scale, visible pan, and stronger rotation changes.',
    segment_unit_sec: 3,
    mirror_policy: 'global_once_only',
    global_transform: { mirror: true, scale: 1.22 },
    segment_transform_rules: { segment_mirror_allowed: false },
    pattern: [
      { scale: 1.22, pan_x: 0.00, pan_y: 0.00, rotation: 0.0, speed: 1.00 },
      { scale: 1.34, pan_x: -0.10, pan_y: 0.00, rotation: -1.8, speed: 1.06 },
      { scale: 1.42, pan_x: 0.10, pan_y: 0.00, rotation: 1.8, speed: 0.94 },
      { scale: 1.30, pan_x: 0.00, pan_y: -0.10, rotation: -1.0, speed: 1.08 },
      { scale: 1.38, pan_x: 0.00, pan_y: 0.10, rotation: 1.4, speed: 1.00 }
    ],
    process_order: [
      'Start: mirror + 1.22 scale',
      'Every 3 seconds: cycle scale 1.22 to 1.42',
      'Use 10 percent pan and stronger rotation to visibly reduce source similarity'
    ],
    color_adjustment: { enabled: true, style: 'clean_hdr' },
    distortion: { enabled: true, type: 'strong_rotation', max_degrees: 1.8 },
    sharpen: true,
    cut_trim: true,
    reorder: false
  },
  {
    preset_id: 'technical_clean_process',
    name: 'Technical Clean Process',
    display_name: 'Technical Clean Process',
    description: 'Readable but visibly transformed: mirror, stronger vertical movement, contrast, and rotation.',
    segment_unit_sec: 3,
    mirror_policy: 'global_once_only',
    global_transform: { mirror: true, scale: 1.20 },
    segment_transform_rules: { segment_mirror_allowed: false },
    pattern: [
      { scale: 1.20, pan_x: 0.00, pan_y: 0.00, rotation: 0.0, speed: 1.00 },
      { scale: 1.28, pan_x: 0.00, pan_y: -0.10, rotation: -0.8, speed: 1.04 },
      { scale: 1.32, pan_x: 0.00, pan_y: 0.10, rotation: 0.8, speed: 0.96 },
      { scale: 1.36, pan_x: -0.08, pan_y: 0.00, rotation: -1.2, speed: 1.06 },
      { scale: 1.26, pan_x: 0.08, pan_y: 0.00, rotation: 1.2, speed: 1.00 }
    ],
    process_order: [
      'Start: mirror + 1.20 scale',
      'Every 3 seconds: cycle scale 1.20 to 1.36',
      'Keep captions readable while applying 8 to 10 percent pan'
    ],
    color_adjustment: { enabled: true, style: 'clean_contrast' },
    distortion: { enabled: true, type: 'strong_rotation', max_degrees: 1.2 },
    sharpen: true,
    cut_trim: true,
    reorder: false
  },
  {
    preset_id: 'punch_zoom_process',
    name: 'Punch Zoom Process',
    display_name: 'Punch Zoom Process',
    description: 'Aggressive zoom punch preset for visible transformation and duplicate-risk reduction.',
    segment_unit_sec: 3,
    mirror_policy: 'global_once_only',
    global_transform: { mirror: true, scale: 1.25 },
    segment_transform_rules: { segment_mirror_allowed: false },
    pattern: [
      { scale: 1.25, pan_x: 0.00, pan_y: 0.00, rotation: 0.0, speed: 1.00 },
      { scale: 1.50, pan_x: -0.14, pan_y: 0.00, rotation: -2.8, speed: 1.18 },
      { scale: 1.30, pan_x: 0.00, pan_y: 0.00, rotation: 0.0, speed: 0.86 },
      { scale: 1.58, pan_x: 0.14, pan_y: 0.00, rotation: 2.8, speed: 1.25 },
      { scale: 1.42, pan_x: 0.00, pan_y: 0.12, rotation: 2.0, speed: 1.00 }
    ],
    process_order: [
      'Start: mirror + 1.25 scale',
      'Every 3 seconds: insert 1.50 to 1.58 punch zoom',
      'Use 12 to 14 percent pan and strong rotation for visible transformation'
    ],
    color_adjustment: { enabled: true, style: 'clean_hdr' },
    distortion: { enabled: true, type: 'strong_rotation', max_degrees: 2.8 },
    sharpen: true,
    cut_trim: true,
    reorder: false
  },
  {
    preset_id: 'speed_rhythm_process',
    name: 'Speed Rhythm Process',
    display_name: 'Speed Rhythm Process',
    description: 'Aggressive rhythm preset with stronger zoom, speed contrast, pan, and rotation.',
    segment_unit_sec: 3,
    mirror_policy: 'global_once_only',
    global_transform: { mirror: true, scale: 1.22 },
    segment_transform_rules: { segment_mirror_allowed: false },
    pattern: [
      { scale: 1.22, pan_x: 0.00, pan_y: 0.00, rotation: 0.0, speed: 1.00 },
      { scale: 1.36, pan_x: -0.11, pan_y: 0.00, rotation: -1.8, speed: 1.28 },
      { scale: 1.45, pan_x: 0.12, pan_y: 0.00, rotation: 2.2, speed: 0.72 },
      { scale: 1.40, pan_x: 0.00, pan_y: -0.12, rotation: -1.2, speed: 1.45 },
      { scale: 1.28, pan_x: 0.00, pan_y: 0.12, rotation: 1.4, speed: 0.86 }
    ],
    process_order: [
      'Start: mirror + 1.22 scale',
      'Apply speed rhythm: 1.28, 0.72, 1.45, 0.86 on selected segments',
      'Combine strong zoom and 11 to 12 percent pan to make repeated actions feel edited'
    ],
    color_adjustment: { enabled: true, style: 'clean_hdr' },
    distortion: { enabled: true, type: 'strong_rotation', max_degrees: 2.2 },
    sharpen: true,
    cut_trim: true,
    reorder: false
  },
  {
    preset_id: 'hook_replay_process',
    name: 'Hook Replay Process',
    display_name: 'Hook Replay Process',
    description: 'Aggressive hook preset: final teaser, stronger zoom, pan, and rhythm changes.',
    segment_unit_sec: 3,
    mirror_policy: 'global_once_only',
    global_transform: { mirror: true, scale: 1.25 },
    segment_transform_rules: { segment_mirror_allowed: false },
    hook_teaser: { enabled: true, source: 'last_seconds', duration_sec: 0.8, min_source_duration_sec: 8 },
    pattern: [
      { scale: 1.30, pan_x: 0.00, pan_y: 0.00, rotation: 0.0, speed: 1.00 },
      { scale: 1.42, pan_x: -0.12, pan_y: 0.00, rotation: -2.0, speed: 1.20 },
      { scale: 1.54, pan_x: 0.13, pan_y: 0.00, rotation: 2.4, speed: 0.82 },
      { scale: 1.36, pan_x: 0.00, pan_y: -0.12, rotation: -1.4, speed: 1.32 },
      { scale: 1.48, pan_x: 0.00, pan_y: 0.12, rotation: 1.8, speed: 1.00 }
    ],
    process_order: [
      '0 to 0.8s: teaser from the final source seconds',
      'Then continue from source start with mirror + at least 1.25 scale',
      'Use 12 to 13 percent pan and speed rhythm for a stronger hook',
      'Skip teaser when source is shorter than 8 seconds'
    ],
    crop_mode: 'vertical_fill',
    crop_zoom: true,
    mirror: true,
    speed_variation: true,
    speed: { enabled: true, mode: 'sequence', value: 1.0 },
    color_adjustment: { enabled: true, style: 'clean_hdr' },
    distortion: { enabled: true, type: 'strong_rotation', max_degrees: 2.4 },
    sharpen: true,
    cut_trim: true,
    reorder: false
  },
  {
    preset_id: 'full_process_hand_focus',
    name: 'Full Process Hand Focus',
    display_name: 'Full Process Hand Focus',
    description: 'Full-draft auto preset for hand or worker-heavy footage: crop harder into the actual material/process action.',
    segment_unit_sec: 2.4,
    mirror_policy: 'global_once_only',
    global_transform: { mirror: true, scale: 1.36 },
    segment_transform_rules: { segment_mirror_allowed: false },
    pattern: [
      { scale: 1.42, pan_x: -0.06, pan_y: 0.08, rotation: -1.0, speed: 1.00, label: 'hand_setup' },
      { scale: 1.74, pan_x: 0.08, pan_y: 0.04, rotation: 1.6, speed: 0.90, label: 'manual_detail_hold' },
      { scale: 1.88, pan_x: -0.04, pan_y: -0.04, rotation: -2.0, speed: 1.16, label: 'process_focus_push' },
      { scale: 1.52, pan_x: 0.10, pan_y: 0.02, rotation: 1.4, speed: 1.08, label: 'result_context' },
      { scale: 1.66, pan_x: -0.08, pan_y: 0.06, rotation: -1.6, speed: 1.02, label: 'hand_motion_follow' }
    ],
    process_order: [
      'Auto-selected when hands or workers dominate the source',
      'Crop around the exact hand/material contact point',
      'Use 1.7x to 1.9x detail pushes so the process stays central'
    ],
    crop_mode: 'vertical_fill',
    crop_zoom: true,
    mirror: true,
    speed_variation: true,
    speed: { enabled: true, mode: 'sequence', value: 1.0 },
    color_adjustment: { enabled: true, style: 'clean_hdr' },
    distortion: { enabled: true, type: 'strong_rotation', max_degrees: 2.0 },
    sharpen: true,
    cut_trim: true,
    reorder: false
  },
  {
    preset_id: 'full_process_punch_detail',
    name: 'Full Process Punch Detail',
    display_name: 'Full Process Punch Detail',
    description: 'Full-draft auto preset for pressing, cutting, stamping, crushing, or other impact-heavy scenes.',
    segment_unit_sec: 2.2,
    mirror_policy: 'global_once_only',
    global_transform: { mirror: true, scale: 1.32 },
    segment_transform_rules: { segment_mirror_allowed: false },
    pattern: [
      { scale: 1.38, pan_x: 0.00, pan_y: -0.04, rotation: -1.2, speed: 1.06, label: 'anticipation' },
      { scale: 1.82, pan_x: -0.06, pan_y: 0.00, rotation: 2.8, speed: 0.78, label: 'impact_hold' },
      { scale: 1.48, pan_x: 0.12, pan_y: 0.02, rotation: -2.6, speed: 1.32, label: 'snap_release' },
      { scale: 1.70, pan_x: -0.10, pan_y: -0.02, rotation: 2.2, speed: 0.92, label: 'second_detail' },
      { scale: 1.40, pan_x: 0.04, pan_y: 0.06, rotation: -1.0, speed: 1.12, label: 'context_return' }
    ],
    process_order: [
      'Auto-selected for press/cut/stamp/impact source scenes',
      'Slow the strongest action briefly, then snap back faster',
      'Use stronger rotation and pan to make each impact readable'
    ],
    crop_mode: 'vertical_fill',
    crop_zoom: true,
    mirror: true,
    speed_variation: true,
    speed: { enabled: true, mode: 'sequence', value: 1.0 },
    color_adjustment: { enabled: true, style: 'clean_hdr' },
    distortion: { enabled: true, type: 'strong_rotation', max_degrees: 2.8 },
    sharpen: true,
    cut_trim: true,
    reorder: false
  },
  {
    preset_id: 'full_process_flow_follow',
    name: 'Full Process Flow Follow',
    display_name: 'Full Process Flow Follow',
    description: 'Full-draft auto preset for pouring, extrusion, conveyors, noodles, and continuous material flow.',
    segment_unit_sec: 2.6,
    mirror_policy: 'global_once_only',
    global_transform: { mirror: true, scale: 1.28 },
    segment_transform_rules: { segment_mirror_allowed: false },
    pattern: [
      { scale: 1.34, pan_x: -0.14, pan_y: -0.06, rotation: -0.8, speed: 1.08, label: 'flow_entry' },
      { scale: 1.52, pan_x: -0.04, pan_y: 0.00, rotation: 1.0, speed: 1.16, label: 'flow_track' },
      { scale: 1.60, pan_x: 0.12, pan_y: 0.04, rotation: -1.2, speed: 1.20, label: 'flow_exit' },
      { scale: 1.42, pan_x: 0.04, pan_y: -0.10, rotation: 0.8, speed: 1.04, label: 'vertical_follow' },
      { scale: 1.30, pan_x: 0.00, pan_y: 0.00, rotation: 0.0, speed: 1.00, label: 'context_reset' }
    ],
    process_order: [
      'Auto-selected for flow/extrusion/conveyor scenes',
      'Pan along material direction instead of only zooming',
      'Use moderate speed-up so flow feels satisfying but still understandable'
    ],
    crop_mode: 'vertical_fill',
    crop_zoom: true,
    mirror: true,
    speed_variation: true,
    speed: { enabled: true, mode: 'sequence', value: 1.0 },
    color_adjustment: { enabled: true, style: 'clean_hdr' },
    distortion: { enabled: true, type: 'strong_rotation', max_degrees: 1.4 },
    sharpen: true,
    cut_trim: true,
    reorder: false
  },
  {
    preset_id: 'full_process_rhythm_scan',
    name: 'Full Process Rhythm Scan',
    display_name: 'Full Process Rhythm Scan',
    description: 'Full-draft auto preset for repeated machinery or rhythmic process loops.',
    segment_unit_sec: 2.0,
    mirror_policy: 'global_once_only',
    global_transform: { mirror: true, scale: 1.26 },
    segment_transform_rules: { segment_mirror_allowed: false },
    pattern: [
      { scale: 1.32, pan_x: -0.10, pan_y: 0.00, rotation: -1.4, speed: 1.18, label: 'rhythm_left' },
      { scale: 1.62, pan_x: 0.08, pan_y: -0.02, rotation: 2.2, speed: 0.82, label: 'slow_detail' },
      { scale: 1.40, pan_x: 0.12, pan_y: 0.02, rotation: -2.0, speed: 1.34, label: 'fast_release' },
      { scale: 1.56, pan_x: -0.04, pan_y: 0.08, rotation: 1.8, speed: 0.92, label: 'repeat_hold' },
      { scale: 1.34, pan_x: 0.00, pan_y: -0.08, rotation: -1.0, speed: 1.16, label: 'rhythm_reset' }
    ],
    process_order: [
      'Auto-selected when repetition or action changes dominate',
      'Alternate slow detail and fast release without duplicating clips',
      'Keep every repeated operation visually changed enough to avoid flat footage'
    ],
    crop_mode: 'vertical_fill',
    crop_zoom: true,
    mirror: true,
    speed_variation: true,
    speed: { enabled: true, mode: 'sequence', value: 1.0 },
    color_adjustment: { enabled: true, style: 'clean_hdr' },
    distortion: { enabled: true, type: 'strong_rotation', max_degrees: 2.2 },
    sharpen: true,
    cut_trim: true,
    reorder: false
  },
  {
    preset_id: 'full_process_reveal_context',
    name: 'Full Process Reveal Context',
    display_name: 'Full Process Reveal Context',
    description: 'Full-draft auto preset for transformation or reveal-driven sources: start close, then give context.',
    segment_unit_sec: 2.8,
    mirror_policy: 'global_once_only',
    global_transform: { mirror: true, scale: 1.24 },
    segment_transform_rules: { segment_mirror_allowed: false },
    pattern: [
      { scale: 1.68, pan_x: -0.04, pan_y: -0.04, rotation: -1.2, speed: 0.90, label: 'mystery_close' },
      { scale: 1.52, pan_x: 0.08, pan_y: -0.02, rotation: 1.4, speed: 0.98, label: 'partial_reveal' },
      { scale: 1.38, pan_x: -0.10, pan_y: 0.04, rotation: -1.6, speed: 1.10, label: 'motion_answer' },
      { scale: 1.26, pan_x: 0.04, pan_y: 0.00, rotation: 0.8, speed: 1.04, label: 'process_context' },
      { scale: 1.44, pan_x: 0.00, pan_y: 0.08, rotation: -0.8, speed: 1.00, label: 'result_focus' }
    ],
    process_order: [
      'Auto-selected for reveal/transformation/process-answer scenes',
      'Start closer so the object is intriguing',
      'Then widen enough to explain the process sequence'
    ],
    crop_mode: 'vertical_fill',
    crop_zoom: true,
    mirror: true,
    speed_variation: true,
    speed: { enabled: true, mode: 'sequence', value: 1.0 },
    color_adjustment: { enabled: true, style: 'clean_hdr' },
    distortion: { enabled: true, type: 'strong_rotation', max_degrees: 1.8 },
    sharpen: true,
    cut_trim: true,
    reorder: false
  },
  {
    preset_id: 'full_longform_core_crop',
    name: 'Full Longform Core Crop',
    display_name: 'Full Longform Core Crop',
    description: 'For 16:9 longform Full Drafts: crop into one core process area for a vertical 9:16 edit instead of shrinking the full horizontal frame.',
    segment_unit_sec: 2.4,
    mirror_policy: 'global_once_only',
    global_transform: { mirror: true, scale: 2.05 },
    segment_transform_rules: { segment_mirror_allowed: false },
    pan_limit_x: 0.32,
    pan_limit_y: 0.22,
    max_zoom_scale: 2.85,
    crop_mode: 'vertical_fill',
    crop_zoom: true,
    crop_intent: 'core_process_close_crop_from_wide_longform_full',
    pattern: [
      { scale: 2.12, pan_x: 0.00, pan_y: -0.04, rotation: -0.8, speed: 1.00, label: 'core_process_entry' },
      { scale: 2.46, pan_x: -0.18, pan_y: -0.02, rotation: 1.2, speed: 0.94, label: 'left_work_area_detail' },
      { scale: 2.24, pan_x: 0.18, pan_y: 0.02, rotation: -1.4, speed: 1.10, label: 'right_work_area_motion' },
      { scale: 2.62, pan_x: 0.04, pan_y: 0.00, rotation: 1.0, speed: 0.92, label: 'tool_material_closeup' },
      { scale: 2.18, pan_x: -0.06, pan_y: 0.04, rotation: -0.8, speed: 1.08, label: 'process_context_tight' }
    ],
    process_order: [
      'Use only the selected 60-second core process source window',
      'Treat wide 16:9 footage as source material, not as a full-frame vertical video',
      'Start around 2.05x scale and pan horizontally to the active work area',
      'Keep the machine/tool/material contact point large in the 9:16 frame'
    ],
    mirror: true,
    speed_variation: true,
    speed: { enabled: true, mode: 'sequence', value: 1.0 },
    color_adjustment: { enabled: true, style: 'clean_hdr' },
    distortion: { enabled: true, type: 'strong_rotation', max_degrees: 1.4 },
    sharpen: true,
    cut_trim: true,
    reorder: false
  },
  {
    preset_id: 'highlight_hook_zoom_out',
    name: 'Highlight Hook Zoom Out',
    display_name: 'Highlight Hook Zoom Out',
    description: 'Highlight preset: start with an extreme close-up hook, then zoom out to reveal the process context.',
    segment_unit_sec: 2,
    mirror_policy: 'global_once_only',
    global_transform: { mirror: true, scale: 1.55 },
    segment_transform_rules: { segment_mirror_allowed: false },
    pattern: [
      { scale: 1.82, pan_x: 0.00, pan_y: -0.06, rotation: -2.4, speed: 0.92, duration_sec: 1.8, label: 'extreme_close_hook' },
      { scale: 1.62, pan_x: -0.08, pan_y: -0.03, rotation: 1.8, speed: 1.06, duration_sec: 2.0, label: 'motion_focus' },
      { scale: 1.42, pan_x: 0.08, pan_y: 0.02, rotation: -1.2, speed: 1.12, duration_sec: 2.0, label: 'rhythm_reveal' },
      { scale: 1.22, pan_x: 0.00, pan_y: 0.00, rotation: 0.0, speed: 1.00, duration_sec: 2.4, label: 'context_zoom_out' }
    ],
    process_order: [
      'Start with 1.82 extreme close-up',
      'Move through 1.62 and 1.42 motion focus',
      'End around 1.22 context zoom-out so the process becomes clear'
    ],
    crop_mode: 'vertical_fill',
    crop_zoom: true,
    mirror: true,
    speed_variation: true,
    speed: { enabled: true, mode: 'sequence', value: 1.0 },
    color_adjustment: { enabled: true, style: 'clean_hdr' },
    distortion: { enabled: true, type: 'strong_rotation', max_degrees: 2.4 },
    sharpen: true,
    cut_trim: false,
    reorder: false
  }
];
const BGM_PRESETS = [
  {
    preset_id: 'process_satisfying',
    name: 'Process Satisfying',
    folder: 'assets/bgm/process',
    volume: 0.18,
    loop: true
  },
  {
    preset_id: 'industrial_clean',
    name: 'Industrial Clean',
    folder: 'assets/bgm/process',
    volume: 0.16,
    loop: true
  }
];

function defaultConfig() {
  return {
    mode: 'ultra_efficiency_process',
    source_video: 'input/source_clean.mp4',
    target_duration_sec: 30,
    use_tts: false,
    use_bgm: true,
    bgm_preset: 'process_satisfying',
    custom_bgm_path: '',
    custom_bgm_original_name: '',
    bgm_volume: 0.18,
    direct_render: {
      enabled: false,
      create_final_mp4: false
    },
    video_transform_preset: DEFAULT_VIDEO_TRANSFORM_PRESET_ID,
    source_preprocess: {
      enabled: true,
      scene_tail_trim_sec: 1,
      quality_scale: 0.8,
      hdr_look: true,
      crf: 28,
      ocr_blur: {
        enabled: false,
        mode: 'watermark_safe',
        padding_px: 16,
        detect_every_sec: 0.5,
        max_samples: 3,
        blur_kernel: 65
      },
      scene_detection: {
        enabled: true,
        threshold: 0.32,
        pyscenedetect_enabled: true,
        pyscenedetect_threshold: 32,
        min_scene_sec: 1.0
      }
    },
    capcut_template_id: 'process_default',
    capcut_template_source: 'capcut_draft_root',
    capcut_template_draft_name: 'sample draft',
    capcut_template_search_root: '',
    upload_title: '\uACF5\uC815\uC758 \uD575\uC2EC \uC21C\uAC04',
    upload_description: '',
    upload_hashtags: [],
    explainer_blocks: [
      {
        block_id: 'exp_001',
        text: '\uC774 \uACF5\uC815\uC5D0\uC11C \uD575\uC2EC \uBCC0\uD654\uAC00 \uC2DC\uC791\uB418\uB294 \uAD6C\uAC04\uC785\uB2C8\uB2E4.',
        start_sec: 0,
        end_sec: 30,
        style_role: 'main_explainer',
        anchor_zone: 'lower_third',
        animation: 'pop_in'
      }
    ],
    ocr_mask_overlay: {
      enabled: true,
      mode: 'fixed_template_blur_mask',
      report_path: '',
      preview_path: '',
      fixed_mask: {
        x: 0,
        y: 0.74,
        width: 0.62,
        height: 0.09
      },
      zones: ['bottom'],
      max_regions_per_frame: 4,
      min_confidence: 0.5,
      padding_px: 18,
      opacity: 0.72,
      color: '#151515'
    },
    channel_tag: {
      text: 'PROCESS LAB',
      start_sec: 0,
      end_sec: 30,
      animation_repeat: true,
      repeat_interval_sec: 2
    },
    channel_asset: {
      enabled: false,
      path: '',
      original_name: '',
      position: 'top_left',
      scale: 0.34,
      opacity: 1,
      replace_channel_tag_text: false
    },
    channel_frame_asset: {
      enabled: false,
      path: '',
      original_name: '',
      position: 'center',
      scale: 1,
      opacity: 1
    }
  };
}

function normalizeSourcePreprocess(input = {}) {
  const defaults = defaultConfig().source_preprocess;
  const raw = input && typeof input === 'object' ? input : {};
  const rawScene = raw.scene_detection && typeof raw.scene_detection === 'object' ? raw.scene_detection : {};
  const rawOcrBlur = raw.ocr_blur && typeof raw.ocr_blur === 'object' ? raw.ocr_blur : {};
  return {
    enabled: raw.enabled !== false,
    scene_tail_trim_sec: Number(raw.scene_tail_trim_sec) >= 0 ? Number(raw.scene_tail_trim_sec) : defaults.scene_tail_trim_sec,
    quality_scale: Number(raw.quality_scale) > 0 && Number(raw.quality_scale) <= 1 ? Number(raw.quality_scale) : defaults.quality_scale,
    hdr_look: raw.hdr_look !== false,
    crf: Number(raw.crf) >= 18 && Number(raw.crf) <= 40 ? Number(raw.crf) : defaults.crf,
    ocr_blur: {
      enabled: rawOcrBlur.enabled === true,
      mode: String(rawOcrBlur.mode || defaults.ocr_blur.mode),
      padding_px: Number(rawOcrBlur.padding_px) >= 0 ? Number(rawOcrBlur.padding_px) : defaults.ocr_blur.padding_px,
      detect_every_sec: Number(rawOcrBlur.detect_every_sec) >= 0.2 ? Number(rawOcrBlur.detect_every_sec) : defaults.ocr_blur.detect_every_sec,
      max_samples: Number(rawOcrBlur.max_samples) >= 1 ? Number(rawOcrBlur.max_samples) : defaults.ocr_blur.max_samples,
      blur_kernel: Number(rawOcrBlur.blur_kernel) >= 15 ? Number(rawOcrBlur.blur_kernel) : defaults.ocr_blur.blur_kernel
    },
    scene_detection: {
      enabled: rawScene.enabled !== false,
      threshold: Number(rawScene.threshold) >= 0.01 && Number(rawScene.threshold) <= 0.95
        ? Number(rawScene.threshold)
        : defaults.scene_detection.threshold,
      min_scene_sec: Number(rawScene.min_scene_sec) >= 0.2
        ? Number(rawScene.min_scene_sec)
        : defaults.scene_detection.min_scene_sec,
      pyscenedetect_enabled: rawScene.pyscenedetect_enabled !== false,
      pyscenedetect_threshold: Number(rawScene.pyscenedetect_threshold) >= 1 && Number(rawScene.pyscenedetect_threshold) <= 95
        ? Number(rawScene.pyscenedetect_threshold)
        : defaults.scene_detection.pyscenedetect_threshold,
      gemini_scene_transitions: Array.isArray(rawScene.gemini_scene_transitions)
        ? rawScene.gemini_scene_transitions
        : [],
      gemini_scene_change_times: Array.isArray(rawScene.gemini_scene_change_times)
        ? rawScene.gemini_scene_change_times
        : []
    }
  };
}

function normalizeOcrMaskOverlay(input = {}) {
  const defaults = defaultConfig().ocr_mask_overlay;
  const raw = input && typeof input === 'object' ? input : {};
  const fixedMask = raw.fixed_mask && typeof raw.fixed_mask === 'object' ? raw.fixed_mask : defaults.fixed_mask;
  const zones = Array.isArray(raw.zones)
    ? raw.zones.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
    : defaults.zones;
  return {
    enabled: raw.enabled !== false,
    mode: String(raw.mode || defaults.mode),
    report_path: String(raw.report_path || raw.reportPath || ''),
    preview_path: String(raw.preview_path || raw.previewPath || ''),
    fixed_mask: {
      x: Number.isFinite(Number(fixedMask.x)) ? Number(fixedMask.x) : defaults.fixed_mask.x,
      y: Number.isFinite(Number(fixedMask.y)) ? Number(fixedMask.y) : defaults.fixed_mask.y,
      width: Number.isFinite(Number(fixedMask.width)) ? Number(fixedMask.width) : defaults.fixed_mask.width,
      height: Number.isFinite(Number(fixedMask.height)) ? Number(fixedMask.height) : defaults.fixed_mask.height
    },
    zones: zones.length ? zones : defaults.zones,
    max_regions_per_frame: Number(raw.max_regions_per_frame) >= 1
      ? Math.min(12, Number(raw.max_regions_per_frame))
      : defaults.max_regions_per_frame,
    min_confidence: Number(raw.min_confidence) >= 0
      ? Math.min(1, Number(raw.min_confidence))
      : defaults.min_confidence,
    padding_px: Number(raw.padding_px) >= 0 ? Number(raw.padding_px) : defaults.padding_px,
    opacity: Number(raw.opacity) >= 0 ? Math.min(1, Number(raw.opacity)) : defaults.opacity,
    color: String(raw.color || defaults.color)
  };
}

function normalizeVideoTransformPresetId(value) {
  const requested = String(
    value && typeof value === 'object'
      ? value.preset_id || value.id || ''
      : value || ''
  ).trim();
  return VIDEO_TRANSFORM_PRESETS.some((preset) => preset.preset_id === requested)
    ? requested
    : DEFAULT_VIDEO_TRANSFORM_PRESET_ID;
}

function normalizeVideoTransformPreset(value) {
  if (value && typeof value === 'object' && (value.preset_id || value.id)) {
    return {
      ...value,
      preset_id: String(value.preset_id || value.id).trim() || DEFAULT_VIDEO_TRANSFORM_PRESET_ID
    };
  }
  return normalizeVideoTransformPresetId(value);
}

function normalizeExplainerBlock(block, index) {
  const fallbackStart = index * 5;
  const start = Number.isFinite(Number(block?.start_sec)) ? Number(block.start_sec) : fallbackStart;
  const end = Number.isFinite(Number(block?.end_sec)) ? Number(block.end_sec) : start + 5;
  return {
    block_id: String(block?.block_id || `exp_${String(index + 1).padStart(3, '0')}`),
    scene_id: String(block?.scene_id || ''),
    parent_scene_id: String(block?.parent_scene_id || block?.scene_id || ''),
    source_scene_index: Number.isFinite(Number(block?.source_scene_index)) ? Number(block.source_scene_index) : undefined,
    caption_part_index: Number.isFinite(Number(block?.caption_part_index)) ? Number(block.caption_part_index) : undefined,
    caption_parts_count: Number.isFinite(Number(block?.caption_parts_count)) ? Number(block.caption_parts_count) : undefined,
    caption_unit_mode: String(block?.caption_unit_mode || ''),
    output_language: String(block?.output_language || block?.language || ''),
    language: String(block?.language || block?.output_language || ''),
    full_scene_caption_text: String(block?.full_scene_caption_text || ''),
    text: String(block?.text || '').trim(),
    start_sec: Math.max(0, start),
    end_sec: Math.max(start + 0.2, end),
    style_role: String(block?.style_role || 'main_explainer'),
    style_profile: String(block?.style_profile || block?.styleProfile || ''),
    anchor_zone: String(block?.anchor_zone || 'lower_third'),
    animation: String(block?.animation || 'slide_up'),
    is_preroll_hook: block?.is_preroll_hook === true,
    source_start_sec: Number.isFinite(Number(block?.source_start_sec)) ? Number(block.source_start_sec) : undefined,
    source_end_sec: Number.isFinite(Number(block?.source_end_sec)) ? Number(block.source_end_sec) : undefined,
    source_window: block?.source_window && typeof block.source_window === 'object' ? block.source_window : undefined,
    video_transform_override: block?.video_transform_override && typeof block.video_transform_override === 'object'
      ? block.video_transform_override
      : undefined
  };
}

function normalizeConfig(input = {}) {
  const base = { ...defaultConfig(), ...(input || {}) };
  const uploadTitle = String(
    base.upload_title
      || base.title_overlay?.text
      || defaultConfig().upload_title
  ).trim();
  const uploadHashtags = Array.isArray(base.upload_hashtags)
    ? base.upload_hashtags
    : String(base.upload_hashtags || '').split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
  const explainerBlocks = Array.isArray(base.explainer_blocks)
    ? base.explainer_blocks.map(normalizeExplainerBlock).filter((block) => block.text)
    : [];

  return {
    mode: 'ultra_efficiency_process',
    source_video: String(base.source_video || 'input/source_clean.mp4'),
    target_duration_sec: Number(base.target_duration_sec) > 0 ? Number(base.target_duration_sec) : 30,
    use_tts: !!base.use_tts,
    use_bgm: base.use_bgm !== false,
    bgm_preset: String(base.bgm_preset || 'process_satisfying'),
    custom_bgm_path: String(base.custom_bgm_path || ''),
    custom_bgm_original_name: String(base.custom_bgm_original_name || ''),
    bgm_volume: Number(base.bgm_volume) >= 0 ? Number(base.bgm_volume) : 0.18,
    direct_render: {
      enabled: base.direct_render?.enabled === true,
      create_final_mp4: base.direct_render?.create_final_mp4 === true
    },
    video_transform_preset: normalizeVideoTransformPreset(base.video_transform_preset),
    source_preprocess: normalizeSourcePreprocess(base.source_preprocess),
    ocr_mask_overlay: normalizeOcrMaskOverlay(base.ocr_mask_overlay),
    capcut_template_id: String(base.capcut_template_id || 'process_default'),
    capcut_template_source: String(base.capcut_template_source || 'capcut_draft_root'),
    capcut_template_draft_name: String(base.capcut_template_draft_name || 'sample draft'),
    capcut_template_search_root: String(base.capcut_template_search_root || ''),
    upload_title: uploadTitle || defaultConfig().upload_title,
    upload_description: String(base.upload_description || ''),
    upload_hashtags: uploadHashtags,
    explainer_blocks: explainerBlocks.length ? explainerBlocks : defaultConfig().explainer_blocks,
    channel_tag: {
      text: String(base.channel_tag?.text || 'PROCESS LAB'),
      start_sec: Number.isFinite(Number(base.channel_tag?.start_sec)) ? Number(base.channel_tag.start_sec) : 0,
      end_sec: Number.isFinite(Number(base.channel_tag?.end_sec)) ? Number(base.channel_tag.end_sec) : Number(base.target_duration_sec || 30),
      animation_repeat: base.channel_tag?.animation_repeat !== false,
      repeat_interval_sec: Number(base.channel_tag?.repeat_interval_sec) > 0 ? Number(base.channel_tag.repeat_interval_sec) : 2
    },
    channel_asset: {
      enabled: base.channel_asset?.enabled === true,
      path: String(base.channel_asset?.path || ''),
      original_name: String(base.channel_asset?.original_name || ''),
      position: String(base.channel_asset?.position || 'top_left'),
      scale: Number(base.channel_asset?.scale) > 0 ? Number(base.channel_asset.scale) : 0.34,
      opacity: Number(base.channel_asset?.opacity) >= 0 ? Number(base.channel_asset.opacity) : 1,
      replace_channel_tag_text: base.channel_asset?.replace_channel_tag_text === true
    },
    channel_frame_asset: {
      enabled: base.channel_frame_asset?.enabled === true,
      path: String(base.channel_frame_asset?.path || ''),
      original_name: String(base.channel_frame_asset?.original_name || ''),
      position: String(base.channel_frame_asset?.position || 'center'),
      scale: Number(base.channel_frame_asset?.scale) > 0 ? Number(base.channel_frame_asset.scale) : 1,
      opacity: Number(base.channel_frame_asset?.opacity) >= 0 ? Number(base.channel_frame_asset.opacity) : 1
    }
  };
}

function getConfig() {
  ensureProjectFolders();
  const saved = readJsonIfExists(CONFIG_PATH);
  return {
    config: normalizeConfig(saved || defaultConfig()),
    configPath: CONFIG_PATH,
    exists: !!saved
  };
}

function saveConfig(config) {
  ensureProjectFolders();
  const normalized = normalizeConfig(config);
  const saved = writeJsonWithBackup(CONFIG_PATH, normalized);
  return {
    config: normalized,
    savedPath: saved.targetPath,
    backupPath: saved.backupPath
  };
}

function findFirstBgmFile() {
  ensureProjectFolders();
  const dir = PROJECT_DIRS.bgmProcess;
  if (!fs.existsSync(dir)) return '';
  const files = fs.readdirSync(dir)
    .filter((name) => /\.(mp3|wav|m4a|aac)$/i.test(name))
    .sort();
  return files.length ? path.join(dir, files[0]) : '';
}

function runExecFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function patchJsonFile(filePath, patch) {
  const current = readJsonIfExists(filePath);
  if (!current) return false;
  fs.writeFileSync(filePath, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, 'utf8');
  return true;
}

async function detectDraftSourceTextRegions({ sourceVideoPath, draftPath }) {
  if (!sourceVideoPath || !fs.existsSync(sourceVideoPath) || !draftPath) {
    return {
      status: 'skipped',
      reason: 'source_video_not_found'
    };
  }

  const analysisDir = path.join(draftPath, 'analysis');
  fs.mkdirSync(analysisDir, { recursive: true });
  const reportPath = path.join(analysisDir, 'ocr_text_regions.json');
  const previewPath = path.join(analysisDir, 'ocr_preview.jpg');

  try {
    const { stdout } = await runExecFile(resolveTool('python', { envKey: 'PYTHON_PATH' }), [
      TEXT_DETECT_SCRIPT,
      '--video',
      sourceVideoPath,
      '--output-json',
      reportPath,
      '--preview',
      previewPath,
      '--interval-sec',
      '2',
      '--max-frames',
      '12'
    ], {
      cwd: PROJECT_ROOT,
      env: getToolEnv(),
      maxBuffer: 20 * 1024 * 1024,
      timeout: 5 * 60 * 1000
    });

    const parsed = readJsonIfExists(reportPath) || JSON.parse(String(stdout || '{}'));
    return {
      status: parsed.status || 'success',
      regions_count: parsed.regions_count || 0,
      zone_counts: parsed.zone_counts || {},
      report_path: reportPath,
      preview_path: fs.existsSync(previewPath) ? previewPath : '',
      source_stage: 'before_capcut_draft_generation',
      source_video_modified: false
    };
  } catch (error) {
    const failure = {
      status: 'failed',
      reason: error.code || 'detect_text_regions_failed',
      message: error.message,
      stdout: String(error.stdout || '').slice(0, 4000),
      stderr: String(error.stderr || '').slice(0, 4000),
      source_video: sourceVideoPath
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(failure, null, 2)}\n`, 'utf8');
    return {
      ...failure,
      report_path: reportPath,
      preview_path: ''
    };
  }
}

function findProcessTemplateFiles() {
  if (!fs.existsSync(PROCESS_TEMPLATE_DIR)) {
    return {
      exists: false,
      templateRootPath: PROCESS_TEMPLATE_DIR,
      draftContentPath: '',
      draftMetaInfoPath: '',
      depth: null
    };
  }

  const directDraft = path.join(PROCESS_TEMPLATE_DIR, 'draft_content.json');
  if (fs.existsSync(directDraft)) {
    const directMeta = path.join(PROCESS_TEMPLATE_DIR, 'draft_meta_info.json');
    return {
      exists: true,
      templateRootPath: PROCESS_TEMPLATE_DIR,
      draftContentPath: directDraft,
      draftMetaInfoPath: fs.existsSync(directMeta) ? directMeta : '',
      depth: 0
    };
  }

  const candidates = [];
  function visit(current, depth) {
    if (depth > 2) return;

    const draftPath = path.join(current, 'draft_content.json');
    if (fs.existsSync(draftPath)) {
      const metaPath = path.join(current, 'draft_meta_info.json');
      candidates.push({
        templateRootPath: current,
        draftContentPath: draftPath,
        draftMetaInfoPath: fs.existsSync(metaPath) ? metaPath : '',
        hasMeta: fs.existsSync(metaPath),
        depth
      });
    }

    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) visit(path.join(current, entry.name), depth + 1);
    }
  }

  visit(PROCESS_TEMPLATE_DIR, 0);

  if (!candidates.length) {
    return {
      exists: true,
      templateRootPath: PROCESS_TEMPLATE_DIR,
      draftContentPath: '',
      draftMetaInfoPath: '',
      depth: null
    };
  }

  candidates.sort((a, b) => {
    if (a.hasMeta !== b.hasMeta) return a.hasMeta ? -1 : 1;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.templateRootPath.localeCompare(b.templateRootPath);
  });

  return {
    exists: true,
    ...candidates[0]
  };
}

function getPresets() {
  ensureProjectFolders();
  const processTemplate = findProcessTemplateFiles();
  return {
    videoTransformPresets: VIDEO_TRANSFORM_PRESETS,
    defaultVideoTransformPresetId: DEFAULT_VIDEO_TRANSFORM_PRESET_ID,
    textAnimationPresets: TEXT_ANIMATION_PRESETS,
    bgmPresets: BGM_PRESETS.map((preset) => ({
      ...preset,
      detectedFile: findFirstBgmFile()
    })),
    capcutTemplates: [
      {
        template_id: 'process_default',
        path: PROCESS_TEMPLATE_DIR,
        exists: fs.existsSync(PROCESS_TEMPLATE_DIR),
        templateRootPath: processTemplate.templateRootPath,
        draftContentPath: processTemplate.draftContentPath,
        draftMetaInfoPath: processTemplate.draftMetaInfoPath,
        draftContentExists: !!processTemplate.draftContentPath,
        draftMetaInfoExists: !!processTemplate.draftMetaInfoPath,
        depth: processTemplate.depth
      }
    ]
  };
}

async function createProcessDraft({ config, useExistingConfig = true, createZip = true } = {}) {
  const resolvedConfig = config && typeof config === 'object'
    ? normalizeConfig(config)
    : (useExistingConfig ? getConfig().config : normalizeConfig(defaultConfig()));

  const presets = getPresets();
  const selectedVideoPreset = resolvedConfig.video_transform_preset && typeof resolvedConfig.video_transform_preset === 'object'
    ? resolvedConfig.video_transform_preset
    : (presets.videoTransformPresets.find((item) => item.preset_id === resolvedConfig.video_transform_preset)
      || VIDEO_TRANSFORM_PRESETS[0]);
  const selectedBgmPreset = presets.bgmPresets.find((item) => item.preset_id === resolvedConfig.bgm_preset)
    || BGM_PRESETS[0];

  const result = await generateProcessDraft({
    config: resolvedConfig,
    videoTransformPreset: selectedVideoPreset,
    bgmPreset: {
      ...selectedBgmPreset,
      asset_path: findFirstBgmFile()
    },
    createZip
  });

  result.ocrTextDetection = await detectDraftSourceTextRegions({
    sourceVideoPath: result.sourceVideoPath,
    draftPath: result.draftPath
  });
  if (result.ocrTextDetection?.status) {
    patchJsonFile(path.join(result.draftPath, 'edit_manifest.json'), {
      ocr_text_detection: result.ocrTextDetection
    });
    fs.appendFileSync(
      path.join(result.draftPath, 'capcut_notes.md'),
      [
        '',
        '## OCR Text Detection',
        `- Status: ${result.ocrTextDetection.status}`,
        `- Candidate Regions: ${result.ocrTextDetection.regions_count || 0}`,
        `- Report: ${result.ocrTextDetection.report_path || 'none'}`,
        `- Preview: ${result.ocrTextDetection.preview_path || 'none'}`,
        '- Source video modified: false',
        ''
      ].join('\n'),
      'utf8'
    );
  }

  if (resolvedConfig.direct_render?.enabled !== false && resolvedConfig.direct_render?.create_final_mp4 !== false) {
    try {
      result.directRender = await renderProcessFinalMp4({
        draftFolder: result.draftPath,
        enabled: true
      });
      result.finalMp4Path = result.directRender.outputPath;
    } catch (error) {
      result.directRender = {
        enabled: true,
        status: 'failed',
        message: error.message
      };
    }
  } else {
    result.directRender = {
      enabled: false,
      status: 'skipped',
      reason: 'direct render disabled'
    };
  }

  return result;
}

module.exports = {
  CONFIG_PATH,
  defaultConfig,
  normalizeConfig,
  getConfig,
  saveConfig,
  getPresets,
  createProcessDraft
};
