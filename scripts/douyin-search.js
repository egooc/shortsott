// 더우인 키워드 검색 → 후보 영상 대장. 받기는 douyin-grab.js 가 한다.
//
//   node scripts/douyin-search.js --keyword 风扇清洁刷 [--pages 2] [--sort likes|latest|best] [--max-dur 90] [--out cand.json]
//   node scripts/douyin-search.js --demo          키 없이 TikHub 무료 데모(검색어 "美食" 고정)로 파서만 시험
//
// 왜 TikHub 인가
//   더우인 웹 검색은 비로그인에 캡차, 브라우저 안에서 검색 API 를 불러도 200·본문 0바이트다(로그인 요구).
//   TikHub 유료 API 는 요청당 $0.001~0.01 로 검색 결과를 준다. 결과의 재생 주소는 앱 화질(540p HEVC)이라
//   여기서는 aweme_id·지표만 쓰고, 1080p H.264 는 douyin-grab.js(실제 크롬)로 받는다.
//
// 키: 환경변수 TIKHUB_API_KEY 또는 ~/.volcano/keys/tikhub (볼케이노와 같은 자리)
// 한 번 실행에 부르는 유료 요청 수 = --pages. 끝에 몇 번 불렀는지 찍는다.
const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const DEMO = argv.includes('--demo');
const KEYWORD = opt('--keyword', null);
const PAGES = Math.max(1, parseInt(opt('--pages', '1'), 10));
const SORT = { best: '0', likes: '1', latest: '2' }[opt('--sort', 'likes')] || '1';
const MAX_DUR = parseFloat(opt('--max-dur', '120'));
const OUT = opt('--out', null);
const ENDPOINT = opt('--endpoint', 'fetch_video_search_v2');
const BASE = 'https://api.tikhub.io';

function readKey() {
  if (process.env.TIKHUB_API_KEY) return process.env.TIKHUB_API_KEY.trim();
  const f = path.join(os.homedir(), '.volcano', 'keys', 'tikhub');
  if (!fs.existsSync(f)) return null;
  const raw = fs.readFileSync(f);
  const txt = (raw[0] === 0xff && raw[1] === 0xfe) ? raw.toString('utf16le') : raw.toString('utf8');
  return txt.replace(/^﻿/, '').trim();
}

// 응답 모양이 엔드포인트마다 달라서, aweme_id 와 video 를 가진 객체를 전부 줍는다.
function collectAwemes(x, out = [], depth = 0) {
  if (depth > 8 || !x || typeof x !== 'object') return out;
  if (Array.isArray(x)) { for (const v of x) collectAwemes(v, out, depth + 1); return out; }
  if (x.aweme_id && x.video && x.author) { out.push(x); return out; }
  for (const v of Object.values(x)) collectAwemes(v, out, depth + 1);
  return out;
}

function toCandidate(a) {
  const v = a.video || {};
  const durMs = a.duration || v.duration || 0;
  const st = a.statistics || {};
  return {
    aweme_id: String(a.aweme_id),
    url: `https://www.douyin.com/video/${a.aweme_id}`,
    desc: (a.desc || '').replace(/\s+/g, ' ').trim(),
    author: a.author && a.author.nickname,
    likes: st.digg_count || 0, comments: st.comment_count || 0, shares: st.share_count || 0,
    duration_s: Math.round(durMs / 100) / 10,
    create_time: a.create_time ? new Date(a.create_time * 1000).toISOString().slice(0, 10) : null,
    is_image_post: !!(a.images && a.images.length),
    has_shop_link: !!(a.anchor_info || (a.commerce_info && a.commerce_info.head_image_list) || a.product_info),
  };
}

async function call(pathname, { method = 'GET', body = null, key = null } = {}) {
  const r = await fetch(BASE + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch (_) { /* 아래에서 처리 */ }
  if (!r.ok || !j || (j.code && j.code !== 200)) {
    // 오류 응답에 요청 헤더(키 포함)가 딸려 오므로 메시지만 꺼낸다
    const body = j && j.detail && typeof j.detail === 'object' ? j.detail : j;
    const msg = body ? (typeof body.message === 'string' ? body.message : (typeof body.detail === 'string' ? body.detail : `code ${body.code}`)) : text.slice(0, 200);
    const e = new Error(`TikHub ${r.status}: ${msg}`); e.status = r.status; throw e;
  }
  return j;
}

(async () => {
  let paid = 0;
  const all = [];
  if (DEMO) {
    const j = await call('/api/v1/demo/douyin_search/app/general_search');
    all.push(...collectAwemes(j));
  } else {
    if (!KEYWORD) { console.error('--keyword 가 필요하다 (또는 --demo)'); process.exit(2); }
    const key = readKey();
    if (!key) { console.error('TikHub 키가 없다 — ~/.volcano/keys/tikhub 에 넣거나 TIKHUB_API_KEY 를 설정하라'); process.exit(2); }
    let cursor = 0, searchId = '', backtrace = '';
    for (let p = 0; p < PAGES; p++) {
      const j = await call(`/api/v1/douyin/search/${ENDPOINT}`, {
        method: 'POST', key,
        body: { keyword: KEYWORD, cursor, sort_type: SORT, publish_time: '0', filter_duration: '0', content_type: '1', search_id: searchId, backtrace },
      });
      paid++;
      all.push(...collectAwemes(j));
      const d = j.data || {};
      const inner = d.data && !Array.isArray(d.data) ? d.data : d;
      if (!inner.has_more) break;
      cursor = inner.cursor || 0;
      searchId = (inner.log_pb && inner.log_pb.impr_id) || inner.search_id || searchId;
      backtrace = inner.backtrace || '';
    }
  }
  const seen = new Set();
  const cands = all.map(toCandidate)
    .filter((c) => !seen.has(c.aweme_id) && seen.add(c.aweme_id))
    .filter((c) => !c.is_image_post && c.duration_s > 0 && c.duration_s <= MAX_DUR)
    .sort((a, b) => b.likes - a.likes);
  const out = { keyword: DEMO ? '美食(demo)' : KEYWORD, searched_at: new Date().toISOString(), paid_requests: paid, count: cands.length, candidates: cands };
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
  for (const c of cands) console.log(`${c.aweme_id}  ♥${String(c.likes).padStart(7)}  ${String(c.duration_s).padStart(5)}s  ${c.has_shop_link ? '🛒' : '  '} ${(c.author || '').slice(0, 10).padEnd(10)}  ${c.desc.slice(0, 40)}`);
  console.log(`\n후보 ${cands.length}편 · 유료 요청 ${paid}회${OUT ? ' · ' + OUT : ''}`);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
