// Blotato 확산에서 실패한 글을 찾아 다시 올린다.
//
//   node scripts/blotato-repair.js                기본: 실패 목록만 보여준다
//   node scripts/blotato-repair.js --retry        실제 재발행(즉시)
//   node scripts/blotato-repair.js --since-days 7 조회 범위(기본 7일)
//
// 왜 필요한가: blotato-publish.js 는 글을 한 번 접수하고 끝낸다. 접수는 성공했는데 플랫폼이 나중에
// 실패시키면(예: "Error posting to Instagram: An internal server error occurred") 아무도 모른다.
// 2026-09-17 23:04 에 ja/instagram 과 ko/threads 가 그렇게 조용히 빠졌고, 일본 인스타에 그날치가
// 한 편만 올라간 이유가 이것이었다. 접수 성공과 발행 성공은 다른 사건이라 따로 확인해야 한다.
//
// 재발행 시각: 원래 예약 시각은 이미 지났으므로 즉시 올린다. 유튜브·틱톡의 동시각 규칙은 이 둘에
// 적용되지 않는다(소유주 2026-09-18: 엄격한 동시각은 유튜브↔틱톡 뿐).
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STATE_PATH = path.join(ROOT, 'server', 'data', 'blotato_publish_state.json');
const ACCOUNTS = path.join(ROOT, 'midform', 'config', 'blotato_accounts.json');
const API = 'https://backend.blotato.com/v2';

const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const idx = process.argv.indexOf('--since-days');
const sinceDays = idx > 0 ? Number(process.argv[idx + 1]) || 7 : 7;
const doRetry = process.argv.includes('--retry');

async function api(method, endpoint, body) {
  const key = String(process.env.BLOTATO_API_KEY || '').trim();
  if (!key) throw new Error('BLOTATO_API_KEY 없음');
  const r = await fetch(`${API}${endpoint}`, {
    method,
    headers: { 'blotato-api-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${endpoint} -> ${r.status} ${text.slice(0, 160)}`);
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

(async () => {
  // .env 에 키가 있으면 읽어 온다(다른 스크립트와 같은 방식).
  if (!process.env.BLOTATO_API_KEY) {
    const env = path.join(ROOT, '.env');
    if (fs.existsSync(env)) {
      const m = /BLOTATO_API_KEY\s*=\s*(.+)/.exec(fs.readFileSync(env, 'utf8'));
      if (m) process.env.BLOTATO_API_KEY = m[1].trim().replace(/^["']|["']$/g, '');
    }
  }

  const since = new Date(Date.now() - sinceDays * 864e5).toISOString();
  const res = await api('GET', `/posts?status=failed&since=${encodeURIComponent(since)}&limit=50`);
  const failed = (res?.items || []).filter((p) => p?.state?.type === 'failed');
  if (!failed.length) { console.log(`최근 ${sinceDays}일 실패 없음`); return; }

  const state = readJson(STATE_PATH, { history: [], media: {} });
  const accounts = readJson(ACCOUNTS, {});
  console.log(`실패 ${failed.length}건 (최근 ${sinceDays}일)\n`);

  for (const p of failed) {
    // 우리 기록에서 어떤 드래프트였는지 찾는다: 같은 플랫폼 + 예약 시각이 15분 안.
    // 미디어 URL 로는 못 맞춘다 — Blotato 가 플랫폼마다 사본을 따로 올려 주소가 전부 다르다(2026-09-18 실측).
    // ko 와 ja 가 같은 시각에 나가므로 시각만으로는 둘이 구분되지 않는다 — 글자로 가른다.
    // 가나(히라가나·가타카나)가 있으면 ja, 한글이 있으면 ko.
    const t = String(p.text || '');
    const guessed = /[぀-ヿ]/.test(t) ? 'ja' : /[가-힣]/.test(t) ? 'ko' : '';
    const postMs = Date.parse(p.postTime);
    const mine = (state.history || []).find((h) => h.platform === p.platform
      && (!guessed || h.locale === guessed)
      && Math.abs(Date.parse(h.scheduledTime || 0) - postMs) < 15 * 60 * 1000);
    const who = mine ? `${mine.locale}/${mine.platform} ${mine.draft}` : `${p.platform} (우리 기록에 없음)`;
    console.log(`- ${who}\n  시각 ${String(p.postTime).slice(0, 16)}  사유: ${p.state.errorMessage}`);

    if (!doRetry) continue;
    if (!mine) { console.log('  건너뜀: 어느 드래프트인지 특정 불가'); continue; }

    const mapping = ((accounts.locales || {})[mine.locale] || {}).platforms?.[mine.platform];
    if (!mapping?.accountId) { console.log('  건너뜀: 계정 매핑 없음'); continue; }

    try {
      const out = await api('POST', '/posts', {
        post: {
          accountId: String(mapping.accountId),
          content: { text: p.text, mediaUrls: p.mediaUrls, platform: p.platform },
          target: p.platform === 'threads' ? { targetType: 'threads', replyControl: 'everyone' }
            : p.platform === 'instagram' ? { targetType: 'instagram', mediaType: 'reel', shareToFeed: true }
              : { targetType: p.platform }
        }
        // scheduledTime 생략 = 즉시 발행. 원래 시각은 이미 지났다.
      });
      const id = out?.postSubmissionId || out?.id || 'submitted';
      console.log(`  재발행 접수됨: ${id}`);
      state.history = [...(state.history || []), {
        at: new Date().toISOString(), draft: mine.draft, locale: mine.locale, platform: mine.platform,
        accountId: String(mapping.accountId), scheduledTime: new Date().toISOString(),
        submissionId: String(id), repairOf: p.id
      }].slice(-1000);
      fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    } catch (e) {
      console.log(`  재발행 실패: ${e.message}`);
    }
  }
  if (!doRetry) console.log('\n실제로 다시 올리려면 --retry');
})().catch((e) => { console.error('[repair]', e.message); process.exit(1); });
