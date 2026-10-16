"""쇼츠 업로드 메타(<name>.upload.json)를 만든다: python prep_upload.py 20261015"""
import json, sys
from pathlib import Path
day = sys.argv[1]
specs = json.loads(Path(day + '.json').read_text(encoding='utf-8'))
titles = json.loads(Path(day + '_titles.json').read_text(encoding='utf-8'))
for s in specs:
    t = titles[s['name']]
    src = s['source'].replace('영상: ', '■ 인용 영상 출처: ')
    desc = '\n'.join([t, '', '풀영상: 쟁점 브리핑 ' + day[4:6] + '.' + day[6:] + ' (채널에서 보기)', '', src,
                      '※ 의원 발언 속 주장은 확인된 사실이 아닐 수 있습니다.', '', '#국정감사 #법사위 #쟁점브리핑'])
    meta = {'file': 'D:/midform/politics-hour/shorts/' + day + '/' + s['name'] + '.mp4', 'title': t + ' #shorts', 'description': desc,
            'privacy': 'public', 'categoryId': '25', 'defaultLanguage': 'ko', 'madeForKids': False}
    Path(day, s['name'] + '.upload.json').write_text(json.dumps(meta, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(s['name'], meta['title'])
