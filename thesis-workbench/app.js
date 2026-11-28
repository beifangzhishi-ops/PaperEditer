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
// A physical source line is an explicit image row. Keep older single-image
// lines unchanged, and never discard non-image Markdown from legacy figures.
function figureImageRows(source){
    const rows=[];
    for(const line of source.split(/\r?\n/)){
        if(!line.trim())continue;
        const images=[...line.matchAll(figureImagePattern())].map(m=>m[0]);
        if(!images.length||line.replace(figureImagePattern(),'').trim())return null;
        rows.push(images)
    }
    return rows
}
function figureWidth(title,fallback=100){return Math.max(.001,Math.min(100,Number(title?.match(/(?:^|\s)wb-width:(\d+(?:\.\d+)?)(?:\s|$)/)?.[1]||fallback)||100))}
function figureRowWidths(widths){
    const total=widths.reduce((sum,w)=>sum+w,0);
    return total<=100?widths:widths.map(w=>Math.floor(w/total*100000)/1000)
}
function figureRowWidthStyle(width){return 'calc((100% - var(--figure-row-gaps, 0px)) * '+width/100+')'}
function figureRowGapStyle(row,count){row.style.setProperty('--figure-row-gaps',Math.max(0,count-1)*10+'px')}
function subfigureLetter(i){let s='';for(i++;i>0;i=Math.floor((i-1)/26))s=String.fromCharCode(97+(i-1)%26)+s;return s}
let db, view='thesis', panes=[{id:null,edit:false}], active=0, open=new Set(), targets=new Map(), numbers=new Map(), aliases=new Map(), search='', dragging=null, timer, saving=false, dirty=false, conflict=false, version=0, toastTimer, longTimer;
let undoStack=[], redoStack=[];
let trashSupported=false;
let syncBase=null,syncBusy=false,syncNeeded=false,syncConflict=null,syncLoading=false,workspaceChanged=false;
let syncSignalPending=false,syncRetryTimer=null,lastEditorInput=0,editorComposing=false,editorPointer=false,imageUploads=0;
const SYNC_IDLE_MS=650;
let draftDB=null,draftQueue=Promise.resolve(),draftWarning=false,draftRunning=false;
const draftPending=new Map();
const draftTab=(()=>{try{let id=sessionStorage.getItem('wb:draft-tab');if(!id){id=uid();sessionStorage.setItem('wb:draft-tab',id)}return id}catch{return uid()}})();
const paneBox=$('panes'), nav=$('nav'), dialog=$('dialog');
// The separators live beside (not inside) the scroll panes, preserving
// existing pane indices, focus and saved reading positions while dragging.
const splitLayout=$('layout'),splitSidebar=$('sidebar'),splitDesktop=matchMedia('(min-width: 761px)');
const splitKey='wb:split-widths:v1';
let splitWidths=(()=>{try{const v=JSON.parse(localStorage.getItem(splitKey)||'{}');return {nav:Number.isFinite(v?.nav)?v.nav:294,pane:Number.isFinite(v?.pane)?v.pane:.5}}catch{return {nav:294,pane:.5}}})();
const splitClamp=(v,min,max)=>Math.max(min,Math.min(max,v));
function splitNavBounds(){return [160,Math.max(160,Math.min(splitLayout.clientWidth*.5,splitLayout.clientWidth-(panes.length>1?400:240)))]}
function splitPaneBounds(){const w=paneBox.clientWidth||1,min=Math.min(180,w*.4)/w;return [min,1-min]}
function applySplitWidths(){
    const navWidth=splitClamp(splitWidths.nav,...splitNavBounds());
    splitLayout.style.setProperty('--split-nav-width',navWidth+'px');
    const ratio=splitClamp(splitWidths.pane,...splitPaneBounds());
    paneBox.style.setProperty('--split-left-width',(ratio*100)+'%');
    paneBox.classList.toggle('splitDual',panes.length>1);
    positionSplitHandles();
    scheduleViewportLines();
}
function saveSplitWidths(){try{localStorage.setItem(splitKey,JSON.stringify(splitWidths))}catch{}}
function makeSplitHandle(kind,label){
    const h=el('div','layoutSplitHandle');h.id=kind==='nav'?'navSplitHandle':'paneSplitHandle';
    h.setAttribute('role','separator');h.setAttribute('aria-orientation','vertical');h.setAttribute('aria-label',label);h.title=label;h.tabIndex=0;
    function set(value){splitWidths[kind]=splitClamp(value,...(kind==='nav'?splitNavBounds():splitPaneBounds()));applySplitWidths()}
    h.addEventListener('pointerdown',e=>{
        if(e.button!==0||!splitDesktop.matches)return;e.preventDefault();e.stopPropagation();
        const x=e.clientX,start=kind==='nav'?splitSidebar.getBoundingClientRect().width:paneBox.firstElementChild.getBoundingClientRect().width/paneBox.clientWidth;
        h.setPointerCapture(e.pointerId);document.body.classList.add('layoutSplitting');
        const move=ev=>{if(ev.pointerId!==e.pointerId)return;set(start+(ev.clientX-x)/(kind==='nav'?1:paneBox.clientWidth))};
        const end=ev=>{if(ev.pointerId!==e.pointerId)return;h.removeEventListener('pointermove',move);h.removeEventListener('pointerup',end);h.removeEventListener('pointercancel',end);h.removeEventListener('lostpointercapture',end);document.body.classList.remove('layoutSplitting');saveSplitWidths()};
        h.addEventListener('pointermove',move);for(const type of ['pointerup','pointercancel','lostpointercapture'])h.addEventListener(type,end)
    });
    h.addEventListener('keydown',e=>{
        const [min,max]=kind==='nav'?splitNavBounds():splitPaneBounds(),step=kind==='nav'?16:16/(paneBox.clientWidth||1);
        if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();e.stopPropagation();
        const value=kind==='nav'?splitSidebar.getBoundingClientRect().width:paneBox.firstElementChild.getBoundingClientRect().width/(paneBox.clientWidth||1);
        set(e.key==='Home'?min:e.key==='End'?max:value+(e.key==='ArrowLeft'?-step:step));saveSplitWidths()
    });
    h.addEventListener('dblclick',e=>{e.preventDefault();set(kind==='nav'?294:.5);saveSplitWidths()});
    splitLayout.append(h);return h
}
const navSplitHandle=makeSplitHandle('nav','调整导航栏宽度'),paneSplitHandle=makeSplitHandle('pane','调整左右页宽度');
function positionSplitHandles(){
    navSplitHandle.hidden=!splitDesktop.matches;paneSplitHandle.hidden=!splitDesktop.matches||panes.length!==2||paneBox.children.length!==2;
    if(!splitDesktop.matches)return;
    const left=splitLayout.getBoundingClientRect().left,navWidth=splitSidebar.getBoundingClientRect().width;
    navSplitHandle.style.left=(splitSidebar.getBoundingClientRect().right-left)+'px';
    const [nmin,nmax]=splitNavBounds();navSplitHandle.setAttribute('aria-valuemin',Math.round(nmin));navSplitHandle.setAttribute('aria-valuemax',Math.round(nmax));navSplitHandle.setAttribute('aria-valuenow',Math.round(navWidth));
    if(!paneSplitHandle.hidden){const first=paneBox.firstElementChild,rect=first.getBoundingClientRect(),[min,max]=splitPaneBounds();paneSplitHandle.style.left=(rect.right-left)+'px';paneSplitHandle.setAttribute('aria-valuemin',Math.round(min*100));paneSplitHandle.setAttribute('aria-valuemax',Math.round(max*100));paneSplitHandle.setAttribute('aria-valuenow',Math.round(rect.width/paneBox.clientWidth*100))}
}
window.addEventListener('resize',applySplitWidths);splitDesktop.addEventListener('change',applySplitWidths);
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
    const nodes=spaceOf(n.id)==='blocks'?[n]:[n,...descendants(spaceOf(n.id),n.id)];
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
function positionSnapshot(){
    const live=panes.map(p=>p.history?p.history.previous:p).filter(Boolean);
    return {view,active:Math.min(panes[active]?.history?0:active,live.length-1),open:[...open],panes:live.map(p=>({...panePosition(p),thesisReading:thesisPosition(p.thesisReading)})),pageFolds:pageFoldStates}
}
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
    if(!p||p.history||pane._readingId!==p.id||pane._restoringReading||!pane.clientHeight)return;
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
function objectIds(n){return objectList(n).flatMap(o=>[o.id,...(o.kind==='figure'?[...o.body.matchAll(figureImagePattern())].map((m,i)=>figureImageId(m[3],o.id,i)):[])])}
function occupiedObjectIds(){return new Set(all().flatMap(n=>[n.id,...objectIds(n)]))}
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
            if(space==='thesis')targets.set(n.id,{kind:'node',owner:n.id,id:n.id,number,title:n.title});
            for(const o of space==='thesis'?objectList(n):[]){
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
const texTarget=t=>!!t&&spaceOf(t.owner)==='thesis'&&!!(t.number||db.originalLabels?.[t.id]||db.thesis.some(n=>[...n.body.matchAll(refPattern())].some(m=>['ref','eqref'].includes(m[1])&&m[2]===t.id)));
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
        if(structureConflict&&!choices[key])conflicts.push({key,label:(space==='thesis'?'博论树':'批注')+'：目录结构或删除冲突',local:mine,remote:theirs});
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
    const caret=redraw&&!preserveEditor?captureSyncCaret():null;
    if(redraw&&preserveEditor){for(const space of ['thesis','blocks'])for(let i=0;i<db[space].length;i++){const n=db[space][i],next=local[space][i];if(!syncEqual(n,next)){for(const k of Object.keys(n))if(!Object.hasOwn(next,k))delete n[k];Object.assign(n,next)}}db.trash=local.trash}
    else if(redraw)Object.assign(db,local);
    Object.assign(db,{revision:remote.revision,originalLabels:remote.originalLabels,importReport:remote.importReport,paragraphs:remote.paragraphs});
    dirty=!syncEqual(local,syncBase);conflict=false;syncConflict=null;syncNeeded=false;version++;
    if(redraw){undoStack=[];redoStack=[];panes.forEach(p=>{if(p.id&&!find(p.id))p.id=null});open=new Set([...open].filter(id=>find(id)));reindex();renderNav();if(preserveEditor){refreshObjectLabels();refreshObjectAnnotations();refreshFreeNotes();refreshAnnotationLists()}else{renderPanes();restoreSyncCaret(caret)}}
    refreshHistoryDiff();persistDraft();syncStatus();if(dirty){clearTimeout(timer);timer=setTimeout(save,100)}
}
async function mergePlan(base,local,remote,choices={}){
    if(!currentWorkspace?.history||syncEqual(local,remote)||syncEqual(base,local)||syncEqual(base,remote))return mergeSnapshots(base,local,remote,choices);
    return api('/api/merge',{base,local,remote,choices});
}
async function reconcile(remote,base=syncBase,local=editableSnapshot(),respectFocus=false){
    const remoteData={thesis:remote.thesis,blocks:remote.blocks,trash:remote.trash||[]},at=version,workspace=currentWorkspace?.id;
    const m=await mergePlan(base,local,remoteData);
    if(workspace!==currentWorkspace?.id)return;
    if(at!==version){syncNeeded=true;status('有新版本 · 等待同步');return}
    if(m.conflicts.length){conflict=true;dirty=true;syncConflict={remote,base,local};persistDraft();syncStatus();showToast('检测到并发冲突，草稿已保留。点击刷新处理。');return}
    const preserve=respectFocus&&syncCanPreserve(local,m.state);
    if(respectFocus&&!preserve&&!syncCanApply()){syncNeeded=true;status('有新版本 · 结束输入后同步');scheduleSyncRetry();return}
    applySynced(remote,m.state,preserve);
}
function downloadSyncDraft(name,data){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=el('a');a.href=url;a.download=name+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
function conflictVersionText(value){return typeof value==='string'?value:JSON.stringify(value,null,2)??'（不存在）'}
function conflictDiff(c){
    const local=conflictVersionText(c.local),remote=conflictVersionText(c.remote);
    const textOnly=typeof c.local==='string'&&typeof c.remote==='string';
    // Compare server -> local. Character-level changes are useful for Chinese
    // prose and TeX; structured values and large conflicts use line changes.
    let changes=null;
    try{if(Math.max(local.length,remote.length)<=200000){
        const compare=textOnly&&Math.max(local.length,remote.length)<=12000?window.Diff?.diffChars:window.Diff?.diffLines;
        changes=compare?.(remote,local,{timeout:200})
    }}catch{}
    const grid=el('div','conflictDiffGrid'),views={};
    for(const [side,title] of [['local','本地版本'],['remote','服务器版本']]){
        const panel=el('div','conflictDiffPanel'),pre=el('pre','conflictDiffText');
        pre.setAttribute('aria-label',title+'内容');pre.tabIndex=0;
        panel.append(el('h4','',title),pre);views[side]={panel,pre};grid.append(panel);
    }
    if(changes){
        for(const part of changes){
            if(!part.removed)views.local.pre.append(el('span',part.added?'conflictAdded':'',part.value));
            if(!part.added)views.remote.pre.append(el('span',part.removed?'conflictRemoved':'',part.value))
        }
    }else{views.local.pre.textContent=local;views.remote.pre.textContent=remote}
    for(const [side,value] of [['local',local],['remote',remote]])if(value==='')views[side].pre.append(el('span','conflictEmpty','（空内容）'));
    return {grid,views,highlighted:!!changes}
}
function showSyncConflict(){
    if(!syncConflict)return;
    const {remote,base}=syncConflict,local=editableSnapshot(),server={thesis:remote.thesis,blocks:remote.blocks,trash:remote.trash||[]},choices={};
    const d=showDialog('处理并发修改');d.append(el('p','small','双方草稿均保留。选择每个冲突项的版本，其他不冲突的修改会自动合并。目录或回收站冲突以完整操作为单位。'));
    const legend=el('p','conflictLegend');legend.append(el('span','conflictAdded','绿色：本地新增或修改'),el('span','conflictRemoved','红色：服务器独有或被本地替换'),el('span','small','对比方向：服务器 → 本地'));d.append(legend);
    const backups=el('div','');backups.append(btn('导出本地草稿',()=>downloadSyncDraft('local-draft',local)),btn('导出服务器版本',()=>downloadSyncDraft('server-draft',server)));d.append(backups);
    const fields=el('div');d.append(fields);let plan=null,generation=0;
    const done=btn('确认合并并保存',()=>{if(!plan||plan.conflicts.length)return;dialog.close();applySynced(remote,plan.state)});d.append(done);
    async function draw(){
        const token=++generation;done.disabled=true;fields.replaceChildren(el('p','small','计算合并差异…'));
        let m;try{m=await mergePlan(base,local,server,choices)}catch(e){if(fields.isConnected)fields.replaceChildren(el('p','muted',e.message),btn('重试',draw));return}
        if(token!==generation||!fields.isConnected||!dialog.open)return;plan=m;fields.replaceChildren();
        for(const c of m.conflicts){
            const row=el('section','conflictItem');row.append(el('h3','',c.label));
            const {grid,views,highlighted}=conflictDiff(c);
            if(!highlighted)row.append(el('p','small muted','差异过大或计算超时，以下显示双方完整原文（未高亮）。'));
            for(const [side,title] of [['local','本地版本'],['remote','服务器版本']])views[side].panel.append(btn('采用'+title,()=>{choices[c.key]=side;draw()}));
            row.append(grid);fields.append(row)
        }
        done.disabled=!!m.conflicts.length;if(!m.conflicts.length)fields.append(el('p','','已选择全部冲突项。确认后保存。'))
    }draw();
}
function captureSyncCaret(){
    const focus=document.activeElement,area=focus?.closest('.richText'),doc=focus?.closest('.visualDocument'),pane=focus?.closest('.pane'),card=focus?.closest('.visualCard');
    if(!doc||!pane||!card)return null;
    const index=[...doc.querySelectorAll('.visualCard')].indexOf(card),paragraph=card.dataset.paragraphIndex;
    const info={owner:doc._owner,pane:[...paneBox.children].indexOf(pane),index,raw:card._part?.raw,id:card.dataset.object,paragraphId:db.paragraphs?.[doc._owner]?.[paragraph]?.id};
    if(focus.matches('math-field'))return {...info,math:true,selection:focus.selection};
    const s=getSelection();if(!area||!s?.rangeCount||!s.isCollapsed||!area.contains(s.anchorNode))return null;
    const r=document.createRange();r.selectNodeContents(area);r.setEnd(s.anchorNode,s.anchorOffset);
    return {...info,offset:r.toString().length,areaIndex:[...card.querySelectorAll('.richText')].indexOf(area)};
}
function restoreSyncCaret(info){
    if(!info)return;
    const doc=[...(paneBox.children[info.pane]?.querySelectorAll('.visualDocument')||[])].find(d=>d._owner===info.owner);
    if(!doc)return;
    const cards=[...doc.querySelectorAll('.visualCard')];let card;
    if(info.id)card=cards.find(c=>c.dataset.object===info.id);
    else if(info.paragraphId){const i=db.paragraphs?.[info.owner]?.findIndex(p=>p.id===info.paragraphId);if(i>=0)card=cards.find(c=>c.dataset.paragraphIndex===String(i))}
    else{const matching=cards.filter(c=>c._part?.raw===info.raw);card=matching.length===1?matching[0]:cards[info.index]?._part?.raw===info.raw?cards[info.index]:null}
    if(!card)return;
    if(info.math){const field=card.querySelector('math-field');if(field){field.focus({preventScroll:true});try{field.selection=info.selection}catch{}}return}
    const area=card.querySelectorAll('.richText')[info.areaIndex];if(!area||!canEditControl(area))return;
    const walker=document.createTreeWalker(area,NodeFilter.SHOW_TEXT);let n,left=info.offset,r=document.createRange();
    while(n=walker.nextNode()){if(left<=n.length){r.setStart(n,left);r.collapse(true);break}left-=n.length}
    if(!n){r.selectNodeContents(area);r.collapse(false)}
    area.focus({preventScroll:true});const s=getSelection();s.removeAllRanges();s.addRange(r);
}
function syncCanApply(){
    if(dialog.open||dragging||!$('menu').hidden||imageUploads||editorComposing||editorPointer)return false;
    const focus=document.activeElement;
    if(!focus?.closest('.richText,.editableTitle,math-field,textarea')||!canEditControl(focus))return true;
    const s=getSelection();if(s&&!s.isCollapsed&&focus.contains(s.anchorNode))return false;
    return Date.now()-lastEditorInput>=SYNC_IDLE_MS;
}
function syncCanPreserve(local,merged){
    if(syncEqual(local,merged))return true;
    if(dialog.open||dragging||!$('menu').hidden||imageUploads)return false;
    // Keep the live editor DOM and node references intact for changes in
    // unrelated, non-rendered chapters. Structural/knowledge changes may
    // affect visible references and are deferred until the editor loses focus.
    if(!syncEqual(local.blocks,merged.blocks)||!syncEqual(local.trash,merged.trash))return false;
    const visible=new Set([...paneBox.querySelectorAll('.visualDocument')].map(d=>d._owner));
    for(const p of panes){if(p.id){visible.add(p.id);for(const n of descendants(spaceOf(p.id),p.id))visible.add(n.id)}}
    if(local.thesis.length!==merged.thesis.length)return false;
    return local.thesis.every((n,i)=>{const next=merged.thesis[i];return n.id===next.id&&n.parent===next.parent&&n.order===next.order&&n.level===next.level&&(!visible.has(n.id)||syncEqual(n,next))});
}
function scheduleSyncRetry(delay=SYNC_IDLE_MS){clearTimeout(syncRetryTimer);syncRetryTimer=setTimeout(()=>{if(syncNeeded||syncSignalPending)syncNow()},delay)}
function signalSync(){syncSignalPending=true;syncNow()}
async function syncNow(force=false){
    if(!db||!syncBase||syncLoading||syncBusy||saving||conflict||workspaceChanged||document.hidden&&!force)return;
    syncBusy=true;syncSignalPending=false;const workspace=currentWorkspace?.id;
    try{
        const r=await api('/api/state?since='+encodeURIComponent(db.revision)+'&workspace='+encodeURIComponent(workspace||'directory'));
        if(syncLoading||workspace!==currentWorkspace?.id)return;
        if(r.workspace?.id!==workspace){workspaceChanged=true;persistDraft();syncStatus();return}
        if(r.unchanged||r.revision===db.revision){syncNeeded=false;return}
        await reconcile(r,syncBase,editableSnapshot(),!force);
    }catch(e){if(e.status>=500)status('文档异常 · 草稿保留');if(force)showToast(e.message);else console.warn(e)}
    finally{syncBusy=false;if(syncSignalPending&&!conflict&&!workspaceChanged)scheduleSyncRetry(0);else if(dirty&&!conflict&&!workspaceChanged&&!syncNeeded){clearTimeout(timer);timer=setTimeout(save,100)}}
}
let annotationEditBefore=null,annotationEditCheckpointed=false;
// Coalesce consecutive edits in one editing host, not unrelated document mutations.
const UNDO_TYPING_IDLE=1000;
let typingUndoGroup=null,typingBefore=null,clipboardEdit=false;
function endTypingUndo(){typingUndoGroup=null;typingBefore=null}
function typingHost(target){return target?.closest?.('.richText,.editableTitle')}
document.addEventListener('beforeinput',e=>{
    const host=typingHost(e.target);typingBefore=null;
    if(!host||e.target.closest?.('math-field'))return;
    if(['historyUndo','historyRedo'].includes(e.inputType)&&e.cancelable&&canEditControl(host)){
        e.preventDefault();toolbarUndo(e.inputType==='historyRedo');return
    }
    const selected=host.matches('input')?host.selectionStart!==host.selectionEnd:!getSelection()?.isCollapsed;
    typingBefore={host,type:e.inputType,selected};
},true);
function typingEdit(e,host){
    if(!e||!host||clipboardEdit||e.target!==host)return null;
    const before=typingBefore;typingBefore=null;
    const type=e.inputType;
    if(e.isComposing||type==='insertCompositionText'||type==='deleteCompositionText')return {host,kind:'composition'};
    if(before?.host===host&&before.type===type&&before.selected)return null;
    if(type==='insertText'&&e.data&&!/[\r\n]/.test(e.data)&&[...e.data].length===1)return {host,kind:'insert'};
    if(type==='deleteContentBackward'||type==='deleteContentForward')return {host,kind:type};
    return null
}
function pushEditHistory(stack,snapshot,edit,limit){
    const now=performance.now(),previous=typingUndoGroup;
    const merge=edit&&previous&&previous.stack===stack&&previous.host===edit.host&&previous.kind===edit.kind&&stack.length&&(edit.kind==='composition'||now-previous.time<=UNDO_TYPING_IDLE);
    if(!merge){stack.push(typeof snapshot==='function'?snapshot():snapshot);if(stack.length>limit)stack.shift()}
    typingUndoGroup=edit?{...edit,stack,time:now}:null
}
for(const type of ['pointerdown','focusin','compositionstart','compositionend'])document.addEventListener(type,endTypingUndo,true);
for(const type of ['paste','cut','drop'])document.addEventListener(type,()=>{endTypingUndo();clipboardEdit=true;queueMicrotask(()=>{clipboardEdit=false;endTypingUndo()})},true);
document.addEventListener('keydown',e=>{
    if(e.isComposing||e.keyCode===229)return;
    if(e.ctrlKey||e.metaKey||e.altKey||['Enter','Tab','Escape','Home','End','PageUp','PageDown'].includes(e.key)||e.key.startsWith('Arrow'))endTypingUndo()
},true);
function checkpoint(edit=null){if(annotationEditBefore&&annotationEditCheckpointed)return;pushEditHistory(undoStack,annotationEditBefore||editableSnapshot,annotationEditBefore?null:edit,30);if(annotationEditBefore)annotationEditCheckpointed=true;redoStack=[]}
function annotationEdit(fn){if(annotationEditBefore)return fn();annotationEditBefore=editableSnapshot();annotationEditCheckpointed=false;try{return fn()}finally{annotationEditBefore=null;annotationEditCheckpointed=false}}
function refreshObjectLabels(){
    for(const el of document.querySelectorAll('.visualRef[data-token],a.ref[data-ref]')){
        const m=el.dataset.token&&[...el.dataset.token.matchAll(refPattern())][0],id=m?.[2]||el.dataset.ref;
        if(m&&['embed','cite'].includes(m[1])||db.blocks.some(n=>n.id===id))continue;
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
function change(structural=false){dirty=true;version++;reindex();syncStatus();persistDraft();clearTimeout(timer);timer=setTimeout(save,850);if(structural){renderNav();renderPanes()}else{refreshObjectLabels();refreshObjectAnnotations();refreshFreeNotes();refreshAnnotationLists();refreshHistoryDiff()}scheduleToolbarUpdate()}
async function save(){
    if(!dirty||saving||conflict||workspaceChanged||syncLoading||syncBusy)return;
    if(syncNeeded){await syncNow();return}
    saving=true;const v=version, snapshot={...editableSnapshot(),revision:db.revision};
    status('保存中');
    try{
        const r=await api('/api/save',snapshot);
        db.revision=r.revision;if(r.paragraphs)db.paragraphs=r.paragraphs;syncBase={thesis:snapshot.thesis,blocks:snapshot.blocks,trash:snapshot.trash};
        dirty=v!==version;persistDraft();status(dirty?'待保存':'已保存');
    }catch(e){if(e.status===409){syncNeeded=true;status('等待同步 · 请结束当前输入');persistDraft()}else{status('保存失败 · 草稿保留');showToast(e.message);console.warn(e)}}
    finally{saving=false;if(syncNeeded||syncSignalPending)syncNow();else if(dirty&&!conflict&&v!==version){clearTimeout(timer);timer=setTimeout(save,850)}}
}
let markingVersion=false;
function updateHistoryControls(){
    const enabled=!!currentWorkspace?.history&&!!db;
    $('saveVersion').hidden=!enabled;$('historyButton').hidden=!enabled;
    document.body.classList.toggle('historyEnabled',enabled);
}
async function flushDocument(){
    if(dialog._commitNote)closeWorkbenchDialog();
    if(!db||workspaceChanged)return false;
    for(let i=0;i<5;i++){
        while(saving||syncBusy)await new Promise(r=>setTimeout(r,40));
        if(conflict){showSyncConflict();return false}
        if(workspaceChanged)return false;
        if(syncNeeded)await syncNow(true);
        else if(dirty)await save();
        else return true;
    }
    if(conflict)showSyncConflict();else if(dirty)showToast('请先完成当前修改的保存');
    return !dirty&&!conflict&&!workspaceChanged;
}
async function markVersion(){
    if(markingVersion||!db)return;
    if(!currentWorkspace?.history){await save();return}
    markingVersion=true;
    try{
        if(!await flushDocument())return;
        const r=await api('/api/history/tag',{revision:db.revision});
        status('已保存版本');showToast('已保存版本：'+r.tag.name);
    }catch(e){showToast(e.message)}
    finally{markingVersion=false}
}
function historyURL(endpoint,params={}){
    return endpoint+'?'+new URLSearchParams({workspace:currentWorkspace.id,...params});
}
function historicalValue(doc,id){
    if(!id)return {thesis:doc.thesis,blocks:doc.blocks,trash:doc.trash||[]};
    for(const n of [...doc.thesis,...doc.blocks]){
        if(n.id===id)return n;
        const index=doc.paragraphs?.[n.id]?.findIndex(r=>r.id===id);
        if(index>=0)return visualParts(n.body).filter(p=>p.kind==='text')[index]?.raw??null;
        for(const m of n.body.matchAll(objectPattern()))if(m[2]===id)return m[0];
    }
    return null;
}
function historyMarkdown(raw,host){
    if(!raw?.trim())return;
    const tokens=[];
    const hold=(kind,value)=>'<span data-history-token="'+(tokens.push({kind,value})-1)+'"></span>';
    const src=raw.replace(/(?<!\\)\$\$([\s\S]+?)\$\$|(?<!\\)\$([^\n$]+?)\$|\\\[([\s\S]+?)\\\]|\\\(([^\n]+?)\\\)|\[\[(ref|eqref|embed|cite):([^\]\n]+)\]\]/g,(m,dm,im,bd,bi,k,id)=>dm!=null?hold('display',dm):im!=null?hold('math',im):bd!=null?hold('display',bd):bi!=null?hold('math',bi):hold(k,id));
    const fragment=el('div','historicalMarkdown');
    fragment.innerHTML=DOMPurify.sanitize(marked.parse(src,{gfm:true}),{ADD_ATTR:['data-history-token'],FORBID_TAGS:['input','textarea','button','select','form'],FORBID_ATTR:['contenteditable','autofocus','tabindex']});
    for(const marker of fragment.querySelectorAll('[data-history-token]')){
        const t=tokens[Number(marker.dataset.historyToken)];
        if(!t){marker.remove();continue}
        if(t.kind==='math'||t.kind==='display'){const span=el(t.kind==='display'?'div':'span','historicalMath');math(span,t.value,t.kind==='display');marker.replaceWith(span)}
        else marker.replaceWith(el('span','historicalRef',t.kind==='cite'?'['+t.value+']':t.kind==='embed'?'※ '+t.value:'〔'+t.value+'〕'));
    }
    for(const a of fragment.querySelectorAll('a'))a.removeAttribute('href');
    host.append(fragment)
}
function historicalBody(raw,host){
    const section=el('div','viewportHistorySection');
    visualParts(raw||'').forEach((part,index)=>{const group=viewportDiffGroup(part,index);group.append(historyRenderedPart(part,true));section.append(group)});
    host.append(section)
}
function closeHistoricalVersion(redraw=true){
    const h=panes[1]?.history;if(!h)return;
    if(h.previous)panes[1]=h.previous;else panes.splice(1,1);
    active=0;
    if(redraw){renderNav();renderPanes()}
}
function closeSecondPane(){
    if(panes.length<2)return;
    captureReading();panes.splice(1,1);active=0;
    renderNav();renderPanes()
}
function openHistoricalVersion(entry,past,objectId=null,mode='version',comparison=null){
    captureReading();
    const previous=panes[1]?.history?panes[1].history.previous:panes[1]||null;
    const selected=objectId||[...past.thesis,...past.blocks].find(n=>n.id===panes[0]?.id)?.id||past.thesis[0]?.id||past.blocks[0]?.id||null;
    panes[1]={id:previous?.id||panes[0]?.id||null,edit:false,history:{entry,past,objectId,selected,previous,mode,comparison}};
    if(dialog.open)dialog.close();$('menu').hidden=true;mobileClose();active=1;renderNav();renderPanes();
}
function historyPageNodes(doc,id){
    if(!id)return [];
    const root=doc.thesis.find(n=>n.id===id);
    if(!root)return doc.blocks.filter(n=>n.id===id);
    const result=[],seen=new Set();
    function visit(n){if(seen.has(n.id))return;seen.add(n.id);result.push(n);for(const child of doc.thesis)if(child.parent===n.id)visit(child)}
    visit(root);return result;
}
// Compare sanitized rendered nodes, not Markdown/TeX syntax. Math and
// images are atomic; matching table cells and formatted prose are recursive.
function historyDiffMark(node,kind){
    const mark=el('span',kind==='add'?'historyAdded':'historyRemoved');
    mark.append(node.cloneNode(true));return mark;
}
function historyDiffText(old,now,host){
    if(old===now){host.append(document.createTextNode(now));return false}
    const diff=window.Diff?.diffWordsWithSpace(old,now,{timeout:250});
    const items=diff||[{value:old,removed:true},{value:now,added:true}];
    for(const item of items)if(item.value)host.append(item.added||item.removed?historyDiffMark(document.createTextNode(item.value),item.added?'add':'remove'):document.createTextNode(item.value));
    return true;
}
function historyDiffDOM(a,b,host){
    if(a.isEqualNode(b)){host.append(b.cloneNode(true));return false}
    if(a.nodeType===3&&b.nodeType===3)return historyDiffText(a.textContent,b.textContent,host);
    if(a.nodeType===1&&b.nodeType===1&&a.tagName===b.tagName&&!a.matches('.historicalMath,.historicalRef,img,svg,pre')&&
        a.getAttributeNames().every(k=>a.getAttribute(k)===b.getAttribute(k))&&a.attributes.length===b.attributes.length&&a.childNodes.length===b.childNodes.length){
        const next=b.cloneNode(false);let changed=false;
        for(let i=0;i<a.childNodes.length;i++)changed=historyDiffDOM(a.childNodes[i],b.childNodes[i],next)||changed;
        host.append(next);return changed;
    }
    // Do not place spans directly inside table rows or lists.
    for(const [node,kind] of [[a,'remove'],[b,'add']]){
        if(node.nodeType===1){const copy=node.cloneNode(true);copy.classList.add(kind==='add'?'historyAdded':'historyRemoved');host.append(copy)}
        else host.append(historyDiffMark(node,kind));
    }
    return true;
}
function historyRenderedPart(p,showId=false){
    const host=el('div','historyRenderedPart');
    if(p.kind==='text')historyMarkdown(p.raw,host);
    else if(p.kind==='embed')host.append(el('p','historicalRef','※ '+p.ref));
    else{
        const box=el('section','historicalObject');box.append(el('div','small',({equation:'公式',figure:'图',table:'表'}[p.kind]||'')+(showId?' · '+p.id:'')));
        if(p.kind==='equation'){const m=el('div','mathscroll historicalMath');math(m,p.body.trim(),true);box.append(m)}
        else if(p.kind==='figure'){
            const [caption,...rest]=p.body.split('\n'),rows=figureImageRows(rest.join('\n'));
            if(rows){
                const images=el('div','figureImageRows');let index=0;
                for(const marks of rows){
                    const row=el('div','figureImageRow');
                    const widths=figureRowWidths(marks.map(mark=>figureWidth([...mark.matchAll(figureImagePattern())][0][3])));
                    figureRowGapStyle(row,marks.length);
                    for(const mark of marks){
                        const m=[...mark.matchAll(figureImagePattern())][0],wrap=el('div','historicalFigureImage'),img=el('img');
                        wrap.dataset.subfigure=figureImageId(m[3],p.id,index++);wrap.style.width=figureRowWidthStyle(widths[row.children.length]);
                        img.src=m[2];img.alt=m[1];wrap.append(img);row.append(wrap)
                    }
                    images.append(row)
                }
                box.append(images);historyMarkdown(caption,box)
            }else historyMarkdown(p.body,box)
        }else historyMarkdown(p.body,box);
        host.append(box);
    }
    return host;
}
function viewportDiffGroup(part,index){
    const group=el('div','viewportDiffPart');group._viewportPart=part;group._viewportIndex=index;return group
}
function historyDiffBody(old,now,host){
    const before=visualParts(old||''),after=visualParts(now||'');
    const indexes=new Map(after.map((part,index)=>[part,index]));
    const identity=p=>p.kind==='text'?'text:'+p.raw:p.kind+':'+(p.id||p.ref);
    const chunks=window.Diff?.diffArrays(before,after,{comparator:(a,b)=>identity(a)===identity(b),timeout:250})||[{removed:true,value:before},{added:true,value:after}];
    let i=0,j=0,changed=false;
    function pair(a,b){
        const group=viewportDiffGroup(b||a,b?indexes.get(b):-1);host.append(group);
        if(!a||!b){const node=historyRenderedPart(a||b);node.classList.add(a?'historyRemoved':'historyAdded');group.append(node);changed=true;return}
        if(a.raw===b.raw){group.append(historyRenderedPart(b));return}
        changed=true;
        const x=historyRenderedPart(a),y=historyRenderedPart(b);
        if(a.kind===b.kind&&a.kind!=='equation')historyDiffDOM(x,y,group);
        else{ x.classList.add('historyRemoved');y.classList.add('historyAdded');group.append(x,y)}
    }
    for(let k=0;k<chunks.length;){
        const c=chunks[k];
        if(!c.added&&!c.removed){for(let n=0;n<c.count;n++)pair(before[i++],after[j++]);k++;continue}
        const a=[],b=[];
        while(k<chunks.length&&(chunks[k].added||chunks[k].removed)){
            const part=chunks[k++];if(part.removed){for(const p of part.value)a.push(before[i++])}else{for(const p of part.value)b.push(after[j++])}
        }
        // Pair adjacent changed prose paragraphs; objects with different IDs
        // are deletions/additions, not edits to an unrelated object.
        while(a.length||b.length){
            if(a[0]&&b[0]&&a[0].kind==='text'&&b[0].kind==='text')pair(a.shift(),b.shift());
            else if(a.length)pair(a.shift(),null);else pair(null,b.shift());
        }
    }
    return changed;
}
function historyPageNotes(doc,nodes){
    const ids=new Set(nodes.flatMap(n=>[n.id,...objectIds(n)])),embedded=new Set(nodes.flatMap(n=>[...n.body.matchAll(refPattern())].filter(m=>m[1]==='embed').map(m=>m[2])));
    return doc.blocks.filter(n=>!ids.has(n.id)&&(embedded.has(n.id)||objectNoteBindings(n).some(b=>ids.has(b.targetId))||freeNotePlacements(n).some(p=>ids.has(p.pageId))));
}
function renderHistoryDiff(host,h){
    const id=panes[0]?.id,oldDoc=h.comparison?h.comparison.doc:h.past,newDoc=h.comparison?h.past:db;
    const oldNodes=historyPageNodes(oldDoc,id),newNodes=historyPageNodes(newDoc,id);
    const oldNotes=historyPageNotes(oldDoc,oldNodes),newNotes=historyPageNotes(newDoc,newNodes);
    const signature=JSON.stringify([id,oldNodes,newNodes,oldNotes,newNotes]);
    if(host._diffSignature===signature)return;
    host._diffSignature=signature;host.replaceChildren();
    if(!id){host.append(el('p','muted','请在首页打开要比较的章节或批注。'));return}
    const basis=h.comparison?(h.comparison.entry?.id.slice(0,8)||'初始空版本')+' → '+h.entry.id.slice(0,8)+' · 行号以选中版本为准':'历史版本 → 当前版本 · 行号以当前版本为准';
    host.append(el('p','small','当前首页：'+(newNodes[0]?.title||oldNodes[0]?.title||id)+' · '+basis));
    let changes=false;
    function sections(oldList,newList,notes=false){
        const before=new Map(oldList.map(n=>[n.id,n])),after=new Map(newList.map(n=>[n.id,n]));
        for(const key of new Set([...after.keys(),...before.keys()])){
            const a=before.get(key),b=after.get(key),section=el('section','historyDiffSection'),title=el('h3','historyDiffHeading');
            section._viewportOwner=key;section._diffTitle=b?.title||'';
            if(!notes){let depth=0,parent=(b||a).parent;const seen=new Set();while(parent&&parent!==id&&!seen.has(parent)){seen.add(parent);parent=(after.get(parent)||before.get(parent))?.parent;depth++}section.style.marginInlineStart=Math.min(3,key===id?0:depth+1)*10+'px'}
            if(!a||!b){title.textContent=(b||a).title||'未命名';section.classList.add(a?'historyRemoved':'historyAdded');section.append(title);historyDiffBody(a?.body||'',b?.body||'',section);changes=true}
            else{
                changes=historyDiffText(a.title||'',b.title||'',title)||changes;section.append(title);
                changes=historyDiffBody(a.body,b.body,section)||changes;
                if(notes&&!syncEqual([a.objectBindings,a.freePlacements],[b.objectBindings,b.freePlacements])){section.append(el('p','small historyAdded','批注位置已修改'));changes=true}
            }
            host.append(section);
        }
    }
    sections(oldNodes,newNodes);
    if(oldNotes.length||newNotes.length){host.append(el('h3','historyDiffHeading','本页批注'));sections(oldNotes,newNotes,true)}
    if(!changes)host.prepend(el('p','muted','当前页面内容一致'));
}
function refreshHistoryDiff(){
    const h=panes[1]?.history,host=paneBox.children[1]?.querySelector('.historyPageDiff');
    if(h?.mode==='diff'&&host)renderHistoryDiff(host,h);
    scheduleViewportLines();
}
// Mirror only the new side of the rendered diff, without inserting markup
// into editable prose (which would affect selection, clipboard and saving).
function historyLiveRuns(root){
    const runs=[];let text='';
    function walk(node,added=false){
        if(node.nodeType===Node.TEXT_NODE){
            if(!node.data)return;
            runs.push({node,start:text.length,end:text.length+node.data.length,added});text+=node.data;return;
        }
        if(node.nodeType!==Node.ELEMENT_NODE||node.matches('.historyRemoved,.objectNoteMarkers,[hidden]'))return;
        added=added||node.classList.contains('historyAdded');
        if(node.matches('.inlineMathAtom,.historicalMath,.visualRef,.historicalRef,math-field,img,br')){
            runs.push({node,start:text.length,end:text.length+1,added,atomic:true});text+=node.matches('br')?'\n':'\ufffc';return;
        }
        for(const child of node.childNodes)walk(child,added);
    }
    walk(root,!!root.closest('.historyAdded'));return {text,runs};
}
function mirrorHistoryAdditions(){
    const left=paneBox.firstElementChild,host=paneBox.children[1]?.querySelector('.historyPageDiff');
    for(const node of left?.querySelectorAll('.historyLiveAdded')||[])node.classList.remove('historyLiveAdded');
    const registry=window.CSS?.highlights;
    registry?.delete('paper-history-added');
    if(!left||!host||panes[1]?.history?.mode!=='diff')return;
    const sections=new Map([...host.querySelectorAll('.historyDiffSection')].map(s=>[s._viewportOwner,s]));
    const ranges=[];
    for(const doc of left.querySelectorAll('.visualDocument')){
        const section=sections.get(doc._owner);if(!section)continue;
        const heading=[...left.querySelectorAll('.editableHeading')].find(h=>h.dataset.bindObject===doc._owner);
        const title=heading?.querySelector('.editableTitle'),diffTitle=section.querySelector('.historyDiffHeading');
        if(title&&title.value===section._diffTitle&&(section.matches('.historyAdded')||diffTitle?.querySelector('.historyAdded')))title.classList.add('historyLiveAdded');
        const cards=[...doc.querySelector(':scope > .visualBody').children];
        const groups=[...section.querySelectorAll(':scope > .viewportDiffPart')].filter(g=>g._viewportIndex>=0);
        const byIndex=new Map(groups.map(g=>[g._viewportIndex,g]));
        for(const [index,card] of cards.entries()){
            const part=card._part;if(!part)continue;
            const same=g=>g?._viewportPart?.raw===part.raw;
            let group=byIndex.get(index);
            if(!same(group)){
                // Older comparisons can have shifted paragraphs. Only use a
                // unique exact match, never a similarly worded unrelated part.
                const matches=groups.filter(same);
                group=matches.length===1&&cards.filter(c=>c._part?.raw===part.raw).length===1?matches[0]:null;
            }
            if(!group||!group.closest('.historyAdded')&&!group.querySelector('.historyAdded'))continue;
            if(part.kind!=='text'){card.classList.add('historyLiveAdded');continue}
            const area=card.querySelector('.richText');if(!area)continue;
            const source=historyLiveRuns(group),target=historyLiveRuns(area);
            const changes=source.text===target.text?[{value:source.text}]:window.Diff?.diffChars(source.text,target.text,{timeout:60});
            if(!changes)continue;
            let a=0,b=0;
            for(const change of changes){
                const len=change.value.length;
                if(!change.added&&!change.removed){
                    for(const run of source.runs){
                        if(!run.added||run.end<=a||run.start>=a+len)continue;
                        const start=b+Math.max(run.start,a)-a,end=b+Math.min(run.end,a+len)-a;
                        for(const dest of target.runs){
                            if(dest.end<=start||dest.start>=end)continue;
                            if(dest.atomic){if(run.atomic)dest.node.classList.add('historyLiveAdded');continue}
                            const range=document.createRange();range.setStart(dest.node,Math.max(start,dest.start)-dest.start);range.setEnd(dest.node,Math.min(end,dest.end)-dest.start);ranges.push(range);
                        }
                    }
                }
                if(!change.added)a+=len;if(!change.removed)b+=len;
            }
        }
    }
    if(ranges.length&&registry&&window.Highlight){const highlight=new Highlight(...ranges);highlight.priority=-2;registry.set('paper-history-added',highlight)}
}
// View-only line coordinates. Count rendered prose rows and one row per
// atomic object, independently for each section. No document IDs or line
// positions are written back. Diff projects current-version row starts onto
// its rendered text, skipping removed runs (which may change its wrapping).
function viewportTextLayout(root,measure=true){
    const runs=[],lines=[];let text='';
    const range=document.createRange();
    const center=r=>(r.top+r.bottom)/2;
    function pushLine(offset,rect){
        if(!rect?.height)return;
        lines.push({offset,y:center(rect)});
    }
    function walk(node){
        if(node.nodeType===Node.TEXT_NODE){
            const value=node.data;if(!value.length)return;
            const start=text.length;text+=value;
            const rectAt=i=>{range.setStart(node,i);range.setEnd(node,i+1);return range.getBoundingClientRect()};
            runs.push({start,end:text.length,rectAt});
            if(!measure||!value.trim())return;
            range.selectNodeContents(node);
            const rects=[...range.getClientRects()].filter(r=>r.width>.1&&r.height>0);
            for(const rect of rects){
                let lo=0,hi=value.length-1;
                if(rects.length>1)while(lo<hi){const mid=(lo+hi)>>1;if(center(rectAt(mid))<center(rect)-1)lo=mid+1;else hi=mid}
                pushLine(start+lo,rect);
            }
            return;
        }
        if(node.nodeType!==Node.ELEMENT_NODE||node.matches('.historyRemoved,[hidden],.objectNoteMarkers'))return;
        if(node.matches('.inlineMathAtom,.historicalMath,.visualRef,.historicalRef,math-field,img,br')){
            const start=text.length;text+=node.tagName==='BR'?'\n':'\ufffc';
            const rectAt=()=>node.getBoundingClientRect();runs.push({start,end:text.length,rectAt});
            if(measure)pushLine(start,rectAt());return
        }
        for(const child of node.childNodes)walk(child)
    }
    walk(root);
    lines.sort((a,b)=>a.y-b.y||a.offset-b.offset);
    const rows=[];
    for(const line of lines){const last=rows.at(-1);if(last&&Math.abs(last.y-line.y)<9){if(line.offset<last.offset){last.offset=line.offset;last.y=line.y}}else rows.push({...line})}
    if(measure&&!rows.length){const r=root.getBoundingClientRect();if(r.height)rows.push({offset:0,y:r.top+Math.min(r.height,parseFloat(getComputedStyle(root).lineHeight)||28)/2})}
    function yAt(offset){
        let lo=0,hi=runs.length;
        while(lo<hi){const mid=(lo+hi)>>1;if(runs[mid].end<=offset)lo=mid+1;else hi=mid}
        for(let i=lo;i<runs.length;i++){const run=runs[i],r=run.rectAt(Math.max(0,offset-run.start));if(r.height)return center(r)}
        return root.getBoundingClientRect().top+14
    }
    return {text,rows,yAt}
}
function viewportOffsetMap(source,target){
    if(source===target)return offset=>offset;
    const changes=window.Diff?.diffChars(source,target,{timeout:60});
    if(!changes)return offset=>Math.min(offset,Math.max(0,target.length-1));
    const spans=[];let a=0,b=0;
    for(const c of changes){const n=c.value.length;if(c.added)b+=n;else{spans.push({start:a,end:a+n,target:b,removed:!!c.removed});a+=n;if(!c.removed)b+=n}}
    return offset=>{const s=spans.find(s=>offset>=s.start&&offset<s.end);return Math.min(Math.max(0,target.length-1),s?s.target+(s.removed?0:offset-s.start):b)}
}
function viewportObjectY(node){const r=node.getBoundingClientRect();return r.top+Math.min(r.height,26)/2}
function viewportPartLayout(part,node){
    if(part.kind==='text')return viewportTextLayout(node);
    return {text:'',rows:[{offset:0,y:viewportObjectY(node)}],yAt:()=>viewportObjectY(node)}
}
let viewportFrame=0;
const viewportObservedPages=new Set();
const viewportResize=new ResizeObserver(scheduleViewportLines);
viewportResize.observe(paneBox);
function scheduleViewportLines(){if(!viewportFrame)viewportFrame=requestAnimationFrame(updateViewportLines)}
function updateViewportLines(){
    viewportFrame=0;
    mirrorHistoryAdditions();
    const pages=[...paneBox.querySelectorAll(':scope > .pane > .page')];
    for(const p of viewportObservedPages)if(!pages.includes(p)){viewportResize.unobserve(p);viewportObservedPages.delete(p)}
    for(const p of pages)if(!viewportObservedPages.has(p)){viewportResize.observe(p);viewportObservedPages.add(p)}
    const live=new Map(),labels=new Map(),hidden=[];
    function label(page,section,owner,index,y,value){
        const list=labels.get(page),x=Math.max(0,section.getBoundingClientRect().left-page.getBoundingClientRect().left-32);
        const last=list.at(-1);
        if(last&&last.owner===owner&&last.index===index&&Math.abs(last.y-y)<9&&value!=='–'&&last.values[0]!=='–'){last.values.push(value);return}
        list.push({owner,index,x,y,values:[value]})
    }
    try{
        for(const page of pages){
            labels.set(page,[]);
            const pane=page.parentElement;
            // Mobile shows one pane at a time. Measure the hidden current pane
            // at the same width without changing its active state or scroll.
            if(!pane.getClientRects().length&&!pane.classList.contains('historicalPane')){pane.classList.add('viewportMeasurePane');hidden.push(pane)}
        }
        for(const page of pages){
            if(page.parentElement.classList.contains('historicalPane'))continue;
            for(const doc of page.querySelectorAll('.visualDocument')){
                if(!doc.getClientRects().length)continue;
                let line=1;const parts=[];
                for(const [index,card] of [...doc.querySelector(':scope > .visualBody').children].entries()){
                    const part=card._part;if(!part)continue;
                    const area=part.kind==='text'?card.querySelector('.richText'):card;
                    const layout=viewportPartLayout(part,area);
                    const start=line;for(const row of layout.rows)label(page,doc,doc._owner,index,row.y,line++);
                    parts.push({part,layout,start})
                }
                if(page.parentElement===paneBox.firstElementChild)live.set(doc._owner,parts)
            }
        }
        for(const page of pages){
            if(!page.parentElement.classList.contains('historicalPane')||!page.getClientRects().length)continue;
            for(const section of page.querySelectorAll('.historyDiffSection,.viewportHistorySection')){
                let line=1;const owner=section._viewportOwner,source=live.get(owner);
                for(const group of section.querySelectorAll(':scope > .viewportDiffPart')){
                    const index=group._viewportIndex,part=group._viewportPart;
                    if(index<0){label(page,section,owner,index,viewportObjectY(group),'–');continue}
                    const current=[...group.children].find(n=>!n.classList.contains('historyRemoved'))||group;
                    const target=part.kind==='text'?viewportTextLayout(group,false):viewportPartLayout(part,current);
                    let baseline=source?.[index];
                    if(!baseline||baseline.part.raw!==part.raw){
                        // A folded/unopened section has no live DOM. Measure
                        // the current part alone, never the mixed diff text.
                        const probe=el('div','viewportLineMeasure');probe.style.width=group.clientWidth+'px';probe.append(historyRenderedPart(part));page.append(probe);
                        const layout=viewportPartLayout(part,probe.firstElementChild);probe.remove();baseline={layout,start:line}
                    }
                    const map=viewportOffsetMap(baseline.layout.text,target.text);
                    line=baseline.start;
                    for(const row of baseline.layout.rows)label(page,section,owner,index,target.yAt(map(row.offset)),line++);
                }
            }
        }
        for(const page of pages){
            const gutter=el('div','viewportLineGutter');gutter.setAttribute('aria-hidden','true');
            const top=page.getBoundingClientRect().top;
            for(const entry of labels.get(page)){
                const v=entry.values,mark=el('span','viewportLineNumber',v.length>1?v[0]+'–'+v.at(-1):String(v[0]));
                mark.dataset.viewportLine=v.join(',');mark.dataset.viewportOwner=entry.owner||'';mark.dataset.viewportPart=String(entry.index);mark.style.left=entry.x+'px';mark.style.top=(entry.y-top)+'px';gutter.append(mark)
            }
            page.querySelector(':scope > .viewportLineGutter')?.remove();page.append(gutter)
        }
    }finally{for(const pane of hidden)pane.classList.remove('viewportMeasurePane')}
}
const viewportDecoration=node=>node.nodeType===1&&node.matches('.viewportLineGutter,.viewportLineMeasure');
new MutationObserver(records=>{
    if(records.some(r=>!r.target.closest?.('.viewportLineGutter,.viewportLineMeasure')&&(r.type!=='childList'||[...r.addedNodes,...r.removedNodes].some(n=>!viewportDecoration(n)))))scheduleViewportLines()
}).observe(paneBox,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['hidden','open']});
window.addEventListener('resize',scheduleViewportLines);
paneBox.addEventListener('load',scheduleViewportLines,true);
document.fonts?.ready.then(scheduleViewportLines);
document.fonts?.addEventListener('loadingdone',scheduleViewportLines);
function renderHistoricalPage(pane,p,pi){
    const h=p.history,{entry,past}=h,toolbar=el('div','toolbar historyPageToolbar'),page=el('article','page historyPreview');
    toolbar.append(btn('切换 首页',()=>{active=0;renderNav();renderPanes()},'mobileOnly'),el('span','historyReadOnly',h.mode==='diff'?'历史差异 · 只读':'历史版本 · 只读'),el('div','spacer'),btn(h.mode==='diff'?'查看历史版本':'查看差异',()=>{h.mode=h.mode==='diff'?'version':'diff';h.scrollTop=0;renderPanes()}),btn('关闭历史',()=>closeHistoricalVersion()));
    page.append(el('h2','historyPreviewHeading',entry.tag?.name||new Date(entry.time).toLocaleString()),el('p','small',entry.id.slice(0,12)+' · '+(entry.message||'')));
    if(h.mode==='diff'){
        const host=el('div','historyPageDiff');page.append(host);renderHistoryDiff(host,h);
        pane.append(toolbar,page);paneBox.append(pane);pane.scrollTop=h.scrollTop||0;
        pane.addEventListener('scroll',()=>{h.scrollTop=pane.scrollTop},{passive:true});return;
    }
    if(!h.objectId){
        const scope=el('select','historySectionSelect');scope.setAttribute('aria-label','历史章节');
        for(const [space,title] of [['thesis','博论树'],['blocks','批注']]){
            const group=el('optgroup');group.label=title;
            for(const n of past[space]){const o=el('option','','　'.repeat(Math.max(0,Math.min(8,(n.level||1)-1)))+(n.title||'未命名'));o.value=n.id;group.append(o)}
            scope.append(group)
        }
        scope.value=h.selected||'';scope.onchange=()=>{h.selected=scope.value;h.scrollTop=0;renderPanes()};page.append(scope);
    }
    const value=h.selected?historicalValue(past,h.selected):null;
    if(value==null)page.append(el('p','muted','此版本中不存在该对象。'));
    else if(typeof value==='string')historicalBody(value,page);
    else if(typeof value.body==='string'){page.append(el('h3','',value.title||'未命名'));historicalBody(value.body,page)}
    page.append(el('p','small muted','历史文本为只读；外部图片仍使用当前登记的资源。'));
    pane.append(toolbar,page);paneBox.append(pane);pane.scrollTop=h.scrollTop||0;
    pane.addEventListener('scroll',()=>{h.scrollTop=pane.scrollTop},{passive:true});
}
async function restoreHistory(entry,objectId){
    if(!confirm('恢复此'+(objectId?'对象':'文档')+'版本？当前版本仍会保留在历史中。'))return;
    if(!await flushDocument())return;
    try{
        await api('/api/history/restore',{id:entry.id,object:objectId,revision:db.revision});
        dialog.close();await syncNow(true);showToast('已恢复历史版本');
    }catch(e){showToast(e.message)}
}
async function showHistory(objectId=null){
    if(!currentWorkspace?.history||!db)return;
    const workspace=currentWorkspace.id,d=showDialog('历史版本');
    const heading=el('div','historyControls'),scope=el('select');scope.setAttribute('aria-label','历史范围');
    const ids=[['','全部文档']];
    const current=objectId||panes[active]?.id;
    if(current)ids.push([current,(resolve(current)?.title||find(current)?.title||(current.startsWith('para-')?'当前段落':current))]);
    for(const [id,label] of ids){const opt=el('option','',label);opt.value=id;scope.append(opt)}
    scope.value=objectId||'';scope.onchange=()=>showHistory(scope.value||null);
    const expand=btn('全部展开',()=>{const groups=[...list.querySelectorAll('details.historyGroup')];const opened=groups.every(x=>x.open);groups.forEach(x=>x.open=!opened);expand.textContent=opened?'全部展开':'全部折叠'});
    heading.append(scope,expand);d.append(heading);
    const list=el('div','historyList');d.append(list);
    let entries=[],more=true,loading=null,viewSequence=0;
    const valid=()=>dialog.open&&d.contains(list)&&list.isConnected&&workspace===currentWorkspace?.id;
    function date(t){return new Date(t).toLocaleDateString()}
    function clock(t){return new Date(t).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}
    const auto=entry=>!entry.tag&&['editor','migration','initial'].includes(entry.source);
    const sameGroup=(newer,older)=>auto(newer)&&auto(older)&&date(newer.time)===date(older.time)&&Math.abs(new Date(newer.time)-new Date(older.time))<=5*60*1000;
    async function preview(entry,grouped=false,compareLive=false){
        const token=++viewSequence;
        try{
            let base=null;
            if(!compareLive){
                let i=entries.findIndex(x=>x.id===entry.id);
                if(i<0)return;
                while(true){
                    if(i+1>=entries.length&&more){if(!await fetchMore()||!valid()||token!==viewSequence)return;continue}
                    if(grouped&&entries[i+1]&&sameGroup(entries[i],entries[i+1])){i++;continue}
                    base=entries[i+1]||null;break;
                }
            }
            const [past,baseDoc]=await Promise.all([api(historyURL('/api/history/item',{id:entry.id})),base?api(historyURL('/api/history/item',{id:base.id})):null]);
            if(!valid()||token!==viewSequence)return;
            openHistoricalVersion(entry,past,objectId,'diff',compareLive?null:{entry:base,doc:baseDoc||{thesis:[],blocks:[]}});
        }catch(e){if(valid())showToast(e.message)}
    }
    function row(entry){
        const r=el('div','historyRow'),name=el('span','historyName',entry.tag?.name||entry.message||'自动保存'),meta=el('span','small',clock(entry.time)+' · '+entry.id.slice(0,8));r.dataset.commit=entry.id;
        const title=el('div','historyTitle');title.append(name,meta);r.append(title);
        async function viewVersion(){
            const token=++viewSequence;
            try{const past=await api(historyURL('/api/history/item',{id:entry.id}));if(valid()&&token===viewSequence)openHistoricalVersion(entry,past,objectId)}
            catch(e){if(valid())showToast(e.message)}
        }
        title.onclick=()=>preview(entry);
        async function setName(value,clear=false){
            try{const result=await api('/api/history/tag',{id:entry.id,name:value,clear});entry.tag=result.tag;draw()}
            catch(e){showToast(e.message)}
        }
        function rename(){
            const input=el('input','historyRename');input.value=entry.tag?.name||new Date(entry.time).toLocaleString();input.maxLength=200;input.setAttribute('aria-label','版本名称');
            name.replaceWith(input);input.focus();input.select();
            for(const type of ['contextmenu','pointerdown'])input.addEventListener(type,e=>e.stopPropagation());
            input.onkeydown=e=>{e.stopPropagation();if(e.key==='Enter'){e.preventDefault();const value=input.value.trim();if(value)setName(value);else showToast('请输入版本名称')}else if(e.key==='Escape'){e.preventDefault();input.replaceWith(name)}};
            input.onblur=()=>{if(input.isConnected)input.replaceWith(name)};
        }
        const menu=()=>[['查看历史版本',viewVersion],['查看差异',()=>preview(entry,false,true)],['复制版本 ID',()=>copy(entry.id)],['恢复版本',()=>restoreHistory(entry,objectId)],['设置版本名称',rename],...(entry.tag?[['清除版本名称',()=>setName(null,true)]]:[])];
        context(r,menu,null,true);
        r.append(btn('⋯',e=>menuAt(e,menu()),'historyMore'));if(entry.tag)r.classList.add('named');return r;
    }
    function draw(){
        const opened=new Set([...list.querySelectorAll('details[open]')].map(x=>x.dataset.group));
        list.replaceChildren();
        let day='',group=null,last=null;
        for(const entry of entries){
            const nextDay=date(entry.time);
            if(day!==nextDay){day=nextDay;group=null;list.append(el('h4','historyDate',day))}
            if(!auto(entry)){group=null;list.append(row(entry))}
            else{
                if(!group||!last||!sameGroup(last,entry)){
                    group=el('details','historyGroup');group.dataset.group=entry.id;group.open=opened.has(entry.id);
                    const summary=el('summary'),versions=group,groupTitle=btn('',e=>{e.preventDefault();e.stopPropagation();preview(entry,true)},'historyGroupTitle');summary.append(groupTitle);group.append(summary);group._summary=groupTitle;group._count=0;group._first=entry.time;list.append(group);
                    context(summary,()=>[[versions.open?'折叠版本组':'展开版本组',()=>{versions.open=!versions.open}],['查看差异',()=>preview(entry,true,true)]],null,true);
                    versions.addEventListener('toggle',()=>{expand.textContent=[...list.querySelectorAll('details.historyGroup')].every(x=>x.open)?'全部折叠':'全部展开'});
                }
                group.append(row(entry));group._count++;group._summary.textContent=clock(entry.time)+'–'+clock(group._first)+' · '+group._count+' 个自动版本';
            }
            last=entry;
        }
        if(!entries.length)list.append(el('p','muted','没有相关历史'));
        if(more)list.append(btn('加载更多',fetchMore));
    }
    async function fetchMore(){
        if(!valid())return false;if(loading)return loading;
        loading=(async()=>{
            try{const result=await api(historyURL('/api/history',{offset:entries.length,limit:100,...(objectId?{object:objectId}:{})}));if(!valid())return false;entries.push(...result.items);more=!!result.more&&result.items.length>0;draw();return true}
            catch(e){if(valid())showToast(e.message);return false}
        })();
        try{return await loading}finally{loading=null}
    }
    list.append(el('p','small','加载历史…'));await fetchMore();
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
        updateHistoryControls();
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
        try{const draft=await draftAccess(draftKey(),null,true);if(draft?.base&&draft?.local){Object.assign(db,clone(draft.local),{revision:draft.revision});syncBase=draft.base;dirty=true;reindex();renderNav();renderPanes();await reconcile(result,draft.base,draft.local);if(conflict)showSyncConflict();else showToast('已恢复本地未保存草稿。')}}catch(e){console.warn(e);showToast('无法读取本地草稿。')}
    }catch(e){readingReady=false;db=null;currentWorkspace=null;updateHistoryControls();readingRestored=false;nav.replaceChildren();$('sideTools').replaceChildren();$('workspaceName').textContent='PaperEditer';for(const id of ['treeTab','blockTab','dual','newNode','search'])$(id).disabled=true;status('未打开文件');paneBox.replaceChildren(el('p','empty',e.message));console.error(e)}
    finally{syncLoading=false;if(dirty&&!conflict&&!workspaceChanged){clearTimeout(timer);timer=setTimeout(save,100)}}
}
function mobileClose(){$('sidebar').classList.remove('open');$('overlay').classList.remove('show')}
function setView(v){
    $('menu').hidden=true;
    if(panes[active]?.history?.mode==='diff')active=0;
    else if(panes[active]?.history)closeHistoricalVersion(false);
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
    if(pi===1&&panes[1]?.history?.mode==='diff')pi=0;
    if(pi>=panes.length)panes.push({id:null,edit:false});
    replacePane(pi,id,object);active=pi;view=spaceOf(id);
    $('treeTab').classList.toggle('active',view==='thesis');$('blockTab').classList.toggle('active',view==='blocks');
    ancestors(find(id)).forEach(x=>open.add(x));mobileClose();renderNav();renderPanes();
    if(object)setTimeout(()=>{const p=paneBox.children[pi];const t=[...p.querySelectorAll('[data-object]')].find(e=>e.dataset.object===object);if(t){let a=t.parentElement;while(a&&a!==p){if(a.tagName==='DETAILS')a.open=true;a=a.parentElement}t.classList.add('highlight');t.scrollIntoView({block:'center',behavior:'smooth'});setTimeout(()=>t.classList.remove('highlight'),2500)}},80);
}
function jump(id,other=false){const t=resolve(id);if(!t){showToast('未找到引用：'+id);return}select(t.owner,other?(active===0?1:0):active,t.kind==='node'?null:(t.actualId||t.id))}
async function copy(s){await writeEditorClipboard(s);showToast('已复制，可直接粘贴')}
function menuAt(e,items,anchor=null){
    items=modeMenuItems(items,e.target||toolbarContext()?.event.target);
    const m=$('menu');(dialog.open?dialog:document.body).append(m);m.replaceChildren();for(const [s,fn,disabled] of items){const b=btn(s,()=>{m.hidden=true;fn()});b.disabled=!!disabled;m.append(b)}m.hidden=!items.length;if(!items.length)return;
    m._toolbarAnchor=anchor;m.style.transform='';m.style.transformOrigin='top left';m.style.width='';m.style.maxWidth='';
    if(anchor){positionToolbarMore();return}
    const v=window.visualViewport,w=v?.width||innerWidth,h=v?.height||innerHeight,ox=v?.offsetLeft||0,oy=v?.offsetTop||0;
    m.style.maxHeight=Math.max(60,h-8)+'px';const x=e.clientX??15,y=e.clientY??70;m.style.left=Math.max(ox+4,Math.min(x,ox+w-m.offsetWidth-5))+'px';m.style.top=Math.max(oy+4,Math.min(y,oy+h-m.offsetHeight-5))+'px';
}
let localClipboard=null, localClipboardPreferred=false, touchMenuAt=0,lastTouchPointerAt=0;
function touchContextEvent(e){return e.pointerType==='touch'||e.sourceCapabilities?.firesTouchEvents||Date.now()-lastTouchPointerAt<1800}
const isActionSurface=e=>!!e?.closest?.('#menu,#floatingTools,#headerActions,.mathPalette,.ML__keyboard');
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
const MORE_TOOL='更多操作';
const MORE_ACTIONS=new Set(['添加公式','添加独立公式','插入交叉引用']);
const readOnlyActions=new Set(['复制','复制交叉引用','复制批注','复制正文（含公式源码）','复制对象源码','复制公式','高级：复制源码','当前页定位','另一页打开','定位批注','查看原图','打开批注','展开内容','折叠内容','展开下级','折叠下级','保存','查看历史版本','查看差异','复制版本 ID','恢复版本','展开版本组','折叠版本组','设置版本名称','清除版本名称']);
// Annotation editing is independent of the global thesis editing switch.
function canEditControl(node){return editingEnabled||!!(node?._noteEditor||node?.closest?.('.visualDocument')?._internalObjects)}
function modeMenuItems(items,target){
    if(editingEnabled)return items;
    const note=canEditControl(target);
    return items.map(([name,fn,disabled])=>[name,fn,!!disabled||!(readOnlyActions.has(name)||name==='新建批注'||note&&name!=='删除批注'&&(!['撤销','重做'].includes(name)||dialog.open))])
}
function requireEditMode(target=null){
    if(!dialog.open&&panes[active]?.history){showToast('历史版本只读，请切换到当前文档');return false}
    if(canEditControl(target))return true;
    showToast('当前为查看模式，请先切换到编辑模式');return false
}
function setEditorControlMode(node){
    const editingEnabled=canEditControl(node);
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
    for(const doc of document.querySelectorAll('.visualDocument'))doc._syncRange?.();
    $('newNode').disabled=!editingEnabled;
    for(const b of document.querySelectorAll('.annotationDelete,.createBlockButton'))b.disabled=!editingEnabled;
    const b=$('editModeToggle');
    if(b){
        setToolIcon(b,editingEnabled?'edit':'eye');
        b.setAttribute('aria-label',editingEnabled?'编辑模式（切换到查看模式）':'查看模式（切换到编辑模式）');
        b.setAttribute('aria-pressed',String(editingEnabled));b.classList.toggle('active',editingEnabled);
    }
    scheduleToolbarUpdate()
}
function toggleEditMode(){
    let mobileFocus=null;
    if(!editingEnabled&&matchMedia('(pointer:coarse), (max-width:760px)').matches&&!dialog.open&&!panes[active]?.history){
        const pane=paneBox.children[active],box=pane?.getBoundingClientRect(),s=getSelection();
        const mixedDoc=[...(pane?.querySelectorAll('.visualDocument')||[])].find(d=>d._mixedRange?.());
        const r=mixedDoc?._mixedRange()?.cloneRange()||(s?.rangeCount?s.getRangeAt(0).cloneRange():null);
        const area=r&&(r.endContainer.nodeType===1?r.endContainer:r.endContainer.parentElement)?.closest('.part-text .richText');
        if(area&&pane?.contains(area)&&area.getClientRects().length){r.collapse(false);mobileFocus={area,range:r}}
        else if(box){
            const candidates=[...pane.querySelectorAll('.part-text .richText')].filter(a=>{const b=a.getBoundingClientRect();return b.height&&b.bottom>Math.max(box.top,0)&&b.top<Math.min(box.bottom,innerHeight)});
            const target=candidates[0];if(target){const b=target.getBoundingClientRect(),y=Math.max(b.top+1,box.top+1,pane.querySelector(':scope > .toolbar')?.getBoundingClientRect().bottom+1||0);const hit=document.caretRangeFromPoint?.(b.left+4,y+8);const range=hit&&target.contains(hit.startContainer)?hit:document.createRange();if(range!==hit){range.selectNodeContents(target);range.collapse(true)}mobileFocus={area:target,range}}
        }
        mixedDoc?._clearMixed?.();
    }
    if(editingEnabled){
        const focus=document.activeElement;
        if(focus?.closest('.richText,.editableTitle,math-field'))focus.blur();
        window.mathVirtualKeyboard?.hide()
    }
    editingEnabled=!editingEnabled;
    $('menu').hidden=true;hideToolHint();syncEditMode();
    // Focus synchronously inside the mode button's user gesture so mobile
    // browsers are allowed to open the system keyboard.
    if(mobileFocus?.area.isConnected&&mobileFocus.area.isContentEditable){
        const {area,range}=mobileFocus;clearNoteLabel();area.focus({preventScroll:true});const s=getSelection();s.removeAllRanges();s.addRange(range)
    }
    showToast(editingEnabled?'编辑模式：点击正文或公式输入':'查看模式：已关闭正文编辑')
}
// These guards also cover native paste/drop/delete shortcuts and touch gestures.
for(const type of ['beforeinput','cut','paste','drop','dragstart'])document.addEventListener(type,e=>{
    if(canEditControl(e.target)||!e.target.closest?.('.visualDocument,.editableTitle,.navrow'))return;
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
    undo:'<path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"/>',
    redo:'<path d="m15 14 5-5-5-5m5 5H10a6 6 0 0 0 0 12h3"/>',
    more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
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
    const scale=hintButton.closest('#floatingTools')&&matchMedia('(pointer: coarse), (max-width: 760px)').matches?1/(v?.scale||1):1;
    tip.style.transformOrigin='top left';tip.style.transform=scale===1?'':`scale(${scale})`;
    const r=hintButton.getBoundingClientRect(),tw=tip.offsetWidth*scale,th=tip.offsetHeight*scale,pad=4*scale,gap=8*scale,above=r.top-th-gap;
    tip.style.left=Math.max(ox+pad,Math.min(r.left+(r.width-tw)/2,ox+w-tw-pad))+'px';
    tip.style.top=Math.max(oy+pad,Math.min(above>=oy+pad?above:r.bottom+gap,oy+h-th-pad))+'px'
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
        else if(['剪切','复制','粘贴','新建批注'].includes(button.dataset.tool)&&button.getAttribute('aria-disabled')!=='true'&&[...document.querySelectorAll('.visualDocument')].some(d=>d._mixedRange?.())){
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
function localRangeArea(r){
    if(!r)return null;
    const a=(r.startContainer.nodeType===Node.ELEMENT_NODE?r.startContainer:r.startContainer.parentElement)?.closest('.richText');
    return a?.contains(r.endContainer)?a:null
}
function toolbarContext(){
    if(!dialog.open&&panes[active]?.history)return null;
    const scope=dialog.open?dialog:paneBox.children[active];
    if(!scope)return null;
    const usable=t=>t?.isConnected&&scope.contains(t)&&t.getClientRects().length;
    let target=usable(toolbarTarget)?toolbarTarget:null;
    const s=getSelection(),r=s?.rangeCount?s.getRangeAt(0):null;
    const rangeTarget=r&&(r.startContainer.nodeType===Node.ELEMENT_NODE?r.startContainer:r.startContainer.parentElement)?.closest('.richText');
    const mixedDoc=[...scope.querySelectorAll('.visualDocument')].find(d=>d._mixedRange?.());
    const selected=scope.querySelector('.selectedNoteLabel')||scope.querySelector('.selectedImage,.selectedObject'),focus=document.activeElement;
    if(selected?.classList.contains('selectedNoteLabel')&&usable(selected))target=selected;
    else if(mixedDoc&&usable(mixedDoc))target=localRangeArea(mixedDoc._mixedRange())||mixedDoc;
    else if(selected&&usable(selected))target=selected;
    else if(usable(rangeTarget)&&(!target||target.closest('.richText')===rangeTarget||focus===rangeTarget))target=rangeTarget;
    else if(usable(focus)&&focus.matches('input,textarea,math-field,.richText'))target=focus;
    else if(!target||target.closest('.toolbar,button:not(.objectNoteMarker,.freeNoteMarker),.noteResizeHandle'))target=[...scope.querySelectorAll('.richText,.visualDocument,.page')].find(t=>usable(t)&&t.matches('.richText'))||scope.querySelector('.visualDocument,.page')||scope;
    const rect=target.getBoundingClientRect();
    const rr=mixedDoc?._mixedRange()?.getBoundingClientRect()||(r&&rangeTarget===target?r.getBoundingClientRect():null);
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
    if(!canEditControl(toolbarContext()?.event.target)&&!readOnlyActions.has(label)&&label!=='新建批注'){requireEditMode();return}
    const item=currentToolbarItems().find(i=>i[0]===label);
    if(item&&!item[2])item[1]();
    else showToast(['剪切','复制'].includes(label)?'请先选中文本或对象':'请先定位正文或对象');
}
function toolbarUndo(redo){
    if(!dialog.open&&panes[active]?.history)return;
    const root=dialog.open&&dialog.querySelector('.visualDocument');
    if(!requireEditMode(root))return;
    if(root?._draftHistory)root._draftHistory(redo);
    else if(!dialog.open)undo(redo)
}
function toolbarMore(){
    const m=$('menu'),anchor=$('toolbarMore');
    if(!m.hidden&&m._toolbarAnchor===anchor){m.hidden=true;return}
    menuAt({},currentToolbarItems().filter(i=>MORE_ACTIONS.has(i[0])),anchor)
}
function positionToolbarMore(){
    const m=$('menu'),anchor=m._toolbarAnchor;if(m.hidden||!anchor)return;
    if(!anchor.getClientRects().length){m.hidden=true;return}
    const v=window.visualViewport,w=v?.width||innerWidth,h=v?.height||innerHeight,ox=v?.offsetLeft||0,oy=v?.offsetTop||0;
    const scale=matchMedia('(pointer: coarse), (max-width: 760px)').matches?1/(v?.scale||1):1;
    const r=anchor.getBoundingClientRect(),pad=4*scale,gap=6*scale;
    m.style.transform=scale===1?'':`scale(${scale})`;
    m.style.width='max-content';m.style.maxWidth=Math.max(0,w/scale-8)+'px';
    m.style.maxHeight=Math.max(0,Math.max(r.top-oy,oy+h-r.bottom)/scale-10)+'px';
    const mw=m.offsetWidth*scale,mh=m.offsetHeight*scale,above=r.top-mh-gap;
    m.style.left=Math.max(ox+pad,Math.min(r.right-mw,ox+w-mw-pad))+'px';
    m.style.top=Math.max(oy+pad,Math.min(above>=oy+pad?above:r.bottom+gap,oy+h-mh-pad))+'px'
}
function positionFloatingTools(){
    const bar=$('floatingTools');if(bar.hidden)return;
    const v=window.visualViewport,w=v?.width||innerWidth,h=v?.height||innerHeight,ox=v?.offsetLeft||0,oy=v?.offsetTop||0;
    const mobile=matchMedia('(pointer: coarse), (max-width: 760px)').matches;
    // VisualViewport dimensions are in layout CSS pixels. Counteract native pinch zoom for the dock only.
    const scale=mobile?1/(v?.scale||1):1;
    bar.style.transformOrigin='top left';bar.style.transform=scale===1?'':`scale(${scale})`;
    // Fixed auto-width boxes shrink to fit the space after their previous left.
    // Keep intrinsic layout width independent of the panned viewport position.
    bar.style.width=mobile?'max-content':'';
    if(mobile){
        bar.style.maxWidth=Math.max(0,w/scale-16)+'px';
        const bw=bar.offsetWidth*scale,bh=bar.offsetHeight*scale,pad=8*scale;
        const x=ox+(w-bw)/2;let y=oy+h-bh-12*scale;
        const keyboard=window.mathVirtualKeyboard;
        if(keyboard?.visible&&keyboard.boundingRect?.height>0)y=Math.min(y,keyboard.boundingRect.top-bh-pad);
        bar.style.left=Math.max(ox+pad,Math.min(x,ox+w-bw-pad))+'px';
        bar.style.top=Math.max(oy+pad,y)+'px';positionToolHint();positionToolbarMore();return
    }
    bar.style.maxWidth=Math.max(0,w-16)+'px';
    let x=ox+(w-bar.offsetWidth)/2,y=oy+h-bar.offsetHeight-12;
    const scope=dialog.open?dialog:paneBox.children[active],s=getSelection(),r=s?.rangeCount?s.getRangeAt(0):null;
    const a=r&&(r.startContainer.nodeType===Node.ELEMENT_NODE?r.startContainer:r.startContainer.parentElement)?.closest('.richText');
    const selected=scope?.querySelector('.selectedNoteLabel')||scope?.querySelector('.selectedImage,.selectedObject'),focus=document.activeElement;
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
    positionToolHint();positionToolbarMore()
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
            if(!dialog.open&&panes[active]?.history){b.setAttribute('aria-disabled','true');continue}
            if(label===MODE_TOOL){b.setAttribute('aria-disabled','false');continue}
            if(label===MORE_TOOL){b.setAttribute('aria-disabled',String(!items.some(i=>MORE_ACTIONS.has(i[0])&&!i[2])));continue}
            if(!canEditControl(toolbarContext()?.event.target)&&!readOnlyActions.has(label)&&label!=='新建批注'){b.setAttribute('aria-disabled','true');continue}
            if(label==='撤销'||label==='重做'){
                const draft=dialog.open&&dialog.querySelector('.visualDocument');
                b.setAttribute('aria-disabled',String(draft?!(draft._canDraftHistory?.(label==='重做')):!editingEnabled||dialog.open||!(label==='撤销'?undoStack:redoStack).length));
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
    const doc=e.target.closest('.visualDocument');
    // Touch range selection uses the dock, not an automatic context popup.
    // Keep explicit object/structure menus for targets without text selection.
    const s=getSelection();
    if(doc?._mixedRange?.()||(doc&&s&&!s.isCollapsed&&doc.contains(s.anchorNode)&&doc.contains(s.focusNode))||(e.target.closest('.richText')&&!e.target.closest('.resizeImage,.visualRef,.inlineAnnotation'))||e.target.closest('math-field')?.selectionIsCollapsed===false){
        $('menu').hidden=true;scheduleToolbarUpdate();return
    }
    menuAt(e,items)
}
function initFloatingTools(){
    const bar=$('floatingTools');
    const mode=toolIcon(btn('',toggleEditMode),'eye',MODE_TOOL);mode.id='editModeToggle';bar.append(mode);
    for(const [name,label] of [['cut','剪切'],['copy','复制'],['paste','粘贴'],['note','新建批注']])bar.append(toolIcon(btn('',()=>toolbarAction(label)),name,label));
    bar.append(toolIcon(btn('',()=>toolbarUndo(false)),'undo','撤销'),toolIcon(btn('',()=>toolbarUndo(true)),'redo','重做'));
    const more=toolIcon(btn('',toolbarMore),'more',MORE_TOOL);more.id='toolbarMore';more.setAttribute('aria-haspopup','menu');bar.append(more);
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
    const show=ev=>{hideFloatingTools();if(touchContextEvent(ev)){touchMenuAt=Date.now();ev.target.closest('.visualDocument')?._prepareTouchRange?.(ev);ev.useCurrentSelection=true;showFloatingTools(ev,get(ev))}else menuAt(ev,get(ev))};
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
document.addEventListener('pointerdown',e=>{lastTouchPointerAt=e.pointerType==='touch'?Date.now():0;if(!isActionSurface(e.target)){hideToolHint();rememberToolbarTarget(e);$('menu').hidden=true}},true);
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
    const logical=e.target.closest('.visualDocument')?._mixedRange?.();
    const r=logical?.cloneRange()||(prior&&Date.now()-prior.time<2000&&Math.hypot(e.clientX-prior.x,e.clientY-prior.y)<32?prior.range:s?.rangeCount?s.getRangeAt(0).cloneRange():null);
    if(!r||!pane.contains(r.startContainer)||!pane.contains(r.endContainer))return null;
    const rangeDoc=e.target.closest('.visualDocument');
    if(!r.collapsed&&rangeDoc?.contains(r.startContainer)&&rangeDoc.contains(r.endContainer)&&!localRangeArea(r))return rangeDoc._rangeAnnotationBinding?.(r)||null;
    const startElement=r.startContainer.nodeType===Node.ELEMENT_NODE?r.startContainer:r.startContainer.parentElement;
    const area=startElement?.closest('.richText'),doc=area?.closest('.visualDocument');
    if(!area||!doc?._owner||!doc._insertBoundAnnotation)return null;
    const rects=[...r.getClientRects()],pad=r.collapsed?22:10;
    if(!rects.some(x=>near(x,pad))&&!near(r.getBoundingClientRect(),pad))return null;
    const quote=r.collapsed?{quote:''}:annotationQuote(r);
    const start=r.cloneRange();start.collapse(true);
    return {doc,area,range:start,...quote,owner:find(doc._owner),mode:r.collapsed?'caret':'selection'};
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
    const pages=[...paneBox.querySelectorAll('.pane:not(.historicalPane) > .page')].filter(p=>p.parentElement._readingPane?.id===placement.pageId&&p.getClientRects().length);
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
    if(objectNoteBindings(n).some(x=>x.targetId===binding.targetId)){showToast('该批注已绑定此对象');return}
    checkpoint();n.objectBindings=[...objectNoteBindings(n),{targetId:binding.targetId,floatOffset:{x:14,y:8}}];change(false)
}
function simpleContextMenu(e,explicit){
    const noteLabel=e.target.closest(noteLabelSelector);
    if(noteLabel?._openNote)return modeMenuItems(noteLabelMenu(noteLabel),noteLabel);
    const rangeDoc=e.target.closest('.visualDocument');
    if(rangeDoc?._mixedRange?.()&&!localRangeArea(rangeDoc._mixedRange()))return modeMenuItems(rangeDoc._clipboardMenu(e),e.target);
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
    const prose=!!(pane&&owner&&spaceOf(owner.id)==='thesis'&&!draft&&!source&&!e.target.closest('button,input,textarea,select,.toolbar,.editableHeading,.breadcrumb,summary,.blockcard,.cards,.visualRef,[data-object],.resizeHandle,.noteResizeHandle'));
    const objectBinding=!draft&&source&&spaceOf(source.owner)==='thesis'?objectAnnotationBinding(source,e):null;
    const binding=objectBinding||(prose?annotationBinding(e,pane):null);
    const result=editorClipboardMenu(e);
    // Surrounding document whitespace has no editable host. Route its paste
    // action to the nearest document just like the insertion menu.
    if(prose&&!rangeDoc&&doc?._clipboardMenu){
        const paste=doc._clipboardMenu({target:doc,clientX:e.clientX,clientY:e.clientY,preview:true}).find(i=>i[0]==='粘贴');
        if(paste)result.push(paste)
    }
    // Insertion lives in the context menu, not a persistent button in the text.
    const insertDoc=e.target.closest('.visualDocument')||(prose?doc:null);
    if(insertDoc?._contentInsertMenu)result.push(...insertDoc._contentInsertMenu(e));
    if(prose||objectBinding)result.push(['新建批注',()=>newAnnotation(binding,e)]);
    if(texTarget(source)&&!draft&&spaceOf(owner?.id)!=='blocks')result.push(['复制交叉引用',()=>copy(refToken(source))]);
    const noteId=draft?dialog._noteId:(source?.kind==='node'&&spaceOf(source.id)==='blocks'?source.id:pane&&owner&&spaceOf(owner.id)==='blocks'?owner.id:null);
    if(noteId&&find(noteId))result.push(['删除批注',()=>deleteNode(find(noteId))]);
    return modeMenuItems(result,e.target);
}
function newAnnotation(binding,e){
    const origin=binding?.owner,quote=binding?.quote;
    const freePlacement=!binding?freeNoteLocation(e):null;
    const initial='';
    newNode('blocks',null,initial,'',id=>{
        if(binding?.mode==='object'){showToast('批注已绑定对象');return}
        if(binding&&!binding.doc._insertBoundAnnotation(id,binding))showToast('原文字位置已变化，批注已保留但未绑定');
        else showToast(binding?'批注已创建并绑定':freePlacement?'批注已保留在创建位置':'已创建批注')
    },{floating:true,x:e.clientX,y:e.clientY,annotation:true,binding,freePlacement,anchorRect:binding?.mode==='object'?binding.anchorRect:binding?()=>binding.area.isConnected?binding.range.getBoundingClientRect():null:freePlacement?()=>freeNoteAnchor(freePlacement):null});
}
function refToken(t){return '[['+(t.kind==='equation'?'eqref':'ref')+':'+(t.actualId||t.id)+']]'}
function refMenu(t){return [...(texTarget(t)?[['复制交叉引用',()=>copy(refToken(t))]]:[]),['当前页定位',()=>jump(t.id)],['另一页打开',()=>jump(t.id,true)]]}
function nodeMenu(n){return spaceOf(n.id)==='blocks'?[...annotationLocationMenu(n),['删除批注',()=>deleteNode(n)]]:treeNodeMenu(n)}
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
    $('newNode').hidden=view==='blocks';
    if(view==='blocks'){
        $('sideTools').replaceChildren();$('newNode').title='新建批注';
        nav.append(btn('批注一览',()=>{if(panes[active]?.history?.mode==='diff')active=0;replacePane(active,null);renderPanes();mobileClose()},'navlabel'));
        const query=search.trim().toLowerCase();
        for(const n of db.blocks.filter(n=>(n.title+' '+n.body).toLowerCase().includes(query))){
            const row=el('div','navrow'+(panes[active].id===n.id?' selected':''));row.dataset.nodeId=n.id;
            row.append(el('span','navlabel',n.title),btn('⋯',e=>menuAt(e,nodeMenu(n))));
            row.addEventListener('click',()=>select(n.id));context(row,()=>nodeMenu(n),null,true);nav.append(row)
        }
        rememberPosition();return
    }
    const branches=db[view].filter(n=>children(view,n.id).length).map(n=>n.id);
    const collapsed=branches.every(id=>!open.has(id));
    const foldButton=btn(collapsed?'全部展开':'全部折叠',()=>{
        for(const n of db[view]){if(collapsed){if(children(view,n.id).length)open.add(n.id)}else open.delete(n.id)}
        renderNav()
    },'foldAllButton navFoldButton');
    foldButton.disabled=!branches.length;foldButton.title='仅展开或折叠导航目录';
    $('sideTools').replaceChildren(foldButton);
    $('newNode').title=view==='blocks'?'新建批注':'新建章节';
    const list=db[view];
    const query=search.trim().toLowerCase();
    function add(n,depth,hit=false){
        const row=el('div','navrow treeNavRow'+(panes[active].id===n.id?' selected':''));
        row.style.paddingLeft=Math.min(depth,8)*12+'px';row.dataset.nodeId=n.id;row.draggable=true;
        const kids=children(view,n.id);
        const toggle=btn(kids.length?(open.has(n.id)?'▾':'▸'):'·',()=>{if(open.has(n.id))open.delete(n.id);else open.add(n.id);renderNav()},'navToggle');
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
    if(!list.length)nav.append(el('div','empty','尚无章节，点击 ＋ 新建。'));
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
    const s=spaceOf(n.id),kids=s==='blocks'?[]:descendants(s,n.id);
    if(s==='blocks'&&!trashSupported){showToast('请先重启工作台服务以启用回收站');return}
    const nodeIds=new Set([n.id,...kids.map(x=>x.id)]);
    if(s==='blocks'&&dialog.open&&nodeIds.has(dialog._noteId))closeWorkbenchDialog();
    const ids=new Set([...nodeIds,...[n,...kids].flatMap(objectIds),...[...targets.values(),...aliases.values()].filter(t=>nodeIds.has(t.owner)).map(t=>t.id)]);
    const count=all().filter(x=>!ids.has(x.id)&&[...x.body.matchAll(refPattern())].some(m=>ids.has(m[2])&&(s!=='blocks'||m[1]!=='embed'))).length;
    if(s!=='blocks'&&!confirm('删除“'+n.title+'”'+(kids.length?'及 '+kids.length+' 个下级':'')+'？'+(count?'有 '+count+' 个节点引用其中对象，删除会留下失效交叉引用。':'')))return;
    if(dialog.open&&ids.has(dialog._noteId))closeWorkbenchDialog();
    checkpoint();
    if(s==='blocks'){
        const entry={id:uid(),deletedAt:new Date().toISOString(),nodes:clone([n,...kids]),anchors:[],bindings:[]};
        for(const child of db.blocks)if(child.parent===n.id){child.parent=null;child.level=1}
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
    db.trash=db.trash.filter(x=>x.id!==entry.id);splitLegacyAnnotationPlacements();change(true);showTrash();
    if(missed)showToast('批注已恢复，'+missed+' 处引用或绑定位置已变化，请重新关联');
}
function showTrash(){
    const d=showDialog('回收站');
    if(!db.trash.length){d.append(el('p','muted','回收站为空'));return}
    for(const entry of db.trash){
        const row=el('div','trashRow'),info=el('div');
        info.append(el('strong','',entry.nodes[0].title),el('div','small',new Date(entry.deletedAt).toLocaleString()+(entry.nodes.length>1?' · '+entry.nodes.length+' 个批注':'')));
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
    clearNoteLabel();
    dialog._commitNote=null;
    dialog._noteId=null;
    dialog._noteValue=null;
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
function remapCopiedObjects(s,own=null,force=false,map=new Map()){
    const occupied=occupiedObjectIds();
    s=s.replace(objectPattern(),(m,k,id)=>{
        if(force||occupied.has(id))map.set(id,k+'-'+uid());
        if(k==='figure'){
            m=normalizeFigureImages(m,id);
            m=m.replace(figureImagePattern(),(full,alt,url,title)=>{
                const child=figureImageId(title,id,0);
                if(force||occupied.has(child))map.set(child,'subfig-'+uid());
                return figureImageMarkup(alt,url,title,map.get(child)||child)
            })
        }
        return map.has(id)?m.replace(':::'+k+' '+id,':::'+k+' '+map.get(id)):m
    });
    return s.replace(refPattern(),(m,k,id)=>map.has(id)?'[['+k+':'+map.get(id)+']]':m)
}
function createBlockFrom(body,title,id){newNode('blocks',null,body+'\n\n来源：[[ref:'+id+']]\n',title+' · 批注')}
function undo(redo){endTypingUndo();if(!requireEditMode())return;const a=redo?redoStack:undoStack,b=redo?undoStack:redoStack;if(!a.length){showToast('无可'+(redo?'重做':'撤销')+'的操作');return}b.push(editableSnapshot());const s=a.pop();db.thesis=s.thesis;db.blocks=s.blocks;db.trash=s.trash;panes.forEach(p=>{if(!find(p.id))p.id=null});change(true)}
function math(e,tex,display=false){
    try{katex.render(tex,e,{displayMode:display,throwOnError:false,strict:'ignore',trust:false,macros:{'\\textmu':'\\mu'}})}
    catch(err){e.textContent=tex;e.title=err.message}
}
function refSpan(kind,id){
    if(kind==='cite'){const s=el('span','muted','['+id.replaceAll(',',', ')+']');s.title='参考文献键：'+id;return s}
    const note=db.blocks.find(n=>n.id===id);if(note)return el('span','muted',note.title);
    const t=resolve(id);
    if(!t)return el('span','badref','〔未解析：'+id+'〕');
    const title=t.kind==='node'?(t.number||t.title):t.number||t.title||id;
    const s=el('a','ref',kind==='eqref'?'('+title+')':title);s.href='#';s.dataset.ref=id;s.title=t.title||id;
    s.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();jump(id,e.shiftKey)});
    context(s,()=>refMenu(t),()=>resolve(t.id)||t);return s
}
function showImagePreview(src,alt){
    const name=decodeURIComponent(new URL(src,location.href).pathname.split('/').pop());
    const d=showDialog(alt||name||'图片'),f=el('img','imagefull'),actions=el('div','imagePreviewActions'),status=el('div','imagePreviewStatus');
    f.src=src;f.alt=alt||name;f.draggable=false;
    // Preserve the browser's native image menu (also useful on HTTP clients
    // that cannot use the async system clipboard).
    for(const type of ['contextmenu','pointerdown'])f.addEventListener(type,e=>e.stopPropagation());
    status.setAttribute('role','status');
    const copyButton=btn('复制图像',async()=>{
        if(!navigator.clipboard?.write||!window.ClipboardItem){status.textContent='当前浏览器不支持直接复制，请右键或长按图片复制';return}
        copyButton.disabled=true;status.textContent='';
        try{
            // Start the clipboard write during the click, before awaiting
            // network/decoding work, to retain browser user activation.
            const png=fetch(src).then(async response=>{
                if(!response.ok)throw new Error('Image unavailable');
                const blob=await response.blob();
                if(blob.type==='image/png')return blob;
                const bitmap=await createImageBitmap(blob);
                try{
                    const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
                    canvas.getContext('2d').drawImage(bitmap,0,0);
                    return await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('PNG conversion failed')),'image/png'));
                }finally{bitmap.close()}
            });
            png.catch(()=>{});
            await navigator.clipboard.write([new ClipboardItem({'image/png':png})]);
            status.textContent='图像已复制';
        }catch{status.textContent='复制失败，请检查剪贴板权限，或右键/长按图片复制'}
        finally{copyButton.disabled=false}
    });
    const saveButton=btn('保存图像',async()=>{
        saveButton.disabled=true;status.textContent='';
        try{
            const response=await fetch(src);
            if(!response.ok)throw new Error('Image unavailable');
            const url=URL.createObjectURL(await response.blob()),a=el('a');a.href=url;
            const extension=name.match(/\.[^.]+$/)?.[0];
            a.download=alt&&extension&&alt.toLowerCase().endsWith(extension.toLowerCase())&&!/[\\/:*?"<>|]/.test(alt)?alt:name;
            d.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
        }catch{status.textContent='保存失败，请重试'}
        finally{saveButton.disabled=false}
    });
    actions.append(copyButton,saveButton,btn('关闭',closeWorkbenchDialog));
    d.append(f,actions,status);
    copyButton.focus({preventScroll:true});
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
            const n=find(t.value);const d=el('details','embed');d.append(el('summary','',n?'批注：'+n.title:'失效嵌入：'+t.value));
            if(n&&!trail.includes(n.id)){d.addEventListener('toggle',()=>{if(d.open&&!d.dataset.loaded){d.dataset.loaded='1';const b=el('div','content');renderBody(n,b,[...trail,n.id]);d.append(b,btn('打开批注',()=>select(n.id)))}})}
            else d.append(el('div','muted','循环引用或对象不存在'));
            p.replaceWith(d)
        }else p.replaceWith(refSpan(t.kind,t.value))
    }
    for(const t of fragment.querySelectorAll('table')){const wrap=el('div','tablescroll');t.replaceWith(wrap);wrap.append(t)}
    let imageIndex=-1;
    for(const img of fragment.querySelectorAll('img')){
        if(!img.getAttribute('src')?.startsWith('/assets/')){img.replaceWith(el('span','badref','图片来源不在本地资源目录'));continue}
        const index=++imageIndex,src=img.getAttribute('src'),key='wb-image-width:'+src;
        const wrap=el('div','imgwrap resizeImage');let w=figureWidth(img.title,onImageResize?100:localStorage.getItem(key)||100);wrap.style.width=w+'%';img.removeAttribute('title');
        wrap._setImageWidth=value=>{w=value;wrap.style.width=wrap.parentElement?.matches('.figureImageRow')?figureRowWidthStyle(w):w+'%'};
        wrap._getImageWidth=()=>w;
        function activate(){document.querySelectorAll('.resizeImage.selectedImage').forEach(x=>{if(x!==wrap)x.classList.remove('selectedImage')});wrap.classList.add('selectedImage');wrap.closest('.visualCard')?._selectImage?.(wrap);wrap.closest('.visualDocument')?.focus({preventScroll:true})}
        function full(){showImagePreview(src,img.alt)}
        function commit(widths=null){if(onImageResize)onImageResize(src,w,index,widths);else localStorage.setItem(key,String(w))}
        // Freeze every other image's displayed width. The selected image can
        // only use the unoccupied width of its explicit row.
        function resizeContext(){
            const row=wrap.parentElement, siblings=row.matches('.figureImageRow')?[...row.querySelectorAll(':scope > .resizeImage')]:[wrap];
            const other=siblings.filter(x=>x!==wrap),max=Math.max(0,Math.round((100-other.reduce((sum,x)=>sum+x._getImageWidth(),0))*1000)/1000);
            const gap=siblings.length>1?parseFloat(getComputedStyle(row).columnGap)||0:0;
            const usable=Math.max(1,(row.clientWidth||wrap.getBoundingClientRect().width)-gap*(siblings.length-1));
            return {siblings,max,usable}
        }
        function commitResize(siblings){
            // Old rows may contain several 100% images. Record their already
            // displayed widths once, so a reload cannot rescale the siblings.
            const changes=siblings.filter(x=>x===wrap||x._figureSourceWidth!==x._getImageWidth()).map(x=>[Number(x.dataset.imageIndex),x._getImageWidth()]);
            commit(siblings.length>1?changes:null);
            for(const x of siblings)x._figureSourceWidth=x._getImageWidth()
        }
        img.loading='lazy';img.draggable=false;img.addEventListener('click',e=>{e.stopPropagation();activate()});img.addEventListener('dblclick',e=>{e.stopPropagation();full()});
        img.replaceWith(wrap);wrap.append(img);context(wrap,()=>[['查看原图',full],['恢复原始显示大小',()=>{if(!canEditControl(wrap))return;const {siblings,max}=resizeContext();wrap._setImageWidth(max);commitResize(siblings)}],...(wrap.closest('.visualCard')?._menu?.()||[])]);
        for(const corner of ['nw','ne','sw','se']){
            const h=el('span','resizeHandle '+corner);h.setAttribute('role','button');h.setAttribute('aria-label','拖动图片'+corner+'角缩放');wrap.append(h);
            h.addEventListener('pointerdown',e=>{if(!canEditControl(wrap))return;e.preventDefault();e.stopPropagation();activate();h.setPointerCapture(e.pointerId);const startX=e.clientX,startY=e.clientY,startW=wrap.getBoundingClientRect().width,startH=wrap.getBoundingClientRect().height,available=wrap.parentElement.clientWidth||startW,signX=corner.endsWith('e')?1:-1,signY=corner.startsWith('s')?1:-1;let moved=false;
                const {siblings,max,usable}=resizeContext(),initial=w;
                const move=ev=>{const dx=(ev.clientX-startX)*signX,dy=(ev.clientY-startY)*signY*(startW/Math.max(1,startH));const delta=Math.abs(dx)>=Math.abs(dy)?dx:dy;if(Math.abs(delta)>2)moved=true;if(!moved)return;
                    const target=Math.max(Math.min(1,max),Math.min(max,Math.round((startW+delta)/usable*1000)/10));
                    wrap._setImageWidth(target)
                };
                const end=ev=>{h.removeEventListener('pointermove',move);h.removeEventListener('pointerup',end);h.removeEventListener('pointercancel',end);if(ev.type==='pointercancel')wrap._setImageWidth(initial);else if(moved&&w!==initial)commitResize(siblings)};h.addEventListener('pointermove',move);h.addEventListener('pointerup',end);h.addEventListener('pointercancel',end)
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
        const h=el('div','objecthead');h.append(el('span','objnum',(kind==='equation'?'公式':kind==='figure'?'图':'表')+(t.number?' '+t.number:'')),el('div','spacer'));
        if(resolve(id)){h.append(btn('⋯',e=>menuAt(e,[...refMenu(t),['复制对象源码',()=>copy(raw)]])));context(box,()=>refMenu(t),()=>resolve(t.id))}
        box.append(h);
        if(kind==='equation'){const b=el('div','mathscroll');math(b,body.trim(),true);box.append(b)}
        else {const lines=body.split('\n');const cap=lines.shift();const b=el('div');markdown(lines.join('\n'),b,trail);const c=el('div','caption');markdown(cap,c,trail);if(kind==='table')box.append(c,b);else box.append(b,c)}
        host.append(box)
    }
    markdown(n.body.slice(pos),host,trail);
}
function annotationLocationIndex(){
    const index=new Map(db.blocks.map(n=>[n.id,[]]));
    for(const n of all())for(const m of n.body.matchAll(refPattern()))if(m[1]==='embed'&&index.has(m[2]))index.get(m[2]).push({owner:n.id,kind:'text',start:m.index,end:m.index+m[0].length});
    for(const note of db.blocks){const places=index.get(note.id);
        for(const b of objectNoteBindings(note)){const target=resolve(b.targetId);places.push({owner:target?.owner||b.targetId,kind:'object',targetId:b.targetId,binding:b})}
        for(const p of freeNotePlacements(note))places.push({owner:p.pageId,kind:'free',placementId:p.id,placement:p})
    }return index
}
function annotationLocations(note,index=null){return (index||annotationLocationIndex()).get(note.id)||[]}
const ANNOTATION_CLIPBOARD='PaperEditer-annotation-v1:';
function annotationClipboard(note,cut=false){
    const body=dialog.open&&dialog._noteId===note.id&&dialog._noteValue?dialog._noteValue():note.body;
    return ANNOTATION_CLIPBOARD+JSON.stringify({workspace:currentWorkspace?.id,id:note.id,title:note.title,body,floatSize:note.floatSize,cut})
}
function annotationClipboardValue(text){
    if(!text.startsWith(ANNOTATION_CLIPBOARD))return null;
    try{const n=JSON.parse(text.slice(ANNOTATION_CLIPBOARD.length));return typeof n.body==='string'&&typeof n.title==='string'?n:null}catch{return null}
}
function clearAnnotationPlacement(n){delete n.annotation;delete n.textBindings;delete n.objectBindings;delete n.freePlacements}
// Keep the Markdown clipboard readable, with a private trailer for the
// selected annotations. Their content is snapshotted, not a live link.
const RANGE_NOTE_TRAILER='\n\n<!-- PaperEditer-range-annotations-v1:';
function rangeNoteClipboard(raw,notes,cut,map){
    if(!notes.length)return raw;
    return raw+RANGE_NOTE_TRAILER+encodeURIComponent(JSON.stringify({workspace:currentWorkspace?.id,cut,notes:notes.map(({note,binding})=>({id:note.id,title:note.title,body:note.body,floatSize:note.floatSize,binding:binding?{...binding,targetId:map.get(binding.targetId)||binding.targetId}:null}))}))+' -->'
}
function rangeNoteClipboardValue(text){
    const i=text.lastIndexOf(RANGE_NOTE_TRAILER);if(i<0||!text.endsWith(' -->'))return null;
    try{const payload=JSON.parse(decodeURIComponent(text.slice(i+RANGE_NOTE_TRAILER.length,-4)));if(!Array.isArray(payload.notes)||!payload.notes.every(n=>typeof n.id==='string'&&typeof n.title==='string'&&typeof n.body==='string'))return null;return {...payload,raw:text.slice(0,i)}}catch{return null}
}
function prepareRangePaste(text,owner,force=false){
    const payload=rangeNoteClipboardValue(text);
    if(!payload)return remapCopiedObjects(prepareAnnotationPaste(text,owner),owner,force);
    const map=new Map(),raw=remapCopiedObjects(payload.raw,owner,force,map),notes=new Map();
    const internal=spaceOf(owner)!=='thesis';
    for(const n of payload.notes){
        if(internal){notes.set(n.id,n.title);continue}
        const source=payload.workspace===currentWorkspace?.id&&db.blocks.find(x=>x.id===n.id);
        const note=payload.cut&&source&&!annotationLocations(source).length?source:annotationCopy(n);
        clearAnnotationPlacement(note);notes.set(n.id,note.id);
        if(n.binding){const targetId=map.get(n.binding.targetId)||n.binding.targetId;note.objectBindings=[{...clone(n.binding),targetId}]}
    }
    return raw.replace(refPattern(),(m,k,id)=>k==='embed'&&notes.has(id)?(internal?notes.get(id):'[[embed:'+notes.get(id)+']]'):m)
}
function annotationCopy(n){
    const id='block-'+uid(),body=remapCopiedObjects(n.body.replace(refPattern(),(m,k,target)=>k==='embed'||(['ref','eqref'].includes(k)&&db.blocks.some(x=>x.id===target))?(find(target)?.title||target):m),null,true);
    const copy={id,title:n.title||blockLabel(body),body,parent:null,level:1,order:db.blocks.length,number:'',file:'blocks/'+id+'.md',source:''};
    if(n.floatSize)copy.floatSize=clone(n.floatSize);db.blocks.push(copy);return copy
}
function prepareAnnotationPaste(text,owner){
    const payload=annotationClipboardValue(text),internal=spaceOf(owner)!=='thesis';
    if(payload){
        if(internal)return payload.body.replace(refPattern(),(m,k,id)=>k==='embed'?(find(id)?.title||id):m);
        const source=payload.workspace===currentWorkspace?.id&&db.blocks.find(n=>n.id===payload.id);
        const note=payload.cut&&source&&!annotationLocations(source).length?source:annotationCopy(payload);
        clearAnnotationPlacement(note);return '[[embed:'+note.id+']]'
    }
    const claimed=new Set();
    return text.replace(refPattern(),(m,k,id)=>{
        const source=db.blocks.find(n=>n.id===id);
        if(k!=='embed')return source&&['ref','eqref'].includes(k)?source.title:m;
        if(!source)return '（批注不可用：'+id+'）';
        if(internal)return source.title;
        const note=!claimed.has(id)&&!annotationLocations(source).length?source:annotationCopy(source);
        claimed.add(id);clearAnnotationPlacement(note);return '[[embed:'+note.id+']]'
    })
}
function splitLegacyAnnotationPlacements(){
    const index=annotationLocationIndex(),edits=new Map();
    for(const n of [...db.blocks]){
        const places=annotationLocations(n,index);if(places.length<2)continue;
        const old=clone(n),meta=[old.annotation,...(old.textBindings||[])].filter(Boolean);
        places.forEach((place,i)=>{
            const note=i?annotationCopy(old):n;clearAnnotationPlacement(note);
            if(place.kind==='text'){
                const owner=find(place.owner),match=meta.find(b=>b.owner===place.owner&&b.quote&&owner?.body.slice(place.end).startsWith(b.quote))||meta.find(b=>b.owner===place.owner);
                if(match)note.annotation={...clone(match),mode:match.mode||(match.quote?'selection':'caret')};
                if(i&&owner){if(!edits.has(owner.id))edits.set(owner.id,[]);edits.get(owner.id).push({...place,id:note.id})}
            }else if(place.kind==='object')note.objectBindings=[clone(place.binding)];else note.freePlacements=[clone(place.placement)]
        })
    }
    for(const [owner,positions] of edits){const n=find(owner);for(const p of positions.sort((a,b)=>b.start-a.start))n.body=n.body.slice(0,p.start)+'[[embed:'+p.id+']]'+n.body.slice(p.end)}
}
function annotationLocationMenu(note){
    const place=annotationLocations(note)[0];
    return place&&find(place.owner)?[['定位批注',()=>jumpAnnotation(note.id,place)]]:[]
}
function highlightNetworkTarget(target){
    if(!target)return;target.classList.add('networkJumpHighlight');
    target.scrollIntoView({block:'center',behavior:'instant'});
    setTimeout(()=>target.classList.remove('networkJumpHighlight'),3000)
}
function jumpAnnotation(center,place){
    if(dialog.open)closeWorkbenchDialog();
    const id=place.owner,note=find(center),dest=find(id);if(!dest||!note)return;
    select(id);
    const pane=paneBox.children[active];
    const belongs=el=>el.closest('.visualDocument')?._owner===id;
    const marker=[...pane.querySelectorAll(noteLabelSelector)].find(el=>el.dataset.noteId===center&&(place.kind==='text'?belongs(el):place.kind==='object'?el.dataset.targetId===place.targetId:el.dataset.placementId===place.placementId));
    if(!marker){showToast('原批注位置已不存在');return}
    const card=marker.closest('.visualCard');if(card?.classList.contains('folded'))card._setFolded?.(false);
    highlightNetworkTarget(marker);
    marker._openNote?.()
}
function renderAnnotationLocation(host,n,index=null){
    const place=annotationLocations(n,index)[0],dest=place&&find(place.owner);
    const key=JSON.stringify([place,dest?.title]);if(host.dataset.key===key)return;host.dataset.key=key;
    host.replaceChildren(dest?btn('定位批注 · '+label(dest),()=>jumpAnnotation(n.id,place),'annotationLocation'):el('span','muted','未放置'))
}
function refreshAnnotationLists(){
    for(const host of paneBox.querySelectorAll('[data-annotation-list]'))renderAnnotationList(host);
    for(const host of paneBox.querySelectorAll('[data-annotation-location]')){const n=find(host.dataset.annotationLocation);if(n)renderAnnotationLocation(host,n)}
}
function renderAnnotationList(host){
    const index=annotationLocationIndex(),entries=db.blocks.map(n=>[n.id,n.title,n.body,annotationLocations(n,index),annotationLocations(n,index).map(p=>find(p.owner)?.title)]);
    const key=JSON.stringify([entries,db.trash.length,search]);if(host.dataset.key===key)return;host.dataset.key=key;
    const actions=el('div','blockOverviewActions');actions.append(btn('回收站'+(db.trash.length?' ('+db.trash.length+')':''),showTrash,'trashButton'));
    host.replaceChildren(actions);
    const list=el('div','annotationList');
    for(const n of db.blocks.filter(n=>(n.title+' '+n.body).toLowerCase().includes(search.trim().toLowerCase()))){
        const row=el('article','blockcard annotationRow');row.dataset.noteId=n.id;
        const title=btn(n.title,()=>select(n.id),'annotationTitle');
        row.append(title,el('div','small',n.body.replace(/:::[^\n]*/g,'').slice(0,180)||'空白批注'));
        const loc=el('div','annotationLocationRow');renderAnnotationLocation(loc,n,index);loc.append(btn('删除',()=>deleteNode(n),'annotationDelete'));loc.lastChild.disabled=!editingEnabled;row.append(loc);
        context(row,()=>nodeMenu(n),null,true);list.append(row)
    }
    host.append(list);if(!list.childNodes.length)host.append(el('div','empty','暂无批注'))
}
function blockOverview(page){
    const list=el('div');list.dataset.annotationList='1';page.append(el('h1','title','批注一览'),list);renderAnnotationList(list)
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
        if(p.history){pane.classList.add('historicalPane');renderHistoricalPage(pane,p,pi);return}
        const toolbar=el('div','toolbar');const page=el('article','page');
        if(panes.length>1)toolbar.append(btn('切换 '+(pi===0?'右页':'左页'),()=>{active=pi===0?1:0;renderNav();renderPanes()},'mobileOnly'));
        const n=find(p.id);
        if(n){
            const foldButton=btn('本页全部折叠',()=>togglePageFolds(pi),'foldAllButton pageFoldButton');foldButton.title='仅展开或折叠当前正文页';toolbar.append(foldButton);
            const path=ancestors(n).map(id=>find(id)).filter(Boolean);const bc=el('div','breadcrumb');bc.append(el('span','',spaceOf(n.id)==='thesis'?'博论树':'批注一览'));for(const a of path){bc.append(document.createTextNode(' / '));const link=el('a','ref',label(a));link.href='#';link.addEventListener('click',e=>{e.preventDefault();select(a.id,pi)});bc.append(link)}page.append(bc);
            editor(n,page,pi);if(spaceOf(n.id)==='thesis'){for(const c of children('thesis',n.id))renderChild(c,page,pi)}
            else{const host=el('section','annotationLocationRow');host.dataset.annotationLocation=n.id;page.append(host);renderAnnotationLocation(host,n)}
        }else if(view==='blocks')blockOverview(page);else page.append(el('div','empty','从左侧目录选择章节'));
        context(pane,e=>{
            const docs=[...page.querySelectorAll('.visualDocument')].filter(d=>d.getClientRects().length);
            const distance=d=>{const r=d.getBoundingClientRect();return Math.max(r.top-e.clientY,0,e.clientY-r.bottom)};
            const doc=e.target.closest('.visualDocument')||docs.sort((a,b)=>distance(a)-distance(b))[0];
            if(doc?._blankMenu)return doc._blankMenu(e);
            return [[view==='blocks'?'新建批注':'新建章节',()=>newNode(view)],['撤销',()=>undo(false)],['重做',()=>undo(true)]]
        });
        if(pi===1)toolbar.append(btn('关闭本页',closeSecondPane,'closeSecondPane'));
        if(toolbar.childNodes.length)pane.append(toolbar);pane.append(page);paneBox.append(pane);updatePageFoldButton(pi);restorePane(pane,p)
    });
    applySplitWidths();
    refreshFreeNotes();
    $('dual').textContent=panes.length===2?'单页':'双页';
    rememberPosition();
    scheduleToolbarUpdate();
}
$('treeTab').onclick=()=>setView('thesis');$('blockTab').onclick=()=>setView('blocks');
$('drawer').onclick=()=>{$('sidebar').classList.toggle('open');$('overlay').classList.toggle('show')};$('overlay').onclick=mobileClose;
$('search').oninput=e=>{search=e.target.value;renderNav();if(view==='blocks')refreshAnnotationLists()};$('newNode').onclick=()=>newNode(view);
$('dual').onclick=()=>{if(panes[1]?.history){closeHistoricalVersion();return}if(panes.length===1){panes.push({id:panes[0].id,edit:false,thesisReading:thesisPosition(panes[0].thesisReading)});active=1}else{panes=[panes[active]];active=0}renderPanes();renderNav()};
$('refresh').onclick=()=>{if(dialog._commitNote)closeWorkbenchDialog();if(conflict){showSyncConflict();return}if(workspaceChanged||!db){load();return}syncNow(true)};$('closeDialog').onclick=()=>closeWorkbenchDialog();
$('saveVersion').onclick=markVersion;$('historyButton').onclick=()=>showHistory();
$('shortcutSettings').onclick=shortcutSettings;
async function openWorkspaceDialog(){
    if(dialog._commitNote)closeWorkbenchDialog();
    const d=showDialog('打开文件');
    d.append(el('p','small','输入服务器上的 .json 文件绝对路径打开或新建文件。新建时可留空，自动在用户数据 workspaces 目录创建包含各类对象示例的文件，不覆盖已有文件。支持本地磁盘和 UNC 网络共享路径。'));
    const form=el('form','workspacePathForm'),input=el('input','workspacePath');input.type='text';input.required=true;input.autocomplete='off';input.autocapitalize='off';input.spellcheck=false;input.placeholder='C:\\项目\\文件.json 或 \\\\服务器\\共享\\文件.json';input.setAttribute('aria-label','服务器文件路径');
    const submit=el('button','','打开');submit.type='submit';form.append(input,submit);d.append(form);
    const create=btn('新建文件',()=>openPath(input.value,'new'));
    const actions=el('div','workspaceFileActions');actions.append(create);d.append(actions);
    const message=el('p','small');d.append(message);
    const filter=el('input','workspacePath');filter.type='search';filter.placeholder='\u641c\u7d22\u6587\u4ef6\u540d\u6216\u8def\u5f84';filter.setAttribute('aria-label','\u641c\u7d22\u6587\u4ef6');d.append(filter);
    const list=el('div','workspaceRecentList');d.append(list);
    let catalogData=null,dragPath=null;
    filter.oninput=()=>{if(catalogData)renderRecent(catalogData)};
    async function openPath(path,mode='open',extra={}){
        if((mode!=='new'&&!path.trim())||submit.disabled)return;
        input.disabled=submit.disabled=create.disabled=true;for(const button of list.querySelectorAll('button'))button.disabled=true;message.textContent=mode==='new'?'正在新建…':'正在打开…';
        try{
            clearTimeout(timer);
            while(saving||syncBusy)await new Promise(r=>setTimeout(r,50));
            if(dirty)await save();
            if(dirty||conflict)throw new Error('当前工作区有未保存的内容，不能切换。');
            captureReading();await flushReading();
            await api('/api/workspaces/'+mode,{path:path.trim(),...extra});
            readingReady=false;readingInteracted=false;dialog.close();await load(true);
        }catch(e){message.textContent=e.message;input.disabled=submit.disabled=create.disabled=false;for(const button of list.querySelectorAll('button'))button.disabled=false}
    }
    form.addEventListener('submit',e=>{e.preventDefault();openPath(input.value)});
    async function changeRecords(endpoint,payload){
        if(submit.disabled)return;
        input.disabled=submit.disabled=create.disabled=true;
        try{renderRecent(await api('/api/workspaces/'+endpoint,payload));message.textContent='';}
        catch(e){message.textContent=e.message}
        finally{input.disabled=submit.disabled=create.disabled=false}
    }
    function renderRecent(catalog){
        catalogData=catalog;list.replaceChildren();
        const q=filter.value.trim().toLocaleLowerCase();
        const visible=catalog.files.filter(f=>f.path.toLocaleLowerCase().includes(q)||f.name.toLocaleLowerCase().includes(q));
        const favorites=catalog.files.filter(f=>f.favorite);
        function reorder(from,to){
            const paths=favorites.map(f=>f.path),a=paths.indexOf(from),b=paths.indexOf(to);
            if(a<0||b<0||a===b)return;
            paths.splice(a,1);paths.splice(b,0,from);changeRecords('reorder',{paths});
        }
        for(const [title,group] of [['\u6536\u85cf',visible.filter(f=>f.favorite)],['\u6700\u8fd1\u6253\u5f00',visible.filter(f=>!f.favorite)]]){
            list.append(el('h3','',title));
            if(!group.length)list.append(el('p','small',title==='\u6536\u85cf'?'\u6682\u65e0\u6536\u85cf':'\u6682\u65e0\u6253\u5f00\u8bb0\u5f55\u3002'));
            for(const f of group){
                const row=el('div','workspaceRecentRow');
                const b=btn('',()=>openPath(f.path),'workspaceRecent');b.append(el('strong','',f.name+(f.active?'\uff08\u5f53\u524d\uff09':'')),el('span','small',f.path));
                if(f.availability&&f.availability!=='present')b.append(el('span','small',f.availability==='missing'?'\u6587\u4ef6\u5df2\u4e22\u5931':'\u6587\u4ef6\u6682\u4e0d\u53ef\u8bbf\u95ee'));
                const star=btn(f.favorite?'\u2605':'\u2606',()=>changeRecords('favorite',{path:f.path,favorite:!f.favorite}),'workspaceRecordAction');
                star.title=f.favorite?'\u53d6\u6d88\u6536\u85cf':'\u6dfb\u52a0\u6536\u85cf';star.setAttribute('aria-label',star.title+' '+f.name);
                const remove=btn('\u5220\u9664\u8bb0\u5f55',()=>changeRecords('forget',{path:f.path}),'workspaceForget');remove.title='\u4ec5\u5220\u9664\u8bb0\u5f55\uff0c\u4fdd\u7559\u6587\u4ef6\u53ca\u5386\u53f2';
                const controls=el('div','workspaceRecordActions');row.append(b,controls);controls.append(star);
                if(f.favorite){
                    const i=favorites.findIndex(x=>x.path===f.path);
                    const up=btn('\u2191',()=>reorder(f.path,favorites[i-1]?.path),'workspaceRecordAction');up.disabled=i===0;up.title='\u5411\u4e0a\u79fb\u52a8\u6536\u85cf';
                    const down=btn('\u2193',()=>reorder(f.path,favorites[i+1]?.path),'workspaceRecordAction');down.disabled=i===favorites.length-1;down.title='\u5411\u4e0b\u79fb\u52a8\u6536\u85cf';
                    controls.append(up,down);
                    row.draggable=true;row.ondragstart=e=>{dragPath=f.path;e.dataTransfer.setData('text/plain',f.path)};
                    row.ondragover=e=>{if(dragPath)e.preventDefault()};
                    row.ondrop=e=>{e.preventDefault();reorder(dragPath,f.path);dragPath=null};
                    row.ondragend=()=>{dragPath=null};
                }
                if(f.availability&&f.availability!=='present'){
                    const locate=btn('\u91cd\u65b0\u5b9a\u4f4d',()=>{
                        const target=input.value.trim();
                        if(!target){message.textContent='\u8bf7\u5728\u4e0a\u65b9\u8f93\u5165\u65b0\u6587\u4ef6\u7684\u7edd\u5bf9\u8def\u5f84\uff0c\u518d\u70b9\u51fb\u91cd\u65b0\u5b9a\u4f4d\u3002';input.focus();return}
                        if(confirm('\u5c06\u6b64\u6587\u4ef6\u5173\u8054\u5230\u9009\u4e2d\u7684\u5386\u53f2\u4e0e\u6536\u85cf\uff1f'))openPath(target,'open',{attachFrom:f.path})
                    },'workspaceRecordAction');controls.append(locate)
                }
                remove.setAttribute('aria-label','\u5220\u9664\u6253\u5f00\u8bb0\u5f55 '+f.name);controls.append(remove);list.append(row)
            }
        }
        if(!visible.length&&q)list.append(el('p','small','\u6ca1\u6709\u5339\u914d\u6587\u4ef6'));
    }
    const asCopy=btn('\u4f5c\u4e3a\u65b0\u526f\u672c\u6253\u5f00',()=>{if(input.value.trim()&&confirm('\u4e3a\u6b64\u6587\u4ef6\u5efa\u7acb\u72ec\u7acb\u5386\u53f2\uff1f'))openPath(input.value,'open',{newCopy:true})});actions.append(asCopy);
    try{
        const catalog=await api('/api/workspaces');
        if(catalog.error)message.textContent=catalog.error;
        renderRecent(catalog);
    }catch(e){message.textContent=e.message}
}
$('openWorkspace').onclick=openWorkspaceDialog;
context(dialog,e=>dialog.querySelector('.historyList')?[]:simpleContextMenu(e),null,true);
dialog.addEventListener('close',()=>{if(!dialog.open){clearNoteLabel();hideFloatingTools();$('menu').hidden=true;dialog._noteId=null}});
$('headerActions').onclick=toggleFloatingTools;
initFloatingTools();
dialog.addEventListener('cancel',e=>{if(dialog._commitNote){e.preventDefault();closeWorkbenchDialog()}});
document.addEventListener('pointerdown',e=>{
    if(!dialog.open||isActionSurface(e.target))return;
    const r=dialog.getBoundingClientRect();
    const imageBlank=dialog.querySelector('.imagePreviewActions')&&(e.target===dialog||e.target===$('dialogBody'));
    if(imageBlank||e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeWorkbenchDialog()
},true);
document.addEventListener('click',e=>{if(isActionSurface(e.target))return;$('menu').hidden=true;if(!e.target.closest('.resizeImage'))document.querySelectorAll('.selectedImage').forEach(x=>x.classList.remove('selectedImage'))});
const SHORTCUT_KEY='wb:tool-shortcuts:v2';
const combo=(key,alt=false,shift=false)=>({ctrl:true,alt,shift,key});
const defaultShortcuts={
    [MODE_TOOL]:combo('e',true),
    '剪切':combo('x'),'复制':combo('c'),'粘贴':combo('v'),
    '新建批注':combo('f'),
    '添加公式':{ctrl:false,alt:true,shift:false,key:'='},
    '复制交叉引用':combo('r',true),'撤销':combo('z'),'重做':combo('y'),
    '显示/隐藏工具栏':combo('t',true)
};
function shortcutLabel(s){return s?[s.ctrl?'Ctrl':'',s.alt?'Alt':'',s.shift?'Shift':'',s.key.toUpperCase()].filter(Boolean).join('+'):'未设置'}
function validShortcut(s){return s===null||!!(s&&typeof s.key==='string'&&/^[a-z0-9=]$/.test(s.key)&&['ctrl','alt','shift'].every(k=>typeof s[k]==='boolean')&&(s.ctrl||s.alt))}
let toolShortcuts=(()=>{
    const result=clone(defaultShortcuts);
    try{
        const saved=JSON.parse(localStorage.getItem(SHORTCUT_KEY));
        if(saved){
            if(!Object.hasOwn(saved,'新建批注')&&Object.hasOwn(saved,'新建批注/知识块'))saved['新建批注']=saved['新建批注/知识块'];
            for(const label of Object.keys(result))if(Object.hasOwn(saved,label)&&validShortcut(saved[label]))result[label]=saved[label]
        }
        else{
            const old=JSON.parse(localStorage.getItem('wb:new-note-shortcut:v1'));
            if(old&&validShortcut(old)&&!Object.entries(result).some(([label,s])=>label!=='新建批注'&&shortcutLabel(s)===shortcutLabel(old)))result['新建批注']=old
        }
    }catch{}
    return result
})();
// The server owns the shared settings. Only a previously customized browser
// may seed an empty server; a revision check prevents competing migrations.
let shortcutRevision=null,shortcutRefresh=null,shortcutSaving=false;
let legacyShortcuts=syncEqual(toolShortcuts,defaultShortcuts)?null:clone(toolShortcuts);
function applySharedShortcuts(result){
    shortcutRevision=result.revision;
    toolShortcuts=clone(defaultShortcuts);for(const label of Object.keys(toolShortcuts))if(result.shortcuts&&Object.hasOwn(result.shortcuts,label)&&validShortcut(result.shortcuts[label]))toolShortcuts[label]=result.shortcuts[label];updateShortcutHints();
    if(result.shortcuts)legacyShortcuts=null;
}
function syncShortcuts(){
    if(shortcutSaving)return Promise.resolve();
    if(shortcutRefresh)return shortcutRefresh;
    shortcutRefresh=(async()=>{
        let result=await api('/api/shortcuts');
        if(result.shortcuts===null&&legacyShortcuts){
            try{result=await api('/api/shortcuts',{revision:null,shortcuts:legacyShortcuts})}
            catch(e){if(e.status!==409)throw e;result=await api('/api/shortcuts')}
        }
        applySharedShortcuts(result);
    })().catch(e=>console.warn('Shortcut sync:',e)).finally(()=>{shortcutRefresh=null});
    return shortcutRefresh;
}
function updateShortcutHints(){
    for(const b of $('floatingTools').querySelectorAll('[data-tool]')){
        const label=b.dataset.tool,s=toolShortcuts[label];b.dataset.shortcutHint=s?' ('+shortcutLabel(s)+')':'';
        if(s)b.setAttribute('aria-keyshortcuts',shortcutLabel(s).replace('Ctrl','Control'));else b.removeAttribute('aria-keyshortcuts')
    }
    const toggle=$('headerActions'),s=toolShortcuts['显示/隐藏工具栏'];
    toolbarShortcutText=s?' ('+shortcutLabel(s)+')':'';
    toggle.dataset.shortcutHint=toolbarShortcutText
}
let localAdminToken='';
try{
    const fragment=new URLSearchParams(location.hash.slice(1)),token=fragment.get('admin');
    if(token&&/^[a-f0-9]{64}$/.test(token)&&location.hostname==='127.0.0.1'){
        sessionStorage.setItem('wb:local-admin',token);
        history.replaceState(null,'',location.pathname+location.search);
    }
    localAdminToken=sessionStorage.getItem('wb:local-admin')||'';
}catch{}
function settingsTabs(d,active){
    const row=el('div','edittools');
    row.append(btn('快捷键',shortcutSettings),btn('服务',serviceSettingsDialog));
    row.querySelectorAll('button')[active==='service'?1:0].disabled=true;
    d.append(row);
}
async function serviceSettingsDialog(){
    const d=showDialog('设置');
    settingsTabs(d,'service');
    const generation=dialogPlacementVersion;
    const message=el('p','small','正在读取服务设置...');
    d.append(message);
    async function request(body,endpoint='/api/settings/service'){
        const options={headers:{'X-PaperEditer-Admin':localAdminToken}};
        if(body){options.method='POST';options.headers['Content-Type']='application/json';options.body=JSON.stringify(body)}
        const r=await fetch(endpoint,options);
        const data=await r.json();if(!r.ok)throw new Error(data.error||'HTTP '+r.status);
        return data;
    }
    try{
        const data=await request();
        if(!d.isConnected||!dialog.open||generation!==dialogPlacementVersion)return;
        message.textContent=(data.buildType==='release'?'发行版':'开发版')+' | '+ '当前端口: '+data.port+' | '+data.dataDir;
        const mode=el('select'),port=el('input');
        mode.append(new Option('自动选择端口','auto'),new Option('固定端口','fixed'));
        mode.value=data.service.portMode;mode.setAttribute('aria-label','端口模式');
        port.type='number';port.min=1024;port.max=65535;port.value=data.service.preferredPort;port.setAttribute('aria-label','端口');
        const msg=el('p','small','仅监听 localhost，修改后下次启动服务时生效。');
        const save=btn('保存',async()=>{
            save.disabled=true;
            try{await request({portMode:mode.value,preferredPort:Number(port.value)});msg.textContent='已保存，下次启动生效。'}
            catch(e){msg.textContent=e.message}finally{save.disabled=false}
        });
        const controls=el('div','edittools');controls.append(mode,port,save);
        const exit=btn('退出程序',async()=>{
            if(!confirm('请确认其他窗口和设备已保存。退出后将停止后台服务，所有设备断开连接。'))return;
            exit.disabled=true;
            try{
                if(db&&!(await flushDocument()))throw new Error('请先完成保存');
                await request({},'/api/settings/stop');
                syncEvents?.close();
                msg.textContent='服务已停止。可关闭网页，再次点击 PaperEditer 启动。';
                save.disabled=true;mode.disabled=true;port.disabled=true;
            }catch(e){msg.textContent=e.message;exit.disabled=false}
        });
        d.append(controls,msg,exit);
    }catch(e){message.textContent='请从本机 PaperEditer 启动器打开浏览器后配置服务。'}
}
function shortcutSettings(){
    const d=showDialog('设置');settingsTabs(d,'shortcuts');let values=clone(toolShortcuts);const revision=shortcutRevision;
    const desc=el('p','small','快捷键由服务端统一保存，所有设备和文档共享。点击组合键输入框后按键，或使用下拉框选择；清除可禁用该工具的自定义快捷键。浏览器原生剪贴快捷键仍可使用。');
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
            const input=el('input');input.readOnly=true;input.dataset.shortcutCapture='1';input.setAttribute('aria-label',label==='新建批注'?'新建批注快捷键':label+'快捷键');
            const mod=el('select'),key=el('select');
            mod.setAttribute('aria-label',label+'修饰键');key.setAttribute('aria-label',label+'按键');
            for(const [v,t] of modifiers)mod.append(new Option(t,v));
            for(const k of 'abcdefghijklmnopqrstuvwxyz0123456789=')key.append(new Option(k.toUpperCase(),k));
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
    const row=el('div','edittools');
    const reset=btn('恢复默认',()=>{values=clone(defaultShortcuts);draw();msg.textContent='已恢复默认，保存后生效。'});
    const saveButton=btn('保存',async()=>{
        if(shortcutSaving)return;
        shortcutSaving=true;saveButton.disabled=true;reset.disabled=true;
        for(const control of list.querySelectorAll('input,select,button'))control.disabled=true;
        const snapshot=clone(values);
        try{
            await shortcutRefresh;
            const result=await api('/api/shortcuts',{revision,shortcuts:snapshot});
            applySharedShortcuts(result);
            if(list.isConnected&&dialog.open)dialog.close();
            showToast('快捷键已保存至所有设备');
        }catch(e){msg.textContent='保存失败：'+e.message}
        finally{shortcutSaving=false;saveButton.disabled=false;reset.disabled=false;for(const control of list.querySelectorAll('input,select,button'))control.disabled=false;syncShortcuts()}
    });
    row.append(reset,saveButton);
    d.append(desc,list,msg,row)
}
updateShortcutHints();
document.addEventListener('keydown',e=>{
    if(e.defaultPrevented||e.isComposing||e.keyCode===229||!db||e.target.closest?.('.shortcutList'))return;
    const key=e.key.toLowerCase(),matches=s=>s&&s.ctrl===(e.ctrlKey||e.metaKey)&&s.alt===e.altKey&&s.shift===e.shiftKey&&s.key===key;
    let label=Object.keys(toolShortcuts).find(k=>matches(toolShortcuts[k]));
    if(!label&&shortcutLabel(toolShortcuts['重做'])==='Ctrl+Y'&&(e.ctrlKey||e.metaKey)&&e.shiftKey&&!e.altKey&&key==='z')label='重做';
    if(!label)return;
    if(label==='添加公式'){
        if(e.target.closest?.('input,textarea,select,math-field')||dialog.open&&!dialog.querySelector('.visualDocument')||(!dialog.open&&panes[active]?.history))return;
        e.preventDefault();e.stopImmediatePropagation();if(!e.repeat)toolbarAction(label);return
    }
    if(label===MODE_TOOL){
        if(dialog.open&&!dialog.querySelector('.visualDocument'))return;
        e.preventDefault();e.stopImmediatePropagation();if(!e.repeat)toggleEditMode();return
    }
    const control=e.target.closest?.('input,textarea,select,math-field'),rich=e.target.closest?.('.richText,.visualDocument');
    if(['剪切','复制','粘贴'].includes(label)&&matches(defaultShortcuts[label])&&(control||rich)&&!e.target.closest?.('.selectedNoteLabel'))return;
    if(dialog.open&&!dialog.querySelector('.visualDocument')&&label!=='显示/隐藏工具栏')return;
    if(['撤销','重做'].includes(label)&&control&&!rich&&!control.matches('.editableTitle'))return;
    // Keep the MathLive native undo for its own formula edits.
    if(['撤销','重做'].includes(label)&&e.target.closest?.('math-field')&&matches(defaultShortcuts[label]))return;
    e.preventDefault();e.stopImmediatePropagation();if(e.repeat)return;
    if(label==='显示/隐藏工具栏')toggleFloatingTools();
    else if(label==='撤销'||label==='重做')toolbarUndo(label==='重做');
    else toolbarAction(label);
},true);
document.addEventListener('keydown',e=>{
    if(dialog.open&&dialog.classList.contains('blankNoteDialog')&&e.key==='Enter'&&!e.shiftKey&&!e.altKey&&!e.ctrlKey&&!e.metaKey&&!e.isComposing&&e.keyCode!==229&&!e.composedPath().some(x=>x.tagName==='MATH-FIELD')){
        if(!e.target.closest('button')&&dialog.contains(e.target)){e.preventDefault();closeWorkbenchDialog();return}
    }
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();if(currentWorkspace?.history)markVersion();else if(conflict)showSyncConflict();else if(syncNeeded&&!dialog.open)syncNow(true);else save()}
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


// Theme is a per-browser preference, not part of the paper or its history.
const themeQuery=matchMedia('(prefers-color-scheme: dark)');
let themePreference=null;
try{themePreference=localStorage.getItem('wb:theme')}catch{}
const themeButton=btn('',()=>{
    themePreference=document.documentElement.dataset.theme==='dark'?'light':'dark';
    try{localStorage.setItem('wb:theme',themePreference)}catch{}
    syncTheme();
});
themeButton.id='themeToggle';
themeButton.type='button';
$('shortcutSettings').after(themeButton);
function syncTheme(){
    const dark=themePreference==='dark'||(themePreference!=='light'&&themeQuery.matches);
    const theme=dark?'dark':'light';
    document.documentElement.dataset.theme=theme;
    document.body.setAttribute('theme',theme); // MathLive's explicit theme hook.
    document.querySelector('meta[name="theme-color"]').content=dark?'#1e2227':'#ffffff';
    themeButton.textContent=dark?'浅色':'深色';
    themeButton.title=dark?'切换至浅色模式':'切换至深色模式';
    themeButton.setAttribute('aria-label','深色模式');
    themeButton.setAttribute('aria-pressed',String(dark));
}
syncTheme();
themeQuery.addEventListener('change',syncTheme);
window.addEventListener('storage',e=>{
    if(e.key==='wb:theme'||e.key===null){themePreference=e.key===null?null:e.newValue;syncTheme()}
});

// Keep one row on phones. Move the actual controls, not copies, so their
// disabled/hidden state, handlers and native fullscreen activation are shared.
const compactHeaderQuery=matchMedia('(max-width: 760px)');
const compactHeader=document.querySelector('header');
const headerMore=btn('更多',()=>setHeaderMore(headerMorePanel.hidden));
headerMore.id='headerMore';headerMore.type='button';
headerMore.setAttribute('aria-label','更多页面操作');
headerMore.setAttribute('aria-controls','headerMorePanel');
setToolIcon(headerMore,'more');
const headerMorePanel=el('div');headerMorePanel.id='headerMorePanel';headerMorePanel.hidden=true;
const headerIdentity=el('div');headerIdentity.id='headerIdentity';headerIdentity.hidden=true;
$('workspaceName').before(headerIdentity);
const headerIdentityItems=['workspaceName','status'].map(id=>{
    const control=$(id),marker=document.createComment(id);
    control.before(marker);return {control,marker};
});
const headerStatusDetail=el('div');headerStatusDetail.id='headerStatusDetail';headerMorePanel.append(headerStatusDetail);
const headerMoreItems=['openWorkspace','historyButton','dual','refresh','fullscreenToggle','shortcutSettings','themeToggle','installApp'].map(id=>{
    const control=$(id),marker=document.createComment(id);
    control.before(marker);return {control,marker};
});
$('refresh').setAttribute('aria-label','重新读取文件');
compactHeader.append(headerMore,headerMorePanel);
function setHeaderMore(open){
    open=!!open&&compactHeaderQuery.matches&&!headerHidden();
    headerMorePanel.hidden=!open;headerMore.setAttribute('aria-expanded',String(open));
}
function syncCompactHeader(){
    setHeaderMore(false);
    for(const {control,marker} of headerIdentityItems){
        if(compactHeaderQuery.matches)headerIdentity.append(control);
        else marker.after(control);
    }
    headerIdentity.hidden=!compactHeaderQuery.matches;
    for(const {control,marker} of headerMoreItems){
        if(compactHeaderQuery.matches)headerMorePanel.append(control);
        else marker.after(control);
    }
    headerMore.hidden=!compactHeaderQuery.matches;
}
function syncHeaderStatus(){
    const value=$('status').textContent;
    const normal=/^(已加载|已同步|已保存|已保存版本)$/.test(value);
    $('status').title=value;
    headerStatusDetail.textContent=value;
    $('status').classList.toggle('statusAttention',!normal);
    $('status').classList.toggle('statusError',/失败|冲突|异常|切换/.test(value));
    headerMore.classList.toggle('statusAttention',!normal);
    headerMore.classList.toggle('statusError',/失败|冲突|异常|切换/.test(value));
    headerMore.title='更多页面操作 · '+value;
    headerMore.setAttribute('aria-label','更多页面操作 · '+value);
}
new MutationObserver(syncHeaderStatus).observe($('status'),{childList:true,characterData:true,subtree:true});
syncHeaderStatus();syncCompactHeader();
compactHeaderQuery.addEventListener('change',syncCompactHeader);
headerMorePanel.addEventListener('click',e=>{if(e.target.closest('button'))setHeaderMore(false)},true);
document.addEventListener('pointerdown',e=>{if(!headerMorePanel.hidden&&!e.target.closest('#headerMore,#headerMorePanel'))setHeaderMore(false)},true);
document.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&!headerMorePanel.hidden){e.stopImmediatePropagation();setHeaderMore(false);headerMore.focus()}
},true);
new MutationObserver(()=>{if(headerHidden())setHeaderMore(false)}).observe(document.body,{attributes:true,attributeFilter:['class']});

window.addEventListener('pagehide',()=>{captureReading();flushReading()});
document.addEventListener('visibilitychange',()=>{if(document.hidden){captureReading();flushReading();readingInteracted=false}else syncNow()});
window.addEventListener('focus',()=>syncNow());
document.addEventListener('visibilitychange',()=>{if(!document.hidden)syncShortcuts()});
window.addEventListener('focus',()=>syncShortcuts());
setInterval(()=>{if(!document.hidden)syncShortcuts()},1500);
document.addEventListener('focusout',()=>setTimeout(()=>syncNow(),0),true);
for(const type of ['beforeinput','input','keydown'])document.addEventListener(type,e=>{if(e.target.closest?.('.richText,.editableTitle,math-field,textarea'))lastEditorInput=Date.now()},true);
document.addEventListener('compositionstart',()=>{editorComposing=true},true);
document.addEventListener('compositionend',()=>{editorComposing=false;lastEditorInput=Date.now();if(syncNeeded)scheduleSyncRetry()},true);
document.addEventListener('pointerdown',e=>{if(e.target.closest?.('.visualDocument,.editableTitle'))editorPointer=true},true);
for(const type of ['pointerup','pointercancel'])window.addEventListener(type,()=>{editorPointer=false;if(syncNeeded)scheduleSyncRetry()},true);
window.addEventListener('blur',()=>{editorPointer=false;editorComposing=false});
let syncEvents;
if(typeof EventSource==='function'){syncEvents=new EventSource('/api/events');syncEvents.addEventListener('change',signalSync)}
setInterval(()=>syncNow(),1500); // Fallback for buffered proxies, offline edits and reconnects.
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
    window.mathVirtualKeyboard?.addEventListener?.('geometrychange',positionFloatingTools);
    window.mathVirtualKeyboard?.addEventListener?.('virtual-keyboard-toggle',()=>requestAnimationFrame(positionFloatingTools));
    await syncShortcuts();
    load();
});
