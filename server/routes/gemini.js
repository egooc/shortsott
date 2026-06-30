const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { requireApiKey } = require('../middleware/auth');
const { analyzeVideo } = require('../services/geminiService');
const { PROJECT_ROOT, writeJsonWithBackup } = require('../services/pipelinePaths');

const router = express.Router();
const jobs = new Map();
const GEMINI_ANALYSIS_FILE = path.join(PROJECT_ROOT, 'analysis', 'gemini_analysis.json');
const GEMINI_REVIEW_FILE = path.join(PROJECT_ROOT, 'analysis', 'gemini_review.json');

const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Only video files are allowed'), false);
  }
});

function normalizeSelectedSource(input = {}) {
  if (!input || typeof input !== 'object') return {};
  return {
    platform: String(input.platform || '').trim(),
    url: String(input.url || '').trim(),
    creator: String(input.creator || '').trim(),
    handle: String(input.handle || '').trim(),
    views: Number.isFinite(Number(input.views)) ? Number(input.views) : 0,
    viralityScore: Number.isFinite(Number(input.viralityScore)) ? Number(input.viralityScore) : 0,
    publishedAt: String(input.publishedAt || '').trim(),
    comet_id: String(input.comet_id || input.cometId || '').trim(),
    comet_name: String(input.comet_name || input.cometName || '').trim()
  };
}

function parseSelectedSource(rawValue) {
  if (!rawValue) return null;
  try {
    if (typeof rawValue === 'string') {
      const parsed = JSON.parse(rawValue);
      return normalizeSelectedSource(parsed);
    }
    if (typeof rawValue === 'object') {
      return normalizeSelectedSource(rawValue);
    }
  } catch {
    return null;
  }
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
    selected_claude_template: 'movie_recap',
    template_selection_reason: '',
    reviewer_notes: '',
    checks: {
      timecodes_ok: false,
      key_scenes_ok: false,
      dopamine_anchors_ok: false,
      risks_reviewed: false,
      cleanup_reviewed: false,
      story_angles_ok: false,
      ready_for_claude: false
    },
    blocking_issues: [],
    warnings: []
  };
}

router.post('/analyze', upload.single('file'), async (req, res, next) => {
  try {
    const apiKey = requireApiKey('GEMINI_API_KEY');
    if (!req.file) {
      return res.status(400).json({ error: true, message: 'file is required', code: 'FILE_REQUIRED', details: {} });
    }

    const analysisId = crypto.randomUUID();
    jobs.set(analysisId, {
      status: 'processing',
      plannedSavePath: GEMINI_ANALYSIS_FILE,
      createdAt: Date.now()
    });

    const contentType = req.body?.contentType || 'general';
    const selectedSource = parseSelectedSource(req.body?.selectedSource);

    analyzeVideo(req.file.path, contentType, apiKey)
      .then((result) => {
        const merged = {
          ...result,
          ...(selectedSource ? { selected_source: selectedSource } : {})
        };
        const { targetPath, backupPath } = writeJsonWithBackup(GEMINI_ANALYSIS_FILE, merged);
        jobs.set(analysisId, {
          status: 'completed',
          result: merged,
          plannedSavePath: GEMINI_ANALYSIS_FILE,
          savedPath: targetPath,
          backupPath: backupPath || null,
          createdAt: Date.now()
        });
      })
      .catch((error) =>
        jobs.set(analysisId, {
          status: 'failed',
          plannedSavePath: GEMINI_ANALYSIS_FILE,
          error: {
            message: error.message,
            code: error.code || 'GEMINI_ANALYSIS_FAILED',
            details: error.details || {}
          },
          createdAt: Date.now()
        })
      );

    res.json({
      analysisId,
      status: 'processing',
      plannedSavePath: GEMINI_ANALYSIS_FILE
    });
  } catch (error) {
    next(error);
  }
});

router.get('/analyze/:analysisId', (req, res) => {
  const job = jobs.get(req.params.analysisId);
  if (!job) {
    return res.status(404).json({ error: true, message: 'analysis not found', code: 'ANALYSIS_NOT_FOUND', details: {} });
  }
  res.json(job);
});

router.get('/review', (_req, res) => {
  if (!fs.existsSync(GEMINI_REVIEW_FILE)) {
    return res.status(404).json({
      error: true,
      message: 'Gemini review not found',
      code: 'GEMINI_REVIEW_NOT_FOUND',
      details: { path: GEMINI_REVIEW_FILE }
    });
  }

  const raw = fs.readFileSync(GEMINI_REVIEW_FILE, 'utf8');
  const review = JSON.parse(raw);
  return res.json({
    review,
    savedPath: GEMINI_REVIEW_FILE
  });
});

router.post('/review', (req, res, next) => {
  try {
    const payload = req.body || {};
    const checksInput = payload.checks || {};
    const checks = {
      timecodes_ok: toBool(checksInput.timecodes_ok),
      key_scenes_ok: toBool(checksInput.key_scenes_ok),
      dopamine_anchors_ok: toBool(checksInput.dopamine_anchors_ok),
      risks_reviewed: toBool(checksInput.risks_reviewed),
      cleanup_reviewed: toBool(checksInput.cleanup_reviewed),
      story_angles_ok: toBool(checksInput.story_angles_ok),
      ready_for_claude: toBool(checksInput.ready_for_claude)
    };

    const blockingIssues = Array.isArray(payload.blocking_issues) ? payload.blocking_issues : [];
    const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
    const selectedTemplate = String(payload.selected_claude_template || '').trim();
    const templateSelectionReason = String(payload.template_selection_reason || '').trim();

    const allChecksTrue = Object.values(checks).every((v) => v === true);
    let status = String(payload.status || '').trim();
    if (!status) {
      status = allChecksTrue ? 'approved' : 'needs_revision';
    }
    if (!['approved', 'needs_revision', 'rejected'].includes(status)) {
      status = 'needs_revision';
    }
    if (status === 'approved' && !allChecksTrue) {
      return res.status(400).json({
        error: true,
        message: 'Cannot approve review when required checks are not all true',
        code: 'GEMINI_REVIEW_INVALID_APPROVAL',
        details: { checks }
      });
    }

    const review = {
      ...defaultReview(),
      status,
      approved_at: status === 'approved' ? new Date().toISOString() : '',
      selected_claude_template: selectedTemplate || 'movie_recap',
      template_selection_reason: templateSelectionReason,
      reviewer_notes: String(payload.reviewer_notes || ''),
      checks,
      blocking_issues: blockingIssues.map((x) => String(x || '').trim()).filter(Boolean),
      warnings: warnings.map((x) => String(x || '').trim()).filter(Boolean)
    };

    const { targetPath, backupPath } = writeJsonWithBackup(GEMINI_REVIEW_FILE, review);
    res.json({
      review,
      savedPath: targetPath,
      backupPath: backupPath || null
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
