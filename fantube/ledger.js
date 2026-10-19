// 제작 장부 한 줄 — 규격 D:/midform/docs/production-ledger.md (관리자 07:40 성과 보고가 읽는다).
//   node ledger.js <ep폴더 이름> [--youtube-id X] [--publish-at ISO] [--gpt N] [--rejected N] [--started ISO] [--finished ISO] [--note "..."] [--retracted "이유"] [--style X]
// started_at 은 spec.json 의 started_at(없으면 --started), finished_at 은 out.mp4 수정 시각(없으면 --finished).
const fs = require('fs');
const path = require('path');

const ROOT = 'D:/volcano-runs/fantube';
const LEDGER = 'D:/midform/server/data/production_ledger.jsonl';
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const kst = (d) => new Date(d.getTime() + 9 * 3600e3).toISOString().replace('Z', '+09:00').replace(/\.\d+/, '');

const ep = process.argv[2];
const dir = path.join(ROOT, ep);
const spec = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8'));
const out = path.join(dir, 'out.mp4');
const rec = {
  at: kst(new Date()),
  session: 'B 팬튜브',
  lane: 'fantube',
  id: ep,
  title: (spec.title || []).join(' '),
  started_at: arg('--started', spec.started_at || null),
  finished_at: arg('--finished', fs.existsSync(out) ? kst(fs.statSync(out).mtime) : null),
  gpt_calls: Number(arg('--gpt', spec.gpt_calls || 0)),
  youtube_id: arg('--youtube-id', undefined),
  publish_at: arg('--publish-at', undefined),
  rejected: Number(arg('--rejected', 0)),
  note: arg('--note', spec.pattern || ''),
};
// 쇼츠 길이 2주 A/B(10/20 소유주 «계속») — 실제 길이로 묶는다: short <20초 · mid 20~35초 · long 35초+
if (fs.existsSync(out)) {
  const sec = Number(require('child_process').spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' }).stdout);
  if (sec > 0) { rec.duration_s = Math.round(sec * 10) / 10; rec.style = arg('--style', spec.style || (sec < 20 ? 'len_short' : sec < 35 ? 'len_mid' : 'len_long')); }
}
if (process.argv.includes('--retracted')) { rec.retracted = true; rec.retract_reason = arg('--retracted', ''); rec.publish_at = null; }
fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n', 'utf8');
console.log(JSON.stringify(rec));
