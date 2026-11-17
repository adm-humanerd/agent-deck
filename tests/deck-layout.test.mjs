import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultDeckLayouts,normalizeDeckSlot,deckAgentForSlot,deckPageCount,deckSessionPage,deckGraphDiagnostics,validateDeckLayouts} from '../src/deck/deck-layout.mjs';
test('15 freely assignable slots on both default pages',()=>{for(const p of defaultDeckLayouts())assert.equal(p.slots.length,15);});
test('generated bank conserves source order and exact targets across every boundary',()=>{
 for(let count=0;count<=120;count++){
  const agents=Array.from({length:count},(_,i)=>Object.freeze({pane_id:'p'+i,id:'id'+i}));
  Object.freeze(agents);
  const all=[],pageCount=Math.max(1,Math.ceil(count/12));
  assert.equal(deckPageCount(agents),pageCount);
  for(let pageIndex=0;pageIndex<pageCount;pageIndex++){
   const projection=deckSessionPage(agents,pageIndex);
   assert.equal(projection.pageIndex,pageIndex);
   assert.equal(projection.pageCount,pageCount);
   assert.equal(projection.slots.length,15);
   assert.deepEqual(projection.slots.slice(12),[{type:'return'},{type:'previous',disabled:pageIndex===0},{type:'next',disabled:pageIndex===pageCount-1}]);
   for(let index=0;index<12;index++){
    const slot=projection.slots[index],target=agents[pageIndex*12+index];
    if(target){
     assert.deepEqual(slot,{type:'agent',mode:'pinned',pane:target.pane_id,target});
     assert.equal(slot.target,target);
     all.push(slot.target);
    }else assert.deepEqual(slot,{type:'empty'});
   }
  }
  assert.deepEqual(all,agents);
  assert.equal(new Set(all).size,count);
 }
});
test('generated page clamp handles growth, shrink and invalid cursors without wrapping',()=>{
 const agents=Array.from({length:37},(_,i)=>({pane_id:'p'+i}));
 for(const [cursor,expected] of [[-10,0],[0,0],[1.9,1],[3,3],[4,3],[100,3],[NaN,0],[Infinity,0],['2',0]])assert.equal(deckSessionPage(agents,cursor).pageIndex,expected);
 assert.equal(deckSessionPage(agents).pageIndex,0);
 assert.equal(deckSessionPage(agents.slice(0,13),3).pageIndex,1);
 assert.equal(deckSessionPage([],3).pageIndex,0);
 for(const [count,counts] of [[0,[0]],[12,[12]],[13,[12,1]],[24,[12,12]],[25,[12,12,1]],[37,[12,12,12,1]]]){
  const source=agents.slice(0,count);
  assert.deepEqual(Array.from({length:deckPageCount(source)},(_,i)=>deckSessionPage(source,i).slots.filter(s=>s.type==='agent').length),counts);
 }
});
test('generated identity prefers pane_id, then pane, then id and never serializes as authored data',()=>{
 const agents=[{pane_id:'native',pane:'alternate',id:'id'},{pane:'tui',id:'id2'},{id:'reason'}];
 const projection=deckSessionPage(agents,0);
 assert.deepEqual(projection.slots.slice(0,3).map(s=>s.pane),['native','tui','reason']);
 for(const slot of projection.slots.filter(s=>s.type!=='empty')){
  const pages=defaultDeckLayouts();pages[0].slots[0]=slot;
  assert.throws(()=>validateDeckLayouts(pages));
 }
 const again=deckSessionPage(agents,0);
 projection.slots[0].pane='changed';projection.slots[12].type='empty';
 assert.equal(again.slots[0].pane,'native');assert.equal(again.slots[12].type,'return');
});
test('authored automatic assignments ignore the generated cursor and retain all 15 coordinates',()=>{
 const agents=Array.from({length:37},(_,i)=>({pane_id:'p'+i}));
 for(const pageIndex of [0,1,3,100])for(const slot of defaultDeckLayouts()[0].slots)assert.equal(deckAgentForSlot(slot,agents,pageIndex),agents[slot.index]);
 assert.equal(deckAgentForSlot({type:'auto-agent',index:14},agents.slice(0,14),3),undefined);
});
test('pinned agent tracks its pane across ordering changes',()=>assert.equal(deckAgentForSlot({type:'agent',pane:'p2'},[{pane_id:'p2'},{pane_id:'p1'}],0).pane_id,'p2'));
test('removed pinned agent does not silently bind another session',()=>assert.equal(deckAgentForSlot({type:'agent',pane:'old'},[{pane_id:'new'}],0),undefined));
test('every response number and all allowed navigation keys are configurable',()=>{for(const key of ['1','9'])assert.equal(normalizeDeckSlot({type:'choice',key},0).key,key);for(const key of ['enter','up','down','left','right','tab','esc'])assert.equal(normalizeDeckSlot({type:'key',key},0).key,key);});
test('invalid or arbitrary command assignments are rejected',()=>{assert.deepEqual(normalizeDeckSlot({type:'key',key:'rm -rf'},0),{type:'empty'});assert.deepEqual(normalizeDeckSlot({type:'choice',key:'10'},0),{type:'empty'});assert.deepEqual(normalizeDeckSlot({type:'shell',command:'echo hi'},0),{type:'empty'});});
test('no shared mutable defaults',()=>{const first=defaultDeckLayouts();first[0].slots[0].type='empty';assert.equal(defaultDeckLayouts()[0].slots[0].type,'auto-agent');});
test('canonical custom navigation preserves every user key without a three-page limit',()=>{
 const pages=defaultDeckLayouts();pages.push({id:'custom-four',name:'사용자 페이지',slots:Array.from({length:15},()=>({type:'key',key:'esc'}))});
 pages[0].slots[0]={type:'page',page:'custom-four'};
 assert.deepEqual(validateDeckLayouts(pages),pages);
 assert.deepEqual(normalizeDeckSlot(pages[0].slots[0],0),pages[0].slots[0]);
 const copy=validateDeckLayouts(pages);copy[3].slots[0].key='enter';assert.equal(pages[3].slots[0].key,'esc');
});
test('canonical validation rejects malformed layouts rather than overwriting with defaults',()=>{
 for(const value of [null,[],{},Array(33).fill(defaultDeckLayouts()[0])])assert.throws(()=>validateDeckLayouts(value));
 for(const mutate of [p=>p.push(p[0]),p=>p[0].slots.pop(),p=>p[0].slots[0]={type:'shell',command:'x'},p=>p[0].slots[0]={type:'page',page:'missing'},p=>p[0].slots[0]={type:'auto-agent',index:-1},p=>p[0].extra=true,p=>p[0].name=' '.repeat(2)]){
  const pages=defaultDeckLayouts();mutate(pages);assert.throws(()=>validateDeckLayouts(pages));
 }
});

