# 쓸모연구소 쇼핑쇼츠 밤 생산 (헤드리스 1회차)

너는 쓸모연구소(쿠팡 파트너스 쇼핑쇼츠) 밤 생산 담당이다. 사람은 자고 있다. 묻지 말고 끝까지 하되, 아래 «멈춤 규칙»에 걸리면 그 편은 버리고 다음 편으로 간다.
작업 기준 문서: `D:/midform/docs/shopping-growth-mode.md`(1~10절), `D:/midform/docs/shopping-ff-template.md`. 먼저 둘 다 읽어라.

## 0. 몇 편 만드나
- `D:/volcano-runs/_upload/produce.lock` 의 `need` 편을 만든다(보통 1~2).
- 각 편은 따로 끝까지 마친다(편 하나 끝 → 다음 편). 시간 한도는 회차 전체 3시간.
- `D:/midform/politics-hour/RENDERING.lock` 이 있으면 정치 롱폼이 렌더 중이다 — 무거운 일(LaMa 지우기·ff_render)은 동시에 여러 개 돌리지 말고 한 번에 하나씩.
- 디스크(10/15 D: 여유 6GB대까지 떨어짐): 편을 시작할 때마다 `df -h /d` 로 D: 여유를 본다. 한 편에 약 1GB 를 쓴다. 3GB 미만이면 그 편은 시작하지 않고 보고서에 «디스크 부족 멈춤»을 적고 끝낸다. 편이 끝나면 `src/` 의 쓰지 않은 원본과 `footage/*_raw.mp4`(지우기 전 클립)를 그 자리에서 지운다(clean 클립·렌더 결과·시트는 남긴다). 다른 폴더는 지우지 않는다.

## 1. 소재 고르기
- 최신 `D:/volcano-runs/_cand/refs/remake_*.md` 표에서 고른다. 이미 쓴 것은 뺀다:
  `D:/volcano-runs/_upload/*.json` 의 `remake_of.url` 과 `product` 를 모두 읽어 겹치는 레퍼런스·같은 상품군은 제외.
- 살림(주방·욕실·수납·청소·세탁)만. 아기용품·완구·문구·패션은 받지 않는다(2절).
- 바로 앞 두 편과 다른 공간(주방/욕실/세탁/수납)을 고른다 — 같은 틀 반복은 재사용 콘텐츠로 걸린다(8절).
- 표가 비었거나 다 썼으면 `node D:/midform/scripts/shop_ref_discover.js` 를 한 번 돌리고 다시 본다. 그래도 없으면 «멈춤».

