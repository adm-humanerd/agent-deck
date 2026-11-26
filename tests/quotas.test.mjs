import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {chmod,mkdtemp,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import vm from 'node:vm';
import {normalizeCodex,normalizeAgy,createQuotaReader,readCodex,readAgy} from '../src/integrations/quotas.mjs';
import {applyQuotaView} from '../scripts/build/apply-quota-view.mjs';
const window=(usedPercent,windowDurationMins=300,resetsAt=1)=>({usedPercent,windowDurationMins,resetsAt});
const codex=(primary=window(20),secondary=window(70,10080))=>({rateLimits:{primary,secondary}});
const agy=(models)=>({userStatus:{cascadeModelConfigData:{clientModelConfigs:models}}});
const model=(remainingFraction,label='Gemini Flash',extra={})=>({label,modelId:label,quotaInfo:{remainingFraction,resetTime:'2025-01-01T00:00:00Z',...extra}});
for(const [used,expected] of [[0,100],[100,0],[5.5,94.5],[undefined,null],[null,null],['0',null],[-1,null],[101,null],[NaN,null]])test('Codex usedPercent '+String(used),()=>{
 assert.equal(normalizeCodex(codex(window(used))).buckets[0].fiveHour.remaining,expected);
});
test('periods use actual duration, never primary order or copied weekly',()=>{
 const b=normalizeCodex(codex(window(10,10080),window(90,300))).buckets[0];
 assert.equal(b.fiveHour.remaining,10);assert.equal(b.weekly.remaining,90);
 const unknown=normalizeCodex(codex(window(20,301),null)).buckets[0];
 assert.equal(unknown.fiveHour.remaining,null);assert.equal(unknown.weekly.remaining,null);
 assert.equal(normalizeCodex(codex(window(10),null)).buckets[0].weekly.remaining,null);
});
test('past resets do not fabricate remaining, long weekly reset stays absolute',()=>{
 const b=normalizeCodex(codex(window(100,300,1),window(99,10080,1893456000))).buckets[0];
 assert.equal(b.fiveHour.remaining,0);assert.equal(b.weekly.remaining,1);
 assert.equal(b.weekly.resetsAt,'2030-01-01T00:00:00.000Z');
 assert.equal(normalizeCodex(codex(window(5,300,'invalid'))).buckets[0].fiveHour.resetsAt,null);
});
test('Codex map dedupes explicit shared limit IDs, omits umbrella duplicate',()=>{
 const rate={limitId:'secret@example.com',primary:window(25)};
 const out=normalizeCodex({rateLimits:rate,rateLimitsByLimitId:{first:rate,alias:rate,other:{limitId:'other',primary:window(10)}}});
 assert.equal(out.buckets.length,2);assert.ok(!JSON.stringify(out).includes('secret@example.com'));
});
for(const [fraction,expected] of [[0,0],[1,100],[.35,35],[undefined,null],[null,null],['1',null],[2,null],[-.1,null]])test('AGY remainingFraction '+String(fraction),()=>{
 const p=normalizeAgy(agy([model(fraction)]));assert.equal(p.models[0].remaining,expected);
 assert.equal(p.models[0].period,'unconfirmed');assert.equal(p.buckets[0].fiveHour.remaining,null);assert.equal(p.buckets[0].weekly.remaining,null);
});
test('AGY dedupes explicit shared bucket, not coincidentally identical model values',()=>{
 const p=normalizeAgy(agy([model(.5,'a',{bucketId:'shared'}),model(.5,'b',{bucketId:'shared'}),model(.5,'c'),model(.5,'d')]));
 assert.equal(p.models.length,3);assert.equal(p.models[0].remaining,50);
});
test('AGY expired resets stay depleted and unsafe identity fields never escape',()=>{
 const p=normalizeAgy({...agy([model(0,'person@example.com')]),email:'person@example.com',csrf_token:'sensitive-token'});
 assert.equal(p.models[0].remaining,0);assert.equal(p.models[0].label,'모델 1');
 assert.doesNotMatch(JSON.stringify(p),/example.com|sensitive-token|csrf/);
});
test('cache coalesces concurrent reads, rate limits errors, and recovers',async()=>{
 let time=0,calls=0,fail=false;
 const reader=createQuotaReader({now:()=>time,ttl:100,staleAfter:200,codex:async()=>{calls++;await new Promise(r=>setTimeout(r,5));if(fail)throw Error('token=secret');return codex();},agy:async()=>agy([model(0)])});
 const [a,b]=await Promise.all([reader.refresh(),reader.refresh()]);assert.deepEqual(a,b);assert.equal(calls,1);
 time=99;await reader.refresh();assert.equal(calls,1);
 time=101;fail=true;const failed=await reader.refresh();assert.equal(calls,2);assert.equal(failed.providers[0].buckets[0].fiveHour.remaining,80);assert.ok(failed.providers[0].error);assert.ok(!JSON.stringify(failed).includes('secret'));
 time=302;const stale=await reader.refresh();assert.equal(stale.providers[0].stale,true);
 time=403;fail=false;const fresh=await reader.refresh();assert.equal(fresh.providers[0].stale,false);assert.equal(fresh.providers[0].error,null);
});
test('first failure or missing quotas remain unknown with independent provider success',async()=>{
 const reader=createQuotaReader({codex:async()=>({}),agy:async()=>agy([model(1)])});
 const result=await reader.refresh();assert.equal(result.providers[0].checkedAt,null);assert.equal(result.providers[0].stale,true);assert.equal(result.providers[0].buckets.length,0);
 assert.equal(result.providers[1].models[0].remaining,100);
});
function fixture(code){let child;return {spawnProcess:(_command,_args,opts)=>(child=spawn(process.execPath,['-e',code],opts)),get child(){return child;}};}
test('Codex waits for initialization and handles split JSON + notifications',async()=>{
 const f=fixture(`let text='';process.stdin.on('data',c=>{text+=c;let i;while((i=text.indexOf('\\n'))>=0){const m=JSON.parse(text.slice(0,i));text=text.slice(i+1);if(m.id===1){process.stdout.write('{"id":1,');setTimeout(()=>process.stdout.write('"result":{}}\\n'),5);}if(m.id===2)process.stdout.write(JSON.stringify({method:'notification'})+'\\n'+JSON.stringify({id:2,result:{rateLimits:{primary:{usedPercent:10,windowDurationMins:300}}}})+'\\n');}});`);
 const data=await readCodex({...f,timeout:2000});assert.equal(normalizeCodex(data).buckets[0].fiveHour.remaining,90);
 await new Promise(r=>f.child.once('close',r));assert.equal(f.child.signalCode,'SIGKILL');
});
test('Codex stalled output times out and kills process group',async()=>{
 const f=fixture('setInterval(()=>{},1000)');await assert.rejects(readCodex({...f,timeout:150}),/timeout/);
 await new Promise(r=>f.child.once('close',r));assert.equal(f.child.signalCode,'SIGKILL');
 assert.throws(()=>process.kill(-f.child.pid,0));
});
test('Codex query errors are generic and cleaned up',async()=>{
 const f=fixture(`process.stdin.on('data',()=>process.stdout.write(''+JSON.stringify({id:1,error:{message:'credential secret'}})+'\\n'))`);
 await assert.rejects(readCodex({...f,timeout:1000}),/^Error: query-error$/);
});
test('Codex missing executable fails safely',async()=>{await assert.rejects(readCodex({command:'/nonexistent/codex',timeout:1000}),/unavailable/);});
test('AGY read boundary suppresses stderr, blocks nonlocal CSRF destination and kills stalled child',async()=>{
 const before=process.env.ANTIGRAVITY_LS_ADDRESS;process.env.ANTIGRAVITY_LS_ADDRESS='external.example:1234';
 let env;const f=fixture('setInterval(()=>{},1000)');
 try{await assert.rejects(readAgy({timeout:150,spawnProcess:(c,a,o)=>{env=o.env;assert.ok(a[2].includes('m.get_active_user_status()'));assert.ok(!a[2].includes('save_state('));return f.spawnProcess(c,a,o);}}),/timeout/);
 await new Promise(r=>f.child.once('close',r));assert.equal(env.ANTIGRAVITY_LS_ADDRESS,undefined);assert.equal(env.PYTHONDONTWRITEBYTECODE,'1');assert.throws(()=>process.kill(-f.child.pid,0));}
 finally{if(before===undefined)delete process.env.ANTIGRAVITY_LS_ADDRESS;else process.env.ANTIGRAVITY_LS_ADDRESS=before;}
});
test('embedding is idempotent, maintained sources match served HTML, existing keys stay intact',async()=>{
 const html=await readFile(new URL('../src/deck/index.html',import.meta.url),'utf8');
 for(const script of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))assert.doesNotThrow(()=>new vm.Script(script[1]));
 const next=await applyQuotaView(html);assert.equal(await applyQuotaView(next),next);assert.equal(next,html);
 for(const file of ['../src/integrations/quota-client.js','../src/integrations/quota.css','../src/deck/deck-client.js'])assert.ok(html.includes((await readFile(new URL(file,import.meta.url),'utf8')).trimEnd()));
 assert.ok(html.includes((await readFile(new URL('../src/deck/deck-layout.mjs',import.meta.url),'utf8')).replace(/^export /gm,'').trimEnd()));
 assert.equal((html.match(/id="quotaKeys"/g)||[]).length,0);assert.doesNotMatch(html,/quota-keys/);assert.ok(html.includes('id="pendingStrip"'));
});
const flatten=n=>[n,...n.children.flatMap(flatten)];
const text=n=>flatten(n).map(n=>n.textContent||'').join(' ');
const settle=()=>new Promise(r=>setImmediate(r));
const clientSource=await readFile(new URL('../src/integrations/quota-client.js',import.meta.url),'utf8');
function clientHarness(fetch,extra={}){
 const document={hidden:false,activeElement:null,events:{},getElementById:id=>ids[id],createElement:t=>new Element(t),addEventListener(k,v){this.events[k]=v;}};
 class Element{
  constructor(tag){this.tag=tag;this.children=[];this.style={};this.attrs={};this.events={};this.dataset={};this.open=false;}
  set className(v){this.attrs.class=v;}
  get className(){return this.attrs.class||'';}
  append(...n){this.children.push(...n);}
  replaceChildren(...n){if(this.children.some(child=>flatten(child).includes(document.activeElement)))document.activeElement=null;this.children=n;}
  setAttribute(k,v){this.attrs[k]=v;}
  addEventListener(k,v){this.events[k]=v;}
  focus(){document.activeElement=this;}
  showModal(){this.open=true;document.activeElement=ids.closeQuota;}
  close(){this.open=false;this.events.close?.();}
 }
 const ids=Object.fromEntries(['quotaKeys','quotaDetail','quotaContent','quotaTitle','closeQuota','refreshQuota'].map(id=>[id,new Element('div')]));
 // Quota presentation unit tests invoke the action supplied to the separately tested input owner.
 const intervals=[],ctx={document,modal:false,fetch,deckInputContext:()=> 'quota-test',bindDeckInput(button,activate){button.onclick=activate;},setInterval(fn,ms){intervals.push({fn,ms});},Date,console,...extra};
 ctx.window=ctx;
 vm.runInNewContext(clientSource,ctx);
 ids.quotaKeys.append(ctx.quotaView.key('codex','slot:quota:0'),ctx.quotaView.key('agy','slot:quota:1'));
 return {ids,ctx,intervals};
}
const clientData=()=>({providers:[{...normalizeCodex(codex(window(100),window(0,10080,1893456000))),checkedAt:new Date().toISOString(),stale:false,error:null},{...normalizeAgy(agy([model(0)])),checkedAt:new Date().toISOString(),stale:false,error:null}]});
test('client renders real 0 vs unknown, touch details, long reset, error and modal safety',async()=>{
 const data={providers:[{...normalizeCodex(codex(window(100),window(0,10080,1893456000))),checkedAt:new Date().toISOString(),stale:false,error:null},{...normalizeAgy(agy([model(0)])),checkedAt:null,stale:true,error:'조회 실패'}]};
 const {ids,ctx}=clientHarness(async()=>({ok:true,json:async()=>data}));await settle();
 const all=flatten(ids.quotaKeys);assert.ok(all.some(n=>n.attrs['aria-valuenow']==='0'));assert.ok(all.some(n=>n.attrs['aria-valuenow']==='100'));assert.ok(all.some(n=>n.attrs['aria-valuetext']==='알 수 없음'&&!('aria-valuenow' in n.attrs)));
 ids.quotaKeys.children[0].onclick();assert.equal(ctx.modal,true);assert.equal(ids.quotaDetail.open,true);assert.ok(flatten(ids.quotaContent).some(n=>n.textContent?.includes('일 ')));
 ids.closeQuota.onclick();assert.equal(ctx.modal,false);
 ids.quotaKeys.children[1].onclick();assert.ok(flatten(ids.quotaContent).some(n=>n.textContent?.includes('기간 미확정')));
});
test('cold loading dialog has both providers, explicit unknown and useful details',async()=>{
 let resolve;const {ids,ctx}=clientHarness(()=>new Promise(r=>{resolve=r;}));
 assert.equal(ids.quotaKeys.children.length,2);
 for(const [i,label] of ['Codex','Antigravity'].entries()){
  ids.quotaKeys.children[i].onclick();assert.equal(ctx.modal,true);
  assert.match(ids.quotaTitle.textContent,new RegExp(label));assert.match(text(ids.quotaContent),/조회 중/);
  assert.match(text(ids.quotaContent),/잔여율과 초기화 시각 미확인/);
  assert.equal(flatten(ids.quotaContent).filter(n=>n.attrs['aria-valuetext']==='알 수 없음').length,2);
  assert.ok(!flatten(ids.quotaContent).some(n=>'aria-valuenow' in n.attrs));ids.closeQuota.onclick();
 }
 resolve({ok:true,json:async()=>clientData()});await settle();assert.match(text(ids.quotaKeys),/0%/);assert.equal(ctx.document.activeElement,ids.quotaKeys.children[1]);
});
const malformedResponses=[null,{}, {providers:[]}, {providers:[null,null]},
 ...[
  data=>{data.providers[1]=data.providers[0];},
  data=>{data.providers[0].buckets={};},
  data=>{data.providers[0].buckets[0]=null;},
  data=>{data.providers[0].buckets[0].fiveHour.remaining=101;},
  data=>{data.providers[0].buckets[0].weekly=null;},
  data=>{data.providers[1].models={};},
  data=>{data.providers[1].models[0].remaining='100';},
  data=>{data.providers[0].checkedAt='invalid';},
 ].map(change=>{const data=clientData();change(data);return data;})];
