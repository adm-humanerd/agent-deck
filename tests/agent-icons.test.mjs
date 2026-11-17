import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import sharp from 'sharp';
import {agentIconName,applyAgentIcons} from '../scripts/build/apply-agent-icons.mjs';
const h=await fs.readFile(new URL('../src/deck/index.html',import.meta.url),'utf8');
const logos=JSON.parse(h.match(/const agentLogoSvgs=([^\n]+);/)[1]);
const agents=['pi','agy','codex','gjc','claude','cursor','copilot','gemini','opencode','ollama','qoder','kiro','grok','kimi','mastracode','amp','muse','hermes','prime-agent','herdr','paseo','orca','pparit','t3'];
test('native app ids and aliases select neutral badges',()=>{
 for(const s of ['antigravity','agy','Antigravity',' antigravity '])assert.equal(agentIconName(s),'agy');
});
test('all agent families remain distinct and unknown inputs stay generic',()=>{
 for(const s of agents)assert.equal(agentIconName(s),s);
 for(const [alias,id] of [['claude-code','claude'],['cursor-agent','cursor'],['github-copilot','copilot'],['google-gemini','gemini'],['goose','opencode'],['qodercli','qoder'],['herdr-app','herdr'],['paseo-loop','paseo'],['빠릿','pparit'],['t3code','t3']])assert.equal(agentIconName(alias),id);
 for(const s of [null,undefined,'shell','custom',1,'__proto__'])assert.equal(agentIconName(s),'terminal');
});
test('served clients use alias mapping with self-contained CSP-safe badges',()=>{
 assert.match(h,/symbol:agentIconName\(x.agent\)/);
 for(const s of h.matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(s[1]);
 for(const icon of Object.values(logos))assert.doesNotMatch(icon,/<image|href=|data:|<script|<path/i);
});
test('all badges use identical padded 128-square geometry and unique labels',()=>{
 assert.deepEqual(Object.keys(logos).sort(),agents.slice().sort());
 const labels=new Set();
 for(const name of agents){assert.match(logos[name],/^<svg[^>]*viewBox="0 0 128 128"/);assert.match(logos[name],/<rect x="12" y="12" width="104" height="104"/);labels.add(logos[name].match(/<text[^>]*>([^<]+)<\/text>/)[1]);}
 assert.equal(labels.size,agents.length);
});
test('rebuild discards injected vendor payloads rather than preserving artwork',async()=>{
 const poisoned=h.replace(/const agentLogoSvgs=([^\n]+);/,'const agentLogoSvgs={"unreviewed":"<svg><path d=\"M1 1\"/></svg>"};');
 assert.equal(await applyAgentIcons(poisoned),h);
 await assert.rejects(applyAgentIcons('no icon anchor'),/map missing/);
});
test('rasterized original badge keeps transparent padding and visible content',async()=>{
 const {data,info}=await sharp(Buffer.from(logos.gjc)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 assert.equal(info.width,128);assert.equal(info.height,128);
 let visible=0;
 for(let y=0;y<128;y++)for(let x=0;x<128;x++){
  const alpha=data[(y*128+x)*4+3];if(alpha)visible++;
  if(x<8||y<8||x>119||y>119)assert.equal(alpha,0);
 }
 assert.ok(visible>1000);
});
test('icon generation is idempotent and independent of external icon packs',async()=>{
 const before=process.env.AGENT_DECK_ICON_PACK;process.env.AGENT_DECK_ICON_PACK='/nonexistent/untrusted-icons';
 try{assert.equal(await applyAgentIcons(h),h);}finally{if(before===undefined)delete process.env.AGENT_DECK_ICON_PACK;else process.env.AGENT_DECK_ICON_PACK=before;}
});
test('all badges share one responsive square slot',async()=>{
 const css=await fs.readFile(new URL('../src/deck/streamdeck-feel.css',import.meta.url),'utf8');
 assert.match(css,/width:\s*var\(--agent-icon-size\)/);assert.match(css,/height:\s*var\(--agent-icon-size\)/);assert.match(css,/--agent-icon-size:\s*clamp\(24px, 5cqw, 46px\)/);
});
