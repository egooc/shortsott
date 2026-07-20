const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { analyzeMidformVideo } = require('../services/geminiMidformService');

const router = express.Router();
const jobs = new Map();
const PROJECT_ROOT = path.join(__dirname, '../..');
const MIDFORM_ANALYSIS_DIR = path.join(PROJECT_ROOT, 'midform', 'analysis');
const MIDFORM_UPLOAD_DIR = path.join(MIDFORM_ANALYSIS_DIR, 'uploads');
const MIDFORM_REVIEW_FILE = path.join(MIDFORM_ANALYSIS_DIR, 'midform_review.json');
const MIDFORM_LATEST_ANALYSIS_FILE = path.join(MIDFORM_ANALYSIS_DIR, 'latest_midform_analysis.json');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

ensureDir(MIDFORM_UPLOAD_DIR);

const upload = multer({
  dest: MIDFORM_UPLOAD_DIR,
  limits: { fileSize: 300 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Only video files are allowed'), false);
  }
});

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

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveProjectPath(inputPath) {
  const rawPath = String(inputPath || '').trim();
  if (!rawPath) return '';
  const resolved = path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(PROJECT_ROOT, rawPath);
  const relative = path.relative(PROJECT_ROOT, resolved);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? resolved : '';
}

function normalizeSelectedSource(input = {}) {
  if (!input || typeof input !== 'object') return {};
  return {
    platform: String(input.platform || '').trim(),
    url: String(input.url || '').trim(),
    creator: String(input.creator || '').trim(),
    handle: String(input.handle || '').trim(),
    views: Number.isFinite(Number(input.views)) ? Number(input.views) : 0,
    publishedAt: String(input.publishedAt || '').trim()
  };
}

function parseSelectedSource(rawValue) {
  if (!rawValue) return null;
  try {
    if (typeof rawValue === 'string') return normalizeSelectedSource(JSON.parse(rawValue));
    if (typeof rawValue === 'object') return normalizeSelectedSource(rawValue);
  } catch {
    return null;
  }
  return null;
}

function parseTranscript(rawValue) {
  if (!rawValue) return null;
  if (typeof rawValue === 'object') return rawValue;
  try {
    return JSON.parse(String(rawValue));
  } catch {
    return null;
  }
}

function parseTranscriptFromBody(body = {}) {
  const inline = parseTranscript(body.transcript || body.sourceTranscript || body.source_transcript);
  if (inline) return inline;
  return null;
}

function toBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
}

function defaultReview() {
  return {
    status: 'needs_revision',
    approved_at: '',
    reviewer_notes: '',
    checks: {
      duration_60_180_ok: false,
      midpoint_hook_ok: false,
      villain_structure_ok: false,
      large_scale_hook_first_3s: false,
      catharsis_or_memorable_line_ok: false,
      vertical_9_16_ok: false,
      no_real_names: false,
      adaptation_boundary_ok: false,
      clip_refs_valid: false,
      timecodes_safe: false,
      korean_natural: false,
      risks_reviewed: false,
      ready_for_claude: false
    },
    blocking_issues: [],
    warnings: []
  };
}

router.post('/analyze', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: true, message: 'file is required', code: 'FILE_REQUIRED', details: {} });
    }

    const analysisId = crypto.randomUUID();
    const analysisFile = path.join(MIDFORM_ANALYSIS_DIR, `${analysisId}.json`);
    jobs.set(analysisId, {
      status: 'processing',
      plannedSavePath: analysisFile,
      createdAt: Date.now()
    });

    const contentType = req.body?.contentType || 'movie_midform_recap';
    const selectedSource = parseSelectedSource(req.body?.selectedSource);

    const transcript = parseTranscriptFromBody(req.body || {});

    analyzeMidformVideo(req.file.path, contentType, { transcript })
      .then((result) => {
        const merged = {
          ...result,
          ...(transcript ? { source_transcript: transcript } : {}),
          ...(selectedSource ? { selected_source: selectedSource } : {})
        };
        const saved = writeJsonWithBackup(analysisFile, merged);
        writeJsonWithBackup(MIDFORM_LATEST_ANALYSIS_FILE, {
          analysis_id: analysisId,
          ...merged
        });
        jobs.set(analysisId, {
          status: 'completed',
          result: merged,
          plannedSavePath: analysisFile,
          savedPath: saved.targetPath,
          backupPath: saved.backupPath || null,
          createdAt: Date.now()
        });
      })
      .catch((error) =>
        jobs.set(analysisId, {
          status: 'failed',
          plannedSavePath: analysisFile,
          error: {
            message: error.message,
            code: error.code || 'GEMINI_MIDFORM_ANALYSIS_FAILED',
            details: error.details || {}
          },
          createdAt: Date.now()
        })
      );

    res.json({
      analysisId,
      status: 'processing',
      plannedSavePath: analysisFile
    });
  } catch (error) {
    next(error);
  }
});

router.get('/analyze/:analysisId', (req, res) => {
  const job = jobs.get(req.params.analysisId);
  if (job) return res.json(job);

  const analysisFile = path.join(MIDFORM_ANALYSIS_DIR, `${req.params.analysisId}.json`);
  const result = readJsonIfExists(analysisFile);
  if (!result) {
    return res.status(404).json({ error: true, message: 'midform analysis not found', code: 'MIDFORM_ANALYSIS_NOT_FOUND', details: {} });
  }
  return res.json({
    status: 'completed',
    result,
    savedPath: analysisFile
  });
});

router.get('/review', (_req, res) => {
  const review = readJsonIfExists(MIDFORM_REVIEW_FILE);
  if (!review) {
    return res.status(404).json({
      error: true,
      message: 'Midform review not found',
      code: 'MIDFORM_REVIEW_NOT_FOUND',
      details: { path: MIDFORM_REVIEW_FILE }
    });
  }
  return res.json({
    review,
    savedPath: MIDFORM_REVIEW_FILE
  });
});

router.post('/review', (req, res, next) => {
  try {
    const payload = req.body || {};
    const checksInput = payload.checks || {};
    const checks = Object.fromEntries(
      Object.keys(defaultReview().checks).map((key) => [key, toBool(checksInput[key])])
    );
    const allChecksTrue = Object.values(checks).every((value) => value === true);
    let status = String(payload.status || '').trim();
    if (!status) status = allChecksTrue ? 'approved' : 'needs_revision';
    if (!['approved', 'needs_revision', 'rejected'].includes(status)) {
      status = 'needs_revision';
    }
    if (status === 'approved' && !allChecksTrue) {
      return res.status(400).json({
        error: true,
        message: 'Cannot approve midform review when required checks are not all true',
        code: 'MIDFORM_REVIEW_INVALID_APPROVAL',
        details: { checks }
      });
    }

    const review = {
      ...defaultReview(),
      status,
      approved_at: status === 'approved' ? new Date().toISOString() : '',
      reviewer_notes: String(payload.reviewer_notes || ''),
      checks,
      blocking_issues: (Array.isArray(payload.blocking_issues) ? payload.blocking_issues : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean),
      warnings: (Array.isArray(payload.warnings) ? payload.warnings : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    };

    const saved = writeJsonWithBackup(MIDFORM_REVIEW_FILE, review);
    return res.json({
      review,
      savedPath: saved.targetPath,
      backupPath: saved.backupPath || null
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
