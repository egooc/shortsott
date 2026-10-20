// 발굴용 키(YOUTUBE_API_KEY_SEARCH) 호출 한 곳 — 호출 직전 쿼터 장부(scripts/api_quota.js)에 적고, 429/403 이면 그날 키를 멈춘다.
//   const keyFetch = require('./lib/ytKeyFetch');
//   const j = await keyFetch('rinbox-scout', 'videos', url);   // 장부 상한·오늘 중지면 QuotaStop 을 던진다(호출 안 함)
// 왜 (10-20 12:55 키 429 · 관리자 지시): 키는 하나라 한 도구가 다 쓰면 모든 도구가 멈춘다. 우회 금지 — 멈추면 내일까지 기다린다.
const quota = require('../api_quota');

async function keyFetch(tool, endpoint, url) {
  quota.spend(tool, endpoint);
  const r = await fetch(url);
  if (r.status === 429 || r.status === 403) {
    quota.markBlocked(tool, `${endpoint} ${r.status}`);
    throw new quota.QuotaStop(`발굴 키 ${endpoint} ${r.status} — 오늘 남은 호출 전부 중지`);
  }
  return r.json();
}

module.exports = keyFetch;
module.exports.QuotaStop = quota.QuotaStop;
