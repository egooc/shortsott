# -*- coding: utf-8 -*-
"""틱톡 ④·⑤ 시험편 원고(10-30 HEAD 배정, 오피스 #58) → <편>/episode.json · script.txt(ref_overlap 입력).

    python -X utf8 ko-corp/tok/make_scripts.py

say = 읽을 문장(숫자는 ko_say 가 한글로 읽음, 자막은 이 문장을 덩어리로 나눔).
img = 장면 그림 이름(d* = 자체 도해, 나머지 = 생성 그림 · prompt 가 있는 첫 장면이 그 그림을 정의).
badge = 화면 위 출처 표시(재구성 그림·도해·원본 그림), step = 단계 꼬리표.
"""
import json
from pathlib import Path

R = '재구성 그림'
EPS = {
    "tok4a": {
        "title": "엘리베이터 줄이 다 끊어지면 떨어질까?",
        "lane": "mech",
        "scenes": [
            {
                "img": "hook",
                "badge": "재구성 그림",
                "say": "엘리베이터 줄이 전부 끊어지면, 정말 바닥까지 떨어질까요?",
                "prompt": "dramatic low-angle view inside a dark elevator shaft, a modern elevator car with snapped steel cables whipping upward, sparks, cinematic lighting, vertical composition, no text"
            },
            {
                "img": "hook",
                "badge": "재구성 그림",
                "say": "정답은, 정상이라면 떨어지지 않게 설계돼 있습니다. 줄이 아니라 다른 장치가 붙잡거든요."
            },
            {
                "img": "ropes",
                "badge": "재구성 그림",
                "say": "먼저, 일반적인 로프식 엘리베이터는 줄 한 가닥에 매달려 있지 않아요. 여러 가닥의 강철 로프가 함께 잡고 있고, 몇 가닥이 끊어져도 버틸 만큼 여유 있게 설계됩니다.",
                "prompt": "clean technical illustration, top of an elevator car hanging from six parallel steel wire ropes over a traction sheave, cutaway, blue and orange flat style, vertical, no text"
            },
            {
                "img": "d1",
                "step": "1단계",
                "say": "그래도 줄이 모두 끊어졌다고 해 볼게요. 칸이 떨어지기 시작하면, 속도가 점점 빨라지죠."
            },
            {
                "img": "d2",
                "step": "2단계",
                "say": "기계실이나 승강로 위에는 조속기, 그러니까 과속 조절기라는 바퀴 장치가 있습니다. 칸과 별도의 줄로 이어져서, 칸이 움직이는 만큼 같이 돌아요."
            },
            {
                "img": "d3",
                "step": "3단계",
                "say": "칸이 정해진 속도보다 빨라지면, 바퀴 안의 추가 원심력으로 바깥으로 벌어지면서, 이 줄을 붙잡는 장치를 작동시킵니다."
            },
            {
                "img": "d4",
                "step": "4단계",
                "say": "이 줄이 붙잡히면 칸에 달린 레버가 당겨지고, 칸 아래 쐐기가 양옆 레일을 꽉 물어서 칸을 세웁니다. 이게 비상 정지 장치예요."
            },
            {
                "img": "otis",
                "badge": "재구성 그림",
                "say": "이런 추락 방지 장치의 초기 형태를 대중 앞에서 보여 준 사람이 엘리샤 오티스입니다. 170여 년 전 뉴욕 크리스털 팰리스 박람회에서, 직접 올라탄 채 줄을 끊게 했죠.",
                "prompt": "19th century exhibition hall, a man in a top hat standing on an open wooden elevator platform high up, a worker cutting the hoisting rope with an axe, crowd gasping below, painterly illustration, vertical, no text"
            },
            {
                "img": "buffer",
                "badge": "재구성 그림",
                "say": "맨 아래에는 완충기도 있어서, 칸이 바닥 쪽에 닿을 때 충격을 한 번 더 줄여 줍니다.",
                "prompt": "technical illustration of an elevator pit with large spring and hydraulic buffers under an elevator car, clean flat style, blue and orange, vertical, no text"
            },
            {
                "img": "city",
                "badge": "재구성 그림",
                "say": "그래서 이게 없으면? 고층 빌딩을 지금처럼 매일 오르내리기는 어려웠을 거예요. 우리는 이 작은 쐐기를 믿고 타는 셈이죠.",
                "prompt": "night city skyline of glass skyscrapers seen from below, glowing elevator shafts visible through glass, cinematic, vertical, no text"
            },
            {
                "img": "city",
                "badge": "재구성 그림",
                "say": "여러분은 엘리베이터 탈 때, 언제가 제일 무서워요? 댓글로 알려 주세요."
            }
        ]
    },
    "tok4b": {
        "title": "이 모래가 휴대폰 두뇌가 된다",
        "lane": "mech",
        "scenes": [
            {
                "img": "hook",
                "badge": "재구성 그림",
                "say": "이 모래가, 여러분 휴대폰의 두뇌가 됩니다. 정확히는, 모래 속 규소가요.",
                "prompt": "macro photo of a hand pouring glittering white quartz sand that turns into a glowing silicon computer chip in the palm, dramatic dark background, vertical, no text"
            },
            {
                "img": "quartz",
                "badge": "재구성 그림",
                "say": "물론 아무 모래나 되는 건 아니에요. 이산화규소가 풍부한 규석 같은 원료를 씁니다.",
                "prompt": "pile of white quartz rocks and quartz sand on dark stone, studio lighting, macro, vertical, no text"
            },
            {
                "img": "d1",
                "step": "1단계",
                "say": "먼저 규석을 탄소와 함께 거대한 전기로에 넣고, 약 2천 도로 달굽니다. 산소가 빠져나가고 규소가 남지만, 아직 순도가 모자라요."
            },
            {
                "img": "d2",
                "step": "2단계",
                "say": "그래서 규소를 기체로 다룰 수 있는 화합물로 바꿔 불순물을 걸러 내고, 다시 반응시켜 순수한 규소를 쌓아 올립니다. 그러면 9가 열두 개나 들어가는 순도까지 올라가기도 해요."
            },
            {
                "img": "d3",
                "step": "3단계",
                "say": "이제 녹인 규소에 작은 씨앗 결정을 담그고, 천천히 돌리며 끌어올립니다. 그러면 원기둥 모양의 거대한 결정, 잉곳이 자라나요."
            },
            {
                "img": "ingot",
                "badge": "재구성 그림",
                "say": "사람 키만큼 자라기도 하는 이 은빛 기둥이, 통째로 하나의 결정입니다.",
                "prompt": "a huge shiny silver monocrystalline silicon ingot cylinder standing in a clean room, technician in white suit beside it for scale, vertical, no text"
            },
            {
                "img": "d4",
                "step": "4단계",
                "say": "이 잉곳을 얇게 썰고, 1밀리미터도 안 되는 두께로 다듬어 거울처럼 갈면 웨이퍼가 됩니다. 그 위에 막을 쌓고, 빛으로 무늬를 옮기고, 깎는 일을 수백 번 넘게 반복해요."
            },
            {
                "img": "wafer",
                "badge": "재구성 그림",
                "say": "칩 크기에 따라, 웨이퍼 한 장에서 손톱만 한 칩이 수백 개씩 나오기도 합니다.",
                "prompt": "gloved hand holding a rainbow iridescent silicon wafer full of tiny chips, clean room yellow light, macro, vertical, no text"
            },
            {
                "img": "city",
                "badge": "재구성 그림",
                "say": "그래서 이게 없으면? 휴대폰도, 노트북도, 요즘 자동차도 멈춥니다. 다 이런 반도체로 움직이거든요. 우리는 결국 모래 위에 사는 셈이죠.",
                "prompt": "futuristic city at night where glowing circuit lines grow out of a sand dune, cinematic, vertical, no text"
            },
            {
                "img": "city",
                "badge": "재구성 그림",
                "say": "웨이퍼 한 장이 칩이 되기까지, 몇 달이 걸리기도 한대요. 여러분은 얼마나 걸릴 것 같았어요? 댓글로 알려 주세요."
            }
        ]
    },
    "tok5a": {
        "title": "모나리자 눈이 따라온다는 소문의 진실",
        "lane": "mystery",
        "scenes": [
            {
                "img": "monalisa",
                "badge": "원본 그림(공유 저작물)",
                "say": "모나리자 앞에 서면, 어디로 가든 눈이 나를 따라온다는 소문, 들어 보셨죠?"
            },
            {
                "img": "museum",
                "badge": "재구성 그림",
                "step": "소문",
                "say": "이 현상엔 아예 이름까지 붙었습니다. 모나리자 효과. 그래서 다빈치가 특별한 비법을 쓴 것처럼 느껴지기도 하죠.",
                "prompt": "crowded museum gallery seen from behind visitors, a small portrait on a far wall behind glass, people holding up phones, soft warm light, painterly, vertical, no portrait details, no text"
            },
            {
                "img": "lab",
                "badge": "재구성 그림",
                "step": "기록 대조",
                "say": "그런데 2019년, 독일 빌레펠트 대학 연구팀이 이걸 직접 재 봤습니다.",
                "prompt": "psychology lab, a participant sitting in front of a large computer screen with a long ruler-like scale under it, researcher taking notes, clean modern illustration, vertical, no text"
            },
            {
                "img": "lab",
                "badge": "재구성 그림",
                "step": "기록 대조",
                "say": "모니터 속 그림을 보여 주고, 그녀가 바라보는 위치를 자의 눈금으로 답하게 했죠. 그림 크기와 위치, 화면과 자 사이 거리를 바꿔 가며 모은 판단이, 2천 번을 넘었어요."
            },
            {
                "img": "d_gaze",
                "badge": "연구 결과 도해",
                "step": "기록 대조",
                "say": "결과는 반전이었습니다. 시선은 정면이 아니라, 보는 사람의 오른쪽으로 15.4도 비껴가 있었어요."
            },
            {
                "img": "portrait",
                "badge": "재구성 그림",
                "step": "확인된 것",
                "say": "확인된 것부터. 우리를 똑바로 바라보게 그린 초상화는, 자리를 옮겨도 눈이 따라오는 것처럼 보일 수 있습니다. 이건 진짜 현상이에요.",
                "prompt": "oil portrait of a fictional bearded man looking straight at the viewer, renaissance style, hanging in a gallery, three visitors at different angles, painterly, vertical, no text"
            },
            {
                "img": "monalisa",
                "badge": "원본 그림(공유 저작물)",
                "step": "덧붙은 것",
                "say": "덧붙은 것은 이 부분. 이 실험에선, 정작 그 이름의 주인공인 모나리자의 시선이 우리를 비껴가 있었습니다."
            },
            {
                "img": "lab",
                "badge": "재구성 그림",
                "step": "덧붙은 것",
                "say": "다만 2022년 후속 연구에선, 보는 거리에 따라 눈이 마주친다는 답이 달라지기도 했어요. 그러니 정확히는, 아직 다 끝난 이야기가 아닙니다."
            },
            {
                "img": "monalisa",
                "badge": "원본 그림(공유 저작물)",
                "step": "덧붙은 것",
                "say": "연구자는 여기에, 누군가의 관심을 받고 싶은 마음이 드러난다고 해석했어요. 다만 그 마음이 착각의 원인인지는, 이번 실험으로 확인한 건 아닙니다."
            },
            {
                "img": "monalisa",
                "badge": "원본 그림(공유 저작물)",
                "say": "지금 이 그림, 여러분은 눈이 마주친 것 같나요? 댓글로 알려 주세요."
            }
        ]
    },
    "tok5b": {
        "title": "바다에서 쓸려 나가기 직전 3가지 신호",
        "lane": "mystery",
        "scenes": [
            {
                "img": "hook",
                "badge": "재구성 그림",
                "say": "이 바다에서, 사람이 쓸려 나가는 길이 보이나요?",
                "prompt": "aerial view of a sunny beach, white breaking waves on both sides with a calm dark gap of water in the middle flowing out to sea, realistic photo style, vertical, no people, no text"
            },
            {
                "img": "hook",
                "badge": "재구성 그림",
                "say": "파도가 하얗게 부서지는 곳 사이로, 오히려 잔잔해 보이는 틈. 그곳이 사람을 끌고 나가는 길일 수 있습니다."
            },
            {
                "img": "d_rip",
                "badge": "도해",
                "say": "이안류. 해안에서 바다 쪽으로 빠르게 빠져나가는 좁은 물길입니다. 지금부터 장면은 이해를 돕기 위한 재구성이에요."
            },
            {
                "img": "gap",
                "badge": "재구성 그림",
                "step": "신호 1",
                "say": "첫째, 양옆에선 파도가 부서지는데, 한 곳만 잔잔하게 끊겨 보입니다.",
                "prompt": "beach shoreline view at eye level, waves breaking white left and right, a flat calm strip in the middle, realistic, vertical, no people, no text"
            },
            {
                "img": "dark",
                "badge": "재구성 그림",
                "step": "신호 2",
                "say": "둘째, 그 자리 물빛이 주변보다 짙거나 탁할 수 있어요. 물길이 깊거나, 모래가 섞여 나가면 그렇게 보이죠.",
                "prompt": "view of sea water near a beach from a cliff, one channel of darker murky brownish water cutting through lighter turquoise water, realistic, vertical, no people, no text"
            },
            {
                "img": "foam",
                "badge": "재구성 그림",
                "step": "신호 3",
                "say": "셋째, 거품이나 해초가 해안이 아니라, 계속 바다 쪽으로 흘러갑니다.",
                "prompt": "sea foam and floating seaweed drifting away from the beach out to sea in a narrow line, realistic photo, vertical, no people, no text"
            },
            {
                "img": "swimmer",
                "badge": "재구성 그림",
                "step": "3초 전",
                "say": "자, 이 장면을 3초 전으로 돌려 볼게요. 발이 닿던 곳인데, 몸이 바다 쪽으로 밀려납니다. 이미 이안류에 휩쓸리고 있다는 뜻일 수 있어요.",
                "prompt": "semi-realistic illustration of an adult swimmer seen from behind in waist-deep sea water, being pulled backward toward open sea, faint arrows of current, sunny day, vertical, no text"
            },
            {
                "img": "d_escape",
                "badge": "도해",
                "say": "이때 물살을 거슬러 해안으로만 헤엄치면, 금방 지칩니다. 이안류는 빠르면 초속 2미터를 넘거든요."
            },
            {
                "img": "d_escape",
                "badge": "도해",
                "say": "헤엄칠 수 있다면, 해안과 나란히 움직여 물길을 벗어난 뒤 비스듬히 돌아오세요. 어렵다면 무리하지 말고 등을 대고 떠서, 팔을 흔들고 소리쳐 도움을 요청하세요."
            },
            {
                "img": "hook",
                "badge": "재구성 그림",
                "say": "잔잔한 틈, 다른 물빛, 바다로 가는 거품. 이런 단서가 없어도 안심은 금물이에요. 휩쓸리면 맞서지 말고, 옆으로."
            },
            {
                "img": "hook",
                "badge": "재구성 그림",
                "say": "막상 저런 순간엔, 배웠던 안전 수칙도 머릿속에서 사라지죠. 여러분도 물에서 아찔했던 순간 있었나요? 댓글로 알려 주세요."
            }
        ]
    }
}


def main():
    here = Path(__file__).resolve().parent
    for k, v in EPS.items():
        d = here / k
        (d / 'img').mkdir(parents=True, exist_ok=True)
        (d / 'episode.json').write_text(json.dumps(v, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
        (d / 'script.txt').write_text('\n'.join(s['say'] for s in v['scenes']) + '\n', encoding='utf-8')
        print(k, len(v['scenes']), '장면', sum(len(s['say']) for s in v['scenes']), '자')


if __name__ == '__main__':
    main()
