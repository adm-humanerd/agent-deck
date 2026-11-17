import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import {discoverHostTools} from '../../host/host-config.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'),'herdr/agent-detection/agy.toml');
const cli = (await discoverHostTools()).herdr;
if(!cli)throw Error('Herdr CLI unavailable. Configure AGENT_DECK_HERDR or PATH.');
const patch = await fs.readFile(path.join(root,'./file-review-approval.toml'),'utf8');
const original = await fs.readFile(target,'utf8');
if (!original.includes('id = "agy"') || !original.includes('id = "local_file_edit_review_prompt"')) {
  throw Error('Unexpected local manifest. No changes made.');
}
// Update our two rules idempotently without touching upstream or edit rules.
const localIds = new Set(['local_file_review_footer_prompt','local_confirmation_footer_prompt']);
const blocks = original.split(/(?=^\[\[rules\]\])/m);
const base = blocks.filter(block => !localIds.has(block.match(/^id\s*=\s*"([^"]+)"/m)?.[1])).join('').trimEnd();
const next = base + '\n\n' + patch;
const changed = next !== original;
let backup;
if (changed) {
  backup = path.join(root,'backups',new Date().toISOString().replace(/[:.]/g,'-'));
  await fs.mkdir(backup,{recursive:true});
  await fs.writeFile(path.join(backup,'agy.before-file-review.toml'),original,{flag:'wx'});
  if (await fs.readFile(target,'utf8') !== original) throw Error('Manifest changed; retry.');
  await fs.writeFile(target,next);
}
try {
  // Also reload if already installed: a previous reload may not have finished.
  console.log(execFileSync(cli,['server','reload-agent-manifests'],{encoding:'utf8',timeout:10000}));
} catch (error) {
  if (changed) {
    await fs.writeFile(target,original);
    try { execFileSync(cli,['server','reload-agent-manifests'],{timeout:10000}); } catch {}
  }
  throw error;
}
console.log('Active review/confirmation footer rules loaded.',backup ? 'Backup: '+backup : 'Already current.');
console.log('No agent input sent. Creation dialogs still need live engine verification.');
