import {open,readFile,rename,unlink} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {defaultDeckLayouts,validateDeckLayouts} from './deck-layout.mjs';
import {validateCustomSnapshot} from '../actions/custom-snapshot.mjs';

export const MAX_LAYOUT_BYTES=65536;
export function actualPeerLocal(req){return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);}
export function localManagement(req,port=43187){return actualPeerLocal(req)&&['localhost:'+port,'127.0.0.1:'+port].includes(req.headers.host);}
export function sameOrigin(req){return typeof req.headers.host==='string'&&req.headers.origin==='http://'+req.headers.host&&(!req.headers['sec-fetch-site']||req.headers['sec-fetch-site']==='same-origin');}
export function layoutError(status,message){return Object.assign(new Error(message),{status});}
export function createLayoutHandler({store,auth,port=43187}){
 return async(req,res)=>{
  if(new URL(req.url,'http://localhost').pathname!=='/api/layout')return false;
  const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  try{
   if(['POST','PUT','PATCH','DELETE'].includes(req.method)&&(!localManagement(req,port)||!sameOrigin(req))){send(403,{error:'배치 관리는 맥의 동일 localhost 화면에서만 가능합니다.'});return true;}
   if(!await auth(req)){send(401,{error:'먼저 맥 화면의 연결 코드로 연결하세요.'});return true;}
   if(req.method!=='GET'){res.setHeader('Allow','GET');send(405,{error:'지원하지 않는 배치 요청 방식입니다.'});return true;}
   send(200,await store.get());
  }catch(error){send(error.status||500,{error:localManagement(req,port)?error.message:'배치 요청을 완료하지 못했습니다. PC에서 저장소 상태를 확인하세요.'});}
  return true;
 };
}
function revisionValid(value){return Number.isSafeInteger(value)&&value>=0;}
export function createLayoutStore(file=new URL('../../.deck-layout.json',import.meta.url),io={open,readFile,rename,unlink}){
 let queue=Promise.resolve();
 const listeners=new Set();
 function serialized(work){const result=queue.then(work);queue=result.catch(()=>{});return result;}
 async function load(){
  let text;
  try{text=await io.readFile(file,'utf8');}catch(error){
   if(error.code==='ENOENT')return {schemaVersion:1,revision:0,initialized:false,layouts:defaultDeckLayouts(),actions:[],assets:[]};
   throw layoutError(500,'배치 저장소를 읽지 못했습니다: '+error.message);
  }
  try{
   const value=JSON.parse(text);
   if(!value||!revisionValid(value.revision)||value.revision===0)throw Error('잘못된 revision');
   if(value.schemaVersion===undefined){
    if(Object.keys(value).sort().join(',')!=='layouts,revision')throw Error('알 수 없는 기존 형식');
    return {schemaVersion:1,revision:value.revision,initialized:true,layouts:validateDeckLayouts(value.layouts),actions:[],assets:[],legacyBytes:text};
   }
   return {...validateCustomSnapshot(value),initialized:true};
  }catch(error){throw layoutError(500,'배치 저장소가 손상되었습니다. 원본을 복구하세요: '+error.message);}
 }
 async function persist(value){
  const tmp=file instanceof URL?new URL(file.href+'.'+randomUUID()+'.tmp'):file+'.'+randomUUID()+'.tmp';
  let handle,created=false;
  try{
   handle=await io.open(tmp,'wx',0o600);created=true;
   await handle.writeFile(JSON.stringify({schemaVersion:1,revision:value.revision,layouts:value.layouts,actions:value.actions,assets:value.assets}),'utf8');
   await handle.sync();await handle.close();handle=undefined;
   await io.rename(tmp,file);
   for(const listener of listeners)listener(value.revision);
  }catch(error){throw layoutError(500,'배치를 저장하지 못했습니다: '+error.message);}
  finally{
   if(handle)await handle.close().catch(()=>{});
   if(created)await io.unlink(tmp).catch(()=>{});
  }
 }
 async function writeLocked(work){
  const lock=file instanceof URL?new URL(file.href+'.lock'):file+'.lock';let handle;
  try{handle=await io.open(lock,'wx',0o600);}catch(error){throw layoutError(error.code==='EEXIST'?423:500,'배치 쓰기 잠금 실패. 원본과 초안을 보존했습니다.');}
  try{return await work();}finally{await handle.close().catch(()=>{});await io.unlink(lock).catch(()=>{});}
 }
 async function retainLegacy(current){
  if(current.legacyBytes===undefined)return;
  const suffix='.legacy-'+createHash('sha256').update(current.legacyBytes).digest('hex');
  const backup=file instanceof URL?new URL(file.href+suffix):file+suffix;
  let handle;
  try{handle=await io.open(backup,'wx',0o600);await handle.writeFile(current.legacyBytes,'utf8');await handle.sync();}
  catch(error){if(error.code!=='EEXIST')throw error;if(await io.readFile(backup,'utf8')!==current.legacyBytes)throw Error('기존 원본 보존 파일이 다릅니다.');}
  finally{if(handle)await handle.close();}
 }
 const publicLayout=value=>({revision:value.revision,initialized:value.initialized,layouts:value.layouts});
 return {
  subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);},
  get(){return serialized(async()=>publicLayout(await load()));},
  snapshot(){return serialized(async()=>{const {legacyBytes,...value}=await load();return value;});},
  admit(revision,enter){return serialized(()=>writeLocked(async()=>{
   const current=await load();
   if(current.revision!==revision)throw layoutError(409,'실행 전 스냅샷이 변경되었습니다.');
   // enter must synchronously enter the effect and wrap any resulting promise.
   // The lock protects admission, not the lifetime of an already-entered effect.
   const result=enter(current);
   if(result&&typeof result.then==='function')throw layoutError(500,'비동기 실행 진입은 허용되지 않습니다.');
   return result;
  }));},
  putSnapshot(input,verifyAssets=async()=>{}){return serialized(()=>writeLocked(async()=>{
   let next;try{next=validateCustomSnapshot(input);}catch(error){throw layoutError(400,error.message);}
   const current=await load();
   if(next.revision!==current.revision)throw layoutError(409,'다른 화면에서 스냅샷이 변경되었습니다. 초안은 보존됩니다.');
   if(current.revision===Number.MAX_SAFE_INTEGER)throw layoutError(500,'배치 revision 한도에 도달했습니다.');
   await verifyAssets(next.assets);await retainLegacy(current);
   next.revision++;await persist(next);return {...next,initialized:true};
  }));},
  put(input){return serialized(async()=>{
   if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='layouts,revision'||!revisionValid(input.revision))throw layoutError(400,'유효한 revision과 layouts가 필요합니다.');
   let layouts;
   try{layouts=validateDeckLayouts(input.layouts);}catch(error){throw layoutError(400,'배치 형식이 잘못되었습니다: '+error.message);}
   return writeLocked(async()=>{const current=await load();
   if(input.revision!==current.revision)throw layoutError(409,'배치가 다른 화면에서 변경되었습니다. 새로고침 후 다시 저장하세요.');
   if(current.revision===Number.MAX_SAFE_INTEGER)throw layoutError(500,'배치 revision 한도에 도달했습니다.');
   const next={schemaVersion:1,revision:current.revision+1,initialized:true,layouts,actions:current.actions,assets:current.assets};
   try{validateCustomSnapshot({schemaVersion:1,revision:next.revision,layouts,actions:next.actions,assets:next.assets});}catch(error){throw layoutError(400,error.message);}
   await retainLegacy(current);
   await persist(next);
   return publicLayout(next);});
  });}
 };
}
export async function readLayoutBody(req){
 let size=0;const chunks=[];
 for await(const chunk of req){
  const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
  size+=bytes.length;
  if(size<=MAX_LAYOUT_BYTES)chunks.push(bytes);
 }
 if(size>MAX_LAYOUT_BYTES)throw layoutError(413,'배치 요청은 65536바이트 이하여야 합니다.');
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw layoutError(400,'올바른 JSON 배치 요청이 필요합니다.');}
}
