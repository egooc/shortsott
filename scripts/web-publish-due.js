// 슬롯 시각(08/12/18 KST)에 도는 얇은 실행기 — 지금이 발행 시각인 것만 브라우저로 올린다.
//
//   node scripts/web-publish-due.js
//
// 왜 따로 두나: 작업 스케줄러 한 칸에 사이트 두 개를 넣으려면 셸 연결(&&)이 필요한데, schtasks 의 /tr 은
// 따옴표 처리가 환경마다 달라 조용히 깨진다. 노드가 순서대로 부르는 편이 안전하다.
//
// 네이버는 업로드할 때 자체 '등록 예약'을 걸어 두므로 보통 여기서 할 일이 없다(안전망으로만 둔다).
// 페이스북 개인 프로필은 예약 기능이 없어 이 경로가 유일한 정시 발행 수단이다.
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SITES = ['facebook_profile', 'naverclip'];
let failed = 0;

for (const site of SITES) {
  console.log(`\n=== ${site} ${new Date().toISOString()}`);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'web-publish.js'), '--site', site, '--due'],
    { cwd: ROOT, encoding: 'utf8', timeout: 30 * 60 * 1000 });
  const all = `${r.stdout || ''}${r.stderr || ''}`;
  const out = all.split('\n')
    .filter((l) => /targets:|\[ok\]|\[fail\]|\[skip\]|report:/.test(l));
  console.log(out.join('\n') || '(출력 없음)');
  // ★자식이 죽으면 **왜 죽었는지 남긴다.** 예전에는 위 거르개가 오류를 통째로 버려서
  //   «(출력 없음)» 한 줄만 남았고, 그래서 이 슬롯이 2026-09-21 부터 3주 동안 죽어 있는
  //   것을 아무도 몰랐다(실측 2026-10-08). 거르개는 평소 로그를 짧게 하자는 것이지
  //   사고를 가리자는 것이 아니다.
  if (r.status !== 0) {
    failed += 1;
    const why = (r.error && r.error.message) ? r.error.message
      : all.split('\n').filter((l) => l.trim()).slice(-12).join('\n');
    console.log(`  ★${site} 실패 (exit ${r.status}) — 아래가 자식이 남긴 마지막 출력이다`);
    console.log(why.split('\n').map((l) => '    ' + l.slice(0, 200)).join('\n'));
  }
}

process.exit(failed ? 1 : 0);
