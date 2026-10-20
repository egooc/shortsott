# -*- coding: utf-8 -*-
"""scripts/tag_gate.py 자기 테스트 — API 0, 임시 폴더만."""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import tag_gate as tg  # noqa: E402

assert tg.common_words('조희대 탄핵, 민주당은 왜', '조희대 탄핵소추안을 두고 민주당이\n둘째 줄\n셋째 줄 국회', ['조희대', '민주당', '국회', '#조희대']) == ['조희대', '민주당']
assert tg.tag_content(['조희대 탄핵', '국회'], '조희대 대법원장 탄핵 이야기') == (0.5, ['국회'])
assert tg.tag_content(['a'], '') == (None, [])
with tempfile.TemporaryDirectory() as t:
    t = Path(t)
    tg.LEDGER = t / 'err.jsonl'
    up = t / 'upload.json'
    up.write_text(json.dumps({'title': '크랜베리 밭을 물에 잠그는 이유', 'description': '크랜베리 수확은 밭을 물에 잠가서 한다\n둘째 줄',
                              'tags': ['크랜베리', '수확', '농장', '미국 농업']}, ensure_ascii=False), encoding='utf-8')
    (t / 'script.txt').write_text('크랜베리 밭을 물에 잠급니다. 수확할 때 열매가 뜹니다.\n', encoding='utf-8')
    r = tg.check(up)
    assert r['common'] == ['크랜베리'] and r['ratio'] == 0.5, r          # 공통 1개 → 경고
    assert any('공통 낱말 1개' in w for w in r['warnings'])
    assert tg.main([str(up)]) == 0 and tg.main([str(up), '--fail-on-warn']) == 4
    assert tg.main([str(up), '--min', '1', '--fail-on-warn']) == 0
    # 린박스 사이드카: 고정 두 줄 건너뛴 첫 문단이 설명 머리, 장르·shorts 는 분모 제외, 배우명은 출연 줄로 일치
    rb = t / 'rb'
    (rb / '_render').mkdir(parents=True)
    (rb / 'plan_local.json').write_text(json.dumps({'narration': [{'id': 'n1', 'cards': ['辰が金を突き返した']}], 'sequence': [{'narration': 'n1'}]}, ensure_ascii=False), encoding='utf-8')
    sc = rb / '_render' / 'x.mp4.rinbox.json'
    sc.write_text(json.dumps({'title': '辰が金を突き返した理由', 'tags': ['地獄の辰捕物控', '北大路欣也', '時代劇', 'shorts', '辰'],
                              'description': '「地獄の辰捕物控」はぜひフルバージョンでご覧になることをおすすめします。\n\n時代劇作品の場面と歴史背景を解説する動画です。\n\n'
                                             '辰が金を突き返します。北大路欣也さんほかが出演しています。\n\n制作：東映「地獄の辰捕物控」'},
                             ensure_ascii=False), encoding='utf-8')
    r = tg.check(sc)
    assert r['lane'] == 'rinbox' and r['ratio'] == 1.0, r
    assert r['common'] == ['辰'], r      # 제목·첫 문단·태그 셋 다에 있는 낱말만 (고정 줄의 작품명은 머리가 아님)
    # 쇼핑 메타: tags 없이 keywords[{kw}] 를 태그로
    sh = t / 'sh'
    sh.mkdir()
    (sh / 'm.json').write_text(json.dumps({'title': '기름때 키친타올로 닦지 마세요', 'description': '주방 기름때 제거, 극세사 행주로\n둘째 줄',
                                           'keywords': [{'kw': '기름때'}, {'kw': '극세사 행주'}]}, ensure_ascii=False), encoding='utf-8')
    (sh / 's.txt').write_text('기름때는 극세사 행주로 닦아요.\n', encoding='utf-8')
    r = tg.check(sh / 'm.json', [str(sh / 's.txt')])
    assert r['ratio'] == 1.0 and r['common'] == ['기름때'], r
    bad = t / 'bad.json'
    bad.write_text(json.dumps({'title': '제목만'}, ensure_ascii=False), encoding='utf-8')
    assert tg.main([str(bad)]) == 5 and tg.LEDGER.exists()
print('OK')
