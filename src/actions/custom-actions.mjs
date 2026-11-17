import {randomBytes} from 'node:crypto';
import {localManagement,readLayoutBody,layoutError} from '../deck/shared-layout.mjs';
import {projectSnapshot} from './custom-snapshot.mjs';
import {readImageBody,assetIdValid} from './deck-assets.mjs';

const strict=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const opaque=()=>randomBytes(32).toString('hex');
export function createCustomHandler({store,assets,dispatcher,auth,authority,admitAuthority,port=43187,now=Date.now}){
 const contexts=new Map(),runs=new Map();
 store.subscribe?.(revision=>{contexts.clear();for(const [id,run]of runs)if(run.revision!==revision)Promise.resolve(dispatcher.cancel(id)).catch(()=>{});});
 const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
 const prune=()=>{for(const [key,value]of contexts)if(value.expires<=now())contexts.delete(key);};
 async function invalidate(){contexts.clear();for(const [id,run]of runs)if(run.revision!==(await store.snapshot()).revision)dispatcher.cancel(id);}
 const handler=async(req,res)=>{
  const route=new URL(req.url,'http://localhost').pathname;
  if(route!=='/api/custom-layout'&&!route.startsWith('/api/actions/')&&!route.startsWith('/api/assets/'))return false;
  const local=localManagement(req,port);
  try{
   if(!auth(req))throw layoutError(401,'등록된 기기가 필요합니다.');
   if(route==='/api/custom-layout'){
    if(req.method==='GET'){send(res,200,projectSnapshot(await store.snapshot(),local));return true;}
    if(req.method!=='PUT')throw layoutError(405,'GET/PUT만 지원합니다.');
    if(!local)throw layoutError(403,'동작과 배치는 PC localhost에서만 작성할 수 있습니다.');
    const value=await store.putSnapshot(await readLayoutBody(req),ids=>assets.verify(ids));
    await invalidate();send(res,200,projectSnapshot(value,true));return true;
   }
   if(route==='/api/assets/upload'){
    if(req.method!=='POST')throw layoutError(405,'POST만 지원합니다.');
    if(!local)throw layoutError(403,'이미지는 PC localhost에서만 업로드할 수 있습니다.');
    send(res,201,await assets.stage(await readImageBody(req)));return true;
   }
   if(route.startsWith('/api/assets/')&&req.method==='GET'){
    const id=route.slice('/api/assets/'.length);
    if(!assetIdValid(id)||(await store.snapshot()).assets.includes(id)===false)throw layoutError(404,'게시되지 않은 이미지입니다.');
    const bytes=await assets.read(id);res.writeHead(200,{'Content-Type':'image/webp','Content-Length':bytes.length,'Content-Disposition':'inline'});res.end(bytes);return true;
   }
   if(route==='/api/actions/capabilities'&&req.method==='GET'){if(!local)throw layoutError(403,'수신기 정보는 PC 전용입니다.');send(res,200,await dispatcher.capabilities());return true;}
   if(route==='/api/actions/runs'&&req.method==='GET'){
    if(!local)throw layoutError(403,'실행 출력은 PC 전용입니다.');
    send(res,200,[...runs].map(([id,run])=>({actionId:run.actionId,...dispatcher.status(id)})).filter(run=>run.runId));return true;
   }
   if(route==='/api/actions/prepare'&&req.method==='POST'){
    prune();if(contexts.size>=1024)throw layoutError(429,'너무 많은 실행 준비 요청입니다.');
    const data=await readLayoutBody(req);
    if(!strict(data,['actionId','revision','pageId','slotIndex'])||!Number.isInteger(data.slotIndex)||data.slotIndex<0||data.slotIndex>=15)throw layoutError(400,'저장된 키 ID와 revision만 사용할 수 있습니다.');
    const current=await store.snapshot(),slot=current.layouts.find(page=>page.id===data.pageId)?.slots[data.slotIndex],action=current.actions.find(action=>action.id===data.actionId);
    if(data.revision!==current.revision||slot?.type!=='custom'||slot.actionId!==data.actionId||!action?.enabled)throw layoutError(409,'동작 또는 배치가 변경되었거나 비활성화되었습니다.');
    const receiverProof=['sessionText','keyCombo'].includes(action.definition.kind)?await dispatcher.receiverContext(action.definition):undefined;
    if(!auth(req)||(await store.snapshot()).revision!==current.revision)throw layoutError(409,'준비 중 권한 또는 동작이 변경되었습니다.');
    const context=opaque(),nonce=opaque();contexts.set(context,{...data,receiverProof,nonce,authority:authority(req),expires:now()+10000});
    send(res,200,{actionId:data.actionId,revision:current.revision,context,nonce});return true;
   }
   if(route==='/api/actions/invoke'&&req.method==='POST'){
    const data=await readLayoutBody(req);
    if(!strict(data,['actionId','revision','context','nonce']))throw layoutError(400,'실행 payload 재정의는 허용되지 않습니다.');
    const entry=contexts.get(data.context);contexts.delete(data.context); // consume before ANY async work, including failed attempts
    if(!entry||entry.expires<=now()||entry.nonce!==data.nonce||entry.actionId!==data.actionId||entry.revision!==data.revision||entry.authority!==authority(req))throw layoutError(409,'만료되거나 이미 사용한 실행 문맥입니다. 다시 실행하지 않았습니다.');
    const recheck=async()=>{
     if(!auth(req))throw layoutError(403,'기기 권한이 해제되었습니다.');
     const current=await store.snapshot(),slot=current.layouts.find(page=>page.id===entry.pageId)?.slots[entry.slotIndex],action=current.actions.find(action=>action.id===entry.actionId);
     if(!auth(req))throw layoutError(403,'기기 권한이 해제되었습니다.');
     if(current.revision!==entry.revision||slot?.type!=='custom'||slot.actionId!==entry.actionId||!action?.enabled)throw layoutError(409,'실행 전 동작이 변경되었습니다.');
     return action;
    };
    const action=await recheck();
    const withAdmission=enter=>store.admit(entry.revision,current=>{
     const slot=current.layouts.find(page=>page.id===entry.pageId)?.slots[entry.slotIndex],stored=current.actions.find(action=>action.id===entry.actionId);
     if(!auth(req)||slot?.type!=='custom'||slot.actionId!==entry.actionId||!stored?.enabled)throw layoutError(409,'실행 진입 전에 권한 또는 저장된 동작이 변경되었습니다.');
     return admitAuthority(req,enter);
    });
    const result=await dispatcher.dispatch(action.definition,{beforeDispatch:recheck,withAdmission,...(['sessionText','keyCombo'].includes(action.definition.kind)?{expectedReceiver:entry.receiverProof}:{})});
    if(result.runId){runs.set(result.runId,{authority:entry.authority,revision:entry.revision,actionId:entry.actionId});if(runs.size>256)runs.delete(runs.keys().next().value);}
    send(res,202,{runId:result.runId,state:result.state});return true;
   }
   const match=route.match(/^\/api\/actions\/(status|cancel)\/([a-zA-Z0-9-]{1,80})$/);
   if(match&&req.method===(match[1]==='status'?'GET':'POST')){
    const [,operation,id]=match,run=runs.get(id);
    if(!run||(!local&&run.authority!==authority(req)))throw layoutError(404,'없는 실행입니다.');
    const result=operation==='cancel'?dispatcher.cancel(id):local&&dispatcher.localStatus?dispatcher.localStatus(id):dispatcher.status(id);
    send(res,200,await result);return true;
   }
   throw layoutError(404,'없는 사용자 동작 경로입니다.');
  }catch(error){send(res,error.status||409,{error:local&&error.status?error.message:'동작을 완료하지 못했습니다. PC에서 수신기/권한/저장 상태를 확인하세요.'});}
  return true;
 };
 handler.revoke=()=>{contexts.clear();for(const [id,run]of runs)if(run.authority!=='local')Promise.resolve(dispatcher.cancel(id)).catch(()=>{});};
 return handler;
}
