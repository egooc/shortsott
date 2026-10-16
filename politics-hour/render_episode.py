"""정치 롱폼 렌더 실행기: 렌더하는 동안 RENDERING.lock 을 둔다(다른 세션이 무거운 작업 전에 확인한다).
   python render_episode.py episodes/20261015   (episode.json 이 있는 폴더, 로그는 그 안 render.log)"""
import datetime, json, os, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOCK = ROOT / 'RENDERING.lock'
ep = (ROOT / sys.argv[1]).resolve()
T0 = time.time()
LOCK.write_text(json.dumps({'pid': os.getpid(), 'episode': ep.name, 'started': time.strftime('%Y-%m-%d %H:%M'),
                            'expect_hours': 6}, ensure_ascii=False) + '\n', encoding='utf-8')
try:
    with open(ep / 'render.log', 'w', encoding='utf-8') as log:
        rc = subprocess.run([sys.executable, str(ROOT / 'overlay' / 'assemble_hour.py'), 'episode.json', '--tts', 'supertonic'],
                            cwd=ep, stdout=log, stderr=subprocess.STDOUT, env={**os.environ, 'PYTHONIOENCODING': 'utf-8'}).returncode
finally:
    LOCK.unlink(missing_ok=True)
# 관리자 성과 보고용 제작 장부(D:/midform/docs/production-ledger.md) — 렌더가 끝나면 한 줄. 업로드 뒤 youtube_id 를 같은 id 로 한 줄 더 쓴다.
if rc == 0:
    kst = datetime.timezone(datetime.timedelta(hours=9))
    iso = lambda s: datetime.datetime.fromtimestamp(s, kst).isoformat(timespec='seconds')
    brief = ep / 'BRIEF.md'
    gpt = ep / 'factcheck'
    rec = {'at': iso(time.time()), 'session': '정치', 'lane': 'politics_long', 'id': ep.name,
           'title': (ep / 'meta.txt').read_text(encoding='utf-8').splitlines()[0] if (ep / 'meta.txt').exists() else '',
           'started_at': iso(brief.stat().st_mtime if brief.exists() else T0), 'finished_at': iso(time.time()),
           'render_secs': round(time.time() - T0), 'gpt_calls': len(list(gpt.glob('*.md'))) if gpt.exists() else 0,
           'rejected': 0, 'note': 'started_at = BRIEF.md 시각(조사 시작 추정)'}
    with open('D:/midform/server/data/production_ledger.jsonl', 'a', encoding='utf-8') as f:
        f.write(json.dumps(rec, ensure_ascii=False) + '\n')
sys.exit(rc)
