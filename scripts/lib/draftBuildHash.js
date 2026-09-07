// 설치된 CapCut 드래프트의 빌드 해시 - 승인(publish_approvals)과 발행(auto-publish)이
// 같은 판을 보고 있음을 결속한다 (P0-2, owner directive 2026-09-07).
// draft_content.json + edit_manifest.json 이 영상 정의의 전부이므로 이 둘의 바이트가 곧 판이다.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function draftBuildHash(draftDir) {
  const files = ['draft_content.json', 'edit_manifest.json'];
  const hash = crypto.createHash('sha256');
  let found = 0;
  for (const name of files) {
    const p = path.join(draftDir, name);
    if (!fs.existsSync(p)) continue;
    hash.update(name);
    hash.update(fs.readFileSync(p));
    found += 1;
  }
  return found ? hash.digest('hex').slice(0, 16) : null;
}

module.exports = { draftBuildHash };
