const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assertContains(file, text, message) {
  const source = read(file);
  if (!source.includes(text)) {
    throw new Error(`${message}\nMissing in ${file}: ${text}`);
  }
}

function assertNotContains(file, text, message) {
  const source = read(file);
  if (source.includes(text)) {
    throw new Error(`${message}\nForbidden in ${file}: ${text}`);
  }
}

function main() {
  const queueService = 'server/services/processQueueService.js';
  const metadataService = 'server/services/processMetadataService.js';
  const phaseUi = 'client/src/pages/Phase5Draft.jsx';

  assertContains(
    phaseUi,
    "highlight: 'highlight_only'",
    'Phase 2 Highlight button must keep requesting the highlight-only mode.'
  );

  assertContains(
    queueService,
    "normalized === 'highlight_only' && isLongformHighlightSource(itemConfig)",
    'Only longform items may promote highlight-only into full+highlight. Shortform highlight must stay highlight-only.'
  );

  assertContains(
    queueService,
    "capcut_template_draft_name: selectVariantCapcutTemplateDraftName(queueConfig, 'jp_highlight')",
    'JP Highlight drafts must keep using the JP Highlight sample template.'
  );

  assertContains(
    queueService,
    "caption_mode: 'long_bottom_explainer'",
    'JP Highlight drafts must keep the long bottom explainer caption mode.'
  );

  assertContains(
    queueService,
    "visual_template: 'jp_highlight'",
    'JP Highlight drafts must keep the highlight visual template.'
  );

  assertContains(
    queueService,
    "style_profile: 'highlight_explainer'",
    'JP Highlight captions must keep the highlight explainer style profile.'
  );

  assertContains(
    queueService,
    'stripHighlightScreenInternalNotes',
    'JP Highlight captions must strip internal notes before draft generation.'
  );

  assertContains(
    metadataService,
    'isHighlightOnlyShortform',
    'Shortform highlight analysis must keep its lightweight highlight-only path.'
  );

  assertNotContains(
    queueService,
    "queueConfig.capcut_template_draft_name,\n      variantDefaults.jp_highlight",
    'JP Highlight template selection must not fall back through the generic/full template before the highlight sample.'
  );

  console.log('shortform highlight contract ok');
}

main();
