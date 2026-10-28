// 발행 경로 스위치 시험 — 네트워크 0(fetch 가짜). Blotato 끔·틱톡 보류에서 Blotato 호출이 0회인지, 건너뜀이 실패가 아닌지.
// node tests/publish_routes_test.js [모듈 파일명, 기본 blotato-publish.js]
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.PUBLISH_ROUTES_PATH = path.join(os.tmpdir(), `publish_routes_${process.pid}.json`);
const routes = require('../scripts/publish-routes');
const calls = [];
global.fetch = async (url, opt = {}) => {
  calls.push(String(url));
  const u = String(url);
  const ok = (j) => ({ ok: true, status: 200, text: async () => JSON.stringify(j), json: async () => j });
  if (u.includes('zernio.com/api/v1/media/presign')) return ok({ uploadUrl: 'https://upload.example/put', publicUrl: 'https://media.zernio.com/x.mp4' });
  if (u === 'https://upload.example/put') return ok({});
  if (u.includes('zernio.com/api/v1/posts')) return ok({ post: { _id: 'p1' }, body: JSON.parse(opt.body || '{}') });
  return ok({});
};
process.env.ZERNIO_API_KEY = process.env.ZERNIO_API_KEY || 'test';

const mod = require(path.join('..', 'scripts', process.argv[2] || 'blotato-publish.js'));
let fails = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) fails++; };
const blotatoCalls = () => calls.filter((u) => u.includes('blotato')).length;
const post = (platform, accountId, url = 'local:C:/x.mp4') => mod.api('POST', '/posts', { post: { accountId, content: { text: 't', mediaUrls: [url], platform }, target: {} }, scheduledTime: new Date().toISOString() });

(async () => {
  const tmp = path.join(os.tmpdir(), `routes_${process.pid}.mp4`);
  fs.writeFileSync(tmp, 'x');
  const set = (cfg) => fs.writeFileSync(routes.ROUTES_PATH, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  try {
    set({ blotato: 'off', tiktok: { hold: true, keep: ['62703'] } });
    const r1 = await post('instagram', '1');
    check('인스타 → skip:blotato_off', r1.postSubmissionId === 'skip:blotato_off');
    const r2 = await post('facebook', '2');
    check('페북 → skip:blotato_off', r2.skipped === 'blotato_off');
    const r3 = await post('tiktok', '57391');
    check('틱톡(보류 계정) → skip:zernio_hold', r3.skipped === 'zernio_hold');
    const up = await mod.uploadLocalFile(tmp);
    check('uploadLocalFile → local: 표시, 호출 0', up.startsWith('local:') && calls.length === 0);
    const zu = await mod.zernioUpload(tmp);
    check('zernioUpload(보류 중) → local: 표시', zu.startsWith('local:') && calls.length === 0);
    const r4 = await post('tiktok', '62703', `local:${tmp}`);
    check('틱톡 keep 계정 → Zernio 업로드+글', String(r4.postSubmissionId).startsWith('zernio:') && calls.some((u) => u.includes('media/presign')));
    let threw = '';
    try { await mod.api('GET', '/users/me/accounts'); } catch (e) { threw = e.code; }
    check('그 밖의 Blotato 호출 → blotato_off 예외', threw === 'blotato_off');
    const st = await mod.api('GET', '/posts/skip:blotato_off');
    check('건너뛴 글 상태 조회 → skipped', st.status === 'skipped');
    check('Blotato 호출 0회', blotatoCalls() === 0);

    set({ blotato: 'off', tiktok: { hold: false } });
    const r5 = await post('tiktok', '99999');
    check('보류 해제 뒤 매핑 없는 틱톡 → skip:zernio_unmapped', r5.skipped === 'zernio_unmapped');
    const r6 = await post('tiktok', '57391', `local:${tmp}`);
    check('보류 해제 뒤 매핑 틱톡 → Zernio', String(r6.postSubmissionId).startsWith('zernio:'));
    check('여전히 Blotato 호출 0회', blotatoCalls() === 0);
  } finally {
    fs.rmSync(routes.ROUTES_PATH, { force: true });
    fs.rmSync(tmp, { force: true });
  }
  process.exit(fails ? 1 : 0);
})();
