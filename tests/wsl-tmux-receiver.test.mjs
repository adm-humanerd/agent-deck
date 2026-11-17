import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createWslTmuxReceiver} from '../src/host/wsl-tmux-receiver.mjs';
import {TMUX_MAPPING,createManagedTmuxSession,runTmux} from '../src/host/tmux-receiver.mjs';

const config = {distribution: 'Ubuntu 작업 distro', socketPath: '/home/owner/private socket/s', paneId: '%42', targetRef: 'owned', scriptPath: 'C:\\Owner Files\\한글\\tmux-receiver.mjs'};
const mapped = '/mnt/c/Owner Files/한글/tmux-receiver.mjs';
const proof = () => ({state: 'ready-idle', targetRef: config.targetRef,
  epoch: '10:20:30:11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222',
  capabilities: ['sessionText', 'keyCombo'], qualifiedMapping: TMUX_MAPPING});
const action = () => ({kind: 'sessionText', targetRef: config.targetRef, literalText: '한글🙂 \' " ; $(touch BAD)\nnext\tline', submit: false});
const blocked = {state: 'blocked', targetRef: config.targetRef};
const unknown = {state: 'unknown', targetRef: config.targetRef};
function harness(responses = []) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const response = responses[calls.length];
    if (response?.throws) throw Error('private spawn diagnostic');
    const child = new EventEmitter();
    Object.assign(child, {stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough()});
    child.kill = () => { child.killed = true; if (response?.killThrows) throw Error('kill failure'); return true; };
    const call = {command, args, options, child, input: ''};
    calls.push(call);
    child.stdin.on('data', chunk => { call.input += chunk.toString('utf8'); });
    child.stdin.on('finish', () => queueMicrotask(() => {
      if (response?.hold) return;
      if (response?.error) { child.emit('error', Error('private child diagnostic')); return; }
      if (response?.stdout) child.stdout.write(response.stdout);
      if (response?.stderr) child.stderr.write(response.stderr);
      child.emit('close', response?.code ?? 0);
    }));
    return child;
  };
  return {calls, spawnImpl, receiver: createWslTmuxReceiver({...config, spawnImpl})};
}
const mapping = () => ({stdout: `${mapped}\n`});
const inspected = () => ({stdout: JSON.stringify(proof())});
const handoff = () => ({stdout: JSON.stringify({state: 'handoff', targetRef: config.targetRef, epoch: proof().epoch})});

test('WSL explicit distribution/argv, Unicode paths and literal stdin; final dispatch spawns synchronously', async () => {
  const f = harness([mapping(), inspected(), handoff(), inspected()]);
  assert.deepEqual(await f.receiver.inspect(), proof());
  assert.deepEqual(f.calls[0].args, ['--distribution', config.distribution, '--exec', 'wslpath', '-a', '-u', config.scriptPath]);
  assert.deepEqual(f.calls[1].args, ['--distribution', config.distribution, '--exec', 'node', mapped, '--stdin-rpc']);
  assert.deepEqual(JSON.parse(f.calls[1].input), {operation: 'inspect', socketPath: config.socketPath, paneId: '%42', targetRef: 'owned'});
  const pending = f.receiver.dispatch(action(), proof());
  assert.equal(f.calls.length, 3, 'no await or mapping after dispatch admission');
  assert.deepEqual(await pending, {state: 'handoff', targetRef: 'owned', epoch: proof().epoch});
  assert.deepEqual(f.calls[2].args, f.calls[1].args);
  assert.deepEqual(JSON.parse(f.calls[2].input), {operation: 'dispatch', socketPath: config.socketPath, paneId: '%42', targetRef: 'owned', action: action(), proof: proof()});
  assert.deepEqual(await f.receiver.inspect(), proof());
  assert.equal(f.calls.length, 4, 'mapped path retained across inspection');
  for (const call of f.calls) {
    assert.equal(call.command, 'wsl.exe');
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
    assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
    assert.equal(call.args.includes(action().literalText), false, 'text is JSON stdin, never executable argv');
    assert.equal(call.args.some(value => /^(cmd(?:\.exe)?|powershell(?:\.exe)?|-c|--shell)$/.test(value)), false);
  }
});

