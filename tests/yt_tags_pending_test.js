// 태그 관문 대기·감시: node tests/yt_tags_pending_test.js  (API 호출 없음, 임시 파일만 쓴다)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(process.env.TMP || os.tmpdir(), 'ytp-'));
process.env.YT_TAGS_PENDING_FILE = path.join(dir, 'pending.json');
process.env.YT_TAGS_HANDOFF_FILE = path.join(dir, 'handoff.md');
fs.writeFileSync(process.env.YT_TAGS_HANDOFF_FILE, '', 'utf8');
const P = require('../scripts/yt_tags_pending');
const MIN = 60e3;
const NOW = Date.parse('2026-10-31T13:00:00Z');
const at = (m) => new Date(NOW + m * MIN).toISOString();
const reported = () => fs.readFileSync(process.env.YT_TAGS_HANDOFF_FILE, 'utf8');

// 전파 지연 판정: 연금 1편 그대로 + 진짜 실패들
assert.strictEqual(P.isPropagating({ written: 18, expected: 18, read: 0, sameText: true }), true);
assert.strictEqual(P.isPropagating({ written: 18, expected: 18, read: 5, before: 5, sameText: true }), true, '옛 값이 읽힘');
assert.strictEqual(P.isPropagating({ written: 0, expected: 18, read: 0, sameText: true }), false, '쓰기 응답에 태그 없음');
assert.strictEqual(P.isPropagating({ written: 12, expected: 18, read: 0, sameText: true }), false, '쓰기 응답이 잘림');
assert.strictEqual(P.isPropagating({ written: 18, expected: 18, read: 0, sameText: false }), false, '제목·설명이 바뀜');
assert.strictEqual(P.isPropagating({ written: 18, expected: 18, read: 7, sameText: true }), false, '일부만 읽힘');

// 기다릴 수 있나
assert.strictEqual(P.canWait({ privacyStatus: 'private', publishAt: at(120) }, NOW), true);
assert.strictEqual(P.canWait({ privacyStatus: 'private', publishAt: at(20) }, NOW), false, '공개 임박');
assert.strictEqual(P.canWait({ privacyStatus: 'private', publishAt: null }, NOW), true);
assert.strictEqual(P.canWait({ privacyStatus: 'public', publishAt: null }, NOW), false, '이미 공개');

// 다음 할 일
const it = { expected: 18, before: 0, added_at: at(-30) };
assert.strictEqual(P.decide(it, null, NOW).act, 'gone');
assert.strictEqual(P.decide(it, { tags: 18, privacyStatus: 'private', publishAt: at(600) }, NOW).act, 'confirmed');
assert.strictEqual(P.decide(it, { tags: 0, privacyStatus: 'private', publishAt: at(600) }, NOW).act, 'wait');
assert.strictEqual(P.decide(it, { tags: 0, privacyStatus: 'private', publishAt: at(15) }, NOW).act, 'cancel');
assert.strictEqual(P.decide(it, { tags: 7, privacyStatus: 'private', publishAt: at(15) }, NOW).act, 'partial', '0개가 아니면 취소 안 함');
assert.strictEqual(P.decide(it, { tags: 0, privacyStatus: 'public', publishAt: null }, NOW).act, 'public_zero');
assert.strictEqual(P.decide({ ...it, added_at: at(-400) }, { tags: 0, privacyStatus: 'private', publishAt: null }, NOW).act, 'give_up');
assert.strictEqual(P.decide({ ...it, before: 5 }, { tags: 5, privacyStatus: 'private', publishAt: at(15) }, NOW).act, 'cancel', '옛 값 그대로면 태그가 안 들어간 것');

(async () => {
  const quiet = () => {};
  // 대기 목록이 비면 API 를 안 부른다
  let calls = 0;
  await P.tick({ api: { read: async () => { calls++; }, cancel: async () => { calls++; } }, now: NOW, log: quiet });
  assert.strictEqual(calls, 0);

  // 30분 뒤 전파: 기다리다 확인되면 취소 없이 끝난다
  P.add({ videoId: 'vid_late', purpose: 'p', expected: 18, title: '연금' });
  let tags = 0, cancelled = 0;
  const api = { read: async () => ({ tags, privacyStatus: 'private', publishAt: at(1000) }), cancel: async () => { cancelled++; return { ok: true }; } };
  assert.deepStrictEqual(await P.tick({ api, now: NOW, log: quiet }), { done: 0, left: 1 });
  tags = 18;
  assert.deepStrictEqual(await P.tick({ api, now: NOW, log: quiet }), { done: 1, left: 0 });
  assert.strictEqual(cancelled, 0);
  assert.strictEqual(P.readAll().length, 0);
  assert.match(reported(), /태그 18개 확인/);

  // 공개 임박까지 0개면 취소하고 보고한다
  P.add({ videoId: 'vid_zero', purpose: 'p', expected: 18, title: '안 들어감' });
  const api2 = { read: async () => ({ tags: 0, privacyStatus: 'private', publishAt: at(10) }), cancel: async () => { cancelled++; return { ok: true, was: at(10) }; } };
  await P.tick({ api: api2, now: NOW, log: quiet });
  assert.strictEqual(cancelled, 1);
  assert.strictEqual(P.readAll().length, 0);
  assert.match(reported(), /예약 취소/);

  // 취소 실패는 목록에 남겨 다음 주기에 다시
  P.add({ videoId: 'vid_fail', purpose: 'p', expected: 18 });
  await P.tick({ api: { read: api2.read, cancel: async () => ({ ok: false, why: '403' }) }, now: NOW, log: quiet });
  assert.strictEqual(P.readAll().length, 1);
  assert.match(reported(), /예약 취소 실패/);

  // 읽기 실패(429 등)는 재시도 없이 남긴다, 도는 사이 들어온 줄은 안 지운다
  let reads = 0;
  await P.tick({ api: { read: async () => { reads++; throw new Error('읽기 429'); }, cancel: async () => {} }, now: NOW, log: quiet });
  assert.strictEqual(reads, 1);
  assert.strictEqual(P.readAll().length, 1);
  const before = P.readAll()[0].videoId;
  await P.tick({ api: { read: async () => { P.add({ videoId: 'vid_new', purpose: 'p', expected: 3 }); return { tags: 18, privacyStatus: 'private', publishAt: at(100) }; }, cancel: async () => {} }, now: NOW, log: quiet });
  const ids = P.readAll().map((x) => x.videoId);
  assert.ok(ids.includes('vid_new') && !ids.includes(before));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('yt_tags_pending_test OK');
})().catch((e) => { console.error(e); process.exit(1); });
