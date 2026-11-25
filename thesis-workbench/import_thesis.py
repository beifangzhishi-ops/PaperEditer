"""Import current thesis into independent, editable Markdown sections. Never writes TeX."""
from pathlib import Path
import re, json, hashlib, shutil, argparse, os
import pymupdf as fitz

ROOT=Path(__file__).resolve().parent
parser=argparse.ArgumentParser(description='Import a compatible LaTeX project into a new PaperEditer data directory.')
parser.add_argument('--source',required=True,type=Path,help='LaTeX project directory with main.aux, main.pdf, contents/ and refs.bib')
parser.add_argument('--data-dir',type=Path,default=Path(os.environ.get('PAPEREDITER_DATA_DIR',str(ROOT/'data'))))
options=parser.parse_args()
SRC=options.source.expanduser().resolve()
DATA=options.data_dir.expanduser().resolve()
if DATA.exists() and any(DATA.iterdir()):
    raise SystemExit('Data directory is not empty: refusing to overwrite. Choose a new directory.')
for f in ['main.aux','main.pdf','contents/abstract.tex','refs.bib']:
    if not (SRC/f).is_file():raise SystemExit('Missing input: '+f)
for d in ['thesis','blocks','assets','original','history']:
    (DATA/d).mkdir(parents=True,exist_ok=True)
if (DATA/'outline.json').exists():
    raise SystemExit('Existing outline: refusing to overwrite. Use separate staging directory for a new import.')
nodes=[]; assets={}; warnings=[]
aux=(SRC/'main.aux').read_text(encoding='utf-8')
labels={m[1]:{'number':m[2],'page':m[3]} for m in re.finditer(r'\\newlabel\{([^}]+)\}\{\{([^}]*)\}\{([^}]*)\}',aux)}
pdf=fitz.open(SRC/'main.pdf')
def write(p,s): p.write_text(s,encoding='utf-8')
def dump(p,v): write(p,json.dumps(v,ensure_ascii=False,indent=2))
def ident(s): return re.sub(r'[^a-zA-Z0-9_-]+','-',s).strip('-')[:100] or 'item'
def strip_comments(s): return re.sub(r'(?<!\\)%[^\n]*','',s)
def group(s,i):
    while i<len(s) and s[i].isspace():i+=1
    if i>=len(s) or s[i]!='{':return '',i
    start=i+1; depth=1;i+=1
    while i<len(s):
        if s[i]=='\\' and i+1<len(s) and s[i+1] in '{}':i+=2;continue
        if s[i]=='{':depth+=1
        if s[i]=='}':
            depth-=1
            if depth==0:return s[start:i],i+1
        i+=1
    return s[start:],i
def args(s,name):
    for m in re.finditer(r'\\'+name+r'\*?\s*(?:\[[^\]]*\]\s*)?',s):
        a,end=group(s,m.end())
        if end>m.end():yield a,m.start(),end
def label(s):return next((a for a,_,_ in args(s,'label')),'')
def text(s):
    # Preserve inline math exactly; transform prose-only macros.
    parts=re.split(r'(?<!\\)(\$[^$]+\$)',s)
    for i in range(0,len(parts),2):
        p=parts[i]
        p=re.sub(r'\\(?:ref|autoref)\{([^}]+)\}',r'[[ref:\1]]',p)
        p=re.sub(r'\\eqref\{([^}]+)\}',r'[[eqref:\1]]',p)
        p=re.sub(r'\\(parencite|textcite|cite)\{([^}]+)\}',r'[[cite:\2]]',p)
        p=re.sub(r'\\(?:label)\{[^}]+\}','',p)
        p=re.sub(r'\\(?:begin|end)\{samepage\}','',p)
        p=re.sub(r'\\(?:centering|noindent|smallskip|medskip|small|footnotesize|par)\b\s*','',p)
        p=re.sub(r'\\textbf\{([^{}]*)\}',r'**\1**',p)
        p=re.sub(r'\\(?:emph|textit)\{([^{}]*)\}',r'*\1*',p)
        p=p.replace(r'\textmu','μ').replace(r'\%', '%').replace(r'\&','&').replace('~',' ').replace('---','—').replace('--','–')
        parts[i]=p
    return ''.join(parts).strip()
