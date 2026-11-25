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
function visualMath(tex,display,onInput){
    const f=document.createElement('math-field');f.className='visualMath'+(display?' displayMath':'');f.setAttribute('contenteditable','false');f.setAttribute('math-virtual-keyboard-policy','auto');
    f.setAttribute('aria-label','可编辑数学公式');f.value=tex;f._texOriginal=tex;f._texChanged=false;
    setEditorControlMode(f);
    function removeBuiltinMenu(){if(!f.isConnected)return;try{f.menuItems=[];f.popoverPolicy='off'}catch(err){/* Wait for MathLive to mount its internal editor. */}}
    customElements.whenDefined('math-field').then(()=>requestAnimationFrame(removeBuiltinMenu));f.addEventListener('focusin',removeBuiltinMenu);
    f.addEventListener('input',e=>{e.stopPropagation();if(!editingEnabled)return;f._texChanged=true;onInput(f.value)});
    return f;
}
function mathPanel(field){
    const bar=el('div','mathPalette');
    const symbols=[['分数',String.raw`\frac{#0}{#?}`],['上标','^{#?}'],['下标','_{#?}'],['根号',String.raw`\sqrt{#0}`],['积分',String.raw`\int_{#?}^{#?}`],['求和',String.raw`\sum_{#?}^{#?}`],['矩阵',String.raw`\begin{pmatrix}#?&#?\\#?&#?\end{pmatrix}`],['偏导',String.raw`\partial`],['矢量',String.raw`\vec{#0}`],['α',String.raw`\alpha`],['β',String.raw`\beta`],['ρ',String.raw`\rho`],['μ',String.raw`\mu`],['σ',String.raw`\sigma`],['ω',String.raw`\omega`],['π',String.raw`\pi`],['±',String.raw`\pm`],['≤',String.raw`\le`]];
    for(const [name,value] of symbols){const b=btn(name,()=>{field.focus();field.insert(value,{insertionMode:'replaceSelection'});field.dispatchEvent(new Event('input',{bubbles:true}))});b.addEventListener('pointerdown',e=>e.preventDefault());bar.append(b)}
    bar.append(btn('数学键盘',()=>{field.focus();window.mathVirtualKeyboard?.show()}));return bar
}
function visualRef(kind,id){
    const chip=el('span','visualRef');chip.contentEditable='false';chip.dataset.token='[['+kind+':'+id+']]';
    if(kind==='embed'){const n=find(id);chip.textContent='※';chip.classList.add('inlineAnnotation');chip.setAttribute('aria-label','打开批注/知识块');chip.title=n?'打开批注/知识块':'知识块不存在';chip.addEventListener('click',e=>{e.stopPropagation();if(n)openAnnotationNote(n,chip,e)});if(n)context(chip,()=>refMenu(resolve(id)),()=>resolve(id));}
    else {const t=resolve(id);const text=kind==='cite'?'['+id+']':t?(kind==='eqref'?'('+(t.number||t.title)+')':t.number||t.title):'〔未解析：'+id+'〕';chip.textContent=text;if(t){chip.title=t.title;context(chip,()=>refMenu(t),()=>resolve(id)||t);chip.addEventListener('click',e=>{e.stopPropagation();jump(id,e.shiftKey)})}}
    return chip
}
function visualRich(raw,changed,compact=false){
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
        }else p.replaceWith(visualRef(t.kind,t.value))
    }
    if(!host.childNodes.length)host.append(el('p'));
    host.addEventListener('input',()=>{if(editingEnabled)changed()});
    // Avoid pasting untrusted HTML; recognized structured text is handled by the parent.
    host.addEventListener('paste',e=>{if(e.defaultPrevented)return;const items=[...(e.clipboardData?.items||[])];if(items.some(x=>x.type.startsWith('image/')))return;e.preventDefault();const text=e.clipboardData?.getData('text/plain')||'';document.execCommand('insertText',false,text);changed()});
    return host
}
function richMarkdown(host){
    function walk(n){
        if(n.nodeType===Node.TEXT_NODE)return (n.textContent||'').replace(/\u00a0/g,' ');
        if(n.nodeType!==Node.ELEMENT_NODE)return '';
        if(n.tagName==='MATH-FIELD')return '$'+(n._texChanged?n.value:n._texOriginal||n.value||'')+'$';
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
    return [...host.childNodes].map(walk).join('').trim()
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
function visualPick(onSelect,embed=false){
    const existing=dialog.open,d=existing?$('dialogBody'):showDialog(embed?'嵌入知识块':'选择引用对象');
    const container=el('div','visualPicker'),q=el('input'),list=el('div','visualPickList');q.placeholder='搜索标题、公式、编号';
    container.append(q,list,btn('取消',()=>{if(existing)container.remove();else dialog.close()}));d.append(container);
    function draw(){list.replaceChildren();const needle=q.value.toLowerCase();for(const t of [...targets.values()].filter(t=>(!embed||t.kind==='node'&&spaceOf(t.id)==='blocks')&&((t.title||'')+' '+t.id+' '+t.number).toLowerCase().includes(needle)).slice(0,80)){
        list.append(btn((t.kind==='equation'?'式 ':t.kind==='figure'?'图 ':t.kind==='table'?'表 ':'')+(t.number||'')+' '+(t.title||t.id),()=>{onSelect(embed?'[[embed:'+t.id+']]':refToken(t));if(existing)container.remove();else dialog.close()}))
    }}q.addEventListener('input',draw);draw();q.focus()
}
function visualDocument(raw,onUpdate,owner=null,pi=null){
    let parts=visualParts(raw),focused=null,selection=null;
    if(!parts.length)parts=[{kind:'text',raw:''}];
    const root=el('div','visualDocument'),body=el('div','visualBody');
    root.append(body);root._owner=owner;
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
        to.push(value());lastValue=from.pop();parts=visualParts(lastValue);if(!parts.length)parts=[{kind:'text',raw:''}];selectedPart=parts[0];selectedObject=null;draw();onUpdate(lastValue);root.focus({preventScroll:true})
    }
    root._draftHistory=draftHistory;
    root._canDraftHistory=redo=>!!(redo?draftRedo:draftUndo).length;
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
    root.addEventListener('keydown',e=>{
        if(!editingEnabled)return;
        if(e.defaultPrevented||e.isComposing||e.keyCode===229)return;
        const inMath=e.composedPath().some(x=>x.tagName==='MATH-FIELD');
        const area=e.target.closest?.('.richText'),inControl=e.target.closest?.('input,textarea,select,button');
        if(!['Backspace','Delete'].includes(e.key)||e.ctrlKey||e.metaKey||e.altKey||inMath||inControl)return;
        const forward=e.key==='Delete';
        if(area){
            const card=area.closest('.visualCard'),p=card?._part;
            // An empty editable paragraph is still a content block in the
            // live editor, even though the saved document omits blank parts.
            if(p?.kind==='text'&&!area.textContent.replace(/[\u200b\u00a0]/g,'').trim()&&!area.querySelector('math-field,[data-token],img')){
                e.preventDefault();
                if(parts.length===1)return;
                const i=parts.indexOf(p);
                const before=[...body.children].slice(0,i).reverse().find(c=>c._part.kind==='text')?.querySelector('.richText');
                const after=[...body.children].slice(i+1).find(c=>c._part.kind==='text')?.querySelector('.richText');
                removePart(p,true);
                const dest=forward?(after||before):(before||after);
                if(dest)placeIn(dest,dest===before);else root.focus({preventScroll:true});
                return
            }
            const s=getSelection();if(!s?.rangeCount||!s.isCollapsed||!area.contains(s.anchorNode))return;
            const caret=s.getRangeAt(0).cloneRange(),atom=atomicAt(area,caret,forward);
            if(atom){
                e.preventDefault();const r=document.createRange();r.setStartBefore(atom);r.collapse(true);atom.remove();s.removeAllRanges();s.addRange(r);area.dispatchEvent(new Event('input',{bubbles:true}));return
            }
            if(p?.kind!=='text')return;
            const edge=document.createRange();edge.selectNodeContents(area);
            if(forward)edge.setStart(caret.startContainer,caret.startOffset);else edge.setEnd(caret.startContainer,caret.startOffset);
            const frag=edge.cloneContents();
            if(frag.textContent.replace(/\u200b/g,'')||frag.querySelector('math-field,[data-token],img'))return;
            const neighbor=parts[parts.indexOf(p)+(forward?1:-1)];
            if(neighbor&&neighbor.kind!=='text'){e.preventDefault();removePart(neighbor,true)}
            return
        }
        if(selectedObject){
            e.preventDefault();const card=[...body.children].find(c=>c._part===selectedObject);
            if(!card?._deleteSelectedImage?.())removePart(selectedObject)
        }
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
    function addStructured(kind,initial=''){
        const id=(kind==='equation'?'eq-':kind==='figure'?'fig-':'tab-')+uid();
        let data=initial||(kind==='equation'?'':kind==='figure'?'图题\n\n':'表题\n\n| 项目 | 数值 |\n| --- | --- |\n|  |  |');
        const p={kind,id,flags:'',body:data,raw:':::'+kind+' '+id+'\n'+data+'\n:::'};add(p)
    }
    function insertPaste(text,after){
        const ids=new Set(parts.flatMap(p=>[p.id,...(p.kind==='figure'?[...p.raw.matchAll(figureImagePattern())].map((m,i)=>figureImageId(m[3],p.id,i)):[])].filter(Boolean)));
        const collision=[...text.matchAll(objectPattern())].some(m=>ids.has(m[2])||(m[1]==='figure'&&[...m[4].matchAll(figureImagePattern())].some((img,i)=>ids.has(figureImageId(img[3],m[2],i)))));
        const p=visualParts(remapCopiedObjects(text,owner,collision));if(!p.length)return;
        let i=parts.indexOf(after);if(after?.kind==='text'&&!after.raw.trim()){parts.splice(i,1,...p)}else parts.splice(i<0?parts.length:i+1,0,...p);selectedPart=p.at(-1);draw();flush()
    }
    const imageMarkup=({url,name})=>figureImageMarkup(name.replace(/[\[\]\r\n]/g,''),url,'','subfig-'+uid());
    function pasteSubfigure(text,after){
        const match=text.trim().match(/^:::subfigure\s*\n([\s\S]*?)\n:::\s*$/);
        if(!match)return false;
        const m=[...match[1].matchAll(figureImagePattern())][0];if(!m)return false;
        let id=figureImageId(m[3],'clipboard',0);
        if(targets.has(id)||parts.some(p=>p.raw.includes('wb-id:'+id)))id='subfig-'+uid();
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
        const s=window.getSelection();let r=s?.rangeCount&&area.contains(s.getRangeAt(0).commonAncestorContainer)?s.getRangeAt(0).cloneRange():null;
        if(!r){r=document.createRange();r.selectNodeContents(area);r.collapse(false)}
        const frag=document.createDocumentFragment();let at=0;
        for(const m of text.matchAll(refPattern())){if(m[1]==='embed')continue;if(m.index>at)frag.append(document.createTextNode(text.slice(at,m.index)));frag.append(visualRef(m[1],m[2]));at=m.index+m[0].length}
        if(at<text.length)frag.append(document.createTextNode(text.slice(at)));
        const last=frag.lastChild;if(!last)return;
        r.deleteContents();r.insertNode(frag);r.setStartAfter(last);r.collapse(true);s.removeAllRanges();s.addRange(r);area.dispatchEvent(new Event('input',{bubbles:true}));remember()
    }
    function insertMenu(){return [
        ['插入正文',()=>add({kind:'text',raw:''})],
        ['插入编号公式',()=>addStructured('equation')],
        ['插入行内公式',()=>{if(!focused||!focused.isConnected){add({kind:'text',raw:'$x$'});return}const f=visualMath('',false,()=>focused?.dispatchEvent(new Event('input',{bubbles:true})));f.dataset.inline='1';insertInline(f)}],
        ['插入图片',()=>chooseImages()],['插入空图对象',()=>addStructured('figure')],['插入表格',()=>addStructured('table')],
        ['插入交叉引用',()=>visualPick(s=>{const m=[...s.matchAll(refPattern())][0];if(m)insertInline(visualRef(m[1],m[2]))})],
        ['嵌入知识块',()=>visualPick(s=>add({kind:'text',raw:s}),true)]
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
            if(/(^:::(equation|figure|table)\s|^\s*\[\[embed:[^\]\n]+\]\]\s*$)/m.test(text)){e.preventDefault();e.stopImmediatePropagation();insertPaste(text,p);return}
            if(/\[\[(ref|eqref|cite):[^\]\n]+\]\]/.test(text)&&!/\[\[embed:/.test(text)){e.preventDefault();e.stopImmediatePropagation();pasteInline(area,text);return}
            if(/(\[\[embed:|\$[^$\n]+\$)/m.test(text)){e.preventDefault();e.stopImmediatePropagation();insertPaste(text,p)}
        },true)
        area.addEventListener('copy',e=>{const s=window.getSelection();if(!s?.rangeCount||s.isCollapsed||!area.contains(s.getRangeAt(0).commonAncestorContainer))return;const clone=s.getRangeAt(0).cloneContents();if(!clone.querySelector('[data-token]'))return;const holder=el('div');holder.append(clone);e.clipboardData.setData('text/plain',richMarkdown(holder));e.preventDefault()});
    }
    function objectRaw(p){p.raw=':::'+p.kind+' '+p.id+(p.flags?' '+p.flags:'')+'\n'+p.body+'\n:::';flush()}
    function draw(){
        body.replaceChildren();focused=null;selection=null;selectedObject=null;
        for(const p of parts){
            const card=el('section','visualCard');card._part=p;card.addEventListener('pointerdown',e=>{selectedPart=p;if(e.button===0&&!e.target.closest('.richText,math-field,button,input,textarea,select,.resizeHandle,.visualRef')){selectObject(p,card);if(p.kind!=='text'&&!e.target.closest('summary'))root.focus({preventScroll:true})}else if(e.button===0&&!e.target.closest('.resizeHandle'))clearObject()});
            card._selectImage=wrap=>{selectedPart=selectedObject=p;for(const c of body.children)c.classList.remove('selectedObject');document.querySelectorAll('.selectedImage').forEach(x=>{if(x!==wrap)x.classList.remove('selectedImage')});getSelection()?.removeAllRanges();root.focus({preventScroll:true});wrap.classList.add('selectedImage')};
            card._selectWhole=()=>{selectedPart=p;selectObject(p,card);root.focus({preventScroll:true})};
            if(p.kind==='figure')card.addEventListener('contextmenu',e=>{if(!e.target.closest('.resizeImage,.richText,.visualRef,button'))card._selectWhole()},true);
            const head=el('div','visualCardHead'),handle=el('span','visualHandle','⠿');handle.draggable=true;handle.title='拖动调整顺序';
            const title=p.kind==='text'?'正文':p.kind==='embed'?'知识块':p.kind==='equation'?'公式':p.kind==='figure'?'图片':'表格';
            if(p.id||p.ref)card.dataset.object=p.id||p.ref;card.classList.add('part-'+p.kind);
            head.append(handle,el('span','small partLabel',p.kind==='text'?'':title),el('div','spacer'));
            if(p.id){const t=resolve(p.id);head.append(el('span','visualNum small',t?.number||''))}
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
                const n=find(p.ref),details=el('details','embed visualEmbed'),summary=el('summary','',n?.title||'失效知识块：'+p.ref);
                details.append(summary);content.append(details);
                details.addEventListener('toggle',()=>{if(!details.open)return;while(details.children.length>1)details.lastChild.remove();if(!n||p.ref===owner){details.append(el('p','muted','知识块不存在或不能嵌入自身'));return}const preview=el('div','content');renderBody(n,preview,[owner,n.id].filter(Boolean));details.append(preview,btn('打开知识块',()=>select(n.id)))});
                extra=[['复制知识块',()=>copy(p.raw)],['打开知识块',()=>{if(n)select(n.id)}]];
            }else if(p.kind==='text'){
                const area=visualRich(p.raw,()=>{p.raw=richMarkdown(area);flush()});bindRich(area,p);content.append(area)
            }else if(p.kind==='equation'){
                const field=visualMath(p.body.trim(),true,value=>{p.body=value;objectRaw(p)}),palette=mathPanel(field);content.append(field,palette);
                extra=[['公式输入工具',()=>{card.classList.add('showMathTools');field.focus()}],['数学键盘',()=>{field.focus();window.mathVirtualKeyboard?.show()}],['复制公式',()=>copy(p.body)]]
            }else if(p.kind==='figure'){
                const lines=p.body.split('\n'),caption=lines.shift()||'',rest=lines.join('\n').trim();
                const cap=visualRich(caption,()=>{p.body=richMarkdown(cap).replace(/\n+/g,' ')+'\n\n'+imageSource;objectRaw(p)},true);
                let imageSource=normalizeFigureImages(rest,p.id);
                const imgs=el('div','visualImages');
                function displayImages(){
                    imgs.replaceChildren();markdown(imageSource,imgs,[owner].filter(Boolean),(src,w,index)=>{let i=-1;imageSource=imageSource.replace(figureImagePattern(),(m,alt,url,title)=>++i===index&&url===src?figureImageMarkup(alt,url,(title||'').replace(/(?:^|\s)wb-width:[^\s"]+/g,'')+' wb-width:'+w,figureImageId(title,p.id,index)):m);p.body=p.body.split('\n')[0]+'\n\n'+imageSource;objectRaw(p)});
                    const records=[...imageSource.matchAll(figureImagePattern())];
                    [...imgs.querySelectorAll('.resizeImage')].forEach((wrap,i)=>{
                        const m=records[i];if(!m)return;
                        const id=figureImageId(m[3],p.id,i);wrap.dataset.object=id;wrap.dataset.subfigure=id;wrap.title='子图 '+(resolve(id)?.number||subfigureLetter(i));
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
                const cap=visualRich(caption,()=>commitTable(),true);const wrap=el('div','tablescroll');const table=el('table','visualTable');wrap.append(table);
                let rows=rest.split('\n').filter(s=>s.trim().startsWith('|')).map(s=>s.trim().replace(/^\||\|$/g,'').split(/(?<!\\)\|/).map(x=>x.trim()));if(rows.length>1&&rows[1].every(x=>/^:?-+:?$/.test(x)))rows.splice(1,1);
                if(!rows.length){rows=[['项目','数值'],['','']];content.append(el('p','muted','原表格存在复杂内容，未修改时保持原始数据；如需改表请核对预览。'))}
                const cols=Math.max(1,...rows.map(x=>x.length));rows=rows.map(r=>Array.from({length:cols},(_,i)=>r[i]||''));
                function commitTable(){p.body=richMarkdown(cap).replace(/\n+/g,' ')+'\n\n'+[rows[0],rows[0].map(()=> '---'),...rows.slice(1)].map(r=>'| '+r.map(x=>x.replace(/\n+/g,' ').replace(/(?<!\\)\|/g,'\\|')).join(' | ')+' |').join('\n');objectRaw(p)}
                function tableDraw(){table.replaceChildren();rows.forEach((row,i)=>{const tr=el('tr');row.forEach((value,j)=>{const td=el(i===0?'th':'td');const cell=visualRich(value,()=>{rows[i][j]=richMarkdown(cell);commitTable()},true);bindRich(cell,p);td.append(cell);tr.append(td)});table.append(tr)})}
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
document.addEventListener('pointerdown',e=>{if(isActionSurface(e.target))return;for(const root of document.querySelectorAll('.visualDocument'))if(!root.contains(e.target))root._clearObject?.()},true);
function editor(n,host,pi,summary=null){
    const title=el('input','editableTitle');title.value=n.title;title.placeholder='标题';title.setAttribute('aria-label','章节标题');
    setEditorControlMode(title);
    const heading=el(summary?'span':'div','editableHeading');heading.dataset.bindObject=n.id;if(numbers.get(n.id))heading.append(el('span','headingNumber',numbers.get(n.id)));
    function sectionMenu(){return isBlock?nodeMenu(n):[...nodeMenu(n),['保存',()=>save()],['展开下级',()=>host.querySelectorAll('details.child').forEach(x=>x.open=true)],['折叠下级',()=>host.querySelectorAll('details.child').forEach(x=>x.open=false)],['高级：复制源码',()=>copy(n.body)]]}
    const isBlock=spaceOf(n.id)==='blocks';
    if(!isBlock)heading.append(title);else heading.append(el('div','spacer'));
    heading.append(btn('⋯',e=>menuAt(e,sectionMenu()),'sectionMore'));context(heading,sectionMenu,()=>resolve(n.id),isBlock);
    const doc=visualDocument(n.body,s=>{if(s===n.body)return;checkpoint();n.body=s;if(isBlock)n.title=blockLabel(s);change(false);if(isBlock)renderNav();for(const card of doc.root.querySelectorAll('.visualCard')){const p=card._part;if(p?.id){const label=card.querySelector('.visualNum');if(label)label.textContent=resolve(p.id)?.number||''}}},n.id,pi);
    title.addEventListener('input',()=>{if(!editingEnabled)return;const t=title.value.trim()||n.title;if(t===n.title)return;checkpoint();n.title=t;change(false);renderNav();if(summary)summary.querySelector('.childCollapsedTitle').textContent=label(n)});
    doc.root._sectionMenu=sectionMenu;
    if(summary){summary.append(heading);title.addEventListener('click',e=>e.stopPropagation());refreshObjectAnnotations(heading)}else host.append(heading);
    host.append(doc.root);refreshObjectAnnotations(host)
};
function blockLabel(body){const t=body.replace(/\[\[(?:ref|eqref|embed|cite):[^\]]+\]\]/g,'').replace(/!\[[^\]]*\]\([^)]*\)/g,'').replace(/^:::[^\n]*$/gm,'').replace(/\s+/g,' ').trim();return t.slice(0,36)||'知识块'}
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
function refreshObjectAnnotations(scope=document){
    if(!db)return;
    const selector='.visualCard[data-object],.resizeImage[data-subfigure],.editableHeading[data-bind-object]';
    const objects=[...(scope.matches?.(selector)?[scope]:[]),...scope.querySelectorAll(selector)];
    for(const object of objects){
        const id=object.dataset.object||object.dataset.bindObject;
        const parent=object.matches('.visualCard')?object.querySelector(':scope > .visualCardHead'):object;
        if(!parent)continue;
        const notes=db.blocks.flatMap(n=>objectNoteBindings(n).filter(b=>b.targetId===id).map(binding=>({n,binding})));
        let group=parent.querySelector(':scope > .objectNoteMarkers');
        if(!notes.length){group?.remove();continue}
        if(!group){group=el('span','objectNoteMarkers');parent.append(group)}
        const key=notes.map(({n})=>n.id).join('|');
        if(group.dataset.key===key)continue;
        group.dataset.key=key;group.replaceChildren();
        for(const {n,binding} of notes){
            const chip=btn('※',e=>{const current=find(n.id),b=current&&objectNoteBindings(current).find(x=>x.targetId===id);if(current&&b)openAnnotationNote(current,chip,e,b)},'objectNoteMarker');
            chip.title='打开批注/知识块';chip.setAttribute('aria-label','打开对象批注');chip.dataset.noteId=n.id;chip.dataset.targetId=id;
            chip.addEventListener('contextmenu',e=>{e.preventDefault();e.stopPropagation();menuAt(e,[['解除绑定',()=>{const current=find(n.id);if(!current)return;checkpoint();current.objectBindings=objectNoteBindings(current).filter(x=>x.targetId!==id);change(false)}]])});
            group.append(chip)
        }
    }
}
function refreshFreeNotes(){
    if(!db)return;
    for(const page of paneBox.querySelectorAll('.pane > .page')){
        const pageId=page.parentElement._readingPane?.id;
        const notes=db.blocks.flatMap(n=>freeNotePlacements(n).filter(p=>p.pageId===pageId).map(placement=>({n,placement})));
        let layer=page.querySelector(':scope > .freeNoteLayer');
        if(!notes.length){layer?.remove();continue}
        if(!layer){layer=el('div','freeNoteLayer');page.append(layer)}
        const key=JSON.stringify(notes.map(({n,placement:p})=>[n.id,p.id,p.x,p.y]));
        if(layer.dataset.key===key)continue;
        layer.dataset.key=key;layer.replaceChildren();
        for(const {n,placement:p} of notes){
            const marker=btn('※',e=>{const current=find(n.id),place=current&&freeNotePlacements(current).find(x=>x.id===p.id);if(current&&place)openAnnotationNote(current,marker,e,null,place)},'freeNoteMarker');
            marker.style.left='clamp(0px,'+(p.x*100)+'%,calc(100% - 18px))';marker.style.top='clamp(0px,'+p.y+'px,calc(100% - 18px))';
            marker.dataset.noteId=n.id;marker.dataset.placementId=p.id;marker.title='打开独立知识块';marker.setAttribute('aria-label','打开独立知识块');
            marker.addEventListener('contextmenu',e=>{e.preventDefault();e.stopPropagation();menuAt(e,[['移除此处标记',()=>{const current=find(n.id);if(!current)return;checkpoint();current.freePlacements=freeNotePlacements(current).filter(x=>x.id!==p.id);change(false)}]])});
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
    dialog._commitNote=()=>{
        const value=doc.getValue();dialog.close();
        if(value!==initial){checkpoint();n.body=value;n.title=blockLabel(value);change(false);renderNav()}
    };
    d.append(doc.root);setupNoteResize(d,n.floatSize,size=>{if(editingEnabled){n.floatSize=size;change(false)}});requestAnimationFrame(()=>{if(editingEnabled)doc.root.querySelector('.richText')?.focus({preventScroll:true});scheduleToolbarUpdate()});
}
function newNode(space,parent=null,body='',title='',onCreated=null,options={}){
    if(!requireEditMode())return;
    if(space==='blocks'){
        const d=showDialog('',{...options,floating:true});dialog.classList.add('blankNoteDialog');
        const doc=visualDocument(remapCopiedObjects(body),()=>{},null);
        dialog._commitNote=()=>{
            const value=remapCopiedObjects(doc.getValue());if(!value.trim()){dialog.close();return}
            checkpoint();const id='block-'+uid(),n={id,title:blockLabel(value),parent,level:parent?ancestors(find(parent)).length+2:1,number:'',file:'blocks/'+id+'.md',source:'',order:db.blocks.length,body:value};
            if(options.binding?.mode==='object')n.objectBindings=[{targetId:options.binding.targetId,floatOffset:{...(dialog._relativeOffset||{x:14,y:8})}}];
            else if(options.binding)n.annotation={owner:options.binding.owner.id,mode:options.binding.mode,quote:options.binding.quote,floatOffset:{...(dialog._relativeOffset||{x:14,y:8})}};
            else if(options.freePlacement)n.freePlacements=[{...options.freePlacement,floatOffset:{...(dialog._relativeOffset||{x:14,y:8})}}];
            if(dialog._noteSize)n.floatSize={...dialog._noteSize};
            db.blocks.push(n);normalizeOrder(space);dialog.close();change(false);if(onCreated){onCreated(id);renderNav()}else{select(id);renderPanes()}
        };
        d.append(doc.root);setupNoteResize(d);requestAnimationFrame(()=>doc.root.querySelector('.richText')?.focus());return
    }
    const d=showDialog(options.annotation?'新建批注/知识块':space==='blocks'?'新建知识块':'新建章节',options);
    if(options.annotation)d.append(el('p','small',options.binding?.mode==='selection'?'绑定选中文本开头':options.binding?.mode==='caret'?'绑定当前光标':'独立知识块（不绑定正文）'));
    const name=el('input');name.placeholder='输入标题';name.value=title;name.style.width='100%';
    const doc=visualDocument(remapCopiedObjects(body),()=>{},null);
    d.append(name,doc.root,btn('创建',()=>{if(!name.value.trim()){name.focus();return}checkpoint();const id=(space==='blocks'?'block-':'sec-')+uid();
        const n={id,title:name.value.trim(),parent,level:parent?ancestors(find(parent)).length+2:1,number:'',file:space+'/'+id+'.md',source:'',order:db[space].length,body:remapCopiedObjects(doc.getValue())};
        if(options.binding)n.annotation={owner:options.binding.owner.id,mode:options.binding.mode,quote:options.binding.quote};
        db[space].push(n);normalizeOrder(space);dialog.close();change(false);if(onCreated){onCreated(id);renderNav()}else{select(id);panes[active].edit=true;renderPanes()}
    }));setTimeout(()=>name.focus(),30)
};

