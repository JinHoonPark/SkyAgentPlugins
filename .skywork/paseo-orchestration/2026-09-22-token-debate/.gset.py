import sys
from pathlib import Path
sys.stdout.reconfigure(encoding='utf-8')
p=Path(__file__).with_name('GRAPH.md'); s=p.read_text(encoding='utf-8'); L=s.split('\n')
hdr=[c.strip() for c in next(l for l in L if l.startswith('| 노드 ID')).strip('|').split('|')]
nid=sys.argv[1]
for i,l in enumerate(L):
    if l.startswith(f'| {nid} |'):
        c=[x.strip() for x in l.strip().strip('|').split('|')]
        for kv in sys.argv[2:]:
            k,v=kv.split('=',1); c[hdr.index(k)]=v
        L[i]='| '+' | '.join(c)+' |'
        p.write_text('\n'.join(L),encoding='utf-8',newline=''); print(L[i][-120:]); break
else: sys.exit('no node')
