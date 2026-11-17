import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,access,rm} from 'node:fs/promises';
import {chromium} from 'playwright';
import sharp from 'sharp';
import {createRequestHandler} from '../server.mjs';
import {createSessions} from '../src/host/connections.mjs';
import {createLayoutStore} from '../src/deck/shared-layout.mjs';
import {createAssetStore} from '../src/actions/deck-assets.mjs';
import {createHostDispatcher} from '../src/host/host-actions.mjs';
import {defaultDeckLayouts} from '../src/deck/deck-layout.mjs';

// Chromium automation, production HTML/HTTP/pairing/store. No physical receiver claim.
test('custom inspector, paired one-shot press, frozen CAS and no offline replay',{timeout:180000,skip:process.platform==='win32'},async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'deck-custom-browser-'));
 const artifacts=path.resolve(process.env.DECK_TEST_ARTIFACT_DIR||'artifacts/custom-buttons');
 await mkdir(artifacts,{recursive:true});
 const steps=[],pageErrors=[],puts=[],children=new Set();let starts=0,builtinCalls=0,browser,server;
 const record=(name,detail)=>steps.push({name,detail,status:'passed'});
 const startedAt=new Date().toISOString();
 const transcript={schemaVersion:1,kind:'browser-automation',tool:'playwright',startedAt,status:'failed',steps,limitations:['Synthetic sessions and receiver state; real production HTTP handler, pairing and temporary atomic stores','Chromium mobile emulation, not a physical native receiver or device','No personal layout or credentials read; screenshots mask local executable definitions']};
 try{
  const address=Object.values(os.networkInterfaces()).flat().find(value=>value.family==='IPv4'&&!value.internal)?.address;
  assert.ok(address,'LAN IPv4 is required for browser remote-authority coverage');
  const file=path.join(dir,'layout.json'),layouts=createLayoutStore(file),assets=createAssetStore(path.join(dir,'assets'));
  const sessions=await createSessions(pathToFileURL(path.join(dir,'sessions.json')));
  await writeFile(path.join(dir,'sentinel'),"#!/bin/sh\nprintf 'CUSTOM_BROWSER_SENTINEL'\n",{mode:0o700});
  const dispatcher=createHostDispatcher({spawnImpl:(...args)=>{starts++;const child=spawn(...args);children.add(child);child.once('close',()=>children.delete(child));return child;}});
  const agents=[{pane_id:'fixture-session',id:'fixture-session',label:'Fixture session',agent:'codex',agent_status:'working',text:'Fixture session data',choices:[]}];
  const runner={refresh:async()=>({ok:true,agents,sessions:agents,version:'fixture'}),focus:async()=>{builtinCalls++;return {ok:true};},respond:async()=>{builtinCalls++;return {ok:true};}};
  let handler;
  server=http.createServer((req,res)=>handler(req,res));await new Promise(resolve=>server.listen(0,'0.0.0.0',resolve));
  const port=server.address().port,localURL=`http://127.0.0.1:${port}`,remoteURL=`http://${address}:${port}`;
  handler=createRequestHandler({sessions,layouts,assets,dispatcher,bridge:runner,nativeHerdr:runner,network:{refresh:async()=>({ok:true,sessions:[],onlineCount:0})},quotas:{refresh:async()=>({providers:[]})},pin:'123456',listenPort:port,addresses:()=>[{address,url:remoteURL}]});
  let executablePath=process.env.DECK_BROWSER_PATH;
  if(!executablePath){try{await access('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');executablePath='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';}catch{}}
  browser=await chromium.launch({headless:true,executablePath});transcript.browser=await browser.version();
  const pcContext=await browser.newContext({viewport:{width:1280,height:800}}),otherContext=await browser.newContext({viewport:{width:1920,height:1080}}),mobileContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const pc=await pcContext.newPage(),other=await otherContext.newPage(),mobile=await mobileContext.newPage();
  for(const page of [pc,other,mobile]){
   page.on('pageerror',error=>pageErrors.push(error.name));
   page.on('request',request=>{if(request.method()==='PUT'&&request.url().endsWith('/api/custom-layout'))puts.push(JSON.parse(request.postData()).revision);});
  }
  const wait=(page,fn)=>page.waitForFunction(fn,null,{timeout:15000});
  const key=(page,index=0)=>page.locator('#keys button[data-key-id]').nth(index);
  const masked=[pc.locator('#customScript'),pc.locator('#customCwd'),pc.locator('#customTarget'),pc.locator('#customText'),pc.locator('#customUrl')];
  const screenshotPC=async(name)=>{await pc.screenshot({path:path.join(artifacts,name),fullPage:true,mask:masked});};
  await pcContext.addInitScript(value=>localStorage.setItem('agentDeck.layouts.v2',JSON.stringify(value)),defaultDeckLayouts());
  await pc.goto(localURL);await wait(pc,()=>layoutRevision===0&&deckLocal);
  await pc.locator('#importLayout').click();await wait(pc,()=>layoutRevision===1);
  assert.equal(starts,0);assert.equal(builtinCalls,0);record('local-import','Browser legacy fixture imported with zero dispatch');
  await pc.locator('#editDeck').click();await key(pc).click();
  await pc.locator('#customLabel').fill('Fixture launch');await pc.locator('#customSymbol').selectOption('terminal');await pc.locator('#customColor').fill('#315a82');
  await pc.locator('#customKind').selectOption('hostProcess');await pc.locator('#customShell').selectOption('bash');
  await pc.locator('#customScript').fill('exec ./sentinel');await pc.locator('#customCwd').fill(dir);await pc.locator('#customTimeout').fill('3000');await pc.locator('#customMaxOutput').fill('8192');
  await pc.locator('#customTrusted').check();
  const image=await sharp({create:{width:16,height:16,channels:3,background:'#315a82'}}).png().toBuffer();
  await pc.locator('#customImage').setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:image});
  await wait(pc,()=>!!document.querySelector('#customInspector').dataset.asset&&!document.querySelector('#customImage').disabled);
  const staged=(await layouts.snapshot());assert.equal(staged.assets.length,0);assert.equal(starts,0);
  await screenshotPC('pc-1280-editor.png');
  await pc.locator('#saveAssignment').click();await wait(pc,()=>layoutRevision===2&&!layoutSaving);
  assert.equal(starts,0);assert.equal(builtinCalls,0);
  let stored=await layouts.snapshot();const actionId=stored.actions[0].id;
  assert.equal(stored.layouts[0].slots[0].presentation.label,'Fixture launch');assert.equal(stored.assets.length,1);
  await pc.reload();await wait(pc,()=>layoutRevision===2&&deckLocal);await key(pc).click();assert.equal(starts,0);
  await pc.setViewportSize({width:1920,height:1080});await screenshotPC('pc-1920-preview.png');
  await pc.locator('#editDeck').click();await key(pc).click();assert.equal(await pc.locator('#customLabel').inputValue(),'Fixture launch');assert.equal(await pc.locator('#customKind').inputValue(),'hostProcess');
  await screenshotPC('pc-1920-editor.png');
  const originalPolicy=structuredClone(stored.actions[0].definition.executionPolicy);
  assert.deepEqual(originalPolicy,{timeoutMs:3000,maxOutputBytes:8192});
  await pc.locator('#customLabel').fill('Renamed fixture');await pc.locator('#saveAssignment').click();await wait(pc,()=>layoutRevision===3&&!layoutSaving);
  stored=await layouts.snapshot();assert.deepEqual(stored.actions[0].definition.executionPolicy,originalPolicy);assert.equal(stored.layouts[0].slots[0].presentation.label,'Renamed fixture');
  record('presentation-preserves-policy','Label-only save preserves nondefault timeout and maxOutputBytes exactly');
  for(const failure of ['http-500','network-abort']){
   await pc.evaluate(()=>{deckEditing=true;redrawDeck();openKeyEditor(0);});
   await pc.locator('#customLabel').fill('Unsaved upload failure draft');
   const before=await pc.evaluate(()=>({candidate:JSON.stringify(deckCandidate),asset:document.querySelector('#customInspector').dataset.asset,label:document.querySelector('#customLabel').value})),canonical=await readFile(file,'utf8');
   let releaseFailure,markHeld;const held=new Promise(resolve=>markHeld=resolve),gate=new Promise(resolve=>releaseFailure=resolve);
   const failUpload=async route=>{markHeld();await gate;if(failure==='http-500')await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Fixture upload failed'})});else await route.abort('failed');};
   await pc.route('**/api/assets/upload',failUpload);
   await pc.locator('#customImage').setInputFiles({name:'failed.png',mimeType:'image/png',buffer:image});await held;
   assert.equal(await pc.locator('#customImage').isDisabled(),true);releaseFailure();
   await wait(pc,()=>!document.querySelector('#customImage').disabled);
   assert.match(await pc.locator('#layoutStatus').textContent(),/업로드 실패/,JSON.stringify(await pc.evaluate(()=>({generation:deckGeneration,editor:customEditorGeneration,slot:editingSlot,candidate:!!deckCandidate,status:document.querySelector('#layoutStatus').textContent}))));
   await pc.unroute('**/api/assets/upload',failUpload);
   assert.deepEqual(await pc.evaluate(()=>({candidate:JSON.stringify(deckCandidate),asset:document.querySelector('#customInspector').dataset.asset,label:document.querySelector('#customLabel').value})),before);
   assert.equal(await readFile(file,'utf8'),canonical);assert.equal(starts,0);assert.equal(builtinCalls,0);
   await screenshotPC('upload-failure-'+failure+'.png');
   record('failed-upload-'+failure,'Held failing upload preserves unsaved fields, complete frozen draft, prior image and exact canonical bytes; zero effects');
   await pc.locator('#reloadLayout').click();await wait(pc,()=>!deckCandidate);
  }
  const lateImage=await sharp({create:{width:16,height:16,channels:3,background:'#824531'}}).png().toBuffer();
  for(const change of ['slot-switch','slot-away-back','page-away-back','source-away-back','discard']){
   await pc.evaluate(()=>{deckEditing=true;redrawDeck();openKeyEditor(0);});
   const before=await pc.evaluate(()=>({assets:[...deckCandidate.assets],asset:document.querySelector('#customInspector').dataset.asset}));
   let releaseUpload,uploadReady;
   const uploadGate=new Promise(resolve=>releaseUpload=resolve),uploadHeld=new Promise(resolve=>uploadReady=resolve);
   const holdUpload=async route=>{const response=await route.fetch();uploadReady();await uploadGate;await route.fulfill({response});};
   await pc.route('**/api/assets/upload',holdUpload);
   await pc.locator('#customImage').setInputFiles({name:'late.png',mimeType:'image/png',buffer:lateImage});await uploadHeld;
   if(change==='slot-switch')await key(pc,1).click();
   else if(change==='slot-away-back'){await key(pc,1).click();await key(pc,0).click();}
   else if(change==='page-away-back')await pc.evaluate(()=>{setDeckProfile('response');setDeckProfile('agents');deckEditing=true;openKeyEditor(0);});
   else if(change==='source-away-back')await pc.evaluate(()=>{const view=deckView;setDeckView(view==='native'?'herdr':'native');setDeckView(view);});
   else await pc.locator('#reloadLayout').click();
   releaseUpload();await wait(pc,()=>!document.querySelector('#customImage').disabled);await pc.unroute('**/api/assets/upload',holdUpload);
   if(change==='discard')assert.equal(await pc.evaluate(()=>deckCandidate),null);
   else assert.deepEqual(await pc.evaluate(()=>({assets:[...deckCandidate.assets],asset:document.querySelector('#customInspector').dataset.asset})),change==='slot-switch'?{assets:before.assets,asset:''}:before);
   record('delayed-upload-'+change,'Late HTTP upload cannot attach to a changed editor or recreate a discarded candidate');
  }
  record('inspector-save-reload','Label, symbol, color, host process, trust acknowledgement and raster persisted; import/save/PC preview dispatch zero');
  await mobile.goto(remoteURL);await mobile.locator('#code').fill('123456');await mobile.locator('#pairButton').click();await wait(mobile,()=>layoutRevision===3&&!deckLocal);
  assert.equal(await mobile.locator('#customInspector').count(),0);
  const projection=await mobile.evaluate(async()=>{const r=await fetch('/api/custom-layout');return r.json();});
  assert.deepEqual(projection.actions,[{id:actionId,enabled:true}]);
  for(const secret of ['exec ./sentinel',dir,'script','cwd','definition'])assert.equal(JSON.stringify(projection).includes(secret),false);
  await mobile.screenshot({path:path.join(artifacts,'paired-mobile.png'),fullPage:true});
  const geometry=await mobile.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,keys:[...document.querySelectorAll('#keys button[data-key-id]')].map(node=>{const r=node.getBoundingClientRect();return {width:r.width,height:r.height,left:r.left,right:r.right,top:r.top,bottom:r.bottom};})}));
  assert.equal(geometry.keys.length,15);assert.ok(geometry.scrollWidth<=geometry.width+1);assert.ok(geometry.scrollHeight<=geometry.height+1);
  for(const rect of geometry.keys){assert.ok(Math.abs(rect.width-rect.height)<=1);assert.ok(rect.left>=-1&&rect.right<=geometry.width+1&&rect.top>=-1&&rect.bottom<=geometry.height+1);}
  let invokeRequests=0;mobile.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/api/actions/invoke'))invokeRequests++;});
  for(const change of ['source-away-back','session-bank-away-back','page-away-back','blur','pagehide','offline','hidden']){
   let releasePrepare,prepareReady;
   const prepareGate=new Promise(resolve=>releasePrepare=resolve),prepareHeld=new Promise(resolve=>prepareReady=resolve);
   const holdPrepare=async route=>{const response=await route.fetch();assert.equal(response.status(),200);prepareReady();await prepareGate;await route.fulfill({response});};
   await mobile.route('**/api/actions/prepare',holdPrepare);await key(mobile).tap();await prepareHeld;
   await mobile.evaluate(change=>{
    if(change==='source-away-back'){const view=deckView;setDeckView(view==='native'?'herdr':'native');setDeckView(view);}
    else if(change==='session-bank-away-back'){enterSessionBank();leaveSessionBank();}
    else if(change==='page-away-back'){setDeckProfile('response');setDeckProfile('agents');}
    else if(change==='hidden'){Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));}
    else{window.dispatchEvent(new Event(change));if(change==='offline')window.dispatchEvent(new Event('online'));else if(change==='pagehide')window.dispatchEvent(new Event('pageshow'));else window.dispatchEvent(new Event('focus'));}
   },change);
   releasePrepare();await wait(mobile,()=>!sending);await mobile.unroute('**/api/actions/prepare',holdPrepare);
   assert.equal(invokeRequests,0);assert.equal(starts,0);assert.equal(builtinCalls,0);
   record('delayed-prepare-'+change,'Held real prepare response released after context/lifecycle away-and-back; zero invoke requests and process/builtin effects (lifecycle events dispatched by automation)');
  }
  const invoked=mobile.waitForResponse(response=>response.url().endsWith('/api/actions/invoke')&&response.request().method()==='POST');
  await key(mobile).tap();const receipt=await (await invoked).json();await wait(mobile,()=>!sending);
  for(let i=0;i<200&&dispatcher.localStatus(receipt.runId)?.state==='running';i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(dispatcher.localStatus(receipt.runId)?.state,'exit');assert.equal(dispatcher.localStatus(receipt.runId)?.stdout,'CUSTOM_BROWSER_SENTINEL');assert.equal(starts,1);
  for(const [run,done,text]of [
   [{state:'exit',exitCode:0,signal:null},true,'exit 0'],
   [{state:'exit',exitCode:7,signal:null},false,'실패 · exit 7'],
   [{state:'exit',exitCode:null,signal:'SIGTERM'},false,'실패 · signal SIGTERM'],
   [{state:'spawn-error',exitCode:null,signal:null},false,'실패'],
   [{state:'handoff',exitCode:0,signal:null},true,'handoff · exit 0'],
   [{state:'handoff',exitCode:9,signal:null},false,'실패 · exit 9']
  ]){
   const rendered=await mobile.evaluate(({actionId,run})=>{
    const previous=customRunStates.get(actionId);customRunStates.set(actionId,run);redrawDeck();
    const button=document.querySelector('#keys button[data-key-id]'),result={done:button.classList.contains('state-done'),text:button.querySelector('.key-detail').textContent,label:button.getAttribute('aria-label')};
    if(previous)customRunStates.set(actionId,previous);else customRunStates.delete(actionId);redrawDeck();return result;
   },{actionId,run});
   assert.equal(rendered.done,done);assert.ok(rendered.text.includes(text),rendered.text);assert.ok(rendered.label.includes(text),rendered.label);
  }
  record('run-outcome-rendering','Browser DOM/accessibility labels distinguish zero exit and URL handoff from nonzero exit, signal, failed URL handoff and spawn error; rendering states injected, no native success claim');
  const invokeResponse=await mobile.evaluate(async()=>{const s=await (await fetch('/api/custom-layout')).json();const p=await (await fetch('/api/actions/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({actionId:s.actions[0].id,revision:s.revision,pageId:'agents',slotIndex:0})})).json();return p;});
  // An unused prepared context becomes stale after a genuine second-tab commit.
  await other.goto(localURL);await wait(other,()=>deckLocal&&layoutRevision===3);
  await pc.locator('#reloadLayout').click();await wait(pc,()=>!deckCandidate);await pc.locator('#editDeck').click();await key(pc).click();await pc.locator('#customLabel').fill('Frozen draft');
  const base=await pc.evaluate(()=>deckCandidate.baseRevision);
  const commit=await other.evaluate(async()=>{const s=await (await fetch('/api/custom-layout')).json();s.layouts[0].name='Concurrent fixture';const {initialized,...body}=s;return (await fetch('/api/custom-layout',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status;});assert.equal(commit,200);
  await pc.evaluate(()=>loadSharedLayouts());assert.equal(await pc.evaluate(()=>layoutRevision),base+1);await pc.locator('#saveAssignment').click();await wait(pc,()=>!layoutSaving&&!!deckCandidate?.error);
  assert.equal(puts.at(-1),base);assert.equal(await pc.evaluate(()=>deckCandidate.baseRevision),base);assert.equal(await pc.locator('#customLabel').inputValue(),'Frozen draft');
  const bytes=await readFile(file,'utf8'),frozen=await pc.evaluate(()=>JSON.stringify(deckCandidate));await pc.evaluate(()=>loadSharedLayouts());await pc.locator('#saveAssignment').click();await wait(pc,()=>!layoutSaving&&!!deckCandidate?.error);assert.equal(await readFile(file,'utf8'),bytes);assert.equal(await pc.evaluate(()=>JSON.stringify(deckCandidate)),frozen);
  await screenshotPC('pc-frozen-conflict.png');
  const stale=await mobile.evaluate(async body=>(await fetch('/api/actions/invoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,invokeResponse);assert.equal(stale,409);assert.equal(starts,1);
  record('two-tab-frozen-CAS','Draft/base and committed bytes preserved after poll and repeat conflict; prepared old context rejected without dispatch');
  await mobile.evaluate(()=>loadSharedLayouts());await mobileContext.setOffline(true);await key(mobile).tap();await wait(mobile,()=>!sending);assert.equal(starts,1);
  await mobileContext.setOffline(false);await mobile.evaluate(()=>loadSharedLayouts());await wait(mobile,()=>!sending);assert.equal(starts,1);
  record('offline-no-replay','Offline press and network restoration do not create a process or replay');
  const unknown=await other.evaluate(async()=>{const s=await (await fetch('/api/custom-layout')).json();s.actions[0].definition={kind:'sessionText',targetRef:'unknown-fixture',literalText:'fixture',submit:true};const {initialized,...body}=s;return (await fetch('/api/custom-layout',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status;});assert.equal(unknown,200);
  await mobile.evaluate(()=>loadSharedLayouts());await key(mobile).tap();await wait(mobile,()=>!sending);assert.equal(starts,1);assert.equal(builtinCalls,0);
  record('unknown-receiver','Stored unknown receiver press cannot dispatch or fall back to builtin/global input');
  assert.deepEqual(pageErrors,[]);transcript.status='passed';
 }finally{
  transcript.finishedAt=new Date().toISOString();
  await writeFile(path.join(artifacts,'browser-transcript.json'),JSON.stringify(transcript,null,2));
  for(const child of children){try{process.kill(-child.pid,'SIGKILL');}catch{}child.kill('SIGKILL');}
  const closed=server?new Promise(resolve=>server.close(resolve)):Promise.resolve();server?.closeAllConnections();
  try{if(browser)await browser.close();}finally{await closed;await rm(dir,{recursive:true,force:true});}
 }
});
