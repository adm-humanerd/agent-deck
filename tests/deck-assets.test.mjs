import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import sharp from 'sharp';
import {createAssetStore,assetIdValid,readImageBody,MAX_IMAGE_BYTES,MAX_ASSET_BYTES,MAX_IMAGE_DIMENSION,MAX_DECODED_BYTES} from '../src/actions/deck-assets.mjs';

const gif=Buffer.from('47494638396101000100800000ff00000000ff'+'21f904000a0000002c0000000001000100000202440100'+'21f904000a0000002c00000000010001000002024c0100'+'3b','hex');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const raster=(format='png',width=8,height=8,color='#315a82')=>sharp({create:{width,height,channels:4,background:color}}).toFormat(format).toBuffer();
const encoded=bytes=>sharp(bytes,{animated:true,failOn:'warning',limitInputPixels:MAX_DECODED_BYTES/4}).rotate().webp({lossless:true}).toBuffer();
async function fixture(t){
 const dir=await fs.mkdtemp(join(tmpdir(),'deck-assets-')),directory=join(dir,'assets');
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 return {dir,directory,store:createAssetStore(directory)};
}
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function chunk(type,data){const result=Buffer.alloc(data.length+12);result.writeUInt32BE(data.length);result.write(type,4,4,'ascii');data.copy(result,8);result.writeUInt32BE(crc32(result.subarray(4,-4)),result.length-4);return result;}
function pngChunks(bytes){let offset=8;const result=[];while(offset<bytes.length){const length=bytes.readUInt32BE(offset);result.push({type:bytes.toString('ascii',offset+4,offset+8),data:bytes.subarray(offset+8,offset+8+length)});offset+=length+12;}return result;}
function exactInput(bytes,format){
 const missing=MAX_IMAGE_BYTES-bytes.length;assert.ok(missing>12);
 if(format==='png')return Buffer.concat([bytes.subarray(0,-12),chunk('npAD',Buffer.alloc(missing-12)),bytes.subarray(-12)]);
 if(format==='webp'){
  assert.equal(missing%2,0);const padding=Buffer.alloc(missing);padding.write('JUNK');padding.writeUInt32LE(missing-8,4);
  const result=Buffer.concat([bytes,padding]);result.writeUInt32LE(result.length-8,4);return result;
 }
 const parts=[];let remaining=missing;
 while(remaining){let length=Math.min(remaining,65537);if(remaining-length>0&&remaining-length<4)length-=4;assert.ok(length>=4);const part=Buffer.alloc(length,32);part[0]=255;part[1]=239;part.writeUInt16BE(length-2,2);parts.push(part);remaining-=length;}
 return Buffer.concat([bytes.subarray(0,2),...parts,bytes.subarray(2)]);
}
async function apng(){
 const first=pngChunks(await raster('png',1,1,'red')),second=pngChunks(await raster('png',1,1,'blue'));
 const animation=Buffer.alloc(8);animation.writeUInt32BE(2);
 function control(sequence){const value=Buffer.alloc(26);value.writeUInt32BE(sequence);value.writeUInt32BE(1,4);value.writeUInt32BE(1,8);value.writeUInt16BE(1,20);value.writeUInt16BE(10,22);return value;}
 const secondData=Buffer.concat(second.filter(part=>part.type==='IDAT').map(part=>part.data));const sequence=Buffer.alloc(4);sequence.writeUInt32BE(2);
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',first[0].data),chunk('acTL',animation),chunk('fcTL',control(0)),...first.filter(part=>part.type==='IDAT').map(part=>chunk(part.type,part.data)),chunk('fcTL',control(1)),chunk('fdAT',Buffer.concat([sequence,secondData])),chunk('IEND',Buffer.alloc(0))]);
}

