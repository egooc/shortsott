// 쇼핑 유튜브 영상에 태그를 넣고 다시 읽어 확인한다(yt-upload.js 는 태그를 넣지 않는다 — 10/16 쟁점브리핑 태그 0개 사고, 관리자 전 세션 공지).
//
//   node scripts/shop_yt_tags.js <videoId> <meta.json> [--dry-run]     한 편
//   node scripts/shop_yt_tags.js --audit [--days 7] [--dry-run]        schedule_shopping.json 최근 N일 공개·예약분 점검, 0개면 넣는다
//   node scripts/shop_yt_tags.js --list --purpose <업로드 프로필 purpose> [--days 7]   어느 채널이든 최근 N일 업로드 중 태그 0개 목록만(고치지 않음, 0개 있으면 종료 코드 4)
//   node scripts/shop_yt_tags.js --wait-propagation <videoId> <meta.json> <태그 수>   전파 대기 백그라운드(ensureTags 가 띄운다)
//   require('./shop_yt_tags').ensureTags(videoId, metaPath) → 확인된 태그 개수(0 이면 실패). 쓰기는 됐는데 읽기만 0개면 쓴 개수를 돌려주고 뒤에서 더 본다.
// 태그는 메타 "tags" 가 있으면 그것, 없으면 제목 해시태그 + 상품명 낱말 + 쇼핑 공통 태그로 만든다.
// ★videos.update 는 snippet 을 통째로 바꾼다 — 원래 값을 읽어 와서 tags 만 바꿔 돌려보낸다(참고: politics-hour/yt_tags.js).
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { OAuth2Client } = require(path.join(__dirname, '..', 'node_modules', 'google-auth-library'));
const pending = require('./yt_tags_pending');

const QUEUE = process.env.SHOP_TAGS_QUEUE || 'D:/volcano-runs/_upload/schedule_shopping.json';
const WAIT_LOG = process.env.SHOP_TAGS_WAIT_LOG || 'D:/volcano-runs/_upload/tags_wait.log';
const HANDOFF = process.env.YT_TAGS_HANDOFF_FILE || path.join(__dirname, '..', 'docs', 'handoff-manager-20261014.md');
// 태그는 내용 일치만(10/19 관리자 전달, 전 레인 공통) — 편마다 안 맞을 수 있는 «정리정돈»·«자취템», 내용과 무관한 «쇼츠»는 뺐다
const COMMON = ['살림템', '살림꿀팁', '생활꿀팁', '꿀템', '살림', '생활용품', '쿠팡추천템'];
const STOP = new Set(['세트', '개입', '대형', '소형', '중형', '1개', '2개', '3개', '4개', '5개', '다용도', '길이조절', '일반형', '기본형', '포함', '대용량', '단품', '본품', '리필']);

// 원고 본문(plan.json segments) — 태그는 원고에 나오는 낱말만(공용 tag_gate.py 내용 일치 ≥50%, 10/20 관리자 «tag_gate ❌»)
function scriptBody(meta) {
  try {
    const plan = JSON.parse(fs.readFileSync(path.join(path.dirname(meta.file), 'plan.json'), 'utf8'));
    return plan.segments.map((x) => String(x.text || '')).join(' ').replace(/\s+/g, '');
  } catch { return ''; }
}

