from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, unquote, parse_qs
import json, hashlib, mimetypes, uuid, os, threading, re, datetime, base64, traceback, contextlib
from workspace import Package
from document import Document, content, object_value, create_document, EXAMPLE_IMAGE
from merge import merge_content
ROOT=Path(__file__).resolve().parent
DATA=Path(os.environ.get('PAPEREDITER_DATA_DIR',str(ROOT/'data'))).expanduser().resolve()
PACKAGE=None
CONFIG=ROOT/'workspace.local.json'
WORKSPACE_ERROR=None
LOCK=threading.RLock()
def settings_load():
    return json.loads(CONFIG.read_text(encoding='utf-8')) if CONFIG.is_file() else {}
def settings_save(settings):
    settings.pop('roots',None)
    dump(CONFIG,settings)
def workspace_path(filename):
    if not isinstance(filename,str):raise ValueError('请输入 .json 文件绝对路径')
    filename=filename.strip()
    if len(filename)>1 and filename[0]==filename[-1]=='"':filename=filename[1:-1]
    p=Path(filename)
    if not p.is_absolute() or filename.startswith(('\\\\?\\','\\\\.\\')):raise ValueError('请输入有效的 .json 文件绝对路径')
    return p.resolve()
def workspace_info():
    if PACKAGE is None:return {'id':'directory','name':'示例工作区'}
    return {'id':PACKAGE.id if isinstance(PACKAGE,Document) else sha(str(PACKAGE.filename))[:24],'name':PACKAGE.filename.name,'path':str(PACKAGE.filename),'history':isinstance(PACKAGE,Document)}
def workspace_catalog():
    settings=settings_load();files=[]
    for filename in settings.get('recent',[]):
        if isinstance(filename,str):files.append({'path':filename,'name':Path(filename).name,'active':PACKAGE is not None and os.path.normcase(filename)==os.path.normcase(str(PACKAGE.filename))})
    return {'files':files,'current':workspace_info(),'error':WORKSPACE_ERROR}
def record_workspace(p):
    settings=settings_load();filename=str(p);key=os.path.normcase(filename)
    settings['workspace']=filename
    settings['recent']=[filename]+[x for x in settings.get('recent',[]) if isinstance(x,str) and os.path.normcase(x)!=key]
    settings_save(settings)
def open_workspace(filename):
    global PACKAGE,WORKSPACE_ERROR
    p=workspace_path(filename)
    candidate=Document(p,validate_document_state)
    previous,previous_error=PACKAGE,WORKSPACE_ERROR
    try:
        PACKAGE=candidate
        initialize_data();state()
        record_workspace(p)
        settings=settings_load()
        old_key=sha(str(p))[:24]
        if old_key in settings.get('reading',{}) and candidate.id not in settings['reading']:
            settings['reading'][candidate.id]=settings['reading'][old_key];settings_save(settings)
        WORKSPACE_ERROR=None
    except BaseException:
        PACKAGE,WORKSPACE_ERROR=previous,previous_error
        raise
    return workspace_info()
def new_workspace(filename):
    p=workspace_path(filename)
    create_document(p,validate_document_state)
    return open_workspace(str(p))
def example_workspace():
    # Keep the tracked, portable fixture pristine. The editable example and
    # its private history live in an ignored local directory.
    directory=CONFIG.parent/'example-workspace'
    directory.mkdir(exist_ok=True)
    p=directory/'example.json'
    if not p.exists():
        template=Package(ROOT/'example.json')
        with template.transaction():
            initial={space:[dict(n,body=template.read(n['file']).decode('utf-8').replace('/assets/demo.png','/assets/'+EXAMPLE_IMAGE)) for n in json.loads(template.read(index))] for space,index in [('thesis','outline.json'),('blocks','blocks.json')]}
        start,method=initial['thesis']
        start['title']='示例：正文与对象'
        start['body']=start['body'].replace('Synthetic color swatches','示例图：可复制整图或子图').replace('\n:::\n\n:::table','\n\n![Second swatch](/assets/'+EXAMPLE_IMAGE+' "wb-id:demo-subfig-2")\n:::\n\n:::table')
        method['title']='示例：引用与知识块'
        method['body']+='\n\n普通段落，**粗体**、*斜体*，行内公式 $a^2+b^2=c^2$。\n\n章节 [[ref:demo-start]]，公式 [[eqref:demo-eq]]，图 [[ref:demo-fig]]，子图 [[ref:demo-subfig]]，表 [[ref:demo-table]]，知识块 [[ref:demo-note]]，文献 [[cite:example2026]]。\n\n[[embed:demo-independent]]\n'
        initial['blocks'].append(dict(id='demo-independent',title='独立知识块示例',parent=None,level=1,number='',file='blocks/demo-independent.md',source='',order=2,body='独立知识块：可复制正文，也可在本文件中嵌入或引用。'))
        create_document(p,validate_document_state,initial)
    return open_workspace(str(p))
