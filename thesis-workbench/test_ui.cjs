// Isolated browser regression tests: example.json is read only, saves are mocked.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const data=JSON.parse(execFileSync('python',['-c',
    "import server,json,base64;from workspace import Package;server.PACKAGE=Package('example.json');s=server.state();s.update(workspace={'id':'test','name':'example.json'},originalLabels={},importReport={});print(json.dumps({'state':s,'image':base64.b64encode(server.PACKAGE.read('assets/demo.png')).decode()}))"
],{cwd:__dirname,encoding:'utf8'}));
const origin='http://127.0.0.1:18761';
async function fixture(browser,mobile=false,shared=null,legacy=null){
    const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},hasTouch:mobile,isMobile:mobile,permissions:['clipboard-read','clipboard-write']});
    const p=await context.newPage(),errors=[];
    let ownState=structuredClone(data.state),rev=0;
    const shortcutStore=shared||{};
    if(legacy)await context.addInitScript(values=>{if(!localStorage.getItem('wb:tool-shortcuts:v2'))localStorage.setItem('wb:tool-shortcuts:v2',JSON.stringify(values))},legacy);
    function currentState(){return shared?{...(shared.state||data.state),workspace:shared.workspace,readingPosition:shared.reading[shared.workspace.id]||null}:ownState}
    p.setDefaultTimeout(12000);
    p.on('pageerror',e=>errors.push(e.message));
    p.on('dialog',d=>{if(d.type()!=='beforeunload'&&!(shared?.allowRestore&&d.message().startsWith('恢复此')))errors.push('Unexpected dialog: '+d.message());d.accept()});
    await p.route(origin+'/**',async r=>{
        const u=new URL(r.request().url()),name=u.pathname;
        if(name==='/api/shortcuts'){
            const current=shortcutStore.shortcuts||{revision:null,shortcuts:null};
            if(r.request().method()==='GET')return r.fulfill({json:current});
            if(shortcutStore.failShortcutSave)return r.fulfill({status:500,json:{error:'Test save failure'}});
            const payload=r.request().postDataJSON();
            if(payload.revision!==current.revision)return r.fulfill({status:409,json:{error:'其他设备已修改快捷键，请重新打开设置后再修改。'}});
            shortcutStore.shortcuts={revision:String(Number(current.revision||0)+1),shortcuts:payload.shortcuts};
            return r.fulfill({json:shortcutStore.shortcuts});
        }
        if(name==='/api/state'){
            const state=currentState();if(u.searchParams.get('since')===state.revision&&u.searchParams.get('workspace')===state.workspace.id)return r.fulfill({json:{unchanged:true,revision:state.revision,workspace:state.workspace}});
            return r.fulfill({json:state});
        }
        if(name==='/api/reading'){
            if(shared)shared.reading[r.request().headers()['x-paperediter-workspace']]=r.request().postDataJSON();
            return r.fulfill({json:{ok:true}})
        }
        if(shared&&name==='/api/workspaces')return r.fulfill({json:{files:shared.recent.map(x=>({...x,active:x.id===shared.workspace.id})),current:shared.workspace}});
        if(shared&&name==='/api/workspaces/new'){
            const requested=r.request().postDataJSON().path;shared.requestedNew=requested;
            const filename=requested||'C:/PaperEditer/workspaces/Untitled-test.json';
            if(shared.recent.some(x=>x.path===filename))return r.fulfill({status:400,json:{error:'文件已存在'}});
            shared.workspace={id:filename,name:filename.split(/[\\/]/).pop(),path:filename,history:true};shared.recent=[shared.workspace,...shared.recent];
            shared.state=structuredClone(data.state);shared.state.revision='new-example';
            return r.fulfill({json:shared.workspace})
        }
        if(shared&&name==='/api/workspaces/forget'){
            const filename=r.request().postDataJSON().path;shared.recent=shared.recent.filter(x=>x.path!==filename);
            return r.fulfill({json:{files:shared.recent.map(x=>({...x,active:x.id===shared.workspace.id})),current:shared.workspace}})
        }
        if(shared&&name==='/api/workspaces/open'){
            const filename=r.request().postDataJSON().path;shared.requested=filename;
            if(filename.endsWith('missing.json'))return r.fulfill({status:400,json:{error:'文件不存在'}});
            shared.workspace={id:filename,name:filename.split(/[\\/]/).pop(),path:filename};shared.recent=[shared.workspace,...shared.recent.filter(x=>x.path!==filename)];
            return r.fulfill({json:shared.workspace})
        }
        if(name==='/api/save'){
            const payload=r.request().postDataJSON(),state=currentState();
            if(payload.revision!==state.revision||r.request().headers()['x-paperediter-workspace']!==state.workspace.id)return r.fulfill({status:409,json:{error:'版本冲突'}});
            const revision='mock-'+(shared?(shared.rev=(shared.rev||0)+1):++rev),next={...state,...payload,revision};
            if(shared)shared.state=next;else ownState=next;
            return r.fulfill({json:{revision}});
        }
        if(shared?.history&&name==='/api/history'){
            const offset=Number(u.searchParams.get('offset')||0),limit=shared.historyPageSize||Number(u.searchParams.get('limit')||100);
            return r.fulfill({json:{items:shared.history.slice(offset,offset+limit),more:offset+limit<shared.history.length,total:shared.history.length}})
        }
        if(shared?.history&&name==='/api/history/item')return r.fulfill({json:shared.versions[u.searchParams.get('id')]});
        if(shared?.history&&name==='/api/history/tag'){
            const req=r.request().postDataJSON(),entry=shared.history.find(x=>x.id===req.id)||shared.history[0];
            shared.tagCalls=(shared.tagCalls||0)+1;
            if(req.clear)entry.tag=null;else entry.tag={id:'mock-tag',name:req.name||entry.tag?.name||'2026-11-26 10:00:00'};
            return r.fulfill({json:{tag:entry.tag}});
        }
        if(shared?.history&&name==='/api/history/restore'){
            const req=r.request().postDataJSON();shared.restoreCalls=(shared.restoreCalls||0)+1;
            shared.state={...shared.versions[req.id],revision:'restore-'+shared.restoreCalls};return r.fulfill({json:{revision:shared.state.revision}});
        }
        if(name==='/assets/demo.png')return r.fulfill({body:Buffer.from(data.image,'base64'),contentType:'image/png'});
        if(name==='/workbench.js')return r.fulfill({body:fs.readFileSync(path.join(__dirname,'app.js'),'utf8')+'\n;\n'+fs.readFileSync(path.join(__dirname,'visual.js'),'utf8'),contentType:'text/javascript'});
        const file=name==='/'?'index.html':name.startsWith('/vendor/')?'node_modules/'+name.slice(8):name.slice(1);
        const resolved=path.resolve(__dirname,file);
        if(!resolved.startsWith(__dirname+path.sep)||!fs.existsSync(resolved))return r.fulfill({status:404});
        const ext=path.extname(resolved),type={'.js':'text/javascript','.css':'text/css','.html':'text/html','.woff2':'font/woff2','.woff':'font/woff'}[ext];
        return r.fulfill({path:resolved,...(type?{contentType:type}:{})});
    });
    await p.goto(origin);await p.waitForFunction(()=>typeof db!=='undefined'&&db?.thesis?.length===2);
    return {p,context,errors};
}
async function headerControl(p,id,method='click'){
    const control=p.locator('#'+id);
    if(!await control.isVisible()&&await p.locator('#headerMore').isVisible())await p.locator('#headerMore').click();
    await control[method]();
}
const menu=(p,name)=>p.locator('#menu').getByRole('button',{name,exact:true});
async function contextAt(p,loc){await loc.click({button:'right'});await p.locator('#menu').waitFor({state:'visible'})}
async function checkSectionMenu(p){
    await p.evaluate(()=>select('demo-start'));
    const expected=['新建同级目录','新建子目录','删除'];
    const heading=p.locator('.pane .editableHeading').first();
    const child=p.locator('details.child[data-section-id="demo-method"] > summary');
    const check=async()=>assert.deepEqual(await p.locator('#menu button').allTextContents(),expected);
    await heading.locator('.sectionMore').click();await check();
    await contextAt(p,heading.locator('.editableTitle'));await check();
    await child.locator('.sectionMore').click();await check();
    await contextAt(p,child.locator('.editableTitle'));await check();
    await p.evaluate(()=>{document.querySelector('details.child[data-section-id="demo-method"]').open=false});
    await contextAt(p,child.locator('.childCollapsedTitle'));await check();
    await menu(p,'新建同级目录').click();
    const sibling=await p.evaluate(()=>panes[active].id);
    assert(await p.evaluate(id=>find(id).parent==='demo-start'&&find(id).title===''&&find(id).body===''&&!dialog.open,sibling));
    await p.locator('.pane .sectionMore').first().click();await check();
    await menu(p,'新建子目录').click();
    const nested=await p.evaluate(()=>panes[active].id);
    assert(await p.evaluate(([id,parent])=>find(id).parent===parent&&find(id).title===''&&find(id).body===''&&!dialog.open,[nested,sibling]));
    await p.evaluate(id=>{select(id);window.confirm=()=>true},sibling);
    await p.locator('.pane .sectionMore').first().click();await menu(p,'删除').click();
    assert(await p.evaluate(([id,child])=>!find(id)&&!find(child),[sibling,nested]));
}
async function checkTreeMenuDrag(p){
    await p.evaluate(()=>select('demo-start'));
    const row=p.locator('#nav .navrow').first();
    await row.locator('button').last().click();
    assert.deepEqual(await p.locator('#menu button').allTextContents(),['新建同级目录','新建子目录','删除']);
    await menu(p,'新建同级目录').click();
    const sibling=await p.evaluate(()=>panes[active].id);
    assert(await p.evaluate(id=>find(id).title===''&&find(id).body===''&&find(id).parent===null&&!dialog.open&&children('thesis',null).at(-1).id===id,sibling));
    await contextAt(p,p.locator('#nav .navrow.selected'));
    assert.deepEqual(await p.locator('#menu button').allTextContents(),['新建同级目录','新建子目录','删除']);
    await menu(p,'新建子目录').click();
    const child=await p.evaluate(()=>panes[active].id);
    assert(await p.evaluate(([id,parent])=>find(id).parent===parent&&find(id).title===''&&find(id).body===''&&!dialog.open,[child,sibling]));
    await p.locator('.pane .editableTitle').first().fill('Temporary child');
    assert.equal(await p.evaluate(id=>find(id).title,child),'Temporary child');
    const drag=async (pos,hold,leave=false)=>{
        await p.evaluate(([id,pos])=>{
            select(id);const source=document.querySelector('#nav .navrow.selected'),target=document.querySelector('#nav .navrow');
            const r=target.getBoundingClientRect(),dt=new DataTransfer();window.treeDrag={source,target,dt,y:r.top+r.height*pos};
            source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));
            target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt,clientY:window.treeDrag.y}));
        },[sibling,pos]);
        const expected=pos<.5?'drop-before':'drop-after';
        const preview=p.locator('#nav .'+expected);
        assert.equal(await preview.count(),1);
        assert.equal(await preview.getAttribute('data-node-id'),pos<.5?'demo-start':'demo-method');
        assert.equal(await preview.evaluate(row=>getComputedStyle(row,'::after').left),'0px');
        if(hold){await p.waitForFunction(()=>document.querySelector('.drop-inside'));assert.equal(await preview.count(),0)}
        if(leave)await p.evaluate(()=>{const {target,dt,y}=window.treeDrag;target.dispatchEvent(new DragEvent('dragleave',{bubbles:true,dataTransfer:dt}));target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt,clientY:y}))});
        await p.evaluate(()=>{const {target,dt,y}=window.treeDrag;target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,clientY:y}))});
    };
    await drag(.4,false);assert(await p.evaluate(id=>find(id).parent===null&&children('thesis',null)[0].id===id,sibling));
    await p.evaluate(id=>moveTo(id,'demo-start','after'),sibling);
    await drag(.6,true,true);assert.equal(await p.evaluate(id=>find(id).parent,sibling),null);
    await drag(.6,true);assert.equal(await p.evaluate(id=>find(id).parent,sibling),'demo-start');
    // Moving out of an expanded parent uses the very same insertion line.
    await drag(.9,false);assert.equal(await p.evaluate(id=>find(id).parent,sibling),null);
    await p.evaluate(id=>select(id),sibling);
    await p.locator('#nav .navrow.selected button').last().click();
    await p.evaluate(()=>window.confirm=()=>true);
    await menu(p,'删除').click();
    assert(await p.evaluate(([a,b])=>!find(a)&&!find(b)&&!!find('demo-start'),[sibling,child]));
    await p.evaluate(()=>undo(false));assert(await p.evaluate(([a,b])=>!!find(a)&&!!find(b),[sibling,child]));
}
async function checkCleanBody(p,mobile=false){
    await p.evaluate(()=>select('demo-start'));
    const child=p.locator('details.child[data-section-id="demo-method"]'),summary=child.locator(':scope > summary'),title=summary.locator('.editableTitle');
    assert.equal(await child.locator(':scope > .childbody > .editableHeading').count(),0);
    assert.equal(await title.inputValue(),'Example method');
    assert(await title.isVisible());assert(!(await summary.locator('.childCollapsedTitle').isVisible()));
    assert.equal(await p.locator('.visualDocument .insertPlus,.visualDocument .visualBottom').count(),0);
    if(mobile){await summary.locator('.headingNumber').tap()}else{await summary.locator('.headingNumber').click()}
    await p.waitForFunction(()=>!document.querySelector('details.child').open);
    assert(await summary.locator('.childCollapsedTitle').isVisible());assert(!(await title.isVisible()));
    if(mobile){await summary.locator('.childCollapsedTitle').tap();await p.locator('#editModeToggle').tap()}else await summary.locator('.childCollapsedTitle').click();
    await title.fill('Updated method');assert(await child.evaluate(d=>d.open));
    await summary.locator('.headingNumber').click();assert.equal(await summary.locator('.childCollapsedTitle').innerText(),'1.1 Updated method');
    await summary.locator('.childCollapsedTitle').click();
    const area=child.locator('.richText').first();
    await contextAt(p,area);
    assert.deepEqual(await p.locator('#menu button').allTextContents(),['剪切','复制','粘贴','添加公式','添加独立公式','插入交叉引用','新建批注']);
    await menu(p,'插入交叉引用').click();
    assert.equal(await p.locator('#dialog .visualPickList button').filter({hasText:'Example annotation'}).count(),0);
    await p.locator('#dialog .visualPickList button').filter({hasText:'Example measurements'}).click();
    await p.locator('#dialog').waitFor({state:'hidden'});
    await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert(await p.evaluate(()=>find('demo-method').body.includes('[[ref:demo-table]]')));
    await area.evaluate(a=>{
        a.focus();const t=[...a.querySelector('p').childNodes].find(n=>n.nodeType===Node.TEXT_NODE&&n.length),r=document.createRange();r.setStart(t,1);r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r);
        const b=r.getBoundingClientRect(),e=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:b.left,clientY:b.top+2});e.useCurrentSelection=true;a.dispatchEvent(e)
    });
    await p.locator('#menu').waitFor({state:'visible'});
    await menu(p,'新建批注').click();await p.locator('#dialog .richText').first().fill('New annotation');await p.evaluate(()=>closeWorkbenchDialog());
    assert(await p.evaluate(()=>db.blocks.some(n=>n.body.includes('New annotation')&&find('demo-method').body.includes('[[embed:'+n.id+']]'))));
}
async function checkNetwork(p){
    await p.evaluate(()=>select('demo-note'));
    await p.locator('#nav .navrow.selected button').last().click();
    assert.deepEqual(await p.locator('#menu button').allTextContents(),['定位批注','删除批注']);
    await menu(p,'定位批注').click();
    await p.waitForFunction(()=>panes[active].id==='demo-start'&&dialog.open&&dialog._noteId==='demo-note');
    await p.evaluate(()=>closeWorkbenchDialog());
    await p.evaluate(()=>select('demo-free'));
    await p.locator('.pane .annotationLocation').click();
    await p.waitForFunction(()=>dialog.open&&dialog._noteId==='demo-free'&&document.querySelector('.freeNoteMarker.networkJumpHighlight'));
    await p.evaluate(()=>closeWorkbenchDialog());
    await p.evaluate(()=>setView('blocks'));
    assert.equal(await p.locator('.graph,.blockNetwork').count(),0);
    assert.equal(await p.locator('.annotationRow').count(),2);
}
async function checkTrashReferences(p){
    await p.evaluate(()=>{
        const note=find('demo-note'),other=find('demo-free'),chapter=find('demo-start');
        note.body+='\n\n:::equation trash-eq\nx=1\n:::\n\n:::figure trash-fig\nCaption\n\n![Demo](/assets/demo.png "wb-id:trash-sub")\n:::';
        chapter.body+='\n\n[[ref:demo-note]][[eqref:trash-eq]] [[ref:trash-sub]] [[cite:demo-note]] [[eqref:demo-eq]]';
        other.objectBindings=[{targetId:'trash-eq'},{targetId:'demo-eq'}];
        other.annotation={owner:'demo-note',mode:'caret'};
        other.freePlacements=[{id:'trash-placement',pageId:'demo-note',x:0,y:0},...other.freePlacements];
        change(true);window.beforeTrash=JSON.stringify(editableSnapshot());deleteNode(note);
    });
    await p.waitForFunction(()=>!find('demo-note')&&db.trash.length===1);
    assert.equal(await p.evaluate(()=>all().some(n=>/\[\[(?:ref|eqref|embed):(?:demo-note|trash-eq|trash-fig|trash-sub)\]\]/.test(n.body))),false);
    assert.equal(await p.evaluate(()=>find('demo-start').body.includes('[[cite:demo-note]]')&&find('demo-start').body.includes('[[eqref:demo-eq]]')),true);
    assert.equal(await p.evaluate(()=>find('demo-free').objectBindings.length===1&&!find('demo-free').annotation&&find('demo-free').freePlacements.length===1),true);
    await p.evaluate(()=>restoreTrash(db.trash[0]));
    assert.equal(await p.evaluate(()=>{const before=JSON.parse(window.beforeTrash),after=editableSnapshot();return before.thesis.every(n=>after.thesis.find(x=>x.id===n.id).body===n.body)&&before.blocks.every(n=>after.blocks.some(a=>a.body===n.body))&&after.blocks.every(n=>annotationLocations(n).length<=1)&&!after.trash.length}),true);
}
async function checkMixedRange(browser,mobile){
    const {p,context,errors}=await fixture(browser,mobile);
    const original='Alpha start $a+b$ [[eqref:range-eq]]\n\n:::equation range-eq\nx^2\n:::\n\n:::figure range-fig\nA figure\n\n![Swatches](/assets/demo.png "wb-id:range-sub wb-width:20")\n:::\n\n:::table range-tab\nA table\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n:::\n\n[[embed:demo-free]]\n\nOmega end\n';
    await p.evaluate(raw=>{find('demo-start').body=raw;reindex();select('demo-start')},original);
    const doc=p.locator('.pane .visualDocument').first();
    const first=doc.locator('.part-text .richText').first(),last=doc.locator('.part-text .richText').last();
    const textPoint=async(loc,offset)=>loc.evaluate((a,i)=>{const n=a.querySelector('p').firstChild,r=document.createRange();r.setStart(n,i);r.collapse(true);const b=r.getBoundingClientRect();return {x:b.x,y:b.y+b.height/2}},offset);
    if(mobile){
        const cdp=await context.newCDPSession(p);let start=await textPoint(first,2);
        const assertVisibleTextPoint=async(point,loc)=>assert.equal(await p.evaluate(({x,y,selector})=>{const pane=document.querySelector('.pane.activepane'),box=pane.getBoundingClientRect(),hit=document.elementFromPoint(x,y);return x>=box.left&&x<=box.right&&y>=box.top&&y<=box.bottom&&hit?.closest('.richText')===document.querySelector(selector)}, {x:point.x,y:point.y,selector:await loc.evaluate(a=>{a.dataset.testTouchTarget='1';return '[data-test-touch-target="1"]'})}),true,'touch point must hit visible prose');
        await assertVisibleTextPoint(start,first);
        await p.evaluate(()=>{window.__touchSelections=[];document.addEventListener('selectionchange',()=>{const s=getSelection();if(s&&!s.isCollapsed)window.__touchSelections.push(s.toString())})});
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[start]});
        await p.locator('.rangeEnd:visible').waitFor();
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        const endpoints=()=>doc.evaluate(d=>{const r=d._mixedRange();return r&&[r.startContainer.textContent,r.startOffset,r.endContainer.textContent,r.endOffset]});
        const initial=await endpoints();assert(initial);
        const swipe=async(a,b)=>{await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[a]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[b]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})};
        const pane=await p.locator('.pane.activepane').boundingBox(),scrollBefore=await p.locator('.pane.activepane').evaluate(x=>x.scrollTop);
        await swipe(start,{x:start.x+8,y:Math.max(pane.y+10,start.y-130)});await p.waitForTimeout(100);
        assert((await p.locator('.pane.activepane').evaluate(x=>x.scrollTop))>scrollBefore,'vertical prose swipe scrolls the pane');
        assert.deepEqual(await endpoints(),initial,'same-prose scroll preserves logical selection endpoints');
        const copyButton=p.locator('#floatingTools [data-tool="复制"]');await copyButton.tap();await p.waitForFunction(()=>localClipboard?.includes('Alpha'));
        assert((await p.evaluate(()=>localClipboard)).includes('Alpha'),'copy uses the original selection after scrolling');
        assert.deepEqual(await endpoints(),initial,'copy leaves the original logical selection intact');
        const outside=await p.locator('.pane .toolbar').first().boundingBox();
        await swipe({x:outside.x+outside.width/2,y:outside.y+outside.height/2},{x:outside.x+outside.width/2+20,y:outside.y+outside.height/2});
        assert.deepEqual(await endpoints(),initial,'outside-document swipe preserves logical selection');
        await p.waitForTimeout(600);
        await p.locator('.pane.activepane').evaluate((x,v)=>{x.scrollTop=v},scrollBefore);
        await first.scrollIntoViewIfNeeded();
        const fresh=await textPoint(first,9);
        await assertVisibleTextPoint(fresh,first);
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[fresh]});await p.waitForFunction(([old])=>{const d=document.querySelector('.pane .visualDocument'),r=d._mixedRange();return !!r&&(r.startOffset!==old[1]||r.endOffset!==old[3])},[initial]);
        assert.notDeepEqual(await endpoints(),initial,'new long press selects a different word without an intervening tap');
        assert.equal(await p.evaluate(()=>getSelection().isCollapsed||getSelection().toString()===''),true,'custom handles leave no stale native text selection');
        assert.deepEqual(await p.evaluate(()=>window.__touchSelections),[],'native selection never appears while custom handles are shown');
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        const freshSelection=await endpoints();assert.deepEqual(await endpoints(),freshSelection,'long-press release keeps the newly selected word');
        const cancelTap=await textPoint(first,11);await assertVisibleTextPoint(cancelTap,first);await p.touchscreen.tap(cancelTap.x,cancelTap.y);
        await p.waitForFunction(()=>!document.querySelector('.pane .visualDocument')._mixedRange(),'tap clears logical selection');
        await p.locator('#editModeToggle').tap();
        const caret=await textPoint(first,7);await assertVisibleTextPoint(caret,first);await p.touchscreen.tap(caret.x,caret.y);
        assert.equal(await p.evaluate(()=>editingEnabled&&getSelection().isCollapsed&&getSelection().anchorNode?.nodeType===Node.TEXT_NODE),true,'edit tap places a usable native caret');
        await p.locator('#editModeToggle').tap();
        start=await textPoint(first,2);await assertVisibleTextPoint(start,first);
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[start]});await p.locator('.rangeEnd:visible').waitFor();
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        assert(!(await p.locator('#menu').isVisible()));
        await p.waitForTimeout(550);
        // Keep both the initial handle and target visible on the phone.
        await p.evaluate(()=>{for(const c of document.querySelectorAll('.pane .part-table,.pane .part-embed'))c._setFolded(true,false)});
        await last.scrollIntoViewIfNeeded();
        const handle=await p.locator('.rangeEnd:visible').boundingBox(),dest=await textPoint(last,5);
        if(!handle)throw Error('missing range handle');
        const hpoint={x:handle.x+handle.width/2,y:handle.y+10};
        assert.equal(await p.evaluate(({x,y})=>document.elementFromPoint(x,y)?.classList.contains('rangeHandle'),hpoint),true);
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[hpoint]});
        await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:dest.x,y:dest.y+10}]});
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    }else{
        await first.evaluate(a=>{a.focus();const n=a.querySelector('p').firstChild;getSelection().collapse(n,6)});
        await last.scrollIntoViewIfNeeded();const dest=await textPoint(last,5);await p.keyboard.down('Shift');await p.mouse.click(dest.x,dest.y);await p.keyboard.up('Shift');
    }
    await p.waitForFunction(()=>document.querySelectorAll('.rangeSelected').length===4).catch(async err=>{console.log('range failure',mobile,errors,await p.evaluate(()=>({selected:[...document.querySelectorAll('.rangeSelected')].map(c=>c.className),range:getSelection().toString(),mixed:!!document.querySelector('.pane .visualDocument')._mixedRange(),focus:document.activeElement?.className})));throw err});
    assert.equal(await first.locator('.inlineMathAtom.rangeMathSelected').count(),1,'cross-object range highlights inline formula on desktop and mobile');
    if(mobile){
        const button=p.locator('#floatingTools [data-tool="复制"]');
        await p.waitForFunction(()=>document.querySelector('#floatingTools [data-tool="复制"]').getAttribute('aria-disabled')==='false');
        await button.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        await p.waitForTimeout(150);
        await button.tap();
    }else await p.keyboard.press('Control+C');
    await p.waitForFunction(()=>localClipboard?.includes(':::table '));
    const copy=await p.evaluate(()=>localClipboard);
    assert(copy.includes(':::equation ')&&copy.includes(':::figure ')&&copy.includes('Omega')&&!copy.includes(':::equation range-eq')&&copy.includes('$a+b$')&&copy.includes('[[embed:demo-free]]'));
    const newEq=copy.match(/:::equation ([^\n]+)/)[1];assert(copy.includes('[[eqref:'+newEq+']]'));
    assert.deepEqual(errors,[]);
    if(!mobile){
        await p.keyboard.press('Control+X');
        await p.waitForFunction(()=>!find('demo-start').body.includes(':::figure range-fig'));
        const cut=await p.evaluate(()=>localClipboard);
        assert(cut.includes(':::equation range-eq')&&cut.includes(':::figure range-fig')&&cut.includes(':::table range-tab'));
        assert.equal(await p.evaluate(()=>find('demo-start').body),'Alpha  end\n');
        await p.evaluate(()=>undo(false));await p.waitForFunction(raw=>find('demo-start').body===raw,original);
        await last.evaluate(a=>{a.focus();const n=a.querySelector('p').firstChild;getSelection().collapse(n,5)});
        await first.scrollIntoViewIfNeeded();const dest=await textPoint(first,6);
        await p.keyboard.down('Shift');await p.mouse.click(dest.x,dest.y);await p.keyboard.up('Shift');
        await p.waitForFunction(()=>document.querySelectorAll('.rangeSelected').length===4);
        await p.keyboard.press('ArrowLeft');
        await p.waitForFunction(()=>!document.querySelector('.rangeSelected'));
        assert.equal(await p.evaluate(()=>find('demo-start').body),original);
        // Shift+Arrow from a prose boundary includes the entire adjacent object.
        await first.evaluate(a=>{a.focus();const r=document.createRange();r.selectNodeContents(a);r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r)});
        await p.keyboard.press('Shift+ArrowRight');await p.waitForFunction(()=>document.querySelector('.part-equation.rangeSelected'));
        await p.keyboard.press('Shift+ArrowRight');await p.waitForFunction(()=>document.querySelector('.part-figure.rangeSelected'));
        await p.keyboard.press('Escape');await p.waitForFunction(()=>!document.querySelector('.rangeSelected'));
        assert.equal(await p.evaluate(()=>find('demo-start').body),original);
    }else{
        assert.equal(await p.locator('#floatingTools [data-tool="剪切"]').getAttribute('aria-disabled'),'true');
        assert.equal(await p.evaluate(()=>find('demo-start').body),original);
    }
    await context.close();
}
async function checkSelectAllRange(browser){
    const {p,context,errors}=await fixture(browser);
    const original='Alpha start $a+b$\n\n:::equation all-eq\nx^2\n:::\n\n:::figure all-fig\nA figure\n\n![Swatches](/assets/demo.png)\n:::\n\n[[embed:demo-free]]\n\nOmega end\n';
    await p.evaluate(raw=>{find('demo-start').body=raw;reindex();select('demo-start')},original);
    const doc=p.locator('.pane .visualDocument').first(),first=doc.locator('.part-text .richText').first();
    await first.evaluate(a=>{a.focus();getSelection().collapse(a.querySelector('p').firstChild,3)});
    await p.keyboard.press('Control+A');
    await p.waitForFunction(()=>document.querySelectorAll('.pane .rangeSelected').length===3);
    assert.equal(await doc.evaluate(d=>{const r=d._mixedRange();return !!r&&r.startContainer===d.querySelector('.part-text .richText')&&r.startOffset===0&&r.endContainer===[...d.querySelectorAll('.part-text .richText')].at(-1)&&r.endOffset===r.endContainer.childNodes.length}),true);
    await p.keyboard.press('Control+C');
    await p.waitForFunction(()=>localClipboard?.includes('Omega end'));
    const copied=await p.evaluate(()=>localClipboard);
    assert(copied.includes('Alpha start $a+b$')&&copied.includes(':::equation ')&&copied.includes(':::figure ')&&copied.includes('[[embed:'));
    assert(!copied.includes(':::equation all-eq'));
    await p.keyboard.press('Control+X');
    await p.waitForFunction(()=>!find('demo-start').body.trim());
    assert((await p.evaluate(()=>localClipboard)).includes(':::equation all-eq'));
    await p.evaluate(()=>undo(false));await p.waitForFunction(raw=>find('demo-start').body===raw,original);
    await first.focus();await p.keyboard.press('Control+A');await p.keyboard.press('Delete');
    await p.waitForFunction(()=>!find('demo-start').body.trim());
    await p.evaluate(()=>undo(false));await p.waitForFunction(raw=>find('demo-start').body===raw,original);
    const formula=doc.locator('.part-equation math-field').first();
    await formula.focus();await p.keyboard.press('Control+A');
    assert.equal(await doc.evaluate(d=>!!d._mixedRange()),false);
    assert.equal(await formula.evaluate(f=>f.getValue(f.selection,'latex')),await formula.evaluate(f=>f.value));
    const title=p.locator('.pane .editableTitle').first();await title.focus();await p.keyboard.press('Control+A');
    assert.equal(await title.evaluate(t=>t.selectionStart===0&&t.selectionEnd===t.value.length),true);
    await p.evaluate(()=>{find('demo-start').body='Only one paragraph\n';reindex();select('demo-start')});
    await first.focus();await p.keyboard.press('Control+A');await p.keyboard.press('Backspace');
    await p.waitForFunction(()=>!find('demo-start').body.trim());
    assert.deepEqual(errors,[]);await context.close();
}
async function checkInlineMathRange(browser){
    const {p,context,errors}=await fixture(browser);
    const raw='Alpha $a+b$ middle $c^2$ Omega\n\n:::equation range-math\nx^2\n:::\n\nLast paragraph\n';
    await p.evaluate(raw=>{find('demo-start').body=raw;clearAnnotationPlacement(find('demo-free'));reindex();select('demo-start')},raw);
    const doc=p.locator('.pane .visualDocument').first(),area=doc.locator('.part-text .richText').first(),atoms=area.locator('.inlineMathAtom');
    await atoms.nth(1).waitFor();
    await area.scrollIntoViewIfNeeded();
    await p.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))});
    const count=()=>area.locator('.rangeMathSelected').count();
    const at=async(n,i)=>area.evaluate((a,[n,i])=>{const t=[...a.querySelector('p').childNodes].filter(x=>x.nodeType===3)[n],r=document.createRange();r.setStart(t,i);r.collapse(true);const b=r.getBoundingClientRect();return {x:b.x,y:b.y+b.height/2}},[n,i]);
    const start=await at(0,2),middle=await at(1,3),end=await at(2,3);
    const initial=await atoms.first().boundingBox();
    await p.mouse.move(start.x,start.y);await p.mouse.down();await p.mouse.move(end.x,end.y,{steps:16});
    await p.waitForFunction(()=>document.querySelectorAll('.inlineMathAtom.rangeMathSelected').length===2).catch(async err=>{console.log('inline range',errors,await p.evaluate(({start,end})=>({selection:getSelection().toString(),anchor:getSelection().anchorNode?.nodeName,focus:getSelection().focusNode?.nodeName,atoms:[...document.querySelectorAll('.inlineMathAtom')].map(a=>({cls:a.className,rect:a.getBoundingClientRect().toJSON()})),hits:[start,end].map(({x,y})=>document.elementFromPoint(x,y)?.outerHTML.slice(0,300))}),{start,end}));throw err});
    assert.deepEqual(await atoms.first().boundingBox(),initial,'range highlight must not change layout');
    assert.equal(await atoms.first().evaluate(a=>getComputedStyle(a).outlineWidth),'2px');
    await p.mouse.move(middle.x,middle.y,{steps:10});await p.mouse.up();
    await p.waitForFunction(()=>document.querySelectorAll('.inlineMathAtom.rangeMathSelected').length===1);
    assert.equal(await atoms.first().evaluate(a=>a.classList.contains('rangeMathSelected')),true);
    // A range ending just before the atom must not select it.
    await area.evaluate(a=>{const p=a.querySelector('p'),r=document.createRange();r.setStart(p.firstChild,0);r.setEndBefore(p.querySelector('.inlineMathAtom'));getSelection().removeAllRanges();getSelection().addRange(r)});
    await p.waitForFunction(()=>!document.querySelector('.rangeMathSelected'));
    await p.mouse.move(end.x,end.y);await p.mouse.down();await p.mouse.move(start.x,start.y,{steps:16});await p.mouse.up();
    await p.waitForFunction(()=>document.querySelectorAll('.inlineMathAtom.rangeMathSelected').length===2);
    await p.mouse.click(middle.x,middle.y);await p.waitForFunction(()=>!document.querySelector('.rangeMathSelected'));
    const field=atoms.first().locator('math-field');await field.focus();await p.keyboard.press('Control+A');
    assert.equal(await field.evaluate(f=>f.getValue(f.selection,'latex')),await field.evaluate(f=>f.value));
    assert.equal(await count(),0,'MathLive internal selection is not an outer atom selection');
    await area.focus();await p.keyboard.press('Control+A');await p.waitForFunction(()=>document.querySelectorAll('.inlineMathAtom.rangeMathSelected').length===2&&document.querySelector('.part-equation.rangeSelected'));
    await p.keyboard.press('Escape');await p.waitForFunction(()=>!document.querySelector('.rangeMathSelected'));
    assert.equal(await p.evaluate(()=>find('demo-start').body),raw);assert.deepEqual(errors,[]);await context.close();
}
async function checkMouseRange(browser){
    const {p,context,errors}=await fixture(browser);
    const original='Alpha start\n\nMiddle paragraph\n\n:::equation drag-eq\nx^2\n:::\n\nOmega end\n';
    await p.evaluate(raw=>{find('demo-start').body=raw;clearAnnotationPlacement(find('demo-free'));reindex();select('demo-start')},original);
    const doc=p.locator('.pane .visualDocument').first(),areas=doc.locator('.part-text .richText');
    const at=(i,offset)=>areas.nth(i).evaluate((a,i)=>{const r=document.createRange();r.setStart(a.querySelector('p').firstChild,i);r.collapse(true);const b=r.getBoundingClientRect();return {x:b.x,y:b.y+b.height/2}},offset);
    const drag=async(i,a,j,b)=>{const start=await at(i,a),end=await at(j,b);await p.mouse.move(start.x,start.y);await p.mouse.down();await p.mouse.move(end.x,end.y,{steps:15});await p.mouse.up()};
    const mixed=()=>doc.evaluate(d=>!!d._mixedRange());
    await drag(0,0,0,5);assert.equal(await mixed(),false);assert.equal(await p.evaluate(()=>getSelection().toString()),'Alpha');
    await drag(0,6,1,6);assert.equal(await mixed(),true);await p.keyboard.press('Control+C');
    await p.waitForFunction(()=>localClipboard==='start\n\nMiddle');
    await drag(2,5,0,6);assert.equal(await mixed(),true);assert.equal(await doc.locator('.part-equation.rangeSelected').count(),1);
    await p.keyboard.press('Control+X');await p.waitForFunction(()=>find('demo-start').body==='Alpha  end\n');
    assert((await p.evaluate(()=>localClipboard)).includes(':::equation drag-eq'));
    await p.evaluate(()=>undo(false));await p.waitForFunction(raw=>find('demo-start').body===raw,original);
    const start=await at(0,0),far=await at(1,6),back=await at(0,5);
    await p.mouse.move(start.x,start.y);await p.mouse.down();await p.mouse.move(far.x,far.y,{steps:10});assert.equal(await mixed(),true);
    await p.mouse.move(back.x,back.y,{steps:10});await p.mouse.up();assert.equal(await mixed(),false);assert.equal(await p.evaluate(()=>getSelection().toString()),'Alpha');
    await drag(0,6,2,5);await p.keyboard.press('Delete');await p.waitForFunction(()=>find('demo-start').body==='Alpha  end\n');
    assert.deepEqual(errors,[]);await context.close();
}
async function checkRangeAnnotations(browser){
    const {p,context,errors}=await fixture(browser);
    const raw='Alpha start [[embed:demo-note]]\n\n:::equation drag-eq\nx^2\n:::\n\n:::figure drag-fig\nCaption\n\n![Demo](/assets/demo.png "wb-id:drag-sub")\n:::\n\n:::table drag-tab\nCaption\n\n| A |\n| --- |\n| 1 |\n:::\n\n[[embed:standalone-note]]\n\nOmega end\n';
    await p.evaluate(raw=>{
        const make=(id,body,extra={})=>db.blocks.push({id,title:body,body,parent:null,level:1,order:db.blocks.length,file:'blocks/'+id+'.md',...extra});
        make('standalone-note','Standalone note');make('bound-note','Bound note',{objectBindings:[{targetId:'drag-sub'}]});
        find('demo-start').body=raw;clearAnnotationPlacement(find('demo-free'));reindex();select('demo-start');
        for(const card of document.querySelectorAll('.pane .visualCard:not(.part-text):not(.part-embed)'))card._setFolded(true,false);
        const page=document.querySelector('.pane .page'),card=page.querySelector('.part-table');find('demo-free').freePlacements=[{id:'free-range',pageId:'demo-start',x:.03,y:card.getBoundingClientRect().top-page.getBoundingClientRect().top+8}];refreshFreeNotes();
    },raw);
    const doc=p.locator('.pane .visualDocument').first(),areas=doc.locator('.part-text .richText');
    const at=(i,offset)=>areas.nth(i).evaluate((a,i)=>{const r=document.createRange();r.setStart(a.querySelector('p').firstChild,i);r.collapse(true);const b=r.getBoundingClientRect();return {x:b.x,y:b.y+b.height/2}},offset);
    const drag=async()=>{const start=await at(0,6),end=await at(1,5);await p.mouse.move(start.x,start.y);await p.mouse.down();await p.mouse.move(end.x,end.y,{steps:20});await p.mouse.up()};
    const ids=['demo-note','standalone-note','bound-note','demo-free'];
    await drag();await p.waitForFunction(()=>document.querySelectorAll('.visualCard.rangeSelected').length===4);
    assert(await p.evaluate(()=>['demo-note','standalone-note','demo-free'].every(id=>document.querySelector('.rangeNoteSelected[data-note-id="'+id+'"]'))));
    await p.keyboard.press('Control+C');await p.waitForFunction(()=>rangeNoteClipboardValue(localClipboard)?.notes.length===4);
    const copy=await p.evaluate(()=>localClipboard);assert(copy.includes(':::equation ')&&copy.includes(':::figure ')&&copy.includes(':::table '));
    const paste=async()=>{await p.evaluate(()=>select('demo-method'));await p.locator('.pane .richText').first().evaluate(a=>{a.focus();const data=new DataTransfer();data.setData('text/plain',localClipboard);a.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}))})};
    await paste();await p.waitForFunction(()=>db.blocks.length===8);
    assert(await p.evaluate(ids=>ids.every(id=>annotationLocations(find(id)).length===1)&&db.blocks.every(n=>annotationLocations(n).length===1)&&db.blocks.filter(n=>n.body==='Bound note').some(n=>n.id!=='bound-note'&&resolve(n.objectBindings[0].targetId)?.owner==='demo-method'),ids));
    await p.evaluate(()=>undo(false));await p.waitForFunction(()=>db.blocks.length===4);await p.evaluate(()=>{select('demo-start');for(const card of document.querySelectorAll('.pane .visualCard:not(.part-text):not(.part-embed)'))card._setFolded(true,false)});
    await drag();await p.keyboard.press('Control+X');await p.waitForFunction(()=>find('demo-start').body==='Alpha  end\n');
    assert(await p.evaluate(ids=>ids.every(id=>!annotationLocations(find(id)).length),ids));
    await paste();await p.waitForFunction(()=>find('demo-method').body.includes(':::equation drag-eq'));
    assert(await p.evaluate(ids=>db.blocks.length===4&&ids.every(id=>annotationLocations(find(id)).length===1)&&resolve(find('bound-note').objectBindings[0].targetId)?.owner==='demo-method',ids));
    await p.evaluate(()=>{undo(false);undo(false);select('demo-start');for(const card of document.querySelectorAll('.pane .visualCard:not(.part-text):not(.part-embed)'))card._setFolded(true,false)});
    await drag();await p.keyboard.press('Delete');await p.waitForFunction(()=>db.trash.length===4&&db.blocks.length===0);
    await p.evaluate(()=>undo(false));assert.equal(await p.evaluate(()=>find('demo-start').body),raw);assert.equal(await p.evaluate(()=>db.blocks.length),4);
    assert.deepEqual(errors,[]);await context.close();
}
async function checkLocalRangeAnnotations(browser){
    const {p,context,errors}=await fixture(browser);
    const raw='Alpha [[embed:demo-note]]marked words Omega\n';
    await p.evaluate(raw=>{clearAnnotationPlacement(find('demo-free'));const note=find('demo-note');clearAnnotationPlacement(note);note.annotation={owner:'demo-start',quote:'marked words',mode:'selection'};find('demo-start').body=raw;reindex();select('demo-start')},raw);
    await p.waitForFunction(()=>textAnnotationRanges.some(x=>x.chip.dataset.noteId==='demo-note'));
    const at=offset=>p.evaluate(offset=>{const {range}=textAnnotationRanges.find(x=>x.chip.dataset.noteId==='demo-note');const r=document.createRange();r.setStart(range.endContainer,offset);r.collapse(true);const b=r.getBoundingClientRect();return {x:b.x,y:b.y+b.height/2}},offset);
    const drag=async(a,b)=>{const start=await at(a),end=await at(b);await p.mouse.move(start.x,start.y);await p.mouse.down();await p.mouse.move(end.x,end.y,{steps:12});await p.mouse.up();await p.waitForFunction(()=>document.querySelector('.rangeNoteSelected[data-note-id="demo-note"]'))};
    await drag(2,9);assert.equal(await p.evaluate(()=>dialog.open),false);
    assert.equal(await p.evaluate(()=>CSS.highlights.get('paper-range-annotation')?.size),1);
    await p.keyboard.press('Control+C');await p.waitForFunction(()=>rangeNoteClipboardValue(localClipboard)?.notes.some(n=>n.id==='demo-note'));
    assert((await p.evaluate(()=>rangeNoteClipboardValue(localClipboard).raw)).includes('[[embed:demo-note]]'));
    await drag(9,2);await p.keyboard.press('Control+X');await p.waitForFunction(()=>!annotationLocations(find('demo-note')).length);
    assert(!(await p.evaluate(()=>find('demo-start').body)).includes('[[embed:demo-note]]'));
    await p.evaluate(()=>undo(false));await p.waitForFunction(raw=>find('demo-start').body===raw,raw);
    await p.waitForFunction(()=>textAnnotationRanges.some(x=>x.chip.dataset.noteId==='demo-note'));
    await drag(2,9);await p.keyboard.press('Delete');await p.waitForFunction(()=>!find('demo-note')&&db.trash.some(t=>t.nodes.some(n=>n.id==='demo-note')));
    await p.evaluate(()=>undo(false));await p.waitForFunction(raw=>find('demo-start').body===raw&&!!find('demo-note'),raw);
    assert.deepEqual(errors,[]);await context.close();
}
async function checkNewlineDeletion(browser,mobile){
    const {p,context,errors}=await fixture(browser,mobile);
    if(mobile)await p.evaluate(()=>{if(!editingEnabled)toggleEditMode()});
    const reset=async body=>{await p.evaluate(body=>{find('demo-start').body=body;select('demo-start');renderPanes()},body)};
    const areas=p.locator('.pane .part-text .richText');
    const caret=async(i,end)=>areas.nth(i).evaluate((area,end)=>{area.focus();const r=document.createRange();r.selectNodeContents(end?area.lastElementChild:area.firstElementChild);r.collapse(!end);const s=getSelection();s.removeAllRanges();s.addRange(r)},end);
    const del=async key=>{if(mobile)await p.evaluate(key=>document.activeElement.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:key==='Delete'?'deleteContentForward':'deleteContentBackward'})),key);else await p.keyboard.press(key)};
    const raw=()=>p.evaluate(()=>find('demo-start').body);
    for(const key of ['Backspace','Delete']){
        await reset('Alpha **bold**\n\nOmega [[ref:demo-method]] $x^2$\n\nThird\n');
        const count=await areas.count();await caret(key==='Delete'?0:1,key==='Delete');await del(key);
        assert.equal(await raw(),'Alpha **bold**Omega [[ref:demo-method]] $x^2$\n\nThird\n');
        assert.equal(await areas.count(),count-1);
        const atJoin=await p.evaluate(()=>{const r=getSelection().getRangeAt(0),left=r.cloneRange();left.selectNodeContents(document.activeElement);left.setEnd(r.startContainer,r.startOffset);return left.toString()});
        assert.equal(atJoin,'Alpha bold');
        if(!mobile){await p.keyboard.type('!');assert.equal(await raw(),'Alpha **bold!**Omega [[ref:demo-method]] $x^2$\n\nThird\n');await p.evaluate(()=>undo(false));await p.evaluate(()=>undo(false));assert.equal(await raw(),'Alpha **bold**\n\nOmega [[ref:demo-method]] $x^2$\n\nThird\n')}
    }
    await reset('Alpha\n\nOmega\n');await caret(1,true);await del('Backspace');if(!mobile)assert.equal(await raw(),'Alpha\n\nOmeg\n');
    await reset('Alpha\n\n:::equation keep-eq\nx^2\n:::\n\nOmega\n');await caret(1,true);await del('Delete');assert((await raw()).includes(':::equation keep-eq'));
    assert.deepEqual(errors,[]);await context.close();
}
async function checkTreeReturn(browser,mobile){
    const state=JSON.parse(JSON.stringify(data.state));
    state.thesis.find(n=>n.id==='demo-method').body=Array.from({length:80},(_,i)=>'Reading paragraph '+i+' with enough text to scroll.').join('\n\n');
    const workspace={id:'tree-return',name:'example.json'},shared={workspace,reading:{},recent:[workspace],state};
    const first=await fixture(browser,mobile,shared),p=first.p;
    const clickTab=async(page,id)=>mobile?page.locator(id).tap():page.locator(id).click();
    const scroll=()=>document.querySelector('.pane.activepane').scrollTop;
    await p.evaluate(()=>select('demo-method'));
    await p.evaluate(()=>{document.querySelector('.pane.activepane').scrollTop=1100});
    const top=await p.evaluate(scroll);assert(top>500);
    await clickTab(p,'#blockTab');
    await p.waitForFunction(()=>view==='blocks'&&panes[active].id===null);
    await p.evaluate(()=>select('demo-note'));
    await clickTab(p,'#treeTab');
    await p.waitForFunction(()=>panes[active].id==='demo-method'&&Math.abs(document.querySelector('.pane.activepane').scrollTop-1100)<30);
    await p.waitForTimeout(1800);
    assert(Math.abs(await p.evaluate(scroll)-top)<30);
    // A switch away immediately after restoration must not overwrite the saved anchor.
    await clickTab(p,'#blockTab');
    await p.waitForTimeout(650);
    assert.equal(shared.reading[workspace.id].panes[0].thesisReading.id,'demo-method');
    const second=await fixture(browser,!mobile,shared);
    await second.p.locator('#treeTab').click();
    await second.p.waitForFunction(()=>panes[active].id==='demo-method'&&document.querySelector('.pane.activepane').scrollTop>500);
    await second.p.waitForTimeout(1800);
    assert.equal(await second.p.evaluate(()=>panes[active].id),'demo-method');
    // Explicit network navigation must still take precedence over the remembered chapter.
    await clickTab(p,'#blockTab');await p.evaluate(()=>select('demo-note'));
    await p.locator('.pane .annotationLocation').click();
    await p.waitForFunction(()=>panes[active].id==='demo-start'&&dialog.open);
    await p.evaluate(()=>closeWorkbenchDialog());
    await clickTab(p,'#blockTab');await clickTab(p,'#treeTab');
    assert.equal(await p.evaluate(()=>panes[active].id),'demo-start');
    assert.deepEqual(first.errors,[]);assert.deepEqual(second.errors,[]);
    await first.context.close();await second.context.close();
}
async function checkAnnotationImages(browser,mobile){
    const {p,context,errors}=await fixture(browser,mobile);
    const original='Note before.\n\n![Legacy image](/assets/demo.png "wb-width:45")\n\n:::figure private-fig\nPrivate figure\n\n![Another image](/assets/demo.png "wb-id:private-sub wb-width:40")\n:::\n\n:::equation private-eq\nx^2\n:::\n\n:::table private-tab\nPrivate table\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n:::\n\nNote after.\n';
    await p.evaluate(raw=>{find('demo-note').body=raw;reindex();select('demo-start')},original);
    assert(await p.evaluate(()=>!resolve('demo-note')&&!['private-fig','private-sub','private-eq','private-tab'].some(id=>resolve(id))));
    const activate=async loc=>mobile?loc.tap():loc.click();
    const note=p.locator('.pane .inlineAnnotation[data-token="[[embed:demo-note]]"]').first();
    const images=p.locator('#dialog .visualImages img');
    await activate(note);await images.first().waitFor();assert.equal(await images.count(),2);
    await activate(images.first());
    await p.waitForFunction(()=>document.querySelector('#dialog .selectedImage img')?.alt==='Legacy image');
    assert.equal(await p.locator('#dialog .selectedImage .resizeHandle').count(),4);
    assert.equal(await p.locator('#dialog .visualNum').count(),0);
    await contextAt(p,images.first());
    assert.equal(await menu(p,'复制交叉引用').count(),0);
    await menu(p,'复制').click();
    await p.waitForFunction(()=>localClipboard?.startsWith(':::subfigure')&&localClipboard.includes('/assets/demo.png'));
    const copied=await p.evaluate(()=>localClipboard);
    await p.evaluate(()=>closeWorkbenchDialog());
    assert.equal(await p.evaluate(()=>find('demo-note').body),original);
    if(mobile)await p.locator('#editModeToggle').tap();
    const area=p.locator('.pane .visualDocument .part-text .richText').first();
    await contextAt(p,area);await menu(p,'粘贴').click();
    await p.waitForFunction(()=>find('demo-start').body.includes('Legacy image'));
    const formal=await p.evaluate(()=>[...targets.values()].find(t=>t.kind==='figure'&&t.body.includes('Legacy image')));
    assert(formal?.number);assert.notEqual(formal.id,'private-fig');
    const formalSub=await p.evaluate(id=>[...targets.values()].find(t=>t.parentId===id),formal.id);
    assert(formalSub?.number);assert(copied.includes(formalSub.id));
    await contextAt(p,p.locator('[data-subfigure="'+formalSub.id+'"] img'));
    assert.equal(await menu(p,'复制交叉引用').count(),1);
    await menu(p,'复制交叉引用').click();
    await p.waitForFunction(id=>localClipboard===`[[ref:${id}]]`,formalSub.id);
    await contextAt(p,p.locator('[data-subfigure="'+formalSub.id+'"] img'));
    assert.equal(await menu(p,'复制交叉引用').count(),1);
    await menu(p,'复制').click();
    await p.waitForFunction(id=>localClipboard?.startsWith(':::subfigure')&&!localClipboard.includes(id),formalSub.id);
    await activate(note);await images.first().waitFor();
    await contextAt(p,p.locator('#dialog .part-text .richText').first());await menu(p,'粘贴').click();
    await p.waitForFunction(()=>document.querySelectorAll('#dialog .visualImages img').length===3);
    await activate(images.first());await p.waitForFunction(()=>!!document.querySelector('#dialog .selectedImage'));
    await p.keyboard.press('Delete');await p.waitForFunction(()=>document.querySelectorAll('#dialog .visualImages img').length===2);
    await p.evaluate(()=>closeWorkbenchDialog());
    const saved=await p.evaluate(()=>find('demo-note').body);assert(saved.includes('wb-id:'));assert(saved.includes('Note before.')&&saved.includes('Note after.'));
    await p.evaluate(()=>{select('demo-note')});
    assert.equal(await p.locator('.pane .visualNum').count(),0);
    assert(await p.evaluate(()=>objectIds(find('demo-note')).every(id=>!resolve(id))));
    assert.deepEqual(errors,[]);await context.close();
}
async function checkAnnotationSelection(browser,mobile){
    const {p,context,errors}=await fixture(browser,mobile);
    const click=async loc=>mobile?loc.tap():loc.click();
    if(mobile)await p.locator('#editModeToggle').tap();
    await p.evaluate(()=>select('demo-start'));
    const marker=id=>p.locator('.pane .inlineAnnotation[data-note-id="'+id+'"]').first();
    const original=marker('demo-note');
    const selected=async loc=>{await click(loc);await p.waitForFunction(()=>!!document.querySelector('.selectedNoteLabel'));assert.equal(await p.locator('#dialog').isVisible(),true);assert.equal(await loc.getAttribute('aria-pressed'),'true');assert.equal(await p.locator('#dialog .noteWindowHandle').getAttribute('aria-pressed'),'true');assert.equal(await p.evaluate(()=>document.activeElement.matches('.noteWindowHandle')),true)};
    const paste=async()=>{await p.evaluate(()=>closeWorkbenchDialog());const area=p.locator('.pane .part-text .richText').nth(1);await area.evaluate(a=>{a.focus();const r=document.createRange();r.selectNodeContents(a);r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r);const data=new DataTransfer();data.setData('text/plain',localClipboard);a.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}))})};
    await selected(original);await p.keyboard.press('Control+C');await p.waitForFunction(()=>localClipboard?.startsWith(ANNOTATION_CLIPBOARD));
    await paste();await p.waitForFunction(()=>db.blocks.length===3);
    const duplicate=await p.evaluate(()=>db.blocks.find(n=>!['demo-note','demo-free'].includes(n.id)).id);
    assert(await p.evaluate(id=>find(id).body===find('demo-note').body&&annotationLocations(find(id)).length===1&&annotationLocations(find('demo-note')).length===1,duplicate));
    await p.evaluate(()=>undo(false));await p.waitForFunction(()=>db.blocks.length===2);
    await selected(original);await p.keyboard.press('Control+X');await p.waitForFunction(()=>!annotationLocations(find('demo-note')).length);
    await paste();await p.waitForFunction(()=>annotationLocations(find('demo-note')).length===1);assert.equal(await p.evaluate(()=>db.blocks.length),2);
    await selected(original);await p.locator('#dialog .richText').first().waitFor({state:'visible'});
    const handle=p.locator('#dialog .noteWindowHandle');await click(handle);await p.waitForFunction(()=>document.querySelector('#dialog .noteWindowHandle.selectedNoteLabel'));
    await p.keyboard.press('Control+C');await p.waitForFunction(()=>annotationClipboardValue(localClipboard)?.id==='demo-note');
    await click(p.locator('#dialog .richText').first());assert.equal(await handle.evaluate(e=>e.classList.contains('selectedNoteLabel')),false);assert.equal(await original.getAttribute('aria-pressed'),'false');await p.keyboard.press('Backspace');assert(await p.evaluate(()=>!!find('demo-note')));
    await click(handle);await p.waitForFunction(()=>document.querySelector('#dialog .noteWindowHandle.selectedNoteLabel'));
    await p.keyboard.press('Delete');await p.waitForFunction(()=>!find('demo-note')&&db.trash.length===1&&!dialog.open);
    await p.evaluate(()=>{const n={...clone(find('demo-free')),id:'test-object-note',file:'blocks/test-object-note.md',title:'Object note',body:'Object note',parent:null,order:db.blocks.length};clearAnnotationPlacement(n);n.objectBindings=[{targetId:'demo-eq'}];db.blocks.push(n);change(true)});
    const object=p.locator('.objectNoteMarker[data-note-id="test-object-note"]');await selected(object);await p.keyboard.press('Delete');await p.waitForFunction(()=>!find('test-object-note'));
    const free=p.locator('.freeNoteMarker[data-note-id="demo-free"]');await selected(free);await p.keyboard.press('Backspace');await p.waitForFunction(()=>!find('demo-free'));
    await p.evaluate(()=>setView('blocks'));assert.equal(await p.locator('.pane h1').innerText(),'批注一览');assert.equal(await p.locator('.graph,.blockNetwork').count(),0);
    assert.equal(await p.evaluate(()=>db.trash.length),3);assert.deepEqual(errors,[]);await context.close();
}
async function checkGroupedUndo(browser,mobile){
    const {p,context,errors}=await fixture(browser,mobile);
    await p.evaluate(()=>{find('demo-start').body='Alpha\n\nBeta\n';select('demo-start',0);if(!editingEnabled)toggleEditMode();undoStack=[];redoStack=[]});
    const area=p.locator('.pane .visualDocument .part-text .richText').first();
    const end=loc=>loc.evaluate(a=>{a.focus();const r=document.createRange();r.selectNodeContents(a.querySelector('p')||a);r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r)});
    const raw=()=>p.evaluate(()=>find('demo-start').body);
    const history=redo=>p.evaluate(redo=>toolbarUndo(redo),redo);
    await end(area);await p.keyboard.type('abc');assert.equal(await raw(),'Alphaabc\n\nBeta\n');
    assert.equal(await p.evaluate(()=>undoStack.length),1);
    await p.waitForTimeout(1100);await p.keyboard.type('def');assert.equal(await p.evaluate(()=>undoStack.length),2);
    await history(false);assert.equal(await raw(),'Alphaabc\n\nBeta\n');await history(false);assert.equal(await raw(),'Alpha\n\nBeta\n');
    await history(true);await history(true);assert.equal(await raw(),'Alphaabcdef\n\nBeta\n');
    await end(area);await p.keyboard.press('Backspace');await p.keyboard.press('Backspace');await p.keyboard.press('Backspace');assert.equal(await raw(),'Alphaabc\n\nBeta\n');
    await history(false);assert.equal(await raw(),'Alphaabcdef\n\nBeta\n');
    await end(area);await p.keyboard.type('X');await p.keyboard.press('ArrowLeft');await p.keyboard.type('Y');
    await history(false);assert.equal(await raw(),'AlphaabcdefX\n\nBeta\n');await history(false);assert.equal(await raw(),'Alphaabcdef\n\nBeta\n');
    await end(area);await p.keyboard.type('q');await end(p.locator('.pane .visualDocument .part-text .richText').nth(1));await p.keyboard.type('r');
    await history(false);assert.equal(await raw(),'Alphaabcdefq\n\nBeta\n');await history(false);assert.equal(await raw(),'Alphaabcdef\n\nBeta\n');
    await end(area);await p.keyboard.type('s');await area.evaluate(a=>{const dt=new DataTransfer();dt.setData('text/plain','PASTE');a.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt}))});await p.keyboard.type('t');
    await history(false);assert.equal(await raw(),'AlphaabcdefsPASTE\n\nBeta\n');await history(false);assert.equal(await raw(),'Alphaabcdefs\n\nBeta\n');await history(false);assert.equal(await raw(),'Alphaabcdef\n\nBeta\n');
    // Model the interim input events of a Chinese IME, including a long pause.
    await end(area);await area.evaluate(a=>{a.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));const node=a.querySelector('p').firstChild;node.appendData('n');a.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'n',isComposing:true}))});
    await p.waitForTimeout(1100);await area.evaluate(a=>{const node=a.querySelector('p').firstChild;node.replaceData(node.length-1,1,'\u4f60');a.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'\u4f60',isComposing:true}));a.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'\u4f60'}))});
    await history(false);assert.equal(await raw(),'Alphaabcdef\n\nBeta\n');await history(true);assert.equal(await raw(),'Alphaabcdef\u4f60\n\nBeta\n');
    await p.evaluate(()=>{select('demo-method',0)});
    const title=p.locator('.pane .editableTitle').first();const originalTitle=await title.inputValue();await title.focus();await title.press('End');await p.keyboard.type('XYZ');await history(false);assert.equal(await title.inputValue(),originalTitle);
    await p.evaluate(()=>{newNode('blocks')});const note=p.locator('#dialog .richText').first();await note.waitFor();await end(note);await p.keyboard.type('note');
    await history(false);assert.equal((await note.innerText()).trim(),'');await history(true);assert.equal((await note.innerText()).trim(),'note');
    assert.deepEqual(errors,[]);await context.close()
}
async function checkHistoryPointDiff(browser,mobile){
    const workspace={...data.state.workspace,history:true};
    const entries=['e','d','c','b','a'].map((x,i)=>({id:x.repeat(40),time:'2026-11-26T10:'+String(10-i*2).padStart(2,'0')+':00Z',source:i===0||i===4?'agent':'editor',message:x,tag:i===0||i===4?{id:x,name:x.toUpperCase()}:null}));
    const versions=Object.fromEntries(entries.map((e,i)=>{const s=structuredClone(data.state);s.thesis[0].body='Version '+e.message.toUpperCase()+'\n';return [e.id,s]}));
    const shared={workspace,state:structuredClone(data.state),reading:{},recent:[],history:entries,versions,historyPageSize:2};
    const {p,context,errors}=await fixture(browser,mobile,shared);
    const open=async()=>{await headerControl(p,'historyButton',mobile?'tap':'click');await p.locator('.historyGroup').first().waitFor()};
    const close=()=>p.evaluate(()=>closeHistoricalVersion());
    const diff=(old,now)=>p.waitForFunction(([old,now])=>{const h=panes[1]?.history;return h?.entry.message===now&&h.comparison?.entry?.message===old&&document.querySelector('.historyPageDiff')?.textContent.includes('Version')},[old,now]);
    await open();await p.locator('.historyRow.named .historyTitle').first().click();await diff('d','e');await close();
    await open();await p.locator('.historyGroupTitle').click();await diff('a','d');
    assert((await p.locator('.historyPageDiff .historyRemoved').allTextContents()).join('').includes('A'));
    assert((await p.locator('.historyPageDiff .historyAdded').allTextContents()).join('').includes('D'));
    await p.evaluate(()=>{find('demo-start').body='Live edit';change(false)});
    assert(!(await p.locator('.historyPageDiff').textContent()).includes('Live edit'));await close();
    await open();await p.evaluate(()=>{document.querySelector('.historyGroup').open=true});await p.locator('.historyGroup .historyTitle').first().click();await diff('c','d');await close();
    await open();await p.evaluate(()=>{document.querySelector('.historyGroup').open=true});await p.locator('.historyGroup .historyRow').first().locator('.historyMore').click();await menu(p,'查看差异').click();
    await p.waitForFunction(()=>panes[1]?.history?.entry.message==='d'&&!panes[1].history.comparison);assert.match((await p.locator('.historyPageDiff .historyAdded').allTextContents()).join(' '),/Live\s+edit/);
    await close();await open();await p.getByRole('button',{name:'加载更多',exact:true}).click();await p.getByRole('button',{name:'加载更多',exact:true}).click();await p.locator('.historyRow.named .historyTitle').last().click();
    await p.waitForFunction(()=>panes[1]?.history?.entry.message==='a'&&panes[1].history.comparison?.entry===null);assert((await p.locator('.historyPageDiff .historyAdded').allTextContents()).join('').includes('Version A'));
    assert.deepEqual(errors,[]);await context.close()
}
async function checkCloseSecondPane(browser,mobile){
    const {p,context,errors}=await fixture(browser,mobile);
    await p.evaluate(()=>select('demo-start',0));
    await headerControl(p,'dual',mobile?'tap':'click');
    await p.evaluate(()=>select('demo-method',1));
    const close=p.locator('#panes > .pane').nth(1).getByRole('button',{name:'关闭本页',exact:true});
    assert.equal(await p.locator('#panes > .pane').first().locator('.closeSecondPane').count(),0);
    await close[mobile?'tap':'click']();
    assert.equal(await p.locator('#panes > .pane').count(),1);
    assert(await p.evaluate(()=>panes.length===1&&active===0&&panes[0].id==='demo-start'));
    await headerControl(p,'dual',mobile?'tap':'click');await close[mobile?'tap':'click']();
    assert.equal(await p.locator('#panes > .pane').count(),1);assert.deepEqual(errors,[]);await context.close()
}
async function run(){
    const executablePath=process.env.PAPEREDITER_CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined);
    const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
    try{
        if(process.argv.includes('--close-second-pane-only')){await checkCloseSecondPane(browser,false);await checkCloseSecondPane(browser,true);console.log('PASS: close only secondary pane on desktop/mobile, retain primary selection');return}
        if(process.argv.includes('--grouped-undo-only')){await checkGroupedUndo(browser,false);await checkGroupedUndo(browser,true);console.log('PASS: grouped typing, deletion, pauses, caret movement, paragraph, paste, IME, title, note undo and redo on desktop/mobile');return}
        if(process.argv.includes('--history-point-only')){await checkHistoryPointDiff(browser,false);await checkHistoryPointDiff(browser,true);console.log('PASS: previous point, folded group across pagination, expanded row, initial version and live comparison on desktop/mobile');return}
        if(process.argv.includes('--figure-rows-only')){
            for(const mobile of [false,true]){
                const {p,context,errors}=await fixture(browser,mobile);
                const source=':::figure row-fig\nCaption\n\n![A](/assets/demo.png "wb-id:row-a")\n\n![B](/assets/demo.png "wb-id:row-b") ![C](/assets/demo.png "wb-id:row-c")\n:::';
                await p.evaluate(source=>{find('demo-start').body=source;select('demo-start',0);if(!editingEnabled)toggleEditMode()},source);
                const fig=p.locator('.pane [data-object="row-fig"]'),rows=fig.locator('.figureImageRow'),images=fig.locator('.resizeImage');
                const shape=()=>rows.evaluateAll(rs=>rs.map(r=>[...r.querySelectorAll('.resizeImage')].map(w=>w.dataset.subfigure)));
                const click=loc=>mobile?loc.tap():loc.click();
                assert.deepEqual(await shape(),[['row-a'],['row-b','row-c']]);
                await click(fig.locator('.figureRowBreak'));
                await p.keyboard.press('Backspace');
                assert.deepEqual(await shape(),[['row-a','row-b','row-c']]);
                const boxes=await images.evaluateAll(ws=>ws.map(w=>({x:w.offsetLeft,y:w.offsetTop,width:w.offsetWidth})));
                assert(boxes.every(b=>b.y===boxes[0].y&&b.width>0)&&boxes[2].x>boxes[1].x&&boxes[1].x>boxes[0].x);
                await click(fig.locator('.figureImageGap[data-slot="1"]'));await p.keyboard.press('Enter');
                assert.deepEqual(await shape(),[['row-a'],['row-b','row-c']]);
                await click(fig.locator('.figureRowBreak'));await p.keyboard.press('Delete');
                assert.deepEqual(await shape(),[['row-a','row-b','row-c']]);
                if(!mobile){
                    const a=fig.locator('[data-subfigure="row-a"] img'),c=fig.locator('[data-subfigure="row-c"] img');
                    await a.scrollIntoViewIfNeeded();const ab=await a.boundingBox(),cb=await c.boundingBox();
                    await p.mouse.move(ab.x+ab.width/2,ab.y+ab.height/2);await p.mouse.down();await p.mouse.move(cb.x+cb.width-2,cb.y+cb.height/2,{steps:12});await p.mouse.up();
                    assert.deepEqual(await shape(),[['row-b','row-c','row-a']]);
                }
                const b=fig.locator('[data-subfigure="row-b"]');
                const widths=()=>images.evaluateAll(ws=>Object.fromEntries(ws.map(w=>[w.dataset.subfigure,w.offsetWidth])));
                const before=await widths();
                const resize=async dx=>{
                    await click(b.locator('img'));const h=b.locator('.resizeHandle.se'),hb=await h.boundingBox(),x=hb.x+hb.width/2,y=hb.y+hb.height/2;
                    if(mobile){
                        const cdp=await context.newCDPSession(p);
                        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
                        for(let i=1;i<=8;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+dx*i/8,y}]});
                        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach()
                    }else{
                        await p.mouse.move(x,y);await p.mouse.down();await p.mouse.move(x+dx,y,{steps:8});await p.mouse.up()
                    }
                };
                await resize(-30);const smaller=await widths();
                assert(smaller['row-b']<before['row-b']);
                for(const id of ['row-a','row-c'])assert.equal(smaller[id],before[id]);
                const siblingSource=()=>p.evaluate(()=>[...find('demo-start').body.matchAll(figureImagePattern())].filter(m=>!m[3].includes('row-b')).map(m=>m[0]));
                const siblingsBefore=await siblingSource();
                await resize(15);const bigger=await widths();
                assert(bigger['row-b']>smaller['row-b'],JSON.stringify({mobile,before,smaller,bigger,source:await p.evaluate(()=>find('demo-start').body)}));
                for(const id of ['row-a','row-c'])assert.equal(bigger[id],before[id]);
                assert.deepEqual(await siblingSource(),siblingsBefore);
                await resize(100);const capped=await widths();
                for(const id of ['row-a','row-c'])assert.equal(capped[id],before[id]);
                assert(Math.abs(capped['row-b']-before['row-b'])<=1);
                const saved=await p.evaluate(()=>find('demo-start').body);
                await p.evaluate(()=>renderPanes());assert.equal(await rows.count(),1);
                assert.equal(await p.evaluate(()=>find('demo-start').body),saved);
                assert.deepEqual(await widths(),capped);
                const historical=await p.evaluate(()=>{const part=visualParts(find('demo-start').body)[0],h=historyRenderedPart(part);return [...h.querySelectorAll('.figureImageRow')].map(r=>[...r.children].map(w=>w.dataset.subfigure))});
                assert.deepEqual(historical,await shape());
                await p.waitForFunction(()=>!document.querySelector('.pane.activepane')?._restoringReading);
                await images.first().locator('img').scrollIntoViewIfNeeded();
                await click(images.first().locator('img'));
                assert(await images.first().evaluate(w=>w.classList.contains('selectedImage')),JSON.stringify({mobile,state:await p.evaluate(()=>({focus:document.activeElement?.className,dialog:dialog.open,editing:editingEnabled,selection:document.querySelector('.selectedImage')?.dataset.subfigure,menu:!$('menu').hidden}))}));
                await p.keyboard.press('Delete');
                assert.equal(await images.count(),2,JSON.stringify({mobile,focus:await p.evaluate(()=>document.activeElement?.className),editing:await p.evaluate(()=>editingEnabled)}));
                assert.deepEqual(errors,[]);await context.close();
            }
            console.log('PASS: figure rows, break insertion/deletion, drag reorder, resize, persistence, history, mobile and single-image deletion');return
        }
        if(process.argv.includes('--viewport-lines-only')){
            for(const mobile of [false,true]){
                const {p,context,errors}=await fixture(browser,mobile);
                const owner='demo-method';
                const prose='A long paragraph with words and inline **formatting** and $x^2$ that wraps naturally. '.repeat(18);
                const next=prose+'\n\n:::equation eq-viewport\nx^2\n:::\n\nLast paragraph.\n';
                const old='Removed paragraph that must not consume a number.\n\n'+prose.replace('A long paragraph','A shorter paragraph')+'\n\n:::equation eq-viewport\nx\n:::\n\nLast paragraph.\n';
                await p.evaluate(({owner,next,old})=>{
                    find(owner).body=next;select(owner,0);
                    const past=structuredClone(db);past.thesis.find(n=>n.id===owner).body=old;
                    openHistoricalVersion({id:'d'.repeat(40),time:'2026-11-26T10:00:00Z',message:'Example'},past,null,'diff')
                },{owner,next,old});
                const read=()=>p.evaluate(owner=>[...document.querySelectorAll('#panes > .pane')].map(pane=>[...pane.querySelectorAll(`.viewportLineNumber[data-viewport-owner="${owner}"]`)].map(n=>n.dataset.viewportLine).flatMap(s=>s.split(',')).filter(s=>s!=='–').map(Number)),owner);
                await p.waitForFunction(owner=>document.querySelectorAll(`.historicalPane .viewportLineNumber[data-viewport-owner="${owner}"]`).length>4,owner);
                let [left,right]=await read();assert(left.length>4);assert.deepEqual(right,left);assert.deepEqual(left,Array.from({length:left.length},(_,i)=>i+1));
                assert(await p.locator('.historicalPane .viewportLineNumber[data-viewport-line="–"]').count()>0);
                if(!mobile){
                    const nav=p.locator('#sidebar'),navHandle=p.locator('#navSplitHandle'),paneHandle=p.locator('#paneSplitHandle');
                    const widths=()=>p.evaluate(()=>[document.querySelector('#sidebar').clientWidth,...[...document.querySelectorAll('#panes > .pane')].map(e=>e.clientWidth)]);
                    async function drag(handle,dx){const r=await handle.boundingBox();assert(r);await p.mouse.move(r.x+r.width/2,r.y+r.height/2);await p.mouse.down();await p.mouse.move(r.x+r.width/2+dx,r.y+r.height/2,{steps:5});await p.mouse.up()}
                    const original=await widths();await drag(navHandle,80);let sized=await widths();assert(sized[0]>original[0]+65);assert(sized[1]<original[1]);
                    await drag(paneHandle,100);let split=await widths();assert(split[1]>sized[1]+85);assert(split[2]<sized[2]-85);assert.equal(split[0],sized[0]);
                    await p.waitForFunction(owner=>{const a=[...document.querySelectorAll('#panes > .pane')].map(pane=>[...pane.querySelectorAll(`.viewportLineNumber[data-viewport-owner="${owner}"]`)].flatMap(n=>n.dataset.viewportLine.split(',')).filter(n=>n!=='–'));return a[0].length>4&&a[0].join(',')===a[1].join(',')},owner);
                    [left,right]=await read();assert.deepEqual(left,right);
                    const stored=await p.evaluate(()=>JSON.parse(localStorage.getItem('wb:split-widths:v1')));assert(stored.nav>350&&stored.pane>.5);
                    await p.evaluate(()=>renderPanes());await p.waitForFunction(()=>!document.getElementById('paneSplitHandle').hidden);assert.deepEqual(await widths(),split);
                    assert(await nav.isVisible());
                }else{assert(!await p.locator('#navSplitHandle').isVisible());assert(!await p.locator('#paneSplitHandle').isVisible())}
                if(mobile)await p.getByRole('button',{name:'切换 首页',exact:true}).tap();
                const pane=p.locator('#panes > .pane').first();await pane.evaluate(e=>{e.scrollTop=e.scrollHeight});
                assert.deepEqual((await read())[0],left);
                await p.evaluate(()=>{select('demo-start',0);select('demo-method',0)});
                await p.waitForFunction(owner=>document.querySelectorAll(`.pane:not(.historicalPane) .viewportLineNumber[data-viewport-owner="${owner}"]`).length>4,owner);
                assert.deepEqual((await read())[0],left);
                assert.equal(await p.evaluate(()=>document.querySelector('.visualDocument').contains(document.querySelector('.viewportLineGutter'))),false);
                assert.deepEqual(errors,[]);await context.close();
            }
            console.log('PASS: desktop/mobile viewport lines, current-version diff mapping, deletion, wrapping, page switch and scroll');return;
        }
        if(process.argv.includes('--theme-only')){
            for(const mobile of [false,true]){
                const {p,context,errors}=await fixture(browser,mobile);
                await p.emulateMedia({colorScheme:'light'});
                await p.waitForFunction(()=>document.documentElement.dataset.theme==='light');
                const before=await p.evaluate(()=>find('demo-start').body);
                await headerControl(p,'themeToggle');
                assert.equal(await p.locator('html').getAttribute('data-theme'),'dark');
                assert.equal(await p.locator('body').getAttribute('theme'),'dark');
                assert.equal(await p.locator('header').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(30, 34, 39)');
                assert.equal(await p.locator('.pane').first().evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(30, 34, 39)');
                assert.equal(await p.locator('body').evaluate(e=>getComputedStyle(e).color),'rgb(225, 230, 237)');
                assert.equal(await p.locator('meta[name="theme-color"]').getAttribute('content'),'#1e2227');
                await p.evaluate(()=>select('demo-start',0));
                await p.locator('.pane .inlineAnnotation').first().click();
                assert.equal(await p.locator('#dialog').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(30, 34, 39)');
                await p.reload();await p.waitForFunction(()=>typeof db!=='undefined'&&db?.thesis?.length===2);
                assert.equal(await p.locator('html').getAttribute('data-theme'),'dark');
                assert.equal(await p.evaluate(()=>find('demo-start').body),before);
                await headerControl(p,'themeToggle');
                assert.equal(await p.locator('html').getAttribute('data-theme'),'light');
                assert.equal(await p.locator('header').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(255, 255, 255)');
                await p.emulateMedia({colorScheme:'dark'});
                assert.equal(await p.locator('html').getAttribute('data-theme'),'light');
                await p.evaluate(()=>localStorage.removeItem('wb:theme'));
                await p.reload();await p.waitForFunction(()=>typeof db!=='undefined'&&db?.thesis?.length===2);
                assert.equal(await p.locator('html').getAttribute('data-theme'),'dark');
                assert.deepEqual(errors,[]);await context.close();
            }
            console.log('PASS: theme desktop/mobile, note surfaces, persistence, system default and unchanged document');return;
        }
        if(process.argv.includes('--view-note-only')){
            for(const mobile of [true,false]){
                const {p,context,errors}=await fixture(browser,mobile);
                await p.evaluate(()=>{if(editingEnabled)toggleEditMode();if(!floatingToolsEnabled)toggleFloatingTools();select('demo-start',0)});
                const target=p.locator('.pane .part-text .richText').first();
                const tool=name=>p.locator(`#floatingTools [data-tool="${name}"]`);
                const original=await p.evaluate(()=>find('demo-start').body);
                assert.equal(await target.getAttribute('contenteditable'),'false');
                await p.locator('.pane .inlineAnnotation').first().click();
                const noteId=await p.evaluate(()=>dialog._noteId);
                const note=p.locator('#dialog .part-text .richText').first();
                assert.equal(await note.getAttribute('contenteditable'),'true');
                await note.fill('Edited in view mode');
                await note.press('Enter');
                await p.waitForFunction(id=>!dialog.open&&find(id).body.includes('Edited in view mode'),noteId);
                assert.equal(await p.evaluate(()=>find('demo-start').body),original);
                await target.evaluate(a=>{const r=document.createRange(),t=a.querySelector('p').firstChild;r.setStart(t,0);r.setEnd(t,9);getSelection().removeAllRanges();getSelection().addRange(r);scheduleToolbarUpdate()});
                await p.waitForFunction(()=>document.querySelector('#floatingTools [data-tool="新建批注"]').getAttribute('aria-disabled')==='false');
                assert.equal(await tool('剪切').getAttribute('aria-disabled'),'true');
                await tool('新建批注').click();
                const fresh=p.locator('#dialog .part-text .richText').first();
                await fresh.fill('New in view mode');await fresh.press('Enter');
                await p.waitForFunction(()=>!dialog.open&&db.blocks.some(n=>n.body.includes('New in view mode')));
                const created=await p.evaluate(()=>db.blocks.find(n=>n.body.includes('New in view mode')));
                assert.equal(created.annotation.quote,'A fiction');
                assert((await p.evaluate(()=>find('demo-start').body)).includes('[[embed:'+created.id+']]'));
                assert.equal(await p.evaluate(()=>editingEnabled),false);
                assert.equal(await target.getAttribute('contenteditable'),'false');
                await p.waitForFunction(()=>!dirty&&!saving);
                await p.evaluate(id=>{setView('blocks');select(id,0)},created.id);
                const pageNote=p.locator('.pane.activepane .richText').first();
                assert.equal(await pageNote.getAttribute('contenteditable'),'true');
                await pageNote.fill('Edited from annotation list');
                await p.waitForFunction(id=>find(id).body.includes('Edited from annotation list'),created.id);
                assert.equal(await p.evaluate(()=>editingEnabled),false);
                assert.deepEqual(errors,[]);await context.close();
            }
            console.log('PASS: view mode creates bound annotations and edits popups and annotation pages without unlocking thesis');return
        }
        if(process.argv.includes('--mobile-status-only')){
            for(const width of [320,390,600])for(const history of [false,true]){
                const {p,context,errors}=await fixture(browser,true);
                await p.setViewportSize({width,height:844});
                await p.evaluate(enabled=>{
                    document.body.classList.toggle('historyEnabled',enabled);
                    document.querySelector('#saveVersion').hidden=!enabled;document.querySelector('#historyButton').hidden=!enabled;
                    const status=document.querySelector('#status');
                    status.textContent='保存失败：版本冲突，请重新加载并合并其他设备的修改后再试。';
                },history);
                await p.evaluate(()=>{workspaceChanged=false;dirty=false;conflict=false;syncStatus()});
                await p.waitForFunction(()=>document.querySelector('#status').textContent==='已同步');
                assert(await p.locator('#status').isVisible());
                assert(await p.locator('#headerMorePanel').isHidden());
                const states=await p.evaluate(()=>['已加载','已同步','待保存','保存中','已保存','已保存版本','保存冲突'].map(value=>{
                    status(value);
                    const e=document.querySelector('#status'),r=e.getBoundingClientRect(),name=document.querySelector('#workspaceName').getBoundingClientRect(),h=document.querySelector('header').getBoundingClientRect();
                    return {value,fits:e.scrollWidth<=e.clientWidth+1,visible:r.width>0&&r.height>0&&r.top>=name.bottom&&r.bottom<=h.bottom};
                }));
                assert(states.every(s=>s.fits&&s.visible),JSON.stringify(states));
                await p.evaluate(()=>{conflict=true;syncStatus()});
                await p.waitForFunction(()=>document.querySelector('#status').textContent==='保存冲突 · 点击刷新处理');
                await p.evaluate(()=>{document.querySelector('#status').textContent='保存失败：版本冲突，请重新加载并合并其他设备的修改后再试。'});
                assert(await p.locator('#headerMore').evaluate(e=>e.classList.contains('statusError')));
                assert(await p.locator('#status').isVisible());
                assert(await p.locator('header > button:visible,header nav button:visible,header #workspaceName').evaluateAll(nodes=>nodes.every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1})));
                await p.locator('#headerMore').tap();
                const metrics=await p.evaluate(()=>{
                    const status=document.querySelector('#headerStatusDetail'),r=status.getBoundingClientRect(),h=document.querySelector('header').getBoundingClientRect();
                    const controls=[...document.querySelectorAll('header button')].map(x=>x.getBoundingClientRect()).filter(x=>x.width&&x.height);
                    return {width:innerWidth,status:{left:r.left,right:r.right,top:r.top,bottom:r.bottom,scrollWidth:status.scrollWidth,clientWidth:status.clientWidth},header:h.height,layout:document.querySelector('#layout').getBoundingClientRect().top,aside:getComputedStyle(document.querySelector('aside')).top,controls:controls.map(x=>({left:x.left,right:x.right,top:x.top,bottom:x.bottom})),display:getComputedStyle(status).display};
                });
                assert.notEqual(metrics.display,'none',`${width}px history=${history}`);
                assert(metrics.status.left>=0&&metrics.status.right<=width,JSON.stringify(metrics));
                assert(metrics.status.scrollWidth<=metrics.status.clientWidth+1,JSON.stringify(metrics));
                assert(metrics.controls.every(c=>c.bottom<=metrics.status.top||c.top>=metrics.status.bottom||c.right<=metrics.status.left||c.left>=metrics.status.right),JSON.stringify(metrics));
                assert.equal(metrics.layout,metrics.header);
                assert.equal(Number.parseFloat(metrics.aside),metrics.header);
                assert.equal(metrics.header,54);
                assert.equal(await p.locator('#headerStatusDetail').innerText(),await p.locator('#status').innerText());
                assert(await p.locator('#openWorkspace').isVisible());
                assert.equal(await p.locator('#historyButton').isVisible(),history);
                await p.keyboard.press('Escape');assert(!await p.locator('#headerMorePanel').isVisible());
                await p.locator('#headerMore').tap();
                await p.locator('#workspaceName').tap();assert(!await p.locator('#headerMorePanel').isVisible());
                if(width===320&&history){
                    await p.evaluate(()=>document.body.classList.add('fullscreenHeaderHidden'));
                    const hidden=await p.evaluate(()=>({top:document.querySelector('#layout').getBoundingClientRect().top,height:document.querySelector('#layout').getBoundingClientRect().height,aside:getComputedStyle(document.querySelector('aside')).top}));
                    assert.equal(hidden.top,0);assert.equal(hidden.height,844);assert.equal(Number.parseFloat(hidden.aside),0,JSON.stringify(hidden));
                    await p.evaluate(()=>document.body.classList.remove('fullscreenHeaderHidden'));
                    assert.equal(await p.locator('#layout').evaluate(e=>e.getBoundingClientRect().top),54);
                }
                assert.deepEqual(errors,[]);await context.close();
            }
            const {p,context,errors}=await fixture(browser,false);
            assert(await p.locator('header > #status').isVisible());
            await p.setViewportSize({width:390,height:844});
            await p.locator('#headerIdentity > #status').waitFor({state:'visible'});
            await p.setViewportSize({width:1280,height:900});
            await p.locator('header > #status').waitFor({state:'visible'});
            await p.locator('#headerActions').click();
            assert.equal(await p.locator('#floatingTools [aria-label="复制交叉引用"]').count(),0);
            assert.deepEqual(errors,[]);await context.close();
            console.log('PASS: mobile status visibility and header offsets at 320/390/600px, with and without history; floating toolbar omits cross-reference');return
        }
        if(process.argv.includes('--selection-toolbar-only')){
            const {p,context,errors}=await fixture(browser,true);
            await p.evaluate(()=>{find('demo-start').body=find('demo-start').body.replace('A fictional example','Alpha beta gamma');reindex();select('demo-start')});
            const area=p.locator('.pane .part-text .richText').first(),more=p.locator('#toolbarMore');
            const cdp=await context.newCDPSession(p);
            const point=await area.evaluate(a=>{const t=a.querySelector('p').firstChild,r=document.createRange();r.setStart(t,2);r.collapse(true);const b=r.getBoundingClientRect();return {x:b.x,y:b.y+b.height/2}});
            await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
            await p.locator('.rangeEnd:visible').waitFor();
            await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
            await p.waitForTimeout(600);
            assert(!(await p.locator('#menu').isVisible()));
            assert.equal(await more.getAttribute('aria-disabled'),'true');
            await p.locator('#floatingTools [data-tool="复制"]').tap();
            await p.waitForFunction(()=>localClipboard==='Alpha');
            await p.locator('#editModeToggle').tap();
            const caret=()=>area.evaluate(a=>{a.closest('.visualDocument')._clearMixed();a.focus();const t=a.querySelector('p').firstChild,r=document.createRange();r.setStart(t,1);r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r);scheduleToolbarUpdate()});
            await caret();
            await p.waitForFunction(()=>document.querySelector('#toolbarMore').getAttribute('aria-disabled')==='false');
            await more.tap();await p.locator('#menu').waitFor({state:'visible'});
            assert.deepEqual(await p.locator('#menu button').allTextContents(),['添加公式','添加独立公式','插入交叉引用']);
            const n=await area.locator('math-field').count();
            await menu(p,'添加公式').tap();assert.equal(await area.locator('math-field').count(),n+1);
            await caret();await more.tap();await menu(p,'添加独立公式').tap();
            assert.equal(await p.locator('.pane .part-equation').count(),2);
            await caret();await more.tap();await menu(p,'插入交叉引用').tap();
            await p.locator('#dialog .visualPickList button').filter({hasText:'Example measurements'}).tap();
            await p.waitForFunction(()=>find('demo-start').body.includes('[[ref:demo-table]]'));
            assert.deepEqual(errors,[]);await context.close();
            console.log('PASS: touch selection without popup, copy in view mode, toolbar more and all three insertion actions');return
        }
        if(process.argv.includes('--toolbar-zoom-only')){
            for(const screenWidth of [320,390,414,0]){
                const mobile=!!screenWidth;
                const {p,context,errors}=await fixture(browser,mobile);
                if(mobile)await p.setViewportSize({width:screenWidth,height:844});
                await p.evaluate(()=>select('demo-start'));
                const bar=p.locator('#floatingTools');
                if(!await bar.isVisible())await p.locator('#headerActions').click();
                if(mobile)await p.waitForFunction(w=>Math.abs(visualViewport.width-w)<1,screenWidth);
                await p.evaluate(()=>positionFloatingTools());
                const cdp=await context.newCDPSession(p);
                const measure=()=>p.evaluate(()=>{
                    const v=visualViewport,b=document.querySelector('#floatingTools'),r=b.getBoundingClientRect(),button=b.querySelector('button').getBoundingClientRect();
                    return {scale:v.scale,width:r.width*v.scale,height:r.height*v.scale,buttonWidth:button.width*v.scale,buttonHeight:button.height*v.scale,rows:new Set([...b.querySelectorAll('button')].map(b=>b.offsetTop)).size,bottom:(v.offsetTop+v.height-r.bottom)*v.scale,center:(r.left+r.width/2-v.offsetLeft-v.width/2)*v.scale,transform:b.style.transform};
                });
                const initial=await measure();
                if(mobile){
                    for(const scale of [2,3,5,1]){
                        await cdp.send('Emulation.setPageScaleFactor',{pageScaleFactor:scale});
                        await p.waitForFunction(s=>Math.abs(visualViewport.scale-s)<.01&&Math.abs(document.querySelector('#floatingTools').getBoundingClientRect().height*visualViewport.scale-document.querySelector('#floatingTools').offsetHeight)<1,scale);
                        // A far-right viewport offset can leave the previous fixed left near the
                        // layout viewport edge. It must not constrain the next toolbar layout.
                        if(scale>1)await p.evaluate(()=>{const b=document.querySelector('#floatingTools');b.style.left=(innerWidth-40)+'px';positionFloatingTools();positionFloatingTools()});
                        const result=await measure();
                        for(const k of ['width','height','buttonWidth','buttonHeight','bottom','center'])assert(Math.abs(result[k]-initial[k])<2,JSON.stringify({screenWidth,k,initial,result}));
                        assert.equal(result.rows,initial.rows,JSON.stringify({screenWidth,initial,result}));
                        const hit=await p.evaluate(()=>{const r=document.querySelector('#editModeToggle').getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')?.id});
                        assert.equal(hit,'editModeToggle');
                    }
                }else assert.equal(initial.transform,'');
                assert.deepEqual(errors,[]);await context.close();
            }
            console.log('PASS: mobile toolbar dimensions, rows, screen position and hit target at 1x/2x/3x/5x on 320/390/414px screens; desktop unchanged');return
        }
        if(process.argv.includes('--math-clipboard-only')){
            const {p,context,errors}=await fixture(browser);
            await p.evaluate(()=>select('demo-start'));
            const source=p.locator('[data-object="demo-eq"] math-field');
            const area=p.locator('.pane .part-text .richText').first();
            const fragment='\\frac{a}{b}';
            await source.evaluate((f,tex)=>{
                f.focus();f.value='x+'+tex+'+y';
                f.dispatchEvent(new Event('input',{bubbles:true}));
                for(let i=0;i<f.lastOffset;i++)for(let j=i+1;j<=f.lastOffset;j++){
                    if(f.getValue([i,j],'latex')===tex){f.selection={ranges:[[i,j]],direction:'forward'};return}
                }
                throw Error('No matching formula fragment');
            },fragment);
            assert.equal(await source.evaluate(f=>f.getValue(f.selection,'latex')),fragment);
            await p.keyboard.press('Control+c');
            assert.match(await p.evaluate(()=>navigator.clipboard.readText()),/\\frac\{a\}\{b\}/);
            const setCaret=()=>area.evaluate(a=>{a.focus();const t=a.querySelector('p').firstChild,r=document.createRange();r.setStart(t,2);r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r)});
            await setCaret();
            await p.keyboard.press('Control+v');
            const inline=area.locator('math-field');
            await inline.waitFor();
            assert.equal(await inline.evaluate(f=>f.value),fragment);
            assert.equal(await p.evaluate(()=>document.activeElement.classList.contains('richText')),true);
            assert.match(await p.evaluate(()=>find('demo-start').body),/^A \$\\frac\{a\}\{b\}\$fictional example/);
            // Native paste into another formula keeps the selected fraction.
            const other=p.locator('.pane .part-text math-field').last();
            await other.click();
            await other.evaluate(f=>f.executeCommand('selectAll'));
            assert.equal(await other.evaluate(f=>document.activeElement===f),true);
            await p.keyboard.press('Control+v');
            assert.equal(await other.evaluate(f=>f.value),fragment);
            // Right-click copy uses the same recognizable fallback format.
            await inline.click();
            await inline.evaluate(f=>f.executeCommand('selectAll'));
            await contextAt(p,inline);await menu(p,'复制').click();
            assert.equal(await p.evaluate(()=>navigator.clipboard.readText()),'$$ '+fragment+' $$');
            await setCaret();await contextAt(p,area);await menu(p,'粘贴').click();
            await p.waitForFunction(()=>document.querySelector('.pane .part-text .richText').querySelectorAll('math-field').length===2);
            await other.click();await other.evaluate(f=>{f.value='w';f.dispatchEvent(new Event('input',{bubbles:true}));f.executeCommand('selectAll')});
            const eqCount=await p.locator('.pane .part-equation').count();
            await contextAt(p,other);await menu(p,'粘贴').click();
            await p.waitForFunction(tex=>[...document.querySelectorAll('.pane .part-text math-field')].at(-1)?.value===tex,fragment);
            assert.equal(await other.evaluate(f=>f.value),fragment);
            assert.equal(await p.locator('.pane .part-equation').count(),eqCount);
            const doc=area.locator('xpath=ancestor::div[contains(@class,"visualDocument")]').first();
            await doc.evaluate(d=>{d.focus();getSelection().removeAllRanges()});
            await p.keyboard.press('Control+v');
            const newEq=p.locator('.pane .part-equation:not([data-object="demo-eq"])');
            await newEq.waitFor();
            assert.equal(await newEq.locator('math-field').evaluate(f=>f.value),fragment);
            assert.notEqual(await newEq.getAttribute('data-object'),'demo-eq');
            // Typed MIME can identify math even when plain text has no delimiters.
            await setCaret();
            await area.evaluate(a=>{const d=new DataTransfer();d.setData('application/x-latex','z^2');d.setData('text/plain','z^2');a.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:d}))});
            assert.equal(await area.locator('math-field').first().evaluate(f=>f.value),'z^2');
            // The same unmarked prose must still be treated as ordinary text.
            await setCaret();
            await area.evaluate(a=>{const d=new DataTransfer();d.setData('text/plain','ordinary text');a.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:d}))});
            assert.equal(await area.locator('math-field').count(),3);
            assert.match(await area.innerText(),/ordinary text/);
            assert.deepEqual(errors,[]);await context.close();
            const mobile=await fixture(browser,true),q=mobile.p;
            await q.evaluate(()=>{select('demo-start');if(!editingEnabled)toggleEditMode()});
            const mf=q.locator('[data-object="demo-eq"] math-field');
            await mf.tap();await mf.evaluate(f=>{f.selection={ranges:[[0,1]],direction:'forward'}});
            const selected=await mf.evaluate(f=>f.getValue(f.selection,'latex'));
            assert.ok(selected&&selected!=='E=mc^2');
            await q.locator('#floatingTools [data-tool="复制"]').tap();
            await q.waitForFunction(tex=>localClipboard==='$$ '+tex+' $$',selected);
            const dest=q.locator('.pane .part-text .richText').first();
            await dest.tap();
            await dest.evaluate(a=>{a.focus();const r=document.createRange();r.selectNodeContents(a.querySelector('p'));r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r)});
            await q.locator('#floatingTools [data-tool="粘贴"]').tap();
            await dest.locator('math-field').waitFor();
            assert.equal(await dest.locator('math-field').evaluate(f=>f.value),selected);
            assert.deepEqual(mobile.errors,[]);await mobile.context.close();
            console.log('PASS: selected formula fragment, native copy/paste to prose and math, context-menu copy/paste, independent equation, typed LaTeX and ordinary text');return
        }
        if(process.argv.includes('--math-only')){
            const {p,context,errors}=await fixture(browser);
            await p.evaluate(()=>select('demo-start'));
            const area=p.locator('.pane .part-text .richText').first();
            await area.click();
            await p.evaluate(()=>{const a=document.activeElement,r=document.createRange();r.selectNodeContents(a);r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r)});
            const count=await area.locator('math-field').count();
            await p.keyboard.press('Alt+Equal');
            assert.equal(await area.locator('math-field').count(),count+1);
            const field=area.locator('math-field').last();
            await p.locator('.mathPalette').waitFor({state:'visible'});
            await p.keyboard.press('a');await p.keyboard.press('Slash');await p.keyboard.press('b');
            assert.match(await field.evaluate(f=>f.value),/\\frac\{a\}\{b\}/);
            await p.keyboard.press('ArrowRight');
            await p.keyboard.press('ArrowRight');
            await p.waitForFunction(()=>document.activeElement?.classList.contains('richText'));
            await p.keyboard.type(' after');
            assert.match(await p.evaluate(()=>find('demo-start').body),/after/);
            await contextAt(p,area);
            await menu(p,'添加独立公式').click();
            const eq=p.locator('.pane .part-equation:not([data-object="demo-eq"])');
            const eqField=eq.locator('math-field');
            await p.locator('.mathPalette').getByRole('button',{name:'根号',exact:true}).click();
            await p.keyboard.type('x');
            assert.equal(await eqField.evaluate(f=>f.value),'\\sqrt{x}');
            await p.keyboard.press('Escape');
            assert.equal(await eq.evaluate(c=>c.classList.contains('selectedObject')),true);
            await p.keyboard.press('Delete');
            assert.equal(await eq.count(),0);
            assert.equal(await p.locator('.pane .part-equation').count(),1);
            assert.deepEqual(errors,[]);await context.close();
            const mobile=await fixture(browser,true);
            await mobile.p.evaluate(()=>{select('demo-start');if(!editingEnabled)toggleEditMode()});
            await mobile.p.locator('.pane .part-text math-field').first().tap();
            await mobile.p.locator('.mathPalette').waitFor({state:'visible'});
            await mobile.p.waitForFunction(()=>window.mathVirtualKeyboard.visible);
            assert.deepEqual(mobile.errors,[]);await mobile.context.close();
            console.log('PASS: formula shortcut, native fraction, move-out, shared formula palette, object selection/delete and mobile keyboard');return
        }
        if(process.argv.includes('--annotation-selection-only')){
            await checkAnnotationSelection(browser,false);await checkAnnotationSelection(browser,true);
            console.log('PASS: single-location annotations, label and window selection, copy/cut/paste/delete, desktop/mobile');return
        }
        if(process.argv.includes('--annotation-images-only')){
            await checkAnnotationImages(browser,false);await checkAnnotationImages(browser,true);
            console.log('PASS: note images, private object IDs, selection, copy/paste across spaces and deletion on desktop/mobile');return
        }
        if(process.argv.includes('--shortcuts-only')||process.argv.length===2){
            const shared={workspace:data.state.workspace,reading:{},recent:[]};
            const desktop=await fixture(browser,false,shared,{'复制':{ctrl:true,alt:true,shift:false,key:'b'}});
            const mobile=await fixture(browser,true,shared,{'复制':{ctrl:true,alt:true,shift:false,key:'d'}});
            const a=desktop.p,b=mobile.p;
            const open=p=>headerControl(p,'shortcutSettings');
            const copy=p=>p.getByRole('textbox',{name:'复制快捷键',exact:true});
            const save=p=>p.locator('#dialog').getByRole('button',{name:'保存',exact:true}).click();
            assert.equal(await b.evaluate(()=>shortcutLabel(toolShortcuts['复制'])),'Ctrl+Alt+B');
            await open(a);await open(b);
            await copy(a).press('Control+Alt+G');await save(a);await a.waitForFunction(()=>!dialog.open);
            await b.waitForFunction(()=>toolShortcuts['复制'].key==='g');
            await copy(b).press('Control+Alt+H');await save(b);
            await b.getByText(/保存失败：其他设备已修改快捷键/).waitFor();
            assert.equal(shared.shortcuts.shortcuts['复制'].key,'g');
            await b.evaluate(()=>dialog.close());await open(b);
            assert.equal(await copy(b).inputValue(),'Ctrl+Alt+G');
            await b.locator('.shortcutRow').filter({has:copy(b)}).getByRole('button',{name:'清除',exact:true}).click();
            shared.failShortcutSave=true;await save(b);await b.getByText(/Test save failure/).waitFor();
            assert.equal(shared.shortcuts.shortcuts['复制'].key,'g');
            shared.failShortcutSave=false;await save(b);await b.waitForFunction(()=>!dialog.open);
            await a.waitForFunction(()=>toolShortcuts['复制']===null);
            await a.reload();await a.waitForFunction(()=>db?.thesis?.length===2);assert.equal(await a.evaluate(()=>toolShortcuts['复制']),null);
            await open(a);await a.getByRole('button',{name:'恢复默认',exact:true}).click();await save(a);await a.waitForFunction(()=>!dialog.open);
            await b.waitForFunction(()=>shortcutLabel(toolShortcuts['复制'])==='Ctrl+C');
            assert.deepEqual(desktop.errors,[]);assert.deepEqual(mobile.errors,[]);
            await desktop.context.close();await mobile.context.close();
            console.log('PASS: shared shortcuts migration, desktop/mobile live sync, stale save conflict, failed save, clearing, reload and reset');
            if(process.argv.includes('--shortcuts-only'))return;
        }
        if(process.argv.includes('--history-only')){
            const workspace={...data.state.workspace,history:true},a={id:'a'.repeat(40),time:'2026-11-26T10:00:00Z',source:'editor',message:'Automatic save',tag:null},b={id:'b'.repeat(40),time:'2026-11-26T09:58:00Z',source:'editor',message:'Automatic save',tag:null},c={id:'c'.repeat(40),time:'2026-11-26T09:55:00Z',source:'agent',message:'Agent edit',tag:{id:'v',name:'Named'}};
            const past=structuredClone(data.state);past.thesis[0].body='Historical body.\n\n:::equation history-eq\nx^2\n:::';
            past.thesis[1].body='**Historical child**.';
            const shared={workspace,state:structuredClone(data.state),reading:{},recent:[],history:[a,b,c],versions:{[a.id]:data.state,[b.id]:past,[c.id]:past},allowRestore:true};
            const {p,context,errors}=await fixture(browser,false,shared);
            const historyLabel='历史版本';
            for(const selector of ['.pane .part-text .richText','.pane [data-object="demo-eq"] .partLabel','.pane [data-subfigure="demo-subfig"] img','#nav [data-node-id="demo-start"] .navlabel']){
                await contextAt(p,p.locator(selector).first());
                assert(!(await p.locator('#menu button').allTextContents()).includes(historyLabel),selector);
            }
            await p.evaluate(()=>{setView('blocks')});
            await contextAt(p,p.locator('.annotationRow').first());
            assert(!(await p.locator('#menu button').allTextContents()).includes(historyLabel));
            await p.evaluate(()=>{setView('thesis');select('demo-start',0);$('menu').hidden=true});
            await p.locator('#saveVersion').click();
            await p.waitForFunction(()=>document.querySelector('#status').textContent==='已保存版本');
            assert.equal(shared.tagCalls,1);assert.equal(await p.locator('#dialog').isVisible(),false);
            await headerControl(p,'historyButton','click');
            await p.locator('.historyRow.named').first().waitFor();
            assert.equal(await p.locator('.historyGroup').count(),1);
            assert.equal(await p.locator('.historyGroup').evaluate(x=>x.open),false);
            const group=p.locator('.historyGroup'),summary=group.locator('summary');
            await summary.click({button:'right'});
            assert.deepEqual(await p.locator('#menu button').allTextContents(),['展开版本组','查看差异']);
            await menu(p,'展开版本组').click();
            assert.equal(await group.evaluate(x=>x.open),true);
            const groupedRow=group.locator('.historyRow').first(),groupedId=await groupedRow.getAttribute('data-commit');
            await groupedRow.click({button:'right'});
            assert(await menu(p,'查看差异').isVisible());
            assert(await menu(p,'设置版本名称').isVisible());
            await menu(p,'复制版本 ID').click();
            await p.waitForFunction(id=>localClipboard===id,groupedId);
            await summary.click({button:'right'});await menu(p,'折叠版本组').click();
            assert.equal(await group.evaluate(x=>x.open),false);
            await p.locator('.historyDate').click({button:'right'});
            assert.equal(await p.locator('#menu').isVisible(),false);
            const row=p.locator('.historyRow').filter({hasText:'Named'});
            await row.click({button:'right'});await menu(p,'设置版本名称').click();
            const rename=p.getByRole('textbox',{name:'版本名称'});await rename.fill('Renamed');await rename.press('Enter');
            await p.locator('.historyRow').filter({hasText:'Renamed'}).waitFor();
            const liveBody=await p.evaluate(()=>find('demo-start').body);
            await p.locator('.historyRow').filter({hasText:'Renamed'}).click({button:'right'});await menu(p,'查看差异').click();
            await p.locator('#panes > .historicalPane').waitFor();
            assert.equal(await p.locator('#panes > .pane').count(),2);
            assert((await p.locator('.historyPageDiff').innerText()).includes('Historical body.'));
            assert.equal(await p.locator('#dialog').isVisible(),false);
            assert(await p.locator('.historyPageDiff .historyRemoved .katex').count()>0);
            assert(await p.locator('.historyPageDiff .historyRemoved strong').count()>0);
            assert.equal(await p.locator('.historyPreview [contenteditable=true],.historyPreview math-field').count(),0);
            assert.equal(await p.evaluate(()=>find('demo-start').body),liveBody);
            assert.equal(await p.evaluate(()=>positionSnapshot().panes.length),1);
            await p.locator('#nav [data-node-id="demo-method"] .navlabel').click();
            assert((await p.locator('.historyPageDiff').innerText()).includes('Historical child'));
            assert(!(await p.locator('.historyPageDiff').innerText()).includes('Historical body.'));
            await p.evaluate(()=>{find('demo-method').body='Live edited child.';change(false)});
            assert((await p.locator('.historyPageDiff').innerText()).includes('Live edited child.'));
            await p.evaluate(()=>select('demo-start',0));
            await p.getByRole('button',{name:'查看历史版本',exact:true}).click();
            assert.equal(await p.locator('.historyPageDiff').count(),0);
            assert((await p.locator('.historyPreview').innerText()).includes('Historical body.'));
            await p.getByRole('button',{name:'关闭历史',exact:true}).click();
            assert.equal(await p.locator('#panes > .pane').count(),1);
            await headerControl(p,'historyButton','click');
            await p.locator('.historyRow').filter({hasText:'Renamed'}).waitFor();
            await p.locator('.historyRow').filter({hasText:'Renamed'}).click({button:'right'});await menu(p,'查看差异').click();
            await p.locator('.historyPageDiff').waitFor();assert((await p.locator('.historyPageDiff').innerText()).includes('Historical body.'));
            await p.getByRole('button',{name:'关闭历史',exact:true}).click();
            await headerControl(p,'historyButton','click');
            await p.locator('.historyRow').filter({hasText:'Renamed'}).click({button:'right'});await menu(p,'恢复版本').click();
            await p.waitForFunction(()=>find('demo-start').body.startsWith('Historical body.'));
            assert.equal(shared.restoreCalls,1);assert.deepEqual(errors,[]);await context.close();
            const mobile=await fixture(browser,true,shared);await headerControl(mobile.p,'historyButton','tap');
            await mobile.p.locator('.historyRow.named').first().waitFor();assert(await mobile.p.locator('#saveVersion').isVisible());
            await mobile.p.locator('.historyGroup summary').click({button:'right'});
            await menu(mobile.p,'展开版本组').tap();
            assert.equal(await mobile.p.locator('.historyGroup').evaluate(x=>x.open),true);
            const mobileRow=mobile.p.locator('.historyGroup .historyRow').first(),mobileId=await mobileRow.getAttribute('data-commit');
            await mobileRow.locator('.historyMore').tap();
            assert(await menu(mobile.p,'查看差异').isEnabled());
            await menu(mobile.p,'复制版本 ID').tap();
            await mobile.p.waitForFunction(id=>localClipboard===id,mobileId);
            await mobile.p.locator('.historyRow').filter({hasText:'Renamed'}).locator('.historyTitle').tap();
            await mobile.p.locator('.historicalPane.activepane').waitFor();
            assert(await mobile.p.locator('.historyPreview').isVisible());
            assert(await mobile.p.locator('.historyPageDiff').isVisible());
            assert.equal(await mobile.p.evaluate(()=>editingEnabled),false);
            for(const [id,body,count] of [[a.id,data.state.thesis[0].body,2],[b.id,past.thesis[0].body,3]]){
                await headerControl(mobile.p,'historyButton','tap');
                await mobile.p.locator('.historyGroup summary').click({button:'right'});await menu(mobile.p,'展开版本组').tap();
                await mobile.p.locator(`.historyRow[data-commit="${id}"] .historyMore`).tap();
                assert(await menu(mobile.p,'恢复版本').isEnabled());
                await menu(mobile.p,'恢复版本').tap();
                await mobile.p.waitForFunction(({body,count})=>find('demo-start').body===body&&db.revision==='restore-'+count,{body,count});
                assert.equal(shared.restoreCalls,count);
                assert.equal(await mobile.p.evaluate(()=>editingEnabled),false);
                assert(await mobile.p.locator('.historicalPane.activepane').isVisible());
                assert.equal(await mobile.p.locator('.historyPreview [contenteditable=true],.historyPreview math-field').count(),0);
            }
            await mobile.p.locator('.historicalPane').getByRole('button',{name:'切换 首页',exact:true}).tap();
            assert(await mobile.p.locator('#panes > .pane').first().isVisible());
            await headerControl(mobile.p,'dual','tap');
            assert.equal(await mobile.p.locator('#panes > .pane').count(),1);
            assert.deepEqual(mobile.errors,[]);await mobile.context.close();
            console.log('PASS: direct save tag, grouping, inline rename, rendered scoped diff, live updates, restore, mobile history');return
        }
        if(process.argv.includes('--paste-center-only')){
            for(const mobile of [false,true]){
                const {p,context,errors}=await fixture(browser,mobile);
                await p.evaluate(()=>{if(!editingEnabled)toggleEditMode();const n=find('demo-method');n.body=Array.from({length:25},(_,i)=>'Paragraph '+i+' '+('some words '.repeat(15))).join('\n\n');select(n.id,0)});
                const area=p.locator('.pane.activepane .part-text .richText').last();
                await area.evaluate(a=>{a.focus();const r=document.createRange();r.selectNodeContents(a);r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r);const d=new DataTransfer();d.setData('text/plain',' pasted end');a.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:d}))});
                await p.waitForFunction(()=>{const s=getSelection(),r=s.rangeCount&&s.getRangeAt(0),rect=r&&caretBounds(r),pane=document.querySelector('.pane.activepane'),box=pane.getBoundingClientRect(),top=pane.querySelector('.toolbar').getBoundingClientRect().bottom;return rect&&Math.abs((rect.top+rect.bottom)/2-(top+box.bottom)/2)<30},null,{timeout:4000}).catch(async e=>{console.error('Plain paste diagnostic',mobile,errors,await p.evaluate(()=>{const s=getSelection(),r=s.rangeCount&&s.getRangeAt(0),rect=r&&caretBounds(r),pane=document.querySelector('.pane.activepane');return {anchor:s.anchorNode?.textContent?.slice(-200),offset:s.anchorOffset,rect:rect?.toJSON(),scroll:pane.scrollTop,height:pane.scrollHeight,client:pane.clientHeight,pane:pane.getBoundingClientRect().toJSON(),toolbar:pane.querySelector('.toolbar').getBoundingClientRect().toJSON(),viewport:{height:visualViewport.height,top:visualViewport.offsetTop},body:find('demo-method').body.slice(-250)}}));throw e});
                assert((await p.evaluate(()=>find('demo-method').body)).includes('pasted end'));
                await area.evaluate(a=>{a.focus();const r=document.createRange();r.selectNodeContents(a);r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r);const d=new DataTransfer();d.setData('text/plain',':::equation paste-center-eq\nx^2\n:::\n\nLast pasted paragraph');a.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:d}))});
                await p.waitForFunction(()=>{const s=getSelection(),r=s.rangeCount&&s.getRangeAt(0),rect=r&&caretBounds(r),pane=document.querySelector('.pane.activepane'),box=pane.getBoundingClientRect(),top=pane.querySelector('.toolbar').getBoundingClientRect().bottom;return rect&&s.anchorNode.textContent.includes('Last pasted paragraph')&&Math.abs((rect.top+rect.bottom)/2-(top+box.bottom)/2)<30}).catch(async e=>{console.error('Paste diagnostic',mobile,errors,await p.evaluate(()=>{const s=getSelection(),r=s.rangeCount&&s.getRangeAt(0),rect=r&&caretBounds(r),pane=document.querySelector('.pane.activepane');return {anchor:s.anchorNode?.textContent?.slice(-200),offset:s.anchorOffset,rect:rect?.toJSON(),scroll:pane.scrollTop,height:pane.scrollHeight,client:pane.clientHeight,pane:pane.getBoundingClientRect().toJSON(),toolbar:pane.querySelector('.toolbar').getBoundingClientRect().toJSON(),body:find('demo-method').body.slice(-300)}}));throw e});
                assert.deepEqual(errors,[]);await context.close()
            }
            console.log('PASS: plain and structured paste center the insertion end on desktop and mobile');return
        }
        if(process.argv.includes('--annotation-highlight-only')){
            for(const isMobile of [false,true]){
                const {p,context,errors}=await fixture(browser,isMobile);
                if(isMobile)await p.locator('#editModeToggle').tap();
                await p.evaluate(()=>select('demo-start'));
                const area=p.locator('.pane .part-text .richText').first();
                const original=await p.evaluate(()=>find('demo-start').body);
                const selectQuote=()=>area.evaluate((a,mobile)=>{
                    a.focus();const t=a.querySelector('p').firstChild,r=document.createRange();
                    r.setStart(t,0);r.setEnd(t,9);getSelection().removeAllRanges();getSelection().addRange(r);
                    if(!mobile){const b=r.getBoundingClientRect(),e=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:b.left+2,clientY:b.top+2});e.useCurrentSelection=true;a.dispatchEvent(e)}
                    scheduleToolbarUpdate();return r.toString();
                },isMobile);
                const createNote=async()=>{if(isMobile){await p.waitForFunction(()=>document.querySelector('#floatingTools [data-tool="新建批注"]').getAttribute('aria-disabled')==='false');await p.locator('#floatingTools [data-tool="新建批注"]').tap()}else await menu(p,'新建批注').click()};
                const quote=await selectQuote();
                assert(quote.length);
                await createNote();
                await p.locator('#dialog .richText').first().fill('New selected-text note');
                await p.evaluate(()=>closeWorkbenchDialog());
                await p.waitForFunction(quote=>[...(CSS.highlights.get('paper-annotation')||[])].some(r=>r.toString()===quote),quote);
                assert(await p.evaluate(quote=>db.blocks.some(n=>n.annotation?.owner==='demo-start'&&n.annotation.quote===quote&&find('demo-start').body.includes('[[embed:'+n.id+']]')),quote));
                await p.evaluate(()=>renderPanes());
                await p.waitForFunction(quote=>[...(CSS.highlights.get('paper-annotation')||[])].some(r=>r.toString()===quote),quote);
                await p.evaluate(()=>undo(false));
                await p.waitForFunction(original=>find('demo-start').body===original,original);
                await p.waitForFunction(()=>!CSS.highlights.get('paper-annotation')?.size);
                await selectQuote();
                await createNote();
                await p.locator('#dialog .richText').first().fill('New selected-text note');
                await p.evaluate(()=>closeWorkbenchDialog());
                await p.waitForFunction(quote=>[...(CSS.highlights.get('paper-annotation')||[])].some(r=>r.toString()===quote),quote);
                assert(await p.evaluate(quote=>db.blocks.some(n=>n.annotation?.owner==='demo-start'&&n.annotation.quote===quote),quote));
                await p.waitForFunction(()=>textAnnotationRanges.length>0);
                const noteId=await p.evaluate(()=>textAnnotationRanges[0].chip.dataset.noteId);
                const point=await p.evaluate(()=>{const r=textAnnotationRanges[0].range.getClientRects()[0];return {x:r.left+r.width/2,y:r.top+r.height/2}});
                if(isMobile)await p.touchscreen.tap(point.x,point.y);else await p.mouse.click(point.x,point.y);
                await p.waitForFunction(id=>dialog.open&&selectedNoteId===id&&dialog._noteId===id,noteId);
                assert.equal(await p.evaluate(()=>CSS.highlights.get('paper-annotation-selected')?.size),1);
                assert.equal(await p.locator('.pane .inlineAnnotation[data-note-id="'+noteId+'"]').getAttribute('aria-pressed'),'true');
                const edit=p.locator('#dialog .richText').first();
                if(isMobile)await edit.tap();else await edit.click();
                await p.waitForFunction(()=>!selectedNoteId&&!CSS.highlights.has('paper-annotation-selected'));
                await edit.fill('Edited annotation');await p.keyboard.press('Backspace');
                assert(await p.evaluate(id=>!!find(id),noteId));
                const handle=p.locator('#dialog .noteWindowHandle');
                if(isMobile)await handle.tap();else await handle.click();
                await p.waitForFunction(id=>selectedNoteId===id,noteId);
                await p.keyboard.press(isMobile?'Backspace':'Delete');
                await p.waitForFunction(id=>!find(id)&&!dialog.open&&!CSS.highlights.get('paper-annotation')?.size,noteId);
                assert.equal(await p.evaluate(()=>find('demo-start').body),original);
                assert.deepEqual(errors,[]);await context.close();
            }
            console.log('PASS: selected text annotation highlights, rerender and undo on desktop/mobile');return
        }
        if(process.argv.includes('--sync-only')){
            const shared={workspace:data.state.workspace,state:structuredClone(data.state),reading:{},recent:[]};
            const desktop=await fixture(browser,false,shared),mobile=await fixture(browser,true,shared),p=desktop.p,q=mobile.p;
            const edit=async(page,id,body)=>page.evaluate(([id,body])=>{find(id).body=body;change(true);clearTimeout(timer)},[id,body]);
            const a='Paragraph A.\n\n:::equation sync-eq\nx=1\n:::\n\nParagraph B.\n';
            await edit(p,'demo-start',a);await p.evaluate(()=>save());await q.waitForFunction(a=>find('demo-start').body===a,a);
            // Separate paragraphs and formula in one section, same initial revision.
            await edit(q,'demo-start',a.replace('x=1','x=2'));await edit(p,'demo-start',a.replace('Paragraph A.','Paragraph A edited.'));
            await p.evaluate(()=>save());await q.evaluate(()=>save());
            const merged=a.replace('x=1','x=2').replace('Paragraph A.','Paragraph A edited.');
            await p.waitForFunction(merged=>find('demo-start').body===merged&&!dirty,merged);await q.waitForFunction(merged=>find('demo-start').body===merged&&!dirty,merged);
            // Conflict only the overlapping paragraph; retain independent edits.
            const plan=await p.evaluate(()=>{const base='One\n\nTwo\n\nThree\n',local='Local one\n\nTwo\n\nLocal three\n',remote='Remote one\n\nRemote two\n\nThree\n',conflicts=[];const state=mergeBody(base,local,remote,(s,e,l,r)=>{conflicts.push([l,r]);return r});return {state,conflicts}});
            assert.deepEqual(plan,{state:'Remote one\n\nRemote two\n\nLocal three\n',conflicts:[['Local one','Remote one']]});
            // Concurrent separate sections and a reader update without refresh.
            await edit(p,'demo-start',merged+'\nDesktop.');await edit(q,'demo-method','Mobile section.');await p.evaluate(()=>save());await q.evaluate(()=>save());
            await p.waitForFunction(()=>find('demo-method').body==='Mobile section.'&&!dirty);await q.waitForFunction(()=>find('demo-start').body.endsWith('Desktop.')&&!dirty);
            // Same object: reject overlap, keep draft through reload, resolve locally.
            await edit(p,'demo-start','Desktop conflict.');await edit(q,'demo-start','Mobile conflict.');await p.evaluate(()=>save());await q.evaluate(()=>save());
            await q.waitForFunction(()=>conflict);await q.evaluate(()=>draftQueue);await q.reload();await q.waitForFunction(()=>conflict&&dialog.open);
            assert.equal(await q.evaluate(()=>find('demo-start').body),'Mobile conflict.');
            const row=q.locator('.conflictItem');
            await row.waitFor();
            const local=row.locator('.conflictDiffPanel').nth(0),remote=row.locator('.conflictDiffPanel').nth(1);
            assert.equal(await local.locator('pre').textContent(),'Mobile conflict.');
            assert.equal(await remote.locator('pre').textContent(),'Desktop conflict.');
            assert.ok(await local.locator('.conflictAdded').count());
            assert.ok(await remote.locator('.conflictRemoved').count());
            assert.equal(await q.getByRole('button',{name:'确认合并并保存',exact:true}).isEnabled(),false);
            assert.equal(await row.locator('.conflictDiffGrid').evaluate(e=>getComputedStyle(e).gridTemplateColumns.split(' ').length),1);
            const checks=await p.evaluate(()=>{
                const c={local:'模型精度提高至95%',remote:'模型精度提高至90%'};
                const t=conflictDiff(c),s=conflictDiff({local:{parent:'new',order:2},remote:{parent:'old',order:1}});
                const empty=conflictDiff({local:'',remote:'原文'}),large='x'.repeat(200001),fallback=conflictDiff({local:large,remote:'server'});
                return {local:t.views.local.pre.textContent,remote:t.views.remote.pre.textContent,
                    changed:t.views.local.pre.querySelector('.conflictAdded')?.textContent,
                    removed:t.views.remote.pre.querySelector('.conflictRemoved')?.textContent,
                    structured:s.highlighted&&!!s.views.local.pre.querySelector('.conflictAdded')&&!!s.views.remote.pre.querySelector('.conflictRemoved'),
                    empty:!!empty.views.local.pre.querySelector('.conflictEmpty'),
                    complete:!fallback.highlighted&&fallback.views.local.pre.textContent===large&&fallback.views.remote.pre.textContent==='server'}
            });
            assert.deepEqual(checks,{local:'模型精度提高至95%',remote:'模型精度提高至90%',changed:'5',removed:'0',structured:true,empty:true,complete:true});
            await q.getByRole('button',{name:'采用本地版本',exact:true}).click();await q.getByRole('button',{name:'确认合并并保存',exact:true}).click();
            await p.waitForFunction(()=>find('demo-start').body==='Mobile conflict.'&&!dirty);await q.waitForFunction(()=>!dirty&&!conflict);
            // Verify the other choice also saves exactly the selected version.
            await edit(p,'demo-start','服务器修改 <b>原文</b>');await edit(q,'demo-start','本地修改 <script>文本</script>');await p.evaluate(()=>save());await q.evaluate(()=>save());
            await q.waitForFunction(()=>conflict);await q.evaluate(()=>showSyncConflict());
            await q.locator('.conflictItem .conflictAdded').first().waitFor();
            assert.equal(await q.locator('.conflictItem pre script,.conflictItem pre b').count(),0);
            await q.getByRole('button',{name:'采用服务器版本',exact:true}).click();
            await q.getByRole('button',{name:'确认合并并保存',exact:true}).click();
            await q.waitForFunction(()=>find('demo-start').body==='服务器修改 <b>原文</b>'&&!dirty&&!conflict);
            assert.deepEqual(desktop.errors,[]);assert.deepEqual(mobile.errors,[]);await desktop.context.close();await mobile.context.close();console.log('PASS: desktop/mobile live refresh, independent sections and objects, highlighted conflict diff, draft reload and both resolution choices');return;
        }
        if(process.argv.includes('--reading-switch-only')){await checkTreeReturn(browser,false);await checkTreeReturn(browser,true);console.log('PASS: tree return and shared position across desktop/mobile; explicit network jump');return}
        if(process.argv.includes('--reading-caret-only')){
            const {p,context,errors}=await fixture(browser,true);
            await p.evaluate(()=>select('demo-start'));
            const area=p.locator('.pane .part-text .richText').first(),caret=p.locator('.readingCaret:visible');
            const original=await p.evaluate(()=>find('demo-start').body);
            const tapAt=async offset=>{
                await area.scrollIntoViewIfNeeded();
                const point=await area.evaluate((a,i)=>{const t=a.querySelector('p').firstChild,r=document.createRange();r.setStart(t,i);r.collapse(true);const b=r.getBoundingClientRect();return {x:b.left,y:(b.top+b.bottom)/2}},offset);
                await p.touchscreen.tap(point.x,point.y);
                await p.waitForFunction(i=>{const s=getSelection();return s.isCollapsed&&s.anchorOffset===i&&s.anchorNode?.nodeType===3&&!!s.anchorNode.parentElement.closest('.richText')},offset);
                await caret.waitFor({state:'visible'});
            };
            await tapAt(2);await tapAt(5);
            assert.equal(await area.getAttribute('contenteditable'),'false');
            assert.equal(await p.evaluate(()=>document.activeElement?.isContentEditable),false);
            await p.keyboard.press('Delete');await p.keyboard.insertText('X');
            assert.equal(await p.evaluate(()=>find('demo-start').body),original);
            await tapAt(5);
            const note=p.locator('#floatingTools [data-tool="新建批注"]');
            await p.waitForFunction(()=>document.querySelector('#floatingTools [data-tool="新建批注"]').getAttribute('aria-disabled')==='false');
            await note.tap();await p.locator('#dialog .richText').first().fill('Read-mode caret note');
            await p.evaluate(()=>closeWorkbenchDialog());
            await p.waitForFunction(()=>db.blocks.some(n=>n.body.includes('Read-mode caret note')));
            const result=await p.evaluate(()=>{const n=db.blocks.find(n=>n.body.includes('Read-mode caret note'));return {annotation:n.annotation,body:find('demo-start').body,id:n.id}});
            assert.equal(result.annotation.mode,'caret');assert.equal(result.annotation.owner,'demo-start');assert.equal(result.annotation.quote,'');
            assert.equal(result.body.replace('[[embed:'+result.id+']]',''),original);
            assert.equal(result.body.indexOf('[[embed:'+result.id+']]'),5);
            await tapAt(2);await p.locator('#editModeToggle').tap();await caret.waitFor({state:'hidden'});
            assert.equal(await area.getAttribute('contenteditable'),'true');
            assert(await area.evaluate(a=>document.activeElement===a&&getSelection().isCollapsed&&getSelection().anchorOffset===2));
            await p.keyboard.insertText('X');await p.waitForFunction(()=>find('demo-start').body.startsWith('A X'));
            await p.locator('#editModeToggle').tap();assert.equal(await p.evaluate(()=>document.activeElement?.isContentEditable),false);
            assert.deepEqual(errors,[]);await context.close();console.log('PASS: mobile read-only tap caret, exact inline annotation, no editable focus or body changes, edit-mode cleanup');return
        }
        if(process.argv.includes('--reading-range-note-only')){
            const {p,context,errors}=await fixture(browser,true);
            const original='Alpha first paragraph.\n\nBeta middle paragraph.\n\nGamma final paragraph.\n';
            await p.evaluate(raw=>{find('demo-start').body=raw;reindex();select('demo-start')},original);
            const doc=p.locator('.pane .visualDocument').first(),areas=doc.locator('.part-text .richText');
            const point=(loc,i)=>loc.evaluate((a,i)=>{const t=a.querySelector('p').firstChild,r=document.createRange();r.setStart(t,i);r.collapse(true);const b=r.getBoundingClientRect();return {x:b.x,y:b.y+b.height/2}},i);
            const cdp=await context.newCDPSession(p),start=await point(areas.first(),2);
            await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[start]});await p.locator('.rangeEnd:visible').waitFor();
            await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
            await p.waitForTimeout(600);
            const h=await p.locator('.rangeEnd:visible').boundingBox(),dest=await point(areas.last(),5);
            await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:h.x+h.width/2,y:h.y+10}]});
            await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:dest.x,y:dest.y+10}]});
            await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
            await p.waitForFunction(()=>document.querySelector('.pane .visualDocument')._rangeAnnotationBinding(document.querySelector('.pane .visualDocument')._mixedRange())?.segments?.length===3);
            const expected=await doc.evaluate(d=>d._rangeAnnotationBinding(d._mixedRange()).segments.map(s=>s.quote));
            const tool=name=>p.locator(`#floatingTools [data-tool="${name}"]`);
            await p.waitForFunction(()=>document.querySelector('#floatingTools [data-tool="新建批注"]').getAttribute('aria-disabled')==='false');
            assert.equal(await tool('剪切').getAttribute('aria-disabled'),'true');
            await tool('新建批注').tap();await p.locator('#dialog .richText').first().fill('Cross paragraph note');await p.evaluate(()=>closeWorkbenchDialog());
            const note=await p.evaluate(()=>db.blocks.find(n=>n.body.includes('Cross paragraph note')));
            assert.deepEqual(note.annotation.segments.map(s=>s.quote),expected);
            assert.equal(await p.evaluate(id=>find('demo-start').body.replace('[[embed:'+id+']]',''),note.id),original);
            const check=()=>p.waitForFunction(({id,expected})=>JSON.stringify(textAnnotationRanges.filter(x=>x.chip.dataset.noteId===id).map(x=>x.range.toString()))===JSON.stringify(expected),{id:note.id,expected});
            await check();await p.waitForFunction(()=>!dirty&&!saving);await p.reload();await p.waitForFunction(()=>typeof db!=='undefined'&&db?.thesis?.length===2);await check();
            const hit=await p.evaluate(id=>{const b=textAnnotationRanges.filter(x=>x.chip.dataset.noteId===id)[1].range.getClientRects()[0];return {x:b.left+b.width/2,y:b.top+b.height/2}},note.id);
            await p.touchscreen.tap(hit.x,hit.y);await p.waitForFunction(id=>dialog.open&&dialog._noteId===id,note.id);
            assert.equal(await p.evaluate(()=>editingEnabled),false);assert.deepEqual(errors,[]);await context.close();console.log('PASS: read-only mobile drag selection creates one annotation, highlights three paragraphs after reload, opens from middle paragraph');return
        }
        if(process.argv.includes('--newline-only')){await checkNewlineDeletion(browser,false);await checkNewlineDeletion(browser,true);console.log('PASS: paragraph joins, caret, undo, inline objects, desktop and mobile beforeinput');return}
        if(process.argv.includes('--local-annotation-range-only')){await checkLocalRangeAnnotations(browser);console.log('PASS: same-paragraph annotation highlight selection, copy, cut, delete and undo');return}
        if(process.argv.includes('--inline-math-range-only')){await checkInlineMathRange(browser);await checkMixedRange(browser,false);await checkMixedRange(browser,true);console.log('PASS: inline math range highlight, reverse and shrink, native MathLive editing, desktop and mobile mixed ranges');return}
        if(process.argv.includes('--mouse-range-only')){await checkMouseRange(browser);await checkRangeAnnotations(browser);await checkLocalRangeAnnotations(browser);console.log('PASS: mouse drag across paragraphs, objects and annotations, reverse, copy, cut, delete and undo');return}
        if(process.argv.includes('--select-all-range-only')){await checkSelectAllRange(browser);console.log('PASS: full document range, copy, cut, delete, undo, single paragraph and native controls');return}
        if(process.argv.includes('--mixed-range-only')){await checkMixedRange(browser,false);await checkMixedRange(browser,true);console.log('PASS: desktop Shift and mobile long-press cross-object selection, copy, cut and undo');return}
        if(process.argv.includes('--recent-layout-only')){
            const initial='C:\\Projects\\'+('LongDirectory\\'.repeat(8))+'example.json';
            const network='\\\\server\\share\\'+('LongDirectory\\'.repeat(8))+'network.json';
            for(const [mobile,width] of [[false,1280],[true,390],[true,320]]){
                const workspace={id:initial,name:'example.json',path:initial};
                const shared={workspace,recent:[workspace,{id:network,name:'network.json',path:network}],reading:{}};
                const {p,context,errors}=await fixture(browser,mobile,shared);
                await p.setViewportSize({width,height:844});
                await headerControl(p,'openWorkspace','click');
                await p.locator('.workspaceRecentRow').nth(1).waitFor();
                const layout=await p.locator('.workspaceRecentRow').evaluateAll(rows=>rows.map(row=>{
                    const list=row.parentElement,open=row.querySelector('.workspaceRecent'),remove=row.querySelector('.workspaceForget'),label=open.querySelector('span');
                    const a=open.getBoundingClientRect(),b=remove.getBoundingClientRect(),r=row.getBoundingClientRect();
                    return {listWidth:list.clientWidth,scrollWidth:list.scrollWidth,openWidth:a.width,removeWidth:b.width,removeRight:b.right,rowRight:r.right,openRight:a.right,removeLeft:b.left,pathHeight:label.offsetHeight,pathWidth:label.offsetWidth,rowHeight:r.height};
                }));
                for(const x of layout){
                    assert(x.openWidth>x.removeWidth,JSON.stringify(x));
                    assert(x.removeRight<=x.rowRight+1&&x.openRight<=x.removeLeft,JSON.stringify(x));
                    assert(x.scrollWidth<=x.listWidth+1,JSON.stringify(x));
                    assert(x.pathWidth>100&&x.pathHeight<180&&x.rowHeight<230,JSON.stringify(x));
                }
                await p.locator('.workspaceRecentRow').nth(1).locator('.workspaceForget').click();
                await p.locator('.workspaceRecentRow').nth(1).waitFor({state:'detached'});
                assert.equal(shared.recent.length,1);assert.deepEqual(errors,[]);await context.close();
            }
            console.log('PASS: recent file layout with long local and UNC paths at desktop, 390px and 320px widths; delete remains usable');return;
        }
        if(process.argv.includes('--workspace-only')){
            const initial='C:\\Projects\\example.json',network='\\\\server\\share\\network.json';
            const shared={workspace:{id:initial,name:'example.json',path:initial},recent:[],reading:{}};shared.recent=[shared.workspace];
            const desktop=await fixture(browser,false,shared);
            await headerControl(desktop.p,'openWorkspace','click');
            await desktop.p.getByRole('textbox',{name:'服务器文件路径'}).fill(network);
            await desktop.p.locator('.workspacePathForm button').click();
            await desktop.p.waitForFunction(()=>currentWorkspace?.name==='network.json');assert.equal(shared.requested,network);
            await desktop.p.locator('#blockTab').click();
            await desktop.p.waitForTimeout(650);assert.equal(shared.reading[network].view,'blocks');
            const mobile=await fixture(browser,true,shared);
            assert.equal(await mobile.p.evaluate(()=>view),'blocks');
            await headerControl(mobile.p,'openWorkspace','tap');
            await mobile.p.getByRole('textbox',{name:'服务器文件路径'}).fill('C:\\Projects\\missing.json');
            await mobile.p.locator('.workspacePathForm button').tap();
            await mobile.p.getByText('文件不存在',{exact:true}).waitFor();assert.equal(await mobile.p.evaluate(()=>currentWorkspace.name),'network.json');
            await mobile.p.locator('.workspaceRecent').filter({hasText:'example.json'}).tap();
            await mobile.p.waitForFunction(()=>currentWorkspace?.name==='example.json');assert.equal(shared.requested,initial);
            assert.deepEqual(desktop.errors,[]);assert.deepEqual(mobile.errors,[]);await desktop.context.close();await mobile.context.close();console.log('PASS: desktop and mobile path input, UNC forwarding, shared history and reading, invalid path preserves document');return;
        }
        if(process.argv.includes('--new-workspace-only')){
            for(const mobile of [false,true]){
                const initial='C:\\Projects\\existing.json',target='C:\\Projects\\new.json';
                const shared={workspace:{id:initial,name:'existing.json',path:initial},recent:[],reading:{}};shared.recent=[shared.workspace];
                const {p,context,errors}=await fixture(browser,mobile,shared);
                await headerControl(p,'openWorkspace','click');
                await p.locator('.workspacePathForm button').click();assert.equal(shared.requested,undefined);
                await p.getByRole('textbox',{name:'服务器文件路径'}).fill(initial);
                await p.getByRole('button',{name:'新建文件',exact:true}).click();await p.getByText('文件已存在',{exact:true}).waitFor();
                assert.equal(await p.evaluate(()=>currentWorkspace.name),'existing.json');
                await p.getByRole('textbox',{name:'服务器文件路径'}).fill(target);
                await p.getByRole('button',{name:'新建文件',exact:true}).click();await p.waitForFunction(()=>currentWorkspace?.name==='new.json'&&db.thesis.length===2&&db.blocks.length>0);
                assert.equal(shared.requestedNew,target);
                await headerControl(p,'openWorkspace','click');assert.equal(await p.getByRole('button',{name:'打开示例文件',exact:true}).count(),0);
                await p.getByRole('textbox',{name:'服务器文件路径'}).fill('   ');
                await p.getByRole('button',{name:'新建文件',exact:true}).click();
                await p.waitForFunction(()=>currentWorkspace?.name==='Untitled-test.json');
                assert.equal(shared.requestedNew,'');
                await headerControl(p,'openWorkspace','click');
                await p.getByRole('button',{name:'删除打开记录 Untitled-test.json',exact:true}).click();
                await p.getByRole('button',{name:'删除打开记录 existing.json',exact:true}).click();await p.waitForFunction(()=>!document.querySelector('.workspaceRecentRow [aria-label="删除打开记录 existing.json"]'));
                await p.getByRole('button',{name:'删除打开记录 new.json',exact:true}).click();await p.getByText('暂无打开记录。',{exact:true}).waitFor();
                assert.equal(shared.recent.length,0);assert.equal(await p.evaluate(()=>currentWorkspace.name),'Untitled-test.json');assert.deepEqual(errors,[]);await context.close();
            }
            console.log('PASS: desktop/mobile default and explicit new paths, collision preserves current document, seeded creation and deleting recent records');return;
        }
        const {p,context,errors}=await fixture(browser);
        if(process.argv.includes('--section-menu-only')){await checkSectionMenu(p);assert.deepEqual(errors,[]);await context.close();console.log('PASS: heading and collapsed child menus, blank creation and subtree deletion');return}
        if(process.argv.includes('--tree-menu-only')){await checkTreeMenuDrag(p);assert.deepEqual(errors,[]);await context.close();console.log('PASS: tree menu, blank creation, reorder, nesting delay/reset, subtree deletion and undo');return}
        if(process.argv.includes('--clean-body-only')){
            await checkCleanBody(p);assert.deepEqual(errors,[]);await context.close();
            const mobile=await fixture(browser,true);await checkCleanBody(mobile.p,true);assert.deepEqual(mobile.errors,[]);await mobile.context.close();
            console.log('PASS: one child heading, collapse/rename, context insertion, no inline plus controls (desktop/mobile)');return
        }
        if(process.argv.includes('--trash-refs-only')){await checkTrashReferences(p);assert.deepEqual(errors,[]);await context.close();console.log('PASS: trash cross-reference cleanup and restore');return}
        if(process.argv.includes('--network-only')){await checkNetwork(p);assert.deepEqual(errors,[]);await context.close();console.log('PASS: block menu, relation network, note jumps and highlight');return}
        if(!process.argv.includes('--fullscreen-only')){
        const area=p.locator('.pane .part-text .richText').first();
        await area.evaluate(a=>{
            a.focus();const r=document.createRange(),t=a.querySelector('p').firstChild;
            r.setStart(t,0);r.setEnd(t,9);getSelection().removeAllRanges();getSelection().addRange(r);
            const b=r.getBoundingClientRect();a.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:b.left+1,clientY:b.top+1}));
        });
        await menu(p,'复制').click();
        await p.waitForFunction(()=>localClipboard==='A fiction');
        await area.evaluate(a=>{
            a.focus();const r=document.createRange(),t=a.querySelector('p').firstChild;
            r.setStart(t,0);r.setEnd(t,9);getSelection().removeAllRanges();getSelection().addRange(r);
            const b=r.getBoundingClientRect();a.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:b.left+1,clientY:b.top+1}));
        });
        await menu(p,'剪切').click();
        await p.waitForFunction(()=>!find('demo-start').body.startsWith('A fiction'));
        await contextAt(p,area);await menu(p,'粘贴').click();
        await p.waitForFunction(()=>find('demo-start').body.includes('A fiction'));
        const eq=p.locator('[data-object="demo-eq"] .partLabel');
        await contextAt(p,eq);await menu(p,'剪切').click();
        await p.waitForFunction(()=>!find('demo-start').body.includes(':::equation demo-eq'));
        await contextAt(p,p.locator('.pane .part-text .richText').first());await menu(p,'粘贴').click();
        await p.waitForFunction(()=>find('demo-start').body.includes(':::equation demo-eq'));
        const image=p.locator('[data-subfigure="demo-subfig"] img');
        await contextAt(p,image);await menu(p,'复制').click();
        await p.waitForFunction(()=>localClipboard.startsWith(':::subfigure')&&!localClipboard.includes('wb-id:demo-subfig'));
        await contextAt(p,image);await menu(p,'粘贴').click();
        await p.waitForFunction(()=>document.querySelectorAll('.pane [data-subfigure]').length===2);
        await contextAt(p,image);await menu(p,'剪切').click();
        await p.waitForFunction(()=>!find('demo-start').body.includes('wb-id:demo-subfig'));
        await contextAt(p,p.locator('[data-object="demo-fig"] .partLabel'));await menu(p,'粘贴').click();
        await p.waitForFunction(()=>find('demo-start').body.includes('wb-id:demo-subfig'));
        await p.locator('.pane .inlineAnnotation').first().click();
        await contextAt(p,p.locator('#dialog .richText').first());
        await menu(p,'删除批注').click();
        await p.waitForFunction(()=>!find('demo-note')&&!find('demo-start').body.includes('[[embed:demo-note]]'));
        await p.waitForFunction(()=>db.trash.length===1);
        assert.equal(await p.locator('#sideTools .trashButton').count(),0);
        assert.equal(await p.locator('.pane .trashButton').count(),0);
        await p.locator('#blockTab').click();
        await p.locator('.pane .blockOverviewActions').getByRole('button',{name:'回收站 (1)',exact:true}).click();
        await p.locator('#dialog').getByRole('button',{name:'恢复',exact:true}).click();
        await p.waitForFunction(()=>find('demo-note')&&find('demo-start').body.includes('[[embed:demo-note]]')&&!db.trash.length);
        await p.locator('#closeDialog').click();
        await p.evaluate(()=>undo(false));
        await p.waitForFunction(()=>!find('demo-note')&&db.trash.length===1);
        await p.evaluate(()=>undo(true));
        await p.waitForFunction(()=>find('demo-note')&&!db.trash.length);
        await checkNetwork(p);
        await p.evaluate(()=>deleteNode(find('demo-note')));
        await p.evaluate(()=>select('demo-free'));
        await contextAt(p,p.locator('.pane .richText').first());
        assert(await menu(p,'删除批注').isVisible());
        await p.evaluate(()=>setView('blocks'));
        await contextAt(p,p.locator('.annotationRow').first());
        await menu(p,'删除批注').click();
        await p.waitForFunction(()=>db.blocks.length===0);
        assert.equal(await p.evaluate(()=>db.trash.length),2);
        await p.locator('#headerActions').click();
        const desktopTool=p.locator('#floatingTools [data-tool="复制"]');
        await desktopTool.hover();
        await p.locator('#toolHint').waitFor({state:'visible'});
        assert.match(await p.locator('#toolHint').innerText(),/复制.*Ctrl\+C/);
        await p.locator('#workspaceName').hover();
        await p.locator('#toolHint').waitFor({state:'hidden'});
        }
        const full=p.locator('#fullscreenToggle');
        await full.click();
        await p.waitForFunction(()=>!!document.fullscreenElement);
        assert.equal(await full.getAttribute('aria-pressed'),'true');
        if(process.argv.includes('--fullscreen-only')){
            await p.locator('.pane.activepane').hover({position:{x:10,y:100}});
            await p.mouse.wheel(0,100);
            await p.locator('header').waitFor({state:'hidden'});
            await p.mouse.wheel(0,-100);
            await p.locator('header').waitFor({state:'visible'});
        }
        await p.evaluate(()=>document.exitFullscreen());
        await p.waitForFunction(()=>document.querySelector('#fullscreenToggle').getAttribute('aria-pressed')==='false');
        assert.deepEqual(errors,[]);await context.close();
        console.log(process.argv.includes('--fullscreen-only')?'PASS: desktop native fullscreen and browser exit':'PASS: desktop editing and native fullscreen');
        const mobile=await fixture(browser,true),q=mobile.p;
        const fullMobile=q.locator('#fullscreenToggle');
        const originalHeight=await q.locator('header').evaluate(e=>e.offsetHeight);
        await q.evaluate(()=>{document.documentElement.requestFullscreen=()=>Promise.reject(new Error('Denied'))});
        await headerControl(q,'fullscreenToggle','tap');
        await q.waitForFunction(()=>document.body.classList.contains('immersiveMode'));
        assert.equal(await q.locator('header').evaluate(e=>e.offsetHeight),originalHeight);
        assert.equal(await fullMobile.getAttribute('aria-pressed'),'true');
        const fullscreenTouch=await mobile.context.newCDPSession(q);
        async function swipe(x,y,dx,dy){
            // Reuse the single finger's CDP touch ID across completed gestures;
            // changing IDs can deliver stale coordinates in Chromium emulation.
            const id=0;
            await fullscreenTouch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id}]});
            for(let i=1;i<=5;i++){
                await fullscreenTouch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+dx*i/5,y:y+dy*i/5,id}]});
                await q.waitForTimeout(35);
            }
            await fullscreenTouch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
            await q.waitForTimeout(180);
        }
        const h=q.locator('header'),reveal=q.locator('#revealFullscreenHeader');
        await swipe(12,350,90,0);
        assert(await h.isVisible());
        await swipe(12,350,0,-140);
        await h.waitFor({state:'hidden'});
        assert(await reveal.isVisible());
        assert(await q.locator('#layout').evaluate(e=>e.offsetHeight>=innerHeight-2));
        await swipe(12,220,0,140);
        await h.waitFor({state:'visible'});
        assert(await q.locator('#headerActions').isVisible());
        await swipe(12,350,0,-140);
        await h.waitFor({state:'hidden'});
        await reveal.tap();
        await h.waitFor({state:'visible'});
        await headerControl(q,'fullscreenToggle','tap');
        await q.waitForFunction(()=>!document.body.classList.contains('immersiveMode'));
        assert.equal(await q.locator('header').evaluate(e=>e.offsetHeight),originalHeight);
        await q.evaluate(()=>{document.documentElement.requestFullscreen=undefined;document.documentElement.webkitRequestFullscreen=undefined});
        await headerControl(q,'fullscreenToggle','tap');
        await q.waitForFunction(()=>document.body.classList.contains('immersiveMode'));
        await headerControl(q,'fullscreenToggle','tap');
        await q.waitForFunction(()=>!document.body.classList.contains('immersiveMode'));
        assert.equal(await q.locator('link[rel="manifest"]').getAttribute('href'),'/manifest.webmanifest');
        await q.evaluate(()=>{delete document.documentElement.requestFullscreen;delete document.documentElement.webkitRequestFullscreen});
        await swipe(12,350,0,-140);
        assert(await h.isVisible());
        const install=q.locator('#installApp');
        await headerControl(q,'installApp','tap');
        assert(await q.getByRole('heading',{name:'安装 PaperEditer',exact:true}).isVisible());
        await q.locator('#closeDialog').tap();
        await q.evaluate(()=>{
            const e=new Event('beforeinstallprompt',{cancelable:true});
            e.prompt=async()=>{window.testInstallCalled=true};
            e.userChoice=Promise.resolve({outcome:'accepted'});
            window.dispatchEvent(e);
        });
        await headerControl(q,'installApp','tap');
        await q.waitForFunction(()=>window.testInstallCalled===true);
        await fullscreenTouch.detach();
        console.log('PASS: mobile fullscreen fallback, swipe hide/reveal, exit, install instructions and prompt');
        if(process.argv.includes('--fullscreen-only')){assert.deepEqual(mobile.errors,[]);await mobile.context.close();return}
        assert(await q.locator('header button:visible').evaluateAll(buttons=>buttons.every(b=>{const r=b.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})));
        const tools=q.locator('#floatingTools'),toggle=q.locator('#headerActions'),tool=name=>tools.getByRole('button',{name,exact:true});
        await tools.waitFor({state:'visible'});
        assert.equal(await toggle.getAttribute('aria-pressed'),'true');
        assert.equal(await tools.locator('button').count(),8);
        assert.equal(await tools.locator('button svg').count(),8);
        assert.equal((await tools.innerText()).trim(),'');
        assert.equal(await tools.getByRole('button',{name:'历史',exact:true}).count(),0);
        await toggle.tap();await tools.waitFor({state:'hidden'});
        assert.equal(await toggle.getAttribute('aria-pressed'),'false');
        await q.reload();await q.waitForFunction(()=>typeof db!=='undefined'&&db?.thesis?.length===2);
        await tools.waitFor({state:'hidden'});
        await toggle.tap();await tools.waitFor({state:'visible'});
        const target=q.locator('.part-text .richText').first();
        const mode=q.locator('#editModeToggle');
        assert.equal(await mode.getAttribute('aria-pressed'),'false');
        assert.equal(await target.getAttribute('contenteditable'),'false');
        assert(await q.locator('.editableTitle').first().evaluate(a=>a.readOnly));
        console.log('Mobile: verifying read-only formula fields');
        await q.waitForFunction(()=>Array.from(document.querySelectorAll('math-field')).every(f=>f.readOnly&&f.mathVirtualKeyboardPolicy==='manual'));
        const readingOriginal=await q.evaluate(()=>find('demo-start').body);
        await target.tap();
        assert.equal(await q.evaluate(()=>document.activeElement?.isContentEditable),false);
        await target.evaluate(a=>{const r=document.createRange(),t=a.querySelector('p').firstChild;r.setStart(t,0);r.setEnd(t,9);getSelection().removeAllRanges();getSelection().addRange(r)});
        console.log('Mobile: verifying copy in view mode');
        await q.waitForFunction(()=>document.querySelector('#floatingTools [data-tool="复制"]').getAttribute('aria-disabled')==='false');
        assert.equal(await tool('剪切').getAttribute('aria-disabled'),'true');
        assert.equal(await tool('粘贴').getAttribute('aria-disabled'),'true');
        await tool('复制').tap();await q.waitForFunction(()=>localClipboard==='A fiction');
        await q.keyboard.press('Delete');
        assert.equal(await q.evaluate(()=>find('demo-start').body),readingOriginal);
        await q.locator('.pane .inlineAnnotation').first().tap();
        console.log('Mobile: verifying editable annotation in view mode');
        await q.locator('#dialog .richText').waitFor({state:'visible'});
        assert.equal(await q.locator('#dialog .richText').first().getAttribute('contenteditable'),'true');
        assert.equal(await q.evaluate(()=>document.activeElement?.isContentEditable),false);
        await q.locator('#workspaceName').tap();
        await q.waitForFunction(()=>!document.querySelector('#dialog').open);
        await mode.tap();
        console.log('Mobile: verifying edit mode');
        assert.equal(await mode.getAttribute('aria-pressed'),'true');
        assert.equal(await target.getAttribute('contenteditable'),'true');
        assert.equal(await q.evaluate(()=>document.activeElement?.isContentEditable),true);
        await q.waitForFunction(()=>Array.from(document.querySelectorAll('math-field')).every(f=>!f.readOnly&&f.mathVirtualKeyboardPolicy==='auto'));
        if(process.argv.includes('--view-mode-only')){
            await q.evaluate(()=>{document.activeElement?.blur();getSelection().removeAllRanges();scheduleToolbarUpdate()});
            await q.waitForFunction(()=>document.querySelector('#floatingTools').getBoundingClientRect().bottom>=innerHeight-25);
            const dock=await tools.boundingBox();
            await target.evaluate(a=>{a.focus();const r=document.createRange(),t=a.querySelector('p').firstChild;r.setStart(t,0);r.setEnd(t,9);getSelection().removeAllRanges();getSelection().addRange(r)});
            await q.waitForTimeout(120);
            assert(Math.abs((await tools.boundingBox()).y-dock.y)<3);
            await target.tap();
            assert(await target.evaluate(a=>a===document.activeElement&&a.isContentEditable));
            await mode.tap();
            assert.equal(await mode.getAttribute('aria-pressed'),'false');
            assert.equal(await target.getAttribute('contenteditable'),'false');
            assert.equal(await q.evaluate(()=>document.activeElement?.isContentEditable),false);
            await q.waitForFunction(()=>Array.from(document.querySelectorAll('math-field')).every(f=>f.readOnly&&f.mathVirtualKeyboardPolicy==='manual'));
            await q.keyboard.press('Control+Alt+E');await q.waitForFunction(()=>editingEnabled);
            await q.keyboard.press('Control+Alt+E');await q.waitForFunction(()=>!editingEnabled);
            assert.equal(await q.evaluate(()=>find('demo-start').body),readingOriginal);
            assert.deepEqual(mobile.errors,[]);await mobile.context.close();
            console.log('PASS: read-only reading, annotation, editing activation, focus removal and shortcut');return
        }
        await q.evaluate(()=>{localClipboard=null;document.activeElement?.blur();getSelection().removeAllRanges();scheduleToolbarUpdate()});
        await q.waitForFunction(()=>document.querySelector('#floatingTools').getBoundingClientRect().bottom>=innerHeight-25,undefined,{timeout:5000});
        const dock=await tools.boundingBox();
        const original=await q.evaluate(()=>find('demo-start').body);
        await target.evaluate(a=>{
            a.focus();const r=document.createRange(),t=a.querySelector('p').firstChild;
            r.setStart(t,0);r.setEnd(t,9);getSelection().removeAllRanges();getSelection().addRange(r)
        });
        await q.waitForFunction(y=>Math.abs(document.querySelector('#floatingTools').getBoundingClientRect().top-y)<3,dock.y);
        const selectionPosition=await tools.boundingBox();
        assert(selectionPosition.y>=0&&selectionPosition.y+selectionPosition.height<=844);
        const cdp=await mobile.context.newCDPSession(q);
        async function hold(locator,label){
            // Wait for the fixed mobile toolbar layout before raw touch input.
            await locator.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
            const rect=await locator.boundingBox(),x=Math.round(rect.x+rect.width/2),y=Math.round(rect.y+rect.height/2);
            await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:0}]});
            await q.locator('#toolHint').waitFor({state:'visible'});
            assert.equal(await q.locator('#toolHint').innerText(),label);
            await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
            await q.waitForTimeout(100);
            assert.equal(await q.locator('#toolHint').innerText(),label);
        }
        await hold(tool('剪切'),'剪切');
        assert.equal(await q.evaluate(()=>find('demo-start').body),original);
        assert.equal(await q.evaluate(()=>localClipboard),null);
        await tool('复制').tap();await q.waitForFunction(()=>localClipboard==='A fiction');
        await tool('剪切').tap();await q.waitForFunction(()=>!find('demo-start').body.startsWith('A fiction'));
        const cut=await q.evaluate(()=>find('demo-start').body);
        await tool('撤销').tap();await q.waitForFunction(original=>find('demo-start').body===original,original);
        await tool('重做').tap();await q.waitForFunction(cut=>find('demo-start').body===cut,cut);
        await tool('撤销').tap();
        await target.evaluate(a=>{a.focus();const r=document.createRange();r.selectNodeContents(a);r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r)});
        await q.waitForFunction(()=>document.querySelector('#floatingTools [data-tool="复制"]').getAttribute('aria-disabled')==='true');
        assert(await tool('粘贴').isEnabled());
        await hold(tool('复制'),'复制');
        assert.equal(await q.evaluate(()=>localClipboard),'A fiction');
        const bar=await tools.boundingBox();
        assert(bar.x>=0&&bar.x+bar.width<=390&&bar.y>=0&&bar.y+bar.height<=844);
        assert.equal(await tool('更多操作').count(),1);
        const rect=await target.boundingBox();
        const x=Math.round(rect.x+20),y=Math.round(rect.y+10);
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:0}]});
        await q.locator('.rangeEnd:visible').waitFor();
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        assert(!(await q.locator('#menu').isVisible()));
        await q.waitForTimeout(550);
        await headerControl(q,'shortcutSettings','tap');
        await tools.waitFor({state:'hidden'});
        assert.equal(await q.locator('.shortcutRow').count(),10);
        const copyShortcut=q.getByRole('textbox',{name:'复制快捷键',exact:true});
        await copyShortcut.focus();await copyShortcut.press('Control+Alt+B');
        assert.equal(await copyShortcut.inputValue(),'Ctrl+Alt+B');
        await q.locator('#dialog').getByRole('button',{name:'保存',exact:true}).tap();
        await q.waitForFunction(()=>toolShortcuts['复制'].key==='b');
        await target.evaluate(a=>{a.focus();const r=document.createRange(),t=a.querySelector('p').firstChild;r.setStart(t,0);r.setEnd(t,1);getSelection().removeAllRanges();getSelection().addRange(r)});
        await q.keyboard.press('Control+Alt+B');await q.waitForFunction(()=>localClipboard==='A');
        await q.reload();await q.waitForFunction(()=>typeof db!=='undefined'&&db?.thesis?.length===2);
        assert.equal(await q.evaluate(()=>shortcutLabel(toolShortcuts['复制'])),'Ctrl+Alt+B');
        assert.equal(await mode.getAttribute('aria-pressed'),'false');
        await q.keyboard.press('Control+Alt+E');await q.waitForFunction(()=>editingEnabled);
        await q.keyboard.press('Control+Alt+E');await q.waitForFunction(()=>!editingEnabled);
        assert.deepEqual(mobile.errors,[]);await mobile.context.close();
        console.log('PASS: mobile icon toolbar, hold hints without actions, context menu, selection states, undo/redo, custom shortcuts and persistence');
    }finally{await browser.close()}
}
run().catch(e=>{console.error(e);process.exitCode=1});
