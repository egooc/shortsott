// 린박스 타 플랫폼 발행 — 유튜브에 잡아 둔 같은 시계로 Blotato 채널에 내보낸다.
//
//   node scripts/rinbox-fanout.js <완성본.mp4> [--dry-run] [--platforms tiktok,instagram]
//
// 전제: rinbox-publish.js 가 먼저 돌아 유튜브 예약이 잡혀 있어야 한다.
//   유튜브 예약이 없으면 «같은 시각» 계약이 깨지고 Content ID 확인 창도 건너뛰게 되므로
//   여기서 멈춘다(명화관 blotato-publish 와 같은 계약).
//
// 린박스가 명화관과 다른 점은 입력뿐이다 — 캡컷 드래프트 폴더가 아니라 mp4 옆의 곁딸린 파일:
//   <완성본>.mp4.rinbox.json      work·locale·title·description·tags·workdir
//   <완성본>.mp4.social.<ko|ja>.txt   플랫폼별 본문 (섹션 모양은 명화관 패키지와 동일)
//
// Blotato 원시 함수(parseSection·composeText·buildTarget·scheduleFor)는 blotato-publish.js 가
// 내보내는 것을 그대로 쓴다. 복제하면 규격이 갈린다.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const { parseSection, composeText, buildTarget, scheduleFor } = require('./blotato-publish');

const ACCOUNTS_PATH = path.join(ROOT, 'midform', 'config', 'blotato_accounts.json');
const SPECS_PATH = path.join(ROOT, 'midform', 'config', 'platform_post_specs.json');
const YT_STATE_PATH = path.join(ROOT, 'server', 'data', 'rinbox_publish_state.json');
const STATE_PATH = path.join(ROOT, 'server', 'data', 'rinbox_blotato_state.json');
const REPORTS_DIR = path.join(ROOT, 'server', 'output', 'rinbox-publish-reports');

