import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,rm,open,unlink,readdir} from 'node:fs/promises';
import {mkdirSync,renameSync,readFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {connectionAddresses,allowedHost,createSessions,migratePairingStore,SESSION_SECONDS,sessionCookie} from '../src/host/connections.mjs';
test('hot-plug USB addresses accepted but foreign hosts still rejected',()=>{
 const interfaces={lo0:[{family:'IPv4',internal:true,address:'127.0.0.1'}],en0:[{family:'IPv4',internal:false,address:'192.168.1.100'}]};
 assert.equal(allowedHost('169.254.223.119:43187',connectionAddresses(interfaces)),false);
 interfaces.en7=[{family:'IPv4',internal:false,address:'169.254.223.119'}];
 const a=connectionAddresses(interfaces);
 assert.equal(allowedHost('169.254.223.119:43187',a),true);
 assert.equal(a.find(x=>x.name==='en7').kind,'link-local');
 for(const h of ['evil.test:43187','169.254.223.119.evil.test:43187','169.254.223.119:80',undefined])assert.equal(allowedHost(h,a),false);
 delete interfaces.en7;assert.equal(allowedHost('169.254.223.119:43187',connectionAddresses(interfaces)),false);
});
test('device registration survives long idle and restart, with private hashed storage',async()=>{
 const dir=await mkdtemp(new URL('./.test-sessions-',import.meta.url));const file=pathToFileURL(dir+'/sessions.json');let now=100000;
 try{
  const s=await createSessions(file,()=>now);assert.equal(s.has(undefined),false);assert.equal(s.has('bad'),false);
  const t=await s.issue();assert.equal(s.has(t),true);
  assert.equal((await stat(file)).mode&0o777,0o600);assert.equal((await readFile(file,'utf8')).includes(t),false);
  const restarted=await createSessions(file,()=>now);assert.equal(restarted.has(t),true);
  now+=10*365*24*60*60*1000;assert.equal(restarted.has(t),true);
  const t2=await restarted.issue();assert.equal(restarted.has(t2),true);assert.equal(Object.keys(JSON.parse(await readFile(file,'utf8'))).length,2);
  await restarted.revokeAll();assert.equal(restarted.has(t),false);assert.equal(restarted.has(t2),false);assert.equal((await createSessions(file)).count(),0);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('active existing 30-day registrations migrate without re-pairing; expired registrations stay invalid',async()=>{
 const dir=await mkdtemp(new URL('./.test-sessions-',import.meta.url));const file=pathToFileURL(dir+'/sessions.json');
 try{const t='a'.repeat(64),expired='b'.repeat(64),digest=t=>createHash('sha256').update(t).digest('hex');
 const original=JSON.stringify({[digest(t)]:200000,[digest(expired)]:99999});await writeFile(file,original);
 await assert.rejects(createSessions(file,()=>100000),/explicit lossless migration/);assert.equal(await readFile(file,'utf8'),original);
 await migratePairingStore(file,()=>100000);
 const backup=new URL(file.href+'.legacy-'+createHash('sha256').update(original).digest('hex'));assert.equal(await readFile(backup,'utf8'),original);
 const s=await createSessions(file,()=>100000);assert.equal(s.has(t),true);assert.equal(s.has(expired),false);assert.equal(s.count(),1);
 const after=await createSessions(file,()=>9999999999999);assert.equal(after.has(t),true);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('malformed registration fields never clean themselves up on read',async()=>{
 const dir=await mkdtemp(new URL('./.test-sessions-',import.meta.url));const file=pathToFileURL(dir+'/sessions.json');
 try{for(const original of ['{"invalid":{"registeredAt":1}}',JSON.stringify({['a'.repeat(64)]:{registeredAt:1,secret:'fixture'}})]){await writeFile(file,original);await assert.rejects(createSessions(file));assert.equal(await readFile(file,'utf8'),original);}}
 finally{await rm(dir,{recursive:true,force:true});}
});
test('renewed cookie is HttpOnly, strict same-site and browser-compatible long lived',()=>{const c=sessionCookie('test');assert.match(c,/HttpOnly/);assert.match(c,/SameSite=Strict/);assert.match(c,/Path=\//);assert.ok(SESSION_SECONDS<=400*24*60*60);assert.match(c,new RegExp('Max-Age='+SESSION_SECONDS));});

test('stale stores merge new registrations and observe revocation without resurrection',async()=>{
 const dir=await mkdtemp(new URL('./.test-sessions-',import.meta.url));const file=pathToFileURL(dir+'/sessions.json');
 try{
  const a=await createSessions(file),b=await createSessions(file);
  const first=await a.issue(),second=await b.issue();
  assert.equal(a.has(second),true);assert.equal(b.has(first),true);assert.equal(a.count(),2);
  await a.revokeAll();assert.equal(b.has(first),false);assert.equal(b.has(second),false);assert.equal(b.count(),0);
  const third=await b.issue();assert.equal(a.has(third),true);assert.equal(a.has(first),false);assert.equal(a.count(),1);
  await b.revokeAll();assert.equal(a.has(third),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('a stale store observes successful cross-process issuance and revocation',async()=>{
 const dir=await mkdtemp(new URL('./.test-sessions-',import.meta.url));const file=pathToFileURL(dir+'/sessions.json');
 const remote=action=>{
  const child=spawnSync(process.execPath,['--input-type=module','-e',`
   import {createSessions} from ${JSON.stringify(new URL('../src/host/connections.mjs',import.meta.url).href)};
   const store=await createSessions(new URL(${JSON.stringify(file.href)}));
   console.log(JSON.stringify(await store[${JSON.stringify(action)}]()??null));
  `],{encoding:'utf8',timeout:10000});
  assert.equal(child.error,undefined);assert.equal(child.status,0,child.stderr);return JSON.parse(child.stdout);
 };
 try{
  const stale=await createSessions(file),first=await stale.issue(),second=remote('issue');
  assert.equal(stale.has(first),true);assert.equal(stale.has(second),true);assert.equal(stale.count(),2);
  await stale.issue();assert.equal(stale.count(),3);
  remote('revokeAll');assert.equal(stale.has(first),false);assert.equal(stale.has(second),false);assert.equal(stale.count(),0);
  const third=remote('issue'),fourth=await stale.issue();
  assert.equal(stale.has(third),true);assert.equal(stale.has(fourth),true);assert.equal(stale.count(),2);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('migration rejects unknown data without backup or cleanup effects',async()=>{
 const dir=await mkdtemp(new URL('./.test-sessions-',import.meta.url));const file=pathToFileURL(dir+'/sessions.json');
 try{
  for(const original of ['{','[]','null','{"invalid":1}',JSON.stringify({['e'.repeat(64)]:{registeredAt:1,unknown:true}})]){
   await writeFile(file,original);await assert.rejects(migratePairingStore(file));
   assert.equal(await readFile(file,'utf8'),original);assert.deepEqual(await readdir(dir),['sessions.json']);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('live reads fail closed on changed canonical data without rewriting it',async()=>{
 const dir=await mkdtemp(new URL('./.test-sessions-',import.meta.url));const file=pathToFileURL(dir+'/sessions.json');
 try{
  const store=await createSessions(file),token=await store.issue(),key=createHash('sha256').update(token).digest('hex');
  for(const original of ['{',JSON.stringify({[key]:9999999999999}),JSON.stringify({[key]:{registeredAt:1,unknown:true}}),'[]']){
   await writeFile(file,original);
   assert.throws(()=>store.has(token));assert.throws(()=>store.count());
   await assert.rejects(store.issue());await assert.rejects(store.revokeAll());
   assert.equal(await readFile(file,'utf8'),original);
  }
  await unlink(file);assert.equal(store.has(token),false);assert.equal(store.count(),0);
  mkdirSync(file);
  assert.throws(()=>store.has(token),{code:'EISDIR'});assert.throws(()=>store.count(),{code:'EISDIR'});
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('all mutators reject an existing lock before reading and recover without retry',async()=>{
 const dir=await mkdtemp(new URL('./.test-sessions-',import.meta.url));const file=pathToFileURL(dir+'/sessions.json'),lock=new URL(file.href+'.lock');
 try{
  const store=await createSessions(file);await writeFile(file,'invalid fixture');
  const handle=await open(lock,'wx',0o600);await handle.close();
  await assert.rejects(store.issue(),/locked/);await assert.rejects(store.revokeAll(),/locked/);await assert.rejects(migratePairingStore(file),/locked/);
  assert.equal(await readFile(file,'utf8'),'invalid fixture');assert.deepEqual((await readdir(dir)).sort(),['sessions.json','sessions.json.lock']);
  await unlink(lock);await writeFile(file,'{}');
  assert.equal(store.has(await store.issue()),true);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('failed atomic persistence publishes no registration and does not poison the queue',async()=>{
 const dir=await mkdtemp(new URL('./.test-sessions-',import.meta.url));const file=pathToFileURL(dir+'/sessions.json'),held=new URL(file.href+'.held');let fail=false,observer,expectedCount=0;
 try{
  const store=await createSessions(file,()=>{
   assert.equal(existsSync(new URL(file.href+'.lock')),true);
   assert.equal(observer.count(),expectedCount);
   if(fail){renameSync(file,held);mkdirSync(file);}
   return 123;
  });
  observer=await createSessions(file);const original=await store.issue();
  await writeFile(new URL(file.href+'.tmp'),'unrelated fixture');
  expectedCount=1;fail=true;await assert.rejects(store.issue());
  await rm(file,{recursive:true});renameSync(held,file);fail=false;
  assert.equal(observer.has(original),true);assert.equal(store.count(),1);
  const next=await store.issue();assert.equal(store.has(next),true);assert.equal(store.count(),2);
  assert.equal(await readFile(new URL(file.href+'.tmp'),'utf8'),'unrelated fixture');
  assert.equal((await stat(file)).mode&0o777,0o600);
  assert.deepEqual((await readdir(dir)).sort(),['sessions.json','sessions.json.tmp']);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('issue, migration and admission hold the shared lock against competing processes',async()=>{
 const dir=await mkdtemp(new URL('./.test-sessions-',import.meta.url));const file=pathToFileURL(dir+'/sessions.json');
 const moduleURL=new URL('../src/host/connections.mjs',import.meta.url).href;
 const compete=()=>{
  const child=spawnSync(process.execPath,['--input-type=module','-e',`
   import {createSessions,migratePairingStore} from ${JSON.stringify(moduleURL)};
   const file=new URL(${JSON.stringify(file.href)}),store=await createSessions(file),results=[];
   for(const action of [()=>store.issue(),()=>store.revokeAll(),()=>migratePairingStore(file),()=>store.admit('a'.repeat(64),()=>{throw Error('unexpected entry');})]){
    try{await action();results.push('unexpected success');}catch(error){results.push(error.message);}
   }
   console.log(JSON.stringify(results));
  `],{encoding:'utf8',timeout:10000});
  assert.equal(child.error,undefined);assert.equal(child.status,0,child.stderr);
  const results=JSON.parse(child.stdout);assert.equal(results.length,4);for(const message of results)assert.match(message,/locked/);
  assert.equal(existsSync(new URL(file.href+'.lock')),true);
  return 123;
 };
 try{
  const store=await createSessions(file,compete),token=await store.issue();
  assert.equal(store.has(token),true);const original=await readFile(file);
  await migratePairingStore(file,compete);
  assert.deepEqual(store.admit(token,compete),{effect:123});
  assert.equal(store.has(token),true);assert.equal(store.count(),1);
  const backup=new URL(file.href+'.legacy-'+createHash('sha256').update(original).digest('hex'));
  assert.deepEqual(await readFile(backup),original);assert.equal((await stat(backup)).mode&0o777,0o600);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('admission validates current authority, enters synchronously and never awaits the effect',async()=>{
 const dir=await mkdtemp(new URL('./.test-sessions-',import.meta.url));const file=pathToFileURL(dir+'/sessions.json'),lock=new URL(file.href+'.lock');let entries=0;
 try{
  const store=await createSessions(file),other=await createSessions(file),token=await other.issue();
  let finish;const pending=new Promise(resolve=>{finish=resolve;});
  const admitted=store.admit(token,()=>{entries++;assert.equal(existsSync(lock),true);return pending;});
  assert.equal(admitted instanceof Promise,false);assert.equal(admitted.effect,pending);assert.equal(entries,1);assert.equal(existsSync(lock),false);
  await other.revokeAll();finish('done');assert.equal(await admitted.effect,'done');
  const enter=()=>{entries++;return 'unexpected';};
  for(const credential of [token,undefined,'bad','f'.repeat(64)])assert.throws(()=>store.admit(credential,enter),{code:'PAIRING_UNAUTHORIZED'});
  assert.equal(entries,1);assert.equal(existsSync(lock),false);
  const fresh=await other.issue(),handle=await open(lock,'wx',0o600);await handle.close();
  assert.throws(()=>store.admit(fresh,enter),{code:'PAIRING_LOCKED'});assert.equal(existsSync(lock),true);await unlink(lock);
  const original=await readFile(file,'utf8');await writeFile(file,'invalid fixture');
  assert.throws(()=>store.admit(fresh,enter));assert.equal(entries,1);assert.equal(await readFile(file,'utf8'),'invalid fixture');assert.equal(existsSync(lock),false);
  await writeFile(file,original);
  const failure=Error('effect entry failed');assert.throws(()=>store.admit(fresh,()=>{throw failure;}),error=>error===failure);
  assert.equal(existsSync(lock),false);assert.deepEqual(store.admit(fresh,()=>42),{effect:42});
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('explicit migration preserves exact legacy bytes and stale stores cannot restore expired entries',async()=>{
 const dir=await mkdtemp(new URL('./.test-sessions-',import.meta.url));const file=pathToFileURL(dir+'/sessions.json');
 try{
  const stale=await createSessions(file),active='c'.repeat(64),expired='d'.repeat(64),digest=t=>createHash('sha256').update(t).digest('hex');
  const original=`{\n  "${digest(active)}": 101,\n  "${digest(expired)}": 100\n}\n`;
  await writeFile(file,original);assert.throws(()=>stale.has(active),/explicit lossless migration/);
  await migratePairingStore(file,()=>100);
  const backup=new URL(file.href+'.legacy-'+createHash('sha256').update(original).digest('hex'));
  assert.equal(readFileSync(backup,'utf8'),original);assert.equal(stale.has(active),true);assert.equal(stale.has(expired),false);
  const token=await stale.issue();assert.equal(stale.count(),2);
  const other=await createSessions(file);await other.revokeAll();
  assert.equal(stale.has(active),false);assert.equal(stale.has(token),false);
  await stale.issue();assert.equal(other.count(),1);assert.equal(other.has(expired),false);assert.equal(other.has(active),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
