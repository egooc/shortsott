const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const SCAN_TARGETS = [
  'client/src',
  'server/routes',
  'server/services',
  'server/index.js',
  'electron',
  'midform/prompts',
  'midform/schemas',
  'midform/scripts',
  'scripts',
  'package.json',
  'AGENTS.md'
];

if (process.env.CHECK_RUN_DIR) {
  SCAN_TARGETS.push(process.env.CHECK_RUN_DIR);
}

const TEXT_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.css', '.html', '.json', '.md', '.cjs', '.mjs'
]);

const EXCLUDED_PARTS = new Set([
  'node_modules',
  'dist',
  'build',
  'server\\data',
  'server\\output',
  'server\\uploads',
  'midform\\test_runs\\layout_20260714_screenshots'
]);

const SUSPICIOUS_CODEPOINTS = new Set([
  0xfffd,
  0x8e42,
  0x907a,
  0x9858,
  0x5a9b,
  0x91c9,
  0x7b4c,
  0x7640
]);

const SUSPICIOUS_FRAGMENTS = [
  '?쒜', '?젣', '?글', '?낅', '?좏',
  '梨', '꾨', '좏', '쒓', '낅', '뱀', '蹂', '媛', '怨', '鍮', '諛', '濡', '移', '誘', '땲', '덈', '몄', '꾩', '쨌',
  '湲', '곗', '筌', '癰', '귡', '겫', '窈', '섇', '첎'
];

function shouldSkip(filePath) {
  const relative = path.relative(ROOT, filePath).replaceAll('/', '\\');
  if (relative === 'scripts\\check-encoding.js') return true;
  if ([...EXCLUDED_PARTS].some((part) => relative.includes(part))) return true;
  return false;
}

function walk(targetPath, out = []) {
  if (!fs.existsSync(targetPath) || shouldSkip(targetPath)) return out;
  const stat = fs.statSync(targetPath);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(targetPath)) {
      walk(path.join(targetPath, entry), out);
    }
    return out;
  }
  if (stat.isFile() && TEXT_EXTENSIONS.has(path.extname(targetPath).toLowerCase())) {
    out.push(targetPath);
  }
  return out;
}

function hasSuspiciousCodepoint(line) {
  for (const char of line) {
    const code = char.codePointAt(0);
    if (SUSPICIOUS_CODEPOINTS.has(code)) return `codepoint ${code.toString(16)}`;
    if (code >= 0xf900 && code <= 0xfaff) return `cjk compatibility ${code.toString(16)}`;
  }
  return '';
}

function isLikelyJsOperatorLine(line) {
  const trimmed = line.trim();
  return /\?\?|\?\.|\?\s*:/.test(trimmed) && !/[가-힣ぁ-んァ-ン一-龥]\?{2,}|\?{2,}[가-힣ぁ-んァ-ン一-龥]/.test(trimmed);
}

// 한글 음절 조각(뱀·꾩 …)은 정상 낱말에도 나온다(뱀파이어·도마뱀). 깨진 글은 조각 옆에 ?·�·한자·다른 조각이 붙으므로
// 이웃 글자가 그런 것일 때만 잡는다. 한자 조각(梨·蹂 …)은 예전처럼 어디에 있어도 잡는다.
const HANGUL_SYLLABLE = /[가-힣]/;
function isMojibakeNeighbor(ch) {
  if (!ch) return false;
  if (ch === '?' || ch === '�') return true;
  if (/[一-龥]/.test(ch)) return true;
  return SUSPICIOUS_FRAGMENTS.includes(ch);
}
function fragmentHit(line, fragment) {
  let from = 0;
  while (true) {
    const i = line.indexOf(fragment, from);
    if (i < 0) return false;
    if (!HANGUL_SYLLABLE.test(fragment) || fragment.startsWith('?')) return true;
    if (isMojibakeNeighbor(line[i - 1]) || isMojibakeNeighbor(line[i + fragment.length])) return true;
    from = i + fragment.length;
  }
}

// 정규식 리터럴 줄(= /…/, (/…/, .test( , new RegExp()에서는 ? 가 수량자다 — 개수 규칙에서 뺀다.
function isLikelyRegexLine(line) {
  return /(=\s*\/|\(\/|\.test\(|new RegExp\()/.test(line) && /\/[gimsuy]*[,;)\s]|\/[gimsuy]*$/.test(line.trim());
}

function inspectLine(line) {
  const trimmed = line.trim();
  if (trimmed.includes('"?? ?? ??" is acceptable')) return '';
  if (trimmed.startsWith('- Forbidden endings are absent:')) return '';

  // 깨진 글자 제거용 정규식(/�/g)은 의도된 리터럴이다.
  const codepointReason = /\/�\/[gimsuy]*/.test(line) ? '' : hasSuspiciousCodepoint(line);
  if (codepointReason) return codepointReason;

  for (const fragment of SUSPICIOUS_FRAGMENTS) {
    if (fragmentHit(line, fragment)) return `fragment ${fragment}`;
  }

  // 따옴표로 감싼 '????' 는 연도 모름 자리표시다(rival-films·whitelist-from-list).
  const stripped = line.replace(/(['"`])\?{4}\1/g, '$1$1');
  const questionCount = (stripped.match(/\?/g) || []).length;
  if (stripped.includes('???')) return 'literal triple question marks';
  const hasTernaryShape = stripped.includes(' ? ') && stripped.includes(' : ');
  if (questionCount >= 4 && !stripped.includes('http') && !hasTernaryShape && !isLikelyJsOperatorLine(stripped) && !isLikelyRegexLine(stripped)) return 'too many question marks';
  if (/[?]{2,}\s*[가-힣ぁ-んァ-ン一-龥]|[가-힣ぁ-んァ-ン一-龥]\s*[?]{2,}/.test(stripped)) return 'question marks near CJK text';

  return '';
}

function main() {
  const files = SCAN_TARGETS.flatMap((target) => walk(path.isAbsolute(target) ? target : path.join(ROOT, target)));
  const findings = [];

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      const reason = inspectLine(line);
      if (reason) {
        findings.push({
          file: path.relative(ROOT, file),
          line: index + 1,
          reason,
          text: line.slice(0, 240)
        });
      }
    });
  }

  if (findings.length) {
    console.error('Encoding/mojibake scan failed. Fix these before completing the task.');
    for (const item of findings.slice(0, 200)) {
      console.error(`${item.file}:${item.line} [${item.reason}] ${item.text}`);
    }
    if (findings.length > 200) console.error(`...and ${findings.length - 200} more findings`);
    process.exit(1);
  }

  console.log(`encoding scan ok (${files.length} files)`);
}

main();
