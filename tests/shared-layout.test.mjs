import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {networkInterfaces,tmpdir} from 'node:os';
import {join} from 'node:path';
import {mkdtemp,readFile,writeFile,stat,readdir,rm,open,rename,unlink} from 'node:fs/promises';
import {defaultDeckLayouts} from '../src/deck/deck-layout.mjs';
import {createLayoutStore,MAX_LAYOUT_BYTES} from '../src/deck/shared-layout.mjs';
import {createRequestHandler,local,sameOrigin} from '../server.mjs';

async function storeFixture(t){
 const directory=await mkdtemp(join(tmpdir(),'deck-layout-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const file=join(directory,'.deck-layout.json');
 return {directory,file,store:createLayoutStore(file)};
}
function input(revision=0){return {revision,layouts:defaultDeckLayouts()};}
function snapshotInput(revision=0){return {schemaVersion:1,...input(revision),actions:[],assets:[]};}

test('defaults remain uninitialized until explicit save; recreation reads canonical disk and private permissions',async t=>{
 const {file,store}=await storeFixture(t);
 assert.deepEqual(await store.get(),{revision:0,initialized:false,layouts:defaultDeckLayouts()});
 await assert.rejects(readFile(file),{code:'ENOENT'});
 const saved=await store.put(input());
 assert.equal(saved.revision,1);assert.equal(saved.initialized,true);
 assert.deepEqual(await createLayoutStore(file).get(),saved);
 assert.equal((await stat(file)).mode&0o777,0o600);
 await writeFile(file,JSON.stringify({revision:2,layouts:defaultDeckLayouts()}));
 assert.equal((await store.get()).revision,2);
});

test('serialized concurrent CAS accepts exactly one writer and recovers after stale or invalid writes',async t=>{
 const {store}=await storeFixture(t);
 const results=await Promise.allSettled([store.put(input()),store.put(input()),store.put(input())]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 assert.deepEqual(results.filter(x=>x.status==='rejected').map(x=>x.reason.status),[409,409]);
 await assert.rejects(store.put({revision:1,layouts:[]}),{status:400});
 assert.equal((await store.put(input(1))).revision,2);
 for(const revision of [-1,1.5,'2',null,Number.MAX_SAFE_INTEGER+1])await assert.rejects(store.put({...input(),revision}),{status:400});
});

test('malformed disk fails closed on reads and writes without replacing original',async t=>{
 const {file,store}=await storeFixture(t);
 for(const text of ['not json',JSON.stringify({revision:0,layouts:defaultDeckLayouts()}),JSON.stringify({revision:1,layouts:[]})]){
  await writeFile(file,text);
  await assert.rejects(store.get(),{status:500});
  await assert.rejects(store.put(input()),{status:500});
  assert.equal(await readFile(file,'utf8'),text);
 }
 await writeFile(file,JSON.stringify({revision:3,layouts:defaultDeckLayouts()}));
 assert.equal((await store.put(input(3))).revision,4);
});

test('write, sync and rename failures preserve original and do not poison queue',async t=>{
 const {file,directory,store}=await storeFixture(t);
 await store.put(input());
 const original=await readFile(file,'utf8');
 for(const stage of ['open','write','sync','rename']){
  let fail=true;
  const io={readFile,unlink,rename:async(...args)=>{if(fail&&stage==='rename')throw Error('rename denied');return rename(...args);},open:async(...args)=>{
   assert.equal(args[1],'wx');assert.equal(args[2],0o600);
   if(fail&&stage==='open')throw Error('open denied');
   const handle=await open(...args);
   return {writeFile:async(...values)=>{if(fail&&stage==='write')throw Error('write denied');return handle.writeFile(...values);},sync:async()=>{if(fail&&stage==='sync')throw Error('sync denied');return handle.sync();},close:()=>handle.close()};
  }};
  const failing=createLayoutStore(file,io);
  await assert.rejects(failing.put(input(1)),{status:500});
  assert.equal(await readFile(file,'utf8'),original);
  assert.deepEqual(await readdir(directory),['.deck-layout.json']);
  fail=false;
  assert.equal((await failing.put(input(1))).revision,2);
  await writeFile(file,original);
 }
});

function request(port,{method='GET',host='localhost:'+port,origin,body,cookie,headers={},hostname='127.0.0.1',path='/api/layout'}={}){
 return new Promise((resolve,reject)=>{
  const payload=body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body);
  const req=http.request({hostname,port,path,method,headers:{Host:host,...(origin===undefined?{}:{Origin:origin}),...(cookie?{Cookie:cookie}:{}),...(payload===undefined?{}:{'Content-Length':Buffer.byteLength(payload)}),...headers}},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
    try{resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(Buffer.concat(chunks).toString())});}catch(error){reject(error);}
   });
  });
  req.on('error',reject);req.end(payload);
 });
}
async function httpFixture(t){
 const {file}=await storeFixture(t);
 const token='a'.repeat(64);
 let port;
 let activeHandler;
 // Resolve the ephemeral port before building the production handler's host allowlist.
 const server=http.createServer((req,res)=>activeHandler(req,res));
 await new Promise(resolve=>server.listen(0,'0.0.0.0',resolve));
 port=server.address().port;
 activeHandler=createRequestHandler({sessions:{has:value=>value===token,count:()=>1},layouts:createLayoutStore(file),listenPort:port,addresses:()=>[{address:'192.0.2.10',url:'http://192.0.2.10:'+port}],bridge:{focus:async()=>({ok:true})}});
 t.after(()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
 return {port,cookie:'deck='+token,file};
}

test('real HTTP canonical snapshot save validates JSON/schema/byte limit and returns canonical revisions',async t=>{
 const {port}=await httpFixture(t),origin='http://localhost:'+port;
 assert.equal((await request(port)).body.initialized,false);
 const path='/api/custom-layout';
 assert.equal((await request(port,{path,method:'PUT',origin,body:snapshotInput()})).body.revision,1);
 assert.equal((await request(port,{path,method:'PUT',origin,body:snapshotInput()})).status,409);
 for(const body of ['{','',JSON.stringify({...snapshotInput(1),layouts:[]}),JSON.stringify(input(1)),JSON.stringify({layouts:defaultDeckLayouts()})]){
  const response=await request(port,{path,method:'PUT',origin,body});assert.equal(response.status,400);assert.equal(typeof response.body.error,'string');
 }
 // Whitespace keeps the JSON valid while testing the exact byte boundary.
 const payload=JSON.stringify(snapshotInput(1));
 assert.equal((await request(port,{path,method:'PUT',origin,body:payload+' '.repeat(MAX_LAYOUT_BYTES-Buffer.byteLength(payload))})).status,200);
 assert.equal((await request(port,{path,method:'PUT',origin,body:'한'.repeat(22000)})).status,413);
 assert.equal((await request(port)).body.revision,2);
});

test('real HTTP corrupt-store errors remain visible and preserve the original',async t=>{
 const {port,file}=await httpFixture(t),origin='http://localhost:'+port;
 await writeFile(file,'broken store');
 for(const options of [{},{path:'/api/custom-layout',method:'PUT',origin,body:snapshotInput()}]){
  const response=await request(port,options);
  assert.equal(response.status,500);assert.match(response.body.error,/손상/);
  assert.equal(await readFile(file,'utf8'),'broken store');
 }
 await writeFile(file,JSON.stringify({revision:1,layouts:defaultDeckLayouts()}));
 assert.equal((await request(port,{path:'/api/custom-layout',method:'PUT',origin,body:snapshotInput(1)})).body.revision,2);
});

test('real HTTP accepts only authored sessions entry and rejects generated mappings without changing bytes',async t=>{
 const {port,file}=await httpFixture(t),origin='http://localhost:'+port;
 const path='/api/custom-layout',value=snapshotInput();value.layouts[0].slots[0]={type:'sessions'};
 assert.equal((await request(port,{path,method:'PUT',origin,body:value})).status,200);
 const original=await readFile(file,'utf8');
 assert.deepEqual((await request(port)).body.layouts[0].slots[0],{type:'sessions'});
 for(const slot of [{type:'sessions',pageIndex:1},{type:'return'},{type:'previous',disabled:false},{type:'next'},{type:'agent',pane:'p0',target:{id:'p0'}}]){
  const invalid=snapshotInput(1);invalid.layouts[0].slots[0]=slot;
  assert.equal((await request(port,{path,method:'PUT',origin,body:invalid})).status,400);
  assert.equal(await readFile(file,'utf8'),original);
 }
 for(const extra of [{cursor:{pageIndex:1}},{baseRevision:1}]){
  assert.equal((await request(port,{path,method:'PUT',origin,body:{...snapshotInput(1),...extra}})).status,400);
  assert.equal(await readFile(file,'utf8'),original);
 }
});

test('real HTTP paired GET allowed, unauthenticated GET 401, remote-authority PUT 403 before auth',async t=>{
 const {port,cookie}=await httpFixture(t),host='192.0.2.10:'+port,origin='http://'+host;
 assert.equal((await request(port,{host})).status,401);
 assert.equal((await request(port,{host,cookie})).status,200);
 for(const authCookie of [undefined,cookie]){
  for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal((await request(port,{host,origin,cookie:authCookie,method,body:input(),headers:{'X-Forwarded-For':'127.0.0.1','X-Forwarded-Host':'localhost:'+port,Forwarded:'for=127.0.0.1;host=localhost:'+port}})).status,403);
 }
 assert.equal((await request(port,{origin:'http://localhost:'+port,method:'POST',body:input()})).status,405);
 assert.equal((await request(port,{host,origin,cookie,method:'POST',path:'/api/focus',body:{}})).status,200);
 assert.equal((await request(port,{host,origin,cookie,method:'POST',path:'/api/devices/revoke-all',body:{}})).status,403);
});

test('obsolete HTTP layout writers reject old and canonical payloads without creating or changing the store',async t=>{
 const {port,file}=await httpFixture(t),origin='http://localhost:'+port;
 for(const method of ['POST','PUT','PATCH','DELETE']){
  for(const body of [input(),snapshotInput(),'{']){
   const response=await request(port,{method,origin,body});
   assert.equal(response.status,405);assert.equal(response.headers.allow,'GET');
   assert.equal(typeof response.body.error,'string');
   await assert.rejects(readFile(file),{code:'ENOENT'});
  }
 }
 assert.equal((await request(port,{path:'/api/custom-layout',method:'PUT',origin,body:snapshotInput()})).status,200);
 const bytes=await readFile(file,'utf8');
 for(const method of ['POST','PUT','PATCH','DELETE']){
  assert.equal((await request(port,{method,origin,body:input(1)})).status,405);
  assert.equal(await readFile(file,'utf8'),bytes);
 }
 assert.equal((await request(port)).body.revision,1);
});

test('all unsafe HTTP methods require exact non-null Origin and reject cross-site metadata',async t=>{
 const {port}=await httpFixture(t),origin='http://localhost:'+port;
 for(const method of ['POST','PUT','PATCH','DELETE']){
  for(const badOrigin of [undefined,'null','https://localhost:'+port,'http://evil.example',origin+'/']){
   assert.equal((await request(port,{method,origin:badOrigin,body:input()})).status,403);
  }
  assert.equal((await request(port,{method,origin,body:input(),headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await request(port,{method,origin,body:input(),headers:{'Sec-Fetch-Site':'same-site'}})).status,403);
 }
 assert.equal((await request(port,{host:'evil.example:'+port})).status,403);
});

test('peer and authority security checks ignore forged proxy headers',()=>{
 const req=(peer,host='localhost:43187')=>({socket:{remoteAddress:peer},headers:{host,origin:'http://'+host,'x-forwarded-for':'127.0.0.1',forwarded:'for=127.0.0.1;host=localhost:43187'}});
 for(const peer of ['127.0.0.1','::1','::ffff:127.0.0.1'])assert.equal(local(req(peer)),true);
 for(const peer of ['192.168.1.2','::ffff:192.168.1.2',undefined])assert.equal(local(req(peer)),false);
 for(const host of ['192.168.1.2:43187','localhost.evil:43187','localhost:43187@evil','[::1]:43187'])assert.equal(local(req('127.0.0.1',host)),false);
 assert.equal(sameOrigin(req('192.168.1.2')),true); // Origin alone never grants local authority.
});

test('real non-loopback peer cannot forge localhost authority to save even when paired',async t=>{
 const address=Object.values(networkInterfaces()).flat().find(x=>x&&!x.internal&&(x.family==='IPv4'||x.family===4))?.address;
 if(!address){t.skip('No non-loopback IPv4 interface available');return;}
 const {port,cookie}=await httpFixture(t);
 assert.equal((await request(port,{hostname:address})).status,401);
 assert.equal((await request(port,{hostname:address,cookie})).status,200);
 for(const path of ['/api/layout','/api/custom-layout']){
  const response=await request(port,{path,hostname:address,method:'PUT',origin:'http://localhost:'+port,cookie,body:path==='/api/layout'?input():snapshotInput(),headers:{'X-Forwarded-For':'127.0.0.1',Forwarded:'for=127.0.0.1'}});
  assert.equal(response.status,403);
 }
 assert.equal((await request(port)).body.initialized,false);
});
