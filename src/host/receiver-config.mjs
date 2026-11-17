import {lstat,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createTmuxReceiver} from './tmux-receiver.mjs';
import {createWslTmuxReceiver} from './wsl-tmux-receiver.mjs';

const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
export async function loadReceivers(file=process.env.AGENT_DECK_RECEIVERS,{platform=process.platform,read=readFile,info=lstat,create=createTmuxReceiver,createWsl=createWslTmuxReceiver}={}){
 const optional=file===undefined;
 if(optional)file=path.join(process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'),'agent-deck','receivers.json');
 if(typeof file!=='string'||!path.isAbsolute(file)||/[\x00-\x1f\x7f]/.test(file))throw Error('Receiver configuration requires an explicit absolute local filename');
 let metadata;try{metadata=await info(file);}catch(error){if(optional&&error.code==='ENOENT')return {};throw error;}
 if(!metadata.isFile()||metadata.size>32768)throw Error('Invalid receiver configuration file');
 if(platform!=='win32'&&((metadata.mode&0o077)!==0||metadata.uid!==process.getuid()))throw Error('Receiver configuration must be owned by this user and private');
 const value=JSON.parse(await read(file,'utf8'));
 if(!exact(value,['schemaVersion','receivers'])||value.schemaVersion!==1||!Array.isArray(value.receivers)||value.receivers.length>64)throw Error('Invalid receiver configuration schema');
 const receivers={};
 for(const entry of value.receivers){
  const wsl=entry?.type==='wsl-tmux';
  if(!exact(entry,wsl?['id','type','distribution','socketPath','paneId']:['id','type','socketPath','paneId'])||typeof entry.id!=='string'||!/^[-a-zA-Z0-9_]{1,64}$/.test(entry.id)||Object.hasOwn(receivers,entry.id)||['__proto__','constructor','prototype'].includes(entry.id)||!['tmux','wsl-tmux'].includes(entry.type)||typeof entry.socketPath!=='string'||!path.posix.isAbsolute(entry.socketPath)||/[\x00-\x1f\x7f]/.test(entry.socketPath)||typeof entry.paneId!=='string'||!/^%[0-9]+$/.test(entry.paneId))throw Error('Invalid explicit receiver registration');
  if(wsl){
   if(platform!=='win32')throw Error('WSL receiver is unavailable on this host platform');
   if(typeof entry.distribution!=='string'||!entry.distribution.trim()||entry.distribution!==entry.distribution.trim()||entry.distribution.startsWith('-')||entry.distribution.length>128||/[\x00-\x1f\x7f]/.test(entry.distribution))throw Error('An explicit WSL distribution is required');
   receivers[entry.id]=createWsl({targetRef:entry.id,socketPath:entry.socketPath,paneId:entry.paneId,distribution:entry.distribution});
  }else{
   if(platform!=='darwin'&&platform!=='linux')throw Error('tmux receiver is unavailable on this host platform');
   receivers[entry.id]=create({targetRef:entry.id,socketPath:entry.socketPath,paneId:entry.paneId});
  }
 }
 return receivers;
}
