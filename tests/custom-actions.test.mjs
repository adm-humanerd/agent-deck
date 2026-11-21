import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdtemp,writeFile,readFile,rm,open,rename,unlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import sharp from 'sharp';
import {createRequestHandler} from '../server.mjs';
import {createSessions} from '../src/host/connections.mjs';
import {createLayoutStore} from '../src/deck/shared-layout.mjs';
import {createAssetStore,MAX_ASSET_BYTES,MAX_IMAGE_BYTES} from '../src/actions/deck-assets.mjs';
import {createHostDispatcher} from '../src/host/host-actions.mjs';
import {defaultDeckLayouts} from '../src/deck/deck-layout.mjs';

// All persistence and child effects belong to this fixture, never the personal store.
async function fixture(t,{receivers={},spawnImpl=spawn,layoutIO}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'deck-custom-http-'));
 const file=path.join(dir,'layout.json'),assetDirectory=path.join(dir,'assets');
 const layouts=createLayoutStore(file,layoutIO),assets=createAssetStore(assetDirectory);
 const sessions=await createSessions(pathToFileURL(path.join(dir,'sessions.json')));
 const children=new Set();
 const dispatcher=createHostDispatcher({receivers,spawnImpl:(...args)=>{const child=spawnImpl(...args);children.add(child);child.once('close',()=>children.delete(child));return child;}});
 let handler;
 const server=http.createServer((req,res)=>handler(req,res));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=server.address().port,local=`127.0.0.1:${port}`,lan=`192.0.2.10:${port}`;
 const runner={refresh:async()=>({ok:true,agents:[],sessions:[]})};
 handler=createRequestHandler({sessions,layouts,assets,dispatcher,bridge:runner,nativeHerdr:runner,network:{refresh:async()=>({ok:true,sessions:[]})},quotas:{refresh:async()=>({providers:[]})},pin:'123456',listenPort:port,addresses:()=>[{address:'192.0.2.10'}]});
 t.after(async()=>{for(const child of children){try{process.kill(-child.pid,'SIGKILL');}catch{}child.kill('SIGKILL');}const closed=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await closed;await rm(dir,{recursive:true,force:true});});
 async function request(route,{method='GET',body,remote=false,cookie,origin=true,raw=false,headers:extraHeaders={}}={}){
  const host=remote?lan:local,headers={Host:host,...extraHeaders};
  if(origin)headers.Origin='http://'+host;
  if(cookie)headers.Cookie=cookie;
  if(body!==undefined)headers['Content-Type']=raw?'application/octet-stream':'application/json';
  return new Promise((resolve,reject)=>{
   const req=http.request({hostname:'127.0.0.1',port,path:route,method,headers},res=>{
    const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
     const bytes=Buffer.concat(chunks);resolve({status:res.statusCode,headers:res.headers,bytes,json:res.headers['content-type']?.includes('application/json')?JSON.parse(bytes):null});
    });
   });req.on('error',reject);req.end(body===undefined?undefined:raw?body:JSON.stringify(body));
  });
 }
 const paired=await request('/api/pair',{method:'POST',remote:true,body:{code:'123456'}});
 assert.equal(paired.status,200);
 const cookie=paired.headers['set-cookie'][0].split(';')[0];
 const remote=(route,options={})=>request(route,{...options,remote:true,cookie});
 const save=body=>request('/api/custom-layout',{method:'PUT',body});
 const snapshot=definition=>{const pages=defaultDeckLayouts();pages[0].slots[0]={type:'custom',actionId:'fixture'};return {schemaVersion:1,revision:0,layouts:pages,actions:[{id:'fixture',enabled:true,definition}],assets:[]};};
 const prepare=revision=>remote('/api/actions/prepare',{method:'POST',body:{actionId:'fixture',revision,pageId:'agents',slotIndex:0}});
 const invoke=body=>remote('/api/actions/invoke',{method:'POST',body});
 async function settled(runId){for(let i=0;i<200;i++){const state=dispatcher.localStatus(runId);if(!['running','cancelling'].includes(state.state))return state;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Fixture run failed to settle');}
 return {dir,file,assetDirectory,layouts,assets,dispatcher,sessions,request,remote,save,snapshot,prepare,invoke,settled};
}
const sessionAction={kind:'sessionText',targetRef:'fixture-receiver',literalText:'fixture literal',submit:true};

test('canonical snapshot preserves actions while obsolete PUT has no effects on the atomic store',async t=>{
 const f=await fixture(t),draft=f.snapshot(sessionAction);
 for(const invalid of [{...draft,extra:true},{...draft,schemaVersion:2},{...draft,actions:[{...draft.actions[0],extra:true}]},{...draft,assets:['invalid']}])assert.equal((await f.save(invalid)).status,400);
 assert.equal((await f.save(draft)).status,200);
 const local=(await f.request('/api/custom-layout')).json,paired=(await f.remote('/api/custom-layout')).json;
 assert.deepEqual(local.actions,draft.actions);assert.deepEqual(paired.actions,[{id:'fixture',enabled:true}]);
 assert.equal(JSON.stringify(paired).includes('fixture literal'),false);
 assert.deepEqual(Object.keys(JSON.parse(await readFile(f.file,'utf8'))).sort(),['actions','assets','layouts','revision','schemaVersion']);
 assert.equal((await f.remote('/api/custom-layout',{method:'PUT',body:{...draft,revision:1}})).status,403);
 const legacy={revision:1,layouts:local.layouts};legacy.layouts[0].name='Preserved';
 const original=await readFile(f.file,'utf8');
 assert.equal((await f.request('/api/layout',{method:'PUT',body:legacy})).status,405);
 assert.equal(await readFile(f.file,'utf8'),original);assert.equal((await f.layouts.snapshot()).revision,1);
 assert.equal((await f.save(legacy)).status,400);assert.equal(await readFile(f.file,'utf8'),original);
 assert.equal((await f.save({...draft,revision:1,layouts:legacy.layouts})).status,200);
 const persisted=await f.layouts.snapshot();assert.equal(persisted.revision,2);assert.deepEqual(persisted.actions,draft.actions);
 assert.equal(persisted.layouts[0].name,'Preserved');assert.deepEqual(persisted.assets,draft.assets);
 const bytes=await readFile(f.file,'utf8');assert.equal((await f.save({...draft,revision:1})).status,409);assert.equal(await readFile(f.file,'utf8'),bytes);
 const concurrent=await Promise.all([f.save({...draft,revision:2}),f.save({...draft,revision:2})]);assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);
});

