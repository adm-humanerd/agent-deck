let pendingPCFocus=null,pcFocusRunning=false,pcFocusSequence=0;
async function focusPCForAgent(a){
 if(demo||!online||deckLocal||deckEditing||sending||deckView==='reason')return;
 pendingPCFocus={pane:a.pane_id,sequence:++pcFocusSequence,label:a.label,view:deckView};
 if(pcFocusRunning)return;
 pcFocusRunning=true;
 try{while(pendingPCFocus){const target=pendingPCFocus;pendingPCFocus=null;if(target.view!==deckView||deckLocal||!online)continue;
 try{
  if(target.view==='native'){
   await api('/api/native/focus',{id:target.pane});
  }else{
   await api('/api/focus',{pane:target.pane});
  }
  if(target.sequence===pcFocusSequence&&selectedPane===target.pane)toast(target.label+' · PC 작업 창으로 전환했습니다.');
 }
 catch(e){if(target.sequence===pcFocusSequence&&selectedPane===target.pane)toast('PC 화면 전환 실패: '+e.message);}
 }}finally{pcFocusRunning=false;}
}
function choose(pane){if(deckEditing||sending)return;const a=current?.agents.find(x=>x.pane_id===pane);if(!a)return;cancelDeckInput();selectedPane=pane;if(editorLayouts().some(p=>p.id==='response')){deckProfile='response';deckCursor().kind='authored';deckCursor().pageId='response';}deckEditing=false;redrawDeck();void focusPCForAgent(a);}
