// 댓글 광산 — 영상 댓글에서 실제 댓글 유형·반복 낱말·다음 소재를 캔다(큰제로 Z4·Z5, 10-20 관리자 명세).
//
//   node scripts/comment_mine.js <videoId|URL> [--lane X] [--no-gpt]            한 편
//   node scripts/comment_mine.js --ours [--days 30] [--per 8] [--no-gpt]       우리 채널 공개 편(최근 30일, 채널마다 댓글 많은 순 --per 편)
//   node scripts/comment_mine.js --refs [--per 5]                               레퍼런스: yt_news_outliers 아웃라이어 상위
//   node scripts/comment_mine.js --vs <잘된 videoId> <우리 videoId>             부검(Z5): 빠진 한 끗 1~3
//
// 댓글: 발굴용 키(.env YOUTUBE_API_KEY_SEARCH) commentThreads.list — 편당 인기순 50 + 최신순 50(2단위). 업로드 프로젝트 토큰 안 씀.
//       하루 상한 300단위(server/data/comment_mine/_quota.json), 넘으면 남은 편은 건너뛴다. 403/429 = 그날 중지·gate_errors.jsonl.
// 분류: GPT(gpt-ask) 편당 1회 — 댓글마다 정정·경험담·훈수·공감·논쟁·기타, 유형별 대표 댓글+좋아요, 다음 소재 후보 3(근거 댓글·좋아요).
//       반복 낱말은 로컬 집계. 쇼츠 레인은 제작 장부(production_ledger.jsonl) → spec/plan 의 expected_comment.type 과 실제 최다 유형을 대조.
// 출력: server/data/comment_mine/<channel>_<YYYYMMDD>.json · 레인별 «댓글 광산 요약» <lane>_<YYYYMMDD>.md
// ★쓸모연구소는 항상 논외(소유주) — 채널 목록에서 뺀다.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'server', 'data', 'comment_mine');
const LEDGER = path.join(ROOT, 'server', 'data', 'gate_errors.jsonl');
const PROD = path.join(ROOT, 'server', 'data', 'production_ledger.jsonl');
const RUNS = 'D:/volcano-runs';
const TYPES = ['정정', '경험담', '훈수', '공감', '논쟁', '위험성 경고'];   // comment_hook TYPES 와 같게(10-21 G19)
const DAY_CAP = 300;
// 우리 채널(youtube_upload_profiles 의 channelId) — purpose → 레인 이름. 쓸모연구소(shopping) 제외.
const OURS = [
  { key: 'politics_ko', name: '쟁점브리핑', id: 'UCocFufLJQ89oAOB2HQ5wR-Q' },
  { key: 'ko_longshort', name: '지구관측소', id: 'UCbOp4wMmedc1_7vkrvYH_mQ' },
  { key: 'fantube', name: '최애모먼트', id: 'UCULWm8j51Q0PtY_K7v3WeIA' },
  { key: 'ja', name: '沼落ちシネマ', id: 'UCdIp0WlNZzoNHrq5zz7mAWQ' },
  { key: 'politics_ja', name: '国会ノート', id: 'UC7onzpvgaBGPr_LxWlzuBKA' },
];
const stampDay = () => new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 10).replace(/-/g, '');

class Stop extends Error {}
class Cap extends Error {}

function apiKey() {
  const env = (() => { try { return fs.readFileSync(path.join(ROOT, '.env'), 'utf8'); } catch { return ''; } })();
  const line = env.split(/\r?\n/).find((l) => l.startsWith('YOUTUBE_API_KEY_SEARCH='));
  return line ? line.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '') : null;
}

function quota(add = 0) {
  const f = path.join(OUT, '_quota.json');
  const d = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  const k = stampDay();
  if (add) {
    if ((d[k] || 0) + add > DAY_CAP) throw new Cap(`하루 상한 ${DAY_CAP}단위`);
    d[k] = (d[k] || 0) + add;
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(f, JSON.stringify(d, null, 2) + '\n', 'utf8');
  }
  return d[k] || 0;
}