## 2. 소스 찾기 (10절 — 상품명 말고 장면 묘사로)
- 작업 폴더 `D:/volcano-runs/ffrefNN` (NN = 기존 ffref 다음 번호). 하위 `cand/ src/ sheets/ footage/`.
- 일본어: `node D:/midform/scripts/tt_search.js "<장면 묘사 일본어>" --count 20 --out <wd>/cand/tt1.json`
- 중국어: `node D:/midform/scripts/douyin-search.js --keyword <중국어> --pages 1 --sort likes --max-dur 60 --out <wd>/cand/dy1.json`
- 받기: 더우인 `node D:/midform/scripts/douyin-grab.js --out <wd>/src <aweme_id...>`(1080p H.264), 틱톡 `node D:/midform/scripts/tt_search.js --get <id> --dir <wd>/src`
- 6~10개 받고 1초 간격 컨택트 시트로 전부 본다: `ffmpeg -i x.mp4 -vf "fps=1,scale=216:384,tile=9x4" -frames:v 1 sheets/x.jpg` (drawtext 쓰지 말 것 — 이 PC ffmpeg 가 죽는다). 시트는 Read 로 직접 본다.
- 필요한 장면: ① 문제 장면(제품이 안 보이거나 같은 제품) ② 사용 장면 ③ 결과 장면.
- 받은 소스마다 역할을 정한다(규칙집 S9): 메인(처음부터 끝까지 뼈대가 되는 한 편) / 후킹(첫 3초만) / 조합(증거·의심 답 한 컷). 후킹용 소스를 뼈대로 쓰지 않는다. 보고서에 역할을 적는다.
- ★**제품 외형이 같은 소스만 섞는다.** 문제 장면에 다른 제품이 비치면 그 구간은 버린다.
- 틱톡샵 광고(#tiktokshop·#ad·할인 문구)는 소스로는 쓸 수 있지만 문구가 박힌 구간은 버린다.
- 폭 720 미만은 쓰지 않는다.
- 검색 중에 해외 유튜버가 같은 상품을 리뷰·비교한 영상이 걸리면 그것도 소스로 쓸 수 있다(10/14 소유주: 새 레인이 아니라 이런 소재를 찾았을 때 쓰는 소스. 예: 해외여행이슈 «외국인이 극찬한 한국 물건», Sorted Food 그릴 비교 314만).
  - 원음 영어는 살리지 말고 한국어 해설로 끌고 간다. 출연자 반응 한마디만 짧게.
  - 출처는 설명란 끝 `@핸들` 에 더해 고정 댓글에 «출처: <채널명> / 원본: <URL>».
- 같은 상품 이름이라도 영상마다 모양이 다르다(ffref03 국자 받침: 접시형·컵형·스탠드형이 섞여 나왔다). **쿠팡에 같은 모양이 있는 쪽으로 소재 모양을 정하고**, 그 모양 소스만 쓴다. 문제 장면은 제품이 안 보이는 구간이면 다른 영상에서 가져와도 된다.
- 쓸 구간의 앞뒤 경계는 0.25~0.5초 간격 시트로 따로 본다 — 1초 시트에선 구간 끝에 다른 제품·포장 비닐이 끼어든 게 안 보였다(ffref03 에서 3번 고쳤다).

## 3. 쿠팡 링크 (영상 속 모양과 같은 상품에만)
- 검색: `node -e "const c=require('D:/midform/scripts/coupang_api');c.call('GET','/products/search',{query:'keyword='+encodeURIComponent('<검색어>')+'&limit=10'}).then(r=>(r.data.productData||[]).forEach(x=>console.log(x.productId,x.productPrice,x.isRocket?'R':'',x.productName,x.productImage)))"`
- 상품 사진을 `curl -s -L -A "Mozilla/5.0" -o <wd>/cand/cp_<id>.jpg <url>` 로 받아 **눈으로 모양을 대조**한다. 같은 모양이 없으면 그 소재는 «멈춤»(비슷한 다른 제품에 링크 금지).
- 같은 모양이 여럿이면 검색 순위가 높은 로켓배송.
- 링크: `node D:/midform/scripts/coupang_api.js deeplink https://www.coupang.com/vp/products/<id>` → shortenUrl. `curl -s -o /dev/null -w "%{http_code}" -A "Mozilla/5.0" <short>` 가 302 인지 확인.
- 상품 사진은 `<wd>/cp_img.jpg` 로 복사(인포크용).

## 4. 자막 지우기
- 쓸 구간만 잘라 H.264 로: `ffmpeg -ss <t0> -to <t1> -i src/x.mp4 -c:v libx264 -preset medium -crf 12 -pix_fmt yuv420p -an footage/<이름>_raw.mp4` (짧은 클립이면 통째로).
- 지우기(GPU, 순서대로 하나씩): `cd D:/tools/vsr && ./.venv/Scripts/python.exe D:/midform/scripts/ocr_lama_erase.py <raw> <clean> --grow 60` — 실패하면 같은 명령을 한 번 더(캐시로 이어진다). ★지우기는 이 원본 `scripts/ocr_lama_erase.py` 만 쓴다. `_night_tools/ocr_lama_erase_crop.py`(10/14 밤 회차가 만든 빠른 복사본)는 화질 비교 전까지 쓰지 않는다(소유주 결정 대기). 지우기 작업은 한 번에 하나씩 — 10/14 에 두 개를 겹쳐 돌려 클립 두 개가 깨졌다.
- 지운 뒤 clean 클립 시트를 다시 보고 회색 얼룩·남은 글자를 확인한다. 얼룩이 큰 구간은 쓰지 않는다. 상품 로고 클로즈업은 지우지 말고 원본(erase:false)으로.

## 5. 원고 + plan.json (키우기 편 — 6절 «성장 모드»)
- 형식은 `D:/volcano-runs/ffref03/plan.json`(deco) 또는 `plan_clean.json`(clean) 을 본보기로(같은 키: voice.tempo 1.35, badge, segments[text/emph/cont/media/tags], variants.social/ig).
- 구조: 하지 마세요 훅(문제 장면) → 왜 그런지 → «그래서 이런 걸 둔다»(상품은 답으로 한 번) → 쓰는 장면 3~5개(의심에 답하기 한 줄 포함) → 누가 쓰면 좋은지 → "저장해 두고…".
- 가격·배송·할인·"아래 링크" 멘트, 빨간 화살표 금지. 첫 3초에 상품을 들이밀지 않는다.
- 사실은 확인된 것만. 효능·숫자를 지어내지 않는다. 판매 페이지 문구(304 스테인리스 등)는 "~래요" 대신 화면에 보이는 것만 말한다.
- 자막 한 장 12자 안팎(`/` 로 끊기), 숫자는 `{보이는|읽는}`.
- 감정 장치(전자책 규칙집 `D:/midform/docs/ebook-rules-20261015.md` W1~W4, 10/15 채택): 원고를 쓴 뒤 문장마다 «감정/정보»를 붙여 보고 고친다.
  - 감정 장치 = 권위·감탄 어휘·의성어·반전. 이야기 장치는 적극 쓴다(10/15 소유주 «허구 서사는 말에 맛을 더하는 거… 그게 기획이야»): 화자 페르소나(«30년 주방장이 알려주는…»)·캐릭터 설정·의인화.
  - 남는 선 셋: ① 제품 효능·수치·가격은 사실만. ② 댓글 캡처 조작 없음. ③ 지어낸 인물이 «이 제품을 써 봤더니 좋더라»고 보증·추천하는 말은 하지 않는다(광고의 추천·보증 표시 기준). 페르소나는 문제와 요령을 말하는 화자로만 쓰고, 제품 평가는 화면에 보이는 사실로 한다. 감정 문장이 전체의 45~50%. 정보 문장만 3개 연달아 나오면 하나를 감정으로 바꾼다.
  - 첫 문장, «그래서 이런 걸 둔다» 바로 앞 예고 문장(«여기서부터가 핵심이에요» 류, 한 번만), 마지막 문장은 반드시 감정. 끝은 결과 확인 + 감탄 + 작은 반전.
  - 화면에 보이는 걸 그대로 읽는 문장은 30% 이하. 해설은 화면이 못 보여 주는 것(이유·느낌·의외의 점)을 말한다.
  - 보고서 단락에 «감정 n / 전체 m» 을 적는다.
- ★화면 두 가지를 섞어 올리고 반응을 비교한다(10/14 소유주 «깨끗한 버전이랑 기존 버전 섞어서 올려보고 반응 보면서 발전»).
  - 정하는 법: 번갈아 간다. `D:/volcano-runs/_upload/ff*.json` 중 수정 시각이 가장 늦은 메타의 `style` 과 반대로 시작하고(그게 deco 면 clean), 한 밤에 2편이면 두 편이 서로 다르게(clean 1·deco 1).
  - `clean`: plan 에서 `badge`·`badge_dur`·`tags` 를 빼고 `emph: []`. 흰 자막 한 줄 + 우상단 «광고»만(본보기 ffref03/plan_clean.json, 레퍼런스 기어로그·미니하우스 Pick).
  - `deco`: 지금까지처럼 badge·tags·emph 를 쓴다(본보기 ffref03/plan.json).
  - 메타 JSON 에 `"style": "clean"` 또는 `"deco"` 를 꼭 넣는다(성적 표에 [깨끗] 표시로 갈린다).
- 장면은 한 공간(같은 조리대·같은 배경)에서 최대한 이어지게 — 컷마다 다른 집 주방이 튀면 지저분해 보인다.
- 길이 28~36초.
- variants: social = "<상품 지칭>은 / 프로필 링크에 있어요", ig = "<상품 지칭>이 궁금하면 / 댓글에 링크라고 남겨 주세요".

## 6. 렌더 + 눈 검사
- `cd <wd> && python D:/midform/scripts/ff_render.py plan.json --out <이름>_ff.mp4 > render.log 2>&1`
- 정지 화면 검사: 1초 간격 시트(`fps=1,scale=270:480,tile=8x5`)를 Read 로 보고 확인 — 자막 문장과 그 순간 화면이 맞는지도 본다("이렇게 돼요"에 문제 장면이 아니라 다른 장면이 걸리면 고친다). 렌더러는 소스 구간이 말보다 짧으면 느리게 늘리므로 0.6배보다 느려지면 문장을 줄인다. — 남의 자막·워터마크·다른 제품·얼룩·자막이 화면 밖으로 넘침·검은 화면. 걸리면 plan 을 고쳐 다시 렌더(최대 3번, 넘으면 «멈춤»).
- 길이 `ffprobe` 로 25~40초인지.

## 7. 등록
1. 인포크 번호: `cd D:/midform && node scripts/inpock_add.js --key <이름> --url <short> --title "<짧은 상품명>" --image <wd>/cp_img.jpg`
2. 다른 판: `cd <wd> && python D:/midform/scripts/shop_social_plan.py <wd> && python D:/midform/scripts/ff_render.py plan_social.json --out <이름>_social.mp4 > render_social.log 2>&1 && python D:/midform/scripts/ff_render.py plan_ig.json --out <이름>_ig.mp4 > render_ig.log 2>&1` — 두 판 끝 3초를 시트로 확인.
3. 메타 `D:/volcano-runs/_upload/<이름>.json` — `ffref03.json` 과 같은 키(file=_ff.mp4, title "<결과/의문> #상품군 #살림팁류", description, pinned_comment, affiliate_link, product, categoryId 26, defaultLanguage ko, content_type growth, remake_of). JSON 은 node `JSON.stringify(x,null,2)` + `fs.writeFileSync(..., 'utf8')` 로만 쓴다.
   - 설명란 끝 출처: 일본·영미권 소스만 `@핸들` 한 줄씩. **중국 소스(더우인·샤오홍슈·콰이쇼우·중국 계정)는 적지 않는다.**
4. 재고 등록: `stock_new_channel.json` 의 `ready` 끝에 `"<이름>.json"` 추가(node 로 읽고 써라). 예약은 07:20 fill 이 한다 — 여기서 `shop_schedule add` 를 부르지 마라.
5. 제작 장부(관리자 07:40 성과 보고용, 규격 `D:/midform/docs/production-ledger.md`): 편마다 한 줄을 node `fs.appendFileSync('D:/midform/server/data/production_ledger.jsonl', JSON.stringify(rec)+'\n','utf8')` 로만 덧붙인다.
   - rec = `{"at":<지금>,"session":"쇼핑","lane":"shop","id":"<이름>","title":"<메타 title>","started_at":<이 편 소재 고르기를 시작한 시각>,"finished_at":<눈 검사 통과 시각>,"render_secs":<LaMa 지우기 초 + ff_render 세 판 초 합>,"gpt_calls":<gpt-ask 부른 횟수, 안 썼으면 0>,"rejected":<눈 검사로 다시 렌더한 횟수>,"note":"<clean 또는 deco> · <한 줄 메모>"}`. 시각은 KST `+09:00` ISO.
   - 지우기·렌더 시작/끝 시각을 그때그때 적어 두었다가 render_secs 를 낸다. youtube_id·publish_at 은 07:20 fill 이 자동으로 덧붙이니 넣지 않는다. 버린 편은 적지 않는다.

## 멈춤 규칙 (그 편만 버리고 기록)
- 같은 모양 쿠팡 상품 없음 / 쓸 만한 소스 3개 미만 / 지우기 두 번 실패 / 렌더 3번 실패 / 얼룩·남의 자막이 못 지워짐.
- 버린 편의 작업 폴더는 남겨 둔다(지우지 말 것).

## 하지 말 것
- 이미 공개·예약된 게시물·메타·인포크 블록을 고치거나 지우지 않는다. 노션 자료 페이지를 손대지 않는다.
- 키·토큰을 출력하지 않는다. `D:/midform/.env`, `~/.volcano/keys` 내용 echo 금지.
- 유료 API 는 TikHub 검색·받기만(회차당 30회 이내). 다른 유료 서비스 금지.

## 마지막 보고
`D:/volcano-runs/_upload/produce_<YYYYMMDD>.md`(KST 날짜)에 편마다 한 단락: 이름·상품·쿠팡 링크·인포크 번호·길이·레퍼런스·쓴 소스(핸들)·눈 검사에서 고친 것, 버린 편은 이유. 마지막 줄에 `OK <만든 편 수>`.