test('paired snapshot readers never receive private malformed-store diagnostics',async t=>{
 const f=await fixture(t),sentinel='PRIVATE_STORE_FIXTURE_SENTINEL';
 await writeFile(f.file,'{"private":"'+sentinel+'",BROKEN');
 for(const route of ['/api/layout','/api/custom-layout']){
  const paired=await f.remote(route);assert.equal(paired.status,500);assert.equal(paired.bytes.includes(Buffer.from(sentinel)),false);assert.equal(paired.bytes.includes(Buffer.from(f.dir)),false);
  const local=await f.request(route);assert.equal(local.status,500);
 }
});

test('real authenticated HTTP renews paired cookie but never grants or echoes a corrupt registration',async t=>{
 const f=await fixture(t);
 const renewed=await f.remote('/api/custom-layout');assert.equal(renewed.status,200);assert.match(renewed.headers['set-cookie'][0],/HttpOnly; SameSite=Strict/);
 const unauth=await f.request('/api/custom-layout',{remote:true});assert.equal(unauth.status,401);assert.equal(unauth.headers['set-cookie'],undefined);
 await writeFile(path.join(f.dir,'sessions.json'),'invalid-private-registration-fixture');
 const corrupted=await f.remote('/api/custom-layout');assert.equal(corrupted.status,401);assert.equal(corrupted.headers['set-cookie'],undefined);assert.equal(corrupted.bytes.includes(Buffer.from('invalid-private-registration-fixture')),false);
});

