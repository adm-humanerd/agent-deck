import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,mkdir,readFile,writeFile,rm,access} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {createManagedTmuxSession,runTmux,TMUX_MAPPING} from '../src/host/tmux-receiver.mjs';
import {loadReceivers} from '../src/host/receiver-config.mjs';
import {createRequestHandler} from '../server.mjs';
import {createLayoutStore} from '../src/deck/shared-layout.mjs';
import {createSessions} from '../src/host/connections.mjs';
import {createAssetStore} from '../src/actions/deck-assets.mjs';
import {createHostDispatcher} from '../src/host/host-actions.mjs';
import {defaultDeckLayouts} from '../src/deck/deck-layout.mjs';

async function until(check){for(let i=0;i<200;i++){if(await check())return;await new Promise(r=>setTimeout(r,25));}throw Error('Real receiver observation timed out');}
test('real macOS paired browser authoring and stored idle session submission without builtin ticket',{timeout:60000},async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'ad-web-')),socketPath=path.join(dir,'s');let browser,server;
 const evidence=path.resolve('artifacts/custom-native');await mkdir(evidence,{recursive:true});const steps=[];
 const started=new Date().toISOString();
 try{
  const registration=await createManagedTmuxSession({socketPath,name:'managed',targetRef:'fixture-shell'});
  const configFile=path.join(dir,'receivers.json');await writeFile(configFile,JSON.stringify({schemaVersion:1,receivers:[{...registration,type:'tmux'}]}),{mode:0o600});
  const receivers=await loadReceivers(configFile),receiver=receivers['fixture-shell'];await until(async()=>(await receiver.inspect()).state==='ready-idle');
  const other=await runTmux(['-S',socketPath,'-N','split-window','-d','-P','-F','#{pane_id}','-t',registration.paneId,'/bin/zsh','-f','-i']);assert.equal(other.code,0);const otherPane=other.stdout.trim();
  const capture=()=>runTmux(['-S',socketPath,'-N','capture-pane','-p','-t',otherPane]);await new Promise(r=>setTimeout(r,50));const otherBefore=(await capture()).stdout;
  const sessions=await createSessions(pathToFileURL(path.join(dir,'pairings.json'))),store=createLayoutStore(path.join(dir,'snapshot.json')),assets=createAssetStore(path.join(dir,'assets'));
  const layouts=defaultDeckLayouts();layouts[0].slots[1]={type:'custom',actionId:'clear',presentation:{label:'Clear exact line'}};layouts[0].slots[2]={type:'custom',actionId:'enter',presentation:{label:'Submit exact line'}};
  await store.putSnapshot({schemaVersion:1,revision:0,layouts,assets:[],actions:[{id:'clear',enabled:true,definition:{kind:'keyCombo',targetRef:'fixture-shell',chord:'Ctrl-U',qualifiedMapping:TMUX_MAPPING}},{id:'enter',enabled:true,definition:{kind:'keyCombo',targetRef:'fixture-shell',chord:'Enter',qualifiedMapping:TMUX_MAPPING}}]});
  const dispatcher=createHostDispatcher({receivers});let builtins=0;
  const runner={refresh:async()=>({ok:true,agents:[],sessions:[]}),respond:async()=>{builtins++;throw Error('No builtin ticket');},focus:async()=>{builtins++;throw Error('No focus required');}};
  let handler;server=http.createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'0.0.0.0',r));const port=server.address().port;
  const address=Object.values(os.networkInterfaces()).flat().find(value=>value.family==='IPv4'&&!value.internal)?.address;assert.ok(address);
  handler=createRequestHandler({sessions,layouts:store,assets,dispatcher,bridge:runner,nativeHerdr:runner,network:runner,quotas:{refresh:async()=>({providers:[]})},listenPort:port,pin:'123456',addresses:()=>[{address}]});
  let executablePath=process.env.DECK_BROWSER_PATH;if(!executablePath)try{await access('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');executablePath='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';}catch{}
  browser=await chromium.launch({headless:true,executablePath});const pc=await browser.newPage({viewport:{width:1280,height:800}}),paired=await browser.newPage({viewport:{width:1024,height:768},hasTouch:true});
  const errors=[];for(const page of [pc,paired])page.on('pageerror',error=>errors.push(error.message));
  await pc.goto(`http://127.0.0.1:${port}`);await pc.waitForFunction(()=>deckLocal&&layoutRevision===1);
  if(!await pc.evaluate(()=>deckEditing))await pc.locator('#editDeck').click();await pc.locator('#keys button[data-key-id]').nth(0).click();
  await pc.locator('#customLabel').fill('Real exact shell');await pc.locator('#modeTabAutomation').click();await pc.locator('#customKind').selectOption('sessionText');await pc.locator('#customTarget').fill('fixture-shell');
  const output=path.join(dir,'result');const command=`printf NATIVE_BROWSER_OK > '${output}'`;
  await pc.locator('#customText').fill(command);await pc.locator('#customSubmit').check();await pc.locator('#customTrusted').check();await pc.locator('#saveAssignment').click();await pc.waitForFunction(()=>layoutRevision===2&&!layoutSaving);
  assert.equal(builtins,0);await assert.rejects(readFile(output),{code:'ENOENT'});steps.push({name:'PC authoring/save is inert',verdict:'passed'});
  await paired.goto(`http://${address}:${port}`);await paired.locator('#code').fill('123456');await paired.locator('#pairButton').click();await paired.waitForFunction(()=>!deckLocal&&online&&layoutRevision===2);
  const press=async index=>{
   const response=paired.waitForResponse(r=>r.url().endsWith('/api/actions/invoke')&&r.request().method()==='POST');await paired.locator('#keys button[data-key-id]').nth(index).tap();const body=await (await response).json();await paired.waitForFunction(()=>!sending);
   await until(()=>!['running','cancelling'].includes(dispatcher.status(body.runId)?.state));assert.equal(dispatcher.status(body.runId)?.state,'handoff');await paired.evaluate(()=>pollCustomRuns());return body;
  };
  const receipt=await press(0);assert.ok(receipt.runId);await until(async()=>{try{return await readFile(output,'utf8')==='NATIVE_BROWSER_OK';}catch{return false;}});assert.equal(builtins,0);steps.push({name:'Stored sessionText+submit at verified idle without builtin ticket',verdict:'passed'});
  await until(async()=>(await receiver.inspect()).state==='ready-idle');
  const snapshot=await store.snapshot(),action=snapshot.actions.find(a=>a.definition.kind==='sessionText');action.definition={kind:'sessionText',targetRef:'fixture-shell',literalText:'SHOULD_BE_CLEARED',submit:false};const {initialized,...next}=snapshot;await store.putSnapshot(next);await paired.evaluate(()=>loadSharedLayouts());await press(0);
  await until(async()=>(await receiver.inspect()).state==='ready-idle');await press(1);await until(async()=>(await receiver.inspect()).state==='ready-idle');
  const latest=await store.snapshot();latest.actions.find(a=>a.id===action.id).definition={kind:'sessionText',targetRef:'fixture-shell',literalText:command,submit:false};const {initialized:unused,...updated}=latest;await store.putSnapshot(updated);await paired.evaluate(()=>loadSharedLayouts());await press(0);await until(async()=>(await receiver.inspect()).state==='ready-idle');await press(2);await until(async()=>(await receiver.inspect()).state==='ready-idle');
  assert.equal(await readFile(output,'utf8'),'NATIVE_BROWSER_OK');assert.equal((await capture()).stdout,otherBefore);assert.equal(builtins,0);steps.push({name:'No-submit+exact Ctrl-U+Enter and unrelated pane isolation',verdict:'passed'});
  const projection=await paired.evaluate(async()=>await (await fetch('/api/custom-layout')).json());assert.equal(JSON.stringify(projection).includes(dir),false);assert.equal(JSON.stringify(projection).includes(command),false);
  await paired.screenshot({path:path.join(evidence,'paired-real-session.png')});assert.deepEqual(errors,[]);
  const transcript={kind:'app-automation',schemaVersion:1,status:'passed',platform:process.platform,osRelease:os.release(),browser:await browser.version(),tmuxVersion:(await runTmux(['-V'])).stdout.trim(),mapping:TMUX_MAPPING,started,finished:new Date().toISOString(),steps,limitations:['Isolated app-owned detached tmux/zsh sessions; not personal session inspection','Only tmux3.8 ZLE Ctrl-U/Enter mapping; not arbitrary app shortcuts or Windows qualification']};
  await writeFile(path.join(evidence,'automation.json'),JSON.stringify(transcript,null,2));
 }finally{
  const closed=server?new Promise(r=>server.close(r)):Promise.resolve();server?.closeAllConnections();try{await browser?.close();}finally{await closed;await runTmux(['-S',socketPath,'-N','kill-server']).catch(()=>{});await rm(dir,{recursive:true,force:true});}
 }
});
