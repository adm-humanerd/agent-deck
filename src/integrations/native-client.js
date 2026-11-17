let nativeState=null,nativeBusy=false,nativeSignature='';
async function refreshNative(force=false){
 if(demo||nativeBusy||modal||sending)return;
 nativeBusy=true;
 try{
  nativeState=await api('/api/native/state');
  if(nativeState?.ok&&deckView==='native'){
   online=true;
   current={agents:nativeState.sessions,version:'native',updated:nativeState.updated};
   if(!current.agents.some(x=>x.pane_id===selectedPane)){
    selectedPane=current.agents[0]?.pane_id||null;
   }
  }else if(deckView==='native'){
   online=false;
  }
 }catch{
  nativeState={ok:false,sessions:[],error:'Herdr 앱에 연결할 수 없습니다.'};
  if(deckView==='native')online=false;
 }finally{
  nativeBusy=false;
  if(deckView==='native')renderNative();
 }
}
function renderNative(){
 if(deckView!=='native')return;
 syncSourceButtons();
 syncDeckLayoutToolbar();
 $('main').hidden=false;
 $('choicePager').hidden=true;
 $('keys').classList.remove('network-bank');
 const list=nativeState?.sessions||[],ok=nativeState?.ok===true,connected=ok&&online;
 current={agents:list,version:'native',updated:nativeState?.updated};
 if(connected)$('errorNotice').hidden=true;
 if(!list.some(x=>x.pane_id===selectedPane))selectedPane=list[0]?.pane_id||null;
 const a=list.find(x=>x.pane_id===selectedPane);

 $('bankTitle').textContent=deckProfile==='response'?'응답 패드 · Herdr 앱':'Herdr 앱 에이전트';
 $('status').textContent=connected?'Herdr 앱 · '+list.length+'개 터미널':nativeState?'Herdr 앱 연결 끊김 · 입력 잠금':'Herdr 앱 조회 중';
 $('connection').classList.toggle('offline',!connected);
 $('deviceStatus').textContent=!connected?'연결 끊김 · 입력 잠금':deckProfile==='response'?'응답 입력 · Herdr 앱':'네이티브 · 창 전환';
 $('footerState').textContent=nativeState?.updated?'Herdr 앱 · '+new Date(nativeState.updated).toLocaleTimeString('ko-KR')+' 조회'+(connected?'':' · 마지막 조회 데이터'):'Herdr 앱 창에 연결 중';
 document.title='Agent Deck · Herdr 앱';


 $('bankHint').textContent='Herdr 네이티브 앱 연결';
 $('bankNote').textContent='선택지 번호 또는 유틸리티 키를 누르면 Herdr 터미널에 즉시 전송됩니다.';

 currentDeckLayout();
 const signature=JSON.stringify([list,selectedPane,deckCursor(),bankMemory[deckView],ok,online,sending,deckProfile,deckEditing,editorLayouts()]);
 if(signature===nativeSignature)return;
 nativeSignature=signature;

 const available=ok&&a&&a.agent_status==='blocked'&&!!a.ticket&&!!a.text&&!a.error&&!sending&&(online||demo);
 renderDeckGrid(a,list,available);
 renderNativeInspector(a,connected);
}
function renderNativeInspector(a,ok){
 const side=$('inspector');
 const expanded=[...side.querySelectorAll('.request-disclosure[open]')].map(d=>[d.dataset.requestKey,d.className]);
 side.replaceChildren();
 const heading=el('div',undefined,'inspector-top');
 heading.append(el('i',undefined,'led'),el('span',ok?'Herdr 앱 · 실시간 연결':'Herdr 앱 · 연결 확인'));
 side.append(heading,el('h2',a?.label||'네이티브 터미널'),el('p',a?(a.app||'shell')+' · '+a.terminal:'herdr-core','agent-meta'));
 const request=el('section',undefined,'request');
 request.id='requestContent';
 request.tabIndex=-1;
 request.setAttribute('aria-label','네이티브 터미널 정보');
 if(nativeState?.error)request.append(el('p',nativeState.error,'network-warning'));
 if(a?.agent_status==='blocked'&&a.text){
  appendApprovalRequest(request,a,!ok);
 }else if(a){
  const fields=el('dl',undefined,'network-fields');
  for(const [label,value] of [['공간',a.space],['탭',a.tab],['컴퓨터',a.machine],['보고 상태',a.reported?a.agent_status:'미보고 · idle/done으로 추정하지 않음']]){
   const group=el('div');group.append(el('dt',label),el('dd',value));fields.append(group);
  }
  request.append(fields);
 }else{
  request.append(el('p',ok?'네이티브 앱에 열린 터미널이 없습니다.':'Herdr 앱을 열고 새로고침하세요.','hint'));
 }
 side.append(request);
 for(const d of side.querySelectorAll('.request-disclosure'))if(expanded.some(([key,cls])=>key===d.dataset.requestKey&&cls===d.className))d.open=true;
}
$('nativeView').onclick=()=>setDeckView('native');
setInterval(()=>{if(deckView==='native')refreshNative();},5000);