def asset(name):
    candidate=next((p for p in [SRC/name,SRC/'figures'/name,SRC/'contents'/'figures'/name] if p.is_file()),None)
    if not candidate:
        for folder in (SRC/'figures',SRC/'contents'/'figures'):
            if folder.exists():
                candidate=next((p for p in folder.glob(name+'.*') if p.is_file()),None)
                if candidate:break
    if not candidate:
        warnings.append('Missing graphic: '+name);return ''
    key=hashlib.sha1(str(candidate.relative_to(SRC)).encode()).hexdigest()[:10]+'-'+candidate.stem
    ext=candidate.suffix.lower()
    out=DATA/'assets'/(key+('.png' if ext=='.pdf' else ext))
    if not out.exists():
        if ext=='.pdf':
            with fitz.open(candidate) as d:
                p=d[0]; scale=min(2.5,1800/max(p.rect.width,p.rect.height))
                p.get_pixmap(matrix=fitz.Matrix(scale,scale),alpha=False).save(out)
        else:shutil.copy2(candidate,out)
    assets[out.name]=str(candidate.relative_to(SRC)).replace('\\','/')
    return '/assets/'+out.name
def pdf_figure(lab,cap):
    # Fallback for diagrams drawn in TeX: crop the actual compiled page.
    try:
        number=labels[lab]['number']; page=int(labels[lab]['page'])+21
        p=pdf[page]; found=[]
        for needle in ['图 '+number,'图'+number,number+' '+cap[:8],cap[:12]]:
            found=p.search_for(needle)
            if found:break
        if not found:raise ValueError('caption not located')
        y=found[0].y0; x0=p.rect.width*.10; x1=p.rect.width*.91
        drawings=[d['rect'] for d in p.get_drawings() if d['rect'].y1<y+2 and d['rect'].y0>p.rect.height*.08 and d['rect'].height>2 and d['rect'].width>2]
        if drawings:
            nearest=max(r.y1 for r in drawings)
            eligible=[r for r in drawings if r.y1>nearest-240]
            top=max(p.rect.height*.08,min(r.y0 for r in eligible)-20)
        else:top=max(p.rect.height*.08,y-270)
        out=DATA/'assets'/('compiled-'+ident(lab)+'.png')
        p.get_pixmap(matrix=fitz.Matrix(2,2),clip=fitz.Rect(x0,top,x1,y-3),alpha=False).save(out)
        assets[out.name]='main.pdf printed page '+labels[lab]['page']+' (TeX diagram crop; review)'
        warnings.append('TeX diagram crop requires visual review: '+lab)
        return '/assets/'+out.name
    except Exception as e:
        warnings.append('Unrendered diagram '+lab+': '+str(e));return ''
def table_body(s):
    m=re.search(r'\\begin\{tabular\}(?:\[[^\]]*\])?\s*',s)
    if not m:return ''
    _,i=group(s,m.end())
    end=s.find(r'\end{tabular}',i)
    if end<0:return ''
    raw=s[i:end]
    raw=re.sub(r'\\(?:toprule|midrule|bottomrule|hline)\b\s*','',raw)
    raw=re.sub(r'\\(?:cmidrule|cline)(?:\([^)]*\))?\{[^}]*\}','',raw)
    rows=[]
    for row in re.split(r'\\\\(?:\[[^\]]*\])?',raw):
        if not row.strip():continue
        cells=[text(c.strip()).replace('\n',' ').replace('|',r'\|') for c in re.split(r'(?<!\\)&',row)]
        rows.append(cells)
    if not rows:return ''
    n=max(map(len,rows)); rows=[r+['']*(n-len(r)) for r in rows]
    return '\n'.join(['| '+' | '.join(rows[0])+' |','| '+' | '.join(['---']*n)+' |']+['| '+' | '.join(r)+' |' for r in rows[1:]])
