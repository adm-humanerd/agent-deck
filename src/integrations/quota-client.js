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
   if(!p.buckets.every(b=>item(b)&&window(b.fiveHour)&&window(b.weekly))||!p.models.every(m=>item(m)&&window(m)))throw Error();
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
 function gauge(label,window){
  const value=pct(window?.remaining),row=node('div',undefined,'quota-row');
  row.append(node('span',label+' 잔여 '+(value===null?'—':value+'%')));
  const track=node('div',undefined,'quota-track'+(value===null?' unknown':''));
  track.setAttribute('role','meter');track.setAttribute('aria-label',label+' 잔여율');
  track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');
  if(value!==null){track.setAttribute('aria-valuenow',String(value));const fill=node('i');fill.style.width=value+'%';fill.style.background=value<=5?'#f87171':value<=20?'#f6bf63':'#69d9a0';track.append(fill);}
  else track.setAttribute('aria-valuetext','알 수 없음');
  row.append(track);return row;
 }
 function stale(p){return p.stale||!p.checkedAt||Date.now()-Date.parse(p.checkedAt)>180000||Date.now()-lastReceived>180000;}
 function cleanModelName(label){
  return (label||'').replace(/\s*\((Low|Medium|High|XHigh)\)/gi,'').trim();
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
  content.append(node('p',planInfo+'활성계정 범위 · 다중계정 식별/전체 계정 조회 미지원','hint'));
  content.append(node('p','마지막 확인: '+(p.checkedAt?new Date(p.checkedAt).toLocaleString():'—')));
  content.append(node('p',status(p)));
  if(!p.buckets.length){content.append(gauge('5시간',null),gauge('주간',null),node('p','잔여율과 초기화 시각 미확인 · 다시 확인으로 재조회하세요','hint'));}
  for(const b of p.buckets||[]){
   content.append(node('h3',b.label));
   for(const [label,w] of [['5시간',b.fiveHour],['주간',b.weekly]]){content.append(gauge(label,w),node('p',resetText(w?.resetsAt),'hint'));}
  }
  if(p.provider==='agy'){
   const chosen=activeAgyModel(p);
   const grouped=groupModels(p.models);
   content.append(node('p','덱 키에 표시할 대표 모델을 선택하세요. 모델별 값은 실제 잔여율입니다.','hint'));
   for(const m of grouped){
    const header=node('div',undefined,'model-pick-header');
    header.append(node('h3',m.cleanName));
    const isSelected=chosen?.cleanName===m.cleanName;
    const btn=node('button',isSelected?'✓ 키에 표시 중':'키에 표시',isSelected?'model-pick-btn active':'model-pick-btn');
    btn.type='button';
    btn.onclick=()=>selectAgyModel(m);
    header.append(btn);
    content.append(header,gauge('모델',m),node('p',resetText(m.resetsAt),'hint'));
   }
  }
  content.scrollTop=scroll;
 }
 function update(entry){
  const p=providers.find(x=>x.provider===entry.provider),b=p.buckets[0];
  const agyModel=activeAgyModel(p);
  const signature=JSON.stringify([p,status(p),agyModel?.id]);
  if(entry.signature===signature)return;
  if(p.provider==='agy'){
   const chosenId=storage.get('agentDeck.quota.agyModel');
   const m=agyModel;
   const cleanName=m?cleanModelName(m.label):'대표 모델';
   const summary=chosenId?cleanName:'모델 미선택 · 터치해 선택';
   const secondGauge=p.models?.length>1&&chosenId?gauge('주간 (추정)',p.models.find(x=>x.id!==m?.id&&x.label.includes('Argon'))||p.models[1]):gauge('기간',b?.weekly);
   entry.button.replaceChildren(node('strong',name(p)),gauge(cleanName,m),secondGauge,node('small',summary),node('small',status(p)));
   entry.button.setAttribute('aria-label',name(p)+' 쿼터 · '+(m?cleanName+' 잔여 '+(m.remaining===null?'—':m.remaining+'%'):'모델 미선택')+' · '+summary+' · '+status(p)+' · 터치 상세');
  }else{
   const summary=(p.buckets.length>1?'공유 한도 1/'+p.buckets.length:'활성계정');
   entry.button.replaceChildren(node('strong',name(p)),gauge('5시간',b?.fiveHour),gauge('주간',b?.weekly),node('small',summary+' · 터치 상세'),node('small',status(p)));
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
 async function refresh(){
  if(preview||busy||document.hidden)return;busy=true;
  try{const response=await fetch('/api/quotas');if(!response.ok)throw Error();providers=validate(await response.json());lastReceived=Date.now();phase='ready';}
  catch{phase='error';providers=providers.map(p=>({...p,error:'서버 조회 오류 · 다시 확인하세요',stale:true}));}
  finally{busy=false;render();}
 }
 document.getElementById('closeQuota').onclick=()=>dialog.close();
 dialog.addEventListener('close',()=>{modal=false;buttons.get(opener)?.button.focus({preventScroll:true});});
 document.getElementById('refreshQuota').onclick=refresh;
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
 render();refresh();setInterval(refresh,30000);setInterval(render,10000);
 return {key,refresh};
})();
if(typeof redrawDeck==='function')redrawDeck();
