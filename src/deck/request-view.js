// Presentation only. Never alters the original text, choices, or response ticket.
function requestPreview(text){
 const lines=text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\r/g,'').split('\n');
 const menu=/^\s*[❯›>→●○]?\s*[1-9][.)]\s+/u;
 let firstChoice=-1;
 for(let i=lines.length-1;i>=0;i--)if(menu.test(lines[i]))firstChoice=i;else if(firstChoice>=0&&lines[i].trim())break;
 const end=firstChoice<0?lines.length:firstChoice;
 let question=-1;
 for(let i=end-1;i>=0;i--)if(/(?:\?|？)\s*$/.test(lines[i].trim())&&!menu.test(lines[i])){question=i;break;}
 const bodyEnd=question>=0?question:end;
 let pending=-1;
 for(let i=bodyEnd-1;i>=0;i--)if(/^\s*(?:Pending (?:edit|creation|changes)|Review changes)\s*$/i.test(lines[i])){pending=i;break;}
 const excerpt=question>=0?lines.slice(question,end).join('\n').trim():lines.slice(Math.max(0,end-12),end).join('\n').trim();
 return {excerpt,exact:question>=0,context:pending>=0?lines.slice(pending,bodyEnd).join('\n').trim():''};
}
function appendApprovalRequest(request,a,disconnected){
 const view=requestPreview(a.text);
 request.append(el('h3',disconnected?'마지막으로 확인한 승인 요청':'승인 요청','request-heading'));
 request.append(el('pre',view.excerpt||'아래 전체 원문에서 요청을 확인하세요.','approval-question'));
 if(!view.exact)request.append(el('p','요청 하단 발췌 · 정확한 내용은 전체 원문을 확인하세요.','request-caption'));
 if(a.choices.length){const list=el('ul',undefined,'option-list');for(const opt of a.choices){const li=el('li');li.append(el('b',opt.key),el('span',opt.label));list.append(li);}request.append(list);}
 function disclosure(title,text,kind){const details=el('details',undefined,'request-disclosure '+kind);details.dataset.requestKey=a.pane_id+'|'+(a.ticket||a.text);const summary=el('summary',title);details.append(summary,el('pre',text,'terminal'));request.append(details);}
 if(view.context)disclosure('변경 내용 보기',view.context,'request-changes');
 disclosure('전체 원문 보기 · '+a.text.split('\n').length+'줄',a.text,'request-original');
}
