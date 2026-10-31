// shop_yt_tags 전파 대기를 가짜 유튜브 API 로 돌려 본다: node tests/shop_yt_tags_wait_test.js
// 실제 API·토큰·작업 스케줄러를 쓰지 않는다(인증 라이브러리·fetch·대기·child_process 를 바꿔 끼운다). 대기 목록·대기열·인계 파일은 임시 파일.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tool = path.resolve(__dirname, '../scripts/shop_yt_tags.js');
const dir = fs.mkdtempSync(path.join(process.env.TMP || os.tmpdir(), 'shoptags-'));
const meta = path.join(dir, 'ffrefT.json');
fs.writeFileSync(meta, JSON.stringify({ file: path.join(dir, 'ffrefT', 'a.mp4'), title: '제목', tags: ['가위', '나무', '다리'] }), 'utf8');
const preload = path.join(dir, 'mock.js');
fs.writeFileSync(preload, `
const Module = require('module'); const fs = require('fs');
const load = Module._load;
Module._load = function (req, ...a) {
  if (/google-auth-library/.test(req)) return { OAuth2Client: class { setCredentials() {} async getAccessToken() { return { token: 'x' }; } } };
  if (req === 'child_process') return { ...load.call(this, req, ...a),
    spawn: (exe, args) => { fs.appendFileSync(process.env.CALLS, 'spawn ' + args.slice(1).join(' ') + '\\n'); return { unref() {} }; },
    spawnSync: (exe, args) => { fs.appendFileSync(process.env.CALLS, exe + ' ' + args.join(' ') + '\\n'); return { status: 0 }; } };
  return load.call(this, req, ...a);
};
const realTimeout = global.setTimeout; const realNow = Date.now; let skew = 0;
Date.now = () => realNow() + skew;
global.setTimeout = (f, ms, ...a) => { skew += ms || 0; return realTimeout(f, 0, ...a); };
const C = JSON.parse(process.env.MOCK);
const res = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
const list = (n) => Array.from({ length: n }, (_, i) => 't' + i);
let wrote = !!C.wrote, reads = 0, cancelled = false;
global.fetch = async (url, init = {}) => {
  if (init.method === 'PUT' && /part=snippet/.test(url)) { wrote = true; return res({ snippet: { tags: list(C.written) } }); }
  if (init.method === 'PUT' && /part=status/.test(url)) { fs.appendFileSync(process.env.CALLS, 'PUT ' + init.body + '\\n'); cancelled = JSON.parse(init.body).status.publishAt === null; return res({ status: {} }); }
  if (wrote && /part=snippet/.test(url)) reads++;
  const n = !wrote ? 0 : (C.lateAfter && reads > C.lateAfter ? 3 : C.read);
  return res({ items: [{ id: 'V', snippet: { title: 'T', description: 'D', categoryId: '26', tags: list(n) },
    status: { privacyStatus: C.privacy, publishAt: cancelled ? undefined : C.publishAt, embeddable: true, license: 'youtube', publicStatsViewable: true, madeForKids: false } }] });
};
`, 'utf8');

function run(name, C, args, code) {
  const f = (x) => path.join(dir, `${name}.${x}`);
  fs.writeFileSync(f('queue'), JSON.stringify({ items: [{ meta, videoId: 'V', publishAt: C.publishAt }] }), 'utf8');
  if (C.watcher) fs.writeFileSync(`${f('pending')}.heartbeat`, 'x', 'utf8');
  if (C.pending) fs.writeFileSync(f('pending'), JSON.stringify([{ videoId: 'V', purpose: 'shopping', expected: 3, before: 0, added_at: new Date().toISOString() }]), 'utf8');
  const scripts = { gate: `require(${JSON.stringify(tool)}).ensureTags('V', ${JSON.stringify(meta)}).then((n) => console.log('RESULT', n))`,
    hold: `require(${JSON.stringify(tool)}).holdPrivate('V').then((ok) => console.log('HELD', ok))` };
  const argv = scripts[args] ? ['-r', preload, '-e', scripts[args]] : ['-r', preload, tool, ...args];
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 60e3, env: { ...process.env, MOCK: JSON.stringify(C), CALLS: f('calls'),
    YT_TAGS_PENDING_FILE: f('pending'), YT_TAGS_HANDOFF_FILE: f('handoff'), SHOP_TAGS_QUEUE: f('queue'), SHOP_TAGS_WAIT_LOG: f('log') } });
  const read = (x) => (fs.existsSync(f(x)) ? fs.readFileSync(f(x), 'utf8') : '');
  if (code !== undefined) assert.strictEqual(r.status, code, r.stdout + r.stderr);
  return { out: r.stdout + r.stderr, calls: read('calls'), handoff: read('handoff'), pending: read('pending') ? JSON.parse(read('pending')) : [], queue: JSON.parse(read('queue')) };
}
const hours = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const WAIT = ['--wait-propagation', 'V', meta, '3'];

