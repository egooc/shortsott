// 댓글 광산 — 영상 댓글에서 실제 댓글 유형·반복 낱말·다음 소재를 캔다(큰제로 Z4·Z5, 10-20 관리자 명세).
//
//   node scripts/comment_mine.js <videoId|URL> [--lane X] [--no-gpt]            한 편
//   node scripts/comment_mine.js --ours [--days 30] [--per 8] [--no-gpt]       우리 채널 공개 편(최근 30일, 채널마다 댓글 많은 순 --per 편)
//   node scripts/comment_mine.js --refs [--per 5]                               레퍼런스: yt_news_outliers 아웃라이어 상위
//   node scripts/comment_mine.js --vs <잘된 videoId> <우리 videoId>             부검(Z5): 빠진 한 끗 1~3
//   node scripts/comment_mine.js --channel-types <key> [--days 60] [--max 25] [--subs] [--force]
//                                                          채널 고유 반응 유형 5~8(10-23) → server/data/comment_types/<key>, 주 1회
//        key: ko_event(야생일지)·ko_robot(로보토리)·ko_mon2_old(무쓸모)·ko_longshort(지구관측소)·dogu(도구의쓸모)·ja(沼落ち)
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

const isoSec = (s) => { const m = String(s || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/); return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0; };
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
      out.push({ id: v.id, title: v.snippet.title, channel: v.snippet.channelTitle, channelId: v.snippet.channelId, published: v.snippet.publishedAt, privacy: v.status.privacyStatus,
        views: +v.statistics.viewCount || 0, likes: +v.statistics.likeCount || 0, comments: +v.statistics.commentCount || 0, dur: isoSec(v.contentDetails && v.contentDetails.duration) });
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

const list = (cs, k = 100) => cs.slice(0, k).map((c, i) => `${i + 1}. [좋아요 ${c.likes} · 답글 ${c.replies || 0}${c.order === 'time' ? ' · 최신' : ''}] ${c.text.slice(0, 300)}`).join('\n');

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
{"counts": {"정정": 0, "경험담": 0, "훈수": 0, "공감": 0, "논쟁": 0, "위험성 경고": 0, "기타": 0},
 "examples": {"정정": [{"comment": "원문 일부", "likes": 0}], "경험담": [...], "훈수": [...], "공감": [...], "논쟁": [...], "위험성 경고": [...]},   // 유형별 좋아요 많은 순 최대 2
 "emotion": {"dominant": "웃음|감동|분노|궁금|불안|부러움 중 하나", "line": "댓글 전체를 지배하는 감정 한 줄(근거 댓글 요지 포함)"},
 "combo": [{"elements": ["요소 A", "요소 B"], "why": "댓글이 두 요소를 같이 원한다는 근거", "evidence": [{"comment": "...", "likes": 0}]}],   // 결합 요소 후보 1~3: 다음 편에서 붙이면 터질 두 요소(인물×상황·소재×형식)
 "next_topics": [{"topic": "...", "why": "...", "evidence": [{"comment": "...", "likes": 0}]}]}                      // 3개, 근거 없으면 빼라
유형: 정정=틀렸다·사실은 / 경험담=내 경우는 / 훈수=이렇게 해야지 / 공감=맞다·웃기다·감동 / 논쟁=편 가르기·찬반 / 위험성 경고=따라 하면 큰일·위험하다 / 기타=인사·도배·광고.
좋아요·답글 수가 큰 댓글일수록 무게를 둬라.

