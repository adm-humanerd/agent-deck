import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const root = new URL('./',import.meta.url);
const source = await fs.readFile(new URL('./file-review-approval.toml',root),'utf8');
// Contract tests, NOT Herdr's own Rust/TOML evaluator or a live capture.
const rules = source.split('[[rules]]').slice(1).map(rule=>({
 id: rule.match(/^id = "([^"]+)"/m)[1],
 contains: [...rule.match(/^contains = \[(.*)\]$/m)[1].matchAll(/"([^"]+)"/g)].map(x=>x[1]),
 alternatives: [...(rule.match(/^any = \[([\s\S]*?)^\]/m)?.[1] || '').matchAll(/contains = \["([^"]+)"\]/g)].map(x=>x[1]),
 footer: new RegExp(rule.match(/^line_regex = \['(.*)'\]$/m)[1],'i'),
 source:rule,
}));
function matches(text) {
 const region = text.split('\n').filter(x=>x.trim()).slice(-2);
 return rules.some(r=>r.contains.every(x=>region.join('\n').toLowerCase().includes(x)) && (!r.alternatives.length || r.alternatives.some(x=>region.join('\n').toLowerCase().includes(x))) && region.some(x=>r.footer.test(x)));
}
const edit = await fs.readFile(new URL('./tests/current-file-edit.txt',root),'utf8');
const review = '↑/↓ Navigate · f full diff · ctrl+r Review\nesc to cancel · Gemini';
test('rules are bounded visible blockers with priority above working',()=>{
 assert.equal(rules.length,2);
 for(const r of rules){assert.match(r.source,/visible_blocker = true/);assert.match(r.source,/priority = 3\d\d/);assert.match(r.source,/bottom_non_empty_lines\(2\)/);}
});
test('sanitized edit fixture',()=>assert.equal(matches(edit),true));
for(const title of ['Accept this file creation?','Create new file?','Accept these changes?','Review changes']){
 test(`synthetic title: ${title}`,()=>assert.equal(matches(`${title}\n> 1. Yes\n2. No\n${review}`),true));
}
test('synthetic creation without full diff hint',()=>assert.equal(matches(review.replace('f full diff · ','')),true));
test('mixed case and blank terminal lines',()=>assert.equal(matches('↑/↓ NAVIGATE · CTRL+R REVIEW\n\n  ESC TO CANCEL\n\n'),true));
test('documented trust footer without heading',()=>assert.equal(matches('↑/↓ Navigate · enter Confirm\nesc to cancel'),true));
for(const name of ['idle','working','quoted-old-dialog']){
 test(`${name} does not match`,async()=>assert.equal(matches(await fs.readFile(new URL(`tests/${name}.txt`,root),'utf8')),false));
}
for(const [name,text] of Object.entries({
 'old dialog followed by idle':edit+'\n> Ready\n? for shortcuts',
 'old dialog followed by working':review+'\n────────────────────\nesc to cancel',
 'missing both review hints':review.replace('f full diff · ctrl+r Review','enter Select'),
 'missing cancel':review.replace('esc to cancel','? for shortcuts'),
 'missing navigation':review.replace('Navigate','Scroll'),
 'slash completion menu':'↑/↓ Navigate · enter Select · tab Complete\nesc to cancel',
 'quoted cancel':'↑/↓ Navigate · ctrl+r Review\nEarlier: esc to cancel',
 'ordinary completed output':'Done\nidle',
})) test(name,()=>assert.equal(matches(text),false));

test('sanitized edit footer without ctrl+r Review',async()=>assert.equal(matches(await fs.readFile(new URL('./tests/current-file-edit-no-review.txt',root),'utf8')),true));
test('full diff footer alone matches even without title',()=>assert.equal(matches('↑/↓ Navigate · f full diff\nesc to cancel · Gemini'),true));
test('no-review edit followed by idle stays idle',()=>assert.equal(matches('↑/↓ Navigate · f full diff\nesc to cancel\n>\n? for shortcuts'),false));