function buildTags(meta) {
  const out = [];
  const add = (t) => { t = String(t).replace(/^#/, '').trim(); if (t.length >= 2 && !out.includes(t)) out.push(t); };
  // 검색 키워드 3개가 태그 맨 앞(10/20 소유주 «쇼핑 제목에는 검색 키워드» — shop_keyword_check 가 앞 3개를 본다)
  for (const k of Array.isArray(meta.keywords) ? meta.keywords : []) if (k && k.kw) add(k.kw);
  // 경쟁 영상 숨은 태그(shop_hidden_tags.js, 10-21 G23) — 키워드 바로 뒤, 아래에서 원고에 없는 낱말은 걸러진다
  for (const r of (meta.ref_tags && Array.isArray(meta.ref_tags.tags) ? meta.ref_tags.tags : [])) add(r.tag);
  const custom = Array.isArray(meta.tags) && meta.tags.length;
  if (custom) for (const t of meta.tags) add(t);
  else {
    for (const h of String(meta.title || '').match(/#[^\s#]+/g) || []) add(h);
    // 괄호 안은 옵션(«스펀지 일체형»·«수납 바구니 포함»)이라 상품 이름 끝 명사구를 가린다 — 빼고 본다
    const words = String(meta.product || '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/[()[\]\-·,/+]/g, ' ').split(/\s+/)
      .filter((w) => /[가-힣]/.test(w) && w.length >= 2 && !STOP.has(w) && !/^\d/.test(w));
    // 상품명 낱말을 하나씩 넣으면 «소변»·«있는»·«핑크» 같은 쓰레기 태그가 생긴다 — 끝 명사구만(마지막 1·2·3 낱말)
    const nouns = words.filter((w) => !STOP.has(w) && !/(할|는|은|한|된|포함|그레이|화이트|블랙|핑크)$/.test(w));
    if (nouns.length) add(nouns[nouns.length - 1]);
    if (nouns.length >= 2) add(nouns.slice(-2).join(' '));
    if (nouns.length >= 3) add(nouns.slice(-3).join(' '));
    for (const c of COMMON) add(c);
  }
  // 검색 키워드(앞 3개)는 그대로 두고, 나머지는 낱말마다 원고에 있어야 남긴다 — 원고를 못 읽으면 거르지 않는다
  const body = scriptBody(meta);
  const nk = (Array.isArray(meta.keywords) ? meta.keywords : []).filter((k) => k && k.kw).length;
  const inScript = (t) => t.split(/\s+/).every((w) => body.includes(w));
  const filtered = body ? out.filter((t, i) => i < nk || inScript(t)) : [...out];
  out.length = 0; out.push(...filtered);
  // 유튜브 태그 한도 500자(쉼표 포함) — 여유 있게 400자 안으로
  const kept = [];
  for (const t of out) { if ([...kept, t].join(',').length > 400) break; kept.push(t); }
  return kept;
}

async function headers(purpose = 'shopping') {
  const store = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'data', 'youtube_upload_profiles.json'), 'utf8'));
  const p = store.profiles.find((x) => x.purpose === purpose);
  if (!p) throw new Error(`업로드 프로필 없음: ${purpose}`);
  const c = new OAuth2Client(p.oauthClientId, p.oauthClientSecret, p.oauthRedirectUri);
  c.setCredentials({ refresh_token: p.refreshToken });
  return { Authorization: `Bearer ${(await c.getAccessToken()).token}`, 'Content-Type': 'application/json' };
}

async function getItem(H, videoId) {
  return (await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}`, { headers: H })).json()).items?.[0];
}

async function ensureTags(videoId, metaPath, { dryRun = false, H } = {}) {
  H = H || await headers();
  const item = await getItem(H, videoId);
  if (!item) { console.log(`  ✗ 태그: 영상 없음 ${videoId}`); return 0; }
  const s = item.snippet;
  const now = (s.tags || []).length;
  if (now > 0) { console.log(`  ✓ 태그 ${videoId} 이미 ${now}개`); return now; }
  const tags = buildTags(JSON.parse(fs.readFileSync(metaPath, 'utf8')));
  console.log(`  [tags] ${videoId} ${s.title.slice(0, 40)} — 0개 → ${tags.length}개: ${tags.join(', ')}`);
  if (dryRun) return 0;
  const snippet = { title: s.title, description: s.description, tags, categoryId: s.categoryId,
                    defaultLanguage: s.defaultLanguage, defaultAudioLanguage: s.defaultAudioLanguage };
  const j = await (await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet', { method: 'PUT', headers: H,
    body: JSON.stringify({ id: videoId, snippet }) })).json();
  if (j.error) { console.log(`  ✗ 태그 넣기 실패 ${videoId} ${JSON.stringify(j.error).slice(0, 200)}`); return 0; }
  // 바로 읽으면 옛 값이 온다(반영 지연) — 몇 번 다시 읽는다. 10/19 ffref16 은 30초 안에 안 보였다가 나중에 15개로 확인됐다(거짓 탈락) — 3분까지 기다린다
  for (let i = 0; i < 12; i++) {
    await new Promise((res) => setTimeout(res, i < 6 ? 5000 : 25000));
    const a = (await getItem(H, videoId)).snippet;
    const n = (a.tags || []).length;
    if (n > 0 && a.title === s.title && a.description === s.description) { console.log(`  ✓ 태그 ${videoId} 확인 ${n}개`); return n; }
  }
  // 쓰기는 됐는데 읽기만 0개면 전파 지연이다(10-31 연금 1편 약 30분) — 예약을 그대로 두고 fill 은 넘어간다. 공개 20분 전까지 안 보이면 그때 취소(scripts/yt_tags_pending.js)
  const a = (await getItem(H, videoId)).snippet;
  const st = await getStatus(H, videoId);
  const sameText = a.title === s.title && a.description === s.description;
  if (st && pending.isPropagating({ written: (j.snippet?.tags || []).length, expected: tags.length, read: (a.tags || []).length, before: now, sameText }) && pending.canWait(st)) {
    pending.add({ videoId, purpose: 'shopping', expected: tags.length, before: now, title: s.title, tool: 'shop_yt_tags' });
    if (pending.watcherAlive()) console.log(`  … 태그 ${videoId} 쓰기 ${tags.length}개·읽기 0개(전파 지연으로 봄) — 감시로 넘김, 예약 ${st.publishAt || '없음'} 유지`);
    else {
      const fd = fs.openSync(WAIT_LOG, 'a');
      spawn(process.execPath, [__filename, '--wait-propagation', videoId, metaPath, String(tags.length)], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true }).unref();
      console.log(`  … 태그 ${videoId} 쓰기 ${tags.length}개·읽기 0개(전파 지연으로 봄) — 백그라운드로 더 본다(${path.basename(WAIT_LOG)}), 예약 ${st.publishAt || '없음'} 유지`);
    }
    return tags.length;
  }
  console.log(`  ✗ 태그 ${videoId} 다시 읽어도 0개`);
  return 0;
}

async function getStatus(H, videoId) {
  return (await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=status&id=${videoId}`, { headers: H })).json()).items?.[0]?.status;
}

