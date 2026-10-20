// 저조회 진단표 — 조회 구간(전자책 M1) · 쇼츠 벽 이름·처방(큰제로 Z9) · 첫 분기 «노출 → 클릭률 → 지속률»(하늘구름땅바람 S5). 10-20 관리자 큐.
// 함수로 쓴다(manager-report·저조회 자동 비공개 로그·레인 보고에서 import):
//   const { diagnose, wall, band, firstBranch } = require('D:/midform/scripts/view_diag.js');
//   diagnose({ views: 1450, kind: 'shorts', impressions: 52000, ctr: null, avp: 41, base: { impressions: 80000, avp: 70 } })
//     → { band, wall: {name, prescription}, branch: {broken, step, prescription, need}, line }
// CLI(표 한 장): node scripts/view_diag.js <rows.json>   rows = [{id, title, views, kind: shorts|long, (선택) impressions, ctr, avp, base}]
//
// 노출·클릭률은 API 로 못 받는다 → 소유주 스튜디오 수치(없으면 need 에 «스튜디오 수치 필요»). 지속률(avp, 평균 시청 비율 %)은 Analytics API.
// ★임계값은 칼럼 근거 + 우리 실측 전의 잠정값 — 사례가 쌓이면 이 표를 고친다(THRESH).
const THRESH = {
  impressions_low: 0.5,            // 같은 채널 평소(base.impressions)의 절반 미만 = 노출 깨짐
  ctr: { shorts: null, long: 3.0 }, // 쇼츠는 «노출 클릭률» 대신 피드에서 본 비율이라 판정 안 함(스튜디오 «본 비율»을 avp 앞에 따로)
  avp: { shorts: 70, long: 30 },   // 평균 시청 비율 % — 쇼츠 70 미만·롱폼 30 미만 = 지속 깨짐
};

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
  const line = `${(v.views || 0).toLocaleString()}회 · ${b.range}(${b.cause})` + (w ? ` · ${w.name}` : '') +
    ` · 첫 분기: ${br.broken ? `${br.broken} 깨짐 → ${br.prescription}` : br.prescription}` + (br.need.length ? ` · 필요: ${br.need.join('·')}` : '');
  return { band: b, wall: w, branch: br, line };
}

module.exports = { diagnose, wall, band, firstBranch, THRESH };

if (require.main === module) {
  const fs = require('fs');
  const f = process.argv[2];
  if (!f) { console.log('usage: node scripts/view_diag.js <rows.json>'); process.exit(2); }
  let rows;
  try { rows = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { console.log(`⚠ 진단표 불가: ${e.message}`); process.exit(5); }
  console.log('| 편 | 조회 | 구간(M1) | 벽(Z9) | 처방 | 첫 분기(S5) | 필요한 수치 |');
  console.log('|---|---|---|---|---|---|---|');
  for (const v of rows) {
    const d = diagnose(v);
    console.log(`| ${(v.title || v.id || '').slice(0, 30)} | ${(v.views || 0).toLocaleString()} | ${d.band.range} ${d.band.cause} | ${d.wall ? d.wall.name : '-'} | ${d.wall ? d.wall.prescription : '-'} | ${d.branch.broken ? d.branch.broken + ' 깨짐: ' + d.branch.prescription : d.branch.prescription} | ${d.branch.need.join('·') || '-'} |`);
  }
}
