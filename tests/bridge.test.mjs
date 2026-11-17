import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBridge,choices} from '../src/integrations/bridge.mjs';
function mock(){
 const a={pane_id:'test:p1',agent:'codex',agent_status:'blocked',revision:1,state_change_seq:3,agent_session:{value:'session-a'}};
 let text='Run this command?\n› 1. Yes, once\n  2. No, cancel',sent=[];
 const run=async args=>args[0]==='api'?JSON.stringify({result:{snapshot:{agents:[a],tabs:[],version:'test'}}}):args[1]==='read'?text:(sent.push(args),'{}');
 return {a,sent,setText:v=>text=v,b:createBridge(run)};
}
test('선택지 내용 추출',()=>assert.deepEqual(choices('› 1. 승인\n  2) 거절').map(x=>x.label),['승인','거절']));
test('오래된 목록이 섞여 있어도 마지막 활성 메뉴만 추출',()=>assert.deepEqual(choices('1. 옛날 항목\n5. 남은 항목\n\n› 1. 승인\n  2. 거절').map(x=>x.label),['승인','거절']));
test('정확한 요청에 한 키만 전달하고 중복 차단',async()=>{const m=mock(),s=await m.b.refresh();await m.b.respond({pane:'test:p1',ticket:s.agents[0].ticket,key:'1'});assert.deepEqual(m.sent,[['agent','send-keys','test:p1','1']]);await assert.rejects(()=>m.b.respond({pane:'test:p1',ticket:s.agents[0].ticket,key:'enter'}));});
test('작업중인 에이전트 입력 차단',async()=>{const m=mock(),s=await m.b.refresh();m.a.agent_status='working';await assert.rejects(()=>m.b.respond({pane:'test:p1',ticket:s.agents[0].ticket,key:'enter'}));assert.equal(m.sent.length,0);});
test('요청 변경 차단',async()=>{const m=mock(),s=await m.b.refresh();m.setText('Different approval');await assert.rejects(()=>m.b.respond({pane:'test:p1',ticket:s.agents[0].ticket,key:'1'}));assert.equal(m.sent.length,0);});
test('세션 교체 차단',async()=>{const m=mock(),s=await m.b.refresh();m.a.agent_session={value:'session-b'};await assert.rejects(()=>m.b.respond({pane:'test:p1',ticket:s.agents[0].ticket,key:'1'}));assert.equal(m.sent.length,0);});
test('임의 명령 차단',async()=>{const m=mock();await m.b.refresh();await assert.rejects(()=>m.b.respond({pane:'test:p1',key:'ctrl+c; rm -rf'}));assert.equal(m.sent.length,0);});