test('real HTTP host fixture executes at most once, exact nonce and no paired output leakage',{skip:process.platform==='win32'},async t=>{
 let starts=0;
 const f=await fixture(t,{spawnImpl:(...args)=>{starts++;return spawn(...args);}});
 await writeFile(path.join(f.dir,'sentinel'),"#!/bin/sh\nprintf 'CUSTOM_FIXTURE_SENTINEL'\n",{mode:0o700});
 const draft=f.snapshot({kind:'hostProcess',shellKind:'bash',script:'exec ./sentinel',cwd:f.dir,executionPolicy:{timeoutMs:3000,maxOutputBytes:1024}});
 assert.equal((await f.save(draft)).status,200);
 const ready=await f.prepare(1);assert.equal(ready.status,200);assert.deepEqual(Object.keys(ready.json).sort(),['actionId','context','nonce','revision']);
 const attempts=await Promise.all([f.invoke(ready.json),f.invoke(ready.json)]);assert.deepEqual(attempts.map(r=>r.status).sort(),[202,409]);
 const result=await f.settled(attempts.find(r=>r.status===202).json.runId);assert.equal(result.state,'exit');assert.equal(result.stdout,'CUSTOM_FIXTURE_SENTINEL');assert.equal(starts,1);
 const remote=await f.remote('/api/actions/status/'+result.runId);assert.equal(remote.status,200);assert.equal(Object.hasOwn(remote.json,'stdout'),false);assert.equal(Object.hasOwn(remote.json,'stderr'),false);
 assert.equal((await f.invoke(ready.json)).status,409);assert.equal(starts,1);
});

test('stored idle-session authority has no builtin ticket; overrides, stale nonce, revision and receiver epoch dispatch zero',async t=>{
 const writes=[];let inspections=0,epoch='epoch-1',unknown=false,changeEpoch=false;
 const receiver={inspect:async()=>({targetRef:'fixture-receiver',epoch:changeEpoch?String(++inspections):epoch,state:unknown?'unknown':'ready-idle',capabilities:['sessionText']}),dispatch:async(action,context)=>{writes.push({action,context});return {state:'handoff',targetRef:context.targetRef,epoch:context.epoch};}};
 const f=await fixture(t,{receivers:{'fixture-receiver':receiver}}),draft=f.snapshot(sessionAction);
 assert.equal((await f.save(draft)).status,200);
 for(const override of ['text','cmd','target','cwd','submit']){
  assert.equal((await f.remote('/api/actions/prepare',{method:'POST',body:{actionId:'fixture',revision:1,pageId:'agents',slotIndex:0,[override]:'override'}})).status,400);
  const ready=(await f.prepare(1)).json;assert.equal((await f.invoke({...ready,[override]:'override'})).status,400);
 }
 assert.equal(writes.length,0);
 let ready=(await f.prepare(1)).json;const wrong=await f.invoke({...ready,nonce:'wrong'});assert.equal(wrong.status,409);assert.equal((await f.invoke(ready)).status,409);
 unknown=true;ready=(await f.prepare(1)).json;let result=await f.invoke(ready);assert.equal((await f.settled(result.json.runId)).state,'blocked');assert.equal(writes.length,0);
 unknown=false;changeEpoch=true;ready=(await f.prepare(1)).json;result=await f.invoke(ready);assert.equal((await f.settled(result.json.runId)).state,'blocked');assert.equal(writes.length,0);
 changeEpoch=false;ready=(await f.prepare(1)).json;result=await f.invoke(ready);assert.equal(result.status,202);assert.equal((await f.settled(result.json.runId)).state,'handoff');assert.deepEqual(writes[0].action,sessionAction);assert.equal(writes.length,1);
 ready=(await f.prepare(1)).json;assert.equal((await f.save({...draft,revision:1})).status,200);assert.equal((await f.invoke(ready)).status,409);assert.equal((await f.prepare(1)).status,409);assert.equal(writes.length,1);
 ready=(await f.prepare(2)).json;await f.request('/api/devices/revoke-all',{method:'POST',body:{}});assert.equal((await f.invoke(ready)).status,401);assert.equal(writes.length,1);
});

