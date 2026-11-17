import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
const root=path.dirname(fileURLToPath(import.meta.url));
const source=path.join(process.env.XDG_STATE_HOME||path.join(os.homedir(),'.local/state'),'herdr/agent-detection/remote/agy.toml');
const target=path.join(process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'),'herdr/agent-detection/agy.toml');
try { await fs.access(target); throw Error('Local override already exists; refusing to overwrite.'); }
catch(e) { if(e.code!=='ENOENT')throw e; }
const base=await fs.readFile(source,'utf8'),patch=await fs.readFile(path.join(root,'./file-edit-approval.toml'),'utf8');
if(!base.includes('id = "agy"')||!base.includes('id = "permission_prompt"')||!base.includes('id = "spinner_working"'))throw Error('Unexpected base manifest; no changes made.');
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const backup=path.join(root,'backups',stamp);await fs.mkdir(backup,{recursive:true});
await fs.writeFile(path.join(backup,'agy.original.toml'),base,{flag:'wx'});
await fs.writeFile(path.join(backup,'restore.txt'),'No previous local override existed. To restore the previous behavior, remove only '+target+' then run herdr server reload-agent-manifests. Do not edit the remote cache.\n',{flag:'wx'});
await fs.mkdir(path.dirname(target),{recursive:true});
await fs.writeFile(target,base+patch,{flag:'wx'});
await fs.writeFile(path.join(root,'installed.json'),JSON.stringify({target,source,backup,installed:new Date().toISOString(),baseSha256:crypto.createHash('sha256').update(base).digest('hex'),addedRule:'local_file_edit_review_prompt',originalRules:(base.match(/\[\[rules\]\]/g)||[]).length},null,2));
console.log('Installed local override:',target);console.log('Original rules preserved:',(base.match(/\[\[rules\]\]/g)||[]).length);console.log('Backup:',backup);
