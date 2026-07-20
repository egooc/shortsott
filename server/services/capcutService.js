const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { createHttpError } = require('./errorService');
const { resolveTool, getToolEnv } = require('../utils/toolPaths');

const OUTPUT_DIR = path.join(__dirname, '../output');
const TEMPLATE_BASE_DIR = path.resolve(__dirname, '../../templates/capcut/channel_default');
const CAPCUT_DRAFT_TIMEOUT_MS = Number(process.env.CAPCUT_DRAFT_TIMEOUT_MS || 20 * 60 * 1000);

function normalizeCaptionText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function assertCaptionUnitsMatchTtsFiles(ttsFiles = [], captionUnits = []) {
  if (!Array.isArray(ttsFiles) || !ttsFiles.length || !Array.isArray(captionUnits) || !captionUnits.length) return true;
  const sentenceTextById = new Map(ttsFiles.map((file) => [String(file.caption_id || file.segment_id || ''), normalizeCaptionText(file.text || '')]));
  const unitsBySentence = new Map();
  for (const unit of captionUnits) {
    const sentenceId = String(unit.tts_caption_id || unit.segment_id || '');
    const sentenceText = sentenceTextById.get(sentenceId) || '';
    const unitText = normalizeCaptionText(unit.text || '');
    if (!sentenceText || !unitText || !sentenceText.includes(unitText)) {
      const error = new Error(`caption unit text does not match TTS sentence: ${unit.caption_id || sentenceId}`);
      error.code = 'CAPTION_TTS_TEXT_MISMATCH';
      error.details = { sentence_id: sentenceId, caption_id: unit.caption_id || '', unit_text: unitText, sentence_text: sentenceText };
      throw error;
    }
    if (!unitsBySentence.has(sentenceId)) unitsBySentence.set(sentenceId, []);
    unitsBySentence.get(sentenceId).push(unitText);
  }
  for (const [sentenceId, unitTexts] of unitsBySentence.entries()) {
    const sentenceText = sentenceTextById.get(sentenceId) || '';
    const joinedText = normalizeCaptionText(unitTexts.join(' '));
    if (joinedText !== sentenceText) {
      const error = new Error(`caption units do not reconstruct TTS sentence: ${sentenceId}`);
      error.code = 'CAPTION_TTS_TEXT_MISMATCH';
      error.details = { sentence_id: sentenceId, unit_text: joinedText, sentence_text: sentenceText };
      throw error;
    }
  }
  return true;
}

function walkDirs(baseDir, maxDepth = 2) {
  const results = [];
  function visit(current, depth) {
    if (depth > maxDepth) return;
    results.push({ dir: current, depth });
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      visit(path.join(current, entry.name), depth + 1);
    }
  }
  visit(baseDir, 0);
  return results;
}

function findCapcutTemplateFiles() {
  if (!fs.existsSync(TEMPLATE_BASE_DIR)) return null;

  const directDraft = path.join(TEMPLATE_BASE_DIR, 'draft_content.json');
  if (fs.existsSync(directDraft)) {
    const directMeta = path.join(TEMPLATE_BASE_DIR, 'draft_meta_info.json');
    return {
      templateBasePath: TEMPLATE_BASE_DIR,
      templateRootPath: TEMPLATE_BASE_DIR,
      draftContentPath: directDraft,
      draftMetaInfoPath: fs.existsSync(directMeta) ? directMeta : '',
      depth: 0
    };
  }

  const candidates = [];
  for (const item of walkDirs(TEMPLATE_BASE_DIR, 2)) {
    if (item.depth === 0) continue;
    const draftPath = path.join(item.dir, 'draft_content.json');
    if (!fs.existsSync(draftPath)) continue;
    const metaPath = path.join(item.dir, 'draft_meta_info.json');
    candidates.push({
      templateBasePath: TEMPLATE_BASE_DIR,
      templateRootPath: item.dir,
      draftContentPath: draftPath,
      draftMetaInfoPath: fs.existsSync(metaPath) ? metaPath : '',
      hasMeta: fs.existsSync(metaPath),
      depth: item.depth
    });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    if (a.hasMeta !== b.hasMeta) return a.hasMeta ? -1 : 1;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.templateRootPath.localeCompare(b.templateRootPath);
  });
  return candidates[0];
}

function getCapcutTemplateStatus() {
  const status = {
    enabledDefault: true,
    templateBasePath: TEMPLATE_BASE_DIR,
    found: false,
    templateRootPath: '',
    draftContentPath: '',
    draftMetaInfoPath: '',
    depth: null,
    message: ''
  };

  const template = findCapcutTemplateFiles();
  if (!template) {
    status.message = 'template draft_content.json not found under templates/capcut/channel_default (depth <= 2)';
    return status;
  }

  status.found = true;
  status.templateRootPath = template.templateRootPath;
  status.draftContentPath = template.draftContentPath;
  status.draftMetaInfoPath = template.draftMetaInfoPath || '';
  status.depth = template.depth;
  status.message = template.draftMetaInfoPath
    ? 'template loaded'
    : 'draft_content.json found but draft_meta_info.json is missing (fallback still possible)';

  return status;
}

