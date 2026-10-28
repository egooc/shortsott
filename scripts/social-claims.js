// 유튜브 밖 플랫폼의 «못 올라갔거나 죽은» 게시물을 본다. check-claims 의 소셜판이다.
//
//   node scripts/social-claims.js            보고만 한다
//   node scripts/social-claims.js --requeue  실패한 것을 팬아웃 장부에서 지워 다시 올리게 한다
//
// 왜 (2026-09-23 소유주: "유튜브에서 통과한 게 인스타나 틱톡에서 차단되기도 해. 그 반대의 경우도 있고.")
//   판정은 플랫폼마다 독립인데 우리는 **유튜브 차단만 볼 줄 알았다**(사례 101).
//   틱톡·인스타에서 죽은 편은 아무도 안 봤고 통계에도 안 잡혔다.
//
// 무엇을 볼 수 있고 무엇은 못 보나 — 정직하게 갈라 둔다
//   ① **게시 실패**(state=failed) — 블로타토가 알려 준다. 확실히 본다. 대개 재시도로 풀린다.
//   ② **사후 차단/삭제** — 블로타토는 «올린 뒤 내려간 것»을 알려 주지 않는다.
//      유일한 실마리는 «올라갔다는데 조회가 0인 채로 오래 있다»는 것이다. 그건 **의심**이지 판정이 아니다.
//      사람이 직접 보고 판단해야 한다 — 그래서 여기서는 «확인 필요»로만 띄운다.
//   ★틱톡은 블로타토 분석이 아예 안 온다(지원 목록에 없다). 틱톡 사후 차단은 지금 볼 방법이 없다.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
try { require('dotenv').config({ path: path.join(ROOT, '.env') }); } catch { /* 환경에서 온다 */ }

const API = 'https://backend.blotato.com/v2';
const STATE = path.join(ROOT, 'server', 'data', 'blotato_publish_state.json');
const REPORT_DIR = path.join(ROOT, 'server', 'output', 'blotato-publish-reports');
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

async function api(qs) {
  if (require('./publish-routes').blotatoOff()) return [];   // Blotato 꺼짐(10-29) — 실패 글 조회 0회
  const key = String(process.env.BLOTATO_API_KEY || '').trim();
  if (!key) throw new Error('BLOTATO_API_KEY 가 없다 — .env 를 확인하라');
  const r = await fetch(`${API}/posts?${qs}`, { headers: { 'blotato-api-key': key } });
  const j = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
  return j.items || [];
}

function draftOf(item, state) {
  // 블로타토가 주는 id(715907)와 우리 submissionId(uuid)는 다른 축이라 직접 못 잇는다.
  // 대신 **판 + 예약 시각**으로 맞춘다 — 우리가 그 시각을 잡아 보냈으므로 postTime 과 같아야 한다.
  // 몇 분의 흔들림은 허용한다(블로타토가 당겨 올릴 수 있다).
  const t = Date.parse(item.postTime || '');
  if (!Number.isFinite(t)) return '';
  let best = '';
  let bestGap = Infinity;
  for (const h of (state.history || [])) {
    if (h.platform !== item.platform) continue;
    const s2 = Date.parse(h.scheduledTime || h.at || '');
    if (!Number.isFinite(s2)) continue;
    const gap = Math.abs(s2 - t);
    if (gap < bestGap) { bestGap = gap; best = h.draft; }
  }
  return bestGap <= 15 * 60 * 1000 ? best : '';
}

(async () => {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const failed = await api(`status=failed&limit=250&since=${encodeURIComponent(since)}`);
  const state = readJson(STATE, { history: [] });

  const lines = [`# 소셜 판정 ${new Date().toLocaleString('ko-KR')}`, ''];
  lines.push(`지난 30일 · **게시 실패 ${failed.length}건**`, '');

  const requeue = [];
  for (const it of failed) {
    const draft = draftOf(it, state);
    const why = ((it.state || {}).errorMessage || '').slice(0, 90);
    lines.push(`- 실패 [${it.platform}] ${String(it.postTime).slice(0, 16)} · ${draft || '(드래프트 미상)'}`);
    lines.push(`  ${why}`);
    if (draft) requeue.push({ draft, platform: it.platform });
  }

  if (process.argv.includes('--requeue') && requeue.length) {
    // 팬아웃 장부에서 그 (드래프트, 판) 기록을 지운다 → fanout-gaps 가 다시 «빠짐»으로 세고
    // fanout-backfill 이 다음 슬롯에 집어 간다. 발행 자체는 기존 경로가 한다.
    const before = (state.history || []).length;
    state.history = (state.history || []).filter(
      (h) => !requeue.some((r) => r.draft === h.draft && r.platform === h.platform));
    fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
    lines.push('', `**재시도 대기열에 넣음**: 장부에서 ${before - state.history.length}건 지웠다.`
      + ' 다음 백필 슬롯이 다시 올린다.');
  } else if (requeue.length) {
    lines.push('', `_\`--requeue\` 를 주면 ${requeue.length}건을 다시 올리게 한다._`);
  }

  lines.push('', '## 볼 수 없는 것 (정직하게)');
  lines.push('- **올린 뒤 내려간 것**은 블로타토가 알려 주지 않는다. 조회 0 이 오래가면 의심할 뿐 판정은 못 한다.');
  lines.push('- **틱톡은 분석 자체가 안 온다**(블로타토 지원 목록 밖). 틱톡 사후 차단은 지금 볼 방법이 없다 — 사람이 앱에서 본다.');

  const text = lines.join('\n');
  console.log(text);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  fs.writeFileSync(path.join(REPORT_DIR, `${stamp}-social-claims.md`), `${text}\n`, 'utf8');
})().catch((e) => { console.error('social-claims fatal:', e.message || e); process.exitCode = 1; });