def reading_position():
    return settings_load().get('reading',{}).get(workspace_info()['id'])
def save_reading(position):
    if not isinstance(position,dict) or position.get('view') not in ('thesis','blocks') or not isinstance(position.get('panes'),list) or not 1<=len(position['panes'])<=2 or len(json.dumps(position))>500000:raise ValueError('Invalid reading position')
    settings=settings_load();settings.setdefault('reading',{})[workspace_info()['id']]=position;settings_save(settings)
def package_name(p): return p.relative_to(DATA).as_posix()
def read(p):
    if PACKAGE is not None and p.is_relative_to(DATA):return PACKAGE.read(package_name(p)).decode('utf-8').replace('\r\n','\n').replace('\r','\n')
    return p.read_text(encoding='utf-8')
def exists(p):
    if PACKAGE is not None and p.is_relative_to(DATA):return PACKAGE.exists(package_name(p))
    return p.exists()
def glob_data(p,pattern):
    if PACKAGE is not None:
        from fnmatch import fnmatch
        prefix=package_name(p)+'/'
        return [DATA/name for name in PACKAGE.names(prefix) if '/' not in name[len(prefix):] and fnmatch(name[len(prefix):],pattern)]
    return list(p.glob(pattern))
def workspace_tx(write=False):
    return PACKAGE.transaction(write) if PACKAGE is not None else contextlib.nullcontext()
def load(p): return json.loads(read(p))
def sha(s): return hashlib.sha256(s.encode('utf-8')).hexdigest()
def atomic(p,s):
    if PACKAGE is not None and p.is_relative_to(DATA):
        PACKAGE.write(package_name(p),s.encode('utf-8'));return
    t=p.with_name(p.name+'.'+uuid.uuid4().hex+'.tmp')
    t.write_text(s,encoding='utf-8')
    os.replace(t,p)
def dump(p,o): atomic(p,json.dumps(o,ensure_ascii=False,indent=2)+'\n')
def initialize_data():
    """Initialize a new workspace only; never overwrite an existing one."""
    if isinstance(PACKAGE,Document):return
    required=['outline.json','blocks.json','original_labels.json','import-report.json']
    if PACKAGE is not None:
        if not all(exists(DATA/name) for name in required):raise RuntimeError('Incomplete workspace package')
        return
    if DATA.exists() and any(DATA.iterdir()):
        if not all((DATA/name).is_file() for name in required):
            raise RuntimeError('Incomplete data directory. Restore from backup or use a new empty directory.')
        for name in ['thesis','blocks','assets','original','history']:
            (DATA/name).mkdir(exist_ok=True)
        return
    DATA.mkdir(parents=True,exist_ok=True)
    for name in ['thesis','blocks','assets','original','history']:
        (DATA/name).mkdir(exist_ok=True)
    node={'id':'demo-start','title':'开始写作','parent':None,'level':1,'number':'','file':'thesis/demo-start.md','source':'','order':0}
    atomic(DATA/node['file'],'这是一个通用示例工作区。点击正文直接编辑，也可以通过目录新建章节。\n\n行内公式示例：$E=mc^2$。\n')
    dump(DATA/'outline.json',[node])
    dump(DATA/'blocks.json',[])
    dump(DATA/'original_labels.json',{})
    dump(DATA/'assets.json',{})
    dump(DATA/'import-report.json',{'source':'demo','sections':1,'assets':0,'warnings':[]})
