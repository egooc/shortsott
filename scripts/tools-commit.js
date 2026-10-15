#!/usr/bin/env node
// 도구개발 커밋 래퍼 — 검사·테스트가 전부 종료 코드 0 일 때만 경로 지정 커밋(+푸시).
//
//   node scripts/tools-commit.js --test "python tests/x_test.py" [--test "..."] (--msg "제목" | --msg-file m.txt) [--push] -- <경로>...
//
// - 항상 먼저 `npm run check:encoding`, 그다음 --test 를 순서대로. 출력은 거르지 않고 그대로 보인다.
// - 하나라도 0 이 아니면 커밋하지 않고 그 종료 코드로 끝난다. tail·grep 을 거치지 않으므로 종료 코드가 가려지지 않는다.
// - 커밋은 `git add -- <경로>` → `git commit -F <메시지> -- <경로>`(남의 스테이징을 섞지 않는다). rebase·force 없음.
// 왜 (2026-10-16 관리자): 실패 테스트를 단 커밋이 두 번(61dfa18·275fd89) — `test | tail && git commit` 은 tail 의 종료 코드로 커밋된다.
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function parse(argv) {
  const a = { tests: [], msg: null, msgFile: null, push: false, paths: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--') { a.paths = argv.slice(i + 1); break; }
    if (x === '--test') a.tests.push(argv[++i]);
    else if (x === '--msg') a.msg = argv[++i];
    else if (x === '--msg-file') a.msgFile = argv[++i];
    else if (x === '--push') a.push = true;
    else throw new Error('모르는 인자: ' + x);
  }
  return a;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: opts.shell || false });
  return r.status === null ? 1 : r.status;
}

function main() {
  let a;
  try { a = parse(process.argv.slice(2)); } catch (e) { console.error(e.message); return 2; }
  if (!a.tests.length || !a.paths.length || !(a.msg || a.msgFile)) {
    console.error('사용: node scripts/tools-commit.js --test "<명령>" (--msg "<메시지>" | --msg-file <파일>) [--push] -- <경로>...');
    return 2;
  }
  const steps = ['npm run check:encoding', ...a.tests];
  for (const s of steps) {
    console.log(`\n[tools-commit] ▶ ${s}`);
    const code = run(s, [], { shell: true });
    if (code !== 0) {
      console.error(`\n[tools-commit] ✗ 종료 코드 ${code}: ${s} — 커밋하지 않는다`);
      return code;
    }
  }
  let msgPath = a.msgFile && path.resolve(a.msgFile);
  if (!msgPath) {
    msgPath = path.join(os.tmpdir(), `tools-commit-${process.pid}.txt`);
    fs.writeFileSync(msgPath, a.msg.endsWith('\n') ? a.msg : a.msg + '\n', 'utf8');
  }
  let code = run('git', ['add', '--', ...a.paths]);
  if (code === 0) code = run('git', ['commit', '-F', msgPath, '--', ...a.paths]);
  if (!a.msgFile) fs.rmSync(msgPath, { force: true });
  if (code !== 0) { console.error(`[tools-commit] ✗ git 종료 코드 ${code}`); return code; }
  if (a.push) {
    code = run('git', ['push']);
    if (code !== 0) { console.error(`[tools-commit] ✗ push 종료 코드 ${code} — 커밋은 됐다`); return code; }
  }
  spawnSync('git', ['log', '-1', '--format=[tools-commit] ✓ %h %s'], { cwd: ROOT, stdio: 'inherit' });
  return 0;
}

process.exit(main());
