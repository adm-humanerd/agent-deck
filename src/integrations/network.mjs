const WATCHED = [
 {id:'watch:muse',name:'Muse',agent:'muse',description:'연결해 둔 Muse 클라이언트'},
 {id:'watch:pickle',name:'Pickle',agent:'pickle',description:'연결해 둔 Pickle 클라이언트'},
];
function text(v,max=250){return typeof v==='string'?v.slice(0,max):null;}
export function normalizeNetwork(raw,now=Date.now()) {
 if(!raw||typeof raw!=='object'||!Array.isArray(raw.sessions))throw new Error('Unexpected Reason session response');
 const seen=new Set(),sessions=[];
 for(const s of raw.sessions){
  if(!s||typeof s!=='object')continue;
  const address=text(s.address,250);if(!address||seen.has(address))continue;seen.add(address);
  const status=text(s.status,40)||'unknown';
  sessions.push({id:'reason:'+address,address,name:text(s.name,120)||address,person:text(s.person,120),machine:text(s.machine,120),agent:text(s.agent,80)||'unknown',cwd:text(s.cwd,500),repo:text(s.repo,200),branch:text(s.branch,200),status,since:typeof s.since==='number'&&Number.isFinite(s.since)?s.since:null,doing:text(s.doing,1000),tier:text(s.tier,40),unread:Number.isInteger(s.unread)&&s.unread>=0?s.unread:0,listed:true,source:'reason'});
 }
 for(const w of WATCHED){
  const match=sessions.some(s=>{const a=s.agent.toLowerCase(),n=s.name.toLowerCase();return a===w.agent||n===w.agent||n.startsWith(w.agent+'-')||(w.agent==='pickle'&&n==='피클');});
  if(!match)sessions.push({...w,address:null,person:null,machine:null,repo:null,branch:null,cwd:null,status:'not-listed',since:null,doing:null,tier:null,unread:0,listed:false,source:'reason'});
 }
 sessions.sort((a,b)=>Number(b.listed)-Number(a.listed)||Number(a.status==='offline')-Number(b.status==='offline')||a.name.localeCompare(b.name));
 return {team:text(raw.team,200),person:text(raw.person,120),machine:text(raw.machine,120),sessions,updated:new Date(now).toISOString(),readOnly:true,onlineCount:sessions.filter(s=>s.listed&&['busy','idle','online','working','blocked','waiting'].includes(s.status)).length};
}
export function createNetworkReader(run,{now=()=>Date.now(),ttl=10000}={}){
 let cached=null,lastAttempt=-Infinity,inFlight=null;
 async function refresh(){
  if(inFlight)return inFlight;
  if(cached&&now()-lastAttempt<ttl)return cached;
  lastAttempt=now();
  inFlight=(async()=>{
   try{const raw=JSON.parse(await run(['who','--all','--json']));cached={...normalizeNetwork(raw,now()),ok:true,error:null};}
   catch(e){cached={...(cached||normalizeNetwork({sessions:[]},now())),ok:false,error:'Reason 세션을 조회하지 못했습니다. 로컬 Reason 서비스와 연결을 확인하세요.',checked:new Date(now()).toISOString()};}
   return cached;
  })().finally(()=>inFlight=null);
  return inFlight;
 }
 return {refresh};
}
