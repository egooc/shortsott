const express = require('express');
const { generateClaudeScript } = require('../services/claudeCliService');
const path = require('path');
const { readJsonIfExists, writeJsonWithBackup } = require('../services/pipelinePaths');
const {
  CLAUDE_SCRIPT_PATH,
  CLAUDE_REVIEW_PATH,
  GEMINI_ANALYSIS_PATH
} = require('../services/claudeCliService');
const { PROJECT_ROOT } = require('../services/pipelinePaths');
const { listTemplates, getTemplate, loadTemplateBundle } = require('../services/claudeTemplateService');

const router = express.Router();
const GEMINI_REVIEW_PATH = path.join(PROJECT_ROOT, 'analysis', 'gemini_review.json');

function assertGeminiReviewApproved() {
  const analysis = readJsonIfExists(GEMINI_ANALYSIS_PATH);
  if (!analysis) {
    const err = new Error('Gemini analysis file not found');
    err.status = 400;
    err.code = 'GEMINI_ANALYSIS_NOT_FOUND';
    err.details = { path: GEMINI_ANALYSIS_PATH };
    throw err;
  }

  const review = readJsonIfExists(GEMINI_REVIEW_PATH);
  if (!review) {
    const err = new Error('Gemini analysis must be reviewed and approved before Claude generation');
    err.status = 400;
    err.code = 'GEMINI_ANALYSIS_NOT_APPROVED';
    err.details = { reviewPath: GEMINI_REVIEW_PATH, reason: 'review_file_missing' };
    throw err;
  }

  const checks = review.checks || {};
  const ready = review.status === 'approved'
    && checks.timecodes_ok === true
    && checks.key_scenes_ok === true
    && checks.dopamine_anchors_ok === true
    && checks.risks_reviewed === true
    && checks.cleanup_reviewed === true
    && checks.story_angles_ok === true
    && checks.ready_for_claude === true;

  const templateId = String(review.selected_claude_template || '').trim();
  if (!templateId) {
    const err = new Error('Claude template must be selected in Gemini review before Claude generation');
    err.status = 400;
    err.code = 'CLAUDE_TEMPLATE_NOT_SELECTED';
    err.details = { reviewPath: GEMINI_REVIEW_PATH, review };
    throw err;
  }

  const template = getTemplate(templateId);
  if (!template) {
    const err = new Error(`Selected Claude template ${templateId} was not found`);
    err.status = 400;
    err.code = 'CLAUDE_TEMPLATE_NOT_FOUND';
    err.details = { templateId };
    throw err;
  }

  if (template.enabled === false) {
    const err = new Error(`Selected Claude template ${templateId} is disabled`);
    err.status = 400;
    err.code = 'CLAUDE_TEMPLATE_DISABLED';
    err.details = { templateId };
    throw err;
  }

  if (!ready) {
    const err = new Error('Gemini analysis must be reviewed and approved before Claude generation');
    err.status = 400;
    err.code = 'GEMINI_ANALYSIS_NOT_APPROVED';
    err.details = { reviewPath: GEMINI_REVIEW_PATH, review };
    throw err;
  }

  return { analysis, review, template };
}

function toBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
}

function defaultClaudeReview() {
  return {
    status: 'needs_revision',
    approved_at: '',
    reviewer_notes: '',
    selected_template: '',
    checks: {
      grounded_in_gemini: false,
      timecodes_valid: false,
      source_clips_valid: false,
      story_recreated_enough: false,
      script_narration_ok: false,
      caption_unit_ready: false,
      risks_reviewed: false,
      ready_for_tts: false
    },
    blocking_issues: [],
    warnings: []
  };
}

