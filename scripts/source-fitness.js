// 소스가 볼케이노 편집에 맞는지 값싸게 먼저 본다. 유료 ASR 을 쓰기 전에 돌릴 것.
//
//   node scripts/source-fitness.js <source.mp4> [--min-silences 20] [--json]
//
// 왜 필요한가 (2026-09-18, 케이스북 사례 52)
//   칼리토(1993) 와이어 장면으로 일곱 번 연속 반려됐다. 사유는 매번 "단어가 오디오 경계를 넘는다".
//   원인은 컷 위치가 아니라 소스였다 — 음악이 480초 내내 끊기지 않아 `silencedetect -30dB` 무음이 **0개**였다.
//   무음이 없으면 어디를 잘라도 말이 걸린다. 경계를 옮겨서 풀 수 있는 문제가 아니다.
//   이 검사 한 번이면 그 일곱 번의 실비를 아꼈다.
//
// 보는 것
//   1) 무음 구간 수 — 컷 경계를 놓을 자리가 실제로 있는가 (가장 중요)
//   2) 길이 — 명화관 규격 240~660초
//   3) 오디오 존재 여부
const { spawnSync } = require('child_process');

const file = process.argv[2];
if (!file) { console.error('사용법: node scripts/source-fitness.js <source.mp4> [--min-silences 20]'); process.exit(2); }
const i = process.argv.indexOf('--min-silences');
const minSil = i > 0 ? Number(process.argv[i + 1]) || 20 : 20;
const asJson = process.argv.includes('--json');

const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
  '-show_entries', 'stream=codec_type', '-of', 'json', file], { encoding: 'utf8' });
let dur = 0; let hasAudio = false;
try {
  const j = JSON.parse(probe.stdout || '{}');
  dur = Number(j.format?.duration || 0);
  hasAudio = (j.streams || []).some((s) => s.codec_type === 'audio');
} catch { /* 아래에서 실패로 처리 */ }

const sil = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'silencedetect=n=-30dB:d=0.15', '-f', 'null', '-'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const starts = [...(sil.stderr || '').matchAll(/silence_start: ([0-9.]+)/g)].map((m) => Number(m[1]));
const ends = [...(sil.stderr || '').matchAll(/silence_end: ([0-9.]+)/g)].map((m) => Number(m[1]));
const windows = starts.map((s, k) => [s, ends[k]]).filter(([s, e]) => Number.isFinite(e) && e - s >= 0.18);

const reasons = [];
if (!hasAudio) reasons.push('오디오 트랙 없음');
if (dur < 240 || dur > 660) reasons.push(`길이 ${dur.toFixed(0)}s 가 규격(240~660s) 밖`);
if (windows.length < minSil) reasons.push(`무음 구간 ${windows.length}개 < ${minSil}개 — 컷 경계를 놓을 자리가 없다`);

const out = {
  file, durationSec: Number(dur.toFixed(1)), hasAudio,
  silenceWindows: windows.length,
  longestSilence: windows.length ? Number(Math.max(...windows.map(([s, e]) => e - s)).toFixed(2)) : 0,
  fit: reasons.length === 0, reasons
};
if (asJson) { console.log(JSON.stringify(out, null, 1)); }
else {
  console.log(`길이 ${out.durationSec}s · 무음 ${out.silenceWindows}개(최장 ${out.longestSilence}s) · 오디오 ${hasAudio ? '있음' : '없음'}`);
  console.log(out.fit ? '적합: 제작 진행 가능' : `부적합: ${reasons.join(' / ')}`);
}
process.exit(out.fit ? 0 : 1);
