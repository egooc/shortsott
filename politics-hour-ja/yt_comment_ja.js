// 정치JA 공개 뒤 고정 댓글 — ko politics-hour/yt_comment.js 를 그대로 부른다(사본 금지).
// ko 도구는 업로드 프로필 purpose 'politics'(쟁점브리핑)를 고정으로 찾으므로, 프로필 파일을 읽을 때만
// politics_ja(国会ノート) 프로필을 그 이름으로 보이게 바꾼다. 인자는 ko 와 같다.
//   node politics-hour-ja/yt_comment_ja.js <videoId> <upload.json> [--wait]
const fs = require('fs');
const path = require('path');
const PROFILES = path.resolve(__dirname, '..', 'server', 'data', 'youtube_upload_profiles.json');
const read = fs.readFileSync;
fs.readFileSync = function (f, ...rest) {
  const out = read.call(this, f, ...rest);
  if (path.resolve(String(f)) !== PROFILES) return out;
  const store = JSON.parse(out);
  const ja = store.profiles.find((x) => x.purpose === 'politics_ja');
  if (!ja) throw new Error('유튜브 연결 없음(purpose politics_ja)');
  return JSON.stringify({ ...store, profiles: [{ ...ja, purpose: 'politics' }] });
};
require('../politics-hour/yt_comment');