for(const [label,response] of [
 ['thrown fetch',async()=>{throw Error('credential-secret');}],
 ['non-OK',async()=>({ok:false,json:async()=>{throw Error('must not parse');}})],
 ['invalid JSON',async()=>({ok:true,json:async()=>{throw Error('credential-secret');}})],
 ...malformedResponses.map((data,i)=>['invalid shape '+i,async()=>({ok:true,json:async()=>data})]),
])test('client cold '+label+' is safe in both dialogs and recovers actual values',async()=>{
 let recover=false;
 const {ids,ctx}=clientHarness((...args)=>recover?Promise.resolve({ok:true,json:async()=>clientData()}):response(...args));await settle();
 assert.equal(ids.quotaKeys.children.length,2);assert.match(text(ids.quotaKeys),/서버 조회 오류/);assert.doesNotMatch(text(ids.quotaKeys),/credential-secret/);
 for(const [i,label] of ['Codex','Antigravity'].entries()){
  ids.quotaKeys.children[i].onclick();assert.match(ids.quotaTitle.textContent,new RegExp(label));assert.match(text(ids.quotaContent),/서버 조회 오류/);
  assert.ok(!flatten(ids.quotaContent).some(n=>'aria-valuenow' in n.attrs));assert.doesNotMatch(text(ids.quotaContent),/credential-secret/);ids.closeQuota.onclick();assert.equal(ctx.modal,false);
 }
 ids.quotaKeys.children[0].onclick();recover=true;await ids.refreshQuota.onclick();
 assert.equal(ctx.modal,true);assert.match(text(ids.quotaContent),/0%/);assert.match(text(ids.quotaContent),/100%/);assert.doesNotMatch(text(ids.quotaContent),/서버 조회 오류/);
 ids.closeQuota.onclick();ids.quotaKeys.children[1].onclick();assert.match(text(ids.quotaContent),/모델 잔여 0%/);assert.match(text(ids.quotaContent),/기간 미확정/);
});
test('provider error strings never appear verbatim, then clear on recovery',async()=>{
 let data=clientData();data.providers[0].error='credential-secret';
 const {ids}=clientHarness(async()=>({ok:true,json:async()=>data}));await settle();
 ids.quotaKeys.children[0].onclick();assert.match(text(ids.quotaContent),/조회 실패/);assert.doesNotMatch(text(ids.quotaContent),/credential-secret/);
 data=clientData();await ids.refreshQuota.onclick();assert.match(text(ids.quotaContent),/조회 정상/);assert.doesNotMatch(text(ids.quotaContent),/조회 실패/);
});
test('failed refresh preserves real last-known values with an explicit error',async()=>{
 let fail=false;const {ids}=clientHarness(async()=>{if(fail)throw Error('credential-secret');return {ok:true,json:async()=>clientData()};});await settle();
 ids.quotaKeys.children[0].onclick();fail=true;await ids.refreshQuota.onclick();
 assert.match(text(ids.quotaContent),/stale/);
 assert.match(text(ids.quotaContent),/서버 조회 오류/);assert.match(text(ids.quotaContent),/5시간 잔여 0%/);assert.match(text(ids.quotaContent),/주간 잔여 100%/);assert.doesNotMatch(text(ids.quotaContent),/credential-secret/);
});
test('demo preview never fetches, including refresh, visibility and interval callbacks',async()=>{
 let calls=0;const {ids,ctx,intervals}=clientHarness(async()=>{calls++;throw Error('live read forbidden');},{demo:true});
 await settle();await ids.refreshQuota.onclick();ctx.document.events.visibilitychange();for(const timer of intervals)timer.fn();await settle();
 assert.equal(calls,0);assert.equal(ids.quotaKeys.children.length,2);
 for(const button of ids.quotaKeys.children){button.onclick();assert.match(text(ids.quotaContent),/미리보기 · 실시간 쿼터 조회 불가/);assert.ok(!flatten(ids.quotaContent).some(n=>'aria-valuenow' in n.attrs));ids.closeQuota.onclick();}
});
test('quota updates retain slot identity and opener while all buckets stay in touch details',async()=>{
 let data=clientData();const {ids,ctx,intervals}=clientHarness(async()=>({ok:true,json:async()=>data}));await settle();
 const first=ids.quotaKeys.children[0];first.focus();intervals.find(timer=>timer.ms===10000).fn();
 assert.equal(ids.quotaKeys.children[0],first);assert.equal(ctx.document.activeElement,first);
 data.providers[0].buckets[0].fiveHour.remaining=25;await ids.refreshQuota.onclick();assert.equal(ids.quotaKeys.children[0],first);assert.equal(ctx.document.activeElement,first);assert.match(text(first),/25%/);
 const second={...data.providers[0].buckets[0],id:'second',label:'Second'};data.providers[0].buckets.push(second);await ids.refreshQuota.onclick();
 assert.equal(ids.quotaKeys.children.length,2);assert.match(text(first),/공유 한도 1\/2/);
 first.onclick();assert.match(text(ids.quotaContent),/Second/);assert.equal(ctx.modal,true);
 data.providers[0].buckets.reverse();await ids.refreshQuota.onclick();assert.equal(ctx.document.activeElement,ids.closeQuota);
 ids.closeQuota.onclick();assert.equal(ctx.modal,false);assert.equal(ctx.document.activeElement,first);
 first.onclick();data.providers[0].buckets=[];await ids.refreshQuota.onclick();ids.closeQuota.onclick();assert.equal(ctx.document.activeElement,first);
 assert.equal(ctx.quotaView.key('codex','slot:quota:0'),first);
});
test('AGY representative model selection updates key gauge and persists in storage',async()=>{
 const store=new Map();
 const extra={localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,String(v))}};
 const data=()=>({providers:[
  {...normalizeCodex(codex(window(100),window(0,10080,1893456000))),checkedAt:new Date().toISOString(),stale:false,error:null},
  {...normalizeAgy(agy([model(0.85,'Gemini 4 Hydrogen'),model(0.028,'Gemini 4 Argon')])),checkedAt:new Date().toISOString(),stale:false,error:null}
 ]});
 const {ids,ctx}=clientHarness(async()=>({ok:true,json:async()=>data()}),extra);await settle();
 const agyKey=ids.quotaKeys.children[1];
 assert.match(text(agyKey),/모델 미선택/);
 agyKey.onclick();
 assert.match(text(ids.quotaContent),/덱 키에 표시할 대표 모델을 선택하세요/);
 const pickButtons=flatten(ids.quotaContent).filter(n=>n.attrs?.class?.includes('model-pick-btn'));
 assert.ok(pickButtons.length>=2);
 pickButtons[0].onclick();
 assert.match(text(agyKey),/Gemini 4 Hydrogen/);
 assert.equal(store.get('agentDeck.quota.agyModel'),'Gemini 4 Hydrogen');
});
test('AGY unconfirmed plan stays null, error sets stale true, and picking default 1st model clears 모델 미선택 immediately',async()=>{
 assert.equal(normalizeAgy(agy([model(0.8,'Alpha'),model(0.2,'Beta')])).plan,null);
 const errReader=createQuotaReader({codex:async()=>codex(),agy:async()=>{throw Error('boom');}});
 const errOut=await errReader.refresh();
 assert.equal(errOut.providers[1].stale,true);assert.ok(errOut.providers[1].error);
 const store=new Map();
 const extra={localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,String(v))}};
 const data=()=>({providers:[
  {...normalizeCodex(codex(window(100),window(0,10080,1893456000))),checkedAt:new Date().toISOString(),stale:false,error:null},
  {...normalizeAgy(agy([model(0.8,'Model Alpha'),model(0.4,'Model Beta')])),checkedAt:new Date().toISOString(),stale:false,error:null}
 ]});
 const {ids}=clientHarness(async()=>({ok:true,json:async()=>data()}),extra);await settle();
 const agyKey=ids.quotaKeys.children[1];
 assert.match(text(agyKey),/모델 미선택/);
 agyKey.onclick();
 const pickButtons=flatten(ids.quotaContent).filter(n=>n.attrs?.class?.includes('model-pick-btn'));
 pickButtons[0].onclick();
 assert.doesNotMatch(text(agyKey),/모델 미선택/);
 assert.doesNotMatch(text(agyKey),/주간 \(추정\)/);
 assert.match(text(agyKey),/Model Alpha/);
 assert.match(text(agyKey),/Model Beta/);
});
test('Codex free monthly window (43200m) normalizes cleanly and renders monthly gauge',async()=>{
 const freeCodex=normalizeCodex({rateLimits:{planType:'free',primary:{usedPercent:35,windowDurationMins:43200,resetsAt:1893456000},secondary:null}});
 assert.equal(freeCodex.plan,'Free');
 assert.equal(freeCodex.buckets[0].fiveHour.remaining,null);
 assert.equal(freeCodex.buckets[0].weekly.remaining,null);
 assert.equal(freeCodex.buckets[0].monthly.remaining,65);
 assert.equal(freeCodex.buckets[0].monthly.resetsAt,'2030-01-01T00:00:00.000Z');
 const reader=createQuotaReader({codex:async()=>({rateLimits:{planType:'free',primary:{usedPercent:35,windowDurationMins:43200,resetsAt:1893456000}}}),agy:async()=>agy([model(0.8)])});
 const out=await reader.refresh();
 assert.equal(out.providers[0].error,null);
 assert.equal(out.providers[0].stale,false);
 assert.equal(out.providers[0].buckets[0].monthly.remaining,65);
 const data={providers:[
  {...freeCodex,checkedAt:new Date().toISOString(),stale:false,error:null},
  {...normalizeAgy(agy([model(0.8,'Model Alpha')])),checkedAt:new Date().toISOString(),stale:false,error:null}
 ]};
 const {ids}=clientHarness(async()=>({ok:true,json:async()=>data}));await settle();
 const codexKey=ids.quotaKeys.children[0];
 assert.match(text(codexKey),/Codex/);
 assert.match(text(codexKey),/Free/);
 assert.match(text(codexKey),/월간 65%/);
 assert.doesNotMatch(text(codexKey),/조회 정상|터치 상세/);
 codexKey.onclick();
 assert.match(text(ids.quotaContent),/구독 플랜: Free/);
 assert.match(text(ids.quotaContent),/월간 잔여 65%/);
});
test('AGY confirmed 5h + weekly groups normalize safely and switch cleanly on key and dialog',async()=>{
 const raw={
  usageGroups:[
   {id:'group-0-Gemini Models',name:'Gemini Models',fiveHour:{remainingFraction:0.625,resetTime:'2026-11-20T19:19:15Z'},weekly:{remainingFraction:0.769,resetTime:'2026-11-27T09:19:15Z'}},
   {id:'group-1-Claude and GPT models',name:'Claude and GPT models',fiveHour:{remainingFraction:1,resetTime:'2026-11-20T22:37:50Z'},weekly:{remainingFraction:1,resetTime:'2026-11-27T17:37:50Z'}},
   {id:'secret-group',name:'bearer secret-token',fiveHour:{remainingFraction:0.5,resetTime:'2026-11-20T22:37:50Z'}}
  ],
  userStatus:{cascadeModelConfigData:{clientModelConfigs:[
   {label:'Gemini 4 Neon',modelId:'Gemini 4 Neon',groupId:'group-0-Gemini Models',period:'5h',quotaInfo:{remainingFraction:0.625,resetTime:'2026-11-20T19:19:15Z'}},
   {label:'Claude Opus 5.5',modelId:'Claude Opus 5.5',groupId:'group-1-Claude and GPT models',period:'5h',quotaInfo:{remainingFraction:1,resetTime:'2026-11-20T22:37:50Z'}}
  ]}}
 };
 const normalized=normalizeAgy(raw);
 assert.equal(normalized.plan,null);
 assert.equal(normalized.buckets.length,3);
 assert.equal(normalized.buckets[0].label,'Gemini Models');
 assert.equal(normalized.buckets[0].fiveHour.remaining,62.5);
 assert.equal(normalized.buckets[0].weekly.remaining,76.9);
 assert.equal(normalized.buckets[2].label,'그룹 3');
 assert.doesNotMatch(JSON.stringify(normalized),/secret-token|bearer/);
 assert.equal(normalized.models[0].groupId,normalized.buckets[0].id);
 assert.equal(normalized.models[0].period,'5h');

 const store=new Map();
 const extra={localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,String(v))}};
 const data={providers:[
  {...normalizeCodex(codex(window(10),window(20,10080))),checkedAt:new Date().toISOString(),stale:false,error:null},
  {...normalized,buckets:normalized.buckets.slice(0,2),checkedAt:new Date().toISOString(),stale:false,error:null}
 ]};
 const {ids}=clientHarness(async()=>({ok:true,json:async()=>data}),extra);await settle();
 const agyKey=ids.quotaKeys.children[1];
 assert.match(text(agyKey),/Antigravity/);
 assert.equal(flatten(agyKey).filter(n=>n.attrs?.class==='quota-tag').length,0);
 assert.equal(flatten(agyKey).filter(n=>n.attrs?.role==='meter').length,4);
 assert.match(text(agyKey),/Gemini 5h 62\.5%/);
 assert.match(text(agyKey),/Gemini 주간 76\.9%/);
 assert.match(text(agyKey),/3P 5h 100%/);
 assert.match(text(agyKey),/3P 주간 100%/);
 assert.doesNotMatch(text(agyKey),/조회 정상|터치 상세/);
 const pairsBefore=flatten(agyKey).filter(n=>n.attrs?.class?.includes('quota-bucket-pair'));
 assert.equal(pairsBefore.length,2);
 assert.equal(pairsBefore[0].attrs.class,'quota-bucket-pair');
 assert.equal(pairsBefore[1].attrs.class,'quota-bucket-pair is-secondary');
 agyKey.onclick();
 assert.match(text(ids.quotaContent),/포함 모델: Gemini 4 Neon/);
 const pickButtons=flatten(ids.quotaContent).filter(n=>n.attrs?.class?.includes('model-pick-btn'));
 assert.equal(pickButtons.length,2);
 pickButtons[1].onclick();
 assert.equal(flatten(agyKey).filter(n=>n.attrs?.class==='quota-tag').length,0);
 const pairsAfter=flatten(agyKey).filter(n=>n.attrs?.class?.includes('quota-bucket-pair'));
 assert.equal(pairsAfter.length,2);
 assert.equal(pairsAfter[0].attrs.class,'quota-bucket-pair is-secondary');
 assert.equal(pairsAfter[1].attrs.class,'quota-bucket-pair');
 assert.match(text(agyKey),/Gemini 5h 62\.5%/);
 assert.match(text(agyKey),/3P 5h 100%/);
 assert.equal(store.get('agentDeck.quota.agyBucket'),normalized.buckets[1].id);
});
test('AGY displays account tier badge in key head and full plan in detail dialog across bucket switches',async()=>{
 const raw={
  planType:'Google AI Ultra',
  usageGroups:[
   {id:'group-0-Gemini Models',name:'Gemini Models',fiveHour:{remainingFraction:0.9,resetTime:'2026-11-26T12:42:22Z'},weekly:{remainingFraction:0.98,resetTime:'2026-12-03T07:42:22Z'}},
   {id:'group-1-Claude and GPT models',name:'Claude and GPT models',fiveHour:{remainingFraction:1,resetTime:'2026-11-26T12:42:22Z'},weekly:{remainingFraction:0.21,resetTime:'2026-12-01T03:25:18Z'}}
  ],
  userStatus:{cascadeModelConfigData:{clientModelConfigs:[
   {label:'Gemini 4 Neon',modelId:'Gemini 4 Neon',groupId:'group-0-Gemini Models',period:'5h',quotaInfo:{remainingFraction:0.9,resetTime:'2026-11-26T12:42:22Z'}},
   {label:'Claude Opus 5.5',modelId:'Claude Opus 5.5',groupId:'group-1-Claude and GPT models',period:'5h',quotaInfo:{remainingFraction:1,resetTime:'2026-11-26T12:42:22Z'}}
  ]}}
 };
 const normalized=normalizeAgy(raw);
 assert.equal(normalized.plan,'Google AI Ultra');
 const store=new Map();
 const extra={localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,String(v))}};
 const data={providers:[
  {...normalizeCodex(codex(window(10),window(20,10080))),checkedAt:new Date().toISOString(),stale:false,error:null},
  {...normalized,checkedAt:new Date().toISOString(),stale:false,error:null}
 ]};
 const {ids}=clientHarness(async()=>({ok:true,json:async()=>data}),extra);await settle();
 const agyKey=ids.quotaKeys.children[1];
 const tagsBefore=flatten(agyKey).filter(n=>n.attrs?.class==='quota-tag');
 assert.equal(tagsBefore.length,1);
 assert.equal(tagsBefore[0].textContent,'AI Ultra');
 assert.match(text(agyKey),/Gemini 5h 90%/);
 assert.match(text(agyKey),/Gemini 주간 98%/);
 assert.match(text(agyKey),/3P 5h 100%/);
 assert.match(text(agyKey),/3P 주간 21%/);
 agyKey.onclick();
 assert.equal(ids.quotaTitle.textContent,'Antigravity (Google AI Ultra) 쿼터');
 assert.match(text(ids.quotaContent),/구독 플랜: Google AI Ultra/);
 const pickButtons=flatten(ids.quotaContent).filter(n=>n.attrs?.class?.includes('model-pick-btn'));
 pickButtons[1].onclick();
 const tagsAfter=flatten(agyKey).filter(n=>n.attrs?.class==='quota-tag');
 assert.equal(tagsAfter.length,1);
 assert.equal(tagsAfter[0].textContent,'AI Ultra');
 const pairsAfter=flatten(agyKey).filter(n=>n.attrs?.class?.includes('quota-bucket-pair'));
 assert.equal(pairsAfter[0].attrs.class,'quota-bucket-pair is-secondary');
 assert.equal(pairsAfter[1].attrs.class,'quota-bucket-pair');
});
test('readAgy resolves verified account tier via --log-file and rejects mismatch or stale cache without leaking email',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'agy-tier-test-'));
 const fakeAgy=path.join(dir,'fake-agy');
 const accountsFile=path.join(dir,'accounts.json');
 const usageJson=JSON.stringify({
  command:{name:'usage',data:{groups:[
   {name:'Gemini Models',description:'Models within this group: Gemini 4 Neon',buckets:[{window:'5h',remaining_fraction:0.9,reset_time:'2026-11-26T12:42:22Z'},{window:'weekly',remaining_fraction:0.98,reset_time:'2026-12-03T07:42:22Z'}]}
  ]}}
 });
 await writeFile(fakeAgy,`#!/usr/bin/env python3
import sys
args = sys.argv[1:]
if '--log-file' in args:
 lf = args[args.index('--log-file') + 1]
 with open(lf, 'w', encoding='utf-8') as f:
  f.write('I1126 17:26:08 server_oauth.go:221] applyAuthResult: email=active@example.com, authMethod=consumer, quotaProject=\\n')
print(${JSON.stringify(usageJson)})
`);
 await chmod(fakeAgy,0o755);
 const nowSec=Math.floor(Date.now()/1000);
 try{
  await writeFile(accountsFile,JSON.stringify({
   latest_email:'active@example.com',
   accounts:{'active@example.com':{email:'active@example.com',plan:'Google AI Ultra',at:nowSec}}
  }));
  const beforeTmp=new Set((await readdir(os.tmpdir())).filter(n=>n.startsWith('agy-deck-')));
  const matched=await readAgy({agyBin:fakeAgy,accountsPath:accountsFile});
  assert.equal(matched.planType,'Google AI Ultra');
  assert.doesNotMatch(JSON.stringify(matched),/active@example\.com/);
  const afterTmp=new Set((await readdir(os.tmpdir())).filter(n=>n.startsWith('agy-deck-')));
  assert.deepEqual([...afterTmp].filter(n=>!beforeTmp.has(n)),[]);

  await writeFile(accountsFile,JSON.stringify({
   latest_email:'other@example.com',
   accounts:{'other@example.com':{email:'other@example.com',plan:'Google AI Pro',at:nowSec}}
  }));
  const mismatch=await readAgy({agyBin:fakeAgy,accountsPath:accountsFile});
  assert.equal(mismatch.planType,null);

  await writeFile(accountsFile,JSON.stringify({
   latest_email:'active@example.com',
   accounts:{'active@example.com':{email:'active@example.com',plan:'Google AI Ultra',at:nowSec-10*86400}}
  }));
  const stale=await readAgy({agyBin:fakeAgy,accountsPath:accountsFile});
  assert.equal(stale.planType,null);
 }finally{
  await rm(dir,{recursive:true,force:true});
 }
});
test('createQuotaReader force refresh respects cooldown and client refresh button sends ?force=1',async()=>{
 let time=10000,calls=0;
 const reader=createQuotaReader({now:()=>time,ttl:30000,forceCooldown:5000,codex:async()=>{calls++;return codex();},agy:async()=>agy([model(1)])});
 await reader.refresh();assert.equal(calls,1);
 time=12000;await reader.refresh({force:true});assert.equal(calls,1);
 time=15000;await reader.refresh({force:true});assert.equal(calls,2);
 time=25000;await reader.refresh();assert.equal(calls,2);
 const urls=[];
 const {ids}=clientHarness(async url=>{urls.push(url);return {ok:true,json:async()=>clientData()};});
 await settle();
 await ids.refreshQuota.onclick();
 assert.deepEqual(urls,['/api/quotas','/api/quotas?force=1']);
});
