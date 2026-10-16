"""10/15 편 원고 공용: 인용 조각 만들기. 색은 여당(A) 파랑·국민의힘(B) 빨강·시사 스피커(P) 초록·무소속(N) 회색."""
COLOR = {'A': '#1E5BD8', 'B': '#E61E2B', 'P': '#12A88A', 'N': '#8A93A6'}


def q(quotes, src, t_in, **over):
    x = next(x for x in quotes if x['src'] == src and abs(x['in'] - t_in) < .05)
    seg = {'type': 'quote', **{k: x[k] for k in ('side', 'src', 'in', 'out', 'speaker', 'role', 'tag', 'phrases', 'source')},
           'color': COLOR[x['side']]}
    seg.update(over)
    return seg
