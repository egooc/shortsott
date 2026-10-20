// 저조회 진단표 — 조회 구간(전자책 M1) · 쇼츠 벽 이름·처방(큰제로 Z9) · 첫 분기 «노출 → 클릭률 → 지속률»(하늘구름땅바람 S5). 10-20 관리자 큐.
// 함수로 쓴다(manager-report·저조회 자동 비공개 로그·레인 보고에서 import):
//   const { diagnose, wall, band, firstBranch } = require('D:/midform/scripts/view_diag.js');
//   diagnose({ views: 1450, kind: 'shorts', impressions: 52000, ctr: null, avp: 41, base: { impressions: 80000, avp: 70 } })
//     → { band, wall: {name, prescription}, branch: {broken, step, prescription, need}, line }
// CLI(표 한 장): node scripts/view_diag.js <rows.json>   rows = [{id, title, views, kind: shorts|long, (선택) impressions, ctr, avp, base}]
//
// 노출·클릭률은 API 로 못 받는다 → 소유주 스튜디오 수치(없으면 need 에 «스튜디오 수치 필요»). 지속률(avp, 평균 시청 비율 %)은 Analytics API.
// ★임계값은 칼럼 근거 + 우리 실측 전의 잠정값 — 사례가 쌓이면 이 표를 고친다(THRESH).
// 10-21 자료 점검 G8: 업로드 48시간 시점 판정(at48 — 레인 48h 중앙값 대비) + 같은 주제 경쟁 편 조회 비교(relative, 시간당 조회로 나이 보정).
//   diagnose({ ..., views_48h, lane_median_48h, competitors: [{title, views, hours}], hours }) 면 line 에 «48h …»·«경쟁 대비 …» 가 붙는다.
//   views48(id) — server/data/yt_low_views_log.jsonl 의 hours 40~56 기록에서 48시간에 가장 가까운 조회.
// G16 부검: autopsy({ ours, ref, missing }) → 소재 동일성·첫 3초·전개 3열 + next_fix(다음 편 메울 한 끗). CLI --autopsy <pair.json>.
const THRESH = {
  impressions_low: 0.5,            // 같은 채널 평소(base.impressions)의 절반 미만 = 노출 깨짐
  ctr: { shorts: null, long: 5.0 }, // 롱폼 5%(devo V13, 10-21 잠정 3→5). 쇼츠는 «노출 클릭률» 대신 피드에서 본 비율이라 판정 안 함
  avp: { shorts: 70, long: 30 },   // 평균 시청 비율 % — 쇼츠 70 미만·롱폼 30 미만 = 지속 깨짐
  at48: { up: 1.5, down: 0.5 },    // 48h 조회 ÷ 레인 48h 중앙값 — 1.5배 이상 오름 · 0.5배 미만 꺾임
  rel: { up: 1.0, down: 0.3 },     // 시간당 조회 ÷ 경쟁 같은 주제 편 중앙값 — 1배 이상 대등 · 0.3배 미만 열세
};

const median = (a) => { const b = a.filter((x) => x != null && !Number.isNaN(x)).sort((x, y) => x - y); return b.length ? (b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2) : null; };

// G8: 48시간 시점 — 레인 48h 중앙값 대비
function at48(views48, laneMedian48) {
  if (views48 == null) return { verdict: null, need: '48h 조회(yt_low_views_log 또는 스냅숏)' };
  if (!laneMedian48) return { verdict: '기준 없음', ratio: null, views48 };
  const r = views48 / laneMedian48;
  return { verdict: r >= THRESH.at48.up ? '오름' : r < THRESH.at48.down ? '꺾임' : '보통', ratio: Math.round(r * 100) / 100, views48 };
}

// G8: 같은 주제 경쟁 편 대비(상대평가) — 나이가 달라 시간당 조회로 맞춘다
function relative(views, hours, competitors = []) {
  const per = (v, h) => (h ? v / Math.max(h, 1) : null);
  const ours = per(views, hours);
  const comp = median(competitors.map((c) => per(c.views, c.hours)));
  if (ours == null || comp == null) return { verdict: null, need: competitors.length ? '우리 편 공개 시간(hours)' : '같은 주제 경쟁 편(제목·조회·hours)' };
  const r = ours / comp;
  return { verdict: r >= THRESH.rel.up ? '대등 이상' : r < THRESH.rel.down ? '열세' : '뒤처짐', ratio: Math.round(r * 100) / 100, comp_median_per_h: Math.round(comp), n: competitors.length };
}

