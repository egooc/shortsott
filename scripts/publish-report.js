// Publish reporting for the midform channels: did every scheduled post land, and how is it doing.
//
//   node scripts/publish-report.js --mode health   # T+3h: landed or not. NOT a performance read.
//   node scripts/publish-report.js --mode daily    # T+24h: first real numbers, yesterday's slot
//   node scripts/publish-report.js --mode weekly   # 7-day roll-up, decides what to make next
//                                  [--hours N] [--json]
//
// Three modes because the same numbers answer different questions at different ages. At three
// hours a low count means nothing about the content — it only tells you whether distribution
// started at all, which is the question worth asking about the ja accounts opened 2026-08-31.
// At 24h the platforms have finished their main push and the comparison is meaningful. Only the
// weekly view survives Shorts resurfacing days later.
//
// Sources: auto_publish_state.json (YouTube, via the Data API with the stored refresh tokens)
// and blotato_publish_state.json (everything else, via Blotato's analytics endpoint). Both live
// on this machine, which is why this runs locally rather than as a cloud routine.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
try { require('dotenv').config({ path: path.join(ROOT, '.env') }); }
catch { /* env comes from the process */ }

const YT_STATE = path.join(ROOT, 'server', 'data', 'auto_publish_state.json');
const BLOTATO_STATE = path.join(ROOT, 'server', 'data', 'blotato_publish_state.json');
const PROFILES = path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json');
const REPORTS_DIR = path.join(ROOT, 'server', 'output', 'publish-reports');
const API_BASE = 'https://backend.blotato.com/v2';

const MODE_HOURS = { health: 6, daily: 48, weekly: 24 * 8 };

function parseArgs(argv) {
  const args = { mode: 'daily', hours: 0, json: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--mode') { args.mode = String(argv[i + 1] || 'daily'); i += 1; }
    else if (argv[i] === '--hours') { args.hours = Number(argv[i + 1]) || 0; i += 1; }
  }
  return args;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function kst(iso) {
  return new Date(Date.parse(iso) + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16);
}

async function youtubeAccessToken(profile) {
  const body = new URLSearchParams({
    client_id: profile.oauthClientId,
    client_secret: profile.oauthClientSecret,
    refresh_token: profile.refreshToken,
    grant_type: 'refresh_token'
  });
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body });
  const data = await response.json();
  if (!data.access_token) throw new Error(`token refresh failed: ${JSON.stringify(data).slice(0, 160)}`);
  return data.access_token;
}

// The window is measured on WHEN IT GOES PUBLIC, not when it was uploaded. Uploads run hours
// ahead of the slot (today: 11:30 upload, 18:00 publish), so filtering on upload time made the
// 21:00 health check report "nothing published" on the very evening it published.
function publishedAt(entry) {
  return Date.parse(entry.publishAt || entry.scheduledTime || entry.at || 0);
}

async function youtubeRows(since) {
  const state = readJson(YT_STATE, { history: [] });
  const now = Date.now();
  const recent = (state.history || []).filter((h) => {
    const at = publishedAt(h);
    return at >= since && at <= now;   // not yet live = nothing to measure
  });
  if (!recent.length) return [];
  const raw = readJson(PROFILES, []);
  const profiles = Array.isArray(raw) ? raw : (raw.profiles || []);
  const byLocale = {
    ko: profiles.find((p) => p.purpose === 'ko_highlight'),
    ja: profiles.find((p) => p.purpose === 'jp_highlight')
  };
  const rows = [];
  for (const [locale, profile] of Object.entries(byLocale)) {
    const mine = recent.filter((h) => h.locale === locale && h.url);
    if (!mine.length || !profile) continue;
    let token;
    try { token = await youtubeAccessToken(profile); }
    catch (error) {
      for (const h of mine) rows.push({ platform: 'youtube', locale, draft: h.draft, error: error.message });
      continue;
    }
    const ids = mine.map((h) => (/[?&]v=([\w-]+)/.exec(h.url) || [])[1]).filter(Boolean);
    const response = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=status,snippet,statistics&id=${ids.join(',')}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await response.json();
    for (const item of data.items || []) {
      const entry = mine.find((h) => h.url.includes(item.id)) || {};
      const stats = item.statistics || {};
      rows.push({
        platform: 'youtube',
        locale,
        draft: entry.draft || '',
        title: item.snippet.title,
        url: `https://youtu.be/${item.id}`,
        privacy: item.status.privacyStatus,
        publishAt: entry.publishAt || '',
        views: Number(stats.viewCount || 0),
        likes: Number(stats.likeCount || 0),
        comments: Number(stats.commentCount || 0)
      });
    }
  }
  return rows;
}

