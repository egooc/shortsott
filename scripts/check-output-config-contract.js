const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function main() {
  const metadata = read('server/services/processMetadataService.js');
  const queue = read('server/services/processQueueService.js');
  const prompt = read('server/prompts/ottogi_process_metadata.txt');

  const rows = [
    {
      item: 'Central output config exists',
      ok: metadata.includes('const OUTPUT_CONFIG = Object.freeze')
        && metadata.includes("highlight: Object.freeze")
        && metadata.includes("full_draft: Object.freeze")
    },
    {
      item: 'Full draft production language is Korean',
      ok: metadata.includes("full_draft: Object.freeze")
        && metadata.includes("lang: 'ko'")
        && metadata.includes("metadataKey: 'full_metadata_ko'")
        && metadata.includes("scriptKey: 'full_caption_script_ko'")
    },
    {
      item: 'Highlight production language is Japanese',
      ok: metadata.includes("highlight: Object.freeze")
        && metadata.includes("lang: 'ja'")
        && metadata.includes("metadataKey: 'highlight_metadata'")
    },
    {
      item: 'Queue variant language uses shared config',
      ok: queue.includes('outputLanguageForVariant')
        && queue.includes('return outputLanguageForVariant(variant);')
    },
    {
      item: 'Metadata prompt names KR Full + JP Highlight',
      ok: metadata.includes('OUTPUT_CONFIG.full_draft.label')
        && metadata.includes('OUTPUT_CONFIG.highlight.label')
    },
    {
      item: 'Legacy text prompt no longer declares Japanese Full as main output',
      ok: prompt.includes('Main output contract: Korean Full Draft + Japanese Highlight Draft.')
        && !prompt.includes('Japanese is the main deliverable.')
        && !prompt.includes('`full_caption_script_ja` is the authoritative Full Draft manuscript')
    },
    {
      item: 'Korean caption limit is separate from Japanese',
      ok: metadata.includes('LANGUAGE_CAPTION_CONFIG')
        && metadata.includes('safeMaxChars: OUTPUT_CONFIG.full_draft.caption.safeMaxChars')
        && metadata.includes('safeMaxChars: 16')
    },
    {
      item: 'Japanese Full validation remains disabled for current contract',
      ok: metadata.includes('includeJapaneseFull: false')
    },
    {
      item: 'Metadata repair schema is thin field map',
      ok: metadata.includes('repaired_fields')
        && metadata.includes('Do not reuse OTTOGI_METADATA_SCHEMA')
    },
    {
      item: 'KO full narration style regeneration is guarded',
      ok: metadata.includes('buildKoreanFullCaptionScriptRegenerationPrompt')
        && metadata.includes('style_regeneration_required')
        && metadata.includes('full_caption_script_regeneration')
        && prompt.includes('Korean Full narration rewrite rules')
        && prompt.includes('Forbidden Korean Full endings')
    },
    {
      item: 'KO full hook is code-assigned and old exact opener is banned',
      ok: metadata.includes('selectKoreanFullHookType')
        && metadata.includes('Assigned Korean Full hook')
        && metadata.includes('ko_full_banned_exact_opening')
        && prompt.includes('assigned hook type is chosen by code')
        && prompt.includes('Do not write the literal sentence "이게 뭔지 아세요?"')
    }
  ];

  console.log('Output contract audit (O/X)');
  rows.forEach((row) => {
    console.log(`${row.ok ? 'O' : 'X'} ${row.item}`);
  });

  const failed = rows.filter((row) => !row.ok);
  assert(!failed.length, `output contract audit failed: ${failed.map((row) => row.item).join(', ')}`);
  console.log('output config contract ok');
}

main();
