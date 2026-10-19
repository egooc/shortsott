# -*- coding: utf-8 -*-
"""2편 장면표(visuals.json) 생성 — script.txt 의 @id 마다 화면 하나. 숫자는 human_check.md 와 같은 계산."""
import json
import re
from pathlib import Path

EP = Path(__file__).resolve().parent
NTA1600 = '国税庁 タックスアンサー No.1600「公的年金等の課税関係」'
NTA1120 = '国税庁 タックスアンサー No.1120「医療費を支払ったとき（医療費控除）」'
NTA1122 = '国税庁 タックスアンサー No.1122「医療費控除の対象となる医療費」'
NTA1160 = '国税庁 タックスアンサー No.1160「障害者控除」'
HAMA = '浜松市「市民税・県民税の申告」'
SAI_NT = 'さいたま市「納税義務者」（非課税の基準）'
SAI_KJ = 'さいたま市「所得控除」'
GEN = '日本年金機構「公的年金等の源泉徴収票」見本'
TAX = [0.622, 0.196, 0.992, 0.265]
SHA = [0.788, 0.418, 0.992, 0.539]
RED = lambda s: f'<span class="red">{s}</span>'


def gen(kw, box):
    return {"type": "doc", "src": "gensen.png", "page": [2088, 1348], "crop": [0, 0, 1, 1],
            "boxes": [{"r": box, "kw": kw}], "source": GEN}


def ch(n, t):
    return {"type": "title", "lines": [f'<span class="k">{n}</span>', t], "size": 104}


def card(label, value, red=False, kw=None):
    d = {"label": label, "value": value}
    if red:
        d["red"] = True
    if kw:
        d["kw"] = kw
    return d