// 태그 관문에서 떨어진 편은 예약 공개를 거둔다(비공개로 남기고 보고) — 태그 0개로 공개하지 않는다. publishAt:null 까지 보내고 다시 읽어 확인한다
async function holdPrivate(videoId) {
  const c = await pending.cancelSchedule(videoId, await headers());
  if (!c.ok) console.log(`  ✗ 예약 취소 실패 ${videoId} ${c.why}`);
  return c.ok;
}

function reportLine(line) {
  const t = new Date(Date.now() + 9 * 3600e3).toISOString();
  fs.appendFileSync(HANDOFF, `- 쇼핑 태그 대기(${t.slice(5, 10)} ${t.slice(11, 16)}): ${line}
`, 'utf8');
}

// 전파 대기 끝에 예약을 거둔 편은 퍼뜨리지 않는다 — 네이버 예약 작업을 지우고 대기열에 막힘으로 적는다
function stopSpread(videoId, metaPath) {
  const name = `midform-shop-naver-${path.basename(path.dirname(JSON.parse(fs.readFileSync(metaPath, 'utf8')).file))}`;
  const del = spawnSync('schtasks', ['/Delete', '/TN', name, '/F'], { encoding: 'utf8' });
  const q = JSON.parse(fs.readFileSync(QUEUE, 'utf8'));
  const it = q.items.find((x) => x.videoId === videoId);
  if (it) { it.publishAt = ''; it.blocked = 'tags'; fs.writeFileSync(QUEUE, `${JSON.stringify(q, null, 2)}
`, 'utf8'); }
  return { naver: del.status === 0 ? '네이버 작업 지움' : '네이버 작업 못 지움', queue: it ? '대기열 막힘' : '대기열에 없음' };
}

// 관문이 띄우는 백그라운드: 2분마다 다시 읽고, 공개 20분 전(또는 47분)까지 0개면 예약을 거둔다
async function waitPropagation(videoId, metaPath, expected) {
  const st = await getStatus(await headers(), videoId);
  if (!st) { reportLine(`△ ${videoId} 상태를 못 읽어 대기 끝냄. 쇼핑 세션 확인.`); pending.remove(videoId); return 1; }
  const until = pending.waitUntil(st);
  console.log(`[wait] ${videoId} 시작 ${new Date().toISOString()} · ${new Date(until).toISOString()} 까지`);
  while (Date.now() < until) {
    await new Promise((res) => setTimeout(res, 120e3));
    try {
      const n = ((await getItem(await headers(), videoId))?.snippet?.tags || []).length;
      if (n > 0) {
        pending.remove(videoId);
        console.log(`[wait] ${videoId} 확인 ${n}/${expected}개`);
        reportLine(`${videoId} 태그 ${n}/${expected}개 확인(전파 지연 뒤), 예약 유지.`);
        return 0;
      }
    } catch (e) { console.log(`[wait] ${videoId} 읽기 실패 ${e.message}`); }   // 다시 시도하지 않고 다음 주기로 넘긴다
  }
  const c = await pending.cancelSchedule(videoId, await headers());
  pending.remove(videoId);
  if (!c.ok) { reportLine(`★사고 ${videoId} 태그 0개인데 예약 취소 실패: ${c.why}. 쇼핑 세션 확인.`); return 1; }
  const s = stopSpread(videoId, metaPath);
  reportLine(`★${videoId} 기다려도 태그 0개 → 예약 취소(비공개, 예약 ${c.was || '없음'} 삭제) · ${s.naver} · ${s.queue}. 쇼핑 세션 확인.`);
  return 2;
}

