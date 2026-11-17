// Single key per tap. The bridge still rechecks pane, session and request ticket.
async function ask(a,key,label){
 if(sending||modal||deckLocal||deckEditing)return;
 if(!/^[1-9]$/.test(key)&&!DECK_KEY_ACTIONS.includes(key))return;
 if(deckView==='reason'){toast('Reason 보기에서는 승인 키를 전송하지 않습니다.');return;}
 if(demo){toast('미리보기입니다. 실제 키는 전송하지 않습니다.');return;}
 if(!online||!a||!a.pane_id||typeof a.ticket!=='string'||!a.ticket||active()?.pane_id!==a.pane_id||active()?.ticket!==a.ticket||a.agent_status!=='blocked'||!a.text||a.error){toast('현재 응답할 수 있는 요청이 없습니다.');return;}
 const view=deckView;cancelDeckInput();sending=true;renderSignature='';if(view==='native'&&typeof renderNative==='function')renderNative();else if(current)render(current);
 try{
  if(view==='native'){
   await api('/api/native/respond',{id:a.id||a.pane_id,ticket:a.ticket,key});
  }else{
   await api('/api/respond',{pane:a.pane_id,ticket:a.ticket,key});
  }
  toast('['+label+'] 키 전송 완료');
 }catch(e){toast('전송 결과를 확인할 수 없습니다. 자동 재전송하지 않습니다. '+e.message);}
 finally{
  sending=false;renderSignature='';if(view==='native'&&typeof refreshNative==='function')await refreshNative();else await refresh();
 }
}
