import test from 'node:test';
import assert from 'node:assert/strict';
import {detectAvailableRuntimes} from '../src/host/runtime-detector.mjs';

test('empty or failed process discovery never fabricates a ready terminal',async()=>{
 assert.deepEqual(await detectAvailableRuntimes({platform:'darwin',execImpl:async()=>({stdout:''})}),[]);
 assert.deepEqual(await detectAvailableRuntimes({platform:'win32',execImpl:async()=>{throw Error('denied');}}),[]);
 let calls=0;assert.deepEqual(await detectAvailableRuntimes({platform:'unknown',execImpl:async()=>{calls++;}}),[]);assert.equal(calls,0);
});
test('POSIX detection uses executable identity, not title or process arguments',async()=>{
 const result=await detectAvailableRuntimes({platform:'darwin',execImpl:async(command,args)=>{assert.equal(command,'/bin/ps');assert.deepEqual(args,['-ax','-o','comm=']);return {stdout:'/Applications/Herdr.app/Contents/MacOS/Herdr\n/usr/bin/osascript\n/opt/bin/paseo\n/tmp/paseo-window-title-spoof\n'};}});
 assert.deepEqual(result.map(value=>value.id),['herdr','paseo']);assert.ok(result.every(value=>value.capability==='detected-not-qualified'));
});
test('mock Windows task enumeration is explicit and is not real receiver qualification',async()=>{
 const result=await detectAvailableRuntimes({platform:'win32',execImpl:async(command,args)=>{assert.equal(command,'tasklist.exe');assert.deepEqual(args,['/FO','CSV','/NH']);return {stdout:'"Herdr.exe","42","Console","1","100 K"\r\n"notepad.exe","43","Console","1","100 K"'};}});
 assert.deepEqual(result.map(value=>value.id),['herdr']);assert.equal(result[0].capability,'detected-not-qualified');
});
