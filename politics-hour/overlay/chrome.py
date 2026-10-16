"""모든 장면에 공통으로 얹는 방송 요소: 진입 전환 띠, 이슈 태그, 로고 상자.
뉴스 티커와 빛줄기·격자처럼 장면 내내 움직이는 요소는 motion.py 가 ffmpeg 합성 단계에서 그린다
(오버레이 안에 두면 하이퍼프레임의 정지 프레임 재사용이 꺼져 렌더가 몇 배 느려진다).
깜빡임도 같은 이유로 길이 0 인 tl.set 을 번갈아 걸어 계단식으로 깜빡이게 한다.

spec 에서 읽는 값(모두 선택):
  issue_tag  "ISSUE 01 · 묘소 논란"         왼쪽 위 고정 태그
  ticker     ["다음 이슈 ...", "..."]       아래쪽에 흐르는 티커 문구
  stinger    true                          장면 시작 0.5초 대각선 띠 전환(기본 true)
  ambience   true                          빛줄기·격자 배경 움직임(해설 화면용)
  brand      "쟁점 브리핑"                  오른쪽 위 채널 로고 상자(우리 채널 이름)
  date       "10.12 (월)"                  로고 옆 날짜
"""
import html

esc = lambda s: html.escape(str(s), quote=True)

CSS = '''
#follow{position:absolute;left:40px;top:84px;font-family:Body;font-size:22px;color:#fff;background:#d4202c;padding:4px 12px;border-radius:4px;z-index:5}
#tagbar{position:absolute;left:40px;top:34px;font-family:Paper;font-size:26px;color:#111;background:#F5C518;
  padding:6px 16px;border-radius:4px;letter-spacing:1px;z-index:5}
#bug{position:absolute;right:40px;top:30px;display:flex;align-items:stretch;z-index:5;font-family:Paper}
#bug .b{background:#0b0f1c;color:#fff;font-size:28px;padding:6px 16px;border-left:6px solid #F5C518}
#bug .l{background:#d4202c;color:#fff;font-size:22px;padding:10px 12px}
#bug .d{background:rgba(255,255,255,.92);color:#111;font-size:22px;padding:10px 12px;font-family:Body}
.stg{position:absolute;top:-300px;height:1700px;width:420px;transform:rotate(18deg);z-index:9}
'''


def blink(sel, low, half, start, end):
    """sel 을 half 초마다 low ↔ 1 로 바꾼다. 길이 0 이라 사이 프레임은 정지로 남는다."""
    out, t, i = [], start, 0
    while t < end:
        out.append(f'tl.set("{sel}",{{opacity:{low if i % 2 == 0 else 1}}},{t:.3f});')
        t += half; i += 1
    if i % 2:
        out.append(f'tl.set("{sel}",{{opacity:1}},{min(t, end):.3f});')
    return out


def parts(spec, d, has_source=False):
    """(body_html, js_lines). body 는 장면 section 안에 넣는다."""
    body, js = '', []
    if spec.get('issue_tag'):
        body += f'<div id="tagbar">{esc(spec["issue_tag"])}</div>'
        js.append('tl.from("#tagbar",{x:-40,opacity:0,duration:.4,ease:"power3.out"},.35);')
        if spec.get('followup'):
            body += '<div id="follow">● 후속 취재 중</div>'
            js.append('tl.from("#follow",{opacity:0,duration:.3},.6);')
            js += blink('#follow', .45, .8, 1, d - .6)
    if spec.get('brand'):
        body += (f'<div id="bug"><div class="b">{esc(spec["brand"])}</div><div class="l">NEWS</div>'
                 + (f'<div class="d">{esc(spec["date"])}</div>' if spec.get('date') else '') + '</div>')
        js.append('tl.from("#bug",{opacity:0,y:-20,duration:.4},.3);')
    if spec.get('stinger', True):
        body += ('<div class="stg" id="sg0" style="left:-520px;background:#F5C518"></div>'
                 '<div class="stg" id="sg1" style="left:-1000px;background:#0b0f1c"></div>')
        js += ['tl.fromTo("#sg0",{x:0},{x:2900,duration:.55,ease:"power3.inOut"},0);',
               'tl.fromTo("#sg1",{x:0},{x:3300,duration:.6,ease:"power3.inOut"},0);']
    return body, js
