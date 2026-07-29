const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const PROJECT_ROOT = path.join(__dirname, '..');
const CAPCUT_DRAFT_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'capcut_draft.py');

const { _test: capcutTest } = require('../server/services/capcutService');
const { collectRunArtifacts } = require('../server/services/midformRunArtifactsService');

test('CapCut draft payload defaults to folder-only output', () => {
  const payload = capcutTest.buildDraftPayloadOverrides({ outputBasePath: 'server/output/drafts' });

  assert.equal(payload.draft_output_mode, 'folder_only');
  assert.equal(payload.draftOutputMode, 'folder_only');
  assert.equal(payload.package_zip, false);
  assert.equal(payload.packageZip, false);
});

test('CapCut draft payload allows zip only when explicitly requested', () => {
  const payload = capcutTest.buildDraftPayloadOverrides({ package_zip: true });

  assert.equal(payload.draft_output_mode, 'folder_and_zip');
  assert.equal(payload.package_zip, true);
});

test('Python draft output policy keeps zip disabled by default', () => {
  const python = `
import importlib.util, json, sys, types
cc = types.ModuleType("pyCapCut")
sys.modules["pyCapCut"] = cc
sys.modules["pycapcut"] = cc
spec = importlib.util.spec_from_file_location("capcut_draft", ${JSON.stringify(CAPCUT_DRAFT_SCRIPT)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps({
  "default": module.resolve_draft_output_policy({}),
  "explicit": module.resolve_draft_output_policy({"draft_output_mode": "folder_and_zip"})
}, ensure_ascii=False))
`;
  const result = spawnSync('python', ['-c', python], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout.trim());

  assert.deepEqual(output.default, { mode: 'folder_only', create_zip: false });
  assert.deepEqual(output.explicit, { mode: 'folder_and_zip', create_zip: true });
});

test('run artifact collection reports draft folder without requiring zip', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'midform-folder-only-'));
  const workspaceDir = path.join(tempRoot, 'workspace');
  const pipelineRunDir = path.join(tempRoot, 'pipeline');
  const draftRoot = path.join(tempRoot, 'draft_folder');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(pipelineRunDir, { recursive: true });
  fs.mkdirSync(draftRoot, { recursive: true });
  fs.writeFileSync(path.join(pipelineRunDir, 'draft_input.json'), `${JSON.stringify({ captionUnits: [] }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(draftRoot, 'edit_manifest.json'), `${JSON.stringify({ segments: [], caption_units: [] }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(draftRoot, 'draft_content.json'), `${JSON.stringify({ tracks: [], materials: { texts: [] } }, null, 2)}\n`, 'utf8');

  const qa = collectRunArtifacts({
    workspaceDir,
    normalizedRequest: {
      profile: 'production',
      source: { url: 'https://youtu.be/example123' },
      output: { target_length_sec: 120 }
    },
    profile: 'production',
    pipelineRunDir,
    draftRoot,
    enablePreviewFrameProof: false,
    readability: {},
    sceneType: 'recap',
    editorialPattern: 'linear',
    previewLimit: 1
  });

  assert.match(qa.outputPaths.draft_folder, /draft_folder$/);
  assert.equal(Object.prototype.hasOwnProperty.call(qa.outputPaths, 'draft_zip'), false);
  assert.equal(fs.existsSync(path.join(workspaceDir, 'edit_manifest.json')), true);
  assert.equal(fs.existsSync(path.join(workspaceDir, 'draft_content.json')), true);
});