${list(cs)}`, meta.id);
    const c = res.analysis.counts || {};
    res.top_type = TYPES.reduce((a, b) => ((c[b] || 0) > (c[a] || 0) ? b : a), TYPES[0]);
    if (res.expected) res.expected_match = res.expected.split(/[/·]/).map((s) => s.trim()).includes(res.top_type);
  }
  res.comments_sample = cs.slice(0, 20);
  // G6(10-21): 좋아요·답글 상위(로컬 집계, GPT 없이도 남는다)
  res.top_liked = cs.slice().sort((a, b) => b.likes - a.likes).slice(0, 3).map((c) => ({ text: c.text.slice(0, 80), likes: c.likes, replies: c.replies }));
  res.top_replied = cs.slice().sort((a, b) => (b.replies || 0) - (a.replies || 0)).slice(0, 3).filter((c) => c.replies).map((c) => ({ text: c.text.slice(0, 80), likes: c.likes, replies: c.replies }));
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
    `- 반복 낱말: ${words.join(' · ') || '-'}`,
    `- 지배 감정: ${Object.entries(vids.reduce((m, v) => { const d = v.analysis?.emotion?.dominant; if (d) m[d] = (m[d] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}편`).join(' · ') || '-'}`,
    '', '## 결합 요소 후보',
    ...vids.flatMap((v) => (v.analysis?.combo || []).map((c) => ({ ...c, from: v.title, likes: Math.max(0, ...(c.evidence || []).map((e) => +e.likes || 0)) })))
      .sort((a, b) => b.likes - a.likes).slice(0, 3)
      .map((c, i) => `${i + 1}. ${(c.elements || []).join(' × ')} — ${c.why || ''} (근거 ${(c.evidence || []).map((e) => `«${String(e.comment).slice(0, 40)}» ♥${e.likes}`).join(' · ')}, 출처 «${c.from.slice(0, 30)}»)`),
    '', '## 다음 소재 후보 3',
    ...topics.map((t, i) => `${i + 1}. ${t.topic} — ${t.why || ''} (근거 ${(t.evidence || []).map((e) => `«${String(e.comment).slice(0, 40)}» ♥${e.likes}`).join(' · ')}, 출처 «${t.from.slice(0, 30)}»)`),
    '', '## 편별', '| 편 | 조회 | 좋아요 | 댓글 | 최다 유형 | 지배 감정 | 예상(expected_comment) | 일치 | 좋아요 1위 댓글 | 답글 1위 댓글 | 반복 낱말 |', '|---|---|---|---|---|---|---|---|---|---|---|',
    ...vids.map((v) => `| ${v.title.slice(0, 28)} | ${v.views.toLocaleString()} | ${(v.likes || 0).toLocaleString()} | ${v.mined}/${v.comments} | ${v.top_type || '-'} | ${v.analysis?.emotion?.dominant || '-'} | ${v.expected || '-'} | ${v.expected_match == null ? '-' : v.expected_match ? 'O' : 'X'} | ${v.top_liked?.[0] ? `«${v.top_liked[0].text.slice(0, 24).replace(/\|/g, '/')}» ♥${v.top_liked[0].likes}` : '-'} | ${v.top_replied?.[0] ? `«${v.top_replied[0].text.slice(0, 24).replace(/\|/g, '/')}» 답${v.top_replied[0].replies}` : '-'} | ${v.repeated.slice(0, 4).join(' ')} |`), ''];
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

// ── 채널별 반응 유형(10-23 소유주 «같은 결로 올리면 비슷한 댓글이 반복된다 → 그 반응을 더 끌어내는 원고», 관리자 배정) ──
// 일반 6종(정정·경험담…)은 «한국 있었으면 잡아먹혔다·상대도 안 된다·귀엽다» 같은 채널 고유 결을 못 잡는다.
// 입력 = 채널 최근 공개 편 전체(댓글 많은 순 --max) 댓글 인기 50+최신 50. GPT 1회 = 유형 5~8개 이름·설명 + 댓글마다 유형 번호.
// 비율·대표 댓글(원문·좋아요)은 로컬 집계라 지어낼 수 없다. 부른 순간(편 id+초)은 자막(--subs, 09~12시 KST 에만 받음)이나
// 댓글 속 타임스탬프에 근거할 때만 초를 남기고, 근거 없는 초는 null(장면 묘사만).
// 출력 server/data/comment_types/<key>.{json,md} — comment_hook --channel <key> 가 읽는다. 주 1회: 6일 안 표가 있으면 --force 없이는 건너뜀.
const TYPES_OUT = path.join(ROOT, 'server', 'data', 'comment_types');
const CHANNELS = {   // 관리자 순서(10-23). ledger = 제작 장부 레인(그 youtube_id 로 채널 id 를 찾는다), id = 고정 채널 id
  ko_event: { name: '야생일지', ledger: 'n100_ko_event', lang: 'ko' },
  ko_robot: { name: '로보토리', ledger: 'n100_ko_robot', lang: 'ko' },
  ko_mon2_old: { name: '무쓸모', ledger: 'n100_ko_mon2_old', lang: 'ko' },
  ko_longshort: { name: '지구관측소', id: 'UCbOp4wMmedc1_7vkrvYH_mQ', lang: 'ko' },
  dogu: { name: '도구의쓸모', id: 'UCxI-BIzq8mH0Wfe99c24YEg', lang: 'ko' },
  ja: { name: '沼落ちシネマ', id: 'UCdIp0WlNZzoNHrq5zz7mAWQ', lang: 'ja' },
};
const PER_VIDEO = 40;   // GPT 에 보내는 편당 댓글(좋아요 순 + 타임스탬프 든 댓글)

const TS_RE = /(?:^|[^\d:])(\d{1,2}):([0-5]\d)(?![\d:])/g;
const commentTs = (text) => [...String(text).matchAll(TS_RE)].map((m) => +m[1] * 60 + +m[2]);
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function parseVtt(text) {
  const out = [];
  let t = null;
  for (const ln of String(text).split(/\r?\n/)) {
    const m = ln.match(/^(\d+):(\d{2}):(\d{2})[.,]\d+\s+-->/) || ln.match(/^(\d{2}):(\d{2})[.,]\d+\s+-->/);
    if (m) { t = m.length === 4 ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2]; continue; }
    const s = ln.replace(/<[^>]*>/g, '').trim();
    if (t == null || !s || /^(WEBVTT|Kind:|Language:)/.test(s)) continue;
    if (out.some((o) => o.text === s)) continue;   // 자동 자막의 굴러가는 중복 줄
    out.push({ t, text: s });
  }
  return out;
}

function fetchSubs(id, lang) {
  const dir = path.join(TYPES_OUT, '_subs');
  fs.mkdirSync(dir, { recursive: true });
  const find = () => fs.readdirSync(dir).find((f) => f.startsWith(`${id}.`) && f.endsWith('.vtt'));
  if (!find()) {
    const h = +new Date(Date.now() + 9 * 36e5).toISOString().slice(11, 13);
    if (h < 9 || h >= 12) return null;   // 유튜브 자막은 09~12시 KST 만(운영 규칙)
    try {
      execFileSync('yt-dlp', ['--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', lang, '--sub-format', 'vtt',
        '-o', path.join(dir, '%(id)s'), `https://www.youtube.com/watch?v=${id}`], { timeout: 120000, stdio: 'ignore' });
    } catch { /* 자막 없음 — 순간 초는 댓글 타임스탬프로만 */ }
  }
  const f = find();
  return f ? parseVtt(fs.readFileSync(path.join(dir, f), 'utf8')) : null;
}

function pickComments(cs, k = PER_VIDEO) {
  const ts = cs.filter((c) => commentTs(c.text).length);
  const top = cs.slice().sort((a, b) => b.likes - a.likes);
  const seen = new Set();
  return [...top.slice(0, k), ...ts].filter((c) => (seen.has(c.id) ? false : seen.add(c.id))).slice(0, k + 10);
}

function typesPrompt(ch, vids) {
  const blocks = vids.map((v, i) => {
    const sub = v.subs ? v.subs.slice(0, 40).map((s) => `[${mmss(s.t)}] ${s.text}`).join(' ') : '없음';
    return `[v${i + 1}] «${v.title}» (길이 ${v.dur}초, 조회 ${v.views.toLocaleString()})\n자막: ${sub}\n댓글:\n` +
      v.picked.map((c, j) => `v${i + 1}.${j + 1} [♥${c.likes} · 답${c.replies || 0}] ${c.text.slice(0, 160)}`).join('\n');
  }).join('\n\n');
  return `유튜브 채널 «${ch.name}» 최근 공개 편 ${vids.length}개의 댓글이다. 이 채널에 반복해서 달리는 반응 유형을 5~8개로 묶어라.
일반 분류(정정·경험담·훈수·공감·논쟁)로 쓰지 말고 이 채널 소재에 고유한 반응으로, 댓글 말투 그대로 짧게 이름 지어라
(동물 채널 예: «한국이었으면 잡아먹힘» «상대도 안 됨» «귀엽다»). 서로 겹치지 않게.
JSON 하나만 답하라(설명 금지):
{"types": [{"name": "짧은 이름", "desc": "어떤 댓글인지 한 줄", "trigger": "이 반응을 부르는 영상 속 순간의 공통점 한 줄", "line_hint": "원고에 넣으면 이 반응을 부를 문장 예 1개"}],
 "assign": {"v1.1": 1, "v1.2": 0},
 "moments": [{"type": 1, "video": "v3", "at_sec": 12, "what": "그 순간 장면 한 줄", "basis": "자막|댓글 타임스탬프|없음"}]}
assign: 위 댓글 번호 전부를 유형 번호(1부터, types 순서)로. 0 = 기타(인사·도배·광고·분류 불가).
moments: 유형마다 1~3개, 그 반응을 부른 편과 순간. at_sec 는 자막 시각이나 댓글 속 타임스탬프에 근거할 때만 숫자, 근거 없으면 null 로 두고 what 에 댓글이 가리키는 장면을 적어라. 지어내지 마라.

${blocks}`;
}

// GPT 답 → 비율·대표 댓글·순간(검증) — 순수 함수(테스트 대상)
function tallyTypes(ch, vids, ans) {
  const types = (ans.types || []).slice(0, 8);
  const refs = new Map();
  vids.forEach((v, i) => v.picked.forEach((c, j) => refs.set(`v${i + 1}.${j + 1}`, { ...c, video: v.id })));
  const bucket = types.map(() => []);
  const other = [];
  for (const [ref, c] of refs) {
    const n = +((ans.assign || {})[ref]);
    if (n >= 1 && n <= types.length) bucket[n - 1].push(c); else other.push(c);
  }
  const total = refs.size || 1;
  const pct = (n) => Math.round((n / total) * 1000) / 10;
  const out = types.map((t, k) => {
    const cs = bucket[k];
    const moments = (ans.moments || []).filter((m) => +m.type === k + 1).slice(0, 3).map((m) => {
      const vi = +(String(m.video || '').match(/\d+/) || [0])[0] - 1;
      const v = vids[vi];
      if (!v) return null;
      let at = m.at_sec == null || m.at_sec === '' ? null : +m.at_sec;
      const grounded = Number.isFinite(at) && at >= 0 && at <= (v.dur || 0) + 1 &&
        ((/자막/.test(m.basis || '') && v.subs && v.subs.length) ||
         (/타임스탬프/.test(m.basis || '') && v.picked.some((c) => commentTs(c.text).some((s) => Math.abs(s - at) <= 2))));
      if (!grounded) at = null;
      return { video: v.id, title: v.title, at_sec: at, what: m.what || '', basis: at == null ? '근거 없음 — 초 미상' : m.basis };
    }).filter(Boolean);
    if (!moments.length && cs.length) {   // GPT 가 순간을 안 줬으면 그 유형 좋아요 1위 댓글의 편(초 미상)
      const c = cs.slice().sort((a, b) => b.likes - a.likes)[0];
      const v = vids.find((x) => x.id === c.video);
      moments.push({ video: c.video, title: v ? v.title : '', at_sec: null, what: `좋아요 1위 댓글이 달린 편`, basis: '근거 없음 — 초 미상' });
    }
    return { name: String(t.name || `유형 ${k + 1}`).trim(), desc: t.desc || '', trigger: t.trigger || '', line_hint: t.line_hint || '',
      count: cs.length, pct: pct(cs.length), likes: cs.reduce((s, c) => s + c.likes, 0),
      examples: cs.slice().sort((a, b) => b.likes - a.likes).slice(0, 3).map((c) => ({ video: c.video, text: c.text.slice(0, 120), likes: c.likes })),
      moments };
  }).sort((a, b) => b.count - a.count || b.likes - a.likes).map((t, i) => ({ rank: i + 1, ...t }));
  return { total: refs.size, types: out, other: { count: other.length, pct: pct(other.length) }, top3: out.slice(0, 3).map((t) => t.name) };
}

function typesMd(res) {
  const L = [`# 채널 반응 유형 — ${res.channel} (${res.key}, ${res.at.slice(0, 10)})`, '',
    `- 편 ${res.videos.length} · 분류한 댓글 ${res.total} · 자막 근거 편 ${res.videos.filter((v) => v.subs).length} · 기타 ${res.other.pct}%`,
    `- ★원고 관문(comment_hook --channel ${res.key}): 상위 3유형 «${res.top3.join('» «')}» 중 2개 이상을 부르는 줄(comment_calls)`, '',
    '| # | 유형 | 비율 | 댓글 | 좋아요 합 | 부르는 순간 공통점 | 원고 줄 예 |', '|---|---|---|---|---|---|---|',
    ...res.types.map((t) => `| ${t.rank} | ${t.name} | ${t.pct}% | ${t.count} | ${t.likes.toLocaleString()} | ${t.trigger.replace(/\|/g, '/')} | ${t.line_hint.replace(/\|/g, '/')} |`), ''];
  for (const t of res.types) {
    L.push(`## ${t.rank}. ${t.name} — ${t.pct}%`, `${t.desc}`, '', '대표 댓글:',
      ...t.examples.map((e) => `- «${e.text}» ♥${e.likes} (${e.video})`), '', '부른 순간:',
      ...t.moments.map((m) => `- ${m.video} ${m.at_sec == null ? '초 미상' : `${mmss(m.at_sec)}(${m.at_sec}초)`} — ${m.what} [${m.basis}] «${(m.title || '').slice(0, 30)}»`), '');
  }
  return L.join('\n');
}

async function channelId(key, ch) {
  if (ch.id) return ch.id;
  const ids = fs.existsSync(PROD) ? fs.readFileSync(PROD, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.lane === ch.ledger && r.youtube_id).map((r) => r.youtube_id) : [];
  if (!ids.length) throw new Error(`제작 장부에 ${ch.ledger} youtube_id 없음 — 채널 id 를 못 찾음`);
  const ms = await videoMeta(key, ids.slice(-5));
  const cnt = {};
  for (const m of ms) cnt[m.channelId] = (cnt[m.channelId] || 0) + 1;
  const best = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
  if (!best) throw new Error(`${ch.ledger} 영상이 공개 목록에 없음`);
  return best[0];
}

async function channelTypes(key, chKey, { days = 60, max = 25, subs = false, force = false, noGpt = false } = {}) {
  const ch = CHANNELS[chKey];
  if (!ch) throw new Error(`채널 키 «${chKey}» 없음 — ${Object.keys(CHANNELS).join('·')}`);
  const outJ = path.join(TYPES_OUT, `${chKey}.json`);
  if (!force && fs.existsSync(outJ)) {
    const prev = JSON.parse(fs.readFileSync(outJ, 'utf8'));
    if (Date.now() - Date.parse(prev.at) < 6 * 864e5) return { skipped: true, ...prev };
  }
  const cid = await channelId(key, ch);
  const metas = (await videoMeta(key, await uploads(key, cid, days))).filter((m) => m.privacy === 'public' && m.comments > 0)
    .sort((a, b) => b.comments - a.comments).slice(0, max);
  const vids = [];
  for (const m of metas) {
    let cs;
    try { cs = await fetchComments(key, m.id); } catch (e) {
      if (e instanceof Stop || e instanceof Cap) { console.log(`  ⚠ ${e.message} — 남은 편 건너뜀`); break; }
      continue;
    }
    vids.push({ ...m, mined: cs.length, picked: pickComments(cs), subs: subs ? fetchSubs(m.id, ch.lang) : null });
    console.log(`  ${ch.name} «${m.title.slice(0, 30)}» 댓글 ${cs.length}${subs ? ` · 자막 ${vids[vids.length - 1].subs ? 'O' : 'X'}` : ''} · 쿼터 오늘 ${quota()}`);
  }
  if (!vids.length) throw new Error(`${ch.name} 댓글 있는 공개 편 없음(최근 ${days}일)`);
  const base = { at: new Date().toISOString(), key: chKey, channel: ch.name, channel_id: cid, channel_title: vids[0].channel, lang: ch.lang, days,
    videos: vids.map((v) => ({ id: v.id, title: v.title, views: v.views, comments: v.comments, mined: v.mined, sent: v.picked.length, dur: v.dur, subs: !!(v.subs && v.subs.length) })) };
  fs.mkdirSync(TYPES_OUT, { recursive: true });
  if (noGpt) {
    fs.writeFileSync(path.join(TYPES_OUT, `${chKey}_raw.json`), JSON.stringify({ ...base, raw: vids }, null, 2) + '\n', 'utf8');
    return { ...base, raw_only: true };
  }
  const ans = gpt(typesPrompt(ch, vids), `types_${chKey}`);
  const res = { ...base, ...tallyTypes(ch, vids, ans) };
  fs.writeFileSync(outJ, JSON.stringify(res, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(TYPES_OUT, `${chKey}.md`), typesMd(res), 'utf8');
  return res;
}

module.exports = { fetchComments, mineVideo, repeatedWords, expectedFor, summaryMd, TYPES,
  CHANNELS, channelTypes, tallyTypes, typesMd, typesPrompt, parseVtt, commentTs, pickComments };

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
      if (argv.includes('--channel-types')) {
        const k = opt('--channel-types');
        const r = await channelTypes(key, k, { days: +opt('--days', 60), max: +opt('--max', 25), subs: argv.includes('--subs'), force: argv.includes('--force'), noGpt });
        if (r.skipped) console.log(`${r.channel} 표가 6일 안(${r.at.slice(0, 10)}) — 건너뜀(--force 로 다시)`);
        else if (r.raw_only) console.log(`${r.channel} 댓글만 모음(--no-gpt) → server/data/comment_types/${k}_raw.json`);
        else console.log(`${r.channel}(${r.channel_title}) 편 ${r.videos.length} · 댓글 ${r.total} · 상위 3: ${r.types.slice(0, 3).map((t) => `${t.name} ${t.pct}%`).join(' · ')} · 쿼터 오늘 ${quota()} → server/data/comment_types/${k}.{json,md}`);
      } else if (argv.includes('--vs')) {
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