const vid = (s) => (String(s).match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/) || [null, s])[1];

const apiQuota = require('./api_quota');   // 발굴 키 공용 쿼터 장부(10-20) — 도구 자체 300 상한과 함께

async function yt(key, endpoint, params) {
  try { apiQuota.spend('comment_mine', endpoint); } catch (e) { if (e instanceof apiQuota.QuotaStop) throw new Stop(e.message); throw e; }
  quota(1);
  const r = await fetch(`https://www.googleapis.com/youtube/v3/${endpoint}?${new URLSearchParams({ ...params, key })}`);
  const j = await r.json().catch(() => ({}));
  if (r.status === 403 && /commentsDisabled/.test(JSON.stringify(j))) { const e = new Error('댓글 꺼진 영상'); e.soft = true; throw e; }
  if (r.status === 403 || r.status === 429) { apiQuota.markBlocked('comment_mine', `${endpoint} ${r.status}`); throw new Stop(`${endpoint} ${r.status} — 발굴용 키 한도·권한, 오늘은 멈춤`); }
  if (!r.ok) throw new Error(`${endpoint} ${r.status}`);
  return j;
}

async function videoMeta(key, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const j = await yt(key, 'videos', { part: 'snippet,statistics,contentDetails,status', id: ids.slice(i, i + 50).join(',') });
    for (const v of j.items || []) {
      out.push({ id: v.id, title: v.snippet.title, channel: v.snippet.channelTitle, published: v.snippet.publishedAt, privacy: v.status.privacyStatus,
        views: +v.statistics.viewCount || 0, likes: +v.statistics.likeCount || 0, comments: +v.statistics.commentCount || 0 });
    }
  }
  return out;
}

async function fetchComments(key, id) {
  const take = async (order) => {
    const j = await yt(key, 'commentThreads', { part: 'snippet', videoId: id, order, maxResults: 50, textFormat: 'plainText' });
    return (j.items || []).map((it) => {
      const s = it.snippet.topLevelComment.snippet;
      return { id: it.id, text: s.textDisplay.replace(/\s+/g, ' ').trim(), likes: s.likeCount || 0, replies: it.snippet.totalReplyCount || 0, at: s.publishedAt, order };
    });
  };
  const top = await take('relevance');
  const seen = new Set(top.map((c) => c.id));
  return [...top, ...(await take('time')).filter((c) => !seen.has(c.id))];
}

function gpt(prompt, tag) {
  fs.mkdirSync(OUT, { recursive: true });
  const f = path.join(OUT, `_prompt_${tag}.md`);
  fs.writeFileSync(f, prompt, 'utf8');
  try {
    const out = execFileSync('node', [path.join(ROOT, 'scripts', 'gpt-ask.js'), '--no-search', '--session', '도구개발 comment_mine', '--file', f],
      { encoding: 'utf8', timeout: 20 * 60 * 1000 });
    const m = out.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('GPT 답에 JSON 없음');
    return JSON.parse(m[0]);
  } finally { fs.rmSync(f, { force: true }); }
}

const list = (cs, k = 100) => cs.slice(0, k).map((c, i) => `${i + 1}. [좋아요 ${c.likes}${c.order === 'time' ? ' · 최신' : ''}] ${c.text.slice(0, 300)}`).join('\n');

function repeatedWords(cs, n = 10) {
  const stop = new Set(['진짜', '너무', '그냥', '정말', '이거', '저거', '그거', '근데', '하는', '있는', '없는', '같은', '이런', '그런', '영상', 'ㅋㅋ', 'ㅋㅋㅋ', 'ㅠㅠ']);
  const cnt = new Map();
  for (const c of cs) {
    const toks = c.text.match(/[가-힣]{2,}|[一-龯々ァ-ヶー]{2,}|[A-Za-z]{3,}/g) || [];
    for (const t of new Set(toks.map((x) => x.replace(/(은|는|이|가|을|를|에|의|도|로|과|와|요|다)$/, '')))) {
      if (t.length >= 2 && !stop.has(t)) cnt.set(t, (cnt.get(t) || 0) + 1);
    }
  }
  return [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w, c]) => `${w}(${c})`);
}