router.post('/generate-script', async (req, res, next) => {
  try {
    const { review } = assertGeminiReviewApproved();
    const { geminiAnalysis, storyAngle, targetDuration, tone, contentType } = req.body || {};
    const result = await generateClaudeScript({
      geminiAnalysis,
      geminiReview: review,
      options: {
        storyAngle: storyAngle || 'A-01',
        targetDuration: targetDuration || 90,
        tone: tone || 'perspective',
        contentType: contentType || 'movie_recap'
      }
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/templates', (_req, res) => {
  const templates = listTemplates({ includeDisabled: true });
  res.json({ templates });
});

router.get('/templates/:templateId', (req, res) => {
  const templateId = String(req.params.templateId || '').trim();
  const template = getTemplate(templateId);
  if (!template) {
    return res.status(404).json({
      error: true,
      message: `Template not found: ${templateId}`,
      code: 'CLAUDE_TEMPLATE_NOT_FOUND',
      details: { templateId }
    });
  }

  const bundle = loadTemplateBundle(templateId);
  return res.json({
    template,
    files: {
      has_prompt: template.has_prompt,
      has_review_checklist: template.has_review_checklist,
      prompt_path: template.prompt_path,
      review_checklist_path: template.review_checklist_path
    },
    review_checklist: bundle?.review_checklist || ''
  });
});

router.get('/latest-script', (req, res) => {
  const script = readJsonIfExists(CLAUDE_SCRIPT_PATH);
  if (!script) {
    return res.status(404).json({
      error: true,
      message: 'Saved Claude script not found',
      code: 'CLAUDE_SCRIPT_NOT_FOUND',
      details: { path: CLAUDE_SCRIPT_PATH }
    });
  }
  return res.json({
    script,
    savedPath: CLAUDE_SCRIPT_PATH
  });
});

router.get('/review', (_req, res) => {
  const review = readJsonIfExists(CLAUDE_REVIEW_PATH);
  if (!review) {
    return res.status(404).json({
      error: true,
      message: 'Claude review not found',
      code: 'CLAUDE_REVIEW_NOT_FOUND',
      details: { path: CLAUDE_REVIEW_PATH }
    });
  }

  return res.json({
    review,
    savedPath: CLAUDE_REVIEW_PATH
  });
});

router.post('/review', (req, res, next) => {
  try {
    const payload = req.body || {};
    const checksInput = payload.checks || {};
    const checks = {
      grounded_in_gemini: toBool(checksInput.grounded_in_gemini),
      timecodes_valid: toBool(checksInput.timecodes_valid),
      source_clips_valid: toBool(checksInput.source_clips_valid),
      story_recreated_enough: toBool(checksInput.story_recreated_enough),
      script_narration_ok: toBool(checksInput.script_narration_ok),
      caption_unit_ready: toBool(checksInput.caption_unit_ready),
      risks_reviewed: toBool(checksInput.risks_reviewed),
      ready_for_tts: toBool(checksInput.ready_for_tts)
    };
    const allChecksTrue = Object.values(checks).every((v) => v === true);
    let status = String(payload.status || '').trim();
    if (!status) status = allChecksTrue ? 'approved' : 'needs_revision';
    if (!['approved', 'needs_revision', 'rejected'].includes(status)) {
      status = 'needs_revision';
    }
    if (status === 'approved' && !allChecksTrue) {
      return res.status(400).json({
        error: true,
        message: 'Cannot approve Claude review when required checks are not all true',
        code: 'CLAUDE_REVIEW_INVALID_APPROVAL',
        details: { checks }
      });
    }

    const review = {
      ...defaultClaudeReview(),
      status,
      approved_at: status === 'approved' ? new Date().toISOString() : '',
      reviewer_notes: String(payload.reviewer_notes || ''),
      selected_template: String(payload.selected_template || '').trim(),
      checks,
      blocking_issues: (Array.isArray(payload.blocking_issues) ? payload.blocking_issues : [])
        .map((v) => String(v || '').trim())
        .filter(Boolean),
      warnings: (Array.isArray(payload.warnings) ? payload.warnings : [])
        .map((v) => String(v || '').trim())
        .filter(Boolean)
    };

    const { targetPath, backupPath } = writeJsonWithBackup(CLAUDE_REVIEW_PATH, review);
    return res.json({
      review,
      savedPath: targetPath,
      backupPath: backupPath || null
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
