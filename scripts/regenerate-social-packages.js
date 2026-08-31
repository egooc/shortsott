// Rebuild the publish package (social_posts.<loc>.txt) for installed CapCut drafts whose package
// came out empty. Fixes the fallout of the 2026-08-24 inline-schema regression, where every
// package was generated against the wrong Codex schema and shipped as a bare template.
//
//   node scripts/regenerate-social-packages.js [--only <base>] [--limit N] [--dry-run] [--force]
//
// - Works on the INSTALLED draft folders, not the pipeline workspaces: most of those are gone,
//   and the installed folder is what auto-publish and blotato-publish actually read.
// - buildSocialPosts wants a workspace (draft_<loc>/edit_manifest.json) and a compression run.
//   The manifest lives in the installed folder, so a shim workspace is assembled per draft. The
//   compression run is found by SOURCE TITLE: the run's source_info.json has no url or video id
//   (runs seeded from a local file record id:"source"), but its title matches the compress run's.
// - Only drafts whose ko AND ja both regenerate are written back; a half-updated pair would ship
//   one locale with new copy and the other with the old empty template.
// - Skips drafts that already have a filled package unless --force.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
try { require('dotenv').config({ path: path.join(ROOT, '.env') }); }
catch { /* env comes from the process */ }

const { buildSocialPosts } = require('../server/services/midformSocialPostService');
const { parseYouTubeSection } = require('./build-upload-metadata');

const DRAFTS_DIR = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts');
const TEST_RUNS = path.join(ROOT, 'midform', 'test_runs');
const CONFIRMATIONS = path.join(ROOT, 'server', 'output', 'upload_confirmations.json');
const REPORTS_DIR = path.join(ROOT, 'server', 'output', 'social-regen-reports');

function parseArgs(argv) {
  const args = { only: '', limit: 0, dryRun: false, force: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--only') { args.only = String(argv[i + 1] || ''); i += 1; }
    else if (argv[i] === '--limit') { args.limit = Number(argv[i + 1]) || 0; i += 1; }
  }
  return args;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

const normTitle = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 60);

// compress_* runs carry bootstrap_script.json + compression_slot_fills*.json, the facts the
// package is written from. Newest wins when a source was compressed more than once.
function compressIndex() {
  const index = new Map();
  for (const name of fs.readdirSync(TEST_RUNS)) {
    if (!name.startsWith('compress_')) continue;
    const dir = path.join(TEST_RUNS, name);
    if (!fs.existsSync(path.join(dir, 'bootstrap_script.json'))) continue;
    const info = readJson(path.join(dir, 'source_info.json'), null);
    const key = normTitle(info && info.title);
    if (!key) continue;
    const prev = index.get(key);
    if (!prev || fs.statSync(dir).mtimeMs > fs.statSync(prev).mtimeMs) index.set(key, dir);
  }
  return index;
}

function sourceTitleOf(draftDir) {
  const manifest = readJson(path.join(draftDir, 'edit_manifest.json'), null);
  if (!manifest) return '';
  const runDir = path.dirname(String(manifest.source_video_path || ''));
  const info = readJson(path.join(runDir, 'source_info.json'), null);
  return info ? String(info.title || '') : '';
}

function packageIsFilled(draftDir, locale) {
  const file = path.join(draftDir, `social_posts.${locale}.txt`);
  if (!fs.existsSync(file)) return false;
  const parsed = parseYouTubeSection(fs.readFileSync(file, 'utf8'));
  return Boolean(parsed && parsed.title);
}

