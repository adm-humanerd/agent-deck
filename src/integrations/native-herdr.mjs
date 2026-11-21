import {choices, fingerprint, allowedKeys} from './bridge.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function readTerminalMetadata(file=process.env.AGENT_DECK_HERDR_METADATA||path.join(process.env.XDG_STATE_HOME||path.join(os.homedir(),'.local/state'),'herdr-core/default/terminals.json')){
 try{
  const raw=JSON.parse(await fs.readFile(file,'utf8'));
  const map={};
  for(const [_,t] of Object.entries(raw.terminals||{})){
   if(t&&t.address){
    map[t.address]={
     title:t.title||null,
     fg:t.foreground?.name||null,
     statusApp:t.status?.app||null
    };
   }
  }
  return map;
 }catch{
  return {};
 }
}

// Native Herdr integrates Herdr.app (window/focus) and herdr-core (hc terminal read/input).
export function normalizeNativeHerdr(raw, blockedData = {}, termMeta = {}){
 if(!raw||!Array.isArray(raw.spaces))throw Error('Unexpected native Herdr window response');
 const sessions=[],seen=new Set();
 for(const space of raw.spaces){for(const tab of space.tabs||[]){
  function add(t,parent=null){
   if(!t||typeof t.terminal!=='string'||!t.terminal||seen.has(t.terminal))return;
   seen.add(t.terminal);const terminal=t.terminal;
   const status=typeof t.status==='string'?t.status:null;
   const agentStatus=status||'unknown';
   const blocked=blockedData[terminal]||{};
   const text=blocked.text||'';
   const meta=termMeta[terminal]||{};
   const metaTitle=meta.title&&meta.title.trim()?meta.title.trim():null;
   const tabTitle=typeof tab.name==='string'&&tab.name&&tab.name!=='1'?tab.name:null;
   const nodeName=typeof t.name==='string'&&t.name?t.name:null;
   const name=nodeName||metaTitle||tabTitle||terminal;
   const rawApp=typeof t.app==='string'&&t.app?t.app:meta.statusApp||meta.fg||null;
   const app=rawApp;
   // Automatic environment detection (Paseo, Orca, Pparit, T3, Herdr, GJC, AGY, Pi, Codex, etc.)
   function detectAgentEnvironment(t, tabName, appName, meta) {
     const fg = String(meta.fg || '').toLowerCase();
     const statusApp = String(meta.statusApp || '').toLowerCase();
     const hasExplicitFg = Boolean(meta.fg);
     const isShellProcess = hasExplicitFg && ['zsh', 'bash', 'sh', 'fish'].includes(fg);

     // 1. If an explicit foreground process or active statusApp is running, that is the agent:
     if (fg.includes('gjc') || statusApp === 'gjc') return 'gjc';
     if (fg.includes('pi') || statusApp === 'pi') return 'pi';
     if (fg.includes('agy') || fg.includes('antigravity') || (!isShellProcess && (statusApp === 'antigravity' || appName === 'antigravity'))) return 'agy';
     if (fg.includes('codex') || (!isShellProcess && (statusApp === 'codex' || appName === 'codex'))) return 'codex';
     if (fg.includes('claude') || (!isShellProcess && (statusApp === 'claude' || appName === 'claude'))) return 'claude';
     if (fg.includes('gemini') || (!isShellProcess && statusApp === 'gemini')) return 'gemini';
     if (fg.includes('paseo') || statusApp === 'paseo') return 'paseo';
     if (fg.includes('orca') || statusApp === 'orca') return 'orca';
     if (fg.includes('pparit') || fg.includes('빠릿') || fg.includes('parit') || statusApp === 'pparit') return 'pparit';
     if (fg.includes('t3code') || fg.includes('t3') || statusApp === 't3') return 't3';

     // 2. If the terminal foreground is verified to be an idle shell, it's just a terminal:
     if (isShellProcess) return 'terminal';

     // 3. Fallback:
     if (statusApp) return statusApp;
     if (appName && appName !== 'antigravity') return appName;
     return 'terminal';
   }
   const agentName=detectAgentEnvironment(t, tab.name, app, meta);
   const ch=agentStatus==='blocked'?(blocked.choices||choices(text)):[];
   const ticket=blocked.ticket||(text?fingerprint({pane_id:'native:'+terminal,agent_session:terminal,agent_status:agentStatus,revision:0,state_change_seq:0},text):null);
   sessions.push({
    id:'native:'+terminal,
    pane_id:'native:'+terminal,
    terminal,
    pane:typeof t.pane==='string'?t.pane:null,
    name,
    label:name,
    app,
    agent:agentName,
    status:agentStatus,
    agent_status:agentStatus,
    reported:status!==null,
    space:space.name||space.id,
    tab:tab.name||tab.id,
    machine:space.machine||'local',
    parent,
    source:'herdr-native',
    text,
    choices:ch,
    ticket,
    error:blocked.error||''
   });
   if(Array.isArray(t.sub_agents))for(const child of t.sub_agents)add(child,terminal);
  }
  for(const t of tab.terminals||[])add(t);
 }}
 return {sessions,source:'herdr-native',inputSupported:true};
}

