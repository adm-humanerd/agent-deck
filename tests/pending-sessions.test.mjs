import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const client = await fs.readFile(new URL('../src/deck/deck-client.js', import.meta.url), 'utf8');
const css = await fs.readFile(new URL('../src/deck/streamdeck-feel.css', import.meta.url), 'utf8');
const renderSource = client.slice(client.indexOf('function decorateCustomKey('), client.indexOf("$('deckProfile').onchange"));
const agents = [
  {pane_id: 'current', agent_status: 'blocked'},
  {pane_id: 'other', agent_status: 'blocked'},
  {pane_id: 'third', agent_status: 'blocked'},
  {pane_id: 'working', agent_status: 'working'},
  {pane_id: 'unknown', agent_status: 'unknown'},
];
function setup(overrides = {}) {
  const ctx = vm.createContext({
    deckProfile: 'response', deckEditing: false, deckLocal: true, deckLayouts: [{id:'agents',name:'에이전트'},{id:'response',name:'응답 페이지'},{id:'quota',name:'쿼터'}], online: true, demo: false,
    selectedPane: 'current', editingSlot: null, keyButton: spec => spec,
    setDeckProfile: page => { ctx.destination = page; },
    openKeyEditor: index => { ctx.editor = index; },
    ...overrides,
  });
  vm.runInContext(renderSource, ctx);
  return {ctx, render: (list = agents, page = 'agents') => ctx.renderDeckKey({type: 'page', page}, 12, list[0], list, false)};
}

test('counts other blocked panels, not choices, current panel, or working/unknown sessions', () => {
  const {ctx, render} = setup();
  const button = render();
  assert.equal(button.name, '에이전트');
  assert.equal(button.detail, '확인 대기 2');
  assert.equal(button.cls, 'pending-sessions');
  assert.match(button.label, /다른 패널 확인 대기 2개/);
  assert.equal(button.disabled, false);
  button.click();
  assert.equal(ctx.destination, 'agents');
});
test('resolved and selected-only waits restore the normal button; click retains navigation', () => {
  const {ctx, render} = setup();
  render();
  for (const list of [[agents[0]], [], agents.map(a => ({...a, agent_status: 'idle'}))]) {
    const button = render(list);
    assert.equal(button.detail, '전체 세션');
    assert.equal(button.cls, '');
    button.click();
    assert.equal(ctx.destination, 'agents');
  }
});
test('selection changes, all pages and large panel counts use the supplied current list', () => {
  const {ctx, render} = setup({deckProfile: 'custom-panel'});
  ctx.selectedPane = 'working';
  assert.equal(render().detail, '확인 대기 3');
  assert.equal(render(Array.from({length: 100}, (_, i) => ({pane_id: String(i), agent_status: 'blocked'}))).detail, '확인 대기 100');
});
test('offline, overview, editing and response-page keys do not falsely signal another wait', () => {
  for (const overrides of [{online: false}, {deckProfile: 'agents'}, {deckEditing: true}]) {
    const {ctx, render} = setup(overrides);
    const button = render();
    assert.equal(button.detail, '전체 세션');
    assert.ok(!button.cls.includes('pending-sessions'));
    if (overrides.deckEditing) { button.click(); assert.equal(ctx.editor, 12); }
  }
  assert.equal(setup().render(agents, 'response').cls, '');
  assert.equal(setup({online: false, demo: true}).render().detail, '확인 대기 2');
});
test('pending shares blocked colors and glow, changing only the pulse duration', () => {
  const shared = css.match(/\.key\.session\.state-blocked,\s*\.key\.session\.state-blocked:hover:not\(:disabled\),\s*\.key\.pending-sessions,\s*\.key\.pending-sessions:hover:not\(:disabled\)\s*\{([^}]+)\}/)?.[1];
  assert.ok(shared, 'blocked and pending use one non-hover-dependent style');
  assert.match(shared, /animation: deckKeyBlockedPulse 1\.6s infinite ease-in-out;/);
  assert.match(shared, /--deck-blocked-glow:[^;]*#f6bf63[^;]*rgba\(246, 191, 99, 0\.55\)/s);
  assert.match(shared, /#422f18 0%/);
  assert.match(shared, /color: #ffe6c2 !important/);
  assert.match(css, /\.key\.pending-sessions,\s*\.key\.pending-sessions:hover:not\(:disabled\)\s*\{\s*animation-duration: 3s;\s*\}/);
  const pulse = css.slice(css.indexOf('@keyframes deckKeyBlockedPulse'), css.indexOf('.key.session.state-blocked,'));
  assert.match(pulse, /50%\s*\{\s*box-shadow: var\(--deck-blocked-glow\);/);
  assert.doesNotMatch(pulse, /opacity|filter|color|transform/);
  assert.doesNotMatch(css, /pendingSessionsPulse|\.pending-sessions::before|#b85412|#ffad52/);
  assert.match(css, /\.key\.session\.state-blocked \.number,\s*\.key\.pending-sessions \.key-detail,\s*\.key\.pending-sessions \.number\s*\{\s*color: #ffcf87 !important;/);
});
test('resting, hover and selected shadows cannot mask the attention glow', () => {
  for (const selector of [
    '.key:not(:where(.session.state-blocked, .pending-sessions))',
    '.key:hover:not(:disabled):not(:where(.session.state-blocked, .pending-sessions))',
    '.key.selected:not(:where(.session.state-blocked, .pending-sessions))',
  ]) assert.ok(css.includes(selector), selector);
});
test('reduced motion disables animation but retains the shared static glow', () => {
  assert.match(css, /prefers-reduced-motion: reduce\)\s*\{\s*\.key\.session\.state-blocked,\s*\.key\.pending-sessions\s*\{\s*box-shadow: var\(--deck-blocked-glow\) !important;/);
  assert.match(css, /\.key\s*\{\s*animation: none !important;\s*transition: none !important;/);
});
test('served HTML contains maintained renderer and skin sources', async () => {
  const html = await fs.readFile(new URL('../src/deck/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes(client.trimEnd()));
  assert.ok(html.includes(css.trimEnd()));
});
test('quota assignments render through slot API and remain editable without sending input',()=>{
 const calls=[];const {ctx}=setup({deckProfile:'quota',quotaView:{key:(provider,id)=>{calls.push([provider,id]);return {quota:true};}}});
 assert.equal(ctx.renderDeckKey({type:'quota',provider:'codex'},0,null,[],false).quota,true);
 assert.deepEqual(calls,[['codex','slot:quota:0']]);
 ctx.deckEditing=true;const edit=ctx.renderDeckKey({type:'quota',provider:'codex'},0,null,[],false);
 edit.click();assert.equal(ctx.editor,0);assert.equal(calls.length,1);
});
test('only the locally edited slot carries the inspector selection',()=>{
 const {ctx,render}=setup({deckEditing:true,editingSlot:12});
 assert.match(render().cls,/configuring/);
 ctx.editingSlot=3;assert.doesNotMatch(render().cls,/configuring/);
 ctx.editingSlot=12;ctx.deckLocal=false;assert.doesNotMatch(render().cls,/configuring|editable/);
});
