# 보이는 재테스트 드래프트 경로 정정

작성일: 2026-07-20

## 왜 이전 안내가 틀렸나

이전 `190117` 테스트런은 배치 리포트에는 성공으로 남았지만,
실제 CapCut Drafts 루트에는 보이지 않았고 `.recycle_bin` 아래로 들어가 있었다.

즉 사용자가 바로 열 수 있는 경로로는 잘못 안내한 것이 맞다.

## 새로 다시 만든 보이는 드래프트 폴더

이번에는 제목 suffix `[VISIBLE-RERUN]`를 붙여서
기존 폴더 충돌 없이 **루트에 실제로 존재하는 경로**로 다시 생성했다.

### 실제 존재 확인 완료 경로

- `C:\Users\sejun\Desktop\캡컷아웃풋\CapCut Drafts\20260720-H-201847-職人のパン作り 生地から黄金の焼き上がりまで [VISIBLE-RERUN]`
- `C:\Users\sejun\Desktop\캡컷아웃풋\CapCut Drafts\20260720-H-201847-大量チキン製造ライン！止まらない食欲の魔法 [VISIBLE-RERUN]`
- `C:\Users\sejun\Desktop\캡컷아웃풋\CapCut Drafts\20260720-H-201847-指先を彩る魔法 手作業ネイルポリッシュの誕生 [VISIBLE-RERUN]`

각 폴더 안에는 실제로 다음 파일이 있다.

- `draft_content.json`
- `edit_manifest.json`
- `capcut_notes.md`
- `video/`
- `audio/`
- `overlay/`

## 배치 정보

- Batch ID: `hook_selector_visible_rerun`

## 확인 대상

이번엔 위 **201847 + [VISIBLE-RERUN]** 3개 폴더만 보면 된다.
