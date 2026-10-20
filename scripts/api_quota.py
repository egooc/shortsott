# -*- coding: utf-8 -*-
"""발굴용 키 쿼터 장부 — scripts/api_quota.js 의 파이썬판(같은 server/data/api_quota.jsonl · config/api_quota.json).

    import api_quota
    api_quota.spend('publish_hours', 'playlistItems')   # 상한·중지 상태면 QuotaStop, 아니면 기록
    api_quota.mark_blocked('publish_hours', 'videos 429')
    print(api_quota.summary())
"""
import datetime as _dt
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOG = ROOT / 'server' / 'data' / 'api_quota.jsonl'
CFG = ROOT / 'config' / 'api_quota.json'
LEDGER = ROOT / 'server' / 'data' / 'gate_errors.jsonl'
KST = _dt.timezone(_dt.timedelta(hours=9))


class QuotaStop(Exception):
    pass


def day():
    return _dt.datetime.now(KST).strftime('%Y-%m-%d')


def _rows(d=None):
    d = d or day()
    if not LOG.exists():
        return []
    out = []
    for line in LOG.read_text(encoding='utf-8').splitlines():
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if r.get('day') == d:
            out.append(r)
    return out


def used(d=None):
    by, total = {}, 0
    for r in _rows(d):
        if r.get('blocked'):
            continue
        by[r['tool']] = by.get(r['tool'], 0) + r.get('units', 0)
        total += r.get('units', 0)
    return total, by


def blocked(d=None):
    b = next((r for r in _rows(d) if r.get('blocked')), None)
    return f"{b['tool']} {b['blocked']}" if b else None


def _append(path, rec):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a', encoding='utf-8') as fh:
        fh.write(json.dumps(rec, ensure_ascii=False) + '\n')


def spend(tool, endpoint):
    c = json.loads(CFG.read_text(encoding='utf-8'))
    units = c['units']['search'] if endpoint == 'search' else c['units']['default']
    b = blocked()
    if b:
        raise QuotaStop(f'발굴 키 오늘 중지({b}) — 내일 KST 0시까지 호출 금지')
    total, by = used()
    cap = c['tools'].get(tool, c['tools']['other'])
    now = _dt.datetime.now().astimezone().isoformat(timespec='seconds')
    if by.get(tool, 0) + units > cap:
        _append(LEDGER, {'at': now, 'gate': 'api_quota', 'lane': tool, 'error': f'{tool} 하루 상한 {cap}단위 도달'})
        raise QuotaStop(f'{tool} 하루 상한 {cap}단위 도달')
    if total + units > c['day_total']:
        _append(LEDGER, {'at': now, 'gate': 'api_quota', 'lane': tool, 'error': f'발굴 키 전체 하루 상한 {c["day_total"]}단위 도달'})
        raise QuotaStop(f'발굴 키 전체 하루 상한 {c["day_total"]}단위 도달')
    _append(LOG, {'at': now, 'day': day(), 'tool': tool, 'endpoint': endpoint, 'units': units})
    return units


def mark_blocked(tool, why):
    now = _dt.datetime.now().astimezone().isoformat(timespec='seconds')
    _append(LOG, {'at': now, 'day': day(), 'tool': tool, 'endpoint': None, 'units': 0, 'blocked': why})
    _append(LEDGER, {'at': now, 'gate': 'api_quota', 'lane': tool, 'error': f'발굴 키 {why} — 오늘 남은 호출 전부 중지'})


def summary(d=None):
    d = d or day()
    c = json.loads(CFG.read_text(encoding='utf-8'))
    total, by = used(d)
    parts = ' · '.join(f"{t} {n}/{c['tools'].get(t, c['tools']['other'])}" for t, n in sorted(by.items(), key=lambda x: -x[1]))
    b = blocked(d)
    return f"발굴 키 쿼터 {d[5:]}: 계 {total}/{c['day_total']}" + (f' · {parts}' if parts else '') + (f' · ★중지: {b}' if b else '')
