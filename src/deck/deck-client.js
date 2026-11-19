let deckLayouts=defaultDeckLayouts(),layoutRevision=null,layoutInitialized=false,layoutSaving=false,layoutLoading=false,layoutMessageGeneration=0,deckLocal=false;
let deckProfile='agents',deckEditing=false,editingSlot=null;
let deckCandidate=null,deckGeneration=0,selectedConnections=[];
let deckActions=[],deckAssets=[],customPress=0,customPolling=false,customEditorGeneration=0;
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
function applySharedLayout(data){
 if(!Number.isSafeInteger(data.revision)||data.revision<0||typeof data.initialized!=='boolean')throw Error('서버 배치 응답이 올바르지 않습니다.');
 if(data.revision!==layoutRevision){cancelDeckInput();deckGeneration++;}
 deckLayouts=validateDeckLayouts(data.layouts);layoutRevision=data.revision;layoutInitialized=data.initialized;
 deckActions=data.actions||[];deckAssets=data.assets||[];
 if(!editorLayouts().some(x=>x.id===deckProfile)){deckProfile=deckRoot();deckCursor().pageId=deckProfile;deckCursor().kind='authored';deckEditing=false;closeKeyEditor();toast('현재 페이지가 삭제되어 시작 페이지로 돌아왔습니다. 배치는 자동 수정하지 않았습니다.');}
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
async function persistDeckLayouts(next,importing=false,candidate=null){
 if(!canEditDeck(importing))return false;
 if(candidate?.navigation){const diagnostics=deckGraphDiagnostics(next,selectedConnections);if(!diagnostics.ready||diagnostics.deficits.some(p=>p.missing)){layoutMessage('저장 차단: 선택 연결 및 모든 페이지 진입·복귀와 전체 세션 진입 키를 직접 준비하세요.');return false;}}
 layoutSaving=true;
 layoutMessage('서버에 저장 중…');$('saveAssignment').disabled=true;
 try{
  validateDeckLayouts(next);
  const response=await fetch('/api/custom-layout',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({schemaVersion:1,revision:candidate?candidate.baseRevision:layoutRevision,layouts:next,actions:candidate?candidate.actions:deckActions,assets:candidate?candidate.assets:deckAssets})});
  const data=await response.json();if(!response.ok)throw Error(response.status===409?'다른 PC에서 배치가 변경되었습니다. 서버 다시 읽기 후 다시 편집하세요.':data.error||'저장 실패');
  if(candidate===deckCandidate)deckCandidate=null;
  applySharedLayout(data);layoutMessage('서버에 저장했습니다 · r'+data.revision);return true;
 }catch(error){if(candidate)candidate.error='저장 실패: '+error.message;layoutMessage(candidate?.error||'저장 실패: '+error.message);return false;}
 finally{layoutSaving=false;$('saveAssignment').disabled=false;}
}
function setDeckAccess(info){
 cancelDeckInput();deckLocal=info.local===true;document.body.classList.toggle('local',deckLocal);document.body.classList.toggle('remote',!deckLocal);
 if(deckLocal)mountLocalEditor();
 $('deckLayoutToolbar').hidden=!deckLocal;$('connectBtn').hidden=!deckLocal;
 if(!deckLocal){deckEditing=false;for(const id of ['keyEditor','pageEditor','resetDialog','connectDialog'])if($(id).open)$(id).close();editingSlot=null;}
 syncDeckLayoutToolbar();
}
const layoutStatus=el('span');layoutStatus.id='layoutStatus';layoutStatus.setAttribute('role','status');
const importLayout=el('button','이 브라우저 배치 가져오기');importLayout.className='deck-tool';importLayout.id='importLayout';
const initializeLayout=el('button','서버 기본 배치 사용');initializeLayout.className='deck-tool';initializeLayout.id='initializeLayout';
const reloadLayout=el('button','초안 버리고 서버 다시 읽기');reloadLayout.className='deck-tool';reloadLayout.id='reloadLayout';reloadLayout.onclick=()=>{if(!deckLocal||layoutSaving)return;cancelDeckInput();deckCandidate=null;deckEditing=false;closeKeyEditor();loadSharedLayouts(true);};
$('deckLayoutToolbar').append(importLayout,initializeLayout,reloadLayout,layoutStatus);
const saveCandidate=el('button','배치 초안 저장');saveCandidate.id='saveCandidate';saveCandidate.className='deck-tool';
saveCandidate.onclick=async()=>{if(!canEditDeck()||!deckCandidate)return;await persistDeckLayouts(deckCandidate.layouts,false,deckCandidate);};
const graphStatus=el('p');graphStatus.id='graphStatus';graphStatus.setAttribute('role','status');
const connectionPlan=el('select');connectionPlan.id='connectionPlan';connectionPlan.multiple=true;connectionPlan.setAttribute('aria-label','현재 페이지에 직접 준비할 연결');
connectionPlan.onchange=()=>{selectedConnections=selectedConnections.filter(c=>c.from!==deckProfile).concat([...connectionPlan.selectedOptions].map(o=>({from:deckProfile,...JSON.parse(o.value)})));syncDeckLayoutToolbar();};
$('deckLayoutToolbar').append(saveCandidate,el('label','현재 페이지에 준비할 연결 (복수 선택 가능)'),connectionPlan,graphStatus);
function mountLocalEditor(){
 if($('editorPages'))return;
 const workspace=document.querySelector('.workspace'),toolbar=$('deckLayoutToolbar');
 const title=el('h2','키 페이지');title.id='editorPagesTitle';
 const pages=el('nav');pages.id='editorPages';pages.setAttribute('aria-label','키 페이지 목록');
 toolbar.prepend(title,pages);workspace.prepend(toolbar);
 const settings=el('aside');settings.id='editorSettings';settings.setAttribute('aria-label','선택 키 설정');
 const empty=el('div');empty.id='editorEmpty';empty.append(el('h2','키 기능 변경'),el('p','키 편집을 켜고 미리보기에서 바꿀 키를 선택하세요.','hint'));
 settings.append(empty,$('keyEditor'));workspace.append(settings);
 const heading=el('div',undefined,'editor-preview-heading');heading.append(el('h2','덱 미리보기'),$('editDeck'),$('showDeckRequest'));
 document.querySelector('.bank-column').prepend(heading);
 $('keyEditor').querySelector('.hint').textContent='기능은 이 키에만 적용됩니다. 편집 중에는 에이전트에 입력을 보내지 않습니다.';
 mountCustomInspector();
}
importLayout.onclick=async()=>{if(layoutInitialized||!canEditDeck(true))return;try{const raw=legacyDeckLayout();if(!raw)throw Error('가져올 배치가 없습니다.');const next=validateDeckLayouts(JSON.parse(raw));if(await persistDeckLayouts(next,true))layoutMessage('기존 배치를 서버에 가져왔습니다. 브라우저 원본은 보존됩니다.');}catch(error){layoutMessage('가져오기 실패: '+error.message);}};
initializeLayout.onclick=()=>{if(!canEditDeck(true)||layoutInitialized)return;persistDeckLayouts(deckLayouts,true);};
setInterval(()=>loadSharedLayouts(),2000);
$('deckLayoutToolbar').hidden=true;$('connectBtn').hidden=true;
for(const id of ['keyEditor','pageEditor','resetDialog']){const error=el('p',undefined,'layout-error');error.setAttribute('role','alert');$(id).append(error);}
function redrawDeck(){renderSignature='';if(typeof nativeSignature!=='undefined')nativeSignature='';if(typeof networkSignature!=='undefined')networkSignature='';if(deckView==='native'&&typeof renderNative==='function')renderNative();else if(deckView==='reason'&&typeof renderNetwork==='function')renderNetwork();else if(current)render(current);}
function setDeckProfile(id){if(layoutSaving||!editorLayouts().some(x=>x.id===id))return;cancelDeckInput();deckGeneration++;closeKeyEditor();deckProfile=id;deckCursor().kind='authored';deckCursor().pageId=id;deckEditing=false;redrawDeck();}
function syncDeckLayoutToolbar(){
 const toolbar=$('deckLayoutToolbar');toolbar.hidden=!deckLocal;$('deckEditHint').hidden=!deckLocal||!deckEditing;
 importLayout.hidden=!deckLocal||layoutInitialized||!legacyDeckLayout();initializeLayout.hidden=!deckLocal||layoutInitialized;
 const layouts=editorLayouts(),diagnostics=deckGraphDiagnostics(layouts,selectedConnections);
 const planSignature=JSON.stringify([deckProfile,layouts.map(p=>[p.id,p.name])]);
 if(connectionPlan.dataset.signature!==planSignature){connectionPlan.replaceChildren();for(const [name,action] of [['전체 세션',{type:'sessions'}],...layouts.filter(p=>p.id!==deckProfile).map(p=>[p.name+' 페이지',{type:'page',page:p.id}])]){const option=el('option',name);option.value=JSON.stringify(action);option.selected=selectedConnections.some(c=>c.from===deckProfile&&c.type===action.type&&c.page===action.page);connectionPlan.append(option);}connectionPlan.dataset.signature=planSignature;}
 saveCandidate.hidden=!deckLocal||!deckCandidate;saveCandidate.disabled=layoutSaving;
 graphStatus.hidden=!deckLocal;graphStatus.textContent=diagnostics.ready?'탐색 준비 완료':('탐색 준비 필요 · 진입 불가: '+(diagnostics.unreachable.join(', ')||'없음')+' · 복귀 불가: '+(diagnostics.noReturn.join(', ')||'없음')+' · 전체 세션 진입 '+(diagnostics.missingSessions?'없음':'있음')+' · 자동 재배치하지 않습니다.');
 for(const deficit of diagnostics.deficits.filter(p=>p.missing)){graphStatus.textContent+=' / '+layouts.find(p=>p.id===deficit.pageId).name+': '+deficit.connections.map(c=>c.page||'전체 세션').join(', ')+' 연결 '+deficit.missing+'개 · 빈 키 '+deficit.empty+'개 · 추가 빈 키 '+deficit.additionalEmpty+'개';}
 if(deckCandidate?.error)layoutMessage(deckCandidate.error);
 const select=$('deckProfile');const signature=JSON.stringify(layouts.map(x=>[x.id,x.name]));
 if(select.dataset.signature!==signature){select.replaceChildren();for(const p of layouts){const option=el('option',p.name);option.value=p.id;select.append(option);}select.dataset.signature=signature;}
 select.value=deckProfile;$('editDeck').setAttribute('aria-pressed',String(deckEditing));$('editDeck').textContent=deckEditing?'편집 완료':'키 편집';$('resetDeck').textContent=defaultDeckLayouts().some(p=>p.id===deckProfile)?'기본 배치':'페이지 삭제';
 if(deckLocal&&$('editorPages')){
  const pages=$('editorPages');
  if(pages.dataset.signature!==signature){pages.replaceChildren();for(const p of layouts){const button=el('button',p.name,'editor-page');button.type='button';button.dataset.page=p.id;button.onclick=()=>setDeckProfile(p.id);pages.append(button);}pages.dataset.signature=signature;}
  for(const button of pages.children){if(button.dataset.page===deckProfile)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');}
  $('editorEmpty').hidden=editingSlot!==null;
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
let macCatalogState=null,macCatalogLoading=false,macIconGeneration=0,macAutoLabel='',macAutoSymbol='';
function applyAutoPresentation(labelText,symbolName){
 if(!$('customLabel')||!$('customSymbol'))return;
 if(labelText&&(!$('customLabel').value||$('customLabel').value===macAutoLabel)){$('customLabel').value=labelText;macAutoLabel=labelText;}
 if(symbolName!==undefined&&(!$('customSymbol').value||$('customSymbol').value===macAutoSymbol)){$('customSymbol').value=symbolName;macAutoSymbol=symbolName;}
}
function renderMacCatalogOptions(){
 if(!$('customMacApp'))return;
 const apps=macCatalogState?.apps||[],shortcuts=macCatalogState?.shortcuts||[];
 const query=($('customMacAppSearch')?.value||'').trim().toLowerCase();
 const appSelect=$('customMacApp'),currentApp=appSelect.dataset.pending??appSelect.value??'';
 const filtered=query?apps.filter(item=>item.name.toLowerCase().includes(query)||item.app.toLowerCase().includes(query)):apps;
 appSelect.replaceChildren();
 appSelect.append(Object.assign(el('option',apps.length?'-- macOS 앱 선택 --':(macCatalogLoading?'앱 목록 불러오는 중…':'앱 목록 없음 (새로고침)')),{value:''}));
 for(const item of filtered){const option=el('option',item.name+' ('+item.app+')');option.value=item.app;option.dataset.name=item.name;appSelect.append(option);}
 if(currentApp&&!filtered.some(item=>item.app===currentApp)){const preserved=apps.find(item=>item.app===currentApp);const option=el('option',(preserved?preserved.name+' · ':'저장된 앱: ')+currentApp);option.value=currentApp;option.dataset.name=preserved?.name||'';appSelect.append(option);}
 appSelect.value=currentApp;
 delete appSelect.dataset.pending;
 const shortcutSelect=$('customMacShortcutSelect'),currentShortcut=$('customMacShortcut')?.value||'';
 shortcutSelect.replaceChildren();
 shortcutSelect.append(Object.assign(el('option',shortcuts.length?'-- 단축어 목록에서 선택 --':(macCatalogLoading?'단축어 불러오는 중…':'단축어 목록 없음 (직접 입력 가능)')),{value:''}));
 for(const name of shortcuts){const option=el('option',name);option.value=name;shortcutSelect.append(option);}
 if(currentShortcut&&shortcuts.includes(currentShortcut))shortcutSelect.value=currentShortcut;
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
 }catch(error){
  if(force&&deckLocal)layoutMessage('macOS 목록 조회 실패: '+error.message);
 }finally{
  macCatalogLoading=false;renderMacCatalogOptions();
 }
}
async function importMacAppIcon(appPath,{manual=false}={}){
 const section=$('customInspector');
 if(!section||!deckCandidate||editingSlot===null||!appPath)return;
 const candidate=deckCandidate,slot=editingSlot,page=deckProfile,generation=deckGeneration,editor=customEditorGeneration,iconReq=++macIconGeneration;
 const current=()=>deckCandidate===candidate&&editingSlot===slot&&deckProfile===page&&deckGeneration===generation&&customEditorGeneration===editor&&macIconGeneration===iconReq&&$('customKind')?.value==='macApp'&&$('customMacApp')?.value===appPath;
 const btn=$('importMacAppIcon');
 if(btn)btn.disabled=true;
 try{
  const response=await fetch('/api/actions/mac-app-icon',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({appPath})});
  const data=await response.json();
  if(!current())return;
  if(!response.ok)throw Error(data.error||'아이콘을 가져오지 못했습니다.');
  if(!candidate.assets.includes(data.id))candidate.assets.push(data.id);
  section.dataset.asset=data.id;
  if($('customSymbol').value===macAutoSymbol){$('customSymbol').value='';macAutoSymbol='';}
  layoutMessage('앱 아이콘 준비 완료 · 키 저장 전에는 게시되지 않습니다.');
 }catch(error){
  if(!current())return;
  if(manual)layoutMessage('아이콘 가져오기 실패: '+error.message);
  else{
   if(!$('customSymbol').value||$('customSymbol').value===macAutoSymbol){$('customSymbol').value='app';macAutoSymbol='app';}
   layoutMessage('앱 선택 완료 · 아이콘을 찾지 못해 기본 기호를 사용합니다.');
  }
 }finally{
  if($('importMacAppIcon'))$('importMacAppIcon').disabled=false;
 }
}
function syncCustomInspectorFields(){
 const value=$('customKind').value,section=$('customInspector');
 if(!section)return;
 for(const [id,show]of [['customMacAppSearch',value==='macApp'],['customMacApp',value==='macApp'],['customMacShortcutSelect',value==='macShortcut'],['customMacShortcut',value==='macShortcut'],['customMacSystem',value==='macSystem'],['customMacHotkeyPreset',value==='macHotkey'],['customMacHotkeyKey',value==='macHotkey'],['customAppUrlPreset',value==='appUrl'],['customAppUrl',value==='appUrl'],['customUrl',value==='hostUrl'],['customShell',value==='hostProcess'],['customScript',value==='hostProcess'],['customCwd',value==='hostProcess'],['customTimeout',value==='hostProcess'],['customMaxOutput',value==='hostProcess'],['customTarget',['sessionText','keyCombo'].includes(value)],['customText',value==='sessionText'],['customSubmit',value==='sessionText'],['customChord',value==='keyCombo'],['customMapping',value==='keyCombo'],['customEnabled',value!=='builtin'],['customTrusted',value!=='builtin']])$(id).parentElement.hidden=!show;
 $('importMacAppIcon').hidden=value!=='macApp';
 $('refreshMacCatalog').hidden=!['macApp','macShortcut'].includes(value);
 $('customMacHotkeyMods').hidden=value!=='macHotkey';
 $('customMacHotkeyNote').hidden=value!=='macHotkey';
 section.querySelector('.custom-trust-warning').hidden=value==='builtin';
 $('customQualificationNote').hidden=!['sessionText','keyCombo'].includes(value);
 if(['macApp','macShortcut'].includes(value))void ensureMacCatalog(false);
}
function mountCustomInspector(){
 const section=el('section');section.id='customInspector';section.append(el('h3','키 모양 · 사용자 동작'));
 const field=(id,label,tag='input')=>{const wrapper=el('label',label),control=el(tag);control.id=id;wrapper.append(control);section.append(wrapper);return control;};
 field('customLabel','사용자 이름 (최대 48자)').maxLength=48;
 const symbols=field('customSymbol','내장 기호','select');for(const symbol of ['',...DECK_SYMBOLS]){const option=el('option',symbol||'기본 기호');option.value=symbol;symbols.append(option);}
 field('customColor','색상 (#RRGGBB, 비우면 기본)').placeholder='#315a82';
 const upload=field('customImage','정적 이미지 (PNG/JPEG/WebP · 최대 1MiB)');upload.type='file';upload.accept='image/png,image/jpeg,image/webp';
 const removeImage=el('button','이미지 제거');removeImage.id='removeCustomImage';removeImage.type='button';removeImage.onclick=()=>{customEditorGeneration++;macIconGeneration++;section.dataset.asset='';upload.value='';};section.append(removeImage);
 upload.onchange=async()=>{const file=upload.files[0];if(!file||!deckCandidate||editingSlot===null)return;if(file.size>1048576){layoutMessage('업로드 실패: 최대 1MiB입니다.');return;}const candidate=deckCandidate,slot=editingSlot,page=deckProfile,generation=deckGeneration,editor=customEditorGeneration;const current=()=>deckCandidate===candidate&&editingSlot===slot&&deckProfile===page&&deckGeneration===generation&&customEditorGeneration===editor;upload.disabled=true;try{const response=await fetch('/api/assets/upload',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file}),data=await response.json();if(!current())return;if(!response.ok)throw Error(data.error);if(!candidate.assets.includes(data.id))candidate.assets.push(data.id);section.dataset.asset=data.id;layoutMessage('이미지 준비 완료 · 키 저장 전에는 게시되지 않습니다.');}catch(error){if(current())layoutMessage('업로드 실패: '+error.message);}finally{upload.disabled=false;}};
 const kind=field('customKind','실행 종류','select');for(const [value,label]of [['builtin','기존 기능'],['macApp','macOS 앱 실행'],['macShortcut','macOS 단축어 실행'],['macSystem','macOS 시스템·미디어 제어'],['macHotkey','macOS 전역 단축키 (활성 창)'],['appUrl','앱 URL 스킴 열기 (raycast:// 등)'],['hostUrl','호스트에서 URL 열기'],['hostProcess','별도 호스트 프로세스'],['sessionText','정확한 유휴 세션에 텍스트'],['keyCombo','검증된 특정 수신기에 단축키']]){const option=el('option',label);option.value=value;kind.append(option);}
 const warning=el('p','신뢰한 코드만 등록하세요. 명령은 샌드박스 없이 PC 사용자 권한으로 파일·자격 증명·앱에 접근하며 되돌릴 수 없는 효과를 낼 수 있습니다. 연결한 기기도 이 권한을 실행할 수 있습니다.','custom-trust-warning');section.append(warning);
 const appSearch=field('customMacAppSearch','앱 검색');appSearch.type='search';appSearch.placeholder='예: Safari, Obsidian, Slack';appSearch.oninput=renderMacCatalogOptions;
 const appSelect=field('customMacApp','설치된 macOS 앱','select');
 appSelect.onchange=()=>{
  const opt=appSelect.selectedOptions[0];
  if(!appSelect.value)return;
  applyAutoPresentation(opt?.dataset?.name||'');
  void importMacAppIcon(appSelect.value);
 };
 const importIconBtn=el('button','선택 앱 아이콘 다시 가져오기','custom-inline-btn');importIconBtn.id='importMacAppIcon';importIconBtn.type='button';importIconBtn.onclick=()=>importMacAppIcon($('customMacApp').value,{manual:true});section.append(importIconBtn);
 const refreshCatalogBtn=el('button','앱·단축어 목록 새로고침','custom-inline-btn');refreshCatalogBtn.id='refreshMacCatalog';refreshCatalogBtn.type='button';refreshCatalogBtn.onclick=()=>ensureMacCatalog(true);section.append(refreshCatalogBtn);
 const shortcutSelect=field('customMacShortcutSelect','설치된 macOS 단축어','select');
 shortcutSelect.onchange=()=>{
  if(!shortcutSelect.value)return;
  $('customMacShortcut').value=shortcutSelect.value;
  applyAutoPresentation(shortcutSelect.value,'shortcut');
 };
 field('customMacShortcut','단축어 이름 (직접 입력 가능)').placeholder='예: 작업 환경 열기';
 const systemSelect=field('customMacSystem','시스템·미디어 동작','select');
 for(const item of MAC_SYSTEM_ITEMS){const option=el('option',item.name+' · '+item.detail);option.value=item.action;option.dataset.name=item.name;option.dataset.symbol=item.symbol;systemSelect.append(option);}
 systemSelect.onchange=()=>{
  const opt=systemSelect.selectedOptions[0];
  if(opt)applyAutoPresentation(opt.dataset.name,opt.dataset.symbol||'app');
 };
 const hotkeyPreset=field('customMacHotkeyPreset','단축키 프리셋 (선택사항)','select');
 hotkeyPreset.append(Object.assign(el('option','-- 단축키 프리셋 선택 --'),{value:''}));
 for(const preset of MAC_HOTKEY_PRESET_ITEMS){const option=el('option',preset.label);option.value=JSON.stringify(preset);hotkeyPreset.append(option);}
 hotkeyPreset.onchange=()=>{
  if(!hotkeyPreset.value)return;
  const preset=JSON.parse(hotkeyPreset.value);
  $('customMacHotkeyKey').value=preset.key;
  for(const mod of ['cmd','shift','alt','ctrl'])$('customMod'+mod[0].toUpperCase()+mod.slice(1)).checked=preset.modifiers.includes(mod);
  applyAutoPresentation(preset.label,'keyboard');
 };
 const hotkeyKey=field('customMacHotkeyKey','전송할 키','select');
 for(const k of MAC_HOTKEY_KEY_ITEMS){const option=el('option',k.length===1?k.toUpperCase():k);option.value=k;hotkeyKey.append(option);}
 const modFieldset=el('fieldset');modFieldset.id='customMacHotkeyMods';modFieldset.append(el('legend','보조 키'));
 const modGrid=el('div',undefined,'custom-mod-grid');
 for(const [mod,label]of [['cmd','⌘ Command'],['shift','⇧ Shift'],['alt','⌥ Option'],['ctrl','⌃ Control']]){
  const wrap=el('label'),box=el('input');box.type='checkbox';box.id='customMod'+mod[0].toUpperCase()+mod.slice(1);
  wrap.append(box,document.createTextNode(label));modGrid.append(wrap);
 }
 modFieldset.append(modGrid);section.append(modFieldset);
 const hotkeyNote=el('p','macOS 손쉬운 사용(Accessibility) 및 자동화(System Events) 권한이 필요하며, 실행 시점에 현재 활성 창에 키 입력을 전송합니다. 특정 터미널 수신기 검증은 수행하지 않습니다.','custom-permission-note');hotkeyNote.id='customMacHotkeyNote';section.append(hotkeyNote);
 const appUrlPreset=field('customAppUrlPreset','앱 URL 프리셋 (선택사항)','select');
 appUrlPreset.append(Object.assign(el('option','-- 앱 URL 프리셋 선택 --'),{value:''}));
 for(const preset of MAC_APP_URL_PRESET_ITEMS){const option=el('option',preset.label+' ('+preset.url+')');option.value=JSON.stringify(preset);appUrlPreset.append(option);}
 appUrlPreset.onchange=()=>{
  if(!appUrlPreset.value)return;
  const preset=JSON.parse(appUrlPreset.value);
  $('customAppUrl').value=preset.url;
  applyAutoPresentation(preset.label,'link');
 };
 const appUrlInput=field('customAppUrl','앱 URL 스킴 (http/https 외)');appUrlInput.type='text';appUrlInput.placeholder='raycast:// 또는 obsidian://open';appUrlInput.autocomplete='off';
 field('customUrl','HTTP/HTTPS URL').type='url';
 const shell=field('customShell','명시적 인터프리터','select');for(const value of ['bash','zsh','powershell','cmd']){const option=el('option',value);option.value=value;shell.append(option);}
 field('customScript','신뢰한 스크립트','textarea');field('customCwd','기존 절대 작업 폴더');
 const timeout=field('customTimeout','최대 실행 시간 (밀리초)');timeout.type='number';timeout.value='30000';
 const outputLimit=field('customMaxOutput','최대 출력 크기 (바이트)');outputLimit.type='number';outputLimit.value='65536';
 const target=field('customTarget','정확한 수신기 ID (창 제목/현재 포커스 불가)');field('customText','리터럴 텍스트','textarea');
 const submit=field('customSubmit','텍스트 뒤 Enter 제출');submit.type='checkbox';
 field('customChord','단축키');field('customMapping','검증된 수신기 매핑 ID');
 const enabled=field('customEnabled','등록 동작 활성화');enabled.type='checkbox';enabled.checked=true;
 const trusted=field('customTrusted','위 사용자 권한 실행 위험을 이해하고 신뢰한 동작을 등록합니다');trusted.type='checkbox';
 const qualification=el('p','sessionText/단축키는 정확한 ID·epoch·유휴 상태를 확인하는 검증된 수신기가 없으면 차단됩니다. 전역 키 입력으로 우회하지 않습니다.');qualification.id='customQualificationNote';section.append(qualification);
 const capability=el('p','호스트 실행 기능 확인 중…');capability.id='customCapabilities';capability.setAttribute('role','status');section.append(capability);
 const targets=el('datalist');targets.id='customReceiverIds';section.append(targets);target.setAttribute('list',targets.id);
 api('/api/actions/capabilities').then(caps=>{
  if(!deckLocal)return;
  const available=Array.isArray(caps.shellKinds)?caps.shellKinds:[],receivers=Array.isArray(caps.receivers)?caps.receivers:[];
  capability.textContent='macOS 제어: '+(caps.macControl?'사용 가능':'사용 불가 (macOS 전용)')+' · 사용 가능한 셸: '+(available.join(', ')||'없음')+' · URL/앱 스킴: '+((caps.hostUrl||caps.appUrl)?'사용 가능':'사용 불가')+' · 등록 수신기: '+(receivers.join(', ')||'없음')+' · 등록은 현재 유휴/권한 확인이나 Windows 실기 검증을 뜻하지 않습니다.';
  for(const option of shell.options){option.disabled=!available.includes(option.value);option.title=option.disabled?'이 호스트에서 사용할 수 없는 인터프리터':'';}
  for(const option of kind.options){if(['macApp','macShortcut','macSystem','macHotkey'].includes(option.value)){option.disabled=caps.macControl===false;option.title=option.disabled?'macOS 호스트에서만 사용할 수 있습니다':'';}}
  for(const id of receivers){const option=el('option');option.value=id;targets.append(option);}
 }).catch(()=>{capability.textContent='호스트 실행 기능을 확인하지 못했습니다. 사용할 수 있다고 추정하지 않습니다.';});
 kind.onchange=()=>{
  syncCustomInspectorFields();
  const value=kind.value;
  if(value==='macSystem'){const opt=$('customMacSystem').selectedOptions[0];if(opt)applyAutoPresentation(opt.dataset.name,opt.dataset.symbol||'app');}
  else if(value==='macHotkey'){if(!$('customMacHotkeyKey').value)$('customMacHotkeyKey').value='c';if(!['cmd','shift','alt','ctrl'].some(m=>$('customMod'+m[0].toUpperCase()+m.slice(1)).checked))$('customModCmd').checked=true;applyAutoPresentation('','keyboard');}
  else if(value==='appUrl'||value==='hostUrl')applyAutoPresentation('','link');
  else if(value==='macShortcut')applyAutoPresentation('','shortcut');
 };
 const remove=el('button','선택 키의 동작 등록 삭제');remove.type='button';remove.id='removeCustomAction';remove.onclick=()=>{const candidate=beginDeckCandidate(),slot=currentDeckLayout().slots[editingSlot];if(slot.type!=='custom')return;if(candidate.layouts.some(page=>page.slots.some((other,i)=>other.type==='custom'&&other.actionId===slot.actionId&&(page.id!==deckProfile||i!==editingSlot)))){layoutMessage('삭제 차단: 다른 키에서 이 동작을 참조합니다. 먼저 해당 키를 직접 변경하세요.');return;}candidate.actions=candidate.actions.filter(action=>action.id!==slot.actionId);kind.value='builtin';syncCustomInspectorFields();$('keyAssignment').value=JSON.stringify({type:'empty'});layoutMessage('동작 삭제 초안 · 키 저장으로 게시합니다.');};section.append(remove);
 const output=el('pre');output.id='customOutput';output.setAttribute('aria-live','polite');section.append(output);
 const cancelRun=el('button','실행 취소 (되돌리기 아님)');cancelRun.id='cancelCustomRun';cancelRun.type='button';cancelRun.hidden=true;cancelRun.onclick=async()=>{const id=currentDeckLayout().slots[editingSlot]?.actionId,run=customRunStates.get(id);if(run)try{await api('/api/actions/cancel/'+run.runId,{});await pollCustomRuns();}catch(error){layoutMessage('취소 실패: '+error.message);}};section.append(cancelRun);
 $('keyEditor').insertBefore(section,$('saveAssignment').parentElement);
 syncCustomInspectorFields();
}
function loadCustomInspector(slot){
 if(!$('customInspector'))return;
 customEditorGeneration++;macIconGeneration++;macAutoLabel='';macAutoSymbol='';
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
 $('customUrl').value=definition?.kind==='hostUrl'?(definition.url||''):'';$('customShell').value=definition?.shellKind||'bash';$('customScript').value=definition?.script||'';$('customCwd').value=definition?.cwd||'';$('customTimeout').value=definition?.executionPolicy?.timeoutMs||30000;$('customTarget').value=definition?.targetRef||'';$('customText').value=definition?.literalText||'';$('customSubmit').checked=definition?.submit===true;$('customChord').value=definition?.chord||'';$('customMapping').value=definition?.qualifiedMapping||'';$('customEnabled').checked=action?.enabled!==false;$('customTrusted').checked=!!definition;$('removeCustomAction').hidden=!action;
 $('customMaxOutput').value=definition?.executionPolicy?.maxOutputBytes??65536;
 syncCustomInspectorFields();
 $('customOutput').textContent='';$('cancelCustomRun').hidden=true;pollCustomRuns();
}
function readCustomInspector(base,candidate){
 if(!$('customInspector'))return base;
 const presentation={};for(const key of ['label','symbol','color']){const value=$('custom'+key[0].toUpperCase()+key.slice(1)).value;if(value)presentation[key]=value;}if($('customInspector').dataset.asset)presentation.asset=$('customInspector').dataset.asset;
 validatePresentation(presentation);
 const kind=$('customKind').value;let slot=base;
 if(kind!=='builtin'){
  if(!$('customTrusted').checked)throw Error('신뢰한 사용자 권한 실행 위험을 확인하세요.');
  let definition;
  if(kind==='hostUrl')definition={kind,url:$('customUrl').value};
  else if(kind==='appUrl'){
   const url=$('customAppUrl').value.trim();
   if(!url)throw Error('앱 URL 스킴을 입력하세요.');
   if(/^(?:https?|file|javascript|data|vbscript|blob|about):/i.test(url))throw Error('http/https는 호스트 URL을 사용하고, file/javascript/data 스킴은 허용되지 않습니다.');
   try{new URL(url);}catch{throw Error('유효한 앱 URL 스킴을 입력하세요 (예: raycast://).');}
   definition={kind,url};
  }
  else if(kind==='macApp'){
   const appPath=$('customMacApp').value.trim();
   if(!appPath)throw Error('실행할 macOS 앱을 선택하세요.');
   definition={kind,appPath};
  }
  else if(kind==='macShortcut'){
   const name=$('customMacShortcut').value.trim();
   if(!name)throw Error('실행할 단축어 이름을 입력하세요.');
   definition={kind,name};
  }
  else if(kind==='macSystem'){
   const action=$('customMacSystem').value;
   if(!action)throw Error('시스템 제어 동작을 선택하세요.');
   definition={kind,action};
  }
  else if(kind==='macHotkey'){
   const key=$('customMacHotkeyKey').value;
   const modifiers=['cmd','shift','alt','ctrl'].filter(m=>$('customMod'+m[0].toUpperCase()+m.slice(1)).checked);
   if(!key)throw Error('전송할 키를 선택하세요.');
   definition={kind,key,modifiers};
  }
  else if(kind==='hostProcess')definition={kind,shellKind:$('customShell').value,script:$('customScript').value,cwd:$('customCwd').value,executionPolicy:{timeoutMs:Number($('customTimeout').value),maxOutputBytes:Number($('customMaxOutput').value)}};
  else if(kind==='sessionText')definition={kind,targetRef:$('customTarget').value,literalText:$('customText').value,submit:$('customSubmit').checked};
  else definition={kind,targetRef:$('customTarget').value,chord:$('customChord').value,qualifiedMapping:$('customMapping').value};
  const previous=currentDeckLayout().slots[editingSlot],id=previous.type==='custom'?previous.actionId:'action-'+crypto.randomUUID();
  candidate.actions=candidate.actions.filter(action=>action.id!==id);candidate.actions.push({id,enabled:$('customEnabled').checked,definition});slot={type:'custom',actionId:id};
 }
 return Object.keys(presentation).length?{...slot,presentation}:slot;
}
async function invokeCustomAction(slot,index){
 if(deckLocal||demo){toast('PC 미리보기에서는 실행하지 않습니다.');return;}
 if(document.hidden||!navigator.onLine||sending){toast('오프라인 또는 다른 실행 중입니다. 대기열에 넣지 않았습니다.');return;}
 const press=++customPress,revision=layoutRevision,pageId=deckProfile,generation=deckGeneration,view=deckView,cursor=JSON.stringify(deckCursor());let attempted=false;
 sending=true;
 try{
  const prepared=await api('/api/actions/prepare',{actionId:slot.actionId,revision,pageId,slotIndex:index});
  if(press!==customPress||document.hidden||revision!==layoutRevision||pageId!==deckProfile||generation!==deckGeneration||view!==deckView||cursor!==JSON.stringify(deckCursor())||!navigator.onLine)throw Error('화면 문맥이 바뀌어 실행을 취소했습니다.');
  attempted=true;const result=await api('/api/actions/invoke',prepared);if(result.runId)customRunStates.set(slot.actionId,result);toast('동작 '+result.state+' · 자동 재시도하지 않습니다.');redrawDeck();
 }catch(error){toast(attempted?'실행 결과 미확인/차단 · 자동 재시도하지 않습니다.':error.message);}
 finally{sending=false;}
}
document.addEventListener('visibilitychange',()=>{if(document.hidden)customPress++;});
window.addEventListener('offline',()=>{customPress++;});
window.addEventListener('blur',()=>{customPress++;});
window.addEventListener('pagehide',()=>{customPress++;});
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
    const detail=await api('/api/actions/status/'+run.runId);
    const permHint=/1002|not allowed|not authorized|assistive/i.test(detail.stderr||'')?'안내: macOS 시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용 및 자동화(System Events) 권한을 허용하세요.':'';
    $('customOutput').textContent=[customRunPresentation(detail).detail,detail.stdout,detail.stderr,permHint,detail.outputTruncated?'출력 한도 도달':''].filter(Boolean).join('\n');
    $('cancelCustomRun').hidden=!['running','cancelling'].includes(run.state);
   }
  }
 }catch{
  // Keep the last receipt as historical data, not an apparently live success.
  if(deckLocal&&$('customOutput'))$('customOutput').textContent='실행 상태 조회 실패 · 마지막 결과는 현재 상태를 보장하지 않습니다. 자동 재실행하지 않습니다.';
 }
 finally{customPolling=false;}
}
setInterval(pollCustomRuns,1000);
function openKeyEditor(index){
 if(!canEditDeck()||!Number.isInteger(index)||index<0||index>=15)return;
 beginDeckCandidate();cancelDeckInput();
 editingSlot=index;modal=true;const layout=currentDeckLayout(),select=$('keyAssignment');select.replaceChildren();
 $('editorSlot').textContent=layout.name+' / 키 '+String(index+1).padStart(2,'0');
 const groups=[['페이지·도구',[['에이전트 페이지',{type:'page',page:'agents'}],['선택한 에이전트 응답 페이지',{type:'page',page:'response'}],['요청 원문 보기',{type:'context'}],['상태 새로고침',{type:'refresh'}],['빈 키',{type:'empty'}]]],['에이전트 자동 배치',Array.from({length:15},(_,i)=>['이 페이지의 '+(i+1)+'번째 에이전트',{type:'auto-agent',index:i}])],['특정 에이전트',(current?.agents||[]).map(a=>[a.label+' · '+a.pane_id,{type:'agent',pane:a.pane_id}])],['응답 선택지',Array.from({length:9},(_,i)=>['선택지 '+(i+1),{type:'choice',key:String(i+1)}])],['키 전송',DECK_KEY_ACTIONS.map(key=>[key,{type:'key',key}])]];
 groups[0][1]=[['전체 세션 뱅크',{type:'sessions'}],...editorLayouts().map(p=>[p.name+' 페이지',{type:'page',page:p.id}]),...groups[0][1].filter(([,value])=>value.type!=='page')];
 for(const [label,items] of groups){const group=el('optgroup');group.label=label;for(const [name,value] of items){const option=el('option',name);option.value=JSON.stringify(value);group.append(option);}select.append(group);}
 for(const [name,value] of [['Codex 쿼터',{type:'quota',provider:'codex'}],['Antigravity 쿼터',{type:'quota',provider:'agy'}],['쿼터 페이지',{type:'page',page:'quota'}]]){const option=el('option',name);option.value=JSON.stringify(value);select.append(option);}
 const {presentation,...baseSlot}=layout.slots[index];const value=JSON.stringify(baseSlot);
 if(![...select.options].some(o=>o.value===value)){const missing=el('option','연결되지 않은 에이전트');missing.value=value;select.append(missing);}
 select.value=value;
 loadCustomInspector(layout.slots[index]);
 select.onchange=()=>{const action=JSON.parse(select.value);if(!['sessions','page'].includes(action.type))return;const report=deckGraphDiagnostics(editorLayouts(),[{from:layout.id,...action}]).deficits.find(p=>p.pageId===layout.id);layoutMessage(layout.name+' · 선택 연결 '+(action.page||'전체 세션')+' · 빈 키 '+report.empty+'개 · 필요한 빈 키 추가 '+report.additionalEmpty+'개'+(layout.slots[index].type!=='empty'&&JSON.stringify(action)!==value?' · 차단: 이 키를 먼저 직접 비우세요.':''));};
 for(const error of $('keyEditor').querySelectorAll('.layout-error'))error.textContent='';
 if(!$('keyEditor').open)$('keyEditor').show();
 $('editorEmpty').hidden=true;
 for(const [i,key] of [...$('keys').querySelectorAll('button[data-key-id]')].entries())key.classList.toggle('configuring',i===index);
 select.focus();
}
function closeKeyEditor(){customEditorGeneration++;const index=editingSlot;if($('keyEditor').open)$('keyEditor').close();editingSlot=null;modal=false;if($('editorEmpty'))$('editorEmpty').hidden=false;for(const key of $('keys').querySelectorAll('.configuring'))key.classList.remove('configuring');if(index!==null&&deckLocal&&deckEditing)$('keys').querySelectorAll('button[data-key-id]')[index]?.focus();}
function openDeckRequest(){
 const content=$('requestContent');if(!content){toast('표시할 요청이 없습니다.');return;}
 const dialog=$('requestDetail'),copy=content.cloneNode(true);copy.removeAttribute('id');$('requestDetailContent').replaceChildren(copy);
 modal=true;dialog.showModal();
}
$('showDeckRequest').onclick=openDeckRequest;
$('closeDeckRequest').onclick=()=>$('requestDetail').close();
$('requestDetail').addEventListener('close',()=>{modal=false;});
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
 const editAction=()=>openKeyEditor(index);let spec={id:'slot:'+deckProfile+':'+index,name:'빈 키',symbol:'terminal',disabled:true},stateAgent;
 if(['auto-agent','agent'].includes(slot.type)){
  const raw=slot.target||deckAgentForSlot(slot,agents,0),x=deckView==='reason'&&raw?{...raw,pane_id:raw.id,label:raw.name||raw.label,agent_status:raw.status==='busy'?'working':raw.status||'unknown'}:raw;stateAgent=x;
  if(x){
   const st=x.agent_status||'unknown';
   const detailLabel=online||demo?(statuses[st]||st):'오프라인';
   spec={...spec,name:x.label,detail:detailLabel,symbol:agentIconName(x.agent),corner:String(agents.findIndex(t=>(t.pane_id||t.id)===x.pane_id)+1).padStart(2,'0'),cls:'session state-'+(online||demo?st:'offline')+' '+(x.pane_id===selectedPane?'selected':''),disabled:!online&&!demo&&deckView!=='reason',label:x.label+' · '+(names[x.agent]||x.agent)+' · '+detailLabel+' · '+(deckLocal?'미리보기':deckView==='reason'?'읽기 전용':'PC 작업 창 및 응답 페이지 열기'),click:()=>deckView==='reason'?chooseNetwork(x.pane_id):choose(x.pane_id)};
  }
  else spec={...spec,name:slot.type==='agent'?'연결 안 됨':'빈 슬롯',label:slot.type==='agent'?'지정한 에이전트가 연결되지 않았습니다':'연결된 에이전트 없음'};
 }else if(slot.type==='choice'){
  const opt=a?.choices?.find(x=>x.key===slot.key);spec={...spec,name:opt?.label||(a?.agent_status==='working'?'작업 중':'선택지 대기'),number:slot.key,symbol:null,cls:'option '+(opt&&available?'available':''),disabled:!available||!opt,label:opt?'선택지 '+opt.key+' · '+opt.label:'선택지 '+slot.key+' 대기 중',click:()=>ask(a,slot.key,slot.key+' · '+opt?.label)};
 }else if(slot.type==='key'){
  const keyNames={enter:'Enter',up:'위로',down:'아래로',left:'왼쪽',right:'오른쪽',tab:'Tab',esc:'Esc'};spec={...spec,name:keyNames[slot.key],symbol:slot.key,cls:'utility '+(slot.key==='enter'?'enter':''),disabled:!available,label:keyNames[slot.key]+' 키 전송',click:()=>ask(a,slot.key,keyNames[slot.key])};
 }else if(slot.type==='sessions')spec={...spec,name:'전체 세션',detail:agents.length+'개 · 12개씩',symbol:'network',disabled:false,click:enterSessionBank};
 else if(slot.type==='return')spec={...spec,name:'돌아가기',symbol:'enter',disabled:false,click:leaveSessionBank};
 else if(slot.type==='previous'||slot.type==='next')spec={...spec,name:slot.type==='previous'?'이전 세션 페이지':'다음 세션 페이지',detail:currentDeckLayout().name,symbol:slot.type==='previous'?'left':'right',disabled:slot.disabled,click:()=>stepSessionBank(slot.type==='previous'?-1:1)};
 else if(slot.type==='page'){
  const pending=slot.page==='agents'&&deckProfile!=='agents'&&!deckEditing&&(online||demo)?agents.filter(x=>x.pane_id!==selectedPane&&x.agent_status==='blocked').length:0;
  spec={...spec,name:deckLayouts.find(p=>p.id===slot.page)?.name||'없는 페이지',detail:pending?'확인 대기 '+pending:slot.page==='response'?(a?.label||'에이전트 선택'):slot.page==='quota'?'잔여율 · 터치 상세':slot.page==='agents'?'전체 세션':'페이지 이동',symbol:slot.page==='agents'?'network':'enter',cls:pending?'pending-sessions':'',label:pending?'에이전트 전체 세션 · 다른 패널 확인 대기 '+pending+'개':undefined,disabled:false,click:()=>setDeckProfile(slot.page)};
 }
 else if(slot.type==='refresh')spec={...spec,name:'새로고침',symbol:'refresh',disabled:false,click:()=>deckView==='native'?(typeof refreshNative==='function'&&refreshNative(true)):deckView==='reason'?refreshNetwork(true):demo?toast('미리보기입니다.'):refresh(true)};
 else if(slot.type==='context')spec={...spec,name:'요청 보기',symbol:'context',disabled:false,click:openDeckRequest};
 else if(slot.type==='quota')spec={...spec,name:slot.provider==='codex'?'Codex 쿼터':'Antigravity 쿼터'};
 else if(slot.type==='custom'){const action=(deckCandidate?.actions||deckActions).find(action=>action.id===slot.actionId),run=customRunStates.get(slot.actionId),busy=run&&['running','cancelling'].includes(run.state),status=customRunPresentation(run);spec={...spec,name:'사용자 동작',detail:status?status.detail:action?.enabled?(deckLocal?'실행 없는 미리보기':'저장된 동작 실행'):'비활성화',cls:status?.cls||'',symbol:customActionDefaultSymbol(action?.definition),disabled:!action?.enabled||(!deckLocal&&busy),click:()=>invokeCustomAction(slot,index)};}
 if(deckLocal&&deckEditing){spec={...spec,disabled:false,click:editAction,label:'키 '+(index+1)+' 편집 · '+spec.name,corner:String(index+1).padStart(2,'0'),cls:(spec.cls||'')+' editable'+(editingSlot===index?' configuring':'')};}
 const b=keyButton(spec);
 if(stateAgent){b.setAttribute('aria-pressed',String(stateAgent.pane_id===selectedPane));b.append(el('i',undefined,'key-dot '+stateAgent.agent_status));}
 return decorateCustomKey(b,slot.presentation);
}
$('deckProfile').onchange=()=>setDeckProfile($('deckProfile').value);
$('editDeck').onclick=()=>{if(!canEditDeck())return;cancelDeckInput();closeKeyEditor();if(deckCursor().kind==='sessions')leaveSessionBank();deckEditing=!deckEditing;redrawDeck();};
$('saveAssignment').onclick=async()=>{
 if(!canEditDeck()||editingSlot===null)return;
 try{
  const candidate=beginDeckCandidate(),action=readCustomInspector(normalizeDeckSlot(JSON.parse($('keyAssignment').value),editingSlot),candidate),old=currentDeckLayout().slots[editingSlot],navigation=['sessions','page'].includes(action.type)&&(old.type!==action.type||old.page!==action.page);
  if(navigation&&old.type!=='empty'&&(old.type!==action.type||old.page!==action.page)){layoutMessage('저장 실패: '+currentDeckLayout().name+' 키 '+(editingSlot+1)+'이 사용 중입니다. 필요한 빈 키 1개를 직접 준비하세요.');return;}
  if(navigation)candidate.navigation=true;
  candidate.layouts.find(page=>page.id===deckProfile).slots[editingSlot]=action;
  if(candidate.navigation){closeKeyEditor();layoutMessage('초안에 반영했습니다. 진입·복귀 연결을 준비하고 배치 초안 저장을 누르세요.');redrawDeck();}
  else if(await persistDeckLayouts(candidate.layouts,false,candidate)){closeKeyEditor();redrawDeck();}
 }catch(error){layoutMessage('저장 실패: '+error.message);}
};
$('cancelAssignment').onclick=closeKeyEditor;$('keyEditor').addEventListener('cancel',()=>{editingSlot=null;modal=false;});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&deckLocal&&editingSlot!==null&&!document.querySelector('dialog:modal')){event.preventDefault();closeKeyEditor();}});
$('addDeckPage').onclick=()=>{if(!canEditDeck())return;if(deckLayouts.length>=32){toast('페이지는 최대 32개까지 만들 수 있습니다.');return;}modal=true;$('pageName').value='';$('pageEditor').showModal();};
$('cancelPage').onclick=()=>{$('pageEditor').close();modal=false;};$('pageEditor').addEventListener('cancel',()=>{modal=false;});
$('pageForm').onsubmit=async e=>{e.preventDefault();if(!canEditDeck()||editorLayouts().length>=32)return;const name=$('pageName').value.trim().slice(0,32);if(!name)return;let id='custom-'+Date.now();while(editorLayouts().some(x=>x.id===id))id+='x';beginDeckCandidate(true).layouts.push({id,name,slots:Array.from({length:15},()=>({type:'empty'}))});$('pageEditor').close();modal=false;setDeckProfile(id);deckEditing=true;redrawDeck();};
$('resetDeck').onclick=()=>{if(!canEditDeck())return;modal=true;$('resetTitle').textContent=defaultDeckLayouts().some(p=>p.id===deckProfile)?'이 페이지를 기본 배치로 되돌릴까요?':'이 페이지와 이 페이지를 향한 이동 키를 삭제할까요?';$('resetDialog').showModal();};
$('cancelReset').onclick=()=>{$('resetDialog').close();modal=false;};$('resetDialog').addEventListener('cancel',()=>{modal=false;});
$('confirmReset').onclick=async()=>{if(!canEditDeck())return;const candidate=beginDeckCandidate(),base=defaultDeckLayouts().find(x=>x.id===deckProfile);const next=base?candidate.layouts.map(x=>x.id===deckProfile?base:x):candidate.layouts.filter(x=>x.id!==deckProfile).map(p=>({...p,slots:p.slots.map(s=>s.type==='page'&&s.page===deckProfile?{type:'empty'}:s)}));if(await persistDeckLayouts(next,false,candidate)){$('resetDialog').close();modal=false;deckEditing=false;redrawDeck();}};
$('refreshDeck').onclick=()=>deckView==='native'?(typeof refreshNative==='function'&&refreshNative(true)):deckView==='reason'?refreshNetwork(true):demo?toast('미리보기입니다.'):refresh(true);
