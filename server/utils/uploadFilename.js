const path = require('path');

function stripPathParts(value) {
  return String(value || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

function scriptScore(value) {
  const text = String(value || '');
  const matches = text.match(/[가-힣ぁ-ゟァ-ヿ一-龯]/g);
  return matches ? matches.length : 0;
}

function hasMojibakeSignals(value) {
  return /[ÃÂãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]/.test(String(value || ''));
}

function normalizePossiblyMojibakeFilename(value) {
  const original = stripPathParts(value);
  if (!original) return '';
  if (!hasMojibakeSignals(original)) return original;

  try {
    const decoded = Buffer.from(original, 'latin1').toString('utf8');
    if (!decoded || decoded.includes('\uFFFD')) return original;
    if (scriptScore(decoded) > scriptScore(original)) return decoded;
    return original;
  } catch {
    return original;
  }
}

function getUploadOriginalName(file, fallback = '') {
  const normalized = normalizePossiblyMojibakeFilename(file?.originalname || '');
  return normalized || fallback || '';
}

function getUploadExt(file, fallback = '') {
  const name = getUploadOriginalName(file, file?.originalname || fallback);
  const ext = path.extname(name || '').toLowerCase();
  return ext || fallback;
}

module.exports = {
  getUploadExt,
  getUploadOriginalName,
  normalizePossiblyMojibakeFilename
};