def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds')
def idx(space): return DATA/('outline.json' if space=='thesis' else 'blocks.json')
def path(n,space):
    p=(DATA/n['file']).resolve()
    if p.parent!=(DATA/space).resolve() or p.suffix!='.md':raise ValueError('Invalid path')
    return p
def state():
    if isinstance(PACKAGE,Document):return PACKAGE.state()
    with workspace_tx():
        out={}
        for space in ['thesis','blocks']:
            out[space]=[dict(n,body=read(path(n,space))) for n in load(idx(space))]
        out['trash']=load(DATA/'trash.json') if exists(DATA/'trash.json') else []
        out['revision']=sha(json.dumps(out,sort_keys=True,ensure_ascii=False))
        return out
def check(nodes,space):
    if not isinstance(nodes,list) or len(nodes)>4000:raise ValueError('Invalid nodes')
    ids=set();files=set()
    for n in nodes:
        if not re.fullmatch(r'[\w:.-]{1,160}',n.get('id','')) or n['id'] in ids:raise ValueError('Duplicate or invalid ID')
        ids.add(n['id'])
        if not isinstance(n.get('title'),str) or (space!='thesis' and not n['title'].strip()) or len(n['title'])>500:raise ValueError('Invalid title')
        if not isinstance(n.get('body'),str) or len(n['body'])>3000000:raise ValueError('Invalid body')
        p=path(n,space)
        if p in files:raise ValueError('Duplicate path')
        files.add(p)
    byid={n['id']:n for n in nodes}
    for n in nodes:
        seen={n['id']};par=n.get('parent')
        while par:
            if par not in byid or par in seen:raise ValueError('Invalid parent/cycle')
            seen.add(par);par=byid[par].get('parent')
    return ids
def validate_document_state(payload):
        active_ids=check(payload['thesis'],'thesis');block_ids=check(payload['blocks'],'blocks')
        if active_ids&block_ids:raise ValueError('Duplicate cross-space ID')
        trash=payload.get('trash',[])
        if not isinstance(trash,list) or len(trash)>4000:raise ValueError('Invalid trash')
        seen=active_ids|block_ids;entry_ids=set()
        for entry in trash:
            if not isinstance(entry,dict) or not isinstance(entry.get('id'),str) or entry['id'] in entry_ids or not isinstance(entry.get('deletedAt'),str):raise ValueError('Invalid trash entry')
            entry_ids.add(entry['id'])
            nodes=entry.get('nodes')
            if not isinstance(nodes,list) or not nodes:raise ValueError('Invalid trash nodes')
            ids={n['id'] for n in nodes}
            if seen&check([dict(n,parent=n.get('parent') if n.get('parent') in ids else None) for n in nodes],'blocks'):raise ValueError('Duplicate trash node')
            seen|=ids
            anchors=entry.get('anchors')
            if not isinstance(anchors,list) or any(not isinstance(a,dict) or not all(isinstance(a.get(k),str) for k in ('owner','left','right','token')) or type(a.get('at')) is not int or a['at']<len(a['left']) or not re.fullmatch(r'(?:\[\[(?:ref|eqref|embed):[^\]\n]+\]\])+',a['token']) for a in anchors):raise ValueError('Invalid trash anchors')
            bindings=entry.get('bindings',[])
            if not isinstance(bindings,list) or any(not isinstance(b,dict) or not isinstance(b.get('owner'),str) or b.get('field') not in ('annotation','objectBindings','freePlacements') or not isinstance(b.get('values'),list) or not b['values'] or any(not isinstance(v,dict) for v in b['values']) or (b['field']=='annotation' and len(b['values'])!=1) for b in bindings):raise ValueError('Invalid trash bindings')

def save(payload):
    with LOCK:
        if isinstance(PACKAGE,Document):return PACKAGE.save(payload)
        return save_legacy(payload)

