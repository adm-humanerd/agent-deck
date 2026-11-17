import http from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomInt,timingSafeEqual} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {connectionAddresses,allowedHost,createSessions,sessionCookie} from './src/host/connections.mjs';
import {createBridge} from './src/integrations/bridge.mjs';
import {raiseHerdrTerminal} from './src/host/terminal-focus.mjs';
import {createNetworkReader} from './src/integrations/network.mjs';
import {createNativeHerdr,nativeRaiseScript} from './src/integrations/native-herdr.mjs';
import {detectAvailableRuntimes} from './src/host/runtime-detector.mjs';
import {createQuotaReader} from './src/integrations/quotas.mjs';
import {createLayoutStore,createLayoutHandler,localManagement,sameOrigin} from './src/deck/shared-layout.mjs';
import {createAssetStore} from './src/actions/deck-assets.mjs';
import {createCustomHandler} from './src/actions/custom-actions.mjs';
import {createHostDispatcher} from './src/host/host-actions.mjs';
import {discoverHostTools} from './src/host/host-config.mjs';
import {loadReceivers} from './src/host/receiver-config.mjs';
const exec=promisify(execFile),port=43187;
const htmlPath=new URL('./src/deck/index.html',import.meta.url);
export function local(req,listenPort=port){return localManagement(req,listenPort);}
export {sameOrigin};
function deviceToken(req){return (req.headers.cookie||'').match(/(?:^|; )deck=([a-f0-9]+)/)?.[1];}
function send(res,status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(obj));}
async function body(req){let text='';for await(const c of req){text+=c;if(text.length>2048)throw new Error('요청이 너무 큽니다.');}return JSON.parse(text||'{}');}
export function createRequestHandler({sessions,layouts=createLayoutStore(),assets=createAssetStore(fileURLToPath(new URL('./.deck-assets',import.meta.url))),dispatcher=createHostDispatcher(),bridge,network,nativeHerdr,quotas,pin=String(randomInt(100000,1000000)),listenPort=port,addresses=()=>connectionAddresses(undefined,listenPort)}){
const attempts=new Map();
const isLocal=req=>local(req,listenPort);
function auth(req){if(isLocal(req))return true;try{return sessions.has(deviceToken(req));}catch{return false;}}
const handleLayout=createLayoutHandler({store:layouts,auth,port:listenPort});
const handleCustom=createCustomHandler({store:layouts,assets,dispatcher,auth,authority:req=>isLocal(req)?'local':deviceToken(req),admitAuthority:(req,enter)=>{
 if(isLocal(req))return {effect:enter()};
 if(typeof sessions.admit!=='function')throw Error('Paired authority admission is unavailable');
 return sessions.admit(deviceToken(req),enter);
},port:listenPort});
let inFlight;
function state(){if(!inFlight)inFlight=bridge.refresh().finally(()=>inFlight=null);return inFlight;}
return async(req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
 const connections=addresses();
 if(!allowedHost(req.headers.host,connections,listenPort)){send(res,403,{error:'허용되지 않은 호스트'});return;}
 const route=new URL(req.url,'http://'+req.headers.host).pathname;
 if(['POST','PUT','PATCH','DELETE'].includes(req.method)&&!sameOrigin(req)){send(res,403,{error:'다른 사이트에서 보낸 요청은 차단됩니다.'});return;}
 if(route.startsWith('/api/devices/')&&['POST','PUT','PATCH','DELETE'].includes(req.method)&&!isLocal(req)){send(res,403,{error:'기기 관리는 맥의 localhost 화면에서만 가능합니다.'});return;}
 try {
  if(route==='/api/layout'&&req.method==='PUT'){await handleLayout(req,res);return;}
  if(!isLocal(req)&&auth(req))res.setHeader('Set-Cookie',sessionCookie(deviceToken(req)));
  if(route==='/'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(await readFile(htmlPath));return;}
  if(route==='/api/runtimes'&&req.method==='GET'){const list=await detectAvailableRuntimes();send(res,200,{ok:true,runtimes:list,active:list[0]?.id||null});return;}
  if(route==='/api/info'&&req.method==='GET'){send(res,200,{paired:auth(req),local:isLocal(req),urls:isLocal(req)?connections.map(x=>x.url):[],connections:isLocal(req)?connections:[],pairCode:isLocal(req)?pin:undefined,registrationPolicy:'until-revoked',registeredDevices:isLocal(req)?sessions.count():undefined});return;}
  if(route==='/api/pair'&&req.method==='POST'){
    const ip=req.socket.remoteAddress,now=Date.now(),entry=attempts.get(ip)||{count:0,since:now};
    if(now-entry.since>300000){entry.count=0;entry.since=now;}entry.count++;attempts.set(ip,entry);
    if(entry.count>8){send(res,429,{error:'잠시 후 다시 연결하세요.'});return;}
    const {code}=await body(req),b=Buffer.from(String(code||'')),p=Buffer.from(pin);
    if(b.length!==p.length||!timingSafeEqual(b,p)){send(res,403,{error:'연결 코드가 맞지 않습니다.'});return;}
    const token=await sessions.issue();
    res.setHeader('Set-Cookie',sessionCookie(token));
    send(res,200,{ok:true});return;
  }
  if(route==='/api/devices/revoke-all'&&req.method==='POST'){
    if(!isLocal(req)){send(res,403,{error:'기기 등록 해제는 맥의 localhost 화면에서만 가능합니다.'});return;}
    await sessions.revokeAll();handleCustom.revoke();send(res,200,{ok:true});return;
  }
  if(await handleLayout(req,res))return;
  if(await handleCustom(req,res))return;
  if(!auth(req)){send(res,401,{error:'먼저 맥 화면의 연결 코드로 연결하세요.'});return;}
  if(route==='/api/quotas'&&req.method==='GET'){send(res,200,await quotas.refresh());return;}
  if(route==='/api/state'&&req.method==='GET'){send(res,200,await state());return;}
  if(route==='/api/native/state'&&req.method==='GET'){send(res,200,await nativeHerdr.refresh());return;}
  if(route==='/api/native/focus'&&req.method==='POST'){send(res,200,await nativeHerdr.focus(await body(req)));return;}
  if(route==='/api/native/respond'&&req.method==='POST'){const data=await body(req);send(res,200,await nativeHerdr.respond(data));return;}
  if(route==='/api/network'&&req.method==='GET'){send(res,200,await network.refresh());return;}
  if(route==='/api/focus'&&req.method==='POST'){const data=await body(req);send(res,200,await bridge.focus(data));return;}
  if(route==='/api/respond'&&req.method==='POST'){const data=await body(req);send(res,200,await bridge.respond(data));return;}
  send(res,404,{error:'Not found'});
 }catch(e){send(res,e.status||(route==='/api/layout'?500:409),{error:e.message});}
};
}
export async function startServer(){
const sessions=await createSessions(new URL('./.paired-sessions.json',import.meta.url));
const tools=await discoverHostTools();
const runTool=key=>async args=>{if(!tools[key])throw Error('선택 통합을 사용할 수 없습니다: '+key);return (await exec(tools[key],args,{timeout:7000,maxBuffer:2*1024*1024})).stdout;};
const bridge=createBridge(runTool('herdr'),()=>raiseHerdrTerminal(exec));
const network=createNetworkReader(runTool('reasonNetwork'));
const nativeHerdr=createNativeHerdr(runTool('nativeHerdr'),async()=>{if(process.platform!=='darwin')throw Error('이 OS의 창 전환 수신기는 검증되지 않았습니다.');await exec('/usr/bin/osascript',['-e',nativeRaiseScript],{timeout:7000,maxBuffer:16384});},runTool('hc'));
const receivers=await loadReceivers();
const server=http.createServer(createRequestHandler({sessions,bridge,network,nativeHerdr,dispatcher:createHostDispatcher({receivers}),quotas:createQuotaReader()}));
server.listen(port,'0.0.0.0',async()=>{
 await writeFile(new URL('./runtime.json',import.meta.url),JSON.stringify({pid:process.pid,port,urls:connectionAddresses(undefined,port).map(x=>x.url),started:new Date().toISOString()}));
 console.log(`Agent Deck listening on port ${port}. Pair code is visible only on the localhost page.`);
});
return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await startServer();
