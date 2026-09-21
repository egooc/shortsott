// 어랍숏(바이럴 클립) 채널용 소스 후보를 찾는다. 조건에 맞는 것만 추려 출처·라이선스와 함께 돌려준다.
//
//   node scripts/find-clip-candidates.js "mantis shrimp eating" "octopus color" ...
//   node scripts/find-clip-candidates.js --cc "검색어"      재사용 허용(크리에이티브 커먼즈)만
//
// 기준 (2026-09-19 레퍼런스 채널 @urabshorts 실측에서 도출)
//   길이 35~75초  — 터진 편 3개가 43·48·52초였다
//   장면 전환 적음 — 100만/12만 편은 2~6회, 347회 편은 11회였다. 대상 하나를 오래 보여줄수록 좋다
//   개인 촬영     — 터진 편 출처가 © mantis.haihai, © morkkornhleng 같은 개인 계정이었다.
//                   드라마·영화 클립(© こねこフィルム)은 347회로 죽었다
//
// 라이선스: --cc 를 붙이면 유튜브 재사용 허용 필터를 쓴다. 안 붙이면 표준 라이선스도 섞여 나오므로
// 실제 사용 전에 원작자 허락을 받아야 한다 — 레퍼런스 채널이 출처만 표기하는 것은 그들의 관행이지
// 권리 처리가 된 것이 아니다.
const { spawnSync } = require('child_process');

const ccOnly = process.argv.includes('--cc');
const queries = process.argv.slice(2).filter((a) => a !== '--cc');
if (!queries.length) { console.error('사용법: node scripts/find-clip-candidates.js [--cc] "검색어" ...'); process.exit(2); }

const MIN = 35; const MAX = 75;
// 유튜브 검색 필터: EgIwAQ%3D%3D = 크리에이티브 커먼즈
const ccParam = '&sp=EgIwAQ%3D%3D';

function search(q) {
  const target = ccOnly
    ? `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}${ccParam}`
    : `ytsearch12:${q}`;
  const r = spawnSync('yt-dlp', ['--flat-playlist', '--playlist-end', '12',
    '--print', '%(duration)s\t%(view_count)s\t%(channel)s\t%(title)s\t%(id)s', target],
    { encoding: 'buffer', timeout: 180000 });
  const out = (r.stdout || Buffer.alloc(0)).toString('utf8').replace(/�/g, '?');
  return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [d, v, ch, t, id] = l.split('\t');
    return { dur: Number(d) || 0, views: Number(v) || 0, channel: ch || '', title: t || '', id: id || '' };
  }).filter((x) => x.id && x.dur >= MIN && x.dur <= MAX);
}

const seen = new Set();
const hits = [];
for (const q of queries) {
  for (const x of search(q)) {
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    hits.push({ ...x, query: q });
  }
}
hits.sort((a, b) => b.views - a.views);

console.log(`조건(${MIN}~${MAX}초${ccOnly ? ', 재사용 허용' : ''}) 통과 ${hits.length}건\n`);
for (const h of hits.slice(0, 20)) {
  console.log(`${String(h.dur).padStart(3)}s | ${String(h.views).padStart(9)} | ${h.channel.slice(0, 22).padEnd(24)} | ${h.title.slice(0, 36).padEnd(38)} | ${h.id}`);
}
if (!ccOnly) console.log('\n※ 표준 라이선스가 섞여 있다. 쓰기 전에 원작자 허락을 받거나 --cc 로 다시 찾아라.');