test('WSL registration rejects missing/default guesses, Windows socket paths, relative paths and nonexact panes', () => {
  for (const overrides of [
    {distribution: undefined}, {distribution: ''}, {distribution: '-default'}, {distribution: ' distro'}, {distribution: 'a\nb'},
    {socketPath: 'C:\\private\\socket'}, {socketPath: 'relative'}, {socketPath: '/private/../socket'}, {socketPath: '/private/s\0'},
    {paneId: '42'}, {paneId: '%42; send-keys'}, {paneId: '%42\n'}, {targetRef: ''},
    {scriptPath: 'relative.mjs'}, {scriptPath: 'C:\\bad\n.mjs'}, {scriptPath: '\\repo\\tmux-receiver.mjs'}, {scriptPath: 'C:repo\\tmux-receiver.mjs'},
    {scriptPath: '\\\\?\\C:\\repo\\tmux-receiver.mjs'}, {scriptPath: '\\\\.\\pipe\\receiver'},
  ]) assert.throws(() => createWslTmuxReceiver({...config, ...overrides}), TypeError);
  if (process.platform === 'win32') assert.throws(() => createWslTmuxReceiver({...config, scriptPath: '/repo/tmux-receiver.mjs'}), TypeError);
  else assert.doesNotThrow(() => createWslTmuxReceiver({...config, scriptPath: '/repo/tmux-receiver.mjs'}));
  assert.doesNotThrow(() => createWslTmuxReceiver({...config, scriptPath: '\\\\server\\share\\한글 files\\tmux-receiver.mjs'}));
});

test('WSL forwards only qualified Enter/Ctrl-U keys and preserves explicit text submit', async () => {
  for (const raw of [
    {kind: 'keyCombo', targetRef: 'owned', chord: 'Enter', qualifiedMapping: TMUX_MAPPING},
    {kind: 'keyCombo', targetRef: 'owned', chord: 'Ctrl-U', qualifiedMapping: TMUX_MAPPING},
    {...action(), literalText: '', submit: true},
  ]) {
    const f = harness([mapping(), inspected(), handoff()]);
    await f.receiver.inspect();
    assert.equal((await f.receiver.dispatch(raw, proof())).state, 'handoff');
    assert.deepEqual(JSON.parse(f.calls[2].input).action, raw);
    assert.equal(f.calls.length, 3);
  }
});

test('WSL cannot dispatch before inspection mapping; rejects raw commands, unsupported keys and lost targets without spawning', async () => {
  const f = harness([mapping(), inspected()]);
  assert.deepEqual(await f.receiver.dispatch(action(), proof()), blocked);
  assert.equal(f.calls.length, 0);
  await f.receiver.inspect();
  for (const [raw, expected] of [
    [{...action(), targetRef: 'other'}, proof()],
    [{kind: 'rawCommand', command: 'evil'}, proof()],
    [{kind: 'hostProcess', shellKind: 'cmd', script: 'evil', cwd: 'C:\\', executionPolicy: {timeoutMs: 1, maxOutputBytes: 1}}, proof()],
    [{...action(), cwd: '/tmp'}, proof()],
    [{kind: 'keyCombo', targetRef: 'owned', chord: 'Ctrl-C', qualifiedMapping: TMUX_MAPPING}, proof()],
    [action(), {...proof(), targetRef: 'other'}], [action(), {...proof(), epoch: 'lost'}],
    [action(), {...proof(), state: 'busy'}], [action(), {...proof(), script: 'evil'}],
  ]) assert.deepEqual(await f.receiver.dispatch(raw, expected), blocked);
  assert.equal(f.calls.length, 2);
});

