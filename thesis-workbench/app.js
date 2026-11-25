'use strict';
const $=id=>document.getElementById(id);
const el=(tag,cls,txt)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e};
const btn=(label,fn,cls)=>{const e=el('button',cls,label);e.type='button';e.addEventListener('click',ev=>{ev.stopPropagation();fn(ev)});return e};
const clone=x=>JSON.parse(JSON.stringify(x));
const uid=()=>crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2);
const objectPattern=()=>/^:::(equation|figure|table)\s+([^\s]+)(?:[ \t]+([^\n]*))?\r?\n([\s\S]*?)^:::[ \t]*$/gm;
const refPattern=()=>/\[\[(ref|eqref|embed|cite):([^\]\n]+)\]\]/g;
const figureImagePattern=()=>/!\[([^\]]*)\]\((\/assets\/[^\s)]+)(?:\s+"([^"]*)")?\)/g;
function figureImageId(title,parent,index){return title?.match(/(?:^|\s)wb-id:([^\s"]+)/)?.[1]||'subfig-'+parent+'-'+(index+1)}
function figureImageMarkup(alt,url,title,id){const meta=(title||'').replace(/(?:^|\s)wb-id:[^\s"]+/g,'').trim();return '!['+alt+']('+url+' "'+[meta,'wb-id:'+id].filter(Boolean).join(' ')+'")'}
function normalizeFigureImages(s,parent){let i=0;return s.replace(figureImagePattern(),(m,alt,url,title)=>figureImageMarkup(alt,url,title,figureImageId(title,parent,i++)))}
function subfigureLetter(i){let s='';for(i++;i>0;i=Math.floor((i-1)/26))s=String.fromCharCode(97+(i-1)%26)+s;return s}
let db, view='thesis', panes=[{id:null,edit:false}], active=0, open=new Set(), targets=new Map(), numbers=new Map(), aliases=new Map(), search='', dragging=null, timer, saving=false, dirty=false, conflict=false, version=0, toastTimer, longTimer;
let undoStack=[], redoStack=[];
let trashSupported=false;
let syncBase=null,syncBusy=false,syncNeeded=false,syncConflict=null,syncLoading=false,workspaceChanged=false;
let draftDB=null,draftQueue=Promise.resolve(),draftWarning=false,draftRunning=false;
const draftPending=new Map();
const draftTab=(()=>{try{let id=sessionStorage.getItem('wb:draft-tab');if(!id){id=uid();sessionStorage.setItem('wb:draft-tab',id)}return id}catch{return uid()}})();
const paneBox=$('panes'), nav=$('nav'), dialog=$('dialog');
const READING_KEY='wb:reading-position:v1';
const PAGE_FOLD_KEY='wb:page-folds:v1';
let currentWorkspace=null;
function workspaceStorageKey(key){return currentWorkspace?.id?key+':'+currentWorkspace.id:key}
let pageFoldStates=(()=>{try{return JSON.parse(localStorage.getItem(PAGE_FOLD_KEY)||'{}')||{}}catch{return {}}})();
function pageFoldKey(pi){return pi+':'+(panes[pi]?.id||'')}
function pageFoldState(pi){return new Set(pageFoldStates[pageFoldKey(pi)]||[])}
function writePageFolds(pi,folds){
    pageFoldStates[pageFoldKey(pi)]=[...folds];
    try{localStorage.setItem(workspaceStorageKey(PAGE_FOLD_KEY),JSON.stringify(pageFoldStates))}catch{}
}
function setPageFold(pi,key,folded){
    if(pi==null||!key)return;
    const s=pageFoldState(pi);if(folded)s.add(key);else s.delete(key);
    writePageFolds(pi,s);updatePageFoldButton(pi)
}
function pageFoldTargets(pi){
    const n=find(panes[pi]?.id);if(!n)return [];
    const nodes=[n,...descendants(spaceOf(n.id),n.id)];
    return [...nodes.slice(1).map(x=>'section:'+x.id),...nodes.flatMap(x=>[
        ...objectList(x).map(o=>'object:'+x.id+':'+o.id),
        ...[...x.body.matchAll(/^\s*\[\[embed:([^\]\n]+)\]\]\s*$/gm)].map(m=>'object:'+x.id+':'+m[1])
    ])]
}
function updatePageFoldButton(pi){
    const pane=paneBox.children[pi],b=pane?.querySelector('.pageFoldButton');if(!b)return;
    const keys=pageFoldTargets(pi),s=pageFoldState(pi);
    b.disabled=!keys.length;b.textContent=keys.length&&keys.every(k=>s.has(k))?'本页全部展开':'本页全部折叠'
}
function togglePageFolds(pi){
    const pane=paneBox.children[pi],keys=pageFoldTargets(pi),s=pageFoldState(pi);if(!pane||!keys.length)return;
    const fold=!keys.every(k=>s.has(k));
    writePageFolds(pi,new Set(fold?keys:[]));
    for(const d of pane.querySelectorAll('details.child')){d.open=!fold;if(!fold)d._populate?.()}
    for(const card of pane.querySelectorAll('.visualCard[data-object]'))card._setFolded?.(fold,false);
    updatePageFoldButton(pi);captureReading()
}
let readingReady=false,readingRestored=false,readingInteracted=false,readingTimer,readingPending=null,readingFlight=Promise.resolve(),readingLast='';
function readPosition(){
    try{return JSON.parse(localStorage.getItem(workspaceStorageKey(READING_KEY))||'null')}catch{return null}
}
function panePosition(p){return {id:p.id,reading:p.reading||null}}
function thesisPosition(p){return p?.id&&db.thesis.some(n=>n.id===p.id)?panePosition(p):null}
function positionSnapshot(){return {view,active,open:[...open],panes:panes.map(p=>({...panePosition(p),thesisReading:thesisPosition(p.thesisReading)})),pageFolds:pageFoldStates}}
function replacePane(pi,id,object=null){
    const previous=panes[pi],old=paneBox.children[pi];
    if(old&&old._readingPane===previous)capturePane(old);
    panes[pi]={id,edit:false,object,thesisReading:thesisPosition({id})?null:thesisPosition(previous)||thesisPosition(previous?.thesisReading)};
}
function flushReading(){
    clearTimeout(readingTimer);
    const pending=readingPending;readingPending=null;
    if(!pending)return readingFlight;
    readingFlight=readingFlight.catch(()=>{}).then(async()=>{
        const r=await fetch('/api/reading',{method:'POST',headers:{'Content-Type':'application/json','X-PaperEditer-Workspace':pending.id},body:pending.body,keepalive:pending.body.length<16000});
        if(!r.ok)throw new Error('Reading position: HTTP '+r.status);
    }).catch(e=>{console.warn(e);if(currentWorkspace?.id===pending.id&&readingLast===pending.body)readingLast=''});
    return readingFlight;
}
function rememberPosition(){
    if(!readingReady||!db||!readingInteracted||!currentWorkspace)return;
    const body=JSON.stringify(positionSnapshot());
    try{localStorage.setItem(workspaceStorageKey(READING_KEY),body)}catch{}
    if(body===readingLast)return;
    readingLast=body;readingPending={id:currentWorkspace.id,body};clearTimeout(readingTimer);readingTimer=setTimeout(flushReading,350);
}
function readingInteraction(e){if(e.target.closest?.('#panes,#nav,#sideTools,#treeTab,#blockTab,#dual'))readingInteracted=true}
for(const type of ['pointerdown','wheel','touchstart','keydown'])document.addEventListener(type,readingInteraction,{capture:true,passive:true});
function capturePane(pane){
    const p=pane._readingPane;
    if(!p||pane._readingId!==p.id||pane._restoringReading||!pane.clientHeight)return;
    const top=pane.getBoundingClientRect().top;
    const cards=[...pane.querySelectorAll('.visualCard')].filter(c=>c.getClientRects().length);
    const card=cards.find(c=>c.getBoundingClientRect().bottom>top+8);
    let anchor=null;
    if(card){
        const doc=card.closest('.visualDocument'),siblings=[...doc.querySelectorAll('.visualCard')];
        anchor={owner:doc._owner,index:siblings.indexOf(card),object:card.dataset.object||null,offset:card.getBoundingClientRect().top-top};
    }
    p.reading={top:pane.scrollTop,anchor,expanded:[...pane.querySelectorAll('details.child[open]')].map(d=>d.dataset.sectionId).filter(Boolean)};
}
function captureReading(){
    for(const pane of paneBox.children)capturePane(pane);
    rememberPosition();
}
function restorePane(pane,p){
    const r=p.reading;
    if(!r||!pane.clientHeight)return;
    const originalTop=Number(r.top)||0;
    pane._restoringReading=true;
    const apply=()=>{
        if(!pane.isConnected||!pane._restoringReading)return;
        const a=r.anchor,doc=a&&[...pane.querySelectorAll('.visualDocument')].find(d=>d._owner===a.owner);
        const cards=doc?[...doc.querySelectorAll('.visualCard')]:[];
        const card=a&&(a.object?cards.find(c=>c.dataset.object===a.object):cards[a.index]);
        pane.scrollTop=card?pane.scrollTop+card.getBoundingClientRect().top-pane.getBoundingClientRect().top-(Number(a.offset)||0):originalTop;
    };
    const finish=()=>{if(!pane._restoringReading)return;pane._restoringReading=false;capturePane(pane);rememberPosition()};
    const cancel=()=>finish();
    for(const type of ['wheel','touchstart','pointerdown','keydown'])pane.addEventListener(type,cancel,{once:true,passive:true});
    apply();requestAnimationFrame(()=>{apply();requestAnimationFrame(apply)});
    // Images and math fonts can change the height of preceding content.
    for(const ms of [150,400,900,1600])setTimeout(()=>{if(pane._restoringReading){apply();if(ms===1600)finish()}},ms);
}
const all=()=>[...db.thesis,...db.blocks];
const find=id=>all().find(x=>x.id===id);
const spaceOf=id=>db.thesis.some(n=>n.id===id)?'thesis':'blocks';
const children=(space,id)=>db[space].filter(n=>(n.parent||null)===(id||null));
const label=n=>[numbers.get(n.id)||'',n.title].filter(Boolean).join(' ');
const ancestors=n=>{const a=[];let p=n;while(p&&p.parent){p=find(p.parent);if(!p||a.includes(p.id))break;a.unshift(p.id)}return a};
const descendants=(space,id)=>{let out=[];for(const n of children(space,id)){out.push(n,...descendants(space,n.id))}return out};
const flat=space=>descendants(space,null);
const objectList=n=>[...n.body.matchAll(objectPattern())].map(m=>({kind:m[1],id:m[2],flags:m[3]||'',body:m[4],owner:n.id,raw:m[0]}));
function reindex(){
    targets=new Map();numbers=new Map();aliases=new Map();
    let chapter=0,counters={};
    function walk(space,parent,prefix,chap){
        let sec=0;
        for(const n of children(space,parent)){
            const isRoot=!parent, formal=space==='thesis'&&!n.id.startsWith('abstract-')&&!n.id.startsWith('front-')&&!n.id.startsWith('back-');
            let number='';
            if(formal){
                if(isRoot){chapter++;number=String(chapter);chap=number}
                else {sec++;number=prefix+'.'+sec}
            }
            numbers.set(n.id,number);
            targets.set(n.id,{kind:'node',owner:n.id,id:n.id,number,title:n.title});
            if(space==='blocks')chap='K'+(db.blocks.indexOf(n)+1);
            for(const o of objectList(n)){
                const key=space+'|'+chap+'|'+o.kind;
                counters[key]=(counters[key]||0)+(!o.flags.includes('unnumbered')?1:0);
                o.number=o.flags.includes('unnumbered')?'':(chap?chap+'.':'')+counters[key];
                o.title=o.kind==='equation'?'公式 '+o.number:o.body.split('\n')[0];
                if(!targets.has(o.id))targets.set(o.id,o);
                if(o.kind==='figure'){
                    let i=0;for(const m of o.body.matchAll(figureImagePattern())){
                        const id=figureImageId(m[3],o.id,i),letter=subfigureLetter(i++);
                        if(!targets.has(id))targets.set(id,{kind:'subfigure',id,parentId:o.id,owner:n.id,number:o.number?o.number+letter:letter,title:'子图 '+(o.number||'')+letter});
                    }
                }
            }
            walk(space,n.id,number,chap);
        }
    }
    walk('thesis',null,'','');walk('blocks',null,'','');
    // Retain the original labels for export, but display one shared figure number.
    const original=db.originalLabels||{};
    for(const [id,x] of Object.entries(original)){
        if(targets.has(id)||!x.number)continue;
        const m=String(x.number).match(/^(\d+\.\d+)([a-z])$/i);
        if(!m)continue;
        const parent=[...targets.values()].find(t=>t.kind==='figure'&&original[t.id]?.number===m[1]);
        if(parent)aliases.set(id,{...parent,id,actualId:parent.id,number:parent.number});
    }
}
const resolve=id=>targets.get(id)||aliases.get(id);
function showToast(t){$('toast').textContent=t;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,3000)}
function status(t){$('status').textContent=t}
async function api(url,body){const r=await fetch(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-PaperEditer-Workspace':currentWorkspace?.id||''},body:JSON.stringify(body)});let v=await r.json();if(!r.ok)throw Object.assign(new Error(v.error||'HTTP '+r.status),{status:r.status});return v}
function editableSnapshot(){return clone({thesis:db.thesis,blocks:db.blocks,trash:db.trash||[]})}
// Three-way reconciliation. Stable node IDs, not whole-document last-writer-wins.
function syncEqual(a,b){
    if(a===b)return true;
    if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
    const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&syncEqual(a[k],b[k]));
}
function nodeContent(n){if(!n)return undefined;const {parent,order,level,...content}=n;return content}
function mergeBody(base,local,remote,resolveConflict){
    // Paragraphs and explicit equation/figure/table blocks are indivisible units.
    // Preserve the exact original Markdown including blank lines.
    if(!window.Diff?.diffArrays)return null;
    function chunks(raw){const out=[];let end=0;const prose=s=>{if(s)out.push(...s.split(/(\n[ \t]*\n+)/).filter(Boolean))};for(const m of raw.matchAll(objectPattern())){prose(raw.slice(end,m.index));out.push(m[0]);end=m.index+m[0].length}prose(raw.slice(end));return out}
    const original=chunks(base);
    function edits(raw){let at=0,change=null;const result=[],parts=Diff.diffArrays(original,chunks(raw),{timeout:250});if(!parts)return null;for(const part of parts){if(!part.added&&!part.removed){if(change){result.push(change);change=null}at+=part.count;continue}if(!change)change={start:at,end:at,values:[]};if(part.removed){at+=part.count;change.end=at}else change.values.push(...part.value)}if(change)result.push(change);return result}
    const a=edits(local),b=edits(remote);if(!a||!b)return null;
    const overlaps=(x,y)=>x.start===y.start||Math.max(x.start,y.start)<Math.min(x.end,y.end)||(x.start===x.end&&x.start>=y.start&&x.start<=y.end)||(y.start===y.end&&y.start>=x.start&&y.start<=x.end);
    const remaining=[...a.map(h=>({...h,side:'local'})),...b.map(h=>({...h,side:'remote'}))],combined=[];
    while(remaining.length){
        const group=[remaining.shift()];for(let i=0;i<group.length;i++)for(let j=remaining.length-1;j>=0;j--)if(group[i].side!==remaining[j].side&&overlaps(group[i],remaining[j]))group.push(...remaining.splice(j,1));
        const start=Math.min(...group.map(h=>h.start)),end=Math.max(...group.map(h=>h.end)),left=group.filter(h=>h.side==='local'),right=group.filter(h=>h.side==='remote');
        if(!left.length||!right.length){combined.push(...group);continue}
        const apply=edits=>{const value=original.slice(start,end);for(const h of edits.sort((x,y)=>y.start-x.start))value.splice(h.start-start,h.end-h.start,...h.values);return value.join('')};
        const l=apply(left),r=apply(right);if(l!==r&&!resolveConflict)return null;
        combined.push({start,end,values:[l===r?l:resolveConflict(start,end,l,r)]});
    }
    const result=[...original];for(const h of combined.sort((x,y)=>y.start-x.start))result.splice(h.start,h.end-h.start,...h.values);return result.join('');
}
function mergeSnapshots(base,local,remote,choices={}){
    if(syncEqual(local,remote)||syncEqual(base,local))return {state:remote,conflicts:[]};
    if(syncEqual(base,remote))return {state:local,conflicts:[]};
    const conflicts=[];
    function choose(key,label,a,b){if(!choices[key])conflicts.push({key,label,local:a,remote:b});return choices[key]==='remote'?b:a}
    function select(key,label,o,a,b){if(syncEqual(a,b)||syncEqual(b,o))return a;if(syncEqual(a,o))return b;return choose(key,label,a,b)}
    const result={};
    for(const space of ['thesis','blocks']){
        const original=base[space],mine=local[space],theirs=remote[space],maps=[original,mine,theirs].map(list=>new Map(list.map(n=>[n.id,n]))),[om,lm,rm]=maps;
        const layout=list=>list.map(n=>[n.id,n.parent||null]);
        const ol=layout(original),ll=layout(mine),rl=layout(theirs);
        const deleteEdit=original.some(n=>(!lm.has(n.id)&&rm.has(n.id)&&!syncEqual(nodeContent(n),nodeContent(rm.get(n.id))))||(!rm.has(n.id)&&lm.has(n.id)&&!syncEqual(nodeContent(n),nodeContent(lm.get(n.id)))));
        const structureConflict=deleteEdit||(!syncEqual(ol,ll)&&!syncEqual(ol,rl)&&!syncEqual(ll,rl));
        const key='structure:'+space;
        if(structureConflict&&!choices[key])conflicts.push({key,label:(space==='thesis'?'博论树':'知识块')+'：目录结构或删除冲突',local:mine,remote:theirs});
        const selected=structureConflict?(choices[key]==='remote'?theirs:mine):syncEqual(ol,ll)?theirs:mine;
        result[space]=selected.map((n,i)=>{
            const o=om.get(n.id),a=lm.get(n.id),b=rm.get(n.id);let value;
            if(!a||!b)value=nodeContent(n);
            else if(!o)value=select(space+':'+n.id,n.title||n.id,undefined,nodeContent(a),nodeContent(b));
            else{
                const ac=nodeContent(a),bc=nodeContent(b),oc=nodeContent(o);
                if(syncEqual(ac,bc)||syncEqual(bc,oc))value=ac;
                else if(syncEqual(ac,oc))value=bc;
                else{
                    // Independently edited fields and nonoverlapping body objects can merge.
                    value={};for(const field of new Set([...Object.keys(oc),...Object.keys(ac),...Object.keys(bc)])){
                        const x=oc[field],y=ac[field],z=bc[field];let v;
                        if(field==='body'&&!syncEqual(x,y)&&!syncEqual(x,z)&&!syncEqual(y,z)){
                            const merged=mergeBody(x,y,z,(start,end,l,r)=>choose(space+':'+n.id+':body:'+start+':'+end,(n.title||n.id)+'：正文对象',l,r));v=merged===null?choose(space+':'+n.id+':body',(n.title||n.id)+'：正文',y,z):merged;
                        }else if(field==='title'&&space==='blocks'&&y===blockLabel(a.body)&&z===blockLabel(b.body))v=y;
                        else v=select(space+':'+n.id+':'+field,(n.title||n.id)+'：'+field,x,y,z);
                        if(v!==undefined)value[field]=v;
                    }
                    if(space==='blocks'&&a.title===blockLabel(a.body)&&b.title===blockLabel(b.body))value.title=blockLabel(value.body);
                }
            }
            return {...value,parent:n.parent||null,order:i,level:n.level};
        });
    }
    // Trash operations also modify references and block membership. Do not
    // independently merge them with concurrent structural changes/deletions.
    const changed=(a,b)=>!syncEqual(a,b),lt=changed(base.trash,local.trash),rt=changed(base.trash,remote.trash);
    function trashIntersects(transaction,other){
        const old=new Map([...base.thesis,...base.blocks].map(n=>[n.id,n])),a=new Map([...transaction.thesis,...transaction.blocks].map(n=>[n.id,n])),b=new Map([...other.thesis,...other.blocks].map(n=>[n.id,n]));
        const touched=new Set([...new Set([...old.keys(),...a.keys()])].filter(id=>changed(nodeContent(old.get(id)),nodeContent(a.get(id)))));
        const removed=new Set();for(const [id,n] of old)if(!a.has(id)){removed.add(id);for(const m of n.body.matchAll(objectPattern()))removed.add(m[2]);for(const m of n.body.matchAll(/wb-id:([^\s"]+)/g))removed.add(m[1])}
        for(const id of new Set([...old.keys(),...b.keys()]))if(changed(nodeContent(old.get(id)),nodeContent(b.get(id)))){
            if(touched.has(id))return true;const n=b.get(id);if(n&&[...removed].some(r=>n.body.includes(':'+r+']]')||JSON.stringify([n.annotation,n.objectBindings,n.freePlacements]).includes(JSON.stringify(r))))return true;
        }
        return conflicts.some(c=>c.key==='structure:blocks');
    }
    if(changed(local,remote)&&((lt&&rt)||(lt&&trashIntersects(local,remote))||(rt&&trashIntersects(remote,local)))){
        const k='trash-transaction';
        if(!choices[k])return {state:local,conflicts:[{key:k,label:'回收站及关联引用操作冲突',local,remote}]};
        return {state:choices[k]==='remote'?remote:local,conflicts:[]};
    }
    result.trash=select('trash','回收站',base.trash,local.trash,remote.trash);
    // Moving an explicitly identified object can appear as a deletion plus
    // insertion in a textual diff. Never introduce duplicate stable IDs.
    function identityCounts(s){const counts=new Map(),add=id=>counts.set(id,(counts.get(id)||0)+1);for(const n of [...s.thesis,...s.blocks]){add(n.id);for(const m of n.body.matchAll(objectPattern()))add(m[2]);for(const m of n.body.matchAll(/wb-id:([^\s"]+)/g))add(m[1])}return counts}
    const originalCounts=[base,local,remote].map(identityCounts);
    if([...identityCounts(result)].some(([id,count])=>count>Math.max(1,...originalCounts.map(m=>m.get(id)||0)))){
        const k='identity-transaction';if(!choices[k])return {state:local,conflicts:[{key:k,label:'对象移动或复制冲突（避免重复 ID）',local,remote}]};
        return {state:choices[k]==='remote'?remote:local,conflicts:[]};
    }
    return {state:result,conflicts};
}
function draftKey(){return (currentWorkspace?.id||'directory')+':'+draftTab}
function openDraftDB(){
    if(!draftDB)draftDB=new Promise((resolve,reject)=>{const r=indexedDB.open('PaperEditer-drafts',1);r.onupgradeneeded=()=>r.result.createObjectStore('drafts');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
    return draftDB;
}
async function draftAccess(key,value,read=false){const store=await openDraftDB();return new Promise((resolve,reject)=>{const tx=store.transaction('drafts',read?'readonly':'readwrite'),s=tx.objectStore('drafts');const r=read?s.get(key):value?s.put(value,key):s.delete(key);tx.oncomplete=()=>resolve(r.result);tx.onerror=tx.onabort=()=>reject(tx.error||r.error)})}
function persistDraft(){
    if(!db||!syncBase)return;
    const key=draftKey(),value=dirty?{base:syncBase,local:editableSnapshot(),revision:db.revision}:null;
    draftPending.set(key,value);if(draftRunning)return;draftRunning=true;
    draftQueue=(async()=>{while(draftPending.size){const [key,value]=draftPending.entries().next().value;draftPending.delete(key);try{await draftAccess(key,value)}catch(e){console.warn(e);if(!draftWarning){draftWarning=true;showToast('浏览器无法保存本地草稿，请不要关闭页面。')}}}})().finally(()=>{draftRunning=false});
}
function syncStatus(){status(workspaceChanged?'工作区已切换 · 请刷新':conflict?'保存冲突 · 点击刷新处理':dirty?'待保存':'已同步')}
function applySynced(remote,merged,preserveEditor=false){
    const before=editableSnapshot();syncBase=clone({thesis:remote.thesis,blocks:remote.blocks,trash:remote.trash||[]});
    const local=clone(merged),redraw=!syncEqual(before,local);
    if(redraw&&preserveEditor){for(const space of ['thesis','blocks'])for(let i=0;i<db[space].length;i++){const n=db[space][i],next=local[space][i];if(!syncEqual(n,next)){for(const k of Object.keys(n))if(!Object.hasOwn(next,k))delete n[k];Object.assign(n,next)}}db.trash=local.trash}
    else if(redraw)Object.assign(db,local);
    Object.assign(db,{revision:remote.revision,originalLabels:remote.originalLabels,importReport:remote.importReport});
    dirty=!syncEqual(local,syncBase);conflict=false;syncConflict=null;syncNeeded=false;version++;
    if(redraw){undoStack=[];redoStack=[];panes.forEach(p=>{if(p.id&&!find(p.id))p.id=null});open=new Set([...open].filter(id=>find(id)));reindex();renderNav();if(preserveEditor){refreshObjectLabels();refreshObjectAnnotations();refreshFreeNotes();refreshBlockNetworks()}else renderPanes()}
    persistDraft();syncStatus();if(dirty){clearTimeout(timer);timer=setTimeout(save,100)}
}
function reconcile(remote,base=syncBase,local=editableSnapshot(),respectFocus=false){
    const remoteData={thesis:remote.thesis,blocks:remote.blocks,trash:remote.trash||[]},m=mergeSnapshots(base,local,remoteData);
    if(m.conflicts.length){conflict=true;dirty=true;syncConflict={remote,base,local};persistDraft();syncStatus();showToast('检测到并发冲突，草稿已保留。点击刷新处理。');return}
    const preserve=respectFocus&&!syncCanApply();
    if(preserve&&!syncCanPreserve(local,m.state)){syncNeeded=true;status('有新版本 · 结束输入后同步');return}
    applySynced(remote,m.state,preserve);
}
function downloadSyncDraft(name,data){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=el('a');a.href=url;a.download=name+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
function showSyncConflict(){
    if(!syncConflict)return;
    const {remote,base}=syncConflict,local=editableSnapshot(),server={thesis:remote.thesis,blocks:remote.blocks,trash:remote.trash||[]},choices={};
    const d=showDialog('处理并发修改');d.append(el('p','small','双方草稿均保留。选择每个冲突项的版本，其他不冲突的修改会自动合并。目录或回收站冲突以完整操作为单位。'));
    const backups=el('div','');backups.append(btn('导出本地草稿',()=>downloadSyncDraft('local-draft',local)),btn('导出服务器版本',()=>downloadSyncDraft('server-draft',server)));d.append(backups);
    const fields=el('div');d.append(fields);const done=btn('确认合并并保存',()=>{const m=mergeSnapshots(base,local,server,choices);if(m.conflicts.length)return;dialog.close();applySynced(remote,m.state)});d.append(done);
    function draw(){const m=mergeSnapshots(base,local,server,choices);fields.replaceChildren();for(const c of m.conflicts){const row=el('section');row.append(el('h3','',c.label));for(const [side,title] of [['local','本地版本'],['remote','服务器版本']]){const content=el('textarea');content.readOnly=true;content.rows=4;content.value=typeof c[side]==='string'?c[side]:JSON.stringify(c[side],null,2)??'（不存在）';content.style.width='100%';row.append(el('p','small',title),content,btn('采用'+title,()=>{choices[c.key]=side;draw()}))}fields.append(row)}done.disabled=!!m.conflicts.length;if(!m.conflicts.length)fields.append(el('p','','已选择全部冲突项。确认后保存。'))}draw();
}
function syncCanApply(){return !dialog.open&&!dragging&&$('menu').hidden&&(!document.activeElement?.closest('.richText,.editableTitle,math-field,textarea')||!editingEnabled)}
function syncCanPreserve(local,merged){
    if(dialog.open||dragging||!$('menu').hidden)return false;
    if(syncEqual(local,merged))return true;
    // Keep the live editor DOM and node references intact for changes in
    // unrelated, non-rendered chapters. Structural/knowledge changes may
    // affect visible references and are deferred until the editor loses focus.
    if(!syncEqual(local.blocks,merged.blocks)||!syncEqual(local.trash,merged.trash))return false;
    const visible=new Set([...paneBox.querySelectorAll('.visualDocument')].map(d=>d._owner));
    for(const p of panes){if(p.id){visible.add(p.id);for(const n of descendants(spaceOf(p.id),p.id))visible.add(n.id)}}
    if(local.thesis.length!==merged.thesis.length)return false;
    return local.thesis.every((n,i)=>{const next=merged.thesis[i];return n.id===next.id&&n.parent===next.parent&&n.order===next.order&&n.level===next.level&&(!visible.has(n.id)||syncEqual(n,next))});
}
async function syncNow(force=false){
    if(!db||!syncBase||syncLoading||syncBusy||saving||conflict||workspaceChanged||document.hidden&&!force)return;
    syncBusy=true;const workspace=currentWorkspace?.id;
    try{
        const r=await api('/api/state?since='+encodeURIComponent(db.revision)+'&workspace='+encodeURIComponent(workspace||'directory'));
        if(syncLoading||workspace!==currentWorkspace?.id)return;
        if(r.workspace?.id!==workspace){workspaceChanged=true;persistDraft();syncStatus();return}
        if(r.unchanged||r.revision===db.revision){syncNeeded=false;return}
        reconcile(r,syncBase,editableSnapshot(),!force);
    }catch(e){if(force)showToast(e.message);else console.warn(e)}
    finally{syncBusy=false;if(dirty&&!conflict&&!workspaceChanged&&!syncNeeded){clearTimeout(timer);timer=setTimeout(save,100)}}
}
function checkpoint(){undoStack.push(editableSnapshot());if(undoStack.length>30)undoStack.shift();redoStack=[]}
function refreshObjectLabels(){
    for(const el of document.querySelectorAll('.visualRef[data-token],a.ref[data-ref]')){
        const m=el.dataset.token&&[...el.dataset.token.matchAll(refPattern())][0],id=m?.[2]||el.dataset.ref;
        if(m&&['embed','cite'].includes(m[1]))continue;
        const t=resolve(id);
        const formula=m?.[1]==='eqref'||(!m&&t?.kind==='equation');
        el.textContent=t?(formula?'('+(t.number||t.title)+')':t.number||t.title):'〔未解析：'+id+'〕';
        el.title=t?.title||id;
    }
    for(const card of document.querySelectorAll('.visualCard[data-object]')){
        const label=card.querySelector('.visualCardHead .visualNum');if(label)label.textContent=resolve(card.dataset.object)?.number||''
    }
    for(const wrap of document.querySelectorAll('[data-subfigure]')){const t=resolve(wrap.dataset.subfigure);if(t)wrap.title='子图 '+t.number}
}
function change(structural=false){dirty=true;version++;reindex();syncStatus();persistDraft();clearTimeout(timer);timer=setTimeout(save,850);if(structural){renderNav();renderPanes()}else{refreshObjectLabels();refreshObjectAnnotations();refreshFreeNotes();refreshBlockNetworks()}scheduleToolbarUpdate()}
async function save(){
    if(!dirty||saving||conflict||workspaceChanged||syncLoading||syncBusy)return;
    if(syncNeeded){await syncNow();return}
    saving=true;const v=version, snapshot={...editableSnapshot(),revision:db.revision};
    status('保存中');
    try{
        const r=await api('/api/save',snapshot);
        db.revision=r.revision;syncBase={thesis:snapshot.thesis,blocks:snapshot.blocks,trash:snapshot.trash};
        dirty=v!==version;persistDraft();status(dirty?'待保存':'已保存');
    }catch(e){if(e.status===409){syncNeeded=true;status('等待同步 · 请结束当前输入');persistDraft()}else{status('保存失败 · 草稿保留');showToast(e.message);console.warn(e)}}
    finally{saving=false;if(syncNeeded)syncNow();else if(dirty&&!conflict&&v!==version){clearTimeout(timer);timer=setTimeout(save,850)}}
}
async function load(force=false){
    if(syncLoading)return;
    if(dirty&&!force&&!confirm('当前有尚未保存的修改，重新加载将尝试恢复本地草稿。继续？'))return;
    syncLoading=true;while(saving||syncBusy)await new Promise(r=>setTimeout(r,30));
    await draftQueue;
    await flushReading();
    clearTimeout(timer);
    try{
        const result=await api('/api/state');
        const nextWorkspace=result.workspace||null;
        readingReady=false;readingInteracted=false;readingLast='';
        if(nextWorkspace?.id!==currentWorkspace?.id){
            const first=currentWorkspace===null&&!readingRestored;
            currentWorkspace=nextWorkspace;readingReady=false;readingRestored=false;panes=[{id:null,edit:false}];active=0;open=new Set();view='thesis';search='';$('search').value='';
            // Migrate the original single-workspace reading settings once.
            try{
                if(first&&!localStorage.getItem('wb:workspace-reading-migrated')){
                    for(const k of [READING_KEY,PAGE_FOLD_KEY]){const v=localStorage.getItem(k);if(v&&!localStorage.getItem(workspaceStorageKey(k)))localStorage.setItem(workspaceStorageKey(k),v)}
                    localStorage.setItem('wb:workspace-reading-migrated','1')
                }
                pageFoldStates=JSON.parse(localStorage.getItem(workspaceStorageKey(PAGE_FOLD_KEY))||'{}')||{}
            }catch{pageFoldStates={}}
        }
        $('workspaceName').textContent=currentWorkspace?.name||'PaperEditer';$('workspaceName').title=currentWorkspace?.name||'PaperEditer';
        db=clone(result);trashSupported=Array.isArray(result.trash);db.trash=db.trash||[];dirty=false;conflict=false;undoStack=[];redoStack=[];
        syncBase=editableSnapshot();syncConflict=null;syncNeeded=false;workspaceChanged=false;
        reindex();
        const r=result.readingPosition||readPosition();
        const firstReadingLoad=!readingRestored||!!result.readingPosition;
        const hadNavState=Array.isArray(r?.open);
        if(firstReadingLoad){
            readingRestored=true;
            if(r?.pageFolds&&typeof r.pageFolds==='object')pageFoldStates=r.pageFolds;
            if(r&&Array.isArray(r.panes)&&r.panes.length){
                view=r.view==='blocks'?'blocks':'thesis';
                panes=r.panes.slice(0,2).map(p=>({id:typeof p.id==='string'&&find(p.id)?p.id:null,edit:false,reading:p.reading||null,thesisReading:thesisPosition(p.thesisReading)}));
                active=Math.max(0,Math.min(panes.length-1,Number(r.active)||0));
                open=new Set(Array.isArray(r.open)?r.open.filter(id=>find(id)):[]);
            }
        }
        if(view==='thesis'&&!panes[active].id)panes[active].id=db.thesis.find(n=>n.id==='chap:introduction')?.id||db.thesis[0]?.id||null;
        for(const p of panes){if(p.id&&!find(p.id))p.id=null;p.edit=false}
        if(firstReadingLoad&&!hadNavState){for(const n of all())if(children(spaceOf(n.id),n.id).length)open.add(n.id)}
        $('treeTab').classList.toggle('active',view==='thesis');$('blockTab').classList.toggle('active',view==='blocks');
        paneBox.replaceChildren();
        for(const id of ['treeTab','blockTab','dual','newNode','search'])$(id).disabled=false;
        status('已加载');renderNav();renderPanes();readingReady=true;
        // Migrate a previously stored local position only if the server has none.
        if(!result.readingPosition&&r){readingInteracted=true;rememberPosition();readingInteracted=false}
        try{const draft=await draftAccess(draftKey(),null,true);if(draft?.base&&draft?.local){Object.assign(db,clone(draft.local),{revision:draft.revision});syncBase=draft.base;dirty=true;reindex();renderNav();renderPanes();reconcile(result,draft.base,draft.local);if(conflict)showSyncConflict();else showToast('已恢复本地未保存草稿。')}}catch(e){console.warn(e);showToast('无法读取本地草稿。')}
    }catch(e){readingReady=false;db=null;currentWorkspace=null;readingRestored=false;nav.replaceChildren();$('sideTools').replaceChildren();$('workspaceName').textContent='PaperEditer';for(const id of ['treeTab','blockTab','dual','newNode','search'])$(id).disabled=true;status('未打开文件');paneBox.replaceChildren(el('p','empty',e.message));console.error(e)}
    finally{syncLoading=false;if(dirty&&!conflict&&!workspaceChanged){clearTimeout(timer);timer=setTimeout(save,100)}}
}
function mobileClose(){$('sidebar').classList.remove('open');$('overlay').classList.remove('show')}
function setView(v){
    captureReading();
    view=v;$('treeTab').classList.toggle('active',v==='thesis');$('blockTab').classList.toggle('active',v==='blocks');search='';$('search').value='';
    const p=panes[active];
    if(v==='thesis'){
        if(!thesisPosition(p)){
            const saved=thesisPosition(p.thesisReading);
            panes[active]=saved?{...saved,edit:false}:{id:db.thesis.find(n=>n.id==='chap:introduction')?.id||db.thesis[0]?.id||null,edit:false};
            if(panes[active].id)ancestors(find(panes[active].id)).forEach(id=>open.add(id));
        }
    }else if(p.id!==null)replacePane(active,null);
    renderNav();renderPanes()
}
function select(id,pi=active,object=null){
    if(!find(id))return;
    if(pi>=panes.length)panes.push({id:null,edit:false});
    replacePane(pi,id,object);active=pi;view=spaceOf(id);
    $('treeTab').classList.toggle('active',view==='thesis');$('blockTab').classList.toggle('active',view==='blocks');
    ancestors(find(id)).forEach(x=>open.add(x));mobileClose();renderNav();renderPanes();
    if(object)setTimeout(()=>{const p=paneBox.children[pi];const t=[...p.querySelectorAll('[data-object]')].find(e=>e.dataset.object===object);if(t){let a=t.parentElement;while(a&&a!==p){if(a.tagName==='DETAILS')a.open=true;a=a.parentElement}t.classList.add('highlight');t.scrollIntoView({block:'center',behavior:'smooth'});setTimeout(()=>t.classList.remove('highlight'),2500)}},80);
}
function jump(id,other=false){const t=resolve(id);if(!t){showToast('未找到引用：'+id);return}select(t.owner,other?(active===0?1:0):active,t.kind==='node'?null:(t.actualId||t.id))}
async function copy(s){await writeEditorClipboard(s);showToast('已复制，可直接粘贴')}
function menuAt(e,items){
    items=modeMenuItems(items);
    const m=$('menu');(dialog.open?dialog:document.body).append(m);m.replaceChildren();for(const [s,fn,disabled] of items){const b=btn(s,()=>{m.hidden=true;fn()});b.disabled=!!disabled;m.append(b)}m.hidden=!items.length;if(!items.length)return;
    const v=window.visualViewport,w=v?.width||innerWidth,h=v?.height||innerHeight,ox=v?.offsetLeft||0,oy=v?.offsetTop||0;
    m.style.maxHeight=Math.max(60,h-8)+'px';const x=e.clientX??15,y=e.clientY??70;m.style.left=Math.max(ox+4,Math.min(x,ox+w-m.offsetWidth-5))+'px';m.style.top=Math.max(oy+4,Math.min(y,oy+h-m.offsetHeight-5))+'px';
}
let localClipboard=null, localClipboardPreferred=false, touchMenuAt=0;
const isActionSurface=e=>!!e?.closest?.('#menu,#floatingTools,#headerActions');
async function writeEditorClipboard(value){
    localClipboard=value;
    try{await navigator.clipboard.writeText(value);localClipboardPreferred=false;return true}catch{localClipboardPreferred=true;showToast('已保存到编辑器剪贴板');return true}
}
async function readEditorClipboard(){
    if(localClipboardPreferred)return localClipboard;
    try{return await navigator.clipboard.readText()}catch{return localClipboard}
}
function editorClipboardMenu(e){
    const doc=e.target.closest('.visualDocument');
    if(doc?._clipboardMenu)return doc._clipboardMenu(e);
    const input=e.target.closest('input.editableTitle,input:not([readonly]),textarea:not([readonly])');
    if(!input||typeof input.selectionStart!=='number')return [];
    const a=input.selectionStart,b=input.selectionEnd;
    const put=txt=>{if(!input.isConnected||input.readOnly||!editingEnabled)return;input.focus();input.setRangeText(txt,a,b,'end');input.dispatchEvent(new Event('input',{bubbles:true}))};
    return [['剪切',async()=>{await writeEditorClipboard(input.value.slice(a,b));put('')},a===b],['复制',()=>writeEditorClipboard(input.value.slice(a,b)),a===b],['粘贴',async()=>{const t=await readEditorClipboard();if(t!=null)put(t);else showToast('无法读取剪贴板，请使用系统粘贴')}]];
}
const FLOATING_TOOLS_KEY='wb:floating-tools:v2';
let floatingToolsEnabled=(()=>{try{const stored=localStorage.getItem(FLOATING_TOOLS_KEY);if(stored!==null)return stored==='1'}catch{}return matchMedia('(pointer:coarse)').matches||innerWidth<=760})();
// A fresh mobile page opens for reading. Editing always requires an explicit switch.
let editingEnabled=!(matchMedia('(pointer:coarse)').matches||innerWidth<=760);
const MODE_TOOL='切换查看/编辑模式';
const readOnlyActions=new Set(['复制','复制交叉引用','复制知识块','复制正文（含公式源码）','复制对象源码','复制公式','高级：复制源码','当前页定位','另一页打开','查看关联网','查看原图','打开知识块','展开内容','折叠内容','展开下级','折叠下级','保存']);
function modeMenuItems(items){
    return editingEnabled?items:items.map(([name,fn,disabled])=>[name,fn,!!disabled||!readOnlyActions.has(name)])
}
function requireEditMode(){
    if(editingEnabled)return true;
    showToast('当前为查看模式，请先切换到编辑模式');return false
}
function setEditorControlMode(node){
    if(node.matches('.richText')){
        node.contentEditable=String(editingEnabled);
        node.setAttribute('aria-readonly',String(!editingEnabled));
        if(editingEnabled)node.removeAttribute('inputmode');else node.setAttribute('inputmode','none')
    }else if(node.matches('.editableTitle')){
        node.readOnly=!editingEnabled;
        if(editingEnabled)node.removeAttribute('inputmode');else node.setAttribute('inputmode','none')
    }else if(node.matches('math-field')){
        node.toggleAttribute('read-only',!editingEnabled);
        node.setAttribute('math-virtual-keyboard-policy',editingEnabled?'auto':'manual');
        if(customElements.get('math-field')){
            node.readOnly=!editingEnabled;
            node.mathVirtualKeyboardPolicy=editingEnabled?'auto':'manual'
        }
        node.setAttribute('aria-label',editingEnabled?'可编辑数学公式':'数学公式（查看模式）');
        node.tabIndex=editingEnabled?0:-1
    }
}
function syncEditMode(){
    document.body.classList.toggle('viewMode',!editingEnabled);
    for(const node of document.querySelectorAll('.richText,.editableTitle,math-field'))setEditorControlMode(node);
    $('newNode').disabled=!editingEnabled;
    const b=$('editModeToggle');
    if(b){
        setToolIcon(b,editingEnabled?'edit':'eye');
        b.setAttribute('aria-label',editingEnabled?'编辑模式（切换到查看模式）':'查看模式（切换到编辑模式）');
        b.setAttribute('aria-pressed',String(editingEnabled));b.classList.toggle('active',editingEnabled);
    }
    scheduleToolbarUpdate()
}
function toggleEditMode(){
    if(editingEnabled){
        const focus=document.activeElement;
        if(focus?.closest('.richText,.editableTitle,math-field'))focus.blur();
        window.mathVirtualKeyboard?.hide()
    }
    editingEnabled=!editingEnabled;
    $('menu').hidden=true;hideToolHint();syncEditMode();
    showToast(editingEnabled?'编辑模式：点击正文或公式输入':'查看模式：已关闭正文编辑')
}
// These guards also cover native paste/drop/delete shortcuts and touch gestures.
for(const type of ['beforeinput','cut','paste','drop','dragstart'])document.addEventListener(type,e=>{
    if(editingEnabled||!e.target.closest?.('.visualDocument,.editableTitle,.navrow'))return;
    e.preventDefault();e.stopImmediatePropagation()
},true);
let toolbarTarget=null,toolbarPoint=null;
let toolbarShortcutText='';
const toolPaths={
    eye:'<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    edit:'<path d="m15 5 4 4M4 20l4-1 12-12a2.8 2.8 0 0 0-4-4L4 15zM4 20h16"/>',
    cut:'<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="m8.2 8.2 12 12M8.2 15.8 20 4"/>',
    copy:'<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    paste:'<rect x="5" y="5" width="14" height="16" rx="2"/><rect x="9" y="3" width="6" height="4" rx="1" fill="white"/><path d="M9 13h6m-6 4h6"/>',
    note:'<path d="M20 15a3 3 0 0 1-3 3H9l-5 3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3zM9 10h6m-3-3v6"/>',
    insert:'<path d="M5 3h10l4 4v13H5zM15 3v5h4M9 14h6m-3-3v6"/>',
    link:'<path d="M10 13a4 4 0 0 0 6 1l4-4a4 4 0 0 0-6-6l-2 2m2 5a4 4 0 0 0-6-1l-4 4a4 4 0 0 0 6 6l2-2"/>',
    undo:'<path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"/>',
    redo:'<path d="m15 14 5-5-5-5m5 5H10a6 6 0 0 0 0 12h3"/>',
    toolbar:'<rect x="3" y="6" width="18" height="12" rx="3"/><path d="M7 10v4m5-4v4m5-4v4"/>'
};
function setToolIcon(button,name){
    button.innerHTML='<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+toolPaths[name]+'</svg>';
}
function toolIcon(button,name,label){
    setToolIcon(button,name);
    button.removeAttribute('title');button.setAttribute('aria-label',label);installToolHint(button);return button
}
let hintButton=null,hintTouch=false,hintTimer=0,hintDismiss=0;
function hideToolHint(){
    clearTimeout(hintTimer);clearTimeout(hintDismiss);hintButton=null;$('toolHint').hidden=true
}
function positionToolHint(){
    if(!hintButton)return;
    const tip=$('toolHint');
    if(!hintButton.isConnected||!hintButton.getClientRects().length){hideToolHint();return}
    const v=window.visualViewport,w=v?.width||innerWidth,h=v?.height||innerHeight,ox=v?.offsetLeft||0,oy=v?.offsetTop||0;
    const r=hintButton.getBoundingClientRect(),above=r.top-tip.offsetHeight-8;
    tip.style.left=Math.max(ox+4,Math.min(r.left+(r.width-tip.offsetWidth)/2,ox+w-tip.offsetWidth-4))+'px';
    tip.style.top=Math.max(oy+4,Math.min(above>=oy+4?above:r.bottom+8,oy+h-tip.offsetHeight-4))+'px'
}
function showToolHint(button,touch){
    hideToolHint();hintButton=button;hintTouch=touch;
    const tip=$('toolHint'),host=button.closest('dialog')||document.body;
    if(tip.parentElement!==host)host.append(tip);
    tip.textContent=button.getAttribute('aria-label')+(touch?'':button.dataset.shortcutHint||'');
    tip.hidden=false;positionToolHint()
}
function installToolHint(button){
    let press=null,suppressClick=false;
    button.addEventListener('pointerenter',e=>{
        if(e.pointerType==='touch'||press)return;
        hideToolHint();hintTimer=setTimeout(()=>showToolHint(button,false),350)
    });
    button.addEventListener('pointerleave',e=>{if(e.pointerType!=='touch'&&!press)hideToolHint()});
    button.addEventListener('pointerdown',e=>{
        hideToolHint();suppressClick=false;
        if(e.pointerType!=='touch')return;
        press={id:e.pointerId,x:e.clientX,y:e.clientY,fired:false};
        try{button.setPointerCapture(e.pointerId)}catch{}
        hintTimer=setTimeout(()=>{if(!press)return;press.fired=true;suppressClick=true;showToolHint(button,true)},500)
    });
    button.addEventListener('pointermove',e=>{
        if(press&&e.pointerId===press.id&&Math.hypot(e.clientX-press.x,e.clientY-press.y)>10){
            clearTimeout(hintTimer);suppressClick=true;press=null;hideToolHint()
        }
    });
    for(const type of ['pointerup','pointercancel','lostpointercapture'])button.addEventListener(type,e=>{
        if(!press||e.pointerId!==press.id)return;
        clearTimeout(hintTimer);const fired=press.fired;press=null;
        if(fired){suppressClick=true;hintDismiss=setTimeout(hideToolHint,1400)}
        else if(type!=='pointerup'){suppressClick=true;hideToolHint()}
        else if(['剪切','复制','粘贴'].includes(button.dataset.tool)&&button.getAttribute('aria-disabled')!=='true'&&[...document.querySelectorAll('.visualDocument')].some(d=>d._mixedRange?.())){
            // Chromium may suppress the compatibility click after dragging
            // a touch selection. Execute the short tap once on pointerup.
            button.click();suppressClick=true
        }
    });
    button.addEventListener('contextmenu',e=>{e.preventDefault();e.stopPropagation()});
    button.addEventListener('click',e=>{
        if(suppressClick||button.getAttribute('aria-disabled')==='true'){
            suppressClick=false;e.preventDefault();e.stopImmediatePropagation();return
        }
        hideToolHint()
    },true);
    button.addEventListener('focus',()=>{if(!press&&button.matches(':focus-visible'))showToolHint(button,false)});
    button.addEventListener('blur',()=>{if(hintButton===button&&!hintTouch)hideToolHint()})
}
function rememberToolbarTarget(e){
    if(!e.target?.closest||isActionSurface(e.target))return;
    if(e.target.closest('.pane,.navrow,#dialog')){toolbarTarget=e.target;toolbarPoint={x:e.clientX,y:e.clientY}}
}
function toolbarContext(){
    const scope=dialog.open?dialog:paneBox.children[active];
    if(!scope)return null;
    const usable=t=>t?.isConnected&&scope.contains(t)&&t.getClientRects().length;
    let target=usable(toolbarTarget)?toolbarTarget:null;
    const s=getSelection(),r=s?.rangeCount?s.getRangeAt(0):null;
    const rangeTarget=r&&(r.startContainer.nodeType===Node.ELEMENT_NODE?r.startContainer:r.startContainer.parentElement)?.closest('.richText');
    const mixedDoc=[...scope.querySelectorAll('.visualDocument')].find(d=>d._mixedRange?.());
    const selected=scope.querySelector('.selectedImage,.selectedObject'),focus=document.activeElement;
    if(mixedDoc&&usable(mixedDoc))target=mixedDoc;
    else if(selected&&usable(selected))target=selected;
    else if(usable(rangeTarget)&&(!target||target.closest('.richText')===rangeTarget||focus===rangeTarget))target=rangeTarget;
    else if(usable(focus)&&focus.matches('input,textarea,math-field,.richText'))target=focus;
    else if(!target||target.closest('.toolbar,button:not(.objectNoteMarker,.freeNoteMarker),.noteResizeHandle'))target=[...scope.querySelectorAll('.richText,.visualDocument,.page')].find(t=>usable(t)&&t.matches('.richText'))||scope.querySelector('.visualDocument,.page')||scope;
    const rect=target.getBoundingClientRect();
    const rr=r&&rangeTarget===target?r.getBoundingClientRect():null;
    const x=rr?.height?rr.left+rr.width/2:target===toolbarTarget&&toolbarPoint?toolbarPoint.x:rect.left+Math.min(rect.width/2,60);
    const y=rr?.height?rr.top+rr.height/2:target===toolbarTarget&&toolbarPoint?toolbarPoint.y:rect.top+Math.min(rect.height/2,16);
    let explicit=null;
    for(let a=target;a&&scope.contains(a);a=a.parentElement)if(a._contextTarget){explicit=a._contextTarget();break}
    return {event:{target,clientX:x,clientY:y,useCurrentSelection:true},explicit}
}
function currentToolbarItems(preview=false){
    const c=toolbarContext();
    if(c)c.event.preview=preview;
    return c?simpleContextMenu(c.event,c.explicit):[]
}
function toolbarAction(label){
    if(!editingEnabled&&!readOnlyActions.has(label)){requireEditMode();return}
    const item=currentToolbarItems().find(i=>i[0]===label);
    if(item&&!item[2])item[1]();
    else showToast(['剪切','复制'].includes(label)?'请先选中文本或对象':'请先定位正文或对象');
}
function toolbarUndo(redo){
    if(!requireEditMode())return;
    const root=dialog.open&&dialog.querySelector('.visualDocument');
    if(root?._draftHistory)root._draftHistory(redo);
    else if(!dialog.open)undo(redo)
}
function positionFloatingTools(){
    const bar=$('floatingTools');if(bar.hidden)return;
    const v=window.visualViewport,w=v?.width||innerWidth,h=v?.height||innerHeight,ox=v?.offsetLeft||0,oy=v?.offsetTop||0;
    bar.style.maxWidth=Math.max(0,w-16)+'px';
    let x=ox+(w-bar.offsetWidth)/2,y=oy+h-bar.offsetHeight-12;
    const scope=dialog.open?dialog:paneBox.children[active],s=getSelection(),r=s?.rangeCount?s.getRangeAt(0):null;
    const a=r&&(r.startContainer.nodeType===Node.ELEMENT_NODE?r.startContainer:r.startContainer.parentElement)?.closest('.richText');
    const selected=scope?.querySelector('.selectedImage,.selectedObject'),focus=document.activeElement;
    const mixed=[...(scope?.querySelectorAll('.visualDocument')||[])].map(d=>d._mixedRange?.()).find(Boolean);
    const anchor=mixed?.getBoundingClientRect()||selected?.getBoundingClientRect()||(a&&scope?.contains(a)&&(focus===a||!r.collapsed)?r.getBoundingClientRect():null)||(focus?.matches('math-field,.editableTitle')&&scope?.contains(focus)?focus.getBoundingClientRect():null);
    const visible=scope?.getBoundingClientRect();
    if(anchor&&visible&&(anchor.width||anchor.height)&&anchor.bottom>=Math.max(oy,visible.top)&&anchor.top<=Math.min(oy+h,visible.bottom)){
        x=anchor.left+anchor.width/2-bar.offsetWidth/2;
        const above=anchor.top-bar.offsetHeight-10,below=anchor.bottom+12;
        if(above>=Math.max(oy+8,visible.top))y=above;
        else if(below+bar.offsetHeight<=oy+h-8)y=below;
    }
    bar.style.left=Math.max(ox+8,Math.min(x,ox+w-bar.offsetWidth-8))+'px';
    bar.style.top=Math.max(oy+8,Math.min(y,oy+h-bar.offsetHeight-8))+'px';
    positionToolHint()
}
let toolbarFrame=0;
function scheduleToolbarUpdate(){
    if(toolbarFrame)return;
    toolbarFrame=requestAnimationFrame(()=>{toolbarFrame=0;if(floatingToolsEnabled&&db){
        const bar=$('floatingTools');
        bar.hidden=dialog.open&&!dialog.querySelector('.visualDocument');
        if(bar.hidden){hideToolHint();return}
        const items=currentToolbarItems(true);
        for(const b of bar.querySelectorAll('[data-tool]')){
            const label=b.dataset.tool;
            if(label===MODE_TOOL){b.setAttribute('aria-disabled','false');continue}
            if(!editingEnabled&&!readOnlyActions.has(label)){b.setAttribute('aria-disabled','true');continue}
            if(label==='撤销'||label==='重做'){
                const draft=dialog.open&&dialog.querySelector('.visualDocument');
                b.setAttribute('aria-disabled',String(draft?!(draft._canDraftHistory?.(label==='重做')):dialog.open||!(label==='撤销'?undoStack:redoStack).length));
            }else{const item=items.find(i=>i[0]===label);b.setAttribute('aria-disabled',String(!item||!!item[2]))}
        }
        positionFloatingTools()
    }})
}
function refreshFloatingTools(){
    const bar=$('floatingTools'),toggle=$('headerActions');
    document.body.classList.toggle('floatingToolsEnabled',floatingToolsEnabled);
    toggle.classList.toggle('active',floatingToolsEnabled);toggle.setAttribute('aria-pressed',String(floatingToolsEnabled));
    const label=floatingToolsEnabled?'隐藏工具栏':'显示工具栏';toggle.dataset.shortcutHint=toolbarShortcutText;toggle.setAttribute('aria-label',label);
    bar.hidden=!floatingToolsEnabled||(dialog.open&&!dialog.querySelector('.visualDocument'));
    if(!floatingToolsEnabled){hideToolHint();return}
    const host=dialog.open?dialog:document.body;if(bar.parentElement!==host)host.append(bar);
    positionFloatingTools();scheduleToolbarUpdate()
}
function toggleFloatingTools(){
    floatingToolsEnabled=!floatingToolsEnabled;
    try{localStorage.setItem(FLOATING_TOOLS_KEY,floatingToolsEnabled?'1':'0')}catch{}
    $('menu').hidden=true;refreshFloatingTools();updateShortcutHints()
}
function showFloatingTools(e,items){
    rememberToolbarTarget(e);
    if(floatingToolsEnabled)refreshFloatingTools();
    menuAt(e,items)
}
function initFloatingTools(){
    const bar=$('floatingTools');
    const mode=toolIcon(btn('',toggleEditMode),'eye',MODE_TOOL);mode.id='editModeToggle';bar.append(mode);
    for(const [name,label] of [['cut','剪切'],['copy','复制'],['paste','粘贴'],['note','新建批注/知识块'],['insert','插入批注/知识块'],['link','复制交叉引用']])bar.append(toolIcon(btn('',()=>toolbarAction(label)),name,label));
    bar.append(toolIcon(btn('',()=>toolbarUndo(false)),'undo','撤销'),toolIcon(btn('',()=>toolbarUndo(true)),'redo','重做'));
    for(const b of bar.querySelectorAll('button'))b.dataset.tool=b.getAttribute('aria-label');
    toolIcon($('headerActions'),'toolbar','显示工具栏');
    syncEditMode();
    refreshFloatingTools()
}
function hideFloatingTools(){if(!floatingToolsEnabled)$('floatingTools').hidden=true;else refreshFloatingTools()}
for(const id of ['menu','floatingTools','headerActions'])$(id).addEventListener('pointerdown',e=>{e.preventDefault();e.stopPropagation()});
function context(e,items,target=null,exact=false){
    if(target)e._contextTarget=()=>typeof target==='function'?target():target;
    const get=ev=>exact?items(ev):simpleContextMenu(ev,typeof target==='function'?target():target);
    const show=ev=>{hideFloatingTools();if(ev.pointerType==='touch'||ev.sourceCapabilities?.firesTouchEvents){touchMenuAt=Date.now();showFloatingTools(ev,get(ev))}else menuAt(ev,get(ev))};
    e.addEventListener('contextmenu',ev=>{if(isActionSurface(ev.target))return;ev.preventDefault();ev.stopPropagation();clearTimeout(longTimer);show(ev)});
    let start=null;
    e.addEventListener('pointerdown',ev=>{
        if(isActionSurface(ev.target))return;
        if(ev.pointerType==='touch'&&!ev.target.closest('.resizeHandle,.noteResizeHandle')){
            clearTimeout(longTimer);start={x:ev.clientX,y:ev.clientY,fired:false};longTimer=setTimeout(()=>{if(start)start.fired=true;touchMenuAt=Date.now();ev.target.closest('.visualDocument')?._prepareTouchRange?.(ev);ev.useCurrentSelection=true;showFloatingTools(ev,get(ev))},550);ev.stopPropagation()
        }
    });
    e.addEventListener('pointermove',ev=>{if(start&&Math.hypot(ev.clientX-start.x,ev.clientY-start.y)>10){clearTimeout(longTimer);start=null}});
    for(const type of ['pointerup','pointercancel'])e.addEventListener(type,()=>{if(start?.fired)touchMenuAt=Date.now();clearTimeout(longTimer);start=null});
}
document.addEventListener('pointerdown',e=>{if(!isActionSurface(e.target)){hideToolHint();rememberToolbarTarget(e);$('menu').hidden=true}},true);
document.addEventListener('click',e=>{if(Date.now()-touchMenuAt<500&&!isActionSurface(e.target)){e.preventDefault();e.stopImmediatePropagation()}},true);
document.addEventListener('pointerup',e=>{if(e.button===0)rememberToolbarTarget(e)});
for(const type of ['selectionchange','focusin','focusout','input','pointerup','click','keyup','scroll'])document.addEventListener(type,scheduleToolbarUpdate,true);
window.addEventListener('resize',positionFloatingTools);
window.visualViewport?.addEventListener('resize',positionFloatingTools);
window.visualViewport?.addEventListener('scroll',positionFloatingTools);
let previousContextSelection=null;
document.addEventListener('pointerdown',e=>{
    if(e.button!==2&&e.pointerType!=='touch')return;
    const s=window.getSelection();
    previousContextSelection=s?.rangeCount?{range:s.getRangeAt(0).cloneRange(),time:Date.now(),x:e.clientX,y:e.clientY}:null;
},true);
function annotationBinding(e,pane){
    if(!pane)return null;
    const near=(r,pad)=>r&&(r.height||r.width)&&e.clientX>=r.left-pad&&e.clientX<=r.right+pad&&e.clientY>=r.top-pad&&e.clientY<=r.bottom+pad;
    const s=window.getSelection(),prior=e.useCurrentSelection?null:previousContextSelection;
    const r=prior&&Date.now()-prior.time<2000&&Math.hypot(e.clientX-prior.x,e.clientY-prior.y)<32?prior.range:s?.rangeCount?s.getRangeAt(0).cloneRange():null;
    if(!r||!pane.contains(r.startContainer)||!pane.contains(r.endContainer))return null;
    const startElement=r.startContainer.nodeType===Node.ELEMENT_NODE?r.startContainer:r.startContainer.parentElement;
    const area=startElement?.closest('.richText'),doc=area?.closest('.visualDocument');
    if(!area||!doc?._owner||!doc._insertBoundAnnotation)return null;
    const rects=[...r.getClientRects()],pad=r.collapsed?22:10;
    if(!rects.some(x=>near(x,pad))&&!near(r.getBoundingClientRect(),pad))return null;
    const quote=r.collapsed?'':r.toString();
    const start=r.cloneRange();start.collapse(true);
    return {doc,area,range:start,quote,owner:find(doc._owner),mode:r.collapsed?'caret':'selection'};
}
function freeNotePlacements(n){return Array.isArray(n.freePlacements)?n.freePlacements:[]}
function freeNoteLocation(e){
    const pane=e.target?.closest?.('.pane')||paneBox.children[active],page=pane?.querySelector(':scope > .page');
    const pageId=pane?._readingPane?.id;
    if(!page||!pageId)return null;
    const r=page.getBoundingClientRect();
    if(!r.width)return null;
    return {id:'place-'+uid(),pageId,x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.round(e.clientY-r.top)),floatOffset:{x:14,y:8}}
}
function freeNoteAnchor(placement,pane=null){
    const pages=[...paneBox.querySelectorAll('.pane > .page')].filter(p=>p.parentElement._readingPane?.id===placement.pageId&&p.getClientRects().length);
    const page=pages.find(p=>p.parentElement===pane)||pages[0];
    if(!page)return null;
    const r=page.getBoundingClientRect(),x=r.left+Math.min(Math.max(0,r.width-18),Math.max(0,r.width*placement.x)),y=r.top+Math.min(Math.max(0,r.height-18),Math.max(0,placement.y));
    return {left:x,right:x,top:y,bottom:y,height:1,width:0}
}
function placeExistingFreeNote(id,placement){
    const n=find(id);if(!n||!placement)return;
    checkpoint();n.freePlacements=[...freeNotePlacements(n),placement];change(false)
}
function objectNoteBindings(n){return Array.isArray(n.objectBindings)?n.objectBindings:[]}
function objectNoteAnchor(id,pane=null){
    const nodes=[...document.querySelectorAll('.visualCard[data-object],.resizeImage[data-subfigure],.editableHeading[data-bind-object]')].filter(x=>(x.dataset.object||x.dataset.bindObject)===id&&x.getClientRects().length);
    const a=nodes.find(x=>pane&&x.closest('.pane')===pane)||nodes[0];
    if(!a)return null;const r=a.getBoundingClientRect();return {left:r.right,right:r.right,top:r.top,bottom:r.top,height:Math.max(1,r.height),width:0}
}
function objectAnnotationBinding(source,e){
    if(!source)return null;
    const targetId=source.actualId||source.id,owner=find(source.owner);
    if(!owner)return null;
    const pane=e.target.closest('.pane');
    return {mode:'object',targetId,owner,quote:'',anchorRect:()=>objectNoteAnchor(targetId,pane)}
}
function bindNoteToObject(id,binding){
    const n=find(id);if(!n||!binding||id===binding.targetId)return;
    if(objectNoteBindings(n).some(x=>x.targetId===binding.targetId)){showToast('该知识块已绑定此对象');return}
    checkpoint();n.objectBindings=[...objectNoteBindings(n),{targetId:binding.targetId,floatOffset:{x:14,y:8}}];change(false)
}
function simpleContextMenu(e,explicit){
    const rangeDoc=e.target.closest('.visualDocument');
    if(rangeDoc?._mixedRange?.())return modeMenuItems(rangeDoc._clipboardMenu(e));
    const pane=e.target.closest('.pane'),pi=pane?[...paneBox.children].indexOf(pane):active;
    const docs=pane?[...pane.querySelectorAll('.visualDocument')].filter(d=>d.getClientRects().length):[];
    const distance=d=>{const r=d.getBoundingClientRect();return Math.max(r.top-e.clientY,0,e.clientY-r.bottom)};
    const doc=e.target.closest('.visualDocument')||docs.sort((a,b)=>distance(a)-distance(b))[0];
    const object=e.target.closest('[data-object]')?.dataset.object;
    // Only actual reference targets qualify; a nearby section is not a target.
    const source=explicit||resolve(object);
    const owner=find(doc?._owner)||find(panes[pi]?.id);
    const draft=dialog.open&&e.target.closest('#dialog');
    // Prose and its surrounding document whitespace allow annotations, not
    // headings, navigation, reference objects or other interface controls.
    const prose=!!(pane&&owner&&!draft&&!source&&!e.target.closest('button,input,textarea,select,.toolbar,.editableHeading,.breadcrumb,summary,.blockcard,.graph,.cards,.visualRef,[data-object],.resizeHandle,.noteResizeHandle'));
    const objectBinding=!draft&&source?objectAnnotationBinding(source,e):null;
    const binding=objectBinding||(prose?annotationBinding(e,pane):null);
    const freePlacement=prose&&!binding?freeNoteLocation(e):null;
    const anchor=doc?._annotationAnchor?.(e.clientY);
    const attach=objectBinding?(id=>bindNoteToObject(id,objectBinding)):owner&&!draft? (id=>{
        if(id===owner.id)return;
        if(binding){if(!binding.doc._insertBoundAnnotation(id,binding))showToast('原文字位置已变化，知识块已保留但未绑定');return}
        if(freePlacement){placeExistingFreeNote(id,freePlacement);return}
        if(doc?._owner===owner.id&&doc._insertAnnotation&&doc.isConnected)doc._insertAnnotation(id,anchor);
        else{checkpoint();owner.body=owner.body.trimEnd()+'\n\n[[embed:'+id+']]\n';change(true)}
    }):null;
    const result=editorClipboardMenu(e);
    // Insertion lives in the context menu, not a persistent button in the text.
    const insertDoc=e.target.closest('.visualDocument')||(prose?doc:null);
    if(!e.preview&&insertDoc?._contentInsertMenu)result.push(...insertDoc._contentInsertMenu(e));
    if(prose||objectBinding){
        result.push(['新建批注/知识块',()=>newAnnotation(binding,e)]);
        result.push(['插入批注/知识块',()=>annotationDialog(binding,attach,objectBinding?.targetId||owner?.id,e)]);
    }
    if(source&&(source.kind==='node'||source.number||all().some(n=>refsOf(n).includes(source.id))))result.push(['复制交叉引用',()=>copy(refToken(source))]);
    const noteId=draft?dialog._noteId:(source?.kind==='node'&&spaceOf(source.id)==='blocks'?source.id:pane&&owner&&spaceOf(owner.id)==='blocks'?owner.id:null);
    if(noteId&&find(noteId))result.push(['删除知识块/批注',()=>deleteNode(find(noteId))]);
    return modeMenuItems(result);
}
function annotationDialog(binding,attach,ownerId,e){
    const d=showDialog('插入批注/知识块',{floating:true,x:e.clientX,y:e.clientY});
    if(binding?.quote)d.append(el('blockquote','muted',binding.quote));
    const q=el('input');q.placeholder='搜索已有知识块';q.style.width='100%';const list=el('div','visualPickList');
    function draw(){list.replaceChildren();const key=q.value.trim().toLowerCase();for(const n of db.blocks.filter(n=>n.id!==ownerId&&n.title.toLowerCase().includes(key)).slice(0,80))list.append(btn(n.title,()=>{dialog.close();if(attach)attach(n.id);else select(n.id)}));if(!list.childNodes.length)list.append(el('p','muted','暂无可插入的知识块'))}
    d.append(q,list);q.addEventListener('input',draw);draw();q.focus()
}
function newAnnotation(binding,e){
    const origin=binding?.owner,quote=binding?.quote;
    const freePlacement=!binding?freeNoteLocation(e):null;
    const initial='';
    newNode('blocks',null,initial,'',id=>{
        if(binding?.mode==='object'){showToast('批注已绑定对象');return}
        if(binding&&!binding.doc._insertBoundAnnotation(id,binding))showToast('原文字位置已变化，知识块已保留但未绑定');
        else showToast(binding?'批注已创建并绑定':freePlacement?'知识块已保留在创建位置':'已创建独立知识块')
    },{floating:true,x:e.clientX,y:e.clientY,annotation:true,binding,freePlacement,anchorRect:binding?.mode==='object'?binding.anchorRect:binding?()=>binding.area.isConnected?binding.range.getBoundingClientRect():null:freePlacement?()=>freeNoteAnchor(freePlacement):null});
}
function refToken(t){return '[['+(t.kind==='equation'?'eqref':'ref')+':'+(t.actualId||t.id)+']]'}
function refMenu(t){return [['复制交叉引用',()=>copy(refToken(t))],['当前页定位',()=>jump(t.id)],['另一页打开',()=>jump(t.id,true)],['查看关联网',()=>relationDialog(t.owner,t.id)]]}
function nodeMenu(n){return spaceOf(n.id)==='blocks'?[['复制交叉引用',()=>copy(refToken(resolve(n.id)))]]:treeNodeMenu(n)}
function createEmptyThesis(parent=null,after=null){
    if(!requireEditMode())return;
    checkpoint();const id='sec-'+uid(),n={id,title:'',parent,level:1,number:'',file:'thesis/'+id+'.md',source:'',order:db.thesis.length,body:''};
    const list=db.thesis;
    if(after){const sibling=find(after),last=descendants('thesis',after).at(-1)||sibling;list.splice(list.indexOf(last)+1,0,n)}else list.push(n);
    normalizeOrder('thesis');change(false);select(id);
}
function treeNodeMenu(n){return [['新建同级目录',()=>createEmptyThesis(n.parent||null,n.id)],['新建子目录',()=>createEmptyThesis(n.id)],['删除',()=>deleteNode(n)]]}
const TREE_NEST_DELAY=600;
let treeDrop=null;
function clearTreeDrop(){
    if(!treeDrop)return;
    clearTimeout(treeDrop.timer);clearTreeDropPaint(treeDrop);treeDrop=null
}
function updateTreeDrop(row,n,e){
    const source=find(dragging);
    if(!editingEnabled||!source||source.id===n.id||spaceOf(source.id)!==spaceOf(n.id)||ancestors(n).includes(source.id)){clearTreeDrop();return null}
    const rect=row.getBoundingClientRect(),pos=(e.clientY-rect.top)/rect.height;
    const center=pos>=.25&&pos<=.75,side=pos<.5?'before':'after';
    if(!treeDrop||treeDrop.row!==row||treeDrop.center!==center){
        clearTreeDrop();const state={row,node:n,space:view,center,where:side,ready:center&&view==='blocks',timer:null};treeDrop=state;
        if(center&&!state.ready)state.timer=setTimeout(()=>{if(treeDrop===state&&dragging&&row.isConnected){state.ready=true;state.where='inside';paintTreeDrop(state)}},TREE_NEST_DELAY)
    }
    treeDrop.where=treeDrop.ready?'inside':side;paintTreeDrop(treeDrop);return treeDrop.where
}
function clearTreeDropPaint(state){
    if(!state.marker)return;
    state.marker.classList.remove('drop-before','drop-after','drop-inside');state.marker.style.removeProperty('--drop-indent');state.marker=null
}
function paintTreeDrop(state){
    let marker=state.row;
    // Inserting after an expanded node means after its entire visible subtree,
    // at the target's level, not between the parent and its first child.
    if(state.space==='thesis'&&state.where==='after'&&!search.trim()){
        for(let next=state.row.nextElementSibling;next?.dataset.nodeId;next=next.nextElementSibling){
            const node=find(next.dataset.nodeId),chain=ancestors(node);
            if(!chain.includes(state.node.id))break;
            if(node.id!==dragging&&!chain.includes(dragging))marker=next;
        }
    }
    const indent=state.row.style.paddingLeft||'0px';
    if(state.marker===marker&&state.paintedWhere===state.where)return;
    clearTreeDropPaint(state);state.marker=marker;state.paintedWhere=state.where;
    marker.style.setProperty('--drop-indent',indent);marker.classList.add('drop-'+state.where)
}
function renderNav(){
    if(!db)return;
    clearTreeDrop();
    nav.replaceChildren();
    const branches=db[view].filter(n=>children(view,n.id).length).map(n=>n.id);
    const collapsed=branches.every(id=>!open.has(id));
    const foldButton=btn(collapsed?'全部展开':'全部折叠',()=>{
        for(const n of db[view]){if(collapsed){if(children(view,n.id).length)open.add(n.id)}else open.delete(n.id)}
        renderNav()
    },'foldAllButton navFoldButton');
    foldButton.disabled=!branches.length;foldButton.title='仅展开或折叠导航目录';
    $('sideTools').replaceChildren(foldButton);
    $('newNode').title=view==='blocks'?'新建知识块':'新建章节';
    const list=db[view];
    const query=search.trim().toLowerCase();
    if(view==='blocks')nav.append(btn('块网总览',()=>{replacePane(active,null);renderPanes();mobileClose()},'navlabel'));
    function add(n,depth,hit=false){
        const row=el('div','navrow'+(panes[active].id===n.id?' selected':''));
        row.style.paddingLeft=Math.min(depth,8)*12+'px';row.dataset.nodeId=n.id;row.draggable=true;
        const kids=children(view,n.id);
        const toggle=btn(kids.length?(open.has(n.id)?'▾':'▸'):'·',()=>{if(open.has(n.id))open.delete(n.id);else open.add(n.id);renderNav()});
        const rowMenu=()=>view==='blocks'?[...nodeMenu(n),['删除',()=>deleteNode(n)]]:nodeMenu(n);
        const t=el('span','navlabel',label(n));row.append(toggle,t,btn('⋯',e=>menuAt(e,rowMenu())));
        if(hit){const excerpt=n.body.toLowerCase().indexOf(query);if(excerpt>=0){const sub=el('span','searchhit',n.body.slice(Math.max(0,excerpt-14),excerpt+40));t.append(sub)}}
        row.addEventListener('click',()=>select(n.id));context(row,rowMenu,()=>resolve(n.id),true);
        row.addEventListener('dragstart',e=>{if(!editingEnabled){e.preventDefault();return}clearTreeDrop();dragging=n.id;e.dataTransfer.setData('text/plain',n.id);row.classList.add('dragging')});
        row.addEventListener('dragend',()=>{clearTreeDrop();dragging=null;row.classList.remove('dragging')});
        row.addEventListener('dragover',e=>{if(updateTreeDrop(row,n,e))e.preventDefault()});
        row.addEventListener('dragleave',e=>{if(treeDrop?.row===row&&!row.contains(e.relatedTarget))clearTreeDrop()});
        row.addEventListener('drop',e=>{e.preventDefault();const where=updateTreeDrop(row,n,e),id=dragging;clearTreeDrop();dragging=null;if(where)moveTo(id,n.id,where)});
        nav.append(row);if(!hit&&open.has(n.id))for(const child of kids)add(child,depth+1);
    }
    if(query){for(const n of list.filter(n=>(n.title+' '+n.body).toLowerCase().includes(query)))add(n,0,true)}
    else for(const n of children(view,null))add(n,0);
    if(!list.length)nav.append(el('div','empty','尚无知识块，点击 ＋ 新建。'));
    rememberPosition();
}
function normalizeOrder(space){db[space]=flat(space);db[space].forEach((n,i)=>{n.order=i;n.level=ancestors(n).length+1})}
function moveTo(id,other,where){
    if(!requireEditMode())return;
    const n=find(id),t=find(other);if(!n||!t||id===other||spaceOf(id)!==spaceOf(other))return;
    const s=spaceOf(id);if(ancestors(t).includes(id)){showToast('不能移动到自己的下级');return}
    checkpoint();n.parent=where==='inside'?other:(t.parent||null);
    const list=db[s];list.splice(list.indexOf(n),1);
    let at=list.indexOf(t);if(where==='after'||where==='inside')at++;
    if(where==='inside'){const last=descendants(s,other).at(-1);if(last)at=list.indexOf(last)+1}
    list.splice(Math.max(0,at),0,n);normalizeOrder(s);if(n.parent)open.add(n.parent);change(true);
}
function moveRelative(n,d){const s=spaceOf(n.id),sib=children(s,n.parent),i=sib.indexOf(n);if(sib[i+d])moveTo(n.id,sib[i+d].id,d<0?'before':'after')}
function indent(n){const s=spaceOf(n.id),sib=children(s,n.parent),i=sib.indexOf(n);if(i>0)moveTo(n.id,sib[i-1].id,'inside')}
function outdent(n){if(n.parent)moveTo(n.id,n.parent,'after')}
function mergePrev(n){
    const s=spaceOf(n.id),sib=children(s,n.parent),p=sib[sib.indexOf(n)-1];
    if(!p){showToast('没有上一节点');return}
    if(!confirm('将“'+n.title+'”合并至“'+p.title+'”？引用原节点的链接也会迁移。'))return;
    checkpoint();p.body+='\n\n## '+n.title+'\n\n'+n.body;
    for(const c of children(s,n.id))c.parent=p.id;
    for(const a of all())a.body=a.body.replace(refPattern(),(m,k,id)=>id===n.id?'[['+k+':'+p.id+']]':m);
    db[s]=db[s].filter(x=>x!==n);normalizeOrder(s);panes.forEach(x=>{if(x.id===n.id)x.id=p.id});change(true);
}
function deleteNode(n){
    if(!requireEditMode())return;
    if(!n)return;
    const s=spaceOf(n.id),kids=descendants(s,n.id);
    if(s==='blocks'&&!trashSupported){showToast('请先重启工作台服务以启用回收站');return}
    const nodeIds=new Set([n.id,...kids.map(x=>x.id)]);
    if(s==='blocks'&&dialog.open&&nodeIds.has(dialog._noteId))closeWorkbenchDialog();
    const ids=new Set([...nodeIds,...[...targets.values(),...aliases.values()].filter(t=>nodeIds.has(t.owner)).map(t=>t.id)]);
    const count=all().filter(x=>!ids.has(x.id)&&[...x.body.matchAll(refPattern())].some(m=>ids.has(m[2])&&(s!=='blocks'||m[1]!=='embed'))).length;
    if(s!=='blocks'&&!confirm('删除“'+n.title+'”'+(kids.length?'及 '+kids.length+' 个下级':'')+'？'+(count?'有 '+count+' 个节点引用其中对象，删除会留下失效交叉引用。':'')))return;
    if(dialog.open&&ids.has(dialog._noteId))closeWorkbenchDialog();
    checkpoint();
    if(s==='blocks'){
        const entry={id:uid(),deletedAt:new Date().toISOString(),nodes:clone([n,...kids]),anchors:[],bindings:[]};
        for(const x of all())if(!ids.has(x.id)){
            const marks=[];let removed=0;
            const body=x.body.replace(refPattern(),(m,k,id,offset)=>{
                if(k==='cite'||!ids.has(id))return m;
                const at=offset-removed,last=marks.at(-1);removed+=m.length;
                if(last?.at===at)last.token+=m;else marks.push({at,token:m});return ''
            });
            for(const mark of marks)entry.anchors.push({...mark,owner:x.id,left:body.slice(Math.max(0,mark.at-64),mark.at),right:body.slice(mark.at,mark.at+64)});
            x.body=body;
            if(spaceOf(x.id)==='blocks'){
                for(const [field,match] of [['objectBindings',b=>ids.has(b.targetId)],['freePlacements',b=>nodeIds.has(b.pageId)]]){
                    const values=x[field];if(!Array.isArray(values))continue;
                    const removed=values.filter(match);if(!removed.length)continue;
                    entry.bindings.push({owner:x.id,field,values:clone(removed)});x[field]=values.filter(b=>!match(b));
                }
                if(x.annotation&&nodeIds.has(x.annotation.owner)){entry.bindings.push({owner:x.id,field:'annotation',values:[clone(x.annotation)]});delete x.annotation}
            }
        }
        db.trash.unshift(entry);
    }
    db[s]=db[s].filter(x=>!nodeIds.has(x.id));panes.forEach(p=>{if(nodeIds.has(p.id)){p.id=null;p.edit=false}});change(true)
}
function restoreTrash(entry){
    if(!requireEditMode())return;
    if(entry.nodes.some(n=>find(n.id))){showToast('存在同 ID 的节点，无法恢复');return}
    checkpoint();
    const nodes=clone(entry.nodes),ids=new Set(nodes.map(n=>n.id));
    for(const n of nodes){if(n.parent&&!ids.has(n.parent)&&!db.blocks.some(x=>x.id===n.parent))n.parent=null;db.blocks.splice(Math.min(n.order,db.blocks.length),0,n)}
    normalizeOrder('blocks');
    let missed=0;
    // Resolve all original positions before inserting any markers in an owner.
    for(const owner of new Set(entry.anchors.map(a=>a.owner))){
        const n=find(owner),anchors=entry.anchors.filter(a=>a.owner===owner),positions=[];
        for(const a of anchors){
            if(!n){missed++;continue}
            const context=a.left+a.right,at=a.at-a.left.length;
            let pos=-1;
            if(n.body.slice(at,at+context.length)===context&&(context||!n.body))pos=a.at;
            else if(context){const i=n.body.indexOf(context);if(i>=0&&n.body.indexOf(context,i+1)<0)pos=i+a.left.length}
            if(pos<0)missed++;else positions.push({pos,token:a.token});
        }
        if(n)for(const a of positions.sort((a,b)=>b.pos-a.pos))n.body=n.body.slice(0,a.pos)+a.token+n.body.slice(a.pos);
    }
    for(const b of entry.bindings||[]){
        const n=find(b.owner);if(!n){missed++;continue}
        if(b.field==='annotation'){if(!n.annotation)n.annotation=clone(b.values[0]);else missed++;continue}
        const current=n[b.field]||[],key=b.field==='objectBindings'?'targetId':'id';
        n[b.field]=[...current,...clone(b.values.filter(v=>!current.some(x=>x[key]===v[key])))];
    }
    db.trash=db.trash.filter(x=>x.id!==entry.id);change(true);showTrash();
    if(missed)showToast('知识块已恢复，'+missed+' 处引用或绑定位置已变化，请重新关联');
}
function showTrash(){
    const d=showDialog('回收站');
    if(!db.trash.length){d.append(el('p','muted','回收站为空'));return}
    for(const entry of db.trash){
        const row=el('div','trashRow'),info=el('div');
        info.append(el('strong','',entry.nodes[0].title),el('div','small',new Date(entry.deletedAt).toLocaleString()+(entry.nodes.length>1?' · '+entry.nodes.length+' 个知识块':'')));
        const restore=btn('恢复',()=>restoreTrash(entry));restore.disabled=!editingEnabled;
        row.append(info,restore);d.append(row);
    }
}
let dialogPlacementVersion=0;
function closeWorkbenchDialog(){
    if(!dialog.open)return;
    const commit=dialog._commitNote;dialog._commitNote=null;
    if(commit)commit();else dialog.close()
}
function showDialog(title,options={}){
    if(dialog.open&&dialog._commitNote)closeWorkbenchDialog();
    dialog._commitNote=null;
    dialog._noteId=null;
    hideFloatingTools();
    const generation=++dialogPlacementVersion;
    dialog._relativeOffset=null;
    dialog._noteSize=null;
    dialog.style.width='';dialog.style.height='';
    dialog.classList.remove('blankNoteDialog');
    const d=$('dialogBody'),h=el('h2','',title);d.replaceChildren(h);
    const floating=!!options.floating;
    if(dialog.open&&dialog.classList.contains('floatingDialog')!==floating)dialog.close();
    dialog.classList.toggle('floatingDialog',floating);
    dialog.style.left='';dialog.style.top='';dialog.style.margin='';
    if(!dialog.open){if(floating)dialog.show();else dialog.showModal()}
    refreshFloatingTools();
    if(floating){
        const anchored=typeof options.anchorRect==='function';
        let dragging=false;
        const initial=options.relativeOffset;
        if(anchored)dialog._relativeOffset={x:Number.isFinite(initial?.x)?initial.x:14,y:Number.isFinite(initial?.y)?initial.y:8};
        const position=(x,y)=>{dialog.style.margin='0';dialog.style.left=Math.max(8,Math.min(x,innerWidth-dialog.offsetWidth-8))+'px';dialog.style.top=Math.max(8,Math.min(y,innerHeight-dialog.offsetHeight-8))+'px'};
        const currentAnchor=()=>{try{const r=options.anchorRect?.();return r&&r.height>0&&Number.isFinite(r.left)?r:null}catch{return null}};
        const place=()=>{if(generation!==dialogPlacementVersion||!dialog.open||!dialog.classList.contains('floatingDialog'))return;if(anchored){const r=currentAnchor();if(r&&!dragging)position(r.left+dialog._relativeOffset.x,r.bottom+dialog._relativeOffset.y)}else if(!dragging)position((options.x??innerWidth/2)+14,(options.y??innerHeight/3)+12)};
        place();requestAnimationFrame(place);
        if(anchored){const follow=()=>{if(generation!==dialogPlacementVersion||!dialog.open)return;place();requestAnimationFrame(follow)};requestAnimationFrame(follow)}
        h.addEventListener('pointerdown',e=>{
            if(e.button!==0)return;e.preventDefault();h.setPointerCapture(e.pointerId);dragging=true;
            const r=dialog.getBoundingClientRect(),x=e.clientX,y=e.clientY;
            const move=ev=>position(r.left+ev.clientX-x,r.top+ev.clientY-y);
            const end=()=>{h.removeEventListener('pointermove',move);h.removeEventListener('pointerup',end);h.removeEventListener('pointercancel',end);const a=currentAnchor(),box=dialog.getBoundingClientRect();if(anchored&&a){dialog._relativeOffset={x:Math.round(box.left-a.left),y:Math.round(box.top-a.bottom)};options.onPositionChange?.({...dialog._relativeOffset})}dragging=false};
            h.addEventListener('pointermove',move);h.addEventListener('pointerup',end);h.addEventListener('pointercancel',end)
        })
    }
    return d
}
function remapCopiedObjects(s,own=null,force=false){
    const map=new Map();
    s=s.replace(objectPattern(),(m,k,id)=>{
        if(force||targets.has(id))map.set(id,k+'-'+uid());
        if(k==='figure'){
            m=normalizeFigureImages(m,id);
            m=m.replace(figureImagePattern(),(full,alt,url,title)=>{
                const child=figureImageId(title,id,0);
                if(force||targets.has(child))map.set(child,'subfig-'+uid());
                return figureImageMarkup(alt,url,title,map.get(child)||child)
            })
        }
        return map.has(id)?m.replace(':::'+k+' '+id,':::'+k+' '+map.get(id)):m
    });
    return s.replace(refPattern(),(m,k,id)=>map.has(id)?'[['+k+':'+map.get(id)+']]':m)
}
function createBlockFrom(body,title,id){newNode('blocks',null,body+'\n\n来源：[[ref:'+id+']]\n',title+' · 知识块')}
function undo(redo){if(!requireEditMode())return;const a=redo?redoStack:undoStack,b=redo?undoStack:redoStack;if(!a.length){showToast('无可'+(redo?'重做':'撤销')+'的操作');return}b.push(editableSnapshot());const s=a.pop();db.thesis=s.thesis;db.blocks=s.blocks;db.trash=s.trash;panes.forEach(p=>{if(!find(p.id))p.id=null});change(true)}
function math(e,tex,display=false){
    try{katex.render(tex,e,{displayMode:display,throwOnError:false,strict:'ignore',trust:false,macros:{'\\textmu':'\\mu'}})}
    catch(err){e.textContent=tex;e.title=err.message}
}
function refSpan(kind,id){
    if(kind==='cite'){const s=el('span','muted','['+id.replaceAll(',',', ')+']');s.title='参考文献键：'+id;return s}
    const t=resolve(id);
    if(!t)return el('span','badref','〔未解析：'+id+'〕');
    const title=t.kind==='node'?(t.number||t.title):t.number||t.title||id;
    const s=el('a','ref',kind==='eqref'?'('+title+')':title);s.href='#';s.dataset.ref=id;s.title=t.title||id;
    s.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();jump(id,e.shiftKey)});
    context(s,()=>refMenu(t),()=>resolve(t.id)||t);return s
}
function markdown(raw,host,trail=[],onImageResize=null){
    if(!raw.trim())return;
    const tokens=[];
    const hold=(kind,value)=>{const i=tokens.push({kind,value})-1;return '<span data-wb-token="'+i+'"></span>'};
    // Protect math and references before Markdown interprets underscores or pipes.
    let s=raw.replace(/(?<!\\)\$\$([\s\S]+?)\$\$|(?<!\\)\$([^\n$]+?)\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\[\[(ref|eqref|embed|cite):([^\]\n]+)\]\]/g,(m,dm,im,bd,bi,k,id)=>dm!=null?hold('display',dm):im!=null?hold('math',im):bd!=null?hold('display',bd):bi!=null?hold('math',bi):hold(k,id));
    const fragment=el('div');fragment.innerHTML=DOMPurify.sanitize(marked.parse(s,{gfm:true,breaks:false}),{ADD_ATTR:['data-wb-token']});
    for(const p of fragment.querySelectorAll('[data-wb-token]')){
        const t=tokens[Number(p.dataset.wbToken)];if(!t){p.remove();continue}
        if(t.kind==='math'||t.kind==='display'){const a=el(t.kind==='math'?'span':'div',t.kind==='display'?'mathscroll':'');math(a,t.value,t.kind==='display');p.replaceWith(a)}
        else if(t.kind==='embed'){
            const n=find(t.value);const d=el('details','embed');d.append(el('summary','',n?'知识块：'+n.title:'失效嵌入：'+t.value));
            if(n&&!trail.includes(n.id)){d.addEventListener('toggle',()=>{if(d.open&&!d.dataset.loaded){d.dataset.loaded='1';const b=el('div','content');renderBody(n,b,[...trail,n.id]);d.append(b,btn('打开知识块',()=>select(n.id)))}})}
            else d.append(el('div','muted','循环引用或对象不存在'));
            p.replaceWith(d)
        }else p.replaceWith(refSpan(t.kind,t.value))
    }
    for(const t of fragment.querySelectorAll('table')){const wrap=el('div','tablescroll');t.replaceWith(wrap);wrap.append(t)}
    let imageIndex=-1;
    for(const img of fragment.querySelectorAll('img')){
        if(!img.getAttribute('src')?.startsWith('/assets/')){img.replaceWith(el('span','badref','图片来源不在本地资源目录'));continue}
        const index=++imageIndex,src=img.getAttribute('src'),key='wb-image-width:'+src,stored=img.title.match(/(?:^|\s)wb-width:(\d+(?:\.\d+)?)(?:\s|$)/);
        const wrap=el('div','imgwrap resizeImage');let w=Math.max(10,Math.min(100,Number(stored?.[1]||(onImageResize?100:localStorage.getItem(key))||100)));wrap.style.width=w+'%';img.removeAttribute('title');
        function activate(){document.querySelectorAll('.resizeImage.selectedImage').forEach(x=>{if(x!==wrap)x.classList.remove('selectedImage')});wrap.classList.add('selectedImage');wrap.closest('.visualCard')?._selectImage?.(wrap);wrap.closest('.visualDocument')?.focus({preventScroll:true})}
        function full(){const d=showDialog(img.alt||'图片');const f=el('img','imagefull');f.src=src;d.append(f,btn('打开原图',()=>window.open(src,'_blank','noopener')))}
        function commit(){if(onImageResize)onImageResize(src,w,index);else localStorage.setItem(key,String(w))}
        img.loading='lazy';img.draggable=false;img.addEventListener('click',e=>{e.stopPropagation();activate()});img.addEventListener('dblclick',e=>{e.stopPropagation();full()});
        img.replaceWith(wrap);wrap.append(img);context(wrap,()=>[['查看原图',full],['恢复原始显示大小',()=>{w=100;wrap.style.width='100%';commit()}],...(wrap.closest('.visualCard')?._menu?.()||[])]);
        for(const corner of ['nw','ne','sw','se']){
            const h=el('span','resizeHandle '+corner);h.setAttribute('role','button');h.setAttribute('aria-label','拖动图片'+corner+'角缩放');wrap.append(h);
            h.addEventListener('pointerdown',e=>{if(!editingEnabled)return;e.preventDefault();e.stopPropagation();activate();h.setPointerCapture(e.pointerId);const startX=e.clientX,startY=e.clientY,startW=wrap.getBoundingClientRect().width,startH=wrap.getBoundingClientRect().height,available=wrap.parentElement.clientWidth||startW,signX=corner.endsWith('e')?1:-1,signY=corner.startsWith('s')?1:-1;let moved=false;
                const move=ev=>{const dx=(ev.clientX-startX)*signX,dy=(ev.clientY-startY)*signY*(startW/Math.max(1,startH));const delta=Math.abs(dx)>=Math.abs(dy)?dx:dy;if(Math.abs(delta)>2)moved=true;w=Math.round(Math.max(10,Math.min(100,(startW+delta)/available*100))*10)/10;wrap.style.width=w+'%'};
                const end=()=>{h.removeEventListener('pointermove',move);h.removeEventListener('pointerup',end);h.removeEventListener('pointercancel',end);if(moved)commit()};h.addEventListener('pointermove',move);h.addEventListener('pointerup',end);h.addEventListener('pointercancel',end)
            })
        }
    }
    host.append(...fragment.childNodes);
}
function renderBody(n,host,trail=[n.id]){
    let pos=0;
    for(const m of n.body.matchAll(objectPattern())){
        markdown(n.body.slice(pos,m.index),host,trail);pos=m.index+m[0].length;
        const [raw,kind,id,flags,body]=m,t=resolve(id)||{id,kind,owner:n.id,title:id,number:''};
        const box=el('section','object');box.dataset.object=id;
        const h=el('div','objecthead');h.append(el('span','objnum',(kind==='equation'?'公式':kind==='figure'?'图':'表')+(t.number?' '+t.number:'')),el('div','spacer'),btn('⋯',e=>menuAt(e,[...refMenu(t),['复制对象源码',()=>copy(raw)]])));
        box.append(h);context(box,()=>[...refMenu(t),['复制对象源码',()=>copy(raw)]],()=>resolve(t.id)||t);
        if(kind==='equation'){const b=el('div','mathscroll');math(b,body.trim(),true);box.append(b)}
        else {const lines=body.split('\n');const cap=lines.shift();const b=el('div');markdown(lines.join('\n'),b,trail);const c=el('div','caption');markdown(cap,c,trail);if(kind==='table')box.append(c,b);else box.append(b,c)}
        host.append(box)
    }
    markdown(n.body.slice(pos),host,trail);
}
function refsOf(n){return [...new Set([...n.body.matchAll(refPattern())].filter(m=>m[1]!=='cite').map(m=>m[2]).concat(objectNoteBindings(n).map(x=>x.targetId)))]}
function related(id,object=null){
    const n=find(id);if(!n)return[];
    const ids=new Set([id,...objectList(n).map(o=>o.id)]), rel=new Map();
    const put=(other,kind)=>{if(other&&other!==id&&find(other)){if(!rel.has(other))rel.set(other,new Set());rel.get(other).add(kind)}};
    for(const r of refsOf(n))put(resolve(r)?.owner,'引用');
    for(const x of all())if(x.id!==id&&refsOf(x).some(r=>ids.has(r)||resolve(r)?.owner===id))put(x.id,'被引用');
    // Free placements and text annotations also link a knowledge block to its page.
    for(const x of db.blocks){
        const owners=[x.annotation?.owner,...freeNotePlacements(x).map(p=>p.pageId)];
        if(x.id===id)for(const owner of owners)put(owner,'批注位置');
        else if(owners.includes(id))put(x.id,'批注');
    }
    if(n.parent)put(n.parent,'上级');for(const c of children(spaceOf(id),id))put(c.id,'下级');
    return [...rel].map(([id,kinds])=>({id,kinds:[...kinds].join(' / ')}))
}
function svgEl(tag,attrs={}){const e=document.createElementNS('http://www.w3.org/2000/svg',tag);Object.entries(attrs).forEach(([k,v])=>e.setAttribute(k,String(v)));return e}
function highlightNetworkTarget(target){
    if(!target)return;target.classList.add('networkJumpHighlight');
    target.scrollIntoView({block:'center',behavior:'instant'});
    setTimeout(()=>target.classList.remove('networkJumpHighlight'),3000)
}
function networkJump(center,id){
    if(dialog.open)closeWorkbenchDialog();
    const note=find(center),dest=find(id);if(!dest)return;
    if(spaceOf(id)==='blocks'){
        select(id);highlightNetworkTarget([...paneBox.children[active].querySelectorAll('.visualDocument')].find(d=>d._owner===id));return
    }
    select(id);
    if(!note||spaceOf(center)!=='blocks')return;
    const pane=paneBox.children[active];
    const belongs=el=>el.closest('.visualDocument')?._owner===id;
    const inline=[...pane.querySelectorAll('.inlineAnnotation')].find(el=>el.dataset.token==='[[embed:'+center+']]'&&belongs(el));
    const embedded=[...pane.querySelectorAll('.visualCard')].find(el=>el._part?.kind==='embed'&&el._part.ref===center&&belongs(el));
    const object=[...pane.querySelectorAll('.objectNoteMarker')].find(el=>el.dataset.noteId===center&&resolve(el.dataset.targetId)?.owner===id);
    const free=[...pane.querySelectorAll('.freeNoteMarker')].find(el=>el.dataset.noteId===center);
    let marker=inline||embedded||object||free;
    if(!marker){
        const reference=refsOf(note).map(resolve).find(t=>t?.owner===id&&t.kind!=='node');
        marker=reference&&[...pane.querySelectorAll('[data-object]')].find(el=>el.dataset.object===(reference.actualId||reference.id));
        marker=marker||[...pane.querySelectorAll('.editableHeading')].find(el=>el.dataset.bindObject===id);
    }
    if(!marker)return;
    const card=marker.closest('.visualCard');if(card?.classList.contains('folded'))card._setFolded?.(false);
    highlightNetworkTarget(marker);
    const r=marker.getBoundingClientRect(),e={clientX:r.left,clientY:r.bottom};
    const binding=marker===object?objectNoteBindings(note).find(b=>b.targetId===object.dataset.targetId):null;
    const placement=marker===free?freeNotePlacements(note).find(p=>p.id===free.dataset.placementId):null;
    openAnnotationNote(note,marker,e,binding,placement)
}
function network(center,rels,host){
    const graph=el('div','graph');const svg=svgEl('svg',{viewBox:'0 0 700 420',role:'img','aria-label':'知识关联图'});
    const nodes=rels.slice(0,18).map((r,i)=>{const a=2*Math.PI*i/Math.max(1,Math.min(18,rels.length))-.5*Math.PI;return{...r,x:350+270*Math.cos(a),y:210+160*Math.sin(a)}});
    for(const n of nodes){const l=svgEl('line',{x1:350,y1:210,x2:n.x,y2:n.y,stroke:'#b5c4cf','stroke-width':1.4});svg.append(l)}
    function add(id,x,y,main=false){
        const n=find(id);if(!n)return;const g=svgEl('g',{tabindex:0,role:'button','aria-label':n.title,'data-network-id':id});
        g.append(svgEl('rect',{x:x-66,y:y-22,width:132,height:44,rx:7,fill:main?'#dce9f3':'#f3f6f8',stroke:main?'#5f8fb4':'#c9d3db'}));
        const t=svgEl('text',{x,y:y+4,'text-anchor':'middle',fill:'#263038'});t.textContent=(n.title.length>12?n.title.slice(0,11)+'…':n.title);g.append(t);
        const title=svgEl('title');title.textContent=n.title;g.append(title);g.addEventListener('click',()=>networkJump(center,id));g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();networkJump(center,id)}});svg.append(g)
    }
    for(const n of nodes)add(n.id,n.x,n.y);add(center,350,210,true);graph.append(svg);host.append(graph)
}
function relationDialog(id,object=null){
    const n=find(id);if(!n)return;const d=showDialog('关联网络 · '+n.title);
    const rels=related(id,object);network(id,rels,d);
    if(!rels.length)d.append(el('p','muted','尚无引用关系'));
    const list=el('div','relationlist');for(const r of rels)list.append(btn(r.kinds+' · '+find(r.id).title,()=>networkJump(id,r.id)));d.append(list)
}
function renderBlockNetwork(host){
    const id=host.dataset.blockNetwork,n=find(id);if(!n)return;
    const rels=related(id),key=JSON.stringify([n.title,...rels.map(r=>[r.id,r.kinds,find(r.id)?.title])]);
    if(host.dataset.networkKey===key)return;host.dataset.networkKey=key;
    host.replaceChildren(el('h2','', '关联网'));
    if(!rels.length){host.append(el('p','muted','尚无关联'));return}
    network(id,rels,host);
    const list=el('div','relationlist');for(const r of rels)list.append(btn(r.kinds+' · '+find(r.id).title,()=>networkJump(id,r.id)));host.append(list)
}
function refreshBlockNetworks(){for(const host of paneBox.querySelectorAll('[data-block-network]'))renderBlockNetwork(host)}
function blockOverview(page){
    const actions=el('div','blockOverviewActions');
    actions.append(btn('＋ 新建知识块',()=>newNode('blocks'),'createBlockButton'),btn('回收站'+(db.trash.length?' ('+db.trash.length+')':''),showTrash,'trashButton'));
    page.append(el('h1','title','块网'),el('p','muted','独立存放研究思路、草稿、推导与备注。与博论树通过引用关联，不进入正式正文。'),actions);
    if(!db.blocks.length){page.append(el('div','empty','块网目前为空。你可以复制博论正文，再粘贴到新建知识块。'));return}
    // Global network shows block-to-block links; select a block for its complete graph.
    const box=el('div','graph');const svg=svgEl('svg',{viewBox:'0 0 800 420',role:'img','aria-label':'知识块网络'});
    const list=db.blocks.slice(0,48),positions=new Map(list.map((n,i)=>[n.id,{x:80+(i%6)*128,y:55+Math.floor(i/6)*Math.min(55,310/Math.max(1,Math.ceil(list.length/6)-1))}]));
    for(const n of list){for(const r of refsOf(n)){const a=positions.get(n.id),b=positions.get(resolve(r)?.owner);if(a&&b)svg.append(svgEl('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,stroke:'#a8b8c5'}))}}
    for(const n of list){const p=positions.get(n.id),g=svgEl('g',{tabindex:0,role:'button','aria-label':n.title});g.append(svgEl('rect',{x:p.x-58,y:p.y-17,width:116,height:34,rx:6,fill:'#eef3f7',stroke:'#b7c8d5'}));const t=svgEl('text',{x:p.x,y:p.y+4,'text-anchor':'middle',fill:'#263038'});t.textContent=n.title.slice(0,10);g.append(t);g.addEventListener('click',()=>networkJump(n.id,n.id));g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();networkJump(n.id,n.id)}});context(g,()=>nodeMenu(n),()=>resolve(n.id));svg.append(g)}box.append(svg);page.append(box);
    const cards=el('div','cards');for(const n of db.blocks){const c=el('article','blockcard');c.append(el('h3','',n.title),el('div','small',n.body.replace(/:::[^\n]*/g,'').slice(0,100)||'空白块'),el('div','small',related(n.id).length+' 个关联'));c.addEventListener('click',()=>select(n.id));context(c,()=>nodeMenu(n),()=>resolve(n.id));cards.append(c)}page.append(cards)
}
function renderChild(n,host,pi){
    const d=el('details','child');d.dataset.sectionId=n.id;const s=el('summary',''),collapsedTitle=el('span','childCollapsedTitle',label(n));s.append(collapsedTitle);d.append(s);
    function populate(){if(d.open&&!d.dataset.loaded){d.dataset.loaded='1';const b=el('div','childbody');editor(n,b,pi,s);for(const x of children(spaceOf(n.id),n.id))renderChild(x,b,pi);d.append(b)}}
    const foldKey='section:'+n.id,initialPageKey=pageFoldKey(pi);
    d._populate=populate;
    d.open=!pageFoldState(pi).has(foldKey);populate();
    d.addEventListener('toggle',()=>{if(!d.isConnected||pageFoldKey(pi)!==initialPageKey)return;populate();setPageFold(pi,foldKey,!d.open);captureReading()});
    context(s,()=>nodeMenu(n),()=>resolve(n.id),true);host.append(d)
}
function renderPanes(){
    if(!db)return;
    for(const old of paneBox.children)capturePane(old);
    paneBox.replaceChildren();
    panes.forEach((p,pi)=>{
        const pane=el('section','pane'+(pi===active?' activepane':''));pane._readingPane=p;pane._readingId=p.id;pane.addEventListener('scroll',()=>{capturePane(pane);rememberPosition()},{passive:true});pane.addEventListener('pointerdown',()=>{if(active!==pi){active=pi;for(let i=0;i<paneBox.children.length;i++)paneBox.children[i].classList.toggle('activepane',i===pi);renderNav()}});
        const toolbar=el('div','toolbar');const page=el('article','page');
        if(panes.length>1)toolbar.append(btn('切换 '+(pi===0?'右页':'左页'),()=>{active=pi===0?1:0;renderNav();renderPanes()},'mobileOnly'));
        const n=find(p.id);
        if(n){
            const foldButton=btn('本页全部折叠',()=>togglePageFolds(pi),'foldAllButton pageFoldButton');foldButton.title='仅展开或折叠当前正文页';toolbar.append(foldButton);
            const path=ancestors(n).map(id=>find(id)).filter(Boolean);const bc=el('div','breadcrumb');bc.append(el('span','',spaceOf(n.id)==='thesis'?'博论树':'块网'));for(const a of path){bc.append(document.createTextNode(' / '));const link=el('a','ref',label(a));link.href='#';link.addEventListener('click',e=>{e.preventDefault();select(a.id,pi)});bc.append(link)}page.append(bc);
            editor(n,page,pi);const kids=children(spaceOf(n.id),n.id);if(kids.length){for(const c of kids)renderChild(c,page,pi)}
            if(spaceOf(n.id)==='blocks'){const host=el('section','blockNetwork');host.dataset.blockNetwork=n.id;page.append(host);renderBlockNetwork(host)}
        }else if(view==='blocks')blockOverview(page);else page.append(el('div','empty','从左侧目录选择章节'));
        context(pane,e=>{
            const docs=[...page.querySelectorAll('.visualDocument')].filter(d=>d.getClientRects().length);
            const distance=d=>{const r=d.getBoundingClientRect();return Math.max(r.top-e.clientY,0,e.clientY-r.bottom)};
            const doc=e.target.closest('.visualDocument')||docs.sort((a,b)=>distance(a)-distance(b))[0];
            if(doc?._blankMenu)return doc._blankMenu(e);
            return [[view==='blocks'?'新建知识块':'新建章节',()=>newNode(view)],['撤销',()=>undo(false)],['重做',()=>undo(true)]]
        });
        if(toolbar.childNodes.length)pane.append(toolbar);pane.append(page);paneBox.append(pane);updatePageFoldButton(pi);restorePane(pane,p)
    });
    refreshFreeNotes();
    $('dual').textContent=panes.length===2?'单页':'双页';
    rememberPosition();
    scheduleToolbarUpdate();
}
$('treeTab').onclick=()=>setView('thesis');$('blockTab').onclick=()=>setView('blocks');
$('drawer').onclick=()=>{$('sidebar').classList.toggle('open');$('overlay').classList.toggle('show')};$('overlay').onclick=mobileClose;
$('search').oninput=e=>{search=e.target.value;renderNav()};$('newNode').onclick=()=>newNode(view);
$('dual').onclick=()=>{if(panes.length===1){panes.push({id:panes[0].id,edit:false,thesisReading:thesisPosition(panes[0].thesisReading)});active=1}else{panes=[panes[active]];active=0}renderPanes();renderNav()};
$('refresh').onclick=()=>{if(dialog._commitNote)closeWorkbenchDialog();if(conflict){showSyncConflict();return}if(workspaceChanged||!db){load();return}syncNow(true)};$('closeDialog').onclick=()=>closeWorkbenchDialog();
$('shortcutSettings').onclick=shortcutSettings;
async function openWorkspaceDialog(){
    if(dialog._commitNote)closeWorkbenchDialog();
    const d=showDialog('打开文件');
    d.append(el('p','small','输入服务器上的 .json 文件绝对路径，支持本地磁盘和 UNC 网络共享路径。直接编辑原文件。'));
    const form=el('form','workspacePathForm'),input=el('input','workspacePath');input.type='text';input.required=true;input.autocomplete='off';input.autocapitalize='off';input.spellcheck=false;input.placeholder='C:\\项目\\文件.json 或 \\\\服务器\\共享\\文件.json';input.setAttribute('aria-label','服务器文件路径');
    const submit=el('button','','打开');submit.type='submit';form.append(input,submit);d.append(form);
    const message=el('p','small');d.append(message,el('h3','','最近打开'));
    const list=el('div','visualPickList');d.append(list);
    async function openPath(path){
        if(!path.trim()||submit.disabled)return;
        input.disabled=submit.disabled=true;for(const button of list.querySelectorAll('button'))button.disabled=true;message.textContent='正在打开…';
        try{
            clearTimeout(timer);
            while(saving||syncBusy)await new Promise(r=>setTimeout(r,50));
            if(dirty)await save();
            if(dirty||conflict)throw new Error('当前工作区有未保存的内容，不能切换。');
            captureReading();await flushReading();
            await api('/api/workspaces/open',{path:path.trim()});
            readingReady=false;readingInteracted=false;dialog.close();await load(true);
        }catch(e){message.textContent=e.message;input.disabled=submit.disabled=false;for(const button of list.querySelectorAll('button'))button.disabled=false}
    }
    form.addEventListener('submit',e=>{e.preventDefault();openPath(input.value)});
    try{
        const catalog=await api('/api/workspaces');
        if(catalog.error)message.textContent=catalog.error;
        if(!catalog.files.length)list.append(el('p','small','暂无打开记录。'));
        for(const f of catalog.files){
            const b=btn('',()=>openPath(f.path),'workspaceRecent');b.append(el('strong','',f.name+(f.active?'（当前）':'')),el('span','small',f.path));list.append(b)
        }
    }catch(e){message.textContent=e.message}
}
$('openWorkspace').onclick=openWorkspaceDialog;
context(dialog,()=>[]);
dialog.addEventListener('close',()=>{if(!dialog.open){hideFloatingTools();$('menu').hidden=true;dialog._noteId=null}});
$('headerActions').onclick=toggleFloatingTools;
initFloatingTools();
dialog.addEventListener('cancel',e=>{if(dialog._commitNote){e.preventDefault();closeWorkbenchDialog()}});
document.addEventListener('pointerdown',e=>{
    if(!dialog.open||isActionSurface(e.target))return;
    const r=dialog.getBoundingClientRect();
    if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeWorkbenchDialog()
},true);
document.addEventListener('click',e=>{if(isActionSurface(e.target))return;$('menu').hidden=true;if(!e.target.closest('.resizeImage'))document.querySelectorAll('.selectedImage').forEach(x=>x.classList.remove('selectedImage'))});
const SHORTCUT_KEY='wb:tool-shortcuts:v2';
const combo=(key,alt=false,shift=false)=>({ctrl:true,alt,shift,key});
const defaultShortcuts={
    [MODE_TOOL]:combo('e',true),
    '剪切':combo('x'),'复制':combo('c'),'粘贴':combo('v'),
    '新建批注/知识块':combo('f'),'插入批注/知识块':combo('i',true),
    '复制交叉引用':combo('r',true),'撤销':combo('z'),'重做':combo('y'),
    '显示/隐藏工具栏':combo('t',true)
};
function shortcutLabel(s){return s?[s.ctrl?'Ctrl':'',s.alt?'Alt':'',s.shift?'Shift':'',s.key.toUpperCase()].filter(Boolean).join('+'):'未设置'}
function validShortcut(s){return s===null||!!(s&&/^[a-z0-9]$/.test(s.key)&&(s.ctrl||s.alt))}
let toolShortcuts=(()=>{
    const result=clone(defaultShortcuts);
    try{
        const saved=JSON.parse(localStorage.getItem(SHORTCUT_KEY));
        if(saved){for(const label of Object.keys(result))if(Object.hasOwn(saved,label)&&validShortcut(saved[label]))result[label]=saved[label]}
        else{
            const old=JSON.parse(localStorage.getItem('wb:new-note-shortcut:v1'));
            if(old&&validShortcut(old)&&!Object.entries(result).some(([label,s])=>label!=='新建批注/知识块'&&shortcutLabel(s)===shortcutLabel(old)))result['新建批注/知识块']=old
        }
    }catch{}
    return result
})();
function updateShortcutHints(){
    for(const b of $('floatingTools').querySelectorAll('[data-tool]')){
        const label=b.dataset.tool,s=toolShortcuts[label];b.dataset.shortcutHint=s?' ('+shortcutLabel(s)+')':'';
        if(s)b.setAttribute('aria-keyshortcuts',shortcutLabel(s).replace('Ctrl','Control'));else b.removeAttribute('aria-keyshortcuts')
    }
    const toggle=$('headerActions'),s=toolShortcuts['显示/隐藏工具栏'];
    toolbarShortcutText=s?' ('+shortcutLabel(s)+')':'';
    toggle.dataset.shortcutHint=toolbarShortcutText
}
function shortcutSettings(){
    const d=showDialog('快捷键设置');let values=clone(toolShortcuts);
    const desc=el('p','small','点击组合键输入框后按键，或使用下拉框选择；清除可禁用该工具的自定义快捷键。浏览器原生剪贴快捷键仍可使用。');
    const list=el('div','shortcutList'),msg=el('p','small','Ctrl+F 默认替代浏览器查找。系统保留的快捷键可能无法使用。');
    const modifiers=[['c','Ctrl'],['a','Alt'],['ca','Ctrl+Alt'],['cs','Ctrl+Shift'],['as','Alt+Shift'],['cas','Ctrl+Alt+Shift']];
    const modValue=v=>v?[v.ctrl?'c':'',v.alt?'a':'',v.shift?'s':''].join(''):'c';
    function set(label,value){
        if(value?.ctrl&&!value.alt&&!value.shift&&['s','r','w','t','l','n'].includes(value.key)){msg.textContent='请避开保存、刷新和浏览器窗口快捷键。';return false}
        if(value&&Object.entries(values).some(([k,v])=>k!==label&&v&&shortcutLabel(v)===shortcutLabel(value))){msg.textContent=shortcutLabel(value)+' 已分配给其他工具，请先修改或清除。';return false}
        values[label]=value;msg.textContent='';return true
    }
    function draw(){
        list.replaceChildren();
        for(const label of Object.keys(values)){
            const row=el('div','shortcutRow'),name=el('span','',label),controls=el('div','shortcutControls');
            const input=el('input');input.readOnly=true;input.dataset.shortcutCapture='1';input.setAttribute('aria-label',label==='新建批注/知识块'?'新建批注快捷键':label+'快捷键');
            const mod=el('select'),key=el('select');
            mod.setAttribute('aria-label',label+'修饰键');key.setAttribute('aria-label',label+'按键');
            for(const [v,t] of modifiers)mod.append(new Option(t,v));
            for(const k of 'abcdefghijklmnopqrstuvwxyz0123456789')key.append(new Option(k.toUpperCase(),k));
            function sync(){const v=values[label];input.value=shortcutLabel(v);mod.value=modValue(v);key.value=v?.key||'a'}
            function applySelect(){set(label,{ctrl:mod.value.includes('c'),alt:mod.value.includes('a'),shift:mod.value.includes('s'),key:key.value});sync()}
            mod.onchange=applySelect;key.onchange=applySelect;
            input.addEventListener('keydown',e=>{
                if(e.key==='Tab'||e.key==='Escape')return;
                e.preventDefault();e.stopPropagation();
                if(e.key==='Backspace'||e.key==='Delete'){set(label,null);sync();return}
                const v={ctrl:e.ctrlKey||e.metaKey,alt:e.altKey,shift:e.shiftKey,key:e.key.toLowerCase()};
                if(validShortcut(v)){set(label,v);sync()}
            });
            sync();controls.append(input,mod,key,btn('清除',()=>{set(label,null);sync()}));row.append(name,controls);list.append(row)
        }
    }
    draw();
    const row=el('div','edittools');row.append(btn('恢复默认',()=>{values=clone(defaultShortcuts);draw();msg.textContent='已恢复默认，保存后生效。'}),btn('保存',()=>{toolShortcuts=clone(values);try{localStorage.setItem(SHORTCUT_KEY,JSON.stringify(values))}catch{}dialog.close();updateShortcutHints();showToast('快捷键已保存')}));
    d.append(desc,list,msg,row)
}
updateShortcutHints();
document.addEventListener('keydown',e=>{
    if(e.defaultPrevented||e.isComposing||e.keyCode===229||!db||e.target.closest?.('.shortcutList'))return;
    const key=e.key.toLowerCase(),matches=s=>s&&s.ctrl===(e.ctrlKey||e.metaKey)&&s.alt===e.altKey&&s.shift===e.shiftKey&&s.key===key;
    let label=Object.keys(toolShortcuts).find(k=>matches(toolShortcuts[k]));
    if(!label&&shortcutLabel(toolShortcuts['重做'])==='Ctrl+Y'&&(e.ctrlKey||e.metaKey)&&e.shiftKey&&!e.altKey&&key==='z')label='重做';
    if(!label)return;
    if(label===MODE_TOOL){
        if(dialog.open&&!dialog.querySelector('.visualDocument'))return;
        e.preventDefault();e.stopImmediatePropagation();if(!e.repeat)toggleEditMode();return
    }
    const control=e.target.closest?.('input,textarea,select,math-field'),rich=e.target.closest?.('.richText,.visualDocument');
    if(['剪切','复制','粘贴'].includes(label)&&matches(defaultShortcuts[label])&&(control||rich))return;
    if(dialog.open&&!dialog.querySelector('.visualDocument')&&label!=='显示/隐藏工具栏')return;
    if(['撤销','重做'].includes(label)&&control&&!rich)return;
    // Keep the MathLive native undo for its own formula edits.
    if(['撤销','重做'].includes(label)&&e.target.closest?.('math-field')&&matches(defaultShortcuts[label]))return;
    e.preventDefault();e.stopImmediatePropagation();if(e.repeat)return;
    if(label==='显示/隐藏工具栏')toggleFloatingTools();
    else if(label==='撤销'||label==='重做')toolbarUndo(label==='重做');
    else toolbarAction(label);
},true);
document.addEventListener('keydown',e=>{
    if(editingEnabled&&dialog.open&&dialog.classList.contains('blankNoteDialog')&&e.key==='Enter'&&!e.shiftKey&&!e.altKey&&!e.ctrlKey&&!e.metaKey&&!e.isComposing&&e.keyCode!==229&&!e.composedPath().some(x=>x.tagName==='MATH-FIELD')){
        if(!e.target.closest('button')&&dialog.contains(e.target)){e.preventDefault();closeWorkbenchDialog();return}
    }
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();if(conflict)showSyncConflict();else if(syncNeeded&&!dialog.open)syncNow(true);else save()}
});

// Native fullscreen must be requested directly from a trusted click/tap.
const fullscreenButton=document.createElement('button');
fullscreenButton.id='fullscreenToggle';
fullscreenButton.type='button';
$('shortcutSettings').after(fullscreenButton);
const revealHeaderButton=btn('⌄',()=>setFullscreenHeader(false));
revealHeaderButton.id='revealFullscreenHeader';
revealHeaderButton.type='button';
revealHeaderButton.setAttribute('aria-label','显示顶部栏');
revealHeaderButton.title='显示顶部栏';
revealHeaderButton.hidden=true;
document.body.append(revealHeaderButton);
let fullscreenBusy=false;
const fullscreenElement=()=>document.fullscreenElement||document.webkitFullscreenElement;
const immersiveMode=()=>document.body.classList.contains('immersiveMode');
const fullscreenActive=()=>!!fullscreenElement()||immersiveMode();
const headerHidden=()=>document.body.classList.contains('fullscreenHeaderHidden');
function setFullscreenHeader(hide){
    hide=!!hide&&fullscreenActive();
    if(headerHidden()===hide)return;
    document.body.classList.toggle('fullscreenHeaderHidden',hide);
    revealHeaderButton.hidden=!hide;
    requestAnimationFrame(positionFloatingTools);
}
function fullscreenGestureAllowed(target){
    return fullscreenActive()&&!dialog.open&&$('menu').hidden&&!$('sidebar').classList.contains('open')&&
        target?.closest?.('.pane.activepane')&&!target.closest('button,input,textarea,select,math-field,.resizeHandle,.noteResizeHandle,.visualHandle,.tablescroll,.mathscroll')&&
        (getSelection()?.isCollapsed!==false);
}
// Measure deliberate touch motion, not changes in scrollTop caused by layout,
// restoring a reading position, a short page, or the on-screen keyboard.
let headerTouch=null,headerTouchScroll=null;
paneBox.addEventListener('touchstart',e=>{
    headerTouch=null;headerTouchScroll=null;
    if(e.touches.length!==1||!fullscreenGestureAllowed(e.target))return;
    const t=e.touches[0];
    headerTouch={x:t.clientX,y:t.clientY,id:t.identifier,target:e.target};
    const pane=e.target.closest('.pane');
    headerTouchScroll={pane,top:pane.scrollTop,until:performance.now()+800,done:false};
},{passive:true});
paneBox.addEventListener('touchmove',e=>{
    if(headerTouchScroll)headerTouchScroll.until=performance.now()+800;
    if(!headerTouch||e.touches.length!==1||!fullscreenGestureAllowed(headerTouch.target)){headerTouch=null;return}
    const t=e.touches[0];if(t.identifier!==headerTouch.id)return;
    const dx=t.clientX-headerTouch.x,dy=t.clientY-headerTouch.y;
    if(Math.abs(dx)>28&&Math.abs(dx)>Math.abs(dy)){headerTouch=null;return}
    if(Math.abs(dy)>=36&&Math.abs(dy)>Math.abs(dx)*1.4){
        if(headerTouchScroll)headerTouchScroll.done=true;
        setFullscreenHeader(dy<0);headerTouch=null;
    }
},{passive:true});
for(const event of ['touchend','touchcancel'])paneBox.addEventListener(event,()=>{headerTouch=null},{passive:true});
// Some mobile engines coalesce touchmove while scrolling on the compositor.
// A real change in the touched pane is an independent direction signal.
paneBox.addEventListener('scroll',e=>{
    const g=headerTouchScroll;
    if(!g||g.done||g.pane!==e.target||performance.now()>g.until||!fullscreenGestureAllowed(g.pane))return;
    const dy=g.pane.scrollTop-g.top;
    if(Math.abs(dy)>=30){g.done=true;setFullscreenHeader(dy>0)}
},{capture:true,passive:true});
let headerWheel=0,headerWheelAt=0;
paneBox.addEventListener('wheel',e=>{
    if(e.ctrlKey||Math.abs(e.deltaX)>Math.abs(e.deltaY)||!fullscreenGestureAllowed(e.target))return;
    const delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?innerHeight:1),now=performance.now();
    if(now-headerWheelAt>220||Math.sign(delta)!==Math.sign(headerWheel))headerWheel=0;
    headerWheelAt=now;headerWheel+=delta;
    if(Math.abs(headerWheel)>=36){setFullscreenHeader(headerWheel>0);headerWheel=0}
},{passive:true});
function syncFullscreen(){
    if(fullscreenElement())document.body.classList.remove('immersiveMode');
    const on=fullscreenActive();
    document.body.classList.toggle('fullscreenActive',on);
    if(!on)setFullscreenHeader(false);
    const label=on?'退出全屏':'全屏';
    fullscreenButton.setAttribute('aria-label',label);
    fullscreenButton.setAttribute('aria-pressed',String(on));
    fullscreenButton.title=label;
    fullscreenButton.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+(on?'M3 9h6V3 M21 9h-6V3 M3 15h6v6 M21 15h-6v6':'M9 3H3v6 M15 3h6v6 M9 21H3v-6 M15 21h6v-6')+'"/></svg>';
    requestAnimationFrame(positionFloatingTools);
}
function enterImmersive(){
    document.body.classList.add('immersiveMode');
    syncFullscreen();
    showToast('已进入沉浸模式，上滑隐藏顶部栏，下滑恢复');
}
fullscreenButton.addEventListener('click',async()=>{
    if(fullscreenBusy)return;
    fullscreenBusy=true;
    try{
        if(immersiveMode()){document.body.classList.remove('immersiveMode');return}
        if(fullscreenElement()){
            const exit=document.exitFullscreen||document.webkitExitFullscreen;
            if(exit)await exit.call(document);
            return
        }
        const root=document.documentElement;
        const request=root.requestFullscreen||root.webkitRequestFullscreen;
        if(!request){enterImmersive();return}
        try{
            const result=request.call(root);
            if(result?.then)await result;
            else await new Promise(resolve=>setTimeout(resolve,500));
            if(!fullscreenElement())enterImmersive();
        }catch{enterImmersive()}
    }catch{showToast('无法退出原生全屏，请使用浏览器退出操作')}
    finally{fullscreenBusy=false;syncFullscreen()}
});
for(const event of ['fullscreenchange','webkitfullscreenchange'])document.addEventListener(event,syncFullscreen);
document.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&immersiveMode()&&!dialog.open&&$('menu').hidden){
        document.body.classList.remove('immersiveMode');syncFullscreen();
    }
});
syncFullscreen();

// Installation is optional; keep the live paper workspace on the server.
const standaloneQuery=matchMedia('(display-mode: standalone)');
const installedMode=()=>standaloneQuery.matches||navigator.standalone===true;
const installButton=btn('安装',installPaperEditer);
installButton.id='installApp';
installButton.title='安装 PaperEditer 应用';
installButton.setAttribute('aria-label','安装 PaperEditer 应用');
fullscreenButton.after(installButton);
let installPrompt=null,appInstalled=false;
function syncInstallButton(){
    installButton.hidden=installedMode()||appInstalled;
    document.body.classList.toggle('installedApp',installedMode());
}
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;syncInstallButton()});
window.addEventListener('appinstalled',()=>{installPrompt=null;appInstalled=true;syncInstallButton()});
standaloneQuery.addEventListener?.('change',syncInstallButton);
function installInstructions(){
    const d=showDialog('安装 PaperEditer');
    d.append(el('p','','在支持安装网页应用的浏览器中，将 PaperEditer 添加到主屏幕后即可独立启动。'));
    if(!window.isSecureContext)d.append(el('p','small','当前访问地址不是安全环境，网页应用安装通常需要 HTTPS。请使用受信任的 HTTPS 访问地址。'));
    d.append(el('p','','Android：打开浏览器菜单，查找“安装应用”或“添加到主屏幕”。如果 Edge 仅创建普通快捷方式，可尝试 Chrome。'));
    d.append(el('p','','iPhone / iPad：通过 Safari 的分享菜单选择“添加到主屏幕”，如有“作为网页 App 打开”选项，请启用。'));
    d.append(el('p','small','安装不复制论文文件；应用仍需要连接原服务器，不提供离线编辑。'));
}
async function installPaperEditer(){
    if(!installPrompt){installInstructions();return}
    const prompt=installPrompt;installPrompt=null;
    try{await prompt.prompt();await prompt.userChoice}catch{installInstructions()}
}
syncInstallButton();

window.addEventListener('pagehide',()=>{captureReading();flushReading()});
document.addEventListener('visibilitychange',()=>{if(document.hidden){captureReading();flushReading();readingInteracted=false}else syncNow()});
window.addEventListener('focus',()=>syncNow());
document.addEventListener('focusout',()=>setTimeout(()=>syncNow(),0),true);
setInterval(()=>syncNow(),1500);
window.addEventListener('beforeunload',e=>{captureReading();flushReading();if(dirty){e.preventDefault();e.returnValue=''}});
document.addEventListener('DOMContentLoaded',async()=>{
    if(typeof editor!=='function'||typeof newNode!=='function'||!window.marked||!window.DOMPurify){
        status('??????????');
        paneBox.replaceChildren(el('p','empty','??????????'));
        return;
    }
    // MathLive registers its element asynchronously on some browsers. Do not
    // prevent ordinary text editing while the formula component is loading.
    await Promise.race([customElements.whenDefined('math-field'),new Promise(resolve=>setTimeout(resolve,2500))]);
    load();
});
