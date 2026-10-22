"""정치 롱폼 렌더 실행기: 렌더하는 동안 RENDERING.lock 을 둔다(다른 세션이 무거운 작업 전에 확인한다).
   python render_episode.py episodes/20261015   (episode.json 이 있는 폴더, 로그는 그 안 render.log)"""
import datetime, json, os, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOCK = ROOT / 'RENDERING.lock'
ep = (ROOT / sys.argv[1]).resolve()
T0 = time.time()
sys.path.insert(0, str(ROOT)); import uncertain_facts   # noqa: E402  불확실 팩트 0건이어야 TTS(G4, 10/23편부터) — 락을 쓰기 전에 막는다
_fact = uncertain_facts.gate_lines(ep)
if _fact:
    print('\n'.join('[fact] FAIL ' + b for b in _fact)); sys.exit(3)
LOCK.write_text(json.dumps({'pid': os.getpid(), 'episode': ep.name, 'started': time.strftime('%Y-%m-%d %H:%M'),
                            'expect_hours': 6}, ensure_ascii=False) + '\n', encoding='utf-8')
try:
    with open(ep / 'render.log', 'w', encoding='utf-8') as log:
        rc = subprocess.run([sys.executable, str(ROOT / 'overlay' / 'assemble_hour.py'), 'episode.json', '--tts', 'supertonic'],
                            cwd=ep, stdout=log, stderr=subprocess.STDOUT, env={**os.environ, 'PYTHONIOENCODING': 'utf-8'}).returncode
    # ★후처리(L컷·역전사·음량·무음 검사)도 무거운 작업이라 락을 끝까지 둔다(10-19 실측: 락이 먼저 풀려 다른 세션이 끼어들 수 있었다)
    # 관리자 성과 보고용 제작 장부(D:/midform/docs/production-ledger.md) — 렌더가 끝나면 한 줄. 업로드 뒤 youtube_id 를 같은 id 로 한 줄 더 쓴다.
    if rc == 0 and json.loads((ep / 'episode.json').read_text(encoding='utf-8')).get('lcut'):   # L컷 꼬리(episode.json "lcut": 0.3~0.5, 10/20편부터) — 음량 정규화 전에
        sys.path.insert(0, str(ROOT / 'overlay'))
        import lcut
        with open(ep / 'render.log', 'a', encoding='utf-8') as log:
            log.write('[lcut] %s\n' % lcut.apply(ep, json.loads((ep / 'episode.json').read_text(encoding='utf-8'))['lcut']))
    if rc == 0 and json.loads((ep / 'episode.json').read_text(encoding='utf-8')).get('tts_say'):   # 해설 역전사 숫자·고유명사 대조 → audit/result.json(upload_gate 가 읽는다)
        with open(ep / 'render.log', 'a', encoding='utf-8') as log:
            subprocess.run([sys.executable, '-X', 'utf8', str(ROOT / 'overlay' / 'tts_audit.py'), str(ep)], stdout=log, stderr=subprocess.STDOUT)
    if rc == 0:   # 마지막 음량 정규화 -14 LUFS(카이안 K12, 10-19 — 조각별 loudnorm -16 만으로는 완성본이 -16.3이었다)
        sys.path.insert(0, 'D:/midform/scripts')
        import loudnorm_final
        with open(ep / 'render.log', 'a', encoding='utf-8') as log:
            log.write('[loudnorm] %s\n' % loudnorm_final.normalize(ep / 'work' / 'episode.mp4'))
    if rc == 0:   # 무음 갭 검사(gap_check.py) — 결과만 render.log 에 남기고 렌더 성공은 그대로 둔다(10/17부터)
        with open(ep / 'render.log', 'a', encoding='utf-8') as log:
            subprocess.run([sys.executable, str(ROOT / 'gap_check.py'), str(ep)], stdout=log, stderr=subprocess.STDOUT,
                           env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
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
finally:
    # 하이퍼프레임 임시 폴더(%TEMP%/hf-render-*)는 렌더가 끝나도 남아 C: 를 채웠다(10-20 0.7GB 사고) — 이 렌더 동안 만들어진 것만 지운다
    import shutil, tempfile
    for d in Path(tempfile.gettempdir()).glob('hf-render-*'):
        try:
            if d.is_dir() and d.stat().st_ctime >= T0 - 5:
                shutil.rmtree(d, ignore_errors=True)
        except OSError:
            pass
    LOCK.unlink(missing_ok=True)
    # 락을 지운 즉시 §10 한 줄 — 남은 밤 창은 수창 롱폼이 쓰고, 수창 관문이 이 줄을 읽는다(10-22 관리자: «- 정치 ko(HH:MM): M/DD 렌더 끝 …»)
    try:
        _rc = globals().get('rc', 'x')
        _d = f'{int(ep.name[4:6])}/{ep.name[6:8]}' if ep.name.isdigit() and len(ep.name) == 8 else ep.name
        with open('D:/midform/docs/handoff-manager-20261014.md', 'a', encoding='utf-8') as f:
            f.write(f'- 정치 ko({time.strftime("%H:%M")}): {_d} 렌더 끝 — {"성공" if _rc == 0 else f"실패 rc={_rc}"}, 락 해제 ({round((time.time() - T0) / 60)}분)\n')
    except Exception as e:   # 줄 쓰기 실패가 렌더 결과를 바꾸면 안 된다
        print('[render] §10 줄 실패', e)
sys.exit(rc)
