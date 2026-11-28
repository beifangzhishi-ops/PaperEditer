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
// Native MathLive copies a typed LaTeX payload and a $$...$$ text fallback.
// The context menu uses the same text envelope so even browsers which only
// permit text clipboard access can distinguish a formula from ordinary prose.
function formulaClipboardLatex(data,text=data?.getData('text/plain')||''){
    const typed=data?.getData('application/x-latex');
    if(typed?.trim())return typed.trim();
    const s=text.trim();
    for(const [open,close] of [['$$','$$'],['\\(','\\)'],['\\[','\\]'],['$','$']]){
        if(!s.startsWith(open)||!s.endsWith(close)||s.length<=open.length+close.length)continue;
        const body=s.slice(open.length,-close.length).trim();
        if(body&&!body.includes(close)&&(open!=='$'||!body.includes('\n')))return body
    }
    return null
}
function formulaClipboardText(tex){return '$$ '+tex+' $$'}
function inlineFormulaSource(tex){
    tex=(tex||' ').replace(/\r?\n/g,' ');
    return tex.includes('$')?'\\('+tex+'\\)':'$'+tex+'$'
}
function formulaObjectSource(tex){return ':::equation eq-'+uid()+'\n'+tex+'\n:::'}
function visualMath(tex,display,onInput,note=false){
    const f=document.createElement('math-field');f.className='visualMath'+(display?' displayMath':'');f.setAttribute('contenteditable','true');f.setAttribute('math-virtual-keyboard-policy','auto');
    f.setAttribute('aria-label','可编辑数学公式');f.value=tex;f._texOriginal=tex;f._texChanged=false;f.dataset.tex=tex;
    if(note){f._noteEditor=true;f.dataset.noteEditor=""}
    setEditorControlMode(f);
    function configure(){if(!f.isConnected)return;try{
        f.menuItems=[];f.popoverPolicy='off';f.smartFence=true;f.smartSuperscript=true;
        f.inlineShortcuts={...f.inlineShortcuts,'>=':'\\ge','<=':'\\le','!=':'\\ne'};
    }catch(err){/* Wait for MathLive to mount its internal editor. */}}
    customElements.whenDefined('math-field').then(()=>requestAnimationFrame(configure));
    f.addEventListener('focusin',()=>{configure();if(canEditControl(f))showMathPalette(f)});
    f.addEventListener('keydown',e=>{
        if(e.key==='Escape'&&canEditControl(f)){e.preventDefault();e.stopPropagation();leaveMathField(f,'forward',true)}
    },true);
    f.addEventListener('move-out',e=>{if(canEditControl(f)&&leaveMathField(f,e.detail.direction,false))e.preventDefault()});
    f.addEventListener('input',e=>{e.stopPropagation();if(!canEditControl(f))return;f._texChanged=true;f.dataset.tex=f.value;onInput(f.value)});
    f.addEventListener('paste',()=>{if(canEditControl(f))requestAnimationFrame(()=>centerAfterPaste(f))},true);
    // MathLive consumes its own contextmenu event inside the shadow DOM.
    // Route it through the editor menu before the native handler sees it.
    f.addEventListener('contextmenu',e=>{
        e.preventDefault();e.stopImmediatePropagation();
        const items=simpleContextMenu(e);
        if(touchContextEvent(e)){touchMenuAt=Date.now();showFloatingTools(e,items)}
        else menuAt(e,items)
    },true);
    for(const type of ['copy','cut'])f.addEventListener(type,e=>{
        if(!e.clipboardData||type==='cut'&&(!canEditControl(f)||f.selectionIsCollapsed))return;
        const tex=f.selectionIsCollapsed?f.value:f.getValue(f.selection,'latex');
        if(!tex)return;
        // Keep the native MathLive atom/JSON export and paste behavior intact.
        e.clipboardData.setData('application/x-latex',tex);
        localClipboard=formulaClipboardText(tex);localClipboardPreferred=false
    },true);
    return f;
}
// Keep the outer caret on a real prose boundary, never in MathLive's
// nested editing host. Adjacent text offsets also give Chromium a visible
// caret when the field loses focus.
function inlineMathEdge(atom,after){
    const r=document.createRange(),sibling=after?atom.nextSibling:atom.previousSibling;
    if(sibling?.nodeType===Node.TEXT_NODE)r.setStart(sibling,after?0:sibling.length);
    else if(after)r.setStartAfter(atom);else r.setStartBefore(atom);
    r.collapse(true);return r
}
function enterAdjacentInlineMath(e,area){
    if(e.defaultPrevented||e.isComposing||e.keyCode===229||e.shiftKey||e.ctrlKey||e.altKey||e.metaKey||!canEditControl(area)||!['ArrowLeft','ArrowRight'].includes(e.key)||e.composedPath().some(n=>n.tagName==='MATH-FIELD'))return;
    const s=getSelection();
    if(!s?.rangeCount||!s.isCollapsed||!area.contains(s.focusNode))return;
    const caret=s.getRangeAt(0),forward=e.key==='ArrowRight',node=s.focusNode;
    const inside=(node.nodeType===Node.ELEMENT_NODE?node:node.parentElement)?.closest('.inlineMathAtom');
    let atom=inside;
    if(!atom){
        const atoms=[...area.querySelectorAll('.inlineMathAtom')];if(!forward)atoms.reverse();
        for(const candidate of atoms){
            const edge=document.createRange();edge.selectNode(candidate);edge.collapse(forward);
            const cmp=edge.compareBoundaryPoints(Range.START_TO_START,caret);
            if(forward?cmp<0:cmp>0)continue;
            const gap=document.createRange();
            if(forward){gap.setStart(caret.startContainer,caret.startOffset);gap.setEnd(edge.startContainer,edge.startOffset)}
            else{gap.setStart(edge.startContainer,edge.startOffset);gap.setEnd(caret.startContainer,caret.startOffset)}
            const content=gap.cloneContents();
            if(!content.textContent&&!content.querySelector('br,img,[data-token],.inlineMathAtom')&&
                (node.nodeType===Node.ELEMENT_NODE?node:node.parentElement)?.closest('p,li,h1,h2,h3,h4,h5,h6,blockquote')===candidate.closest('p,li,h1,h2,h3,h4,h5,h6,blockquote'))atom=candidate;
            break
        }
    }
    const field=atom?.querySelector('math-field');
    if(!field||field.readOnly||typeof field.lastOffset!=='number')return;
    e.preventDefault();e.stopPropagation();
    field.focus({preventScroll:true});field.position=forward?0:field.lastOffset
}
// MathLive itself must remain editable. The wrapper, not its editor, is
// atomic to the surrounding contenteditable prose.
function inlineMathAtom(field){
    const atom=el('span','inlineMathAtom');atom.contentEditable='false';field.dataset.inline='1';atom.append(field);return atom
}
let activeMathField=null,activeMathPalette=null;
function hideMathPalette(){activeMathPalette?.remove();activeMathPalette=null;activeMathField=null}
function positionMathPalette(){
    const bar=activeMathPalette,field=activeMathField;
    if(!bar||!field?.isConnected||!canEditControl(field)){hideMathPalette();return}
    const v=window.visualViewport,w=v?.width||innerWidth,h=v?.height||innerHeight,x=v?.offsetLeft||0,y=v?.offsetTop||0;
    const r=field.getBoundingClientRect(),mobile=matchMedia('(pointer:coarse), (max-width:760px)').matches;
    bar.style.maxWidth=Math.max(0,w-16)+'px';
    const left=mobile?x+8:Math.max(x+8,Math.min(r.left+r.width/2-bar.offsetWidth/2,x+w-bar.offsetWidth-8));
    const above=r.top-bar.offsetHeight-8;
    const top=mobile?y+56:above>=y+56?above:Math.min(r.bottom+8,y+h-bar.offsetHeight-8);
    bar.style.left=left+'px';bar.style.top=Math.max(y+8,top)+'px'
}
function showMathPalette(field){
    if(activeMathField===field&&activeMathPalette?.isConnected)return;
    hideMathPalette();activeMathField=field;activeMathPalette=mathPanel(field);
    (dialog.open&&dialog.contains(field)?dialog:document.body).append(activeMathPalette);positionMathPalette()
}
document.addEventListener('focusin',e=>{if(!e.target.closest('math-field,.mathPalette,.ML__keyboard'))hideMathPalette()},true);
document.addEventListener('pointerdown',e=>{if(!e.target.closest('math-field,.mathPalette,.ML__keyboard,#floatingTools,#menu'))hideMathPalette()},true);
document.addEventListener('scroll',positionMathPalette,true);
window.addEventListener('resize',positionMathPalette);
window.visualViewport?.addEventListener('resize',positionMathPalette);
window.visualViewport?.addEventListener('scroll',positionMathPalette);
function leaveMathField(field,direction,selectWhole){
    const area=field.closest('.richText'),card=field.closest('.visualCard');
    const backwards=direction==='backward'||direction==='upward';
    if(area){
        const atom=field.closest('.inlineMathAtom')||field;
        area.focus({preventScroll:true});const r=inlineMathEdge(atom,!backwards);
        const s=getSelection();s.removeAllRanges();s.addRange(r);hideMathPalette();return true
    }
    if(!card)return false;
    if(!selectWhole){
        const next=backwards?card.previousElementSibling:card.nextElementSibling,target=next?.querySelector('.richText');
        if(target){target.focus({preventScroll:true});const r=document.createRange();r.selectNodeContents(target);r.collapse(!backwards);const s=getSelection();s.removeAllRanges();s.addRange(r);hideMathPalette();return true}
    }
    card._selectWhole?.();hideMathPalette();return true
}
function mathPanel(field){
    const bar=el('div','mathPalette');
    const symbols=[['分数',String.raw`\frac{#@}{#?}`],['上标','^{#?}'],['下标','_{#?}'],['根号',String.raw`\sqrt{#@}`],['积分',String.raw`\int_{#?}^{#?}`],['求和',String.raw`\sum_{#?}^{#?}`],['矩阵',String.raw`\begin{pmatrix}#?&#?\\#?&#?\end{pmatrix}`],['偏导',String.raw`\partial`],['矢量',String.raw`\vec{#@}`],['α',String.raw`\alpha`],['β',String.raw`\beta`],['ρ',String.raw`\rho`],['μ',String.raw`\mu`],['σ',String.raw`\sigma`],['ω',String.raw`\omega`],['π',String.raw`\pi`],['±',String.raw`\pm`],['≤',String.raw`\le`]];
    const glyphs=['a/b','xⁿ','xᵢ','√','∫','∑','▦','∂','x⃗'];
    for(const [i,[name,value]] of symbols.entries()){const b=btn(glyphs[i]||name,()=>{
        if(!canEditControl(field)||!field.isConnected)return;field.focus();
        // The initial square is only a visible insertion point, not an operand.
        if(field.value==='\\square'&&!field.selectionIsCollapsed&&field.getValue(field.selection,'latex')==='\\square'){
            field.insert(value.replaceAll('#@','#?'),{insertionMode:'replaceSelection',selectionMode:'placeholder'})
        }else field.insert(value,{insertionMode:'replaceSelection',selectionMode:'placeholder'});
        field.dispatchEvent(new Event('input',{bubbles:true}))
    });b.title=name;b.setAttribute('aria-label',name);b.addEventListener('pointerdown',e=>e.preventDefault());bar.append(b)}
    const keyboard=btn('数学键盘',()=>{field.focus();window.mathVirtualKeyboard?.show()});keyboard.addEventListener('pointerdown',e=>e.preventDefault());bar.append(keyboard);return bar
}
// A note marker is a selectable reference, not an editable text character.
const noteLabelSelector='.inlineAnnotation,.objectNoteMarker,.freeNoteMarker,.noteWindowHandle';
let selectedNoteId=null;
let textAnnotationRanges=[];
let annotatedMath=new Set();
function mathAtomsInRange(range,area){
    return [...area.querySelectorAll('.inlineMathAtom')].filter(atom=>{
        const bounds=document.createRange();bounds.selectNode(atom);
        return range.compareBoundaryPoints(Range.END_TO_START,bounds)<0&&range.compareBoundaryPoints(Range.START_TO_END,bounds)>0;
    })
}
function annotationMathToken(atom){return '\uFFFC'+JSON.stringify(atom.querySelector('math-field')?.dataset.tex||'')+'\uFFFC'}
function annotationQuote(range){
    const quote=range.toString(),fragment=range.cloneContents(),atoms=fragment.querySelectorAll('.inlineMathAtom');
    if(!atoms.length)return {quote};
    for(const atom of atoms)atom.replaceWith(document.createTextNode(annotationMathToken(atom)));
    return {quote,mathQuote:fragment.textContent}
}
function syncAnnotationMath(){
    const next=new Set(),selected=new Set();
    for(const {chip,math} of textAnnotationRanges)if(chip.isConnected)for(const atom of math||[]){
        next.add(atom);if(chip.dataset.noteId===selectedNoteId)selected.add(atom)
    }
    for(const atom of annotatedMath)if(!next.has(atom))atom.classList.remove('annotationMathHighlight','annotationMathSelected');
    for(const atom of next){atom.classList.add('annotationMathHighlight');atom.classList.toggle('annotationMathSelected',selected.has(atom))}
    annotatedMath=next
}
function syncNoteSelection(){
    syncAnnotationMath();
    for(const chip of document.querySelectorAll(noteLabelSelector)){
        const selected=!!selectedNoteId&&chip.dataset.noteId===selectedNoteId;
        chip.classList.toggle('selectedNoteLabel',selected);
        chip.setAttribute('aria-pressed',String(selected));
    }
    if(globalThis.CSS?.highlights&&typeof Highlight!=='undefined'){
        const ranges=textAnnotationRanges.filter(x=>x.chip.isConnected&&x.chip.dataset.noteId===selectedNoteId).map(x=>x.range);
        if(ranges.length){const h=new Highlight(...ranges);h.priority=1;CSS.highlights.set('paper-annotation-selected',h)}
        else CSS.highlights.delete('paper-annotation-selected');
    }
}
function clearNoteLabel(){
    if(!selectedNoteId)return;
    selectedNoteId=null;syncNoteSelection();scheduleToolbarUpdate();
}
function selectNoteLabel(chip){
    if(!chip?.isConnected)return;
    for(const root of document.querySelectorAll('.visualDocument')){root._clearObject?.();root._clearMixed?.()}
    selectedNoteId=chip.dataset.noteId;syncNoteSelection();
    const handle=dialog.open&&dialog._noteId===selectedNoteId&&dialog.querySelector('.noteWindowHandle');
    (handle||chip).focus({preventScroll:true});getSelection()?.removeAllRanges();scheduleToolbarUpdate();
}
function noteLabelMenu(chip){
    const id=chip.dataset.noteId,n=find(id);if(!n)return [];
    const detach=()=>{if(!chip.isConnected||!requireEditMode())return;clearNoteLabel();if(dialog.open&&dialog._noteId===id&&!chip.matches('.noteWindowHandle'))closeWorkbenchDialog();chip._detachNote?.()};
    return [['剪切',async()=>{if(chip._detachNote&&requireEditMode()){await writeEditorClipboard(annotationClipboard(n,true));detach()}},!chip._detachNote],['复制',()=>writeEditorClipboard(annotationClipboard(n))],
        ['打开批注',()=>chip._openNote?.()],
        ['删除批注',()=>{if(!requireEditMode())return;clearNoteLabel();if(dialog.open)closeWorkbenchDialog();deleteNode(find(id))}],
        ...(chip.matches('.objectNoteMarker')?[['解除绑定',detach]]:chip.matches('.freeNoteMarker')?[['移除此处标记',detach]]:[])];
}
function setupNoteLabel(chip,id,open,detach,windowHandle=false){
    chip.dataset.noteId=id;chip.tabIndex=0;chip.setAttribute('role','button');chip.setAttribute('aria-pressed','false');
    chip.title=windowHandle?'\u70b9\u51fb\u9009\u4e2d\u6279\u6ce8':'\u6253\u5f00\u5e76\u9009\u4e2d\u6279\u6ce8';
    chip._openNote=()=>{const r=chip.getBoundingClientRect();open({clientX:r.left,clientY:r.bottom});if(!windowHandle){const handle=dialog.querySelector('.noteWindowHandle');if(handle)selectNoteLabel(handle)}};
    chip._detachNote=detach;
    chip.addEventListener('pointerdown',e=>{if(e.button===0&&e.pointerType!=='touch')e.preventDefault()});
    chip.addEventListener('click',e=>{e.stopPropagation();if(windowHandle)selectNoteLabel(chip);else chip._openNote()});
    chip.addEventListener('keydown',e=>{
        if(e.defaultPrevented||e.isComposing||e.ctrlKey||e.metaKey||e.altKey||e.shiftKey)return;
        if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();chip._openNote();return}
        if(e.key==='Escape'){clearNoteLabel();scheduleToolbarUpdate();return}
        if(['Delete','Backspace'].includes(e.key)&&chip.classList.contains('selectedNoteLabel')){e.preventDefault();e.stopPropagation();if(editingEnabled&&!e.repeat)deleteNode(find(id))}
    });
    context(chip,()=>{selectNoteLabel(chip);return noteLabelMenu(chip)},()=>resolve(id),true);
}
document.addEventListener('pointerdown',e=>{if(!isActionSurface(e.target)&&!e.target.closest('.selectedNoteLabel'))clearNoteLabel()},true);
document.addEventListener('focusin',e=>{if(!isActionSurface(e.target)&&!e.target.closest('.selectedNoteLabel'))clearNoteLabel()},true);
document.addEventListener('click',e=>{if(dialog.open&&(e.target===dialog||e.target===$('dialogBody'))){const handle=dialog.querySelector('.noteWindowHandle');if(handle)selectNoteLabel(handle)}});
function textAnnotationAt(e){
    const area=e.target.closest('.richText');
    return textAnnotationRanges.find(({chip,range})=>chip.isConnected&&area?.contains(range.startContainer)&&[...range.getClientRects()].some(r=>e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom))
}
document.addEventListener('click',e=>{
    if(e.defaultPrevented||e.button!==0||e.shiftKey||e.ctrlKey||e.metaKey||e.altKey||!e.target.closest('.pane .richText')||e.target.closest('[data-token],math-field,a,img,button'))return;
    if(!getSelection()?.isCollapsed||e.target.closest('.visualDocument')?._mixedRange?.())return;
    const hit=textAnnotationAt(e);
    if(hit){e.preventDefault();hit.chip._openNote?.()}
});
function visualRef(kind,id,allowRefs=true){
    const chip=el('span','visualRef');chip.contentEditable='false';chip.dataset.token='[['+kind+':'+id+']]';
    if(kind==='embed'){const n=find(id);chip.textContent='※';chip.classList.add('inlineAnnotation');chip.setAttribute('aria-label','批注');chip.title='批注不存在';if(n)setupNoteLabel(chip,id,e=>{const current=find(id);if(current)openAnnotationNote(current,chip,e)},()=>{
        const area=chip.closest('.richText');if(!area)return;
        annotationEdit(()=>{const note=find(id);if(note){delete note.annotation;delete note.textBindings}chip.remove();area.dispatchEvent(new Event('input',{bubbles:true}))});
    });}
    else {const t=resolve(id),note=db.blocks.find(n=>n.id===id);const text=kind==='cite'?'['+id+']':note?note.title:t?(kind==='eqref'?'('+(t.number||t.title)+')':t.number||t.title):'〔未解析：'+id+'〕';chip.textContent=text;if(note||!allowRefs)chip.classList.add('legacyNoteRef');else if(texTarget(t)){chip.title=t.title;context(chip,()=>refMenu(t),()=>resolve(id)||t);chip.addEventListener('click',e=>{e.stopPropagation();jump(id,e.shiftKey)})}}
    return chip
}
// Share the inline token grammar between initial rendering and clipboard insertion.
function inlineTokenPattern(){return /(?<!\\)\$\$([\s\S]+?)\$\$|(?<!\\)\$([^\n$]+?)\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\[\[(ref|eqref|embed|cite):([^\]\n]+)\]\]/g}
function visualRich(raw,changed,compact=false,allowRefs=true){
    const host=el('div','richText'+(compact?' compact':''));host.contentEditable='true';host.spellcheck=false;host.setAttribute('role','textbox');host.setAttribute('aria-multiline','true');
    if(!allowRefs){host._noteEditor=true;host.dataset.noteEditor=""}
    setEditorControlMode(host);
    const tokens=[];
    function token(kind,value){const i=tokens.push({kind,value})-1;return '<span data-wb-token="'+i+'"></span>'}
    const src=raw.replace(inlineTokenPattern(),(m,dm,im,bd,bi,k,id)=>dm!=null?token('math',dm):im!=null?token('math',im):bd!=null?token('math',bd):bi!=null?token('math',bi):token(k,id));
    host.innerHTML=DOMPurify.sanitize(marked.parse(src,{gfm:true,breaks:false}),{ADD_ATTR:['data-wb-token']});
    for(const p of host.querySelectorAll('[data-wb-token]')){
        const t=tokens[Number(p.dataset.wbToken)];if(!t){p.remove();continue}
        if(t.kind==='math'){
            const f=visualMath(t.value,false,()=>changed(),!allowRefs);p.replaceWith(inlineMathAtom(f));
        }else p.replaceWith(visualRef(t.kind,t.value,allowRefs))
    }
    if(!host.childNodes.length)host.append(el('p'));
    host.addEventListener('keydown',e=>enterAdjacentInlineMath(e,host));
    host.addEventListener('input',e=>{if(canEditControl(host))changed(typingEdit(e,host))});
    // Avoid pasting untrusted HTML; recognized structured text is handled by the parent.
    host.addEventListener('paste',e=>{if(e.defaultPrevented||e.target.closest('math-field'))return;const items=[...(e.clipboardData?.items||[])];if(items.some(x=>x.type.startsWith('image/')))return;e.preventDefault();const text=e.clipboardData?.getData('text/plain')||'';document.execCommand('insertText',false,text);changed();centerAfterPaste(host)});
    return host
}
function richMarkdown(host,fragment=false){
    function walk(n){
        if(n.nodeType===Node.TEXT_NODE)return (n.textContent||'').replace(/\u00a0/g,' ');
        if(n.nodeType!==Node.ELEMENT_NODE)return '';
        if(n.tagName==='MATH-FIELD')return inlineFormulaSource(n.dataset.tex??(n._texChanged?n.value:n._texOriginal||n.value||''));
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
// Scroll the editing pane, not the document or the beginning of the pasted
// block. Re-measure after layout, and cancel if the user moves the caret.
function centerAfterPaste(target){
    if(!target?.isConnected)return;
    const sel=getSelection(),range=sel?.rangeCount&&target.contains(sel.getRangeAt(0).commonAncestorContainer)?sel.getRangeAt(0).cloneRange():null;
    if(range)range.collapse(false);
    const scroller=target.closest('dialog')||target.closest('.pane');
    if(!scroller)return;
    scroller._restoringReading=false;
    const ticket={};scroller._pasteCenter=ticket;
    function center(){
        if(!target.isConnected||scroller._pasteCenter!==ticket)return;
        if(range){const s=getSelection();if(!s?.rangeCount||s.focusNode!==range.endContainer||s.focusOffset!==range.endOffset)return}
        const rect=(range&&caretBounds(range))||target.getBoundingClientRect();
        const box=scroller.getBoundingClientRect(),toolbar=scroller.querySelector(':scope > .toolbar'),top=Math.max(box.top,toolbar?.getBoundingClientRect().bottom||box.top);
        const viewportBottom=Math.min(box.bottom,(window.visualViewport?.offsetTop||0)+(window.visualViewport?.height||innerHeight));
        const y=(top+Math.max(top,viewportBottom))/2;
        const desired=scroller.scrollTop+(rect.top+rect.bottom)/2-y;
        // Leave room below the final paragraph so it can also be centered.
        const page=target.closest('.page');
        if(page&&desired>scroller.scrollHeight-scroller.clientHeight){
            const pad=parseFloat(getComputedStyle(page).paddingBottom)||0;
            page.style.paddingBottom=Math.ceil(pad+desired-(scroller.scrollHeight-scroller.clientHeight)+2)+'px';
        }
        scroller.scrollTop=Math.max(0,desired);
    }
    requestAnimationFrame(()=>{center();requestAnimationFrame(center)});
    for(const type of ['pointerdown','keydown','wheel','touchstart'])scroller.addEventListener(type,()=>{if(scroller._pasteCenter===ticket)scroller._pasteCenter=null},{once:true,passive:true});
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
    if(!canEditControl(e.target))return;
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
    // When the destination column falls on a formula, choose its nearest
    // prose edge rather than jumping to the beginning/end of the paragraph.
    const atom=document.elementsFromPoint(x,dest.y).map(n=>n.closest('.inlineMathAtom')).find(n=>n&&next.contains(n));
    if(atom){const rect=atom.getBoundingClientRect();target=inlineMathEdge(atom,x>rect.left+rect.width/2)}
    else if(!target||!next.contains(target.startContainer)||((target.startContainer.nodeType===Node.ELEMENT_NODE?target.startContainer:target.startContainer.parentElement)?.closest('[contenteditable=false],math-field'))){
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
        const r=await fetch('/api/upload',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-PaperEditer-Workspace':currentWorkspace?.id||''},body:file});
        const result=await r.json();if(!r.ok)throw new Error(result.error||'HTTP '+r.status);
        done?.(result.url,file.name||'图片');return {url:result.url,name:file.name||'图片'}
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
    if(internal)root.dataset.noteEditor="";
    root.append(body);root._owner=owner;root._internalObjects=internal;
    let selectedPart=parts[0],selectedObject=null;
    const value=()=>parts.map(p=>p.raw).filter(x=>x.trim()).join('\n\n')+'\n';
    let lastValue=value(),draftUndo=[],draftRedo=[];
    function flush(edit=null){
        const s=value();if(s===lastValue)return;
        if(dialog.contains(root)){pushEditHistory(draftUndo,lastValue,edit,60);draftRedo=[]}
        lastValue=s;onUpdate(s,edit)
    }
    function draftHistory(redo){
        endTypingUndo();
        if(!requireEditMode(root))return;
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
    function selectedPieces(r,serialize=false,allowCaret=false){
        if(!r||r.collapsed&&!allowCaret||!body.contains(r.startContainer)||!body.contains(r.endContainer))return [];
        return cards().flatMap(card=>{
            const bounds=document.createRange();bounds.selectNode(card);
            if(r.compareBoundaryPoints(Range.END_TO_START,bounds)>=0||r.compareBoundaryPoints(Range.START_TO_END,bounds)<=0)return [];
            const p=card._part;
            if(p.kind!=='text')return [serialize?{card,p,raw:card._clipboardRaw?.()||p.raw}:{card,p}];
            const area=card.querySelector('.richText'),whole=document.createRange();whole.selectNodeContents(area);
            const local=whole.cloneRange();
            if(area.contains(r.startContainer))local.setStart(r.startContainer,r.startOffset);
            if(area.contains(r.endContainer))local.setEnd(r.endContainer,r.endOffset);
            if(local.collapsed&&!allowCaret)return [];
            if(!serialize)return [{card,p,local}];
            const before=whole.cloneRange(),after=whole.cloneRange();before.setEnd(local.startContainer,local.startOffset);after.setStart(local.endContainer,local.endOffset);
            const md=x=>{const h=el('div');h.append(x.cloneContents());return richMarkdown(h,true)};
            return [{card,p,local,raw:md(local),before:md(before),after:md(after)}]
        })
    }
    // A contiguous selection has one annotation marker, even when its text
    // spans several independently rendered paragraph cards.
    root._rangeAnnotationBinding=r=>{
        const node=find(owner);
        if(internal||!node||spaceOf(owner)!=='thesis'||dialog.open||!root.closest('.pane:not(.historicalPane)'))return null;
        const pieces=selectedPieces(r).filter(p=>p.local&&(p.local.toString()||mathAtomsInRange(p.local,p.card).length));
        if(!pieces.length)return null;
        const first=pieces[0],area=first.card.querySelector('.richText'),range=first.local.cloneRange();range.collapse(true);
        const start=cards().indexOf(first.card),segments=pieces.map(p=>({partOffset:cards().indexOf(p.card)-start,...annotationQuote(p.local)}));
        return {doc:root,area,range,owner:node,mode:'selection',quote:segments.map(s=>s.quote).join('\n\n'),...(segments.length>1?{segments}:segments[0].mathQuote?{mathQuote:segments[0].mathQuote}:{})}
    };
    function selectedRangeNotes(r,pieces=selectedPieces(r,true)){
        if(internal||!pieces.length)return [];
        const selected=new Map(),ids=new Set();
        for(const piece of pieces){
            for(const m of piece.raw.matchAll(refPattern()))if(m[1]==='embed'){
                const note=db.blocks.find(n=>n.id===m[2]);if(note)selected.set(note.id,{note,piece});
            }
            if(!piece.local)for(const id of objectIds({body:piece.raw}))ids.add(id);
        }
        for(const {chip,range} of textAnnotationRanges){
            if(!chip.isConnected||!body.contains(chip)||range.collapsed)continue;
            const piece=pieces.find(p=>p.local&&p.card.contains(range.startContainer));
            if(!piece||piece.local.compareBoundaryPoints(Range.END_TO_START,range)>=0||piece.local.compareBoundaryPoints(Range.START_TO_END,range)<=0)continue;
            const note=db.blocks.find(n=>n.id===chip.dataset.noteId);
            if(note&&!selected.has(note.id))selected.set(note.id,{note,piece,highlightOnly:true});
        }
        for(const note of db.blocks)for(const binding of objectNoteBindings(note))if(ids.has(binding.targetId)&&!selected.has(note.id))selected.set(note.id,{note,binding});
        // Free annotations have no text anchor. Include only markers whose
        // page coordinates lie between the selected range endpoints.
        const page=root.closest('.page'),first=pieces[0],last=pieces.at(-1);
        if(pieces.length>1&&page&&page.parentElement?._readingPane?.id===owner){
            const bounds=(piece,end)=>{if(!piece.local)return piece.card.getBoundingClientRect();const range=piece.local.cloneRange();range.collapse(!end);return caretBounds(range)||piece.card.getBoundingClientRect()};
            const top=bounds(first,false).top,bottom=bounds(last,true).bottom;
            for(const marker of page.querySelectorAll(':scope > .freeNoteLayer .freeNoteMarker')){
                const b=marker.getBoundingClientRect(),y=(b.top+b.bottom)/2,note=db.blocks.find(n=>n.id===marker.dataset.noteId);
                if(note&&y>=top&&y<=bottom&&!selected.has(note.id)){
                    const piece=pieces.find(p=>p.card.getBoundingClientRect().bottom>=y)||last;
                    selected.set(note.id,{note,piece,free:true})
                }
            }
        }
        return [...selected.values()]
    }
    function nativeRange(){const s=getSelection();return s?.rangeCount&&body.contains(s.anchorNode)&&body.contains(s.focusNode)?s.getRangeAt(0):null}
    function activeMixed(){
        if(mixed&&!mixed.collapsed&&body.contains(mixed.startContainer)&&body.contains(mixed.endContainer))return mixed;
        const r=nativeRange();return r&&!r.collapsed&&(cardOf(r.startContainer)!==cardOf(r.endContainer)||selectedRangeNotes(r).length)?r:null
    }
    root._mixedRange=activeMixed;
    // A native same-paragraph range can cover an atomic MathLive wrapper.
    // The browser's plain-text clipboard cannot serialize that formula.
    function clipboardRange(){
        const r=activeMixed();if(r)return r;
        const local=nativeRange(),area=localRangeArea(local);
        return local&&!local.collapsed&&area?.closest('.part-text')&&mathAtomsInRange(local,area).some(atom=>!atom.contains(local.startContainer)||!atom.contains(local.endContainer))?local:null
    }
    const handles=[el('span','rangeHandle rangeStart'),el('span','rangeHandle rangeEnd')];
    for(const h of handles){h.hidden=true;root.append(h);h.setAttribute('aria-hidden','true')}
    // Non-editable prose cannot display a native insertion caret on touch
    // browsers. Paint one from the collapsed DOM range without making the
    // text host editable or focusing an input (which would open the IME).
    const readingCaret=el('span','readingCaret');readingCaret.hidden=true;readingCaret.setAttribute('aria-hidden','true');root.append(readingCaret);
    let readingCaretActive=false;
    function clearReadingCaret(){readingCaretActive=false;readingCaret.hidden=true}
    function syncReadingCaret(r){
        readingCaret.hidden=true;
        if(!readingCaretActive||canEditControl(root)||dialog.open||!r?.collapsed){clearReadingCaret();return}
        const node=r.startContainer,area=(node.nodeType===1?node:node.parentElement)?.closest('.part-text .richText');
        if(!area||!body.contains(area)){clearReadingCaret();return}
        const b=caretBounds(r),pane=root.closest('.pane'),clip=pane?.getBoundingClientRect();
        if(!b||!clip||b.bottom<=clip.top||b.top>=clip.bottom||b.left<clip.left||b.left>clip.right)return;
        readingCaret.style.left=b.left+'px';readingCaret.style.top=b.top+'px';readingCaret.style.height=b.height+'px';readingCaret.hidden=false
    }
    let ownsHighlight=false;
    let touchPressSerial=0,preparedTouchSerial=0,touchTap=null,touchLongPressTimer=0;
    function clearHighlight(){if(ownsHighlight&&window.CSS?.highlights){CSS.highlights.delete('paper-range');CSS.highlights.delete('paper-range-annotation');ownsHighlight=false}}
    let highlightedNotes=[];
    function clearRangeNotes(){for(const chip of highlightedNotes)chip.classList.remove('rangeNoteSelected','rangeAnnotationMathSelected');highlightedNotes=[]}
    let highlightedMath=new Set();
    function syncRangeMath(r){
        const next=new Set();
        if(r&&!r.collapsed)for(const atom of body.querySelectorAll('.inlineMathAtom')){
            if(atom.closest('.visualDocument')!==root||atom.closest('.visualCard.rangeSelected'))continue;
            // The outer prose range selects the atom, not MathLive's internal selection.
            if(atom.contains(r.startContainer)&&atom.contains(r.endContainer))continue;
            const bounds=document.createRange();bounds.selectNode(atom);
            if(r.compareBoundaryPoints(Range.END_TO_START,bounds)<0&&r.compareBoundaryPoints(Range.START_TO_END,bounds)>0)next.add(atom)
        }
        for(const atom of highlightedMath)if(!next.has(atom))atom.classList.remove('rangeMathSelected');
        for(const atom of next)if(!highlightedMath.has(atom))atom.classList.add('rangeMathSelected');
        highlightedMath=next
    }
    function clearMixed(){mixed=null;anchorPoint=focusPoint=null;clearReadingCaret();for(const c of cards())c.classList.remove('rangeSelected');for(const h of handles)h.hidden=true;clearRangeNotes();syncRangeMath(null);clearHighlight()}
    root._clearMixed=clearMixed;
    function syncRange(){
        const cross=mixed&&!mixed.collapsed&&body.contains(mixed.startContainer)&&body.contains(mixed.endContainer)?mixed:null,r=cross||nativeRange(),pieces=selectedPieces(r);
        syncReadingCaret(r);
        for(const c of cards())c.classList.toggle('rangeSelected',cross&&pieces.some(x=>x.card===c&&!x.local));
        syncRangeMath(r);
        clearRangeNotes();
        const ids=new Set(cross?selectedRangeNotes(cross).map(x=>x.note.id):[]);
        if(cross){highlightedNotes=[...(root.closest('.page')||root).querySelectorAll(noteLabelSelector)].filter(chip=>ids.has(chip.dataset.noteId));for(const chip of highlightedNotes)chip.classList.add('rangeNoteSelected')}
        if(cross)for(const {chip,math} of textAnnotationRanges)if(body.contains(chip)&&ids.has(chip.dataset.noteId))for(const atom of math||[]){atom.classList.add('rangeAnnotationMathSelected');highlightedNotes.push(atom)}
        if(cross&&window.CSS?.highlights&&window.Highlight){CSS.highlights.set('paper-range',new Highlight(...pieces.map(x=>x.local).filter(Boolean)));const h=new Highlight(...textAnnotationRanges.filter(x=>body.contains(x.chip)&&ids.has(x.chip.dataset.noteId)).map(x=>x.range));h.priority=1;CSS.highlights.set('paper-range-annotation',h);ownsHighlight=true}else clearHighlight();
        if(!cross||!window.CSS?.highlights||!window.Highlight||!matchMedia('(pointer:coarse)').matches||!r||r.collapsed||!pieces.length){for(const h of handles)h.hidden=true;return}
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
        const hits=document.elementsFromPoint(x,y);
        let card=hits.map(n=>n.closest('.visualCard')).find(c=>c?.parentElement===body);
        if(!card||card.parentElement!==body)card=cards().filter(c=>c.getClientRects().length).sort((a,b)=>{const d=c=>{const r=c.getBoundingClientRect();return Math.max(r.top-y,y-r.bottom,0)};return d(a)-d(b)})[0];
        if(!card)return null;
        if(card._part.kind!=='text')return edge(card,compare(fixed,edge(card,false))<=0);
        const atom=hits.map(n=>n.closest('.inlineMathAtom')||n.closest('.inlineAnnotation,math-field,[data-token]')).find(n=>n&&card.contains(n));
        if(atom){const r=document.createRange();r.selectNode(atom);return compare(fixed,point(r.startContainer,r.startOffset))<=0?point(r.endContainer,r.endOffset):point(r.startContainer,r.startOffset)}
        const area=card.querySelector('.richText'),r=document.caretRangeFromPoint?.(x,y);
        if(r&&area.contains(r.startContainer)&&!(r.startContainer.nodeType===1?r.startContainer:r.startContainer.parentElement)?.closest('math-field,[data-token]'))return point(r.startContainer,r.startOffset);
        const rect=area.getBoundingClientRect();return edge(card,y>rect.top+rect.height/2||x>rect.right)
    }
    function selectionAnchor(){const s=getSelection();return anchorPoint||(s?.anchorNode&&body.contains(s.anchorNode)?point(s.anchorNode,s.anchorOffset):null)}
    // Each paragraph is a separate editing host. Let Chromium handle a local
    // mouse selection until the pointer leaves that host, then extend the
    // same anchor using the logical document range (including atomic cards).
    let suppressDragClick=false;
    function beginMouseRange(e){
        if(e.pointerType!=='mouse'||e.detail>1)return;
        const area=e.target.closest('.part-text .richText'),startCard=e.target.closest('.visualCard');
        if(!startCard||startCard.parentElement!==body)return;
        const chip=e.target.closest('.inlineAnnotation');
        const atomic=chip||(!area&&startCard._part.kind!=='text'&&!e.target.closest('math-field,input,textarea,select,img,.resizeHandle,.visualHandle,button:not(.objectNoteMarker),a,.richText')?startCard:null);
        if(!atomic&&(!area||e.target.closest('math-field,[data-token],img,a,button,input,textarea,.resizeHandle')))return;
        const hit=atomic?null:document.caretRangeFromPoint?.(e.clientX,e.clientY);
        if(!atomic&&(!hit||!area.contains(hit.startContainer)))return;
        const bounds=atomic?document.createRange():null;if(bounds)bounds.selectNode(atomic);
        const lo=bounds?point(bounds.startContainer,bounds.startOffset):point(hit.startContainer,hit.startOffset),hi=bounds?point(bounds.endContainer,bounds.endOffset):lo;
        let a=lo;const start={x:e.clientX,y:e.clientY};
        const scroller=root.closest('.blankNoteDialog .visualDocument,.pane')||root;
        let crossed=false,latest=start,frame=0;
        function update(){
            if(!root.isConnected||!root.contains(a.node))return;
            const rect=scroller.getBoundingClientRect(),x=Math.max(0,Math.min(innerWidth-1,Math.max(rect.left,Math.min(rect.right-1,latest.x)))),y=Math.max(0,Math.min(innerHeight-1,Math.max(rect.top,Math.min(rect.bottom-1,latest.y))));
            const b=pointAt(x,y,a);if(!b)return;
            const sameCard=!atomic&&cardOf(b.node)===startCard;
            const includesNote=sameCard&&selectedRangeNotes(rangeOf(a,b)).length;
            if(!crossed&&sameCard&&!includesNote)return;
            if(atomic){a=compare(b,lo)<0?hi:lo;if(compare(b,a)===0)return}
            crossed=true;dragging=true;
            if(sameCard&&!includesNote){
                // Returning to the original paragraph restores native editing.
                clearMixed();if(canEditControl(root))area.focus({preventScroll:true});
                getSelection().setBaseAndExtent(a.node,a.offset,b.node,b.offset);
                syncRange();scheduleToolbarUpdate();
            }else setRange(a,b)
        }
        function scroll(){
            frame=0;if(!root.isConnected||!root.contains(a.node)){finish();return}
            const r=scroller.getBoundingClientRect(),top=Math.max(r.top,0),bottom=Math.min(r.bottom,innerHeight),margin=28;
            const delta=latest.y<top+margin?-Math.min(22,(top+margin-latest.y)/3):latest.y>bottom-margin?Math.min(22,(latest.y-bottom+margin)/3):0;
            if(delta){const before=scroller.scrollTop;scroller.scrollTop+=delta;if(before!==scroller.scrollTop)update()}
            if(crossed)frame=requestAnimationFrame(scroll)
        }
        function move(ev){
            if(!(ev.buttons&1)||!root.isConnected||!root.contains(a.node)){finish();return}
            latest={x:ev.clientX,y:ev.clientY};
            if(!crossed&&Math.hypot(latest.x-start.x,latest.y-start.y)<4)return;
            update();if(crossed){ev.preventDefault();if(!frame)frame=requestAnimationFrame(scroll)}
        }
        function finish(ev){
            if(ev?.type==='mouseup'&&crossed){latest={x:ev.clientX,y:ev.clientY};update();ev.preventDefault();suppressDragClick=true}
            dragging=false;cancelAnimationFrame(frame);
            document.removeEventListener('mousemove',move,true);document.removeEventListener('mouseup',finish,true);window.removeEventListener('blur',finish);
        }
        document.addEventListener('mousemove',move,true);document.addEventListener('mouseup',finish,true);window.addEventListener('blur',finish);
    }
    root.addEventListener('pointerdown',e=>{
        if(e.target.closest('.rangeHandle'))return;
        suppressDragClick=false;
        const touchProse=e.target.closest('.part-text .richText');
        if(e.pointerType==='touch'&&e.isPrimary&&e.button===0&&!isActionSurface(e.target)&&!e.target.closest('.resizeHandle,.noteResizeHandle')){
            if(touchProse)touchPressSerial++;
            touchTap={id:e.pointerId,x:e.clientX,y:e.clientY,time:Date.now(),moved:false,prose:!!touchProse};
            clearTimeout(touchLongPressTimer);touchLongPressTimer=setTimeout(()=>{if(touchTap?.id===e.pointerId)touchTap.longPress=true},450)
        }
        if(e.button===0&&e.shiftKey){
            let a=selectionAnchor();
            if(!a&&selectedObject){const c=cards().find(c=>c._part===selectedObject);if(c)a=edge(c,e.clientY<c.getBoundingClientRect().top)}
            const b=a&&pointAt(e.clientX,e.clientY,a);
            if(a&&b&&(mixed||cardOf(a.node)!==cardOf(b.node)||selectedRangeNotes(rangeOf(a,b)).length)){e.preventDefault();e.stopImmediatePropagation();setRange(a,b);return}
        }
        if(e.button===0&&e.pointerType!=='touch'){clearMixed();if(!e.shiftKey&&!e.ctrlKey&&!e.metaKey&&!e.altKey)beginMouseRange(e)}
    },true);
    root.addEventListener('pointermove',e=>{if(touchTap?.id===e.pointerId&&Math.hypot(e.clientX-touchTap.x,e.clientY-touchTap.y)>10){touchTap.moved=true;clearTimeout(touchLongPressTimer)}},true);
    root.addEventListener('pointerup',e=>{const t=touchTap;if(!t||e.pointerId!==t.id||!e.isPrimary)return;clearTimeout(touchLongPressTimer);touchTap=null;if(!t.moved&&!t.longPress&&Date.now()-t.time<550)clearMixed()},true);
    root.addEventListener('pointercancel',e=>{if(touchTap?.id===e.pointerId){touchTap=null;clearTimeout(touchLongPressTimer)}},true);
    root.addEventListener('lostpointercapture',e=>{if(touchTap?.id===e.pointerId){touchTap=null;clearTimeout(touchLongPressTimer)}},true);
    root.addEventListener('selectstart',e=>{if(touchTap?.prose&&touchTap.longPress&&!touchTap.moved&&window.CSS?.highlights&&window.Highlight&&e.cancelable)e.preventDefault()},true);
    root.addEventListener('click',e=>{if(suppressDragClick||(e.shiftKey&&activeMixed())){suppressDragClick=false;e.preventDefault();e.stopImmediatePropagation()}},true);
    root.addEventListener('click',e=>{
        if(canEditControl(root)||!touchContextEvent(e)||e.target.closest('math-field,[data-token],img,a,button,.rangeHandle'))return;
        const area=e.target.closest('.part-text .richText');
        if(!area||!body.contains(area)||!root.closest('.pane:not(.historicalPane)'))return;
        const r=document.caretRangeFromPoint?.(e.clientX,e.clientY);
        if(!r||!area.contains(r.startContainer)||r.startContainer.parentElement?.closest('math-field,[data-token]'))return;
        e.preventDefault();clearMixed();clearObject();clearNoteLabel();
        const s=getSelection();r.collapse(true);s.removeAllRanges();s.addRange(r);
        const hit=textAnnotationAt(e);if(hit){hit.chip._openNote?.();return}
        readingCaretActive=true;syncRange();scheduleToolbarUpdate()
    },true);
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
        if(!e.target.closest('.part-text .richText'))return;
        if(!window.CSS?.highlights||!window.Highlight)return;
        if(preparedTouchSerial===touchPressSerial)return;
        preparedTouchSerial=touchPressSerial;
        // A fresh long press starts from the current prose point, never from a
        // native selection left behind by an earlier tap or gesture.
        clearMixed();getSelection()?.removeAllRanges();
        const r=document.caretRangeFromPoint?.(e.clientX,e.clientY),n=r?.startContainer;
        if(n?.nodeType!==Node.TEXT_NODE||!body.contains(n)||!n.textContent.trim())return;
        const segments=[...new Intl.Segmenter(undefined,{granularity:'word'}).segment(n.textContent)];
        const word=segments.find(x=>x.index<=r.startOffset&&x.index+x.segment.length>r.startOffset&&x.isWordLike);if(!word)return;
        setRange(point(n,word.index),point(n,word.index+word.segment.length))
    };
    function mixedClipboard(r,cut){
        const pieces=selectedPieces(r,true),notes=selectedRangeNotes(r,pieces),map=new Map();
        const raw=pieces.map(p=>[notes.filter(n=>n.highlightOnly&&n.piece===p).map(n=>'[[embed:'+n.note.id+']] ').join('')+p.raw,...notes.filter(n=>n.free&&n.piece===p).map(n=>'[[embed:'+n.note.id+']]')].filter(x=>x.trim()).join('\n\n')).filter(Boolean).join('\n\n');
        return rangeNoteClipboard(cut?raw:remapCopiedObjects(raw,owner,true,map),notes,cut,map)
    }
    function replaceMixed(r,text='',cut=false,allowCaret=false){
        if(!canEditControl(root)||!root.isConnected)return;
        const pieces=selectedPieces(r,true,allowCaret);if(!pieces.length)return;
        const first=pieces[0],last=pieces.at(-1),i=parts.indexOf(first.p),j=parts.indexOf(last.p);if(i<0||j<i)return;
        return annotationEdit(()=>{
        const notes=r.collapsed?[]:selectedRangeNotes(r,pieces);
        const noteIds=new Set(notes.map(n=>n.note.id));
        const stripSelected=raw=>raw?.replace(refPattern(),(m,k,id)=>k==='embed'&&noteIds.has(id)?'':m);
        first.before=stripSelected(first.before);last.after=stripSelected(last.after);
        const prepared=text.trim()?prepareRangePaste(text,owner):'',replacement=prepared?parseParts(prepared):[];
        // A copied inline fragment may begin or end with meaningful spaces.
        if(replacement.length===1&&replacement[0].kind==='text'&&!/[\r\n]/.test(prepared))replacement[0].raw=prepared;
        const pastedEnd=replacement.at(-1),pasteMarker='WBPASTE'+uid().replace(/-/g,'')+'END';
        for(const {note} of notes)clearAnnotationPlacement(note);
        if(first.before?.trim()){
            if(replacement[0]?.kind==='text')replacement[0].raw=first.before+replacement[0].raw;
            else replacement.unshift({kind:'text',raw:first.before})
        }
        const caretPart=pastedEnd?.kind==='text'?pastedEnd:!pastedEnd&&replacement.at(-1)?.kind==='text'?replacement.at(-1):null;
        if(last.after?.trim()){
            if(caretPart)caretPart.raw+=pasteMarker;
            if(replacement.at(-1)?.kind==='text')replacement.at(-1).raw+=last.after;
            else replacement.push({kind:'text',raw:last.after})
        }
        parts.splice(i,j-i+1,...replacement);if(!parts.length)parts=[{kind:'text',raw:''}];
        selectedPart=pastedEnd||parts[Math.min(i,parts.length-1)];clearMixed();getSelection()?.removeAllRanges();draw();
        let caret=null;
        if(caretPart?.raw.includes(pasteMarker)){
            caretPart.raw=caretPart.raw.replace(pasteMarker,'');
            const area=cards().find(c=>c._part===caretPart)?.querySelector('.richText');
            if(area){const walker=document.createTreeWalker(area,NodeFilter.SHOW_TEXT);for(let n=walker.nextNode();n;n=walker.nextNode()){
                const at=n.data.indexOf(pasteMarker);if(at>=0){n.deleteData(at,pasteMarker.length);caret=document.createRange();caret.setStart(n,at);caret.collapse(true);break}
            }}
        }
        flush();
        if(!cut)for(const {note} of notes)if(find(note.id))deleteNode(find(note.id));
        if(root.isConnected){const card=cards().find(c=>c._part===selectedPart),dest=card?.querySelector('.part-text .richText');if(dest){placeIn(dest,!!pastedEnd||!!caretPart&&!last.after?.trim());if(caret){getSelection().removeAllRanges();getSelection().addRange(caret)}if(pastedEnd)centerAfterPaste(dest)}else{root.focus({preventScroll:true});if(pastedEnd&&card)centerAfterPaste(card)}}})
    }
    function mixedMenu(r,e){
        const items=[['剪切',async()=>{if(requireEditMode(root)){await writeEditorClipboard(mixedClipboard(r,true));replaceMixed(r,'',true)}}],['复制',()=>writeEditorClipboard(mixedClipboard(r,false))],['粘贴',async()=>{if(requireEditMode(root)){const t=await readEditorClipboard();if(t!=null){const tex=formulaClipboardLatex(null,t);replaceMixed(r,tex?inlineFormulaSource(tex):t)}}}]];
        const binding=e&&root._rangeAnnotationBinding(r);if(binding)items.push(['新建批注',()=>newAnnotation(binding,e)]);
        return items
    }
    root.addEventListener('contextmenu',e=>{if(touchContextEvent(e)&&e.target.closest('.part-text .richText'))root._prepareTouchRange(e);const r=activeMixed();if(!r)return;e.preventDefault();e.stopImmediatePropagation();const items=modeMenuItems(mixedMenu(r,e),root);if(touchContextEvent(e)){touchMenuAt=Date.now();showFloatingTools(e,items)}else menuAt(e,items)},true);
    for(const type of ['copy','cut','paste'])root.addEventListener(type,e=>{
        const r=clipboardRange();if(!r||!e.clipboardData||e.target.closest('math-field'))return;e.preventDefault();e.stopImmediatePropagation();
        if(type==='paste'){if(canEditControl(root)){const tex=formulaClipboardLatex(e.clipboardData);replaceMixed(r,tex?inlineFormulaSource(tex):e.clipboardData.getData('text/plain'))}return}
        if(type==='cut'&&!canEditControl(root))return;const text=mixedClipboard(r,type==='cut');e.clipboardData.setData('text/plain',text);localClipboard=text;localClipboardPreferred=false;if(type==='cut')replaceMixed(r,'',true)
    },true);
    root.addEventListener('keydown',e=>{
        if(e.isComposing||e.keyCode===229)return;
        if((e.ctrlKey||e.metaKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==='a'){
            // Preserve local selection inside a formula or a native control.
            if(e.composedPath().some(n=>n.matches?.('math-field,input,textarea,select')))return;
            e.preventDefault();e.stopImmediatePropagation();
            const list=cards();
            if(list.length)setRange(edge(list[0],false),edge(list.at(-1),true));
            return
        }
        const r=activeMixed();
        if(r&&(e.ctrlKey||e.metaKey)&&!e.altKey&&!e.shiftKey&&['c','x','v'].includes(e.key.toLowerCase())){
            e.preventDefault();e.stopImmediatePropagation();
            const key=e.key.toLowerCase(),items=mixedMenu(r);
            if(key==='c')items[1][1]();else if(canEditControl(root))items[key==='x'?0:2][1]();
            return
        }
        if(r&&['Delete','Backspace'].includes(e.key)){e.preventDefault();e.stopImmediatePropagation();if(canEditControl(root))replaceMixed(r);return}
        if(r&&e.key==='Escape'){clearMixed();getSelection()?.removeAllRanges();return}
        if(r&&!e.shiftKey&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key)){
            e.preventDefault();e.stopImmediatePropagation();const forward=['ArrowRight','ArrowDown','End'].includes(e.key),p=forward?point(r.endContainer,r.endOffset):point(r.startContainer,r.startOffset),card=cardOf(p.node),area=card?.querySelector('.part-text .richText');
            clearMixed();const s=getSelection();
            if(area?.contains(p.node)){if(canEditControl(root))area.focus({preventScroll:true});s.collapse(p.node,p.offset)}
            else if(card?._part.kind!=='text'&&card){selectObject(card._part,card);root.focus({preventScroll:true})}
            else if(p.node===body){const c=cards()[forward?p.offset-1:p.offset];if(c?._part.kind==='text')placeIn(c.querySelector('.richText'),forward);else if(c){selectObject(c._part,c);root.focus({preventScroll:true})}}
            return
        }
        if(r&&canEditControl(root)&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&e.key.length===1){e.preventDefault();e.stopImmediatePropagation();replaceMixed(r,e.key);return}
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
    root.addEventListener('beforeinput',e=>{if(activeMixed()&&!dragging&&canEditControl(root)&&e.inputType?.startsWith('insert')&&!e.isComposing){e.preventDefault();if(e.inputType==='insertText'&&e.data)replaceMixed(activeMixed(),e.data)}},true);
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
        area.focus({preventScroll:true});const r=document.createRange();r.selectNodeContents(area);r.collapse(!end);
        if(end){
            let node=area;
            while(node.lastChild){
                let last=node.lastChild;
                // Marked adds a formatting newline after the final paragraph;
                // it is not an editable visible caret position.
                while(last.previousSibling&&last.nodeType===Node.TEXT_NODE&&!last.data.trim())last=last.previousSibling;
                if(last.parentElement?.closest('[contenteditable=false],math-field')||last.matches?.('[contenteditable=false],math-field,br,img')){r.setStartAfter(last);node=null;break}
                node=last;
            }
            if(node?.nodeType===Node.TEXT_NODE)r.setStart(node,node.length);
            else if(node&&node!==area)r.setStart(node,node.childNodes.length);
            r.collapse(true)
        }
        const s=getSelection();s.removeAllRanges();s.addRange(r)
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
        const atoms=[...area.querySelectorAll('math-field,[data-token],img')].map(n=>n.closest('.inlineMathAtom')||n);
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
        if(!canEditControl(root)||e.defaultPrevented||e.isComposing||e.keyCode===229)return;
        const inMath=e.composedPath().some(x=>x.tagName==='MATH-FIELD');
        const area=e.target.closest?.('.richText'),inControl=e.target.closest?.('input,textarea,select,button');
        if(e.ctrlKey||e.metaKey||e.altKey||inMath||inControl)return;
        if(!area&&selectedObject&&cards().find(c=>c._part===selectedObject)?._imageKey?.(e)){e.preventDefault();return}
        if(!['Backspace','Delete'].includes(e.key))return;
        if(area){if(deleteInRich(area,e.key==='Delete'))e.preventDefault();return}
        if(selectedObject){
            e.preventDefault();const card=cards().find(c=>c._part===selectedObject);
            if(!card?._deleteSelectedImage?.())removePart(selectedObject)
        }
    });
    // Mobile soft keyboards may send beforeinput without a keydown.
    root.addEventListener('beforeinput',e=>{
        if(!canEditControl(root)||e.defaultPrevented||e.isComposing||!['deleteContentBackward','deleteContentForward'].includes(e.inputType)||e.composedPath().some(x=>x.tagName==='MATH-FIELD'))return;
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
        const ids=new Set(parts.flatMap(p=>[p.id,...(p.kind==='figure'?[...p.raw.matchAll(figureImagePattern())].map((m,i)=>figureImageId(m[3],p.id,i)):[])].filter(Boolean)));
        const raw=rangeNoteClipboardValue(text)?.raw||text;
        const collision=[...raw.matchAll(objectPattern())].some(m=>ids.has(m[2])||(m[1]==='figure'&&[...m[4].matchAll(figureImagePattern())].some((img,i)=>ids.has(figureImageId(img[3],m[2],i)))));
        const p=parseParts(prepareRangePaste(text,owner,collision));if(!p.length)return;
        let i=parts.indexOf(after);if(after?.kind==='text'&&!after.raw.trim()){parts.splice(i,1,...p)}else parts.splice(i<0?parts.length:i+1,0,...p);selectedPart=p.at(-1);draw();flush();
        const card=cards().find(c=>c._part===selectedPart),area=card?.querySelector('.part-text .richText');
        if(area){placeIn(area,true);centerAfterPaste(area)}else if(card){root.focus({preventScroll:true});centerAfterPaste(card)}})
    }
    const imageMarkup=({url,name})=>figureImageMarkup(name.replace(/[\[\]\r\n]/g,''),url,'','subfig-'+uid());
    function pasteSubfigure(text,after){
        const match=text.trim().match(/^:::subfigure\s*\n([\s\S]*?)\n:::\s*$/);
        if(!match)return false;
        const m=[...match[1].matchAll(figureImagePattern())][0];if(!m)return false;
        let id=figureImageId(m[3],'clipboard',0);
        if(occupiedObjectIds().has(id)||parts.some(p=>p.raw.includes('wb-id:'+id)))id='subfig-'+uid();
        const markup=figureImageMarkup(m[1],m[2],m[3],id),card=[...body.children].find(c=>c._part===after);
        if(after?.kind==='figure'&&card?._appendImageMarkup){card._appendImageMarkup([markup]);centerAfterPaste(card)}
        else{const fig='fig-'+uid(),data=m[1]+'\n\n'+markup;add({kind:'figure',id:fig,flags:'',body:data,raw:':::figure '+fig+'\n'+data+'\n:::'},after);centerAfterPaste(cards().find(c=>c._part===selectedPart))}
        return true
    }
    function addImages(images,after=selectedPart,center=false){
        if(!canEditControl(root)||!images.length||!root.isConnected)return;
        const card=[...body.children].find(c=>c._part===after);
        if(after?.kind==='figure'&&card?._appendImages){card._appendImages(images);if(center)centerAfterPaste(card);return}
        const id='fig-'+uid(),data=images[0].name.replace(/[\r\n]/g,' ')+'\n\n'+images.map(imageMarkup).join(' ');
        add({kind:'figure',id,flags:'',body:data,raw:':::figure '+id+'\n'+data+'\n:::'},after);if(center)centerAfterPaste(cards().find(c=>c._part===selectedPart))
    }
    async function uploadImages(files,after=selectedPart,center=false){
        const images=[],workspace=currentWorkspace?.id,queue=files.filter(f=>f?.type?.startsWith('image/'));
        imageUploads++;
        try{
            for(let i=0;i<queue.length;i+=3){
                if(workspace!==currentWorkspace?.id||!root.isConnected)return;
                images.push(...(await Promise.all(queue.slice(i,i+3).map(f=>visualImageUpload(f)))).filter(Boolean))
            }
            if(workspace===currentWorkspace?.id){addImages(images,after,center);if(images.length&&dirty){clearTimeout(timer);timer=setTimeout(save,0)}}
        }finally{imageUploads--;if(syncNeeded||syncSignalPending)scheduleSyncRetry(0)}
    }
    function pasteImage(e,after){
        const items=[...(e.clipboardData?.items||[])].filter(x=>x.kind==='file'&&x.type.startsWith('image/')).map(x=>x.getAsFile()).filter(Boolean);
        const files=items.length?items:[...(e.clipboardData?.files||[])].filter(x=>x.type.startsWith('image/'));
        if(!files.length)return false;e.preventDefault();e.stopImmediatePropagation();uploadImages(files,after,true);return true
    }
    function pasteInline(area,text){
        return annotationEdit(()=>{
        text=prepareAnnotationPaste(text,owner);
        const s=window.getSelection();let r=s?.rangeCount&&area.contains(s.getRangeAt(0).commonAncestorContainer)?s.getRangeAt(0).cloneRange():null;
        if(!r){r=document.createRange();r.selectNodeContents(area);r.collapse(false)}
        const frag=document.createDocumentFragment();let at=0;
        for(const m of text.matchAll(inlineTokenPattern())){
            if(m.index>at)frag.append(document.createTextNode(text.slice(at,m.index)));
            const [,dm,im,bd,bi,kind,id]=m,tex=dm??im??bd??bi;
            if(tex!=null)frag.append(inlineMathAtom(visualMath(tex,false,()=>area.dispatchEvent(new Event('input',{bubbles:true})),internal)));
            else frag.append(visualRef(kind,id,!internal));
            at=m.index+m[0].length
        }
        if(at<text.length)frag.append(document.createTextNode(text.slice(at)));
        const last=frag.lastChild;if(!last)return;
        r.deleteContents();r.insertNode(frag);r.setStartAfter(last);r.collapse(true);s.removeAllRanges();s.addRange(r);area.dispatchEvent(new Event('input',{bubbles:true}));remember();centerAfterPaste(area)})
    }
    function addFormula(area,caret,anchor,standalone=false){
        if(!requireEditMode(root)||!root.isConnected)return;
        clearMixed();clearObject();
        if(!standalone&&area?.isConnected&&root.contains(area)){
            focused=area;selectedPart=area.closest('.visualCard')?._part;selection=caret;
            const field=visualMath('\\square',false,()=>area.dispatchEvent(new Event('input',{bubbles:true})),internal);
            insertInline(inlineMathAtom(field));field.focus();field.executeCommand?.('selectAll');return
        }
        const id='eq-'+uid(),tex='\\square';
        add({kind:'equation',id,flags:'',body:tex,raw:':::equation '+id+'\n'+tex+'\n:::'},anchor);
        cards().find(c=>c._part.id===id)?.querySelector('math-field')?.executeCommand?.('selectAll')
    }
    function pasteFormula(area,tex,anchor){
        if(!canEditControl(root)||!root.isConnected||!tex)return;
        if(!area){insertPaste(formulaObjectSource(tex),anchor);root.focus({preventScroll:true});return}
        annotationEdit(()=>{
            const s=getSelection(),r=s?.rangeCount&&area.contains(s.getRangeAt(0).commonAncestorContainer)?s.getRangeAt(0).cloneRange():document.createRange();
            if(!area.contains(r.commonAncestorContainer)){r.selectNodeContents(area);r.collapse(false)}
            const field=visualMath(tex.replace(/\r?\n/g,' '),false,()=>area.dispatchEvent(new Event('input',{bubbles:true})),internal);
            const atom=inlineMathAtom(field);
            area.focus({preventScroll:true});r.deleteContents();r.insertNode(atom);r.setStartAfter(atom);r.collapse(true);
            s.removeAllRanges();s.addRange(r);area.dispatchEvent(new Event('input',{bubbles:true}));remember();centerAfterPaste(area)
        })
    }
    function insertMenu(){return internal?[]:[
        ['插入交叉引用',()=>visualPick(s=>{const m=[...s.matchAll(refPattern())][0];if(m)insertInline(visualRef(m[1],m[2]))})]
    ]}
    root._contentInsertMenu=e=>{
        const cards=[...body.children],clicked=e.target.closest('.visualCard'),area=e.target.closest('.richText');
        const card=clicked&&body.contains(clicked)?clicked:cards.filter(c=>c.getBoundingClientRect().top<=e.clientY).at(-1)||cards[0];
        const anchor=card?._part||parts.at(-1);
        const range=activeMixed()||(getSelection()?.rangeCount?getSelection().getRangeAt(0):null);
        const caret=area&&range&&area.contains(range.commonAncestorContainer)?range.cloneRange():null;
        const hit=!e.useCurrentSelection&&area&&document.caretRangeFromPoint?.(e.clientX,e.clientY);
        const position=caret&&!caret.collapsed?caret:hit&&area.contains(hit.startContainer)&&!hit.startContainer.parentElement?.closest('math-field')?hit:caret;
        const formulas=e.target.closest('math-field')?[]:[
            ['添加公式',()=>addFormula(area,position,anchor)],
            ...(area?[['添加独立公式',()=>addFormula(null,null,anchor,true)]]:[])
        ];
        return [...formulas,...insertMenu().map(([name,action])=>[name,()=>{
            clearMixed();
            selectedPart=anchor;focused=area&&root.contains(area)?area:null;selection=focused?caret:null;
            action()
        }])]
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
        try{const r=range.cloneRange();r.collapse(true);const chip=visualRef('embed',id);r.insertNode(chip);const p=area.closest('.visualCard')?._part;if(!p||p.kind!=='text'){chip.remove();return false}p.raw=richMarkdown(area);flush();return true}catch(err){console.warn(err);return false}
    };
    context(root,e=>root._blankMenu(e));
    function bindRich(area,p){
        area.addEventListener('focusin',()=>{focused=area;selectedPart=p;clearObject()});
        area.addEventListener('keyup',remember);area.addEventListener('pointerup',remember);
        area.addEventListener('paste',e=>{if(e.target.closest('math-field'))return;const text=e.clipboardData?.getData('text/plain')||'';
            const tex=formulaClipboardLatex(e.clipboardData,text);
            if(tex){e.preventDefault();e.stopImmediatePropagation();pasteFormula(area,tex,p);return}
            if(pasteSubfigure(text,p)){e.preventDefault();e.stopImmediatePropagation();return}
            if(pasteImage(e,p))return;
            if(rangeNoteClipboardValue(text)){e.preventDefault();e.stopImmediatePropagation();insertPaste(text,p);return}
            if(annotationClipboardValue(text)){e.preventDefault();e.stopImmediatePropagation();if(internal)insertPaste(text,p);else pasteInline(area,text);return}
            const label=text.trim().match(/^\[\[embed:([^\]\n]+)\]\]$/);
            if(label&&find(label[1])&&label[1]!==owner){e.preventDefault();e.stopImmediatePropagation();pasteInline(area,label[0]);return}
            if(/(^:::(equation|figure|table)\s|^\s*\[\[embed:[^\]\n]+\]\]\s*$)/m.test(text)||(internal&&figureImagePattern().test(text))){e.preventDefault();e.stopImmediatePropagation();insertPaste(text,p);return}
            if(/\[\[(ref|eqref|cite):[^\]\n]+\]\]/.test(text)&&!/\[\[embed:/.test(text)){e.preventDefault();e.stopImmediatePropagation();pasteInline(area,text);return}
            if(/\[\[embed:/.test(text)){e.preventDefault();e.stopImmediatePropagation();insertPaste(text,p);return}
            if(/(?<!\\)\$\$[\s\S]+?\$\$|(?<!\\)\$[^\n$]+?\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)/.test(text)){
                e.preventDefault();e.stopImmediatePropagation();
                const s=getSelection(),r=s?.rangeCount&&area.contains(s.getRangeAt(0).commonAncestorContainer)?s.getRangeAt(0).cloneRange():document.createRange();
                if(!area.contains(r.commonAncestorContainer)){r.selectNodeContents(area);r.collapse(false)}
                replaceMixed(r,text,false,true)
            }
        },true)
        area.addEventListener('copy',e=>{if(e.target.closest('math-field'))return;const s=window.getSelection();if(!s?.rangeCount||s.isCollapsed||!area.contains(s.getRangeAt(0).commonAncestorContainer))return;const clone=s.getRangeAt(0).cloneContents();if(!clone.querySelector('[data-token],math-field'))return;const holder=el('div');holder.append(clone);e.clipboardData.setData('text/plain',richMarkdown(holder));e.preventDefault()});
    }
    function objectRaw(p,edit=null){p.raw=':::'+p.kind+' '+p.id+(p.flags?' '+p.flags:'')+'\n'+p.body+'\n:::';flush(edit)}
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
                const area=visualRich(p.raw,edit=>{p.raw=richMarkdown(area);flush(edit)},false,!internal);bindRich(area,p);content.append(area)
            }else if(p.kind==='equation'){
                const field=visualMath(p.body.trim(),true,value=>{p.body=value;objectRaw(p)},internal);content.append(field);
                field.addEventListener('focusin',()=>{clearMixed();clearObject();selectedPart=p});
                extra=[['公式输入工具',()=>{field.focus();showMathPalette(field)}],['数学键盘',()=>{field.focus();window.mathVirtualKeyboard?.show()}],['复制公式',()=>copy(p.body)]]
            }else if(p.kind==='figure'){
                const lines=p.body.split('\n'),caption=lines.shift()||'',rest=lines.join('\n').trim();
                const cap=visualRich(caption,edit=>{p.body=richMarkdown(cap).replace(/\n+/g,' ')+'\n\n'+imageSource;objectRaw(p,edit)},true,!internal);
                let imageSource=normalizeFigureImages(rest,p.id);
                const imgs=el('div','visualImages');
                const imageId=mark=>[...mark.matchAll(figureImagePattern())][0][3].match(/(?:^|\s)wb-id:([^\s"]+)/)[1];
                function saveImages(){p.body=richMarkdown(cap).replace(/\n+/g,' ')+'\n\n'+imageSource;objectRaw(p)}
                function updateRows(rows,selectId=null,focusSlot=null){
                    imageSource=rows.filter(r=>r.length).map(r=>r.join(' ')).join('\n\n');
                    saveImages();clearObject();displayImages();
                    if(selectId){const w=[...imgs.querySelectorAll('.resizeImage')].find(w=>w.dataset.subfigure===selectId);if(w)card._selectImage(w)}
                    if(focusSlot)imgs.querySelector(focusSlot)?.focus({preventScroll:true});
                    else if(!selectId)root.focus({preventScroll:true})
                }
                function splitRow(r,i){
                    const rows=figureImageRows(imageSource);if(!canEditControl(root)||!rows||i<=0||i>=rows[r]?.length)return;
                    rows.splice(r,1,rows[r].slice(0,i),rows[r].slice(i));updateRows(rows,null,'.figureRowBreak[data-row="'+r+'"]')
                }
                function joinRows(r){
                    const rows=figureImageRows(imageSource);if(!canEditControl(root)||!rows?.[r+1])return;
                    const i=rows[r].length;rows.splice(r,2,[...rows[r],...rows[r+1]]);updateRows(rows,null,'.figureImageGap[data-row="'+r+'"][data-slot="'+i+'"]')
                }
                function slotButton(cls,r,i,label,action){
                    const b=el('button',cls);b.type='button';b.dataset.row=r;b.dataset.slot=i;b.title=label;b.setAttribute('aria-label',label);
                    b.addEventListener('pointerdown',e=>{e.stopPropagation();clearObject();clearMixed()});
                    b.addEventListener('focus',()=>{clearObject();clearMixed()});
                    b.addEventListener('click',e=>{e.stopPropagation();if(!canEditControl(root))return;if(b._armed)action();else{b._armed=true;b.focus({preventScroll:true})}});
                    b.addEventListener('blur',()=>{b._armed=false});
                    b.addEventListener('keydown',e=>{
                        if(!canEditControl(root))return;
                        if(cls==='figureRowBreak'?['Backspace','Delete'].includes(e.key):e.key==='Enter'){e.preventDefault();e.stopPropagation();action()}
                    });
                    return b
                }
                function dragImage(e,wrap,handle){
                    if(e.button!==0||!canEditControl(root)||(!handle&&e.pointerType==='touch'))return;
                    const id=wrap.dataset.subfigure,startX=e.clientX,startY=e.clientY;
                    let moved=false,target=null;
                    const dragTarget=e.currentTarget,marker=el('div','figureDropMarker');
                    function move(ev){
                        if(!moved&&Math.hypot(ev.clientX-startX,ev.clientY-startY)<6)return;
                        if(!moved){moved=true;card._selectImage(wrap);wrap.classList.add('figureDragging');imgs.append(marker);dragTarget.setPointerCapture?.(e.pointerId)}
                        ev.preventDefault();const rect=imgs.getBoundingClientRect(),rowEls=[...imgs.querySelectorAll(':scope > .figureImageRow')];
                        if(ev.clientX<rect.left-24||ev.clientX>rect.right+24||ev.clientY<rect.top-28||ev.clientY>rect.bottom+28){target=null;marker.hidden=true;return}
                        marker.hidden=false;
                        const rowIndex=rowEls.findIndex(row=>{const b=row.getBoundingClientRect();return ev.clientY>=b.top&&ev.clientY<=b.bottom});
                        if(rowIndex<0){
                            let i=rowEls.findIndex(row=>ev.clientY<row.getBoundingClientRect().top);if(i<0)i=rowEls.length;
                            const y=i===0?rowEls[0].getBoundingClientRect().top:i===rowEls.length?rowEls.at(-1).getBoundingClientRect().bottom:(rowEls[i-1].getBoundingClientRect().bottom+rowEls[i].getBoundingClientRect().top)/2;
                            target={newRow:i};Object.assign(marker.style,{left:'0px',top:(y-rect.top)+'px',width:'100%',height:'3px'});return
                        }
                        const row=rowEls[rowIndex],items=[...row.querySelectorAll(':scope > .resizeImage')],rb=row.getBoundingClientRect();
                        let i=items.findIndex(w=>{const b=w.getBoundingClientRect();return ev.clientX<b.left+b.width/2});if(i<0)i=items.length;
                        const x=i===items.length?items.at(-1).getBoundingClientRect().right:items[i].getBoundingClientRect().left;
                        target={row:rowIndex,index:i};Object.assign(marker.style,{left:(x-rect.left)+'px',top:(rb.top-rect.top)+'px',width:'3px',height:rb.height+'px'})
                    }
                    function finish(ev){
                        document.removeEventListener('pointermove',move,true);document.removeEventListener('pointerup',finish,true);document.removeEventListener('pointercancel',finish,true);
                        marker.remove();wrap.classList.remove('figureDragging');
                        if(!moved||ev.type==='pointercancel'||!target||!canEditControl(root))return;
                        const rows=figureImageRows(imageSource),r=rows?.findIndex(row=>row.some(m=>imageId(m)===id));if(r==null||r<0)return;
                        const i=rows[r].findIndex(m=>imageId(m)===id),mark=rows[r].splice(i,1)[0];
                        if(target.newRow!=null)rows.splice(target.newRow,0,[mark]);
                        else rows[target.row].splice(target.row===r&&target.index>i?target.index-1:target.index,0,mark);
                        updateRows(rows,id)
                    }
                    document.addEventListener('pointermove',move,{capture:true,passive:false});document.addEventListener('pointerup',finish,true);document.addEventListener('pointercancel',finish,true)
                }
                function displayImages(){
                    imgs.replaceChildren();
                    const rows=figureImageRows(imageSource),resize=(src,w,index,widths)=>{
                        const changed=new Map(widths||[[index,w]]);let i=-1;
                        imageSource=imageSource.replace(figureImagePattern(),(m,alt,url,title)=>{i++;return changed.has(i)?figureImageMarkup(alt,url,(title||'').replace(/(?:^|\s)wb-width:[^\s"]+/g,'')+' wb-width:'+changed.get(i),figureImageId(title,p.id,i)):m});
                        saveImages()
                    };
                    if(rows){
                        imgs.classList.add('figureImageRows');let offset=0;
                        rows.forEach((marks,r)=>{
                            const row=el('div','figureImageRow'),tmp=el('div'),base=offset;
                            markdown(marks.join(' '),tmp,[owner].filter(Boolean),(src,w,i,widths)=>resize(src,w,base+i,widths));
                            const wraps=[...tmp.querySelectorAll('.resizeImage')];
                            const widths=figureRowWidths(wraps.map(w=>w._getImageWidth()));
                            figureRowGapStyle(row,wraps.length);
                            wraps.forEach((wrap,i)=>{
                                row.append(wrap);wrap.dataset.row=r;wrap.dataset.slot=i;
                                wrap._figureSourceWidth=wrap._getImageWidth();wrap._setImageWidth(widths[i]);
                                if(i>0)wrap.append(slotButton('figureImageGap',r,i,'\u63d2\u5165\u6362\u884c (Enter)',()=>splitRow(r,i)));
                                const handle=el('button','figureDragHandle','\u283f');handle.type='button';handle.title='\u62d6\u52a8\u56fe\u7247';handle.setAttribute('aria-label',handle.title);
                                handle.addEventListener('pointerdown',e=>{e.stopPropagation();e.preventDefault();dragImage(e,wrap,true)});
                                wrap.append(handle);wrap.querySelector('img').addEventListener('pointerdown',e=>dragImage(e,wrap,false))
                            });
                            imgs.append(row);offset+=marks.length;
                            if(r<rows.length-1){const b=slotButton('figureRowBreak',r,0,'\u5220\u9664\u6362\u884c (Backspace / Delete)',()=>joinRows(r));b.textContent='\u21b5';imgs.append(b)}
                        })
                    }else{imgs.classList.remove('figureImageRows');markdown(imageSource,imgs,[owner].filter(Boolean),resize)}
                    const records=[...imageSource.matchAll(figureImagePattern())];
                    [...imgs.querySelectorAll('.resizeImage')].forEach((wrap,i)=>{
                        const m=records[i];if(!m)return;
                        wrap.dataset.imageIndex=i;
                        const id=figureImageId(m[3],p.id,i);wrap.dataset.object=id;wrap.dataset.subfigure=id;wrap.title=internal?(m[1]||'图片'):'子图 '+(resolve(id)?.number||subfigureLetter(i));
                        wrap.addEventListener('contextmenu',()=>card._selectImage(wrap),true)
                    });
                    if(!imgs.querySelector('img'))imgs.append(btn('添加图片',()=>chooseImages(p),'emptyFigureAdd'));
                    refreshObjectAnnotations(card)
                }
                card._appendImageMarkup=markups=>{
                    const rows=figureImageRows(imageSource);
                    if(rows){
                        const selected=imgs.querySelector('.selectedImage'),r=selected?Number(selected.dataset.row):rows.length-1,i=selected?Number(selected.dataset.slot)+1:rows[r]?.length||0;
                        if(rows[r])rows[r].splice(i,0,...markups);else rows.push(markups);
                        updateRows(rows)
                    }else{imageSource=[imageSource,...markups].filter(Boolean).join('\n\n');saveImages();displayImages()}
                };
                card._imageKey=e=>{
                    const wrap=imgs.querySelector('.selectedImage'),rows=figureImageRows(imageSource);if(!wrap||!rows)return false;
                    const r=Number(wrap.dataset.row),i=Number(wrap.dataset.slot),before=e.key==='ArrowLeft',after=e.key==='ArrowRight';
                    if(e.key==='Enter'&&i+1<rows[r].length){splitRow(r,i+1);return true}
                    if(before||after){
                        const slot=before?i:i+1,selector=slot>0&&slot<rows[r].length?'.figureImageGap[data-row="'+r+'"][data-slot="'+slot+'"]':'.figureRowBreak[data-row="'+(before?r-1:r)+'"]';
                        const b=imgs.querySelector(selector);if(b){b.focus({preventScroll:true});return true}
                    }
                    return false
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
                    const rows=figureImageRows(imageSource),wrap=wrappers[index];
                    if(rows){rows[Number(wrap.dataset.row)].splice(Number(wrap.dataset.slot),1);updateRows(rows);return true}
                    let i=-1;imageSource=imageSource.replace(figureImagePattern(),m=>++i===index?'':m).trim();
                    p.body=p.body.split('\n')[0]+'\n\n'+imageSource;objectRaw(p);displayImages();clearObject();root.focus({preventScroll:true});return true
                };
                bindRich(cap,p);content.append(imgs,cap);
                extra=[['添加图片',()=>chooseImages(p)]];
                displayImages()
            }else if(p.kind==='table'){
                const lines=p.body.split('\n'),caption=lines.shift()||'',rest=lines.join('\n').trim();
                const cap=visualRich(caption,edit=>commitTable(edit),true,!internal);const wrap=el('div','tablescroll');const table=el('table','visualTable');wrap.append(table);
                let rows=rest.split('\n').filter(s=>s.trim().startsWith('|')).map(s=>s.trim().replace(/^\||\|$/g,'').split(/(?<!\\)\|/).map(x=>x.trim()));if(rows.length>1&&rows[1].every(x=>/^:?-+:?$/.test(x)))rows.splice(1,1);
                if(!rows.length){rows=[['项目','数值'],['','']];content.append(el('p','muted','原表格存在复杂内容，未修改时保持原始数据；如需改表请核对预览。'))}
                const cols=Math.max(1,...rows.map(x=>x.length));rows=rows.map(r=>Array.from({length:cols},(_,i)=>r[i]||''));
                function commitTable(edit=null){p.body=richMarkdown(cap).replace(/\n+/g,' ')+'\n\n'+[rows[0],rows[0].map(()=> '---'),...rows.slice(1)].map(r=>'| '+r.map(x=>x.replace(/\n+/g,' ').replace(/(?<!\\)\|/g,'\\|')).join(' | ')+' |').join('\n');objectRaw(p,edit)}
                function tableDraw(){table.replaceChildren();rows.forEach((row,i)=>{const tr=el('tr');row.forEach((value,j)=>{const td=el(i===0?'th':'td');const cell=visualRich(value,edit=>{rows[i][j]=richMarkdown(cell);commitTable(edit)},true,!internal);bindRich(cell,p);td.append(cell);tr.append(td)});table.append(tr)})}
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
        return {text,remove:()=>{if(!canEditControl(root)||!root.isConnected||!parts.includes(p))return;if(!image||!card._deleteSelectedImage?.())removePart(p)}};
    }
    function objectClipboard(e,cut){
        if(cut&&!canEditControl(root)){e.preventDefault();return}
        if(!selectedObject||e.target.closest('.richText,math-field,input,textarea')||!e.clipboardData)return;
        const p=selectedObject,card=[...body.children].find(c=>c._part===p);if(!card)return;
        const data=objectClipboardData(p,card,cut);
        e.clipboardData.setData('text/plain',data.text);localClipboard=data.text;localClipboardPreferred=false;e.preventDefault();e.stopPropagation();
        if(cut){data.remove();showToast('已剪切，粘贴将保留原引用')}
        else showToast('已复制，粘贴将生成新 ID')
    }
    root._clipboardMenu=e=>{
        const multi=clipboardRange();if(multi)return mixedMenu(multi,localRangeArea(multi)?null:e);
        const card=e.target.closest('.visualCard'),p=card?._part||(e.target===root&&Number.isFinite(e.clientY)?cards().filter(c=>c.getBoundingClientRect().top<=e.clientY).at(-1)?._part||parts[0]:selectedPart);
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
            if(cut&&!requireEditMode(root))return;
            if(object){const data=objectClipboardData(p,card,cut);await writeEditorClipboard(data.text);if(cut)data.remove();return}
            if(math){const value=math.selectionIsCollapsed?math.value:math.getValue(math.selection,'latex');if(!value||cut&&math.selectionIsCollapsed)return;await writeEditorClipboard(formulaClipboardText(value));if(cut&&canEditControl(root)&&math.isConnected){math.executeCommand?.('deleteBackward');math.dispatchEvent(new Event('input',{bubbles:true}))}return}
            if(!selected)return;await writeEditorClipboard(text());if(cut&&canEditControl(root)&&restore()){document.execCommand('delete');area.dispatchEvent(new Event('input',{bubbles:true}))}
        };
        const paste=async()=>{
            if(!requireEditMode(root))return;
            const value=await readEditorClipboard();if(!canEditControl(root)||!root.isConnected)return;
            if(!value){
                if(!math&&!localClipboardPreferred)try{
                    const items=await navigator.clipboard.read(),files=[];
                    for(const item of items){const type=item.types.find(t=>['image/png','image/jpeg','image/webp','image/gif'].includes(t));if(type)files.push(new File([await item.getType(type)],'clipboard.'+type.split('/')[1],{type}))}
                    if(files.length){await uploadImages(files,p,true);return}
                }catch{}
                if(value==null)showToast('无法读取剪贴板，请使用系统粘贴');return
            }
            const tex=formulaClipboardLatex(null,value);
            if(math?.isConnected){math.focus();math.insert(tex||value,{insertionMode:'replaceSelection',...(tex?{format:'latex'}:{})});math.dispatchEvent(new Event('input',{bubbles:true}));centerAfterPaste(math);return}
            if(area&&restore()){
                // Reuse the normal paste handlers, including object/ref parsing.
                const data=new DataTransfer();data.setData('text/plain',value);
                area.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));return
            }
            if(tex){pasteFormula(null,tex,p);return}
            if(!pasteSubfigure(value,p))insertPaste(value,p)
        };
        return [['剪切',()=>copyOrCut(true),!object&&!selected&&!(math&&!math.selectionIsCollapsed)],['复制',()=>copyOrCut(false),!object&&!selected&&!math],['粘贴',paste]]
    };
    root.addEventListener('copy',e=>objectClipboard(e,false));
    root.addEventListener('cut',e=>objectClipboard(e,true));
    root.addEventListener('paste',e=>{if(e.defaultPrevented||e.target.closest('math-field'))return;if(pasteImage(e,selectedPart))return;if(!e.target.closest('[contenteditable=true],input,textarea')){const tex=formulaClipboardLatex(e.clipboardData);if(tex){e.preventDefault();pasteFormula(null,tex,selectedPart);return}const text=e.clipboardData?.getData('text/plain');if(text){e.preventDefault();if(!pasteSubfigure(text,selectedPart))insertPaste(text,selectedPart)}}});
    root.addEventListener('click',e=>{if(!e.target.closest('.richText,math-field,input,textarea,button,summary,a,img,.resizeHandle,.visualRef')){selectedPart=e.target.closest('.visualCard')?._part||selectedPart;root.focus({preventScroll:true})}});
    root.tabIndex=0;draw();
    return {root,getValue:value};
}
document.addEventListener('pointerdown',e=>{if(isActionSurface(e.target)||e.pointerType==='touch')return;for(const root of document.querySelectorAll('.visualDocument'))if(!root.contains(e.target)){root._clearObject?.();root._clearMixed?.()}},true);
document.addEventListener('click',e=>{if(e.pointerType!=='touch'||isActionSurface(e.target)||e.target.closest('.rangeHandle')||Date.now()-touchMenuAt<500)return;for(const root of document.querySelectorAll('.visualDocument'))if(!root.contains(e.target)){root._clearObject?.();root._clearMixed?.()}},true);
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
    const doc=visualDocument(n.body,(s,edit)=>{if(s===n.body)return;checkpoint(edit);n.body=s;if(isBlock)n.title=blockLabel(s);change(false);if(isBlock)renderNav();for(const card of doc.root.querySelectorAll('.visualCard')){const p=card._part;if(p?.id){const label=card.querySelector('.visualNum');if(label)label.textContent=resolve(p.id)?.number||''}}},n.id,pi);
    title.addEventListener('input',e=>{if(!editingEnabled)return;const t=title.value.trim();if(t===n.title)return;checkpoint(typingEdit(e,title));n.title=t;change(false);renderNav();if(summary)summary.querySelector('.childCollapsedTitle').textContent=label(n)});
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
        textAnnotationRanges=[];
        for(const chip of paneBox.querySelectorAll('.richText .inlineAnnotation')){
            const doc=chip.closest('.visualDocument'),owner=doc?._owner,id=chip.dataset.token?.slice(8,-2),note=find(id);
            if(!owner||!note)continue;
            const bindings=[note.annotation,...(note.textBindings||[])].filter(a=>a?.owner===owner&&(a.quote||a.mathQuote||a.segments?.some(s=>s.mathQuote))).sort((a,b)=>(b.quote||'').length-(a.quote||'').length);
            const firstArea=chip.closest('.richText'),cards=[...doc.querySelector(':scope > .visualBody').children],start=cards.indexOf(chip.closest('.visualCard'));
            function matchQuote(area,quote,marker,mathQuote){
                if(!area||!(quote||mathQuote))return null;
                const range=document.createRange();if(marker)range.setStartAfter(marker);else range.setStart(area,0);range.setEnd(area,area.childNodes.length);
                if(mathQuote){
                    const walker=document.createTreeWalker(area,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT);let length=0;
                    for(let n=walker.nextNode();n;n=walker.nextNode()){
                        if(marker&&(marker.contains(n)||!(marker.compareDocumentPosition(n)&Node.DOCUMENT_POSITION_FOLLOWING)))continue;
                        const atom=(n.nodeType===1?n:n.parentElement)?.closest('.inlineMathAtom');
                        if(atom&&atom!==n)continue;
                        if(!atom&&n.nodeType!==Node.TEXT_NODE)continue;
                        const value=atom?annotationMathToken(atom):n.textContent,remaining=mathQuote.slice(length);
                        if(atom){if(!remaining.startsWith(value))return null;length+=value.length;if(length===mathQuote.length){range.setEndAfter(atom);return range}}
                        else if(value.startsWith(remaining)){range.setEnd(n,remaining.length);return range}
                        else {if(!remaining.startsWith(value))return null;length+=value.length}
                    }
                    return null
                }
                if(!range.toString().startsWith(quote))return null;
                const walker=document.createTreeWalker(area,NodeFilter.SHOW_TEXT);let length=0;
                for(let n=walker.nextNode();n;n=walker.nextNode()){
                    if(marker&&(marker.contains(n)||!(marker.compareDocumentPosition(n)&Node.DOCUMENT_POSITION_FOLLOWING)))continue;
                    if(length+n.length>=quote.length){range.setEnd(n,quote.length-length);return range.toString()===quote?range:null}
                    length+=n.length;
                }
                return null
            }
            for(const binding of bindings){
                const segments=Array.isArray(binding.segments)&&binding.segments.length?binding.segments:[{partOffset:0,quote:binding.quote,mathQuote:binding.mathQuote}];
                if(segments[0].partOffset!==0)continue;
                const matched=segments.map(({partOffset,quote,mathQuote})=>matchQuote(partOffset===0?firstArea:cards[start+partOffset]?.querySelector('.part-text .richText'),quote,partOffset===0?chip:null,mathQuote));
                // Do not paint a partial or unrelated quote when its text has changed.
                if(matched.some(r=>!r))continue;
                for(const range of matched){const area=(range.startContainer.nodeType===1?range.startContainer:range.startContainer.parentElement).closest('.richText');ranges.push(range);textAnnotationRanges.push({chip,range,math:mathAtomsInRange(range,area)})}break
            }
        }
        const highlight=new Highlight(...ranges);highlight.priority=-1;CSS.highlights.set('paper-annotation',highlight);syncNoteSelection();
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
    if(dialog.open&&dialog._noteId===n.id)return;
    const owner=chip.closest('.visualDocument')?._owner,pane=chip.closest('.pane');
    const anchorRect=()=>{
        if(freePlacement)return freeNoteAnchor(freePlacement,pane);
        if(objectBinding)return objectNoteAnchor(objectBinding.targetId,pane);
        let a=chip.isConnected?chip:null;
        if(!a){const matches=[...paneBox.querySelectorAll('.inlineAnnotation')].filter(x=>x.dataset.token==='[[embed:'+n.id+']]');a=matches.find(x=>x.closest('.pane')===pane)||matches.find(x=>x.closest('.visualDocument')?._owner===owner)||matches[0]}
        return a?.getBoundingClientRect()||null
    };
    const d=showDialog('',{floating:true,x:e.clientX,y:e.clientY,anchorRect,relativeOffset:freePlacement?.floatOffset||objectBinding?.floatOffset||n.annotation?.floatOffset,onPositionChange:offset=>{if(freePlacement){freePlacement.floatOffset=offset;change(false)}else if(objectBinding){objectBinding.floatOffset=offset;change(false)}else if(n.annotation){n.annotation.floatOffset=offset;change(false)}}});
    dialog.classList.add('blankNoteDialog');
    dialog._noteId=n.id;
    const doc=visualDocument(n.body,()=>{},n.id),initial=doc.getValue();
    dialog._noteValue=()=>doc.getValue();
    dialog._commitNote=()=>{
        const value=doc.getValue();dialog.close();
        if(value!==initial){checkpoint();n.body=value;n.title=blockLabel(value);change(false);renderNav()}
    };
    d.append(doc.root);setupNoteResize(d,n.floatSize,size=>{n.floatSize=size;change(false)});
    const handle=d.querySelector('h2');handle.classList.add('noteWindowHandle');handle.setAttribute('aria-label','选中批注浮窗');
    setupNoteLabel(handle,n.id,()=>{doc.root.querySelector('.richText,math-field')?.focus({preventScroll:true})},chip._detachNote?()=>{closeWorkbenchDialog();if(chip.isConnected)chip._detachNote()}:null,true);
    selectNoteLabel(handle);
}
function newNode(space,parent=null,body='',title='',onCreated=null,options={}){
    if(space!=='blocks'&&!requireEditMode())return;
    if(!dialog.open&&panes[active]?.history)return;
    if(space==='blocks'){
        const d=showDialog('',{...options,floating:true});dialog.classList.add('blankNoteDialog');
        const doc=visualDocument(remapCopiedObjects(body),()=>{},null);
        dialog._commitNote=()=>annotationEdit(()=>{
            const value=remapCopiedObjects(doc.getValue());if(!value.trim()){dialog.close();return}
            checkpoint();const id='block-'+uid(),n={id,title:blockLabel(value),parent,level:parent?ancestors(find(parent)).length+2:1,number:'',file:'blocks/'+id+'.md',source:'',order:db.blocks.length,body:value};
            if(options.binding?.mode==='object')n.objectBindings=[{targetId:options.binding.targetId,floatOffset:{...(dialog._relativeOffset||{x:14,y:8})}}];
            else if(options.binding)n.annotation={owner:options.binding.owner.id,mode:options.binding.mode,quote:options.binding.quote,...(options.binding.segments?{segments:options.binding.segments}:{}),...(options.binding.mathQuote?{mathQuote:options.binding.mathQuote}:{}),floatOffset:{...(dialog._relativeOffset||{x:14,y:8})}};
            else if(options.freePlacement)n.freePlacements=[{...options.freePlacement,floatOffset:{...(dialog._relativeOffset||{x:14,y:8})}}];
            if(dialog._noteSize)n.floatSize={...dialog._noteSize};
            db.blocks.push(n);normalizeOrder(space);dialog.close();change(false);if(onCreated){onCreated(id);renderNav()}else{select(id);renderPanes()}
        });
        d.append(doc.root);setupNoteResize(d);requestAnimationFrame(()=>doc.root.querySelector('.richText')?.focus());return
    }
    createEmptyThesis(parent)
};

