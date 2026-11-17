import fs from 'node:fs/promises';
export async function applyRequestView(html){
 const js=(await fs.readFile(new URL('../../src/deck/request-view.js',import.meta.url),'utf8')).trimEnd();
 const css=(await fs.readFile(new URL('../../src/deck/request-view.css',import.meta.url),'utf8')).trimEnd();
 if(!html.includes('function requestPreview('))html=html.replace('function renderInspector(a){',js+'\nfunction renderInspector(a){');
 html=html.replace(/if\(a\?\.agent_status==='blocked'&&a\.text\)\{request\.append\(el\('h3',[^\n]+/,"if(a?.agent_status==='blocked'&&a.text){appendApprovalRequest(request,a,disconnected);}");
 // Preserve expanded disclosures only while the same request remains selected.
 html=html.replace("function renderInspector(a){const side=$('inspector');side.replaceChildren();", "function renderInspector(a){const side=$('inspector');const expanded=[...side.querySelectorAll('.request-disclosure[open]')].map(d=>[d.dataset.requestKey,d.className]);side.replaceChildren();");
 html=html.replace('side.append(request);\nconst details=',"side.append(request);for(const d of side.querySelectorAll('.request-disclosure'))if(expanded.some(([key,cls])=>key===d.dataset.requestKey&&cls===d.className))d.open=true;\nconst details=");
 if(!html.includes('.approval-question{'))html=html.replace('</style>',css+'\n</style>');
 return html;
}