test('WSL mapping failures never fall back to current distro, shell or host paths', async () => {
  for (const response of [
    {code: 1, stderr: 'private C:\\path diagnostic'}, {error: true}, {throws: true},
    {stdout: ''}, {stdout: '\n'}, {stdout: 'C:\\not-linux\n'}, {stdout: 'relative\n'}, {stdout: '/mnt/c/a\n/other\n'},
    {stdout: '/mnt/c/a\0\n'}, {stdout: '/mnt/c/a/../b\n'},
  ]) {
    const f = harness([response]);
    assert.deepEqual(await f.receiver.inspect(), blocked);
    assert.deepEqual(await f.receiver.dispatch(action(), proof()), blocked);
    assert.ok(f.calls.length <= 1);
  }
});

test('WSL malformed inspection stays blocked; no unverified capabilities or diagnostics escape', async () => {
  for (const response of [
    {stdout: 'private stderr text'}, {stdout: JSON.stringify({...proof(), targetRef: 'other'})},
    {stdout: JSON.stringify({...proof(), epoch: [proof().epoch]})},
    {stdout: JSON.stringify({...proof(), capabilities: ['hostProcess', 'keyCombo']})},
    {stdout: JSON.stringify({...proof(), scriptPath: '/private/path'})}, {code: 1}, {error: true},
  ]) {
    const f = harness([mapping(), response]);
    assert.deepEqual(await f.receiver.inspect(), blocked);
  }
});

test('WSL dispatch accepts only exact receipts; errors, nonzero exits and stale/malformed receipts are unknown without replay', async () => {
  for (const response of [
    {code: 1, stderr: 'private missing target'}, {error: true}, {stdout: 'not json'},
    {stdout: JSON.stringify({...blocked, targetRef: 'other'})},
    {stdout: JSON.stringify({state: 'handoff', targetRef: 'owned', epoch: 'stale'})},
    {stdout: JSON.stringify({...blocked, source: 'private script'})},
  ]) {
    const f = harness([mapping(), inspected(), response]);
    await f.receiver.inspect();
    assert.deepEqual(await f.receiver.dispatch(action(), proof()), unknown);
    assert.equal(f.calls.length, 3);
  }
  for (const receipt of [blocked, unknown]) {
    const f = harness([mapping(), inspected(), {stdout: JSON.stringify(receipt)}]);
    await f.receiver.inspect();
    assert.deepEqual(await f.receiver.dispatch(action(), proof()), receipt);
  }
  const f = harness([mapping(), inspected(), {throws: true}]);
  await f.receiver.inspect();
  assert.deepEqual(await f.receiver.dispatch(action(), proof()), blocked, 'synchronous spawn throw proves no child');
});

test('WSL caps combined stdout/stderr, kills best effort, and never replays uncertain delivery', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const f = harness([mapping(), inspected(), {[stream]: 'x'.repeat(1048577), killThrows: true}]);
    await f.receiver.inspect();
    assert.deepEqual(await f.receiver.dispatch(action(), proof()), unknown);
    assert.equal(f.calls[2].child.killed, true);
    assert.equal(f.calls.length, 3);
  }
  const f = harness([{stdout: '/'.repeat(1048577)}]);
  assert.deepEqual(await f.receiver.inspect(), blocked);
  assert.equal(f.calls[0].child.killed, true);
  const combined = harness([mapping(), inspected(), {stdout: 'x'.repeat(600000), stderr: 'y'.repeat(600000)}]);
  await combined.receiver.inspect();
  assert.deepEqual(await combined.receiver.dispatch(action(), proof()), unknown);
  assert.equal(combined.calls[2].child.killed, true);
});

test('WSL transport timeout settles unknown even when kill throws and close never arrives', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = harness([mapping(), inspected(), {hold: true, killThrows: true}]);
  await f.receiver.inspect();
  const pending = f.receiver.dispatch(action(), proof());
  assert.equal(f.calls.length, 3);
  t.mock.timers.tick(5000);
  assert.deepEqual(await pending, unknown);
  assert.equal(f.calls[2].child.killed, true);
  assert.equal(f.calls.length, 3);
});

test('WSL mapping timeout returns blocked with no final process', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = harness([{hold: true}]);
  const pending = f.receiver.inspect();
  t.mock.timers.tick(5000);
  assert.deepEqual(await pending, blocked);
  assert.equal(f.calls.length, 1);
});

