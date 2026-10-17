# -*- coding: utf-8 -*-
"""ep01 장면표 → visuals.json (JSON 은 이 파일에서만 만든다)."""
import json
from pathlib import Path

S_OSHIRASE = '日本年金機構「令和9年分 扶養親族等申告書 大切なお知らせ」'
S_TEBIKI = '日本年金機構「令和9年分 扶養親族等申告書 作成と提出の手引き（新規）」'
S_FORM = '日本年金機構「令和9年分 扶養親族等申告書」様式'
S_KAISEI = '日本年金機構「令和8年度税制改正による公的年金等に係る主な改正事項」'
S_FAQ = '日本年金機構 よくある質問「扶養親族等申告書を提出しなかった場合」'
S_SAITAMA = 'さいたま市「介護保険料の決め方と納め方」（令和6〜8年度）'
FORM = '2027fuyo_p1.png'
FLOW = '2027oshirase_p1.png'
TOC = ['なぜ今年、はじめて届いたのか', 'あなたは出す必要があるのか', '申告書の書き方', '出さないと、どうなるのか', '12月に戻ってくる税金と、出し方']


def toc(on):
    return {'type': 'toc', 'items': TOC, 'on': on, 'head': '今日の内容', 'size': 60}


def chap(n, title):
    return {'type': 'title', 'lines': [f'<span class="k">{n}</span>', title], 'size': 104}


