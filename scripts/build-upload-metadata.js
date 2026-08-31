// Build per-locale YouTube upload metadata for an installed midform draft folder.
//
//   node scripts/build-upload-metadata.js <draft folder path> [--json]
//
// Written for the auto-publish chain but runnable standalone. Sources, in authority order:
//   1. social_posts.<loc>.txt inside the folder — the [YouTube Shorts] section carries the
//      hook-pattern title, caption and hashtags the pipeline already gate-checked.
//   2. midform/config/movie_catalog.json — the movie identity (개봉명 포함) appended to the
//      description, because the public listing must say which film the clip is from; ja tags
//      must use the Japanese release title (platform-package rule).
// Output: upload_meta.json in the draft folder { locale, variant, title, description, tags }.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CATALOG_PATH = path.join(ROOT, 'midform', 'config', 'movie_catalog.json');

function localeOf(folderName) {
  const m = /-(ko|ja)$/.exec(String(folderName || ''));
  return m ? m[1] : '';
}

function matchMovie(folderName) {
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  for (const [key, movie] of Object.entries(catalog.movies || {})) {
    if (new RegExp(movie.match, 'i').test(folderName)) return { key, ...movie };
  }
  return null;
}

// Folder names get rewritten as drafts are revised (20260825n-new-moon-QnFcGy becomes
// 20260827c-jacob_wolf_v7-QnFcGy), so the film often survives only in the run's
// source_info.json title ("... | Twilight: New Moon") — which is what the catalog patterns
// were written against. Matching on the folder alone silently yields movie=null, and that
// drops the ja release title AND skips the banned-distributor check entirely.
function movieHaystack(draftDir) {
  const parts = [path.basename(draftDir)];
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(draftDir, 'edit_manifest.json'), 'utf8'));
    const runDir = path.dirname(String(manifest.source_video_path || ''));
    const info = JSON.parse(fs.readFileSync(path.join(runDir, 'source_info.json'), 'utf8'));
    if (info.title) parts.push(String(info.title));
  } catch { /* the folder name is all we have */ }
  return parts.join(' ');
}

// The [YouTube Shorts] section is "(제목, n/100자)\n<title>\n\n(캡션, ...)\n<caption>\n\n(해시태그 ...)\n#a #b".
function parseYouTubeSection(text) {
  const section = /\[YouTube[^\]]*\][^\n]*\n=+\n([\s\S]*?)(?:\n=+\n|$)/i.exec(String(text || ''));
  if (!section) return null;
  const body = section[1];
  const grab = (label) => {
    // Consume only the rest of the label line. `\\s*\\n` also eats the blank lines an EMPTY
    // field leaves behind, so the capture swallows the NEXT "(label)" and an unfilled publish
    // package looks filled — that is how "(캡션, 0/5000자)" became a video title.
    const m = new RegExp(`\\(${label}[^)]*\\)[^\\n]*\\n([\\s\\S]*?)(?=\\n\\s*\\(|$)`).exec(body);
    const value = m ? m[1].trim() : '';
    return value.startsWith('(') ? '' : value;
  };
  const title = grab('제목');
  const caption = grab('캡션');
  const hashtagLine = grab('해시태그');
  const tags = [...String(hashtagLine).matchAll(/#([^\s#]+)/g)].map((m) => m[1]);
  return { title, caption, tags };
}

function buildUploadMeta(draftDir) {
  const folderName = path.basename(draftDir);
  const locale = localeOf(folderName);
  if (!locale) throw new Error(`folder name does not end in -ko/-ja: ${folderName}`);

  const socialPath = path.join(draftDir, `social_posts.${locale}.txt`);
  const social = fs.existsSync(socialPath)
    ? parseYouTubeSection(fs.readFileSync(socialPath, 'utf8'))
    : null;
  if (!social || !social.title) {
    throw new Error(`no [YouTube] section in ${path.basename(socialPath)} — 발행 패키지부터 생성해야 한다`);
  }

  const movie = matchMovie(movieHaystack(draftDir));
  if (movie && movie.distributor_tier === 'banned') {
    throw new Error(`banned distributor (${movie.distributor}) — 발행 금지 소스: ${folderName}`);
  }

  const movieTitle = movie ? (locale === 'ja' ? movie.title_ja : movie.title_ko) : '';
  const credit = movie ? (locale === 'ja' ? movie.credit_ja : movie.credit_ko) : '';
  const infoLine = movie
    ? (locale === 'ja'
      ? `映画: ${movie.title_ja}（${movie.title_en}, ${movie.year}）`
      : `영화: ${movie.title_ko} (${movie.title_en}, ${movie.year})`)
    : '';

  // Hashtags belong at the END OF THE DESCRIPTION, not only in `tags`: YouTube surfaces up to
  // three description hashtags above the title, while the `tags` field is invisible to viewers
  // (platform_post_specs: youtube.hashtags.where = "설명 끝"). Shipping them in `tags` alone
  // means the channel shows no hashtags at all.
  const hashtagLine = social.tags.slice(0, 3).map((t) => `#${t}`).join(' ');
  const description = [social.caption, '', credit, infoLine, '', hashtagLine]
    .filter((line, index, arr) => line !== '' || (arr[index - 1] !== '' && index < arr.length - 1))
    .join('\n')
    .trim();

  // ja tags must carry the Japanese release title; ko tags the Korean title. The social
  // hashtags stay, deduped, capped at 10 (YouTube counts total tag characters, not count,
  // but 10 short tags stays far under the 500-char limit).
  const tags = [...new Set([
    ...(movieTitle ? [movieTitle] : []),
    ...(movie && locale === 'ko' ? [movie.title_en] : []),
    ...social.tags
  ])].slice(0, 10);

  const meta = {
    locale,
    // Profile purposes in the upload service: ko_highlight <-> variant ko_highlight,
    // jp_highlight <-> variant highlight.
    variant: locale === 'ko' ? 'ko_highlight' : 'highlight',
    title: String(social.title).slice(0, 100),
    description: description.slice(0, 5000),
    tags,
    movie: movie ? { key: movie.key, distributor: movie.distributor, tier: movie.distributor_tier } : null,
    built_at: new Date().toISOString()
  };
  fs.writeFileSync(path.join(draftDir, 'upload_meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  return meta;
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: build-upload-metadata.js <draft folder>'); process.exit(2); }
  const meta = buildUploadMeta(path.resolve(dir));
  if (process.argv.includes('--json')) console.log(JSON.stringify(meta, null, 2));
  else console.log(`ok: ${meta.variant} | ${meta.title} | tags: ${meta.tags.join(', ')}`);
}

module.exports = { buildUploadMeta, parseYouTubeSection, matchMovie, movieHaystack };