function resolveSrtPath(srtFile, ttsFiles) {
  if (!srtFile) return '';
  if (path.isAbsolute(srtFile) && fs.existsSync(srtFile)) return srtFile;

  const firstTtsPath = ttsFiles?.[0]?.filepath;
  if (firstTtsPath) {
    const candidate = path.join(path.dirname(firstTtsPath), srtFile);
    if (fs.existsSync(candidate)) return candidate;
  }

  const fallback = path.join(OUTPUT_DIR, srtFile);
  return fs.existsSync(fallback) ? fallback : srtFile;
}

function generateDraft(
  segments,
  ttsFiles,
  captionUnits,
  captionWarnings,
  srtFile,
  resolution,
  fps,
  audioPathMode = 'absolute',
  videoPlacementMode = 'source_clips',
  useCapcutTemplate = true,
  claudeScript = {}
) {
  const inputPath = path.join(OUTPUT_DIR, 'draft_input.json');
  const payload = {
    segments,
    ttsFiles,
    captionUnits,
    captionWarnings,
    srtFile: resolveSrtPath(srtFile, ttsFiles),
    resolution,
    fps,
    audioPathMode,
    videoPlacementMode,
    useCapcutTemplate,
    claudeScript
  };

  fs.writeFileSync(inputPath, JSON.stringify(payload, null, 2), 'utf8');

  const scriptPath = path.join(__dirname, '../../scripts/capcut_draft.py');
  const pythonCommand = resolveTool('python', { envKey: 'PYTHON_PATH' });

  return new Promise((resolve, reject) => {
    execFile(
      pythonCommand,
      [scriptPath, inputPath],
      { cwd: path.join(__dirname, '../..'), env: getToolEnv(), maxBuffer: 50 * 1024 * 1024, timeout: CAPCUT_DRAFT_TIMEOUT_MS },
      (error, stdout, stderr) => {
      if (error) {
        const timeoutMessage = error.killed && error.signal === 'SIGTERM'
          ? `CapCut draft timed out after ${Math.round(CAPCUT_DRAFT_TIMEOUT_MS / 1000)} seconds`
          : '';
        reject(createHttpError(500, 'CAPCUT_DRAFT_ERROR', `CapCut draft failed: ${stderr || timeoutMessage || error.message}`, { stderr, stdout, timeoutMs: CAPCUT_DRAFT_TIMEOUT_MS }));
        return;
      }

      try {
        const result = JSON.parse(String(stdout || '').trim() || '{}');
        if (result.error) {
          reject(createHttpError(500, 'CAPCUT_DRAFT_ERROR', result.error, result));
          return;
        }
        resolve(result);
      } catch {
        reject(createHttpError(500, 'CAPCUT_DRAFT_PARSE_ERROR', 'CapCut script output was not valid JSON', { stdout }));
      }
    });
  });
}

function runCapcutScript(payload, inputFilename = 'draft_input.json') {
  const inputPath = path.join(OUTPUT_DIR, inputFilename);
  fs.writeFileSync(inputPath, JSON.stringify(payload, null, 2), 'utf8');

  const scriptPath = path.join(__dirname, '../../scripts/capcut_draft.py');
  const pythonCommand = resolveTool('python', { envKey: 'PYTHON_PATH' });

  return new Promise((resolve, reject) => {
    execFile(
      pythonCommand,
      [scriptPath, inputPath],
      { cwd: path.join(__dirname, '../..'), env: getToolEnv(), maxBuffer: 50 * 1024 * 1024, timeout: CAPCUT_DRAFT_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          const timeoutMessage = error.killed && error.signal === 'SIGTERM'
            ? `CapCut draft timed out after ${Math.round(CAPCUT_DRAFT_TIMEOUT_MS / 1000)} seconds`
            : '';
          reject(createHttpError(500, 'CAPCUT_DRAFT_ERROR', `CapCut draft failed: ${stderr || timeoutMessage || error.message}`, { stderr, stdout, timeoutMs: CAPCUT_DRAFT_TIMEOUT_MS }));
          return;
        }

        try {
          const result = JSON.parse(String(stdout || '').trim() || '{}');
          if (result.error) {
            reject(createHttpError(500, 'CAPCUT_DRAFT_ERROR', result.error, result));
            return;
          }
          resolve(result);
        } catch {
          reject(createHttpError(500, 'CAPCUT_DRAFT_PARSE_ERROR', 'CapCut script output was not valid JSON', { stdout }));
        }
      }
    );
  });
}

function generateProcessDraft({
  config,
  videoTransformPreset,
  bgmPreset,
  createZip = true,
  ttsFiles = [],
  captionUnits = [],
  captionWarnings = [],
  srtFile = ''
}) {
  assertCaptionUnitsMatchTtsFiles(ttsFiles, captionUnits);
  const resolvedBgmPreset = {
    ...(bgmPreset || {}),
    process_config: config || {},
    custom_bgm_path: config?.custom_bgm_path || ''
  };
  const payload = {
    editMode: 'ultra_efficiency_process',
    processConfig: config || {},
    videoTransformPreset: videoTransformPreset || {},
    bgmPreset: resolvedBgmPreset,
    ttsFiles,
    captionUnits,
    captionWarnings,
    srtFile: resolveSrtPath(srtFile, ttsFiles),
    resolution: { width: 1080, height: 1920 },
    fps: 30,
    audioPathMode: 'absolute',
    createZip
  };

  return runCapcutScript(payload, 'process_draft_input.json');
}

module.exports = { generateDraft, generateProcessDraft, getCapcutTemplateStatus, __test: { assertCaptionUnitsMatchTtsFiles } };