for(const format of ['png','jpeg','webp']){
 test(`${format}: exact 1MiB upload is accepted; 1MiB+1 is rejected without changing stored data`,async t=>{
  const {directory,store}=await fixture(t),bytes=exactInput(await raster(format),format);assert.equal(bytes.length,MAX_IMAGE_BYTES);
  const staged=await store.stage(bytes),original=await store.read(staged.id);assert.equal(staged.bytes,original.length);assert.equal(digest(original),staged.id);
  assert.equal((await sharp(original).metadata()).format,'webp');await assert.rejects(store.stage(Buffer.concat([bytes,Buffer.from([0])])),{status:413});
  assert.deepEqual(await store.read(staged.id),original);assert.deepEqual(await fs.readdir(directory),[staged.id]);
 });
 test(`${format}: inclusive dimensions and decoded pixel bound, thin dimensions, and excess dimensions`,async t=>{
  const {store}=await fixture(t);
  for(const [width,height] of [[1024,1024],[1024,1],[1,1024],[1,1]]){
   const staged=await store.stage(await raster(format,width,height));assert.equal(staged.width,width);assert.equal(staged.height,height);assert.ok(width*height*4<=MAX_DECODED_BYTES);
  }
  for(const [width,height] of [[1025,1],[1,1025],[1025,1024],[1024,1025]])await assert.rejects(store.stage(await raster(format,width,height)),{status:400});
  assert.equal(MAX_IMAGE_DIMENSION,1024);assert.equal(MAX_DECODED_BYTES,1024*1024*4);
 });
 test(`${format}: source metadata is stripped and output orientation is reflected in staged dimensions`,async t=>{
  const {store}=await fixture(t);const sentinel='PRIVATE_ASSET_METADATA_SENTINEL';
  const bytes=await sharp({create:{width:3,height:7,channels:3,background:'red'}}).withMetadata({orientation:6,exif:{IFD0:{Copyright:sentinel}}}).toFormat(format).toBuffer();
  assert.ok((await sharp(bytes).metadata()).exif);const staged=await store.stage(bytes),clean=await store.read(staged.id),metadata=await sharp(clean).metadata();
  for(const key of ['exif','icc','xmp','iptc','orientation'])assert.equal(metadata[key],undefined,key);
  assert.equal(clean.includes(Buffer.from(sentinel)),false);assert.equal(staged.width,7);assert.equal(staged.height,3);assert.equal(metadata.width,7);assert.equal(metadata.height,3);
 });
}

