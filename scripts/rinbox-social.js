// 린박스 편을 유튜브 밖 플랫폼으로 퍼뜨린다 (Blotato 7곳).
//
//   node scripts/rinbox-social.js --dry-run              무엇이 어디로 갈지만 본다
//   node scripts/rinbox-social.js                        실제 예약
//   node scripts/rinbox-social.js --only final-xxx.mp4   한 편만
//   node scripts/rinbox-social.js --platforms tiktok,threads
//   node scripts/rinbox-social.js --limit 3
//
// 왜 따로 만드나: blotato-publish.js 는 캡컷 «드래프트 폴더 + draft_content.json» 을 찾는다.
// 린박스는 드래프트를 만들지 않는다(소유주 지시 2026-09-28) — mp4 와 곁딸린
// <완성본>.rinbox.json 뿐이다. 그래서 린박스 편은 지금까지 **팬아웃 경로에 아예 없었다**:
// 유튜브 한 곳에만 올라갔고, ja 는 그 한 곳이 소유권 매칭으로 눌려 있었다.
//
// Blotato 로 말하는 부분(업로드·타깃 블록·과거시각 클램프)은 blotato-publish.js 것을
// 그대로 물려 쓴다. 그 세 곳은 사고를 겪고 고친 자리라 복제하면 갈라진다.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const { api, uploadLocalFile, buildTarget, scheduleFor } = require('./blotato-publish');

const RINBOX_STATE = path.join(ROOT, 'server', 'data', 'rinbox_publish_state.json');
const STATE_PATH = path.join(ROOT, 'server', 'data', 'rinbox_social_state.json');
const ACCOUNTS_PATH = path.join(ROOT, 'midform', 'config', 'blotato_accounts.json');
const SPECS_PATH = path.join(ROOT, 'midform', 'config', 'platform_post_specs.json');
const CATALOG_PATH = path.join(ROOT, 'midform', 'config', 'rinbox_catalog.json');
const REPORTS_DIR = path.join(ROOT, 'server', 'output', 'rinbox-social-reports');
const RUNS_ROOT = 'D:/volcano-runs';

// 유튜브는 여기 없다 — 린박스 유튜브 발행은 rinbox-publish.js(OAuth, 네이티브 publishAt)가 맡는다.
// Blotato 는 publishAt 을 지원하지 않아서 Content ID 프리플라이트 창이 사라진다.
const FAN_OUT = ['instagram', 'tiktok', 'threads', 'facebook'];

