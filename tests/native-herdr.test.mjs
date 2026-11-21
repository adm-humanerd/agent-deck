import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import vm from 'node:vm';
import {normalizeNativeHerdr,createNativeHerdr} from '../src/integrations/native-herdr.mjs';
const raw={spaces:[{id:'s1',name:'Repo',machine:null,tabs:[{id:'tab1',name:'One',terminals:[{terminal:'t1',pane:'p1',app:'pi',status:null,name:null,sub_agents:[]}]}]}]};
const blockedRaw={spaces:[{id:'s1',name:'Repo',machine:null,tabs:[{id:'tab1',name:'One',terminals:[{terminal:'t1',pane:'p1',app:'antigravity',status:'blocked',name:null,sub_agents:[]}]}]}]};

test('native actual response shape, unreported is unknown not idle',()=>{const n=normalizeNativeHerdr(raw);assert.equal(n.sessions.length,1);assert.equal(n.sessions[0].id,'native:t1');assert.equal(n.sessions[0].status,'unknown');assert.equal(n.sessions[0].reported,false);assert.equal(n.inputSupported,true);});
test('terminal title does not falsely trigger agent when active process is a normal shell',()=>{
  const staleRaw={spaces:[{id:'s1',tabs:[{id:'tab1',terminals:[{terminal:'t15',pane:'p1',app:'antigravity',status:null}]}]}]};
  const termMeta={t15:{title:'π - drew',fg:'zsh',statusApp:null}};
  const n=normalizeNativeHerdr(staleRaw,{},termMeta);
  assert.equal(n.sessions[0].agent,'terminal');
  assert.equal(n.sessions[0].name,'π - drew');

  const livePiMeta={t15:{title:'my custom title',fg:'pi',statusApp:null}};
  const n2=normalizeNativeHerdr(staleRaw,{},livePiMeta);
  assert.equal(n2.sessions[0].agent,'pi');
});
test('native malformed response is not empty success',()=>assert.throws(()=>normalizeNativeHerdr({tabs:[]})));
test('native list reads only app ls, errors do not masquerade as current data',async()=>{const calls=[];const n=createNativeHerdr(async args=>{calls.push(args);return JSON.stringify(raw);});assert.equal((await n.refresh()).ok,true);assert.deepEqual(calls,[['ls']]);const f=createNativeHerdr(async()=>{throw Error('no app');});const fail=await f.refresh();assert.equal(fail.ok,false);assert.deepEqual(fail.sessions,[]);});
test('native blocked session reads terminal, parses choices, generates ticket',async()=>{
 const hcCalls=[];const sampleText='Run this command?\n> 1. Yes\n  2. No\n';
 const n=createNativeHerdr(async args=>JSON.stringify(blockedRaw),async()=>{},async args=>{hcCalls.push(args);return sampleText;});
 const res=await n.refresh();
 assert.equal(res.ok,true);assert.equal(res.sessions.length,1);
 const s=res.sessions[0];
 assert.equal(s.status,'blocked');assert.equal(s.agent,'agy');
 assert.deepEqual(s.choices.map(c=>c.label),['Yes','No']);assert.ok(s.ticket);
 assert.deepEqual(hcCalls,[['read','t1']]);
});
test('native respond sends allowed key via hc keys and rejects stale ticket',async()=>{
 const hcCalls=[];const sampleText='Run this command?\n> 1. Yes\n  2. No\n';
 const n=createNativeHerdr(async args=>JSON.stringify(blockedRaw),async()=>{},async args=>{hcCalls.push(args);return sampleText;});
 const res=await n.refresh();const s=res.sessions[0];
 const r=await n.respond({id:s.id,ticket:s.ticket,key:'1'});
 assert.equal(r.ok,true);
 assert.deepEqual(hcCalls,[['read','t1'],['read','t1'],['keys','t1','1']]);
 await assert.rejects(()=>n.respond({id:s.id,ticket:s.ticket,key:'rm -rf'}),/허용되지 않은/);
 await assert.rejects(()=>n.respond({id:s.id,ticket:'bad-ticket',key:'1'}),/오래된 요청/);
});
test('native focus resolves exact live terminal and checks native pane after focusing',async()=>{const calls=[];let raised=0;const n=createNativeHerdr(async args=>{calls.push(args);return args[0]==='ls'?JSON.stringify(raw):args[0]==='status'?JSON.stringify({focused_pane:'p1'}):'{}';},async()=>raised++);assert.equal((await n.focus({id:'native:t1'})).ok,true);assert.deepEqual(calls,[['ls'],['do','agent.focus','--terminal','t1'],['status']]);assert.equal(raised,1);});
test('native focus rejects stale target instead of falling back to TUI',async()=>{const calls=[];const n=createNativeHerdr(async args=>{calls.push(args);return JSON.stringify(raw);});await assert.rejects(()=>n.focus({id:'wG:p16'}));assert.deepEqual(calls,[['ls']]);});
test('focus mismatch never reports success',async()=>{const n=createNativeHerdr(async args=>args[0]==='ls'?JSON.stringify(raw):JSON.stringify({focused_pane:'another'}));await assert.rejects(()=>n.focus({id:'native:t1'}),/확인하지/);});
test('server routes use existing auth and origin checks; includes native respond route',async()=>{const s=await fs.readFile(new URL('../server.mjs',import.meta.url),'utf8');for(const route of ['/api/native/state','/api/native/focus','/api/native/respond']){assert.ok(s.indexOf("if(!auth(req))")<s.indexOf("route==='"+route+"'"));assert.ok(s.indexOf('req.headers.origin')<s.indexOf("route==='"+route+"'"));}});
test('generated client is present, compiles, and includes native client',async()=>{const html=await fs.readFile(new URL('../src/deck/index.html',import.meta.url),'utf8');assert.ok(html.includes((await fs.readFile(new URL('../src/integrations/native-client.js',import.meta.url),'utf8')).trimEnd()));for(const s of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(s[1]);});
test('recursive nested sub_agents blocked discovery hydrates in parallel and supports respond',async()=>{
 const nestedRaw={spaces:[{id:'s1',name:'Repo',machine:null,tabs:[{id:'tab1',name:'One',terminals:[{terminal:'t1',pane:'p1',app:'codex',status:'blocked',name:'Root',sub_agents:[{terminal:'t2',pane:'p2',app:'claude',status:'working',name:'Child',sub_agents:[{terminal:'t3',pane:'p3',app:'pi',status:'blocked',name:'Nested Pi',sub_agents:[]}]}]}]}]}]};
 const hcCalls=[];
 const n=createNativeHerdr(async()=>JSON.stringify(nestedRaw),async()=>{},async args=>{hcCalls.push(args);return 'Approve nested?\n> 1. Allow\n  2. Deny\n';});
 const res=await n.refresh();
 assert.equal(res.ok,true);
 const nested=res.sessions.find(s=>s.terminal==='t3');
 assert.ok(nested);assert.equal(nested.status,'blocked');assert.equal(nested.parent,'t2');assert.ok(nested.ticket);
 assert.deepEqual(nested.choices.map(c=>c.label),['Allow','Deny']);
 assert.deepEqual(hcCalls.filter(a=>a[0]==='read').map(a=>a[1]).sort(),['t1','t3']);
 const r=await n.respond({id:nested.id,ticket:nested.ticket,key:'1'});
 assert.equal(r.ok,true);
 assert.ok(hcCalls.some(a=>a[0]==='keys'&&a[1]==='t3'&&a[2]==='1'));
});
