import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
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
test('AGY plan remains unknown without an explicit valid upstream plan',()=>{
 for(const planType of [undefined,null,'','<script>'])assert.equal(normalizeAgy({...agy([model(.5)]),planType}).plan,null);
 assert.equal(normalizeAgy({...agy([model(.5)]),planType:'Free'}).plan,'Free');
 assert.equal(normalizeAgy({userStatus:{...agy([]).userStatus,planType:'Pro'}}).plan,'Pro');
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
 assert.equal(failed.providers[0].stale,true,'A failed refresh is stale immediately, even inside the age threshold');
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
 try{await assert.rejects(readAgy({timeout:150,spawnProcess:(c,a,o)=>{env=o.env;assert.ok(a[2].includes('m.get_active_user_status()'));assert.ok(!a[2].includes('save_state('));assert.doesNotMatch(a[2],/agy_quota_state|remaining_pct|open\(sf\)/);return f.spawnProcess(c,a,o);}}),/timeout/);
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