const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
};
const writeJson = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`, 'utf8');
};

function parseArgs(argv) {
  const args = { dryRun: false, only: '', limit: 0, platforms: null };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--only') { i += 1; args.only = argv[i] || ''; }
    else if (argv[i] === '--limit') { i += 1; args.limit = Number(argv[i] || 0); }
    else if (argv[i] === '--platforms') { i += 1; args.platforms = String(argv[i] || '').split(',').map((s) => s.trim()).filter(Boolean); }
  }
  return args;
}

// 완성본은 <workdir>/edits/<해시>/final-xxx.mp4 에 있다. 발행 기록에는 파일명만 남아 있어서
// 런 폴더를 훑어 찾는다. 찾은 경로는 상태에 적어 둬서 다음부터는 안 훑는다.
function findMp4(filename, cache) {
  if (cache[filename] && fs.existsSync(cache[filename])) return cache[filename];
  let runs = [];
  try { runs = fs.readdirSync(RUNS_ROOT); } catch { return ''; }
  for (const run of runs) {
    const editsDir = path.join(RUNS_ROOT, run, 'edits');
    let hashes = [];
    try { hashes = fs.readdirSync(editsDir); } catch { continue; }
    for (const h of hashes) {
      const candidate = path.join(editsDir, h, filename);
      if (fs.existsSync(candidate)) { cache[filename] = candidate; return candidate; }
    }
  }
  return '';
}

// 곁딸린 파일의 설명문은 40자쯤에서 강제 개행돼 있을 수 있다(rinbox04 가 그렇다).
// 유튜브 설명문에서는 안 보이지만 소셜 캡션에서는 문장 중간이 끊겨 읽힌다. 그래서 단락 안의
// 줄바꿈만 되붙인다. ★URL 이 있는 줄은 붙이지 않는다 — 붙이면 링크가 깨진다.
function unwrap(paragraph) {
  const raw = String(paragraph || '');
  // ★언어로 갈린다. 한국어는 단어 사이에 공백이 있으니 강제 개행 자리가 곧 공백이다
  //   — 그냥 붙이면 「직접 나서상황을」이 된다. 일본어는 공백을 쓰지 않으니 붙여야 한다.
  //   가나가 있으면 일본어로 본다(한국어에는 가나가 없다).
  const japanese = /[぀-ヿ]/.test(raw);
  const rows = raw.split('\n').map((s) => s.trim()).filter(Boolean);
  let out = '';
  for (const row of rows) {
    if (!out) { out = row; continue; }
    if (/https?:\/\//.test(row) || /https?:\/\//.test(out.slice(-60))) { out += `\n${row}`; continue; }
    out += japanese ? row : ` ${row}`;
  }
  return out;
}

// 설명문은 빈 줄로 갈린 네 토막이다: 원작 유도 / 줄거리 / 삭제 고지 / 출처 블록.
// 소셜 캡션은 여기서 골라 다시 짠다 — 유튜브 설명문을 그대로 붙이면 스레드(500자)가 넘친다.
function splitDescription(description) {
  const parts = String(description || '').split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const out = { pitch: '', summary: '', notice: '', source: '' };
  for (const p of parts) {
    if (/풀버전|フルバージョン|full version/i.test(p) && !out.pitch) out.pitch = unwrap(p);
    else if (/^★/.test(p)) out.notice = unwrap(p);
    else if (/^[─-]{5,}|출처|出典|source:/i.test(p)) out.source = unwrap(p.replace(/^[─-]{5,}\s*/, ''));
    else if (!out.summary) out.summary = unwrap(p);
  }
  return out;
}

// 린박스는 소셜 캡션 패키지를 따로 쓰지 않는다. 곁딸린 파일의 제목·설명·태그로 짠다.
// ★원작 유도 문구는 매 편 반드시 실린다 — 권리 자세이자 린박스 포맷의 일부다.
function composeCaption(meta, platform, spec) {
  const d = splitDescription(meta.description);
  const capMax = Number(spec?.caption_max || 2200);
  const tagMax = Number(spec?.hashtags?.max ?? 3);
  const tags = (meta.tags || []).slice(0, Math.max(0, tagMax)).map((t) => `#${String(t).replace(/\s+/g, '')}`);
  const tagLine = tags.join(' ');

  // 스레드는 500자다. 제목 + 원작 유도 + 태그 하나까지만 들어간다.
  const blocks = capMax <= 600
    ? [meta.title, d.pitch]
    : [meta.title, d.summary, d.pitch, d.source];

  let text = blocks.filter(Boolean).join('\n\n');
  const room = capMax - (tagLine ? tagLine.length + 2 : 0);
  if (text.length > room) text = `${text.slice(0, Math.max(0, room - 1)).trimEnd()}…`;
  return tagLine ? `${text}\n\n${tagLine}` : text;
}

function main() {
  const args = parseArgs(process.argv);
  const config = readJson(ACCOUNTS_PATH, null);
  if (!config) throw new Error(`cannot read ${ACCOUNTS_PATH}`);
  const specs = readJson(SPECS_PATH, { platforms: {} });
  const catalog = readJson(CATALOG_PATH, { works: {} });
  const state = readJson(STATE_PATH, { history: [], media: {}, paths: {} });
  state.paths = state.paths || {};
  const done = new Set((state.history || []).map((h) => `${h.file}:${h.platform}`));
  const wanted = args.platforms || FAN_OUT;

  const published = (readJson(RINBOX_STATE, { history: [] }).history || [])
    .filter((e) => e.file && e.locale)
    .filter((e) => !args.only || e.file === args.only);
  const targets = args.limit > 0 ? published.slice(-args.limit) : published;
  console.log(`린박스 발행 이력 ${published.length}건 중 ${targets.length}건 검토 · 대상 플랫폼 ${wanted.join(', ')}`);

  const lines = [`# rinbox-social ${new Date().toISOString()}`, ''];
  const jobs = [];

  for (const entry of targets) {
    const mp4 = findMp4(entry.file, state.paths);
    if (!mp4) { lines.push(`- SKIP(mp4 없음): ${entry.file}`); console.log(`  건너뜀 mp4 없음 ${entry.file}`); continue; }
    const meta = readJson(`${mp4}.rinbox.json`, null);
    if (!meta) { lines.push(`- SKIP(곁딸린 파일 없음): ${entry.file}`); console.log(`  건너뜀 메타 없음 ${entry.file}`); continue; }

    // ★로케일 금지 게이트 — rinbox-publish.js 와 같은 규칙이다. 한국 드라마를 ja 로 보내면
    //   유튜브에서 전세계 차단을 맞았다. 다른 플랫폼에도 같은 지역 라이선스가 걸려 있다.
    const localeBlock = ((catalog.works || {})[meta.work] || {}).locale_block?.[meta.locale];
    if (localeBlock) {
      lines.push(`- BLOCKED(${meta.locale}): ${entry.file} — ${localeBlock}`);
      console.log(`  ★발행 금지 ${meta.locale} ${meta.work}: ${localeBlock}`);
      continue;
    }

    const localeCfg = config.locales?.[meta.locale];
    if (!localeCfg) { lines.push(`- SKIP(매핑 없음 ${meta.locale}): ${entry.file}`); continue; }

    for (const platform of wanted) {
      const mapping = localeCfg.platforms?.[platform];
      if (!mapping) continue;
      if (mapping.status !== 'connected') {
        lines.push(`- ${platform} ${mapping.status} [${meta.locale}]: ${entry.file}`);
        continue;
      }
      if (done.has(`${entry.file}:${platform}`)) continue;
      const spec = specs.platforms?.[platform] || {};
      let target;
      try { target = buildTarget(platform, mapping, {}); }
      catch (e) { lines.push(`- FAIL ${platform} [${meta.locale}]: ${entry.file} — ${e.message}`); continue; }
      jobs.push({
        entry, meta, mp4, platform, mapping, target,
        text: composeCaption(meta, platform, spec),
        scheduledTime: scheduleFor(entry.publishAt || new Date().toISOString(), platform, false)
      });
    }
  }

  writeJson(STATE_PATH, state);
  return { args, jobs, lines, state, done };
}

