import {createHash} from 'node:crypto';
export const allowedKeys = new Set(['1','2','3','4','5','6','7','8','9','enter','esc','up','down','left','right','tab']);
export function choices(text) {
  const lines = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '').split('\n');
  const menuRegex = /^\s*[❯›>→●○]?\s*([1-9])[.)]\s+(.{1,220})$/u;
  const found = [];
  const seen = new Set();
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(menuRegex);
    if (m) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        found.push({ key: m[1], label: m[2].trim() });
      }
      if (m[1] === '1') break;
    } else if (found.length > 0) {
      if (/^[-─=_]{3,}/.test(lines[i].trim()) || /(?:\?|？)\s*$/.test(lines[i].trim())) break;
    }
  }
  return found.sort((a, b) => +a.key - +b.key);
}
export function fingerprint(a,text) {
  return createHash('sha256').update(JSON.stringify([a.pane_id,a.agent_session,a.agent_status,a.revision,a.state_change_seq,text])).digest('hex');
}
export function createBridge(run,raiseTerminal=async()=>{}) {
 let cached=null, busy=false,focusBusy=false;
 async function snapshot(){
   const raw=JSON.parse(await run(['api','snapshot']));
   const s=raw.result?.snapshot;
   if(!s?.agents) throw new Error('herdr snapshot 형식을 확인할 수 없습니다.');
   return s;
 }
 async function read(a){return await run(['agent','read',a.pane_id,'--source','detection','--lines','65']);}
 async function refresh(){
   const s=await snapshot();
   const agents=await Promise.all(s.agents.map(async a=>{
     let text='',error='';
     if(a.agent_status==='blocked') try{text=await read(a);}catch(e){error=e.message;}
     return {...a,label:s.tabs.find(t=>t.tab_id===a.tab_id)?.label||a.agent,text,error,choices:a.agent_status==='blocked'?choices(text):[],ticket:fingerprint(a,text)};
   }));
   cached={agents,version:s.version,updated:new Date().toISOString()};
   return cached;
 }
 async function focus({pane}){
   if(typeof pane!=='string'||pane.length>128)throw new Error('올바른 에이전트를 선택하세요.');
   if(focusBusy)throw new Error('다른 PC 화면 전환을 처리 중입니다. 다시 누르세요.');
   focusBusy=true;
   try{
     const s=await snapshot(),a=s.agents.find(a=>a.pane_id===pane);
     if(!a)throw new Error('해당 에이전트가 더 이상 연결되어 있지 않습니다.');
     await run(['agent','focus',a.pane_id]);
     await raiseTerminal();
     return {ok:true,pane:a.pane_id,message:'PC 작업 창 전환 완료'};
   }finally{focusBusy=false;}
 }
 async function respond({pane,ticket,key}){
   if(!allowedKeys.has(key)) throw new Error('허용되지 않은 키입니다.');
   if(busy) throw new Error('다른 응답을 전송 중입니다.');
   busy=true;
   try {
     const prev=cached?.agents.find(a=>a.pane_id===pane);
     if(!prev||prev.ticket!==ticket) throw new Error('오래된 요청입니다. 새로고침 후 다시 확인하세요.');
     const s=await snapshot(),a=s.agents.find(a=>a.pane_id===pane);
     if(!a||a.agent_status!=='blocked') throw new Error('현재 승인/질문 대기 상태가 아닙니다. 입력하지 않았습니다.');
     const text=await read(a);
     if(fingerprint(a,text)!==ticket) throw new Error('요청 내용 또는 에이전트 세션이 바뀌었습니다. 입력하지 않았습니다.');
     cached=null; // prevent double submission from the same screen
     const result=await run(['agent','send-keys',pane,key]);
     return {ok:true,message:'키 전송 완료. 실제 처리 상태는 다음 화면에서 확인하세요.',result};
   }finally{busy=false;}
 }
 return {refresh,respond,focus};
}