// 관문: 쓰기 3개·읽기 0개·예약 많이 남음 → 쓴 개수를 돌려주고 예약은 그대로, 백그라운드를 띄운다
let r = run('handoff', { written: 3, read: 0, privacy: 'private', publishAt: hours(10) }, 'gate');
assert.match(r.out, /RESULT 3/, r.out);
assert.match(r.calls, /spawn --wait-propagation V/);
assert.doesNotMatch(r.calls, /PUT/);
assert.strictEqual(r.pending[0].videoId, 'V');

// 관문: 감시가 살아 있으면 띄우지 않고 넘긴다
r = run('watcher', { written: 3, read: 0, privacy: 'private', publishAt: hours(10), watcher: true }, 'gate');
assert.match(r.out, /RESULT 3/, r.out);
assert.match(r.out, /감시로 넘김/);
assert.doesNotMatch(r.calls, /spawn/);

// 관문: 공개가 20분 안이면 기다리지 않고 0 을 돌려준다(3분 대기 뒤 판정)
r = run('soon', { written: 3, read: 0, privacy: 'private', publishAt: new Date(Date.now() + 22 * 60e3).toISOString() }, 'gate');
assert.match(r.out, /RESULT 0/, r.out);
assert.strictEqual(r.pending.length, 0);

// 관문: 쓰기 응답이 비면 전파 지연이 아니다
r = run('notwritten', { written: 0, read: 0, privacy: 'private', publishAt: hours(10) }, 'gate');
assert.match(r.out, /RESULT 0/, r.out);
assert.doesNotMatch(r.calls, /spawn/);

// holdPrivate: publishAt:null 을 보낸다
r = run('hold', { wrote: true, read: 0, privacy: 'private', publishAt: hours(10) }, 'hold');
assert.match(r.out, /HELD true/, r.out);
assert.match(r.calls, /"publishAt":null/);

// 대기: 늦게 보이면 취소 없이 끝난다
r = run('late', { wrote: true, read: 0, lateAfter: 15, privacy: 'private', publishAt: hours(17), pending: true }, WAIT, 0);
assert.doesNotMatch(r.calls, /PUT/);
assert.match(r.handoff, /태그 3\/3개 확인/);
assert.strictEqual(r.pending.length, 0);
assert.strictEqual(r.queue.items[0].blocked, undefined);

// 대기: 끝내 0개면 예약을 거두고 네이버 작업을 지우고 대기열에 막힘으로 적는다
r = run('zero', { wrote: true, read: 0, privacy: 'private', publishAt: hours(17), pending: true }, WAIT, 2);
assert.match(r.calls, /"publishAt":null/);
assert.match(r.calls, /schtasks \/Delete \/TN midform-shop-naver-ffrefT \/F/);
assert.strictEqual(r.queue.items[0].blocked, 'tags');
assert.strictEqual(r.queue.items[0].publishAt, '');
assert.match(r.handoff, /★V 기다려도 태그 0개/);
assert.strictEqual(r.pending.length, 0);

fs.rmSync(dir, { recursive: true, force: true });
console.log('shop_yt_tags 전파 대기 시험 통과');