function rpc(input, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/host/tmux-receiver.mjs', import.meta.url)), '--stdin-rpc', ...args],
      {shell: false, stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(Error('RPC test timeout')); }, 5000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({code, stdout, stderr}); });
    child.stdin.on('error', () => {});
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}
const inspectRequest = () => ({operation: 'inspect', socketPath: '/nonexistent-agent-deck-private-rpc/socket', paneId: '%42', targetRef: 'owned'});

test('local stdin RPC rejects the non-receiver union/overrides and emits only bounded public state', async () => {
  for (const request of [
    {...inspectRequest(), operation: 'create'}, {...inspectRequest(), command: 'touch BAD'},
    {...inspectRequest(), cwd: '/tmp'}, {...inspectRequest(), executable: '/tmp/evil'},
    {...inspectRequest(), action: action()}, {...inspectRequest(), proof: proof()},
    {...inspectRequest(), operation: 'dispatch', action: {...action(), script: 'evil'}, proof: proof()},
    {...inspectRequest(), operation: 'dispatch', action: action(), proof: {...proof(), socketPath: '/other'}},
    {...inspectRequest(), operation: 'dispatch', action: action(), proof: {...proof(), targetRef: 'other'}},
    {...inspectRequest(), operation: 'dispatch', action: {kind: 'hostUrl', url: 'https://example.com'}, proof: proof()},
  ]) {
    const result = await rpc(request);
    assert.deepEqual(JSON.parse(result.stdout), blocked);
    assert.equal(result.stderr, '');
    assert.equal(result.code, 0);
  }
  for (const input of ['{not JSON', 'x'.repeat(1048577)]) {
    const result = await rpc(input);
    assert.deepEqual(JSON.parse(result.stdout), {state: 'blocked'});
    assert.equal(result.stderr, '');
  }
  const result = await rpc(inspectRequest(), ['forbidden']);
  assert.deepEqual(JSON.parse(result.stdout), {state: 'blocked'});
  assert.equal(result.stderr, '');
});

test('local stdin RPC inspects/dispatches only the exact missing socket and never creates a session', async () => {
  for (const request of [inspectRequest(), {...inspectRequest(), operation: 'dispatch', action: action(), proof: proof()}]) {
    const result = await rpc(request);
    assert.deepEqual(JSON.parse(result.stdout), blocked);
    assert.equal(result.stderr, '');
    assert.equal(result.code, 0);
    assert.equal(result.stdout.includes(request.socketPath), false);
    assert.equal(result.stdout.includes(action().literalText), false);
  }
});

test('real local receiver stdin protocol executes exact idle text and rejects replay; not Windows qualification',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'ad-rpc-')),socketPath=path.join(directory,'s');
 try{
  const registered=await createManagedTmuxSession({socketPath,name:'rpc',targetRef:'rpc-owned'});
  const request={operation:'inspect',socketPath,paneId:registered.paneId,targetRef:registered.id};let inspected;
  for(let i=0;i<100;i++){inspected=JSON.parse((await rpc(request)).stdout);if(inspected.state==='ready-idle')break;await new Promise(r=>setTimeout(r,25));}
  assert.equal(inspected.state,'ready-idle');const output=path.join(directory,'result');
  const submitted={...request,operation:'dispatch',proof:inspected,action:{kind:'sessionText',targetRef:registered.id,literalText:`printf RPC_OK > '${output}'`,submit:true}};
  const result=await rpc(submitted);assert.equal(result.code,0);assert.equal(result.stderr,'');assert.equal(JSON.parse(result.stdout).state,'handoff');
  let actual;for(let i=0;i<100;i++){try{actual=await readFile(output,'utf8');if(actual==='RPC_OK')break;}catch{}await new Promise(r=>setTimeout(r,25));}assert.equal(actual,'RPC_OK');
  assert.equal(JSON.parse((await rpc(submitted)).stdout).state,'blocked');assert.equal(await readFile(output,'utf8'),'RPC_OK');
 }finally{await runTmux(['-S',socketPath,'-N','kill-server']).catch(()=>{});await rm(directory,{recursive:true,force:true});}
});