function views48(id, logFile = require('path').join(__dirname, '..', 'server', 'data', 'yt_low_views_log.jsonl')) {
  let rows = [];
  try { rows = require('fs').readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.id === id && r.hours >= 40 && r.hours <= 56); } catch {}
  if (!rows.length) return null;
  return rows.sort((a, b) => Math.abs(a.hours - 48) - Math.abs(b.hours - 48))[0].views;
}

// G16 부검: 우리 편(ours) vs 잘된 같은 소재 편(ref) — {title, first3s(첫 3초 문장·장면), segments(컷 수) | duration, topic}
const words = (t) => [...new Set(String(t || '').replace(/#\S+/g, ' ').match(/[가-힣]{2,}|[一-龥々ァ-ヶー]{2,}|[A-Za-z]{3,}/g) || [])];
function autopsy({ ours = {}, ref = {}, missing = [] } = {}) {
  const wo = words(ours.topic || ours.title), wr = words(ref.topic || ref.title);
  const common = wo.filter((w) => wr.some((x) => x.includes(w) || w.includes(x)));
  const same = { verdict: common.length >= 2 ? '같은 소재' : common.length ? '일부 겹침' : '다른 소재', common };
  const first3 = { ours: ours.first3s || null, ref: ref.first3s || null,
    verdict: !ours.first3s || !ref.first3s ? '비교 불가(첫 3초 기록 없음)' : words(ours.first3s).some((w) => words(ref.first3s).includes(w)) ? '같은 진입' : '진입이 다름' };
  const pace = (x) => (x.segments && x.duration ? x.duration / x.segments : null);
  const po = pace(ours), pr = pace(ref);
  const flow = { ours_sec_per_cut: po && Math.round(po * 10) / 10, ref_sec_per_cut: pr && Math.round(pr * 10) / 10,
    verdict: po == null || pr == null ? '비교 불가(컷 수·길이 없음)' : po > pr * 1.5 ? '우리가 느림' : po < pr / 1.5 ? '우리가 빠름' : '비슷' };
  // 다음 편 메울 한 끗: 댓글 부검(comment_mine --vs missing[0]) 이 먼저, 없으면 처음 어긋난 열
  const next_fix = (missing[0] && (missing[0].what || missing[0].point || missing[0])) ||
    (same.verdict === '다른 소재' ? '소재부터 — 같은 소재로 비교하거나 잘된 소재를 다시 잡아라' :
      first3.verdict === '진입이 다름' ? `첫 3초를 잘된 편 진입으로 «${String(ref.first3s).slice(0, 30)}»` :
        flow.verdict === '우리가 느림' ? `컷 간격 ${flow.ours_sec_per_cut}초 → ${flow.ref_sec_per_cut}초 쪽으로` : '세 열 비슷 — 시기·포장(제목·썸네일) 비교');
  return { same_topic: same, first3s: first3, flow, next_fix: typeof next_fix === 'string' ? next_fix : JSON.stringify(next_fix) };
}

// 전자책 M1: 조회 구간 → 원인 후보(편집 탓은 마지막)
function band(views) {
  if (views < 1000) return { range: '0~1,000', cause: '가이드 위반·재사용·채널 불량 의심' };
  if (views < 10000) return { range: '1,000~10,000', cause: '재미 없음·채널빨 약함' };
  if (views <= 30000) return { range: '10,000~30,000', cause: '영상은 좋은데 중복도' };
  return { range: '30,000+', cause: '정상 이상' };
}

// 큰제로 Z9: 쇼츠 벽 3단계 + 처방
function wall(views, kind = 'shorts') {
  if (kind !== 'shorts') return null;
  if (views < 1000) return { name: '스와이프 벽', prescription: '계정 웜업(5~7일 일반 시청) · 3단 훅(시각·청각·텍스트 3초 안)' };
  if (views < 10000) return { name: '리액션 벽', prescription: '끝까지 보지만 감정 동요 없음 → 대리만족 한 문장 역설계 · 공유·댓글 유발(comment_hook)' };
  if (views < 20000) return { name: '리액션→포맷 사이', prescription: '리액션 벽 처방 유지, 터진 편과 포맷 비교 시작' };
  if (views <= 30000) return { name: '포맷 벽', prescription: '아웃라이어 포맷 이식(같은 소재·다른 틀)' };
  return { name: '벽 넘음', prescription: '같은 소재·틀 반복(멱살캐리)' };
}

// 하늘구름땅바람 S5: 노출 → 클릭률 → 지속률 — 처음 깨진 곳에서 멈춘다(소재부터 바꾸지 않는다)
function firstBranch({ kind = 'shorts', impressions = null, ctr = null, avp = null, base = {} } = {}) {
  const need = [];
  if (impressions == null) need.push('노출수(스튜디오)');
  else if (base.impressions && impressions < base.impressions * THRESH.impressions_low) {
    return { broken: '노출', step: 1, prescription: '유튜브가 채널을 이해 못 함·저품질 누적 — 채널 주제 일관성·가이드 점검(guide_words)·최근 저품질 편 정리', need };
  }
  const ctrMin = THRESH.ctr[kind];
  if (ctrMin != null) {
    if (ctr == null) need.push('노출 클릭률(스튜디오)');
    else if (ctr < ctrMin) return { broken: '클릭률', step: 2, prescription: '썸네일·제목 — title_check·포장 교체(롱폼 자동 포장)', need };
  }
  const avpMin = THRESH.avp[kind];
  if (avp == null) need.push('평균 시청 비율(Analytics)');
  else if (avp < avpMin) return { broken: '지속률', step: 3, prescription: '영상 — 첫 3초·리듬(script_audit 리듬·첫 질문)·끝맺음', need };
  if (need.length) return { broken: null, step: null, prescription: '판정 보류 — 수치 부족', need };
  return { broken: null, step: null, prescription: '세 숫자 정상 — 소재·시기 문제(부검 Z5: 같은 소재 잘된 영상과 댓글 대조)', need };
}

function diagnose(v) {
  const kind = v.kind || 'shorts';
  const b = band(v.views || 0);
  const w = wall(v.views || 0, kind);
  const br = firstBranch({ ...v, kind });
  const a48 = v.views_48h !== undefined || v.lane_median_48h !== undefined ? at48(v.views_48h, v.lane_median_48h) : null;
  const rel = v.competitors ? relative(v.views || 0, v.hours, v.competitors) : null;
  const line = `${(v.views || 0).toLocaleString()}회 · ${b.range}(${b.cause})` + (w ? ` · ${w.name}` : '') +
    (a48 && a48.verdict ? ` · 48h ${a48.verdict}${a48.ratio != null ? `(레인 중앙의 ${a48.ratio}배)` : ''}` : '') +
    (rel && rel.verdict ? ` · 경쟁 대비 ${rel.verdict}(시간당 ${rel.ratio}배, 경쟁 ${rel.n}편)` : '') +
    ` · 첫 분기: ${br.broken ? `${br.broken} 깨짐 → ${br.prescription}` : br.prescription}` + (br.need.length ? ` · 필요: ${br.need.join('·')}` : '');
  return { band: b, wall: w, branch: br, at48: a48, relative: rel, line };
}

module.exports = { diagnose, wall, band, firstBranch, at48, relative, views48, autopsy, THRESH };

if (require.main === module) {
  const fs = require('fs');
  if (process.argv[2] === '--autopsy') {
    let pair;
    try { pair = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')); } catch (e) { console.log(`⚠ 부검 불가: ${e.message}`); process.exit(5); }
    const a = autopsy(pair);
    console.log('| 소재 동일성 | 첫 3초 | 전개(컷 간격) | 다음 편 메울 한 끗 |');
    console.log('|---|---|---|---|');
    console.log(`| ${a.same_topic.verdict} (${a.same_topic.common.join('·') || '-'}) | ${a.first3s.verdict} | ${a.flow.verdict} (${a.flow.ours_sec_per_cut ?? '-'}초 vs ${a.flow.ref_sec_per_cut ?? '-'}초) | ${a.next_fix} |`);
    process.exit(0);
  }
  const f = process.argv[2];
  if (!f) { console.log('usage: node scripts/view_diag.js <rows.json> | --autopsy <pair.json>'); process.exit(2); }
  let rows;
  try { rows = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { console.log(`⚠ 진단표 불가: ${e.message}`); process.exit(5); }
  console.log('| 편 | 조회 | 구간(M1) | 벽(Z9) | 처방 | 48h | 경쟁 대비 | 첫 분기(S5) | 필요한 수치 |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const v of rows) {
    const d = diagnose(v);
    if (v.views_48h === undefined && v.id) v.views_48h = views48(v.id);
    const d2 = diagnose(v);
    console.log(`| ${(v.title || v.id || '').slice(0, 30)} | ${(v.views || 0).toLocaleString()} | ${d.band.range} ${d.band.cause} | ${d.wall ? d.wall.name : '-'} | ${d.wall ? d.wall.prescription : '-'} | ${d2.at48 && d2.at48.verdict ? `${d2.at48.verdict}${d2.at48.ratio != null ? ` ${d2.at48.ratio}배` : ''}` : '-'} | ${d2.relative && d2.relative.verdict ? `${d2.relative.verdict} ${d2.relative.ratio}배` : '-'} | ${d.branch.broken ? d.branch.broken + ' 깨짐: ' + d.branch.prescription : d.branch.prescription} | ${d.branch.need.join('·') || '-'} |`);
  }
}
