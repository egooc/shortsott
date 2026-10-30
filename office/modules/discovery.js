// AI 오피스 현황판 — 발굴분석 세션 진행. 유튜브 아래 따로 뜨는 판. 내용은 lib/boards.js
delete require.cache[require.resolve('./lib/boards')]; // 공용 파일을 고쳐도 연결기 재시작 없이 반영
const { workDashboard } = require('./lib/boards');
module.exports = { project: 'board-discovery', title: '발굴분석', run: async () => workDashboard({ key: '발굴분석', title: '발굴분석', prefix: '발굴', session: 'YTHOME-M-발굴분석',
  extra: [{ type: 'note', text: '찾은 결 후보와 채널별 분석은 «잡탕 광산» 판에 있습니다.' }] }) };
