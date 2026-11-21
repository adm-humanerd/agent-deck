import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,readFile,writeFile,mkdir,access,rm} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {createRequestHandler} from '../server.mjs';
import {createSessions} from '../src/host/connections.mjs';
import {createLayoutStore} from '../src/deck/shared-layout.mjs';
import {defaultDeckLayouts} from '../src/deck/deck-layout.mjs';

// Real HTTP, authority checks, atomic store and served canonical HTML. Only data adapters are synthetic.
test('whole-key authoring, frozen CAS and independent paired runtimes', {timeout:240000}, async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'deck-browser-'));
 const artifacts=process.env.DECK_TEST_ARTIFACT_DIR||path.join(dir,'evidence');await mkdir(artifacts,{recursive:true});
 const events=[],errors=[],calls=[],puts=[];
 const startedAt=new Date().toISOString();
 const record=(action,detail)=>events.push({timestamp:new Date().toISOString(),action,detail,status:'passed'});
 const address=Object.values(os.networkInterfaces()).flat().find(x=>x.family==='IPv4'&&!x.internal)?.address;
 assert.ok(address,'Non-loopback IPv4 required for real remote authority checks');
 const file=path.join(dir,'layouts.json'),sessionFile=pathToFileURL(path.join(dir,'sessions.json'));
 let store=createLayoutStore(file),handler;
 const server=http.createServer((req,res)=>handler(req,res));
 await new Promise(r=>server.listen(0,'0.0.0.0',r));const port=server.address().port;
 const localURL=`http://127.0.0.1:${port}`,remoteURL=`http://${address}:${port}`,changedURL=`http://deck-reconnect.test:${port}`;
 const agents=Array.from({length:37},(_,i)=>({pane_id:'p'+i,id:'p'+i,label:'세션 '+(i+1),agent:'codex',agent_status:i===0||i===36?'blocked':'working',text:'허용할까요?\n'+('검증 내용\n'.repeat(100))+'1. 허용\n2. 거절',choices:[{key:'1',label:'허용'},{key:'2',label:'거절'}],ticket:'t'+i}));
 const state=()=>({ok:true,agents,sessions:agents,version:'fixture',updated:new Date().toISOString()});
 const runner={refresh:async()=>state(),focus:async data=>{calls.push(['focus',data]);return {ok:true};},respond:async data=>{calls.push(['respond',data]);return {ok:true};}};
 const sessions=await createSessions(sessionFile);
 const options={sessions,layouts:store,bridge:runner,nativeHerdr:runner,network:{refresh:async()=>({ok:true,sessions:agents.map(a=>({id:a.id,name:a.label,agent:a.agent,status:'idle',address:'fixture'})),onlineCount:37})},quotas:{refresh:async()=>({providers:['codex','agy'].map(provider=>({provider,checkedAt:new Date().toISOString(),stale:false,error:null,models:[],buckets:[{id:'main',label:'활성계정',fiveHour:{remaining:37,resetsAt:null},weekly:{remaining:62,resetsAt:null}}]}))})},pin:'123456',listenPort:port,addresses:()=>[{address,url:remoteURL}]};
 handler=createRequestHandler(options);
 let executablePath=process.env.DECK_BROWSER_PATH;
 if(!executablePath){try{await access('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');executablePath='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';}catch{}}
 const browser=await chromium.launch({headless:true,executablePath,args:[`--host-resolver-rules=MAP deck-reconnect.test ${address}`]});
 const pcContext=await browser.newContext({viewport:{width:1440,height:1000}}),pcBContext=await browser.newContext({viewport:{width:1024,height:900}});
 const remoteContext=await browser.newContext({viewport:{width:834,height:1112},hasTouch:true,isMobile:true}),remoteBContext=await browser.newContext({viewport:{width:1112,height:834},hasTouch:true,isMobile:true});
 const pc=await pcContext.newPage(),pcB=await pcBContext.newPage(),remote=await remoteContext.newPage(),remoteB=await remoteBContext.newPage();
 for(const page of [pc,pcB,remote,remoteB]){page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='PUT'&&r.url().endsWith('/api/custom-layout'))puts.push(JSON.parse(r.postData()));});}
 const wait=(page,fn)=>page.waitForFunction(fn,null,{timeout:15000});
 const pageUI=async id=>pc.locator('#editorPages button[data-page="'+id+'"]').click();
 const assign=async(index,action)=>{if(!await pc.evaluate(()=>deckEditing))await pc.locator('#editDeck').click();await pc.locator('#keys button').nth(index).click();await pc.locator('#keyAssignment').selectOption(JSON.stringify(action));await pc.locator('#saveAssignment').click();await pc.waitForFunction(()=>editingSlot===null&&!layoutSaving);};
 const key=(page,index)=>page.locator('#keys button[data-key-id]').nth(index);
 const pair=async page=>{await page.goto(remoteURL);await page.locator('#code').fill('123456');await page.locator('#pairButton').click();await wait(page,()=>layoutRevision!==null&&!deckLocal);};
 try{
  const legacy=defaultDeckLayouts();legacy.push({id:'custom-preserved',name:'보존한 사용자 페이지',slots:Array.from({length:15},(_,i)=>({type:'key',key:i===0?'esc':'enter'}))});legacy[1].slots[10]={type:'page',page:'custom-preserved'};legacy[1].slots[11]={type:'context'};legacy[3].slots[14]={type:'page',page:'agents'};
  await pcContext.addInitScript(value=>{if(!localStorage.getItem('agentDeck.layouts.v2'))localStorage.setItem('agentDeck.layouts.v2',JSON.stringify(value));},legacy);
  await remoteContext.addInitScript(value=>localStorage.setItem('agentDeck.layouts.v2',JSON.stringify(value)),defaultDeckLayouts());
  await pc.goto(localURL);await wait(pc,()=>layoutRevision===0&&deckLocal);
  await pc.locator('#editDeck').click();assert.equal(await pc.evaluate(()=>deckEditing),false);assert.equal((await store.get()).initialized,false);
  await pc.locator('#importLayout').click();await wait(pc,()=>layoutRevision===1);
  assert.deepEqual((await store.get()).layouts,legacy);assert.deepEqual(JSON.parse(await pc.evaluate(()=>localStorage.getItem('agentDeck.layouts.v2'))),legacy);
  record('explicit-local-import','Exact legacy payloads imported; original localStorage preserved; no automatic initialization');
  await pcB.goto(localURL);await wait(pcB,()=>layoutRevision===1&&deckLocal);
  assert.equal((await fetch(remoteURL+'/api/layout')).status,401);
  await pair(remote);await pair(remoteB);
  for(const id of ['deckLayoutToolbar','editDeck','addDeckPage','resetDeck','connectBtn'])assert.equal(await remote.locator('#'+id).isVisible(),false,id);
  await remote.evaluate(()=>{openKeyEditor(0);$('editDeck').onclick();$('addDeckPage').onclick();$('resetDeck').onclick();$('connectBtn').onclick();$('confirmReset').onclick();$('pageName').value='forged';$('pageForm').onsubmit({preventDefault(){}});$('saveAssignment').onclick();$('importLayout').onclick();});
  assert.equal(await remote.evaluate(()=>deckEditing||!!document.querySelector('dialog[open]')),false);
  const denied=await remote.evaluate(async()=>{const r=await fetch('/api/layout',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:layoutRevision,layouts:deckLayouts})});return r.status;});assert.equal(denied,403);
  assert.deepEqual((await store.get()).layouts,legacy);record('remote-authority','Unauthenticated GET401; paired remote forced editor inert and PUT403');
  if(!await pc.locator('#navCheckDetails').evaluate(e=>e.open))await pc.locator('#navCheckDetails summary').click();
  await pc.locator('#connectionPlan').selectOption([JSON.stringify({type:'sessions'}),JSON.stringify({type:'page',page:'quota'})]);assert.match(await pc.locator('#graphStatus').textContent(),/연결 2개 · 빈 키 0개 · 추가 빈 키 2개/);await pc.locator('#connectionPlan').selectOption([]);

  // A blocks occupied navigation insertion without altering even the local candidate.
  if(!await pc.evaluate(()=>deckEditing))await pc.locator('#editDeck').click();
  await key(pc,0).click();
  const fullBefore=await pc.evaluate(()=>JSON.stringify(editorLayouts()));
  await pc.locator('#keyAssignment').selectOption(JSON.stringify({type:'sessions'}));
  assert.match(await pc.locator('#layoutStatus').textContent(),/필요한 빈 키 추가 1개/);
  await pc.locator('#saveAssignment').click();assert.match(await pc.locator('#layoutStatus').textContent(),/사용 중/);
  assert.equal(await pc.evaluate(()=>JSON.stringify(editorLayouts())),fullBefore);assert.deepEqual((await store.get()).layouts,legacy);
  await pc.screenshot({path:path.join(artifacts,'editor-blocked.png'),fullPage:true});await pc.locator('#cancelAssignment').click();
  record('A-full-page-block','Occupied root key rejects sessions insertion, exact one-empty-key deficit, no movement/deletion/store write');

  // Explicit ordinary preparation remains possible on an existing disconnected graph.
  for(const index of [12,13,14]){await assign(index,{type:'empty'});}
  await wait(pc,()=>layoutRevision===4);
  await pc.locator('#addDeckPage').click();await pc.locator('#autoLinkPage').uncheck();await pc.locator('#pageName').fill('직접 준비한 페이지');await pc.getByRole('button',{name:'추가',exact:true}).click();
  const newID=await pc.evaluate(()=>deckProfile);
  assert.equal(await pc.evaluate(()=>currentDeckLayout().slots.filter(s=>s.type==='empty').length),15);
  assert.equal((await store.get()).layouts.length,4);
  const incompleteDraft=await pc.evaluate(()=>JSON.stringify(deckCandidate)),incompleteBytes=await readFile(file,'utf8'),incompletePuts=puts.length;
  for(const page of ['agents','custom-preserved']){await pageUI(page);await pc.locator('#resetDeck').click();await pc.locator('#confirmReset').click();assert.match(await pc.locator('#layoutStatus').textContent(),/저장 차단/);assert.equal(await pc.locator('#resetDialog .layout-error').isVisible(),true);assert.match(await pc.locator('#resetDialog .layout-error').textContent(),/저장 차단/);assert.equal(puts.length,incompletePuts);assert.equal(await readFile(file,'utf8'),incompleteBytes);assert.equal(await pc.evaluate(()=>JSON.stringify(deckCandidate)),incompleteDraft);await pc.locator('#cancelReset').click();}
  record('shared-publication-boundary','Incomplete navigation draft cannot escape via confirmed default reset or custom deletion: zero PUT, byte-identical store, unchanged candidate/base');
  await pageUI(newID);
  await assign(0,{type:'quota',provider:'codex'});await assign(14,{type:'page',page:'agents'});
  await pc.locator('#saveCandidate').click();assert.match(await pc.locator('#layoutStatus').textContent(),/저장 차단/);assert.equal((await store.get()).revision,4);
  await pageUI('agents');await assign(12,{type:'sessions'});await assign(13,{type:'page',page:'quota'});await assign(14,{type:'page',page:newID});
  assert.match(await pc.locator('#graphStatus').textContent(),/탐색 준비 완료/);
  const prepared=await pc.evaluate(()=>structuredClone(deckCandidate.layouts));
  await pc.locator('#saveCandidate').click();await wait(pc,()=>layoutRevision===5&&!deckCandidate);
  assert.deepEqual((await store.get()).layouts,prepared);assert.deepEqual(prepared[0].slots.slice(0,12),legacy[0].slots.slice(0,12));assert.deepEqual(prepared[1],legacy[1]);assert.deepEqual(prepared[3],legacy[3]);
  await pc.screenshot({path:path.join(artifacts,'editor-prepared.png'),fullPage:true});
  record('A-explicit-preparation','Three individually cleared root keys, blank new-page candidate, explicit links plus bank entry; incomplete graph blocked; one complete CAS publication; unrelated authored bytes conserved');

  // PC preview, inline editing, keyboard navigation and all viewport geometry.
  const beforePreview=calls.length;if(!await pc.evaluate(()=>deckEditing))await pc.locator('#editDeck').click();await key(pc,1).click();
  assert.equal(await pc.evaluate(()=>document.querySelector('#keyEditor').matches(':modal')),false);
  assert.equal(await pc.locator('#keyAssignment').evaluate(e=>e===document.activeElement),true);
  await pc.keyboard.press('2');await pc.keyboard.press('Enter');assert.equal(calls.length,beforePreview);
  for(const size of [{width:1440,height:1000},{width:1024,height:900},{width:390,height:844}]){
   await pc.setViewportSize(size);await pc.evaluate(()=>{document.activeElement.blur();window.scrollTo(0,0);});
   assert.equal(await pc.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(await pc.locator('#keys button').count(),15);assert.equal(await pc.locator('#keyAssignment').isVisible(),true);
   await pc.screenshot({path:path.join(artifacts,`editor-${size.width}.png`),fullPage:size.width!==390});
   if(size.width===390){
    for(let index=0;index<15;index++){
     await key(pc,index).evaluate(button=>button.scrollIntoView({block:'center',behavior:'instant'}));await pc.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
     const box=await key(pc,index).boundingBox();assert.ok(box.y>=0&&box.y+box.height<=size.height&&box.x>=0&&box.x+box.width<=size.width,JSON.stringify({index,box}));
     if(index%3===0)await pc.screenshot({path:path.join(artifacts,`editor-390-row-${index/3}.png`)});
    }
    await pc.locator('#keyAssignment').evaluate(select=>select.scrollIntoView({block:'center',behavior:'instant'}));await pc.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    const control=await pc.locator('#keyAssignment').boundingBox();assert.ok(control.y>=0&&control.y+control.height<=size.height);await pc.screenshot({path:path.join(artifacts,'editor-390-settings.png')});record('narrow-scrolling-access',{all15KeysIndividuallyInViewport:true,selectedControl:control,fullPageCapture:false});
   }
  }
  await pc.setViewportSize({width:1440,height:1000});await pc.keyboard.press('Escape');assert.equal(await pc.locator('#keyEditor').isVisible(),false);await pc.keyboard.press('Enter');assert.equal(await pc.locator('#keyAssignment').evaluate(e=>e===document.activeElement),true);
  for(const id of ['customLabel','customSymbol','customColor','customImage','removeCustomImage','cancelAssignment']){await pc.keyboard.press('Tab');assert.equal(await pc.locator('#'+id).evaluate(e=>e===document.activeElement),true,id+' keyboard traversal');}
  await pc.locator('#cancelAssignment').click();await pc.locator('#editDeck').click();
  await key(pc,0).click();await wait(pc,()=>deckProfile==='response');await pc.evaluate(()=>ask(active(),'1','1'));assert.equal(calls.length,beforePreview);
  await pageUI('agents');await key(pc,12).click();await key(pc,14).click();assert.equal(calls.length,beforePreview);assert.equal(await remote.evaluate(()=>deckCursor().kind),'authored');
  record('PC-preview-independence','Wide/intermediate/narrow editor, keyboard focus/Escape, preview selection and bank navigation send zero focus/respond and do not move either remote');

  await remote.waitForFunction(()=>layoutRevision===5);await remoteB.waitForFunction(()=>layoutRevision===5);
  await key(remote,14).tap();await remote.waitForFunction(id=>deckProfile===id,newID);
  await remote.waitForFunction(()=>document.querySelector('.quota-key [role="meter"]')?.getAttribute('aria-valuenow')==='37');await remote.locator('.quota-key').tap();assert.equal(await remote.locator('#quotaDetail').isVisible(),true);await remote.locator('#closeQuota').click();
  for(const size of [{width:834,height:1112},{width:1112,height:834},{width:768,height:1024},{width:1024,height:768}]){
   await remote.setViewportSize(size);
   const geometry=await remote.evaluate(()=>{const d=document.querySelector('.device'),r=d.getBoundingClientRect(),s=getComputedStyle(d);return {height:innerHeight,width:innerWidth,scrollHeight:document.documentElement.scrollHeight,scrollWidth:document.documentElement.scrollWidth,top:r.top,bottom:r.bottom,left:r.left,right:r.right,radius:s.borderRadius,border:s.borderTopWidth,shadow:s.boxShadow,background:s.backgroundImage,keys:[...document.querySelectorAll('#keys .key')].map(k=>{const r=k.getBoundingClientRect();return {width:r.width,height:r.height};}),external:[...document.querySelectorAll('button,select,a,input')].filter(e=>e.getClientRects().length&&!e.closest('#keys,dialog,[hidden]')).map(e=>e.id),hover:matchMedia('(hover:hover)').matches};});
   assert.ok(geometry.scrollHeight<=size.height&&geometry.scrollWidth<=size.width,JSON.stringify(geometry));assert.ok(geometry.top>=10&&geometry.bottom<=size.height&&geometry.left>=10&&geometry.right<=size.width);assert.ok(parseFloat(geometry.radius)>=20&&parseFloat(geometry.border)>=2);assert.notEqual(geometry.shadow,'none');assert.match(geometry.background,/linear-gradient/);assert.equal(geometry.keys.length,15);assert.ok(geometry.keys.every(k=>Math.abs(k.width-k.height)<1&&k.width>=150));assert.deepEqual(geometry.external,[]);assert.equal(geometry.hover,false);
   await remote.screenshot({path:path.join(artifacts,`housing-${size.width}x${size.height}.png`)});record('square-graphite-housing',geometry);
  }
  await key(remote,14).tap();await wait(remote,()=>deckProfile==='agents');
  const graphCalls=calls.length;
  for(const [index,id] of [[13,'quota'],[13,'response'],[10,'custom-preserved'],[14,'agents'],[14,newID],[14,'agents']]){await key(remote,index).tap();assert.equal(await remote.evaluate(()=>deckProfile),id);}
  assert.equal(calls.length,graphCalls);record('complete-authored-navigation','Every authored page reached from root and returned using whole navigation keys only; zero focus/respond including full manual custom page');
  const beforePaging=calls.length;await key(remote,12).tap();assert.equal(await key(remote,13).isDisabled(),true);
  for(const [pageIndex,count] of [[0,12],[1,12],[2,12],[3,1]]){assert.equal(await remote.locator('#keys button.session:not(:disabled)').count(),count);assert.equal(await remote.evaluate(()=>bankMemory[deckView]),pageIndex);await remote.screenshot({path:path.join(artifacts,`bank-${pageIndex}.png`)});if(pageIndex<3)await key(remote,14).tap();}
  assert.equal(await key(remote,14).isDisabled(),true);assert.equal(calls.length,beforePaging);assert.equal(await remoteB.evaluate(()=>deckCursor().kind),'authored');
  await key(remote,0).tap();await wait(remote,()=>deckProfile==='response'&&selectedPane==='p36');assert.ok(calls.some(([a,d])=>a==='focus'&&d.id==='p36'));
  assert.equal(await remote.locator('.pending-sessions').count(),1);await remote.emulateMedia({reducedMotion:'reduce'});assert.equal(await remote.locator('.pending-sessions').evaluate(e=>getComputedStyle(e).animationName),'none');await remote.emulateMedia({reducedMotion:'no-preference'});
  const sent=calls.length;await remote.locator('#keys button.option').first().tap();await wait(remote,()=>!sending);assert.equal(calls.filter(([a])=>a==='respond').length,1);assert.equal(calls.length,sent+1);
  await key(remote,11).tap();await remote.locator('#requestDetail .request-original summary').click();assert.equal(await remote.locator('#requestDetail').isVisible(),true);await remote.locator('#closeDeckRequest').click();
  await key(remote,14).tap();await key(remote,12).tap();assert.equal(await remote.evaluate(()=>bankMemory.native),3);await key(remote,12).tap();assert.equal(await remote.evaluate(()=>deckProfile),'agents');
  assert.deepEqual((await store.get()).layouts,prepared);record('whole-key-37-sessions','12/12/12/1, disabled non-wrapping boundaries, last session native focus/respond once, pending/reduced motion/request/quota and remembered return path; canonical unchanged');

  // Every source uses the same projection. Reason is always read-only.
  for(const source of ['native','herdr','reason']){await remote.evaluate(view=>setDeckView(view),source);await remote.waitForFunction(view=>deckView===view,source);await remote.waitForFunction(()=>deckSourceSessions().length===37);for(const target of [0,18,36]){await remote.evaluate(()=>setDeckProfile('agents'));await key(remote,12).tap();const destination=Math.floor(target/12);while(await remote.evaluate(()=>bankMemory[deckView])<destination)await key(remote,14).tap();while(await remote.evaluate(()=>bankMemory[deckView])>destination)await key(remote,13).tap();const before=calls.length;await key(remote,target%12).tap();await remote.waitForFunction(({source,id})=>deckProfile==='response'&&(source==='reason'?networkSelected:selectedPane)===id,{source,id:'p'+target});if(source==='reason')assert.equal(calls.length,before);else{assert.equal(calls.length,before+1);assert.deepEqual(calls.at(-1),['focus',source==='native'?{id:'p'+target}:{pane:'p'+target}]);}if(target===18||source==='reason')assert.equal(await remote.locator('#keys button.option:not(:disabled)').count(),0);}await remote.evaluate(()=>setDeckProfile('agents'));}
  record('all-source-banks','Native/TUI/Reason first/middle/last exact identities selected; native id versus TUI pane focus; working/Reason responses disabled; Reason sends zero');

  // Local owner lifecycle, unchanged polling, changed ticket/layout and no action replay.
  await remote.evaluate(()=>setDeckView('native'));await remote.waitForFunction(()=>deckView==='native'&&current?.agents.length===37);await remote.evaluate(()=>{setDeckProfile('response');selectedPane='p36';redrawDeck();});
  const responseKey=remote.locator('#keys button.option').first();
  const down=async()=>{
   // Polling replaces key DOM nodes. Acquire a live visible rectangle rather
   // than asserting that a node survives Playwright's separate lookup step.
   const handle=await remote.waitForFunction(()=>{const button=document.querySelector('#keys button.option');if(!button)return null;const rect=button.getBoundingClientRect();return rect.width&&rect.height?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null;},null,{timeout:15000});
   const box=await handle.jsonValue();await handle.dispose();await remote.mouse.move(box.x+box.width/2,box.y+box.height/2);await remote.mouse.down();
  };
  await wait(remote,()=>!nativeBusy&&!recoveryBusy);
  let releaseFailedNative,markNativeStarted;const nativeHeld=new Promise(resolve=>{releaseFailedNative=resolve;}),nativeStarted=new Promise(resolve=>{markNativeStarted=resolve;});
  await remote.route('**/api/native/state',async route=>{markNativeStarted();await nativeHeld;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'fixture native recovery unavailable'})});});
  const recoveryCalls=calls.length;
  await remote.evaluate(()=>{window.dispatchEvent(new Event('offline'));void recoverConnection();});await nativeStarted;
  assert.equal(await remote.evaluate(()=>recoveryBusy&&nativeBusy&&!online),true);assert.equal(await remote.locator('#errorNotice').evaluate(e=>e.hidden),false);assert.match(await remote.locator('#errorText').textContent(),/네트워크 연결이 끊겼습니다/);
  releaseFailedNative();await wait(remote,()=>!recoveryBusy&&!nativeBusy);assert.equal(await remote.evaluate(()=>online),false);assert.equal(await remote.locator('#errorNotice').evaluate(e=>e.hidden),false);assert.match(await remote.locator('#deviceStatus').textContent(),/입력 잠금/);assert.equal(calls.length,recoveryCalls);
  await remote.screenshot({path:path.join(artifacts,'native-recovery-failed.png')});await remote.unroute('**/api/native/state');await remote.evaluate(()=>refreshNative());await wait(remote,()=>online&&!nativeBusy);assert.equal(await remote.locator('#errorNotice').evaluate(e=>e.hidden),true);assert.equal(calls.length,recoveryCalls);await remote.evaluate(()=>{selectedPane='p36';setDeckProfile('response');redrawDeck();});
  record('metadata-is-not-native-recovery','Paired info/layout succeed while native state is held then503: warning remains before/after failure, online false/input locked, no action calls; only subsequent successful native read clears warning and restores eligibility');
  await remote.evaluate(()=>setDeckView('reason'));await wait(remote,()=>!networkBusy&&networkState?.ok);
  const reasonSnapshot=await remote.evaluate(()=>structuredClone(networkState)),reasonCalls=calls.length;
  let releaseReason,markReasonStarted;const reasonHeld=new Promise(resolve=>{releaseReason=resolve;}),reasonStarted=new Promise(resolve=>{markReasonStarted=resolve;});
  await remote.route('**/api/network',async route=>{markReasonStarted();await reasonHeld;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'fixture Reason unavailable'})});});
  await remote.evaluate(()=>{showError('fixture Reason disconnect warning');void refreshNetwork();});await reasonStarted;assert.equal(await remote.locator('#errorNotice').evaluate(e=>e.hidden),false);releaseReason();await wait(remote,()=>!networkBusy);assert.equal(await remote.locator('#errorNotice').evaluate(e=>e.hidden),false);assert.match(await remote.locator('#errorText').textContent(),/fixture Reason disconnect/);await remote.unroute('**/api/network');
  await remote.route('**/api/network',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...reasonSnapshot,ok:false,error:'fixture adapter unavailable'})}));await remote.evaluate(()=>refreshNetwork());assert.equal(await remote.locator('#errorNotice').evaluate(e=>e.hidden),false);await remote.unroute('**/api/network');
  await remote.evaluate(()=>refreshNetwork());await wait(remote,()=>!networkBusy&&networkState?.ok);assert.equal(await remote.locator('#errorNotice').evaluate(e=>e.hidden),true);assert.equal(calls.length,reasonCalls);
  let releaseLateReason,markLateReasonStarted;const lateReasonHeld=new Promise(resolve=>{releaseLateReason=resolve;}),lateReasonStarted=new Promise(resolve=>{markLateReasonStarted=resolve;});
  await remote.route('**/api/network',async route=>{markLateReasonStarted();await lateReasonHeld;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(reasonSnapshot)});});await remote.evaluate(()=>{showError('fixture Reason prior warning');void refreshNetwork();});await lateReasonStarted;await remote.evaluate(()=>setDeckView('native'));await wait(remote,()=>!nativeBusy&&online);await remote.evaluate(()=>showError('fixture native current warning'));releaseLateReason();await wait(remote,()=>!networkBusy);assert.equal(await remote.evaluate(()=>deckView),'native');assert.equal(await remote.locator('#errorNotice').evaluate(e=>e.hidden),false);assert.match(await remote.locator('#errorText').textContent(),/fixture native current warning/);assert.equal(calls.length,reasonCalls);await remote.unroute('**/api/network');await remote.evaluate(()=>refreshNative());await wait(remote,()=>online&&!nativeBusy);await remote.evaluate(()=>{selectedPane='p36';setDeckProfile('response');redrawDeck();});
  record('reason-warning-source-ownership','Actual refreshNetwork retains existing warning through held read, HTTP503 and ok:false; active Reason ok:true clears it; late successful Reason response after switching native cannot clear current native warning; zero focus/respond throughout');
  let offlineCalls=calls.length;await remote.evaluate(()=>window.dispatchEvent(new Event('offline')));assert.equal(await remote.evaluate(()=>online),false);assert.equal(await responseKey.isDisabled(),true);assert.equal(await remote.locator('#errorNotice').evaluate(e=>e.hidden),false);assert.match(await remote.locator('#errorText').textContent(),/네트워크 연결이 끊겼습니다/);assert.equal(await remote.locator('#connection').evaluate(e=>e.classList.contains('offline')),true);assert.match(await remote.locator('#status').textContent(),/연결 끊김/);assert.match(await remote.locator('#deviceStatus').textContent(),/입력 잠금/);assert.match(await remote.locator('#footerState').textContent(),/마지막 조회 데이터/);await down();await remote.mouse.up();await responseKey.evaluate(button=>button.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:0})));await remote.keyboard.press('Enter');assert.equal(calls.length,offlineCalls,'Fresh offline pointer/keyboard/assistive attempts send zero');await remote.evaluate(()=>refreshNative());await wait(remote,()=>online);assert.equal(await responseKey.isEnabled(),true,'Unchanged cached native snapshot reenables after online recovery');assert.equal(await remote.locator('#errorNotice').evaluate(e=>e.hidden),true);assert.equal(await remote.locator('#connection').evaluate(e=>e.classList.contains('offline')),false);record('offline-latch-and-cached-recovery','Detected offline retains disconnect notice/status and disables fresh pointer/keyboard/assistive execution immediately; unchanged successful read clears warning, invalidates cache and reenables response');
  for(const cancel of [()=>remote.evaluate(()=>window.dispatchEvent(new Event('blur'))),()=>remote.evaluate(()=>window.dispatchEvent(new Event('pagehide'))),()=>remote.evaluate(()=>window.dispatchEvent(new Event('offline'))),()=>remote.evaluate(()=>setDeckProfile('agents')),()=>remote.evaluate(async()=>{await setDeckView('herdr');await setDeckView('native');}),()=>remote.mouse.move(0,0)]){const before=calls.length;await down();await cancel();await remote.mouse.up();assert.equal(calls.length,before);assert.equal(await remote.locator('.pressed').count(),0);await remote.evaluate(()=>refreshNative());await wait(remote,()=>online&&!nativeBusy);await remote.evaluate(()=>{selectedPane='p36';setDeckProfile('response');redrawDeck();});assert.equal(await responseKey.isEnabled(),true);}
  let before=calls.length;await down();await remote.evaluate(()=>refreshNative());await remote.mouse.up();await wait(remote,()=>!sending);assert.equal(calls.length,before+1,'Unchanged poll permits one original activation');
  before=calls.length;await down();await remote.evaluate(()=>window.dispatchEvent(new Event('pagehide')));await remote.mouse.up();assert.equal(calls.length,before);await responseKey.focus();await remote.keyboard.press('Enter');await wait(remote,()=>!sending);assert.equal(calls.length,before+1,'Live keyboard activation after pointer cancellation sends exactly once');record('runtime-keyboard-after-cancel','Physical pointer cancelled0; focus and real keyboard Enter activation1 without pointer record');
  const originalOrder=[...agents];before=calls.length;await down();agents.reverse();await remote.evaluate(()=>refreshNative());await remote.mouse.up();assert.equal(calls.length,before);agents.splice(0,agents.length,...originalOrder);await remote.evaluate(()=>refreshNative());await remote.evaluate(()=>{selectedPane='p36';redrawDeck();});before=calls.length;await down();agents.splice(agents.findIndex(a=>a.pane_id==='p36'),1);await remote.evaluate(()=>refreshNative());await remote.mouse.up();assert.equal(calls.length,before);agents.splice(0,agents.length,...originalOrder);await remote.evaluate(()=>refreshNative());await remote.evaluate(()=>{selectedPane='p36';redrawDeck();});record('session-reorder-removal-during-down','Reordered source mapping and removed selected target both cancel original physical press with zero calls; no replay after restoring fixtures');
  before=calls.length;await down();agents[36].ticket='changed-ticket';await remote.evaluate(()=>refreshNative());await remote.mouse.up();assert.equal(calls.length,before,'Changed ticket cancels');
  before=calls.length;await down();await remoteContext.setOffline(true);await remote.mouse.up();await remoteContext.setOffline(false);await remote.evaluate(()=>recoverConnection());await wait(remote,()=>online&&!recoveryBusy);assert.equal(calls.length,before);assert.equal(await remote.locator('.pressed').count(),0);
  before=calls.length;await remote.route('**/api/native/respond',async route=>{await route.fetch();await route.abort('failed');});await responseKey.tap();await wait(remote,()=>!sending);await remote.waitForFunction(()=>document.querySelector('#toast').textContent.includes('자동 재전송하지 않습니다'));assert.equal(calls.length,before+1);await remote.unroute('**/api/native/respond');await remote.evaluate(()=>recoverConnection());assert.equal(calls.length,before+1,'Ambiguous delivery never retries');
  before=calls.length;await down();assert.equal(await pcB.evaluate(async()=>{const {schemaVersion,revision,layouts,actions,assets}=await (await fetch('/api/custom-layout')).json();layouts[0].name='revision cancel fixture';const r=await fetch('/api/custom-layout',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({schemaVersion,revision,layouts,actions,assets})});return r.status;}),200);await remote.evaluate(()=>loadSharedLayouts());await remote.mouse.up();assert.equal(calls.length,before,'New layout revision cancels original press');
  const emptyBytes=await readFile(file,'utf8');await key(remote,14).tap();await key(remote,12).tap();agents.splice(0);await remote.evaluate(()=>refreshNative());assert.equal(await remote.locator('#keys button.session').count(),0);assert.equal(await key(remote,12).isEnabled(),true);assert.equal(await key(remote,13).isDisabled(),true);assert.equal(await key(remote,14).isDisabled(),true);await remote.screenshot({path:path.join(artifacts,'bank-empty.png')});await key(remote,12).tap();agents.push(...originalOrder);await remote.evaluate(()=>refreshNative());assert.equal(await readFile(file,'utf8'),emptyBytes);record('empty-bank-recovery','N=0 bank retains Return and disabled boundaries, no persisted cursor or layout mutation; source restored by reads');
  before=calls.length;handler=createRequestHandler({...options,addresses:()=>[{address,url:remoteURL},{address:'deck-reconnect.test',url:changedURL}]});await remote.goto(changedURL);assert.equal(await remote.locator('#pair').isVisible(),true);await remote.locator('#code').fill('123456');await remote.locator('#pairButton').click();await wait(remote,()=>online&&layoutRevision!==null&&!deckLocal);assert.equal(calls.length,before);assert.equal(await readFile(file,'utf8'),emptyBytes);await remote.goto(remoteURL);await wait(remote,()=>online&&layoutRevision!==null&&!deckLocal);assert.equal(await remote.locator('#pair').isVisible(),false);assert.equal(calls.length,before);handler=createRequestHandler(options);record('changed-origin-recovery','A distinct fixture hostname resolves to same real non-loopback server: new origin requires pairing, original origin registration remains valid; both recover reads only, no action replay. This emulates address change, not a physical USB/IP measurement.');
  record('input-lifecycle','blur/pagehide/offline/page-change/ticket-change cancel0; unchanged poll valid1; network restoration reads only with no replay');

  // Two genuine PC browser contexts: frozen draft r, B commits r+1, A polls then PUTs original r.
  await pc.locator('#reloadLayout').click();await pageUI('quota');await assign(2,{type:'sessions'});assert.equal(await pc.evaluate(()=>deckCandidate.navigation),true);
  const base=await pc.evaluate(()=>deckCandidate.baseRevision);
  const concurrent=async name=>pcB.evaluate(async name=>{const {schemaVersion,revision,layouts,actions,assets}=await (await fetch('/api/custom-layout')).json();layouts[0].name=name;const r=await fetch('/api/custom-layout',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({schemaVersion,revision,layouts,actions,assets})});return r.status;},name);
  assert.equal(await concurrent('동시 편집'),200);await pc.evaluate(()=>loadSharedLayouts());assert.equal(await pc.evaluate(()=>layoutRevision),base+1);
  await pc.locator('#saveCandidate').click();await pc.waitForFunction(()=>deckCandidate?.error.includes('다른 PC'));
  assert.equal(puts.at(-1).revision,base);assert.equal(await pc.evaluate(()=>deckCandidate.baseRevision),base);
  const committedBytes=await readFile(file,'utf8'),draft=await pc.evaluate(()=>JSON.stringify(deckCandidate));await pc.evaluate(()=>loadSharedLayouts());assert.equal(await readFile(file,'utf8'),committedBytes);assert.equal(await pc.evaluate(()=>JSON.stringify(deckCandidate)),draft);assert.match(await pc.locator('#layoutStatus').textContent(),/다른 PC/);
  await pc.locator('#saveCandidate').click();await pc.waitForFunction(()=>!layoutSaving&&deckCandidate?.error.includes('다른 PC'));assert.equal(puts.at(-1).revision,base);assert.equal(await readFile(file,'utf8'),committedBytes);assert.equal(await pc.evaluate(()=>JSON.stringify(deckCandidate)),draft);
  record('frozen-CAS409-after-poll',{base,observed:base+1,requestRevision:puts.at(-1).revision,preservedBytes:true,preservedDraft:true});
  await pc.locator('#reloadLayout').click();await pageUI('quota');await assign(2,{type:'sessions'});assert.equal(await pc.evaluate(()=>deckCandidate.navigation),true);
  const failureBase=await pc.evaluate(()=>deckCandidate.baseRevision);handler=createRequestHandler({...options,layouts:{get:()=>store.get(),snapshot:()=>store.snapshot(),subscribe:listener=>store.subscribe(listener),admit:(...args)=>store.admit(...args),putSnapshot:async()=>{throw Object.assign(Error('simulated disk failure'),{status:500});}}});
  await pc.locator('#saveCandidate').click();await pc.waitForFunction(()=>deckCandidate?.error.includes('simulated disk failure'));assert.equal(await pc.evaluate(()=>deckCandidate.baseRevision),failureBase);assert.equal(await readFile(file,'utf8'),committedBytes);
  await pc.screenshot({path:path.join(artifacts,'editor-save-error.png'),fullPage:true});handler=createRequestHandler(options);assert.equal(await concurrent('오류 후 동시 편집'),200);await pc.evaluate(()=>loadSharedLayouts());await pc.locator('#saveCandidate').click();await pc.waitForFunction(()=>deckCandidate?.error.includes('다른 PC'));assert.equal(puts.at(-1).revision,failureBase);const failedDraft=await pc.evaluate(()=>JSON.stringify(deckCandidate)),failureCommitted=await readFile(file,'utf8');await pc.evaluate(()=>loadSharedLayouts());assert.equal(await pc.evaluate(()=>JSON.stringify(deckCandidate)),failedDraft);await pc.locator('#saveCandidate').click();await pc.waitForFunction(()=>!layoutSaving&&deckCandidate?.error.includes('다른 PC'));assert.equal(puts.at(-1).revision,failureBase);assert.equal(await readFile(file,'utf8'),failureCommitted);assert.equal(await pc.evaluate(()=>JSON.stringify(deckCandidate)),failedDraft);
  record('failed-save-frozen-CAS','I/O error retains draft/base; another PC commits; poll cannot rebase; retry original revision409; visible conflict retained');

  await pc.locator('#reloadLayout').click();await pageUI(newID);await pc.locator('#resetDeck').click();await pc.locator('#confirmReset').click();await wait(pc,()=>!layoutSaving&&deckProfile==='agents');
  const finalRevision=(await store.get()).revision;await remote.waitForFunction(r=>layoutRevision===r,finalRevision);store=createLayoutStore(file);handler=createRequestHandler({...options,layouts:store,sessions:await createSessions(sessionFile)});await remote.reload();await remote.waitForFunction(r=>layoutRevision===r&&!deckLocal,finalRevision);assert.equal(await remote.locator('#pair').isVisible(),false);assert.equal((await store.get()).layouts.length,4);
  await key(remote,0).tap();await wait(remote,()=>deckProfile==='response');before=calls.length;await down();assert.equal(await pcB.evaluate(async()=>{const r=await fetch('/api/devices/revoke-all',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});return r.status;}),200);await remote.evaluate(()=>refreshNative());await remote.mouse.up();assert.equal(calls.length,before);await remote.evaluate(()=>recoverConnection());assert.equal(await remote.locator('#pair').isVisible(),true);await remote.locator('#code').fill('123456');await remote.locator('#pairButton').click();await wait(remote,()=>online&&!recoveryBusy);assert.equal(calls.length,before);record('registration-revoked-during-down','Real local revoke-all, authenticated read401 cancels, release0; pairing required and recovery reads only');
  assert.deepEqual(errors,[]);record('restart-delete-recovery','Explicit confirmed page deletion updates affected links, valid cursor fallback; fresh handler/store preserves paired registration and committed revision');
  await writeFile(path.join(artifacts,'browser-transcript.json'),JSON.stringify({schemaVersion:1,kind:'browser-automation',tool:'playwright',browser:await browser.version(),url:localURL,remoteURL,startedAt,finishedAt:new Date().toISOString(),status:'passed',steps:events,events,limitations:['Chromium touch emulation, not physical iPad Safari','Synthetic Herdr/quota data; real production handler/auth/layout store/HTML; not personal deployment inventory']},null,2));
  console.log('Browser evidence:',artifacts);
 }finally{
  // Browser polling can leave keep-alive requests active during shutdown.
  // Destroy only this fixture server's sockets before awaiting its closure.
  const closed=new Promise(r=>server.close(r));server.closeAllConnections();
  try{await browser.close();}finally{await closed;if(!process.env.DECK_TEST_ARTIFACT_DIR)await rm(dir,{recursive:true,force:true});}
 }
});
