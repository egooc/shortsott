// 저작권 경고(스트라이크)가 왔을 때 — 같은 권리자의 남은 편을 한 번에 내릴 목록을 만든다.
//
//   node scripts/rinbox-strike-plan.js <locale> <경고받은 videoId 또는 권리자 이름>           목록만
//   node scripts/rinbox-strike-plan.js <locale> <videoId|권리자> --private                   전부 비공개로
//
//   예: node scripts/rinbox-strike-plan.js ko SBS
//       node scripts/rinbox-strike-plan.js ja K8aEMd0hXnI
//
// 왜 (2026-10-12 소유주 전자책 3장, «다 사실이니 시스템으로»):
//   방송사는 직원이 한 달에 한 번 몰아서 신고한다. 같은 날 같은 권리자의 편이 또 걸릴 수 있으니
//   경고를 받으면 그 권리자의 남은 편을 «빨리» 내려야 채널을 지킨다(경고 3회 = 채널 정지).
//   ★여기까지가 이 도구의 일이다 — 정지를 피하려 새 채널을 파거나 계정을 쪼개는 것은 하지 않는다
//     (유튜브 우회 금지 정책, 계정 정지 사유).
// 비공개는 되돌릴 수 있지만 공개 영상을 바꾸는 일이라 --private 는 사람이 목록을 본 뒤에 붙인다.
require('dotenv').config({ path: 'D:/midform/.env' });
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STATE = path.join(ROOT, 'server', 'data', 'rinbox_publish_state.json');
const CATALOG = path.join(ROOT, 'midform', 'config', 'rinbox_catalog.json');
const PROFILES = path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json');
const LOG = path.join(ROOT, 'server', 'data', 'rinbox_strike_log.jsonl');
const PURPOSE = { ko: 'ko_highlight', ja: 'jp_highlight' };

const [locale, target] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const PRIVATE = process.argv.includes('--private');

async function token(p) {
  const body = new URLSearchParams({
    client_id: p.oauthClientId, client_secret: p.oauthClientSecret,
    refresh_token: p.refreshToken, grant_type: 'refresh_token'
  });
  const j = await (await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' }
  })).json();
  if (!j.access_token) throw new Error('토큰 갱신 실패');
  return j.access_token;
}

// 권리자 이름은 표기가 갈린다(「テレビ朝日 / 東映」「NET（現・テレビ朝日）／東映」) — 조각으로 맞춘다.
const holderOf = (w) => String(w.rights_holder_ko || w.broadcaster || '');
const parts = (s) => s.split(/[\/／・（）()系\s]+/).map((x) => x.replace(/^現/, '')).filter((x) => x.length >= 2);
const sameHolder = (a, b) => parts(a).some((x) => parts(b).includes(x));

(async () => {
  if (!PURPOSE[locale] || !target) {
    console.log('쓰는 법: node scripts/rinbox-strike-plan.js <ko|ja> <videoId|권리자> [--private]');
    process.exitCode = 2; return;
  }
  const works = JSON.parse(fs.readFileSync(CATALOG, 'utf8')).works || {};
  const hist = (JSON.parse(fs.readFileSync(STATE, 'utf8')).history || [])
    .filter((e) => e.url && !e.retracted && e.locale === locale)
    .map((e) => ({ ...e, id: (/[?&]v=([\w-]{11})/.exec(e.url) || /shorts\/([\w-]{11})/.exec(e.url) || [])[1] }))
    .filter((e) => e.id);

  let holder = target;
  const struck = hist.find((e) => e.id === target);
  if (struck) holder = holderOf(works[struck.work] || {}) || struck.work;
  const hitWorks = Object.entries(works).filter(([k, w]) => sameHolder(holderOf(w), holder) || k === (struck || {}).work).map(([k]) => k);
  const list = hist.filter((e) => hitWorks.includes(e.work));
  console.log(`권리자 «${holder}» — 작품 ${hitWorks.length}개 (${hitWorks.join(', ')})`);

  const store = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
  const prof = (Array.isArray(store) ? store : (store.profiles || [])).find((x) => x.purpose === PURPOSE[locale]);
  if (!prof) throw new Error(`${locale} 업로드 프로필 없음`);
  const tk = await token(prof);

  const live = [];
  for (let i = 0; i < list.length; i += 50) {
    const r = await (await fetch('https://www.googleapis.com/youtube/v3/videos?part=status,snippet&id='
      + list.slice(i, i + 50).map((e) => e.id).join(','), { headers: { authorization: 'Bearer ' + tk } })).json();
    if (r.error) throw new Error(r.error.message);
    for (const v of r.items || []) if (v.status.privacyStatus !== 'private' || v.status.publishAt) live.push(v);
  }
  console.log(`내릴 대상 ${live.length}편 (공개 + 예약)${PRIVATE ? '' : ' — 목록만, 실행은 --private'}`);
  for (const v of live) {
    console.log(`  ${v.id}  [${v.status.privacyStatus}${v.status.publishAt ? ' 예약 ' + v.status.publishAt : ''}]  ${v.snippet.title.slice(0, 36)}`);
    if (!PRIVATE) continue;
    // publishAt 을 보내지 않으면 예약도 풀린다 — 나중에 저절로 공개되지 않는다
    const j = await (await fetch('https://www.googleapis.com/youtube/v3/videos?part=status', {
      method: 'PUT', headers: { authorization: 'Bearer ' + tk, 'content-type': 'application/json' },
      body: JSON.stringify({ id: v.id, status: { privacyStatus: 'private', selfDeclaredMadeForKids: v.status.selfDeclaredMadeForKids, embeddable: v.status.embeddable, license: v.status.license, publicStatsViewable: v.status.publicStatsViewable } })
    })).json();
    console.log(j.error ? `    실패: ${JSON.stringify(j.error).slice(0, 200)}` : '    비공개됨');
    fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), locale, holder, trigger: target, id: v.id, ok: !j.error }) + '\n', 'utf8');
  }
  if (PRIVATE && live.length) console.log('★rinbox_publish_state 의 retracted 는 건드리지 않았다 — 슬롯 계산이 필요하면 따로 표시');
})().catch((e) => { console.error('[strike-plan]', e.message); process.exitCode = 1; });