test('empty, one-byte, malformed/truncated rasters and compressed pixel bombs are rejected before any store writes',async t=>{
 const {dir,directory,store}=await fixture(t);
 await assert.rejects(store.stage(Buffer.alloc(0)),{status:413});
 for(const value of [null,'https://example.invalid/image.png',new Uint8Array([1])])await assert.rejects(store.stage(value),{status:413});
 for(const bytes of [Buffer.from([0]),Buffer.from([137]),Buffer.from('not an image'),Buffer.from([255,216,255]),Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBP'),...(await Promise.all(['png','jpeg','webp'].map(async format=>(await raster(format)).subarray(0,20))))])await assert.rejects(store.stage(bytes),{status:400});
 const bomb=await raster('png',4096,4096);assert.ok(bomb.length<MAX_IMAGE_BYTES);await assert.rejects(store.stage(bomb),{status:400});
 assert.deepEqual(await fs.readdir(dir),[]);await assert.rejects(fs.stat(directory),{code:'ENOENT'});
});

test('animated WebP, GIF, and APNG source control chunks are rejected even when only the PNG default frame decodes',async t=>{
 const {store}=await fixture(t),animated=await sharp(gif,{animated:true}).webp({loop:0,delay:[100,100]}).toBuffer();
 assert.equal((await sharp(animated,{animated:true}).metadata()).pages,2);
 const png=await raster('png',1,1),control=Buffer.alloc(8);control.writeUInt32BE(1);
 const defaultOnly=Buffer.concat([png.subarray(0,33),chunk('acTL',control),png.subarray(33)]);
 assert.equal((await sharp(defaultOnly).metadata()).format,'png');
 for(const bytes of [gif,animated,await apng(),defaultOnly])await assert.rejects(store.stage(bytes),{status:400});
 for(const type of ['fcTL','fdAT'])await assert.rejects(store.stage(Buffer.concat([png.subarray(0,33),chunk(type,Buffer.alloc(26)),png.subarray(33)])),{status:400});
});

test('active/remote formats, source paths and traversal are never opened or accepted as image identifiers',async t=>{
 const {directory}=await fixture(t);let reads=0;
 const store=createAssetStore(directory,{readFile:async()=>{reads++;throw Error('must not read');}});
 for(const bytes of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.invalid/private"/></svg>'),Buffer.from('<html><script>alert(1)</script></html>'),Buffer.from('https://example.invalid/image.png'),Buffer.from('file:///private/image.png'),Buffer.from('../private.png'),await sharp({create:{width:1,height:1,channels:3,background:'red'}}).tiff().toBuffer()])await assert.rejects(store.stage(bytes),{status:400});
 for(const id of ['../private','a'.repeat(63),'a'.repeat(65),'A'.repeat(64),'a'.repeat(64)+'/x','%2e%2e%2fprivate','https://example.invalid',null]){
  assert.equal(assetIdValid(id),false);await assert.rejects(store.read(id),{status:404});await assert.rejects(store.verify([id]),{status:404});
 }
 assert.equal(reads,0);
});

test('bounded streaming body accepts exactly 1MiB, rejects the next byte, and propagates input faults',async()=>{
 async function* body(chunks){yield* chunks;}
 assert.equal((await readImageBody(body([Buffer.alloc(MAX_IMAGE_BYTES-1),Buffer.alloc(1)]))).length,MAX_IMAGE_BYTES);
 assert.equal((await readImageBody(body([]))).length,0);assert.equal((await readImageBody(body([Buffer.from([1])]))).length,1);
 await assert.rejects(readImageBody(body([Buffer.alloc(MAX_IMAGE_BYTES),Buffer.alloc(1)])),{status:413});
 let consumed=0;async function* excessive(){consumed++;yield Buffer.alloc(MAX_IMAGE_BYTES+1);consumed++;yield Buffer.from([1]);}
 await assert.rejects(readImageBody(excessive()),{status:413});assert.equal(consumed,1);
 async function* broken(){yield Buffer.from([1]);throw Error('stream fault');}await assert.rejects(readImageBody(broken()),/stream fault/);
});

test('inclusive 32MiB quota, deduplication at the limit, and immutable draft assets across store restarts',async t=>{
 const {directory,store}=await fixture(t),first=await raster('png',8,8,'red'),second=await raster('png',8,8,'blue'),clean=await encoded(first);
 await fs.mkdir(directory,{mode:0o700});const filler='f'.repeat(64);const handle=await fs.open(join(directory,filler),'wx',0o600);await handle.truncate(MAX_ASSET_BYTES-clean.length);await handle.close();
 const staged=await store.stage(first);assert.equal((await fs.stat(join(directory,filler))).size+staged.bytes,MAX_ASSET_BYTES);
 const names=await fs.readdir(directory),original=await store.read(staged.id);assert.deepEqual(await createAssetStore(directory).stage(first),staged);
 await assert.rejects(createAssetStore(directory).stage(second),{status:413});await createAssetStore(directory).verify([staged.id]);
 assert.deepEqual(await fs.readdir(directory),names);assert.deepEqual(await store.read(staged.id),original);
 // A matching name with different bytes is corruption, not permission to replace immutable content.
 await fs.writeFile(join(directory,staged.id),Buffer.alloc(clean.length,1));await assert.rejects(store.stage(first),{status:500});assert.deepEqual(await fs.readFile(join(directory,staged.id)),Buffer.alloc(clean.length,1));
});

test('all staging writes are unique/private, synchronized before rename; deduplication never renames',async t=>{
 const {directory}=await fixture(t),events=[],temps=[];
 const store=createAssetStore(directory,{open:async(file,flags,mode)=>{
  assert.equal(flags,'wx');assert.equal(mode,0o600);const handle=await fs.open(file,flags,mode);if(!file.endsWith('.tmp'))return handle;
  temps.push(file);return {stat:()=>handle.stat(),writeFile:async bytes=>{events.push('write');return handle.writeFile(bytes);},sync:async()=>{events.push('sync');return handle.sync();},close:async()=>{events.push('close');return handle.close();}};
 },rename:async(...args)=>{assert.deepEqual(events.slice(-3),['write','sync','close']);events.push('rename');return fs.rename(...args);}});
 const first=await store.stage(await raster('png',8,8,'red'));await store.stage(await raster('png',8,8,'blue'));await store.stage(await raster('png',8,8,'red'));
 assert.equal(temps.length,2);assert.notEqual(temps[0],temps[1]);assert.ok(temps.every(file=>/\.[a-f0-9-]+\.tmp$/.test(file)));
 assert.equal(events.filter(event=>event==='rename').length,2);
 if(process.platform!=='win32'){assert.equal((await fs.stat(directory)).mode&0o777,0o700);assert.equal((await fs.stat(join(directory,first.id))).mode&0o777,0o600);}
});

for(const fault of ['mkdir','directory-stat','lock-open','lock-sync','temp-open','temp-permissions','write','sync','close','rename']){
 test(`stage ${fault} failure preserves original published bytes and retained draft assets`,async t=>{
  const {dir,directory,store}=await fixture(t),staged=await store.stage(await raster()),original=await store.read(staged.id),canonical=join(dir,'layout.json'),snapshot=Buffer.from(JSON.stringify({revision:7,assets:[staged.id]}));
  await fs.writeFile(canonical,snapshot,{mode:0o600});const failure=Object.assign(Error('injected private staging fault'),{code:fault==='write'?'ENOSPC':'EACCES'});
  let closeFailed=false;
  const broken=createAssetStore(directory,{
   mkdir:async(...args)=>{if(fault==='mkdir')throw failure;return fs.mkdir(...args);},
   lstat:async(...args)=>{if(fault==='directory-stat'&&args[0]===directory)throw failure;return fs.lstat(...args);},
   open:async(file,...args)=>{
    const temp=file.endsWith('.tmp');if((temp&&fault==='temp-open')||(!temp&&fault==='lock-open'))throw failure;
    const handle=await fs.open(file,...args);
    return {stat:async()=>{const info=await handle.stat();if(temp&&fault==='temp-permissions'){if(process.platform==='win32')throw failure;info.mode|=0o044;}return info;},
     writeFile:async(...values)=>{if(temp&&fault==='write'){await handle.writeFile(Buffer.from('partial'));throw failure;}return handle.writeFile(...values);},
     sync:async()=>{if((temp&&fault==='sync')||(!temp&&fault==='lock-sync'))throw failure;return handle.sync();},
     close:async()=>{if(temp&&fault==='close'&&!closeFailed){closeFailed=true;throw failure;}return handle.close();}};
   },rename:async(...args)=>{if(fault==='rename')throw failure;return fs.rename(...args);}
  });
  await assert.rejects(broken.stage(await raster('png',8,8,'green')));
  assert.deepEqual(await fs.readFile(canonical),snapshot);assert.deepEqual(await store.read(staged.id),original);assert.deepEqual(await fs.readdir(directory),[staged.id]);
  assert.equal((await store.stage(await raster('png',8,8,'green'))).width,8);
 });
}

test('POSIX broad permissions and symlinks fail closed without changing originals',{skip:process.platform==='win32'},async t=>{
 const {directory,store}=await fixture(t),staged=await store.stage(await raster()),original=await store.read(staged.id),file=join(directory,staged.id);
 await fs.chmod(directory,0o755);await assert.rejects(store.stage(await raster('png',8,8,'blue')),{status:500});await fs.chmod(directory,0o700);
 await fs.chmod(file,0o644);await assert.rejects(store.read(staged.id),{status:500});await assert.rejects(store.stage(await raster('png',8,8,'blue')),{status:500});assert.deepEqual(await fs.readFile(file),original);
 await fs.chmod(file,0o600);await fs.symlink(file,join(directory,'e'.repeat(64)));await assert.rejects(store.read('e'.repeat(64)),{status:500});await assert.rejects(store.stage(await raster('png',8,8,'blue')),{status:500});assert.deepEqual(await fs.readFile(file),original);
});

test('independent instances share quota exclusion; stale lock and unrelated temp are never removed by reads',async t=>{
 const {directory,store}=await fixture(t),first=await store.stage(await raster());let entered,release;
 const ready=new Promise(resolve=>{entered=resolve;}),barrier=new Promise(resolve=>{release=resolve;});
 const blocked=createAssetStore(directory,{rename:async(...args)=>{entered();await barrier;return fs.rename(...args);}});
 const staging=blocked.stage(await raster('png',8,8,'red'));await ready;
 try{await assert.rejects(createAssetStore(directory).stage(await raster('png',8,8,'blue')),{status:423});}finally{release();}
 await staging;
 await fs.writeFile(join(directory,'.stage.lock'),'crashed-owner',{mode:0o600});await fs.writeFile(join(directory,'.orphan.tmp'),'retained',{mode:0o600});const names=await fs.readdir(directory);
 await createAssetStore(directory).read(first.id);await createAssetStore(directory).verify([first.id]);await assert.rejects(store.stage(await raster()),{status:423});
 assert.deepEqual(await fs.readdir(directory),names);assert.equal(await fs.readFile(join(directory,'.stage.lock'),'utf8'),'crashed-owner');assert.equal(await fs.readFile(join(directory,'.orphan.tmp'),'utf8'),'retained');
});

// Authored process tests prove process-death/atomic visibility, NOT power-loss durability or Windows ACL behavior.
const childSource=`
 import {createAssetStore} from ${JSON.stringify(new URL('../src/actions/deck-assets.mjs',import.meta.url).href)};
 import {rename} from 'node:fs/promises';
 process.on('message',async message=>{
  try{
   const io=message.pause?{rename:async(...args)=>{if(message.pause==='after')await rename(...args);process.send({phase:'paused'});await new Promise(()=>{});}}:{};
   const result=await createAssetStore(message.directory,io).stage(Buffer.from(message.bytes,'base64'));
   process.send({phase:'result',result});
  }catch(error){process.send({phase:'result',status:error.status,error:error.message});}
 });
 process.send({phase:'ready'});
`;
function child(t){
 const processChild=spawn(process.execPath,['--input-type=module','-e',childSource],{stdio:['ignore','ignore','pipe','ipc']});let stderr='';processChild.stderr.on('data',data=>{stderr+=data;});
 const messages=[],waiting=[];let exit;
 const exited=new Promise(resolve=>{exit=resolve;});
 processChild.on('message',message=>{const waiter=waiting.shift();if(waiter)waiter.resolve(message);else messages.push(message);});
 processChild.on('exit',(code,signal)=>{exit({code,signal});for(const waiter of waiting.splice(0))waiter.reject(Error(`child exited ${code}/${signal}: ${stderr}`));});
 processChild.on('error',error=>{for(const waiter of waiting.splice(0))waiter.reject(error);});
 t.after(async()=>{if(processChild.exitCode===null&&processChild.signalCode===null)processChild.kill('SIGKILL');await exited;});
 return {process:processChild,exited,next:()=>messages.length?Promise.resolve(messages.shift()):new Promise((resolve,reject)=>waiting.push({resolve,reject}))};
}

test('independent processes cannot bypass the 32MiB quota',{timeout:20000},async t=>{
 const {directory}=await fixture(t),red=await raster('png',8,8,'red'),blue=await raster('png',8,8,'blue'),redClean=await encoded(red),blueClean=await encoded(blue);
 await fs.mkdir(directory,{mode:0o700});const handle=await fs.open(join(directory,'f'.repeat(64)),'wx',0o600);await handle.truncate(MAX_ASSET_BYTES-Math.max(redClean.length,blueClean.length));await handle.close();
 const a=child(t),b=child(t);assert.equal((await a.next()).phase,'ready');assert.equal((await b.next()).phase,'ready');
 a.process.send({directory,bytes:red.toString('base64')});b.process.send({directory,bytes:blue.toString('base64')});
 const results=await Promise.all([a.next(),b.next()]);assert.equal(results.filter(result=>result.result).length,1);assert.ok([413,423].includes(results.find(result=>!result.result).status));
 const files=await fs.readdir(directory);let total=0;for(const file of files)if(assetIdValid(file))total+=(await fs.stat(join(directory,file))).size;assert.ok(total<=MAX_ASSET_BYTES);assert.equal(files.filter(assetIdValid).length,2);
});

for(const pause of ['before','after'])test(`stage process death ${pause} rename leaves original snapshot refs and bytes intact on restart`,{timeout:20000,skip:process.platform==='win32'},async t=>{
 const {dir,directory,store}=await fixture(t),original=await store.stage(await raster()),originalBytes=await store.read(original.id),canonical=join(dir,'layout.json'),snapshot=Buffer.from(JSON.stringify({revision:1,assets:[original.id]}));
 await fs.writeFile(canonical,snapshot,{mode:0o600});const bytes=await raster('png',8,8,'blue'),expected=await encoded(bytes),id=digest(expected),worker=child(t);
 assert.equal((await worker.next()).phase,'ready');worker.process.send({directory,bytes:bytes.toString('base64'),pause});assert.equal((await worker.next()).phase,'paused');worker.process.kill('SIGKILL');assert.equal((await worker.exited).signal,'SIGKILL');
 const restarted=createAssetStore(directory);assert.deepEqual(await fs.readFile(canonical),snapshot);assert.deepEqual(await restarted.read(original.id),originalBytes);
 const beforeRead=await fs.readdir(directory);
 if(pause==='before'){await assert.rejects(restarted.read(id),{status:404});assert.equal(beforeRead.filter(name=>name.endsWith('.tmp')).length,1);}
 else{assert.deepEqual(await restarted.read(id),expected);assert.equal(beforeRead.filter(name=>name.endsWith('.tmp')).length,0);}
 await restarted.verify([original.id]);assert.deepEqual(await fs.readdir(directory),beforeRead);await assert.rejects(restarted.stage(bytes),{status:423});
 assert.deepEqual(JSON.parse(await fs.readFile(canonical,'utf8')).assets,[original.id]);
});
test('store.prune removes only unreferenced 64-hex assets safely under lock',async t=>{
 const {directory,store}=await fixture(t);
 const kept=await store.stage(await raster('png',8,8,'red'));
 const orphan=await store.stage(await raster('png',8,8,'blue'));
 await fs.writeFile(join(directory,'.keep.tmp'),'temp',{mode:0o600});
 const res=await store.prune([kept.id]);
 assert.equal(res.removed,1);assert.ok(res.bytesFreed>0);assert.ok(res.remainingBytes>0);
 assert.ok((await store.read(kept.id)).length>0);
 await assert.rejects(store.read(orphan.id),{status:404});
 assert.equal(await fs.readFile(join(directory,'.keep.tmp'),'utf8'),'temp');
 await assert.rejects(store.prune(['../bad']),{status:400});
 await fs.writeFile(join(directory,'.stage.lock'),'locked',{mode:0o600});
 await assert.rejects(store.prune([kept.id]),{status:423});
});
