// 위키미디어 공용에서 어랍숏용 소스를 찾고 **소리가 실제로 있는지**까지 재서 돌려준다.
//
//   node scripts/find-commons-clips.js "octopus" "street food" ...
//   node scripts/find-commons-clips.js --min-db -45 "parrot"
//
// 왜 필요한가 (2026-09-19, 케이스북 사례 62)
//   NOAA 심해 영상으로 만든 첫 어랍숏이 "밋밋하다"는 평을 받았다. 재 보니 덤보·도망 클립의 오디오가
//   **-91dB, 디지털 무음**이었다. 고슴도치로 갈아타도 같았다(-61dB, 또는 오디오 트랙 자체가 없음).
//   **무료 라이선스 야생·기관 영상은 소리가 없는 것이 기본값이다.** 길이와 화질만 보고 고르면
//   편집을 다 끝낸 뒤에야 밋밋하다는 걸 알게 된다. 그래서 고르는 단계에서 레벨을 잰다.
//
// 거르는 기준: 길이 20~120초 · 세로 720 이상 · 오디오 평균 레벨 > min-db(기본 -45dB)
// 라이선스는 항목마다 같이 찍는다. CC BY/BY-SA 는 출처 표기가 **의무**다. CC0/Public domain 은 자유.
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const dbAt = argv.indexOf('--min-db');
const MIN_DB = dbAt >= 0 ? Number(argv[dbAt + 1]) : -45;
const terms = argv.filter((a, i) => a !== '--min-db' && i !== dbAt + 1 && !a.startsWith('--'));
if (!terms.length) { console.error('사용법: node scripts/find-commons-clips.js [--min-db -45] "검색어" ...'); process.exit(2); }

const API = 'https://commons.wikimedia.org/w/api.php';
const UA = 'midform-source-scout/1.0 (contact: egoooc@gmail.com)';
const MIN_SEC = 20, MAX_SEC = 120, MIN_H = 720;

async function api(params) {
  const u = `${API}?${new URLSearchParams({ ...params, format: 'json' })}`;
  const r = await fetch(u, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`commons ${r.status}`);
  return r.json();
}

function meanDb(url) {
  // 앞 30초만 받아 레벨을 잰다. 영상 전체를 받지 않는다.
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-user_agent', UA,
    '-t', '30', '-i', url, '-vn', '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'buffer', timeout: 180000, maxBuffer: 64 << 20 });
  const err = (r.stderr || Buffer.alloc(0)).toString('utf8');
  if (!/Audio:/.test(err)) return null;           // 오디오 트랙 자체가 없다
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(err);
  return m ? Number(m[1]) : null;
}

(async () => {
  const seen = new Set();
  for (const t of terms) {
    const s = await api({ action: 'query', list: 'search', srsearch: `filetype:video ${t}`, srnamespace: 6, srlimit: 20 });
    const titles = (s.query?.search || []).map((x) => x.title);
    if (!titles.length) { console.log(`[${t}] 결과 없음`); continue; }
    const info = await api({ action: 'query', titles: titles.join('|'), prop: 'imageinfo', iiprop: 'url|size|extmetadata|metadata' });
    console.log(`\n[${t}]`);
    for (const p of Object.values(info.query?.pages || {})) {
      const ii = (p.imageinfo || [])[0]; if (!ii) continue;
      const md = Object.fromEntries((ii.metadata || []).map((m) => [m.name, m.value]));
      const dur = Number(md.length || md.playtime_seconds || 0);
      if (!(dur >= MIN_SEC && dur <= MAX_SEC) || (ii.height || 0) < MIN_H) continue;
      const name = p.title.replace(/^File:/, '');
      if (seen.has(name)) continue; seen.add(name);
      const db = meanDb(ii.url);
      const lic = ii.extmetadata?.LicenseShortName?.value || '?';
      const ok = db !== null && db > MIN_DB;
      const shown = db === null ? '오디오없음' : `${db.toFixed(1)}dB`;
      console.log(`${ok ? '적합' : '  탈락'} | ${dur.toFixed(0).padStart(3)}s | ${ii.width}x${ii.height} | ${shown.padStart(10)} | ${lic.slice(0, 16).padEnd(16)} | ${name.slice(0, 52)}`);
      if (ok) console.log(`       ${ii.url.split('?')[0]}`);
    }
  }
  console.log(`\n※ ${MIN_DB}dB 이하는 사실상 무음이다. 어랍숏에는 쓰지 마라.`);
  console.log('※ CC BY / BY-SA 는 출처 표기가 의무다. 영상 하단 크레딧에 저작자와 라이선스를 적을 것.');
})().catch((e) => { console.error('[commons]', e.message); process.exit(1); });