def convert(raw,owner):
    s=strip_comments(raw); i=0; out=[]
    pattern=re.compile(r'\\begin\{(figure|table|equation\*?|align\*?|gather\*?)\}(?:\[[^\]]*\])?')
    for m in pattern.finditer(s):
        if m.start()<i:continue
        end=s.find(r'\end{'+m[1]+'}',m.end())
        if end<0:continue
        out.append(text(s[i:m.start()]))
        body=s[m.end():end];i=end+len(r'\end{'+m[1]+'}')
        if m[1] in ['figure','table']:
            caps=list(args(body,'caption'))
            # Last caption outside subfigures is the actual figure caption.
            lab=label(body)
            labs=list(args(body,'label'))
            if labs:lab=labs[-1][0]
            cap=text(caps[-1][0]) if caps else ''
            lab=lab or owner+'-'+m[1]+'-'+str(m.start())
            if m[1]=='figure':
                imgs=[]
                for filename,start,stop in args(body,'includegraphics'):
                    url=asset(filename)
                    if url:imgs.append('!['+filename+']('+url+')')
                # Include captions for subfigures explicitly.
                subcaps=[text(c[0]) for c in caps[:-1]]
                content='\n\n'.join(imgs)
                if not imgs:
                    url=pdf_figure(lab,cap)
                    content='!['+cap+']('+url+')' if url else '**图源待核对**\n\n'+body
                if subcaps:content+='\n\n'+'；'.join('('+chr(97+j)+') '+x for j,x in enumerate(subcaps))
            else:
                content=table_body(body)
                if not content:
                    warnings.append('Unparsed table '+lab);content='~~~latex\n'+body+'\n~~~'
            out.append(':::'+m[1]+' '+lab+'\n'+cap+'\n\n'+content+'\n:::')
        else:
            lab=label(body) or owner+'-eq-'+str(m.start())
            expr=re.sub(r'\\label\{[^}]+\}','',body).strip()
            if m[1].startswith(('align','gather')):expr=r'\begin{aligned}'+'\n'+expr+'\n'+r'\end{aligned}'
            out.append(':::equation '+lab+('\n' if not m[1].endswith('*') else ' unnumbered\n')+expr+'\n:::')
    out.append(text(s[i:]))
    return '\n\n'.join(x for x in out if x.strip())+'\n'
def add(title,lev,parent,id_,raw,source,number=''):
    id_=id_ or 'section-'+hashlib.sha1((source+title).encode()).hexdigest()[:12]
    file=ident(id_)+'-'+hashlib.sha1(id_.encode()).hexdigest()[:6]+'.md'
    node={'id':id_,'title':text(title),'level':lev,'parent':parent,'number':number,'file':'thesis/'+file,'source':source,'order':len(nodes)}
    nodes.append(node)
    write(DATA/'original'/file.replace('.md','.tex'),raw)
    write(DATA/node['file'],convert(raw,id_))
    return id_
for lang,title in [('zh','中文摘要'),('en','英文摘要')]:
    s=(SRC/'contents'/'abstract.tex').read_text(encoding='utf-8')
    m=re.search(r'\\begin\{abstract\}\['+lang+r'\](.*?)\\end\{abstract\}',s,re.S)
    if m:add(title,1,None,'abstract-'+lang,m[1],'contents/abstract.tex')
for f in sorted((SRC/'contents').glob('chapter*.tex')):
    s=(f).read_text(encoding='utf-8');s=strip_comments(s)
    heading=re.compile(r'\\(chapter|section|subsection|subsubsection)\*?\s*(?:\[[^\]]*\]\s*)?')
    hs=list(heading.finditer(s));stack={}
    for j,m in enumerate(hs):
        title,end=group(s,m.end())
        raw=s[end:hs[j+1].start() if j+1<len(hs) else len(s)]
        lm=re.match(r'\s*\\label\{([^}]+)\}',raw)
        lab=lm[1] if lm else ''
        if lm:raw=raw[lm.end():]
        lev=['chapter','section','subsection','subsubsection'].index(m[1])+1
        parent=stack.get(lev-1)
        num=labels.get(lab,{}).get('number','')
        stack[lev]=add(title,lev,parent,lab,raw,str(f.relative_to(SRC)).replace('\\','/'),num)
# Preserve source bibliography as a separate readable resource.
shutil.copy2(SRC/'refs.bib',DATA/'references.bib')
dump(DATA/'outline.json',nodes)
dump(DATA/'assets.json',assets)
dump(DATA/'blocks.json',[])
dump(DATA/'original_labels.json',labels)
dump(DATA/'import-report.json',{'source':str(SRC),'sections':len(nodes),'assets':len(assets),'warnings':warnings,'source_sha256':hashlib.sha256((SRC/'main.pdf').read_bytes()).hexdigest()})
print(json.dumps({'sections':len(nodes),'assets':len(assets),'warnings':warnings},ensure_ascii=False))

