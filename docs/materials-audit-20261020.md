# 10-19 자료 반영 실측 — 2026-10-20 (관리자 직접 grep)

소유주 10-20 09시대: «인사이트 갖다 받치면 뭐해, 반영이 하나도 안 되는데.» 10-19 밤 6세션의 «적용하겠다» ack 를 관리자가 적용으로 보고한 것이 잘못. 아래는 **D:/midform 제작 코드(scripts·fantube·politics-hour·politics-hour-ja·ja-nenkin·ko-corp·config)와 volcano-runs spec 을 직접 뒤진 결과**다. 문서·인계·프롬프트에만 있는 것은 «없음»으로 친다. N100 은 다른 PC 라 보고만.

판정: ✅ 코드·게이트에 있음 · ⚠ 일부/프롬프트만 · ❌ 없음

| # | 항목(출처) | 배정 | 적용 지점 | 10-20 실측 | 조치 · 기한 · 증명 |
|---|---|---|---|---|---|
| 1 | 댓글 장치 expected_comment{type,line,at_sec} + 원고 안 장치 (S8·Z4) | 쇼츠 6레인 | 각 레인 업로드 게이트 | ❌ 아침 0 → 10-20 10~11시 5레인 게이트 추가(쇼핑 c594a96·린박스 90aef0d·팬튜브 2e4d424·정치 3daa63e·N100), 공용 scripts/comment_hook.py(a4856bc). 롱투숏 회신 대기 | 오늘 제작분부터 FAIL·업로드 금지. 증명 = 다음 편 장치 문장·초·게이트 출력. 10-21 07:40 관리자 grep 재확인 |
| 2 | 제목 10패턴·앞 10자 핵심·15자·답 노출 금지 (S1·S2, 팬튜브 19항) | 쇼츠 레인 spec.title_pattern + 도구개발 title_check | spec 필드 + 공용 검사 | ❌→⚠ 공용 scripts/title_check.py 완성(055f18a), 롱투숏 plan_gate·N100 title_check 있음, 쇼핑·정치 ko·팬튜브(ep19)·린박스(134ja) 완료, 정치JA 대기 | 도구개발 title_check 오늘(위험 행위×대상 포함) → 레인 import. 레인은 오늘 제작분부터 spec.title_pattern 없으면 FAIL |
| 3 | 쇼핑 원고 검사 한 표(결충전·6단·리듬·열린 결말·반박 선제·사회적 증거) (Z6·S3) | 쇼핑 | 원고 검사 스크립트 | ⚠→✅ 10-20 shop_script_check.js(90496bd) 7항 검사 코드, ffref20 시험 ③리듬·⑥증거 FAIL 실측 | 검사 코드(결·충·전 3문장 유무, 6단 순서, 문장 길이 분산, 열린 결말 어미, 반박 선제 1, 증거 1) 종료 코드 4, 00:30 회차부터. 증명 = 검사 로그 한 편 |
| 4 | 지금의 대리만족 한 문장 spec.vicarious (Z7·Z3, 팬튜브 17항) | 팬튜브·정치 ko/JA·린박스·롱투숏·N100 | spec/plan 필드 + 게이트 | ❌→⚠ 팬튜브 ep19·린박스 134ja·롱투숏 lx02·정치 ko emotion_now·N100 ✅, 정치JA 13:43 후보표 | 오늘 제작분부터 필드 없으면 FAIL(팬튜브 ep19·린박스 nar4·정치 10/21·롱투숏 다음 편). 증명 = 문장 그대로 |
| 5 | 3단 훅 0~3초 spec.hook{visual,audio,text} (Z14, 팬튜브 18항) | 팬튜브(→ 쇼츠 레인 콜드오픈 검사) | spec.hook 3칸 | ⚠ 팬튜브 ep19 ✅(hook 3칸 게이트) | 다른 쇼츠 레인: 다른 쇼츠 레인은 «제목 낱말 장면» 검사에 청각·텍스트 2칸 추가(이번 주) |
| 6 | 제목 전문용어엔 쉬운 풀이 동반 (S5) | 정치 ko·JA·연금·기업 | upload_gate 제목 검사 | ❌→✅ 정치 ko jargon.json 18낱말+upload_gate(28ca994), 10/21편부터. 정치JA 12낱말(b4c12da)·연금 25낱말(f7b563f)·기업 24낱말 ✅ — 4레인 전부, 제목 검사 통과 | 레인별 전문용어 사전(json) + 제목에 사전 낱말 있으면 같은 제목/설명 첫 줄에 풀이 없을 때 FAIL. 10/21편부터 |
| 7 | 상승 키워드에 «댓글 많은 뉴스» 소스·정치 후보표 댓글 수 열 (Z12) | 도구개발·정치 ko | rising_keywords.js·후보표 | ✅ 정치 ko candidate_gate comment_count·emotion_now 필수(28ca994) + rising_keywords 네이버 댓글 뉴스 랭킹 칸(27e375a, 댓글 수 대신 등장 건수·순위) | 도구개발 큐 ③ 뒤. 정치 ko 후보표 열은 10/21편 |
| 8 | 저조회 진단표 첫 분기 노출→CTR→지속 + 쇼츠 벽 이름·처방 열 (S6·Z9) | 도구개발 | 진단표 | ❌→✅ view_diag.js(2d14d78) + manager-report §1 진단 열 | — |
| 9 | comment_mine.js 댓글 광산 5종 (Z4) | 도구개발 | — | ❌→✅ comment_mine.js(3186444), 5채널 첫 실행 | 다음 소재 신호 레인 전달 |
| 10 | 첫 줄 인사·«오늘은» 금지, Why 먼저 (K2·K3, 팬튜브 13항) | 전 레인 원고 첫 문장 | 게이트 | ⚠ 정치 ko upload_gate·쇼핑 shop_script_check·롱투숏 plan_gate·N100 script_kind 있음, 팬튜브·린박스·정치JA 아직 | 각 레인 원고 검사에 첫 문장 금지 낱말 1줄(오늘). comment_hook 처럼 공용은 script_audit 에 |
| 11 | E-E-A-T 고유명사·전문용어 밀도 열 (K7) | 연금·기업·정치 롱폼 검수표 | script_audit | ⚠→✅ 공용 script_audit.py(f381aba) 밀도·리듬·첫 질문·전환·끝맺음, 사전 4레인 완비, 연금·기업·정치 ko 실측 후 전환 문구 보강(연금 319→88초·기업 147→94초) | 도구개발 script_audit(10-19 요청분)에 밀도 열 |
| 12 | 태그는 내용 일치만·제목·설명·태그 공통 낱말 (K6) | 전 레인 태그 게이트 | yt_tags --gate | ⚠→✅ 공용 tag_gate.py(35d6266) 공통 낱말 ≥2·원고 일치 ≥50% | 레인 업로드 게이트 import(10-21) |
| 13 | -14 LUFS (K12) | 전 레인 | loudnorm_final·렌더러 | ✅ | — |
| 14 | 무음 간격 상한 (K13) | TTS 레인 | gap_check | ✅ 정치·쇼핑(ff_render) | 팬튜브·린박스 TTS 줄은 확인 요청 |
| 15 | 경쟁 채널 업로드 시각 히스토그램 → 1~2h 선점 (K16) | 도구개발 | — | ❌→✅ publish_hours.py --api(6a529fd) 조회 가중·제안 슬롯, 8레인 실측 | 재배치 결정 §5 56 |
| 16 | 07:40 보고에 롱폼 지속 곡선 (K9) | 도구개발 | manager-report | ❌→✅ retention_curve.js(70e1195) | manager-report 연결(10-20) |
| 17 | 쇼츠 길이 — 팬튜브 20~30·N100 len45/50 A/B (K1·H12·16항) | 팬튜브·N100 | 렌더 길이 | ✅ 팬튜브 ep18 27.6초, N100 A/B 10-20~ 보고 | — |
| 18 | H1 5기준·H14 첫 문장 4형·H16 체크리스트 5 (김호) | N100 own_check | N100 PC | ✅ N100 증명(yt_checklist.py source_checks 61행 MIN_CRITERIA=2·script_kind.py OPENERS 25행·upload_checks 163행·title_check.py 57행, own_check 266~310행 호출, volcano-upload.js 393·399행 재실행, _gate_log 실측 ott220~222) + Z3 vicarious 반려·인사 금지(こんにちは 포함) 있음 | — |
| 19 | ref_overlap 원고 겹침 관문 | 롱폼 4레인 | scripts/ref_overlap.py | ✅ 4레인 전부(기업 10-20 전사 24편 뒤 0건) | — |
| 20 | 팬튜브 RULES_PDF 17·18·19·20항 | 팬튜브 | spec 필드 | ❌→✅ ep19 publish.js 기획 게이트(vicarious·hook 3칸·title_pattern·15±3·인사 금지)+title_check+comment_hook, ep18 FAIL 실측 | ep19부터 4필드 없으면 FAIL(#2·4·5·1) |
| 21 | 대본 교배 Z13·대본 세 질문 K8 → 기획 가이드 표준 | 발굴 | 기획 가이드 | ⚠ 표준 문서(planning-guide-standard.md)엔 6항목 있음, 실제 가이드 적용은 정치 ko 1회(머리 두 줄·Q4), 10패턴 열·7항목 시트 0회, Z8 채굴 0회 | ⚠→✅ 기업 가이드 2차(4b4cfdd) 24편 실측·7지시·K8 3 채움. Z8 채굴 10개씩은 아직 |

| 22 | **쇼핑 제목에 검색 키워드**(소유주 10-20 10:13 «왜 반영 안 하나») | 쇼핑 | meta.keywords + 제목 앞 10자 + 설명 첫 줄 + 태그 + 게이트 | ❌→✅ shop_keyword_check.js(dbeabc6) 관문 + 17·19·20 포장 교체(논슬립 옷걸이·변기솔·기름때 앞 10자) | 오늘: keywords 3(쿠팡·자동완성 근거)·제목 앞 10자에 1개·설명·태그 일치·게이트, 17·19·20 포장 수정. 증명 = 바뀐 제목 3개 |

| 23 | **정치 주제 = 뉴스 채널 터진 롱폼 신호**(소유주 10-20 10:45) | 정치 ko·JA·도구개발 | keywords.json candidates 열 news_outlier{channel,video,views,ratio,title_words,thumb_words} + candidate_gate 필수 + yt_news_outliers 도구 | ❌→⚠ 정치 ko candidate_gate 필수 열 + news_out.py(20c03fb, 9/12채널, TV조선 36.6배·오마이TV 21.3배 실측) + 공용 yt_news_outliers.js(e274987, ko 28편) — 정치 ko·JA candidate_gate 가 latest.json 읽어 옮기면 ✅ | 오늘 15:00 후보표부터 손으로 열 채움, 도구는 도구개발 큐 선두 |

## 운영 규칙(이 문서로 못 박음)
1. 소유주 자료 배정은 **적용 지점(파일·필드·게이트)**까지 적어 보낸다. 적용 지점이 없는 배정은 배정이 아니다.
2. 세션 보고는 «적용했다»가 아니라 **바뀐 문장 그대로 + 게이트 종료 코드**. 관리자는 그 보고를 받아도 «들어감»이라 쓰지 않는다.
3. 관리자는 **다음 날 07:40 보고에 이 표의 실측 열을 grep 으로 갱신**해서 붙인다. 코드에 없으면 ❌ 그대로 간다.
4. 게이트 없는 원칙은 적용 안 된 것으로 본다(§7 «게이트는 실패하면 소리 낸다»).
