// 포장 CTR 칸(G10, 관리자 10-21) — 다른 롱폼 레인(연금·기업·수창·정치JA)이 그대로 require 한다.
//
//   const { ctrFor } = require('D:/midform/politics-hour/ctr.js');  ctrFor(videoId, sinceISO?) → {value, impressions, at, source} | {value: null, source}
//
// Data API 는 노출 수를 주지 않는다 → 스튜디오 수치를 소유주가 server/data/ctr_input.jsonl 에 한 줄씩 넣는다:
//   {"id": "<videoId>", "at": "2026-10-21T09:00:00+09:00", "impressions": 1234, "ctr": 4.1}   (ctr = 퍼센트)
// 입력이 없으면 {value: null, source: '입력 없음'} — 조회/노출 추정치를 지어내지 않는다. impressions 만 있으면 조회로 추정(source: '추정').
const fs = require('fs');
const path = require('path');

const INPUT = path.join(__dirname, '..', 'server', 'data', 'ctr_input.jsonl');

function ctrFor(videoId, since, views) {
  if (!fs.existsSync(INPUT)) return { value: null, source: '입력 없음(ctr_input.jsonl)' };
  const rows = fs.readFileSync(INPUT, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } })
    .filter((r) => r.id === videoId && (!since || new Date(r.at) >= new Date(since)));
  const r = rows.sort((a, b) => new Date(a.at) - new Date(b.at)).pop();
  if (!r) return { value: null, source: since ? '이 포장 기간 입력 없음' : '입력 없음' };
  if (typeof r.ctr === 'number') return { value: r.ctr, impressions: r.impressions ?? null, at: r.at, source: '스튜디오(소유주 입력)' };
  if (r.impressions > 0 && typeof views === 'number') return { value: +(100 * views / r.impressions).toFixed(2), impressions: r.impressions, at: r.at, source: '추정(조회/노출)' };
  return { value: null, source: '입력에 ctr·impressions 없음' };
}

module.exports = { ctrFor, INPUT };
