# -*- coding: utf-8 -*-
"""ep01 장면표(visuals.json) 생성기 — 원고 @id 마다 화면 하나. 그림 장면은 img_prompts.json 키와 같은 이름."""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def P(img, **k):
    return dict(type='pic', img=img + '.png', **k)


def CH(n, t, img):
    return dict(type='chapter', n=n, title=t, img=img + '.png')


V = {
    "_emph": ["196억 원", "2,155억 원", "3조 3,000억 원", "3조 3,900억 원", "1만 원", "1,177억 원", "부도", "법정관리", "출자전환", "화의"],
    "hook_shelf": P('hook_shelf', move='in'),
    "hook_split": {"type": "split", "label": "한 그룹에서 나온 제품, 지금의 주인", "root": "옛 해태그룹",
                   "left": {"title": "과자", "items": ["홈런볼 · 맛동산", "크라운해태 계열"]},
                   "right": {"title": "그 밖", "items": ["부라보콘 → 빙그레", "갈아만든배 → LG생활건강", "타이거즈 → KIA"]}},
    "hook_question": P('hook_question', move='in'),
    "hook_promise": P('hook_promise', move='right', badge='그림은 이해를 돕는 그림'),
    "ch1_title": CH('1', '과자 회사의 시작', 'candy_era'),
    "y1945": {"type": "year", "label": "시작", "date": "1945년 10월 3일", "lines": ["해태제과 합명회사 설립"], "source": "한국민족문화대백과"},
    "founders": {"type": "list", "label": "창업자는 네 사람", "items": ["박병규", "민후식", "신덕발", "한달성"], "mark": "·", "size": 66, "w": 900},
    "candy_era": P('candy_era', move='left'),
    "y1972": {"type": "table", "label": "과자에서 음료로", "rows": [["1972년", "해태제과 상장"], ["1973년", "해태음료 설립"]], "w": 1300, "size": 62},
    "products_70s": P('products_70s', move='in'),
    "product_years": {"type": "table", "label": "지금도 팔리는 해태의 과자들", "head": ["나온 해", "제품"], "rows": [["1970년", "부라보콘"], ["1974년", "에이스"], ["1975년", "맛동산"], ["1981년", "홈런볼"]], "w": 1100, "size": 62, "source": "한국민족문화대백과·동아일보 2015"},
    "what_is_jonggeum": {"type": "flow", "label": "종금사와 짧은 빚", "n": "종합금융회사", "q": "기업에 <em>짧은 기간</em> 돈을 빌려주던 금융회사", "a": "만기 연장을 거절하면 → 그 자리에서 갚아야 한다", "a_kw": "연장을"},
    "three_paths": {"type": "table", "label": "비슷해 보이는 세 말", "head": ["절차", "누가 회사를 맡나", "어디서"], "rows": [["화의", "기존 경영진", "법원"], ["법정관리", "법원이 정한 관리인", "법원"], ["워크아웃", "회사 + 채권 금융회사 약속", "법원 밖"]], "at": ["화의는", "법정관리는", "워크아웃은"], "w": 1600, "size": 54},
    "listing_2016": {"type": "year", "label": "헷갈리기 쉬운 상장", "date": "2016년 5월 11일", "lines": ["해태제과식품, 유가증권시장 <em>신규 상장</em>"], "sub": "옛 해태제과의 재상장이 아니다", "source": "뉴시스 2016.5.11"},
    "three_lessons": {"type": "list", "label": "확인된 사실 세 가지", "items": ["잘 팔리는 제품 ≠ 빚을 버티는 힘", "그룹 해체 ≠ 제품의 끝", "같은 이름 ≠ 같은 회사"], "mark": None, "size": 62, "w": 1500, "at": ["첫째", "둘째", "셋째"]},
    "drink_launch": {"type": "table", "label": "음료 쪽의 새 얼굴", "head": ["나온 때", "제품"], "rows": [["1995년 3월", "코코팜"], ["1996년 5월", "갈아만든배"], ["1997년 11월", "그룹 최종 부도"]], "hi": [2], "w": 1200, "size": 60, "source": "해태htb 공식 연혁"},
    "wave_1997": {"type": "table", "label": "1997년에 쓰러진 그룹들(주요 사례)", "head": ["날짜", "그룹", "무슨 일"], "rows": [["3월 19일", "삼미", "부도"], ["4월 21일", "진로", "부도유예"], ["5월 19일", "대농", "부도방지협약"], ["5월 31일", "한신공영", "부도"], ["7월 15일", "기아", "부도방지협약"], ["10월", "태일정밀 · 쌍방울", "부도유예 · 부도"], ["11월 1일", "해태", "최종 부도"], ["11월 4일", "뉴코아", "최종 부도"], ["12월 6일", "한라", "최종 부도"]], "hi": [6], "w": 1500, "size": 40, "source": "MBC·매일경제·한국경제·연합뉴스 1997"},
    "kia_irony": {"type": "split", "label": "1997년에 함께 흔들린 두 이름", "root": "KIA 타이거즈", "all_at_once": True,
                  "left": {"title": "해태", "items": ["1997년 11월 최종 부도", "2001년 야구단 매각"]}, "right": {"title": "기아", "items": ["1997년 7월 부도유예협약", "1998년 10월 현대차 낙찰"]}},
    "tigers": P('tigers', move='right'),
    "ch2_title": CH('2', '과자 밖으로', 'electronics'),
    "y1981": {"type": "year", "label": "2세 경영", "date": "1981년", "lines": ["창업자의 아들 박건배 씨,", "주요 계열사 경영을 맡다"], "source": "한국경제 1997.11.3 보도"},
    "electronics": P('electronics', move='in'),
    "y1994": {"type": "table", "label": "전자 산업으로", "rows": [["1994년", "인켈 인수"], ["1995년", "나우정밀 인수"], ["1996년", "두 회사를 해태전자로 합병"]], "w": 1400, "size": 62},
    "why_diversify": P('why_diversify', move='left'),
    "group_size": {"type": "cards", "label": "1996년 말 해태그룹",
                   "items": [{"label": "재계 순위", "value": "24위"}, {"label": "자산", "value": "3조 3,900억", "red": True, "kw": "자산"},
                             {"label": "매출", "value": "2조 7,100억", "kw": "매출"}],
                   "size": 84, "note": "1997년 보도 기준 계열사 15개 · 임직원 약 1만 4,000명", "source": "한국경제 1997.11.3"},
    "org_chart": {"type": "org", "label": "그룹 지도(주요 계열사)", "top": "해태제과",
                  "kids": [{"name": "해태음료"}, {"name": "해태유통"}, {"name": "해태전자", "hi": True}, {"name": "해태중공업"},
                           {"name": "해태상사"}, {"name": "해태 타이거즈"}], "kw": 520},
    "ch3_title": CH('3', '1997년', 'imf'),
    "y1997_context": {"type": "table", "label": "1997년, 흔들린 한국 경제", "rows": [["1월", "한보철강 부도"], ["7월", "기아그룹 부도유예협약"], ["11월", "정부, IMF 구제금융 신청"]], "w": 1400, "size": 60},
    "what_is_bill": P('what_is_bill', move='in'),
    "y1997_0521": {"type": "year", "label": "첫 번째 경고등", "date": "1997년 5월 21일", "lines": ["종합금융회사들,", "<em>2,155억 원</em> 회수"], "source": "연합뉴스 「해태제과 부도일지」"},
    "calendar": {"type": "calendar", "label": "갚아야 할 날이 몰려든 1997년", "badge": "점은 개념 그림(실제 만기 수 아님)",
                 "months": [{"m": "6월", "dots": 2}, {"m": "7월", "dots": 3}, {"m": "8월", "dots": 4}, {"m": "9월", "dots": 5, "hi": True},
                            {"m": "10월", "dots": 7, "hi": True}, {"m": "11월", "dots": 8, "hi": True, "tag": "11월 1일 부도"}]},
    "ask_why_rumor": P('ask_why_rumor', move='right'),
    "ch4_title": CH('4', '196억 원', 'why_small'),
    "y1997_1101": {"type": "year", "label": "최종 부도", "date": "1997년 11월 1일", "lines": ["해태제과·해태전자·대한포장공업", "어음 <em>196억 원</em>을 막지 못하다"], "source": "MBC 뉴스데스크 1997.11.1"},
    "debt_vs_bill": {"type": "bars", "label": "막지 못한 어음과 전체 빚",
                     "groups": [{"label": "부도 어음", "bars": [{"value": 196, "label": "196억 원", "red": True}]},
                                {"label": "은행 빚", "bars": [{"value": 15000, "label": "1조 5,000억 원"}]},
                                {"label": "그 밖 금융권", "bars": [{"value": 18000, "label": "1조 8,000억 원"}]}],
                     "max": 18000, "source": "MBC 1997.11.1 (그 밖 = 3조 3,000억 − 은행)"},
    "asset_vs_debt": {"type": "bars", "label": "가진 것과 갚아야 할 것",
                      "groups": [{"label": "자산", "bars": [{"name": "1996년 말", "value": 33900, "label": "3조 3,900억 원"}]},
                                 {"label": "금융권 빚", "bars": [{"name": "1997년 11월", "value": 33000, "label": "3조 3,000억 원", "red": True}]}],
                      "max": 34000, "size": 52, "bw": 900, "source": "한국경제 1997.11.3 · MBC 1997.11.1"},
    "why_small": P('why_small', move='in'),
    "electronics_in": P('electronics_in', move='left'),
    "y1997_1103": {"type": "flow", "label": "화의란", "n": "11월 3일", "q": "해태, 법원에 <em>화의</em> 신청", "a": "빚 갚는 방법을 다시 정하자고 법원에 요청하는 절차", "a_kw": "화의는"},
    "imf": P('imf', move='right'),
    "ch5_title": CH('5', '그룹의 해체', 'y1998_0618'),
    "y1998_0601": {"type": "year", "label": "해체 방침", "date": "1998년 6월 1일", "lines": ["주거래은행 조흥은행,", "제과·음료·유통은 해외 매각, 나머지는 정리"], "source": "SBS 1998.6.1"},
    "y1998_0618": P('y1998_0618', move='in'),
    "y1998_0827": {"type": "flow", "label": "방향이 바뀌다", "n": "1998년 8월 27일", "q": "채권단, <em>출자전환</em>으로 정상화 합의", "a": "빌려준 돈 대신 그만큼 회사의 주인이 되는 방식", "a_kw": "빌려준 돈을"},
    "y1999": {"type": "table", "label": "1999년", "rows": [["1월 13일", "대주주 지분 전량 무상 소각"], ["9월 15일", "채권단과 기업개선약정"]], "w": 1400, "size": 60, "source": "연합뉴스 「해태제과 부도일지」"},
    "y2001": P('y2001', move='left'),
    "court": {"type": "table", "label": "법정관리", "rows": [["2001년 4월 11일", "이사회, 회사정리절차 신청 결의"], ["2001년 5월 3일", "서울지법, 정리절차 개시 결정"], ["2001년 8월 29일", "정리계획안 인가"]], "w": 1500, "size": 56, "source": "경향신문·동아일보 2001"},
    "ch6_title": CH('6', '흩어진 조각들', 'pieces_intro'),
    "pieces_intro": P('pieces_intro', move='in'),
    "drink_2000": {"type": "year", "label": "가장 먼저 떠난 사업", "date": "2000년 5월", "lines": ["해태음료, 히카리 컨소시엄에", "<em>3,085억 원</em>에 매각"], "source": "매일경제 2000"},
    "tigers_2001": {"type": "cards", "label": "해태 타이거즈 → KIA 타이거즈",
                    "items": [{"label": "인수 대금", "value": "180억 원"}, "+", {"label": "가입금", "value": "30억 원", "kw": "가입금"}],
                    "size": 90, "note": "2001년 8월 1일부터 KIA 타이거즈", "source": "연합뉴스 2001.7.30"},
    "snack_2001": P('snack_2001', move='right'),
    "two_companies": {"type": "split", "label": "옛 해태제과는 둘로 나뉘었다", "root": "해태제과 (2001년)",
                      "left": {"title": "제과 사업", "items": ["새 회사로 옮겨 감", "2005년 크라운 인수", "지금의 해태제과식품"]},
                      "right": {"title": "옛 법인", "items": ["껍데기만 남음", "하이콘테크로 이름 변경", "청산 절차"]},
                      "order": [["l", 0], ["r", 0], ["r", 1], ["r", 2]], "source": "연합뉴스 2016.10.21"},
    "split_first": {"type": "split", "label": "첫 번째 갈림길", "root": "같은 뿌리", "all_at_once": True,
                    "left": {"title": "살아남은 쪽", "items": ["과자를 만드는 사업"]}, "right": {"title": "사라진 쪽", "items": ["해태제과라는 이름의 옛 회사"]}},
    "crown_2005": P('crown_2005', move='in'),
    "old_shares": P('old_shares', move='left'),
    "ch7_title": CH('7', '1만 원에 팔린 회사', 'htb'),
    "lg_2011": {"type": "year", "label": "2011년 1월", "date": "<em>1만 원</em>", "size": 200, "lines": ["LG생활건강, 해태음료 지분 100% 인수"], "source": "LG생활건강 2011.1.11 발표"},
    "ten_thousand": {"type": "cards", "label": "1만 원의 진짜 구조",
                     "items": [{"label": "주식값", "value": "1만 원"}, "+", {"label": "떠안은 순차입금", "value": "약 1,177억 원", "red": True, "kw": "순차입금"}],
                     "size": 84, "note": "순차입금은 판 쪽에 준 돈이 아니라 회사에 남아 있던 빚", "source": "LG생활건강 2011.1.11 발표"},
    "htb": P('htb', move='right'),
    "retail_2005": {"type": "table", "label": "해태유통의 길", "rows": [["2005년", "이랜드 쪽 컨소시엄 636억 5,000만 원 인수"], ["2005년 12월 29일", "법정관리 종결"], ["2024년", "이마트에 합병"]], "w": 1600, "size": 52},
    "electro_2006": P('electro_2006', move='in'),
    "ch8_title": CH('8', '두 번째 갈림길', 'ice_2020'),
    "ice_2020": P('ice_2020', move='left'),
    "bing_2026": {"type": "year", "label": "합병", "date": "2026년 4월 1일", "lines": ["해태아이스크림, 빙그레에 흡수합병"], "sub": "합병은 폐업이 아니라 두 회사를 하나로 합치는 절차", "source": "빙그레 합병종료 공고"},
    "split_second": {"type": "split", "label": "두 번째 갈림길", "root": "새 주인을 만난 두 사업", "all_at_once": True,
                     "left": {"title": "음료", "items": ["해태htb · LG생활건강"]}, "right": {"title": "아이스크림", "items": ["해태아이스크림 · 빙그레"]}},
    "results_2025": {"type": "bars", "label": "2025년 성적표",
                     "groups": [{"label": "매출", "bars": [{"name": "음료", "value": 3742, "label": "3,742억 원"}, {"name": "아이스크림", "value": 1876, "label": "1,876억 원"}]},
                                {"label": "순손익", "bars": [{"name": "음료", "value": 240, "label": "−240억 원"}, {"name": "아이스크림", "value": 132, "label": "+132억 원", "red": True}]}],
                     "max": 3742, "size": 50, "bw": 800, "source": "LG생활건강·빙그레 2025 사업보고서"},
    "results_caveat": P('results_caveat', move='in'),
    "ch9_title": CH('9', '사라진 것과 남은 것', 'what_remained'),
    "timeline_all": {"type": "table", "label": "해태 연표", "rows": [["1945년", "과자 회사 출발"], ["1997년 11월 1일", "최종 부도"], ["1998년", "해체 방침"], ["2001년", "법정관리"], ["2000~2026년", "크라운해태·LG생활건강·KIA·빙그레·이마트로"]], "w": 1600, "size": 50},
    "what_remained": P('what_remained', move='right'),
    "lesson": P('lesson', move='in'),
    "ending": P('ending', move='in'),
}

for s in V.values():                      # 녹판 제목은 label, 연금 표의 head 는 열 이름
    if isinstance(s, dict) and s.get('type') == 'table':
        s.setdefault('head', ['언제', '무슨 일'])
    if isinstance(s, dict) and s.get('type') in ('table', 'list') and len(s.get('rows', s.get('items', []))) <= 5:   # 미리보기 10-19: 판에 비해 글씨가 작고 빈 곳이 많다 → 1.25배
        s['size'] = int(s.get('size', 60) * 1.25)
        s['w'] = min(1750, int(s.get('w', 1500) * 1.2))
(HERE / 'visuals.json').write_text(json.dumps(V, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
vids = [ln[1:].strip() for ln in (HERE / 'script.txt').read_text(encoding='utf-8').splitlines() if ln.startswith('@')]
pr = json.loads((HERE / 'img_prompts.json').read_text(encoding='utf-8'))
print('원고에 있고 장면표에 없음:', [v for v in vids if v not in V])
print('장면표에만:', [k for k in V if k not in vids and k != '_emph'])
print('그림 프롬프트 없음:', sorted({s['img'][:-4] for s in V.values() if isinstance(s, dict) and s.get('img')} - set(pr)))
