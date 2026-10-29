# variety_fx 묶음 — 예능식 편집 + 효과음 (도구개발, 2026-10-29)

쇼폼 완성 영상 위에 스티커(!!·?!)·손글씨 반응·빨간 화살표·숫자/CTA 박스·첫 화면 펀치 줌을 얹고, 큰 순간 몇 곳에만 효과음을 넣는다.
소유주 승인 «C판 좋아»(10-29). 코드는 `scripts/variety_fx.py`, 이 폴더는 그 코드가 읽는 자산이다.

## 쓰는 법

```
python -X utf8 scripts/variety_fx.py <완성.mp4> <시각표> --out <출력.mp4> [--plan fx.json] [--fonts 글꼴폴더] [--dry]
```

- `<시각표>`: 대사 시각 JSON(t0·t1·text·chunks) **또는 자막 파일**(.ass·.srt·.vtt).
  - 볼케이노 어랍숏은 `edits/<해시>/captions.ass` 를 그대로 주면 된다. Head(위 제목)는 피해서 그 아래에 그래픽을 놓고, Dialogue(원음 대사) 줄에는 손글씨 반응을 붙인다. Effect·Credit 줄은 쓰지 않는다.
- `--dry`: 효과 계획(`<출력>.vfx/fx.json`)만 쓰고 렌더하지 않는다. 고치고 싶으면 fx.json 을 고쳐서 `--plan` 으로 다시 돌린다.
- `--no-kind arrow` (쉼표·여러 번 가능): 그 그래픽 종류를 뺀다(쇼핑 성장 모드 화살표 금지). kind(arrow·sticker·note·tag·punch·silhouette) 또는 as(cta·number). 자동 배치면 빈 효과음 몫을 남은 그래픽이 받는다.
- 결과는 -14 LUFS로 맞춘다(`scripts/loudnorm_final.py`).
- 효과음 규칙(소유주 «거의 안 들려» → «너무 잦아»): 그 자리 믹스보다 +4~6dB, 최소 5초 간격, 한 편 최대 6개. 그래픽은 더 자주 나와도 대부분 소리 없이 나온다.

## 필요한 것

| 무엇 | 설명 |
|---|---|
| Python + numpy | 효과음 트랙. Earshot 설치는 **필요 없다**(키트 파일과 놓는 식만 씀) |
| ffmpeg | 합성·음량 |
| Node.js(npx) | 그래픽 렌더(`hyperframes@0.8.140`, 처음 한 번 내려받음) |
| 글꼴 | 저장소에 없음(아래) |

- `VFX_WORKERS`: 그래픽 렌더 동시 수. 기본 2(램 16GB PC 기준). 실패하면 자동으로 1로 다시 돈다. 임시 프레임은 출력 옆 작업 폴더에 둔다(C: 안 씀).
- `VFX_HOME`: 이 폴더 위치(기본 = 저장소 `tools/variety_fx`).
- 실측(메인 PC, 18초 어랍숏 1편, VFX_WORKERS=2): 108초.

## 글꼴

공개 저장소라 글꼴 파일은 올리지 않는다(`fonts/` 는 gitignore). 아래 순서로 찾는다.

1. `--fonts` 폴더
2. 영상 위쪽 폴더들의 `fonts/` — 볼케이노 작업 폴더에는 `SBAggroB.ttf`·`BMDOHYEON.ttf`·`HakgyoansimAllimjangTTF-R.ttf` 가 이미 있다
3. 정치 레인 `politics-hour/assets/fonts`
4. 설치 글꼴(사용자·Windows)

| 역할 | 1순위 | 대체 |
|---|---|---|
| 스티커 | SBAggroB.ttf | BMDOHYEON.ttf |
| 박스 글씨 | Paperlogy-8ExtraBold.ttf | BMDOHYEON.ttf, SBAggroB.ttf |
| 손글씨 | BMYEONSUNG.ttf | HakgyoansimAllimjangTTF-R.ttf, BMDOHYEON.ttf |

## 효과음 72개 — 출처와 권리

- `kit/` 의 wav 72개와 `kit.lock.json` 은 Earshot 0.4.0(github.com/Leonxlnx/earshot, MIT, 커밋 591fa3e)의 `earshot kit` 으로 **이 PC에서 코드로 합성**한 소리다. 뱅크는 `forge_v2r6+forge04r1+fit1+pluck1`, 프리셋은 `launch`(`kit/kit.json`), 48kHz.
- 녹음 샘플·외부 소리 파일·AI 모델·네트워크를 쓰지 않았다(오프라인, 모델 0). 그러니 남의 소리를 담고 있지 않다.
- 도구개발이 만든 결과물이므로 **CC0 1.0**(퍼블릭 도메인 기증)으로 둔다. 어느 채널·레인에서나 출처 표기 없이 써도 된다.
- 역할: bell·click·click.confirm·drop·hit·key·key.return·key.space·land·land.light·pop·riser·snap·swell·text·tick·tick.crisp·tock·whoosh.long·whoosh.short. 실제로 쓰는 것은 hit·pop·tock·click·click.confirm·whoosh.short·swell·bell.
- `gsap.min.js`: 정치 레인 `politics-hour/assets/gsap.min.js` 와 같은 파일(GSAP 무료 표준 라이선스).