async function blotatoRows(since) {
  const key = String(process.env.BLOTATO_API_KEY || '').trim();
  const state = readJson(BLOTATO_STATE, { history: [] });
  const now = Date.now();
  const recent = (state.history || []).filter((h) => {
    const at = publishedAt(h);
    return at >= since && at <= now;
  });
  if (!recent.length) return [];
  if (require('./publish-routes').blotatoOff()) return recent.map((h) => ({ platform: h.platform, locale: h.locale, draft: h.draft, publishAt: h.scheduledTime || '', status: String(h.submissionId || '').startsWith('skip:') ? 'skipped' : '', error: 'blotato_off' }));
  if (!key) return recent.map((h) => ({ ...h, error: 'BLOTATO_API_KEY not set' }));
  const rows = [];
  for (const entry of recent) {
    const row = {
      platform: entry.platform, locale: entry.locale, draft: entry.draft,
      publishAt: entry.scheduledTime || ''
    };
    try {
      const status = await fetch(`${API_BASE}/posts/${entry.submissionId}`, {
        headers: { 'blotato-api-key': key }
      }).then((r) => r.json()).catch(() => ({}));
      row.status = status.status || '';
      row.url = status.publicUrl || '';
      const a = await fetch(`${API_BASE}/posts/${entry.submissionId}/analytics`, {
        headers: { 'blotato-api-key': key }
      }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (a) {
        // Blotato collects metrics on its own schedule and this endpoint does NOT trigger a
        // re-fetch, so a fresh post reads {metrics: null, lastFetchedAt: null}. That is "not
        // measured yet", NOT zero — reporting it as 0 would fire the zero-distribution finding
        // on every post the morning after it went out.
        row.fetchedAt = a.lastFetchedAt || '';
        if (a.lastFetchedAt) {
          const m = a.metrics || a;
          row.views = Number(m.viewsCount || 0);
          row.likes = Number(m.likesCount || 0);
          row.comments = Number(m.commentsCount || 0);
          row.shares = Number(m.sharesCount || 0);
        }
        if (a.lastError) row.error = String(a.lastError).slice(0, 120);
      }
    } catch (error) {
      row.error = String(error.message).slice(0, 120);
    }
    rows.push(row);
  }
  return rows;
}

// What the reader should act on. Silence is not success: a post that never reached "published",
// or one with zero distribution well past its push window, is the finding — not the view count.
function findings(rows, mode) {
  const out = [];
  for (const row of rows) {
    if (row.error) { out.push(`조회 실패 ${row.locale}/${row.platform} (${row.draft}): ${row.error}`); continue; }
    if (row.platform === 'youtube') {
      if (row.privacy && row.privacy !== 'public') {
        out.push(`미공개 ${row.locale}/youtube: privacyStatus=${row.privacy} — 예약이 풀렸는지 확인`);
      }
    } else if (row.status && row.status !== 'published') {
      out.push(`미발행 ${row.locale}/${row.platform}: status=${row.status}`);
    }
    // Only a MEASURED zero is a finding. An unmeasured post says nothing yet — except that
    // Blotato has not collected it, which is worth surfacing once it is a day overdue.
    const measured = row.platform === 'youtube' || Boolean(row.fetchedAt);
    if (mode !== 'health' && measured && Number(row.views || 0) === 0
      && (row.privacy === 'public' || row.status === 'published')) {
      out.push(`노출 0 ${row.locale}/${row.platform} (${row.draft}) — 배포가 시작되지 않았을 수 있음`);
    }
    if (mode !== 'health' && row.platform !== 'youtube' && row.status === 'published' && !row.fetchedAt) {
      out.push(`지표 미수집 ${row.locale}/${row.platform} (${row.draft}) — 발행 24시간 뒤에도 Blotato가 수집하지 않았다`);
    }
  }
  return out;
}

function render(rows, mode, sinceIso) {
  const title = { health: '발행 건강 확인 (T+3h)', daily: '일간 성과 (T+24h)', weekly: '주간 종합 (7일)' }[mode] || mode;
  const lines = [`# ${title} — ${kst(new Date().toISOString())} KST`, '', `대상: ${kst(sinceIso)} KST 이후 발행분`, ''];
  if (!rows.length) {
    lines.push('_해당 기간에 발행된 건이 없습니다._');
    return lines.join('\n');
  }
  if (mode === 'health') {
    lines.push('※ 이 시점 수치는 성과 판단용이 아닙니다. 배포가 시작됐는지만 봅니다.', '');
  }
  lines.push('| 로케일 | 플랫폼 | 상태 | 조회 | 좋아요 | 댓글 | 드래프트 |', '|---|---|---|---|---|---|---|');
  for (const row of rows.sort((a, b) => `${a.locale}${a.platform}`.localeCompare(`${b.locale}${b.platform}`))) {
    const state = row.error ? '조회실패' : (row.platform === 'youtube' ? (row.privacy || '?') : (row.status || '?'));
    const n = (v) => (v === undefined || v === null ? '수집전' : String(v));
    lines.push(`| ${row.locale} | ${row.platform} | ${state} | ${n(row.views)} | ${n(row.likes)} | ${n(row.comments)} | ${String(row.draft || '').slice(0, 34)} |`);
  }
  const found = findings(rows, mode);
  lines.push('', found.length ? '## 확인 필요' : '## 확인 필요\n- 없음');
  for (const f of found) lines.push(`- ${f}`);
  if (mode === 'weekly') {
    lines.push('', '## 채널별 합계');
    const totals = {};
    for (const row of rows) {
      const k = row.locale;
      totals[k] = totals[k] || { views: 0, likes: 0, posts: 0 };
      totals[k].views += Number(row.views || 0);
      totals[k].likes += Number(row.likes || 0);
      totals[k].posts += 1;
    }
    for (const [k, t] of Object.entries(totals)) {
      lines.push(`- ${k}: ${t.posts}건 / 조회 ${t.views} / 좋아요 ${t.likes}`);
    }
    lines.push('', '※ ja 채널은 2026-08-31 개설. 워밍업(~09-14) 중에는 신규 계정 페널티와 콘텐츠 문제를 구분할 수 없다.');
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const hours = args.hours || MODE_HOURS[args.mode] || 48;
  const since = Date.now() - hours * 3600 * 1000;
  const sinceIso = new Date(since).toISOString();

  const rows = [...await youtubeRows(since), ...await blotatoRows(since)];
  if (args.json) { console.log(JSON.stringify({ mode: args.mode, since: sinceIso, rows }, null, 2)); return; }

  const text = render(rows, args.mode, sinceIso);
  console.log(text);
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const stamp = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  fs.appendFileSync(path.join(REPORTS_DIR, `${stamp}-${args.mode}.md`), `${text}\n\n`, 'utf8');
}

main().catch((error) => {
  console.error('publish-report fatal:', error.message || error);
  process.exitCode = 1;
});
