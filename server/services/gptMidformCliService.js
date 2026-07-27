const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { createHttpError } = require('./errorService');
const { condenseGeminiAnalysis } = require('./midformSceneCondensationService');

const PROJECT_ROOT = path.join(__dirname, '../..');
const MIDFORM_SCHEMA_PATH = path.join(PROJECT_ROOT, 'midform', 'schemas', 'midform_script_schema.json');
const MIDFORM_SLOT_FILLS_SCHEMA_PATH = path.join(PROJECT_ROOT, 'midform', 'schemas', 'midform_slot_fills_schema.json');
const MIDFORM_STORY_OUTLINE_SCHEMA_PATH = path.join(PROJECT_ROOT, 'midform', 'schemas', 'midform_story_outline_schema.json');
const MIDFORM_NATURALIZATION_VALIDATION_SCHEMA_PATH = path.join(PROJECT_ROOT, 'midform', 'schemas', 'midform_naturalization_validation_schema.json');
const MIDFORM_CLOSING_DRIP_VALIDATION_SCHEMA_PATH = path.join(PROJECT_ROOT, 'midform', 'schemas', 'closing_drip_validation_schema.json');
const MIDFORM_COMPRESSION_BEATS_SCHEMA_PATH = path.join(PROJECT_ROOT, 'midform', 'schemas', 'midform_compression_beats_schema.json');
const MIDFORM_COMPRESSION_EDIT_PLAN_SCHEMA_PATH = path.join(PROJECT_ROOT, 'midform', 'schemas', 'midform_compression_edit_plan_schema.json');
const GPT_WORK_DIR = path.join(PROJECT_ROOT, 'midform', 'work', 'gpt_cli');
const DEFAULT_MODEL = '';
const CAMERA_TERMS = ['클로즈업', '컷', '프레임', '화면', '샷', '앵글', '자막', '와이드샷', '구독', '인트로', '아웃트로'];
const CAMERA_META_PATTERNS = [
  { pattern: /장면(?:은|이|을|의|에서|으로|에는)?/, label: '장면' },
  { pattern: /자막(?:은|이|을|의|에|으로)?/, label: '자막' },
  { pattern: /화면(?:은|이|을|의|에|으로)?/, label: '화면' },
  { pattern: /(?:화면|컷|샷|장면)\s*전환|전환(?:됩니다|된다|되는|되며|되면서|컷)/, label: '전환' },
  { pattern: /(?:와이드샷|클로즈업|프레임|앵글|인트로|아웃트로|구독)/, label: 'camera_meta_term' }
];
const EVASIVE_MOVIE_LABELS = ['은빛 존재', '낯선 은빛 존재', '보라 망토의 영웅', '망토의 영웅', '여성 영웅', '검은 망토의 인물', '검은 망토의 남자', '어떤 존재', '무언가', '정체불명'];
const ACTOR_REAL_NAME_TOKENS = ['크리스 에반스', '제시카 알바', '이안 그루퍼드', '마이클 치클리스', '더그 존스', '로렌스 피시번', '줄리안 맥마흔', 'Chris Evans', 'Jessica Alba', 'Ioan Gruffudd', 'Michael Chiklis', 'Doug Jones', 'Laurence Fishburne', 'Julian McMahon'];
const FORMAL_DIALOGUE_TOKENS = ['습니까', '십시오', '합니다', '입니다', '했습니다'];
const VISUAL_RELAY_VERBS = ['보다', '바라', '올려다', '내려다', '서 있', '앉', '걷', '뛰', '날아', '내려오', '다가', '돌', '움직', '가로질러', '스치', '배치', '발사', '튀', '쓰러', '멈췄', '깜빡', '흔들', '포위', '조준'];
const CONTEXT_LAYER_TERMS = ['왜', '정체', '동기', '이유', '선택', '파괴자', '판돈', '위협', '문제는', '그런데', '사실', '진짜', '갈락투스', '전령', '고향', '섬기는', '처지', '목적', '대가', '결국'];
const ALLOWED_MOVIE_CONTEXT_TERMS = ['갈락투스', '전령', '선택권', '선택', '파괴자', '묶인 처지', '고향', '경고', '더 큰 파괴자', '첫 대면', '시작에 불과'];
const COMPRESSED_HANJA_PHRASES = ['제어 잔재', '해제 성립', '잔재 반응', '징후를 찾', '판정', '성립될', '여부', '반응에서 해제', '재정렬', '루프', '협업으로', '완수하겠다는'];
const CODEWORD_SOURCE_PATTERNS = [/benign/i, /homecoming/i, /freight\s+car/i, /cargo\s+ship/i, /the\s+heart/i, /the\s+dream/i, /the\s+return/i, /the\s+one/i, /грузовой/i, /возвращение/i];
const CODEWORD_TRANSLATION_HINTS = ['젤라니예', '꿈', '열일곱', '화물열차', '화물칸', '홈커밍', '귀향', '...', '…'];
const ENDING_RATIO_PRESETS = {
  action: { label: 'action/thriller/sci_fi', nida: 60, jyo: 15, neunde: 10, beoryeot: 15 },
  drama: { label: 'drama/emotional/romance', nida: 75, jyo: 15, neunde: 8, beoryeot: 2 },
  comedy: { label: 'comedy', nida: 55, jyo: 25, neunde: 15, beoryeot: 5 },
  mystery: { label: 'mystery/twist/suspense', nida: 65, jyo: 10, neunde: 20, beoryeot: 5 }
};
const OBSERVATION_ENDING_PHRASES = ['봅니다', '기다립니다', '지켜봅니다', '확인합니다'];
const UNGROUNDED_EVENT_PATTERNS = [
  { token: '손끝', reason: 'body-action not grounded in the verified clip', alwaysForbidden: true },
  { token: '전류', reason: 'electric counteraction not grounded in the verified clip', alwaysForbidden: true },
  { token: '스파크', reason: 'electric counteraction not grounded in the verified clip', alwaysForbidden: true },
  { token: '세 번', reason: 'specific count not grounded in this clip evidence', alwaysForbidden: true },
  { token: '문을 열', reason: 'invented reversal/device consequence', alwaysForbidden: true },
  { token: '잠깐의 착각', reason: 'invented reversal judgment', alwaysForbidden: true },
  { token: '판단은 착각', reason: 'invented reversal judgment', alwaysForbidden: true },
  { token: '줄을 조종', reason: 'future puppet-master certainty outside the clip', alwaysForbidden: true },
  { token: '곧 드러', reason: 'future plot certainty outside the clip', alwaysForbidden: true },
  { token: '다시 움직', reason: 'recovery after being shot/downed is not grounded in the verified clip', alwaysForbidden: true },
  { token: '다시 일어', reason: 'recovery/counterattack not grounded in the verified clip', alwaysForbidden: true },
  { token: '공중으로 일으', reason: 'invented recovery action', alwaysForbidden: true },
  { token: '보드를 붙잡아 다시', reason: 'invented recovery action', alwaysForbidden: true },
  { token: '반격', reason: 'counterattack not grounded unless source text states it' },
  { token: '더 강한 장치', reason: 'invented device escalation', alwaysForbidden: true },
  { token: '패배를 버', reason: 'invented recovery/reversal after defeat', alwaysForbidden: true },
  { token: '사냥꾼', reason: 'future villain/threat framing not grounded in this clip', alwaysForbidden: true },
  { token: '다음엔 누가', reason: 'future plot certainty outside the clip', alwaysForbidden: true }
];
const MIN_AUTO_SLOT_SEC = 4.0;
const FAST_CLOSING_DRIP_TOKENS = ['여러분', '그러니까', '이쯤 되면', '웃긴 건', '드립'];
const FAST_CLOSING_AFTERTASTE_TOKENS = ['여운', '상처', '마음', '가족', '아픕', '씁쓸', '무게', '남습니다', '남았죠', '말하죠', '조용하긴', '틀렸습니다'];
const PASS0_STAKES_PLACEHOLDER = 'The scene stakes should be inferred only from verified source and research evidence.';
const GENERIC_MOVIE_KNOWLEDGE_ROLE = 'source-observed character';
const GENERIC_MOVIE_KNOWLEDGE_MOTIVATION = 'Pass 0 research could not safely infer motivation beyond the source clip.';

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function timestamp() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

