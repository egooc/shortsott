// 사람 검수 승인 대장 (owner directive 2026-09-07: 검수가 예약보다 앞).
//
//   node scripts/approve-publish.js <draftName> [<draftName> ...]   승인 기록
//   node scripts/approve-publish.js --list                          승인 대기 목록
//   node scripts/approve-publish.js --revoke <draftName>            승인 철회
//
// auto-publish 는 이 대장에 있는 드래프트만 업로드·예약한다. 승인은 mp4 를 본 사람이
// 하는 것이므로, 이 스크립트는 소유주(또는 소유주 지시를 받은 세션)만 부른다.
// P0-2 (2026-09-08): 승인은 그 순간 설치돼 있는 판의 build hash 에 결속된다.
// 같은 이름으로 재설치되면 auto-publish 가 해시 불일치로 승인을 자동 무효화한다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { draftBuildHash } = require('./lib/draftBuildHash');

const ROOT = path.join(__dirname, '..');
const APPROVALS_PATH = path.join(ROOT, 'server', 'data', 'publish_approvals.json');
const DRAFTS_DIR = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts');
const EXPORT_DIR = path.join(DRAFTS_DIR, '_automation factory');
const STATE_PATH = path.join(ROOT, 'server', 'data', 'auto_publish_state.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeApprovals(approvals) {
  fs.mkdirSync(path.dirname(APPROVALS_PATH), { recursive: true });
  fs.writeFileSync(APPROVALS_PATH, `${JSON.stringify(approvals, null, 2)}\n`, 'utf8');
}

function main() {
  const args = process.argv.slice(2);
  const approvals = readJson(APPROVALS_PATH, {});

  if (args.includes('--list') || !args.length) {
    const published = new Set((readJson(STATE_PATH, { history: [] }).history || []).map((h) => h.draft));
    const exported = fs.existsSync(EXPORT_DIR)
      ? fs.readdirSync(EXPORT_DIR).filter((f) => /^\d{8}[a-z]?-.+-(ko|ja)\.mp4$/.test(f)).map((f) => f.replace(/\.mp4$/, ''))
      : [];
    const pending = exported.filter((name) => !approvals[name] && !published.has(name));
    console.log(`승인 대기 ${pending.length}건:`);
    for (const name of pending) console.log(`  node scripts/approve-publish.js "${name}"`);
    const approved = Object.keys(approvals).filter((name) => !published.has(name));
    if (approved.length) console.log(`\n승인됨(미발행) ${approved.length}건: ${approved.join(', ')}`);
    return;
  }

  if (args[0] === '--revoke') {
    for (const name of args.slice(1)) {
      if (approvals[name]) { delete approvals[name]; console.log(`철회: ${name}`); }
      else console.log(`대장에 없음: ${name}`);
    }
    writeApprovals(approvals);
    return;
  }

  for (const name of args) {
    const draftDir = path.join(DRAFTS_DIR, name);
    const buildHash = draftBuildHash(draftDir);
    if (!buildHash) {
      console.log(`거부: ${name} — 설치된 드래프트가 없어 해시를 만들 수 없다 (승인은 실물에만 한다)`);
      continue;
    }
    approvals[name] = { approved_at: new Date().toISOString(), build_hash: buildHash };
    console.log(`승인: ${name} (build ${buildHash})`);
  }
  writeApprovals(approvals);
}

main();
