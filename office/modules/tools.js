// AI 오피스 현황판 — 도구개발 세션 진행. 유튜브 아래 따로 뜨는 판. 내용은 lib/boards.js
delete require.cache[require.resolve('./lib/boards')]; // 공용 파일을 고쳐도 연결기 재시작 없이 반영
const { workDashboard } = require('./lib/boards');
module.exports = { project: 'board-tools', title: '도구개발', run: async () => workDashboard({ key: '도구개발', title: '도구개발', prefix: '도구개발', session: 'YTHOME-M-도구개발' }) };
