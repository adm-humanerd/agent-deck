import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,readFile,rename,readdir,lstat,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import sharp from 'sharp';

export const MAX_IMAGE_BYTES=1024*1024,MAX_ASSET_BYTES=32*1024*1024;
export const MAX_IMAGE_DIMENSION=1024,MAX_DECODED_BYTES=4*1024*1024;
export const assetIdValid=id=>typeof id==='string'&&/^[a-f0-9]{64}$/.test(id);
const fail=(status,message)=>Object.assign(new Error(message),{status});
const pngSignature=Buffer.from([137,80,78,71,13,10,26,10]);
function rejectAnimatedPng(bytes){
 if(!bytes.subarray(0,8).equals(pngSignature))return;
 let offset=8;
 while(offset<bytes.length){
  if(bytes.length-offset<12)throw Error('truncated PNG chunk');
  const length=bytes.readUInt32BE(offset),end=offset+12+length;
  if(end>bytes.length)throw Error('truncated PNG chunk');
  const type=bytes.toString('ascii',offset+4,offset+8);
  if(['acTL','fcTL','fdAT'].includes(type))throw Error('animated PNG');
  offset=end;
  if(type==='IEND')return;
 }
 throw Error('missing PNG end');
}
function requirePrivate(info,directory=false){
 if(directory?!info.isDirectory():!info.isFile())throw fail(500,'개인 이미지 저장소 형식이 잘못되었습니다.');
 // POSIX mode checks do not establish Windows ACL privacy; native qualification is separate.
 if(process.platform!=='win32'&&((info.mode&0o077)!==0||(typeof process.getuid==='function'&&info.uid!==process.getuid())))throw fail(500,'개인 이미지 저장소 권한이 안전하지 않습니다.');
}
export function createAssetStore(directory,io={}){
 const fs={mkdir,open,readFile,rename,readdir,lstat,unlink,...io};
 let queue=Promise.resolve();
 return {
  async stage(bytes){
   const work=async()=>{
    if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX_IMAGE_BYTES)throw fail(413,'이미지는 1바이트~1MiB여야 합니다.');
    let clean,info;
    try{
     rejectAnimatedPng(bytes);
     const options={limitInputPixels:MAX_DECODED_BYTES/4,animated:true,failOn:'warning'};
     const metadata=await sharp(bytes,options).metadata();
     if(!['png','jpeg','webp'].includes(metadata.format)||!metadata.width||!metadata.height||metadata.width>MAX_IMAGE_DIMENSION||metadata.height>MAX_IMAGE_DIMENSION||(metadata.pages||1)!==1||metadata.width*metadata.height*4>MAX_DECODED_BYTES)throw Error('bounds');
     // Re-encoding strips EXIF, XMP, ICC and other source metadata. Never serve source bytes.
     ({data:clean,info}=await sharp(bytes,options).rotate().webp({lossless:true}).toBuffer({resolveWithObject:true}));
    }catch{throw fail(400,'정적 PNG/JPEG/WebP (최대 1024×1024)만 사용할 수 있습니다.');}
    const id=createHash('sha256').update(clean).digest('hex');
    const result={id,width:info.width,height:info.height,bytes:clean.length};
    await fs.mkdir(directory,{recursive:true,mode:0o700});
    requirePrivate(await fs.lstat(directory),true);
    const lock=join(directory,'.stage.lock');let lockHandle;
    try{lockHandle=await fs.open(lock,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw fail(423,'이미지 저장소가 잠겨 있습니다. 원본을 보존하고 잠금을 확인하세요.');throw error;}
    try{
     requirePrivate(await lockHandle.stat());await lockHandle.sync();
     const files=await fs.readdir(directory);let total=0,exists=false;
     for(const name of files)if(assetIdValid(name)){
      const stored=await fs.lstat(join(directory,name));requirePrivate(stored);total+=stored.size;
      if(name===id)exists=true;
     }
     if(total>MAX_ASSET_BYTES)throw fail(413,'개인 이미지 저장소는 32MiB 한도입니다.');
     if(exists){
      if(!(await fs.readFile(join(directory,id))).equals(clean))throw fail(500,'이미지 무결성 확인에 실패했습니다.');
      return result;
     }
     if(total+clean.length>MAX_ASSET_BYTES)throw fail(413,'개인 이미지 저장소는 32MiB 한도입니다.');
     const temp=join(directory,'.'+randomUUID()+'.tmp');let handle,created=false;
     try{
      handle=await fs.open(temp,'wx',0o600);created=true;requirePrivate(await handle.stat());
      await handle.writeFile(clean);await handle.sync();await handle.close();handle=null;
      await fs.rename(temp,join(directory,id));
     }finally{if(handle)await handle.close().catch(()=>{});if(created)await fs.unlink(temp).catch(()=>{});}
     return result;
    }finally{try{await lockHandle.close();}finally{await fs.unlink(lock);}}
   };
   const pending=queue.then(work);queue=pending.catch(()=>{});return pending;
  },
  async read(id){if(!assetIdValid(id))throw fail(404,'없는 이미지입니다.');try{requirePrivate(await fs.lstat(join(directory,id)));return await fs.readFile(join(directory,id));}catch(error){if(error.code==='ENOENT')throw fail(404,'없는 이미지입니다.');throw error;}},
  async verify(ids){for(const id of ids)await this.read(id);}
 };
}
export async function readImageBody(req){
 let size=0;const chunks=[];
 for await(const chunk of req){size+=chunk.length;if(size>MAX_IMAGE_BYTES)throw fail(413,'이미지 업로드는 1MiB 한도입니다.');chunks.push(chunk);}
 return Buffer.concat(chunks);
}
