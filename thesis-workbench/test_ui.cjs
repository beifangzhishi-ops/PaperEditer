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
            const filename=r.request().postDataJSON().path;shared.requestedNew=filename;
            if(shared.recent.some(x=>x.path===filename))return r.fulfill({status:400,json:{error:'文件已存在'}});
            shared.workspace={id:filename,name:filename.split(/[\\/]/).pop(),path:filename,history:true};shared.recent=[shared.workspace,...shared.recent];
            shared.state={...data.state,thesis:[],blocks:[],trash:[],revision:'blank'};
            return r.fulfill({json:shared.workspace})
        }
        if(shared&&name==='/api/workspaces/example'){
            shared.exampleCalls=(shared.exampleCalls||0)+1;
            shared.workspace={id:'built-in-example',name:'example.json',path:'built-in-example',history:true};shared.recent=[shared.workspace,...shared.recent.filter(x=>x.id!=='built-in-example')];shared.state=structuredClone(data.state);
            return r.fulfill({json:shared.workspace})
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
        if(shared?.history&&name==='/api/history')return r.fulfill({json:{items:shared.history,more:false,total:shared.history.length}});
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
    assert.deepEqual(await p.locator('#menu button').allTextContents(),['剪切','复制','粘贴','插入交叉引用','新建批注/知识块','插入批注/知识块']);
    await menu(p,'插入交叉引用').click();
    await p.locator('#dialog .visualPickList button').filter({hasText:'Example annotation'}).click();
    assert(await p.evaluate(()=>find('demo-method').body.includes('[[ref:demo-note]]')));
    await area.evaluate(a=>{
        a.focus();const t=a.querySelector('p').firstChild,r=document.createRange();r.setStart(t,1);r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r);
        const b=r.getBoundingClientRect(),e=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:b.left,clientY:b.top+2});e.useCurrentSelection=true;a.dispatchEvent(e)
    });
    await menu(p,'插入批注/知识块').click();
    await p.locator('#dialog .visualPickList').getByRole('button',{name:'Independent note',exact:true}).click();
    assert(await p.evaluate(()=>find('demo-method').body.includes('[[embed:demo-free]]')));
}
async function checkNetwork(p){
    await p.evaluate(()=>select('demo-note'));
    await p.locator('#nav .navrow.selected button').last().click();
    assert.deepEqual(await p.locator('#menu button').allTextContents(),['复制交叉引用','删除']);
    await p.locator('.blockNetwork [data-network-id="demo-start"]').click();
    await p.waitForFunction(()=>panes[active].id==='demo-start'&&dialog.open&&dialog._noteId==='demo-note');
    await p.evaluate(()=>closeWorkbenchDialog());
    await p.evaluate(()=>select('demo-free'));
    await p.locator('.blockNetwork [data-network-id="demo-start"]').click();
    await p.waitForFunction(()=>dialog.open&&dialog._noteId==='demo-free'&&document.querySelector('.freeNoteMarker.networkJumpHighlight'));
    await p.evaluate(()=>closeWorkbenchDialog());
    await p.evaluate(()=>select('demo-free'));
    await p.locator('.blockNetwork [data-network-id="demo-note"]').click();
    await p.waitForFunction(()=>panes[active].id==='demo-note'&&document.querySelector('.visualDocument.networkJumpHighlight'));
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
    assert.equal(await p.evaluate(()=>{const before=JSON.parse(window.beforeTrash),after=editableSnapshot();return before.thesis.every(n=>after.thesis.find(x=>x.id===n.id).body===n.body)&&before.blocks.every(n=>{const a=after.blocks.find(x=>x.id===n.id);return a.body===n.body&&JSON.stringify(a.annotation)===JSON.stringify(n.annotation)&&a.objectBindings?.length===n.objectBindings?.length&&a.freePlacements?.length===n.freePlacements?.length})&&!after.trash.length}),true);
}
async function checkMixedRange(browser,mobile){
    const {p,context,errors}=await fixture(browser,mobile);
    const original='Alpha start $a+b$ [[eqref:range-eq]]\n\n:::equation range-eq\nx^2\n:::\n\n:::figure range-fig\nA figure\n\n![Swatches](/assets/demo.png "wb-id:range-sub wb-width:20")\n:::\n\n:::table range-tab\nA table\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n:::\n\n[[embed:demo-free]]\n\nOmega end\n';
    await p.evaluate(raw=>{find('demo-start').body=raw;reindex();select('demo-start')},original);
    const doc=p.locator('.pane .visualDocument').first();
    const first=doc.locator('.part-text .richText').first(),last=doc.locator('.part-text .richText').last();
    const textPoint=async(loc,offset)=>loc.evaluate((a,i)=>{const n=a.querySelector('p').firstChild,r=document.createRange();r.setStart(n,i);r.collapse(true);const b=r.getBoundingClientRect();return {x:b.x,y:b.y+b.height/2}},offset);
    if(mobile){
        const cdp=await context.newCDPSession(p),start=await textPoint(first,2);
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[start]});
        await p.locator('.rangeEnd:visible').waitFor();
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
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
    await p.locator('.blockNetwork [data-network-id="demo-start"]').click();
    await p.waitForFunction(()=>panes[active].id==='demo-start'&&dialog.open);
    await p.evaluate(()=>closeWorkbenchDialog());
    await clickTab(p,'#blockTab');await clickTab(p,'#treeTab');
    assert.equal(await p.evaluate(()=>panes[active].id),'demo-start');
    assert.deepEqual(first.errors,[]);assert.deepEqual(second.errors,[]);
    await first.context.close();await second.context.close();
}
async function run(){
    const executablePath=process.env.PAPEREDITER_CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined);
    const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
    try{
        if(process.argv.includes('--shortcuts-only')||process.argv.length===2){
            const shared={workspace:data.state.workspace,reading:{},recent:[]};
            const desktop=await fixture(browser,false,shared,{'复制':{ctrl:true,alt:true,shift:false,key:'b'}});
            const mobile=await fixture(browser,true,shared,{'复制':{ctrl:true,alt:true,shift:false,key:'d'}});
            const a=desktop.p,b=mobile.p;
            const open=p=>p.locator('#shortcutSettings').click();
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
            const past=structuredClone(data.state);past.thesis[0].body='Historical body.';
            const shared={workspace,state:structuredClone(data.state),reading:{},recent:[],history:[a,b,c],versions:{[a.id]:data.state,[b.id]:past,[c.id]:past},allowRestore:true};
            const {p,context,errors}=await fixture(browser,false,shared);
            await p.locator('#saveVersion').click();
            await p.waitForFunction(()=>document.querySelector('#status').textContent==='已保存版本');
            assert.equal(shared.tagCalls,1);assert.equal(await p.locator('#dialog').isVisible(),false);
            await p.locator('#historyButton').click();
            await p.locator('.historyRow.named').first().waitFor();
            assert.equal(await p.locator('.historyGroup').count(),1);
            assert.equal(await p.locator('.historyGroup').evaluate(x=>x.open),false);
            const row=p.locator('.historyRow').filter({hasText:'Named'});
            await row.click({button:'right'});await menu(p,'设置版本名称').click();
            const rename=p.getByRole('textbox',{name:'版本名称'});await rename.fill('Renamed');await rename.press('Enter');
            await p.locator('.historyRow').filter({hasText:'Renamed'}).waitFor();
            const liveBody=await p.evaluate(()=>find('demo-start').body);
            await p.locator('.historyRow').filter({hasText:'Renamed'}).locator('.historyTitle').click();
            await p.locator('#panes > .historicalPane').waitFor();
            assert.equal(await p.locator('#panes > .pane').count(),2);
            assert((await p.locator('.historyPreview').innerText()).includes('Historical body.'));
            assert.equal(await p.locator('.historyPreview [contenteditable=true],.historyPreview math-field').count(),0);
            assert.equal(await p.evaluate(()=>find('demo-start').body),liveBody);
            assert.equal(await p.evaluate(()=>positionSnapshot().panes.length),1);
            await p.getByRole('button',{name:'关闭历史',exact:true}).click();
            assert.equal(await p.locator('#panes > .pane').count(),1);
            await p.locator('#historyButton').click();
            await p.locator('.historyRow').filter({hasText:'Renamed'}).waitFor();
            await p.locator('.historyRow').filter({hasText:'Renamed'}).click({button:'right'});await menu(p,'查看差异').click();
            await p.locator('.historyDiff').waitFor();assert((await p.locator('.historyDiff').innerText()).includes('Historical body.'));
            await p.locator('.historyDetail').getByRole('button',{name:'恢复版本',exact:true}).click();
            await p.waitForFunction(()=>find('demo-start').body==='Historical body.');
            assert.equal(shared.restoreCalls,1);assert.deepEqual(errors,[]);await context.close();
            const mobile=await fixture(browser,true,shared);await mobile.p.locator('#historyButton').tap();
            await mobile.p.locator('.historyRow.named').first().waitFor();assert(await mobile.p.locator('#saveVersion').isVisible());
            await mobile.p.locator('.historyRow').filter({hasText:'Renamed'}).locator('.historyTitle').tap();
            await mobile.p.locator('.historicalPane.activepane').waitFor();
            assert(await mobile.p.locator('.historyPreview').isVisible());
            await mobile.p.locator('.historicalPane').getByRole('button',{name:'切换 首页',exact:true}).tap();
            assert(await mobile.p.locator('#panes > .pane').first().isVisible());
            await mobile.p.locator('#dual').tap();
            assert.equal(await mobile.p.locator('#panes > .pane').count(),1);
            assert.deepEqual(mobile.errors,[]);await mobile.context.close();
            console.log('PASS: direct save tag, grouping, inline rename, diff, restore, mobile history');return
        }
        if(process.argv.includes('--annotation-highlight-only')){
            for(const isMobile of [false,true]){
                const {p,context,errors}=await fixture(browser,isMobile);
                if(isMobile)await p.locator('#editModeToggle').tap();
                await p.evaluate(()=>select('demo-start'));
                const area=p.locator('.pane .part-text .richText').first();
                const original=await p.evaluate(()=>find('demo-start').body);
                const selectQuote=()=>area.evaluate(a=>{
                    a.focus();const t=a.querySelector('p').firstChild,r=document.createRange();
                    r.setStart(t,0);r.setEnd(t,9);getSelection().removeAllRanges();getSelection().addRange(r);
                    const b=r.getBoundingClientRect(),e=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:b.left+2,clientY:b.top+2});e.useCurrentSelection=true;a.dispatchEvent(e);return r.toString();
                });
                const quote=await selectQuote();
                assert(quote.length);
                await menu(p,'插入批注/知识块').click();
                await p.locator('#dialog .visualPickList button').filter({hasText:'Independent note'}).click();
                await p.waitForFunction(quote=>[...(CSS.highlights.get('paper-annotation')||[])].some(r=>r.toString()===quote),quote);
                assert(await p.evaluate(()=>find('demo-free').textBindings.some(b=>b.owner==='demo-start')));
                assert((await p.evaluate(()=>find('demo-start').body)).includes('[[embed:demo-free]]'));
                await p.evaluate(()=>renderPanes());
                await p.waitForFunction(quote=>[...(CSS.highlights.get('paper-annotation')||[])].some(r=>r.toString()===quote),quote);
                await p.evaluate(()=>undo(false));
                await p.waitForFunction(original=>find('demo-start').body===original,original);
                await p.waitForFunction(()=>!CSS.highlights.get('paper-annotation')?.size);
                await selectQuote();
                await menu(p,'新建批注/知识块').click();
                await p.locator('#dialog .richText').first().fill('New selected-text note');
                await p.evaluate(()=>closeWorkbenchDialog());
                await p.waitForFunction(quote=>[...(CSS.highlights.get('paper-annotation')||[])].some(r=>r.toString()===quote),quote);
                assert(await p.evaluate(quote=>db.blocks.some(n=>n.annotation?.owner==='demo-start'&&n.annotation.quote===quote),quote));
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
            await q.getByRole('button',{name:'采用本地版本',exact:true}).click();await q.getByRole('button',{name:'确认合并并保存',exact:true}).click();
            await p.waitForFunction(()=>find('demo-start').body==='Mobile conflict.'&&!dirty);await q.waitForFunction(()=>!dirty&&!conflict);
            assert.deepEqual(desktop.errors,[]);assert.deepEqual(mobile.errors,[]);await desktop.context.close();await mobile.context.close();console.log('PASS: desktop/mobile live refresh, independent sections and objects, conflict draft reload and resolution');return;
        }
        if(process.argv.includes('--reading-switch-only')){await checkTreeReturn(browser,false);await checkTreeReturn(browser,true);console.log('PASS: tree return and shared position across desktop/mobile; explicit network jump');return}
        if(process.argv.includes('--newline-only')){await checkNewlineDeletion(browser,false);await checkNewlineDeletion(browser,true);console.log('PASS: paragraph joins, caret, undo, inline objects, desktop and mobile beforeinput');return}
        if(process.argv.includes('--mixed-range-only')){await checkMixedRange(browser,false);await checkMixedRange(browser,true);console.log('PASS: desktop Shift and mobile long-press cross-object selection, copy, cut and undo');return}
        if(process.argv.includes('--workspace-only')){
            const initial='C:\\Projects\\example.json',network='\\\\server\\share\\network.json';
            const shared={workspace:{id:initial,name:'example.json',path:initial},recent:[],reading:{}};shared.recent=[shared.workspace];
            const desktop=await fixture(browser,false,shared);
            await desktop.p.locator('#openWorkspace').click();
            await desktop.p.getByRole('textbox',{name:'服务器文件路径'}).fill(network);
            await desktop.p.locator('.workspacePathForm button').click();
            await desktop.p.waitForFunction(()=>currentWorkspace?.name==='network.json');assert.equal(shared.requested,network);
            await desktop.p.locator('#blockTab').click();
            await desktop.p.waitForTimeout(650);assert.equal(shared.reading[network].view,'blocks');
            const mobile=await fixture(browser,true,shared);
            assert.equal(await mobile.p.evaluate(()=>view),'blocks');
            await mobile.p.locator('#openWorkspace').tap();
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
                await p.locator('#openWorkspace').click();
                await p.getByRole('button',{name:'新建文件',exact:true}).click();assert.equal(shared.requestedNew,undefined);
                await p.getByRole('textbox',{name:'服务器文件路径'}).fill(initial);
                await p.getByRole('button',{name:'新建文件',exact:true}).click();await p.getByText('文件已存在',{exact:true}).waitFor();
                assert.equal(await p.evaluate(()=>currentWorkspace.name),'existing.json');
                await p.getByRole('textbox',{name:'服务器文件路径'}).fill(target);
                await p.getByRole('button',{name:'新建文件',exact:true}).click();await p.waitForFunction(()=>currentWorkspace?.name==='new.json'&&db.thesis.length===0&&db.blocks.length===0);
                assert.equal(shared.requestedNew,target);
                await p.locator('#openWorkspace').click();await p.getByRole('button',{name:'打开示例文件',exact:true}).click();
                await p.waitForFunction(()=>currentWorkspace?.id==='built-in-example'&&db.thesis.length===2);
                assert.equal(shared.exampleCalls,1);assert.deepEqual(errors,[]);await context.close();
            }
            console.log('PASS: desktop/mobile required new path, collision preserves current document, blank creation and one-click example');return;
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
        await menu(p,'删除知识块/批注').click();
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
        assert(await menu(p,'删除知识块/批注').isVisible());
        await p.evaluate(()=>setView('blocks'));
        await contextAt(p,p.locator('.graph g').first());
        await menu(p,'删除知识块/批注').click();
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
        await fullMobile.tap();
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
        await fullMobile.tap();
        await q.waitForFunction(()=>!document.body.classList.contains('immersiveMode'));
        assert.equal(await q.locator('header').evaluate(e=>e.offsetHeight),originalHeight);
        await q.evaluate(()=>{document.documentElement.requestFullscreen=undefined;document.documentElement.webkitRequestFullscreen=undefined});
        await fullMobile.tap();
        await q.waitForFunction(()=>document.body.classList.contains('immersiveMode'));
        await fullMobile.tap();
        await q.waitForFunction(()=>!document.body.classList.contains('immersiveMode'));
        assert.equal(await q.locator('link[rel="manifest"]').getAttribute('href'),'/manifest.webmanifest');
        await q.evaluate(()=>{delete document.documentElement.requestFullscreen;delete document.documentElement.webkitRequestFullscreen});
        await swipe(12,350,0,-140);
        assert(await h.isVisible());
        const install=q.locator('#installApp');
        await install.tap();
        assert(await q.getByRole('heading',{name:'安装 PaperEditer',exact:true}).isVisible());
        await q.locator('#closeDialog').tap();
        await q.evaluate(()=>{
            const e=new Event('beforeinstallprompt',{cancelable:true});
            e.prompt=async()=>{window.testInstallCalled=true};
            e.userChoice=Promise.resolve({outcome:'accepted'});
            window.dispatchEvent(e);
        });
        await install.tap();
        await q.waitForFunction(()=>window.testInstallCalled===true);
        await fullscreenTouch.detach();
        console.log('PASS: mobile fullscreen fallback, swipe hide/reveal, exit, install instructions and prompt');
        if(process.argv.includes('--fullscreen-only')){assert.deepEqual(mobile.errors,[]);await mobile.context.close();return}
        assert(await q.locator('header button:visible').evaluateAll(buttons=>buttons.every(b=>{const r=b.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})));
        const tools=q.locator('#floatingTools'),toggle=q.locator('#headerActions'),tool=name=>tools.getByRole('button',{name,exact:true});
        await tools.waitFor({state:'visible'});
        assert.equal(await toggle.getAttribute('aria-pressed'),'true');
        assert.equal(await tools.locator('button').count(),9);
        assert.equal(await tools.locator('button svg').count(),9);
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
        console.log('Mobile: verifying read-only annotation');
        await q.locator('#dialog .richText').waitFor({state:'visible'});
        assert.equal(await q.locator('#dialog .richText').first().getAttribute('contenteditable'),'false');
        assert.equal(await q.evaluate(()=>document.activeElement?.isContentEditable),false);
        await q.locator('#workspaceName').tap();
        await q.waitForFunction(()=>!document.querySelector('#dialog').open);
        await mode.tap();
        console.log('Mobile: verifying edit mode');
        assert.equal(await mode.getAttribute('aria-pressed'),'true');
        assert.equal(await target.getAttribute('contenteditable'),'true');
        assert.equal(await q.evaluate(()=>document.activeElement?.isContentEditable),false);
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
        assert.equal(await tool('更多操作').count(),0);
        const rect=await target.boundingBox();
        const x=Math.round(rect.x+20),y=Math.round(rect.y+10);
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:0}]});
        await q.locator('#menu').waitFor({state:'visible'});
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        assert(await menu(q,'新建批注/知识块').isVisible());
        await q.waitForTimeout(550);
        await q.locator('#shortcutSettings').tap();
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