const API_BASE = 'https://backend.blotato.com/v2';
// naver_clip 은 Blotato 미지원이라 midform-webpublish-* 브라우저 경로가 따로 담당한다.
const FAN_OUT = ['tiktok', 'instagram', 'threads', 'facebook'];

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`, 'utf8');
}

function apiKey() {
  const key = String(process.env.BLOTATO_API_KEY || '').trim();
  if (!key) throw new Error('BLOTATO_API_KEY 가 없다 — .env 에 넣어라 (Blotato > Settings > API keys)');
  return key;
}

async function api(method, endpoint, body) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method,
    headers: { 'blotato-api-key': apiKey(), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* raw */ }
  if (!res.ok) throw new Error(`${method} ${endpoint} -> ${res.status} ${(parsed ? JSON.stringify(parsed) : text).slice(0, 300)}`);
  return parsed;
}

async function uploadLocalFile(filePath) {
  const filename = path.basename(filePath);
  const { presignedUrl, publicUrl } = await api('POST', '/media/uploads', { filename });
  if (!presignedUrl || !publicUrl) throw new Error('presigned 업로드가 URL 을 안 줬다');
  const bytes = fs.readFileSync(filePath);
  const put = await fetch(presignedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length) },
    body: bytes
  });
  if (!put.ok) throw new Error(`presigned PUT -> ${put.status} ${(await put.text()).slice(0, 200)}`);
  return publicUrl;
}

// 유튜브가 잡아 둔 시각. 차단돼 예약이 풀린 편은 blockedPublishAt 으로 옮겨져도
// 타 플랫폼으로는 나간다(인수인계 §5) — 그래서 둘 다 본다.
function youtubeClock(fileName) {
  const state = readJson(YT_STATE_PATH, {});
  const hit = [...(state.history || [])].reverse()
    .find((h) => h.file === fileName && (h.publishAt || h.blockedPublishAt));
  if (!hit) return null;
  return { iso: hit.publishAt || hit.blockedPublishAt, blocked: !hit.publishAt };
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const pf = argv.indexOf('--platforms');
  const wanted = pf >= 0 ? String(argv[pf + 1] || '').split(',').filter(Boolean) : FAN_OUT;
  const mp4Arg = argv.find((a) => !a.startsWith('--') && /\.mp4$/i.test(a));
  if (!mp4Arg) {
    console.log('사용법: node scripts/rinbox-fanout.js <완성본.mp4> [--dry-run] [--platforms a,b]');
    process.exitCode = 2;
    return;
  }

  const mp4 = path.resolve(mp4Arg);
  if (!fs.existsSync(mp4)) throw new Error(`mp4 가 없다: ${mp4}`);
  const meta = readJson(`${mp4}.rinbox.json`, null);
  if (!meta) throw new Error(`곁딸린 메타가 없다: ${mp4}.rinbox.json`);
  const locale = meta.locale;

  const socialPath = `${mp4}.social.${locale}.txt`;
  if (!fs.existsSync(socialPath)) throw new Error(`플랫폼 본문이 없다: ${socialPath}`);
  const socialText = fs.readFileSync(socialPath, 'utf8');

  const clock = youtubeClock(path.basename(mp4));
  if (!clock) throw new Error('유튜브 예약이 먼저다 — node scripts/rinbox-publish.js 를 돌려라');

  const config = readJson(ACCOUNTS_PATH, {});
  const specs = readJson(SPECS_PATH, {});
  const entry = (config.locales || {})[locale];
  if (!entry) throw new Error(`blotato_accounts 에 ${locale} 매핑이 없다`);

  const state = readJson(STATE_PATH, { history: [], media: {} });
  const done = new Set((state.history || []).map((h) => `${h.file}:${h.platform}`));
  const key = path.basename(mp4);
  const lines = [`# rinbox-fanout ${new Date().toISOString()}`,
    `- 파일: ${key} [${locale}] · 유튜브 시계 ${clock.iso}${clock.blocked ? ' (유튜브 차단분 — 타 플랫폼만)' : ''}`];

  let mediaUrl = (state.media || {})[key] || '';

  for (const platform of wanted) {
    const mapping = (entry.platforms || {})[platform];
    if (!mapping) { lines.push(`- 없음 ${platform}: 매핑 자체가 없다`); continue; }
    if (mapping.status !== 'connected' || !mapping.accountId) {
      lines.push(`- SKIP ${platform} [${locale}]: status=${mapping.status}`);
      continue;
    }
    if (done.has(`${key}:${platform}`)) { lines.push(`- 이미 올림 ${platform}`); continue; }

    const spec = (specs.platforms || {})[platform] || {};
    const section = parseSection(socialText, [spec.label, platform].filter(Boolean));
    if (!section || !section.caption) {
      lines.push(`- SKIP ${platform}: [${spec.label || platform}] 섹션이 비어 있다`);
      continue;
    }
    const text = composeText(section, spec);
    let target;
    try { target = buildTarget(platform, mapping, {}); }
    catch (e) { lines.push(`- FAIL ${platform}: ${e.message}`); continue; }

    const scheduledTime = scheduleFor(clock.iso, platform, false);
    if (dryRun) {
      console.log(`[dry-run] ${locale}/${platform} @ ${scheduledTime}\n    ${text.slice(0, 70).replace(/\n/g, ' ')}…`);
      lines.push(`- dry-run ${platform} ${scheduledTime} (${text.length}자)`);
      continue;
    }

    try {
      if (!mediaUrl) {
        console.log(`[media] 올리는 중 ${key}`);
        mediaUrl = await uploadLocalFile(mp4);
        state.media = { ...(state.media || {}), [key]: mediaUrl };
        writeJson(STATE_PATH, state);
      }
      const result = await api('POST', '/posts', {
        post: {
          accountId: String(mapping.accountId),
          content: { text, mediaUrls: [mediaUrl], platform },
          target
        },
        scheduledTime
      });
      const id = (result && (result.id || result.postId)) || '';
      console.log(`[post] ${locale}/${platform} @ ${scheduledTime} -> ${id}`);
      lines.push(`- OK ${platform} ${scheduledTime} (${id})`);
      state.history = [...(state.history || []), {
        at: new Date().toISOString(), file: key, work: meta.work, locale, platform,
        accountId: String(mapping.accountId), scheduledTime, id
      }].slice(-1000);
      writeJson(STATE_PATH, state);
    } catch (e) {
      console.log(`[fail] ${locale}/${platform}: ${e.message}`);
      lines.push(`- FAIL ${platform}: ${e.message}`);
    }
  }

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const rp = path.join(REPORTS_DIR, `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-rinbox-fanout.md`);
  fs.appendFileSync(rp, `${lines.join('\n')}\n\n`, 'utf8');
  console.log(lines.join('\n'));
  console.log(`report: ${rp}`);
}

main().catch((e) => { console.error('rinbox-fanout:', e.message || e); process.exitCode = 1; });