// 제작 장부 → 이 영상의 expected_comment.type (쇼츠 레인)
function expectedFor(youtubeId) {
  if (!fs.existsSync(PROD)) return null;
  const row = fs.readFileSync(PROD, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.youtube_id === youtubeId).pop();
  if (!row) return null;
  const cands = {
    fantube: [`${RUNS}/fantube/${row.id}/spec.json`],
    ja: [`${RUNS}/rinbox${row.id}/plan_local.json`, `${RUNS}/${row.id}/plan_local.json`],
    ko: [`${RUNS}/rinbox${row.id}/plan_local.json`],
    ko_longshort: [`${RUNS}/${row.id}/plan.json`],
  }[row.lane] || [];
  for (const f of cands) {
    try { const ec = JSON.parse(fs.readFileSync(f, 'utf8')).expected_comment; if (ec) return typeof ec === 'object' ? String(ec.type || '') : `메모: ${ec}`; } catch { /* 다음 후보 */ }
  }
  return null;
}

async function mineVideo(key, meta, lane, noGpt) {
  const cs = meta.comments ? await fetchComments(key, meta.id) : [];
  const res = { ...meta, lane, mined: cs.length, repeated: repeatedWords(cs), expected: expectedFor(meta.id), analysis: null };
  if (!noGpt && cs.length >= 3) {
    res.analysis = gpt(`유튜브 영상 «${meta.title}»(${meta.channel}, 조회 ${meta.views.toLocaleString()}) 댓글 ${cs.length}개(인기순 50 + «최신» 표시 최신순).
댓글만 근거로 JSON 하나만 답하라(설명 금지).
{"counts": {"정정": 0, "경험담": 0, "훈수": 0, "공감": 0, "논쟁": 0, "기타": 0},
 "examples": {"정정": [{"comment": "원문 일부", "likes": 0}], "경험담": [...], "훈수": [...], "공감": [...], "논쟁": [...]},   // 유형별 좋아요 많은 순 최대 2
 "next_topics": [{"topic": "...", "why": "...", "evidence": [{"comment": "...", "likes": 0}]}]}                      // 3개, 근거 없으면 빼라
유형: 정정=틀렸다·사실은 / 경험담=내 경우는 / 훈수=이렇게 해야지 / 공감=맞다·웃기다·감동 / 논쟁=편 가르기·찬반 / 기타=인사·도배·광고.

${list(cs)}`, meta.id);
    const c = res.analysis.counts || {};
    res.top_type = TYPES.reduce((a, b) => ((c[b] || 0) > (c[a] || 0) ? b : a), TYPES[0]);
    if (res.expected) res.expected_match = res.expected.split(/[/·]/).map((s) => s.trim()).includes(res.top_type);
  }
  res.comments_sample = cs.slice(0, 20);
  return res;
}

async function uploads(key, chId, days) {
  const since = Date.now() - days * 864e5;
  const ids = [];
  let page = '';
  for (let n = 0; n < 4; n++) {
    const j = await yt(key, 'playlistItems', { part: 'contentDetails', playlistId: 'UU' + chId.slice(2), maxResults: 50, ...(page ? { pageToken: page } : {}) });
    const items = j.items || [];
    ids.push(...items.filter((x) => Date.parse(x.contentDetails.videoPublishedAt || 0) >= since).map((x) => x.contentDetails.videoId));
    if (!j.nextPageToken || items.some((x) => Date.parse(x.contentDetails.videoPublishedAt || 0) < since)) break;
    page = j.nextPageToken;
  }
  return ids;
}

