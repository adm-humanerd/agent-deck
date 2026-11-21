let deckLayouts=defaultDeckLayouts(),layoutRevision=null,layoutInitialized=false,layoutSaving=false,layoutLoading=false,layoutMessageGeneration=0,deckLocal=false;
let deckProfile='agents',deckEditing=false,userExitedEditMode=false,editingSlot=null;
let deckCandidate=null,deckGeneration=0,selectedConnections=[];
let deckActions=[],deckAssets=[],customPress=0,customPolling=false,customEditorGeneration=0;
let copiedSlotClipboard=null,hotkeyRecording=false,pageEditorMode='add',editorBaselineSignature='',deckDragState=null;
let catalogDragState=null,autoSaveTimer=null,macIconInFlight=false,catalogLoadedOnce=false,catalogClickDragged=false;
const undoStack=[],redoStack=[],HIGH_RISK_CUSTOM_KINDS=new Set(['hostProcess','sessionText','keyCombo']);
const customRunStates=new Map();
const runtimeCursor={kind:'authored',pageId:'agents'},previewCursor={kind:'authored',pageId:'agents'};
const bankMemory={native:0,herdr:0,reason:0};
function deckCursor(){return deckLocal?previewCursor:runtimeCursor;}
function editorLayouts(){return deckLocal&&deckCandidate?deckCandidate.layouts:deckLayouts;}
function deckRoot(){return editorLayouts().find(p=>p.id==='agents')?.id||editorLayouts()[0].id;}
function deckSourceSessions(){return deckView==='reason'?(networkState?.sessions||[]):deckView==='native'?(nativeState?.sessions||[]):(current?.agents||[]);}
function currentDeckLayout(){
 const cursor=deckCursor(),layouts=editorLayouts();
 if(!layouts.some(p=>p.id===cursor.pageId)){cancelDeckInput();cursor.kind='authored';cursor.pageId=deckRoot();deckProfile=cursor.pageId;layoutMessage('현재 페이지가 삭제되어 시작 페이지로 돌아왔습니다. 배치는 변경하지 않았습니다.');}
 if(cursor.kind==='sessions'&&!deckEditing){const page=deckSessionPage(deckSourceSessions(),bankMemory[deckView]);bankMemory[deckView]=page.pageIndex;return {id:'session-bank',name:'전체 세션 '+(page.pageIndex+1)+' / '+page.pageCount,slots:page.slots};}
 return layouts.find(x=>x.id===deckProfile)||layouts[0];
}
function enterSessionBank(){cancelDeckInput();deckGeneration++;const cursor=deckCursor();cursor.kind='sessions';cursor.source=deckView;cursor.pageId=deckProfile;redrawDeck();}
function leaveSessionBank(){const id=deckCursor().pageId;setDeckProfile(editorLayouts().some(p=>p.id===id)?id:deckRoot());}
function stepSessionBank(delta){cancelDeckInput();deckGeneration++;const page=deckSessionPage(deckSourceSessions(),bankMemory[deckView]);bankMemory[deckView]=Math.max(0,Math.min(page.pageCount-1,page.pageIndex+delta));redrawDeck();}
function deckInputContext(){
 if(sending||(!deckLocal&&modal)||document.hidden)return null;
 return JSON.stringify([deckGeneration,layoutRevision,deckView,deckCursor(),deckProfile,deckEditing,online,selectedPane,networkSelected,deckSourceSessions(),editorLayouts()]);
}
function beginDeckCandidate(navigation=false){if(!deckCandidate)deckCandidate={baseRevision:layoutRevision,layouts:structuredClone(deckLayouts),actions:structuredClone(deckActions),assets:[...deckAssets],navigation,error:''};else if(navigation)deckCandidate.navigation=true;return deckCandidate;}
function pruneCandidateReferences(candidate){
 const usedActions=new Set(),usedAssets=new Set();
 for(const page of candidate.layouts)for(const slot of page.slots){
  if(slot.type==='custom'&&slot.actionId)usedActions.add(slot.actionId);
  if(slot.presentation?.asset)usedAssets.add(slot.presentation.asset);
 }
 candidate.actions=candidate.actions.filter(action=>usedActions.has(action.id));
 candidate.assets=candidate.assets.filter(id=>usedAssets.has(id));
}
function renderDeckGrid(a,agents,available){
 cancelDeckInput();const layout=currentDeckLayout();$('keys').replaceChildren();
 for(let row=0;row<3;row++){const group=el('div',undefined,'key-row');group.setAttribute('role','group');group.setAttribute('aria-label',layout.name+' 키 '+(row*5+1)+'–'+(row*5+5));for(let col=0;col<5;col++){const index=row*5+col;group.append(renderDeckKey(layout.slots[index],index,a,agents,available));}$('keys').append(group);}
 $('sessionPager').hidden=true;$('choicePager').hidden=true;$('sessionPageLabel').textContent=layout.name;
}
function layoutMessage(text){layoutMessageGeneration++;if(deckCandidate?.error&&text!==deckCandidate.error&&!text.startsWith('서버에 저장 중'))text=deckCandidate.error+' · '+text;const rejected=text.includes('실패')||text.includes('차단');$('layoutStatus').textContent=text;$('layoutStatus').dataset.state=rejected?'error':'ready';for(const error of document.querySelectorAll('.layout-error'))error.textContent=rejected?text:'';if(!deckLocal&&rejected)toast(text);}
function legacyDeckLayout(){try{return localStorage.getItem(DECK_STORAGE_KEY);}catch{return null;}}
function canEditDeck(importing=false){
 if(!deckLocal||layoutRevision===null||layoutSaving)return false;
 if(!importing&&!layoutInitialized&&legacyDeckLayout()){layoutMessage('기존 브라우저 배치가 있습니다. 먼저 가져오거나 서버 기본 배치 사용을 명시적으로 선택하세요.');return false;}
 return true;
}
function syncDefaultEditMode(){
 if(!deckLocal){deckEditing=false;return;}
 if(userExitedEditMode)return;
 if(layoutRevision!==null&&(layoutInitialized||!legacyDeckLayout()))deckEditing=true;
}
function captureCommittedSnapshot(reason='배치 변경'){
 return {layouts:structuredClone(deckLayouts),actions:structuredClone(deckActions),assets:[...deckAssets],profile:deckProfile,reason};
}
function syncHistoryButtons(){
 if($('undoDeckBtn'))$('undoDeckBtn').disabled=layoutSaving||undoStack.length===0||Boolean(deckCandidate?.navigation);
 if($('redoDeckBtn'))$('redoDeckBtn').disabled=layoutSaving||redoStack.length===0||Boolean(deckCandidate?.navigation);
}
function applySharedLayout(data){
 if(!Number.isSafeInteger(data.revision)||data.revision<0||typeof data.initialized!=='boolean')throw Error('서버 배치 응답이 올바르지 않습니다.');
 if(data.revision!==layoutRevision){cancelDeckInput();deckGeneration++;}
 deckLayouts=validateDeckLayouts(data.layouts);layoutRevision=data.revision;layoutInitialized=data.initialized;
 deckActions=data.actions||[];deckAssets=data.assets||[];
 syncDefaultEditMode();
 if(!editorLayouts().some(x=>x.id===deckProfile)){deckProfile=deckRoot();deckCursor().pageId=deckProfile;deckCursor().kind='authored';if(!deckLocal)deckEditing=false;closeKeyEditor();toast('현재 페이지가 삭제되어 시작 페이지로 돌아왔습니다. 배치는 자동 수정하지 않았습니다.');}
 redrawDeck();syncDeckLayoutToolbar();
}
async function loadSharedLayouts(manual=false){
 if(demo||layoutLoading||layoutSaving)return;
 layoutLoading=true;
 const messageAtStart=layoutMessageGeneration,previousRevision=layoutRevision;
 try{const data=await api('/api/custom-layout');if(!layoutSaving&&(layoutRevision===null||data.revision>=layoutRevision)&&(manual||data.revision!==layoutRevision)){applySharedLayout(data);if(!deckCandidate?.error&&(data.revision!==previousRevision||layoutMessageGeneration===messageAtStart))layoutMessage('서버 배치 r'+data.revision+(data.initialized?'':' · 아직 저장되지 않음')+(deckCandidate?' · 편집 초안 기준 r'+deckCandidate.baseRevision:''));}}
 catch(error){layoutMessage('배치 조회 실패: '+error.message);}
 finally{layoutLoading=false;}
}
async function persistDeckLayouts(next,importing=false,candidate=null,opts={}){
 if(!canEditDeck(importing))return false;
 if(candidate?.navigation){const diagnostics=deckGraphDiagnostics(next,selectedConnections);if(!diagnostics.ready||diagnostics.deficits.some(p=>p.missing)){layoutMessage('저장 차단: 선택 연결 및 모든 페이지 진입·복귀와 전체 세션 진입 키를 직접 준비하세요.');return false;}}
 const historyMode=opts.historyMode||(importing?'skip':'record');
 const prevSnap=historyMode==='record'&&layoutInitialized?captureCommittedSnapshot(opts.reason||'배치 변경'):null;
 layoutSaving=true;syncHistoryButtons();
 layoutMessage(opts.silentStatus?'자동 반영 중…':'서버에 저장 중…');$('saveAssignment').disabled=true;
 try{
  validateDeckLayouts(next);
  const payload={schemaVersion:1,revision:candidate?candidate.baseRevision:layoutRevision,layouts:next,actions:candidate?[...candidate.actions]:[...deckActions],assets:candidate?[...candidate.assets]:[...deckAssets]};
  pruneCandidateReferences(payload);
  const response=await fetch('/api/custom-layout',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const data=await response.json();if(!response.ok)throw Error(response.status===409?'다른 PC에서 배치가 변경되었습니다. 서버 다시 읽기 후 다시 편집하세요.':data.error||'저장 실패');
  if(candidate===deckCandidate)deckCandidate=null;
  if(prevSnap){undoStack.push(prevSnap);if(undoStack.length>30)undoStack.shift();redoStack.length=0;}
  applySharedLayout(data);
  layoutMessage(opts.statusText||('서버에 저장했습니다 · r'+data.revision));
  return true;
 }catch(error){if(candidate)candidate.error='저장 실패: '+error.message;layoutMessage(candidate?.error||'저장 실패: '+error.message);return false;}
 finally{layoutSaving=false;$('saveAssignment').disabled=false;if(deckLocal){syncDeckLayoutToolbar();syncHistoryButtons();}}
}
function setDeckAccess(info){
 cancelDeckInput();deckLocal=info.local===true;document.body.classList.toggle('local',deckLocal);document.body.classList.toggle('remote',!deckLocal);
 if(deckLocal)mountLocalEditor();
 $('deckLayoutToolbar').hidden=!deckLocal;$('connectBtn').hidden=!deckLocal;
 if(!deckLocal){deckEditing=false;hotkeyRecording=false;for(const id of ['keyEditor','pageEditor','resetDialog','connectDialog'])if($(id).open)$(id).close();editingSlot=null;}
 else syncDefaultEditMode();
 syncDeckLayoutToolbar();
}
const layoutStatus=el('span');layoutStatus.id='layoutStatus';layoutStatus.setAttribute('role','status');
const importLayout=el('button','이 브라우저 배치 가져오기');importLayout.className='deck-tool';importLayout.id='importLayout';
const initializeLayout=el('button','서버 기본 배치 사용');initializeLayout.className='deck-tool';initializeLayout.id='initializeLayout';
const reloadLayout=el('button','서버 다시 읽기');reloadLayout.className='deck-tool';reloadLayout.id='reloadLayout';reloadLayout.onclick=()=>{if(!deckLocal||layoutSaving)return;cancelAutoSave();cancelDeckInput();deckCandidate=null;userExitedEditMode=false;syncDefaultEditMode();closeKeyEditor();loadSharedLayouts(true);};
$('deckLayoutToolbar').append(importLayout,initializeLayout,reloadLayout,layoutStatus);
const draftCallout=el('p');draftCallout.id='draftCallout';draftCallout.className='draft-callout';draftCallout.setAttribute('role','status');draftCallout.hidden=true;
const saveCandidate=el('button','배치 초안 저장');saveCandidate.id='saveCandidate';saveCandidate.className='deck-tool';
saveCandidate.onclick=async()=>{if(!canEditDeck()||!deckCandidate)return;await persistDeckLayouts(deckCandidate.layouts,false,deckCandidate,{reason:'탐색 초안 저장'});};
const graphStatus=el('p');graphStatus.id='graphStatus';graphStatus.setAttribute('role','status');
const connectionPlan=el('select');connectionPlan.id='connectionPlan';connectionPlan.multiple=true;connectionPlan.setAttribute('aria-label','현재 페이지에 직접 준비할 연결');
connectionPlan.onchange=()=>{selectedConnections=selectedConnections.filter(c=>c.from!==deckProfile).concat([...connectionPlan.selectedOptions].map(o=>({from:deckProfile,...JSON.parse(o.value)})));syncDeckLayoutToolbar();};
const connectionLabel=el('label','이동 키 연결 점검 (복수 선택)');connectionLabel.htmlFor='connectionPlan';
$('deckLayoutToolbar').append(draftCallout,saveCandidate,connectionLabel,connectionPlan,graphStatus);
const renameDeckPage=el('button','이름 변경','deck-tool');renameDeckPage.id='renameDeckPage';renameDeckPage.type='button';
const movePageUp=el('button','위로','deck-tool');movePageUp.id='movePageUp';movePageUp.type='button';movePageUp.setAttribute('aria-label','현재 페이지 위로 이동');
const movePageDown=el('button','아래로','deck-tool');movePageDown.id='movePageDown';movePageDown.type='button';movePageDown.setAttribute('aria-label','현재 페이지 아래로 이동');
let navDetailsUserOpen=false,suppressingNavToggle=false;
function cancelAutoSave(){if(autoSaveTimer){clearTimeout(autoSaveTimer);autoSaveTimer=null;}}
function canAutoSaveCurrentSlot(){
 if(!deckLocal||!canEditDeck()||editingSlot===null)return false;
 if(deckCandidate?.navigation||deckCandidate?.error)return false;
 if($('customImage')?.disabled||macIconInFlight)return false;
 const kind=$('customKind')?.value||'builtin';
 if(HIGH_RISK_CUSTOM_KINDS.has(kind))return false;
 try{
  const base=normalizeDeckSlot(JSON.parse($('keyAssignment').value||'{"type":"empty"}'),editingSlot);
  if(kind==='builtin'&&['sessions','page'].includes(base.type)){
   const committed=deckLayouts.find(p=>p.id===deckProfile)?.slots[editingSlot];
   if(!committed||committed.type!==base.type||committed.page!==base.page)return false;
  }
 }catch{return false;}
 return true;
}
function isEditorDirty(){
 return editingSlot!==null&&editorBaselineSignature!==''&&captureEditorStateSignature()!==editorBaselineSignature;
}
function updateEditorHintCopy(){
 const hint=$('keyEditor')?.querySelector('.hint');
 if(!hint)return;
 hint.textContent=canAutoSaveCurrentSlot()?'변경하면 즉시 자동 반영됩니다. (실행 취소 ⌘Z · 닫기 Esc)':'이 키에만 적용됩니다. 저장 버튼을 눌러 반영하세요. (⌘Enter 저장 · Esc 닫기)';
}
async function commitAutoSave(slotIndex=editingSlot){
 cancelAutoSave();
 if(slotIndex===null||slotIndex!==editingSlot||!canAutoSaveCurrentSlot()||!isEditorDirty())return false;
 try{
  const sigBefore=captureEditorStateSignature();
  const candidate=beginDeckCandidate();
  const base=normalizeDeckSlot(JSON.parse($('keyAssignment').value||'{"type":"empty"}'),slotIndex);
  const action=readCustomInspector(base,candidate);
  const old=currentDeckLayout().slots[slotIndex];
  if(['sessions','page'].includes(action.type)&&(old.type!==action.type||old.page!==action.page))return false;
  candidate.layouts.find(page=>page.id===deckProfile).slots[slotIndex]=action;
  const saved=await persistDeckLayouts(candidate.layouts,false,candidate,{silentStatus:true,statusText:'자동 반영됨 · r',reason:'키 '+String(slotIndex+1).padStart(2,'0')+' 수정'});
  if(!saved)return false;
  layoutMessage('자동 반영됨 · r'+layoutRevision);
  if(editingSlot===slotIndex){
   editorBaselineSignature=sigBefore;
   const liveSlot=deckLayouts.find(p=>p.id===deckProfile)?.slots[slotIndex];
   if($('removeCustomAction'))$('removeCustomAction').hidden=!liveSlot||liveSlot.type!=='custom';
   updateKeyPreview();
   if(isEditorDirty())scheduleAutoSave(420);
  }
  return true;
 }catch{return false;}
}
function scheduleAutoSave(delay=220){
 cancelAutoSave();
 if(!canAutoSaveCurrentSlot()||!isEditorDirty())return;
 autoSaveTimer=setTimeout(()=>{void commitAutoSave(editingSlot);},delay);
}
async function flushAutoSave(){
 if(autoSaveTimer||isEditorDirty()){
  cancelAutoSave();
  if(canAutoSaveCurrentSlot()&&isEditorDirty())await commitAutoSave(editingSlot);
 }
}
async function undoDeckChange(){
 cancelAutoSave();
 if(!canEditDeck()||layoutSaving||deckCandidate?.navigation||!undoStack.length)return false;
 const entry=undoStack.pop(),currentSnap=captureCommittedSnapshot(entry.reason);
 const ok=await persistDeckLayouts(structuredClone(entry.layouts),false,{baseRevision:layoutRevision,layouts:structuredClone(entry.layouts),actions:structuredClone(entry.actions),assets:[...entry.assets],navigation:false,error:''},{historyMode:'undo',statusText:'실행 취소됨 ('+entry.reason+')'});
 if(!ok){undoStack.push(entry);syncHistoryButtons();return false;}
 redoStack.push(currentSnap);
 if(entry.profile&&deckLayouts.some(p=>p.id===entry.profile)){deckProfile=entry.profile;deckCursor().pageId=entry.profile;redrawDeck();syncDeckLayoutToolbar();}
 if(editingSlot!==null)openKeyEditor(editingSlot);
 syncHistoryButtons();
 return true;
}
async function redoDeckChange(){
 cancelAutoSave();
 if(!canEditDeck()||layoutSaving||deckCandidate?.navigation||!redoStack.length)return false;
 const entry=redoStack.pop(),currentSnap=captureCommittedSnapshot(entry.reason);
 const ok=await persistDeckLayouts(structuredClone(entry.layouts),false,{baseRevision:layoutRevision,layouts:structuredClone(entry.layouts),actions:structuredClone(entry.actions),assets:[...entry.assets],navigation:false,error:''},{historyMode:'redo',statusText:'다시 실행됨 ('+entry.reason+')'});
 if(!ok){redoStack.push(entry);syncHistoryButtons();return false;}
 undoStack.push(currentSnap);
 if(entry.profile&&deckLayouts.some(p=>p.id===entry.profile)){deckProfile=entry.profile;deckCursor().pageId=entry.profile;redrawDeck();syncDeckLayoutToolbar();}
 if(editingSlot!==null)openKeyEditor(editingSlot);
 syncHistoryButtons();
 return true;
}
function syncEditorEmpty(){
 const empty=$('editorEmpty'),catalog=$('actionCatalog'),needsImport=Boolean(deckLocal&&!layoutInitialized&&legacyDeckLayout());
 if(empty)empty.hidden=editingSlot!==null||!needsImport;
 if(catalog){
  catalog.hidden=editingSlot!==null||needsImport;
  if(!catalog.hidden){
   if(!catalogLoadedOnce){catalogLoadedOnce=true;void ensureMacCatalog(false);}
   renderActionCatalog();
  }
 }
 if($('catalogPreviewNote'))$('catalogPreviewNote').hidden=deckEditing;
 if(empty&&$('editorEmptyTitle')){
  $('editorEmptyTitle').textContent='기존 배치 가져오기 필요';
  $('editorEmptyDesc').textContent='이 브라우저에 기존 배치가 있습니다. 왼쪽 저장 · 동기화에서 ‘이 브라우저 배치 가져오기’ 또는 ‘서버 기본 배치 사용’을 선택하면 바로 편집 캔버스가 열립니다.';
  if($('startDeckEditing'))$('startDeckEditing').hidden=true;
  if($('editorGuideList'))$('editorGuideList').hidden=false;
 }
}
function syncActionModeTabs(){
 if(!$('actionModeTabs'))return;
 const kind=$('customKind')?.value||'builtin';
 const mode=kind==='builtin'?'builtin':['macApp','macShortcut','macSystem','macHotkey'].includes(kind)?'mac':'automation';
 for(const [id,key]of [['modeTabBuiltin','builtin'],['modeTabMac','mac'],['modeTabAutomation','automation']]){
  const btn=$(id);if(!btn)continue;
  const active=mode===key;
  btn.setAttribute('aria-pressed',String(active));
  btn.classList.toggle('is-active',active);
 }
 if($('builtinAssignmentGroup'))$('builtinAssignmentGroup').hidden=kind!=='builtin';
 if($('customActionGroup'))$('customActionGroup').hidden=kind==='builtin';
}
function clearCatalogDragState(){
 for(const k of $('keys').querySelectorAll('.drag-over'))k.classList.remove('drag-over');
 catalogDragState=null;
}
function findKeyButtonAtPoint(x,y){
 const keys=[...$('keys').querySelectorAll('button[data-key-id]')];
 return document.elementFromPoint(x,y)?.closest?.('#keys button[data-key-id]')||keys.find(k=>{const r=k.getBoundingClientRect();return x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom;});
}
function buildActionCatalogGroups(){
 const layouts=editorLayouts();
 const groups=[];
 groups.push(['에이전트 · 탐색',[
  {id:'auto-agent',title:'에이전트 슬롯',detail:'자동 배치 (다음 빈 순서)',symbol:'terminal',kind:'builtin',slot:slotIdx=>({type:'auto-agent',index:slotIdx})},
  {id:'sessions',title:'전체 세션 뱅크',detail:'12개씩 모든 세션 보기',symbol:'network',kind:'builtin',slot:{type:'sessions'}},
  ...layouts.filter(p=>p.id!==deckProfile).map(p=>({id:'page:'+p.id,title:p.name+' 이동',detail:'페이지 전환 키',symbol:p.id==='agents'?'network':'enter',kind:'builtin',slot:{type:'page',page:p.id}})),
  ...[1,2,3,4].map(n=>({id:'choice:'+n,title:'선택지 '+n,detail:'승인 응답 '+n+'번',symbol:'enter',number:String(n),kind:'builtin',slot:{type:'choice',key:String(n)}})),
  {id:'key:enter',title:'Enter 승인',detail:'유틸리티 키',symbol:'enter',kind:'builtin',slot:{type:'key',key:'enter'}},
  {id:'key:esc',title:'Esc 취소',detail:'유틸리티 키',symbol:'esc',kind:'builtin',slot:{type:'key',key:'esc'}},
  {id:'key:tab',title:'Tab 전환',detail:'유틸리티 키',symbol:'tab',kind:'builtin',slot:{type:'key',key:'tab'}},
  {id:'context',title:'요청 원문 보기',detail:'승인 상세 창 열기',symbol:'context',kind:'builtin',slot:{type:'context'}},
  {id:'refresh',title:'상태 새로고침',detail:'세션 즉시 갱신',symbol:'refresh',kind:'builtin',slot:{type:'refresh'}}
 ]]);
 groups.push(['AI 한도 (쿼터)',[
  {id:'quota:agy',title:'Antigravity 쿼터',detail:'실시간 한도 게이지',symbol:'quota',kind:'builtin',slot:{type:'quota',provider:'agy'}},
  {id:'quota:codex',title:'Codex 쿼터',detail:'실시간 한도 게이지',symbol:'quota',kind:'builtin',slot:{type:'quota',provider:'codex'}}
 ]]);
 groups.push(['macOS 시스템 · 미디어',MAC_SYSTEM_ITEMS.map(item=>({
  id:'macSystem:'+item.action,title:item.name,detail:item.detail,symbol:item.symbol||'app',kind:'custom',customKind:'macSystem',action:item.action
 }))]);
 groups.push(['단축키 · 앱/웹 열기',[
  {id:'macHotkey:record',title:'단축키 직접 녹화',detail:'키 조합 입력 (⌘⇧K 등)',symbol:'keyboard',kind:'custom',customKind:'macHotkey',record:true},
  ...MAC_HOTKEY_PRESET_ITEMS.slice(0,6).map(p=>({id:'hotkey:'+p.key+':'+p.modifiers.join('+'),title:p.label,detail:'전역 단축키',symbol:'keyboard',kind:'custom',customKind:'macHotkey',hotkey:p})),
  ...MAC_APP_URL_PRESET_ITEMS.slice(0,5).map(p=>({id:'appUrl:'+p.url,title:p.label,detail:p.url,symbol:'link',kind:'custom',customKind:'appUrl',url:p.url})),
  {id:'hostUrl:blank',title:'웹 주소(URL) 열기',detail:'http / https 열기',symbol:'link',kind:'custom',customKind:'hostUrl',url:''}
 ]]);
 const apps=(macCatalogState?.apps||[]).map(item=>({id:'macApp:'+item.app,title:item.name,detail:item.app,symbol:'app',kind:'custom',customKind:'macApp',appPath:item.app}));
 groups.push(['설치된 macOS 앱',apps]);
 groups.push(['고급 자동화',[
  {id:'macShortcut:blank',title:'macOS 단축어 실행',detail:'Apple Shortcuts 호출',symbol:'shortcut',kind:'custom',customKind:'macShortcut'},
  {id:'hostProcess:blank',title:'셸 스크립트 실행',detail:'bash · zsh 명령 (권한 확인)',symbol:'terminal',kind:'custom',customKind:'hostProcess'},
  {id:'sessionText:blank',title:'유휴 세션 텍스트 전송',detail:'검증된 tmux 셸에 전송',symbol:'terminal',kind:'custom',customKind:'sessionText'},
  {id:'keyCombo:blank',title:'검증된 수신기에 단축키',detail:'Ctrl-U / Enter 등 정밀 제어',symbol:'keyboard',kind:'custom',customKind:'keyCombo'}
 ]]);
 return groups;
}
function renderActionCatalog(){
 const box=$('catalogGroups');if(!box)return;
 const q=($('catalogSearch')?.value||'').trim().toLowerCase();
 const apps=macCatalogState?.apps||[];
 const sig=JSON.stringify([q,deckProfile,editorLayouts().map(p=>[p.id,p.name]),apps.length,macCatalogLoading]);
 if(box.dataset.signature===sig)return;
 box.dataset.signature=sig;
 box.replaceChildren();
 const groups=buildActionCatalogGroups();
 let totalShown=0;
 for(const [groupName,items]of groups){
  const isApps=groupName==='설치된 macOS 앱';
  const filtered=q?items.filter(it=>it.title.toLowerCase().includes(q)||it.detail.toLowerCase().includes(q)||groupName.toLowerCase().includes(q)):(isApps?items.slice(0,12):items);
  if(!filtered.length&&!isApps)continue;
  const details=el('details',undefined,'catalog-group');details.open=Boolean(q)||['에이전트 · 탐색','AI 한도 (쿼터)','macOS 시스템 · 미디어','단축키 · 앱/웹 열기'].includes(groupName);
  const summary=el('summary',undefined,'catalog-group-summary');
  summary.append(el('span',groupName),el('span',String(isApps&&!q?items.length:filtered.length),'catalog-group-count'));
  details.append(summary);
  if(isApps&&!filtered.length){
   details.append(el('p',macCatalogLoading?'설치된 macOS 앱 목록 불러오는 중…':'검색된 macOS 앱이 없습니다.','catalog-empty-note'));
  }else{
   const list=el('div',undefined,'catalog-item-list');
   for(const item of filtered){
    totalShown++;
    const btn=el('button',undefined,'catalog-item');btn.type='button';btn.draggable=true;
    btn.dataset.catalogId=item.id;
    const iconBox=el('span',undefined,'catalog-item-icon');
    if(item.number)iconBox.append(el('span',item.number,'catalog-item-num'));
    else iconBox.append(icon(item.symbol||'app'));
    const textWrap=el('span',undefined,'catalog-item-text');
    textWrap.append(el('strong',item.title),el('span',item.detail));
    const plusMark=el('span','+','catalog-item-add');plusMark.setAttribute('aria-hidden','true');
    btn.append(iconBox,textWrap,plusMark);
    const serialized={...item,slot:typeof item.slot==='function'?'__auto_agent__':item.slot};
    btn.addEventListener('dragstart',e=>{
     if(!e.dataTransfer)return;
     e.dataTransfer.effectAllowed='copy';
     e.dataTransfer.setData('application/x-agent-deck-catalog',JSON.stringify(serialized));
    });
    btn.addEventListener('pointerdown',e=>{
     if(!deckLocal||!canEditDeck()||!e.isPrimary||e.button!==0)return;
     catalogDragState={item:serialized,pointerId:e.pointerId,startX:e.clientX,startY:e.clientY,active:false,overIndex:null};
    });
    btn.onclick=()=>{
     if(catalogClickDragged){catalogClickDragged=false;return;}
     const layout=currentDeckLayout();
     const emptyIdx=layout.slots.findIndex(s=>s.type==='empty');
     if(emptyIdx<0){layoutMessage('현재 페이지에 빈 키가 없습니다. 항목을 원하는 키 위로 직접 끌어다 놓으세요.');return;}
     void applyCatalogItemToSlot(serialized,emptyIdx);
    };
    list.append(btn);
   }
   if(isApps&&!q&&items.length>12){
    list.append(el('p','앱이 '+(items.length-12)+'개 더 있습니다. 위 검색창에 앱 이름을 입력하세요.','catalog-empty-note'));
   }
   details.append(list);
  }
  box.append(details);
 }
 if(!totalShown){
  box.append(el('p','검색 결과가 없습니다.','catalog-empty-note'));
 }
}
async function applyCatalogItemToSlot(item,slotIndex){
 if(!canEditDeck()||!Number.isInteger(slotIndex)||slotIndex<0||slotIndex>=15)return false;
 cancelAutoSave();
 if(deckCursor().kind==='sessions')leaveSessionBank();
 if(!deckEditing){deckEditing=true;userExitedEditMode=false;redrawDeck();}
 const candidate=beginDeckCandidate(),page=candidate.layouts.find(p=>p.id===deckProfile);
 if(!page)return false;
 const old=page.slots[slotIndex];
 if(item.kind==='builtin'){
  const resolvedSlot=item.slot==='__auto_agent__'?{type:'auto-agent',index:slotIndex}:normalizeDeckSlot(item.slot,slotIndex);
  const isNav=['sessions','page'].includes(resolvedSlot.type);
  if(isNav&&old.type!=='empty'&&(old.type!==resolvedSlot.type||old.page!==resolvedSlot.page)){
   openKeyEditor(slotIndex);
   if($('occupiedSlotHint'))$('occupiedSlotHint').hidden=false;
   layoutMessage('이동 키는 빈 슬롯에만 놓을 수 있습니다. 먼저 ‘키 비우기’를 누르세요.');
   return false;
  }
  page.slots[slotIndex]=resolvedSlot;
  if(isNav){
   candidate.navigation=true;redrawDeck();syncDeckLayoutToolbar();openKeyEditor(slotIndex);
   layoutMessage('초안에 이동 키를 추가했습니다. 진입·복귀 연결을 준비한 뒤 저장하세요.');
   return true;
  }
  if(await persistDeckLayouts(candidate.layouts,false,candidate,{reason:item.title+' 배치'})){
   redrawDeck();openKeyEditor(slotIndex);
   layoutMessage('‘'+item.title+'’ 키 '+String(slotIndex+1).padStart(2,'0')+'에 배치됨 · r'+layoutRevision);
   return true;
  }
  return false;
 }
 const kind=item.customKind;
 if(HIGH_RISK_CUSTOM_KINDS.has(kind)||kind==='macShortcut'||(kind==='hostUrl'&&!item.url)||(kind==='macHotkey'&&item.record)){
  openKeyEditor(slotIndex);
  if($('customKind')){$('customKind').value=kind;$('customKind').onchange();}
  if(kind==='macHotkey'&&item.record){setHotkeyRecording(true);$('recordMacHotkey')?.focus();}
  else if(kind==='hostUrl')$('customUrl')?.focus();
  else if(kind==='macShortcut')$('customMacShortcut')?.focus();
  return true;
 }
 let definition=null,label=item.title||'',symbol=item.symbol||customActionDefaultSymbol({kind,action:item.action});
 if(kind==='macSystem')definition={kind,action:item.action};
 else if(kind==='macHotkey'&&item.hotkey)definition={kind,key:item.hotkey.key,modifiers:[...item.hotkey.modifiers]};
 else if(kind==='appUrl'&&item.url)definition={kind,url:item.url};
 else if(kind==='hostUrl'&&item.url)definition={kind,url:item.url};
 else if(kind==='macApp'&&item.appPath){definition={kind,appPath:item.appPath};symbol='app';}
 if(!definition)return false;
 const id=old.type==='custom'?old.actionId:'action-'+crypto.randomUUID();
 candidate.actions=candidate.actions.filter(a=>a.id!==id);
 candidate.actions.push({id,enabled:true,definition});
 const presentation={};
 if(label)presentation.label=label.slice(0,48);
 if(symbol&&symbol!=='terminal')presentation.symbol=symbol;
 page.slots[slotIndex]=Object.keys(presentation).length?{type:'custom',actionId:id,presentation}:{type:'custom',actionId:id};
 if(await persistDeckLayouts(candidate.layouts,false,candidate,{reason:item.title+' 배치'})){
  redrawDeck();openKeyEditor(slotIndex);
  if(kind==='macApp')void importMacAppIcon(item.appPath);
  layoutMessage('‘'+item.title+'’ 키 '+String(slotIndex+1).padStart(2,'0')+'에 배치됨 · r'+layoutRevision);
  return true;
 }
 return false;
}
async function dropImageFileOnSlot(file,slotIndex){
 if(!canEditDeck()||!Number.isInteger(slotIndex)||slotIndex<0||slotIndex>=15)return;
 if(file.size>1048576){layoutMessage('업로드 실패: 최대 1MiB입니다.');return;}
 try{
  const response=await fetch('/api/assets/upload',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});
  const data=await response.json();
  if(!response.ok)throw Error(data.error||'업로드 실패');
  const candidate=beginDeckCandidate(),page=candidate.layouts.find(p=>p.id===deckProfile);
  if(!page)return;
  if(!candidate.assets.includes(data.id))candidate.assets.push(data.id);
  const slot=page.slots[slotIndex],presentation={...(slot.presentation||{}),asset:data.id};
  page.slots[slotIndex]={...slot,presentation};
  if(candidate.navigation){
   redrawDeck();openKeyEditor(slotIndex);syncDeckLayoutToolbar();
   layoutMessage('초안 키 '+String(slotIndex+1).padStart(2,'0')+'에 이미지를 적용했습니다.');
   return;
  }
  if(await persistDeckLayouts(candidate.layouts,false,candidate,{reason:'이미지 드롭 적용'})){
   if(!deckEditing){deckEditing=true;userExitedEditMode=false;}
   redrawDeck();openKeyEditor(slotIndex);
   layoutMessage('키 '+String(slotIndex+1).padStart(2,'0')+' 이미지 적용 완료 · r'+layoutRevision);
  }
 }catch(error){layoutMessage('업로드 실패: '+error.message);}
}
function mountLocalEditor(){
 if($('editorPages'))return;
 const workspace=document.querySelector('.workspace'),toolbar=$('deckLayoutToolbar');
 const pagesSection=el('div',undefined,'sidebar-section sidebar-pages');
 const title=el('h2','키 페이지');title.id='editorPagesTitle';
 const pages=el('nav');pages.id='editorPages';pages.setAttribute('aria-label','키 페이지 목록');
 const pageActions=el('div',undefined,'sidebar-page-actions');pageActions.append($('addDeckPage'),renameDeckPage,movePageUp,movePageDown,$('resetDeck'));
 pagesSection.append(title,pages,pageActions);
 const syncSection=el('div',undefined,'sidebar-section sidebar-sync');
 const syncTitle=el('h3','저장 · 동기화','sidebar-heading');
 const syncRow=el('div',undefined,'sidebar-sync-row');
 syncRow.append(layoutStatus,reloadLayout);
 const backupRow=el('div',undefined,'sidebar-backup-row');
 const exportBtn=el('button','백업 저장','deck-tool');exportBtn.id='exportProfileBtn';exportBtn.type='button';
 const importBtn=el('button','불러오기','deck-tool');importBtn.id='importProfileBtn';importBtn.type='button';
 const importFile=el('input');importFile.type='file';importFile.id='importProfileInput';importFile.accept='application/json,.json';importFile.hidden=true;
 exportBtn.onclick=()=>{
  if(!deckLocal||layoutRevision===null)return;
  const payload=JSON.stringify({schemaVersion:1,exportedAt:new Date().toISOString(),layouts:validateDeckLayouts(deckLayouts),actions:structuredClone(deckActions)},null,2);
  const url=URL.createObjectURL(new Blob([payload],{type:'application/json'}));
  const link=el('a');link.href=url;link.download='agent-deck-profile.json';document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  layoutMessage('프로필 백업 파일(agent-deck-profile.json)을 저장했습니다.');
 };
 importBtn.onclick=()=>{if(canEditDeck())importFile.click();};
 importFile.onchange=async()=>{
  const file=importFile.files?.[0];importFile.value='';
  if(!file||!canEditDeck())return;
  try{
   const parsed=JSON.parse(await file.text());
   const layouts=validateDeckLayouts(parsed.layouts);
   const actions=Array.isArray(parsed.actions)?structuredClone(parsed.actions):[];
   const validAssetSet=new Set(deckAssets);
   for(const page of layouts)for(const slot of page.slots){
    if(slot.presentation?.asset&&!validAssetSet.has(slot.presentation.asset)){
     try{const check=await fetch('/api/assets/'+slot.presentation.asset+'?staged=1');if(check.ok)validAssetSet.add(slot.presentation.asset);}catch{}
     if(!validAssetSet.has(slot.presentation.asset)){delete slot.presentation.asset;if(!Object.keys(slot.presentation).length)delete slot.presentation;}
    }
   }
   const candidate={baseRevision:layoutRevision,layouts,actions,assets:[...validAssetSet],navigation:false,error:''};
   if(await persistDeckLayouts(layouts,false,candidate,{reason:'프로필 불러오기'})){closeKeyEditor();redrawDeck();layoutMessage('프로필 백업을 불러왔습니다 · r'+layoutRevision);}
  }catch(error){layoutMessage('프로필 불러오기 실패: '+error.message);}
 };
 backupRow.append(exportBtn,importBtn,importFile);
 syncSection.append(syncTitle,syncRow,draftCallout,saveCandidate,importLayout,initializeLayout,backupRow);
 const navDetails=el('details',undefined,'sidebar-section sidebar-nav-details');navDetails.id='navCheckDetails';
 const navSummary=el('summary',undefined,'sidebar-nav-summary');
 const navSummaryLabel=el('span','탐색 연결 점검');
 const navSummaryBadge=el('span','확인 중','nav-summary-badge');navSummaryBadge.id='navSummaryBadge';
 navSummary.append(navSummaryLabel,navSummaryBadge);
 const navBody=el('div',undefined,'sidebar-nav-check');
 navBody.append(connectionLabel,connectionPlan,graphStatus);
 navDetails.append(navSummary,navBody);
 navDetails.addEventListener('toggle',()=>{if(suppressingNavToggle){suppressingNavToggle=false;return;}navDetailsUserOpen=navDetails.open;});
 toolbar.prepend(pagesSection);
 toolbar.append(syncSection,navDetails);
 workspace.prepend(toolbar);
 const settings=el('aside');settings.id='editorSettings';settings.setAttribute('aria-label','선택 키 설정');
 const empty=el('div');empty.id='editorEmpty';
 const emptyTitle=el('h2','기존 배치 가져오기 필요');emptyTitle.id='editorEmptyTitle';
 const emptyDesc=el('p','','hint');emptyDesc.id='editorEmptyDesc';
 const startBtn=el('button','키 편집 시작','action editor-start-btn');startBtn.id='startDeckEditing';startBtn.type='button';startBtn.hidden=true;startBtn.onclick=()=>$('editDeck').click();
 const guideList=el('dl',undefined,'editor-guide-list');guideList.id='editorGuideList';
 for(const [term,desc]of [['우클릭 · E 단축키','미리보기 테스트 중에도 우클릭으로 바로 편집합니다'],['드래그 위치 · 액션 놓기','키끼리 맞바꾸거나 라이브러리에서 끌어다 놓습니다'],['자동 저장 · 실행 취소','수정 즉시 자동 반영되고 ⌘Z로 되돌릴 수 있습니다']]){
  const item=el('div');item.append(el('dt',term),el('dd',desc));guideList.append(item);
 }
 empty.append(emptyTitle,emptyDesc,startBtn,guideList);
 const catalog=el('div');catalog.id='actionCatalog';
 const catHead=el('div',undefined,'catalog-head');
 const catTitle=el('h2','액션 라이브러리');
 catHead.append(catTitle);
 const catHint=el('p','항목을 왼쪽 키로 끌어다 놓거나, 눌러서 빈 칸에 추가하세요.','hint');
 const catPreviewNote=el('p','동작 미리보기 테스트 중입니다. 상단 ‘편집으로 돌아가기’ 또는 키 우클릭으로 수정합니다.','catalog-preview-note');catPreviewNote.id='catalogPreviewNote';catPreviewNote.hidden=true;
 const catSearch=el('input');catSearch.type='search';catSearch.id='catalogSearch';catSearch.placeholder='액션·앱·단축키 검색 (볼륨, Safari)';catSearch.setAttribute('aria-label','액션 라이브러리 검색');
 catSearch.oninput=()=>renderActionCatalog();
 const catGroups=el('div',undefined,'catalog-groups');catGroups.id='catalogGroups';
 catalog.append(catHead,catHint,catPreviewNote,catSearch,catGroups);
 settings.append(empty,catalog,$('keyEditor'));workspace.append(settings);
 const previewTitle=el('h2','에이전트');previewTitle.id='editorPreviewTitle';
 const modeBadge=el('span','편집 캔버스','editor-mode-badge');modeBadge.id='editorModeBadge';
 const undoBtn=el('button','↶','deck-history-btn');undoBtn.id='undoDeckBtn';undoBtn.type='button';undoBtn.title='실행 취소 (⌘Z)';undoBtn.setAttribute('aria-label','실행 취소');undoBtn.disabled=true;undoBtn.onclick=()=>void undoDeckChange();
 const redoBtn=el('button','↷','deck-history-btn');redoBtn.id='redoDeckBtn';redoBtn.type='button';redoBtn.title='다시 실행 (⌘⇧Z)';redoBtn.setAttribute('aria-label','다시 실행');redoBtn.disabled=true;redoBtn.onclick=()=>void redoDeckChange();
 const heading=el('div',undefined,'editor-preview-heading');heading.append(previewTitle,modeBadge,undoBtn,redoBtn,$('editDeck'),$('showDeckRequest'));
 const bankCol=document.querySelector('.bank-column');
 bankCol.prepend(heading);
 const canvasPageBar=el('nav');canvasPageBar.id='canvasPageBar';canvasPageBar.className='canvas-page-bar';canvasPageBar.setAttribute('aria-label','빠른 페이지 전환');
 bankCol.append(canvasPageBar);
 $('deckEditHint').textContent='키를 누르면 설정이 열리고, 키끼리 또는 오른쪽 라이브러리에서 끌어다 놓을 수 있습니다.';
 const pageForm=$('pageForm'),pageActionsEl=pageForm?.querySelector('.dialog-actions');
 if(pageForm&&pageActionsEl){
  const autoRow=el('label',undefined,'custom-check page-autolink-row');autoRow.id='autoLinkPageRow';
  const autoBox=el('input');autoBox.type='checkbox';autoBox.id='autoLinkPage';autoBox.checked=true;
  autoRow.append(autoBox,el('span','현재 페이지 빈 칸에 이동 키 + 새 페이지 15번 칸에 ‘돌아가기’ 자동 배치'));
  pageForm.insertBefore(autoRow,pageActionsEl);
 }
 const keyEditor=$('keyEditor');
 keyEditor.querySelector('.hint').textContent='변경하면 즉시 자동 반영됩니다. (실행 취소 ⌘Z · 닫기 Esc)';
 const keyHead=el('div',undefined,'key-editor-head');
 const backBtn=el('button','← 목록','slot-back-btn');backBtn.id='backToCatalogBtn';backBtn.type='button';backBtn.onclick=()=>closeKeyEditor();
 const headTools=el('div',undefined,'key-editor-head-tools');
 const prevSlot=el('button','‹','slot-step-btn');prevSlot.id='prevSlotBtn';prevSlot.type='button';prevSlot.setAttribute('aria-label','이전 키 편집');prevSlot.title='이전 키 (‹)';
 prevSlot.onclick=()=>{if(editingSlot!==null)openKeyEditor((editingSlot+14)%15);};
 const nextSlot=el('button','›','slot-step-btn');nextSlot.id='nextSlotBtn';nextSlot.type='button';nextSlot.setAttribute('aria-label','다음 키 편집');nextSlot.title='다음 키 (›)';
 nextSlot.onclick=()=>{if(editingSlot!==null)openKeyEditor((editingSlot+1)%15);};
 headTools.append(prevSlot,$('editorSlot'),nextSlot);
 keyHead.append(backBtn,$('keyEditorTitle'),headTools);
 keyEditor.prepend(keyHead);
 const slotQuickActions=el('div',undefined,'slot-quick-actions');slotQuickActions.id='slotQuickActions';
 const copyBtn=el('button','복사','slot-quick-btn');copyBtn.id='copySlotBtn';copyBtn.type='button';copyBtn.onclick=copyEditingSlot;
 const pasteBtn=el('button','붙여넣기','slot-quick-btn');pasteBtn.id='pasteSlotBtn';pasteBtn.type='button';pasteBtn.disabled=!copiedSlotClipboard;pasteBtn.onclick=pasteToEditingSlot;
 const clearBtn=el('button','키 비우기','slot-quick-btn is-clear');clearBtn.id='clearSlotBtn';clearBtn.type='button';clearBtn.onclick=clearEditingSlot;
 slotQuickActions.append(copyBtn,pasteBtn,clearBtn);
 const modeTabs=el('div',undefined,'action-mode-tabs');modeTabs.id='actionModeTabs';modeTabs.setAttribute('role','group');modeTabs.setAttribute('aria-label','동작 분류');
 for(const [id,label,mode]of [['modeTabBuiltin','기본 · 탐색','builtin'],['modeTabMac','macOS · 미디어','mac'],['modeTabAutomation','URL · 자동화','automation']]){
  const tab=el('button',label,'action-mode-tab');tab.id=id;tab.type='button';tab.setAttribute('aria-pressed','false');
  tab.onclick=()=>switchActionMode(mode);
  modeTabs.append(tab);
 }
 const assignmentLabel=document.querySelector('label[for="keyAssignment"]');
 const assignmentGroup=el('div',undefined,'builtin-assignment-group');assignmentGroup.id='builtinAssignmentGroup';
 if(assignmentLabel){
  assignmentLabel.textContent='기본 기능 (에이전트 · 페이지 · 응답)';
  keyEditor.insertBefore(slotQuickActions,assignmentLabel);
  keyEditor.insertBefore(modeTabs,assignmentLabel);
  keyEditor.insertBefore(assignmentGroup,assignmentLabel);
  assignmentGroup.append(assignmentLabel,$('keyAssignment'));
 }else{
  keyEditor.prepend(modeTabs);
  keyEditor.prepend(slotQuickActions);
 }
 const overrideHint=el('p','아래 사용자 동작이 선택되어 기본 기능 대신 실행됩니다.','override-hint');overrideHint.id='keyAssignmentOverrideHint';overrideHint.hidden=true;
 const occupiedHint=el('p','이 키는 이미 사용 중이라 이동 키로 바로 바꿀 수 없습니다. 위의 ‘키 비우기’를 먼저 누르세요.','occupied-slot-hint');occupiedHint.id='occupiedSlotHint';occupiedHint.hidden=true;
 assignmentGroup.append(overrideHint,occupiedHint);
 mountCustomInspector();
 syncEditorEmpty();
 syncActionModeTabs();
 syncHistoryButtons();
}
importLayout.onclick=async()=>{if(layoutInitialized||!canEditDeck(true))return;try{const raw=legacyDeckLayout();if(!raw)throw Error('가져올 배치가 없습니다.');const next=validateDeckLayouts(JSON.parse(raw));if(await persistDeckLayouts(next,true)){userExitedEditMode=false;deckEditing=true;redrawDeck();syncDeckLayoutToolbar();layoutMessage('기존 배치를 서버에 가져왔습니다. 브라우저 원본은 보존됩니다.');}}catch(error){layoutMessage('가져오기 실패: '+error.message);}};
initializeLayout.onclick=async()=>{if(!canEditDeck(true)||layoutInitialized)return;if(await persistDeckLayouts(deckLayouts,true)){userExitedEditMode=false;deckEditing=true;redrawDeck();syncDeckLayoutToolbar();}};
setInterval(()=>{if(!document.hidden)loadSharedLayouts();},2000);
$('deckLayoutToolbar').hidden=true;$('connectBtn').hidden=true;
for(const id of ['keyEditor','pageEditor','resetDialog']){const error=el('p',undefined,'layout-error');error.setAttribute('role','alert');$(id).append(error);}
function redrawDeck(){renderSignature='';if(typeof nativeSignature!=='undefined')nativeSignature='';if(typeof networkSignature!=='undefined')networkSignature='';if(deckView==='native'&&typeof renderNative==='function')renderNative();else if(deckView==='reason'&&typeof renderNetwork==='function')renderNetwork();else if(current)render(current);}
function setDeckProfile(id){
 if(layoutSaving||!editorLayouts().some(x=>x.id===id))return;
 cancelAutoSave();cancelDeckInput();deckGeneration++;closeKeyEditor();
 deckProfile=id;deckCursor().kind='authored';deckCursor().pageId=id;
 if(!deckLocal)deckEditing=false;
 redrawDeck();syncDeckLayoutToolbar();
}
function syncDeckLayoutToolbar(){
 const toolbar=$('deckLayoutToolbar');toolbar.hidden=!deckLocal;$('deckEditHint').hidden=!deckLocal||!deckEditing;
 importLayout.hidden=!deckLocal||layoutInitialized||!legacyDeckLayout();initializeLayout.hidden=!deckLocal||layoutInitialized;
 const layouts=editorLayouts(),diagnostics=deckGraphDiagnostics(layouts,selectedConnections);
 const pageName=id=>layouts.find(p=>p.id===id)?.name||id;
 const planSignature=JSON.stringify([deckProfile,layouts.map(p=>[p.id,p.name])]);
 if(connectionPlan.dataset.signature!==planSignature){connectionPlan.replaceChildren();for(const [name,action] of [['전체 세션',{type:'sessions'}],...layouts.filter(p=>p.id!==deckProfile).map(p=>[p.name+' 페이지',{type:'page',page:p.id}])]){const option=el('option',name);option.value=JSON.stringify(action);option.selected=selectedConnections.some(c=>c.from===deckProfile&&c.type===action.type&&c.page===action.page);connectionPlan.append(option);}connectionPlan.dataset.signature=planSignature;}
 draftCallout.hidden=!deckLocal||!deckCandidate;
 if(!draftCallout.hidden){
  const needs=[];
  if(deckCandidate.navigation&&!diagnostics.ready){
   if(diagnostics.unreachable.length)needs.push('진입 키 필요: '+diagnostics.unreachable.map(pageName).join(', '));
   if(diagnostics.noReturn.length)needs.push('복귀 키 필요: '+diagnostics.noReturn.map(pageName).join(', '));
   if(diagnostics.missingSessions)needs.push('‘전체 세션’ 이동 키 1개 필요');
  }
  draftCallout.dataset.ready=String(diagnostics.ready);
  draftCallout.textContent=needs.length?('게시 전 필요한 연결: '+needs.join(' · ')):'초안이 준비되었습니다. ‘배치 초안 저장’을 누르면 반영됩니다.';
 }
 saveCandidate.hidden=!deckLocal||!deckCandidate;saveCandidate.disabled=layoutSaving;
 reloadLayout.textContent=deckCandidate?'초안 버리고 다시 읽기':'서버 다시 읽기';
 graphStatus.hidden=!deckLocal;graphStatus.dataset.ready=String(diagnostics.ready);
 graphStatus.textContent=diagnostics.ready?'탐색 준비 완료':('탐색 준비 필요 · 진입 불가: '+(diagnostics.unreachable.join(', ')||'없음')+' · 복귀 불가: '+(diagnostics.noReturn.join(', ')||'없음')+' · 전체 세션 진입 '+(diagnostics.missingSessions?'없음':'있음')+' · 자동 재배치하지 않습니다.');
 for(const deficit of diagnostics.deficits.filter(p=>p.missing)){graphStatus.textContent+=' / '+layouts.find(p=>p.id===deficit.pageId).name+': '+deficit.connections.map(c=>c.page||'전체 세션').join(', ')+' 연결 '+deficit.missing+'개 · 빈 키 '+deficit.empty+'개 · 추가 빈 키 '+deficit.additionalEmpty+'개';}
 if($('navSummaryBadge')){$('navSummaryBadge').textContent=diagnostics.ready?'준비 완료':'점검 필요';$('navSummaryBadge').dataset.ready=String(diagnostics.ready);}
 if($('navCheckDetails')){
  const wantNavOpen=Boolean(deckCandidate?.navigation)||selectedConnections.length>0||navDetailsUserOpen;
  if($('navCheckDetails').open!==wantNavOpen){suppressingNavToggle=true;$('navCheckDetails').open=wantNavOpen;}
 }
 if(deckCandidate?.error)layoutMessage(deckCandidate.error);
 const select=$('deckProfile');const signature=JSON.stringify(layouts.map(x=>[x.id,x.name]));
 if(select.dataset.signature!==signature){select.replaceChildren();for(const p of layouts){const option=el('option',p.name);option.value=p.id;select.append(option);}select.dataset.signature=signature;}
 const isDefaultPage=defaultDeckLayouts().some(p=>p.id===deckProfile);
 const pageIndex=layouts.findIndex(p=>p.id===deckProfile);
 select.value=deckProfile;$('editDeck').setAttribute('aria-pressed',String(!deckEditing));$('editDeck').textContent=deckEditing?'동작 미리보기':'편집으로 돌아가기';$('resetDeck').textContent=isDefaultPage?'기본 배치':'페이지 삭제';$('resetDeck').classList.toggle('is-destructive',!isDefaultPage);
 renameDeckPage.disabled=layoutSaving;
 movePageUp.disabled=layoutSaving||pageIndex<=0;
 movePageDown.disabled=layoutSaving||pageIndex<0||pageIndex>=layouts.length-1;
 if($('editorPreviewTitle'))$('editorPreviewTitle').textContent=layouts.find(p=>p.id===deckProfile)?.name||'덱 미리보기';
 if($('editorModeBadge')){$('editorModeBadge').textContent=deckEditing?'편집 캔버스':'미리보기 테스트';$('editorModeBadge').dataset.editing=String(deckEditing);}
 if(deckLocal&&$('canvasPageBar')){
  const bar=$('canvasPageBar');
  const barSig=JSON.stringify([deckProfile,layouts.map(p=>[p.id,p.name])]);
  if(bar.dataset.signature!==barSig){
   bar.replaceChildren();
   for(const [i,p]of layouts.entries()){
    const pill=el('button',undefined,'canvas-page-pill');pill.type='button';pill.dataset.page=p.id;
    pill.append(el('span',String(i+1),'canvas-page-num'),el('span',p.name));
    if(p.id===deckProfile)pill.setAttribute('aria-current','page');
    pill.onclick=()=>setDeckProfile(p.id);
    bar.append(pill);
   }
   const addPill=el('button','+','canvas-page-add');addPill.type='button';addPill.setAttribute('aria-label','새 키 페이지 추가');addPill.title='페이지 추가';
   addPill.onclick=()=>$('addDeckPage').click();
   bar.append(addPill);
   bar.dataset.signature=barSig;
  }
  bar.hidden=!deckLocal;
 }
 syncHistoryButtons();
 if(deckLocal&&$('editorPages')){
  const pages=$('editorPages');
  if(pages.dataset.signature!==signature){pages.replaceChildren();for(const p of layouts){const button=el('button',p.name,'editor-page');button.type='button';button.dataset.page=p.id;button.onclick=()=>setDeckProfile(p.id);pages.append(button);}pages.dataset.signature=signature;}
  for(const button of pages.children){if(button.dataset.page===deckProfile)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');}
  syncEditorEmpty();
 }
}
const MAC_SYSTEM_ITEMS=[
 {action:'volume-up',name:'볼륨 올리기',detail:'음량 +10%',symbol:'volume-up'},
 {action:'volume-down',name:'볼륨 내리기',detail:'음량 -10%',symbol:'volume-down'},
 {action:'volume-mute',name:'음소거 전환',detail:'오디오 음소거',symbol:'volume-mute'},
 {action:'media-play-pause',name:'재생 / 일시정지',detail:'미디어 제어',symbol:'media-play'},
 {action:'media-next',name:'다음 트랙',detail:'미디어 제어',symbol:'media-next'},
 {action:'media-prev',name:'이전 트랙',detail:'미디어 제어',symbol:'media-prev'},
 {action:'dark-mode',name:'다크 모드 전환',detail:'화면 스타일',symbol:'dark-mode'},
 {action:'screenshot',name:'영역 스크린샷',detail:'클립보드 복사',symbol:'screenshot'},
 {action:'screen-lock',name:'화면 잠금',detail:'디스플레이 끄기',symbol:'lock'},
 {action:'mission-control',name:'미션 컨트롤',detail:'창 한눈에 보기',symbol:'app'},
 {action:'finder',name:'Finder 열기',detail:'파일 관리자',symbol:'folder'},
 {action:'downloads',name:'다운로드 폴더',detail:'Finder 열기',symbol:'folder'}
];
const MAC_HOTKEY_PRESET_ITEMS=[
 {key:'c',modifiers:['cmd'],label:'복사 (⌘C)'},
 {key:'v',modifiers:['cmd'],label:'붙여넣기 (⌘V)'},
 {key:'z',modifiers:['cmd'],label:'실행 취소 (⌘Z)'},
 {key:'z',modifiers:['cmd','shift'],label:'다시 실행 (⌘⇧Z)'},
 {key:'4',modifiers:['cmd','shift'],label:'영역 캡처 (⌘⇧4)'},
 {key:'5',modifiers:['cmd','shift'],label:'화면 캡처 도구 (⌘⇧5)'},
 {key:'space',modifiers:['cmd'],label:'Spotlight 검색 (⌘Space)'},
 {key:'w',modifiers:['cmd'],label:'창/탭 닫기 (⌘W)'},
 {key:'t',modifiers:['cmd'],label:'새 탭 (⌘T)'},
 {key:'a',modifiers:['cmd','shift'],label:'회의 음소거 토글 (⌘⇧A)'}
];
const MAC_APP_URL_PRESET_ITEMS=[
 {url:'raycast://',label:'Raycast 열기'},
 {url:'obsidian://open',label:'Obsidian 열기'},
 {url:'slack://open',label:'Slack 열기'},
 {url:'vscode://',label:'VS Code 열기'},
 {url:'notion://',label:'Notion 열기'},
 {url:'shortcuts://',label:'단축어 앱 열기'},
 {url:'spotify://',label:'Spotify 열기'},
 {url:'x-apple.systempreferences:',label:'시스템 설정 열기'}
];
const MAC_HOTKEY_KEY_ITEMS=[...'abcdefghijklmnopqrstuvwxyz'.split(''),...'0123456789'.split(''),'space','tab','enter','esc','delete','up','down','left','right','f1','f2','f3','f4','f5','f6','f7','f8','f9','f10','f11','f12'];
const DECK_SYMBOL_LABELS={terminal:'터미널',network:'네트워크 · 세션',enter:'Enter',up:'위 방향키',down:'아래 방향키',left:'왼쪽 방향키',right:'오른쪽 방향키',tab:'Tab',esc:'Esc',refresh:'새로고침',context:'요청 원문',app:'앱 격자',shortcut:'단축어',link:'링크 · URL',keyboard:'키보드 · 단축키','volume-up':'볼륨 올리기','volume-down':'볼륨 내리기','volume-mute':'음소거','media-play':'재생 · 일시정지','media-next':'다음 트랙','media-prev':'이전 트랙','dark-mode':'다크 모드',screenshot:'스크린샷',lock:'화면 잠금',folder:'폴더'};
const CUSTOM_KIND_GROUPS=[
 ['macOS 제어',[['macApp','macOS 앱 실행'],['macShortcut','macOS 단축어 실행'],['macSystem','macOS 시스템·미디어 제어'],['macHotkey','macOS 전역 단축키 (활성 창)'],['appUrl','앱 URL 열기 (raycast:// 등)']]],
 ['웹 · 고급 자동화',[['hostUrl','웹 주소 열기 (http/https)'],['hostProcess','셸 스크립트 실행'],['sessionText','유휴 세션에 텍스트 전송'],['keyCombo','검증된 수신기에 단축키']]]
];
const COLOR_PRESET_ITEMS=[
 {label:'기본 배경',value:''},
 {label:'슬레이트',value:'#243447'},
 {label:'민트',value:'#1b4332'},
 {label:'코발트',value:'#1e3a5f'},
 {label:'인디고',value:'#342c5c'},
 {label:'앰버',value:'#543817'},
 {label:'크림슨',value:'#522024'},
 {label:'플럼',value:'#45234d'}
];
let macCatalogState=null,macCatalogLoading=false,macIconGeneration=0,macAutoLabel='',macAutoSymbol='';
function applyAutoPresentation(labelText,symbolName){
 if(!$('customLabel')||!$('customSymbol'))return;
 if(labelText&&(!$('customLabel').value||$('customLabel').value===macAutoLabel)){$('customLabel').value=labelText;macAutoLabel=labelText;}
 if(symbolName!==undefined&&(!$('customSymbol').value||$('customSymbol').value===macAutoSymbol)){$('customSymbol').value=symbolName;macAutoSymbol=symbolName;}
}
function normalizeHexColor(raw){
 const s=String(raw||'').trim();
 if(!s)return '';
 const short=s.match(/^#?([a-fA-F0-9]{3})$/);
 if(short)return '#'+short[1].split('').map(c=>c+c).join('').toLowerCase();
 const full=s.match(/^#?([a-fA-F0-9]{6})$/);
 return full?'#'+full[1].toLowerCase():s;
}
function captureEditorStateSignature(){
 if(!$('customInspector')||!$('keyAssignment'))return '';
 return JSON.stringify([
  $('keyAssignment').value,
  $('customLabel').value,
  $('customSymbol').value,
  normalizeHexColor($('customColor').value),
  $('customInspector').dataset.asset||'',
  $('customKind').value,
  $('customMacApp')?.value||'',
  $('customMacShortcut')?.value||'',
  $('customMacSystem')?.value||'',
  $('customMacHotkeyKey')?.value||'',
  ['cmd','shift','alt','ctrl'].map(m=>Boolean($('customMod'+m[0].toUpperCase()+m.slice(1))?.checked)),
  $('customAppUrl')?.value||'',
  $('customUrl')?.value||'',
  $('customShell')?.value||'',
  $('customScript')?.value||'',
  $('customCwd')?.value||'',
  $('customTimeout')?.value||'',
  $('customMaxOutput')?.value||'',
  $('customTarget')?.value||'',
  $('customText')?.value||'',
  Boolean($('customSubmit')?.checked),
  $('customChord')?.value||'',
  $('customMapping')?.value||'',
  Boolean($('customEnabled')?.checked),
  Boolean($('customTrusted')?.checked)
 ]);
}
function setHotkeyRecording(active){
 hotkeyRecording=Boolean(active);
 const btn=$('recordMacHotkey');
 if(btn){
  btn.setAttribute('aria-pressed',String(hotkeyRecording));
  btn.textContent=hotkeyRecording?'키 조합을 누르세요… (Esc 취소)':'단축키 눌러서 입력';
 }
}
function mapCodeToMacHotkeyKey(code){
 if(/^Key([A-Z])$/.test(code))return code.slice(3).toLowerCase();
 if(/^Digit([0-9])$/.test(code))return code.slice(5);
 const specials={Space:'space',Tab:'tab',Enter:'enter',NumpadEnter:'enter',Escape:'esc',Backspace:'delete',Delete:'delete',ArrowUp:'up',ArrowDown:'down',ArrowLeft:'left',ArrowRight:'right'};
 if(specials[code])return specials[code];
 if(/^F([1-9]|1[0-2])$/.test(code))return code.toLowerCase();
 return '';
}
function formatMacHotkeyChord(){
 const modMap=[['customModCmd','⌘'],['customModShift','⇧'],['customModAlt','⌥'],['customModCtrl','⌃']];
 const prefix=modMap.filter(([id])=>$('customModCmd')&&$(id)?.checked).map(([,glyph])=>glyph).join('');
 const key=($('customMacHotkeyKey')?.value||'c');
 const keyText=key.length===1?key.toUpperCase():key.charAt(0).toUpperCase()+key.slice(1);
 return prefix+keyText;
}
function updateKeyPreview(){
 const section=$('customInspector');
 if(!section||!$('keyPreviewCard'))return;
 syncActionModeTabs();
 const kind=$('customKind').value,customActive=kind!=='builtin';
 const asset=section.dataset.asset||'';
 const assetCommitted=!!asset&&deckAssets.includes(asset);
 const normalizedColor=normalizeHexColor($('customColor').value);
 const validColor=/^#[a-fA-F0-9]{6}$/.test(normalizedColor);
 const swatch=$('customColorSwatch');
 if(swatch){swatch.style.backgroundColor=validColor?normalizedColor:'transparent';swatch.classList.toggle('is-set',validColor);}
 if($('customColorPicker')&&validColor)$('customColorPicker').value=normalizedColor;
 if($('customColorPresets')){
  for(const chip of $('customColorPresets').querySelectorAll('.color-preset-chip')){
   const active=chip.dataset.color===(validColor?normalizedColor:'');
   chip.classList.toggle('is-active',active);
   chip.setAttribute('aria-pressed',String(active));
  }
 }
 const assignEl=$('keyAssignment'),assignLabel=document.querySelector('label[for="keyAssignment"]');
 assignEl.classList.toggle('is-overridden',customActive);
 if(assignLabel)assignLabel.classList.toggle('is-overridden',customActive);
 if($('keyAssignmentOverrideHint'))$('keyAssignmentOverrideHint').hidden=!customActive;
 let parsedAssign=null;
 try{parsedAssign=JSON.parse(assignEl.value||'{}');}catch{}
 const currentSlot=editingSlot!==null?currentDeckLayout()?.slots[editingSlot]:null;
 if($('occupiedSlotHint')){
  const blockedNav=!customActive&&parsedAssign&&['sessions','page'].includes(parsedAssign.type)&&currentSlot&&currentSlot.type!=='empty'&&(currentSlot.type!==parsedAssign.type||currentSlot.page!==parsedAssign.page);
  $('occupiedSlotHint').hidden=!blockedNav;
 }
 if($('clearSlotBtn')){
  const alreadyEmpty=!customActive&&parsedAssign?.type==='empty'&&!$('customLabel').value.trim()&&!$('customSymbol').value&&!normalizedColor&&!asset&&currentSlot?.type==='empty'&&!currentSlot?.presentation;
  $('clearSlotBtn').disabled=alreadyEmpty||layoutSaving;
 }
 if($('customImageStatus'))$('customImageStatus').textContent=asset?(assetCommitted?'적용된 이미지 있음':'새 이미지 준비됨 (저장 시 반영)'):'이미지 없음 (클릭 또는 드래그해 업로드)';
 $('removeCustomImage').classList.toggle('is-empty',!asset);
 const kindLabel=$('customKind').selectedOptions[0]?.textContent||'사용자 동작';
 const assignText=assignEl.selectedOptions[0]?.textContent||'빈 키';
 let actionName=assignText;
 if(kind==='macApp')actionName=$('customMacApp').selectedOptions[0]?.dataset?.name||'macOS 앱 선택';
 else if(kind==='macShortcut')actionName=$('customMacShortcut').value.trim()||'macOS 단축어';
 else if(kind==='macSystem')actionName=$('customMacSystem').selectedOptions[0]?.dataset?.name||'시스템 제어';
 else if(kind==='macHotkey')actionName=formatMacHotkeyChord();
 else if(kind==='appUrl')actionName=$('customAppUrl').value.trim()||'앱 URL';
 else if(kind==='hostUrl')actionName=$('customUrl').value.trim()||'웹 URL';
 else if(customActive)actionName=kindLabel;
 else if(parsedAssign&&['auto-agent','agent'].includes(parsedAssign.type)){
  const liveAgent=deckAgentForSlot(parsedAssign,deckSourceSessions(),0);
  if(liveAgent?.label)actionName=liveAgent.label;
 }
 const labelText=$('customLabel').value.trim();
 $('keyPreviewName').textContent=labelText||actionName;
 const dirty=editorBaselineSignature!==''&&captureEditorStateSignature()!==editorBaselineSignature;
 const subParts=[customActive?kindLabel:('기본 기능 · '+assignText)];
 if(asset&&!assetCommitted)subParts.push('이미지 저장 대기');
 if(dirty)subParts.push('변경됨 · 저장 전');
 $('keyPreviewSub').textContent=subParts.join(' · ');
 if($('testCustomAction'))$('testCustomAction').hidden=!customActive||demo;
 const tile=$('keyPreviewTile');
 tile.style.setProperty('--preview-key-color',validColor?normalizedColor:'');
 tile.classList.toggle('has-color',validColor);
 tile.classList.toggle('has-custom-asset',Boolean(asset&&!$('customSymbol').value));
 tile.replaceChildren();
 const renderFallbackSymbol=()=>{
  const symOverride=$('customSymbol').value;
  if(!symOverride&&!customActive&&parsedAssign&&['auto-agent','agent'].includes(parsedAssign.type)){
   const liveAgent=deckAgentForSlot(parsedAssign,deckSourceSessions(),0);
   if(liveAgent&&typeof agentIconName==='function'){tile.append(icon(agentIconName(liveAgent.agent),'preview-symbol'));return;}
  }
  if(!symOverride&&!customActive&&parsedAssign?.type==='choice'){
   tile.append(el('span',String(parsedAssign.key||'1'),'preview-choice-number'));
   return;
  }
  const builtinDefault={sessions:'network',page:'enter',refresh:'refresh',context:'context',quota:'quota',key:parsedAssign?.key||'keyboard',empty:'plus'}[parsedAssign?.type]||'terminal';
  const sym=symOverride||(customActive?customActionDefaultSymbol({kind,action:$('customMacSystem')?.value}):builtinDefault);
  tile.append(icon(sym,'preview-symbol'));
 };
 if(asset){
  const img=el('img');img.src='/api/assets/'+asset+(assetCommitted?'':'?staged=1');img.width=36;img.height=36;img.alt='';
  img.onerror=()=>{img.remove();tile.classList.remove('has-custom-asset');renderFallbackSymbol();};
  tile.append(img);
 }else{
  renderFallbackSymbol();
 }
 if(labelText||(!customActive&&parsedAssign?.type!=='empty')||customActive){
  tile.append(el('span',labelText||actionName,'preview-tile-caption'));
 }
}
function renderMacCatalogOptions(){
 if(!$('customMacApp'))return;
 const apps=macCatalogState?.apps||[],shortcuts=macCatalogState?.shortcuts||[];
 const query=($('customMacAppSearch')?.value||'').trim().toLowerCase();
 const appSelect=$('customMacApp'),currentApp=appSelect.dataset.pending??appSelect.value??'';
 const filtered=query?apps.filter(item=>item.name.toLowerCase().includes(query)||item.app.toLowerCase().includes(query)):apps;
 appSelect.replaceChildren();
 appSelect.append(Object.assign(el('option',apps.length?'macOS 앱을 선택하세요':(macCatalogLoading?'앱 목록 불러오는 중…':'앱 목록 없음 (새로고침)')),{value:''}));
 for(const item of filtered){const option=el('option',item.name+' ('+item.app+')');option.value=item.app;option.dataset.name=item.name;appSelect.append(option);}
 if(currentApp&&!filtered.some(item=>item.app===currentApp)){const preserved=apps.find(item=>item.app===currentApp);const option=el('option',(preserved?preserved.name+' · ':'저장된 앱: ')+currentApp);option.value=currentApp;option.dataset.name=preserved?.name||'';appSelect.append(option);}
 appSelect.value=currentApp;
 delete appSelect.dataset.pending;
 const shortcutSelect=$('customMacShortcutSelect'),currentShortcut=$('customMacShortcut')?.value||'';
 shortcutSelect.replaceChildren();
 shortcutSelect.append(Object.assign(el('option',shortcuts.length?'단축어 목록에서 선택':(macCatalogLoading?'단축어 불러오는 중…':'단축어 목록 없음 (직접 입력 가능)')),{value:''}));
 for(const name of shortcuts){const option=el('option',name);option.value=name;shortcutSelect.append(option);}
 if(currentShortcut&&shortcuts.includes(currentShortcut))shortcutSelect.value=currentShortcut;
 updateKeyPreview();
}
async function ensureMacCatalog(force=false){
 if(!deckLocal)return;
 if(macCatalogState&&!force){renderMacCatalogOptions();return;}
 if(macCatalogLoading&&!force)return;
 macCatalogLoading=true;renderMacCatalogOptions();
 try{
  const data=await api('/api/actions/mac-catalog'+(force?'?refresh=1':''));
  if(!deckLocal)return;
  macCatalogState=data;
  if(Array.isArray(data.systemControls)&&$('customMacSystem')){
   const sys=$('customMacSystem'),prev=sys.value||'volume-up';sys.replaceChildren();
   for(const item of data.systemControls){const option=el('option',item.name+' · '+item.detail);option.value=item.action;option.dataset.name=item.name;option.dataset.symbol=item.symbol||'app';sys.append(option);}
   sys.value=data.systemControls.some(x=>x.action===prev)?prev:data.systemControls[0]?.action||'';
  }
  if(Array.isArray(data.hotkeyPresets)&&$('customMacHotkeyPreset')){
   const hp=$('customMacHotkeyPreset'),prev=hp.value;hp.replaceChildren();
   hp.append(Object.assign(el('option','자주 쓰는 단축키 선택'),{value:''}));
   for(const preset of data.hotkeyPresets){const option=el('option',preset.label);option.value=JSON.stringify(preset);hp.append(option);}
   if([...hp.options].some(o=>o.value===prev))hp.value=prev;
  }
  if(Array.isArray(data.appUrlPresets)&&$('customAppUrlPreset')){
   const ap=$('customAppUrlPreset'),prev=ap.value;ap.replaceChildren();
   ap.append(Object.assign(el('option','자주 쓰는 앱 URL 선택'),{value:''}));
   for(const preset of data.appUrlPresets){const option=el('option',preset.label+' ('+preset.url+')');option.value=JSON.stringify(preset);ap.append(option);}
   if([...ap.options].some(o=>o.value===prev))ap.value=prev;
  }
 }catch(error){
  if(force&&deckLocal)layoutMessage('macOS 목록 조회 실패: '+error.message);
 }finally{
  macCatalogLoading=false;renderMacCatalogOptions();
 }
}
function syncEditorActionLabels(){
 const auto=canAutoSaveCurrentSlot();
 if($('saveAssignment'))$('saveAssignment').textContent=auto?'완료':'저장';
 if($('cancelAssignment'))$('cancelAssignment').textContent=auto?'닫기':'취소';
}
function notifyInspectorChange(delay=220){
 updateEditorHintCopy();
 syncEditorActionLabels();
 updateKeyPreview();
 if(editorBaselineSignature!==''&&canAutoSaveCurrentSlot())scheduleAutoSave(delay);
}
async function importMacAppIcon(appPath,{manual=false}={}){
 const section=$('customInspector');
 if(!section||!deckCandidate||editingSlot===null||!appPath)return;
 const candidate=deckCandidate,slot=editingSlot,page=deckProfile,generation=deckGeneration,editor=customEditorGeneration,iconReq=++macIconGeneration;
 const current=()=>deckCandidate===candidate&&editingSlot===slot&&deckProfile===page&&deckGeneration===generation&&customEditorGeneration===editor&&macIconGeneration===iconReq&&$('customKind')?.value==='macApp'&&$('customMacApp')?.value===appPath;
 const btn=$('importMacAppIcon');
 if(btn)btn.disabled=true;
 macIconInFlight=true;
 try{
  const response=await fetch('/api/actions/mac-app-icon',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({appPath})});
  const data=await response.json();
  if(!current())return;
  if(!response.ok)throw Error(data.error||'아이콘을 가져오지 못했습니다.');
  if(!candidate.assets.includes(data.id))candidate.assets.push(data.id);
  section.dataset.asset=data.id;
  if($('customSymbol').value===macAutoSymbol){$('customSymbol').value='';macAutoSymbol='';}
  layoutMessage(canAutoSaveCurrentSlot()?'앱 아이콘 가져옴 · 잠시 후 자동 반영됩니다.':'앱 아이콘 준비 완료 · 저장을 누르세요.');
 }catch(error){
  if(!current())return;
  if(manual)layoutMessage('아이콘 가져오기 실패: '+error.message);
  else{
   if(!$('customSymbol').value||$('customSymbol').value===macAutoSymbol){$('customSymbol').value='app';macAutoSymbol='app';}
   layoutMessage('앱 선택 완료 · 아이콘을 찾지 못해 기본 기호를 사용합니다.');
  }
 }finally{
  if(macIconGeneration===iconReq)macIconInFlight=false;
  if($('importMacAppIcon'))$('importMacAppIcon').disabled=false;
  notifyInspectorChange(140);
 }
}
function syncCustomInspectorFields(){
 const value=$('customKind').value,section=$('customInspector');
 if(!section)return;
 const highRisk=HIGH_RISK_CUSTOM_KINDS.has(value);
 if(value!=='macHotkey'&&hotkeyRecording)setHotkeyRecording(false);
 for(const [id,show]of [['customMacAppSearch',value==='macApp'],['customMacApp',value==='macApp'],['customMacShortcutSelect',value==='macShortcut'],['customMacShortcut',value==='macShortcut'],['customMacSystem',value==='macSystem'],['customMacHotkeyPreset',value==='macHotkey'],['customMacHotkeyKey',value==='macHotkey'],['customAppUrlPreset',value==='appUrl'],['customAppUrl',value==='appUrl'],['customUrl',value==='hostUrl'],['customShell',value==='hostProcess'],['customScript',value==='hostProcess'],['customCwd',value==='hostProcess'],['customTimeout',value==='hostProcess'],['customMaxOutput',value==='hostProcess'],['customTarget',['sessionText','keyCombo'].includes(value)],['customText',value==='sessionText'],['customSubmit',value==='sessionText'],['customChord',value==='keyCombo'],['customMapping',value==='keyCombo'],['customEnabled',value!=='builtin'],['customTrusted',highRisk]])$(id).parentElement.hidden=!show;
 $('customMacCatalogActions').hidden=!['macApp','macShortcut'].includes(value);
 $('importMacAppIcon').hidden=value!=='macApp';
 $('refreshMacCatalog').hidden=!['macApp','macShortcut'].includes(value);
 if($('customMacHotkeyRecorderRow'))$('customMacHotkeyRecorderRow').hidden=value!=='macHotkey';
 $('customMacHotkeyMods').hidden=value!=='macHotkey';
 $('customMacHotkeyNote').hidden=value!=='macHotkey';
 section.querySelector('.custom-trust-warning').hidden=!highRisk;
 $('customQualificationNote').hidden=!['sessionText','keyCombo'].includes(value);
 $('customCapabilities').hidden=value==='builtin';
 if($('customActionBar'))$('customActionBar').hidden=value==='builtin';
 const trustWrap=$('customTrusted')?.closest('.custom-check');
 if(trustWrap)trustWrap.classList.remove('is-attention');
 if(['macApp','macShortcut'].includes(value))void ensureMacCatalog(false);
 syncActionModeTabs();
 updateEditorHintCopy();
 syncEditorActionLabels();
 updateKeyPreview();
}
function switchActionMode(mode){
 const kindEl=$('customKind');
 if(!kindEl)return;
 if(mode==='builtin'){
  kindEl.value='builtin';
  try{if(JSON.parse($('keyAssignment').value||'{}').type==='custom')$('keyAssignment').value=JSON.stringify({type:'empty'});}catch{}
  kindEl.onchange();
  $('keyAssignment').focus();
  return;
 }
 if(mode==='mac'){
  const macKinds=['macApp','macShortcut','macSystem','macHotkey'];
  if(!macKinds.includes(kindEl.value)){
   const firstEnabled=macKinds.find(k=>![...kindEl.options].find(o=>o.value===k)?.disabled);
   if(!firstEnabled){layoutMessage('이 호스트에서는 macOS 제어 동작을 사용할 수 없습니다.');return;}
   kindEl.value=firstEnabled;
   kindEl.onchange();
  }
  kindEl.focus();
  return;
 }
 if(mode==='automation'){
  const autoKinds=['appUrl','hostUrl','hostProcess','sessionText','keyCombo'];
  if(!autoKinds.includes(kindEl.value)){
   kindEl.value='appUrl';
   kindEl.onchange();
  }
  kindEl.focus();
 }
}
function snapshotEditorClipboard(){
 const base=normalizeDeckSlot(JSON.parse($('keyAssignment').value||'{"type":"empty"}'),0);
 const presentation={};
 const label=$('customLabel').value;if(label)presentation.label=label;
 const symbol=$('customSymbol').value;if(symbol)presentation.symbol=symbol;
 const color=normalizeHexColor($('customColor').value);if(color)presentation.color=color;
 const asset=$('customInspector').dataset.asset||'';if(asset)presentation.asset=asset;
 const kind=$('customKind').value;
 return {
  kind,baseSlot:base,presentation,
  enabled:Boolean($('customEnabled').checked),
  trusted:Boolean($('customTrusted').checked),
  fields:{
   macApp:$('customMacApp').value||$('customMacApp').dataset.pending||'',
   macShortcut:$('customMacShortcut').value,
   macSystem:$('customMacSystem').value,
   macHotkeyKey:$('customMacHotkeyKey').value,
   mods:['cmd','shift','alt','ctrl'].filter(m=>$('customMod'+m[0].toUpperCase()+m.slice(1)).checked),
   appUrl:$('customAppUrl').value,
   url:$('customUrl').value,
   shell:$('customShell').value,
   script:$('customScript').value,
   cwd:$('customCwd').value,
   timeout:$('customTimeout').value,
   maxOutput:$('customMaxOutput').value,
   target:$('customTarget').value,
   text:$('customText').value,
   submit:Boolean($('customSubmit').checked),
   chord:$('customChord').value,
   mapping:$('customMapping').value
  }
 };
}
function copyEditingSlot(){
 if(!canEditDeck()||editingSlot===null)return;
 copiedSlotClipboard=snapshotEditorClipboard();
 if($('pasteSlotBtn'))$('pasteSlotBtn').disabled=false;
 layoutMessage('키 '+String(editingSlot+1).padStart(2,'0')+' 설정을 복사했습니다. 다른 키에서 붙여넣기하세요.');
}
function pasteToEditingSlot(){
 if(!canEditDeck()||editingSlot===null||!copiedSlotClipboard)return;
 const candidate=beginDeckCandidate();
 const clip=copiedSlotClipboard;
 $('customLabel').value=clip.presentation.label||'';
 $('customSymbol').value=clip.presentation.symbol||'';
 $('customColor').value=clip.presentation.color||'';
 $('customInspector').dataset.asset=clip.presentation.asset||'';
 $('customImage').value='';
 if(clip.presentation.asset&&!candidate.assets.includes(clip.presentation.asset))candidate.assets.push(clip.presentation.asset);
 $('customKind').value=clip.kind;
 if(clip.kind==='builtin'){
  const val=JSON.stringify(clip.baseSlot);
  if([...$('keyAssignment').options].some(o=>o.value===val))$('keyAssignment').value=val;
  else $('keyAssignment').value=JSON.stringify({type:'empty'});
 }
 $('customMacApp').dataset.pending=clip.fields.macApp||'';
 $('customMacShortcut').value=clip.fields.macShortcut||'';
 $('customMacSystem').value=clip.fields.macSystem||'volume-up';
 $('customMacHotkeyKey').value=clip.fields.macHotkeyKey||'c';
 for(const m of ['cmd','shift','alt','ctrl'])$('customMod'+m[0].toUpperCase()+m.slice(1)).checked=clip.fields.mods.includes(m);
 $('customAppUrl').value=clip.fields.appUrl||'';
 $('customUrl').value=clip.fields.url||'';
 $('customShell').value=clip.fields.shell||'bash';
 $('customScript').value=clip.fields.script||'';
 $('customCwd').value=clip.fields.cwd||'';
 $('customTimeout').value=clip.fields.timeout||'30000';
 $('customMaxOutput').value=clip.fields.maxOutput||'65536';
 $('customTarget').value=clip.fields.target||'';
 $('customText').value=clip.fields.text||'';
 $('customSubmit').checked=Boolean(clip.fields.submit);
 $('customChord').value=clip.fields.chord||'';
 $('customMapping').value=clip.fields.mapping||'';
 $('customEnabled').checked=clip.enabled!==false;
 $('customTrusted').checked=clip.kind==='builtin'?true:(HIGH_RISK_CUSTOM_KINDS.has(clip.kind)?clip.trusted===true:true);
 renderMacCatalogOptions();
 syncCustomInspectorFields();
 notifyInspectorChange(180);
 layoutMessage('복사한 설정을 키 '+String(editingSlot+1).padStart(2,'0')+'에 불러왔습니다.');
}
async function clearEditingSlot(){
 if(!canEditDeck()||editingSlot===null)return;
 cancelAutoSave();
 const slotIndex=editingSlot,candidate=beginDeckCandidate(),page=candidate.layouts.find(p=>p.id===deckProfile);
 if(!page)return;
 const old=page.slots[slotIndex],clearingNav=['sessions','page'].includes(old?.type);
 page.slots[slotIndex]={type:'empty'};
 if(clearingNav)candidate.navigation=true;
 if(candidate.navigation){
  redrawDeck();await openKeyEditor(slotIndex);syncDeckLayoutToolbar();
  layoutMessage('초안에서 키 '+String(slotIndex+1).padStart(2,'0')+'을 비웠습니다. 연결을 준비한 뒤 배치 초안 저장을 누르세요.');
  return;
 }
 if(await persistDeckLayouts(candidate.layouts,false,candidate,{reason:'키 '+String(slotIndex+1).padStart(2,'0')+' 비우기'})){
  redrawDeck();await openKeyEditor(slotIndex);
  layoutMessage('키 '+String(slotIndex+1).padStart(2,'0')+'을 비웠습니다. 새 기능을 바로 선택하세요.');
 }
}
async function swapDeckSlots(fromIndex,toIndex){
 if(!canEditDeck()||!Number.isInteger(fromIndex)||!Number.isInteger(toIndex)||fromIndex<0||fromIndex>=15||toIndex<0||toIndex>=15||fromIndex===toIndex)return false;
 cancelAutoSave();
 const candidate=beginDeckCandidate(),page=candidate.layouts.find(p=>p.id===deckProfile);
 if(!page)return false;
 const tmp=page.slots[fromIndex];
 page.slots[fromIndex]=page.slots[toIndex];
 page.slots[toIndex]=tmp;
 if(editingSlot===fromIndex)editingSlot=toIndex;
 else if(editingSlot===toIndex)editingSlot=fromIndex;
 const pairLabel='키 '+String(fromIndex+1).padStart(2,'0')+' ↔ 키 '+String(toIndex+1).padStart(2,'0');
 if(candidate.navigation){
  redrawDeck();if(editingSlot!==null)await openKeyEditor(editingSlot);else syncDeckLayoutToolbar();
  layoutMessage('초안에서 '+pairLabel+' 위치를 바꿨습니다. 배치 초안 저장을 누르면 반영됩니다.');
  return true;
 }
 if(await persistDeckLayouts(candidate.layouts,false,candidate,{reason:pairLabel+' 맞바꾸기'})){
  redrawDeck();if(editingSlot!==null)await openKeyEditor(editingSlot);
  layoutMessage(pairLabel+' 위치를 바꿨습니다 · r'+layoutRevision);
  return true;
 }
 return false;
}
async function moveCurrentPage(delta){
 if(!canEditDeck())return;
 const candidate=beginDeckCandidate();
 const idx=candidate.layouts.findIndex(p=>p.id===deckProfile),nextIdx=idx+delta;
 if(idx<0||nextIdx<0||nextIdx>=candidate.layouts.length)return;
 const [page]=candidate.layouts.splice(idx,1);
 candidate.layouts.splice(nextIdx,0,page);
 if(candidate.navigation){
  redrawDeck();syncDeckLayoutToolbar();
  layoutMessage('초안에서 ‘'+page.name+'’ 페이지 순서를 변경했습니다. 배치 초안 저장을 누르면 반영됩니다.');
  return;
 }
 if(await persistDeckLayouts(candidate.layouts,false,candidate,{reason:'‘'+page.name+'’ 순서 변경'})){
  redrawDeck();
  layoutMessage('‘'+page.name+'’ 페이지 순서를 변경했습니다 · r'+layoutRevision);
 }
}
async function testCurrentCustomAction(){
 if(!canEditDeck()||editingSlot===null||demo)return;
 if($('customKind').value==='builtin'){layoutMessage('사용자 동작을 먼저 선택하세요.');return;}
 cancelAutoSave();
 const slotIndex=editingSlot;
 try{
  const candidate=beginDeckCandidate();
  const action=readCustomInspector(normalizeDeckSlot(JSON.parse($('keyAssignment').value||'{"type":"empty"}'),slotIndex),candidate);
  if(candidate.navigation){layoutMessage('페이지 이동 초안을 먼저 ‘배치 초안 저장’으로 반영한 뒤 테스트할 수 있습니다.');return;}
  if(!$('customEnabled').checked){const err=new Error('키 활성화가 꺼져 있어 테스트 실행할 수 없습니다.');err.focusId='customEnabled';throw err;}
  const currentCommitted=deckLayouts.find(p=>p.id===deckProfile)?.slots[slotIndex];
  const needsSave=captureEditorStateSignature()!==editorBaselineSignature||currentCommitted?.type!=='custom';
  candidate.layouts.find(page=>page.id===deckProfile).slots[slotIndex]=action;
  if(needsSave){
   const saved=await persistDeckLayouts(candidate.layouts,false,candidate,{reason:'동작 테스트 저장'});
   if(!saved)return;
   redrawDeck();
   for(const [i,key]of [...$('keys').querySelectorAll('button[data-key-id]')].entries())key.classList.toggle('configuring',i===slotIndex);
   if($('removeCustomAction'))$('removeCustomAction').hidden=false;
   editorBaselineSignature=captureEditorStateSignature();
   syncEditorActionLabels();
   updateKeyPreview();
  }
  const liveSlot=deckLayouts.find(p=>p.id===deckProfile)?.slots[slotIndex];
  if(!liveSlot||liveSlot.type!=='custom')throw new Error('저장된 사용자 동작을 찾지 못했습니다.');
  const prepared=await api('/api/actions/prepare',{actionId:liveSlot.actionId,revision:layoutRevision,pageId:deckProfile,slotIndex});
  const result=await api('/api/actions/invoke',prepared);
  if(result.runId){
   customRunStates.set(liveSlot.actionId,result);
   if($('customOutput'))$('customOutput').textContent='테스트 실행 시작 ('+(CUSTOM_RUN_TOAST_LABELS[result.state]||result.state)+')…';
   setTimeout(pollCustomRuns,120);setTimeout(pollCustomRuns,420);
  }
  layoutMessage('맥에서 테스트 실행 중 · 아래 출력 결과를 확인하세요.');
 }catch(error){
  focusValidationError(error);
  layoutMessage('테스트 실행 실패: '+error.message);
 }
}
function focusValidationError(error){
 if(!error?.focusId)return;
 const elTarget=$(error.focusId);
 if(!elTarget)return;
 const trustWrap=elTarget.closest('.custom-check');
 if(trustWrap)trustWrap.classList.add('is-attention');
 elTarget.scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
 elTarget.focus();
}
function mountCustomInspector(){
 const section=el('section');section.id='customInspector';
 const actionGroup=el('div',undefined,'custom-action-group');actionGroup.id='customActionGroup';
 actionGroup.append(el('h3','동작 상세 설정','custom-section-heading custom-section-action'));
 const field=(id,label,tag='input',parent=actionGroup)=>{const wrapper=el('label',label),control=el(tag);control.id=id;wrapper.append(control);parent.append(wrapper);return control;};
 const checkField=(id,label,checked=false,parent=actionGroup)=>{const wrapper=el('label',undefined,'custom-check'),box=el('input');box.type='checkbox';box.id=id;box.checked=checked;wrapper.append(box,el('span',label));parent.append(wrapper);return box;};
 const kind=field('customKind','실행 종류','select',actionGroup);
 kind.append(Object.assign(el('option','사용 안 함 (위 기본 기능 사용)'),{value:'builtin'}));
 for(const [groupLabel,items]of CUSTOM_KIND_GROUPS){const grp=el('optgroup');grp.label=groupLabel;for(const [value,label]of items){const option=el('option',label);option.value=value;grp.append(option);}kind.append(grp);}
 const warning=el('p','신뢰할 수 있는 동작만 등록하세요. 연결된 기기에서 이 키를 누르면 이 맥의 사용자 권한으로 실행됩니다.','custom-trust-warning');actionGroup.append(warning);
 const appSearch=field('customMacAppSearch','앱 검색');appSearch.type='search';appSearch.placeholder='예: Safari, Obsidian, Slack';appSearch.oninput=renderMacCatalogOptions;
 const appSelect=field('customMacApp','설치된 macOS 앱','select');
 appSelect.onchange=()=>{
  const opt=appSelect.selectedOptions[0];
  if(!appSelect.value){notifyInspectorChange(150);return;}
  applyAutoPresentation(opt?.dataset?.name||'');
  updateKeyPreview();
  void importMacAppIcon(appSelect.value);
 };
 const catalogActions=el('div',undefined,'custom-inline-row');catalogActions.id='customMacCatalogActions';
 const importIconBtn=el('button','아이콘 다시 가져오기','custom-inline-btn');importIconBtn.id='importMacAppIcon';importIconBtn.type='button';importIconBtn.onclick=()=>importMacAppIcon($('customMacApp').value,{manual:true});
 const refreshCatalogBtn=el('button','목록 새로고침','custom-inline-btn');refreshCatalogBtn.id='refreshMacCatalog';refreshCatalogBtn.type='button';refreshCatalogBtn.onclick=()=>ensureMacCatalog(true);
 catalogActions.append(importIconBtn,refreshCatalogBtn);actionGroup.append(catalogActions);
 const shortcutSelect=field('customMacShortcutSelect','설치된 macOS 단축어','select');
 shortcutSelect.onchange=()=>{
  if(!shortcutSelect.value)return;
  $('customMacShortcut').value=shortcutSelect.value;
  applyAutoPresentation(shortcutSelect.value,'shortcut');
  notifyInspectorChange(180);
 };
 const shortcutInput=field('customMacShortcut','단축어 이름 (직접 입력 가능)');shortcutInput.placeholder='예: 작업 환경 열기';shortcutInput.oninput=()=>notifyInspectorChange(280);
 const systemSelect=field('customMacSystem','시스템·미디어 동작','select');
 for(const item of MAC_SYSTEM_ITEMS){const option=el('option',item.name+' · '+item.detail);option.value=item.action;option.dataset.name=item.name;option.dataset.symbol=item.symbol;systemSelect.append(option);}
 systemSelect.onchange=()=>{
  const opt=systemSelect.selectedOptions[0];
  if(opt)applyAutoPresentation(opt.dataset.name,opt.dataset.symbol||'app');
  notifyInspectorChange(150);
 };
 const hotkeyPreset=field('customMacHotkeyPreset','단축키 프리셋 (선택)','select');
 hotkeyPreset.append(Object.assign(el('option','자주 쓰는 단축키 선택'),{value:''}));
 for(const preset of MAC_HOTKEY_PRESET_ITEMS){const option=el('option',preset.label);option.value=JSON.stringify(preset);hotkeyPreset.append(option);}
 hotkeyPreset.onchange=()=>{
  if(!hotkeyPreset.value)return;
  const preset=JSON.parse(hotkeyPreset.value);
  $('customMacHotkeyKey').value=preset.key;
  for(const mod of ['cmd','shift','alt','ctrl'])$('customMod'+mod[0].toUpperCase()+mod.slice(1)).checked=preset.modifiers.includes(mod);
  applyAutoPresentation(preset.label,'keyboard');
  notifyInspectorChange(150);
 };
 const recorderRow=el('div',undefined,'custom-recorder-row');recorderRow.id='customMacHotkeyRecorderRow';
 const recordBtn=el('button','단축키 눌러서 입력','custom-inline-btn record-hotkey-btn');recordBtn.id='recordMacHotkey';recordBtn.type='button';recordBtn.setAttribute('aria-pressed','false');
 recordBtn.onclick=()=>setHotkeyRecording(!hotkeyRecording);
 recorderRow.append(recordBtn);actionGroup.append(recorderRow);
 const hotkeyKey=field('customMacHotkeyKey','전송할 키','select');
 for(const k of MAC_HOTKEY_KEY_ITEMS){const option=el('option',k.length===1?k.toUpperCase():k);option.value=k;hotkeyKey.append(option);}
 hotkeyKey.onchange=()=>notifyInspectorChange(150);
 const modFieldset=el('fieldset');modFieldset.id='customMacHotkeyMods';modFieldset.append(el('legend','보조 키'));
 const modGrid=el('div',undefined,'custom-mod-grid');
 for(const [mod,label]of [['cmd','⌘ Command'],['shift','⇧ Shift'],['alt','⌥ Option'],['ctrl','⌃ Control']]){
  const wrap=el('label'),box=el('input');box.type='checkbox';box.id='customMod'+mod[0].toUpperCase()+mod.slice(1);box.onchange=()=>notifyInspectorChange(150);
  wrap.append(box,document.createTextNode(label));modGrid.append(wrap);
 }
 modFieldset.append(modGrid);actionGroup.append(modFieldset);
 const hotkeyNote=el('p','macOS 손쉬운 사용(Accessibility) 및 자동화(System Events) 권한이 필요하며, 실행 시 현재 활성 창에 키 입력을 전송합니다.','custom-permission-note');hotkeyNote.id='customMacHotkeyNote';actionGroup.append(hotkeyNote);
 const appUrlPreset=field('customAppUrlPreset','앱 URL 프리셋 (선택)','select');
 appUrlPreset.append(Object.assign(el('option','자주 쓰는 앱 URL 선택'),{value:''}));
 for(const preset of MAC_APP_URL_PRESET_ITEMS){const option=el('option',preset.label+' ('+preset.url+')');option.value=JSON.stringify(preset);appUrlPreset.append(option);}
 appUrlPreset.onchange=()=>{
  if(!appUrlPreset.value)return;
  const preset=JSON.parse(appUrlPreset.value);
  $('customAppUrl').value=preset.url;
  applyAutoPresentation(preset.label,'link');
  notifyInspectorChange(150);
 };
 const appUrlInput=field('customAppUrl','앱 URL 스킴 (http/https 외)');appUrlInput.type='text';appUrlInput.placeholder='raycast:// 또는 obsidian://open';appUrlInput.autocomplete='off';appUrlInput.oninput=()=>notifyInspectorChange(300);
 const hostUrlInput=field('customUrl','HTTP/HTTPS URL');hostUrlInput.type='url';hostUrlInput.placeholder='https://example.com';hostUrlInput.oninput=()=>notifyInspectorChange(300);
 const shell=field('customShell','명시적 인터프리터','select');for(const value of ['bash','zsh','powershell','cmd']){const option=el('option',value);option.value=value;shell.append(option);}shell.onchange=()=>updateKeyPreview();
 const scriptEl=field('customScript','신뢰한 스크립트','textarea');scriptEl.oninput=()=>updateKeyPreview();
 const cwdEl=field('customCwd','기존 절대 작업 폴더');cwdEl.oninput=()=>updateKeyPreview();
 const timeout=field('customTimeout','최대 실행 시간 (밀리초)');timeout.type='number';timeout.value='30000';timeout.oninput=()=>updateKeyPreview();
 const outputLimit=field('customMaxOutput','최대 출력 크기 (바이트)');outputLimit.type='number';outputLimit.value='65536';outputLimit.oninput=()=>updateKeyPreview();
 const target=field('customTarget','정확한 수신기 ID (창 제목·현재 포커스 불가)');target.oninput=()=>updateKeyPreview();
 const textEl=field('customText','리터럴 텍스트','textarea');textEl.oninput=()=>updateKeyPreview();
 const submit=checkField('customSubmit','텍스트 뒤 Enter 제출',false);submit.onchange=()=>updateKeyPreview();
 const chordEl=field('customChord','단축키');chordEl.oninput=()=>updateKeyPreview();
 const mappingEl=field('customMapping','검증된 수신기 매핑 ID');mappingEl.oninput=()=>updateKeyPreview();
 const enabled=checkField('customEnabled','키 활성화 (해제하면 실행 차단)',true);enabled.onchange=()=>notifyInspectorChange(150);
 const trusted=checkField('customTrusted','이 맥의 사용자 권한으로 실행됨을 확인하고 등록합니다',false);
 trusted.onchange=()=>{const w=trusted.closest('.custom-check');if(w)w.classList.remove('is-attention');updateKeyPreview();};
 const qualification=el('p','sessionText/단축키는 정확한 ID·epoch·유휴 상태를 확인하는 검증된 수신기가 없으면 차단됩니다. 전역 키 입력으로 우회하지 않습니다.','custom-permission-note');qualification.id='customQualificationNote';actionGroup.append(qualification);
 const capability=el('p','호스트 실행 기능 확인 중…','custom-capabilities');capability.id='customCapabilities';capability.setAttribute('role','status');actionGroup.append(capability);
 const targets=el('datalist');targets.id='customReceiverIds';actionGroup.append(targets);target.setAttribute('list',targets.id);
 api('/api/actions/capabilities').then(caps=>{
  if(!deckLocal)return;
  const available=Array.isArray(caps.shellKinds)?caps.shellKinds:[],receivers=Array.isArray(caps.receivers)?caps.receivers:[];
  const parts=['macOS 제어: '+(caps.macControl?'가능':'불가')];
  if(available.length)parts.push('셸: '+available.join(', '));
  parts.push('URL: '+((caps.hostUrl||caps.appUrl)?'가능':'불가'));
  if(receivers.length)parts.push('수신기: '+receivers.join(', '));
  capability.textContent=parts.join(' · ');
  for(const option of shell.options){option.disabled=!available.includes(option.value);option.title=option.disabled?'이 호스트에서 사용할 수 없는 인터프리터':'';}
  for(const option of kind.options){if(['macApp','macShortcut','macSystem','macHotkey'].includes(option.value)){option.disabled=caps.macControl===false;option.title=option.disabled?'macOS 호스트에서만 사용할 수 있습니다':'';}}
  for(const id of receivers){const option=el('option');option.value=id;targets.append(option);}
 }).catch(()=>{capability.textContent='호스트 실행 기능을 확인하지 못했습니다.';});
 const actionBar=el('div',undefined,'custom-action-bar');actionBar.id='customActionBar';
 const testBtn=el('button','맥에서 테스트 실행','custom-test-btn');testBtn.id='testCustomAction';testBtn.type='button';testBtn.onclick=()=>void testCurrentCustomAction();
 const remove=el('button','등록된 동작 삭제','custom-danger-btn');remove.type='button';remove.id='removeCustomAction';
 actionBar.append(testBtn,remove);actionGroup.append(actionBar);
 const output=el('pre');output.id='customOutput';output.setAttribute('aria-live','polite');actionGroup.append(output);
 const cancelRun=el('button','실행 중지 (되돌리기 아님)','custom-danger-btn');cancelRun.id='cancelCustomRun';cancelRun.type='button';cancelRun.hidden=true;cancelRun.onclick=async()=>{const id=currentDeckLayout().slots[editingSlot]?.actionId,run=customRunStates.get(id);if(run)try{await api('/api/actions/cancel/'+run.runId,{});await pollCustomRuns();}catch(error){layoutMessage('취소 실패: '+error.message);}};actionGroup.append(cancelRun);

 const presGroup=el('div',undefined,'custom-presentation-group');presGroup.id='customPresentationGroup';
 presGroup.append(el('h3','키캡 모양','custom-section-heading'));
 const topGrid=el('div',undefined,'presentation-top-grid');
 const previewCard=el('div',undefined,'key-preview-card');previewCard.id='keyPreviewCard';
 const previewTile=el('div',undefined,'key-preview-tile');previewTile.id='keyPreviewTile';previewTile.setAttribute('aria-hidden','true');
 previewCard.append(previewTile);
 const topFields=el('div',undefined,'presentation-top-fields');
 const previewMeta=el('div',undefined,'key-preview-meta');
 const previewName=el('strong','빈 키');previewName.id='keyPreviewName';
 const previewSub=el('span','기본 기능');previewSub.id='keyPreviewSub';
 previewMeta.append(previewName,previewSub);
 topFields.append(previewMeta);
 const labelInput=field('customLabel','표시 이름 (최대 48자)','input',topFields);labelInput.maxLength=48;labelInput.placeholder='비우면 기본 이름 사용';labelInput.oninput=()=>notifyInspectorChange(280);
 topGrid.append(previewCard,topFields);
 presGroup.append(topGrid);
 const pairRow=el('div',undefined,'custom-pair-row');presGroup.append(pairRow);
 const symbols=field('customSymbol','기호','select',pairRow);
 for(const symbol of ['',...DECK_SYMBOLS]){const option=el('option',symbol?(DECK_SYMBOL_LABELS[symbol]||symbol):'기본 기호');option.value=symbol;symbols.append(option);}
 symbols.onchange=()=>notifyInspectorChange(150);
 const colorLabel=el('label','배경색 (#RRGGBB)');
 const colorWrap=el('span',undefined,'color-input-wrap');
 const colorSwatch=el('span',undefined,'color-swatch');colorSwatch.id='customColorSwatch';colorSwatch.setAttribute('aria-hidden','true');
 const colorPicker=el('input');colorPicker.type='color';colorPicker.id='customColorPicker';colorPicker.tabIndex=-1;colorPicker.setAttribute('aria-label','배경색 선택기');colorPicker.value='#315a82';
 colorPicker.oninput=()=>{colorInput.value=colorPicker.value;notifyInspectorChange(200);};
 colorSwatch.append(colorPicker);
 const colorInput=el('input');colorInput.id='customColor';colorInput.placeholder='#315a82';colorInput.oninput=()=>notifyInspectorChange(280);
 colorInput.onblur=()=>{const normalized=normalizeHexColor(colorInput.value);if(normalized!==colorInput.value)colorInput.value=normalized;notifyInspectorChange(120);};
 colorWrap.append(colorSwatch,colorInput);colorLabel.append(colorWrap);pairRow.append(colorLabel);
 const presets=el('div',undefined,'color-preset-row');presets.id='customColorPresets';presets.setAttribute('role','group');presets.setAttribute('aria-label','추천 키 색상');
 for(const preset of COLOR_PRESET_ITEMS){
  const chip=el('button',undefined,'color-preset-chip'+(preset.value?'':' is-default'));chip.type='button';chip.tabIndex=-1;chip.dataset.color=preset.value;chip.title=preset.label;chip.setAttribute('aria-label',preset.label+(preset.value?' ('+preset.value+')':''));
  if(preset.value)chip.style.setProperty('--chip-color',preset.value);else chip.textContent='×';
  chip.onclick=()=>{colorInput.value=preset.value;notifyInspectorChange(120);};
  presets.append(chip);
 }
 presGroup.append(presets);
 const imageBlock=el('div',undefined,'custom-image-block');presGroup.append(imageBlock);
 const upload=field('customImage','이미지 (PNG/JPEG/WebP, 1MiB 이하)','input',imageBlock);upload.type='file';upload.accept='image/png,image/jpeg,image/webp';
 const imageBar=el('div',undefined,'custom-image-bar');
 const removeImage=el('button','이미지 제거','custom-ghost-btn');removeImage.id='removeCustomImage';removeImage.type='button';
 const imageStatus=el('span','선택된 이미지 없음','custom-image-status');imageStatus.id='customImageStatus';
 removeImage.onclick=()=>{customEditorGeneration++;macIconGeneration++;macIconInFlight=false;const hadAsset=Boolean(section.dataset.asset||upload.value);section.dataset.asset='';upload.value='';notifyInspectorChange(120);if(!hadAsset&&$('customImageStatus'))$('customImageStatus').textContent='제거할 이미지가 없습니다';};
 imageBar.append(removeImage,imageStatus);imageBlock.append(imageBar);
 async function stageCustomImageFile(file){
  if(!file||!deckCandidate||editingSlot===null)return;
  if(file.size>1048576){layoutMessage('업로드 실패: 최대 1MiB입니다.');return;}
  const candidate=deckCandidate,slot=editingSlot,page=deckProfile,generation=deckGeneration,editor=customEditorGeneration;
  const currentState=()=>deckCandidate===candidate&&editingSlot===slot&&deckProfile===page&&deckGeneration===generation&&customEditorGeneration===editor;
  let stagedOk=false;
  upload.disabled=true;
  try{
   const response=await fetch('/api/assets/upload',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file}),data=await response.json();
   if(!currentState())return;
   if(!response.ok)throw Error(data.error);
   if(!candidate.assets.includes(data.id))candidate.assets.push(data.id);
   section.dataset.asset=data.id;
   stagedOk=true;
   layoutMessage(canAutoSaveCurrentSlot()?'이미지 준비 완료 · 잠시 후 자동 반영됩니다.':'이미지 준비 완료 · 저장을 누르세요.');
  }catch(error){
   if(currentState())layoutMessage('업로드 실패: '+error.message);
  }finally{
   upload.disabled=false;updateKeyPreview();
   if(stagedOk&&currentState()&&editorBaselineSignature!==''&&canAutoSaveCurrentSlot())scheduleAutoSave(450);
  }
 }
 upload.onchange=()=>{if(upload.files[0])void stageCustomImageFile(upload.files[0]);};
 imageBlock.ondragover=e=>{if(!deckLocal||editingSlot===null)return;e.preventDefault();imageBlock.classList.add('is-dragover');};
 imageBlock.ondragleave=()=>imageBlock.classList.remove('is-dragover');
 imageBlock.ondrop=e=>{imageBlock.classList.remove('is-dragover');if(!deckLocal||editingSlot===null)return;const file=e.dataTransfer?.files?.[0];if(!file)return;e.preventDefault();void stageCustomImageFile(file);};

 kind.onchange=()=>{
  const value=kind.value;
  if(value==='builtin'){
   try{if(JSON.parse($('keyAssignment').value||'{}').type==='custom')$('keyAssignment').value=JSON.stringify({type:'empty'});}catch{}
  }
  if(HIGH_RISK_CUSTOM_KINDS.has(value)){
   const currentSlot=currentDeckLayout()?.slots[editingSlot];
   const existingDef=(deckCandidate?.actions||deckActions).find(a=>a.id===currentSlot?.actionId)?.definition;
   trusted.checked=existingDef?.kind===value;
  }else{
   trusted.checked=true;
  }
  syncCustomInspectorFields();
  if(value==='macApp'&&!section.dataset.asset)applyAutoPresentation('','app');
  else if(value==='macSystem'){const opt=$('customMacSystem').selectedOptions[0];if(opt)applyAutoPresentation(opt.dataset.name,opt.dataset.symbol||'app');}
  else if(value==='macHotkey'){if(!$('customMacHotkeyKey').value)$('customMacHotkeyKey').value='c';if(!['cmd','shift','alt','ctrl'].some(m=>$('customMod'+m[0].toUpperCase()+m.slice(1)).checked))$('customModCmd').checked=true;applyAutoPresentation('','keyboard');}
  else if(value==='appUrl'||value==='hostUrl')applyAutoPresentation('','link');
  else if(value==='macShortcut')applyAutoPresentation('','shortcut');
  if(HIGH_RISK_CUSTOM_KINDS.has(value)){cancelAutoSave();updateKeyPreview();}
  else notifyInspectorChange(220);
 };
 remove.onclick=()=>{
  const candidate=beginDeckCandidate(),slot=currentDeckLayout().slots[editingSlot];
  if(slot.type!=='custom')return;
  if(candidate.layouts.some(page=>page.slots.some((other,i)=>other.type==='custom'&&other.actionId===slot.actionId&&(page.id!==deckProfile||i!==editingSlot)))){
   layoutMessage('삭제 차단: 다른 키에서 이 동작을 참조합니다. 먼저 해당 키를 직접 변경하세요.');return;
  }
  cancelAutoSave();
  kind.value='builtin';section.dataset.asset='';upload.value='';labelInput.value='';symbols.value='';colorInput.value='';macAutoLabel='';macAutoSymbol='';
  trusted.checked=true;
  syncCustomInspectorFields();
  $('keyAssignment').value=JSON.stringify({type:'empty'});
  updateKeyPreview();
  layoutMessage('동작 삭제 준비됨 · 저장을 누르면 반영됩니다.');
 };

 section.append(actionGroup,presGroup);
 $('keyEditor').insertBefore(section,$('saveAssignment').parentElement);
 syncCustomInspectorFields();
}
function loadCustomInspector(slot){
 if(!$('customInspector'))return;
 customEditorGeneration++;macIconGeneration++;macIconInFlight=false;macAutoLabel='';macAutoSymbol='';setHotkeyRecording(false);
 const presentation=slot.presentation||{},action=(deckCandidate?.actions||deckActions).find(action=>action.id===slot.actionId),definition=action?.definition;
 $('customLabel').value=presentation.label||'';$('customSymbol').value=presentation.symbol||'';$('customColor').value=presentation.color||'';$('customInspector').dataset.asset=presentation.asset||'';$('customImage').value='';
 $('customKind').value=definition?.kind||'builtin';
 $('customMacAppSearch').value='';
 $('customMacApp').dataset.pending=definition?.kind==='macApp'?(definition.appPath||''):'';
 $('customMacShortcut').value=definition?.kind==='macShortcut'?(definition.name||''):'';
 $('customMacSystem').value=definition?.kind==='macSystem'?(definition.action||'volume-up'):'volume-up';
 $('customMacHotkeyPreset').value='';
 $('customMacHotkeyKey').value=definition?.kind==='macHotkey'?(definition.key||'c'):'c';
 const mods=definition?.kind==='macHotkey'&&Array.isArray(definition.modifiers)?definition.modifiers:[];
 for(const mod of ['cmd','shift','alt','ctrl'])$('customMod'+mod[0].toUpperCase()+mod.slice(1)).checked=mods.includes(mod);
 $('customAppUrlPreset').value='';
 $('customAppUrl').value=definition?.kind==='appUrl'?(definition.url||''):'';
 renderMacCatalogOptions();
 const loadedKind=definition?.kind||'builtin';
 $('customUrl').value=definition?.kind==='hostUrl'?(definition.url||''):'';$('customShell').value=definition?.shellKind||'bash';$('customScript').value=definition?.script||'';$('customCwd').value=definition?.cwd||'';$('customTimeout').value=definition?.executionPolicy?.timeoutMs||30000;$('customTarget').value=definition?.targetRef||'';$('customText').value=definition?.literalText||'';$('customSubmit').checked=definition?.submit===true;$('customChord').value=definition?.chord||'';$('customMapping').value=definition?.qualifiedMapping||'';$('customEnabled').checked=action?.enabled!==false;$('customTrusted').checked=HIGH_RISK_CUSTOM_KINDS.has(loadedKind)?!!definition:true;$('removeCustomAction').hidden=!action;
 $('customMaxOutput').value=definition?.executionPolicy?.maxOutputBytes??65536;
 syncCustomInspectorFields();
 $('customOutput').textContent='';$('customOutput').dataset.runKey='';$('cancelCustomRun').hidden=true;pollCustomRuns();
}
function readCustomInspector(base,candidate){
 if(!$('customInspector'))return base;
 const normalizedColor=normalizeHexColor($('customColor').value);
 if($('customColor').value.trim()&&normalizedColor!==$('customColor').value)$('customColor').value=normalizedColor;
 const presentation={};
 const labelVal=$('customLabel').value;if(labelVal)presentation.label=labelVal;
 const symbolVal=$('customSymbol').value;if(symbolVal)presentation.symbol=symbolVal;
 if(normalizedColor)presentation.color=normalizedColor;
 if($('customInspector').dataset.asset)presentation.asset=$('customInspector').dataset.asset;
 try{validatePresentation(presentation);}catch(error){if(String(error.message).includes('색상'))error.focusId='customColor';else if(String(error.message).includes('이름'))error.focusId='customLabel';throw error;}
 const kind=$('customKind').value;let slot=base;
 if(kind!=='builtin'){
  const fail=(msg,focusId)=>{const err=new Error(msg);err.focusId=focusId;throw err;};
  if(HIGH_RISK_CUSTOM_KINDS.has(kind)&&!$('customTrusted').checked)fail('신뢰한 사용자 권한 실행 위험을 확인하세요.','customTrusted');
  let definition;
  if(kind==='hostUrl'){
   const url=$('customUrl').value.trim();
   if(!url)fail('HTTP 또는 HTTPS 주소를 입력하세요.','customUrl');
   definition={kind,url};
  }else if(kind==='appUrl'){
   const url=$('customAppUrl').value.trim();
   if(!url)fail('앱 URL 스킴을 입력하세요.','customAppUrl');
   if(/^(?:https?|file|javascript|data|vbscript|blob|about):/i.test(url))fail('http/https는 호스트 URL을 사용하고, file/javascript/data 스킴은 허용되지 않습니다.','customAppUrl');
   try{new URL(url);}catch{fail('유효한 앱 URL 스킴을 입력하세요 (예: raycast://).','customAppUrl');}
   definition={kind,url};
  }else if(kind==='macApp'){
   const appPath=$('customMacApp').value.trim();
   if(!appPath)fail('실행할 macOS 앱을 선택하세요.','customMacApp');
   definition={kind,appPath};
  }else if(kind==='macShortcut'){
   const name=$('customMacShortcut').value.trim();
   if(!name)fail('실행할 단축어 이름을 입력하세요.','customMacShortcut');
   definition={kind,name};
  }else if(kind==='macSystem'){
   const action=$('customMacSystem').value;
   if(!action)fail('시스템 제어 동작을 선택하세요.','customMacSystem');
   definition={kind,action};
  }else if(kind==='macHotkey'){
   const key=$('customMacHotkeyKey').value;
   const modifiers=['cmd','shift','alt','ctrl'].filter(m=>$('customMod'+m[0].toUpperCase()+m.slice(1)).checked);
   if(!key)fail('전송할 키를 선택하세요.','customMacHotkeyKey');
   definition={kind,key,modifiers};
  }else if(kind==='hostProcess'){
   definition={kind,shellKind:$('customShell').value,script:$('customScript').value,cwd:$('customCwd').value,executionPolicy:{timeoutMs:Number($('customTimeout').value),maxOutputBytes:Number($('customMaxOutput').value)}};
  }else if(kind==='sessionText'){
   definition={kind,targetRef:$('customTarget').value,literalText:$('customText').value,submit:$('customSubmit').checked};
  }else{
   definition={kind,targetRef:$('customTarget').value,chord:$('customChord').value,qualifiedMapping:$('customMapping').value};
  }
  const previous=currentDeckLayout().slots[editingSlot],id=previous.type==='custom'?previous.actionId:'action-'+crypto.randomUUID();
  candidate.actions=candidate.actions.filter(action=>action.id!==id);candidate.actions.push({id,enabled:$('customEnabled').checked,definition});slot={type:'custom',actionId:id};
  if(!presentation.symbol&&!presentation.asset){const fallbackSymbol=customActionDefaultSymbol(definition);if(fallbackSymbol&&fallbackSymbol!=='terminal')presentation.symbol=fallbackSymbol;}
 }
 return Object.keys(presentation).length?{...slot,presentation}:slot;
}
const CUSTOM_RUN_TOAST_LABELS={running:'실행 시작',handoff:'전달 완료',exit:'실행 완료',blocked:'실행 차단',unavailable:'사용 불가',unknown:'상태 미확인',cancelling:'취소 중'};
async function invokeCustomAction(slot,index){
 if(deckLocal||demo){toast('PC 미리보기에서는 실행하지 않습니다.'+(deckLocal?' 우클릭해 편집하거나 설정 창에서 테스트 실행하세요.':''));return;}
 if(document.hidden||!navigator.onLine||sending){toast('오프라인 또는 다른 실행 중입니다. 대기열에 넣지 않았습니다.');return;}
 const press=++customPress,revision=layoutRevision,pageId=deckProfile,generation=deckGeneration,view=deckView,cursor=JSON.stringify(deckCursor());let attempted=false;
 sending=true;
 try{
  const prepared=await api('/api/actions/prepare',{actionId:slot.actionId,revision,pageId,slotIndex:index});
  if(press!==customPress||document.hidden||revision!==layoutRevision||pageId!==deckProfile||generation!==deckGeneration||view!==deckView||cursor!==JSON.stringify(deckCursor())||!navigator.onLine)throw Error('화면 문맥이 바뀌어 실행을 취소했습니다.');
  attempted=true;const result=await api('/api/actions/invoke',prepared);if(result.runId){customRunStates.set(slot.actionId,result);if(['running','cancelling'].includes(result.state)){setTimeout(pollCustomRuns,100);setTimeout(pollCustomRuns,300);}}toast('동작 '+(CUSTOM_RUN_TOAST_LABELS[result.state]||result.state)+' · 자동 재시도하지 않습니다.');redrawDeck();
 }catch(error){toast(attempted?'실행 결과 미확인/차단 · 자동 재시도하지 않습니다.':error.message);}
 finally{sending=false;}
}
document.addEventListener('visibilitychange',()=>{if(document.hidden)customPress++;});
window.addEventListener('offline',()=>{customPress++;});
window.addEventListener('blur',()=>{customPress++;});
window.addEventListener('pagehide',()=>{customPress++;});
let lastCustomDetailKey='',customPollIdleTick=0;
async function pollCustomRuns(){
 if(customPolling||document.hidden||!navigator.onLine||demo||layoutRevision===null)return;
 customPolling=true;
 try{
  const before=JSON.stringify([...customRunStates]);
  if(deckLocal){for(const run of await api('/api/actions/runs'))customRunStates.set(run.actionId,run);}
  else for(const [id,run]of customRunStates)if(['running','cancelling'].includes(run.state)){try{customRunStates.set(id,await api('/api/actions/status/'+run.runId));}catch{customRunStates.set(id,{...run,state:'unknown'});}}
  if(before!==JSON.stringify([...customRunStates]))redrawDeck();
  if(deckLocal&&editingSlot!==null&&$('customOutput')){
   const slot=currentDeckLayout().slots[editingSlot],run=customRunStates.get(slot?.actionId);
   if(run){
    const settled=!['running','cancelling'].includes(run.state),cacheKey=run.runId+':'+run.state;
    if(!settled||$('customOutput').dataset.runKey!==cacheKey||lastCustomDetailKey!==cacheKey){
     const detail=await api('/api/actions/status/'+run.runId);
     const permHint=/1002|not allowed|not authorized|assistive/i.test(detail.stderr||'')?'안내: macOS 시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용 및 자동화(System Events) 권한을 허용하세요.':'';
     const text=[customRunPresentation(detail).detail,detail.stdout,detail.stderr,permHint,detail.outputTruncated?'출력 한도 도달':''].filter(Boolean).join('\n');
     if($('customOutput').textContent!==text)$('customOutput').textContent=text;
     $('customOutput').dataset.runKey=cacheKey;
     lastCustomDetailKey=cacheKey;
    }
    $('cancelCustomRun').hidden=settled;
   }
  }
 }catch{
  // Keep the last receipt as historical data, not an apparently live success.
  if(deckLocal&&$('customOutput'))$('customOutput').textContent='실행 상태 조회 실패 · 마지막 결과는 현재 상태를 보장하지 않습니다. 자동 재실행하지 않습니다.';
 }
 finally{customPolling=false;}
}
setInterval(()=>{if(!deckLocal||editingSlot!==null||[...customRunStates.values()].some(r=>['running','cancelling'].includes(r.state))||((customPollIdleTick=(customPollIdleTick+1)%3)===0))pollCustomRuns();},1000);
async function openKeyEditor(index){
 if(!canEditDeck()||!Number.isInteger(index)||index<0||index>=15)return;
 if(editingSlot!==null&&editingSlot!==index&&canAutoSaveCurrentSlot()&&isEditorDirty())await flushAutoSave();
 cancelAutoSave();
 beginDeckCandidate();cancelDeckInput();
 editingSlot=index;if(!deckLocal)modal=true;const layout=currentDeckLayout(),select=$('keyAssignment');select.replaceChildren();
 $('editorSlot').textContent='키 '+String(index+1).padStart(2,'0')+' / 15';
 const groups=[['페이지·도구',[['에이전트 페이지',{type:'page',page:'agents'}],['선택한 에이전트 응답 페이지',{type:'page',page:'response'}],['요청 원문 보기',{type:'context'}],['상태 새로고침',{type:'refresh'}],['빈 키',{type:'empty'}]]],['에이전트 자동 배치',Array.from({length:15},(_,i)=>['이 페이지의 '+(i+1)+'번째 에이전트',{type:'auto-agent',index:i}])],['특정 에이전트',(current?.agents||[]).map(a=>[a.label+' · '+a.pane_id,{type:'agent',pane:a.pane_id}])],['응답 선택지',Array.from({length:9},(_,i)=>['선택지 '+(i+1),{type:'choice',key:String(i+1)}])],['키 전송',DECK_KEY_ACTIONS.map(key=>[key,{type:'key',key}])]];
 groups[0][1]=[['전체 세션 뱅크',{type:'sessions'}],...editorLayouts().map(p=>[p.name+' 페이지',{type:'page',page:p.id}]),...groups[0][1].filter(([,value])=>value.type!=='page')];
 for(const [label,items] of groups){const group=el('optgroup');group.label=label;for(const [name,value] of items){const option=el('option',name);option.value=JSON.stringify(value);group.append(option);}select.append(group);}
 for(const [name,value] of [['Codex 쿼터',{type:'quota',provider:'codex'}],['Antigravity 쿼터',{type:'quota',provider:'agy'}],['쿼터 페이지',{type:'page',page:'quota'}]]){const option=el('option',name);option.value=JSON.stringify(value);select.append(option);}
 const {presentation,...baseSlot}=layout.slots[index];const value=JSON.stringify(baseSlot);
 if(![...select.options].some(o=>o.value===value)){const missing=el('option',baseSlot.type==='custom'?'사용자 동작 (아래 설정 사용)':'연결되지 않은 에이전트');missing.value=value;select.append(missing);}
 select.value=value;
 editorBaselineSignature='';
 loadCustomInspector(layout.slots[index]);
 editorBaselineSignature=captureEditorStateSignature();
 updateEditorHintCopy();
 syncEditorActionLabels();
 updateKeyPreview();
 select.onchange=()=>{
  const action=JSON.parse(select.value);
  if(['sessions','page'].includes(action.type)){
   cancelAutoSave();updateEditorHintCopy();syncEditorActionLabels();updateKeyPreview();
   const report=deckGraphDiagnostics(editorLayouts(),[{from:layout.id,...action}]).deficits.find(p=>p.pageId===layout.id);
   layoutMessage(layout.name+' · 선택 연결 '+(action.page||'전체 세션')+' · 빈 키 '+report.empty+'개 · 필요한 빈 키 추가 '+report.additionalEmpty+'개'+(layout.slots[index].type!=='empty'&&JSON.stringify(action)!==value?' · 차단: 이 키를 먼저 직접 비우세요.':''));
   return;
  }
  notifyInspectorChange(150);
 };
 for(const error of $('keyEditor').querySelectorAll('.layout-error'))error.textContent='';
 if(!$('keyEditor').open)$('keyEditor').show();
 if($('editorEmpty'))$('editorEmpty').hidden=true;
 if($('actionCatalog'))$('actionCatalog').hidden=true;
 if($('editorSettings')&&window.innerWidth<=1200)$('editorSettings').scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
 for(const [i,key] of [...$('keys').querySelectorAll('button[data-key-id]')].entries())key.classList.toggle('configuring',i===index);
 ($('customKind')?.value==='builtin'?select:$('customKind')).focus();
}
async function closeKeyEditor(flush=true){
 if(flush&&editingSlot!==null&&canAutoSaveCurrentSlot()&&isEditorDirty())await flushAutoSave();
 cancelAutoSave();
 customEditorGeneration++;macIconGeneration++;macIconInFlight=false;setHotkeyRecording(false);editorBaselineSignature='';const index=editingSlot;if($('keyEditor').open)$('keyEditor').close();editingSlot=null;
 if(deckCandidate&&!deckCandidate.navigation&&!deckCandidate.error&&JSON.stringify(deckCandidate.layouts)===JSON.stringify(deckLayouts)&&JSON.stringify(deckCandidate.actions)===JSON.stringify(deckActions)&&JSON.stringify(deckCandidate.assets)===JSON.stringify(deckAssets)){deckCandidate=null;syncDeckLayoutToolbar();}
 if(typeof syncModalState==='function')syncModalState();else modal=Boolean(document.querySelector?.('dialog:modal'));
 syncEditorEmpty();
 for(const key of $('keys').querySelectorAll('.configuring'))key.classList.remove('configuring');
 if(index!==null&&deckLocal&&deckEditing)$('keys').querySelectorAll('button[data-key-id]')[index]?.focus();
}
function openDeckRequest(){
 const content=$('requestContent');if(!content){toast('표시할 요청이 없습니다.');return;}
 const dialog=$('requestDetail'),copy=content.cloneNode(true);copy.removeAttribute('id');$('requestDetailContent').replaceChildren(copy);
 modal=true;dialog.showModal();
}
$('showDeckRequest').onclick=openDeckRequest;
$('closeDeckRequest').onclick=()=>$('requestDetail').close();
$('requestDetail').addEventListener('close',()=>{if(typeof syncModalState==='function')syncModalState();else modal=false;});
function decorateCustomKey(button,presentation){
 if(!presentation)return button;
 if(presentation.label){const name=button.querySelector('.key-name');if(name)name.textContent=presentation.label;button.setAttribute('aria-label',presentation.label+' · '+button.getAttribute('aria-label'));}
 if(presentation.symbol){const previous=button.querySelector('.key-symbol,.agent-logo');if(previous)previous.replaceWith(icon(presentation.symbol,'key-symbol'));}
 if(presentation.color){button.classList.add('custom-color');button.style.setProperty('--custom-key-color',presentation.color);}
 if(presentation.asset){const image=el('img');image.className='custom-key-image';image.alt='';image.src='/api/assets/'+presentation.asset;button.prepend(image);if(!presentation.symbol)button.classList.add('has-custom-asset');}
 return button;
}
function customActionDefaultSymbol(definition){
 if(!definition)return 'terminal';
 if(definition.kind==='macApp')return 'app';
 if(definition.kind==='macShortcut')return 'shortcut';
 if(definition.kind==='macSystem')return MAC_SYSTEM_ITEMS.find(x=>x.action===definition.action)?.symbol||'app';
 if(definition.kind==='macHotkey')return 'keyboard';
 if(definition.kind==='appUrl'||definition.kind==='hostUrl')return 'link';
 return 'terminal';
}
function customRunPresentation(run){
 if(!run)return null;
 const failed=['blocked','unknown','unavailable','spawn-error','timeout','output-limit'].includes(run.state)||run.state==='exit'&&(run.exitCode!==0||!!run.signal)||run.state==='handoff'&&(!!run.signal||run.exitCode!==null&&run.exitCode!==undefined&&run.exitCode!==0);
 const detail=[failed?(['exit','handoff'].includes(run.state)?'실패':'실패 · '+run.state):run.state,Number.isInteger(run.exitCode)?'exit '+run.exitCode:'',run.signal?'signal '+run.signal:''].filter(Boolean).join(' · ');
 return {detail,cls:failed?'state-unknown':run.state==='exit'||run.state==='handoff'?'state-done':''};
}
function renderDeckKey(slot,index,a,agents,available){
 if(slot.type==='quota'&&!deckEditing&&typeof quotaView!=='undefined')return decorateCustomKey(quotaView.key(slot.provider,'slot:'+deckProfile+':'+index),slot.presentation);
 const editAction=()=>void openKeyEditor(index);let spec={id:'slot:'+deckProfile+':'+index,name:'빈 키',symbol:deckLocal&&deckEditing?'plus':null,cls:'empty-slot',disabled:true},stateAgent;
 if(['auto-agent','agent'].includes(slot.type)){
  const raw=slot.target||deckAgentForSlot(slot,agents,0),x=deckView==='reason'&&raw?{...raw,pane_id:raw.id,label:raw.name||raw.label,agent_status:raw.status==='busy'?'working':raw.status||'unknown'}:raw;stateAgent=x;
  if(x){
   const st=x.agent_status||'unknown';
   const detailLabel=online||demo?(statuses[st]||st):'오프라인';
   spec={...spec,name:x.label,detail:detailLabel,symbol:agentIconName(x.agent),corner:String(agents.findIndex(t=>(t.pane_id||t.id)===x.pane_id)+1).padStart(2,'0'),cls:'session state-'+(online||demo?st:'offline')+' '+(x.pane_id===selectedPane?'selected':''),disabled:!online&&!demo&&deckView!=='reason',label:x.label+' · '+(names[x.agent]||x.agent)+' · '+detailLabel+' · '+(deckLocal?'미리보기':deckView==='reason'?'읽기 전용':'PC 작업 창 및 응답 페이지 열기'),click:()=>deckView==='reason'?chooseNetwork(x.pane_id):choose(x.pane_id)};
  }
  else if(slot.type==='agent')spec={...spec,name:'연결 안 됨',symbol:'terminal',cls:'disconnected-slot',label:'지정한 에이전트가 연결되지 않았습니다'};
  else spec={...spec,name:'빈 슬롯',symbol:deckLocal&&deckEditing?'plus':null,cls:'empty-slot',label:'연결된 에이전트 없음'};
 }else if(slot.type==='choice'){
  const opt=a?.choices?.find(x=>x.key===slot.key);spec={...spec,name:opt?.label||(a?.agent_status==='working'?'작업 중':'선택지 대기'),number:slot.key,symbol:null,cls:'option '+(opt&&available?'available':''),disabled:!available||!opt,label:opt?'선택지 '+opt.key+' · '+opt.label:'선택지 '+slot.key+' 대기 중',click:()=>ask(a,slot.key,slot.key+' · '+opt?.label)};
 }else if(slot.type==='key'){
  const keyNames={enter:'Enter',up:'위로',down:'아래로',left:'왼쪽',right:'오른쪽',tab:'Tab',esc:'Esc'};spec={...spec,name:keyNames[slot.key],symbol:slot.key,cls:'utility '+(slot.key==='enter'?'enter':''),disabled:!available,label:keyNames[slot.key]+' 키 전송',click:()=>ask(a,slot.key,keyNames[slot.key])};
 }else if(slot.type==='sessions')spec={...spec,name:'전체 세션',detail:agents.length+'개 · 12개씩',symbol:'network',cls:'',disabled:false,click:enterSessionBank};
 else if(slot.type==='return')spec={...spec,name:'돌아가기',symbol:'enter',cls:'',disabled:false,click:leaveSessionBank};
 else if(slot.type==='previous'||slot.type==='next')spec={...spec,name:slot.type==='previous'?'이전 세션 페이지':'다음 세션 페이지',detail:currentDeckLayout().name,symbol:slot.type==='previous'?'left':'right',cls:'',disabled:slot.disabled,click:()=>stepSessionBank(slot.type==='previous'?-1:1)};
 else if(slot.type==='page'){
  const pending=slot.page==='agents'&&deckProfile!=='agents'&&!deckEditing&&(online||demo)?agents.filter(x=>x.pane_id!==selectedPane&&x.agent_status==='blocked').length:0;
  spec={...spec,name:(typeof editorLayouts==='function'?editorLayouts():deckLayouts).find(p=>p.id===slot.page)?.name||'없는 페이지',detail:pending?'확인 대기 '+pending:slot.page==='response'?(a?.label||'에이전트 선택'):slot.page==='quota'?'잔여율 · 터치 상세':slot.page==='agents'?'전체 세션':'페이지 이동',symbol:slot.page==='agents'?'network':'enter',cls:pending?'pending-sessions':'',label:pending?'에이전트 전체 세션 · 다른 패널 확인 대기 '+pending+'개':undefined,disabled:false,click:()=>setDeckProfile(slot.page)};
 }
 else if(slot.type==='refresh')spec={...spec,name:'새로고침',symbol:'refresh',cls:'',disabled:false,click:()=>deckView==='native'?(typeof refreshNative==='function'&&refreshNative(true)):deckView==='reason'?refreshNetwork(true):demo?toast('미리보기입니다.'):refresh(true)};
 else if(slot.type==='context')spec={...spec,name:'요청 보기',symbol:'context',cls:'',disabled:false,click:openDeckRequest};
 else if(slot.type==='quota')spec={...spec,name:slot.provider==='codex'?'Codex 쿼터':'Antigravity 쿼터',symbol:'quota',cls:''};
 else if(slot.type==='custom'){const action=(deckCandidate?.actions||deckActions).find(action=>action.id===slot.actionId),run=customRunStates.get(slot.actionId),busy=run&&['running','cancelling'].includes(run.state),status=customRunPresentation(run);spec={...spec,name:'사용자 동작',detail:status?status.detail:action?.enabled?(deckLocal?'실행 없는 미리보기':'저장된 동작 실행'):'비활성화',cls:status?.cls||'',symbol:customActionDefaultSymbol(action?.definition),disabled:!action?.enabled||(!deckLocal&&busy),click:()=>invokeCustomAction(slot,index)};}
 if(deckLocal&&deckEditing){spec={...spec,disabled:false,click:editAction,label:'키 '+(index+1)+' 편집 · '+spec.name,corner:String(index+1).padStart(2,'0'),cls:(spec.cls||'')+' editable'+(editingSlot===index?' configuring':'')};}
 const previewInert=deckLocal&&!deckEditing&&spec.disabled;
 if(previewInert){spec={...spec,disabled:false,click:undefined,cls:(spec.cls||'')+' preview-inert',label:(spec.label||spec.name)+' · 우클릭으로 편집'};}
 const b=keyButton(spec);
 if(stateAgent){b.setAttribute('aria-pressed',String(stateAgent.pane_id===selectedPane));b.append(el('i',undefined,'key-dot '+stateAgent.agent_status));}
 return decorateCustomKey(b,slot.presentation);
}
$('deckProfile').onchange=()=>setDeckProfile($('deckProfile').value);
$('editDeck').onclick=async()=>{
 if(!canEditDeck())return;
 await closeKeyEditor(true);
 cancelDeckInput();
 if(deckCursor().kind==='sessions')leaveSessionBank();
 deckEditing=!deckEditing;
 userExitedEditMode=!deckEditing;
 redrawDeck();
 syncDeckLayoutToolbar();
};
$('keys').addEventListener('contextmenu',event=>{
 if(!deckLocal||!canEditDeck())return;
 const keys=[...$('keys').querySelectorAll('button[data-key-id]')];
 const button=event.target.closest?.('button[data-key-id]')||document.elementFromPoint(event.clientX,event.clientY)?.closest?.('#keys button[data-key-id]')||keys.find(k=>{const r=k.getBoundingClientRect();return event.clientX>=r.left&&event.clientX<=r.right&&event.clientY>=r.top&&event.clientY<=r.bottom;});
 if(!button)return;
 const index=keys.indexOf(button);
 if(index<0||index>=15)return;
 event.preventDefault();
 cancelDeckInput();
 if(deckCursor().kind==='sessions')leaveSessionBank();
 if(!deckEditing){deckEditing=true;userExitedEditMode=false;redrawDeck();syncDeckLayoutToolbar();}
 void openKeyEditor(index);
});
function clearDeckDragClasses(){
 for(const k of $('keys').querySelectorAll('.drag-source,.drag-over'))k.classList.remove('drag-source','drag-over');
}
document.addEventListener('dragstart',event=>{
 if(event.target?.closest?.('.catalog-item')&&catalogDragState)clearCatalogDragState();
},true);
$('keys').addEventListener('dragover',event=>{
 if(!deckLocal||!canEditDeck())return;
 const types=event.dataTransfer?.types;
 if(!types||(!types.includes('Files')&&!types.includes('application/x-agent-deck-catalog')))return;
 event.preventDefault();
 if(event.dataTransfer)event.dataTransfer.dropEffect='copy';
 const target=findKeyButtonAtPoint(event.clientX,event.clientY);
 for(const k of $('keys').querySelectorAll('button[data-key-id]'))k.classList.toggle('drag-over',k===target);
});
$('keys').addEventListener('dragleave',event=>{
 if(event.relatedTarget&&$('keys').contains(event.relatedTarget))return;
 for(const k of $('keys').querySelectorAll('.drag-over'))k.classList.remove('drag-over');
});
$('keys').addEventListener('drop',event=>{
 for(const k of $('keys').querySelectorAll('.drag-over'))k.classList.remove('drag-over');
 if(!deckLocal||!canEditDeck())return;
 const keys=[...$('keys').querySelectorAll('button[data-key-id]')];
 const target=findKeyButtonAtPoint(event.clientX,event.clientY);
 const index=target?keys.indexOf(target):-1;
 if(index<0||index>=15)return;
 const files=event.dataTransfer?.files;
 if(files?.length){
  const image=[...files].find(f=>/^image\/(png|jpeg|webp)$/i.test(f.type)||/\.(png|jpe?g|webp)$/i.test(f.name||''));
  event.preventDefault();
  if(!image){layoutMessage('PNG, JPEG, WebP 이미지 파일만 키에 놓을 수 있습니다.');return;}
  void dropImageFileOnSlot(image,index);
  return;
 }
 const raw=event.dataTransfer?.getData('application/x-agent-deck-catalog');
 if(raw){
  event.preventDefault();
  try{void applyCatalogItemToSlot(JSON.parse(raw),index);}catch{}
 }
});
$('keys').addEventListener('pointerdown',event=>{
 if(!deckLocal||!deckEditing||!canEditDeck()||!event.isPrimary||event.button!==0)return;
 const button=event.target.closest('button[data-key-id]');
 if(!button)return;
 const index=[...$('keys').querySelectorAll('button[data-key-id]')].indexOf(button);
 if(index<0||index>=15)return;
 const rect=button.getBoundingClientRect();
 deckDragState={pointerId:event.pointerId,fromIndex:index,startX:event.clientX,startY:event.clientY,startRect:{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom},active:false,overIndex:null};
},true);
document.addEventListener('pointermove',event=>{
 if(catalogDragState&&event.pointerId===catalogDragState.pointerId){
  if(!deckLocal||!canEditDeck()){clearCatalogDragState();return;}
  const dx=event.clientX-catalogDragState.startX,dy=event.clientY-catalogDragState.startY;
  if(!catalogDragState.active&&Math.hypot(dx,dy)>10)catalogDragState.active=true;
  if(catalogDragState.active){
   const keys=[...$('keys').querySelectorAll('button[data-key-id]')];
   const target=findKeyButtonAtPoint(event.clientX,event.clientY);
   const overIndex=target?keys.indexOf(target):-1;
   catalogDragState.overIndex=overIndex>=0?overIndex:null;
   for(const [i,k]of keys.entries())k.classList.toggle('drag-over',i===catalogDragState.overIndex);
  }
  return;
 }
 if(!deckDragState||event.pointerId!==deckDragState.pointerId)return;
 if(!deckLocal||!deckEditing){deckDragState=null;clearDeckDragClasses();return;}
 const dx=event.clientX-deckDragState.startX,dy=event.clientY-deckDragState.startY,r=deckDragState.startRect;
 const outside=event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom;
 if(!deckDragState.active&&outside&&Math.hypot(dx,dy)>10){
  deckDragState.active=true;
  const fromBtn=$('keys').querySelectorAll('button[data-key-id]')[deckDragState.fromIndex];
  if(fromBtn)fromBtn.classList.add('drag-source');
 }
 if(!deckDragState.active)return;
 const target=document.elementFromPoint(event.clientX,event.clientY)?.closest?.('#keys button[data-key-id]');
 const keys=[...$('keys').querySelectorAll('button[data-key-id]')];
 const overIndex=target?keys.indexOf(target):-1;
 deckDragState.overIndex=overIndex>=0&&overIndex!==deckDragState.fromIndex?overIndex:null;
 for(const [i,k]of keys.entries())k.classList.toggle('drag-over',i===deckDragState.overIndex);
},true);
document.addEventListener('pointerup',event=>{
 if(catalogDragState&&event.pointerId===catalogDragState.pointerId){
  const state=catalogDragState;clearCatalogDragState();
  if(state.active){
   catalogClickDragged=true;
   setTimeout(()=>{catalogClickDragged=false;},0);
   const keys=[...$('keys').querySelectorAll('button[data-key-id]')];
   const target=findKeyButtonAtPoint(event.clientX,event.clientY);
   const dropIdx=target?keys.indexOf(target):(state.overIndex??-1);
   if(dropIdx>=0&&dropIdx<15&&deckLocal&&canEditDeck())void applyCatalogItemToSlot(state.item,dropIdx);
  }
  return;
 }
 if(!deckDragState||event.pointerId!==deckDragState.pointerId)return;
 const state=deckDragState;deckDragState=null;
 clearDeckDragClasses();
 if(state.active&&state.overIndex!==null&&state.overIndex!==state.fromIndex&&deckLocal&&deckEditing){
  void swapDeckSlots(state.fromIndex,state.overIndex);
 }
},true);
document.addEventListener('pointercancel',event=>{
 if(catalogDragState&&event.pointerId===catalogDragState.pointerId)clearCatalogDragState();
 if(deckDragState&&event.pointerId===deckDragState.pointerId){deckDragState=null;clearDeckDragClasses();}
},true);
window.addEventListener('blur',()=>{
 if(deckDragState){deckDragState=null;clearDeckDragClasses();}
 if(catalogDragState)clearCatalogDragState();
});
$('saveAssignment').onclick=async()=>{
 if(!canEditDeck()||editingSlot===null)return;
 cancelAutoSave();
 try{
  if(canAutoSaveCurrentSlot()&&!isEditorDirty()){await closeKeyEditor(false);redrawDeck();return;}
  const candidate=beginDeckCandidate(),action=readCustomInspector(normalizeDeckSlot(JSON.parse($('keyAssignment').value),editingSlot),candidate),old=currentDeckLayout().slots[editingSlot],navigation=['sessions','page'].includes(action.type)&&(old.type!==action.type||old.page!==action.page);
  if(navigation&&old.type!=='empty'&&(old.type!==action.type||old.page!==action.page)){if($('occupiedSlotHint'))$('occupiedSlotHint').hidden=false;layoutMessage('저장 실패: '+currentDeckLayout().name+' 키 '+(editingSlot+1)+'이 사용 중입니다. 필요한 빈 키 1개를 직접 준비하세요.');return;}
  if(navigation)candidate.navigation=true;
  candidate.layouts.find(page=>page.id===deckProfile).slots[editingSlot]=action;
  if(candidate.navigation){await closeKeyEditor(false);layoutMessage('초안에 반영했습니다. 진입·복귀 연결을 준비하고 배치 초안 저장을 누르세요.');redrawDeck();}
  else if(await persistDeckLayouts(candidate.layouts,false,candidate,{reason:'키 '+String(editingSlot+1).padStart(2,'0')+' 저장'})){await closeKeyEditor(false);redrawDeck();}
 }catch(error){focusValidationError(error);layoutMessage('저장 실패: '+error.message);}
};
$('cancelAssignment').onclick=()=>void closeKeyEditor(false);
$('keyEditor').addEventListener('cancel',()=>{void closeKeyEditor(true);});
document.addEventListener('keydown',event=>{
 if(hotkeyRecording){
  event.preventDefault();event.stopImmediatePropagation();
  const hasMods=event.metaKey||event.shiftKey||event.altKey||event.ctrlKey;
  if(event.code==='Escape'&&!hasMods){setHotkeyRecording(false);layoutMessage('단축키 입력을 취소했습니다.');return;}
  if(['Meta','Shift','Alt','Control'].includes(event.key)||/^(Meta|Shift|Alt|Control)(Left|Right)$/.test(event.code)){
   const live=[event.metaKey?'⌘':'',event.shiftKey?'⇧':'',event.altKey?'⌥':'',event.ctrlKey?'⌃':''].filter(Boolean).join('');
   if($('recordMacHotkey'))$('recordMacHotkey').textContent=(live?live+' + ':'')+'키를 누르세요… (Esc 취소)';
   return;
  }
  const mapped=mapCodeToMacHotkeyKey(event.code);
  if(!mapped||!MAC_HOTKEY_KEY_ITEMS.includes(mapped)){
   layoutMessage('지원하는 키(A–Z, 0–9, 방향키, F1–F12, Space, Tab, Enter, Delete, Esc)를 누르세요.');
   return;
  }
  $('customMacHotkeyKey').value=mapped;
  $('customModCmd').checked=event.metaKey;
  $('customModShift').checked=event.shiftKey;
  $('customModAlt').checked=event.altKey;
  $('customModCtrl').checked=event.ctrlKey;
  setHotkeyRecording(false);
  applyAutoPresentation('단축키 ('+formatMacHotkeyChord()+')','keyboard');
  notifyInspectorChange(180);
  layoutMessage('단축키 '+formatMacHotkeyChord()+' 입력 완료');
  return;
 }
 if(deckLocal&&!modal&&!document.querySelector('dialog:modal')&&(event.metaKey||event.ctrlKey)&&!event.altKey&&event.key.toLowerCase()==='z'){
  const tag=document.activeElement?.tagName;
  if(!tag||!['INPUT','SELECT','TEXTAREA'].includes(tag)&&!document.activeElement?.isContentEditable){
   event.preventDefault();
   if(event.shiftKey)void redoDeckChange();else void undoDeckChange();
   return;
  }
 }
 if(deckLocal&&!modal&&!document.querySelector('dialog:modal')&&(event.metaKey||event.ctrlKey)&&!event.shiftKey&&!event.altKey&&event.key.toLowerCase()==='y'){
  const tag=document.activeElement?.tagName;
  if(!tag||!['INPUT','SELECT','TEXTAREA'].includes(tag)&&!document.activeElement?.isContentEditable){
   event.preventDefault();
   void redoDeckChange();
   return;
  }
 }
 if(event.key==='Escape'&&deckLocal&&editingSlot!==null&&!document.querySelector('dialog:modal')){event.preventDefault();void closeKeyEditor(true);return;}
 if(deckLocal&&editingSlot!==null&&!document.querySelector('dialog:modal')&&(event.metaKey||event.ctrlKey)&&event.key==='Enter'){event.preventDefault();$('saveAssignment').click();return;}
 if(deckLocal&&!modal&&!document.querySelector('dialog:modal')&&!event.metaKey&&!event.ctrlKey&&!event.altKey&&(event.key==='e'||event.key==='E')){
  const tag=document.activeElement?.tagName;
  if(!tag||!['INPUT','SELECT','TEXTAREA'].includes(tag)&&!document.activeElement?.isContentEditable){event.preventDefault();$('editDeck').click();}
 }
},true);
function openPageModal(mode){
 pageEditorMode=mode;
 const isRename=mode==='rename';
 if($('pageEditorTitle'))$('pageEditorTitle').textContent=isRename?'페이지 이름 변경':'키 페이지 추가';
 const hint=$('pageEditor')?.querySelector('.hint');
 if(hint)hint.textContent=isRename?'현재 페이지의 표시 이름만 변경합니다. 키 배치와 이동 연결은 유지됩니다.':'새 페이지를 만들고 현재 페이지에서 오가는 이동 키를 자동으로 연결할 수 있습니다.';
 if($('autoLinkPageRow'))$('autoLinkPageRow').hidden=isRename;
 if($('autoLinkPage')&&!isRename)$('autoLinkPage').checked=true;
 const submitBtn=$('pageForm')?.querySelector('button[type="submit"]');
 if(submitBtn)submitBtn.textContent=isRename?'저장':'추가';
 $('pageName').value=isRename?(currentDeckLayout()?.name||''):'';
 modal=true;$('pageEditor').showModal();
 if(isRename)$('pageName').select();
}
$('addDeckPage').onclick=()=>{if(!canEditDeck())return;if(editorLayouts().length>=32){toast('페이지는 최대 32개까지 만들 수 있습니다.');return;}openPageModal('add');};
renameDeckPage.onclick=()=>{if(!canEditDeck())return;openPageModal('rename');};
movePageUp.onclick=()=>void moveCurrentPage(-1);
movePageDown.onclick=()=>void moveCurrentPage(1);
$('cancelPage').onclick=()=>{$('pageEditor').close();};
$('pageEditor').addEventListener('close',()=>{pageEditorMode='add';if(typeof syncModalState==='function')syncModalState();else modal=false;});
$('pageEditor').addEventListener('cancel',()=>{pageEditorMode='add';if(typeof syncModalState==='function')syncModalState();else modal=false;});
$('pageForm').onsubmit=async e=>{
 e.preventDefault();
 if(!canEditDeck())return;
 const name=$('pageName').value.trim().slice(0,32);if(!name)return;
 if(pageEditorMode==='rename'){
  const candidate=beginDeckCandidate(),page=candidate.layouts.find(p=>p.id===deckProfile);
  if(!page){$('pageEditor').close();return;}
  if(page.name===name){$('pageEditor').close();return;}
  page.name=name;$('pageEditor').close();
  if(candidate.navigation){redrawDeck();syncDeckLayoutToolbar();layoutMessage('초안에서 페이지 이름을 ‘'+name+'’(으)로 변경했습니다. 배치 초안 저장을 누르면 반영됩니다.');}
  else if(await persistDeckLayouts(candidate.layouts,false,candidate,{reason:'‘'+name+'’ 이름 변경'})){redrawDeck();layoutMessage('페이지 이름을 ‘'+name+'’(으)로 변경했습니다 · r'+layoutRevision);}
  return;
 }
 if(editorLayouts().length>=32)return;
 let id='custom-'+Date.now();while(editorLayouts().some(x=>x.id===id))id+='x';
 const autoLink=Boolean($('autoLinkPage')?.checked)&&!deckCandidate?.navigation;
 if(autoLink){
  const candidate=beginDeckCandidate(false);
  const srcPage=candidate.layouts.find(p=>p.id===deckProfile)||candidate.layouts[0];
  let entrySlot=-1;
  if(srcPage)for(let i=14;i>=0;i--)if(srcPage.slots[i].type==='empty'){entrySlot=i;break;}
  let entryPage=srcPage;
  if(entrySlot<0){
   for(const p of candidate.layouts){
    for(let i=14;i>=0;i--)if(p.slots[i].type==='empty'){entryPage=p;entrySlot=i;break;}
    if(entrySlot>=0)break;
   }
  }
  if(entryPage&&entrySlot>=0){
   entryPage.slots[entrySlot]={type:'page',page:id};
   const slots=Array.from({length:15},()=>({type:'empty'}));
   slots[14]={type:'page',page:entryPage.id};
   candidate.layouts.push({id,name,slots});
   const wasReady=deckGraphDiagnostics(deckLayouts,[]).ready;
   const diag=deckGraphDiagnostics(candidate.layouts,[]);
   if((!wasReady||diag.ready)&&!diag.unreachable.includes(id)&&!diag.noReturn.includes(id)){
    if(await persistDeckLayouts(candidate.layouts,false,candidate,{reason:'‘'+name+'’ 페이지 추가'})){
     $('pageEditor').close();
     setDeckProfile(id);if(deckLocal)deckEditing=!userExitedEditMode;redrawDeck();syncDeckLayoutToolbar();
     layoutMessage('‘'+name+'’ 페이지를 만들고 ‘'+entryPage.name+'’ 키 '+(entrySlot+1)+'과 자동 연결했습니다 · r'+layoutRevision);
    }
    return;
   }
  }
 }
 beginDeckCandidate(true).layouts.push({id,name,slots:Array.from({length:15},()=>({type:'empty'}))});
 $('pageEditor').close();
 setDeckProfile(id);deckEditing=true;userExitedEditMode=false;redrawDeck();syncDeckLayoutToolbar();
};
$('resetDeck').onclick=()=>{if(!canEditDeck())return;modal=true;$('resetTitle').textContent=defaultDeckLayouts().some(p=>p.id===deckProfile)?'이 페이지를 기본 배치로 되돌릴까요?':'이 페이지와 이 페이지를 향한 이동 키를 삭제할까요?';$('resetDialog').showModal();};
$('cancelReset').onclick=()=>{$('resetDialog').close();if(typeof syncModalState==='function')syncModalState();else modal=false;};$('resetDialog').addEventListener('cancel',()=>{if(typeof syncModalState==='function')syncModalState();else modal=false;});
$('confirmReset').onclick=async()=>{if(!canEditDeck())return;const candidate=beginDeckCandidate(),base=defaultDeckLayouts().find(x=>x.id===deckProfile);const next=base?candidate.layouts.map(x=>x.id===deckProfile?base:x):candidate.layouts.filter(x=>x.id!==deckProfile).map(p=>({...p,slots:p.slots.map(s=>s.type==='page'&&s.page===deckProfile?{type:'empty'}:s)}));if(await persistDeckLayouts(next,false,candidate,{reason:base?'페이지 기본 복원':'페이지 삭제'})){$('resetDialog').close();if(typeof syncModalState==='function')syncModalState();else modal=false;syncDefaultEditMode();redrawDeck();}};
$('refreshDeck').onclick=()=>deckView==='native'?(typeof refreshNative==='function'&&refreshNative(true)):deckView==='reason'?refreshNetwork(true):demo?toast('미리보기입니다.'):refresh(true);
