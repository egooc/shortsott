"""편 내내 쉬지 않고 움직이는 방송 요소를 하이퍼프레임 밖(ffmpeg 합성 단계)에서 그린다.

하이퍼프레임은 GSAP 트윈이 걸린 구간을 모두 '움직이는 프레임'으로 보고 정지 프레임 재사용(static dedup)을
끈다. 티커·격자·빛줄기처럼 장면 전체에 걸친 트윈이 하나라도 있으면 매 프레임을 새로 캡처하게 되어
노트북에서 실시간의 15배가 걸렸다. 그래서 이 요소들은 여기서 ffmpeg 필터로 그리고, 오버레이에는
정지 구간이 생기는 요소만 남긴다.

  pre(spec, d, folder, first_input, src, dst)  -> (입력 인자, 필터)   오버레이 아래(배경 위): 격자·빛줄기
  post(spec, folder, src, dst)                 -> 필터               오버레이 위: 뉴스 티커
"""
import math
import subprocess
from pathlib import Path

from config import ASSETS

FONT_BODY = (ASSETS / 'fonts' / 'ROKAFSansMedium.ttf').as_posix().replace(':', r'\:')
FONT_PAPER = (ASSETS / 'fonts' / 'Paperlogy-8ExtraBold.ttf').as_posix().replace(':', r'\:')
SPEED = 140          # 티커 초당 px. 편 전체에서 같은 속도로 이어 흐른다
BAR_H, BORDER, LABEL_W = 46, 3, 84


def _still(path, cmd):
    if not path.exists():
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y'] + cmd + ['-frames:v', '1', str(path)], check=True)
    return path


def _grid(folder):
    # chrome.CSS #grid: 80px 칸, 흰색 5% 1px 선, 화면보다 80px 넓게
    return _still(folder / 'grid.png', ['-f', 'lavfi', '-i', 'color=c=white:s=2080x1240,format=rgba',
                                        '-vf', "geq=r=255:g=255:b=255:a='if(eq(mod(X,80),0)+eq(mod(Y,80),0),13,0)'"])


def _streak(folder):
    # chrome.CSS #streak: 520x1500 따뜻한 빛 띠(가운데 10%), 22도 기울임
    return _still(folder / 'streak.png', ['-f', 'lavfi', '-i', 'color=c=white:s=520x1500,format=rgba',
                                          '-vf', "geq=r=255:g=236:b=170:a='25.5*(1-abs(2*X/520-1))',"
                                                 "rotate=22*PI/180:ow=rotw(22*PI/180):oh=roth(22*PI/180):c=none"])


def pre(spec, d, folder, first_input, src, dst):
    """해설 화면 배경의 격자 흐름과 빛줄기. ambience 가 꺼져 있으면 그대로 통과."""
    if not spec.get('ambience'):
        return [], f'[{src}]null[{dst}]'
    folder = Path(folder)
    g, s = first_input, first_input + 1
    args = ['-loop', '1', '-framerate', '30', '-t', f'{d:.3f}', '-i', str(_grid(folder)),
            '-loop', '1', '-framerate', '30', '-t', f'{d:.3f}', '-i', str(_streak(folder))]
    # 빛줄기: .3초부터 D초 동안 power1.inOut 으로 3300px 이동, 2초 쉬고 반복(int(d//7)번)
    D, R, c = max(3, d * .6), int(d // 7), max(3, d * .6) + 2
    k = f'floor((t-0.3)/{c:.3f})'
    p = f'((t-0.3-{k}*{c:.3f})/{D:.3f})'
    ease = f'if(lt(t,0.3),0,if(gt({k},{R}),1,if(gte({p},1),1,if(lt({p},0.5),2*{p}*{p},1-2*(1-{p})*(1-{p})))))'
    f = (f"[{src}][{g}:v]overlay=x='-80+80*t/{d:.3f}':y='-80+80*t/{d:.3f}':eof_action=pass[_g];"
         f"[_g][{s}:v]overlay=x='-440-w/2+3300*{ease}':y='550-h/2':eof_action=pass[{dst}]")
    return args, f


def post(spec, folder, src, dst):
    """아래쪽 뉴스 티커(띠·문구·'후속' 라벨). ticker 가 없으면 그대로 통과."""
    items = spec.get('ticker') or []
    if not items:
        return f'[{src}]null[{dst}]'
    unit = '   ◆   '.join(items) + '   ◆   '
    copies = max(3, math.ceil(1920 / max(1, len(unit) * 18)) + 2)   # 한 바퀴 밀려도 오른쪽 끝까지 덮는다
    txt = Path(folder) / 'ticker.txt'
    txt.write_text(unit * copies, encoding='utf-8')
    tpath = txt.resolve().as_posix().replace(':', r'\:')
    off = spec.get('ticker_at', 0) * SPEED
    top = 1080 - BAR_H
    return (f"[{src}]drawbox=x=0:y={top}:w=1920:h={BAR_H}:color=0x080A12@0.86:t=fill,"
            f"drawbox=x=0:y={top - BORDER}:w=1920:h={BORDER}:color=0xF5C518:t=fill,"
            f"drawtext=fontfile='{FONT_BODY}':textfile='{tpath}':fontsize=25:fontcolor=0xE8EBF3:"
            f"x='150-mod({off:.1f}+t*{SPEED},tw/{copies})':y='{top}+({BAR_H}-(ascent-descent))/2',"
            f"drawbox=x=0:y={top}:w={LABEL_W}:h={BAR_H}:color=0xD4202C:t=fill,"
            f"drawtext=fontfile='{FONT_PAPER}':text='후속':fontsize=24:fontcolor=white:"
            f"x='({LABEL_W}-tw)/2':y='{top}+({BAR_H}-(ascent-descent))/2'[{dst}]")
