// Shrink an exported cut to something that can be sent in chat for review.
//
//   node scripts/make-review-preview.js <mp4> [--max-mb 25] [--height 720] [--out <path>]
//
// The shipped exports run 150-200MB, over every chat attachment limit, which meant review
// required sitting at the machine the file is on. This makes a phone-sized copy: the bitrate is
// derived from the clip's real duration so the result lands under the cap on the first try
// rather than after guessing.
//
// Audio is deliberately NOT starved - reviews here are usually about the mix (BGM level, the
// fade at the tail), so the video takes the loss and the audio stays at 128k.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const AUDIO_KBPS = 128;

function parseArgs(argv) {
  const args = { input: '', maxMb: 25, height: 720, out: '' };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--max-mb') { args.maxMb = Number(argv[i + 1]) || 25; i += 1; }
    else if (argv[i] === '--height') { args.height = Number(argv[i + 1]) || 720; i += 1; }
    else if (argv[i] === '--out') { args.out = String(argv[i + 1] || ''); i += 1; }
    else if (!args.input) args.input = argv[i];
  }
  return args;
}

function durationSec(file) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file
  ], { encoding: 'utf8' });
  return Number(String(out).trim());
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.input || !fs.existsSync(args.input)) {
    console.error('usage: make-review-preview.js <mp4> [--max-mb 25] [--height 720]');
    process.exit(2);
  }
  const seconds = durationSec(args.input);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('cannot read duration');

  // Leave 8% for container overhead so the cap is a cap, not a target we overshoot.
  const budgetKbits = args.maxMb * 8 * 1024 * 0.92;
  const videoKbps = Math.max(200, Math.floor(budgetKbits / seconds) - AUDIO_KBPS);

  const out = args.out || path.join(
    path.dirname(args.input),
    `${path.basename(args.input, path.extname(args.input))}.preview.mp4`
  );
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', args.input,
    '-vf', `scale=-2:${args.height}`,
    '-c:v', 'libx264', '-b:v', `${videoKbps}k`, '-maxrate', `${Math.floor(videoKbps * 1.3)}k`,
    '-bufsize', `${videoKbps * 2}k`, '-preset', 'veryfast', '-profile:v', 'high',
    '-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`,
    '-movflags', '+faststart',
    out
  ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15 * 60 * 1000 });

  const mb = fs.statSync(out).size / 1048576;
  console.log(JSON.stringify({
    out, seconds: Number(seconds.toFixed(2)), videoKbps, mb: Number(mb.toFixed(1)),
    withinCap: mb <= args.maxMb
  }, null, 2));
  if (mb > args.maxMb) process.exitCode = 1;
}

main();
