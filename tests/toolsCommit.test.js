// tools-commit.js — 실패하는 테스트면 git 까지 가지 않고 그 종료 코드로 끝나는지.
'use strict';
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const W = path.join(ROOT, 'scripts', 'tools-commit.js');
const head = () => spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();

const before = head();
let r = spawnSync(process.execPath, [W, '--test', 'node -e "process.exit(3)"', '--msg', 'x', '--', 'scripts/tools-commit.js'],
  { cwd: ROOT, encoding: 'utf8' });
assert.strictEqual(r.status, 3, r.stdout + r.stderr);
assert.match(r.stderr, /커밋하지 않는다/);
assert.strictEqual(head(), before);

// 출력이 많고 마지막 줄이 정상처럼 보여도 종료 코드만 본다(tail 함정)
r = spawnSync(process.execPath, [W, '--test', 'node -e "console.log(\'OK\');process.exit(1)"', '--msg', 'x', '--', 'scripts/tools-commit.js'],
  { cwd: ROOT, encoding: 'utf8' });
assert.strictEqual(r.status, 1);
assert.strictEqual(head(), before);

r = spawnSync(process.execPath, [W, '--msg', 'x', '--', 'a'], { cwd: ROOT, encoding: 'utf8' });
assert.strictEqual(r.status, 2);
console.log('toolsCommit.test ok');
