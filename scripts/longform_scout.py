"""롱폼 to 쇼츠(채널 A) 에셋 찾기 — «최근 롱폼이 100만 넘는데 남들이 쇼츠로 안 따는 채널».

  python scripts/longform_scout.py [--min 1000000] [--q "검색어,검색어"] [--period month|week] [--out path]

왜 (2026-10-13 소유주: «여기서 새로운 롱폼투쇼츠를 할거야», 전자책 2장):
  · 수요 판정은 «최신 롱폼이 100만+» 하나. 롱폼으로 100만이면 쇼츠로 따면 통한다.
  · 방송사·OTT·기획사 공식 채널은 뺀다(그건 채널 C·명화관 영역). 연예인 자체 채널·일반인 채널을 찾는다.
API 0원: yt-dlp 로 유튜브 검색 결과 페이지를 읽는다(조회순·기간·길이 필터). 검색 API 한도는 다른 세션이 쓴다.
"""
import argparse
import base64
import json
import re
import subprocess
import sys
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

OFFICIAL = re.compile(
    r"(netflix|넷플릭스|disney|디즈니|tving|티빙|wavve|웨이브|coupang|쿠팡|\bsbs|kbs|mbc|jtbc|tvn|\bena\b|채널a|mbn|tv조선|ytn|"
    r"연합뉴스|뉴스|news|mnet|엠넷|hybe|smtown|jyp|starship|1thek|원더케이|studio waffle|스튜디오 와플|딩고|dingo|"
    r"오리지널|official|티비|tv chosun|kbc|obs|ebs|cjenm|채널s|skylife|아리랑)", re.I)

DEFAULT_Q = ("브이로그,가족 일상,시골 일상,할머니,먹방,토크,연예인,웹예능,술자리,부부,육아,여행,리액션,몰래카메라,"
             "인터뷰,요리,일상,썰,동네,캠핑,반려견,고양이,예능,콘텐츠,챌린지,유튜버,가수,배우,개그맨,아이돌")


def sp_filter(period: str, length: str) -> str:
    # SearchFilter protobuf: sort=view count(1:3), filters{ upload_date(1), type=video(2:1), duration(3) }
    up = {"hour": 1, "today": 2, "week": 3, "month": 4, "year": 5}[period]
    du = {"short": 1, "long": 2, "medium": 3}[length]
    inner = bytes([0x08, up, 0x10, 0x01, 0x18, du])
    raw = bytes([0x08, 0x03, 0x12, len(inner)]) + inner
    return base64.b64encode(raw).decode()


def search(q: str, period: str, length: str) -> list:
    url = ("https://www.youtube.com/results?search_query=" + urllib.parse.quote(q)
           + "&sp=" + urllib.parse.quote(sp_filter(period, length)))
    p = subprocess.run(["yt-dlp", "--flat-playlist", "-J", "--playlist-end", "200", url],
                       capture_output=True, text=True, encoding="utf-8")
    if p.returncode != 0:
        print(f"! {q}/{length}: {p.stderr.strip()[-200:]}", file=sys.stderr)
        return []
    return json.loads(p.stdout).get("entries") or []


def man(n: int) -> str:
    return f"{round(n / 1e4)}만" if n >= 1e4 else str(n)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min", type=int, default=1_000_000)
    ap.add_argument("--q", default=DEFAULT_Q)
    ap.add_argument("--period", default="month", choices=["week", "month", "year"])
    ap.add_argument("--out", default="D:/midform/server/data/longform_scout.json")
    # 해외 롱폼도 소스로 쓴다(10-13 소유주: 지구관측소는 국내·해외 섞어 카테고리로) — 한글 제목 조건을 끈다
    ap.add_argument("--any-lang", action="store_true")
    a = ap.parse_args()
    qs = [q.strip() for q in a.q.split(",") if q.strip()]

    jobs = [(q, ln) for q in qs for ln in ("long", "medium")]
    seen = {}
    with ThreadPoolExecutor(6) as ex:
        for (q, ln), ents in zip(jobs, ex.map(lambda j: search(j[0], a.period, j[1]), jobs)):
            for e in ents:
                vid = e.get("id")
                if not vid or vid in seen:
                    continue
                seen[vid] = {"id": vid, "title": e.get("title") or "", "channelId": e.get("channel_id"),
                             "channel": e.get("channel") or "", "handle": e.get("uploader_id"),
                             "views": int(e.get("view_count") or 0), "min": round((e.get("duration") or 0) / 60),
                             "q": q}
            print(f"· {q}/{ln} → 누적 {len(seen)}", file=sys.stderr)

    hits = [v for v in seen.values()
            if v["views"] >= a.min and v["min"] >= 8 and not OFFICIAL.search(v["channel"])
            and (a.any_lang or re.search(r"[가-힣]", v["title"]))]
    by = {}
    for v in hits:
        c = by.setdefault(v["channelId"], {"channelId": v["channelId"], "channel": v["channel"],
                                           "handle": v["handle"], "hits": []})
        c["hits"].append(v)
    rows = sorted(by.values(), key=lambda c: (-len(c["hits"]), -max(h["views"] for h in c["hits"])))
    for c in rows:
        c["hits"].sort(key=lambda h: -h["views"])
        c["topViews"] = c["hits"][0]["views"]
    Path(a.out).write_text(json.dumps({"period": a.period, "min": a.min, "queries": qs, "scanned": len(seen),
                                       "channels": rows}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for c in rows:
        print(f"{c['channel']} {c['handle'] or ''} — {man(a.min)}+ 롱폼 {len(c['hits'])}편, 최고 {man(c['topViews'])}")
        for h in c["hits"][:3]:
            print(f"    {man(h['views'])} · {h['min']}분 · {h['title'][:60]}")
    print(f"\n검사 {len(seen)}편 → {len(rows)}채널 → {a.out}")


if __name__ == "__main__":
    main()