module.exports = { ensureTags, buildTags, holdPrivate, waitPropagation, headers };

if (require.main === module) {
  (async () => {
    const a = process.argv.slice(2);
    const dryRun = a.includes('--dry-run');
    if (a[0] === '--wait-propagation') process.exit(await waitPropagation(a[1], a[2], Number(a[3])));
    if (a[0] === '--list') {
      const purpose = a[a.indexOf('--purpose') + 1];
      if (!a.includes('--purpose') || !purpose) throw new Error('--list 는 --purpose <p> 가 필요하다');
      const days = Number(a[a.indexOf('--days') + 1]) || 7;
      const since = Date.now() - days * 864e5;
      const H = await headers(purpose);
      const ch = (await (await fetch('https://www.googleapis.com/youtube/v3/channels?part=contentDetails,snippet&mine=true', { headers: H })).json()).items?.[0];
      const up = ch.contentDetails.relatedPlaylists.uploads;
      const ids = [];
      let page = '';
      for (let k = 0; k < 4; k++) {
        const j = await (await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId=${up}${page ? `&pageToken=${page}` : ''}`, { headers: H })).json();
        for (const it of j.items || []) ids.push(it.contentDetails.videoId);
        if (!j.nextPageToken) break; page = j.nextPageToken;
      }
      let total = 0, zero = 0;
      for (let k = 0; k < ids.length; k += 50) {
        const j = await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,status&id=${ids.slice(k, k + 50).join(',')}`, { headers: H })).json();
        for (const v of j.items || []) {
          const when = Date.parse(v.status.publishAt || v.snippet.publishedAt);
          if (when < since) continue;
          total++;
          const n = (v.snippet.tags || []).length;
          if (!n) { zero++; console.log(`  0개 ${v.id} ${v.status.privacyStatus}${v.status.publishAt ? ` 예약 ${v.status.publishAt}` : ''} ${v.snippet.title.slice(0, 50)}`); }
        }
      }
      console.log(`[${purpose}] ${ch.snippet.title} 최근 ${days}일 ${total}편 · 태그 0개 ${zero}편`);
      process.exit(zero ? 4 : 0);
    }
    if (a[0] === '--audit') {
      const days = Number(a[a.indexOf('--days') + 1]) || 7;
      const since = Date.now() - days * 864e5;
      const q = JSON.parse(fs.readFileSync(QUEUE, 'utf8'));
      const H = await headers();
      let total = 0, zero = 0, fixed = 0;
      for (const i of q.items.filter((x) => x.videoId && new Date(x.publishAt).getTime() >= since)) {
        total++;
        const it = await getItem(H, i.videoId);
        if (it && (it.snippet.tags || []).length) { console.log(`  ✓ ${i.videoId} ${path.basename(i.meta)} ${it.snippet.tags.length}개`); continue; }
        zero++;
        if (await ensureTags(i.videoId, i.meta, { dryRun, H })) fixed++;
      }
      console.log(`점검 ${total}편 · 0개였던 편 ${zero} · 넣고 확인 ${fixed}${dryRun ? ' (dry-run)' : ''}`);
      process.exit(zero > fixed && !dryRun ? 1 : 0);
    }
    const [videoId, metaPath] = a.filter((x) => !x.startsWith('--'));
    if (!videoId || !metaPath) throw new Error('usage: node scripts/shop_yt_tags.js <videoId> <meta.json> [--dry-run] | --audit [--days 7]');
    process.exit((await ensureTags(videoId, metaPath, { dryRun })) || dryRun ? 0 : 1);
  })().catch((e) => { console.error('[tags]', e.message); process.exit(1); });
}
