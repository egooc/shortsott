frame band + logo assets (locale-aware)

band_top_ko.png      1080x432  상단 밴드, 한국어 (bleed 11px into the video band)
band_bottom_ko.png   1080x432  하단 밴드, 한국어 (bleed 10px into the video band)
band_top_ja.png      1080x432  상단 밴드, 일본어
band_bottom_ja.png   1080x432  하단 밴드, 일본어
channel_logo.png     216x216   투명 PNG, KO/JA 공용

로케일 우선순위: <name>_<locale>.png 가 있으면 그것, 없으면 <name>.png 폴백.
로고를 언어별로 쓰려면 channel_logo_ko.png / channel_logo_ja.png 를 추가한다.

배치 스펙 (1080x1920 캔버스):
- 상단 밴드 0~21.9%, 영상 밴드 21.9~78.0% (1:1 정사각, 풀폭), 하단 밴드 78.0~100%
- 채널 로고: 우측 상단, transform x +0.741, y +0.416
- 제목 2줄: 상단 밴드 안 (y 142~244px 영역)
