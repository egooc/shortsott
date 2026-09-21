// 어랍숏용 소스 후보를 찾되 **소리가 실제로 있는지**까지 확인한다.
//
//   node scripts/find-audible-clips.js "검색어" "검색어2" ...
//
// 왜 필요한가 (2026-09-19, 케이스북 사례 62)
//   NOAA 심해 영상으로 만든 첫 어랍숏이 "밋밋하다"는 평을 받았다. 재 보니 덤보·도망 클립의
//   오디오가 **-91dB, 디지털 무음**이었다. 기관 배포 영상은 소리를 빼고 올리는 경우가 흔하다.
//   어랍숏은 현장음이 살아 있어야 하는 형식이라, 길이·화질만 보고 고르면 반드시 다시 만들게 된다.
//
// 보는 것: 재사용 허용(CC) · 길이 35~75초 · 최대 해상도 1080 이상 · 오디오 평균 레벨 > -60dB
const { spawnSync } = require('child_process');

const queries = process.argv.slice(2);
if (!queries.length) { console.error('사용법: node scripts/find-audible-clips.js "검색어" ...'); process.exit(2); }
const MIN = 30, MAX = 90, CC = '&sp=EgIwAQ%3D%3D';

const run = (a, t = 120000) => spawnSync(a[0], a.slice(1), { encoding: 'buffer', timeout: t, maxBuffer: 64 << 20 });
const out = (r) => (r.stdout || Buffer.alloc(0)).toString('utf8');

function search(q) {
  const r = run(['yt-dlp', '--flat-playlist', '--playlist-end', '15', '--print',
    '%(duration)s\t%(channel)s\t%(title)s\t%(id)s',
    `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}${CC}`], 180000);
  return out(r).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [d, ch, t, id] = l.split('\t');
    return { dur: Number(d) || 0, channel: ch || '', title: t || '', id: id || '' };
  }).filter((x) => x.id && x.dur >= MIN && x.dur <= MAX);
}

function audio(id) {
  // 음원만 받아 레벨을 잰다 — 영상 없이 몇 초면 끝난다.
  const u = `https://www.youtube.com/watch?v=${id}`;
  const h = run(['yt-dlp', '-f', 'ba', '-g', u], 90000);
  const url = out(h).trim().split('\n')[0];
  if (!url) return null;
  const v = run(['ffmpeg', '-hide_banner', '-nostats', '-t', '30', '-i', url, '-af', 'volumedetect', '-f', 'null', '-'], 120000);
  const err = (v.stderr || Buffer.alloc(0)).toString('utf8');
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(err);
  return m ? Number(m[1]) : null;
}

function maxHeight(id) {
  const r = run(['yt-dlp', '-F', `https://www.youtube.com/watch?v=${id}`], 90000);
  const hs = [...out(r).matchAll(/\d{3,4}x(\d{3,4})/g)].map((x) => Number(x[1]));
  return hs.length ? Math.max(...hs) : 0;
}

const seen = new Set(); const hits = [];
for (const q of queries) for (const x of search(q)) { if (!seen.has(x.id)) { seen.add(x.id); hits.push({ ...x, query: q }); } }

console.log(`재사용 허용 · ${MIN}~${MAX}초 후보 ${hits.length}건 — 오디오와 해상도를 잰다\n`);
for (const h of hits) {
  const db = audio(h.id);
  if (db === null) { console.log(`  건너뜀 ${h.id} (오디오 측정 실패)`); continue; }
  const hh = db > -60 ? maxHeight(h.id) : 0;
  const ok = db > -60 && hh >= 1080;
  console.log(`${ok ? '적합' : '  탈락'} | ${String(h.dur).padStart(3)}s | ${String(db).padStart(6)}dB | ${String(hh || '-').padStart(4)}p | ${h.channel.slice(0, 20).padEnd(22)} | ${h.title.slice(0, 40)} | ${h.id}`);
}
console.log('\n※ 오디오 -60dB 이하는 무음 트랙이다. 어랍숏에는 쓰지 마라.');
console.log('※ 재사용 허용이어도 출처 표기는 필요하다. 사람·상표가 크게 나오면 따로 확인할 것.');
