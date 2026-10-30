// AI 오피스 현황판 — 그로우업 블로그 발행기. 그로우업 아래 따로 뜨는 판(10-31 소유주 «모바일앱 블로그 발행기 대시보드 만들고 진행상황 계속 보고»).
// 단계·지금 하는 일·막힌 것·시험 결과는 맡은 세션(그로우업 관리자)이 growupup/docs/office/blog-publisher.json 에 적는다.
// 커밋·고치는 중인 파일·앱 버전은 저장소에서 읽기만 한다(폰·adb 는 건드리지 않는다).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = process.env.GROWUP_REPO || path.join(require('os').homedir(), 'orca/growupup');
const STATUS = 'docs/office/blog-publisher.json';
const PATHS = ['scripts/adb', 'scripts/autojs6', 'supabase/functions/_shared/assembleNaverJob.ts', STATUS];
const MANAGER = '그로우업 관리자';
const TONE = { 끝: 'ok', 진행: 'busy', 대기: 'muted', 막힘: 'bad' };
const RESULT = { 통과: 'ok', 실패: 'bad', 부분: 'warn' };

const git = (args) => { try { return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', timeout: 15e3, windowsHide: true }); } catch { return ''; } };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(path.join(REPO, p), 'utf8')); } catch { return null; } };
const kstMd = (iso) => { const d = new Date(Date.parse(iso) + 9 * 3600e3); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.toISOString().slice(11, 16)}`; };
// 커밋 제목의 «feat(daangn): …» 꼬리표를 떼고 읽는 말만
const subj = (s) => s.replace(/^\w+(\([^)]*\))?!?:\s*/, '');

module.exports = {
  project: 'board-blogpub', title: '블로그 발행기',
  run: async () => {
    const st = readJson(STATUS) || { steps: [], blockers: [], tests: [] };
    const steps = st.steps || [];
    const done = steps.filter((s) => s.state === '끝').length;
    const cur = steps.find((s) => s.state === '막힘') || steps.find((s) => s.state === '진행') || steps.find((s) => s.state !== '끝');
    const app = readJson('scripts/autojs6/project/project.json');
    const commits = git(['log', '--since=14 days ago', '--format=%h%x09%cI%x09%s', '--', ...PATHS]).split('\n').filter(Boolean)
      .map((l) => { const [h, at, s] = l.split('\t'); return { h, at, s }; });
    const dirty = git(['status', '--porcelain', '--', ...PATHS]).split('\n').filter(Boolean).map((l) => l.slice(3));
    const tests = (st.tests || []).slice(-20).reverse();
    const blockers = st.blockers || [];

    const stepCards = steps.map((s, i) => ({
      title: `${i + 1}. ${s.title}`, sub: s.note || '', tone: TONE[s.state] || 'muted',
      chips: [{ t: s.state || '대기', c: TONE[s.state] || 'muted' }, ...(s.at ? [{ t: s.at, c: 'muted' }] : [])],
    }));
    const commitCards = commits.map((c) => ({ title: subj(c.s), sub: c.h, chips: [{ t: kstMd(c.at), c: 'muted' }] }));
    const testCards = tests.map((t) => ({ title: t.title, sub: t.note || '', tone: RESULT[t.result] || 'muted',
      chips: [{ t: t.result || '—', c: RESULT[t.result] || 'muted' }, ...(t.at ? [{ t: t.at, c: 'muted' }] : [])] }));

    return {
      title: '블로그 발행기', updated_at: st.updated_at ? new Date(st.updated_at).toISOString() : new Date().toISOString(),
      board: { parent: 'growupup', manager: MANAGER, sessions: [MANAGER] },
      tabs: [
        { key: 'glance', label: '한눈에', sections: [
          { type: 'stats', items: [
            { label: '진행', value: `${done}/${steps.length}단계`, tone: done === steps.length && steps.length ? 'ok' : 'busy' },
            { label: '지금 단계', value: cur ? cur.title.split(/[—(]/)[0].trim() : '전부 끝', tone: cur ? TONE[cur.state] || 'busy' : 'ok' },
            { label: '막힌 것', value: `${blockers.length}건`, tone: blockers.length ? 'bad' : 'ok' },
            { label: '폰 앱', value: app?.versionName ? `v${app.versionName}` : '—', sub: dirty.length ? `고치는 중 파일 ${dirty.length}개` : '고치는 중 없음' },
          ] },
          { type: 'list', title: '지금 하는 일', items: [{ title: st.now || '맡은 세션이 아직 안 적었습니다', sub: st.updated_at ? `${kstMd(st.updated_at)} 기록` : '', tone: 'busy' }], compact: true },
          ...(blockers.length ? [{ type: 'list', title: '막힌 것', items: blockers.map((b) => ({ title: b.title || b, sub: b.note || '', tone: 'bad' })), compact: true }] : []),
          { type: 'list', title: '단계', items: stepCards, compact: true, empty: '단계가 아직 없습니다.' },
          { type: 'list', title: '최근 시험', items: testCards.slice(0, 3), compact: true, empty: '시험 기록이 아직 없습니다.' },
        ] },
        { key: 'tests', label: `시험 ${tests.length}`, sections: [{ type: 'list', title: '폰 시험 결과(최근 20개)', items: testCards, compact: true, empty: '시험 기록이 아직 없습니다.' }] },
        { key: 'work', label: '작업 기록', sections: [
          { type: 'list', title: '최근 2주 발행기 커밋', items: commitCards, compact: true, empty: '최근 2주 커밋이 없습니다.' },
          { type: 'list', title: '아직 커밋 안 한 파일', items: dirty.map((f) => ({ title: f, tone: 'warn' })), compact: true, empty: '없습니다.' },
        ] },
      ],
    };
  },
};