def save_legacy(payload):
    with LOCK,workspace_tx(True):
        old=state()
        if old['revision']!=payload.get('revision'):
            return 409,{'error':'其他网页或 Agent 已修改文件。请复制当前草稿，刷新后合并。'}
        trash=payload.get('trash',old['trash'])
        validate_document_state({**payload,'trash':trash})
        for space in ['thesis','blocks']:
            prior={n['id']:n for n in old[space]}
            for n in payload[space]:
                prev=prior.get(n['id'])
                if prev and prev['file']!=n['file']:raise ValueError('Existing path cannot change')
                if not prev and exists(path(n,space)):
                    # Allow restoring previously removed node from history, but never overwrite unrelated ID.
                    from_trash=space=='blocks' and any(x['id']==n['id'] and x['file']==n['file'] for e in old['trash'] for x in e['nodes'])
                    if not from_trash and not any(any(x['id']==n['id'] and x['file']==n['file'] for x in load(h)[space]) for h in glob_data(DATA/'history','*.json')):
                        raise ValueError('Existing file conflict')
        if all(old[s]==payload[s] for s in ['thesis','blocks']) and old['trash']==trash:return 200,{'revision':old['revision']}
        stamp=now().replace(':','-')+'-'+uuid.uuid4().hex[:8]
        dump(DATA/'history'/(stamp+'.json'),old)
        for space in ['thesis','blocks']:
            prior={n['id']:n for n in old[space]}
            for i,n in enumerate(payload[space]):
                n['order']=i
                if n['id'] not in prior or prior[n['id']]['body']!=n['body']:atomic(path(n,space),n['body'])
            dump(idx(space),[{k:v for k,v in n.items() if k!='body'} for n in payload[space]])
        if old['trash']!=trash:dump(DATA/'trash.json',trash)
        return 200,{'revision':state()['revision']}