test('32 full custom pages validate without silent defaults injection or truncation',()=>{const pages=Array.from({length:32},(_,i)=>({id:'custom-'+i,name:'P',slots:Array.from({length:15},()=>({type:'empty'}))}));assert.deepEqual(validateDeckLayouts(pages),pages);});
test('quota uses existing grid slots without displacing session or response actions',()=>{
 const pages=defaultDeckLayouts();assert.equal(pages[0].slots.filter(s=>s.type==='auto-agent').length,15);
 assert.deepEqual(pages.find(p=>p.id==='quota').slots.slice(0,2),[{type:'quota',provider:'codex'},{type:'quota',provider:'agy'}]);
 for(const provider of ['codex','agy'])assert.deepEqual(normalizeDeckSlot({type:'quota',provider},0),{type:'quota',provider});
 assert.deepEqual(normalizeDeckSlot({type:'quota',provider:'arbitrary'},0),{type:'empty'});
 assert.equal(normalizeDeckSlot({type:'page',page:'quota'},0).page,'quota');
 const saved=defaultDeckLayouts();saved[0].slots[0]={type:'key',key:'esc'};assert.deepEqual(validateDeckLayouts(saved)[0].slots[0],{type:'key',key:'esc'});
});

function authoredPage(id,actions=[]){return {id,name:id,slots:[...actions,...Array.from({length:15-actions.length},()=>({type:'empty'}))]};}
test('only the exact sessions action is accepted as durable authored data',()=>{
 const pages=defaultDeckLayouts();pages[2].slots[2]={type:'sessions'};
 assert.deepEqual(normalizeDeckSlot({type:'sessions'},2),{type:'sessions'});
 assert.deepEqual(validateDeckLayouts(pages),pages);
 for(const slot of [
  {type:'sessions',page:0},{type:'sessions',index:0},{type:'sessions',disabled:false},
  {type:'sessions',target:{}},{type:'sessions',mode:'pinned'},{type:'sessions',pane:'p'},
  {type:'return'},{type:'previous'},{type:'next'},{type:'previous',disabled:true},
  {type:'agent',mode:'pinned',pane:'p'},{type:'empty',target:{}},
  {type:'Sessions'},{type:'session'},['sessions'],
 ]){
  pages[2].slots[2]=slot;
  assert.throws(()=>validateDeckLayouts(pages),JSON.stringify(slot));
 }
});
test('graph readiness uses navigation only and falls back to first page without agents',()=>{
 const layouts=[authoredPage('custom-root',[{type:'page',page:'branch'}]),authoredPage('branch',[{type:'page',page:'response'},{type:'sessions'}]),authoredPage('response',[{type:'page',page:'custom-root'}])];
 const result=deckGraphDiagnostics(layouts);
 assert.equal(result.ready,true);
 assert.deepEqual(result.unreachable,[]);assert.deepEqual(result.noReturn,[]);assert.equal(result.missingSessions,false);
 layouts[0].slots[0]={type:'agent',pane:'branch'};
 assert.deepEqual(deckGraphDiagnostics(layouts).unreachable,['branch','response']);
 assert.equal(deckGraphDiagnostics(layouts).missingSessions,true);
 assert.equal(deckGraphDiagnostics(layouts).ready,false);
 layouts[0].slots[0]={type:'page',page:'branch'};
 layouts[2].slots[0]={type:'choice',key:'1'};
 assert.deepEqual(deckGraphDiagnostics(layouts).noReturn,['branch','response']);
 assert.equal(deckGraphDiagnostics(layouts).ready,false);
});
test('agents is the graph root even when it is not the first authored page',()=>{
 const layouts=[authoredPage('first',[{type:'page',page:'agents'},{type:'sessions'}]),authoredPage('agents')];
 const result=deckGraphDiagnostics(layouts);
 assert.deepEqual(result.unreachable,['first']);
 assert.deepEqual(result.noReturn,[]);
 assert.equal(result.missingSessions,true);
 assert.equal(result.ready,false);
 layouts[1].slots[0]={type:'page',page:'first'};
 assert.equal(deckGraphDiagnostics(layouts).ready,true);
 layouts[0].slots[0]={type:'empty'};
 assert.deepEqual(deckGraphDiagnostics(layouts).noReturn,['first']);
});
test('disconnected cycles, self-links and missing entry are diagnosed without repair',()=>{
 const layouts=[authoredPage('root',[{type:'page',page:'root'}]),authoredPage('a',[{type:'page',page:'b'},{type:'sessions'}]),authoredPage('b',[{type:'page',page:'a'}])];
 const before=JSON.stringify(layouts),result=deckGraphDiagnostics(layouts);
 assert.deepEqual(result.unreachable,['a','b']);assert.deepEqual(result.noReturn,['a','b']);assert.equal(result.missingSessions,true);
 assert.equal(JSON.stringify(layouts),before);
 assert.equal(deckGraphDiagnostics([authoredPage('root')]).missingSessions,true);
 assert.equal(deckGraphDiagnostics([authoredPage('root',[{type:'sessions'}])]).ready,true);
 assert.deepEqual(deckGraphDiagnostics([]),{ready:false,unreachable:[],noReturn:[],missingSessions:true,deficits:[]});
});
test('manual preparation A reports per-source direct compatible missing actions only',()=>{
 const layouts=[authoredPage('root',Array.from({length:15},()=>({type:'key',key:'esc'}))),authoredPage('middle',[{type:'page',page:'root'},{type:'page',page:'end'},{type:'sessions'},...Array.from({length:11},()=>({type:'choice',key:'1'}))]),authoredPage('end',[{type:'page',page:'root'}])];
 const selected=[
  {from:'root',type:'page',page:'middle'},{from:'root',type:'sessions'},
  {from:'root',type:'sessions'},{from:'root',type:'page',page:'middle'},
  {from:'middle',type:'page',page:'root'},{from:'middle',type:'sessions'},
  {from:'middle',type:'page',page:'end'},
  {from:'end',type:'page',page:'middle'},{from:'end',type:'sessions'},
  {from:'missing',type:'sessions'},{from:'root',type:'page',page:'missing'},
 ];
 const before=JSON.stringify({layouts,selected});
 for(const page of layouts){for(const slot of page.slots)Object.freeze(slot);Object.freeze(page.slots);Object.freeze(page);}
 Object.freeze(layouts);for(const connection of selected)Object.freeze(connection);Object.freeze(selected);
 const result=deckGraphDiagnostics(layouts,selected);
 assert.deepEqual(result.deficits,[
  {pageId:'root',empty:0,missing:2,additionalEmpty:2,connections:[{from:'root',type:'page',page:'middle'},{from:'root',type:'sessions'}]},
  {pageId:'middle',empty:1,missing:0,additionalEmpty:0,connections:[]},
  {pageId:'end',empty:14,missing:2,additionalEmpty:0,connections:[{from:'end',type:'page',page:'middle'},{from:'end',type:'sessions'}]},
 ]);
 assert.equal(JSON.stringify({layouts,selected}),before);
 assert.notEqual(result.deficits[0].connections[0],selected[0]);
});
test('one empty key for two selected new links needs one additional empty key',()=>{
 const layouts=[authoredPage('root',[...Array.from({length:14},()=>({type:'context'}))]),authoredPage('other')];
 const result=deckGraphDiagnostics(layouts,[{from:'root',type:'page',page:'other'},{from:'root',type:'sessions'}]);
 assert.deepEqual(result.deficits[0],{pageId:'root',empty:1,missing:2,additionalEmpty:1,connections:[{from:'root',type:'page',page:'other'},{from:'root',type:'sessions'}]});
});
test('full defaults remain unchanged and unready until explicit manual preparation',()=>{
 const layouts=defaultDeckLayouts(),before=JSON.stringify(layouts);
 const result=deckGraphDiagnostics(layouts,[{from:'agents',type:'sessions'},{from:'agents',type:'page',page:'response'}]);
 assert.equal(result.ready,false);assert.deepEqual(result.unreachable,['response','quota']);assert.deepEqual(result.noReturn,[]);assert.equal(result.missingSessions,true);
 assert.equal(result.deficits[0].additionalEmpty,2);assert.equal(JSON.stringify(layouts),before);
 layouts[0].slots[0]={type:'sessions'};
 layouts[0].slots[1]={type:'page',page:'response'};
 layouts[1].slots[0]={type:'page',page:'quota'};
 assert.equal(deckGraphDiagnostics(layouts).ready,true);
 assert.deepEqual(validateDeckLayouts(layouts),layouts);
});
test('32 authored pages and 37 generated sessions remain separate and conserve authored payloads',()=>{
 const layouts=Array.from({length:32},(_,i)=>authoredPage('p'+i,[{type:'page',page:'p'+((i+1)%32)},...(i===0?[{type:'sessions'}]:[])]));
 const before=JSON.stringify(layouts),agents=Array.from({length:37},(_,i)=>({pane_id:'s'+i}));
 assert.equal(deckGraphDiagnostics(layouts).ready,true);
 for(let page=0;page<deckPageCount(agents);page++)deckSessionPage(agents,page);
 assert.equal(JSON.stringify(layouts),before);assert.deepEqual(validateDeckLayouts(layouts),layouts);
});
