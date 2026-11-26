/* Visual editor. Markdown and TeX are internal persistence formats. */
'use strict';
function visualParts(raw){
    const list=[];
    function prose(s){for(const x of s.trim().split(/\r?\n[ \t]*\r?\n+/))if(x.trim()){const m=x.trim().match(/^\[\[embed:([^\]\n]+)\]\]$/);list.push(m?{kind:'embed',ref:m[1],raw:x.trim()}:{kind:'text',raw:x});}}
    let end=0;
    for(const m of raw.matchAll(objectPattern())){prose(raw.slice(end,m.index));list.push({kind:m[1],id:m[2],flags:m[3]||'',raw:m[0],body:m[4]});end=m.index+m[0].length}
    prose(raw.slice(end));
    return list;
}
// Old notes can contain bare Markdown images. Give standalone image lines the
// same internal figure representation as pasted files, without rewriting a
// note merely by opening it. Do not reinterpret Markdown inside code or links.
function noteParts(raw){
    const parts=[];
    for(const p of visualParts(raw)){
        if(p.kind!=='text'){parts.push(p);continue}
        const tokens=marked.lexer(p.raw);
        if(tokens.length!==1||tokens[0].type!=='paragraph'||!tokens[0].tokens?.some(t=>t.type==='image'&&figureImagePattern().test(t.raw))){parts.push(p);continue}
        let pending='';
        const flush=()=>{if(pending.trim())parts.push({kind:'text',raw:pending.trim()});pending=''};
        for(const t of tokens[0].tokens||[]){
            const m=t.type==='image'&&[...t.raw.matchAll(figureImagePattern())][0];
            if(!m||m[0]!==t.raw){pending+=t.raw;continue}
            flush();const id='fig-'+uid(),image=figureImageMarkup(m[1],m[2],m[3],'subfig-'+uid()),body='\n\n'+image;
            parts.push({kind:'figure',id,flags:'',body,raw:':::figure '+id+'\n'+body+'\n:::'});
        }
        flush();
    }
    return parts;
}
function visualMath(tex,display,onInput){
    const f=document.createElement('math-field');f.className='visualMath'+(display?' displayMath':'');f.setAttribute('contenteditable','false');f.setAttribute('math-virtual-keyboard-policy','auto');
    f.setAttribute('aria-label','可编辑数学公式');f.value=tex;f._texOriginal=tex;f._texChanged=false;f.dataset.tex=tex;
    setEditorControlMode(f);
    function removeBuiltinMenu(){if(!f.isConnected)return;try{f.menuItems=[];f.popoverPolicy='off'}catch(err){/* Wait for MathLive to mount its internal editor. */}}
    customElements.whenDefined('math-field').then(()=>requestAnimationFrame(removeBuiltinMenu));f.addEventListener('focusin',removeBuiltinMenu);
    f.addEventListener('input',e=>{e.stopPropagation();if(!editingEnabled)return;f._texChanged=true;f.dataset.tex=f.value;onInput(f.value)});
    return f;
}
function mathPanel(field){
    const bar=el('div','mathPalette');
    const symbols=[['分数',String.raw`\frac{#0}{#?}`],['上标','^{#?}'],['下标','_{#?}'],['根号',String.raw`\sqrt{#0}`],['积分',String.raw`\int_{#?}^{#?}`],['求和',String.raw`\sum_{#?}^{#?}`],['矩阵',String.raw`\begin{pmatrix}#?&#?\\#?&#?\end{pmatrix}`],['偏导',String.raw`\partial`],['矢量',String.raw`\vec{#0}`],['α',String.raw`\alpha`],['β',String.raw`\beta`],['ρ',String.raw`\rho`],['μ',String.raw`\mu`],['σ',String.raw`\sigma`],['ω',String.raw`\omega`],['π',String.raw`\pi`],['±',String.raw`\pm`],['≤',String.raw`\le`]];
    for(const [name,value] of symbols){const b=btn(name,()=>{field.focus();field.insert(value,{insertionMode:'replaceSelection'});field.dispatchEvent(new Event('input',{bubbles:true}))});b.addEventListener('pointerdown',e=>e.preventDefault());bar.append(b)}
    bar.append(btn('数学键盘',()=>{field.focus();window.mathVirtualKeyboard?.show()}));return bar
}
// A note marker is a selectable reference, not an editable text character.
const noteLabelSelector='.inlineAnnotation,.objectNoteMarker,.freeNoteMarker,.noteWindowHandle';
function clearNoteLabel(){
    document.querySelectorAll('.selectedNoteLabel').forEach(chip=>{chip.classList.remove('selectedNoteLabel');chip.setAttribute('aria-pressed','false')});
}
function selectNoteLabel(chip){
    clearNoteLabel();
    for(const root of document.querySelectorAll('.visualDocument')){root._clearObject?.();root._clearMixed?.()}
    chip.classList.add('selectedNoteLabel');chip.setAttribute('aria-pressed','true');
    chip.focus({preventScroll:true});getSelection()?.removeAllRanges();scheduleToolbarUpdate();
}
function noteLabelMenu(chip){
    const id=chip.dataset.noteId,n=find(id);if(!n)return [];
    const detach=()=>{if(!chip.isConnected||!requireEditMode())return;clearNoteLabel();chip._detachNote?.()};
    return [['剪切',async()=>{if(chip._detachNote&&requireEditMode()){await writeEditorClipboard(annotationClipboard(n,true));detach()}},!chip._detachNote],['复制',()=>writeEditorClipboard(annotationClipboard(n))],
        ['打开批注',()=>chip._openNote?.()],
        ['删除批注',()=>{if(!requireEditMode())return;clearNoteLabel();if(dialog.open)closeWorkbenchDialog();deleteNode(find(id))}],
        ...(chip.matches('.objectNoteMarker')?[['解除绑定',detach]]:chip.matches('.freeNoteMarker')?[['移除此处标记',detach]]:[])];
}
function setupNoteLabel(chip,id,open,detach,windowHandle=false){
    chip.dataset.noteId=id;chip.tabIndex=0;chip.setAttribute('role','button');chip.setAttribute('aria-pressed','false');
    chip.title=windowHandle?'单击选中批注，拖动移动窗口':'单击选中，再次点击打开批注（查看模式直接打开）';
    chip._openNote=()=>{clearNoteLabel();const r=chip.getBoundingClientRect();open({clientX:r.left,clientY:r.bottom})};
    chip._detachNote=detach;
    let wasSelected=false;
    chip.addEventListener('pointerdown',e=>{wasSelected=chip.classList.contains('selectedNoteLabel');if(e.button===0&&e.pointerType!=='touch')e.preventDefault()});
    chip.addEventListener('pointercancel',()=>{wasSelected=false});
    chip.addEventListener('click',e=>{e.stopPropagation();const reopen=wasSelected||chip.classList.contains('selectedNoteLabel');wasSelected=false;if(windowHandle)selectNoteLabel(chip);else if(!editingEnabled||reopen){clearNoteLabel();open(e)}else selectNoteLabel(chip)});
    chip.addEventListener('keydown',e=>{
        if(e.defaultPrevented||e.isComposing||e.ctrlKey||e.metaKey||e.altKey||e.shiftKey)return;
        if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();chip._openNote();return}
        if(e.key==='Escape'){clearNoteLabel();scheduleToolbarUpdate();return}
        if(e.key==='Delete'&&chip.classList.contains('selectedNoteLabel')){e.preventDefault();e.stopPropagation();if(editingEnabled&&!e.repeat)noteLabelMenu(chip).find(x=>x[0]==='删除批注')?.[1]()}
    });
    context(chip,()=>{selectNoteLabel(chip);return noteLabelMenu(chip)},()=>resolve(id),true);
}
document.addEventListener('pointerdown',e=>{if(!isActionSurface(e.target)&&!e.target.closest('.selectedNoteLabel'))clearNoteLabel()},true);
document.addEventListener('focusin',e=>{if(!isActionSurface(e.target)&&!e.target.closest('.selectedNoteLabel'))clearNoteLabel()},true);
document.addEventListener('click',e=>{if(dialog.open&&(e.target===dialog||e.target===$('dialogBody'))){const handle=dialog.querySelector('.noteWindowHandle');if(handle)selectNoteLabel(handle)}});
function visualRef(kind,id,allowRefs=true){
    const chip=el('span','visualRef');chip.contentEditable='false';chip.dataset.token='[['+kind+':'+id+']]';
    if(kind==='embed'){const n=find(id);chip.textContent='※';chip.classList.add('inlineAnnotation');chip.setAttribute('aria-label','批注');chip.title='批注不存在';if(n)setupNoteLabel(chip,id,e=>{const current=find(id);if(current)openAnnotationNote(current,chip,e)},()=>{
        const area=chip.closest('.richText');if(!area)return;
        annotationEdit(()=>{const note=find(id);if(note){delete note.annotation;delete note.textBindings}chip.remove();area.dispatchEvent(new Event('input',{bubbles:true}))});
    });}
    else {const t=resolve(id),note=db.blocks.find(n=>n.id===id);const text=kind==='cite'?'['+id+']':note?note.title:t?(kind==='eqref'?'('+(t.number||t.title)+')':t.number||t.title):'〔未解析：'+id+'〕';chip.textContent=text;if(note||!allowRefs)chip.classList.add('legacyNoteRef');else if(texTarget(t)){chip.title=t.title;context(chip,()=>refMenu(t),()=>resolve(id)||t);chip.addEventListener('click',e=>{e.stopPropagation();jump(id,e.shiftKey)})}}
    return chip
}
function visualRich(raw,changed,compact=false,allowRefs=true){
    const host=el('div','richText'+(compact?' compact':''));host.contentEditable='true';host.spellcheck=false;host.setAttribute('role','textbox');host.setAttribute('aria-multiline','true');
    setEditorControlMode(host);
    const tokens=[];
    function token(kind,value){const i=tokens.push({kind,value})-1;return '<span data-wb-token="'+i+'"></span>'}
    const src=raw.replace(/(?<!\\)\$\$([\s\S]+?)\$\$|(?<!\\)\$([^\n$]+?)\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\[\[(ref|eqref|embed|cite):([^\]\n]+)\]\]/g,(m,dm,im,bd,bi,k,id)=>dm!=null?token('math',dm):im!=null?token('math',im):bd!=null?token('math',bd):bi!=null?token('math',bi):token(k,id));
    host.innerHTML=DOMPurify.sanitize(marked.parse(src,{gfm:true,breaks:false}),{ADD_ATTR:['data-wb-token']});
    for(const p of host.querySelectorAll('[data-wb-token]')){
        const t=tokens[Number(p.dataset.wbToken)];if(!t){p.remove();continue}
        if(t.kind==='math'){
            const f=visualMath(t.value,false,()=>changed());f.dataset.inline='1';p.replaceWith(f);
        }else p.replaceWith(visualRef(t.kind,t.value,allowRefs))
    }
    if(!host.childNodes.length)host.append(el('p'));
    host.addEventListener('input',()=>{if(editingEnabled)changed()});
    // Avoid pasting untrusted HTML; recognized structured text is handled by the parent.
    host.addEventListener('paste',e=>{if(e.defaultPrevented)return;const items=[...(e.clipboardData?.items||[])];if(items.some(x=>x.type.startsWith('image/')))return;e.preventDefault();const text=e.clipboardData?.getData('text/plain')||'';document.execCommand('insertText',false,text);changed()});
    return host
}
function richMarkdown(host,fragment=false){
    function walk(n){
        if(n.nodeType===Node.TEXT_NODE)return (n.textContent||'').replace(/\u00a0/g,' ');
        if(n.nodeType!==Node.ELEMENT_NODE)return '';
        if(n.tagName==='MATH-FIELD')return '$'+(n.dataset.tex??(n._texChanged?n.value:n._texOriginal||n.value||''))+'$';
        if(n.dataset.token)return n.dataset.token;
        const inner=[...n.childNodes].map(walk).join('');
        if(n.tagName==='BR')return '\n';
        if(['B','STRONG'].includes(n.tagName))return '**'+inner+'**';
        if(['I','EM'].includes(n.tagName))return '*'+inner+'*';
        if(n.tagName==='CODE')return '\x60'+inner+'\x60';
        if(/^H[1-6]$/.test(n.tagName))return '\n'+'#'.repeat(+n.tagName[1])+' '+inner+'\n\n';
        if(n.tagName==='LI')return '- '+inner+'\n';
        if(['P','DIV','UL','OL','BLOCKQUOTE'].includes(n.tagName))return inner+'\n\n';
        if(n.tagName==='IMG'&&n.getAttribute('src')?.startsWith('/assets/'))return '!['+(n.alt||'图片')+']('+n.getAttribute('src')+')';
        return inner;
    }
    const text=[...host.childNodes].map(walk).join('');return fragment?text.replace(/^\n+|\n+$/g,''):text.trim()
}
// The document consists of independent editable paragraphs. Keep native
// line movement within each one, and bridge their visual line boundaries.
let verticalCaretX=null;
function caretBounds(range){
    const r=[...range.getClientRects()].find(r=>r.height>0)||range.getBoundingClientRect();
    return r.height>0?r:null
}
function proseLineRects(area){
    const rects=[];
    const add=(r)=>{if(r.height>0&&Number.isFinite(r.left))rects.push(r)};
    const walker=document.createTreeWalker(area,NodeFilter.SHOW_TEXT|NodeFilter.SHOW_ELEMENT,{
        acceptNode(n){
            if(n.nodeType===Node.TEXT_NODE)return n.parentElement?.closest('[contenteditable=false],math-field')?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT;
            return n.matches('br,math-field,[contenteditable=false]')?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_SKIP
        }
    });
    for(let n=walker.nextNode();n;n=walker.nextNode()){
        if(n.nodeType===Node.TEXT_NODE){if(!n.length)continue;const r=document.createRange();r.selectNodeContents(n);for(const box of r.getClientRects())add(box)}
        else if(!n.parentElement?.closest('[contenteditable=false],math-field'))add(n.getBoundingClientRect())
    }
    return rects;
}
function proseEdge(area,down){
    const rects=proseLineRects(area);
    if(!rects.length){const r=area.getBoundingClientRect();return {y:r.top+Math.min(r.height/2,14),rects:[r]}}
    const center=r=>(r.top+r.bottom)/2;
    const y=(down?Math.min:Math.max)(...rects.map(center));
    const lh=parseFloat(getComputedStyle(area).lineHeight)||26;
    return {y,rects:rects.filter(r=>Math.abs(center(r)-y)<lh*.55)}
}
function crossParagraphArrow(e){
    if(!editingEnabled)return;
    if(e.key!=='ArrowUp'&&e.key!=='ArrowDown'){verticalCaretX=null;return}
    if(e.defaultPrevented||e.isComposing||e.keyCode===229||e.ctrlKey||e.metaKey||e.altKey||e.shiftKey)return;
    if(e.composedPath().some(n=>n.tagName==='MATH-FIELD'))return;
    const area=e.target.closest?.('.part-text .richText');
    const sel=window.getSelection();
    if(!area||!sel?.rangeCount||!sel.isCollapsed||!area.contains(sel.anchorNode))return;
    const range=sel.getRangeAt(0),caret=caretBounds(range),down=e.key==='ArrowDown';
    if(!caret&&area.textContent.trim())return;
    const lh=parseFloat(getComputedStyle(area).lineHeight)||26;
    const edge=proseEdge(area,!down),cy=caret?(caret.top+caret.bottom)/2:edge.y;
    if(verticalCaretX===null)verticalCaretX=caret?.left??area.getBoundingClientRect().left;
    // A paragraph may wrap over many lines; only leave its outermost line.
    if(Math.abs(cy-edge.y)>lh*.58)return;
    const scope=area.closest('.pane')||area.closest('.blankNoteDialog')||area.closest('.visualDocument');
    if(!scope)return;
    const fields=[...scope.querySelectorAll('.part-text .richText')].filter(a=>a.isContentEditable&&a.getClientRects().length&&!a.closest('[hidden]'));
    const next=fields[fields.indexOf(area)+(down?1:-1)];
    if(!next)return;
    e.preventDefault();
    const scrollHost=next.closest('.pane')||next.closest('.blankNoteDialog .visualDocument');
    let dest=proseEdge(next,down);
    if(scrollHost){const r=scrollHost.getBoundingClientRect(),top=Math.max(0,r.top)+8,bottom=Math.min(innerHeight,r.bottom)-8;
        if(dest.y<top)scrollHost.scrollTop+=dest.y-top-lh*.5;
        else if(dest.y>bottom)scrollHost.scrollTop+=dest.y-bottom+lh*.5;
        dest=proseEdge(next,down)
    }
    const distance=r=>Math.max(r.left-verticalCaretX,0,verticalCaretX-r.right);
    const fragment=dest.rects.sort((a,b)=>distance(a)-distance(b))[0];
    const x=Math.max(fragment.left+.5,Math.min(verticalCaretX,Math.max(fragment.left+.5,fragment.right-.5)));
    let target=document.caretRangeFromPoint?.(x,dest.y);
    if(!target||!next.contains(target.startContainer)||((target.startContainer.nodeType===Node.ELEMENT_NODE?target.startContainer:target.startContainer.parentElement)?.closest('[contenteditable=false],math-field'))){
        target=document.createRange();target.selectNodeContents(next);target.collapse(down)
    }else target.collapse(true);
    next.focus({preventScroll:true});sel.removeAllRanges();sel.addRange(target)
}
document.addEventListener('keydown',crossParagraphArrow);
document.addEventListener('pointerdown',()=>{verticalCaretX=null},true);
document.addEventListener('input',()=>{verticalCaretX=null},true);
function visualImageUpload(file,done){
    if(!file)return Promise.resolve();
    return (async()=>{try{
        const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=reject;r.readAsDataURL(file)});
        const result=await api('/api/upload',{data});done?.(result.url,file.name||'图片');return {url:result.url,name:file.name||'图片'}
    }catch(e){showToast(e.message)}})()
}
function visualPick(onSelect){
    const existing=dialog.open,d=existing?$('dialogBody'):showDialog('选择引用对象');
    const container=el('div','visualPicker'),q=el('input'),list=el('div','visualPickList');q.placeholder='搜索标题、公式、编号';
    container.append(q,list,btn('取消',()=>{if(existing)container.remove();else dialog.close()}));d.append(container);
    function draw(){list.replaceChildren();const needle=q.value.toLowerCase();for(const t of [...targets.values()].filter(t=>texTarget(t)&&((t.title||'')+' '+t.id+' '+t.number).toLowerCase().includes(needle)).slice(0,80)){
        list.append(btn((t.kind==='equation'?'式 ':t.kind==='figure'?'图 ':t.kind==='table'?'表 ':'')+(t.number||'')+' '+(t.title||t.id),()=>{onSelect(refToken(t));if(existing)container.remove();else dialog.close()}))
    }}q.addEventListener('input',draw);draw();q.focus()
}
function visualDocument(raw,onUpdate,owner=null,pi=null){
    const internal=owner===null||spaceOf(owner)==='blocks',parseParts=internal?noteParts:visualParts;
    let parts=parseParts(raw),focused=null,selection=null;
    if(!parts.length)parts=[{kind:'text',raw:''}];
    const root=el('div','visualDocument'),body=el('div','visualBody');
    root.append(body);root._owner=owner;root._internalObjects=internal;
    let selectedPart=parts[0],selectedObject=null;
    const value=()=>parts.map(p=>p.raw).filter(x=>x.trim()).join('\n\n')+'\n';
    let lastValue=value(),draftUndo=[],draftRedo=[];
    function flush(){
        const s=value();if(s===lastValue)return;
        if(dialog.contains(root)){draftUndo.push(lastValue);if(draftUndo.length>60)draftUndo.shift();draftRedo=[]}
        lastValue=s;onUpdate(s)
    }
    function draftHistory(redo){
        if(!requireEditMode())return;
        const from=redo?draftRedo:draftUndo,to=redo?draftUndo:draftRedo;if(!from.length)return;
        to.push(value());lastValue=from.pop();parts=parseParts(lastValue);if(!parts.length)parts=[{kind:'text',raw:''}];selectedPart=parts[0];selectedObject=null;draw();onUpdate(lastValue);root.focus({preventScroll:true})
    }
    root._draftHistory=draftHistory;
    root._canDraftHistory=redo=>!!(redo?draftRedo:draftUndo).length;
    // A visual document has several independent editing hosts. Keep a logical
    // range across them rather than letting the browser edit their outer DOM.
    let mixed=null,anchorPoint=null,focusPoint=null,dragging=false;
    const cards=()=>[...body.children];
    const point=(node,offset)=>({node,offset});
    const edge=(card,end)=>{const area=card._part.kind==='text'&&card.querySelector('.richText');return area?point(area,end?area.childNodes.length:0):point(body,cards().indexOf(card)+(end?1:0))};
    const collapsed=p=>{const r=document.createRange();r.setStart(p.node,p.offset);r.collapse(true);return r};
    const compare=(a,b)=>collapsed(a).compareBoundaryPoints(Range.START_TO_START,collapsed(b));
    const cardOf=n=>(n.nodeType===1?n:n.parentElement)?.closest('.visualCard');
    function rangeOf(a,b){const r=collapsed(a);if(compare(a,b)<=0)r.setEnd(b.node,b.offset);else r.setStart(b.node,b.offset);return r}
    function selectedPieces(r,serialize=false){
        if(!r||r.collapsed||!body.contains(r.startContainer)||!body.contains(r.endContainer))return [];
        return cards().flatMap(card=>{
            const bounds=document.createRange();bounds.selectNode(card);
            if(r.compareBoundaryPoints(Range.END_TO_START,bounds)>=0||r.compareBoundaryPoints(Range.START_TO_END,bounds)<=0)return [];
            const p=card._part;
            if(p.kind!=='text')return [serialize?{card,p,raw:card._clipboardRaw?.()||p.raw}:{card,p}];
            const area=card.querySelector('.richText'),whole=document.createRange();whole.selectNodeContents(area);
            const local=whole.cloneRange();
            if(area.contains(r.startContainer))local.setStart(r.startContainer,r.startOffset);
            if(area.contains(r.endContainer))local.setEnd(r.endContainer,r.endOffset);
            if(local.collapsed)return [];
            if(!serialize)return [{card,p,local}];
            const before=whole.cloneRange(),after=whole.cloneRange();before.setEnd(local.startContainer,local.startOffset);after.setStart(local.endContainer,local.endOffset);
            const md=x=>{const h=el('div');h.append(x.cloneContents());return richMarkdown(h,true)};
            return [{card,p,local,raw:md(local),before:md(before),after:md(after)}]
        })
    }
    function nativeRange(){const s=getSelection();return s?.rangeCount&&body.contains(s.anchorNode)&&body.contains(s.focusNode)?s.getRangeAt(0):null}
    function activeMixed(){
        if(mixed&&!mixed.collapsed&&body.contains(mixed.startContainer)&&body.contains(mixed.endContainer))return mixed;
        const r=nativeRange();return r&&!r.collapsed&&cardOf(r.startContainer)!==cardOf(r.endContainer)?r:null
    }
    root._mixedRange=activeMixed;
    const handles=[el('span','rangeHandle rangeStart'),el('span','rangeHandle rangeEnd')];
    for(const h of handles){h.hidden=true;root.append(h);h.setAttribute('aria-hidden','true')}
    let ownsHighlight=false;
    function clearHighlight(){if(ownsHighlight&&window.CSS?.highlights){CSS.highlights.delete('paper-range');ownsHighlight=false}}
    function clearMixed(){mixed=null;anchorPoint=focusPoint=null;for(const c of cards())c.classList.remove('rangeSelected');for(const h of handles)h.hidden=true;clearHighlight()}
    root._clearMixed=clearMixed;
    function syncRange(){
        const cross=activeMixed(),r=cross||nativeRange(),pieces=selectedPieces(r);
        for(const c of cards())c.classList.toggle('rangeSelected',cross&&pieces.some(x=>x.card===c&&!x.local));
        if(cross&&window.CSS?.highlights&&window.Highlight){CSS.highlights.set('paper-range',new Highlight(...pieces.map(x=>x.local).filter(Boolean)));ownsHighlight=true}else clearHighlight();
        if(!matchMedia('(pointer:coarse)').matches||!r||r.collapsed||!pieces.length||(!cross&&!pieces[0].local)){for(const h of handles)h.hidden=true;return}
        for(let i=0;i<2;i++){
            const piece=i?pieces.at(-1):pieces[0],rr=piece.local?.cloneRange();if(rr)rr.collapse(!i);
            const b=rr?caretBounds(rr):piece.card.getBoundingClientRect(),h=handles[i];
            if(!b){h.hidden=true;continue}const x=rr?b.left:i?b.right:b.left,y=rr?b.bottom:i?b.bottom:b.top;
            h.hidden=x<0||x>innerWidth||y<0||y>innerHeight;h.style.left=Math.max(9,Math.min(innerWidth-9,x))+'px';h.style.top=y+'px'
        }
    }
    root._syncRange=syncRange;
    function setRange(a,b){
        anchorPoint=a;focusPoint=b;const r=rangeOf(a,b);clearObject();mixed=r;
        const s=getSelection();root.focus({preventScroll:true});
        // The logical range and CSS highlight are authoritative. Keeping a
        // native selection across independent hosts makes mobile Chromium
        // intercept the next toolbar tap to dismiss its native selection UI.
        if(window.CSS?.highlights&&window.Highlight)s.removeAllRanges();
        else try{s.setBaseAndExtent(a.node,a.offset,b.node,b.offset)}catch{}
        syncRange();scheduleToolbarUpdate()
    }
    function pointAt(x,y,fixed){
        let card=document.elementsFromPoint(x,y).map(n=>n.closest('.visualCard')).find(c=>c?.parentElement===body);
        if(!card||card.parentElement!==body)card=cards().filter(c=>c.getClientRects().length).sort((a,b)=>{const d=c=>{const r=c.getBoundingClientRect();return Math.max(r.top-y,y-r.bottom,0)};return d(a)-d(b)})[0];
        if(!card)return null;
        if(card._part.kind!=='text')return edge(card,compare(fixed,edge(card,false))<=0);
        const area=card.querySelector('.richText'),r=document.caretRangeFromPoint?.(x,y);
        if(r&&area.contains(r.startContainer)&&!(r.startContainer.nodeType===1?r.startContainer:r.startContainer.parentElement)?.closest('math-field,[data-token]'))return point(r.startContainer,r.startOffset);
        const rect=area.getBoundingClientRect();return edge(card,y>rect.top+rect.height/2||x>rect.right)
    }
    function selectionAnchor(){const s=getSelection();return anchorPoint||(s?.anchorNode&&body.contains(s.anchorNode)?point(s.anchorNode,s.anchorOffset):null)}
    root.addEventListener('pointerdown',e=>{
        if(e.target.closest('.rangeHandle'))return;
        if(e.button===0&&e.shiftKey){
            let a=selectionAnchor();
            if(!a&&selectedObject){const c=cards().find(c=>c._part===selectedObject);if(c)a=edge(c,e.clientY<c.getBoundingClientRect().top)}
            const b=a&&pointAt(e.clientX,e.clientY,a);
            if(a&&b&&(mixed||cardOf(a.node)!==cardOf(b.node))){e.preventDefault();e.stopImmediatePropagation();setRange(a,b);return}
        }
        if(e.button===0){clearMixed()}
    },true);
    root.addEventListener('click',e=>{if(e.shiftKey&&activeMixed()){e.preventDefault();e.stopImmediatePropagation()}},true);
    for(let i=0;i<2;i++)handles[i].addEventListener('pointerdown',e=>{
        const r=activeMixed()||nativeRange();if(!r)return;
        e.preventDefault();e.stopPropagation();dragging=true;$('menu').hidden=true;const h=handles[i],fixed=i?point(r.startContainer,r.startOffset):point(r.endContainer,r.endOffset);h.setPointerCapture(e.pointerId);
        const scroller=root.closest('.blankNoteDialog .visualDocument,.pane')||root;
        let latest=null,frame=0;
        const update=()=>{if(!latest)return;const b=pointAt(latest.x,latest.y-10,fixed);if(b)setRange(fixed,b)};
        const autoscroll=()=>{
            frame=0;if(!dragging||!latest)return;
            const rect=scroller.getBoundingClientRect(),top=Math.max(rect.top,0),bottom=Math.min(rect.bottom,innerHeight),margin=40;
            const delta=latest.y<top+margin?-Math.min(20,(top+margin-latest.y)/3):latest.y>bottom-margin?Math.min(20,(latest.y-bottom+margin)/3):0;
            if(delta){const before=scroller.scrollTop;scroller.scrollTop+=delta;if(scroller.scrollTop!==before)update()}
            frame=requestAnimationFrame(autoscroll)
        };
        const move=ev=>{latest={x:ev.clientX,y:ev.clientY};update();if(!frame)frame=requestAnimationFrame(autoscroll)};
        const end=()=>{dragging=false;cancelAnimationFrame(frame);h.removeEventListener('pointermove',move);h.removeEventListener('pointerup',end);h.removeEventListener('pointercancel',end);h.removeEventListener('lostpointercapture',end);syncRange()};
        h.addEventListener('pointermove',move);h.addEventListener('pointerup',end);h.addEventListener('pointercancel',end);h.addEventListener('lostpointercapture',end)
    });
    root._prepareTouchRange=e=>{
        if(!e.target.closest('.part-text .richText')||activeMixed()||nativeRange()?.collapsed===false)return;
        const r=document.caretRangeFromPoint?.(e.clientX,e.clientY),n=r?.startContainer;
        if(n?.nodeType!==Node.TEXT_NODE||!body.contains(n)||!n.textContent.trim())return;
        const segments=[...new Intl.Segmenter(undefined,{granularity:'word'}).segment(n.textContent)];
        const word=segments.find(x=>x.index<=r.startOffset&&x.index+x.segment.length>r.startOffset&&x.isWordLike);if(!word)return;
        const s=getSelection();s.setBaseAndExtent(n,word.index,n,word.index+word.segment.length);syncRange()
    };
    function mixedClipboard(r,cut){const pieces=selectedPieces(r,true),raw=pieces.map(x=>x.raw).filter(x=>x.trim()).join('\n\n');return cut?raw:remapCopiedObjects(raw,owner,true)}
    function replaceMixed(r,text=''){
        if(!editingEnabled||!root.isConnected)return;
        const pieces=selectedPieces(r,true);if(!pieces.length)return;
        const first=pieces[0],last=pieces.at(-1),i=parts.indexOf(first.p),j=parts.indexOf(last.p);if(i<0||j<i)return;
        return annotationEdit(()=>{
        const replacement=text.trim()?parseParts(remapCopiedObjects(prepareAnnotationPaste(text,owner),owner)):[];
        if(first.before?.trim()){
            if(replacement[0]?.kind==='text')replacement[0].raw=first.before+replacement[0].raw;
            else replacement.unshift({kind:'text',raw:first.before})
        }
        if(last.after?.trim()){
            if(replacement.at(-1)?.kind==='text')replacement.at(-1).raw+=last.after;
            else replacement.push({kind:'text',raw:last.after})
        }
        parts.splice(i,j-i+1,...replacement);if(!parts.length)parts=[{kind:'text',raw:''}];
        selectedPart=parts[Math.min(i,parts.length-1)];clearMixed();getSelection()?.removeAllRanges();draw();flush();const dest=cards().find(c=>c._part===selectedPart)?.querySelector('.part-text .richText');if(dest)placeIn(dest);else root.focus({preventScroll:true})})
    }
    function mixedMenu(r){return [['剪切',async()=>{if(requireEditMode()){await writeEditorClipboard(mixedClipboard(r,true));replaceMixed(r)}}],['复制',()=>writeEditorClipboard(mixedClipboard(r,false))],['粘贴',async()=>{if(requireEditMode()){const t=await readEditorClipboard();if(t!=null)replaceMixed(r,t)}}]]}
    root.addEventListener('contextmenu',e=>{const r=activeMixed();if(!r)return;e.preventDefault();e.stopImmediatePropagation();if(e.pointerType==='touch'||e.sourceCapabilities?.firesTouchEvents){touchMenuAt=Date.now();showFloatingTools(e,mixedMenu(r))}else menuAt(e,mixedMenu(r))},true);
    for(const type of ['copy','cut','paste'])root.addEventListener(type,e=>{
        const r=activeMixed();if(!r||!e.clipboardData)return;e.preventDefault();e.stopImmediatePropagation();
        if(type==='paste'){if(editingEnabled)replaceMixed(r,e.clipboardData.getData('text/plain'));return}
        if(type==='cut'&&!editingEnabled)return;const text=mixedClipboard(r,type==='cut');e.clipboardData.setData('text/plain',text);localClipboard=text;localClipboardPreferred=false;if(type==='cut')replaceMixed(r)
    },true);
    root.addEventListener('keydown',e=>{
        if(e.isComposing||e.keyCode===229)return;
        const r=activeMixed();
        if(r&&(e.ctrlKey||e.metaKey)&&!e.altKey&&!e.shiftKey&&['c','x','v'].includes(e.key.toLowerCase())){
            e.preventDefault();e.stopImmediatePropagation();
            const key=e.key.toLowerCase(),items=mixedMenu(r);
            if(key==='c')items[1][1]();else if(editingEnabled)items[key==='x'?0:2][1]();
            return
        }
        if(r&&['Delete','Backspace'].includes(e.key)){e.preventDefault();e.stopImmediatePropagation();if(editingEnabled)replaceMixed(r);return}
        if(r&&e.key==='Escape'){clearMixed();getSelection()?.removeAllRanges();return}
        if(r&&!e.shiftKey&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key)){
            e.preventDefault();e.stopImmediatePropagation();const forward=['ArrowRight','ArrowDown','End'].includes(e.key),p=forward?point(r.endContainer,r.endOffset):point(r.startContainer,r.startOffset),card=cardOf(p.node),area=card?.querySelector('.part-text .richText');
            clearMixed();const s=getSelection();
            if(area?.contains(p.node)){if(editingEnabled)area.focus({preventScroll:true});s.collapse(p.node,p.offset)}
            else if(card?._part.kind!=='text'&&card){selectObject(card._part,card);root.focus({preventScroll:true})}
            else if(p.node===body){const c=cards()[forward?p.offset-1:p.offset];if(c?._part.kind==='text')placeIn(c.querySelector('.richText'),forward);else if(c){selectObject(c._part,c);root.focus({preventScroll:true})}}
            return
        }
        if(r&&editingEnabled&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&e.key.length===1){e.preventDefault();e.stopImmediatePropagation();replaceMixed(r,e.key);return}
        if(!r&&e.composedPath().some(n=>n.tagName==='MATH-FIELD'))return;
        if(!e.shiftKey||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)||e.ctrlKey||e.altKey||e.metaKey)return;
        const a=selectionAnchor(),s=getSelection(),b=focusPoint||(s?.focusNode&&body.contains(s.focusNode)?point(s.focusNode,s.focusOffset):null);if(!a||!b)return;
        const forward=['ArrowRight','ArrowDown'].includes(e.key),vertical=['ArrowUp','ArrowDown'].includes(e.key),card=cardOf(b.node),list=cards();let next;
        if(card?._part.kind==='text'){
            const area=card.querySelector('.richText'),rest=document.createRange();rest.selectNodeContents(area);if(forward)rest.setStart(b.node,b.offset);else rest.setEnd(b.node,b.offset);
            const frag=rest.cloneContents(),atEdge=!frag.textContent.trim()&&!frag.querySelector('math-field,[data-token],img');
            const caret=caretBounds(collapsed(b)),line=vertical&&proseEdge(area,!forward),atLine=vertical&&caret&&Math.abs((caret.top+caret.bottom)/2-line.y)<(parseFloat(getComputedStyle(area).lineHeight)||26)*.6;
            if(atEdge||atLine)next=list[list.indexOf(card)+(forward?1:-1)];
            else if(r){try{s.collapse(b.node,b.offset);s.modify('move',forward?'forward':'backward',vertical?'line':'character');const p=point(s.focusNode,s.focusOffset);if(body.contains(p.node)) {e.preventDefault();setRange(a,p);return}}catch{}}
        }else if(b.node===body)next=list[b.offset+(forward?0:-1)];else if(card)next=list[list.indexOf(card)+(forward?1:-1)];
        if(next){e.preventDefault();e.stopImmediatePropagation();setRange(a,edge(next,next._part.kind==='text'?!forward:forward));next.scrollIntoView({block:'nearest'})}
    },true);
    root.addEventListener('beforeinput',e=>{if(activeMixed()&&!dragging&&editingEnabled&&e.inputType?.startsWith('insert')&&!e.isComposing){e.preventDefault();if(e.inputType==='insertText'&&e.data)replaceMixed(activeMixed(),e.data)}},true);
    function selectObject(p,card){
        selectedObject=p.kind==='text'?null:p;
        document.querySelectorAll('.selectedImage').forEach(x=>x.classList.remove('selectedImage'));
        for(const c of body.children)c.classList.toggle('selectedObject',c===card&&!!selectedObject)
        if(selectedObject)getSelection()?.removeAllRanges()
    }
    function clearObject(){selectedObject=null;for(const c of body.children){c.classList.remove('selectedObject');c.querySelectorAll('.selectedImage').forEach(x=>x.classList.remove('selectedImage'))}}
    root._clearObject=clearObject;
    root.addEventListener('pointerdown',e=>{if(!e.target.closest('.visualCard'))clearObject()},true);
    function placeIn(area,end=false){
        if(!area)return;
        area.focus({preventScroll:true});const r=document.createRange();r.selectNodeContents(area);r.collapse(!end);const s=getSelection();s.removeAllRanges();s.addRange(r)
    }
    function removePart(p,keepCaret=false){
        const i=parts.indexOf(p);if(i<0)return;
        const card=[...body.children].find(c=>c._part===p);
        parts.splice(i,1);card?.remove();clearObject();
        if(!parts.length){parts=[{kind:'text',raw:''}];draw()}
        selectedPart=parts[Math.min(i,parts.length-1)];flush();
        if(!keepCaret){
            const next=[...body.children].slice(i).find(c=>c._part.kind==='text')?.querySelector('.richText');
            const prev=[...body.children].slice(0,i).reverse().find(c=>c._part.kind==='text')?.querySelector('.richText');
            if(next||prev)placeIn(next||prev,!next);else root.focus({preventScroll:true})
        }
    }
    function atomicAt(area,caret,forward){
        const atoms=[...area.querySelectorAll('math-field,[data-token],img')];
        if(!forward)atoms.reverse();
        for(const atom of atoms){
            const edge=document.createRange();edge.selectNode(atom);edge.collapse(forward);
            const cmp=edge.compareBoundaryPoints(Range.START_TO_START,caret);
            if(forward?cmp<0:cmp>0)continue;
            const between=document.createRange();
            if(forward){between.setStart(caret.startContainer,caret.startOffset);between.setEnd(edge.startContainer,edge.startOffset)}
            else{between.setStart(edge.startContainer,edge.startOffset);between.setEnd(caret.startContainer,caret.startOffset)}
            const frag=between.cloneContents();
            if(!frag.textContent.replace(/\u200b/g,'')&&!frag.querySelector('math-field,[data-token],img,br'))return atom;
            break;
        }
        return null
    }
    // Join only adjacent prose cards, keeping the caret at the former break.
    // Rebuild the right inline nodes with callbacks owned by the surviving card.
    function joinProse(left,right){
        const leftCard=cards().find(c=>c._part===left),rightCard=cards().find(c=>c._part===right);
        const area=leftCard?.querySelector('.richText'),rightArea=rightCard?.querySelector('.richText');
        if(!area||!rightArea)return false;
        const tail=area.lastElementChild,head=rightArea.firstElementChild;
        const paragraph=n=>n&&/^(P|DIV|H[1-6])$/.test(n.tagName);
        if(!paragraph(tail)||!paragraph(head))return false;
        const fresh=visualRich(richMarkdown(rightArea),()=>{left.raw=richMarkdown(area);flush()},false,!internal);
        const start=fresh.firstElementChild;if(!paragraph(start))return false;
        // Marked inserts formatting newlines between block elements. Those are
        // not visible text and must not become a line break at the join.
        if(tail.lastChild?.nodeName==='BR'&&tail.childNodes.length===1)tail.lastChild.remove();
        const boundary=tail.childNodes.length;
        if(!(start.childNodes.length===1&&start.firstChild.nodeName==='BR'))tail.append(...start.childNodes);
        start.remove();area.append(...fresh.childNodes);
        parts.splice(parts.indexOf(right),1);rightCard.remove();selectedPart=left;clearObject();
        area.focus({preventScroll:true});const r=document.createRange();r.setStart(tail,boundary);r.collapse(true);
        const s=getSelection();s.removeAllRanges();s.addRange(r);remember();
        left.raw=richMarkdown(area);flush();return true
    }
    function deleteInRich(area,forward){
        const card=area.closest('.visualCard'),p=card?._part;
        const s=getSelection();if(!s?.rangeCount||!s.isCollapsed||!area.contains(s.anchorNode))return false;
        // Empty editable paragraphs still exist until saved.
        if(p?.kind==='text'&&!area.textContent.replace(/[\u200b\u00a0]/g,'').trim()&&!area.querySelector('math-field,[data-token],img')){
            if(parts.length===1)return true;
            const i=parts.indexOf(p);
            const before=cards().slice(0,i).reverse().find(c=>c._part.kind==='text')?.querySelector('.richText');
            const after=cards().slice(i+1).find(c=>c._part.kind==='text')?.querySelector('.richText');
            removePart(p,true);
            const dest=forward?(after||before):(before||after);
            if(dest)placeIn(dest,dest===before);else root.focus({preventScroll:true});
            return true
        }
        const caret=s.getRangeAt(0).cloneRange(),atom=atomicAt(area,caret,forward);
        if(atom){
            const r=document.createRange();r.setStartBefore(atom);r.collapse(true);atom.remove();s.removeAllRanges();s.addRange(r);area.dispatchEvent(new Event('input',{bubbles:true}));return true
        }
        if(p?.kind!=='text')return false;
        const edge=document.createRange();edge.selectNodeContents(area);
        if(forward)edge.setStart(caret.startContainer,caret.startOffset);else edge.setEnd(caret.startContainer,caret.startOffset);
        const frag=edge.cloneContents();
        // Ignore only DOM formatting newlines; real spaces and inline objects
        // still count as content, and an internal BR is handled natively.
        if(frag.textContent.replace(/[\u200b\r\n]/g,'')||frag.querySelector('math-field,[data-token],img,br'))return false;
        const neighbor=parts[parts.indexOf(p)+(forward?1:-1)];
        if(!neighbor)return false;
        if(neighbor.kind!=='text'){removePart(neighbor,true);return true}
        return forward?joinProse(p,neighbor):joinProse(neighbor,p)
    }
    root.addEventListener('keydown',e=>{
        if(!editingEnabled||e.defaultPrevented||e.isComposing||e.keyCode===229)return;
        const inMath=e.composedPath().some(x=>x.tagName==='MATH-FIELD');
        const area=e.target.closest?.('.richText'),inControl=e.target.closest?.('input,textarea,select,button');
        if(!['Backspace','Delete'].includes(e.key)||e.ctrlKey||e.metaKey||e.altKey||inMath||inControl)return;
        if(area){if(deleteInRich(area,e.key==='Delete'))e.preventDefault();return}
        if(selectedObject){
            e.preventDefault();const card=cards().find(c=>c._part===selectedObject);
            if(!card?._deleteSelectedImage?.())removePart(selectedObject)
        }
    });
    // Mobile soft keyboards may send beforeinput without a keydown.
    root.addEventListener('beforeinput',e=>{
        if(!editingEnabled||e.defaultPrevented||e.isComposing||!['deleteContentBackward','deleteContentForward'].includes(e.inputType)||e.composedPath().some(x=>x.tagName==='MATH-FIELD'))return;
        const area=e.target.closest?.('.richText');
        if(area&&deleteInRich(area,e.inputType==='deleteContentForward'))e.preventDefault()
    });
    function remember(){const s=window.getSelection();if(focused&&s?.rangeCount&&focused.contains(s.getRangeAt(0).commonAncestorContainer))selection=s.getRangeAt(0).cloneRange()}
    function insertInline(node){
        if(!focused||!focused.isConnected){add({kind:'text',raw:node.dataset.token||''});return}
        focused.focus();const s=window.getSelection();
        if(selection&&focused.contains(selection.commonAncestorContainer)){s.removeAllRanges();s.addRange(selection)}
        if(!s.rangeCount||!focused.contains(s.getRangeAt(0).commonAncestorContainer)){const range=document.createRange();range.selectNodeContents(focused);range.collapse(false);s.removeAllRanges();s.addRange(range)}
        const r=s.getRangeAt(0);r.deleteContents();r.insertNode(node);r.setStartAfter(node);r.collapse(true);s.removeAllRanges();s.addRange(r);focused.dispatchEvent(new Event('input',{bubbles:true}));if(node.tagName==='MATH-FIELD')node.focus()
    }
    function format(command){if(!focused||!focused.isConnected)return;focused.focus();if(selection&&focused.contains(selection.commonAncestorContainer)){const s=window.getSelection();s.removeAllRanges();s.addRange(selection)}document.execCommand(command,false,null);focused.dispatchEvent(new Event('input',{bubbles:true}))}
    function chooseImages(after=selectedPart){
        const f=$('file');f.value='';f.multiple=true;f.onchange=()=>{const files=[...f.files];f.multiple=false;uploadImages(files,after)};f.click()
    }
    function add(p,after=selectedPart){
        let i=parts.indexOf(after);parts.splice(i<0?parts.length:i+1,0,p);selectedPart=p;draw();flush();const card=[...body.children].find(e=>e._part===p);card?.scrollIntoView({block:'nearest'});card?.querySelector('[contenteditable=true],math-field,input')?.focus()
    }
    function insertPaste(text,after){
        return annotationEdit(()=>{
        text=prepareAnnotationPaste(text,owner);
        const ids=new Set(parts.flatMap(p=>[p.id,...(p.kind==='figure'?[...p.raw.matchAll(figureImagePattern())].map((m,i)=>figureImageId(m[3],p.id,i)):[])].filter(Boolean)));
        const collision=[...text.matchAll(objectPattern())].some(m=>ids.has(m[2])||(m[1]==='figure'&&[...m[4].matchAll(figureImagePattern())].some((img,i)=>ids.has(figureImageId(img[3],m[2],i)))));
        const p=parseParts(remapCopiedObjects(text,owner,collision));if(!p.length)return;
        let i=parts.indexOf(after);if(after?.kind==='text'&&!after.raw.trim()){parts.splice(i,1,...p)}else parts.splice(i<0?parts.length:i+1,0,...p);selectedPart=p.at(-1);draw();flush()})
    }
    const imageMarkup=({url,name})=>figureImageMarkup(name.replace(/[\[\]\r\n]/g,''),url,'','subfig-'+uid());
    function pasteSubfigure(text,after){
        const match=text.trim().match(/^:::subfigure\s*\n([\s\S]*?)\n:::\s*$/);
        if(!match)return false;
        const m=[...match[1].matchAll(figureImagePattern())][0];if(!m)return false;
        let id=figureImageId(m[3],'clipboard',0);
        if(occupiedObjectIds().has(id)||parts.some(p=>p.raw.includes('wb-id:'+id)))id='subfig-'+uid();
        const markup=figureImageMarkup(m[1],m[2],m[3],id),card=[...body.children].find(c=>c._part===after);
        if(after?.kind==='figure'&&card?._appendImageMarkup)card._appendImageMarkup([markup]);
        else{const fig='fig-'+uid(),data=m[1]+'\n\n'+markup;add({kind:'figure',id:fig,flags:'',body:data,raw:':::figure '+fig+'\n'+data+'\n:::'},after)}
        return true
    }
    function addImages(images,after=selectedPart){
        if(!editingEnabled||!images.length||!root.isConnected)return;
        const card=[...body.children].find(c=>c._part===after);
        if(after?.kind==='figure'&&card?._appendImages){card._appendImages(images);return}
        const id='fig-'+uid(),data=images[0].name.replace(/[\r\n]/g,' ')+'\n\n'+images.map(imageMarkup).join('\n\n');
        add({kind:'figure',id,flags:'',body:data,raw:':::figure '+id+'\n'+data+'\n:::'},after)
    }
    async function uploadImages(files,after=selectedPart){
        const images=[];
        for(const file of files.filter(f=>f?.type?.startsWith('image/'))){const img=await visualImageUpload(file);if(img)images.push(img)}
        addImages(images,after)
    }
    function pasteImage(e,after){
        const items=[...(e.clipboardData?.items||[])].filter(x=>x.kind==='file'&&x.type.startsWith('image/')).map(x=>x.getAsFile()).filter(Boolean);
        const files=items.length?items:[...(e.clipboardData?.files||[])].filter(x=>x.type.startsWith('image/'));
        if(!files.length)return false;e.preventDefault();e.stopImmediatePropagation();uploadImages(files,after);return true
    }
    function pasteInline(area,text){
        return annotationEdit(()=>{
        text=prepareAnnotationPaste(text,owner);
        const s=window.getSelection();let r=s?.rangeCount&&area.contains(s.getRangeAt(0).commonAncestorContainer)?s.getRangeAt(0).cloneRange():null;
        if(!r){r=document.createRange();r.selectNodeContents(area);r.collapse(false)}
        const frag=document.createDocumentFragment();let at=0;
        for(const m of text.matchAll(refPattern())){if(m.index>at)frag.append(document.createTextNode(text.slice(at,m.index)));frag.append(visualRef(m[1],m[2],!internal));at=m.index+m[0].length}
        if(at<text.length)frag.append(document.createTextNode(text.slice(at)));
        const last=frag.lastChild;if(!last)return;
        r.deleteContents();r.insertNode(frag);r.setStartAfter(last);r.collapse(true);s.removeAllRanges();s.addRange(r);area.dispatchEvent(new Event('input',{bubbles:true}));remember()})
    }
    function insertMenu(){return internal?[]:[
        ['插入交叉引用',()=>visualPick(s=>{const m=[...s.matchAll(refPattern())][0];if(m)insertInline(visualRef(m[1],m[2]))})]
    ]}
    root._contentInsertMenu=e=>{
        const cards=[...body.children],clicked=e.target.closest('.visualCard'),area=e.target.closest('.richText');
        const card=clicked&&body.contains(clicked)?clicked:cards.filter(c=>c.getBoundingClientRect().top<=e.clientY).at(-1)||cards[0];
        const anchor=card?._part||parts.at(-1);
        const range=getSelection()?.rangeCount?getSelection().getRangeAt(0):null;
        const caret=area&&range&&area.contains(range.commonAncestorContainer)?range.cloneRange():null;
        return insertMenu().map(([name,action])=>[name,()=>{
            selectedPart=anchor;focused=area&&root.contains(area)?area:null;selection=focused?caret:null;
            action()
        }])
    };
    root._blankMenu=e=>{
        const cards=[...body.children];const before=cards.filter(c=>c.getBoundingClientRect().top<=e.clientY).at(-1);
        selectedPart=(before||cards[0])?._part||parts.at(-1);
        focused=null;selection=null;
        return [...insertMenu(),...(root._sectionMenu?root._sectionMenu():[]),['撤销',()=>undo(false)],['重做',()=>undo(true)]]
    };
    root._annotationAnchor=y=>{
        const cards=[...body.children];const before=cards.filter(c=>c.getBoundingClientRect().top<=y).at(-1);
        return (before||cards[0])?._part||parts.at(-1)
    };
    root._insertAnnotation=(id,anchor)=>add({kind:'embed',ref:id,raw:'[[embed:'+id+']]'},anchor||parts.at(-1));
    root._insertBoundAnnotation=(id,binding)=>{
        const {area,range}=binding;
        if(!root.isConnected||!area.isConnected||!root.contains(area)||!area.contains(range.startContainer))return false;
        try{const r=range.cloneRange();r.collapse(true);const chip=visualRef('embed',id);r.insertNode(chip);area.dispatchEvent(new Event('input',{bubbles:true}));return true}catch(err){console.warn(err);return false}
    };
    context(root,e=>root._blankMenu(e));
    function bindRich(area,p){
        area.addEventListener('focusin',()=>{focused=area;selectedPart=p;clearObject()});
        area.addEventListener('keyup',remember);area.addEventListener('pointerup',remember);
        area.addEventListener('paste',e=>{const text=e.clipboardData?.getData('text/plain')||'';
            if(pasteSubfigure(text,p)){e.preventDefault();e.stopImmediatePropagation();return}
            if(pasteImage(e,p))return;
            if(annotationClipboardValue(text)){e.preventDefault();e.stopImmediatePropagation();if(internal)insertPaste(text,p);else pasteInline(area,text);return}
            const label=text.trim().match(/^\[\[embed:([^\]\n]+)\]\]$/);
            if(label&&find(label[1])&&label[1]!==owner){e.preventDefault();e.stopImmediatePropagation();pasteInline(area,label[0]);return}
            if(/(^:::(equation|figure|table)\s|^\s*\[\[embed:[^\]\n]+\]\]\s*$)/m.test(text)||(internal&&figureImagePattern().test(text))){e.preventDefault();e.stopImmediatePropagation();insertPaste(text,p);return}
            if(/\[\[(ref|eqref|cite):[^\]\n]+\]\]/.test(text)&&!/\[\[embed:/.test(text)){e.preventDefault();e.stopImmediatePropagation();pasteInline(area,text);return}
            if(/(\[\[embed:|\$[^$\n]+\$)/m.test(text)){e.preventDefault();e.stopImmediatePropagation();insertPaste(text,p)}
        },true)
        area.addEventListener('copy',e=>{const s=window.getSelection();if(!s?.rangeCount||s.isCollapsed||!area.contains(s.getRangeAt(0).commonAncestorContainer))return;const clone=s.getRangeAt(0).cloneContents();if(!clone.querySelector('[data-token]'))return;const holder=el('div');holder.append(clone);e.clipboardData.setData('text/plain',richMarkdown(holder));e.preventDefault()});
    }
    function objectRaw(p){p.raw=':::'+p.kind+' '+p.id+(p.flags?' '+p.flags:'')+'\n'+p.body+'\n:::';flush()}
    function draw(){
        clearMixed();body.replaceChildren();focused=null;selection=null;selectedObject=null;
        let paragraphIndex=0;
        for(const p of parts){
            const card=el('section','visualCard');card._part=p;card.addEventListener('pointerdown',e=>{selectedPart=p;if(e.button===0&&!e.target.closest('.richText,math-field,button,input,textarea,select,.resizeHandle,.visualRef')){selectObject(p,card);if(p.kind!=='text'&&!e.target.closest('summary'))root.focus({preventScroll:true})}else if(e.button===0&&!e.target.closest('.resizeHandle'))clearObject()});
            card._selectImage=wrap=>{selectedPart=selectedObject=p;for(const c of body.children)c.classList.remove('selectedObject');document.querySelectorAll('.selectedImage').forEach(x=>{if(x!==wrap)x.classList.remove('selectedImage')});getSelection()?.removeAllRanges();root.focus({preventScroll:true});wrap.classList.add('selectedImage')};
            card._selectWhole=()=>{selectedPart=p;selectObject(p,card);root.focus({preventScroll:true})};
            if(p.kind==='figure')card.addEventListener('contextmenu',e=>{if(!e.target.closest('.resizeImage,.richText,.visualRef,button'))card._selectWhole()},true);
            const head=el('div','visualCardHead'),handle=el('span','visualHandle','⠿');handle.draggable=true;handle.title='拖动调整顺序';
            const title=p.kind==='text'?'正文':p.kind==='embed'?'批注':p.kind==='equation'?'公式':p.kind==='figure'?'图片':'表格';
            if(p.id||p.ref)card.dataset.object=p.id||p.ref;card.classList.add('part-'+p.kind);
            if(p.kind==='text')card.dataset.paragraphIndex=paragraphIndex++;
            head.append(handle,el('span','small partLabel',p.kind==='text'?'':title),el('div','spacer'));
            if(p.id&&!internal){const t=resolve(p.id);head.append(el('span','visualNum small',t?.number||''))}
            const content=el('div','visualCardContent');
            const foldKey=p.id||p.ref?'object:'+owner+':'+(p.id||p.ref):null;
            const fold=btn('▾',()=>card._setFolded(!content.hidden),'partFold');fold.title='折叠／展开';
            card._setFolded=(state,persist=true)=>{content.hidden=!!state;p.folded=!!state;fold.textContent=state?'▸':'▾';card.classList.toggle('folded',!!state);if(persist&&pi!=null&&foldKey)setPageFold(pi,foldKey,!!state)};
            let extra=[];
            function partMenu(){selectedPart=p;remember();const target=(p.id||p.ref)&&resolve(p.id||p.ref);
                return [...(target?refMenu(target):[]),...(p.kind==='text'?[['粗体',()=>format('bold')],['斜体',()=>format('italic')]]:[]),...extra,...insertMenu(),[content.hidden?'展开内容':'折叠内容',()=>fold.click()],['上移',()=>shift(p,-1)],['下移',()=>shift(p,1)],['删除内容块',()=>removePart(p)]]
            }
            head.append(fold);
            if(p.kind==='text'){head.classList.add('textPartTools');card.append(content,head)}else card.append(head,content);card._setFolded(pi!=null&&foldKey?pageFoldState(pi).has(foldKey):!!p.folded,false);
            card._menu=partMenu;context(card,partMenu);
            handle.addEventListener('dragstart',e=>{e.dataTransfer.setData('application/x-workbench-part',String(parts.indexOf(p)));e.dataTransfer.effectAllowed='move'});
            card.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('application/x-workbench-part'))e.preventDefault()});
            card.addEventListener('drop',e=>{if(!e.dataTransfer.types.includes('application/x-workbench-part'))return;e.preventDefault();const from=+e.dataTransfer.getData('application/x-workbench-part'),to=parts.indexOf(p);if(from!==to&&parts[from]){const a=parts.splice(from,1)[0];parts.splice(to,0,a);draw();flush()}});
            if(p.kind==='embed'){
                const n=find(p.ref),chip=visualRef('embed',p.ref);content.append(chip,el('span','small',' '+(n?.title||'批注不存在')));
                if(n){chip._detachNote=()=>annotationEdit(()=>{clearAnnotationPlacement(n);removePart(p)});extra=noteLabelMenu(chip)}
            }else if(p.kind==='text'){
                const area=visualRich(p.raw,()=>{p.raw=richMarkdown(area);flush()},false,!internal);bindRich(area,p);content.append(area)
            }else if(p.kind==='equation'){
                const field=visualMath(p.body.trim(),true,value=>{p.body=value;objectRaw(p)}),palette=mathPanel(field);content.append(field,palette);
                extra=[['公式输入工具',()=>{card.classList.add('showMathTools');field.focus()}],['数学键盘',()=>{field.focus();window.mathVirtualKeyboard?.show()}],['复制公式',()=>copy(p.body)]]
            }else if(p.kind==='figure'){
                const lines=p.body.split('\n'),caption=lines.shift()||'',rest=lines.join('\n').trim();
                const cap=visualRich(caption,()=>{p.body=richMarkdown(cap).replace(/\n+/g,' ')+'\n\n'+imageSource;objectRaw(p)},true,!internal);
                let imageSource=normalizeFigureImages(rest,p.id);
                const imgs=el('div','visualImages');
                function displayImages(){
                    imgs.replaceChildren();markdown(imageSource,imgs,[owner].filter(Boolean),(src,w,index)=>{let i=-1;imageSource=imageSource.replace(figureImagePattern(),(m,alt,url,title)=>++i===index&&url===src?figureImageMarkup(alt,url,(title||'').replace(/(?:^|\s)wb-width:[^\s"]+/g,'')+' wb-width:'+w,figureImageId(title,p.id,index)):m);p.body=p.body.split('\n')[0]+'\n\n'+imageSource;objectRaw(p)});
                    const records=[...imageSource.matchAll(figureImagePattern())];
                    [...imgs.querySelectorAll('.resizeImage')].forEach((wrap,i)=>{
                        const m=records[i];if(!m)return;
                        const id=figureImageId(m[3],p.id,i);wrap.dataset.object=id;wrap.dataset.subfigure=id;wrap.title=internal?(m[1]||'图片'):'子图 '+(resolve(id)?.number||subfigureLetter(i));
                        wrap.addEventListener('contextmenu',()=>card._selectImage(wrap),true)
                    });
                    if(!imgs.querySelector('img'))imgs.append(btn('添加图片',()=>chooseImages(p),'emptyFigureAdd'));
                    refreshObjectAnnotations(card)
                }
                card._appendImageMarkup=markups=>{
                    imageSource=[imageSource,...markups].filter(Boolean).join('\n\n');
                    p.body=richMarkdown(cap).replace(/\n+/g,' ')+'\n\n'+imageSource;objectRaw(p);displayImages()
                };
                card._appendImages=images=>card._appendImageMarkup(images.map(imageMarkup));
                card._clipboardRaw=()=>(':::figure '+p.id+(p.flags?' '+p.flags:'')+'\n'+richMarkdown(cap).replace(/\n+/g,' ')+'\n\n'+imageSource+'\n:::');
                card._selectedImageRaw=()=>{
                    const wrappers=[...imgs.querySelectorAll('.resizeImage')],index=wrappers.findIndex(w=>w.classList.contains('selectedImage'));
                    return index<0?null:[...imageSource.matchAll(figureImagePattern())][index]?.[0]||null
                };
                card._deleteSelectedImage=()=>{
                    const wrappers=[...imgs.querySelectorAll('.resizeImage')],index=wrappers.findIndex(w=>w.classList.contains('selectedImage'));
                    if(index<0)return false;
                    let i=-1;imageSource=imageSource.replace(figureImagePattern(),m=>++i===index?'':m).trim();
                    p.body=p.body.split('\n')[0]+'\n\n'+imageSource;objectRaw(p);displayImages();clearObject();root.focus({preventScroll:true});return true
                };
                bindRich(cap,p);content.append(imgs,cap);
                extra=[['添加图片',()=>chooseImages(p)]];
                displayImages()
            }else if(p.kind==='table'){
                const lines=p.body.split('\n'),caption=lines.shift()||'',rest=lines.join('\n').trim();
                const cap=visualRich(caption,()=>commitTable(),true,!internal);const wrap=el('div','tablescroll');const table=el('table','visualTable');wrap.append(table);
                let rows=rest.split('\n').filter(s=>s.trim().startsWith('|')).map(s=>s.trim().replace(/^\||\|$/g,'').split(/(?<!\\)\|/).map(x=>x.trim()));if(rows.length>1&&rows[1].every(x=>/^:?-+:?$/.test(x)))rows.splice(1,1);
                if(!rows.length){rows=[['项目','数值'],['','']];content.append(el('p','muted','原表格存在复杂内容，未修改时保持原始数据；如需改表请核对预览。'))}
                const cols=Math.max(1,...rows.map(x=>x.length));rows=rows.map(r=>Array.from({length:cols},(_,i)=>r[i]||''));
                function commitTable(){p.body=richMarkdown(cap).replace(/\n+/g,' ')+'\n\n'+[rows[0],rows[0].map(()=> '---'),...rows.slice(1)].map(r=>'| '+r.map(x=>x.replace(/\n+/g,' ').replace(/(?<!\\)\|/g,'\\|')).join(' | ')+' |').join('\n');objectRaw(p)}
                function tableDraw(){table.replaceChildren();rows.forEach((row,i)=>{const tr=el('tr');row.forEach((value,j)=>{const td=el(i===0?'th':'td');const cell=visualRich(value,()=>{rows[i][j]=richMarkdown(cell);commitTable()},true,!internal);bindRich(cell,p);td.append(cell);tr.append(td)});table.append(tr)})}
                bindRich(cap,p);content.append(cap,wrap);extra=[['添加行',()=>{rows.push(rows[0].map(()=>''));tableDraw();commitTable()}],['添加列',()=>{rows.forEach(r=>r.push(''));tableDraw();commitTable()}]];tableDraw()
            }
            body.append(card)
        }
        refreshObjectAnnotations(root)
    }
    function shift(p,d){const i=parts.indexOf(p),j=i+d;if(j>=0&&j<parts.length){[parts[i],parts[j]]=[parts[j],parts[i]];draw();flush()}}
    root.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault()});
    root.addEventListener('drop',e=>{if(e.dataTransfer.files.length){e.preventDefault();const dest=e.target.closest('.visualCard')?._part;uploadImages([...e.dataTransfer.files],dest||selectedPart)}});
    function objectClipboardData(p,card,cut){
        const image=card._selectedImageRaw?.();
        let text;
        if(image){
            const m=[...image.matchAll(figureImagePattern())][0];
            const markup=cut?image:figureImageMarkup(m[1],m[2],m[3],'subfig-'+uid());
            text=':::subfigure\n'+markup+'\n:::'
        }else{
            const raw=card._clipboardRaw?.()||p.raw;
            text=cut?raw:remapCopiedObjects(raw,owner,true)
        }
        return {text,remove:()=>{if(!editingEnabled||!root.isConnected||!parts.includes(p))return;if(!image||!card._deleteSelectedImage?.())removePart(p)}};
    }
    function objectClipboard(e,cut){
        if(cut&&!editingEnabled){e.preventDefault();return}
        if(!selectedObject||e.target.closest('.richText,math-field,input,textarea')||!e.clipboardData)return;
        const p=selectedObject,card=[...body.children].find(c=>c._part===p);if(!card)return;
        const data=objectClipboardData(p,card,cut);
        e.clipboardData.setData('text/plain',data.text);localClipboard=data.text;localClipboardPreferred=false;e.preventDefault();e.stopPropagation();
        if(cut){data.remove();showToast('已剪切，粘贴将保留原引用')}
        else showToast('已复制，粘贴将生成新 ID')
    }
    root._clipboardMenu=e=>{
        const multi=activeMixed();if(multi)return mixedMenu(multi);
        const card=e.target.closest('.visualCard'),p=card?._part||selectedPart;
        const area=e.target.closest('.richText'),math=e.target.closest('math-field');
        const wrap=e.target.closest('.resizeImage');
        if(!e.preview){
            if(wrap&&card?._selectImage)card._selectImage(wrap);
            else if(card&&p.kind!=='text'&&!area&&!math)card._selectWhole();
        }
        const s=getSelection(),prior=e.useCurrentSelection?null:previousContextSelection;
        let r=prior&&Date.now()-prior.time<2000&&Math.hypot(e.clientX-prior.x,e.clientY-prior.y)<32?prior.range:s?.rangeCount?s.getRangeAt(0).cloneRange():null;
        if(!area||!r||!area.contains(r.commonAncestorContainer))r=null;
        if(area&&!r){r=document.createRange();r.selectNodeContents(area);r.collapse(false)}
        const restore=()=>{if(!area?.isConnected||!r||!area.contains(r.commonAncestorContainer))return false;area.focus({preventScroll:true});s.removeAllRanges();s.addRange(r);return true};
        const selected=!!r&&!r.collapsed;
        const text=()=>{const holder=el('div');holder.append(r.cloneContents());return richMarkdown(holder)};
        const object=!!card&&p.kind!=='text'&&!area&&!math;
        const copyOrCut=async cut=>{
            if(cut&&!requireEditMode())return;
            if(object){const data=objectClipboardData(p,card,cut);await writeEditorClipboard(data.text);if(cut)data.remove();return}
            if(math){const value=math.getValue?.(math.selection,'latex')||math.value;if(!value)return;await writeEditorClipboard(value);if(cut&&editingEnabled&&math.isConnected){math.executeCommand?.('deleteBackward');math.dispatchEvent(new Event('input',{bubbles:true}))}return}
            if(!selected)return;await writeEditorClipboard(text());if(cut&&editingEnabled&&restore()){document.execCommand('delete');area.dispatchEvent(new Event('input',{bubbles:true}))}
        };
        const paste=async()=>{
            if(!requireEditMode())return;
            const value=await readEditorClipboard();if(!editingEnabled||!root.isConnected)return;
            if(!value){
                if(!math&&!localClipboardPreferred)try{
                    const items=await navigator.clipboard.read(),files=[];
                    for(const item of items){const type=item.types.find(t=>['image/png','image/jpeg','image/webp','image/gif'].includes(t));if(type)files.push(new File([await item.getType(type)],'clipboard.'+type.split('/')[1],{type}))}
                    if(files.length){await uploadImages(files,p);return}
                }catch{}
                if(value==null)showToast('无法读取剪贴板，请使用系统粘贴');return
            }
            if(math?.isConnected){math.focus();math.insert(value,{insertionMode:'replaceSelection'});math.dispatchEvent(new Event('input',{bubbles:true}));return}
            if(area&&restore()){
                // Reuse the normal paste handlers, including object/ref parsing.
                const data=new DataTransfer();data.setData('text/plain',value);
                area.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));return
            }
            if(!pasteSubfigure(value,p))insertPaste(value,p)
        };
        return [['剪切',()=>copyOrCut(true),!object&&!selected&&!(math&&!math.selectionIsCollapsed)],['复制',()=>copyOrCut(false),!object&&!selected&&!math],['粘贴',paste]]
    };
    root.addEventListener('copy',e=>objectClipboard(e,false));
    root.addEventListener('cut',e=>objectClipboard(e,true));
    root.addEventListener('paste',e=>{if(e.defaultPrevented)return;if(pasteImage(e,selectedPart))return;if(!e.target.closest('[contenteditable=true],math-field,input,textarea')){const text=e.clipboardData?.getData('text/plain');if(text){e.preventDefault();if(!pasteSubfigure(text,selectedPart))insertPaste(text,selectedPart)}}});
    root.addEventListener('click',e=>{if(!e.target.closest('.richText,math-field,input,textarea,button,summary,a,img,.resizeHandle,.visualRef')){selectedPart=e.target.closest('.visualCard')?._part||selectedPart;root.focus({preventScroll:true})}});
    root.tabIndex=0;draw();
    return {root,getValue:value};
}
document.addEventListener('pointerdown',e=>{if(isActionSurface(e.target))return;for(const root of document.querySelectorAll('.visualDocument'))if(!root.contains(e.target)){root._clearObject?.();root._clearMixed?.()}},true);
document.addEventListener('selectionchange',()=>{for(const root of document.querySelectorAll('.visualDocument'))root._syncRange?.()});
document.addEventListener('scroll',()=>{for(const root of document.querySelectorAll('.visualDocument'))root._syncRange?.()},true);
function editor(n,host,pi,summary=null){
    const title=el('input','editableTitle');title.value=n.title;title.placeholder='标题';title.setAttribute('aria-label','章节标题');
    setEditorControlMode(title);
    const heading=el(summary?'span':'div','editableHeading');heading.dataset.bindObject=n.id;if(numbers.get(n.id))heading.append(el('span','headingNumber',numbers.get(n.id)));
    function sectionMenu(){return nodeMenu(n)}
    const isBlock=spaceOf(n.id)==='blocks';
    if(!isBlock)heading.append(title);else heading.append(el('div','spacer'));
    heading.append(btn('⋯',e=>menuAt(e,sectionMenu()),'sectionMore'));context(heading,sectionMenu,()=>resolve(n.id),true);
    const doc=visualDocument(n.body,s=>{if(s===n.body)return;checkpoint();n.body=s;if(isBlock)n.title=blockLabel(s);change(false);if(isBlock)renderNav();for(const card of doc.root.querySelectorAll('.visualCard')){const p=card._part;if(p?.id){const label=card.querySelector('.visualNum');if(label)label.textContent=resolve(p.id)?.number||''}}},n.id,pi);
    title.addEventListener('input',()=>{if(!editingEnabled)return;const t=title.value.trim();if(t===n.title)return;checkpoint();n.title=t;change(false);renderNav();if(summary)summary.querySelector('.childCollapsedTitle').textContent=label(n)});
    doc.root._sectionMenu=sectionMenu;
    if(summary){summary.append(heading);title.addEventListener('click',e=>e.stopPropagation());refreshObjectAnnotations(heading)}else host.append(heading);
    host.append(doc.root);refreshObjectAnnotations(host)
};
function blockLabel(body){const t=body.replace(/\[\[(?:ref|eqref|embed|cite):[^\]]+\]\]/g,'').replace(/!\[[^\]]*\]\([^)]*\)/g,'').replace(/^:::[^\n]*$/gm,'').replace(/\s+/g,' ').trim();return t.slice(0,36)||'批注'}
function setupNoteResize(d,size,onResize){
    const clamp=(v,min,max)=>Math.round(Math.max(Math.min(min,max),Math.min(v,max)));
    const apply=(w,h)=>{dialog.style.width=clamp(w,220,innerWidth-16)+'px';dialog.style.height=clamp(h,145,innerHeight-16)+'px'};
    apply(size?.width||380,size?.height||210);
    const handle=el('span','noteResizeHandle');handle.setAttribute('role','button');handle.setAttribute('aria-label','拖动调整批注窗口长宽');handle.title='拖动调整长宽';d.append(handle);
    handle.addEventListener('pointerdown',e=>{
        if(e.button!==0)return;e.preventDefault();e.stopPropagation();handle.setPointerCapture(e.pointerId);
        const r=dialog.getBoundingClientRect(),x=e.clientX,y=e.clientY;
        const move=ev=>apply(r.width+ev.clientX-x,r.height+ev.clientY-y);
        const end=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',end);const box=dialog.getBoundingClientRect();dialog._noteSize={width:Math.round(box.width),height:Math.round(box.height)};onResize?.({...dialog._noteSize})};
        handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end)
    });
}
let textHighlightFrame=0;
function refreshTextAnnotations(){
    if(textHighlightFrame)return;
    textHighlightFrame=requestAnimationFrame(()=>{
        textHighlightFrame=0;
        if(!globalThis.CSS?.highlights||typeof Highlight==='undefined')return;
        const ranges=[];
        for(const chip of paneBox.querySelectorAll('.richText .inlineAnnotation')){
            const owner=chip.closest('.visualDocument')?._owner,id=chip.dataset.token?.slice(8,-2),note=find(id);
            if(!owner||!note)continue;
            const quotes=[note.annotation,...(note.textBindings||[])].filter(a=>a?.owner===owner&&a.quote).map(a=>a.quote).sort((a,b)=>b.length-a.length);
            if(!quotes.length)continue;
            const area=chip.closest('.richText'),walker=document.createTreeWalker(area,NodeFilter.SHOW_TEXT);
            const range=document.createRange();range.setStartAfter(chip);range.setEnd(area,area.childNodes.length);
            const remaining=range.toString(),quote=quotes.find(q=>remaining.startsWith(q));
            if(!quote)continue; // A changed/deleted quote must not highlight unrelated text.
            let length=0;
            for(let n=walker.nextNode();n;n=walker.nextNode()){
                if(chip.contains(n)||!(chip.compareDocumentPosition(n)&Node.DOCUMENT_POSITION_FOLLOWING))continue;
                if(length+n.length>=quote.length){
                    range.setEnd(n,quote.length-length);
                    if(range.toString()===quote)ranges.push(range);
                    break;
                }
                length+=n.length;
            }
        }
        const highlight=new Highlight(...ranges);highlight.priority=-1;CSS.highlights.set('paper-annotation',highlight);
    });
}
function refreshObjectAnnotations(scope=document){
    if(!db)return;
    refreshTextAnnotations();
    const selector='.visualCard[data-object],.resizeImage[data-subfigure],.editableHeading[data-bind-object]';
    const objects=[...(scope.matches?.(selector)?[scope]:[]),...scope.querySelectorAll(selector)];
    for(const object of objects){
        const id=object.dataset.object||object.dataset.bindObject;
        const parent=object.matches('.visualCard')?object.querySelector(':scope > .visualCardHead'):object;
        if(!parent)continue;
        const privateObject=!object.matches('.editableHeading')&&object.closest('.visualDocument')?._internalObjects;
        const notes=privateObject?[]:db.blocks.flatMap(n=>objectNoteBindings(n).filter(b=>b.targetId===id).map(binding=>({n,binding})));
        let group=parent.querySelector(':scope > .objectNoteMarkers');
        if(!notes.length){group?.remove();continue}
        if(!group){group=el('span','objectNoteMarkers');parent.append(group)}
        const key=notes.map(({n})=>n.id).join('|');
        if(group.dataset.key===key)continue;
        group.dataset.key=key;group.replaceChildren();
        for(const {n,binding} of notes){
            const chip=el('button','objectNoteMarker','※');chip.type='button';
            chip.title='打开批注';chip.setAttribute('aria-label','打开对象批注');chip.dataset.noteId=n.id;chip.dataset.targetId=id;
            setupNoteLabel(chip,n.id,e=>{const current=find(n.id),b=current&&objectNoteBindings(current).find(x=>x.targetId===id);if(current&&b)openAnnotationNote(current,chip,e,b)},()=>{const current=find(n.id);if(!current)return;checkpoint();current.objectBindings=objectNoteBindings(current).filter(x=>x.targetId!==id);change(false)});
            group.append(chip)
        }
    }
}
function refreshFreeNotes(){
    if(!db)return;
    for(const page of paneBox.querySelectorAll('.pane:not(.historicalPane) > .page')){
        const pageId=page.parentElement._readingPane?.id;
        const notes=db.blocks.flatMap(n=>freeNotePlacements(n).filter(p=>p.pageId===pageId).map(placement=>({n,placement})));
        let layer=page.querySelector(':scope > .freeNoteLayer');
        if(!notes.length){layer?.remove();continue}
        if(!layer){layer=el('div','freeNoteLayer');page.append(layer)}
        const key=JSON.stringify(notes.map(({n,placement:p})=>[n.id,p.id,p.x,p.y]));
        if(layer.dataset.key===key)continue;
        layer.dataset.key=key;layer.replaceChildren();
        for(const {n,placement:p} of notes){
            const marker=el('button','freeNoteMarker','※');marker.type='button';
            marker.style.left='clamp(0px,'+(p.x*100)+'%,calc(100% - 18px))';marker.style.top='clamp(0px,'+p.y+'px,calc(100% - 18px))';
            marker.dataset.noteId=n.id;marker.dataset.placementId=p.id;marker.title='打开独立批注';marker.setAttribute('aria-label','打开独立批注');
            setupNoteLabel(marker,n.id,e=>{const current=find(n.id),place=current&&freeNotePlacements(current).find(x=>x.id===p.id);if(current&&place)openAnnotationNote(current,marker,e,null,place)},()=>{const current=find(n.id);if(!current)return;checkpoint();current.freePlacements=freeNotePlacements(current).filter(x=>x.id!==p.id);change(false)});
            layer.append(marker)
        }
    }
}
function openAnnotationNote(n,chip,e,objectBinding=null,freePlacement=null){
    const owner=chip.closest('.visualDocument')?._owner,pane=chip.closest('.pane');
    const anchorRect=()=>{
        if(freePlacement)return freeNoteAnchor(freePlacement,pane);
        if(objectBinding)return objectNoteAnchor(objectBinding.targetId,pane);
        let a=chip.isConnected?chip:null;
        if(!a){const matches=[...paneBox.querySelectorAll('.inlineAnnotation')].filter(x=>x.dataset.token==='[[embed:'+n.id+']]');a=matches.find(x=>x.closest('.pane')===pane)||matches.find(x=>x.closest('.visualDocument')?._owner===owner)||matches[0]}
        return a?.getBoundingClientRect()||null
    };
    const d=showDialog('',{floating:true,x:e.clientX,y:e.clientY,anchorRect,relativeOffset:freePlacement?.floatOffset||objectBinding?.floatOffset||n.annotation?.floatOffset,onPositionChange:offset=>{if(!editingEnabled)return;if(freePlacement){freePlacement.floatOffset=offset;change(false)}else if(objectBinding){objectBinding.floatOffset=offset;change(false)}else if(n.annotation){n.annotation.floatOffset=offset;change(false)}}});
    dialog.classList.add('blankNoteDialog');
    dialog._noteId=n.id;
    const doc=visualDocument(n.body,()=>{},n.id),initial=doc.getValue();
    dialog._noteValue=()=>doc.getValue();
    dialog._commitNote=()=>{
        const value=doc.getValue();dialog.close();
        if(value!==initial){checkpoint();n.body=value;n.title=blockLabel(value);change(false);renderNav()}
    };
    d.append(doc.root);setupNoteResize(d,n.floatSize,size=>{if(editingEnabled){n.floatSize=size;change(false)}});
    const handle=d.querySelector('h2');handle.classList.add('noteWindowHandle');handle.setAttribute('aria-label','选中批注浮窗');
    setupNoteLabel(handle,n.id,()=>{doc.root.querySelector('.richText,math-field')?.focus({preventScroll:true})},chip._detachNote?()=>{closeWorkbenchDialog();if(chip.isConnected)chip._detachNote()}:null,true);
    requestAnimationFrame(()=>{if(editingEnabled&&!handle.classList.contains('selectedNoteLabel'))doc.root.querySelector('.richText')?.focus({preventScroll:true});scheduleToolbarUpdate()});
}
function newNode(space,parent=null,body='',title='',onCreated=null,options={}){
    if(!requireEditMode())return;
    if(space==='blocks'){
        const d=showDialog('',{...options,floating:true});dialog.classList.add('blankNoteDialog');
        const doc=visualDocument(remapCopiedObjects(body),()=>{},null);
        dialog._commitNote=()=>annotationEdit(()=>{
            const value=remapCopiedObjects(doc.getValue());if(!value.trim()){dialog.close();return}
            checkpoint();const id='block-'+uid(),n={id,title:blockLabel(value),parent,level:parent?ancestors(find(parent)).length+2:1,number:'',file:'blocks/'+id+'.md',source:'',order:db.blocks.length,body:value};
            if(options.binding?.mode==='object')n.objectBindings=[{targetId:options.binding.targetId,floatOffset:{...(dialog._relativeOffset||{x:14,y:8})}}];
            else if(options.binding)n.annotation={owner:options.binding.owner.id,mode:options.binding.mode,quote:options.binding.quote,floatOffset:{...(dialog._relativeOffset||{x:14,y:8})}};
            else if(options.freePlacement)n.freePlacements=[{...options.freePlacement,floatOffset:{...(dialog._relativeOffset||{x:14,y:8})}}];
            if(dialog._noteSize)n.floatSize={...dialog._noteSize};
            db.blocks.push(n);normalizeOrder(space);dialog.close();change(false);if(onCreated){onCreated(id);renderNav()}else{select(id);renderPanes()}
        });
        d.append(doc.root);setupNoteResize(d);requestAnimationFrame(()=>doc.root.querySelector('.richText')?.focus());return
    }
    createEmptyThesis(parent)
};

