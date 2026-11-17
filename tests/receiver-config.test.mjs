import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadReceivers} from '../src/host/receiver-config.mjs';

const config=()=>({schemaVersion:1,receivers:[{id:'my-shell',type:'tmux',socketPath:'/private/fixture/socket',paneId:'%0'}]});
async function fixture(t){const dir=await mkdtemp(path.join(tmpdir(),'deck-receiver-config-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'receivers.json');return {dir,file};}
test('receiver registration is explicit, private and injected only by the host owner',async t=>{
 const {file}=await fixture(t);await writeFile(file,JSON.stringify(config()),{mode:0o600});const calls=[];
 const receivers=await loadReceivers(file,{create:entry=>{calls.push(entry);return {marker:true};}});
 assert.deepEqual(Object.keys(receivers),['my-shell']);assert.equal(receivers['my-shell'].marker,true);assert.deepEqual(calls,[{targetRef:'my-shell',socketPath:'/private/fixture/socket',paneId:'%0'}]);
 assert.deepEqual(await loadReceivers(undefined,{info:async()=>{throw Object.assign(Error('absent fixture'),{code:'ENOENT'});}}),{});
});
test('unknown fields, duplicates, executable overrides and ambiguous target identities reject',async t=>{
 const {file}=await fixture(t);
 for(const mutate of [v=>v.schemaVersion=99,v=>v.extra=true,v=>v.receivers[0].cmd='forbidden',v=>v.receivers[0].socketPath='relative',v=>v.receivers[0].paneId='current',v=>v.receivers.push({...v.receivers[0]}),v=>v.receivers[0].id='__proto__']){
  const value=config();mutate(value);await writeFile(file,JSON.stringify(value),{mode:0o600});await assert.rejects(loadReceivers(file));
 }
 await assert.rejects(loadReceivers('relative.json'));await writeFile(file,JSON.stringify(config()),{mode:0o600});await assert.rejects(loadReceivers(file,{platform:'win32'}),/unavailable/);
});
test('symlink, oversized, nonowner and broad POSIX config permissions are never silently accepted',async t=>{
 const {dir,file}=await fixture(t);await writeFile(file,JSON.stringify(config()),{mode:0o600});
 const link=path.join(dir,'link.json');await symlink(file,link);await assert.rejects(loadReceivers(link));
 if(process.platform!=='win32'){await chmod(file,0o644);await assert.rejects(loadReceivers(file),/private/);await chmod(file,0o600);await assert.rejects(loadReceivers(file,{info:async()=>({isFile:()=>true,size:100,mode:0o600,uid:process.getuid()+1})}),/owned/);}
 await writeFile(file,' '.repeat(32769));await assert.rejects(loadReceivers(file),/Invalid/);
});

test('mock Windows registration requires explicit distribution and never rewrites a POSIX session target',async t=>{
 const {file}=await fixture(t),value=config();value.receivers[0].type='wsl-tmux';value.receivers[0].distribution='Fixture Ubuntu 한글';
 await writeFile(file,JSON.stringify(value),{mode:0o600});const entries=[];
 const result=await loadReceivers(file,{platform:'win32',createWsl:entry=>{entries.push(entry);return {registered:true};}});assert.equal(result['my-shell'].registered,true);assert.equal(entries[0].distribution,'Fixture Ubuntu 한글');assert.equal(entries[0].socketPath,'/private/fixture/socket');
 await assert.rejects(loadReceivers(file,{platform:'darwin'}),/unavailable/);
 for(const distribution of ['', '-d', ' Leading', 'fixture\nother']){value.receivers[0].distribution=distribution;await writeFile(file,JSON.stringify(value));await assert.rejects(loadReceivers(file,{platform:'win32'}),/explicit/);}
});
