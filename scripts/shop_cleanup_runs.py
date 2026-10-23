# 발행 3일 지난 쇼핑 편의 다시 만들 수 있는 중간 파일 정리(10-23 관리자). 최종 mp4·json·보고서는 남김. 쓰임: python scripts/shop_cleanup_runs.py [apply]
import os,glob,shutil,sys,time
apply=sys.argv[1]=='apply'
cut=time.mktime(time.localtime(time.time()-3*86400))
tot=0;rows=[]
def sz(p):
    if os.path.isfile(p): return os.path.getsize(p)
    return sum(os.path.getsize(os.path.join(r,f)) for r,_,fs in os.walk(p) for f in fs)
os.chdir('D:/volcano-runs')
for d in sorted(glob.glob('ff*/')):
    d=d.rstrip('/')
    fin=[f for f in glob.glob(d+'/*_social.mp4')+glob.glob(d+'/*_ff.mp4')]
    if not fin: continue
    if max(os.path.getmtime(f) for f in fin)>=cut: continue
    for n in ['_ff','footage','src','sheets','cand','eye','frames','preview','tmp']:
        p=os.path.join(d,n)
        if os.path.exists(p): rows.append(p)
    for pat in ['*_nobgm.mp4','*_v1.mp4','*_raw.mp4','*_prev*.mp4']:
        rows+=glob.glob(d+'/'+pat)
for p in rows:
    s=sz(p);tot+=s
    if apply:
        shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
print(len(rows),'items',round(tot/2**30,2),'GB','APPLIED' if apply else 'dry')
