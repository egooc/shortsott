const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./pipelinePaths');

const TEMPLATES_ROOT = path.join(PROJECT_ROOT, 'prompts', 'claude_templates');
const COMMON_RULES_PATH = path.join(TEMPLATES_ROOT, 'common_rules.md');
const COMMON_SCHEMA_PATH = path.join(TEMPLATES_ROOT, 'common_output_schema.md');

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function exists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function readTextIfExists(filePath) {
  if (!exists(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
}

function normalizeTemplateMeta(raw, templateId) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    template_id: String(raw.template_id || templateId || '').trim(),
    template_name: String(raw.template_name || templateId || '').trim(),
    category: String(raw.category || '').trim(),
    enabled: raw.enabled !== false,
    description: String(raw.description || '').trim(),
    default_target_duration_sec: Number(raw.default_target_duration_sec || 90)
  };
}

function getTemplateDir(templateId) {
  return path.join(TEMPLATES_ROOT, templateId);
}

function listTemplates({ includeDisabled = true } = {}) {
  if (!exists(TEMPLATES_ROOT)) return [];
  const entries = fs.readdirSync(TEMPLATES_ROOT, { withFileTypes: true });
  const templates = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const templateId = entry.name;
    const templateJsonPath = path.join(TEMPLATES_ROOT, templateId, 'template.json');
    if (!exists(templateJsonPath)) continue;

    const meta = normalizeTemplateMeta(readJsonSafe(templateJsonPath), templateId);
    if (!meta) continue;
    if (!includeDisabled && meta.enabled === false) continue;
    templates.push(meta);
  }

  templates.sort((a, b) => a.template_id.localeCompare(b.template_id));
  return templates;
}

function getTemplate(templateId) {
  const safeTemplateId = String(templateId || '').trim();
  if (!safeTemplateId) return null;

  const dir = getTemplateDir(safeTemplateId);
  const templateJsonPath = path.join(dir, 'template.json');
  if (!exists(templateJsonPath)) return null;

  const meta = normalizeTemplateMeta(readJsonSafe(templateJsonPath), safeTemplateId);
  if (!meta) return null;

  const promptPath = path.join(dir, 'prompt.md');
  const reviewChecklistPath = path.join(dir, 'review_checklist.md');

  return {
    ...meta,
    template_dir: dir,
    prompt_path: promptPath,
    review_checklist_path: reviewChecklistPath,
    has_prompt: exists(promptPath),
    has_review_checklist: exists(reviewChecklistPath)
  };
}

function loadTemplateBundle(templateId) {
  const template = getTemplate(templateId);
  if (!template) return null;

  return {
    template,
    common_rules: readTextIfExists(COMMON_RULES_PATH),
    common_output_schema: readTextIfExists(COMMON_SCHEMA_PATH),
    template_prompt: readTextIfExists(template.prompt_path),
    review_checklist: readTextIfExists(template.review_checklist_path),
    common_rules_path: COMMON_RULES_PATH,
    common_output_schema_path: COMMON_SCHEMA_PATH
  };
}

module.exports = {
  TEMPLATES_ROOT,
  COMMON_RULES_PATH,
  COMMON_SCHEMA_PATH,
  listTemplates,
  getTemplate,
  loadTemplateBundle
};
