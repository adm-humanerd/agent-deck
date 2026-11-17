import fs from 'node:fs/promises';
export async function applyNativeView(html){
 if(html.includes('id="nativeView"'))return html;
 html=html.replace('>herdr</button><button id="reasonView"','<button id="nativeView" type="button" aria-pressed="true">Herdr 앱</button>');
 html=html.replace('<button id="reasonView" type="button" aria-pressed="false">Reason</button>','');
 html=html.replace("$('reasonView').setAttribute('aria-pressed',String(deckView==='reason'));", "if($('reasonView'))$('reasonView').setAttribute('aria-pressed',String(deckView==='reason'));if($('nativeView'))$('nativeView').setAttribute('aria-pressed',String(deckView==='native'));");
 html=html.replace("if(demo&&view==='reason')", "if(demo&&view!=='herdr')");
 html=html.replace("if(view==='reason')viewUrl.searchParams.set('view','reason');", "if(view!=='herdr')viewUrl.searchParams.set('view',view);");
 html=html.replace("syncSourceButtons();renderSignature='';networkSignature='';", "syncSourceButtons();renderSignature='';networkSignature='';nativeSignature='';");
 html=html.replace("async function refresh(manual=false){if(demo||modal||sending||refreshing)return;", "async function refresh(manual=false){if(deckView!=='herdr'||demo||modal||sending||refreshing)return;");
 html=html.replace("if(view==='reason'){renderNetwork();refreshNetwork();}", "if(view==='native'){renderNative();refreshNative();}else if(view==='reason'){renderNetwork();refreshNetwork();}");
 html=html.replace("if(deckView==='reason'){renderNetwork();return;}","if(deckView==='native'){renderNative();return;}if(deckView==='reason'){renderNetwork();return;}");
 html=html.replace("$('refreshDeck').onclick=()=>deckView==='reason'?", "$('refreshDeck').onclick=()=>deckView==='native'?refreshNative():deckView==='reason'?");
 html=html.replace("$('retry').onclick=()=>deckView==='reason'?", "$('retry').onclick=()=>deckView==='native'?refreshNative():deckView==='reason'?");
 html=html.replace("$(id).onclick=()=>{if(deckView==='reason'", "$(id).onclick=()=>{if(deckView==='native'&&type==='session'){sessionPage=Math.max(0,Math.min(Math.max(0,Math.ceil((nativeState?.sessions.length||0)/15)-1),sessionPage+delta));renderNative();return;}if(deckView==='reason'");
 html=html.replace("if(new URLSearchParams(location.search).get('view')==='reason'&&deckView!=='reason')setDeckView('reason');", "const requestedView=new URLSearchParams(location.search).get('view');if(['reason','native'].includes(requestedView)&&deckView!==requestedView)setDeckView(requestedView);");
 const client=(await fs.readFile(new URL('../../src/integrations/native-client.js',import.meta.url),'utf8')).trimEnd();
 html=html.replace("(async()=>{if(demo){",client+"\n(async()=>{if(demo){");
 html=html.replace('</style>',".source-switch{flex-wrap:wrap}.bank-heading{min-width:0}.network-fields+.hint{margin-top:24px}\n</style>");
 return html;
}