test('final authority is rechecked after asynchronous receiver inspection',{timeout:10000},async t=>{
 let entered,release;const inspectionEntered=new Promise(resolve=>{entered=resolve;}),barrier=new Promise(resolve=>{release=resolve;});let writes=0;
 let inspections=0;
 const receiver={inspect:async()=>{if(++inspections>1){entered();await barrier;}return {targetRef:'fixture-receiver',epoch:'one',state:'ready-idle',capabilities:['sessionText']};},dispatch:async()=>{writes++;return {state:'handoff',targetRef:'fixture-receiver',epoch:'one'};}};
 const f=await fixture(t,{receivers:{'fixture-receiver':receiver}}),draft=f.snapshot(sessionAction);await f.save(draft);
 const ready=(await f.prepare(1)).json,result=await f.invoke(ready);await inspectionEntered;
 await f.save({...draft,revision:1});release();assert.ok(['unknown','blocked','cancelled'].includes((await f.settled(result.json.runId)).state));assert.equal(writes,0);
});

test('revocation during receiver inspection is checked immediately before dispatch',{timeout:10000},async t=>{
 let entered,release,writes=0;
 const inspected=new Promise(resolve=>{entered=resolve;}),barrier=new Promise(resolve=>{release=resolve;});
 let inspections=0;
 const receiver={inspect:async()=>{if(++inspections>1){entered();await barrier;}return {targetRef:'fixture-receiver',epoch:'one',state:'ready-idle',capabilities:['sessionText']};},dispatch:async()=>{writes++;return {state:'handoff',targetRef:'fixture-receiver',epoch:'one'};}};
 const f=await fixture(t,{receivers:{'fixture-receiver':receiver}});assert.equal((await f.save(f.snapshot(sessionAction))).status,200);
 const ready=(await f.prepare(1)).json,result=await f.invoke(ready);assert.equal(result.status,202);await inspected;
 assert.equal((await f.request('/api/devices/revoke-all',{method:'POST',body:{}})).status,200);release();
 // Revocation actively cancels this in-flight inspection before release. No
 // receiver dispatch occurred; cancellation cannot certify receiver settlement.
 assert.equal((await f.settled(result.json.runId)).state,'unknown');assert.equal(writes,0);
});

test('real HTTP final admission excludes an independent publisher during its final read',{timeout:10000},async t=>{
 let held=false,entered,release,writes=0;const reading=new Promise(resolve=>{entered=resolve;}),barrier=new Promise(resolve=>{release=resolve;});
 const receiver={inspect:async()=>({targetRef:'fixture-receiver',epoch:'one',state:'ready-idle',capabilities:['sessionText']}),dispatch:async()=>{writes++;return {state:'handoff',targetRef:'fixture-receiver',epoch:'one'};}};
 const f=await fixture(t,{receivers:{'fixture-receiver':receiver},layoutIO:{open,rename,unlink,readFile:async(...args)=>{if(held){entered();await barrier;}return readFile(...args);}}});
 const draft=f.snapshot(sessionAction);await f.save(draft);const ready=await f.prepare(1);
 const admit=f.layouts.admit;f.layouts.admit=(...args)=>{held=true;return admit(...args);};
 const invoked=await f.invoke(ready.json);await reading;
 const disabled={...draft,revision:1,actions:[{...draft.actions[0],enabled:false}]};
 await assert.rejects(createLayoutStore(f.file).putSnapshot(disabled),{status:423});assert.equal(writes,0);
 held=false;release();assert.equal((await f.settled(invoked.json.runId)).state,'handoff');assert.equal(writes,1);
 await createLayoutStore(f.file).putSnapshot(disabled);
 assert.equal((await f.prepare(1)).status,409);assert.equal(writes,1);
});