function quoteForCmd(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function resolveCodexBaseCommand() {
  if (process.platform !== 'win32') {
    return { command: 'codex', argsPrefix: [] };
  }

  const candidates = [];
  for (const query of ['codex.cmd', 'codex']) {
    try {
      const output = execFileSync('where.exe', [query], { encoding: 'utf8' });
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach((line) => candidates.push(line));
    } catch {
      // continue fallback
    }
  }

  const cmdCandidate = candidates.find((item) => item.toLowerCase().endsWith('.cmd'));
  if (cmdCandidate) {
    return { command: 'C:\\Windows\\System32\\cmd.exe', argsPrefix: ['/d', '/s', '/c', cmdCandidate] };
  }
  return { command: 'codex', argsPrefix: [] };
}

function buildCodexArgs({ outputPath, model, outputSchemaPath = MIDFORM_SCHEMA_PATH }) {
  const effectiveModel = String(model || process.env.GPT_MIDFORM_MODEL || DEFAULT_MODEL).trim();
  const baseArgs = [
    'exec',
    '--sandbox',
    'read-only',
    '--output-schema',
    outputSchemaPath,
    '--output-last-message',
    outputPath,
    '-'
  ];
  if (effectiveModel) {
    baseArgs.splice(1, 0, '--model', effectiveModel);
  }
  return baseArgs;
}

function safeOutputSchemaPath(outputSchemaPath) {
  const allowed = new Set([
    MIDFORM_SCHEMA_PATH,
    MIDFORM_SLOT_FILLS_SCHEMA_PATH,
    MIDFORM_STORY_OUTLINE_SCHEMA_PATH,
    MIDFORM_NATURALIZATION_VALIDATION_SCHEMA_PATH,
    MIDFORM_CLOSING_DRIP_VALIDATION_SCHEMA_PATH,
    MIDFORM_COMPRESSION_BEATS_SCHEMA_PATH,
    MIDFORM_COMPRESSION_EDIT_PLAN_SCHEMA_PATH
  ].map((item) => path.normalize(item)));
  const resolved = path.normalize(path.isAbsolute(String(outputSchemaPath || ''))
    ? String(outputSchemaPath || MIDFORM_SCHEMA_PATH)
    : path.resolve(PROJECT_ROOT, String(outputSchemaPath || MIDFORM_SCHEMA_PATH)));
  return allowed.has(resolved) ? resolved : MIDFORM_SCHEMA_PATH;
}

function runCodexCli(prompt, options = {}) {
  return new Promise((resolve, reject) => {
    ensureDir(GPT_WORK_DIR);
    const outputPath = path.join(GPT_WORK_DIR, `codex_midform_output_${timestamp()}_${crypto.randomUUID()}.txt`);
    const promptPath = path.join(GPT_WORK_DIR, `codex_midform_prompt_${timestamp()}_${crypto.randomUUID()}.md`);
    fs.writeFileSync(promptPath, `${prompt}\n`, 'utf8');

    const base = resolveCodexBaseCommand();
    const codexArgs = buildCodexArgs({ outputPath, model: options.model, outputSchemaPath: safeOutputSchemaPath(options.outputSchemaPath) });
    const command = base.command;
    const args = [...base.argsPrefix, ...codexArgs];
    const env = {
      ...process.env,
      LANG: process.env.LANG || 'C.UTF-8',
      LC_ALL: process.env.LC_ALL || 'C.UTF-8',
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8'
    };

    let child;
    try {
      child = spawn(command, args, {
        cwd: PROJECT_ROOT,
        env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      reject(createHttpError(500, 'GPT_CLI_SPAWN_FAILED', `Failed to start GPT CLI: ${error.message}`, {
        command,
        args,
        promptPath
      }));
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdin.setDefaultEncoding('utf8');
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      reject(createHttpError(500, 'GPT_CLI_SPAWN_FAILED', `GPT CLI error: ${error.message}`, {
        command,
        args,
        stdout,
        stderr,
        promptPath,
        outputPath
      }));
    });
    child.on('close', (exitCode) => {
      const outputText = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
      if (exitCode !== 0) {
        reject(createHttpError(500, 'GPT_CLI_FAILED', `GPT CLI exited with code ${exitCode}`, {
          command,
          args,
          exitCode,
          stdout: stdout.slice(0, 4000),
          stderr: stderr.slice(0, 4000),
          promptPath,
          outputPath
        }));
        return;
      }
      resolve({ stdout, stderr, outputText, outputPath, promptPath, command, args });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function stripCodeFence(text) {
  return String(text || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractJson(text) {
  const cleaned = stripCodeFence(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) {
      throw createHttpError(500, 'GPT_CLI_JSON_PARSE_ERROR', 'GPT CLI output did not include a JSON object', {
        snippet: cleaned.slice(0, 1000)
      });
    }
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

function secondsToTimecode(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const secs = Math.floor(value % 60);
  const millis = Math.round((value - Math.floor(value)) * 1000);
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function timecodeToSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const parts = text.split(':').map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function sourceRefsForSegment(segment) {
  const sourceClips = Array.isArray(segment?.source_clips) ? segment.source_clips : [];
  if (sourceClips.length) return sourceClips;
  return Array.isArray(segment?.source_scenes) ? segment.source_scenes : [];
}

function isInsideProjectRoot(resolvedPath) {
  const relative = path.relative(PROJECT_ROOT, resolvedPath);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function loadTranscriptFromOptions(options = {}) {
  const inline = options.transcript || options.sourceTranscript || options.source_transcript;
  if (inline && typeof inline === 'object') return inline;
  const transcriptPath = String(options.transcriptPath || options.transcript_path || options.sourceTranscriptPath || '').trim();
  if (!transcriptPath) return null;
  const resolved = path.isAbsolute(transcriptPath) ? path.normalize(transcriptPath) : path.resolve(PROJECT_ROOT, transcriptPath);
  if (!isInsideProjectRoot(resolved) || !fs.existsSync(resolved)) return null;
  return JSON.parse(fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/, ''));
}

function loadSlotMapFromOptions(options = {}) {
  const inline = options.slotMap || options.slot_map;
  if (inline && typeof inline === 'object') return inline;
  const slotMapPath = String(options.slotMapPath || options.slot_map_path || '').trim();
  if (!slotMapPath) return null;
  const resolved = path.isAbsolute(slotMapPath) ? path.normalize(slotMapPath) : path.resolve(PROJECT_ROOT, slotMapPath);
  if (!isInsideProjectRoot(resolved) || !fs.existsSync(resolved)) return null;
  return JSON.parse(fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/, ''));
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function sourceDurationFromGemini(geminiAnalysis = {}) {
  const direct = numberOrZero(geminiAnalysis?.source?.duration_sec || geminiAnalysis?.source_duration_sec || geminiAnalysis?.duration_sec);
  if (direct > 0) return direct;
  const scenes = Array.isArray(geminiAnalysis?.scenes) ? geminiAnalysis.scenes : [];
  return scenes.reduce((max, scene) => Math.max(max, numberOrZero(scene?.end_sec || scene?.end)), 0);
}

function sceneText(scene = {}) {
  return [
    scene.visible_action,
    scene.recap_bridge_before,
    scene.dialogue_or_caption,
    scene.vertical_crop_note
  ].map((value) => String(value || '').trim()).filter(Boolean).join(' / ');
}

function isExcludedAutoSlotScene(scene = {}) {
  return /(구독|엔딩 화면|다른 영상|시청을 유도|credit|credits|end screen)/i.test(sceneText(scene));
}

function buildAutomaticNarrationSlotMap(geminiAnalysis = {}, transcript = null) {
  const sourceDuration = sourceDurationFromGemini(geminiAnalysis);
  const scenes = Array.isArray(geminiAnalysis?.scenes) ? geminiAnalysis.scenes : [];
  const candidates = scenes.length
    ? scenes.map((scene, index) => {
      const start = Math.max(0, Math.min(sourceDuration, numberOrZero(scene.start_sec || scene.start)));
      const end = Math.max(0, Math.min(sourceDuration, numberOrZero(scene.end_sec || scene.end)));
      return {
        start,
        end,
        sceneIds: [String(scene.scene_id || scene.id || `scene_${index + 1}`).trim()].filter(Boolean),
        summary: sceneText(scene) || '비발화 장면',
        excluded: isExcludedAutoSlotScene(scene)
      };
    })
    : [{ start: 0, end: sourceDuration, sceneIds: [], summary: '비발화 장면', excluded: false }];

  const slots = [];
  const excludedRanges = [];
  let pending = null;
  for (const candidate of candidates) {
    if (candidate.end <= candidate.start) continue;
    if (candidate.excluded) {
      excludedRanges.push([Number(candidate.start.toFixed(3)), Number(candidate.end.toFixed(3)), 'excluded_end_screen_or_static']);
      continue;
    }
    if (!pending) {
      pending = { ...candidate, summaries: [candidate.summary], sceneIds: [...candidate.sceneIds] };
      continue;
    }
    const pendingDuration = pending.end - pending.start;
    if (pendingDuration < MIN_AUTO_SLOT_SEC && candidate.start <= pending.end + 0.25) {
      pending.end = candidate.end;
      pending.summaries.push(candidate.summary);
      pending.sceneIds.push(...candidate.sceneIds);
    } else {
      slots.push(pending);
      pending = { ...candidate, summaries: [candidate.summary], sceneIds: [...candidate.sceneIds] };
    }
  }
  if (pending) slots.push(pending);

  const normalizedSlots = slots
    .filter((slot) => slot.end - slot.start >= 0.5)
    .map((slot, index) => {
      const duration = slot.end - slot.start;
      return {
        type: 'narration',
        source_range: [Number(slot.start.toFixed(3)), Number(slot.end.toFixed(3))],
        duration: Number(duration.toFixed(3)),
        scene_summary: [...new Set(slot.summaries.filter(Boolean))].join(' / ') || '비발화 장면',
        scene_ids: [...new Set(slot.sceneIds.filter(Boolean))],
        tts_budget_sec: [Number((duration * 0.75).toFixed(3)), Number((duration * 0.95).toFixed(3))],
        slot_id: `s${String(index + 1).padStart(2, '0')}`
      };
    });

  const utterances = transcriptUtterances(transcript);
  return {
    source_duration_sec: Number(sourceDuration.toFixed(6)),
    slots: normalizedSlots,
    excluded_ranges: excludedRanges,
    excluded_dialogue_utterances: utterances.map((utterance) => ({
      utt_id: utterance.utt_id,
      source_range: [Number(utterance.start.toFixed(3)), Number(utterance.end.toFixed(3))],
      text: utterance.text,
      reason: 'auto_narration_slot_map_uses_no_dialogue_without_explicit_slot_map'
    })),
    total_output_estimate_sec: Number(normalizedSlots.reduce((total, slot) => total + ((slot.tts_budget_sec[0] + slot.tts_budget_sec[1]) / 2), 0).toFixed(3)),
    dialogue_selected_duration_sec: 0,
    generation_mode: 'auto_narration_only_slot_map'
  };
}

function shouldAllowLegacySinglePrompt(options = {}) {
  return options.allowLegacySinglePrompt === true || options.allow_legacy_single_prompt === true || process.env.GPT_MIDFORM_ALLOW_LEGACY_SINGLE_PROMPT === '1';
}

function movieResearchFromOptions(options = {}) {
  const research = options.movieResearch || options.movie_research || null;
  const identity = options.movieIdentity || options.movie_identity || research?.movie_identity || null;
  const knowledge = options.movieKnowledge || options.movie_knowledge || research?.movie_knowledge || null;
  if (!identity && !knowledge) return null;
  return {
    movie_identity: identity || null,
    movie_knowledge: knowledge || null,
    evidence_summary: Array.isArray(research?.movie_identity?.evidence) ? research.movie_identity.evidence : []
  };
}

function resolveContentProfile(geminiAnalysis = {}, options = {}) {
  const explicit = String(options.contentType || options.content_type || options.profile || '').trim().toLowerCase();
  const sourceType = String(geminiAnalysis?.source?.content_type || geminiAnalysis?.content_type || '').trim().toLowerCase();
  const guess = String(geminiAnalysis?.story_context?.content_guess || '').trim().toLowerCase();
  const combined = [explicit, sourceType, guess].join(' ');
  if (combined.includes('real_person')) return 'real_person_story';
  if (combined.includes('movie') || combined.includes('film') || combined.includes('recap')) return 'movie_recap';
  return explicit || 'movie_recap';
}

function isMovieRecapProfile(profile) {
  return String(profile || '').toLowerCase() === 'movie_recap';
}

function transcriptUtterances(transcript) {
  return (Array.isArray(transcript?.utterances) ? transcript.utterances : [])
    .map((utterance) => ({
      utt_id: String(utterance?.utt_id || '').trim(),
      start: Number(utterance?.start),
      end: Number(utterance?.end),
      text: String(utterance?.text || '').trim()
    }))
    .filter((utterance) => utterance.utt_id && Number.isFinite(utterance.start) && Number.isFinite(utterance.end) && utterance.end > utterance.start);
}

function cameraMetaTermHits(text) {
  const value = String(text || '');
  const direct = CAMERA_TERMS.filter((term) => value.includes(term));
  const patternHits = CAMERA_META_PATTERNS
    .filter(({ pattern }) => pattern.test(value))
    .map(({ label }) => label);
  return [...new Set([...direct, ...patternHits])];
}

function visibleLength(text) {
  return String(text || '').replace(/\s+/g, '').length;
}

function dialogueQualityIssue({ text, start = 0, end = 0, movieKnowledge = null, allowCodeword = false }) {
  const raw = String(text || '').trim();
  const duration = Math.max(0, Number(end) - Number(start));
  if (!raw) return 'empty_dialogue_text';
  const compactLength = visibleLength(raw);
  const words = raw.split(/\s+/).filter(Boolean);
  const contextText = [
    movieKnowledge?.clip_context,
    movieKnowledge?.stakes,
    ...(Array.isArray(movieKnowledge?.characters) ? movieKnowledge.characters.flatMap((item) => [item.screen_name, item.role, item.motivation]) : [])
  ].join(' ').toLowerCase();
  const codewordContext = allowCodeword || /(세뇌|암시어|코드|codeword|winter soldier|грузовой|benign|freight car|homecoming)/i.test(`${raw} ${contextText}`);
  if (duration >= 8 && compactLength <= Math.max(12, duration * 1.2) && !codewordContext) return `dialogue_too_sparse_for_duration(${duration.toFixed(3)}s/${compactLength}chars)`;
  if (!/\p{L}/u.test(raw)) return 'non_linguistic_dialogue_text';
  if (/[\uFFFD]/.test(raw)) return 'mojibake_dialogue_text';
  return '';
}

function movieKnowledgeFromOptions(options = {}) {
  const research = movieResearchFromOptions(options);
  return options.movieKnowledge || options.movie_knowledge || research?.movie_knowledge || null;
}

function isCodewordSlot(slot = {}, options = {}) {
  const knowledge = movieKnowledgeFromOptions(options);
  const context = [
    slot.caption_source_text,
    slot.scene_summary,
    knowledge?.clip_context,
    knowledge?.stakes
  ].map((value) => String(value || '')).join(' ');
  if (!/(세뇌|암시어|코드워드|주문|암호|codeword|winter soldier|히드라)/i.test(context)) return false;
  return CODEWORD_SOURCE_PATTERNS.some((pattern) => pattern.test(context));
}

function compressedHanjaHits(text) {
  const value = String(text || '');
  return COMPRESSED_HANJA_PHRASES.filter((phrase) => value.includes(phrase));
}

function namingConsistencyErrors(text, options = {}) {
  const knowledge = movieKnowledgeFromOptions(options);
  const names = (Array.isArray(knowledge?.characters) ? knowledge.characters : []).map((character) => String(character?.screen_name || ''));
  const errors = [];
  if (names.some((name) => name.includes('아요')) && String(text || '').includes('오코예')) {
    errors.push('Pass 0 identifies the Wakanda warrior as 아요; do not mix in 오코예 for the same role');
  }
  return errors;
}

function buildUtteranceMap(transcript) {
  return new Map(transcriptUtterances(transcript).map((utterance) => [utterance.utt_id, utterance]));
}

function storyAnchorRange(segment) {
  const range = segment?.story_anchor?.source_range_hint;
  if (!Array.isArray(range) || range.length !== 2) return null;
  const start = Number(range[0]);
  const end = Number(range[1]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

function storyAnchorSceneRefs(segment) {
  const refs = segment?.story_anchor?.scene_refs;
  return Array.isArray(refs) ? refs.map((item) => String(item || '').trim()).filter(Boolean) : [];
}

function buildSceneMap(geminiAnalysis) {
  return new Map((Array.isArray(geminiAnalysis?.scenes) ? geminiAnalysis.scenes : [])
    .map((scene) => [String(scene?.scene_id || '').trim(), scene])
    .filter(([sceneId]) => Boolean(sceneId)));
}

function sceneHasDialogue(scene) {
  const text = String(scene?.dialogue_or_caption || '').trim().toLowerCase();
  if (!text || text === 'none' || text === 'n/a' || text === 'null') return false;
  if (scene?.should_preserve_original_dialogue === true) return true;

  const fn = String(scene?.dialogue_function || '').trim().toLowerCase();
  return ['iconic_line', 'threat', 'confession', 'punchline'].includes(fn);
}

function collectSourceRanges(script, errors) {
  const ranges = [];
  for (const segment of script?.segments || []) {
    const segmentId = String(segment?.segment_id || '?');
    const refs = sourceRefsForSegment(segment);
    refs.forEach((ref, refIndex) => {
      const start = timecodeToSeconds(ref?.start ?? ref?.start_time ?? ref?.start_sec);
      const end = timecodeToSeconds(ref?.end ?? ref?.end_time ?? ref?.end_sec);
      const sceneId = String(ref?.scene_id || '').trim();
      if (start == null || end == null || end <= start) {
        errors.push(`${segmentId} source ref #${refIndex + 1} has invalid start/end`);
        return;
      }
      ranges.push({
        segmentId,
        segmentType: String(segment?.segment_type || 'recap'),
        sceneId,
        start,
        end
      });
    });
  }
  return ranges;
}

function validateSourceRanges(script, geminiAnalysis, errors, transcript = null) {
  const sceneMap = buildSceneMap(geminiAnalysis);
  const utteranceMap = buildUtteranceMap(transcript);
  const ranges = collectSourceRanges(script, errors);
  const epsilon = 0.001;
  const knownSourceDuration = Math.max(
    Number(geminiAnalysis?.source?.duration_sec || 0),
    Number(geminiAnalysis?.selected_source?.duration_sec || 0),
    Number(script?.source_reference?.duration_sec || 0)
  );

  for (const range of ranges) {
    if (Number.isFinite(knownSourceDuration) && knownSourceDuration > 0 && range.end > knownSourceDuration + epsilon) {
      errors.push(`${range.segmentId} source range exceeds known source duration (${range.end} > ${knownSourceDuration})`);
    }
    if (!['dialogue_quote', 'dialogue'].includes(range.segmentType)) continue;
    const segment = (script?.segments || []).find((item) => String(item?.segment_id || '') === range.segmentId);
    const uttId = String(segment?.utt_id || '').trim();
    const utterance = uttId ? utteranceMap.get(uttId) : null;
    if (utterance) {
      if (Math.abs(range.start - utterance.start) > epsilon || Math.abs(range.end - utterance.end) > epsilon) {
        errors.push(`${range.segmentId} dialogue range must equal transcript ${uttId} (${utterance.start}-${utterance.end})`);
      }
      const speed = Number(segment?.source_scenes?.[0]?.speed_multiplier || 1);
      if (Math.abs(speed - 1) > epsilon) {
        errors.push(`${range.segmentId} transcript dialogue must use speed_multiplier=1`);
      }
      continue;
    }
    const scene = sceneMap.get(range.sceneId);
    if (!scene) continue;
    if (!sceneHasDialogue(scene)) {
      errors.push(`${range.segmentId} dialogue_quote references ${range.sceneId} without dialogue_or_caption`);
    }
    const sceneStart = Number(scene.start_sec);
    const sceneEnd = Number(scene.end_sec);
    if (Number.isFinite(knownSourceDuration) && knownSourceDuration > 0 && Number.isFinite(sceneEnd) && sceneEnd > knownSourceDuration + epsilon) {
      errors.push(`${range.segmentId} dialogue_quote references ${range.sceneId} beyond known source duration (${sceneEnd} > ${knownSourceDuration})`);
    }
    if (Number.isFinite(sceneStart) && range.start < sceneStart - epsilon) {
      errors.push(`${range.segmentId} dialogue_quote starts before ${range.sceneId} (${range.start} < ${sceneStart})`);
    }
    if (Number.isFinite(sceneEnd) && range.end > sceneEnd + epsilon) {
      errors.push(`${range.segmentId} dialogue_quote ends after ${range.sceneId} (${range.end} > ${sceneEnd})`);
    }
  }

  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end || a.segmentId.localeCompare(b.segmentId));
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i];
      const b = sorted[j];
      if (b.start >= a.end - epsilon) break;
      const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
      if (overlap > epsilon) {
        errors.push(`${a.segmentId} and ${b.segmentId} source ranges overlap by ${overlap.toFixed(3)}s (${a.start}-${a.end} vs ${b.start}-${b.end})`);
      }
    }
  }

  const dialogueScenes = [...sceneMap.values()].filter(sceneHasDialogue).map((scene) => ({
    sceneId: String(scene?.scene_id || '').trim(),
    start: Number(scene?.start_sec),
    end: Number(scene?.end_sec),
    dialogue: String(scene?.dialogue_or_caption || '').trim()
  })).filter((scene) => Number.isFinite(scene.start) && Number.isFinite(scene.end) && scene.end > scene.start);

  for (const range of ranges) {
    for (const speech of dialogueScenes) {
      const overlap = Math.min(range.end, speech.end) - Math.max(range.start, speech.start);
      if (overlap <= epsilon) continue;
      if (!['dialogue_quote', 'dialogue'].includes(range.segmentType)) {
        errors.push(`${range.segmentId} ${range.segmentType} overlaps dialogue-only range ${speech.sceneId} by ${overlap.toFixed(3)}s (${speech.dialogue})`);
      }
    }
  }
}

function sourceSceneIds(geminiAnalysis) {
  return new Set((Array.isArray(geminiAnalysis?.scenes) ? geminiAnalysis.scenes : [])
    .map((scene) => String(scene?.scene_id || '').trim())
    .filter(Boolean));
}

function validateScript(script, geminiAnalysis, transcript = null) {
  const ids = sourceSceneIds(geminiAnalysis);
  const utteranceMap = buildUtteranceMap(transcript);
  const errors = [];
  const narrationAnchors = [];
  const knownSourceDuration = Math.max(
    Number(geminiAnalysis?.source?.duration_sec || 0),
    Number(geminiAnalysis?.selected_source?.duration_sec || 0),
    Number(script?.source_reference?.duration_sec || 0)
  );
  if (!Array.isArray(script?.segments) || script.segments.length === 0) {
    errors.push('segments must be a non-empty array');
  }
  for (const segment of script?.segments || []) {
    const segmentType = String(segment?.segment_type || 'recap');
    if (!['recap', 'dialogue_quote', 'dialogue', 'bridge'].includes(segmentType)) {
      errors.push(`${segment?.segment_id || '?'} segment_type is invalid`);
    }
    if (['dialogue_quote', 'dialogue'].includes(segmentType)) {
      if (segment.tts_enabled !== false) errors.push(`${segment?.segment_id || '?'} ${segmentType} must set tts_enabled=false`);
      if (!segment?.translated_caption_ko || typeof segment.translated_caption_ko !== 'string') {
        errors.push(`${segment?.segment_id || '?'} translated_caption_ko is required for ${segmentType}`);
      }
      const uttId = String(segment?.utt_id || '').trim();
      if (utteranceMap.size > 0 && !uttId) errors.push(`${segment?.segment_id || '?'} ${segmentType} must include utt_id`);
      if (uttId && !utteranceMap.has(uttId)) errors.push(`${segment?.segment_id || '?'} references missing transcript utt_id ${uttId}`);
    } else if (!segment?.narration || typeof segment.narration !== 'string') {
      errors.push(`${segment?.segment_id || '?'} narration is required`);
    } else {
      const anchor = storyAnchorRange(segment);
      const sceneRefs = storyAnchorSceneRefs(segment);
      if (!anchor) {
        errors.push(`${segment?.segment_id || '?'} story_anchor.source_range_hint is required for narration segments`);
      } else {
        if (anchor.start < 0) errors.push(`${segment?.segment_id || '?'} story_anchor starts before source`);
        if (Number.isFinite(knownSourceDuration) && knownSourceDuration > 0 && anchor.end > knownSourceDuration + 0.001) {
          errors.push(`${segment?.segment_id || '?'} story_anchor exceeds source duration (${anchor.end} > ${knownSourceDuration})`);
        }
        narrationAnchors.push({ segmentId: String(segment?.segment_id || '?'), ...anchor });
      }
      if (!sceneRefs.length) {
        errors.push(`${segment?.segment_id || '?'} story_anchor.scene_refs is required for narration segments`);
      }
      for (const sceneId of sceneRefs) {
        if (!ids.has(sceneId)) errors.push(`${segment?.segment_id || '?'} story_anchor references missing scene_id ${sceneId}`);
      }
    }
    const refs = Array.isArray(segment?.source_scenes) ? segment.source_scenes : [];
    if (!refs.length) {
      errors.push(`${segment?.segment_id || '?'} source_scenes is required`);
    }
    for (const ref of refs) {
      const sceneId = String(ref?.scene_id || '').trim();
      if (sceneId && !ids.has(sceneId) && !String(ref?.clip_id || '').startsWith('transcript_')) errors.push(`${segment?.segment_id || '?'} references missing scene_id ${sceneId}`);
    }
  }
  for (let index = 1; index < narrationAnchors.length; index += 1) {
    const previous = narrationAnchors[index - 1];
    const current = narrationAnchors[index];
    if (current.start + 0.001 < previous.start) {
      errors.push(`${current.segmentId} story_anchor moves backward (${current.start} < ${previous.start})`);
    }
  }
  if (Number.isFinite(knownSourceDuration) && knownSourceDuration > 0 && narrationAnchors.length) {
    const last = narrationAnchors[narrationAnchors.length - 1];
    const threshold = knownSourceDuration * 0.7;
    if (last.end < threshold) {
      errors.push(`${last.segmentId} final narration story_anchor must cover source after 70% (${last.end} < ${threshold.toFixed(3)})`);
    }
  }
  validateSourceRanges(script, geminiAnalysis, errors, transcript);
  if (errors.length) {
    throw createHttpError(500, 'GPT_CLI_SCRIPT_VALIDATION_FAILED', 'GPT CLI script failed validation', { errors });
  }
}

function forbiddenEndingCount(text) {
  const forbidden = ['에요', '어요', '네요', '거든요', '였어요', '라구요', '다구요', '고요', '겁니다', '까요'];
  return forbidden.reduce((count, token) => count + (String(text || '').includes(token) ? 1 : 0), 0);
}

function slotBudgetCharRange(slot) {
  const budget = Array.isArray(slot?.tts_budget_sec) ? slot.tts_budget_sec : [0, 0];
  const minSec = Number(budget[0] || 0);
  const maxSec = Number(budget[1] || 0);
  const minChars = slot?.require_min_chars === true ? Math.floor(minSec * 4) : Math.floor(minSec * 5);
  return [minChars, Math.ceil(maxSec * 6)];
}

function koreanSentences(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  return normalized
    .split(/(?<=[.!?。！？])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function hasPlainNovelDaEnding(sentence) {
  const trimmed = String(sentence || '').trim().replace(/["'”’)]*$/g, '');
  if (!/[가-힣]다[.!?。！？]?$/.test(trimmed)) return false;
  return !/[가-힣]니다[.!?。！？]?$/.test(trimmed);
}

function inferEndingPreset(geminiAnalysis = {}, options = {}) {
  const explicit = String(options.endingPreset || options.ending_preset || '').trim().toLowerCase();
  if (ENDING_RATIO_PRESETS[explicit]) return { key: explicit, ...ENDING_RATIO_PRESETS[explicit] };
  const genre = String(geminiAnalysis?.story_context?.genre || geminiAnalysis?.genre || '').trim().toLowerCase();
  if (/comedy|코미디/.test(genre)) return { key: 'comedy', ...ENDING_RATIO_PRESETS.comedy };
  if (/mystery|twist|suspense|미스터리|반전|서스펜스/.test(genre)) return { key: 'mystery', ...ENDING_RATIO_PRESETS.mystery };
  if (/drama|emotional|romance|드라마|감정|로맨스/.test(genre)) return { key: 'drama', ...ENDING_RATIO_PRESETS.drama };
  return { key: 'action', ...ENDING_RATIO_PRESETS.action };
}

function normalizeSentenceEndingText(sentence) {
  return String(sentence || '').trim().replace(/["'“”‘’()[\]{}]+$/g, '').replace(/[.!?。！？]+$/g, '').trim();
}

function classifyKoreanEnding(sentence) {
  const text = normalizeSentenceEndingText(sentence);
  if (!text) return 'other';
  if (/버렸(?:습니다|죠|는데)?$/.test(text)) return 'beoryeot';
  if (/(?:는데|했는데|였는데|이었는데|인데)$/.test(text)) return 'neunde';
  if (/(?:죠|했죠|였죠|이었죠|었죠|았죠)$/.test(text)) return 'jyo';
  if (/(?:습니다|했습니다|됩니다|였습니다|이었습니다|립니다|입니다|니다)$/.test(text)) return 'nida';
  if (hasPlainNovelDaEnding(text)) return 'plain_da';
  return 'other';
}

function endingDistributionStats(narrationBySlot) {
  const rows = [];
  const counts = { nida: 0, jyo: 0, neunde: 0, beoryeot: 0, plain_da: 0, other: 0 };
  narrationBySlot.forEach((item) => {
    koreanSentences(item.narration).forEach((sentence) => {
      const ending = classifyKoreanEnding(sentence);
      counts[ending] = (counts[ending] || 0) + 1;
      rows.push({ slotId: item.slotId, sentence, ending });
    });
  });
  const total = rows.length || 0;
  const pct = Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, total ? Number(((value / total) * 100).toFixed(1)) : 0]));
  return { total, counts, pct, rows };
}

function endingRatioFeedbackCandidates(stats) {
  return stats.rows
    .filter((row) => row.ending === 'nida')
    .sort((left, right) => {
      const leftObservation = OBSERVATION_ENDING_PHRASES.some((token) => left.sentence.includes(token)) ? 0 : 1;
      const rightObservation = OBSERVATION_ENDING_PHRASES.some((token) => right.sentence.includes(token)) ? 0 : 1;
      return leftObservation - rightObservation;
    })
    .slice(0, 5)
    .map((row) => `${row.slotId}: ${row.sentence}`);
}

function endingRatioValidationErrors(narrationBySlot, geminiAnalysis, options = {}) {
  const stats = endingDistributionStats(narrationBySlot);
  if (!stats.total) return [];
  const preset = inferEndingPreset(geminiAnalysis, options);
  const candidates = endingRatioFeedbackCandidates(stats);
  const candidateText = candidates.length ? ` 다음 문장들을 ~죠/~는데로 전환하라: [${candidates.join(' / ')}]` : '';
  const base = `어미 분포 현재 니다 ${stats.pct.nida}%, 죠 ${stats.pct.jyo}%, 는데 ${stats.pct.neunde}%, 버렸 ${stats.pct.beoryeot}% / 목표(${preset.key}) 니다 ${preset.nida}%, 죠 ${preset.jyo}%, 는데 ${preset.neunde}%, 버렸 ${preset.beoryeot}%.`;
  const errors = [];
  if (stats.pct.nida > preset.nida + 10) {
    errors.push(`${base} ~습니다/~니다 계열이 상한 ${preset.nida + 10}%를 초과했습니다.${candidateText}`);
  }
  if (stats.pct.jyo < Math.max(0, preset.jyo - 8)) {
    errors.push(`${base} ~죠 계열이 하한 ${Math.max(0, preset.jyo - 8)}% 미만입니다.${candidateText}`);
  }
  return errors;
}

function repeatedObservationPhraseErrors(narrationBySlot) {
  const phraseCounts = new Map();
  const observationCounts = new Map();
  narrationBySlot.forEach((item) => {
    koreanSentences(item.narration).forEach((sentence) => {
      OBSERVATION_ENDING_PHRASES.forEach((phrase) => {
        if (sentence.includes(phrase)) {
          const rows = observationCounts.get(phrase) || [];
          rows.push(`${item.slotId}: ${sentence}`);
          observationCounts.set(phrase, rows);
        }
      });
      const words = normalizeForSimilarity(sentence).filter((word) => word.length >= 2);
      for (let size = 3; size <= 5; size += 1) {
        for (let index = 0; index + size <= words.length; index += 1) {
          const phrase = words.slice(index, index + size).join(' ');
          if (phrase.length < 8) continue;
          const rows = phraseCounts.get(phrase) || [];
          rows.push(`${item.slotId}: ${sentence}`);
          phraseCounts.set(phrase, rows);
        }
      }
    });
  });
  const errors = [];
  observationCounts.forEach((rows, phrase) => {
    if (rows.length >= 3) {
      errors.push(`관찰/대기 서술구 "${phrase}"가 ${rows.length}회 반복됐습니다. 3회 이상 반복 금지: [${rows.slice(0, 5).join(' / ')}]`);
    }
  });
  phraseCounts.forEach((rows, phrase) => {
    const uniqueRows = [...new Set(rows)];
    if (uniqueRows.length >= 2) {
      errors.push(`동일 서술구 "${phrase}"가 2회 이상 반복됐습니다. 표현 레벨 중복입니다: [${uniqueRows.slice(0, 4).join(' / ')}]`);
    }
  });
  return errors.slice(0, 8);
}

function forbiddenNameTokens(geminiAnalysis = {}, profile = 'movie_recap') {
  if (isMovieRecapProfile(profile)) return ACTOR_REAL_NAME_TOKENS;
  const tokens = new Set([
    '수 스톰', '리드', '리드 리처즈', '벤 그림', '자니 스톰', '조니 스톰', '닥터 둠', '둠', '헤이거 장군',
    'Sue Storm', 'Sue', 'Reed Richards', 'Reed', 'Ben Grimm', 'Ben', 'Johnny Storm', 'Johnny', 'Dr. Doom', 'Doctor Doom', 'Doom', 'General Hager',
    'Fantastic Four', 'Rise of the Silver Surfer'
  ]);
  (Array.isArray(geminiAnalysis?.characters) ? geminiAnalysis.characters : []).forEach((character) => {
    ['name', 'original_name', 'canonical_name', 'character_name'].forEach((key) => {
      const value = String(character?.[key] || '').trim();
      if (value) tokens.add(value);
    });
    const safeName = String(character?.safe_display_name || '').trim();
    if (safeName) {
      tokens.add(safeName);
      tokens.add(safeName.replace(/_/g, ' '));
    }
  });
  const contentGuess = String(geminiAnalysis?.story_context?.content_guess || '').trim();
  if (contentGuess) tokens.add(contentGuess);
  return [...tokens].filter((token) => token.length >= 2);
}

function movieCharacterNameGuidance(geminiAnalysis = {}, movieResearch = null) {
  const names = (Array.isArray(geminiAnalysis?.characters) ? geminiAnalysis.characters : [])
    .map((character) => String(character?.safe_display_name || '').trim())
    .filter(Boolean);
  const researched = (Array.isArray(movieResearch?.movie_knowledge?.characters) ? movieResearch.movie_knowledge.characters : [])
    .flatMap((character) => [character?.screen_name, character?.role])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return [...new Set([...researched, ...names])];
}

function narrationSlotRole(slots, index) {
  const narrationIndexes = slots
    .map((slot, slotIndex) => (slot?.type === 'narration' ? slotIndex : -1))
    .filter((slotIndex) => slotIndex >= 0);
  const narrationOrder = narrationIndexes.indexOf(index);
  if (narrationOrder === 0) return 'hook';
  if (narrationOrder === narrationIndexes.length - 1) return 'payoff';
  const nextSlot = slots[index + 1];
  if (nextSlot?.type === 'dialogue') return 'setup';
  return 'bridge';
}

function slotRoleMap(slotMap = {}) {
  const slots = Array.isArray(slotMap?.slots) ? slotMap.slots : [];
  return Object.fromEntries(slots.map((slot, index) => [String(slot?.slot_id || ''), narrationSlotRole(slots, index)]).filter(([slotId]) => Boolean(slotId)));
}

function narrationRowsFromSlotFillScript(slotFillScript, slotMap) {
  const slots = Array.isArray(slotMap?.slots) ? slotMap.slots : [];
  const fills = Array.isArray(slotFillScript?.slot_fills) ? slotFillScript.slot_fills : [];
  const fillById = new Map(fills.map((fill) => [String(fill?.slot_id || ''), fill]));
  const roles = slotRoleMap(slotMap);
  return slots
    .map((slot, index) => ({
      slot,
      index,
      slotId: String(slot?.slot_id || ''),
      role: roles[String(slot?.slot_id || '')] || '',
      narration: String(fillById.get(String(slot?.slot_id || ''))?.narration || '').trim()
    }))
    .filter((item) => item.slot?.type === 'narration' && item.narration);
}

function earlyNarrationSlotIds(slotMap, limit = 2) {
  const slots = Array.isArray(slotMap?.slots) ? slotMap.slots : [];
  return slots.filter((slot) => slot?.type === 'narration').slice(0, limit).map((slot) => String(slot?.slot_id || '')).filter(Boolean);
}

function contiguousDialogueText(slots, fillsById, startIndex, direction) {
  const texts = [];
  for (let cursor = startIndex + direction; cursor >= 0 && cursor < slots.length; cursor += direction) {
    const slot = slots[cursor];
    if (slot?.type !== 'dialogue') break;
    const fill = fillsById.get(String(slot?.slot_id || ''));
    const text = String(fill?.caption_kr || slot?.caption_source_text || '').trim();
    if (text) {
      if (direction < 0) texts.unshift(text);
      else texts.push(text);
    }
  }
  return texts.join(' ');
}

function narrationReportingRestatement(text) {
  return /(신고됐|신고자는|확신했|살려 달라|죽이지 마|빌었|애원|말했|외쳤|소리쳤|명령했|안심시키는 듯|전해졌|알려졌)/.test(String(text || ''));
}

function defaultNarrationContextTracePath(options = {}) {
  const candidates = [options.slotMapPath, options.movieResearchPath, options.transcriptPath, options.sourceInfoPath]
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  if (!candidates.length) return '';
  return path.join(path.dirname(candidates[0]), 'narration_context_feedback_trace.jsonl');
}

function writeNarrationContextTrace(tracePath, payload) {
  if (!tracePath) return;
  fs.appendFileSync(tracePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function meaningfulKnowledgeParts(options = {}) {
  const knowledge = movieKnowledgeFromOptions(options);
  if (!knowledge) return { required: false, parts: [], earlySlotCount: 0 };
  const parts = [];
  const clipContext = String(knowledge?.clip_context || '').trim();
  const fullPlot = String(knowledge?.full_plot || '').trim();
  const stakes = String(knowledge?.stakes || '').trim();
  if (clipContext && clipContext !== fullPlot) parts.push(clipContext);
  if (stakes && stakes !== PASS0_STAKES_PLACEHOLDER) parts.push(stakes);
  (Array.isArray(knowledge?.characters) ? knowledge.characters : []).forEach((character) => {
    const screenName = String(character?.screen_name || '').trim();
    const role = String(character?.role || '').trim();
    const motivation = String(character?.motivation || '').trim();
    if (screenName && role && role !== GENERIC_MOVIE_KNOWLEDGE_ROLE) parts.push(`${screenName} ${role}`);
    if (motivation && motivation !== GENERIC_MOVIE_KNOWLEDGE_MOTIVATION) parts.push(motivation);
  });
  return { required: parts.length > 0, parts };
}

function knowledgeContextUsageAnalysis(slotFillScript, slotMap, options = {}) {
  const narrationRows = narrationRowsFromSlotFillScript(slotFillScript, slotMap);
  const earlyRows = narrationRows.slice(0, 2);
  const knowledge = meaningfulKnowledgeParts(options);
  if (!knowledge.required || !earlyRows.length) {
    return {
      required: false,
      used: false,
      slotIds: earlyRows.map((row) => row.slotId),
      matchedTokens: []
    };
  }
  const earlyText = earlyRows.map((row) => row.narration).join(' ');
  const knowledgeText = knowledge.parts.join(' ');
  const earlyTokens = new Set(normalizeForSimilarity(earlyText));
  const knowledgeTokens = new Set(normalizeForSimilarity(knowledgeText));
  const matchedTokens = [...earlyTokens].filter((token) => knowledgeTokens.has(token));
  const used = matchedTokens.length >= 2 || jaccardSimilarity(earlyText, knowledgeText) >= 0.12;
  return {
    required: true,
    used,
    slotIds: earlyRows.map((row) => row.slotId),
    matchedTokens: matchedTokens.slice(0, 8),
    earlyText,
    knowledgeText
  };
}

function collectNarrationContextFeedback(slotFillScript, slotMap, options = {}) {
  const slots = Array.isArray(slotMap?.slots) ? slotMap.slots : [];
  const fills = Array.isArray(slotFillScript?.slot_fills) ? slotFillScript.slot_fills : [];
  const fillsById = new Map(fills.map((fill) => [String(fill?.slot_id || ''), fill]));
  const narrationRows = narrationRowsFromSlotFillScript(slotFillScript, slotMap);
  const issues = [];
  narrationRows.forEach((row) => {
    const firstSentence = koreanSentences(row.narration)[0] || row.narration;
    const previousDialogue = contiguousDialogueText(slots, fillsById, row.index, -1);
    const nextDialogue = contiguousDialogueText(slots, fillsById, row.index, 1);
    const previousDialogueOverlap = previousDialogue ? Math.max(jaccardSimilarity(row.narration, previousDialogue), jaccardSimilarity(firstSentence, previousDialogue)) : 0;
    const nextDialogueOverlap = nextDialogue ? Math.max(jaccardSimilarity(row.narration, nextDialogue), jaccardSimilarity(firstSentence, nextDialogue)) : 0;
    if (previousDialogue && (previousDialogueOverlap >= 0.16 || narrationReportingRestatement(firstSentence))) {
      issues.push({
        slotId: row.slotId,
        type: 'after_dialogue_restatement',
        overlap: Number(previousDialogueOverlap.toFixed(2)),
        message: `${row.slotId} narration repeats the just-heard dialogue instead of adding meaning or irony (adjacent dialogue overlap ${previousDialogueOverlap.toFixed(2)}). After dialogue, add interpretation, consequence, or next curiosity.`
      });
    } else if (nextDialogue && (nextDialogueOverlap >= 0.16 || narrationReportingRestatement(firstSentence))) {
      issues.push({
        slotId: row.slotId,
        type: 'before_dialogue_restatement',
        overlap: Number(nextDialogueOverlap.toFixed(2)),
        message: `${row.slotId} setup narration rephrases adjacent dialogue facts instead of planting stakes or expectation (adjacent dialogue overlap ${nextDialogueOverlap.toFixed(2)}). Before dialogue, set up why the line matters.`
      });
    }
    const relay = screenRelayStats([{ slotId: row.slotId, narration: row.narration }]);
    const sceneSimilarity = jaccardSimilarity(row.narration, String(row.slot?.scene_summary || ''));
    if (relay.ratio >= 0.5 && sceneSimilarity >= 0.22) {
      issues.push({
        slotId: row.slotId,
        type: 'action_relay_restatement',
        overlap: Number(sceneSimilarity.toFixed(2)),
        message: `${row.slotId} narration mostly restates the visible action instead of adding consequence or interpretation (scene overlap ${sceneSimilarity.toFixed(2)}). Add meaning, irony, stakes, or the next question.`
      });
    }
  });
  const knowledge = knowledgeContextUsageAnalysis(slotFillScript, slotMap, options);
  if (knowledge.required && !knowledge.used && knowledge.slotIds.length) {
    issues.push({
      slotId: knowledge.slotIds[0],
      type: 'knowledge_context_missing',
      overlap: 0,
      message: `${knowledge.slotIds.join(', ')} early narration did not use supported Pass 0 context. In one early narration slot, introduce who the figure is or what is at stake using only movie_knowledge.clip_context/stakes.`
    });
  }
  const tracePath = String(options.narrationContextTracePath || options.narration_context_trace_path || defaultNarrationContextTracePath(options) || '').trim();
  writeNarrationContextTrace(tracePath, {
    checked_at: new Date().toISOString(),
    issues,
    knowledge_context_required: knowledge.required,
    knowledge_context_used: knowledge.used,
    knowledge_matched_tokens: knowledge.matchedTokens || []
  });
  return {
    errors: issues.map((issue) => issue.message),
    slotIds: new Set(issues.map((issue) => issue.slotId).filter(Boolean)),
    issues,
    knowledge,
    tracePath
  };
}

function hasFormalDialogueEnding(text) {
  return FORMAL_DIALOGUE_TOKENS.some((token) => String(text || '').includes(token));
}

function startsLikeVisualRelay(sentence) {
  const text = String(sentence || '').trim();
  if (!text) return false;
  return /^(수 스톰|실버 서퍼|인비저블 우먼|리드 리처즈|미스터 판타스틱|벤 그리무|벤 그림|휴먼 토치|조니 스톰|닥터 둠|군인|군 병력|미사일|장치|보드|숲|나무|그는|그녀는|그가|그녀가).{0,24}(봤|바라|올려다|내려다|서|앉|걷|뛰|날아|내려|다가|돌|움직|발사|스치|쓰러|멈췄|깜빡|흔들|포위|조준)/.test(text);
}

function isScreenRelaySentence(sentence) {
  const text = String(sentence || '').trim();
  if (!text) return false;
  const hasVisualVerb = VISUAL_RELAY_VERBS.some((token) => text.includes(token));
  const hasContextLayer = CONTEXT_LAYER_TERMS.some((token) => text.includes(token));
  return hasVisualVerb && !hasContextLayer;
}

function screenRelayStats(narrations) {
  const sentences = narrations.flatMap((item) => koreanSentences(item.narration || item));
  const relaySentences = sentences.filter(isScreenRelaySentence);
  return {
    sentences,
    relaySentences,
    ratio: sentences.length ? relaySentences.length / sentences.length : 0
  };
}

function groundednessLogForSlot(slot, fill) {
  const sourceText = [slot?.scene_summary, slot?.caption_source_text].map((item) => String(item || '')).join(' ');
  return koreanSentences(fill?.narration || '').map((sentence) => {
    const unsupported = UNGROUNDED_EVENT_PATTERNS
      .filter((pattern) => sentence.includes(pattern.token) && (pattern.alwaysForbidden || !sourceText.includes(pattern.token)))
      .map((pattern) => ({ token: pattern.token, reason: pattern.reason }));
    const contextHits = ALLOWED_MOVIE_CONTEXT_TERMS.filter((token) => sentence.includes(token));
    return {
      sentence,
      grounded: unsupported.length === 0,
      evidence: contextHits.length ? 'allowed_movie_context_or_source_fact' : 'slot_scene_summary_or_story_context',
      context_hits: contextHits,
      unsupported
    };
  });
}

function closingDripPresent(narrationBySlot) {
  const last = narrationBySlot[narrationBySlot.length - 1]?.narration || '';
  return FAST_CLOSING_DRIP_TOKENS.some((token) => last.includes(token));
}

function closingAftertastePresent(narrationBySlot) {
  const last = narrationBySlot[narrationBySlot.length - 1]?.narration || '';
  if (closingDripPresent(narrationBySlot)) return true;
  return FAST_CLOSING_AFTERTASTE_TOKENS.some((token) => last.includes(token));
}

function buildClosingDripValidationPrompt(lastNarration, options = {}) {
  const allowAftertasteClose = options.allowAftertasteClose === true;
  return [
    '# Closing Line Semantic Check',
    '',
    'Return JSON only. Do not use Markdown. Do not call tools. Do not edit files.',
    '',
    allowAftertasteClose
      ? 'Judge whether the final Korean narration functions as a valid ending line for a recap video. Count it as yes if it works as either (a) a viewer-facing closing joke/reaction/ironic payoff or (b) one short lingering emotional aftertaste line.'
      : 'Judge whether the final Korean narration functions as a valid ending line for a recap video. Count it as yes only if it works as a viewer-facing closing joke, ironic payoff, or reaction-inducing closing line.',
    'Do not require the literal tokens 여러분, 그러니까, 이쯤 되면, 웃긴 건, or 드립.',
    'A line can pass even without direct second-person address if it clearly lands as a closing joke, irony, reaction hook, or ending aftertaste.',
    'A flat factual summary with no closing effect should be no.',
    'Return {"verdict":"yes"|"no","reason":"..."}. Keep reason under 80 Korean characters.',
    '',
    'Final narration:',
    JSON.stringify(String(lastNarration || ''))
  ].join('\n');
}

function defaultClosingDripValidationTracePath(options = {}) {
  const candidates = [options.slotMapPath, options.movieResearchPath, options.transcriptPath, options.sourceInfoPath]
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  if (!candidates.length) return '';
  return path.join(path.dirname(candidates[0]), 'closing_drip_validation_trace.jsonl');
}

function writeClosingDripValidationTrace(tracePath, payload) {
  if (!tracePath) return;
  fs.appendFileSync(tracePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function evaluateClosingDrip(narrationBySlot, options = {}) {
  const lastNarration = String(narrationBySlot[narrationBySlot.length - 1]?.narration || '').trim();
  const allowAftertasteClose = options.allowAftertasteClose === true;
  const tracePath = String(options.closingDripValidationTracePath || options.closing_drip_validation_trace_path || defaultClosingDripValidationTracePath(options) || '').trim();
  if (!lastNarration) {
    return {
      passed: false,
      method: 'missing_last_narration',
      reason: 'last narration is empty',
      lastNarration,
      tracePath
    };
  }
  if (allowAftertasteClose ? closingAftertastePresent(narrationBySlot) : closingDripPresent(narrationBySlot)) {
    return {
      passed: true,
      method: 'token_matched',
      reason: 'matched fast closing token rule',
      lastNarration,
      tracePath
    };
  }
  const prompt = buildClosingDripValidationPrompt(lastNarration, { allowAftertasteClose });
  const result = await runCodexCli(prompt, {
    ...options,
    model: options.closingDripValidationModel || options.closing_drip_validation_model || options.naturalizationValidationModel || options.naturalization_validation_model || options.model,
    outputSchemaPath: MIDFORM_CLOSING_DRIP_VALIDATION_SCHEMA_PATH
  });
  const parsed = extractJson(result.outputText || result.stdout);
  const verdict = String(parsed?.verdict || '').trim().toLowerCase();
  const evaluation = {
    passed: verdict === 'yes',
    method: 'semantic_check',
    reason: String(parsed?.reason || '').trim(),
    verdict,
    lastNarration,
    promptPath: result.promptPath,
    outputPath: result.outputPath,
    tracePath
  };
  writeClosingDripValidationTrace(tracePath, {
    checked_at: new Date().toISOString(),
    method: evaluation.method,
    verdict: evaluation.verdict,
    passed: evaluation.passed,
    reason: evaluation.reason,
    allow_aftertaste_close: allowAftertasteClose,
    last_narration: lastNarration,
    promptPath: result.promptPath,
    outputPath: result.outputPath
  });
  return evaluation;
}

function normalizeForSimilarity(text) {
  return String(text || '')
    .replace(/[.!?。！？,，]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word.length >= 2 && !['그리고', '그런데', '하지만', '이때', '문제는', '결국', '진짜'].includes(word));
}

function jaccardSimilarity(left, right) {
  const a = new Set(normalizeForSimilarity(left));
  const b = new Set(normalizeForSimilarity(right));
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  a.forEach((token) => { if (b.has(token)) intersection += 1; });
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}

function validateStoryOutline(storyOutline, profile = 'movie_recap') {
  const errors = [];
  if (!storyOutline || typeof storyOutline !== 'object') errors.push('story_outline must be an object');
  if (!String(storyOutline?.premise || '').trim()) errors.push('story_outline.premise is required');
  if (!String(storyOutline?.arc || '').trim()) errors.push('story_outline.arc is required');
  const beats = Array.isArray(storyOutline?.beats) ? storyOutline.beats : [];
  if (!beats.length) errors.push('story_outline.beats must be non-empty');
  beats.forEach((beat, index) => {
    const beatId = String(beat?.beat_id || `beat#${index + 1}`);
    const event = String(beat?.story_event || '').trim();
    const range = Array.isArray(beat?.source_range) ? beat.source_range : [];
    if (!event) errors.push(`${beatId} story_event is required`);
    const termHits = cameraMetaTermHits(event);
    if (termHits.length) errors.push(`${beatId} story_event includes camera/editing term(s): ${termHits.join(', ')}`);
    if (isMovieRecapProfile(profile)) {
      const evasiveHits = EVASIVE_MOVIE_LABELS.filter((term) => event.includes(term));
      if (evasiveHits.length) errors.push(`${beatId} story_event uses evasive movie label(s): ${evasiveHits.join(', ')}`);
    }
    if (range.length !== 2 || !Number.isFinite(Number(range[0])) || !Number.isFinite(Number(range[1])) || Number(range[1]) <= Number(range[0])) {
      errors.push(`${beatId} source_range must be [start,end]`);
    }
  });
  if (errors.length) {
    throw createHttpError(500, 'GPT_STORY_OUTLINE_VALIDATION_FAILED', 'GPT story outline failed validation', { errors });
  }
}

function collectSlotFillValidationErrors(slotFillScript, slotMap, geminiAnalysis = {}, options = {}) {
  const profile = resolveContentProfile(geminiAnalysis, options);
  const slots = Array.isArray(slotMap?.slots) ? slotMap.slots : [];
  const fills = Array.isArray(slotFillScript?.slot_fills) ? slotFillScript.slot_fills : [];
  const errors = [];
  const forbiddenNames = forbiddenNameTokens(geminiAnalysis, profile);
  const roles = slotRoleMap(slotMap);
  const narrationBySlot = [];
  const combinedTextParts = [];
  let plainDaEndingCount = 0;
  let narrationSentenceCount = 0;
  if (!slots.length) errors.push('slot_map.slots is required');
  if (fills.length !== slots.length) errors.push(`slot_fills length must equal slot count (${fills.length} !== ${slots.length})`);
  const fillById = new Map(fills.map((fill) => [String(fill?.slot_id || ''), fill]));
  slots.forEach((slot, index) => {
    const slotId = String(slot?.slot_id || '');
    const fill = fillById.get(slotId);
    if (!fill) {
      errors.push(`${slotId || `slot#${index + 1}`} is missing from slot_fills`);
      return;
    }
    if (String(fills[index]?.slot_id || '') !== slotId) {
      errors.push(`${slotId} slot order changed`);
    }
    if (slot.type === 'narration') {
      const narration = String(fill.narration || '').trim();
      combinedTextParts.push(narration);
      if (!narration) errors.push(`${slotId} narration is required`);
      const [minChars, maxChars] = slotBudgetCharRange(slot);
      const charCount = narration.replace(/\s+/g, '').length;
      const effectiveMinChars = slot.require_min_chars === true ? Math.floor(minChars * 0.9) : minChars;
      if (slot.require_min_chars === true && charCount < effectiveMinChars) {
        errors.push(`${slotId} narration char count ${charCount} is below dialogue-heavy budget min ${effectiveMinChars}`);
      }
      const effectiveMaxChars = slot.require_min_chars === true ? Math.ceil(maxChars * 1.15) : maxChars;
      if (minChars > 0 && charCount > effectiveMaxChars) {
        errors.push(`${slotId} narration char count ${charCount} exceeds budget max ${effectiveMaxChars}`);
      }
      if (forbiddenEndingCount(narration) > 0) errors.push(`${slotId} narration includes forbidden ending`);
      const nameHits = forbiddenNames.filter((token) => narration.includes(token));
      if (nameHits.length) errors.push(`${slotId} narration uses real/unsafe character name(s): ${nameHits.join(', ')}`);
      if (isMovieRecapProfile(profile)) {
        const evasiveHits = EVASIVE_MOVIE_LABELS.filter((token) => narration.includes(token));
        if (evasiveHits.length) errors.push(`${slotId} narration uses evasive movie label(s): ${evasiveHits.join(', ')}`);
      }
      const cameraTermHits = cameraMetaTermHits(narration);
      if (cameraTermHits.length) errors.push(`${slotId} narration includes camera/editing term(s): ${cameraTermHits.join(', ')}`);
      const hanjaHits = compressedHanjaHits(narration);
      if (hanjaHits.length) errors.push(`${slotId} narration uses compressed Sino-Korean phrase(s): ${hanjaHits.join(', ')}. Rewrite for middle-school spoken comprehension.`);
      const groundedness = groundednessLogForSlot(slot, fill);
      groundedness.forEach((item) => {
        if (item.unsupported.length) {
          errors.push(`${slotId} ungrounded narration event: "${item.sentence}" (${item.unsupported.map((hit) => `${hit.token}: ${hit.reason}`).join('; ')})`);
        }
      });
      const sentences = koreanSentences(narration);
      if (roles[slotId] === 'hook' && startsLikeVisualRelay(sentences[0] || narration)) {
        errors.push(`${slotId} hook narration starts like screen relay; open with contradiction/stakes, not visible action`);
      }
      narrationSentenceCount += sentences.length;
      plainDaEndingCount += sentences.filter(hasPlainNovelDaEnding).length;
      narrationBySlot.push({ slotId, narration });
    } else if (slot.type === 'dialogue') {
      const caption = String(fill.caption_kr || '').trim();
      combinedTextParts.push(caption);
      if (String(fill.narration || '').trim()) errors.push(`${slotId} narration must be empty for dialogue slots`);
      if (!caption) errors.push(`${slotId} caption_kr is required for dialogue slots`);
      if (hasFormalDialogueEnding(caption)) errors.push(`${slotId} dialogue caption uses formal/report style; use urgent colloquial Korean`);
      if (isCodewordSlot(slot, options)) {
        const literalHits = ['심장', '꿈', '사람들이 돌아', '귀환', '그 사람', '화물선'].filter((token) => caption.includes(token));
        const hasCodewordFeel = CODEWORD_TRANSLATION_HINTS.some((token) => caption.includes(token));
        if (literalHits.length && !hasCodewordFeel) errors.push(`${slotId} codeword dialogue was literally translated (${literalHits.join(', ')}); use chant/codeword feeling or ellipsis instead`);
      }
      const qualityIssue = dialogueQualityIssue({
        text: String(caption || slot.caption_source_text || ''),
        start: Array.isArray(slot.source_range) ? Number(slot.source_range[0]) : 0,
        end: Array.isArray(slot.source_range) ? Number(slot.source_range[1]) : 0,
        movieKnowledge: movieKnowledgeFromOptions(options),
        allowCodeword: /세뇌|암시어|코드|codeword|winter soldier|benign|freight car|грузовой/i.test(String(slot.scene_summary || slot.caption_source_text || ''))
      });
      if (qualityIssue) errors.push(`${slotId} dialogue quality failed: ${qualityIssue}`);
    }
  });
  namingConsistencyErrors(combinedTextParts.join('\n'), options).forEach((error) => errors.push(`character naming inconsistency: ${error}`));
  const relay = screenRelayStats(narrationBySlot);
  if (relay.ratio > 0.5) {
    errors.push(`screen-relay narration exceeds 50% (${relay.relaySentences.length}/${relay.sentences.length}, ${(relay.ratio * 100).toFixed(1)}%)`);
  }
  if (narrationSentenceCount > 0) {
    const plainDaRatio = plainDaEndingCount / narrationSentenceCount;
    if (plainDaRatio > 0.3) {
      errors.push(`plain ~다 narration endings exceed 30% (${plainDaEndingCount}/${narrationSentenceCount}, ${(plainDaRatio * 100).toFixed(1)}%)`);
    }
  }
  endingRatioValidationErrors(narrationBySlot, geminiAnalysis, { ...options, slotMap }).forEach((error) => errors.push(error));
  repeatedObservationPhraseErrors(narrationBySlot).forEach((error) => errors.push(error));
  for (let i = 0; i < narrationBySlot.length; i += 1) {
    for (let j = i + 1; j < narrationBySlot.length; j += 1) {
      const similarity = jaccardSimilarity(narrationBySlot[i].narration, narrationBySlot[j].narration);
      if (similarity >= 0.55) {
        errors.push(`${narrationBySlot[i].slotId} and ${narrationBySlot[j].slotId} narrations look like duplicate event descriptions (${similarity.toFixed(2)})`);
      }
    }
  }
  return errors;
}

async function collectClosingDripValidationErrors(slotFillScript, slotMap, options = {}) {
  const slots = Array.isArray(slotMap?.slots) ? slotMap.slots : [];
  const fills = Array.isArray(slotFillScript?.slot_fills) ? slotFillScript.slot_fills : [];
  const fillById = new Map(fills.map((fill) => [String(fill?.slot_id || ''), fill]));
  const narrationBySlot = slots
    .filter((slot) => slot?.type === 'narration')
    .map((slot) => ({
      slotId: String(slot?.slot_id || ''),
      narration: String(fillById.get(String(slot?.slot_id || ''))?.narration || '').trim()
    }))
    .filter((item) => item.narration);
  if (!narrationBySlot.length) return [];
  const shortSlotScript = slots.length <= 2;
  const dialogueHeavyMode = slotMap?.dialogue_heavy_mode === true || String(slotMap?.composition_mode || '').startsWith('dialogue_heavy');
  const allowAftertasteClose = shortSlotScript || dialogueHeavyMode;
  const evaluation = options.closingDripEvaluation || await evaluateClosingDrip(narrationBySlot, { ...options, allowAftertasteClose });
  if (evaluation.passed) return [];
  return [allowAftertasteClose
    ? 'payoff narration lacks a closing drip/reaction or lingering aftertaste line; for scripts with 2 slots or fewer, end with either a grounded viewer-facing reaction or one reflective aftertaste line'
    : 'payoff narration lacks a closing drip/reaction line; end with a grounded short viewer-facing joke or reaction'];
}

async function validateSlotFills(slotFillScript, slotMap, geminiAnalysis = {}, options = {}) {
  const errors = collectSlotFillValidationErrors(slotFillScript, slotMap, geminiAnalysis, options);
  if (errors.length) {
    throw createHttpError(500, 'GPT_SLOT_FILLS_VALIDATION_FAILED', 'GPT slot fills failed validation', { errors });
  }
  const closingDripErrors = await collectClosingDripValidationErrors(slotFillScript, slotMap, options);
  if (closingDripErrors.length) {
    throw createHttpError(500, 'GPT_SLOT_FILLS_VALIDATION_FAILED', 'GPT slot fills failed validation', { errors: closingDripErrors });
  }
}

function parseSlotOverlengthError(error) {
  const match = String(error || '').match(/^(s\d+) narration char count (\d+) exceeds budget max (\d+)$/);
  if (!match) return null;
  return {
    slotId: match[1],
    actualChars: Number(match[2]),
    maxChars: Number(match[3]),
    excessChars: Number(match[2]) - Number(match[3])
  };
}

function parseSlotForbiddenEndingError(error) {
  const match = String(error || '').match(/^(s\d+) narration includes forbidden ending$/);
  if (!match) return null;
  return { slotId: match[1] };
}

function parseEndingDistributionError(error) {
  const text = String(error || '');
  if (!text.includes('어미 분포 현재')) return null;
  return { message: text };
}

function buildStructuredValidationWarnings(errors) {
  return (errors || []).map((error) => {
    const overlength = parseSlotOverlengthError(error);
    if (overlength) {
      return {
        slot_id: overlength.slotId,
        rule_code: 'NARRATION_OVER_BUDGET',
        message: String(error),
        actual: overlength.actualChars,
        threshold: overlength.maxChars,
        severity: 'warning'
      };
    }
    const forbiddenEnding = parseSlotForbiddenEndingError(error);
    if (forbiddenEnding) {
      return {
        slot_id: forbiddenEnding.slotId,
        rule_code: 'FORBIDDEN_ENDING',
        message: String(error),
        actual: null,
        threshold: null,
        severity: 'warning'
      };
    }
    const endingDistribution = parseEndingDistributionError(error);
    if (endingDistribution) {
      return {
        slot_id: '',
        rule_code: 'ENDING_DISTRIBUTION',
        message: endingDistribution.message,
        actual: null,
        threshold: null,
        severity: 'warning'
      };
    }
    const slotMatch = String(error || '').match(/^(s\d+)/);
    return {
      slot_id: slotMatch ? slotMatch[1] : '',
      rule_code: 'QUALITY_GATE_WARNING',
      message: String(error),
      actual: null,
      threshold: null,
      severity: 'warning'
    };
  });
}

function isOnlyInteractiveReviewDeferrableErrors(errors) {
  const parsed = (errors || []).map(parseSlotOverlengthError).filter(Boolean);
  return parsed.length > 0 && parsed.length === (errors || []).length;
}

function buildOverlengthRetryFeedback(errors) {
  const rows = (errors || []).map(parseSlotOverlengthError).filter(Boolean);
  if (!rows.length) return '';
  return [
    'Length correction rule: the following narration slots exceeded the slot-map max character budget. Rewrite them shorter while preserving the same facts and tone.',
    ...rows.map((row) => `- ${row.slotId}: ${row.actualChars} chars > max ${row.maxChars} chars (shorten by at least ${row.excessChars} chars)`),
    'Do not change any slot that is not listed above.'
  ].join('\n');
}

function buildNaturalizationValidationPrompt(slotFillScript, slotMap) {
  const narrationFills = (Array.isArray(slotFillScript?.slot_fills) ? slotFillScript.slot_fills : [])
    .filter((fill) => String(fill?.narration || '').trim())
    .map((fill) => ({ slot_id: String(fill.slot_id || ''), narration: String(fill.narration || '') }));
  return [
    '# Korean Naturalization Principle Validation',
    '',
    'Return JSON only. Do not use Markdown. Do not call tools. Do not edit files.',
    '',
    'Judge each Korean narration sentence by one principle:',
    '- Would a Korean viewer naturally say or understand this as a friend explaining a movie scene out loud?',
    '- Flag sentences that sound like military briefings, strategy reports, corporate summaries, translated noun chains, or abstract control-system labels.',
    '- Also flag grammatically incomplete Korean sentences where a required subject, object, complement, or predicate argument is missing.',
    '- Especially catch dangling expressions such as "아직 안 났는데" when what has not been decided/settled is omitted; suggest a complete phrase like "결판이 아직 안 났는데" when appropriate.',
    '- Do not flag a sentence just because it uses formal narration endings like ~습니다 or ~죠.',
    '- Do flag report/briefing wording such as "제압 루프로", "판단을 재정렬", "장치 협업으로", "전투를 먼저 완수".',
    '',
    'For every issue, include the exact slot_id, exact sentence, short reason, and rewrite direction.',
    'If there are no issues, return {"issues":[]}.',
    '',
    'Slot map context:',
    JSON.stringify({ slots: (slotMap?.slots || []).map((slot) => ({ slot_id: slot.slot_id, type: slot.type, scene_summary: slot.scene_summary })) }, null, 2),
    '',
    'Narration fills to judge:',
    JSON.stringify(narrationFills, null, 2)
  ].join('\n');
}

function naturalizationIssuesToErrors(report) {
  const issues = Array.isArray(report?.issues) ? report.issues : [];
  return issues
    .map((issue) => ({
      slotId: String(issue?.slot_id || '').trim(),
      sentence: String(issue?.sentence || '').trim(),
      reason: String(issue?.reason || '').trim(),
      suggestedDirection: String(issue?.suggested_direction || '').trim()
    }))
    .filter((issue) => issue.slotId && issue.sentence)
    .map((issue) => `${issue.slotId} naturalization principle failed: "${issue.sentence}" (${issue.reason || 'sounds like report/briefing language'}; rewrite direction: ${issue.suggestedDirection || 'make it spoken movie-story Korean'})`);
}

function unchangedSlotFillErrors(previousSlotFillScript, nextSlotFillScript, allowedSlotIds) {
  if (!previousSlotFillScript || !nextSlotFillScript || !allowedSlotIds?.size) return [];
  const previousById = new Map((previousSlotFillScript.slot_fills || []).map((fill) => [String(fill.slot_id || ''), fill]));
  const nextById = new Map((nextSlotFillScript.slot_fills || []).map((fill) => [String(fill.slot_id || ''), fill]));
  const errors = [];
  previousById.forEach((previousFill, slotId) => {
    if (!slotId || allowedSlotIds.has(slotId)) return;
    const nextFill = nextById.get(slotId);
    if (!nextFill) return;
    const previousStable = JSON.stringify(previousFill);
    const nextStable = JSON.stringify(nextFill);
    if (previousStable !== nextStable) {
      errors.push(`${slotId} changed during targeted naturalization retry; only flagged slots may change`);
    }
  });
  return errors;
}

function slotIdsFromValidationErrors(errors) {
  const slotIds = new Set();
  (errors || []).forEach((error) => {
    const match = String(error || '').match(/^(s\d+)/);
    if (match) slotIds.add(match[1]);
  });
  return slotIds;
}

async function collectNaturalizationPrincipleErrors(slotFillScript, slotMap, options = {}) {
  if (options.disableNaturalizationPrincipleGate === true || options.disable_naturalization_principle_gate === true) return [];
  const narrationFills = (Array.isArray(slotFillScript?.slot_fills) ? slotFillScript.slot_fills : []).filter((fill) => String(fill?.narration || '').trim());
  if (!narrationFills.length) return [];
  const prompt = buildNaturalizationValidationPrompt(slotFillScript, slotMap);
  const result = await runCodexCli(prompt, {
    ...options,
    model: options.naturalizationValidationModel || options.naturalization_validation_model || options.model,
    outputSchemaPath: MIDFORM_NATURALIZATION_VALIDATION_SCHEMA_PATH
  });
  const parsed = extractJson(result.outputText || result.stdout);
  const errors = naturalizationIssuesToErrors(parsed);
  if (errors.length && options.naturalizationValidationTracePath) {
    fs.writeFileSync(options.naturalizationValidationTracePath, `${JSON.stringify({ promptPath: result.promptPath, outputPath: result.outputPath, report: parsed, errors }, null, 2)}\n`, 'utf8');
  }
  return errors;
}

function secondsToSlotTimecode(seconds) {
  return secondsToTimecode(Number(seconds) || 0);
}

async function normalizeSlotFillsToScript(slotFillScript, slotMap, geminiAnalysis, options = {}) {
  if (options.skipSlotFillValidation !== true) {
    await validateSlotFills(slotFillScript, slotMap, geminiAnalysis, options);
  }
  const fillById = new Map(slotFillScript.slot_fills.map((fill) => [String(fill.slot_id), fill]));
  const source = geminiAnalysis?.source || {};
  const contentContext = geminiAnalysis?.story_context || {};
  const contentProfile = resolveContentProfile(geminiAnalysis, options);
  const segments = slotMap.slots.map((slot, index) => {
    const fill = fillById.get(String(slot.slot_id));
    const [start, end] = Array.isArray(slot.source_range) ? slot.source_range : [0, 0];
    const sceneId = String(slot.scene_id || slot.scene_ids?.[0] || 'slot_map');
    if (slot.type === 'dialogue') {
      return {
        segment_id: String(slot.slot_id),
        segment_type: 'dialogue_quote',
        slot_id: String(slot.slot_id),
        scene_summary: String(slot.scene_summary || ''),
        utt_id: String(slot.utt_id || ''),
        tts_enabled: false,
        narration: '',
        dialogue_original: String(slot.caption_source_text || ''),
        translated_caption_ko: String(fill.caption_kr || ''),
        caption_text: String(fill.caption_kr || ''),
        source_scenes: [{
          clip_id: `slot_${slot.slot_id}`,
          scene_id: sceneId,
          start: secondsToSlotTimecode(start),
          end: secondsToSlotTimecode(end),
          speed_multiplier: 1
        }],
        source_clips: [{
          clip_id: `slot_${slot.slot_id}`,
          scene_id: sceneId,
          start: secondsToSlotTimecode(start),
          end: secondsToSlotTimecode(end),
          speed_multiplier: 1,
          source: 'slot_map_dialogue'
        }],
        edit_instruction: { visual_role: 'slot_dialogue', pace: 'hold', transition: 'cut', zoom: 'medium', sfx: [] }
      };
    }
    return {
      segment_id: String(slot.slot_id),
      segment_type: 'recap',
      storytelling_role: narrationSlotRole(slotMap.slots, index),
      slot_id: String(slot.slot_id),
      scene_summary: String(slot.scene_summary || ''),
      utt_id: '',
      tts_enabled: true,
      narration: String(fill.narration || ''),
      caption_units: Array.isArray(fill.caption_units) ? fill.caption_units.map((item) => String(item || '').trim()).filter(Boolean) : [],
      dialogue_original: '',
      translated_caption_ko: '',
      caption_text: String(fill.narration || ''),
      source_scenes: [{
        clip_id: `slot_${slot.slot_id}`,
        scene_id: sceneId,
        start: secondsToSlotTimecode(start),
        end: secondsToSlotTimecode(end),
        speed_multiplier: 1
      }],
      source_clips: [{
        clip_id: `slot_${slot.slot_id}`,
        scene_id: sceneId,
        start: secondsToSlotTimecode(start),
        end: secondsToSlotTimecode(end),
        speed_multiplier: 1,
        source: 'slot_map_narration'
      }],
      edit_instruction: { visual_role: 'slot_narration', pace: 'snappy', transition: 'cut', zoom: 'medium', sfx: [] },
      order: index + 1
    };
  });
  const now = new Date().toISOString();
  const scriptId = String(slotFillScript.script_id || options.scriptId || crypto.randomUUID());
  const endingPreset = inferEndingPreset(geminiAnalysis, options);
  const narrationEndingStats = endingDistributionStats(segments.filter((segment) => segment.tts_enabled !== false).map((segment) => ({ slotId: segment.segment_id, narration: segment.narration })));
  const shortSlotScript = Array.isArray(slotMap?.slots) && slotMap.slots.length <= 2;
  const dialogueHeavyMode = slotMap?.dialogue_heavy_mode === true || String(slotMap?.composition_mode || '').startsWith('dialogue_heavy');
  const knowledgeContextEvaluation = options.knowledgeContextEvaluation || knowledgeContextUsageAnalysis(slotFillScript, slotMap, options);
  const closingDripEvaluation = options.closingDripEvaluation || await evaluateClosingDrip(
    segments.filter((segment) => segment.tts_enabled !== false).map((segment) => ({ slotId: segment.segment_id, narration: segment.narration })),
    { ...options, allowAftertasteClose: shortSlotScript || dialogueHeavyMode }
  );
  return {
    script_id: scriptId,
    source_reference: {
      gemini_analysis_source_id: String(source.source_id || ''),
      duration_sec: Number(slotMap.source_duration_sec || source.duration_sec || 0)
    },
    content_context: {
      content_guess: String(contentContext.content_guess || ''),
      genre: String(contentContext.genre || ''),
      content_profile: contentProfile,
      style_hint_used: String(options.style_hint || 'slot-map-first midform hybrid'),
      movie_identity: movieResearchFromOptions(options)?.movie_identity || null,
      movie_knowledge: movieResearchFromOptions(options)?.movie_knowledge || null
    },
    slot_map: slotMap,
    story_outline: options.storyOutline || options.story_outline || null,
    slot_fills: slotFillScript.slot_fills,
    segments,
    quality_check: {
      segment_count: segments.length,
      estimated_total_duration_sec: Number(slotMap.total_output_estimate_sec || 0),
      duration_within_60_180: Number(slotMap.total_output_estimate_sec || 0) >= 60 && Number(slotMap.total_output_estimate_sec || 0) <= 180,
      all_scene_ids_exist_in_gemini_analysis: true,
      no_source_scene_exceeds_30_sec: true,
      korean_ending_rules_ok: Number(slotFillScript?.quality_check?.forbidden_eomi_count || 0) === 0,
      knowledge_context_used: Boolean(knowledgeContextEvaluation.used),
      dialogue_quote_count: segments.filter((segment) => segment.segment_type === 'dialogue_quote').length,
      recap_tts_segment_count: segments.filter((segment) => segment.tts_enabled !== false).length,
      ending_rules_check: {
        preset: endingPreset.key,
        target_eomi_ratio_seumnida_pct: endingPreset.nida,
        target_eomi_ratio_jyo_pct: endingPreset.jyo,
        target_eomi_ratio_neunde_pct: endingPreset.neunde,
        target_eomi_ratio_beoryeot_pct: endingPreset.beoryeot,
        eomi_ratio_seumnida_pct: narrationEndingStats.pct.nida,
        eomi_ratio_jyo_pct: narrationEndingStats.pct.jyo,
        eomi_ratio_neunde_pct: narrationEndingStats.pct.neunde,
        eomi_ratio_beoryeot_pct: narrationEndingStats.pct.beoryeot,
        eomi_sentence_count: narrationEndingStats.total,
        forbidden_eomi_count: Number(slotFillScript?.quality_check?.forbidden_eomi_count || 0),
        character_naming_consistent: true,
        real_name_used: false,
        mystery_4steps_applied: !isMovieRecapProfile(contentProfile),
        closing_drip_present: closingDripEvaluation.passed
      }
    },
    created_at: now
  };
}

function normalizeScript(script, geminiAnalysis, options = {}) {
  const now = new Date().toISOString();
  const source = geminiAnalysis?.source || {};
  const utteranceMap = buildUtteranceMap(options.transcript || null);
  const segments = (Array.isArray(script?.segments) ? script.segments : []).map((segment, index) => {
    const segmentType = String(segment?.segment_type || 'recap');
    const safeType = ['recap', 'dialogue_quote', 'dialogue', 'bridge'].includes(segmentType) ? segmentType : 'recap';
    const narration = String(segment?.narration || '');
    const translatedCaption = String(segment?.translated_caption_ko || segment?.caption_text || narration || '');
    const uttId = String(segment?.utt_id || '').trim();
    const utterance = uttId ? utteranceMap.get(uttId) : null;
    const normalizedSourceScenes = Array.isArray(segment?.source_scenes) ? [...segment.source_scenes] : [];
    if (utterance && ['dialogue_quote', 'dialogue'].includes(safeType)) {
      normalizedSourceScenes.splice(0, normalizedSourceScenes.length, {
        clip_id: `transcript_${uttId}`,
        scene_id: String(normalizedSourceScenes?.[0]?.scene_id || ''),
        start: secondsToTimecode(utterance.start),
        end: secondsToTimecode(utterance.end),
        speed_multiplier: 1
      });
    }
    return {
      ...segment,
      segment_id: String(segment?.segment_id || `seg_${String(index + 1).padStart(2, '0')}`),
      segment_type: safeType,
      utt_id: uttId,
      tts_enabled: ['dialogue_quote', 'dialogue'].includes(safeType) ? false : segment?.tts_enabled !== false,
      narration,
      dialogue_original: String(segment?.dialogue_original || utterance?.text || ''),
      translated_caption_ko: translatedCaption,
      caption_text: String(segment?.caption_text || translatedCaption || narration || ''),
      story_anchor: segment?.story_anchor && typeof segment.story_anchor === 'object'
        ? segment.story_anchor
        : { source_range_hint: [], scene_refs: [] },
      source_scenes: normalizedSourceScenes
    };
  });
  const normalized = {
    script_id: String(script?.script_id || options.scriptId || crypto.randomUUID()),
    source_reference: {
      gemini_analysis_source_id: String(script?.source_reference?.gemini_analysis_source_id || source.source_id || ''),
      duration_sec: Number(script?.source_reference?.duration_sec || source.duration_sec || 0)
    },
    content_context: {
      content_guess: String(script?.content_context?.content_guess || geminiAnalysis?.story_context?.content_guess || ''),
      genre: String(script?.content_context?.genre || geminiAnalysis?.story_context?.genre || ''),
      style_hint_used: String(script?.content_context?.style_hint_used || options.style_hint || ''),
      movie_identity: script?.content_context?.movie_identity || movieResearchFromOptions(options)?.movie_identity || null,
      movie_knowledge: script?.content_context?.movie_knowledge || movieResearchFromOptions(options)?.movie_knowledge || null
    },
    segments,
    quality_check: script?.quality_check && typeof script.quality_check === 'object' ? script.quality_check : {},
    created_at: String(script?.created_at || now)
  };
  normalized.quality_check.segment_count = normalized.segments.length;
  normalized.quality_check.all_scene_ids_exist_in_gemini_analysis = true;
  normalized.quality_check.knowledge_context_used = Boolean(normalized.quality_check.knowledge_context_used);
  normalized.quality_check.dialogue_quote_count = normalized.segments.filter((segment) => segment.segment_type === 'dialogue_quote').length;
  normalized.quality_check.recap_tts_segment_count = normalized.segments.filter((segment) => segment.tts_enabled !== false).length;
  return normalized;
}

function buildGptMidformPrompt(geminiAnalysis, options = {}) {
  const condensed = condenseGeminiAnalysis(geminiAnalysis, options.scene_condensation || {});
  const schema = JSON.parse(fs.readFileSync(MIDFORM_SCHEMA_PATH, 'utf8'));
  const transcript = options.transcript || loadTranscriptFromOptions(options);
  const utterances = transcriptUtterances(transcript);
  const movieResearch = movieResearchFromOptions(options);
  return [
    '# GPT Midform Script Generation',
    '',
    'You are writing a Korean YouTube midform movie recap script from structured scene facts.',
    'Return JSON only. Do not use Markdown. Do not call tools. Do not edit files.',
    '',
    '## Korean writing rules',
    '- Natural Korean YouTube narration, not translationese.',
    '- Build a clear hook, setup, conflict, climax, and ending.',
    '- Use scene_beats as narrative units, not the raw 45-scene list.',
    '- Keep original scene_id values inside every segment.source_scenes item.',
    '- Do not invent names, crimes, sexual content, or outcomes not supported by the source.',
    '- Avoid endings with repeated question marks; use at most one question mark when needed.',
    '- One sentence should fit one spoken line when possible.',
    '',
    '## Entertainment and E-9 tone rules',
    '- Do not write like a neutral summary. Write like a Korean YouTube recap narrator reacting to the scene.',
    '- Every 2-3 captions should create a mini rhythm: setup -> twist -> payoff.',
    '- Use at least one of these in each recap/bridge segment: curiosity gap, ironic contrast, character reaction, stakes reminder, or short punchline.',
    '- Useful Korean connectors: "문제는", "그런데", "이때", "하필", "진짜 문제는", "여기서 웃긴 건", "분위기가 이상해집니다".',
    '- Keep it factual. Do not add events, motives, identities, crimes, or outcomes not supported by Gemini facts.',
    '- Avoid excessive slang, meme words, fake hype, and childish tone.',
    '',
    '## E-9 genre preset rules',
    '- Read Gemini story_context.genre from the condensed scene facts and choose the closest preset below.',
    '- If genre is sci_fi, superhero, fantasy, adventure, or crime_action, use the action/thriller preset unless the scene facts are clearly emotional drama or comedy.',
    '- If genre is unknown or mixed, choose the dominant viewing rhythm from the scene facts and record the selected numeric ratios in quality_check.ending_rules_check.',
    '',
    '### Genre-specific ending ratio presets',
    '- action/thriller/sci_fi: ~습니다/~했습니다 60%, ~죠/~했죠 15%, ~는데/~했는데 10% target. Use ~는데 when it naturally helps reversal/setup; 0% is allowed if the rhythm is already handled by other connectors or sentence shapes. ~버렸습니다 is optional shock-completion wording only; 0% is allowed when it sounds forced.',
    '- drama/emotional/romance: ~습니다/~했습니다 75%, ~죠/~했죠 15%, ~는데/~했는데 8% target. Use ~는데 when it naturally helps lingering emotional flow; no hard minimum quota. ~버렸습니다 is optional and should usually be rare or absent.',
    '- comedy: ~습니다/~했습니다 55%, ~죠/~했죠 25%, ~는데/~했는데 15% target. Use ~는데 when it naturally improves comic turn timing; never force it just to satisfy a quota. ~버렸습니다 is optional; never add it only to satisfy a quota.',
    '- mystery/twist/suspense: ~습니다/~했습니다 65%, ~죠/~했죠 10%, ~는데/~했는데 20% target. Prioritize reversal-setup endings and connectors such as "그런데" and "하지만", but do not force a literal minimum if the suspense rhythm is already clear.',
    '',
    '### Ending-ratio execution rules',
    '- Do not use one fixed ratio for every genre. The chosen preset is mandatory unless the source facts strongly justify a nearby adjustment.',
    '- Self-check the selected ratio after every 10 sentences while drafting.',
    '- For short scripts under 20 Korean narration sentences, treat the selected percentages as guidance for overall flavor rather than a literal checklist for every ending family.',
    '- There is no hard minimum quota for ~는데/~했는데 or ~버렸습니다. Use them only when they improve the actual spoken rhythm of the scene.',
    '- If a sentence count is too small to hit every percentage exactly, preserve the genre signature first: action keeps shock-completion, drama keeps calm narration, comedy keeps ~죠 wit, mystery keeps ~는데 reversal setup.',
    '- In quality_check.ending_rules_check, report the selected preset numbers or your justified adjusted numbers, not the old fixed 70/15/10/5 defaults.',
    '- Forbidden endings: ~에요, ~어요, ~네요, ~거든요, ~였어요, ~라구요, ~다구요, ~고요, ~겁니다, ~까요.',
    '- ~을까요? and ~일까요? are forbidden except for the final closing joke/reaction only.',
    '- Situation explanation patterns: "~는 상태였는데", "~던 것이었죠".',
    '- Action description patterns: "~기 시작했습니다", "~해 버렸죠".',
    '- Result or realization patterns: "~게 되었습니다", "~을 알아차렸죠".',
    '- Transition patterns: "~자", "~는 순간", "~던 그때".',
    '',
    '## E-9 genre-variable mystery preservation',
    '- Core principle: show, do not tell too early, but change the reveal rhythm by genre.',
    '- action/thriller/sci_fi: shorten Stage 1 to 0-15%, stretch Stage 3 across roughly 40-80%, and prioritize speed/action escalation over slow mystery.',
    '- mystery/twist/suspense: use the standard four-way split, roughly 25/25/25/25.',
    '- drama/emotional/romance: stretch Stage 2 across roughly 25-60% so the emotional hint/pressure can accumulate.',
    '- comedy: keep Stage 4 flexible because spoiler burden is lower; prioritize joke timing and payoff clarity.',
    '- Stage 1 means action only. Stage 2 means ambiguous hints. Stage 3 means expectation break. Stage 4 means truth reveal using "알고 보니" or "사실은" when factually supported.',
    '- Map hook/setup to Stage 1, conflict to Stages 2-3, reveal_or_climax to Stage 4, and ending to a title/name-hidden finish unless comedy timing requires a direct payoff.',
    '- Hide real person names and movie title; encourage viewer guessing without making unsupported claims.',
    '',
    '## E-9 character naming consistency',
    '- One character must keep one label throughout the whole script.',
    '- Label priority: relationship label first, occupation label second, generic label third.',
    '- Use Gemini characters[].safe_display_name by default. If relationship or occupation is clearly known from Gemini facts, promote to one consistent label.',
    '- Situation modifiers are allowed, but keep the base label fixed: "당황한 남자", "화가 난 그".',
    '- Do not rename the same character from "남자" to "그 사람" to "주인공".',
    '- Do not use insulting labels such as "이 놈", "저 놈", or "그 녀석".',
    '',
    '## E-9 yellow-dollar safe rephrasing',
    '- 죽었다 -> 세상을 떠났습니다.',
    '- 살해당했다 -> 사례를 당했습니다.',
    '- 자살했다 -> 스스로 세상을 등졌습니다.',
    '- 때려죽였다 -> 제압했습니다.',
    '- 잔인하게 고문했다 -> 고통을 주었습니다.',
    '- 피를 흘리며 -> 다친 채로.',
    '',
    '## E-9 genre-specific closing and slang intensity',
    '- Use Gemini story_context.genre to decide the closing tone and slang strength.',
    '- action/thriller/sci_fi closing: use cathartic exaggeration or a punchy rhetorical reaction, for example "여러분 이게 사람의 맷집인가요?". Omit a reflection line.',
    '- drama/emotional/romance closing: prefer exactly one reflective line over a joke, for example "가족을 위한 마음은 어디나 같습니다". Slang should be minimal.',
    '- comedy closing: strengthen the joke, for example "여러분 이게 바로 K-대머리의 위엄인가요?". Add 2-3 mid-script jokes if factually safe.',
    '- mystery/twist/suspense closing: leave aftertaste or a choice question, for example "여러분이라면 그 문을 열었을까요?".',
    '- Slang intensity: action/comedy may use punchy colloquial words such as "빤스런", "빡치다", "한 방에 정리" when appropriate; drama/emotional should avoid slang and use restrained emotion words.',
    '',
    '## Hybrid recap/dialogue rules',
    '- Use segment_type "recap" for Korean narration that should be generated with ElevenLabs TTS.',
    '- Use segment_type "dialogue_quote" only for source dialogue that should keep the original source audio and show Korean translated_caption_ko on screen.',
    '- If Source transcript utterances are provided, every dialogue_quote must include exactly one utt_id from that transcript. The transcript utterance is the only timing authority.',
    '- dialogue_quote must set tts_enabled=false, narration="", dialogue_original to the transcript text, caption_text and translated_caption_ko to the Korean subtitle.',
    '- For dialogue_quote with utt_id, set source_scenes to the full transcript utterance range, speed_multiplier=1, and do not split or retime it.',
    '- If Source transcript utterances is [], do not output utt_id at all. Use Gemini scene_id/timecodes for dialogue_quote timing instead.',
    '- For dialogue_quote without a transcript, use the exact Gemini scene timecode that contains dialogue_or_caption. Do not shift a dialogue line to another timestamp inside or outside the scene.',
    '- Never create a dialogue_quote from a scene whose start/end exceeds the known selected source duration. If a high-impact line has impossible or uncertain timing, skip it and use a different dialogue scene.',
    '- Treat Gemini scenes marked should_preserve_original_dialogue=true, or dialogue_function iconic_line/threat/confession/punchline, as dialogue-only source material. Recap/bridge narration source_scenes and story_anchor ranges must not overlap those spoken ranges.',
    '- Recap-channel narration captions may be reused as recap source evidence only when should_preserve_original_dialogue is false and dialogue_function is not iconic_line/threat/confession/punchline.',
    '- If a narration needs context around a dialogue scene, choose the adjacent non-dialogue visual range before or after the spoken line, never the mouth-moving speech range itself.',
    '- All segment source_scenes ranges must be strictly non-overlapping in final timeline order. Do not reuse the same source seconds in multiple segments.',
    '- Use only 2-5 dialogue_quote segments in the full script. Prefer high-impact lines marked should_preserve_original_dialogue=true, dialogue_importance=high, or dialogue_function turning_point/character_emotion/iconic_line/threat/confession/punchline.',
    '- Put short recap or bridge segments before and after dialogue_quote so the story remains understandable.',
    '- recap and bridge segments must set tts_enabled=true and include natural Korean narration.',
    '',
    '## Story-anchor synchronization rules',
    '- Every recap/bridge narration segment must include story_anchor.',
    '- story_anchor.source_range_hint must be [start_sec, end_sec] for the source story moment that the narration describes.',
    '- story_anchor.scene_refs must list the Gemini scene_id values that support that narration.',
    '- Narration order must follow source story progression. You may skip source sections, but must not go backward in source time.',
    '- Later narration that describes later story events must use later source ranges, not early visual filler.',
    '- The final recap/bridge narration must anchor to source content after 70% of source duration unless the source facts prove the story ends earlier.',
    '- Dialogue_quote timing remains controlled by utt_id; story_anchor is primarily for recap/bridge background-video selection.',
    '',
    '## Style hint',
    String(options.style_hint || '3분무비 스타일: 빠른 후킹, 이해 쉬운 설명, 과장 없이 궁금증을 유지하는 톤'),
    '',
    '## Pass 0 movie identity and storyline research',
    movieResearch ? JSON.stringify(movieResearch, null, 2) : '{}',
    '- Use movie_knowledge.clip_context as the main material for hooks and bridge narration: explain what the image alone cannot say.',
    '- Treat movie_knowledge as allowed B-context only when movie_identity.status is confirmed or probable. Do not invent concrete actions beyond source scenes.',
    '- If Pass 0 status is unknown, rely only on Gemini/source evidence and avoid naming unsupported titles or characters.',
    '',
    '## Required output schema',
    JSON.stringify(schema, null, 2),
    '',
    '## Required quality_check ending_rules_check',
    '- Include quality_check.ending_rules_check exactly as specified by the schema.',
    '- quality_check.knowledge_context_used must be true only if an early narration slot actually uses supported Pass 0 context.',
    '- forbidden_eomi_count must be 0.',
    '- real_name_used must be false.',
    '- character_naming_consistent, mystery_4steps_applied, and closing_drip_present should reflect your actual script, not optimistic defaults.',
    '',
    '## Condensed Gemini scene facts',
    JSON.stringify(condensed, null, 2),
    '',
    '## Source transcript utterances',
    utterances.length ? JSON.stringify(utterances, null, 2) : '[]',
    '',
    '## Final instruction',
    options.script_validation_feedback ? `Before generating, fix these previous validation failures:\n${options.script_validation_feedback}` : '',
    'Generate one complete script JSON now.'
  ].join('\n');
}

function buildStoryOutlinePrompt(geminiAnalysis, options = {}) {
  const transcript = options.transcript || loadTranscriptFromOptions(options);
  const utterances = transcriptUtterances(transcript);
  const schema = JSON.parse(fs.readFileSync(MIDFORM_STORY_OUTLINE_SCHEMA_PATH, 'utf8'));
  const profile = resolveContentProfile(geminiAnalysis, options);
  const movieRecap = isMovieRecapProfile(profile);
  const movieResearch = movieResearchFromOptions(options);
  return [
    '# GPT Midform Story Outline Pass',
    '',
    'Return JSON only. Do not use Markdown. Do not call tools. Do not edit files.',
    '',
    '## Task',
    '- Understand the story told by this source video before any slot writing.',
    '- Use the STT transcript as the story spine because dialogue order is the strongest timeline signal.',
    '- Use Gemini scenes only as visual evidence for who acts, what happens, and when.',
    '- Produce a story_outline, not narration and not captions.',
    '',
    '## Story event rules',
    '- story_event must describe character action, conflict, cause, and result: who did what and why it matters.',
    '- Do not describe cinematography or editing.',
    `- Forbidden camera/editing terms in story_event: ${CAMERA_TERMS.join(', ')}.`,
    '- Do not write "클로즈업", "화면", "장면", "전환", "샷", "프레임", "앵글", or similar shooting-log language.',
    '- Merge repeated observations into one story beat. Do not create two beats for the same discovery/warning event.',
    '- Keep each beat source_range broad enough to cover the event, usually 8-35 seconds.',
    movieRecap
      ? '- movie_recap profile: use natural in-universe character names or roles from Pass 0 movie_knowledge when supported. Do not import character names from other movies, and do not hide identity with vague labels.'
      : '- real_person_story profile: use safe labels rather than real names or title where possible.',
    movieRecap
      ? `- Forbidden evasive movie labels: ${EVASIVE_MOVIE_LABELS.join(', ')}.`
      : '- Preserve mystery/reveal rhythm; do not expose identity too early.',
    movieRecap
      ? `- Actor real names remain forbidden: ${ACTOR_REAL_NAME_TOKENS.join(', ')}.`
      : '',
    '',
    '## Required output schema',
    JSON.stringify(schema, null, 2),
    '',
    '## Content context',
    JSON.stringify({
      content_guess: geminiAnalysis?.story_context?.content_guess || '',
      genre: geminiAnalysis?.story_context?.genre || '',
      plot_summary_neutral: geminiAnalysis?.story_context?.plot_summary_neutral || ''
    }, null, 2),
    '',
    '## Content profile',
    profile,
    '',
    '## Pass 0 movie identity and storyline research',
    movieResearch ? JSON.stringify(movieResearch, null, 2) : '{}',
    '- Build story_outline from verified source order plus movie_knowledge.clip_context/full_plot when status is confirmed or probable.',
    '- The outline must explain cause, motive, stakes, and result, not just visible action. This is where Pass 0 context should enter.',
    '- Keep fact boundaries: visible/source facts are A; Pass 0 research is B-context; unsupported concrete actions remain forbidden C.',
    '',
    '## Source transcript utterances',
    JSON.stringify(utterances, null, 2),
    '',
    '## Full Gemini scenes',
    JSON.stringify(Array.isArray(geminiAnalysis?.scenes) ? geminiAnalysis.scenes : [], null, 2),
    '',
    '## Final instruction',
    options.story_outline_validation_feedback ? `Before generating, fix these previous validation failures:\n${options.story_outline_validation_feedback}` : '',
    'Generate story_outline JSON now.'
  ].join('\n');
}

function buildSlotFillPrompt(geminiAnalysis, slotMap, options = {}) {
  const transcript = options.transcript || loadTranscriptFromOptions(options);
  const utterances = transcriptUtterances(transcript);
  const contentContext = geminiAnalysis?.story_context || {};
  const schema = JSON.parse(fs.readFileSync(MIDFORM_SLOT_FILLS_SCHEMA_PATH, 'utf8'));
  const storyOutline = options.storyOutline || options.story_outline || null;
  const profile = resolveContentProfile(geminiAnalysis, options);
  const movieRecap = isMovieRecapProfile(profile);
  const roles = slotRoleMap(slotMap);
  const movieResearch = movieResearchFromOptions(options);
  const endingPreset = inferEndingPreset(geminiAnalysis, options);
  const dialogueHeavyMode = slotMap?.dialogue_heavy_mode === true || String(slotMap?.composition_mode || '').startsWith('dialogue_heavy');
  return [
    '# GPT Midform Slot Fill Generation',
    '',
    'Return JSON only. Do not use Markdown. Do not call tools. Do not edit files.',
    '',
    '## Core contract',
    '- The slot_map order and source ranges are final. Do not change, reorder, merge, skip, or invent slots.',
    '- Fill every slot exactly once, in the same order.',
    '- For narration slots, do not explain scene_summary. Tell the matching story_outline event to viewers as one continuous story.',
    '- scene_summary is only a visual contradiction guardrail: use it to avoid saying something impossible for the current image, not as the sentence source.',
    '- Each narration slot must continue from previous narration slots. Do not repeat an event that was already narrated.',
    '- For dialogue slots, do not write narration. Provide only caption_kr as a natural Korean subtitle translation.',
    '- Do not use credit/static/black/excluded ranges. The slot_map already removed them.',
    '',
    '## Narration budget',
    '- tts_budget_sec is mandatory. Korean TTS averages roughly 5-6 Korean characters per second.',
    '- Example: 14 seconds means about 70-84 Korean characters excluding spaces.',
    '- Keep narration slightly under the slot duration; do not fill every frame with speech.',
    '',
    '## Korean style rules — mandatory E-9 slot mode transplant',
    '- This is a Korean naturalization pass, not a literal translation pass. Every line must sound instantly understandable when heard once.',
    '- Explain compact concepts in spoken Korean. Bad: "제어 잔재", "해제 성립", "잔재 반응", "징후를 찾고". Good: "아직 세뇌에 붙잡혀 있는지 확인하는 겁니다".',
    '- Narration must sound like telling a friend what happened in a movie. Military briefing, strategy report, corporate summary, and abstract operation-control wording are validation failures.',
    '- Bad → Good: "제압 루프로 넘어섰습니다" → "이번엔 작전을 바꿨죠" / "판단을 재정렬할지" → "물러설지 밀어붙일지" / "장치 협업으로 판을 돌렸습니다" → "장치로 승부를 걸었습니다".',
    '- Also avoid report phrases like "전투를 먼저 완수하겠다는 판단". Say the human choice directly: "대화보다 공격을 먼저 택했습니다".',
    '- If narration contains three compressed noun concepts in a row, it will fail validation. Use subject + action + consequence instead.',
    '- Natural Korean YouTube narration, not translationese. Do not write novel-stage directions or neutral summaries.',
    '- Use the E-9 냐옹시네마 rhythm: fast hook, clear setup, conflict escalation, climax, ending punchline.',
    '- Every narration sentence must explain a concrete story turn: contradiction, motive, stakes, setup, consequence, or payoff.',
    '- Do not merely broadcast what the viewer can already see. Observation-log narration is a validation failure.',
    '- Bad examples forbidden: "긴장은 급격히 뻗고", "공기가 더 무겁게 가라앉는다", "금속성 파문이 스치는 순간".',
    '- Good examples: "전 세계 군대가 단 한 명을 포위했습니다. 그런데 그는 싸울 생각이 없었죠", "대화가 통하지 않자 군은 결국 방아쇠를 당겼습니다. 그런데 이게 최악의 선택이 됐죠".',
    `- Camera/editing terms are validation failures: ${CAMERA_TERMS.join(', ')}.`,
    '- Bad camera-log examples: "장치가 클로즈업되면서", "얼굴 클로즈업으로 전환됩니다", "장면이 번쩍였습니다", "위에서 대치가 잡혔습니다".',
    '- Rewrite those as story events: "장치가 켜지자 작전이 시작됐습니다", "은빛 남자의 표정이 굳어졌습니다", "공격이 터지며 모두가 흩어졌습니다".',
    '- Ban abstract noun chains, literal English structures, and poetic phrasing. Prefer actor + action + result.',
    '- Forbidden endings: ~에요, ~어요, ~네요, ~거든요, ~였어요, ~라구요, ~다구요, ~고요, ~겁니다, ~까요.',
    `- Selected ending preset is ${endingPreset.key} (${endingPreset.label}): ~습니다/~했습니다 ${endingPreset.nida}%, ~죠/~했죠 ${endingPreset.jyo}%, ~는데/~했는데 ${endingPreset.neunde}%, ~버렸습니다 ${endingPreset.beoryeot}%.`,
    '- The automatic gate is bidirectional: too many ~습니다/~니다 endings fail, and too few ~죠 endings fail.',
    '- There is no hard minimum quota for sentence-final ~는데/~했는데. Use it when it naturally helps reversal/setup, but other connectors or sentence shapes may carry the same rhythm.',
    '- Do not use plain dictionary/story-form ~다 endings in narration. Replace forms like "훑었다/물러섰다/회전했다/굳어졌다/터졌다" with "훑었습니다/물러섰죠/회전했습니다/굳어졌습니다/터졌습니다".',
    '- The automatic gate fails if plain ~다 endings exceed 30%, so aim for 0 plain ~다 narration endings.',
    '- There is no minimum quota for ~는데 or ~버렸습니다; use them only when they naturally support the spoken rhythm and genre feel.',
    '- 관찰/대기 동사(봅니다, 기다립니다, 지켜봅니다, 확인합니다)를 문말에 3회 이상 반복 금지.',
    '- 긴장 고조는 ~는데, "그런데", "하지만", "문제는" 같은 자연스러운 전환 장치 중 문맥에 맞는 것을 쓰세요.',
    '- 확신/전환은 ~죠로 처리하세요: "이게 마지막 관문이었죠".',
    '- 충격 완료도 문맥상 자연스러울 때만 ~버렸습니다로 처리하세요. 억지로 채우지 마세요.',
    '- 동일 서술구를 2회 이상 반복하지 마세요. 예: "세뇌에 붙잡혀 있는지"를 두 번 쓰면 실패합니다.',
    '- Useful connectors: "문제는", "그런데", "이때", "하필", "진짜 문제는", "분위기가 이상해집니다".',
    '- Make adjacent narration slots connect naturally; the last line of one slot should flow into the next slot.',
    '- Keep all facts grounded in slot_map.scene_summary, source transcript, and content context only.',
    '',
    '## Storytelling slot roles — mandatory',
    '- Use these roles for narration slots. Do not change slot order or source ranges.',
    JSON.stringify(roles, null, 2),
    '- role=hook: first narration slot. Do NOT describe the first image. Open with a contradiction/paradox/stakes sentence for the whole clip.',
    '- Hook formulas: "지구를 파괴하러 온 존재가, 정작 자신은 파괴자가 아니라고 말합니다." / "전 세계 군대가 단 한 명을 포위했습니다. 그런데 그는 싸울 생각이 없었죠."',
    '- role=bridge: middle narration slots. Build expectation for the next beat, explain motive/stakes, and say what the image alone does not say.',
    '- role=setup: narration immediately before dialogue or a major beat. Plant expectation, stakes, or irony for what is about to happen; do not paraphrase the adjacent dialogue line or visible action.',
    dialogueHeavyMode
      ? '- dialogue-heavy signature-quote mode: narration carries the story; only the selected_signature_quotes remain as original-audio highlights. Do not preserve or translate non-selected dialogue as dialogue slots.'
      : '',
    dialogueHeavyMode
      ? '- Use narration_background slots as real narration over source dialogue with source_audio_ducking=0.3. Explain context, conflict escalation, and meaning; do not merely caption the background speech.'
      : '',
    dialogueHeavyMode
      ? '- The selected quote list is mandatory. Each dialogue slot must translate only its caption_source_text and preserve why the quote matters.'
      : '',
    '- role=payoff: final narration slot. Deliver meaning and next curiosity. For scripts with 2 slots or fewer, a grounded emotional aftertaste line is allowed instead of a joke.',
    '- If a narration slot comes right after dialogue, do not restate what the line just said. Add meaning, irony, consequence, or the next curiosity instead.',
    '- If a narration slot comes right after a visible action burst, do not just describe the same movement again. Add interpretation, consequence, or why that action changes the scene.',
    '- Bad adjacent restatement: repeating a phone call as "신고됐다/확신했다" right after the call already said it, or repeating "살려 달라" right after the plea. Good: explain what that line changes, reveals, or sets up.',
    '- Screen-relay rule: sentences that only restate visible motion must be under 30% of narration. The automatic gate fails above 50%.',
    '- At least two bridge/setup narration sentences must include off-screen context from Pass 0: who the character is, why this moment matters, what changed before/after the clip, and what is at stake.',
    '- Movie context allowed for this clip comes only from Pass 0 movie_knowledge. Use it carefully as context, not a lore lecture.',
    meaningfulKnowledgeParts(options).required
      ? `- Use supported Pass 0 context at least once in the hook or early narration (${earlyNarrationSlotIds(slotMap).join(', ') || 'first two narration slots'}): introduce who the central figure is or what is at stake using only movie_knowledge.clip_context/stakes.`
      : '',
    '- Bad: "미사일이 산비탈을 가로질러 돌진했습니다." Good: "대화가 통하지 않자 군은 결국 방아쇠를 당겼습니다. 그런데 이게 최악의 선택이 됐죠."',
    '',
    '## Fact boundary — do not invent events',
    '- Allowed A — visible/source facts: concrete actions/events explicitly present in that slot scene_summary, slot caption_source_text, or source transcript.',
    '- Allowed B — movie context: character identity/motive/stakes from Pass 0, expressed only as state/meaning. Example: "이 순간은 그 인물이 더 이상 예전 명령에 묶이지 않는지 확인하는 시험입니다."',
    '- Forbidden C — invented events: concrete actions, reversals, device effects, exact counts, or future plot certainty not present in A or B.',
    '- Every concrete action phrase in narration must be grounded in the same slot scene_summary. If the source says only that someone falls, do not add recovery, counterattack, electricity, hand gestures, or hidden device effects.',
    '- Forbidden examples: "손끝으로 전류를 세 번 튕기자", "그 판단은 잠깐의 착각이었고", "더 강한 장치가 문을 열어", "누가 줄을 조종했는지는 곧 드러납니다".',
    '- If a slot has weak dramatic material, write it plainly. It is better to be grounded than exciting.',
    '- Payoff rule: next curiosity must be based on actual movie context. If not, use a short closing joke/reaction, or for dialogue-heavy scripts with 2 slots or fewer, one grounded reflective aftertaste line.',
    '- The automatic gate fails unsupported concrete-event patterns and will retry with feedback.',
    '- Pass 0 movie_knowledge is allowed B-context only. Use it for why this moment matters, what happened immediately before/after, and character motivation; never use it to add visible actions that are not in the slot.',
    '',
    '## Character naming profile',
    movieRecap
      ? '- movie_recap profile: mystery/identity hiding is OFF. Use natural in-universe names, not vague labels.'
      : '- real_person_story profile: mystery/identity hiding is ON. Hide real names and identity-reveal labels until the planned reveal.',
    movieRecap
      ? '- Use character names naturally from Pass 0 movie_knowledge.characters when supported. Do not import character names from other movies.'
      : '- Use Gemini characters[].safe_display_name only as internal identity evidence, then choose a Korean safe label and keep it consistent.',
    '- One character must keep one label throughout the script.',
    movieRecap
      ? `- Forbidden evasive movie labels: ${EVASIVE_MOVIE_LABELS.join(', ')}.`
      : '- Avoid revealing hidden identities or names before the reveal stage.',
    movieRecap
      ? `- Actor real names remain forbidden: ${ACTOR_REAL_NAME_TOKENS.join(', ')}.`
      : '- Do not use raw real-person names in narration.',
    '',
    '## Mystery/yellow-dollar/closing rules',
    movieRecap
      ? '- movie_recap profile: remove the mystery four-stage identity-hiding formula. Tell the movie scene clearly using character names.'
      : '- Mystery four stages still apply: Stage 1 action only, Stage 2 ambiguous hints, Stage 3 expectation break, Stage 4 reveal/payoff.',
    movieRecap
      ? '- Do not use vague expressions like "어떤", "무언가", "정체불명의" to hide identities that viewers should understand.'
      : '- For sci_fi/action, Stage 1 is short, Stage 3 stretches through the middle, and speed/action escalation beats slow explanation.',
    '- Yellow-dollar safe phrasing: 죽었다 -> 세상을 떠났습니다; 살해당했다 -> 사고를 당했습니다; 때려죽였다 -> 제압했습니다; 피를 흘리며 -> 다친 채로.',
    '- Closing should use action/sci-fi cathartic exaggeration or a punchy reaction, not a reflective essay.',
    '',
    '## Caption unit rules',
    '- For every narration slot, fill caption_units with the exact Korean chunks that TTS/subtitles should use.',
    '- Obey each narration slot tts_budget_sec strictly. Keep Korean characters excluding spaces within the budget implied by 5-6 chars/sec.',
    '- caption_units must concatenate to the narration text with spaces only. Subtitle and TTS use the same units 1:1.',
    '- Split by sentence boundary first, then comma/connector boundary. Never split in the middle of an eojeol/word.',
    '- Each caption unit should be at most 22 Korean characters excluding spaces when possible, and each split piece should have at least 2 eojeol unless the whole sentence is shorter.',
    '- Do not produce chunks that split a subject from its predicate or split one action phrase across captions.',
    '- For dialogue slots, caption_units should contain only the translated subtitle pieces and caption_kr should be their joined text.',
    '',
    '## Dialogue translation style',
    '- Dialogue happens during a tense combat standoff. Translate as urgent spoken Korean, mostly 반말/짧은 구어체, not report-style 존댓말.',
    '- Codewords, chants, passwords, brainwashing trigger words, songs, or uncertain foreign fragments are NOT normal dialogue. Do not literally translate them as everyday Korean.',
    '- If a dialogue slot is a brainwashing codeword sequence, preserve the feeling as a chant/codeword: use ellipsis, transliteration-like Korean, or a compact cue such as "암시어가 이어집니다…". Do not output literal fragments like "심장이야. 꿈이야. 화물선이다."',
    '- The narration slot immediately before or around a codeword sequence must explain what the words are doing: Ayo is testing whether the old Winter Soldier trigger words still control Bucky.',
    '- If an STT line looks like a foreign-language misrecognition and does not connect to the story, omit it from slot selection or keep it as a minimal ambiguous sound, not a confident Korean sentence.',
    '- Forbidden dialogue endings: ~습니까, ~하십시오, ~합니다, ~입니다, ~했습니다.',
    '- Examples: "왜 우리 행성을 파괴하려는 거야?" / "선택의 여지가 없어." / "선택이 없다는 게 무슨 뜻이야?" / "난 파괴자가 아니야."',
    '',
    '## Required output schema',
    JSON.stringify(schema, null, 2),
    '',
    '## Content context',
    JSON.stringify({
      content_guess: contentContext.content_guess || '',
      plot_summary_neutral: contentContext.plot_summary_neutral || '',
      genre: contentContext.genre || '',
      content_profile: profile,
      suggested_movie_character_names: movieRecap ? movieCharacterNameGuidance(geminiAnalysis, movieResearch) : [],
      style_hint: options.style_hint || ''
    }, null, 2),
    '',
    '## Pass 0 movie identity and storyline research',
    movieResearch ? JSON.stringify(movieResearch, null, 2) : '{}',
    '- For hook/setup/bridge/payoff slots, prefer movie_knowledge.clip_context over generic visual description.',
    '- Character labels should follow movie_knowledge.characters when available and confirmed/probable.',
    '- Good pattern: "직전에 X였기 때문에, 지금 Y가 마지막 관문이 됩니다."',
    '',
    '## Source transcript utterances',
    utterances.length ? JSON.stringify(utterances, null, 2) : '[]',
    '',
    '## Story outline from Pass 1 — use this as the narration source',
    storyOutline ? JSON.stringify(storyOutline, null, 2) : '{}',
    '',
    '## Slot map',
    JSON.stringify(slotMap, null, 2),
    '',
    '## Final instruction',
    options.slot_validation_feedback ? `Before generating, fix these previous validation failures:\n${options.slot_validation_feedback}` : '',
    'Generate slot_fills JSON now.'
  ].join('\n');
}

function formatSlotValidationFeedback(errors) {
  return (errors || []).map((error, index) => `${index + 1}. ${error}`).join('\n');
}

function savePromptPackage(geminiAnalysis, outputDir, options = {}) {
  ensureDir(outputDir);
  const transcript = loadTranscriptFromOptions(options);
  const loadedSlotMap = loadSlotMapFromOptions(options);
  const profile = resolveContentProfile(geminiAnalysis, options);
  const slotMap = loadedSlotMap || (isMovieRecapProfile(profile) && !shouldAllowLegacySinglePrompt(options) ? buildAutomaticNarrationSlotMap(geminiAnalysis, transcript) : null);
  const storyOutlinePrompt = slotMap ? buildStoryOutlinePrompt(geminiAnalysis, { ...options, transcript }) : '';
  const prompt = slotMap
    ? buildSlotFillPrompt(geminiAnalysis, slotMap, { ...options, transcript, storyOutline: options.storyOutline || options.story_outline || null })
    : buildGptMidformPrompt(geminiAnalysis, { ...options, transcript });
  const condensed = condenseGeminiAnalysis(geminiAnalysis, options.scene_condensation || {});
  const promptPath = path.join(outputDir, 'gpt_cli_script_prompt.md');
  const outlinePromptPath = path.join(outputDir, 'gpt_cli_story_outline_prompt.md');
  const inputPath = path.join(outputDir, 'gpt_cli_scene_beats.json');
  fs.writeFileSync(promptPath, `${prompt}\n`, 'utf8');
  if (storyOutlinePrompt) fs.writeFileSync(outlinePromptPath, `${storyOutlinePrompt}\n`, 'utf8');
  fs.writeFileSync(inputPath, `${JSON.stringify(condensed, null, 2)}\n`, 'utf8');
  return { promptPath, outlinePromptPath: storyOutlinePrompt ? outlinePromptPath : '', inputPath, prompt, storyOutlinePrompt, condensed };
}

async function generateStoryOutlineWithGptCli(geminiAnalysis, options = {}) {
  const transcript = options.transcript || loadTranscriptFromOptions(options);
  let validationFeedback = '';
  let lastResult = null;
  let lastErrors = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prompt = buildStoryOutlinePrompt(geminiAnalysis, { ...options, transcript, story_outline_validation_feedback: validationFeedback });
    const result = await runCodexCli(prompt, { ...options, outputSchemaPath: MIDFORM_STORY_OUTLINE_SCHEMA_PATH });
    lastResult = result;
    const parsed = extractJson(result.outputText || result.stdout);
    try {
      validateStoryOutline(parsed, resolveContentProfile(geminiAnalysis, options));
      return {
        storyOutline: parsed,
        cli: {
          promptPath: result.promptPath,
          outputPath: result.outputPath,
          stderr: result.stderr.slice(0, 2000),
          storyOutlineValidationAttempts: attempt
        }
      };
    } catch (error) {
      lastErrors = Array.isArray(error?.details?.errors) ? error.details.errors : [error.message || 'story outline validation failed'];
      validationFeedback = formatSlotValidationFeedback(lastErrors);
    }
  }
  throw createHttpError(500, 'GPT_STORY_OUTLINE_VALIDATION_FAILED', 'GPT story outline failed validation after retry', {
    errors: lastErrors,
    promptPath: lastResult?.promptPath,
    outputPath: lastResult?.outputPath
  });
}

async function generateMidformScriptWithGptCli(geminiAnalysis, options = {}) {
  const scriptId = String(options.scriptId || crypto.randomUUID());
  const transcript = loadTranscriptFromOptions(options);
  const loadedSlotMap = loadSlotMapFromOptions(options);
  const profile = resolveContentProfile(geminiAnalysis, options);
  const slotMap = loadedSlotMap || (isMovieRecapProfile(profile) && !shouldAllowLegacySinglePrompt(options) ? buildAutomaticNarrationSlotMap(geminiAnalysis, transcript) : null);
  if (isMovieRecapProfile(profile) && !slotMap && !shouldAllowLegacySinglePrompt(options)) {
    throw createHttpError(400, 'GPT_MIDFORM_SLOT_MAP_REQUIRED', 'Movie recap generation requires a slot map. Pass slotMap/slotMapPath, or explicitly set allowLegacySinglePrompt for legacy testing only.', {
      profile,
      hasTranscript: Boolean(transcript)
    });
  }
  if (isMovieRecapProfile(profile) && slotMap && (!Array.isArray(slotMap.slots) || !slotMap.slots.length)) {
    throw createHttpError(400, 'GPT_MIDFORM_SLOT_MAP_EMPTY', 'Movie recap slot map did not contain usable slots.', {
      profile,
      sourceDurationSec: slotMap.source_duration_sec || 0
    });
  }
  if (slotMap) {
    const outlineResult = options.storyOutline || options.story_outline
      ? { storyOutline: options.storyOutline || options.story_outline, cli: null }
      : await generateStoryOutlineWithGptCli(geminiAnalysis, { ...options, scriptId, transcript });
    validateStoryOutline(outlineResult.storyOutline, resolveContentProfile(geminiAnalysis, options));
    let validationFeedback = '';
    let lastValidationErrors = [];
    let lastResult = null;
    let previousSlotFillScript = null;
    let targetedRetrySlotIds = new Set();
    let softNarrationFeedbackUsed = false;
    const maxSlotFillAttempts = String(slotMap?.composition_mode || '').startsWith('dialogue_heavy') ? 3 : 2;
    for (let attempt = 1; attempt <= maxSlotFillAttempts; attempt += 1) {
      const prompt = buildSlotFillPrompt(geminiAnalysis, slotMap, { ...options, scriptId, transcript, storyOutline: outlineResult.storyOutline, slot_validation_feedback: validationFeedback });
      const result = await runCodexCli(prompt, { ...options, outputSchemaPath: MIDFORM_SLOT_FILLS_SCHEMA_PATH });
      lastResult = result;
      const parsed = extractJson(result.outputText || result.stdout);
      let validationErrors = collectSlotFillValidationErrors(parsed, slotMap, geminiAnalysis, options);
      const dialogueHeavySignatureMode = String(slotMap?.composition_mode || '').startsWith('dialogue_heavy');
      if (!dialogueHeavySignatureMode && !validationErrors.length && targetedRetrySlotIds.size) {
        validationErrors = unchangedSlotFillErrors(previousSlotFillScript, parsed, targetedRetrySlotIds);
      }
      let closingDripEvaluation = null;
      let knowledgeContextEvaluation = null;
      if (!validationErrors.length) {
        const shortSlotScript = Array.isArray(slotMap?.slots) && slotMap.slots.length <= 2;
        const dialogueHeavyMode = slotMap?.dialogue_heavy_mode === true || String(slotMap?.composition_mode || '').startsWith('dialogue_heavy');
        closingDripEvaluation = await evaluateClosingDrip(
          (Array.isArray(slotMap?.slots) ? slotMap.slots : [])
            .filter((slot) => slot?.type === 'narration')
            .map((slot) => ({ slotId: String(slot?.slot_id || ''), narration: String((parsed?.slot_fills || []).find((fill) => String(fill?.slot_id || '') === String(slot?.slot_id || ''))?.narration || '').trim() }))
            .filter((item) => item.narration),
          { ...options, allowAftertasteClose: shortSlotScript || dialogueHeavyMode }
        );
        if (!closingDripEvaluation.passed) {
          validationErrors = await collectClosingDripValidationErrors(parsed, slotMap, { ...options, closingDripEvaluation });
        }
      }
      if (!validationErrors.length) {
        const narrationContextFeedback = collectNarrationContextFeedback(parsed, slotMap, options);
        knowledgeContextEvaluation = narrationContextFeedback.knowledge;
        if (narrationContextFeedback.errors.length && !softNarrationFeedbackUsed) {
          validationErrors = narrationContextFeedback.errors;
          previousSlotFillScript = parsed;
          targetedRetrySlotIds = narrationContextFeedback.slotIds;
          softNarrationFeedbackUsed = true;
        }
      }
      if (!validationErrors.length) {
        const principleErrors = await collectNaturalizationPrincipleErrors(parsed, slotMap, options);
        if (principleErrors.length) {
          validationErrors = principleErrors;
          previousSlotFillScript = parsed;
          targetedRetrySlotIds = slotIdsFromValidationErrors(principleErrors);
        }
      }
      if (!validationErrors.length) {
        const normalizedSlotScript = await normalizeSlotFillsToScript(parsed, slotMap, geminiAnalysis, { ...options, scriptId, transcript, storyOutline: outlineResult.storyOutline, closingDripEvaluation, knowledgeContextEvaluation });
        return {
          script: normalizedSlotScript,
          cli: {
            storyOutlinePromptPath: outlineResult.cli?.promptPath || '',
            storyOutlineOutputPath: outlineResult.cli?.outputPath || '',
            promptPath: result.promptPath,
            outputPath: result.outputPath,
            stderr: result.stderr.slice(0, 2000),
            slotValidationAttempts: attempt
          }
        };
      }
      lastValidationErrors = validationErrors;
      const targetedSlots = slotIdsFromValidationErrors(validationErrors);
      validationFeedback = [
        formatSlotValidationFeedback(validationErrors),
        buildOverlengthRetryFeedback(validationErrors),
        targetedSlots.size
          ? `Targeted retry rule: rewrite ONLY these slot_id values and keep every other slot_fills item byte-for-byte semantically unchanged: ${Array.from(targetedSlots).join(', ')}.`
          : '',
        'Naturalization principle: narration must sound like a friend explaining a movie scene, not a military briefing, strategy report, corporate summary, or abstract control-system label.'
      ].filter(Boolean).join('\n');
    }
    if (options.interactiveMode === true && lastValidationErrors.length) {
      const deferredValidationErrors = [...lastValidationErrors];
      const deferredValidationWarnings = buildStructuredValidationWarnings(deferredValidationErrors);
      const normalizedSlotScript = await normalizeSlotFillsToScript(
        previousSlotFillScript || extractJson(lastResult.outputText || lastResult.stdout),
        slotMap,
        geminiAnalysis,
        {
          ...options,
          scriptId,
          transcript,
          storyOutline: outlineResult.storyOutline,
          skipSlotFillValidation: true
        }
      );
      normalizedSlotScript.quality_check = {
        ...(normalizedSlotScript.quality_check || {}),
        deferred_slot_fill_errors: deferredValidationErrors,
        deferred_slot_fill_warnings: deferredValidationWarnings
      };
      return {
        script: normalizedSlotScript,
        cli: {
          storyOutlinePromptPath: outlineResult.cli?.promptPath || '',
          storyOutlineOutputPath: outlineResult.cli?.outputPath || '',
          promptPath: lastResult?.promptPath || '',
          outputPath: lastResult?.outputPath || '',
          stderr: String(lastResult?.stderr || '').slice(0, 2000),
          slotValidationAttempts: maxSlotFillAttempts,
          deferredValidationErrors,
          deferredValidationWarnings,
          reviewRequired: true
        }
      };
    }
    throw createHttpError(500, 'GPT_SLOT_FILLS_VALIDATION_FAILED', 'GPT slot fills failed validation after retry', {
      errors: lastValidationErrors,
      promptPath: lastResult?.promptPath,
      outputPath: lastResult?.outputPath
    });
  }
  let validationFeedback = '';
  let lastValidationErrors = [];
  let lastResult = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prompt = buildGptMidformPrompt(geminiAnalysis, { ...options, scriptId, transcript, script_validation_feedback: validationFeedback });
    const result = await runCodexCli(prompt, options);
    lastResult = result;
    const parsed = extractJson(result.outputText || result.stdout);
    const normalized = normalizeScript(parsed, geminiAnalysis, { ...options, scriptId, transcript });
    try {
      validateScript(normalized, geminiAnalysis, transcript);
      return {
        script: normalized,
        cli: {
          promptPath: result.promptPath,
          outputPath: result.outputPath,
          stderr: result.stderr.slice(0, 2000),
          validationAttempts: attempt
        }
      };
    } catch (error) {
      lastValidationErrors = Array.isArray(error?.details?.errors) ? error.details.errors : [error.message || 'script validation failed'];
      validationFeedback = formatSlotValidationFeedback(lastValidationErrors);
    }
  }
  throw createHttpError(500, 'GPT_CLI_SCRIPT_VALIDATION_FAILED', 'GPT CLI script failed validation', {
    errors: lastValidationErrors,
    promptPath: lastResult?.promptPath,
    outputPath: lastResult?.outputPath
  });
}

module.exports = {
  DEFAULT_MODEL,
  GPT_WORK_DIR,
  MIDFORM_SCHEMA_PATH,
  MIDFORM_SLOT_FILLS_SCHEMA_PATH,
  MIDFORM_STORY_OUTLINE_SCHEMA_PATH,
  MIDFORM_COMPRESSION_BEATS_SCHEMA_PATH,
  MIDFORM_COMPRESSION_EDIT_PLAN_SCHEMA_PATH,
  buildGptMidformPrompt,
  buildStoryOutlinePrompt,
  buildSlotFillPrompt,
  generateStoryOutlineWithGptCli,
  normalizeSlotFillsToScript,
  validateSlotFills,
  collectNarrationContextFeedback,
  knowledgeContextUsageAnalysis,
  savePromptPackage,
  generateMidformScriptWithGptCli,
  runCodexCli,
  extractJson
};
