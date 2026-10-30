// AI 오피스 현황판 — 잡탕 광산(결 가로채기). 유튜브 아래 따로 뜨는 판. 내용은 lib/boards.js
delete require.cache[require.resolve('./lib/boards')]; // 공용 파일을 고쳐도 연결기 재시작 없이 반영
const { mineDashboard } = require('./lib/boards');
module.exports = { project: 'board-jabtang', title: '잡탕 광산', run: async () => mineDashboard() };
