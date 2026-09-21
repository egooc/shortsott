// 지난 제작물이 남긴 대용량 잔재를 정리한다. 기본은 보여주기만(dry-run), --delete 로 실제 삭제.
//
//   node scripts/cleanup-artifacts.js               무엇을 얼마나 지울지 보여주기만
//   node scripts/cleanup-artifacts.js --delete      실제 삭제
//   node scripts/cleanup-artifacts.js --keep-days 7 보존 기간(기본 7일)
//
// 무엇을 지우나
//   1) _automation factory 의 오래된 mp4 — 캡컷 시절(~2026-09-08) 내보내기. 유튜브 업로드 이력이 없는 것만.
//   2) 오래된 CapCut Drafts 폴더 — 위 mp4 와 짝인 드래프트 메타데이터.
//   3) 볼케이노 워크디렉토리의 무거운 중간물 — 원본 영상, 렌더 결과, 샘플/미리보기/검수 이미지, ASR 캐시.
//
// 무엇을 반드시 남기나
//   - `paid/` — TTS 영수증과 narration.wav. 서버가 "유료 접수 기록은 보존하라"고 반복해 지시한다.
//     지우면 같은 소스를 다시 만들 때 음성값을 또 지불한다.
//   - `*.json`, `captions.ass`, `logs/` — 재개와 추적에 쓰는 작은 파일들.
//   - 최근 --keep-days 안에 만든 것 전부.
//   - 유튜브에 올라간 이력이 있는 mp4(로컬 사본이라도 대조가 필요할 수 있다).
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const DRAFTS_DIR = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts');
const EXPORT_DIR = path.join(DRAFTS_DIR, '_automation factory');
const VOLCANO = path.join(os.homedir(), 'volcano-runs');
const YT_STATE = path.join(ROOT, 'server', 'data', 'auto_publish_state.json');

const doDelete = process.argv.includes('--delete');
// indexOf 가 -1 이면 argv[0](노드 경로)을 집어 NaN 이 된다 — 옵션이 있을 때만 읽는다.
const kdIdx = process.argv.indexOf('--keep-days');
const keepDays = kdIdx > 0 ? Number(process.argv[kdIdx + 1]) || 7 : 7;
const cutoff = new Date(Date.now() - keepDays * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const uploaded = new Set((readJson(YT_STATE, { history: [] }).history || []).map((h) => h.draft));

let bytes = 0; let count = 0;
const sizeOf = (p) => {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    return fs.readdirSync(p).reduce((a, n) => a + sizeOf(path.join(p, n)), 0);
  } catch { return 0; }
};
const kill = (p, why) => {
  const s = sizeOf(p);
  if (!s && !fs.existsSync(p)) return;
  bytes += s; count += 1;
  console.log(`${doDelete ? '삭제' : '대상'} ${(s / 1048576).toFixed(0).padStart(6)}MB  ${why}  ${path.basename(p)}`);
  if (doDelete) fs.rmSync(p, { recursive: true, force: true });
};

// 1) 오래된 내보내기 mp4 — 업로드 이력이 없는 것만
if (fs.existsSync(EXPORT_DIR)) {
  for (const f of fs.readdirSync(EXPORT_DIR)) {
    if (!f.endsWith('.mp4')) continue;
    if (f.slice(0, 8) >= cutoff) continue;
    if (uploaded.has(f.slice(0, -4))) continue;   // 올라간 적 있으면 남긴다
    kill(path.join(EXPORT_DIR, f), '옛 내보내기');
  }
}

// 2) 오래된 드래프트 폴더
if (fs.existsSync(DRAFTS_DIR)) {
  for (const d of fs.readdirSync(DRAFTS_DIR)) {
    if (!/^\d{8}[a-z]?-.+-(ko|ja)$/.test(d)) continue;
    if (d.slice(0, 8) >= cutoff) continue;
    if (uploaded.has(d)) continue;
    kill(path.join(DRAFTS_DIR, d), '옛 드래프트');
  }
}

// 3) 볼케이노 워크디렉토리의 무거운 중간물 — paid/ 와 작은 기록은 건드리지 않는다
// ★★2026-09-20 사고: 이 구간이 **보존 기간을 보지 않았고**, `final-*.mp4` 를 중간물로 지웠다.
//   명화관은 리프레임본(`midform_*.mp4`)이 따로 있어 맞는 가정이었지만, **어랍숏은 final 이 곧 완성본**이다.
//   그래서 30분 전에 만들어 소유주에게 보낸 어랍숏 두 편의 마스터가 지워졌다.
//   고친 것 둘: ① 워크디렉토리가 최근 keepDays 안에 손댄 것이면 통째로 건너뛴다.
//              ② 같은 edits 폴더에 리프레임본이 없으면 `final-*.mp4` 를 남긴다 — 그게 유일한 완성본이다.
const recentMs = keepDays * 864e5;
const touchedWithin = (p) => { try { return Date.now() - fs.statSync(p).mtimeMs < recentMs; } catch { return false; } };

if (fs.existsSync(VOLCANO)) {
  for (const w of fs.readdirSync(VOLCANO)) {
    const wd = path.join(VOLCANO, w);
    if (w === 'tools' || !fs.statSync(wd).isDirectory()) continue;
    if (touchedWithin(wd)) { console.log(`건너뜀 (최근 ${keepDays}일 작업)  ${w}`); continue; }
    for (const f of ['volcano_src.mp4', 'volcano_src.orig.mp4', 'word-audio']) kill(path.join(wd, f), `중간물 ${w}`);
    const editsDir = path.join(wd, 'edits');
    if (!fs.existsSync(editsDir)) continue;
    // 리프레임본이 워크디렉토리에 있으면 final 은 중간물이다. 없으면 final 이 완성본이다.
    const hasReframed = fs.readdirSync(wd).some((n) => /^midform_.*\.mp4$/.test(n));
    for (const e of fs.readdirSync(editsDir)) {
      const ed = path.join(editsDir, e);
      if (!fs.statSync(ed).isDirectory()) continue;
      for (const n of fs.readdirSync(ed)) {
        const isFinal = /^final-.*\.mp4$/.test(n);
        if (isFinal && !hasReframed) continue;          // ★유일한 완성본은 지우지 않는다
        if (isFinal || n === 'samples' || /^preview-/.test(n) || /^review-/.test(n)
            || /^master\.wav$/.test(n) || /^audio\.m4a$/.test(n)) {
          kill(path.join(ed, n), `중간물 ${w}`);
        }
      }
    }
  }
}

console.log(`\n${doDelete ? '삭제 완료' : '삭제 예정'}: ${count}건, ${(bytes / 1073741824).toFixed(2)}GB` +
  (doDelete ? '' : '  — 실제로 지우려면 --delete'));