V = {
    '_emph': ['扶養親族等申告書', '11万円', '62万円', '58万円', '148万円', '214万円', '先に結論です', '勘違いしやすいポイント', '毎年', '非課税', '課税'],
    # ---- 0 훅 ----
    'hook_envelope': {'type': 'title', 'img': '02_mailbox.png', 'lines': ['今年<em>はじめて</em>', '届いた封筒', '<span style="font-size:72px">扶養親族等申告書</span>'], 'size': 110},
    'hook_money': {'type': 'title', 'img': '09_thumb_shock.png', 'lines': ['出さないと', '夫婦で<em>年11万円</em>', '損することも'], 'size': 118},
    'title_card': {'type': 'title', 'lines': ['年金・給付金', '手続きノート'], 'size': 130},
    'theme': {'type': 'img', 'img': '03_reading.png', 'head': '今日のテーマ', 'lines': ['今年はじめて届いた人も', '<em>扶養親族等申告書</em>'], 'size': 70},
    'why_now': {'type': 'list', 'head': '今年 変わったこと', 'items': ['送る相手が<em>住民税</em>のかかる人まで', '扶養の線が <em>58万円 → 62万円</em>'], 'mark': '●', 'size': 66, 'source': S_KAISEI},
    'promise': {'type': 'img', 'img': '04_wife_naruhodo.png', 'head': '最後まで見ると', 'lines': ['出すべきかどうか', 'どこに何を書くか', '<em>手元の書類でわかる</em>'], 'size': 68},
    'toc_all': toc(-1),
    # ---- 1 ----
    'ch1_title': chap(1, 'なぜ今年、<br>はじめて届いたのか'),
    'ch1_conclusion': {'type': 'title', 'lines': ['<span class="k">先に結論</span>', '<em>住民税</em>のためにも', '出す仕組みになった'], 'size': 104},
    'ch1_what': {'type': 'img', 'img': '03_reading.png', 'head': '扶養親族等申告書とは', 'lines': ['年金から引かれる税金を', '家族の状況に合わせて', '<em>安くする</em>ための書類'], 'size': 64},
    'ch1_table': {'type': 'table', 'title': '申告書が送られる年金額（65歳以上）', 'head': ['年分', '送付の対象'], 'rows': [['令和8年分', '205万円以上'], ['令和9年分', '<span class="red">148万円以上</span>']],
                  'hi': [1], 'w': 1300, 'size': 76, 'at': ['205万円', '148万円'], 'source': '日本年金機構「令和9年分 扶養親族等申告書（紙の提出）」'},
    'ch1_band': {'type': 'cards', 'items': [{'label': '住民税がかかる', 'value': '148万円〜'}, '／', {'label': '所得税がかかる', 'value': '214万円〜'}, '→',
                                            {'label': 'はじめて届く', 'value': '148〜214万円', 'red': True, 'kw': '148万円から214万円'}], 'size': 74,
                 'note': '一人暮らし・65歳以上の年金額の目安（地域で148〜155万円）', 'source': S_OSHIRASE + ' p.1'},
    'ch1_before': {'type': 'img', 'img': '05_counter.png', 'h': 560, 'head': 'これまで', 'lines': ['住民税の控除は', '市区町村に<em>別に申告</em>', '（毎年2〜3月）'], 'size': 64},
    'ch1_after': {'type': 'cards', 'items': [{'label': '年金機構', 'value': '申告書1枚'}, '→', {'label': '市区町村', 'value': '住民税の控除', 'red': True}], 'size': 80,
                  'note': '出さなければ、市区町村に伝わらない'},
    'ch1_who': {'type': 'img', 'img': '01_couple.png', 'head': '届いた方は', 'lines': ['手続きの間違い<em>ではない</em>', '年金148万円以上なら', '届いて当たり前'], 'size': 64},
    'ch1_when': {'type': 'doc', 'src': FORM, 'crop': [0.03, 0.17, 0.97, 0.25], 'boxes': [{'r': [0.035, 0.2, 0.375, 0.236], 'kw': '期限'}], 'source': S_FORM},
    'ch1_misread': {'type': 'img', 'img': '09_thumb_shock.png', 'head': '勘違いしやすいポイント', 'lines': ['去年は届かなかった', '→ 関係ない、<em>は間違い</em>', 'ルールが変わった'], 'size': 64},
    'ch1_bridge': {'type': 'img', 'img': '04_wife_naruhodo.png', 'bubble': '全員出すの？', 'bx': 760, 'by': 140},
    # ---- 2 ----
    'ch2_title': chap(2, 'あなたは<br>出す必要があるのか'),
    'ch2_conclusion': {'type': 'list', 'head': '先に結論', 'items': ['本人に<em>障害</em>がある', '<em>配偶者・家族</em>を養っている', 'どちらもない → 出さなくてよい'], 'mark': '●', 'size': 66},
    'ch2_flow': {'type': 'doc', 'src': FLOW, 'crop': [0, 0, 1, 1], 'boxes': [{'r': [0.038, 0.127, 0.714, 0.296], 'n': '1', 'kw': '4つの質問'}], 'source': S_OSHIRASE + ' p.1'},
    'ch2_q1': {'type': 'flow', 'n': '質問1', 'q': '受け取っている年金が<br>所得税か住民税のかかる額？', 'a': '目安：65歳以上で<em>148万円以上</em> → 届いた方はほぼ「はい」', 'a_kw': '148万円'},
    'ch2_q2': {'type': 'flow', 'n': '質問2', 'q': 'ご本人が<em>障害者</em>、<br>または寡婦・ひとり親？', 'a': '当てはまる → <em>提出が必要</em>', 'a_kw': '当てはまるなら'},
    'ch2_q3': {'type': 'table', 'title': '質問3　控除の対象になる家族を養っている？', 'head': ['家族', '年間所得の見積もり'], 'rows': [['配偶者', '95万円以下'], ['19〜22歳の家族', '85万円以下'], ['それ以外の家族', '<span class="red">62万円以下</span>']],
               'w': 1400, 'size': 62, 'at': ['95万円', '85万円', '62万円'], 'source': S_OSHIRASE + ' p.1'},
    'ch2_income': {'type': 'cards', 'items': [{'label': '年金', 'value': '172万円'}, '−', {'label': '公的年金等控除', 'value': '110万円', 'kw': '110万円'}, '=',
                                              {'label': '所得', 'value': '62万円', 'red': True, 'kw': '残り'}], 'size': 88, 'note': '65歳以上・収入が年金だけの場合', 'source': S_OSHIRASE + ' p.2・3'},
    'ch2_q4': {'type': 'flow', 'n': '質問4', 'q': '養っている家族に<br>退職金を受け取る見込みの方がいる？', 'a': '特別なケース。当てはまる方だけ', 'a_kw': '特別'},
    'ch2_notneeded': {'type': 'list', 'head': '4つとも当てはまらない', 'items': ['提出は<em>不要</em>', '基礎控除は受けられる', '所得税の税率は 5.105％'], 'mark': '●', 'size': 66, 'source': S_OSHIRASE + ' p.1'},
    'ch2_people': {'type': 'img', 'img': '01_couple.png', 'head': '3人の例で判定', 'lines': ['鈴木さん', '佐藤さん', '中村さん'], 'size': 72, 'fiction': True},
    'ch2_suzuki': {'type': 'table', 'title': '鈴木さん（68歳・一人暮らし・年金180万円）', 'head': ['質問1', '質問2', '質問3', '質問4'], 'rows': [['はい', 'いいえ', 'いいえ', 'いいえ']],
                   'w': 1500, 'size': 66, 'fiction': True, 'at': ['1つ目の質問', '2つ目', '提出は不要']},
    'ch2_sato': {'type': 'cards', 'items': [{'label': 'お孫さんの給料', 'value': '150万円'}, '−', {'label': '給与所得控除', 'value': '74万円'}, '=',
                                            {'label': '所得', 'value': '76万円', 'red': True, 'kw': '76万円'}], 'size': 84, 'note': '19〜22歳の線は85万円 → 内側なので提出が必要', 'fiction': True,
                 'source': S_OSHIRASE + ' p.3'},
    'ch2_nakamura': {'type': 'img', 'img': '01_couple.png', 'head': '中村さん夫婦（さいたま市）', 'lines': ['夫 73歳・年金200万円', '妻 71歳・年金70万円', '→ 妻を書いて<em>提出が必要</em>'], 'size': 62, 'fiction': True},
    'ch2_every_year': {'type': 'doc', 'src': FORM, 'crop': [0.03, 0.17, 0.97, 0.45], 'boxes': [{'r': [0.035, 0.2, 0.375, 0.236], 'kw': '変更なし'}], 'source': S_TEBIKI},
    'ch2_bridge': {'type': 'img', 'img': '03_reading.png', 'bubble': 'どこに何を書く？', 'bx': 760, 'by': 140},
    # ---- 3 ----
    'ch3_title': chap(3, '申告書の書き方'),
    'ch3_conclusion': {'type': 'list', 'head': '先に結論　書く場所は4つ', 'items': ['A　受給者', 'B　配偶者', 'C　扶養親族', 'D　摘要欄'], 'mark': '■', 'size': 68},
    'ch3_sample': {'type': 'doc', 'src': FORM, 'crop': [0, 0, 1, 1], 'boxes': [], 'source': S_FORM},
    'ch3_date': {'type': 'doc', 'src': FORM, 'crop': [0.03, 0.17, 0.97, 0.26], 'boxes': [{'r': [0.035, 0.2, 0.375, 0.236], 'n': '1', 'kw': '年月日'}], 'source': S_FORM},
    'ch3_a': {'type': 'doc', 'src': FORM, 'crop': [0.03, 0.245, 0.97, 0.43], 'boxes': [{'r': [0.035, 0.275, 0.47, 0.425], 'n': 'A', 'kw': '受給者'},
                                                                                       {'r': [0.465, 0.275, 0.965, 0.425], 'kw': '3つの欄'}], 'source': S_FORM},
    'ch3_proxy': {'type': 'img', 'img': '06_smartphone.png', 'head': '家族が代わりに書くとき', 'lines': ['裏面の<em>摘要欄</em>に', '代筆したこと', '書いた人の名前'], 'size': 64, 'source': S_TEBIKI + ' p.1'},
    'ch3_b': {'type': 'doc', 'src': FORM, 'crop': [0.03, 0.43, 0.97, 0.7], 'boxes': [{'r': [0.371, 0.455, 0.762, 0.583], 'n': '5', 'kw': '配偶者の区分'},
                                                                                    {'r': [0.762, 0.633, 0.962, 0.696], 'n': '8', 'kw': '老人'},
                                                                                    {'r': [0.762, 0.527, 0.962, 0.633], 'n': '7', 'kw': '同居'}], 'source': S_FORM},
    'ch3_b_nakamura': {'type': 'doc', 'src': '2027kamitebiki_shinki_p2.png', 'crop': [0.07, 0.38, 0.7, 0.58], 'boxes': [{'r': [0.075, 0.425, 0.3, 0.52], 'kw': '奥さんの名前'},
                                                                                                                  {'r': [0.3, 0.425, 0.55, 0.49], 'kw': '上の欄'}], 'source': S_TEBIKI + ' p.2（記入例）', 'fiction': True},
    'ch3_c': {'type': 'doc', 'src': FORM, 'crop': [0.03, 0.71, 0.97, 0.965], 'boxes': [{'r': [0.771, 0.738, 0.962, 0.87], 'n': '13', 'kw': '年間所得'}], 'source': S_FORM},
    'ch3_change': {'type': 'cards', 'items': [{'label': '去年まで', 'value': '58万円'}, '→', {'label': '今年から', 'value': '62万円', 'red': True, 'kw': '62万円'}], 'size': 120,
                   'note': '扶養親族の所得の線', 'source': S_OSHIRASE + ' p.2'},
    'ch3_change_example': {'type': 'doc', 'src': '2027oshirase_p2.png', 'crop': [0.05, 0.62, 0.95, 0.9], 'boxes': [{'r': [0.5, 0.68, 0.65, 0.78], 'kw': 'パート'}], 'source': S_OSHIRASE + ' p.2'},
    'ch3_d': {'type': 'doc', 'src': '2027kamitebiki_shinki_p4.png', 'crop': [0.05, 0.02, 0.95, 0.32], 'boxes': [{'r': [0.07, 0.227, 0.7, 0.31], 'n': 'D', 'kw': '摘要'}], 'source': S_TEBIKI + ' p.4'},
    'ch3_mynumber': {'type': 'list', 'head': 'マイナンバーの欄', 'items': ['書かなくても<em>受け付けられる</em>', '一度書けば、次の年から不要'], 'mark': '●', 'size': 66, 'source': S_TEBIKI + ' p.2'},
    'ch3_bridge': {'type': 'img', 'img': '09_thumb_shock.png', 'bubble': '出し忘れたら？', 'bx': 760, 'by': 140},
    # ---- 4 ----
    'ch4_title': chap(4, '出さないと、<br>どうなるのか'),
    'ch4_conclusion': {'type': 'list', 'head': '先に結論', 'items': ['住民税の<em>配偶者控除</em>が受けられない', '非課税の世帯が<em>課税</em>に', '介護保険料まで上がることも'], 'mark': '●', 'size': 64},
    'ch4_faq': {'type': 'title', 'lines': ['<span style="font-size:58px">日本年金機構 よくある質問</span>', '提出しないと', '住民税で<em>各種控除が受けられません</em>'], 'size': 84, 'source': S_FAQ},
    'ch4_couple': {'type': 'img', 'img': '01_couple.png', 'head': '中村さん夫婦（さいたま市）', 'lines': ['夫 73歳・年金<em>200万円</em>', '妻 71歳・年金<em>70万円</em>', '収入は年金だけ'], 'size': 64, 'fiction': True},
    'ch4_husband_income': {'type': 'cards', 'items': [{'label': '年金', 'value': '200万円'}, '−', {'label': '公的年金等控除', 'value': '110万円'}, '=',
                                                      {'label': 'ご主人の所得', 'value': '90万円', 'red': True, 'kw': '90万円'}], 'size': 90, 'fiction': True},
    'ch4_no_shotokuzei': {'type': 'cards', 'items': [{'label': '所得税', 'value': 'かからない'}, '／', {'label': '住民税', 'value': '別の話', 'red': True, 'kw': '住民税'}], 'size': 96,
                          'note': '年金214万円未満は所得税がかからない', 'fiction': True},
    'ch4_line': {'type': 'table', 'title': '住民税がかからない線（さいたま市など1級地）', 'head': ['', '所得', '年金に直すと'], 'rows': [['一人暮らし', '45万円以下', '155万円'], ['配偶者を養う夫婦', '101万円以下', '211万円']],
                 'w': 1500, 'size': 62, 'at': ['一人暮らしなら', '夫婦なら'], 'source': S_KAISEI},
    'ch4_case_a': {'type': 'cards', 'items': [{'label': 'ご主人の所得', 'value': '90万円'}, '≦', {'label': '夫婦の線', 'value': '101万円'}, '→',
                                              {'label': '住民税', 'value': '非課税', 'kw': 'かかりません'}], 'size': 84, 'note': '申告書を出した場合', 'fiction': True},
    'ch4_case_b': {'type': 'cards', 'items': [{'label': 'ご主人の所得', 'value': '90万円'}, '＞', {'label': '一人の線', 'value': '45万円'}, '→',
                                              {'label': '住民税', 'value': '課税', 'red': True, 'kw': 'かかるんです'}], 'size': 84, 'note': '出さなかった場合', 'fiction': True},
    'ch4_tax_calc': {'type': 'table', 'title': 'ご主人の住民税（出さなかった場合・目安）', 'head': ['', '金額'], 'rows': [['所得', '90万円'], ['基礎控除', '−43万円'], ['保険料（仮）', '−15万円'],
                                                                                   ['課税所得', '約32万円'], ['住民税（年）', '<span class="red">約3万4500円</span>']],
                     'w': 1200, 'size': 52, 'at': ['所得90万円', '基礎控除', '保険料', '32万円', '3万4500円'], 'fiction': True},
    'ch4_kaigo_intro': {'type': 'img', 'img': '04_wife_naruhodo.png', 'head': '住民税のもう一つの役目', 'lines': ['65歳以上の', '<em>介護保険料の段階</em>を', '決めている'], 'size': 66},
    'ch4_kaigo_table': {'type': 'table', 'title': 'さいたま市の介護保険料（抜粋・年額）', 'head': ['段階', '対象', '年額'],
                        'rows': [['第1段階', '世帯全員非課税・年金82.65万円以下', '21,900円'], ['第3段階', '世帯全員非課税・120万円超', '52,600円'],
                                 ['第4段階', '本人非課税・世帯に課税者', '69,100円'], ['第6段階', '本人課税・所得120万円未満', '84,500円']],
                        'w': 1700, 'size': 46, 'source': S_SAITAMA},
    'ch4_kaigo_a': {'type': 'table', 'title': '出した場合（世帯全員 非課税）', 'head': ['', '段階', '年額'], 'rows': [['ご主人', '第3段階', '52,600円'], ['奥さん', '第1段階', '21,900円']],
                    'w': 1300, 'size': 64, 'at': ['ご主人は', '奥さんは'], 'fiction': True, 'source': S_SAITAMA},
    'ch4_kaigo_b': {'type': 'table', 'title': '出さなかった場合', 'head': ['', '段階', '年額', '差'], 'rows': [['ご主人', '第6段階', '84,500円', '<span class="red">+31,900円</span>'],
                                                                                                        ['奥さん', '第4段階', '69,100円', '<span class="red">+47,200円</span>']],
                    'w': 1600, 'size': 62, 'at': ['ご主人は', '奥さんは'], 'fiction': True, 'source': S_SAITAMA},
    'ch4_total': {'type': 'title', 'img': '09_thumb_shock.png', 'lines': ['住民税＋介護保険料', 'ご夫婦で', '<em>年約11万3600円</em>'], 'size': 104, 'fiction': True},
    'ch4_kyufukin': {'type': 'img', 'img': '07_passbook.png', 'head': '年金生活者支援給付金', 'lines': ['条件は<em>世帯全員が非課税</em>', '課税の人が出ると', '受け取れないことも'], 'size': 62},
    'ch4_caution': {'type': 'list', 'head': 'ご注意', 'items': ['今年度のさいたま市の表で出した<em>目安</em>', '介護保険料は来年度に見直し', '線は地域で少しずつ違う', '自分の額は市区町村の窓口へ'], 'mark': '●', 'size': 58},
    'ch4_when': {'type': 'cards', 'items': [{'label': '令和9年分の申告書', 'value': '今年出す'}, '→', {'label': '使われるのは', 'value': '令和10年度 住民税', 'red': True}], 'size': 70,
                 'note': '出し忘れても、確定申告・住民税の申告で控除は受けられる'},
    'ch4_bridge': {'type': 'img', 'img': '07_passbook.png', 'bubble': '戻ってくるお金は？', 'bx': 760, 'by': 140},
    # ---- 5 ----
    'ch5_title': chap(5, '12月に戻ってくる<br>税金と、出し方'),
    'ch5_conclusion': {'type': 'cards', 'items': [{'label': '去年まで', 'value': '205万円'}, '→', {'label': '今年から', 'value': '214万円', 'red': True}], 'size': 110,
                       'note': '所得税がかからない年金の線（65歳以上）', 'source': S_KAISEI},
    'ch5_line': {'type': 'list', 'head': '所得税がかからない年金', 'items': ['65歳以上 <em>214万円未満</em>（去年まで205万円）', '65歳未満 164万円未満（去年まで155万円）'], 'mark': '●', 'size': 58, 'source': S_KAISEI},
    'ch5_timing': {'type': 'months', 'items': [{'m': '2月', 'v': '前の<br>ルール'}, {'m': '4月', 'v': '前の<br>ルール'}, {'m': '6月', 'v': '前の<br>ルール'}, {'m': '8月', 'v': '前の<br>ルール'},
                                               {'m': '10月', 'v': '前の<br>ルール'}, {'m': '12月', 'v': '1年分を<br>計算し直し', 'on': True}], 'note': '引きすぎた分は12月に戻る', 'note_kw': '戻す', 'source': S_KAISEI},
    'ch5_example': {'type': 'table', 'title': '日本年金機構の例', 'head': ['', '1回あたり'], 'rows': [['前のルール', '6,000円'], ['新しいルール', '4,600円'], ['引きすぎ × 5回', '7,000円'],
                                                                                        ['12月に戻る', '<span class="red">2,400円</span>']],
                    'w': 1200, 'size': 58, 'at': ['6000円', '4600円', '7000円', '2400円'], 'source': S_KAISEI},
    'ch5_who': {'type': 'img', 'img': '07_passbook.png', 'head': '12月の振込', 'lines': ['税金が引かれるどころか', '<em>上乗せ</em>されることも', '額は人によって違う'], 'size': 64},
    'ch5_link': {'type': 'cards', 'items': [{'label': '家族を届けた', 'value': '控除あり'}, '／', {'label': '届けていない', 'value': '控除なし', 'red': True}], 'size': 92,
                 'note': '12月の計算にも申告書の内容が使われる'},
    'ch5_how': {'type': 'list', 'head': '出し方① 郵送', 'items': ['同封の返信用封筒', '切手は自分で貼る（普通郵便 110円）', '年金事務所に持参なら切手不要'], 'mark': '●', 'size': 60, 'source': S_TEBIKI + ' p.1'},
    'ch5_online': {'type': 'img', 'img': '06_smartphone.png', 'head': '出し方② 電子申請', 'lines': ['マイナポータルから', '<em>切手代なし</em>', '紙は出さなくてよい'], 'size': 64, 'source': '日本年金機構「令和9年分 扶養親族等申告書（紙の提出）」'},
    'ch5_past': {'type': 'list', 'head': '昔の分', 'items': ['所得税は<em>5年前</em>までさかのぼって還付申告', '住民税は市区町村ごとに扱いが違う'], 'mark': '●', 'size': 60},
    'ch5_help': {'type': 'doc', 'src': '2027oshirase_p4.png', 'crop': [0.03, 0.82, 0.97, 0.99], 'boxes': [{'r': [0.04, 0.87, 0.9, 0.93], 'kw': 'ダイヤル'}], 'source': S_OSHIRASE + ' p.4'},
    # ---- 정리 ----
    'summary_todo': {'type': 'list', 'head': 'やること', 'items': ['封筒を開けて<em>4つの質問</em>に答える', '家族を養っているなら<em>期限までに提出</em>', '12月の通知書で戻る額を確かめる'],
                     'mark': '☑', 'size': 62, 'at': ['やること1', 'やること2', 'やること3']},
    'closing': {'type': 'title', 'img': '01_couple.png', 'lines': ['今年はじめての封筒は', '<em>守れるお金</em>の入り口'], 'size': 92},
}
Path(__file__).with_name('visuals.json').write_text(json.dumps(V, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(len(V) - 1, 'visuals')