V = {
    "hook_doc": {"type": "title", "img": "03_reading.png", "lines": ["年金だけの方へ", "<em>確定申告不要</em>でも", "住民税は別"], "size": 110},
    "hook_question": {"type": "title", "lines": ["申告しなくていいのに", "<em>損している人</em>がいる"], "size": 110},
    "hook_answer": {"type": "cards", "items": [card("所得税", "国（税務署）"), "≠", card("住民税", "市区町村", True, "別々")], "size": 84, "note": "計算する所が違う"},
    "hook_nta": {"type": "list", "head": "国税庁の案内より", "items": ["確定申告の必要がない場合でも", "<em>住民税の申告</em>が必要な場合があります"], "mark": "", "size": 64, "source": NTA1600},
    "hook_money": {"type": "title", "img": "09_thumb_shock.png", "lines": ["届け出だけで", "<em>年およそ3万5000円</em>", "軽くなる例も"], "size": 110, "fiction": True},
    "hook_two": gen("税額の欄", TAX),
    "ch1_title": ch(1, "申告しなくて<br>いい人の線"),
    "ch1_line": {"type": "cards", "items": [card("年金の収入", "400万円以下"), "＋", card("年金以外の所得", "20万円以下", True, "20万円")], "size": 76, "note": "両方満たすと、所得税の確定申告は不要", "source": NTA1600},
    "ch1_income": {"type": "table", "title": "収入と所得（65歳以上・年金330万円未満）", "head": ["", "金額"], "rows": [["年金の収入", "200万円"], ["差し引く額", "−110万円"], ["所得", RED("90万円")]], "w": 1300, "size": 58, "at": ["収入は", "所得は", "110万円", "90万円"], "source": NTA1600},
    "ch1_why": {"type": "img", "img": "07_passbook.png", "head": "なぜ申告不要？", "lines": ["所得税は<em>年金から先に</em>", "引かれているから"], "size": 70},
    "ch1_but": {"type": "title", "lines": ["ただし", "これは<em>所得税</em>の話"], "size": 118},
    "ch2_title": ch(2, "住民税は、<br>話が別"),
    "ch2_report": {"type": "cards", "items": [card("日本年金機構", "年金の額"), "→", card("公的年金等支払報告書", "市区町村へ", True, "支払報告書")], "size": 64, "note": "年金だけの方は、これで住民税が計算される"},
    "ch2_missing": {"type": "list", "head": "報告書に載らないもの", "items": ["病院・薬局に払った<em>医療費</em>", "年金から引かれていない<em>保険料</em>", "<em>生命保険料</em>など"], "mark": "✕", "size": 62, "at": ["医療費", "保険料", "生命保険料"]},
    "ch2_hamamatsu": {"type": "list", "head": "住民税の申告が必要な人（年金400万円以下）", "items": ["年金以外の所得が<em>20万円以下</em>ある人", "源泉徴収票と違う内容で<em>控除</em>を申告する人"], "mark": "●", "size": 60, "at": ["1つ目", "2つ目"], "source": HAMA},
    "ch2_case1": {"type": "img", "img": "05_counter.png", "head": "ケース1", "lines": ["シルバー人材センター・原稿料など", "所得税：申告不要", "住民税：<em>原則申告</em>"], "size": 58},
    "ch2_case2": {"type": "img", "img": "04_wife_naruhodo.png", "head": "ケース2（今日の本題）", "lines": ["医療費控除などを使う", "住民税の申告で", "<em>住民税が下がる</em>ことも"], "size": 58},
    "ch2_point": {"type": "cards", "items": [card("所得税", "0円"), "でも", card("住民税", "かかる", True, "かかっていることが多い")], "size": 84, "note": "住民税は少ない年金でもかかる"},
    "ch2_check": {"type": "img", "img": "02_mailbox.png", "head": "確かめ方", "lines": ["6月ごろの通知", "年金から住民税が<em>引かれていれば</em>", "かかっている"], "size": 60},
    "ch3_title": ch(3, "医療費で、<br>いくら戻るのか"),
    "ch3_formula": {"type": "table", "title": "医療費控除の計算", "head": ["", "内容"], "rows": [["払った医療費", "1年分の合計"], ["戻ったお金", "保険などで補てん"], ["さらに引く", "10万円（所得200万円未満は" + RED("所得の5%") + "）"]], "w": 1600, "size": 56, "at": ["医療費から", "戻ってきたお金", "10万円"], "source": NTA1120},
    "ch3_5percent": {"type": "cards", "items": [card("所得140万円の5%", "7万円", True, "7万円"), "＜", card("よく言われる線", "10万円")], "size": 80, "note": "年金だけの方は、10万円より低い額から使える"},
    "ch3_family": {"type": "img", "img": "01_couple.png", "head": "覚えておくと得", "lines": ["一緒に暮らす<em>家族の分</em>も", "まとめて申告できる"], "size": 66, "source": NTA1120},
    "ch3_couple": {"type": "table", "title": "小林さん夫婦（架空）", "head": ["", "ご主人", "奥さん"], "rows": [["年齢", "76歳", "73歳"], ["年金（年）", "250万円", "70万円"], ["医療費（夫婦）", RED("30万円"), ""]], "w": 1400, "size": 58, "fiction": True, "at": ["ご主人は", "奥さんは", "30万円"]},
    "ch3_income": {"type": "table", "title": "ご主人の所得", "head": ["", "金額"], "rows": [["年金", "250万円"], ["差し引く額", "−110万円"], ["所得", RED("140万円")], ["所得税（1年分）", "0円"]], "w": 1200, "size": 56, "fiction": True, "at": ["250万円", "110万円", "140万円", "所得税はかかりません"]},
    "ch3_juminzei": {"type": "cards", "items": [card("ご主人の所得", "140万円"), "＞", card("夫婦の線（さいたま市）", "101万円"), "→", card("住民税", "かかる", True, "払う側")], "size": 66, "fiction": True, "source": SAI_NT},
    "ch3_calc_a": {"type": "table", "title": "届けなかった場合（目安）", "head": ["", "金額"], "rows": [["所得", "140万円"], ["基礎控除", "−43万円"], ["配偶者（70歳以上）", "−38万円"], ["保険料（仮）", "−15万円"], ["税金のかかる額", "44万円"], ["所得割（年）", RED("約3万6500円")]], "w": 1200, "size": 50, "fiction": True, "at": ["140万円", "43万円", "38万円", "15万円", "44万円", "3万6500円"], "source": SAI_KJ},
    "ch3_deduct": {"type": "cards", "items": [card("医療費", "30万円"), "−", card("所得の5%", "7万円"), "＝", card("医療費控除", "23万円", True, "23万円")], "size": 66, "fiction": True},
    "ch3_calc_b": {"type": "table", "title": "届けた場合（目安）", "head": ["", "金額"], "rows": [["税金のかかる額", "44万円"], ["医療費控除", "−23万円"], ["残り", "21万円"], ["所得割（年）", RED("約1万3500円")]], "w": 1200, "size": 54, "fiction": True, "at": ["44万円", "23万円", "21万円", "1万3500円"]},
    "ch3_diff": {"type": "bars", "title": "小林さんのご主人・住民税（所得割）", "groups": [{"label": "届けない", "bars": [{"value": 36500, "label": "約3万6500円"}]}, {"label": "届ける", "bars": [{"value": 13500, "label": "約1万3500円", "red": True}]}], "max": 40000, "at": ["3万6500円", "1万3500円"], "note": "差は年およそ2万3000円", "fiction": True},
    "ch3_single_intro": {"type": "title", "lines": ["もう一人", "<em>一人暮らし</em>の場合"], "size": 110},
    "ch3_single": {"type": "table", "title": "佐々木さん（架空）", "head": ["", "内容"], "rows": [["年齢", "82歳・一人暮らし"], ["年金（年）", "190万円"], ["医療費", RED("20万円")]], "w": 1300, "size": 58, "fiction": True, "at": ["82歳", "190万円", "20万円"]},
    "ch3_single_line": {"type": "cards", "items": [card("所得", "80万円"), "＞", card("一人の線", "45万円"), "→", card("住民税", "かかる", True, "払う側")], "size": 70, "fiction": True, "source": SAI_NT},
    "ch3_single_calc": {"type": "table", "title": "届けなかった場合（目安）", "head": ["", "金額"], "rows": [["所得", "80万円"], ["基礎控除", "−43万円"], ["保険料（仮）", "−10万円"], ["税金のかかる額", "27万円"], ["所得割（年）", RED("約2万4500円")]], "w": 1200, "size": 52, "fiction": True, "at": ["80万円", "43万円", "10万円", "27万円", "2万4500円"]},
    "ch3_single_deduct": {"type": "cards", "items": [card("医療費控除", "16万円"), "→", card("所得割（年）", "約8500円", True, "8500円")], "size": 76, "fiction": True},
    "ch3_single_diff": {"type": "bars", "title": "佐々木さん・住民税（所得割）", "groups": [{"label": "届けない", "bars": [{"value": 24500, "label": "約2万4500円"}]}, {"label": "届ける", "bars": [{"value": 8500, "label": "約8500円", "red": True}]}], "max": 30000, "at": ["1万6000円", "1万7000円"], "note": "医療費20万円＝月1万7000円ほど", "fiction": True},
    "ch3_note": {"type": "list", "head": "正直にお伝えすること", "items": ["下がるのは<em>所得割</em>の部分", "年5000円ほどの<em>均等割</em>は変わらない", "非課税の判定・<em>介護保険料の段階</em>は控除前の所得で決まる"], "mark": "●", "size": 56, "at": ["所得に対して", "全員が同じ額", "介護保険料の段階"], "source": SAI_NT},
    "ch3_withheld": gen("税額の欄", TAX),
    "ch3_total": {"type": "cards", "items": [card("住民税", "約2万3000円↓"), "＋", card("所得税", "1万2000円戻る"), "＝", card("1年で", "約3万5000円", True, "3万5000円")], "size": 62, "fiction": True},
    "ch4m_title": ch(4, "医療費に入るもの、<br>入らないもの"),
    "ch4m_intro": {"type": "img", "img": "08_desk.png", "head": "いちばん多い失敗", "lines": ["入れていいものを", "<em>入れ忘れる</em>"], "size": 70},
    "ch4m_yes1": {"type": "list", "head": "入るもの①", "items": ["診察・治療の<em>自己負担</em>", "入院の部屋代・食事代（治療に必要な分）", "<em>歯医者</em>の治療費・治療に必要な入れ歯"], "mark": "○", "size": 56, "at": ["診察", "入院", "歯医者"], "source": NTA1122},
    "ch4m_yes2": {"type": "list", "head": "入るもの②", "items": ["処方せんの薬", "治療のための<em>市販薬</em>（かぜ薬など）"], "mark": "○", "size": 62, "at": ["処方せん", "かぜ薬"], "source": NTA1122},
    "ch4m_bus": {"type": "img", "img": "05_counter.png", "head": "通院の電車代・バス代", "lines": ["医療費に<em>入る</em>", "日付・病院・金額をメモ"], "size": 64, "source": NTA1122},
    "ch4m_taxi": {"type": "cards", "items": [card("タクシー代", "原則入らない"), "→", card("電車・バスが使えない時", "入る", True, "入ります")], "size": 62, "source": NTA1122},
    "ch4m_kaigo": {"type": "list", "head": "介護保険サービス", "items": ["訪問看護など", "一部の施設サービスの<em>自己負担分</em>", "領収書に対象額が書かれていることも"], "mark": "○", "size": 58, "source": NTA1122},
    "ch4m_omutsu": {"type": "list", "head": "おむつ代（条件つき）", "items": ["寝たきりで医師の治療を受けている", "<em>おむつ使用証明書</em>（医師）", "要介護の方は市区町村の確認書で代わりにできる場合"], "mark": "○", "size": 54, "source": NTA1122},
    "ch4m_no": {"type": "list", "head": "入らないもの", "items": ["自家用車の<em>ガソリン代・駐車場代</em>", "予防・健康のための<em>ビタミン剤</em>", "健康診断の費用", "家族への付き添い料"], "mark": "✕", "size": 56, "at": ["ガソリン代", "ビタミン剤", "健康診断", "付き添い"], "source": NTA1122},
    "ch4m_glasses": {"type": "cards", "items": [card("ふだんの眼鏡・補聴器", "入らない"), "／", card("治療に必要と医師が認めたもの", "入る", True, "入ります")], "size": 56, "source": NTA1122},
    "ch4m_sum": {"type": "img", "img": "03_reading.png", "head": "忘れがち", "lines": ["通院のバス代", "歯医者の入れ歯", "薬局の<em>かぜ薬</em>"], "size": 64},
    "ch5_title": ch(5, "医療費のほかにも、<br>届けると下がるもの"),
    "ch5_intro": {"type": "list", "head": "源泉徴収票に載らない控除", "items": ["天引きでない<em>保険料</em>", "生命保険料・地震保険料", "<em>障害者控除</em>"], "mark": "", "size": 64},
    "ch5_hoken": gen("載ります", SHA),
    "ch5_family": {"type": "img", "img": "01_couple.png", "head": "保険料は払った人の控除", "lines": ["奥さんの分も", "<em>ご主人の口座</em>から払えば", "ご主人の控除に"], "size": 60, "source": SAI_KJ},
    "ch5_seimei": {"type": "img", "img": "02_mailbox.png", "head": "② 生命保険料・地震保険料", "lines": ["秋ごろに<em>控除証明書</em>", "住民税の申告で届けられる"], "size": 60, "source": SAI_KJ},
    "ch5_shogai": {"type": "img", "img": "05_counter.png", "head": "③ 障害者控除", "lines": ["手帳がなくても受けられる場合", "65歳以上で市区町村の<em>認定</em>", "障害者控除対象者認定書"], "size": 56, "source": NTA1160},
    "ch5_shogai_amount": {"type": "table", "title": "障害者控除の額", "head": ["", "住民税", "所得税"], "rows": [["障害者", "26万円", "27万円"], ["特別障害者", RED("30万円"), RED("40万円")]], "w": 1400, "size": 60, "at": ["26万円", "27万円"], "source": "さいたま市「所得控除」・国税庁 No.1160"},
    "ch5_note": {"type": "title", "lines": ["届けなければ", "市区町村は<em>知らない</em>"], "size": 112},
    "ch6_title": ch(6, "どの紙を、<br>どこに出すのか"),
    "ch6_gensen": gen("源泉徴収税額", TAX),
    "ch6_flow": {"type": "flow", "n": "2つの質問", "q": "税額の欄に金額は？<br>医療費は10万円か所得の5%を超える？", "a": "この2つで、出す紙が決まる", "a_kw": "2つの質問"},
    "ch6_flow_a": {"type": "cards", "items": [card("税額あり＋医療費超え", "確定申告"), "→", card("税務署", "所得税が戻る", True, "所得税が戻り")], "size": 58, "note": "住民税も下がる（別の申告は不要）"},
    "ch6_flow_b": {"type": "cards", "items": [card("税額0円＋医療費超え", "住民税の申告"), "→", card("市区町村", "住民税が下がる", True, "住民税が下がります")], "size": 58},
    "ch6_flow_c": {"type": "cards", "items": [card("医療費が超えない", "控除なし"), "／", card("年金以外の所得20万円以下", "住民税の申告", True, "住民税の申告が必要")], "size": 56},
    "ch6_form": {"type": "list", "head": "住民税の申告書", "items": ["市区町村の窓口・ホームページ", "名前・住所・<em>年金の額</em>", "<em>医療費控除</em>の欄"], "mark": "●", "size": 60, "at": ["窓口", "年金の額", "医療費控除の欄"]},
    "ch6_receipt": {"type": "list", "head": "医療費の明細書", "items": ["領収書を<em>人ごと・病院ごと</em>に合計", "領収書は出さなくてよい", "<em>5年間</em>は保管"], "mark": "●", "size": 60, "at": ["人ごと", "出さなくて", "5年間"], "source": NTA1120},
    "ch6_notice": {"type": "img", "img": "02_mailbox.png", "head": "医療費のお知らせ", "lines": ["健康保険・後期高齢者医療から", "明細書の<em>手間が減る</em>"], "size": 60},
    "ch6_deadline": {"type": "table", "title": "期限", "head": ["", "いつまで"], "rows": [["住民税の申告", RED("3月15日") + "（原則）"], ["所得税の還付申告", "1月1日から" + RED("5年間")]], "w": 1400, "size": 58, "at": ["3月15日", "5年間"]},
    "ch6_where": {"type": "img", "img": "05_counter.png", "head": "わからないとき", "lines": ["市区町村の<em>市民税</em>の担当", "税務署", "源泉徴収票と領収書を持って"], "size": 58},
    "ch7_title": ch(7, "よくある疑問"),
    "ch7_q1": {"type": "flow", "n": "疑問1", "q": "申告したら<br>かえって上がらない？", "a": "控除を届けるだけなら<em>上がらない</em>", "a_kw": "上がることはありません"},
    "ch7_q2": {"type": "flow", "n": "疑問2", "q": "去年・おととしの分も<br>出せる？", "a": "所得税の還付申告は<em>5年前</em>まで", "a_kw": "5年前"},
    "ch7_q3": {"type": "flow", "n": "疑問3", "q": "窓口に<br>行けないときは？", "a": "郵送・<em>スマートフォン</em>（マイナンバーカード）", "a_kw": "スマートフォン"},
    "ch7_q4": {"type": "flow", "n": "疑問4", "q": "薬局の薬だけで<br>10万円に届かない", "a": "<em>セルフメディケーション税制</em>（医療費控除とどちらか一方）", "a_kw": "セルフメディケーション"},
    "ch7_q5": {"type": "flow", "n": "疑問5", "q": "家族が代わりに<br>申告してもいい？", "a": "ご本人の申告書を<em>家族が書いて届けられる</em>", "a_kw": "届けることはできます"},
    "summary_title": {"type": "title", "lines": ["今日の話を", "<em>手順</em>に"], "size": 118},
    "summary_todo": {"type": "list", "head": "やること", "items": ["1月の<em>源泉徴収票</em>の税額の欄を見る", "去年の<em>医療費</em>を領収書で合計", "税額あり→確定申告／0円→<em>住民税の申告</em>"], "mark": "☑", "size": 58, "at": ["やること1", "やること2", "やること3"]},
    "summary_close": {"type": "title", "img": "01_couple.png", "lines": ["住民税は", "<em>届けて</em>はじめて", "正しく計算される"], "size": 96},
    "_emph": ["確定申告", "住民税", "源泉徴収票", "医療費控除", "医療費", "5パーセント", "申告", "控除", "3月15日", "5年"],
}

(EP / 'visuals.json').write_text(json.dumps(V, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
ids = re.findall(r'^@(\S+)', (EP / 'script.txt').read_text(encoding='utf-8'), re.M)
print('missing', [i for i in ids if i not in V], 'unused', [k for k in V if k not in ids and k != '_emph'])
