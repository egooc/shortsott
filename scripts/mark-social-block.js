// 사람이 눈으로 확인한 «플랫폼별 차단»을 카탈로그에 적는다.
//
//   node scripts/mark-social-block.js <movie-key> <platform> ["본 것 한 줄"]
//   예: node scripts/mark-social-block.js tokyo-drift instagram "소유주 확인, 게시 뒤 내려감"
//
// 왜 (2026-09-23 소유주: "도쿄드리프트도 인스타에서 차단당했어")
//   블로타토는 그 게시물을 `published` 로 알고 있다 — **올라간 뒤 내려간 것은 API 가 안 알려 준다**
//   (사례 102). 그러니 사람이 본 것이 유일한 신호다. 그 신호를 받아 적을 칸이 없으면
//   다음에 같은 영화를 또 올린다.
//
// 왜 `distributor_tier: banned` 를 쓰지 않나
//   그 칸은 **유튜브 축**이다. 소유주 말대로 판정은 플랫폼마다 독립이다 —
//   "유튜브에서 통과한 게 인스타나 틱톡에서 차단되기도 해. 그 반대의 경우도 있고."
//   인스타에서 막혔다고 유튜브까지 접으면 멀쩡한 판을 버린다. 그래서 칸을 따로 둔다:
//       platform_blocks: { instagram: "2026-09-23 ..." }
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CATALOG = path.join(ROOT, 'midform', 'config', 'movie_catalog.json');
const KNOWN = ['instagram', 'tiktok', 'threads', 'facebook', 'facebook_profile', 'naverclip', 'youtube'];

const [key, platform, ...rest] = process.argv.slice(2);
if (!key || !platform) {
  console.error('사용법: mark-social-block.js <movie-key> <platform> ["본 것 한 줄"]');
  console.error(`판: ${KNOWN.join(' · ')}`);
  process.exit(2);
}
if (!KNOWN.includes(platform)) {
  console.error(`모르는 판: ${platform} — ${KNOWN.join(' · ')} 중 하나여야 한다`);
  process.exit(2);
}

const cat = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
const movie = (cat.movies || {})[key];
if (!movie) { console.error(`카탈로그에 없는 영화: ${key}`); process.exit(2); }

const note = rest.join(' ').trim() || '사람이 확인';
const stamp = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
movie.platform_blocks = movie.platform_blocks || {};
if (movie.platform_blocks[platform]) {
  console.log(`이미 적혀 있다: ${key} / ${platform} — ${movie.platform_blocks[platform]}`);
  process.exit(0);
}
movie.platform_blocks[platform] = `${stamp} ${note}`;
fs.writeFileSync(CATALOG, JSON.stringify(cat, null, 2));

console.log(`기록: ${key} 는 ${platform} 에서 차단 (${stamp} ${note})`);
console.log(`  · 유튜브 등급은 그대로 둔다(${movie.distributor_tier}) — 판정은 판마다 독립이다.`);
console.log('  · 앞으로 blotato-publish 가 이 영화를 그 판에는 안 올린다.');
