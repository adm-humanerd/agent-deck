import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
const exec=promisify(execFile);

// Executable presence/running process detection is not receiver qualification.
// Window titles, command text and current focus are never agent identity.
export async function detectAvailableRuntimes({platform=process.platform,execImpl=exec}={}){
 if(!['darwin','win32','linux'].includes(platform))return [];
 let stdout;
 try{
  ({stdout}=await execImpl(platform==='win32'?'tasklist.exe':'/bin/ps',platform==='win32'?['/FO','CSV','/NH']:['-ax','-o','comm='],{timeout:3000,maxBuffer:1024*1024,windowsHide:true}));
 }catch{return [];}
 const names=new Set(String(stdout).split(/\r?\n/).map(line=>platform==='win32'?line.match(/^"([^"]+)"/)?.[1]:path.posix.basename(line.trim())).filter(Boolean).map(name=>name.toLowerCase().replace(/\.exe$/,'')));
 const definitions=[['herdr','Herdr','app',['herdr','herdr-core']],['paseo','Paseo','orchestrator',['paseo']],['t3','T3 Code','app',['t3code','t3-code']],['tmux','TMUX','multiplexer',['tmux']],['zellij','Zellij','multiplexer',['zellij']],['orca','Orca','runner',['orca']]];
 return definitions.filter(([, , ,executables])=>executables.some(name=>names.has(name))).map(([id,label,type])=>({id,label,type,active:true,capability:'detected-not-qualified'}));
}