async function run() {
  const { args, jobs, lines, state } = main();
  console.log(`예약할 건수 ${jobs.length}`);

  for (const job of jobs) {
    const tag = `${job.meta.locale}/${job.platform}`;
    if (args.dryRun) {
      console.log(`[dry-run] ${tag} @ ${job.scheduledTime} · ${job.text.length}자`);
      console.log(`          ${job.text.replace(/\n/g, ' ⏎ ').slice(0, 120)}`);
      lines.push(`- dry-run ${job.platform} [${job.meta.locale}] ${job.scheduledTime}: ${job.entry.file}`);
      continue;
    }
    try {
      let mediaUrl = (state.media || {})[job.entry.file] || '';
      if (!mediaUrl) {
        console.log(`[media] 업로드 ${job.entry.file}`);
        mediaUrl = await uploadLocalFile(job.mp4);
        state.media = { ...(state.media || {}), [job.entry.file]: mediaUrl };
        writeJson(STATE_PATH, state);
      }
      const result = await api('POST', '/posts', {
        post: {
          accountId: String(job.mapping.accountId),
          content: { text: job.text, mediaUrls: [mediaUrl], platform: job.platform },
          target: job.target
        },
        scheduledTime: job.scheduledTime
      });
      const id = result?.postSubmissionId || result?.id || 'submitted';
      console.log(`[post] ${tag} @ ${job.scheduledTime} -> ${id}`);
      lines.push(`- OK ${job.platform} [${job.meta.locale}] ${job.scheduledTime}: ${job.entry.file} (${id})`);
      state.history = [...(state.history || []), {
        at: new Date().toISOString(),
        file: job.entry.file,
        work: job.meta.work,
        locale: job.meta.locale,
        platform: job.platform,
        accountId: String(job.mapping.accountId),
        scheduledTime: job.scheduledTime,
        submissionId: String(id)
      }].slice(-2000);
      writeJson(STATE_PATH, state);
    } catch (error) {
      console.log(`[fail] ${tag}: ${error.message}`);
      lines.push(`- FAIL ${job.platform} [${job.meta.locale}]: ${job.entry.file} — ${error.message}`);
    }
  }

  lines.push('', '## 수동 발행 잔여',
    '- ko Facebook: 수익화가 개인 프로필에 있어 서드파티 발행 불가 — 비즈니스 스위트 직접(크로스포스트 해제).',
    '- ko 네이버 클립: Blotato 미지원 — 앱 직접 업로드, 정보태그 필수.');
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = path.join(REPORTS_DIR, `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-rinbox-social.md`);
  fs.appendFileSync(reportPath, `${lines.join('\n')}\n\n`, 'utf8');
  console.log(`보고서: ${reportPath}`);
}

if (require.main === module) {
  run().catch((e) => { console.error('rinbox-social fatal:', e.message || e); process.exitCode = 1; });
}