test('receiver restart after preparation cannot retarget the new epoch',async t=>{
 let epoch='original',writes=0;
 const receiver={inspect:async()=>({targetRef:'fixture-receiver',epoch,state:'ready-idle',capabilities:['sessionText']}),dispatch:async()=>{writes++;return {state:'handoff',targetRef:'fixture-receiver',epoch};}};
 const f=await fixture(t,{receivers:{'fixture-receiver':receiver}});await f.save(f.snapshot(sessionAction));
 const ready=await f.prepare(1);assert.equal(ready.status,200);epoch='restarted';
 const result=await f.invoke(ready.json);assert.equal(result.status,202);assert.equal((await f.settled(result.json.runId)).state,'blocked');assert.equal(writes,0);
 assert.equal((await f.remote('/api/actions/capabilities')).status,403);assert.equal((await f.remote('/api/actions/runs')).status,403);
});

test('raw static raster upload is local/authenticated, sanitized and unpublished until atomic snapshot commit',async t=>{
 const f=await fixture(t);
 const image=await sharp({create:{width:16,height:16,channels:4,background:'#315a82'}}).withMetadata({exif:{IFD0:{Copyright:'PRIVATE_FIXTURE_METADATA'}}}).png().toBuffer();
 assert.equal((await f.request('/api/assets/upload',{method:'POST',remote:true,body:image,raw:true})).status,401);
 assert.equal((await f.remote('/api/assets/upload',{method:'POST',body:image,raw:true})).status,403);
 assert.equal((await f.request('/api/assets/upload',{method:'POST',body:image,raw:true,origin:false})).status,403);
 const staged=await f.request('/api/assets/upload',{method:'POST',body:image,raw:true});assert.equal(staged.status,201);assert.match(staged.json.id,/^[a-f0-9]{64}$/);
 const id=staged.json.id;assert.equal((await f.remote('/api/assets/'+id)).status,404);
 const clean=await f.assets.read(id),metadata=await sharp(clean).metadata();assert.equal(metadata.format,'webp');assert.equal(metadata.exif,undefined);assert.equal(metadata.icc,undefined);assert.equal(clean.includes(Buffer.from('PRIVATE_FIXTURE_METADATA')),false);
 const draft=f.snapshot(sessionAction);draft.assets=[id];draft.layouts[0].slots[0].presentation={asset:id};
 const missing={...draft,assets:['a'.repeat(64)]};missing.layouts=structuredClone(draft.layouts);missing.layouts[0].slots[0].presentation.asset='a'.repeat(64);
 assert.notEqual((await f.save(missing)).status,200);assert.equal((await f.layouts.snapshot()).revision,0);assert.equal((await f.remote('/api/assets/'+id)).status,404);
 assert.equal((await f.save(draft)).status,200);const served=await f.remote('/api/assets/'+id);assert.equal(served.status,200);assert.deepEqual(served.bytes,clean);
 for(const bytes of [Buffer.alloc(0),Buffer.alloc(MAX_IMAGE_BYTES+1)])assert.equal((await f.request('/api/assets/upload',{method:'POST',body:bytes,raw:true})).status,413);
 const oversized=await sharp({create:{width:1025,height:1,channels:3,background:'red'}}).png().toBuffer();assert.equal((await f.request('/api/assets/upload',{method:'POST',body:oversized,raw:true})).status,400);
 // Two distinct palette frames prevent encoder deduplication; decode as animation.
 const gif=Buffer.from('47494638396101000100800000ff00000000ff'+'21f904000a0000002c0000000001000100000202440100'+'21f904000a0000002c00000000010001000002024c0100'+'3b','hex');
 const animated=await sharp(gif,{animated:true}).webp({loop:0,delay:[100,100]}).toBuffer();
 assert.equal((await sharp(animated,{animated:true}).metadata()).pages,2);assert.equal((await f.request('/api/assets/upload',{method:'POST',body:animated,raw:true})).status,400);
 await writeFile(path.join(f.assetDirectory,'b'.repeat(64)),Buffer.alloc(MAX_ASSET_BYTES),{mode:0o600});
 const other=await sharp({create:{width:8,height:8,channels:3,background:'green'}}).png().toBuffer();assert.equal((await f.request('/api/assets/upload',{method:'POST',body:other,raw:true})).status,413);
 assert.deepEqual((await f.layouts.snapshot()).assets,[id]);
 const original=await readFile(f.file,'utf8');
 const legacy=await f.request('/api/layout',{method:'PUT',body:{revision:1,layouts:draft.layouts}});assert.equal(legacy.status,405);
 assert.equal(await readFile(f.file,'utf8'),original);assert.equal((await f.layouts.snapshot()).revision,1);
 const updated=structuredClone(draft);updated.revision=1;updated.layouts[0].name='Asset retained';
 assert.equal((await f.save(updated)).status,200);
 const retained=await f.layouts.snapshot();assert.equal(retained.revision,2);assert.equal(retained.layouts[0].name,'Asset retained');assert.deepEqual(retained.assets,[id]);assert.deepEqual(retained.actions,draft.actions);assert.equal((await f.remote('/api/assets/'+id)).status,200);
});

