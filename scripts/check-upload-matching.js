// Guards the Phase 3 upload video<->TXT matching contract.
//
// Draft folder naming has two generations and both must keep matching:
//  - legacy:  YYYYMMDD_HHMMSS-NNN-CODE-title      (e.g. 20260625_153813-001-KF-...)
//  - current: YYYYMMDD-CODE-HHMMSS-title [Hnn]    (e.g. 20260728-H-023148-... H01)
// A 2026-08 regression: the draft-key and title-prefix logic only understood the
// legacy prefix, so current-format names could only match on byte-identical stems.
const {
  __test: uploadTest
} = require('../server/services/youtubeUploadService');

const {
  detectUploadVariant,
  extractDraftMatchKey,
  extractDraftStampKey,
  findMatchingMetadata,
  normalizeBaseName,
  normalizeUploadTitleKey
} = uploadTest;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeMetadata(originalName, index) {
  return {
    originalName,
    path: `fake/meta_${index}_${originalName}`,
    baseKey: normalizeBaseName(originalName),
    variant: detectUploadVariant(originalName),
    parsed: {},
    rawText: 'stub'
  };
}

function runMatch(videoName, metadataNames) {
  const importedMetadata = metadataNames.map((name, index) => makeMetadata(name, index));
  const metadataByBase = new Map();
  for (const record of importedMetadata) {
    const rows = metadataByBase.get(record.baseKey) || [];
    rows.push(record);
    metadataByBase.set(record.baseKey, rows);
  }
  return findMatchingMetadata(videoName, metadataByBase, importedMetadata, new Set());
}

// --- draft key extraction -------------------------------------------------

assert(
  extractDraftMatchKey('20260625_153813-001-KF-물 위에 뜬 시트가 접시에 쏙.mp4') === '20260625_153813-001-kf',
  'legacy draft key must stay byte-identical to the pre-change format'
);
assert(
  extractDraftMatchKey('20260728-H-023148-穀物から油を抽出する古の智慧 H01.mp4') === '20260728_023148-h-h01',
  'current-format draft key must carry date, time, variant code, and cut ordinal'
);
assert(
  extractDraftMatchKey('20260728-H-023318-鍛造工程ができるまで.mp4') === '20260728_023318-h',
  'current-format draft key without a cut ordinal must omit the ordinal segment'
);
assert(
  extractDraftStampKey('20260728-H-023148-穀物から油を抽出する H01.txt') === '20260728_023148',
  'stamp key must identify the draft generation run without the variant code'
);
assert(
  normalizeUploadTitleKey('20260728-H-023148-穀物から油を抽出する.mp4') === normalizeUploadTitleKey('穀物から油を抽出する.txt'),
  'title key must strip the current-format draft prefix'
);
assert(
  normalizeUploadTitleKey('20260625_153813-001-KF-마법 같은 수전사 기술.mp4') === normalizeUploadTitleKey('마법 같은 수전사 기술.txt'),
  'title key must strip the legacy draft prefix including multi-letter variant codes'
);

// --- exact stem match (both generations) ----------------------------------

assert(
  runMatch(
    '20260728-H-021153-灼熱の斧づくり：火花舞う鍛冶職人の技.mp4',
    ['20260728-H-021153-灼熱の斧づくり：火花舞う鍛冶職人の技.txt']
  )?.originalName === '20260728-H-021153-灼熱の斧づくり：火花舞う鍛冶職人の技.txt',
  'current-format identical stems must match'
);
assert(
  runMatch(
    '20260625_153813-001-KF-물 위에 뜬 시트가 접시에 쏙! 마법 같.mp4',
    ['20260625_153813-001-KF-물 위에 뜬 시트가 접시에 쏙! 마법 같은 수전사 기술.txt']
  )?.originalName === '20260625_153813-001-KF-물 위에 뜬 시트가 접시에 쏙! 마법 같은 수전사 기술.txt',
  'legacy truncated export names must still match their full-length TXT'
);

// --- truncated CapCut export names ----------------------------------------

assert(
  runMatch(
    '20260728-H-023038-炎と鉄が織りなすアート！職人によるナイフ製造工程 H0.mp4',
    [
      '20260728-H-023038-炎と鉄が織りなすアート！職人によるナイフ製造工程 H02.txt',
      '20260728-H-023038-鋼が命を吹き込まれる瞬間！ガットフックナイフができるまで H01.txt'
    ]
  )?.originalName === '20260728-H-023038-炎と鉄が織りなすアート！職人によるナイフ製造工程 H02.txt',
  'truncated current-format names must match the TXT sharing the same title prefix'
);

// --- draft-key tier: same folder, renamed title, ordinal disambiguation ----

assert(
  runMatch(
    '20260728-H-023148-穀物から油を抽出する古の智慧：ハンマーが紡ぐ秘伝 H01.mp4',
    [
      '20260728-H-023148-まったく別の書き直されたタイトル H01.txt',
      '20260728-H-023148-こちらも別の書き直されたタイトル H02.txt'
    ]
  )?.originalName === '20260728-H-023148-まったく別の書き直されたタイトル H01.txt',
  'same draft folder with a rewritten title must match via draft key + cut ordinal'
);

// --- cross-draft generic titles must NOT pair ------------------------------

assert(
  runMatch(
    '20260727-H-160616-鍛造工程ができるまで H01.mp4',
    ['20260727-H-164916-鍛造工程ができるまで H01.txt']
  ) === null,
  'a generic title from a different draft stamp must not match — its description belongs to another source video'
);

// --- prefix-less TXT (title-only metadata files) ---------------------------

assert(
  runMatch(
    '20260629-H-123713-魔法の糸：インド伝統菓子ソアンパプディの職人技.mp4',
    ['魔法の糸：インド伝統菓子ソアンパプディの職人技.txt']
  )?.originalName === '魔法の糸：インド伝統菓子ソアンパプディの職人技.txt',
  'a title-only TXT (no draft prefix) must match a prefixed video with the same title'
);

console.log('check-upload-matching: OK');
