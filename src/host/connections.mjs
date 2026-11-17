import os from 'node:os';
import {readFile,rename,open,unlink} from 'node:fs/promises';
import {readFileSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {randomBytes,createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export function connectionAddresses(interfaces=os.networkInterfaces(),port=43187){
 return Object.entries(interfaces).flatMap(([name,entries])=>(entries||[]).filter(x=>(x.family==='IPv4'||x.family===4)&&!x.internal).map(x=>({name,address:x.address,url:'http://'+x.address+':'+port,kind:x.address.startsWith('169.254.')?'link-local':'network'})));
}
export function allowedHost(host,addresses,port=43187){return new Set(['localhost','127.0.0.1',...addresses.map(x=>x.address)].map(x=>x+':'+port)).has(host);}
// Browser cookies have a maximum lifetime. Renew on authenticated requests;
// server-side device registrations never expire and can be revoked locally.
export const SESSION_SECONDS=400*24*60*60;
export function sessionCookie(token){return 'deck='+token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age='+SESSION_SECONDS;}
const pairingName=(file,suffix)=>file instanceof URL?new URL(file.href+suffix):file+suffix;
function validatePairings(entries,legacy=false){
 if(!entries||typeof entries!=='object'||Array.isArray(entries))throw Error('Invalid pairing store');
 for(const [key,value] of Object.entries(entries)){
  if(!/^[a-f0-9]{64}$/.test(key))throw Error('Invalid pairing credential key; original preserved');
  if(typeof value==='number'){
   if(!legacy)throw Error('Legacy pairing data requires explicit lossless migration; original preserved');
   if(!Number.isFinite(value)||value<0)throw Error('Invalid legacy registration');
   continue;
  }
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).join(',')!=='registeredAt'||!Number.isFinite(value.registeredAt)||value.registeredAt<0)throw Error('Invalid pairing registration; original preserved');
 }
 return entries;
}
async function readPairings(file){
 let text;
 try{text=await readFile(file,'utf8');}catch(error){if(error.code==='ENOENT')return {};throw error;}
 return validatePairings(JSON.parse(text));
}
function currentPairings(file){
 // Synchronous authorization must consult the canonical file, never an old cache.
 let text;
 try{text=readFileSync(file,'utf8');}catch(error){if(error.code==='ENOENT')return {};throw error;}
 return validatePairings(JSON.parse(text));
}
async function withPairingLock(file,action){
 const lock=pairingName(file,'.lock');let handle;
 try{handle=await open(lock,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw Object.assign(Error('Pairing store locked; original preserved'),{code:'PAIRING_LOCKED'});throw error;}
 try{return await action();}finally{try{await handle.close();}finally{await unlink(lock);}}
}
async function replacePairings(file,entries){
 const tmp=pairingName(file,'.'+randomUUID()+'.tmp');let pending;
 try{
  pending=await open(tmp,'wx',0o600);
  try{await pending.writeFile(JSON.stringify(entries));await pending.sync();}finally{await pending.close();}
  await rename(tmp,file);
 }finally{if(pending)await unlink(tmp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
export async function createSessions(file,now=()=>Date.now()){
 await readPairings(file);
 const digest=token=>createHash('sha256').update(token).digest('hex');
 let queue=Promise.resolve();
 function update(change){
  const result=queue.then(()=>withPairingLock(file,async()=>{
   const entries=await readPairings(file),value=change(entries);
   validatePairings(entries);
   await replacePairings(file,entries);
   return value;
  }));
  queue=result.catch(()=>{}); // Keep later explicit operations usable after failure.
  return result;
 }
 return {
  has(token){return typeof token==='string'&&/^[a-f0-9]{64}$/.test(token)&&Object.hasOwn(currentPairings(file),digest(token));},
  count(){return Object.keys(currentPairings(file)).length;},
  admit(token,enter){
   const lock=pairingName(file,'.lock');let handle;
   try{handle=openSync(lock,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw Object.assign(Error('Pairing store locked; original preserved'),{code:'PAIRING_LOCKED'});throw error;}
   try{
    const entries=currentPairings(file);
    if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token)||!Object.hasOwn(entries,digest(token)))throw Object.assign(Error('Pairing credential not authorized'),{code:'PAIRING_UNAUTHORIZED'});
    return {effect:enter()};
   }finally{try{closeSync(handle);}finally{unlinkSync(lock);}}
  },
  issue(){return update(entries=>{const token=randomBytes(32).toString('hex');entries[digest(token)]={registeredAt:now()};return token;});},
  revokeAll(){return update(entries=>{for(const key of Object.keys(entries))delete entries[key];});}
 };
}
// Explicit owner operation only. Never invoked as a side effect of startup/read.
export async function migratePairingStore(file,now=()=>Date.now()){
 return withPairingLock(file,async()=>{
 const bytes=await readFile(file),entries=validatePairings(JSON.parse(bytes.toString('utf8')),true);
 const migratedAt=now();
 const next={};
 for(const [key,value]of Object.entries(entries)){
  if(typeof value==='number'){
   if(value>migratedAt)next[key]={registeredAt:migratedAt};
  }else{
   next[key]=value;
  }
 }
 validatePairings(next);
 const backup=pairingName(file,'.legacy-'+createHash('sha256').update(bytes).digest('hex'));let handle;
 try{handle=await open(backup,'wx',0o600);}catch(error){if(error.code!=='EEXIST'||!(await readFile(backup)).equals(bytes))throw error;}
 if(handle){try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}}
 await replacePairings(file,next);
 return {registered:Object.keys(next).length,originalPreserved:true};
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==3||process.argv[2]!=='--migrate')throw Error('Explicit migration requires: node src/host/connections.mjs --migrate');
 const result=await migratePairingStore(new URL('../../.paired-sessions.json',import.meta.url));
 console.log(JSON.stringify(result));
}
