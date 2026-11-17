import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {applyQuotaView} from './apply-quota-view.mjs';
import {applyAgentIcons} from './apply-agent-icons.mjs';
import {applyConsoleLayout} from './apply-console-layout.mjs';

// index.html is the canonical shell and lifecycle code. Historical backups are
// user data, not build inputs: rebuilding must not resurrect retired auth/storage.
export async function buildDeck(html){
 const focus=(await fs.readFile(new URL('../../src/deck/deck-focus.js',import.meta.url),'utf8')).trimEnd();
 const native=(await fs.readFile(new URL('../../src/integrations/native-client.js',import.meta.url),'utf8')).trimEnd();
 const client=(await fs.readFile(new URL('../../src/deck/deck-client.js',import.meta.url),'utf8')).trimEnd();
 const model=(await fs.readFile(new URL('../../src/deck/deck-layout.mjs',import.meta.url),'utf8')).replace(/^export /gm,'').trimEnd();
 const input=(await fs.readFile(new URL('../../src/deck/deck-input.js',import.meta.url),'utf8')).trimEnd();
 const send=(await fs.readFile(new URL('../../src/deck/deck-send.js',import.meta.url),'utf8')).trimEnd();
 const haptics=(await fs.readFile(new URL('../../src/deck/streamdeck-haptics.js',import.meta.url),'utf8')).trimEnd();
 const tablet=(await fs.readFile(new URL('../../src/deck/tablet-layout.css',import.meta.url),'utf8')).trimEnd();
 if(!html.includes('let pendingPCFocus=')||!html.includes('let nativeState=')||!html.includes('let recoveryBusy='))throw Error('Current deck template anchors missing');
 html=html.replace(/let pendingPCFocus=[\s\S]*?function choose\(pane\)[^\n]*/,()=>focus);
 html=html.replace(/let nativeState=[\s\S]*?(?=let recoveryBusy=)/,()=>native+'\n');
 html=html.replace(/(?:\/\/ Shared schema for the embedded client and Node regression tests\.\n)*const DECK_SLOT_COUNT[\s\S]*?(?=\/\/ Single key per tap\.)/,()=>model+'\n\n'+client+'\n');
 html=html.replace(/\/\/ Single key per tap\.[\s\S]*?(?=function keyButton\()/,()=>send+'\n');
 html=html.replace(/\/\* deck-input:start \*\/[\s\S]*?\/\* deck-input:end \*\/\n?/,'');
 html=html.replace('// Shared schema for the embedded client and Node regression tests.','/* deck-input:start */\n'+input+'\n/* deck-input:end */\n// Shared schema for the embedded client and Node regression tests.');
 html=html.replace(/\/\/ Stream Deck Touch & Hardware Feel Utilities[\s\S]*?(?=<\/script>)/,()=>haptics+'\n\n');
 html=html.replace(/\/\* iPad Air 3: stable [\s\S]*?(?=\.source-switch\{flex-wrap:wrap\})/,()=>tablet+'\n\n');
 html=await applyQuotaView(html);
 html=await applyAgentIcons(html);
 html=await applyConsoleLayout(html);
 return html;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const file=new URL('../../src/deck/index.html',import.meta.url);
 await fs.writeFile(file,await buildDeck(await fs.readFile(file,'utf8')));
 console.log('Rebuilt maintained deck sources; canonical lifecycle and user backups preserved.');
}
