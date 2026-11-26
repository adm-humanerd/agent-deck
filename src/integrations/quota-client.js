// Quota keys occupy ordinary profile slots; collection remains read-only.
var quotaView=(()=>{
 const dialog=document.getElementById('quotaDetail');
 const preview=typeof demo!=='undefined'&&demo;
 const unknown=provider=>({provider,buckets:[],models:[],checkedAt:null,error:null,stale:true});
 let providers=['codex','agy'].map(unknown),busy=false,selected=null,opener=null,lastReceived=0,phase=preview?'preview':'loading';
 const buttons=new Map();
 const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
 const pct=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100?value:null;
 function validate(data){
  const date=value=>value===null||(typeof value==='string'&&Number.isFinite(Date.parse(value)));
  const window=value=>value&&typeof value==='object'&&(value.remaining===null||pct(value.remaining)!==null)&&date(value.resetsAt);
  const item=value=>value&&typeof value.id==='string'&&value.id.length>0&&typeof value.label==='string';
  if(!data||!Array.isArray(data.providers)||data.providers.length!==2)throw Error();
  return ['codex','agy'].map(provider=>{
   const matches=data.providers.filter(p=>p?.provider===provider),p=matches[0];
   if(matches.length!==1||!date(p.checkedAt)||typeof p.stale!=='boolean'||!(p.error===null||typeof p.error==='string')||!Array.isArray(p.buckets)||!Array.isArray(p.models))throw Error();
   if(!p.buckets.every(b=>item(b)&&window(b.fiveHour)&&window(b.weekly)&&(!b.daily||window(b.daily))&&(!b.monthly||window(b.monthly)))||!p.models.every(m=>item(m)&&window(m)))throw Error();
   if(new Set(p.buckets.map(b=>b.id)).size!==p.buckets.length)throw Error();
   return {...p,error:p.error?'조회 실패 · 연결 또는 로그인 상태를 확인하세요':null};
  });
 }
 function status(p){
  if(phase==='preview')return '미리보기 · 실시간 쿼터 조회 불가';
  if(phase==='loading')return '쿼터 조회 중 · 잔여율 미확인';
  const old=p.checkedAt&&stale(p);
  if(p.error)return (old?'오래된 정보 (stale) · ':'')+p.error;
  return !p.checkedAt?'아직 확인되지 않음':old?'오래된 정보 (stale)':'조회 정상';
 }
 function gauge(label,window,compact=false){
  const value=pct(window?.remaining),row=node('div',undefined,'quota-row');
  const head=node('div',undefined,'quota-row-head');
  if(compact){
   head.append(node('span',label),node('span',value===null?'—':value+'%','quota-val'));
  }else{
   head.append(node('span',label+' 잔여 '+(value===null?'—':value+'%')));
  }
  row.append(head);
  const track=node('div',undefined,'quota-track'+(value===null?' unknown':''));
  track.setAttribute('role','meter');track.setAttribute('aria-label',label+' 잔여율');
  track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');
  if(value!==null){track.setAttribute('aria-valuenow',String(value));const fill=node('i');fill.style.width=value+'%';fill.style.background=value<=5?'#ffc2b8':value<=20?'#f6bf63':'#b9e8ce';track.append(fill);}
  else track.setAttribute('aria-valuetext','알 수 없음');
  row.append(track);return row;
 }
 function stale(p){return p.stale||!p.checkedAt||Date.now()-Date.parse(p.checkedAt)>180000||Date.now()-lastReceived>180000;}
 function isAbnormalStatus(p){return phase!=='ready'||!!p.error||!p.checkedAt||stale(p);}
 function cleanModelName(label){
  return (label||'').replace(/\s*\((Low|Medium|High|XHigh)\)/gi,'').trim();
 }
 function compactGroupPrefix(label,multi){
  const s=String(label||'').trim();
  if(/^gemini/i.test(s))return 'Gemini';
  if(/claude.*gpt|^3p\b/i.test(s))return '3P';
  return multi?s:'';
 }
 function compactWindowLabel(prefix,label){
  if(!prefix)return label;
  return prefix+' '+(label==='5시간'?'5h':label);
 }
 function shortPlanLabel(plan){
  return String(plan||'').trim().replace(/^Google(?:\s+One)?\s+/i,'');
 }
 function name(p){
  const base=p.provider==='codex'?'Codex':'Antigravity';
  return p.plan?base+' ('+p.plan+')':base;
 }
 function resetText(value){
  if(!value)return '초기화 시각 미확인';
  const ms=Date.parse(value)-Date.now();
  if(!Number.isFinite(ms))return '초기화 시각 미확인';
  if(ms<=0)return new Date(value).toLocaleString()+' · 초기화 시각 경과 · 재조회 필요';
  const minutes=Math.ceil(ms/60000),days=Math.floor(minutes/1440),hours=Math.floor(minutes%1440/60);
  return new Date(value).toLocaleString()+' · 초기화까지 '+(days?days+'일 ':'')+(hours?hours+'시간 ':'')+(minutes%60)+'분';
 }
 const storage={get(k){try{return window.localStorage?.getItem(k);}catch{return null;}},set(k,v){try{window.localStorage?.['set'+'Item'](k,v);}catch{}}};
 function groupModels(models){
  const map=new Map();
  for(const m of models||[]){
   const clean=cleanModelName(m.label);
   if(!map.has(clean)){
    map.set(clean,{...m,cleanName:clean});
   }else{
    const cur=map.get(clean);
    if(m.remaining!==null&&(cur.remaining===null||m.remaining<cur.remaining)){
     map.set(clean,{...m,cleanName:clean});
    }
   }
  }
  return Array.from(map.values());
 }
 function bucketWindows(b){
  if(!b)return [['5시간',null],['주간',null]];
  const rows=[];
  const hasStandard=pct(b.fiveHour?.remaining)!==null||pct(b.weekly?.remaining)!==null;
  const hasExtended=pct(b.daily?.remaining)!==null||pct(b.monthly?.remaining)!==null;
  if(hasStandard||!hasExtended)rows.push(['5시간',b.fiveHour],['주간',b.weekly]);
  if(pct(b.daily?.remaining)!==null)rows.push(['일간',b.daily]);
  if(pct(b.monthly?.remaining)!==null)rows.push(['월간',b.monthly]);
  return rows;
 }
 function confirmedAgyBuckets(p){
  if(p.provider!=='agy')return [];
  return (p.buckets||[]).filter(b=>[b.fiveHour,b.weekly,b.daily,b.monthly].some(w=>pct(w?.remaining)!==null));
 }
 function activeAgyBucket(p){
  const confirmed=confirmedAgyBuckets(p);
  if(!confirmed.length)return null;
  const saved=storage.get('agentDeck.quota.agyBucket');
  return confirmed.find(b=>b.id===saved||b.label===saved)||confirmed[0];
 }
 function selectAgyBucket(bucket){
  storage.set('agentDeck.quota.agyBucket',bucket.id);
  render();
 }
 function activeAgyModel(p){
  if(p.provider!=='agy'||!p.models?.length)return null;
  const grouped=groupModels(p.models);
  const saved=storage.get('agentDeck.quota.agyModel');
  return grouped.find(m=>m.cleanName===saved||m.id===saved)||grouped.find(m=>m.cleanName.includes('Argon'))||grouped[0];
 }
 function selectAgyModel(model){
  storage.set('agentDeck.quota.agyModel',model.cleanName);
  render();
 }
 function detail(){
  const p=providers.find(x=>x.provider===selected);if(!p)return;
  const content=document.getElementById('quotaContent'),scroll=dialog.open?content.scrollTop:0;content.replaceChildren();
  document.getElementById('quotaTitle').textContent=name(p)+' 쿼터';
  const planInfo=p.plan?'구독 플랜: '+p.plan+' · ':'';
  const metaBar=node('div',undefined,'quota-meta-bar');
  const pill=node('span',status(p),'quota-status-pill');
  pill.dataset.state=p.error?'err':stale(p)||phase!=='ready'?'warn':'ok';
  metaBar.append(pill,node('p','마지막 확인: '+(p.checkedAt?new Date(p.checkedAt).toLocaleString():'—'),'quota-checked-at'));
  content.append(metaBar,node('p',planInfo+'활성계정 범위 · 다중계정 식별/전체 계정 조회 미지원','hint'));
  const confirmedAgy=confirmedAgyBuckets(p);
  if(p.provider==='agy'&&confirmedAgy.length){
   const chosen=activeAgyBucket(p);
   content.append(node('p','기본·아이패드 키에는 두 그룹(4줄)이 함께 표시되며, 좁은 화면에서는 선택한 우선 그룹만 표시됩니다.','hint'));
   for(const b of confirmedAgy){
    const card=node('div',undefined,'quota-group-card');
    const header=node('div',undefined,'model-pick-header');
    header.append(node('h3',b.label));
    const isSelected=chosen?.id===b.id;
    const btn=node('button',isSelected?'✓ 우선 표시 중':'우선 표시',isSelected?'model-pick-btn active':'model-pick-btn');
    btn.type='button';
    btn.onclick=()=>selectAgyBucket(b);
    header.append(btn);
    card.append(header);
    for(const [label,w] of bucketWindows(b)){card.append(gauge(label,w,false),node('p',resetText(w?.resetsAt),'hint'));}
    const names=[];
    for(const m of groupModels(p.models)){if(m.groupId===b.id&&!names.includes(m.cleanName))names.push(m.cleanName);}
    if(names.length)card.append(node('p','포함 모델: '+names.join(', '),'quota-models-note'));
    content.append(card);
   }
  }else{
   if(!p.buckets.length){content.append(gauge('5시간',null,false),gauge('주간',null,false),node('p','잔여율과 초기화 시각 미확인 · 다시 확인으로 재조회하세요','hint'));}
   for(const b of p.buckets||[]){
    const card=node('div',undefined,'quota-group-card');
    card.append(node('h3',b.label));
    for(const [label,w] of bucketWindows(b)){card.append(gauge(label,w,false),node('p',resetText(w?.resetsAt),'hint'));}
    content.append(card);
   }
   if(p.provider==='agy'){
    const chosen=activeAgyModel(p);
    const grouped=groupModels(p.models);
    content.append(node('p','덱 키에 표시할 대표 모델을 선택하세요. 모델별 값은 실제 잔여율입니다.','hint'));
    for(const m of grouped){
     const card=node('div',undefined,'quota-group-card');
     const header=node('div',undefined,'model-pick-header');
     header.append(node('h3',m.cleanName));
     const isSelected=chosen?.cleanName===m.cleanName;
     const btn=node('button',isSelected?'✓ 키에 표시 중':'키에 표시',isSelected?'model-pick-btn active':'model-pick-btn');
     btn.type='button';
     btn.onclick=()=>selectAgyModel(m);
     header.append(btn);
     card.append(header,gauge('모델',m,false),node('p',resetText(m.resetsAt),'hint'));
     content.append(card);
    }
   }
  }
  content.scrollTop=scroll;
 }
 function update(entry){
  const p=providers.find(x=>x.provider===entry.provider),b=p.buckets[0];
  const agyBucket=activeAgyBucket(p);
  const chosenBucketId=storage.get('agentDeck.quota.agyBucket');
  const agyModel=activeAgyModel(p);
  const chosenId=storage.get('agentDeck.quota.agyModel');
  const abnormal=isAbnormalStatus(p);
  const signature=JSON.stringify([p,status(p),abnormal,agyBucket?.id,chosenBucketId,agyModel?.id,chosenId]);
  if(entry.signature===signature)return;
  const curCls=(entry.button.className||'').split(/\s+/).filter(c=>c&&c!=='is-abnormal');
  if(abnormal)curCls.push('is-abnormal');
  entry.button.className=curCls.join(' ');
  const baseName=p.provider==='codex'?'Codex':'Antigravity';
  const planTag=p.plan?shortPlanLabel(p.plan):'';
  if(p.provider==='agy'&&agyBucket){
   const confirmed=confirmedAgyBuckets(p);
   const visibleBuckets=confirmed.length<=2?confirmed:(confirmed.slice(0,2).some(x=>x.id===agyBucket.id)?confirmed.slice(0,2):[confirmed[0],agyBucket]);
   const head=node('div',undefined,'quota-key-head');
   head.append(node('strong',baseName));
   if(planTag)head.append(node('span',planTag,'quota-tag'));
   const metrics=node('div',undefined,'quota-metrics');
   const ariaParts=[];
   for(const bucket of visibleBuckets){
    const isSecondary=visibleBuckets.length>1&&bucket.id!==agyBucket.id;
    const pair=node('div',undefined,'quota-bucket-pair'+(isSecondary?' is-secondary':''));
    const prefix=compactGroupPrefix(bucket.label,visibleBuckets.length>1);
    for(const [lbl,w] of bucketWindows(bucket).slice(0,2)){
     const rowLbl=compactWindowLabel(prefix,lbl);
     pair.append(gauge(rowLbl,w,true));
     ariaParts.push(rowLbl+' 잔여 '+(pct(w?.remaining)===null?'—':pct(w?.remaining)+'%'));
    }
    metrics.append(pair);
   }
   const parts=[head,metrics];
   if(abnormal)parts.push(node('small',status(p),'quota-foot'+(p.error||stale(p)?' is-alert':'')));
   entry.button.replaceChildren(...parts);
   entry.button.setAttribute('aria-label',name(p)+' 쿼터 · '+ariaParts.join(' · ')+' · '+status(p)+' · 터치 상세');
  }else if(p.provider==='agy'){
   const m=agyModel;
   const cleanName=m?cleanModelName(m.label):'대표 모델';
   const summary=chosenId?cleanName:'모델 미선택 · 터치해 선택';
   const grouped=groupModels(p.models);
   const other=chosenId?grouped.find(x=>x.cleanName!==cleanName):null;
   const secondGauge=other?gauge(other.cleanName,other,true):gauge('기간',b?.weekly,true);
   const head=node('div',undefined,'quota-key-head');
   head.append(node('strong',baseName));
   if(planTag)head.append(node('span',planTag,'quota-tag'));
   const metrics=node('div',undefined,'quota-metrics');
   metrics.append(gauge(cleanName,m,true),secondGauge);
   const parts=[head,metrics,node('small',summary,'quota-foot')];
   if(abnormal)parts.push(node('small',status(p),'quota-foot'+(p.error||stale(p)?' is-alert':'')));
   entry.button.replaceChildren(...parts);
   entry.button.setAttribute('aria-label',name(p)+' 쿼터 · '+(m?cleanName+' 잔여 '+(m.remaining===null?'—':m.remaining+'%'):'모델 미선택')+' · '+summary+' · '+status(p)+' · 터치 상세');
  }else{
   const windows=bucketWindows(b).slice(0,2);
   const summary=(p.buckets.length>1?'공유 한도 1/'+p.buckets.length:'활성계정');
   const head=node('div',undefined,'quota-key-head');
   head.append(node('strong',baseName));
   if(planTag)head.append(node('span',planTag,'quota-tag'));
   const metrics=node('div',undefined,'quota-metrics');
   metrics.append(...windows.map(([lbl,w])=>gauge(lbl,w,true)));
   const parts=[head,metrics];
   if(p.buckets.length>1)parts.push(node('small',summary,'quota-foot'));
   if(abnormal)parts.push(node('small',status(p),'quota-foot'+(p.error||stale(p)?' is-alert':'')));
   entry.button.replaceChildren(...parts);
   entry.button.setAttribute('aria-label',name(p)+' 쿼터 · '+summary+' · '+status(p)+' · 터치 상세');
  }
  entry.signature=signature;
 }
 function key(provider,id){
  let entry=buttons.get(id);
  if(entry?.provider!==provider){
   const button=node('button',undefined,'key quota-key');button.type='button';button.dataset.keyId=id;
   entry={button,provider};buttons.set(id,entry);
   bindDeckInput(button,()=>{selected=provider;opener=id;detail();modal=true;dialog.showModal();},deckInputContext);
  }
  update(entry);return entry.button;
 }
 function render(){
  for(const entry of buttons.values())update(entry);
  if(dialog.open)detail();
 }
 async function refresh(force=false){
  if(preview||busy||document.hidden)return;busy=true;
  try{const response=await fetch(force===true?'/api/quotas?force=1':'/api/quotas');if(!response.ok)throw Error();providers=validate(await response.json());lastReceived=Date.now();phase='ready';}
  catch{phase='error';providers=providers.map(p=>({...p,error:'서버 조회 오류 · 다시 확인하세요',stale:true}));}
  finally{busy=false;render();}
 }
 document.getElementById('closeQuota').onclick=()=>dialog.close();
 dialog.addEventListener('close',()=>{modal=Boolean(document.querySelector?.('dialog:modal'));buttons.get(opener)?.button.focus({preventScroll:true});});
 document.getElementById('refreshQuota').onclick=()=>refresh(true);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh(false);});
 render();refresh(false);setInterval(()=>refresh(false),30000);setInterval(render,10000);
 return {key,refresh};
})();
if(typeof redrawDeck==='function')redrawDeck();
