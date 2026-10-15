"""롱폼 에셋별 쇼츠 경쟁 강도 — 이 사람·채널로 «최근 한 달 쇼츠를 올린 남의 채널»이 몇 개인가.

  python scripts/longform_competition.py "순자엄마@순자엄마" "강나미@강나미|상화" ... [--owner UCxxx,...] [--period month]
  검색어@토큰1|토큰2 — 제목·설명에 토큰이 실제로 든 결과만 센다(기본 토큰 = 띄어쓰기 뺀 검색어).
  --from-scout : longform_scout.json 상위 채널을 자동으로 검사(검색어 = 채널명, 주인 채널 제외).

판정은 rinbox-competition.js 와 같은 결: 수요(그 에셋 쇼츠가 얼마나 나오나) × 공급(올리는 남의 채널 수).
API 0원: 유튜브 웹 검색(innertube)의 «Shorts» 유형 필터 + 기간. yt-dlp 검색은 Shorts 선반을 버려서
(«4분 미만» 필터로 쯔양이 21편·전부 방송사 클립으로 나왔다) 쓸 수 없다. 채널은 oEmbed 로 붙인다.
"""
import argparse
import json
import re
import statistics
import sys
import base64
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from longform_scout import OFFICIAL, man  # noqa: E402

norm = lambda s: re.sub(r"\s+", "", (s or "").lower())  # noqa: E731


UPLOAD = {"week": 3, "month": 4, "year": 5}
CLIENT = {"clientName": "WEB", "clientVersion": "2.20261001.00.00", "hl": "ko", "gl": "KR"}


def _post(body):
    r = urllib.request.Request("https://www.youtube.com/youtubei/v1/search?prettyPrint=false",
                               data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=30))


def _walk(o, acc, conts):
    if isinstance(o, dict):
        if "shortsLockupViewModel" in o:
            acc.append(o["shortsLockupViewModel"])
        if "continuationCommand" in o:
            conts.append(o["continuationCommand"]["token"])
        for v in o.values():
            _walk(v, acc, conts)
    elif isinstance(o, list):
        for v in o:
            _walk(v, acc, conts)


def _views(t):
    m = re.search(r"조회수\s*([\d.,]+)\s*(천|만|억)?회", t)
    if not m:
        return 0
    n = float(m.group(1).replace(",", ""))
    return int(n * {"천": 1e3, "만": 1e4, "억": 1e8}.get(m.group(2), 1))


def _channel(vid):
    try:
        u = "https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/shorts/" + vid
        d = json.load(urllib.request.urlopen(u, timeout=20))
        return urllib.parse.unquote(d.get("author_url", "").rsplit("/", 1)[-1]), d.get("author_name", "")
    except Exception:
        return "", ""


def search(q, period, pages=3):
    """Shorts 유형 + 기간 필터 검색 → [{id,title,view_count,channel_id(=핸들),channel}]"""
    params = base64.b64encode(bytes([0x12, 4, 0x08, UPLOAD[period], 0x10, 9])).decode()
    body = {"context": {"client": CLIENT}, "query": q, "params": params}
    items, seen = [], set()
    for _ in range(pages):
        acc, conts = [], []
        _walk(_post(body), acc, conts)
        for x in acc:
            vid = x.get("onTap", {}).get("innertubeCommand", {}).get("reelWatchEndpoint", {}).get("videoId")
            if not vid or vid in seen:
                continue
            seen.add(vid)
            t = x.get("accessibilityText", "")
            items.append({"id": vid, "title": re.split(r", 조회수", t)[0], "view_count": _views(t)})
        if not conts:
            break
        body = {"context": {"client": CLIENT}, "continuation": conts[-1]}
    with ThreadPoolExecutor(8) as ex:
        for it, (h, n) in zip(items, ex.map(_channel, [i["id"] for i in items])):
            it["channel_id"], it["channel"] = h, n
    return items


def verdict(top, chans, med):
    if top >= 1e6 and chans <= 3:
        return "★빈 자리 — 쇼츠로 터진 적 있는데 올리는 남의 채널 적음"
    if chans <= 3:
        return "공백 — 쇼츠 수요 미확인(롱폼 수요만 있음), 먼저 들어가 본다"
    if chans <= 8 and med >= 1e5:
        return "진입 가능 — 올리는 채널 있지만 잘 나온다"
    if chans >= 15 and med < 3e4:
        return "포화 — 다들 올리는데 안 나온다, 넘겨라"
    return "경쟁 있음 — 덜 다뤄진 회차·인물로 좁혀라"


def check(spec, owners, period):
    q, _, tk = spec.partition("@")
    tokens = [norm(t) for t in (tk.split("|") if tk else [q]) if norm(t)]
    ents = search(q, period)
    rel = [e for e in ents if any(t in norm((e.get("title") or "") + (e.get("description") or "")) for t in tokens)]
    # 주인 판정: 핸들 또는 채널명 (스카우트가 핸들을 못 받은 채널이 있다 — 강나미 @sanghwahusband 를 남으로 셌다)
    others = [e for e in rel if e.get("channel_id") not in owners and (e.get("channel") or "").strip() not in owners
              and not OFFICIAL.search(e.get("channel") or "")]
    by = {}
    for e in others:
        by.setdefault(e.get("channel_id"), []).append(int(e.get("view_count") or 0))
    views = sorted((max(v) for v in by.values()), reverse=True)
    med = statistics.median(views) if views else 0
    return {"q": q, "results": len(ents), "relevant": len(rel), "otherChannels": len(by),
            "otherTop": views[0] if views else 0, "otherMedian": med,
            "ownerShorts": len(rel) - len(others),
            "verdict": verdict(views[0] if views else 0, len(by), med)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("specs", nargs="*")
    ap.add_argument("--owner", default="")
    ap.add_argument("--period", default="month", choices=["week", "month", "year"])
    ap.add_argument("--from-scout", action="store_true")
    ap.add_argument("--top", type=int, default=40)
    ap.add_argument("--scout", default="D:/midform/server/data/longform_scout.json")
    ap.add_argument("--out", default="D:/midform/server/data/longform_competition.json")
    a = ap.parse_args()
    owners = set(filter(None, a.owner.split(",")))
    specs = list(a.specs)
    scout = json.loads(Path(a.scout).read_text(encoding="utf-8"))["channels"] if Path(a.scout).exists() else []
    owners |= {c["handle"] for c in scout if c.get("handle")}  # 롱폼 주인 채널은 경쟁자가 아니다(oEmbed 는 핸들을 준다)
    owners |= {c["channel"].strip() for c in scout}
    if a.from_scout:
        for c in scout[:a.top]:
            specs.append(re.sub(r"[\[\]()@:|]", " ", c["channel"]).strip())
    with ThreadPoolExecutor(6) as ex:
        rows = list(ex.map(lambda s: check(s, owners, a.period), specs))
    Path(a.out).write_text(json.dumps({"period": a.period, "rows": rows}, ensure_ascii=False, indent=2) + "\n",
                           encoding="utf-8")
    for r in sorted(rows, key=lambda r: r["otherChannels"]):
        print(f"{r['q']}: 남의 채널 {r['otherChannels']}개 · 최고 {man(r['otherTop'])} · 중앙 {man(int(r['otherMedian']))}"
              f" · 주인 쇼츠 {r['ownerShorts']} · 관련 {r['relevant']}/{r['results']} → {r['verdict']}")


if __name__ == "__main__":
    main()
