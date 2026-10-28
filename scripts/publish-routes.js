'use strict';
// 발행 경로 스위치 — midform/config/publish_routes.json (관리자 배정 10-29: Blotato 끔·틱톡 Zernio 2계정 고를 때까지 보류).
// Blotato 를 부르는 모든 곳이 이걸 먼저 본다. 파일이 없거나 깨졌으면 예전대로(켜짐) 동작한다.
const fs = require('fs');
const path = require('path');

// PUBLISH_ROUTES_PATH: 시험용(tests/publish_routes_test.js 가 임시 파일로 바꿔 끼운다 — 실제 설정을 건드리지 않게)
const ROUTES_PATH = process.env.PUBLISH_ROUTES_PATH || path.join(__dirname, '..', 'midform', 'config', 'publish_routes.json');

function routes() {
  try { return JSON.parse(fs.readFileSync(ROUTES_PATH, 'utf8')); } catch { return {}; }
}
function blotatoOff() { return routes().blotato === 'off'; }
// 틱톡 글 하나를 어떻게 할지: '' = 보낸다, 아니면 건너뛸 이유(zernio_hold)
function tiktokHold(accountId) {
  const t = routes().tiktok || {};
  if (!t.hold) return '';
  return (t.keep || []).map(String).includes(String(accountId)) ? '' : 'zernio_hold';
}
// 실패가 아닌 «건너뜀» 결과 — 발행기들은 postSubmissionId 를 그대로 기록하므로 skip:<이유> 가 남는다
function skipped(reason) { return { postSubmissionId: `skip:${reason}`, id: `skip:${reason}`, skipped: reason, via: 'skip' }; }
function offError(what) {
  const e = new Error(`blotato_off: ${what} — Blotato 꺼짐(midform/config/publish_routes.json)`);
  e.code = 'blotato_off';
  return e;
}

module.exports = { ROUTES_PATH, routes, blotatoOff, tiktokHold, skipped, offError };
