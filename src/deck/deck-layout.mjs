// Shared schema for the embedded client and Node regression tests.
export const DECK_SLOT_COUNT = 15;
export const DECK_STORAGE_KEY = 'agentDeck.layouts.v2';
export const DECK_KEY_ACTIONS = ['enter','up','down','left','right','tab','esc'];
export const DECK_SYMBOLS = ['terminal','network','enter','up','down','left','right','tab','esc','refresh','context','app','shortcut','link','keyboard','volume-up','volume-down','volume-mute','media-play','media-next','media-prev','dark-mode','screenshot','lock','folder'];
export function validatePresentation(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['label','symbol','color','asset'].includes(k)))throw Error('잘못된 키 모양입니다.');
 if(value.label!==undefined&&(typeof value.label!=='string'||value.label.length>48||/[\x00-\x1f\x7f]/.test(value.label)))throw Error('키 이름은 최대 48자입니다.');
 if(value.symbol!==undefined&&!DECK_SYMBOLS.includes(value.symbol))throw Error('지원하지 않는 기호입니다.');
 if(value.color!==undefined&&(typeof value.color!=='string'||!/^#[a-fA-F0-9]{6}$/.test(value.color)))throw Error('색상을 확인하세요.');
 if(value.asset!==undefined&&(typeof value.asset!=='string'||!/^[a-f0-9]{64}$/.test(value.asset)))throw Error('이미지 ID를 확인하세요.');
 return JSON.parse(JSON.stringify(value));
}
export function defaultDeckLayouts(){
 return [
  {id:'agents',name:'에이전트',slots:Array.from({length:15},(_,index)=>({type:'auto-agent',index}))},
  {id:'response',name:'응답',slots:[...Array.from({length:9},(_,index)=>({type:'choice',key:String(index+1)})),...['enter','up','down','tab','esc'].map(key=>({type:'key',key})),{type:'page',page:'agents'}]},
  {id:'quota',name:'쿼터',slots:[{type:'quota',provider:'codex'},{type:'quota',provider:'agy'},...Array.from({length:11},()=>({type:'empty'})),{type:'page',page:'response'},{type:'page',page:'agents'}]},
 ];
}
export function normalizeDeckSlot(slot,index){
 if(!slot||typeof slot!=='object')return {type:'empty'};
 if(Object.hasOwn(slot,'presentation')){
  const {presentation,...base}=slot;
  return {...normalizeDeckSlot(base,index),presentation:validatePresentation(presentation)};
 }
 if(slot.type==='custom'&&typeof slot.actionId==='string'&&/^[-a-zA-Z0-9_]{1,64}$/.test(slot.actionId))return {type:'custom',actionId:slot.actionId};
 if(slot.type==='auto-agent')return {type:slot.type,index:Number.isInteger(slot.index)&&slot.index>=0&&slot.index<15?slot.index:index};
 if(slot.type==='agent'&&typeof slot.pane==='string'&&slot.pane.length<=160)return {type:slot.type,pane:slot.pane};
 if(slot.type==='choice'&&/^[1-9]$/.test(slot.key))return {type:slot.type,key:String(slot.key)};
 if(slot.type==='key'&&DECK_KEY_ACTIONS.includes(slot.key))return {type:slot.type,key:slot.key};
 if(slot.type==='quota'&&['codex','agy'].includes(slot.provider))return {type:slot.type,provider:slot.provider};
 if(slot.type==='page'&&typeof slot.page==='string'&&/^[-a-zA-Z0-9_]{1,64}$/.test(slot.page))return {type:slot.type,page:slot.page};
 if(slot.type==='sessions'&&Object.keys(slot).length===1)return {type:'sessions'};
 if(['empty','refresh','context'].includes(slot.type))return {type:slot.type};
 return {type:'empty'};
}

export function deckAgentForSlot(slot,agents,page){
 if(slot.type==='auto-agent')return agents[slot.index];
 if(slot.type==='agent')return agents.find(a=>a.pane_id===slot.pane);
}
export function deckPageCount(agents){return Math.max(1,Math.ceil(agents.length/12));}
export function deckSessionPage(agents,pageIndex=0){
 const pageCount=deckPageCount(agents);
 pageIndex=Math.max(0,Math.min(pageCount-1,Number.isFinite(pageIndex)?Math.trunc(pageIndex):0));
 const slots=Array.from({length:12},(_,index)=>{
  const agent=agents[pageIndex*12+index];
  return agent?{type:'agent',mode:'pinned',pane:agent.pane_id||agent.pane||agent.id,target:agent}:{type:'empty'};
 });
 slots.push({type:'return'},{type:'previous',disabled:pageIndex===0},{type:'next',disabled:pageIndex===pageCount-1});
 return {pageIndex,pageCount,slots};
}
export function deckGraphDiagnostics(layouts,selectedConnections=[]){
 const byId=new Map(layouts.map(page=>[page.id,page]));
 const forward=new Map(layouts.map(page=>[page.id,[]]));
 const reverse=new Map(layouts.map(page=>[page.id,[]]));
 for(const page of layouts)for(const slot of page.slots){
  if(slot.type==='page'&&byId.has(slot.page)){
   forward.get(page.id).push(slot.page);
   reverse.get(slot.page).push(page.id);
  }
 }
 const root=byId.has('agents')?'agents':layouts[0]?.id;
 const visit=edges=>{
  const seen=new Set(root===undefined?[]:[root]),queue=[...seen];
  for(let i=0;i<queue.length;i++)for(const id of edges.get(queue[i])||[]){
   if(!seen.has(id)){seen.add(id);queue.push(id);}
  }
  return seen;
 };
 const reachable=visit(forward),returnable=visit(reverse);
 const unreachable=layouts.filter(page=>!reachable.has(page.id)).map(page=>page.id);
 const noReturn=layouts.filter(page=>!returnable.has(page.id)).map(page=>page.id);
 const missingSessions=!layouts.some(page=>reachable.has(page.id)&&page.slots.some(slot=>slot.type==='sessions'));
 const deficits=layouts.map(page=>{
  const connections=[];
  for(const connection of selectedConnections){
   if(connection.from!==page.id||!(connection.type==='sessions'||connection.type==='page'&&byId.has(connection.page)))continue;
   const matches=slot=>slot.type===connection.type&&(connection.type!=='page'||slot.page===connection.page);
   if(page.slots.some(matches)||connections.some(matches))continue;
   connections.push(connection.type==='page'?{from:page.id,type:'page',page:connection.page}:{from:page.id,type:'sessions'});
  }
  const empty=page.slots.filter(slot=>slot.type==='empty').length,missing=connections.length;
  return {pageId:page.id,empty,missing,additionalEmpty:Math.max(0,missing-empty),connections};
 });
 return {ready:layouts.length>0&&!unreachable.length&&!noReturn.length&&!missingSessions,unreachable,noReturn,missingSessions,deficits};
}
// Canonical server writes must reject invalid data, never silently repair it.
export function validateDeckLayouts(raw){
 if(!Array.isArray(raw)||raw.length<1||raw.length>32)throw Error('페이지는 1~32개여야 합니다.');
 const seen=new Set();
 for(const page of raw){
  if(!page||typeof page!=='object'||Object.keys(page).sort().join(',')!=='id,name,slots'||typeof page.id!=='string'||!/^[-a-zA-Z0-9_]{1,64}$/.test(page.id)||seen.has(page.id))throw Error('페이지 ID가 잘못되거나 중복됩니다.');
  seen.add(page.id);
  if(typeof page.name!=='string'||!page.name.trim()||page.name.length>32||!Array.isArray(page.slots)||page.slots.length!==15)throw Error('페이지 이름 또는 15개 키 배치를 확인하세요.');
  for(let i=0;i<15;i++){
   const slot=page.slots[i],normalized=normalizeDeckSlot(slot,i);
   if(!slot||typeof slot!=='object'||Array.isArray(slot)||Object.keys(slot).length!==Object.keys(normalized).length||Object.keys(normalized).some(key=>key==='presentation'?JSON.stringify(slot[key])!==JSON.stringify(normalized[key]):slot[key]!==normalized[key]))throw Error('허용되지 않은 키 배치입니다.');
  }
 }
 for(const page of raw)for(const slot of page.slots)if(slot.type==='page'&&!seen.has(slot.page))throw Error('이동 대상 페이지가 없습니다.');
 return JSON.parse(JSON.stringify(raw));
}