test('staged asset preview, ETag 304 caching, missing/null runId 404, rotate-pin, body bounds and remote error redaction',async t=>{
 const f=await fixture(t);
 const image=await sharp({create:{width:8,height:8,channels:4,background:'#225588'}}).png().toBuffer();
 const staged=await f.request('/api/assets/upload',{method:'POST',body:image,raw:true});
 assert.equal(staged.status,201);
 const id=staged.json.id;
 assert.equal((await f.request('/api/assets/'+id)).status,404);
 assert.equal((await f.remote('/api/assets/'+id+'?staged=1')).status,404);
 const localStaged=await f.request('/api/assets/'+id+'?staged=1');
 assert.equal(localStaged.status,200);
 assert.equal(localStaged.headers.etag,'"'+id+'"');
 assert.equal(localStaged.headers['cache-control'],'private, no-cache');
 assert.equal((await f.request('/api/assets/'+id+'?staged=1',{headers:{'If-None-Match':'"'+id+'"'}})).status,304);

 const draft=f.snapshot(sessionAction);draft.assets=[id];draft.layouts[0].slots[0].presentation={asset:id};
 assert.equal((await f.save(draft)).status,200);
 assert.equal((await f.remote('/api/assets/'+id,{headers:{'If-None-Match':'"'+id+'"'}})).status,304);

 assert.equal((await f.remote('/api/actions/status/missing-run-id')).status,404);
 assert.equal((await f.remote('/api/actions/cancel/missing-run-id',{method:'POST'})).status,404);

 assert.equal((await f.remote('/api/devices/rotate-pin',{method:'POST',body:{}})).status,403);
 for(let i=0;i<9;i++)await f.request('/api/pair',{method:'POST',remote:true,body:{code:'000000'}});
 assert.equal((await f.request('/api/pair',{method:'POST',remote:true,body:{code:'123456'}})).status,429);
 const rotated=await f.request('/api/devices/rotate-pin',{method:'POST',body:{}});
 assert.equal(rotated.status,200);assert.match(rotated.json.pairCode,/^\d{6}$/);assert.notEqual(rotated.json.pairCode,'123456');
 assert.equal((await f.request('/api/pair',{method:'POST',remote:true,body:{code:'123456'}})).status,403);
 assert.equal((await f.request('/api/pair',{method:'POST',remote:true,body:{code:rotated.json.pairCode}})).status,200);

 assert.equal((await f.request('/api/pair',{method:'POST',remote:true,raw:true,body:Buffer.from('{"code":"한글테스트"}','utf8')})).status,403);
 assert.equal((await f.request('/api/pair',{method:'POST',remote:true,raw:true,body:Buffer.from('{invalid-json','utf8')})).status,400);
 assert.equal((await f.request('/api/pair',{method:'POST',remote:true,raw:true,body:Buffer.alloc(2049,65)})).status,413);

 const dir=await mkdtemp(path.join(os.tmpdir(),'deck-redact-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const layouts=createLayoutStore(path.join(dir,'layout.json')),assets=createAssetStore(path.join(dir,'assets'));
 const sessions=await createSessions(pathToFileURL(path.join(dir,'sessions.json')));
 let handler;
 const s2=http.createServer((req,res)=>handler(req,res));
 await new Promise(resolve=>s2.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>s2.close(resolve));});
 const p2=s2.address().port,lan2=`192.0.2.10:${p2}`,local2=`127.0.0.1:${p2}`;
 const errRunner={refresh:async()=>{throw Object.assign(new Error('ENOENT: read /Users/fixture/private/secret.json\nstack'),{code:'ENOENT'});}};
 const stubDispatcher={capabilities:async()=>({shellKinds:[],receivers:[],macControl:false}),receiverContext:async()=>undefined,dispatch:async()=>({runId:'r-gone',state:'running'}),status:()=>null,localStatus:()=>null,cancel:async()=>null};
 handler=createRequestHandler({sessions,layouts,assets,dispatcher:stubDispatcher,bridge:errRunner,nativeHerdr:{refresh:async()=>({ok:true,sessions:[]})},network:{refresh:async()=>({ok:true,sessions:[]})},quotas:{refresh:async()=>({providers:[]})},pin:'654321',listenPort:p2,addresses:()=>[{address:'192.0.2.10'}]});
 const req2=(p,{method='GET',remote=false,cookie,body}={})=>new Promise((resolve,reject)=>{
  const host=remote?lan2:local2,h={Host:host,Origin:'http://'+host};if(cookie)h.Cookie=cookie;if(body!==undefined)h['Content-Type']='application/json';
  const req=http.request({hostname:'127.0.0.1',port:p2,path:p,method,headers:h},res=>{const c=[];res.on('data',d=>c.push(d));res.on('end',()=>resolve({status:res.statusCode,json:JSON.parse(Buffer.concat(c))}));});
  req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
 });
 const paired2=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:p2,path:'/api/pair',method:'POST',headers:{Host:lan2,Origin:'http://'+lan2,'Content-Type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.headers['set-cookie'][0].split(';')[0]));});req.on('error',reject);req.end(JSON.stringify({code:'654321'}));});
 const remoteErr=await req2('/api/state',{remote:true,cookie:paired2});
 assert.equal(remoteErr.status,409);assert.equal(remoteErr.json.error.includes('/Users/fixture'),false);assert.equal(remoteErr.json.error.includes('ENOENT'),false);
 const localErr=await req2('/api/state');
 assert.equal(localErr.status,409);assert.ok(localErr.json.error.includes('/Users/fixture'));
 const snap=defaultDeckLayouts();snap[0].slots[0]={type:'custom',actionId:'a1'};
 await req2('/api/custom-layout',{method:'PUT',body:{schemaVersion:1,revision:0,layouts:snap,actions:[{id:'a1',enabled:true,definition:{kind:'hostUrl',url:'https://example.com'}}],assets:[]}});
 const prep=await req2('/api/actions/prepare',{method:'POST',remote:true,cookie:paired2,body:{actionId:'a1',revision:1,pageId:'agents',slotIndex:0}});
 const inv=await req2('/api/actions/invoke',{method:'POST',remote:true,cookie:paired2,body:prep.json});
 assert.equal(inv.status,202);
 assert.equal((await req2('/api/actions/status/r-gone',{remote:true,cookie:paired2})).status,404);
 assert.equal((await req2('/api/actions/cancel/r-gone',{method:'POST',remote:true,cookie:paired2,body:{}})).status,404);
});
