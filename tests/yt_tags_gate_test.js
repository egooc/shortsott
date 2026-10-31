// politics-hour/yt_tags.js --gate 를 가짜 유튜브 API 로 끝까지 돌려 본다: node tests/yt_tags_gate_test.js
// 실제 API·토큰을 쓰지 않는다(인증 라이브러리·fetch·대기를 바꿔 끼운다). 대기 목록은 임시 파일.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(process.env.TMP || os.tmpdir(), 'ytg-'));
const tool = process.env.YT_TAGS_TOOL || path.resolve(__dirname, '../politics-hour/yt_tags.js');
const meta = path.join(dir, 'upload.json');
fs.writeFileSync(meta, JSON.stringify({ tags: Array.from({ length: 18 }, (_, i) => `t${i}`) }), 'utf8');
const preload = path.join(dir, 'mock.js');
fs.writeFileSync(preload, `
const Module = require('module'); const fs = require('fs');
const load = Module._load;
Module._load = function (req, ...a) {
  if (/google-auth-library/.test(req)) return { OAuth2Client: class { setCredentials() {} async getAccessToken() { return { token: 'x' }; } } };
  return load.call(this, req, ...a);
};
const realTimeout = global.setTimeout; const realNow = Date.now; let skew = 0;
Date.now = () => realNow() + skew;
global.setTimeout = (f, ms, ...a) => { skew += ms || 0; return realTimeout(f, 0, ...a); };
let reads = 0;
const C = JSON.parse(process.env.MOCK);
const res = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
const snippet = (tags) => ({ title: 'T', description: 'D', categoryId: '27', tags });
const list = (n) => Array.from({ length: n }, (_, i) => 't' + i);
let wrote = false;
global.fetch = async (url, init = {}) => {
  if (init.method === 'PUT' && /part=snippet/.test(url)) { wrote = true; return res({ snippet: snippet(list(C.written)) }); }
  if (init.method === 'PUT' && /part=status/.test(url)) { fs.appendFileSync(process.env.PUTS, init.body + '\\n'); return res({ status: {} }); }
  const after = fs.existsSync(process.env.PUTS);
  if (wrote && /part=snippet/.test(url)) reads++;
  return res({ items: [{ id: 'V', snippet: snippet(list(!wrote ? (C.before || 0) : (C.lateAfter && reads > C.lateAfter ? C.written : C.read))),
    status: { privacyStatus: C.privacy, publishAt: after ? undefined : C.publishAt, embeddable: true, license: 'youtube', publicStatsViewable: true, madeForKids: false },
    processingDetails: { processingStatus: 'succeeded' } }] });
};
`, 'utf8');

function run(name, C) {
  const pendingFile = path.join(dir, `${name}.json`), puts = path.join(dir, `${name}.puts`);
  if (C.watcher) fs.writeFileSync(`${pendingFile}.heartbeat`, 'x', 'utf8');
  const r = spawnSync(process.execPath, ['-r', preload, tool, 'V', meta, '--gate'], { encoding: 'utf8', env: { ...process.env, MOCK: JSON.stringify(C), YT_TAGS_PENDING_FILE: pendingFile, PUTS: puts }, timeout: 60e3 });
  return { code: r.status, out: r.stdout + r.stderr, pending: fs.existsSync(pendingFile) ? JSON.parse(fs.readFileSync(pendingFile, 'utf8')) : [], puts: fs.existsSync(puts) ? fs.readFileSync(puts, 'utf8') : '' };
}
const hours = (h) => new Date(Date.now() + h * 3600e3).toISOString();

// 감시 없음: 관문이 직접 기다려, 30분쯤 뒤 보이면 취소 없이 끝낸다(연금 1편 그대로)
let r = run('wait_ok', { written: 18, read: 0, lateAfter: 33, privacy: 'private', publishAt: hours(17) });
assert.strictEqual(r.code, 0, r.out);
assert.match(r.out, /전파 대기/);
assert.match(r.out, /확인 18개\(전파 지연 뒤\)/);
assert.strictEqual(r.puts, '');
assert.strictEqual(r.pending.length, 0);

// 감시 없음: 끝내 0개면 한도(47분) 뒤 취소한다 — 태그 0개면 공개 안 한다
r = run('wait_zero', { written: 18, read: 0, privacy: 'private', publishAt: hours(17) });
assert.strictEqual(r.code, 2, r.out);
assert.match(r.out, /기다려도 0개/);
assert.strictEqual(JSON.parse(r.puts).status.publishAt, null);
assert.strictEqual(r.pending.length, 0);

// 감시 돎: 예약 유지, 넘기고 바로 끝
r = run('late', { written: 18, read: 0, watcher: true, privacy: 'private', publishAt: hours(17) });
assert.strictEqual(r.code, 0, r.out);
assert.match(r.out, /감시로 넘김/);
assert.strictEqual(r.puts, '', '예약을 건드리면 안 된다');
assert.strictEqual(r.pending[0].expected, 18);
assert.strictEqual(r.pending[0].purpose, 'politics');

// 바로 읽힘 → 평소대로
r = run('ok', { written: 18, read: 18, privacy: 'private', publishAt: hours(17) });
assert.strictEqual(r.code, 0, r.out);
assert.strictEqual(r.pending.length, 0);
assert.strictEqual(r.puts, '');

// 쓰기 응답에 태그가 없으면 진짜 실패 → 바로 취소, publishAt:null 포함
r = run('nowrite', { written: 0, read: 0, privacy: 'private', publishAt: hours(17) });
assert.strictEqual(r.code, 2, r.out);
assert.strictEqual(r.pending.length, 0);
assert.strictEqual(JSON.parse(r.puts).status.publishAt, null);
assert.match(r.out, /공개 예약 취소/);

// 공개 임박이면 쓰기가 정상이어도 지금 취소
r = run('soon', { written: 18, read: 0, privacy: 'private', publishAt: hours(0.2) });
assert.strictEqual(r.code, 2, r.out);
assert.strictEqual(r.pending.length, 0);

// 쓰기 전 옛 값이 그대로 읽히는 것도 전파 지연
r = run('stale', { written: 18, before: 5, read: 5, watcher: true, privacy: 'private', publishAt: hours(17) });
assert.strictEqual(r.code, 0, r.out);
assert.strictEqual(r.pending[0].before, 5);

// 일부만 읽힘은 전파 지연으로 보지 않는다(기존 관문 그대로)
r = run('partial', { written: 18, read: 7, privacy: 'private', publishAt: hours(17) });
assert.strictEqual(r.code, 2, r.out);

fs.rmSync(dir, { recursive: true, force: true });
console.log('yt_tags_gate_test OK');