function summaryMd(lane, vids) {
  const tot = Object.fromEntries([...TYPES, '기타'].map((t) => [t, 0]));
  for (const v of vids) for (const [k, n] of Object.entries(v.analysis?.counts || {})) tot[k] = (tot[k] || 0) + n;
  const top = TYPES.slice().sort((a, b) => tot[b] - tot[a]);
  const words = repeatedWords(vids.flatMap((v) => v.comments_sample || []), 12);
  const topics = vids.flatMap((v) => (v.analysis?.next_topics || []).map((t) => ({ ...t, from: v.title, likes: Math.max(0, ...(t.evidence || []).map((e) => +e.likes || 0)) })))
    .sort((a, b) => b.likes - a.likes).slice(0, 3);
  const L = [`# 댓글 광산 요약 — ${lane} (${stampDay()})`, '',
    `- 편 ${vids.length} · 모은 댓글 ${vids.reduce((s, v) => s + v.mined, 0)} · 가장 많이 달린 유형: ${top.slice(0, 3).map((t) => `${t} ${tot[t]}`).join(' · ')} (기타 ${tot['기타']})`,
    `- 반복 낱말: ${words.join(' · ') || '-'}`, '', '## 다음 소재 후보 3',
    ...topics.map((t, i) => `${i + 1}. ${t.topic} — ${t.why || ''} (근거 ${(t.evidence || []).map((e) => `«${String(e.comment).slice(0, 40)}» ♥${e.likes}`).join(' · ')}, 출처 «${t.from.slice(0, 30)}»)`),
    '', '## 편별', '| 편 | 조회 | 댓글 | 최다 유형 | 예상(expected_comment) | 일치 | 반복 낱말 |', '|---|---|---|---|---|---|---|',
    ...vids.map((v) => `| ${v.title.slice(0, 28)} | ${v.views.toLocaleString()} | ${v.mined}/${v.comments} | ${v.top_type || '-'} | ${v.expected || '-'} | ${v.expected_match == null ? '-' : v.expected_match ? 'O' : 'X'} | ${v.repeated.slice(0, 4).join(' ')} |`), ''];
  return L.join('\n');
}

async function runGroup(key, groups, opts) {
  const done = [];
  for (const g of groups) {
    const metas = (await videoMeta(key, g.ids)).filter((m) => m.privacy === 'public').sort((a, b) => b.comments - a.comments).slice(0, opts.per);
    const vids = [];
    for (const m of metas) {
      try { vids.push(await mineVideo(key, m, g.key, opts.noGpt)); } catch (e) {
        if (e instanceof Stop || e instanceof Cap) { console.log(`  ⚠ ${e.message} — ${g.name} 남은 편 건너뜀`); g.stopped = e.message; break; }
        vids.push({ ...m, lane: g.key, mined: 0, repeated: [], error: e.message });
      }
      console.log(`  ${g.name} «${m.title.slice(0, 30)}» 댓글 ${vids[vids.length - 1].mined} · ${vids[vids.length - 1].top_type || '-'} · 쿼터 오늘 ${quota()}`);
    }
    const res = { at: new Date().toISOString(), lane: g.key, channel: g.name, videos: vids, stopped: g.stopped || null, quota_today: quota() };
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `${g.key}_${stampDay()}.json`), JSON.stringify(res, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(OUT, `${g.key}_${stampDay()}.md`), summaryMd(`${g.key} · ${g.name}`, vids), 'utf8');
    done.push(res);
    if (g.stopped) break;
  }
  return done;
}

