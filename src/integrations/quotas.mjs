import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
const digest = value => createHash('sha256').update(String(value)).digest('hex').slice(0,16);
function stop(child){
 if(child.pid){try{process.kill(-child.pid,'SIGKILL');return;}catch{}}
 child.kill('SIGKILL');
}
export const QUOTA_TTL = 60000, QUOTA_STALE = 180000;
function percent(value, scale=1) {
 return typeof value==='number' && Number.isFinite(value) && value>=0 && value<=100/scale ? Math.round(value*scale*10)/10 : null;
}
function reset(value) {
 if(typeof value==='number')value*=1000;
 else if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT/.test(value))return null;
 const date=new Date(value);return Number.isFinite(date.getTime())?date.toISOString():null;
}
const emptyWindow = () => ({remaining:null,resetsAt:null});
function base(provider) {return {provider,scope:'active-account',accountLabel:'활성계정 · 전체 계정 아님',plan:null,buckets:[],models:[]};}
export function normalizeCodex(result) {
 const out=base('codex');
 const planRaw=result?.rateLimits?.planType||result?.planType||Object.values(result?.rateLimitsByLimitId||{})[0]?.planType;
 if(typeof planRaw==='string'&&/^[a-zA-Z0-9_ -]{1,32}$/.test(planRaw))out.plan=planRaw.charAt(0).toUpperCase()+planRaw.slice(1).toLowerCase();
 const mapped=result?.rateLimitsByLimitId;
 const entries=mapped && typeof mapped==='object' && Object.keys(mapped).length ? Object.entries(mapped) : [['active',result?.rateLimits]];
 const seen=new Set();
 for(const [key,value] of entries){
  if(!value||typeof value!=='object')continue;
  const identity=value.limitId||key;
  if(seen.has(identity))continue;seen.add(identity);
  const bucket={id:'codex-'+digest(identity),label:'공유 한도 '+(out.buckets.length+1),fiveHour:emptyWindow(),weekly:emptyWindow()};
  for(const w of [value.primary,value.secondary]){
   if(!w)continue;
   const target=w.windowDurationMins===300?'fiveHour':w.windowDurationMins===10080?'weekly':null;
   if(!target)continue;
   const used=percent(w.usedPercent);
   bucket[target]={remaining:used===null?null:Math.round((100-used)*10)/10,resetsAt:reset(w.resetsAt)};
  }
  out.buckets.push(bucket);
 }
 return out;
}
export function normalizeAgy(result) {
 const out=base('agy'), seen=new Set();
 const planRaw=result?.planType||result?.userStatus?.planType||result?.plan;
 out.plan=typeof planRaw==='string'&&/^[a-zA-Z0-9_ -]{1,32}$/.test(planRaw)?planRaw:null;
 for(const model of result?.userStatus?.cascadeModelConfigData?.clientModelConfigs||[]){
  const q=model?.quotaInfo;if(!q||typeof q!=='object')continue;
  const modelId=String(model.modelId||model.label||'unknown');
  // Only explicit shared identifiers dedupe models; equal percentages do not prove sharing.
  const identity=q.bucketId||q.quotaId||modelId;
  if(seen.has(identity))continue;seen.add(identity);
  const rawLabel=String(model.label||model.modelId||'');
  const label=/^[\w .()+:/-]{1,80}$/.test(rawLabel)&&!/(token|bearer|secret|csrf)/i.test(rawLabel)?rawLabel:'모델 '+(out.models.length+1);
  out.models.push({id:'agy-'+digest(identity),label,remaining:percent(q.remainingFraction,100),resetsAt:reset(q.resetTime),period:'unconfirmed'});
 }
 // GetUserStatus does not establish 5h/weekly periods. Never infer from model names.
 out.buckets=[{id:'agy-active',label:'기간 미확정 · 모델별 상세',fiveHour:emptyWindow(),weekly:emptyWindow()}];
 return out;
}
export function readCodex({command='codex',timeout=8000,spawnProcess=spawn}={}) {
 return new Promise((resolve,reject)=>{
  const child=spawnProcess(command,['app-server','--stdio'],{stdio:['pipe','pipe','ignore'],detached:true});
  let buffer='',bytes=0,done=false,initialized=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);child.stdin.destroy();stop(child);error?reject(new Error(error)):resolve(value);};
  const timer=setTimeout(()=>finish('timeout'),timeout);
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
  child.on('error',()=>finish('unavailable'));
  child.on('exit',()=>finish('unavailable'));
  child.stdin.on('error',()=>finish('unavailable'));
  child.stdout.on('data',chunk=>{
   bytes+=chunk.length;if(bytes>2*1024*1024){finish('invalid-response');return;}
   buffer+=chunk.toString();let index;
   while((index=buffer.indexOf('\n'))>=0){
    const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
    let msg;try{msg=JSON.parse(line);}catch{continue;}
    if(msg.id===1&&!initialized){
     if(msg.error){finish('query-error');return;}initialized=true;
     send({method:'initialized'});send({id:2,method:'account/rateLimits/read',params:{}});
    }else if(msg.id===2){finish(msg.error?'query-error':null,msg.result);return;}
   }
  });
  send({id:1,method:'initialize',params:{clientInfo:{name:'agent-deck-quota',version:'1.0.0'}}});
 });
}
// Import only the read-side helper, not main/parse_quota_data/save_state. No cache, SVG or CSRF writes.
const agyRead = `import importlib.util,json,os,subprocess,sys
sys.dont_write_bytecode=True
d=None
try:
 p=os.path.expanduser('~/agy-quota-guard/quota_guard.py')
 s=importlib.util.spec_from_file_location('deck_quota_guard',p)
 m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
 d,_,_=m.get_active_user_status()
except Exception: pass
if not d:
 try:
  b=os.path.expanduser('~/.local/bin/agy')
  cmd=[b if os.path.exists(b) else 'agy','-p','/usage','--output-format','json']
  out=subprocess.check_output(cmd,timeout=8,stderr=subprocess.DEVNULL).decode()
  j=json.loads(out)
  models=[]
  for g in j.get('command',{}).get('data',{}).get('groups',[]):
   desc=g.get('description','')
   m_names=[]
   if 'Models within this group:' in desc:
    m_names=[x.strip() for x in desc.split('Models within this group:')[1].split(',') if x.strip()]
   elif g.get('name')=='Gemini 4 Argon':
    m_names=['Gemini 4 Argon']
   for mn in m_names:
    for bk in g.get('buckets',[]):
     models.append({'label':mn,'modelId':mn,'quotaInfo':{'remainingFraction':bk.get('remaining_fraction'),'resetTime':bk.get('reset_time')}})
     break
  if models: d={'userStatus':{'cascadeModelConfigData':{'clientModelConfigs':models}}}
 except Exception: pass
if not d: raise RuntimeError('unavailable')
models=d.get('userStatus',{}).get('cascadeModelConfigData',{}).get('clientModelConfigs',[])
print(json.dumps({'planType':d.get('planType') or d.get('userStatus',{}).get('planType') or d.get('plan'),'userStatus':{'cascadeModelConfigData':{'clientModelConfigs':[{'label':x.get('label'),'modelId':x.get('modelId'),'quotaInfo':x.get('quotaInfo')} for x in models]}}}))`;
export function readAgy({timeout=10000,spawnProcess=spawn}={}) {
 const env={...process.env,HOME:homedir(),PYTHONDONTWRITEBYTECODE:'1'};
 // The original helper supports an environment address. Never send CSRF outside loopback.
 if(env.ANTIGRAVITY_LS_ADDRESS&&!/^127\.0\.0\.1:\d{1,5}$/.test(env.ANTIGRAVITY_LS_ADDRESS))delete env.ANTIGRAVITY_LS_ADDRESS;
 return new Promise((resolve,reject)=>{
  const child=spawnProcess('/usr/bin/python3',['-B','-c',agyRead],{env,detached:true,stdio:['ignore','pipe','ignore']});
  let text='',done=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);stop(child);error?reject(new Error(error)):resolve(value);};
  const timer=setTimeout(()=>finish('timeout'),timeout);
  child.on('error',()=>finish('unavailable'));
  child.stdout.on('data',chunk=>{text+=chunk.toString();if(text.length>2*1024*1024)finish('invalid-response');});
  child.on('close',code=>{if(code!==0){finish('unavailable');return;}try{finish(null,JSON.parse(text));}catch{finish('invalid-response');}});
 });
}
export function createQuotaReader({codex=readCodex,agy=readAgy,now=Date.now,ttl=QUOTA_TTL,staleAfter=QUOTA_STALE}={}) {
 const cache=new Map();let inFlight,lastAttempt=-Infinity;
 const project=()=>({providers:['codex','agy'].map(provider=>{
  const entry=cache.get(provider)||{...base(provider),checkedAt:null,attemptedAt:null,error:null};
  return {...entry,stale:!!entry.error||!entry.checkedAt||now()-Date.parse(entry.checkedAt)>staleAfter};
 }),refreshAfterMs:Math.max(0,ttl-(now()-lastAttempt))});
 async function collect(provider,read,normalize){
  const attemptedAt=new Date(now()).toISOString();
  try{
   const value=normalize(await read());
   if(!value.buckets.some(b=>[b.fiveHour,b.weekly].some(w=>w.remaining!==null))&&!value.models.some(m=>m.remaining!==null))throw Error('missing');
   cache.set(provider,{...value,checkedAt:new Date(now()).toISOString(),attemptedAt,error:null});
  }catch{
   // Old values remain visibly stale/error-bound, never silently replaced with 100%.
   const old=cache.get(provider)||{...normalize(null),checkedAt:null};
   cache.set(provider,{...old,attemptedAt,error:'조회 실패 · 연결 또는 로그인 상태를 확인하세요'});
  }
 }
 return {async refresh(){
  if(inFlight){await inFlight;return project();}
  if(now()-lastAttempt>=ttl){lastAttempt=now();inFlight=Promise.all([collect('codex',codex,normalizeCodex),collect('agy',agy,normalizeAgy)]).finally(()=>{inFlight=null;});await inFlight;}
  return project();
 }};
}
