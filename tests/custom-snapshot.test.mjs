import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm,open,rename,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import sharp from 'sharp';
import {createAssetStore} from '../src/actions/deck-assets.mjs';
import {createLayoutStore} from '../src/deck/shared-layout.mjs';
import {defaultDeckLayouts,validateDeckLayouts} from '../src/deck/deck-layout.mjs';
import {validateCustomSnapshot,projectSnapshot} from '../src/actions/custom-snapshot.mjs';

const definition={kind:'hostProcess',shellKind:'bash',script:'printf "private-fixture"',cwd:'/fixture-private',executionPolicy:{timeoutMs:1000,maxOutputBytes:1024}};
function input(revision=0){const layouts=defaultDeckLayouts();layouts[0].slots[3]={type:'custom',actionId:'owned',presentation:{label:'한글 Key',symbol:'terminal',color:'#123456'}};return {schemaVersion:1,revision,layouts,actions:[{id:'owned',enabled:true,definition}],assets:[]};}
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'deck-snapshot-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=join(dir,'layout.json');return {dir,file,store:createLayoutStore(file)};}

test('presentation is strict, retains authored data, and never adds generated bank keys',()=>{
 const data=input();assert.deepEqual(validateDeckLayouts(data.layouts),data.layouts);
 for(const presentation of [{label:'x',nested:{url:'x'}},{asset:'../private'},{color:'red'},{symbol:'<svg>'},{label:'bad\nlabel'},[]]){const bad=input();bad.layouts[0].slots[3].presentation=presentation;assert.throws(()=>validateDeckLayouts(bad.layouts));}
 for(const mutate of [value=>value.actions[0].definition.extra='private',value=>value.actions[0].definition.executionPolicy.retry=true,value=>value.actions[0].extra=true,value=>value.actions=[],value=>value.assets=['../private'],value=>value.schemaVersion=2]){const bad=structuredClone(data);mutate(bad);assert.throws(()=>validateCustomSnapshot(bad));}
 const projected=projectSnapshot({...data,initialized:true},false);assert.deepEqual(projected.actions,[{id:'owned',enabled:true}]);assert.doesNotMatch(JSON.stringify(projected),/private-fixture|fixture-private|executionPolicy/);
});
test('legacy original bytes are not touched until explicit save, then retained exactly',async t=>{
 const {dir,file,store}=await fixture(t),layouts=defaultDeckLayouts();layouts[1].slots[14]={type:'page',page:'agents',presentation:{label:'원문 보존'}};
 const original='  '+JSON.stringify({revision:4,layouts},null,2)+'\n';await writeFile(file,original);
 assert.equal((await store.snapshot()).revision,4);assert.deepEqual(await readdir(dir),['layout.json']);assert.equal(await readFile(file,'utf8'),original);
 const current=await store.snapshot();const saved=await store.putSnapshot({schemaVersion:1,revision:4,layouts:current.layouts,actions:[],assets:[]});assert.equal(saved.revision,5);
 assert.equal(await readFile(file+'.legacy-'+createHash('sha256').update(original).digest('hex'),'utf8'),original);
 assert.deepEqual((await store.snapshot()).layouts,layouts);assert.equal(JSON.parse(await readFile(file,'utf8')).schemaVersion,1);
});
test('independent store instances cannot both publish the same revision',async t=>{
 const {file,store}=await fixture(t),other=createLayoutStore(file);
 const results=await Promise.allSettled([store.putSnapshot(input()),other.putSnapshot(input())]);
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.ok([409,423].includes(results.find(result=>result.status==='rejected').reason.status));
 assert.equal((await store.snapshot()).revision,1);assert.deepEqual((await store.snapshot()).actions,input().actions);
});
test('asset verification, disk-full, publication faults and stale locks preserve exact snapshot bytes',async t=>{
 const {file,store}=await fixture(t);await store.putSnapshot(input());const bytes=await readFile(file);
 await assert.rejects(store.putSnapshot(input(1),async()=>{throw Error('asset missing');}));assert.deepEqual(await readFile(file),bytes);
 for(const stage of ['write','sync','rename']){
  const failing=createLayoutStore(file,{readFile,unlink,rename:async(...args)=>{if(stage==='rename')throw Object.assign(Error('disk full'),{code:'ENOSPC'});return rename(...args);},open:async(...args)=>{const handle=await open(...args);if(String(args[0]).endsWith('.lock'))return handle;return {writeFile:async(...values)=>{if(stage==='write')throw Object.assign(Error('disk full'),{code:'ENOSPC'});return handle.writeFile(...values);},sync:async()=>{if(stage==='sync')throw Error('sync failure');return handle.sync();},close:()=>handle.close()};}});
  await assert.rejects(failing.putSnapshot(input(1)));assert.deepEqual(await readFile(file),bytes);
 }
 await writeFile(file+'.lock','crashed fixture');await assert.rejects(store.putSnapshot(input(1)),{status:423});assert.deepEqual(await readFile(file),bytes);assert.equal(await readFile(file+'.lock','utf8'),'crashed fixture');
});
test('final effect admission and independent publication share one exclusion boundary',async t=>{
 const {file,store}=await fixture(t);await store.putSnapshot(input());
 let signal,release,effects=0;const reading=new Promise(resolve=>{signal=resolve;}),barrier=new Promise(resolve=>{release=resolve;});
 const admitting=createLayoutStore(file,{open,rename,unlink,readFile:async(...args)=>{signal();await barrier;return readFile(...args);}});
 const admission=admitting.admit(1,current=>{assert.equal(current.revision,1);effects++;return {effect:'entered'};});
 await reading;
 const disabled=input(1);disabled.actions[0].enabled=false;
 await assert.rejects(store.putSnapshot(disabled),{status:423});assert.equal(effects,0);
 release();assert.deepEqual(await admission,{effect:'entered'});assert.equal(effects,1);
 await store.putSnapshot(disabled);
 await assert.rejects(admitting.admit(1,()=>{effects++;}),{status:409});assert.equal(effects,1);
 assert.equal((await store.snapshot()).actions[0].enabled,false);
});