async function vs(key, a, b, noGpt) {
  const [A, B] = await videoMeta(key, [a, b]).then((ms) => [ms.find((m) => m.id === a), ms.find((m) => m.id === b)]);
  const ca = await fetchComments(key, a);
  const cb = B.comments ? await fetchComments(key, b) : [];
  const res = { at: new Date().toISOString(), a: A, b: B, analysis: null };
  if (!noGpt) {
    res.analysis = gpt(`부검: 같은 소재인데 A 조회 ${A.views.toLocaleString()}, B 조회 ${B.views.toLocaleString()}. 두 영상 댓글만 근거로 B 에 빠진 «한 끗» 1~3가지를 단정하라(B 댓글이 적거나 0인 것도 단서). JSON 하나만:
{"missing": [{"point": "...", "evidence_a": [{"comment": "...", "likes": 0}], "evidence_b": [{"comment": "...", "likes": 0}]}], "fix": ["다음 편에서 바꿀 것 한 줄"]}

A «${A.title}» (${A.channel})
${list(ca, 60)}

B «${B.title}» (${B.channel})
${list(cb, 60) || '(댓글 0)'}`, `vs_${a}_${b}`);
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `vs_${a}_${b}.json`), JSON.stringify(res, null, 2) + '\n', 'utf8');
  return res;
}

module.exports = { fetchComments, mineVideo, repeatedWords, expectedFor, TYPES };

if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
    const noGpt = argv.includes('--no-gpt');
    const key = apiKey();
    const loud = (msg, code) => {
      console.log(`⚠ 댓글 광산 중단: ${msg}`);
      fs.appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), gate: 'comment_mine', error: msg }) + '\n', 'utf8');
      process.exit(code);
    };
    if (!key) loud('.env 에 YOUTUBE_API_KEY_SEARCH 없음', 5);
    try {
      if (argv.includes('--vs')) {
        const i = argv.indexOf('--vs');
        const r = await vs(key, vid(argv[i + 1]), vid(argv[i + 2]), noGpt);
        console.log(`부검 ${(r.analysis?.missing || []).length}가지 · 쿼터 오늘 ${quota()}단위`);
      } else if (argv.includes('--ours')) {
        const days = +opt('--days', 30);
        const groups = [];
        for (const c of OURS) groups.push({ ...c, ids: await uploads(key, c.id, days) });
        await runGroup(key, groups, { per: +opt('--per', 8), noGpt });
        console.log(`우리 채널 ${groups.length}곳 · 쿼터 오늘 ${quota()}단위 → server/data/comment_mine/<lane>_${stampDay()}.{json,md}`);
      } else if (argv.includes('--refs')) {
        const groups = [];
        for (const lane of ['politics_ko', 'politics_ja']) {
          const f = path.join(ROOT, 'server', 'data', 'news_outliers', `${lane}_latest.json`);
          if (fs.existsSync(f)) groups.push({ key: `ref_${lane}`, name: `${lane} 뉴스 아웃라이어`, ids: JSON.parse(fs.readFileSync(f, 'utf8')).outliers.map((o) => o.video_id) });
        }
        await runGroup(key, groups, { per: +opt('--per', 5), noGpt });
        console.log(`레퍼런스 ${groups.length}묶음 · 쿼터 오늘 ${quota()}단위`);
      } else {
        const id = vid(argv.find((a, j) => !a.startsWith('--') && argv[j - 1] !== '--lane'));
        if (!id) { console.log('usage: <videoId|URL> [--lane X] | --ours [--days 30] [--per 8] | --refs [--per 5] | --vs A B   [--no-gpt]'); process.exit(2); }
        const [m] = await videoMeta(key, [id]);
        const r = await mineVideo(key, m, opt('--lane', null), noGpt);
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify(r, null, 2) + '\n', 'utf8');
        console.log(`«${m.title}» 댓글 ${r.mined} · 최다 ${r.top_type || '-'} · 반복 ${r.repeated.slice(0, 5).join(' ')} · 쿼터 오늘 ${quota()}단위`);
      }
    } catch (e) {
      loud(e.message, e instanceof Stop ? 9 : e.soft ? 4 : 5);
    }
  })();
}