export function createNativeHerdr(runApp,raiseApp=async()=>{},runHc=async()=>{return '';}){
 let inFlight=null,cached=null,busy=false,focusBusy=false;
 async function readTerminal(terminal){return await runHc(['read',terminal]);}
 async function inspect(){
  const raw=JSON.parse(await runApp(['ls']));
  const termMeta=await readTerminalMetadata();
  const blockedTargets=[];
  const seenBlocked=new Set();
  function collectBlocked(t){
   if(!t||typeof t.terminal!=='string'||!t.terminal||seenBlocked.has(t.terminal))return;
   seenBlocked.add(t.terminal);
   if(t.status==='blocked')blockedTargets.push(t.terminal);
   if(Array.isArray(t.sub_agents))for(const child of t.sub_agents)collectBlocked(child);
  }
  for(const space of raw.spaces||[]){
   for(const tab of space.tabs||[]){
    for(const t of tab.terminals||[])collectBlocked(t);
   }
  }
  const blockedData={};
  await Promise.all(blockedTargets.map(async terminal=>{
   try{
    const text=await readTerminal(terminal);
    const ch=choices(text);
    const ticket=fingerprint({pane_id:'native:'+terminal,agent_session:terminal,agent_status:'blocked',revision:0,state_change_seq:0},text);
    blockedData[terminal]={text,choices:ch,ticket};
   }catch(e){
    blockedData[terminal]={text:'',choices:[],ticket:null,error:e.message};
   }
  }));
  return normalizeNativeHerdr(raw,blockedData,termMeta);
 }
 async function refresh(){
  if(inFlight)return inFlight;
  inFlight=(async()=>{
   try{
    const data=await inspect();
    cached={...data,ok:true,error:null,updated:new Date().toISOString()};
    return cached;
   }catch{
    return {sessions:[],source:'herdr-native',inputSupported:false,ok:false,error:'Herdr 네이티브 앱 창에 연결할 수 없습니다. 앱을 열고 다시 조회하세요.',updated:new Date().toISOString()};
   }
  })().finally(()=>inFlight=null);
  return inFlight;
 }
 async function focus({id}){
  if(typeof id!=='string'||id.length>200)throw Error('올바른 네이티브 터미널을 선택하세요.');
  if(focusBusy)throw Error('다른 화면 전환을 처리 중입니다. 다시 누르세요.');
  focusBusy=true;
  try{
   const s=await inspect(),target=s.sessions.find(x=>x.id===id||x.pane_id===id);
   if(!target)throw Error('선택한 네이티브 터미널이 더 이상 없습니다.');
   await runApp(['do','agent.focus','--terminal',target.terminal]);
   const after=JSON.parse(await runApp(['status']));
   if(target.pane&&after.focused_pane!==target.pane)throw Error('네이티브 앱의 대상 창 전환을 확인하지 못했습니다.');
   await raiseApp();
   return {ok:true,id:target.id,message:'Herdr 앱 작업 창으로 전환했습니다.'};
  }finally{focusBusy=false;}
 }
 async function respond({id,ticket,key}){
  if(!allowedKeys.has(key))throw Error('허용되지 않은 키입니다.');
  if(busy)throw Error('다른 응답을 전송 중입니다.');
  busy=true;
  try{
   const prev=cached?.sessions.find(x=>x.id===id||x.pane_id===id);
   if(!prev||prev.ticket!==ticket)throw Error('오래된 요청입니다. 새로고침 후 다시 확인하세요.');
   const s=await inspect(),target=s.sessions.find(x=>x.id===id||x.pane_id===id);
   if(!target||target.status!=='blocked')throw Error('현재 승인/질문 대기 상태가 아닙니다. 입력하지 않았습니다.');
   if(target.ticket!==ticket)throw Error('요청 내용 또는 에이전트 세션이 바뀌었습니다. 입력하지 않았습니다.');
   cached=null;
   const result=await runHc(['keys',target.terminal,key]);
   return {ok:true,id:target.id,message:'키 전송 완료',result};
  }finally{busy=false;}
 }
 return {refresh,focus,respond};
}
export const nativeRaiseScript='tell application id "dev.herdr.app" to activate';
