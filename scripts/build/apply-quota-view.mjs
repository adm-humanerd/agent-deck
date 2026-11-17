import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
export async function applyQuotaView(html){
 const css=(await fs.readFile(new URL('../../src/integrations/quota.css',import.meta.url),'utf8')).trimEnd();
 const client=(await fs.readFile(new URL('../../src/integrations/quota-client.js',import.meta.url),'utf8')).trimEnd();

 html=html.replace(/\n?\/\* quota-view:start \*\/[\s\S]*?\/\* quota-view:end \*\/\n?/,'');
 html=html.replace(/<style data-quota-view>[\s\S]*?<\/style>\n?/,'');
 html=html.replace('</head>','<style data-quota-view>\n'+css+'\n</style>\n</head>');
 html=html.replace(/<div id="quotaKeys"[^>]*><\/div>/g,'');
 if(!html.includes('id="showDeckRequest"'))html=html.replace('<button class="deck-tool" id="editDeck"','<button class="deck-tool" id="showDeckRequest">요청 보기</button><button class="deck-tool" id="editDeck"');
 if(!html.includes('id="requestDetail"'))html=html.replace('<dialog id="keyEditor"','<dialog id="requestDetail" aria-labelledby="requestDetailTitle"><h2 id="requestDetailTitle">요청 원문</h2><div id="requestDetailContent"></div><div class="dialog-actions"><button id="closeDeckRequest" class="action primary">닫기</button></div></dialog>\n<dialog id="keyEditor"');
 if(!html.includes('id="quotaDetail"'))html=html.replace('<dialog id="keyEditor"','<dialog id="quotaDetail" aria-labelledby="quotaTitle"><h2 id="quotaTitle">쿼터</h2><div id="quotaContent"></div><div class="dialog-actions"><button id="refreshQuota" class="action">다시 확인</button><button id="closeQuota" class="action primary">닫기</button></div></dialog>\n<dialog id="keyEditor"');
 html=html.replace(/<script data-quota-view>[\s\S]*?<\/script>\n?/,'');
 html=html.replace('</body>','<script data-quota-view>\n'+client+'\n</script>\n</body>');
 if(!html.includes('function renderDeckKey('))throw Error('Deck slot renderer missing');
 return html;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const file=new URL('../../src/deck/index.html',import.meta.url);await fs.writeFile(file,await applyQuotaView(await fs.readFile(file,'utf8')));}
