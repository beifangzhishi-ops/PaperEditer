// Isolated browser regression tests: example.paper is read only, saves are mocked.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const data=JSON.parse(execFileSync('python',['-c',
    "import server,json,base64;from workspace import Package;server.PACKAGE=Package('example.paper');s=server.state();s.update(workspace={'id':'test','name':'example.paper'},originalLabels={},importReport={});print(json.dumps({'state':s,'image':base64.b64encode(server.PACKAGE.read('assets/demo.png')).decode()}))"
],{cwd:__dirname,encoding:'utf8'}));
const origin='http://127.0.0.1:18761';
async function fixture(browser,mobile=false,shared=null){
    const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},hasTouch:mobile,isMobile:mobile,permissions:['clipboard-read','clipboard-write']});
    const p=await context.newPage(),errors=[];
    p.setDefaultTimeout(12000);
    p.on('pageerror',e=>errors.push(e.message));
    p.on('dialog',d=>{errors.push('Unexpected dialog: '+d.message());d.accept()});
    await p.route(origin+'/**',async r=>{
        const u=new URL(r.request().url()),name=u.pathname;
        if(name==='/api/state')return r.fulfill({json:shared?{...data.state,workspace:shared.workspace,readingPosition:shared.reading[shared.workspace.id]||null}:data.state});
        if(name==='/api/reading'){
            if(shared)shared.reading[r.request().headers()['x-paperediter-workspace']]=r.request().postDataJSON();
            return r.fulfill({json:{ok:true}})
        }
        if(shared&&name==='/api/workspaces')return r.fulfill({json:{files:shared.recent.map(x=>({...x,active:x.id===shared.workspace.id})),current:shared.workspace}});
        if(shared&&name==='/api/workspaces/open'){
            const filename=r.request().postDataJSON().path;shared.requested=filename;
            if(filename.endsWith('missing.paper'))return r.fulfill({status:400,json:{error:'文件不存在'}});
            shared.workspace={id:filename,name:filename.split(/[\\/]/).pop(),path:filename};shared.recent=[shared.workspace,...shared.recent.filter(x=>x.path!==filename)];
            return r.fulfill({json:shared.workspace})
        }
        if(name==='/api/save')return r.fulfill({json:{revision:'mock'}});
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
    await p.evaluate(()=>{find('demo-start').body='Alpha start\n\n:::equation range-eq\nx^2\n:::\n\n:::figure range-fig\nA figure\n\n![Swatches](/assets/demo.png "wb-id:range-sub wb-width:20")\n:::\n\nOmega end\n';select('demo-start')});
    const doc=p.locator('.pane .visualDocument').first();
    const first=doc.locator('.part-text .richText').first(),last=doc.locator('.part-text .richText').last();
    const textPoint=async(loc,offset)=>loc.evaluate((a,i)=>{const n=a.querySelector('p').firstChild,r=document.createRange();r.setStart(n,i);r.collapse(true);const b=r.getBoundingClientRect();return {x:b.x,y:b.y+b.height/2}},offset);
    if(mobile){
        const cdp=await context.newCDPSession(p),start=await textPoint(first,2);
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[start]});
        await p.locator('.rangeEnd:visible').waitFor();
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        await p.waitForTimeout(550);
        await last.scrollIntoViewIfNeeded();
        const handle=await p.locator('.rangeEnd:visible').boundingBox(),dest=await textPoint(last,5);
        if(!handle)throw Error('missing range handle');
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:handle.x+handle.width/2,y:handle.y+10}]});
        await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:dest.x,y:dest.y+10}]});
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    }else{
        await first.evaluate(a=>{a.focus();const n=a.querySelector('p').firstChild;getSelection().collapse(n,6)});
        await last.scrollIntoViewIfNeeded();const dest=await textPoint(last,5);await p.keyboard.down('Shift');await p.mouse.click(dest.x,dest.y);await p.keyboard.up('Shift');
    }
    await p.waitForFunction(()=>document.querySelectorAll('.rangeSelected').length===2);
    const copy=await p.evaluate(async()=>{const d=document.querySelector('.pane .visualDocument');await d._clipboardMenu({target:d,useCurrentSelection:true})[1][1]();return localClipboard});
    assert(copy.includes(':::equation ')&&copy.includes(':::figure ')&&copy.includes('Omega')&&!copy.includes(':::equation range-eq'));
    assert.deepEqual(errors,[]);
    if(!mobile){
        const cut=await p.evaluate(async()=>{const d=document.querySelector('.pane .visualDocument');await d._clipboardMenu({target:d,useCurrentSelection:true})[0][1]();return localClipboard});
        assert(cut.includes(':::equation range-eq')&&cut.includes(':::figure range-fig'));
        assert.equal(await p.evaluate(()=>find('demo-start').body.includes(':::figure range-fig')),false);
        await p.evaluate(()=>undo(false));await p.waitForFunction(()=>find('demo-start').body.includes(':::figure range-fig'));
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
async function run(){
    const executablePath=process.env.PAPEREDITER_CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined);
    const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
    try{
        if(process.argv.includes('--newline-only')){await checkNewlineDeletion(browser,false);await checkNewlineDeletion(browser,true);console.log('PASS: paragraph joins, caret, undo, inline objects, desktop and mobile beforeinput');return}
        if(process.argv.includes('--mixed-range-only')){await checkMixedRange(browser,false);await checkMixedRange(browser,true);console.log('PASS: desktop Shift and mobile long-press cross-object selection, copy, cut and undo');return}
        if(process.argv.includes('--workspace-only')){
            const initial='C:\\Projects\\example.paper',network='\\\\server\\share\\network.paper';
            const shared={workspace:{id:initial,name:'example.paper',path:initial},recent:[],reading:{}};shared.recent=[shared.workspace];
            const desktop=await fixture(browser,false,shared);
            await desktop.p.locator('#openWorkspace').click();
            await desktop.p.getByRole('textbox',{name:'服务器文件路径'}).fill(network);
            await desktop.p.locator('.workspacePathForm button').click();
            await desktop.p.waitForFunction(()=>currentWorkspace?.name==='network.paper');assert.equal(shared.requested,network);
            await desktop.p.locator('#blockTab').click();
            await desktop.p.waitForTimeout(650);assert.equal(shared.reading[network].view,'blocks');
            const mobile=await fixture(browser,true,shared);
            assert.equal(await mobile.p.evaluate(()=>view),'blocks');
            await mobile.p.locator('#openWorkspace').tap();
            await mobile.p.getByRole('textbox',{name:'服务器文件路径'}).fill('C:\\Projects\\missing.paper');
            await mobile.p.locator('.workspacePathForm button').tap();
            await mobile.p.getByText('文件不存在',{exact:true}).waitFor();assert.equal(await mobile.p.evaluate(()=>currentWorkspace.name),'network.paper');
            await mobile.p.locator('.workspaceRecent').filter({hasText:'example.paper'}).tap();
            await mobile.p.waitForFunction(()=>currentWorkspace?.name==='example.paper');assert.equal(shared.requested,initial);
            assert.deepEqual(desktop.errors,[]);assert.deepEqual(mobile.errors,[]);await desktop.context.close();await mobile.context.close();console.log('PASS: desktop and mobile path input, UNC forwarding, shared history and reading, invalid path preserves document');return;
        }
        const {p,context,errors}=await fixture(browser);
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
        let swipeId=0;
        async function swipe(x,y,dx,dy){
            const id=++swipeId;
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
        await q.waitForFunction(y=>Math.abs(document.querySelector('#floatingTools').getBoundingClientRect().top-y)>30,dock.y);
        const selectionPosition=await tools.boundingBox();
        assert(selectionPosition.y>=0&&selectionPosition.y+selectionPosition.height<=844);
        const cdp=await mobile.context.newCDPSession(q);
        async function hold(locator,label){
            // The floating toolbar follows the caret asynchronously. Wait for
            // its layout to settle before sending raw touch coordinates.
            await locator.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
            const rect=await locator.boundingBox(),x=Math.round(rect.x+rect.width/2),y=Math.round(rect.y+rect.height/2);
            await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
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
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
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