test('unknown schema and unknown legacy fields fail closed without byte replacement',async t=>{
 const {file,store}=await fixture(t);
 for(const value of [{...input(),schemaVersion:99},{revision:1,layouts:defaultDeckLayouts(),privateUnknown:'preserve'}]){const bytes=JSON.stringify(value);await writeFile(file,bytes);await assert.rejects(store.snapshot());await assert.rejects(store.putSnapshot(input()));assert.equal(await readFile(file,'utf8'),bytes);}
});

for(const fence of ['before-publication','after-publication'])test('canonical snapshot process death '+fence+' preserves whole snapshots and original recovery bytes',{timeout:15000},async t=>{
 const {dir,file}=await fixture(t),layouts=defaultDeckLayouts();layouts[1].slots[14]={type:'page',page:'agents',presentation:{label:'Original authored position'}};
 const original='  '+JSON.stringify({revision:4,layouts},null,2)+'\n';await writeFile(file,original);
 const assetDirectory=join(dir,'assets'),assets=createAssetStore(assetDirectory),image=await sharp({create:{width:8,height:8,channels:3,background:'#315a82'}}).png().toBuffer(),staged=await assets.stage(image),imageBytes=await assets.read(staged.id);
 const next=input(4);next.layouts=structuredClone(layouts);next.layouts[0].slots[3]={type:'custom',actionId:'owned',presentation:{label:'Published custom',asset:staged.id}};next.assets=[staged.id];
 const draft=join(dir,'draft.json');await writeFile(draft,JSON.stringify(next),{mode:0o600});
 const source=`import {open,readFile,rename,unlink} from 'node:fs/promises';import {createLayoutStore} from ${JSON.stringify(new URL('../src/deck/shared-layout.mjs',import.meta.url).href)};import {createAssetStore} from ${JSON.stringify(new URL('../src/actions/deck-assets.mjs',import.meta.url).href)};process.on('message',()=>{});const fence=process.env.FENCE;const store=createLayoutStore(process.env.SNAPSHOT,{open,readFile,unlink,rename:async(...args)=>{if(fence==='before-publication'){process.send({fence});await new Promise(()=>{});}await rename(...args);if(fence==='after-publication'){process.send({fence});await new Promise(()=>{});}}});await store.putSnapshot(JSON.parse(await readFile(process.env.DRAFT,'utf8')),ids=>createAssetStore(process.env.ASSETS).verify(ids));`;
 const child=spawn(process.execPath,['--input-type=module','-e',source],{env:{...process.env,FENCE:fence,SNAPSHOT:file,DRAFT:draft,ASSETS:assetDirectory},stdio:['ignore','pipe','pipe','ipc']});
 let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);child.stdout.resume();
 t.after(()=>{if(child.exitCode===null&&!child.killed)child.kill('SIGKILL');});
 const stopped=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Publication fence was not reached: '+stderr)),7000);child.once('message',message=>{clearTimeout(timer);assert.equal(message.fence,fence);resolve();});child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',()=>{clearTimeout(timer);reject(Error('Writer exited before fence: '+stderr));});});
 child.kill('SIGKILL');assert.equal((await stopped).signal,'SIGKILL');
 const restarted=createLayoutStore(file),actual=await restarted.snapshot();
 if(fence==='before-publication'){assert.equal(await readFile(file,'utf8'),original);assert.equal(actual.revision,4);assert.deepEqual(actual.layouts,layouts);assert.deepEqual(actual.actions,[]);assert.deepEqual(actual.assets,[]);}
 else{assert.equal(actual.revision,5);assert.deepEqual(actual.layouts,next.layouts);assert.deepEqual(actual.actions,next.actions);assert.deepEqual(actual.assets,[staged.id]);}
 const recovery=file+'.legacy-'+createHash('sha256').update(original).digest('hex');assert.equal(await readFile(recovery,'utf8'),original);assert.deepEqual(await createAssetStore(assetDirectory).read(staged.id),imageBytes);
 // A crash leaves the exclusive lock. Reads do not clean it or retry effects.
 await assert.rejects(restarted.putSnapshot({...next,revision:actual.revision}),{status:423});
 const bytesAfterRestart=await readFile(file,'utf8');assert.equal((await readdir(dir)).includes('layout.json.lock'),true);assert.equal(await readFile(file,'utf8'),bytesAfterRestart);
 // Fixture owner has observed this exact child die; explicit recovery only.
 await unlink(file+'.lock');await restarted.putSnapshot({...next,revision:actual.revision});assert.equal((await restarted.snapshot()).revision,actual.revision+1);assert.equal(await readFile(recovery,'utf8'),original);
 // Process-death visibility is tested, not storage-controller power-loss or Windows ACL durability.
});