class Handler(BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    def log_message(self,fmt,*args):print(now(),fmt%args,flush=True)
    def respond(self,code,data,ct='application/json; charset=utf-8'):
        if not isinstance(data,bytes):data=json.dumps(data,ensure_ascii=False).encode('utf-8')
        self.send_response(code);self.send_header('Content-Type',ct);self.send_header('Content-Length',str(len(data)))
        self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Connection','close');self.close_connection=True
        self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
        self.end_headers();self.wfile.write(data)
    def file(self,p,root):
        p=p.resolve()
        if not p.is_relative_to(root.resolve()) or not p.is_file():return self.respond(404,{'error':'Not found'})
        ct=mimetypes.guess_type(str(p))[0] or 'application/octet-stream'
        if p.suffix=='.js':ct='text/javascript'
        self.respond(200,p.read_bytes(),ct)
    def do_GET(self):
        try:
            u=urlparse(self.path);p=unquote(u.path)
            if p=='/api/workspaces':
                with LOCK:return self.respond(200,workspace_catalog())
            if p=='/api/state':
                with LOCK,workspace_tx():
                    if WORKSPACE_ERROR:return self.respond(409,{'error':WORKSPACE_ERROR})
                    s=state();q=parse_qs(u.query)
                    if q.get('since')==[s['revision']] and q.get('workspace')==[workspace_info()['id']]:
                        return self.respond(200,{'unchanged':True,'revision':s['revision'],'workspace':workspace_info()})
                    if isinstance(PACKAGE,Document):
                        s['originalLabels']=PACKAGE.local.doc['originalLabels'];s['importReport']=PACKAGE.local.doc['importReport']
                    else:
                        s['originalLabels']=load(DATA/'original_labels.json');s['importReport']=load(DATA/'import-report.json')
                    s['workspace']=workspace_info()
                    s['readingPosition']=reading_position()
                return self.respond(200,s)
            if p=='/api/history':
                with LOCK:
                    if isinstance(PACKAGE,Document):
                        q=parse_qs(u.query)
                        if q.get('workspace')!=[workspace_info()['id']]:return self.respond(409,{'error':'工作区已切换'})
                        return self.respond(200,PACKAGE.history_list(max(0,int(q.get('offset',['0'])[0])),min(200,max(1,int(q.get('limit',['100'])[0]))),q.get('object',[None])[0]))
                    return self.respond(200,[f.stem for f in sorted(glob_data(DATA/'history','*.json'),reverse=True)][:150])
            if p=='/api/history/item':
                key=parse_qs(u.query).get('id',[''])[0]
                if not re.fullmatch(r'[\w.+-]+',key):raise ValueError('Invalid history ID')
                with LOCK:
                    if isinstance(PACKAGE,Document):
                        if parse_qs(u.query).get('workspace')!=[workspace_info()['id']]:return self.respond(409,{'error':'工作区已切换'})
                        return self.respond(200,PACKAGE.history_item(key))
                    return self.respond(200,load(DATA/'history'/(key+'.json')))
            if p.startswith('/assets/'):
                with LOCK:
                    if PACKAGE is not None:
                        name=p[len('/assets/'):]
                        if isinstance(PACKAGE,Document):
                            if not re.fullmatch(r'[\w.-]+',name):return self.respond(404,{'error':'Not found'})
                            try:data=PACKAGE.asset(name)
                            except FileNotFoundError:return self.respond(404,{'error':'Not found'})
                            return self.respond(200,data,mimetypes.guess_type(name)[0] or 'application/octet-stream')
                        if not re.fullmatch(r'[\w.-]+',name) or not PACKAGE.exists('assets/'+name):return self.respond(404,{'error':'Not found'})
                        return self.respond(200,PACKAGE.read('assets/'+name),mimetypes.guess_type(name)[0] or 'application/octet-stream')
                    return self.file(DATA/p.lstrip('/'),DATA/'assets')
            if p.startswith('/vendor/'):return self.file(ROOT/'node_modules'/p[len('/vendor/'):],ROOT/'node_modules')
            if p=='/workbench.js':
                return self.respond(200,(read(ROOT/'app.js')+'\n;\n'+read(ROOT/'visual.js')).encode('utf-8'),'text/javascript; charset=utf-8')
            if p=='/manifest.webmanifest':return self.respond(200,(ROOT/'manifest.webmanifest').read_bytes(),'application/manifest+json')
            if p in ['/','/index.html','/app.js','/visual.js','/style.css','/visual.css','/app-icon-192.png','/app-icon-512.png']:return self.file(ROOT/('index.html' if p=='/' else p[1:]),ROOT)
            return self.respond(404,{'error':'Not found'})
        except Exception as e: traceback.print_exc();self.respond(500,{'error':str(e)})
    def do_POST(self):
        try:
            if self.headers.get('Origin'):
                origin=urlparse(self.headers['Origin'])
                if origin.netloc.lower()!=self.headers.get('Host','').lower():return self.respond(403,{'error':'Origin mismatch'})
            if self.headers.get('Content-Type','').split(';')[0]!='application/json':return self.respond(415,{'error':'JSON required'})
            n=int(self.headers.get('Content-Length',0))
            if not 0<n<=32*1024*1024:return self.respond(413,{'error':'Invalid request size'})
            payload=json.loads(self.rfile.read(n))
            if self.path=='/api/workspaces/open':
                with LOCK:return self.respond(200,open_workspace(payload['path']))
            if self.path=='/api/workspaces/new':
                with LOCK:return self.respond(200,new_workspace(payload['path']))
            if self.path=='/api/workspaces/example':
                with LOCK:return self.respond(200,example_workspace())
            if self.path=='/api/reading':
                with LOCK:
                    if WORKSPACE_ERROR or self.headers.get('X-PaperEditer-Workspace')!=workspace_info()['id']:return self.respond(409,{'error':'工作区已切换，请刷新。'})
                    save_reading(payload);return self.respond(200,{'ok':True})
            if self.path=='/api/save':
                with LOCK:
                    if WORKSPACE_ERROR or (PACKAGE is not None and self.headers.get('X-PaperEditer-Workspace')!=workspace_info()['id']):return self.respond(409,{'error':'工作区已切换，请先保存草稿并刷新。'})
                    code,result=save(payload);return self.respond(code,result)
            if self.path in ('/api/history/tag','/api/history/restore','/api/cli/edit','/api/merge'):
                with LOCK:
                    if not isinstance(PACKAGE,Document) or WORKSPACE_ERROR or self.headers.get('X-PaperEditer-Workspace')!=workspace_info()['id']:return self.respond(409,{'error':'工作区已切换或不支持历史'})
                    if self.path=='/api/merge':
                        for key in ('base','local','remote'):validate_document_state(payload[key])
                        return self.respond(200,merge_content(payload['base'],payload['local'],payload['remote'],payload.get('choices')))
                    if self.path=='/api/history/tag':
                        return self.respond(200,{'tag':PACKAGE.tag(payload.get('id'),payload.get('name'),payload.get('clear',False),payload.get('revision'))})
                    if self.path=='/api/history/restore':
                        code,result=PACKAGE.restore(payload['id'],payload['revision'],payload.get('object'));return self.respond(code,result)
                    code,result=PACKAGE.edit(payload['operations'],payload['revision'],payload.get('message'));return self.respond(code,result)
            if self.path=='/api/upload':
                data=base64.b64decode(payload['data'],validate=True)
                if len(data)>20*1024*1024:raise ValueError('Image too large')
                import io
                from PIL import Image
                with Image.open(io.BytesIO(data)) as img:
                    if img.width*img.height>50000000:raise ValueError('Image too large')
                    img.load();kind=img.format
                    if kind not in ['PNG','JPEG','WEBP','GIF']:raise ValueError('Unsupported image type')
                ext={'PNG':'png','JPEG':'jpg','WEBP':'webp','GIF':'gif'}[kind]
                name=hashlib.sha256(data).hexdigest()[:24]+'.'+ext
                with LOCK,workspace_tx(True):
                    if WORKSPACE_ERROR or (PACKAGE is not None and self.headers.get('X-PaperEditer-Workspace')!=workspace_info()['id']):return self.respond(409,{'error':'工作区已切换，请刷新。'})
                    target=DATA/'assets'/name
                    if isinstance(PACKAGE,Document):PACKAGE.upload(name,data)
                    elif not exists(target):
                        if PACKAGE is not None:PACKAGE.write(package_name(target),data)
                        else:
                            temp=target.with_suffix('.tmp');temp.write_bytes(data);os.replace(temp,target)
                return self.respond(200,{'url':'/assets/'+name})
            return self.respond(404,{'error':'Not found'})
        except Exception as e:traceback.print_exc();self.respond(400,{'error':str(e)})
class WorkbenchServer(ThreadingHTTPServer):
    request_queue_size=128
    daemon_threads=True

def scan_workspaces():
    # Do not depend on an open browser. Observe the active document while the
    # service runs; failures are logged without overwriting invalid content.
    previous_error=None
    while True:
        try:
            with LOCK:
                if isinstance(PACKAGE,Document):PACKAGE.scan()
            previous_error=None
        except Exception as e:
            if str(e)!=previous_error:
                previous_error=str(e);print('Document scan:',previous_error,flush=True)
        threading.Event().wait(2)

if __name__=='__main__':
    settings=settings_load()
    filename=os.environ.get('PAPEREDITER_WORKSPACE')
    if not filename:filename=settings.get('workspace')
    if filename:
        try:
            open_workspace(filename)
        except Exception:
            PACKAGE=None;WORKSPACE_ERROR='上次打开的工作区无法读取，请重新选择文件。'
    elif 'PAPEREDITER_DATA_DIR' in os.environ:initialize_data()
    else:WORKSPACE_ERROR='尚未打开文档，请输入服务器上的 .json 文件路径。'
    port=int(os.environ.get('PAPEREDITER_PORT','8191'))
    print(f'PaperEditer 127.0.0.1:{port}',flush=True)
    threading.Thread(target=scan_workspaces,daemon=True).start()
    WorkbenchServer(('127.0.0.1',port),Handler).serve_forever()

