const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { generateMidformScript } = require('../services/claudeMidformService');

const router = express.Router();
const jobs = new Map();
const PROJECT_ROOT = path.join(__dirname, '../..');
const MIDFORM_GENERATED_DIR = path.join(PROJECT_ROOT, 'midform', 'scripts_generated');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function resolveProjectPath(inputPath) {
  const rawPath = String(inputPath || '').trim();
  if (!rawPath) return '';
  const resolved = path.isAbsolute(rawPath)
    ? path.normalize(rawPath)
    : path.resolve(PROJECT_ROOT, rawPath);

  const relative = path.relative(PROJECT_ROOT, resolved);
  if (!(relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative)))) {
    const error = new Error('Path must stay inside the project root');
    error.status = 400;
    error.code = 'MIDFORM_PATH_OUTSIDE_PROJECT';
    error.details = { inputPath };
    throw error;
  }
  return resolved;
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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

function writeJsonWithBackup(targetPath, data) {
  ensureDir(path.dirname(targetPath));
  let backupPath = null;
  if (fs.existsSync(targetPath)) {
    const parsed = path.parse(targetPath);
    backupPath = path.join(parsed.dir, `${parsed.name}.backup.${timestamp()}${parsed.ext || '.json'}`);
    fs.copyFileSync(targetPath, backupPath);
  }
  fs.writeFileSync(targetPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return { targetPath, backupPath };
}

function loadGeminiAnalysis(payload) {
  if (payload.gemini_analysis) {
    return {
      geminiAnalysis: payload.gemini_analysis,
      sourcePath: '',
      plannedSavePath: path.join(MIDFORM_GENERATED_DIR, `${crypto.randomUUID()}.json`)
    };
  }

  const sourcePath = resolveProjectPath(payload.gemini_analysis_path);
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    const error = new Error('gemini_analysis_path or gemini_analysis is required');
    error.status = 400;
    error.code = 'MIDFORM_GEMINI_ANALYSIS_REQUIRED';
    error.details = { gemini_analysis_path: payload.gemini_analysis_path || '' };
    throw error;
  }

  return {
    geminiAnalysis: readJsonFile(sourcePath),
    sourcePath,
    plannedSavePath: path.join(path.dirname(sourcePath), 'script.json')
  };
}

function errorBody(error) {
  return {
    message: error.message || 'Claude midform script generation failed',
    code: error.code || 'CLAUDE_MIDFORM_SCRIPT_FAILED',
    details: error.details || {}
  };
}

function normalizeReviewStatus(checks) {
  const required = [
    'story_flow_ok',
    'all_scenes_valid',
    'korean_ending_ok',
    'duration_ok',
    'ready_for_capcut'
  ];
  const normalized = Object.fromEntries(required.map((key) => [key, checks?.[key] === true || checks?.[key] === 'true']));
  const approved = Object.values(normalized).every((value) => value === true);
  return { checks: normalized, status: approved ? 'approved' : 'needs_revision' };
}

router.post('/script', (req, res, next) => {
  try {
    const payload = req.body || {};
    const scriptId = crypto.randomUUID();
    const loaded = loadGeminiAnalysis(payload);
    const plannedSavePath = loaded.sourcePath
      ? loaded.plannedSavePath
      : path.join(MIDFORM_GENERATED_DIR, `${scriptId}.json`);

    jobs.set(scriptId, {
      status: 'processing',
      plannedSavePath,
      createdAt: Date.now()
    });

    generateMidformScript(loaded.geminiAnalysis, {
      ...(payload.options || {}),
      scriptId
    })
      .then((script) => {
        const saved = writeJsonWithBackup(plannedSavePath, script);
        jobs.set(scriptId, {
          status: 'completed',
          result: script,
          savedPath: saved.targetPath,
          backupPath: saved.backupPath || null,
          plannedSavePath,
          createdAt: Date.now()
        });
      })
      .catch((error) => {
        jobs.set(scriptId, {
          status: 'failed',
          error: errorBody(error),
          plannedSavePath,
          createdAt: Date.now()
        });
      });

    return res.json({
      scriptId,
      status: 'processing',
      plannedSavePath
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/script/:scriptId', (req, res) => {
  const job = jobs.get(req.params.scriptId);
  if (!job) {
    return res.status(404).json({
      error: true,
      message: 'Claude midform script job not found',
      code: 'CLAUDE_MIDFORM_JOB_NOT_FOUND',
      details: { scriptId: req.params.scriptId }
    });
  }
  return res.json(job);
});

router.post('/review', (req, res, next) => {
  try {
    const payload = req.body || {};
    const scriptPath = resolveProjectPath(payload.script_path);
    if (!scriptPath) {
      return res.status(400).json({
        error: true,
        message: 'script_path is required',
        code: 'MIDFORM_SCRIPT_PATH_REQUIRED',
        details: {}
      });
    }

    const normalized = normalizeReviewStatus(payload.checks || {});
    const review = {
      status: normalized.status,
      approved_at: normalized.status === 'approved' ? new Date().toISOString() : '',
      script_path: scriptPath,
      checks: normalized.checks,
      reviewer_notes: String(payload.reviewer_notes || ''),
      created_at: new Date().toISOString()
    };
    const reviewPath = path.join(path.dirname(scriptPath), 'script_review.json');
    const saved = writeJsonWithBackup(reviewPath, review);
    return res.json({
      review,
      savedPath: saved.targetPath,
      backupPath: saved.backupPath || null
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/review', (req, res, next) => {
  try {
    const scriptPath = resolveProjectPath(req.query.script_path);
    if (!scriptPath) {
      return res.status(400).json({
        error: true,
        message: 'script_path query parameter is required',
        code: 'MIDFORM_SCRIPT_PATH_REQUIRED',
        details: {}
      });
    }

    const reviewPath = path.join(path.dirname(scriptPath), 'script_review.json');
    if (!fs.existsSync(reviewPath)) {
      return res.status(404).json({
        error: true,
        message: 'Claude midform script review not found',
        code: 'CLAUDE_MIDFORM_REVIEW_NOT_FOUND',
        details: { reviewPath }
      });
    }

    return res.json({
      review: readJsonFile(reviewPath),
      savedPath: reviewPath
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
