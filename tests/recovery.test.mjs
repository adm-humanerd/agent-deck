import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const html=await readFile(new URL('../src/deck/index.html',import.meta.url),'utf8');
const recovery=html.match(/let recoveryBusy=false[\s\S]*?(?=\(async\(\)=>\{if\(demo\))/)?.[0];
function setup(){
 const els={},calls=[],timeouts=[];
 const c={demo:false,modal:false,sending:false,timer:123,online:true,pairInfo:null,deckView:'herdr',setDeckAccess:()=>calls.push('access'),loadSharedLayouts:async()=>calls.push('layout'),document:{body:{classList:{add(){}}}},$:id=>els[id]??=( {hidden:true,textContent:''}),api:async url=>{calls.push(url);return {paired:true,local:false};},startPolling:()=>calls.push('poll'),refresh:async()=>calls.push('state'),refreshNative:async()=>calls.push('native'),refreshNetwork:async()=>calls.push('network'),showError:m=>calls.push('error'),setTimeout:(fn,ms)=>{timeouts.push({fn,ms});return timeouts.length;},clearTimeout(){},clearInterval:()=>calls.push('stop')};
 c.cancelDeckInput=()=>calls.push('cancel-input');
 vm.createContext(c);vm.runInContext(recovery,c);return {c,els,calls,timeouts};
}
test('initial offline boot keeps retrying then restores read polling without key sends',async()=>{
 const {c,calls,timeouts}=setup();c.api=async url=>{calls.push(url);throw Error('offline');};
 await c.recoverConnection();assert.equal(timeouts[0].ms,1000);await timeouts[0].fn();assert.equal(timeouts[1].ms,2000);
 c.api=async url=>{calls.push(url);return {paired:true,local:false};};await timeouts[1].fn();assert.ok(calls.includes('state'));assert.ok(calls.includes('poll'));assert.ok(calls.every(x=>!x.includes('respond')&&!x.includes('focus')));
});
test('expired or revoked registration stops polling and requests pairing',async()=>{
 const {c,els,calls}=setup();c.api=async()=>({paired:false});await c.recoverConnection();assert.equal(els.pair.hidden,false);assert.ok(calls.includes('stop'));assert.ok(!calls.includes('state'));
});
test('native and Reason recover their current view',async()=>{for(const [view,call] of [['native','native'],['reason','network']]){const {c,calls}=setup();c.deckView=view;await c.recoverConnection();assert.ok(calls.includes(call));assert.ok(!calls.includes('state'));}});
test('recovery never interferes with in-flight user input or modal actions',async()=>{for(const field of ['sending','modal','demo']){const {c,calls}=setup();c[field]=true;await c.recoverConnection();assert.equal(calls.length,0);}});
test('concurrent lifecycle events coalesce one recovery',async()=>{
 const {c,calls}=setup();let resolve;c.api=()=>new Promise(r=>resolve=r);const first=c.recoverConnection();await c.recoverConnection();resolve({paired:true,local:false});await first;assert.equal(calls.filter(x=>x==='poll').length,1);
});
test('auth renews cookies, revocation requires localhost and same-origin',async()=>{
 const s=await readFile(new URL('../server.mjs',import.meta.url),'utf8');assert.ok(s.includes("if(!isLocal(req)&&auth(req))res.setHeader('Set-Cookie',sessionCookie(deviceToken(req)));"));assert.match(s,/function auth\(req\)[^\n]*sessions.has\(deviceToken\(req\)\)[^\n]*catch\{return false;\}/);assert.match(s,/api\/devices\/revoke-all[\s\S]*?if\(!isLocal\(req\)\)/);assert.match(s,/\['POST','PUT','PATCH','DELETE'\]\.includes\(req.method\)&&!sameOrigin\(req\)/);
 assert.match(html,/window.addEventListener\('pageshow'/);assert.match(html,/window.addEventListener\('online'/);assert.match(html,/visibilitychange/);
});
