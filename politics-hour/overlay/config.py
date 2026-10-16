"""패키지 설정: politics-hour/config.json 을 읽는다(없으면 기본값)."""
import json
from pathlib import Path

HOME = Path(__file__).resolve().parents[1]
_c = json.loads((HOME / 'config.json').read_text(encoding='utf-8')) if (HOME / 'config.json').exists() else {}
PYTHON = _c.get('python', 'python')                      # numpy·opencv 가 깔린 파이썬
HYPERFRAMES = _c.get('hyperframes', '0.8.140')
GOOGLE_PROJECT = _c.get('google_project', 'project-b341a363-4d35-4813-a99')
GOOGLE_VOICE = _c.get('google_voice', 'ko-KR-Neural2-C')
# 로컬 무료 TTS. 목소리 F2 는 소유주가 10종 중 고른 것(10/13)
SUPERTONIC = dict({'python': 'D:/midform/tts-lab/supertonic/.venv/Scripts/python.exe', 'dir': 'D:/midform/tts-lab/supertonic',
                   'voice': 'F2', 'speed': 1.05, 'steps': 8, 'gap': 0.4}, **_c.get('supertonic', {}))
ASSETS = HOME / 'assets'
MODELS = HOME / 'models'