// Confirmed and awaiting-review cuts are the ones that can actually be published, so they go
// first: a batch this long may be interrupted, and the useful half should already be done.
function priorityOrder(bases) {
  const finals = readJson(CONFIRMATIONS, { finals: [] }).finals || [];
  const rank = new Map();
  finals.forEach((entry, index) => {
    if (entry.draft) rank.set(String(entry.draft), entry.status === 'confirmed' ? index : 100 + index);
  });
  return [...bases].sort((a, b) => {
    const ra = rank.has(a) ? rank.get(a) : 1000;
    const rb = rank.has(b) ? rank.get(b) : 1000;
    return ra - rb || a.localeCompare(b);
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const index = compressIndex();

  const bases = new Set();
  for (const name of fs.readdirSync(DRAFTS_DIR)) {
    const m = /^(\d{8}[a-z]?-.+)-(ko|ja)$/.exec(name);
    if (!m) continue;
    if (args.only && m[1] !== args.only) continue;
    if (fs.existsSync(path.join(DRAFTS_DIR, name, 'edit_manifest.json'))) bases.add(m[1]);
  }

  let targets = priorityOrder(bases).filter((base) => args.force
    || ['ko', 'ja'].some((loc) => !packageIsFilled(path.join(DRAFTS_DIR, `${base}-${loc}`), loc)));
  if (args.limit > 0) targets = targets.slice(0, args.limit);

  console.log(`대상 ${targets.length}건 (설치 ${bases.size}건 중)${args.dryRun ? ' [dry-run]' : ''}`);
  const lines = [`# social 패키지 재생성 ${new Date().toISOString()}`, ''];
  let done = 0; let failed = 0;

  for (const [n, base] of targets.entries()) {
    const koDir = path.join(DRAFTS_DIR, `${base}-ko`);
    const jaDir = path.join(DRAFTS_DIR, `${base}-ja`);
    const present = ['ko', 'ja'].filter((loc) => fs.existsSync(path.join(DRAFTS_DIR, `${base}-${loc}`)));
    const compressDir = index.get(normTitle(sourceTitleOf(fs.existsSync(koDir) ? koDir : jaDir)));
    if (!compressDir) {
      console.log(`[${n + 1}/${targets.length}] SKIP ${base} — compress run 못 찾음`);
      lines.push(`- SKIP ${base}: compress run 없음`);
      failed += 1;
      continue;
    }
    if (args.dryRun) {
      console.log(`[${n + 1}/${targets.length}] would rebuild ${base} (${present.join(',')}) <- ${path.basename(compressDir)}`);
      lines.push(`- dry-run ${base} (${present.join(',')})`);
      continue;
    }

    // Shim workspace: buildSocialPosts only reads draft_<loc>/edit_manifest.json from here.
    const shim = fs.mkdtempSync(path.join(os.tmpdir(), 'social-'));
    const built = {};
    let error = '';
    try {
      for (const loc of present) {
        const src = path.join(DRAFTS_DIR, `${base}-${loc}`);
        fs.mkdirSync(path.join(shim, `draft_${loc}`), { recursive: true });
        fs.copyFileSync(path.join(src, 'edit_manifest.json'), path.join(shim, `draft_${loc}`, 'edit_manifest.json'));
      }
      for (const loc of present) {
        await buildSocialPosts({ workspaceDir: shim, compressionRunDir: compressDir, locale: loc });
        const out = path.join(shim, `social_posts.${loc}.txt`);
        if (!fs.existsSync(out)) throw new Error(`${loc}: 생성 파일 없음`);
        built[loc] = fs.readFileSync(out, 'utf8');
      }
    } catch (e) {
      error = String(e.message || e).slice(0, 160);
    }

    if (error) {
      console.log(`[${n + 1}/${targets.length}] FAIL ${base} — ${error}`);
      lines.push(`- FAIL ${base}: ${error}`);
      failed += 1;
    } else {
      // Both locales survived, so write the pair together and drop the cached metadata built
      // from the old empty package.
      for (const loc of present) {
        const dest = path.join(DRAFTS_DIR, `${base}-${loc}`);
        fs.writeFileSync(path.join(dest, `social_posts.${loc}.txt`), built[loc], 'utf8');
        try { fs.unlinkSync(path.join(dest, 'upload_meta.json')); } catch { /* none cached */ }
      }
      const check = present.map((loc) => `${loc}:${packageIsFilled(path.join(DRAFTS_DIR, `${base}-${loc}`), loc) ? 'OK' : 'EMPTY'}`);
      console.log(`[${n + 1}/${targets.length}] OK ${base} ${check.join(' ')}`);
      lines.push(`- OK ${base} ${check.join(' ')}`);
      done += 1;
    }
    try { fs.rmSync(shim, { recursive: true, force: true }); } catch { /* temp */ }
  }

  const summary = `완료 ${done}건 / 실패 ${failed}건 / 대상 ${targets.length}건`;
  console.log(summary);
  if (!args.dryRun) {
    lines.push('', summary);
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    fs.appendFileSync(path.join(REPORTS_DIR, `${stamp}-social-regen.md`), `${lines.join('\n')}\n\n`, 'utf8');
  }
}

main().catch((error) => {
  console.error('regenerate-social-packages fatal:', error.message || error);
  process.exitCode = 1;
});
