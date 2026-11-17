import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createHostDispatcher, validateAction} from '../src/host/host-actions.mjs';

const processAction = (overrides = {}) => ({kind: 'hostProcess', shellKind: process.platform === 'win32' ? 'cmd' : 'bash', script: 'printf safe', cwd: process.cwd(), executionPolicy: {timeoutMs: 1000, maxOutputBytes: 4096}, ...overrides});
const textAction = {kind: 'sessionText', targetRef: 'fixture-session', literalText: '$(not-a-command)\nplain text', submit: false};
const inspection = (overrides = {}) => ({targetRef: textAction.targetRef, epoch: 'fixture-epoch-1', state: 'ready-idle', capabilities: ['sessionText', 'keyCombo'], qualifiedMapping: 'fixture-map-1', ...overrides});
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}
// All injected child/receiver fixtures are mocks, never platform qualification.
function mockChildren() {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, {stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: undefined});
    child.kill = signal => { child.killedWith = signal; queueMicrotask(() => child.emit('close', null, signal)); return true; };
    calls.push({command, args, options, child});
    return child;
  };
  return {calls, spawnImpl};
}

test('strict union rejects unknown fields, accessors, missing and nested keys', () => {
  for (const raw of [
    {...processAction(), extra: true},
    processAction({executionPolicy: {timeoutMs: 100, maxOutputBytes: 1, shell: true}}),
    processAction({executionPolicy: {timeoutMs: 0, maxOutputBytes: 1}}),
    processAction({executionPolicy: {timeoutMs: 3600001, maxOutputBytes: 1}}),
    processAction({executionPolicy: {timeoutMs: 1, maxOutputBytes: 1048577}}),
    processAction({shellKind: 'sh'}),
    {...textAction, submit: 'false'},
    {...textAction, literalText: '\x1b[2J'},
    {...textAction, epoch: 'remote-override'},
    {kind: 'keyCombo', targetRef: 'x', chord: 'ctrl+c'},
    {kind: 'bogus'},
    {kind: 'hostUrl', get url() { throw Error('must not invoke accessor'); }}
  ]) assert.throws(() => validateAction(raw), TypeError);
  const original = processAction();
  const normalized = validateAction(original);
  original.executionPolicy.timeoutMs = 99;
  assert.equal(normalized.executionPolicy.timeoutMs, 1000);
  assert.ok(Object.isFrozen(normalized.executionPolicy));
});

test('URL allowlist rejects credentials, control bytes and non-web schemes', () => {
  for (const url of ['file:///tmp/a', 'javascript:alert(1)', 'https://u:p@example.org/', 'https://example.org/\n', 'https://example.org/%0a', 'https://example.org/%7f', 'not a url']) {
    assert.throws(() => validateAction({kind: 'hostUrl', url}), TypeError);
  }
  assert.equal(validateAction({kind: 'hostUrl', url: 'https://example.org/?x=%26%3B'}).url, 'https://example.org/?x=%26%3B');
});

test('mock macOS/Linux URL argv is fixed and status never includes URL or output', async () => {
  for (const [platform, command] of [['darwin', '/usr/bin/open'], ['linux', 'xdg-open']]) {
    const mock = mockChildren(), dispatcher = createHostDispatcher({platform, ...mock});
    const url = 'https://example.org/?private=token&x=1';
    const receipt = await dispatcher.dispatch({kind: 'hostUrl', url});
    const call = mock.calls[0];
    assert.equal(call.command, command);
    assert.deepEqual(call.args, [url]);
    assert.equal(call.options.shell, false);
    call.child.stdout.write('local secret');
    call.child.emit('close', 0, null);
    assert.equal((await receipt.completion).state, 'handoff');
    assert.deepEqual(Object.keys(dispatcher.status(receipt.runId)).sort(), ['exitCode', 'runId', 'signal', 'state']);
    assert.equal(dispatcher.localStatus(receipt.runId).stdout, 'local secret');
    assert.ok(!JSON.stringify(dispatcher.status(receipt.runId)).includes('secret'));
  }
});

test('mock Windows URL uses constant encoded program and data-only stdin; no qualification claim', async () => {
  const mock = mockChildren(), dispatcher = createHostDispatcher({platform: 'win32', ...mock});
  const url = 'https://example.org/?x=%22;%26calc.exe';
  const receipt = await dispatcher.dispatch({kind: 'hostUrl', url});
  const call = mock.calls[0];
  assert.equal(call.command, 'powershell.exe');
  const program = Buffer.from(call.args.at(-1), 'base64').toString('utf16le');
  assert.ok(program.includes('[Console]::In.ReadLine()'));
  assert.ok(program.includes('Start-Process -FilePath $u'));
  assert.ok(!program.includes(url));
  assert.ok(!call.args.some(arg => arg.includes(url)));
  assert.equal(call.child.stdin.read().toString(), url + '\n');
  assert.equal(call.options.shell, false);
  call.child.emit('close', 0, null);
  assert.equal((await receipt.completion).state, 'handoff');
  assert.equal((await dispatcher.capabilities()).windowsQualified, false);
});

test('mock Windows cancellation uses PID-only tree argv, never the authored command', async () => {
  const mock = mockChildren(), kills = [];
  const dispatcher = createHostDispatcher({platform: 'win32', ...mock, execFileImpl: (...args) => { kills.push(args); args.at(-1)(null); }});
  const receipt = await dispatcher.dispatch({kind: 'hostUrl', url: 'https://example.org/?private=secret'});
  mock.calls[0].child.pid = 987654321;
  dispatcher.cancel(receipt.runId);
  assert.equal((await receipt.completion).state, 'cancelled');
  assert.equal(kills[0][0], 'taskkill.exe');
  assert.deepEqual(kills[0][1], ['/PID', '987654321', '/T', '/F']);
  assert.ok(!JSON.stringify(kills).includes('private'));
});

test('mock POSIX process interpreters receive one uninterpolated script argument', {skip: process.platform === 'win32'}, async () => {
  for (const [shellKind, command] of [['bash', '/bin/bash'], ['zsh', '/bin/zsh'], ['powershell', 'pwsh']]) {
    const mock = mockChildren(), dispatcher = createHostDispatcher({platform: 'darwin', ...mock});
    const script = 'echo "a b"; echo $HOME';
    const receipt = await dispatcher.dispatch(processAction({shellKind, script}));
    const call = mock.calls[0];
    assert.equal(call.command, command);
    if (shellKind === 'powershell') assert.equal(Buffer.from(call.args.at(-1), 'base64').toString('utf16le'), script);
    else assert.deepEqual(call.args, ['-c', script]);
    assert.equal(call.options.cwd, process.cwd());
    assert.equal(call.options.shell, false);
    call.child.emit('close', 7, null);
    assert.equal((await receipt.completion).exitCode, 7);
  }
});

test('mock Windows cmd and PowerShell argv with injected Windows directory stat; not qualification', async () => {
  for (const shellKind of ['cmd', 'powershell']) {
    const cwd = 'C:\\fixture\\authored folder', stats = [];
    const mock = mockChildren(), dispatcher = createHostDispatcher({platform: 'win32', ...mock, fsStat: async value => { stats.push(value); return {isDirectory: () => true}; }});
    const script = 'echo trusted';
    const receipt = await dispatcher.dispatch(processAction({shellKind, script, cwd}));
    const call = mock.calls[0];
    assert.deepEqual(stats, [cwd]);
    assert.equal(call.options.cwd, cwd);
    assert.equal(call.options.shell, false);
    assert.equal(call.command, shellKind === 'cmd' ? 'cmd.exe' : 'powershell.exe');
    if (shellKind === 'cmd') assert.deepEqual(call.args, ['/d', '/s', '/c', script]);
    else assert.equal(Buffer.from(call.args.at(-1), 'base64').toString('utf16le'), script);
    call.child.emit('close', 0, null);
    assert.equal((await receipt.completion).state, 'exit');
  }
});

test('cwd must exist and be absolute; authority rechecked after cwd lookup', async () => {
  const mock = mockChildren(), dispatcher = createHostDispatcher({...mock});
  for (const cwd of ['.', process.cwd() + '/missing-host-actions-directory']) {
    const receipt = await dispatcher.dispatch(processAction({cwd}));
    assert.equal((await receipt.completion).state, 'blocked');
  }
  const receipt = await dispatcher.dispatch(processAction(), {beforeDispatch: () => false});
  assert.equal((await receipt.completion).state, 'blocked');
  assert.equal(mock.calls.length, 0);
});

test('mock spawn errors are redacted and completed without exposing raw errors', async () => {
  const dispatcher = createHostDispatcher({platform: 'darwin', spawnImpl() { throw Error('/secret/path ?token=secret'); }});
  const receipt = await dispatcher.dispatch({kind: 'hostUrl', url: 'https://example.org'});
  const result = await receipt.completion;
  assert.equal(result.state, 'spawn-error');
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('mock output limit is shared across stdout/stderr and cancels the child', async () => {
  const mock = mockChildren(), dispatcher = createHostDispatcher({...mock});
  const receipt = await dispatcher.dispatch(processAction({executionPolicy: {timeoutMs: 1000, maxOutputBytes: 5}}));
  const child = mock.calls[0].child;
  child.stdout.write('abc');
  child.stderr.write('defg');
  const result = await receipt.completion;
  assert.equal(result.state, 'output-limit');
  assert.equal(result.stdout, 'abc');
  assert.equal(result.stderr, 'de');
  assert.equal(result.outputTruncated, true);
  assert.equal(child.killedWith, 'SIGKILL');
});

test('mock timeout and cancel distinguish terminal reasons and unknown id', async () => {
  const mock = mockChildren(), dispatcher = createHostDispatcher({...mock});
  const timeout = await dispatcher.dispatch(processAction({executionPolicy: {timeoutMs: 5, maxOutputBytes: 99}}));
  assert.equal((await timeout.completion).state, 'timeout');
  const cancelled = await dispatcher.dispatch(processAction());
  dispatcher.cancel(cancelled.runId);
  assert.equal((await cancelled.completion).state, 'cancelled');
  assert.equal(dispatcher.cancel('missing'), null);
});

test('mock cancellation falls back to direct child.kill when pid is unavailable', async () => {
  const mock = mockChildren(), dispatcher = createHostDispatcher({platform: 'darwin', ...mock});
  const receipt = await dispatcher.dispatch({kind: 'hostUrl', url: 'https://example.org/'});
  assert.equal(mock.calls[0].child.pid, undefined);
  dispatcher.cancel(receipt.runId);
  assert.equal((await receipt.completion).state, 'cancelled');
  assert.equal(mock.calls[0].child.killedWith, 'SIGKILL');
});

test('mock global concurrency rejects fifth run rather than silently queuing commands', async () => {
  const mock = mockChildren(), dispatcher = createHostDispatcher({platform: 'darwin', ...mock});
  const receipts = [];
  for (let n = 0; n < 4; n++) receipts.push(await dispatcher.dispatch({kind: 'hostUrl', url: 'https://example.org'}));
  const denied = await dispatcher.dispatch({kind: 'hostUrl', url: 'https://example.org'});
  assert.equal(denied.state, 'blocked');
  assert.equal(mock.calls.length, 4);
  for (const call of mock.calls) call.child.emit('close', 0, null);
  await Promise.all(receipts.map(receipt => receipt.completion));
});

test('absent receiver is unavailable, never a no-op handoff', async () => {
  const dispatcher = createHostDispatcher();
  const receipt = await dispatcher.dispatch(textAction);
  assert.equal((await receipt.completion).state, 'unavailable');
  assert.equal((await dispatcher.capabilities()).herdr, 'unavailable');
});

test('mock receiver fails closed on identity, readiness, capability, epoch and key mapping drift', async () => {
  for (const changed of [
    {targetRef: 'other'}, {state: 'working'}, {state: 'blocked'}, {capabilities: []}, {epoch: null}, {epoch: 'fixture-epoch-2'}
  ]) {
    let count = 0, sent = 0;
    const adapter = {inspect: async () => inspection(++count === 1 ? {} : changed), dispatch: async () => { sent++; }};
    const dispatcher = createHostDispatcher({receivers: {[textAction.targetRef]: adapter}});
    const receipt = await dispatcher.dispatch(textAction);
    assert.equal((await receipt.completion).state, 'blocked');
    assert.equal(sent, 0);
  }
  const dispatcher = createHostDispatcher({receivers: {[textAction.targetRef]: {inspect: async () => inspection(), dispatch() { throw Error('must not enter'); }}}});
  const receipt = await dispatcher.dispatch({kind: 'keyCombo', targetRef: textAction.targetRef, chord: 'ctrl+c', qualifiedMapping: 'wrong-map'});
  assert.equal((await receipt.completion).state, 'blocked');
});

test('mock receiver performs its own final epoch check and literal bytes are not evaluated', async () => {
  let epoch = 'fixture-epoch-1', effects = 0;
  const adapter = {
    inspect: async () => inspection({epoch}),
    dispatch: async (action, inspected) => {
      assert.equal(action.literalText, textAction.literalText);
      assert.ok(Object.isFrozen(inspected));
      // Fixture models an atomic final receiver-side comparison, not Herdr IPC.
      if (epoch !== inspected.epoch) return {state: 'blocked'};
      effects++;
      return {state: 'handoff', targetRef: action.targetRef, epoch};
    }
  };
  const dispatcher = createHostDispatcher({receivers: {[textAction.targetRef]: adapter}});
  const denied = await dispatcher.dispatch(textAction, {beforeDispatch: () => { epoch = 'replacement'; }});
  assert.equal((await denied.completion).state, 'blocked');
  assert.equal(effects, 0);
  const accepted = await dispatcher.dispatch(textAction);
  assert.equal((await accepted.completion).state, 'handoff');
  assert.equal(effects, 1);
});

test('mock prepare-time receiver proof blocks a restarted same target before any dispatch', async () => {
  let epoch = 'prepared-epoch', effects = 0;
  const adapter = {
    inspect: async () => inspection({epoch}),
    dispatch: async (action, inspected) => { effects++; return {state: 'handoff', targetRef: action.targetRef, epoch: inspected.epoch}; }
  };
  const dispatcher = createHostDispatcher({receivers: {[textAction.targetRef]: adapter}});
  const expectedReceiver = await dispatcher.receiverContext(textAction);
  assert.ok(Object.isFrozen(expectedReceiver));
  assert.ok(Object.isFrozen(expectedReceiver.capabilities));
  assert.equal(expectedReceiver.epoch, 'prepared-epoch');
  assert.equal(effects, 0);
  epoch = 'restarted-epoch';
  const denied = await dispatcher.dispatch(textAction, {expectedReceiver});
  assert.equal((await denied.completion).state, 'blocked');
  assert.equal(effects, 0);
  const fresh = await dispatcher.receiverContext(textAction);
  const accepted = await dispatcher.dispatch(textAction, {expectedReceiver: fresh});
  assert.equal((await accepted.completion).state, 'handoff');
  assert.equal(effects, 1);
});

test('mock explicitly absent receiver proof never silently falls back to immediate inspection', async () => {
  let effects = 0;
  const adapter = {inspect: async () => inspection(), dispatch: async () => { effects++; }};
  const dispatcher = createHostDispatcher({receivers: {[textAction.targetRef]: adapter}});
  for (const expectedReceiver of [null, undefined]) {
    const receipt = await dispatcher.dispatch(textAction, {expectedReceiver});
    assert.equal((await receipt.completion).state, 'blocked');
  }
  assert.equal(effects, 0);
  assert.equal(await createHostDispatcher().receiverContext(textAction), null);
  assert.equal(await dispatcher.receiverContext({kind: 'hostUrl', url: 'https://example.org/'}), null);
  const unconfirmed = createHostDispatcher({receivers: {[textAction.targetRef]: {...adapter, inspect: async () => inspection({state: 'working'})}}});
  assert.equal(await unconfirmed.receiverContext(textAction), null);
});

test('mock prepared key context rejects qualification drift before dispatch', async () => {
  let mapping = 'fixture-map-1', effects = 0;
  const action = {kind: 'keyCombo', targetRef: textAction.targetRef, chord: 'ctrl+c', qualifiedMapping: mapping};
  const adapter = {inspect: async () => inspection({qualifiedMapping: mapping}), dispatch: async () => { effects++; }};
  const dispatcher = createHostDispatcher({receivers: {[action.targetRef]: adapter}});
  const expectedReceiver = await dispatcher.receiverContext(action);
  mapping = 'replacement-map';
  const receipt = await dispatcher.dispatch(action, {expectedReceiver});
  assert.equal((await receipt.completion).state, 'blocked');
  assert.equal(effects, 0);
});

test('mock per-target exclusion persists through in-flight cancellation; no retry', async () => {
  const gate = deferred();
  let entries = 0;
  const adapter = {inspect: async () => inspection(), dispatch: async () => { entries++; await gate.promise; return {state: 'handoff', targetRef: textAction.targetRef, epoch: 'fixture-epoch-1'}; }};
  const dispatcher = createHostDispatcher({receivers: {[textAction.targetRef]: adapter}});
  const first = await dispatcher.dispatch(textAction);
  await tick();
  assert.equal(entries, 1);
  dispatcher.cancel(first.runId);
  assert.equal((await first.completion).state, 'unknown');
  const second = await dispatcher.dispatch(textAction);
  assert.equal((await second.completion).state, 'blocked');
  gate.resolve();
  await tick();
  assert.equal(entries, 1);
  assert.equal(dispatcher.status(first.runId).state, 'unknown');
});

test('mock final authority recheck denies a revoked receiver action without effect', async () => {
  let effects = 0;
  const dispatcher = createHostDispatcher({receivers: {[textAction.targetRef]: {inspect: async () => inspection(), dispatch: async () => { effects++; }}}});
  const receipt = await dispatcher.dispatch(textAction, {beforeDispatch: async () => { throw Error('revoked'); }});
  assert.equal((await receipt.completion).state, 'blocked');
  assert.equal(effects, 0);
});

test('mock key handoff requires exact qualification and echoed identity; ambiguous dispatch is unknown', async () => {
  const action = {kind: 'keyCombo', targetRef: textAction.targetRef, chord: 'ctrl+c', qualifiedMapping: 'fixture-map-1'};
  for (const outcome of ['handoff', 'wrong-epoch', 'throw']) {
    let effects = 0;
    const adapter = {
      inspect: async () => inspection(),
      dispatch: async (sent, snapshot) => {
        assert.equal(sent.chord, 'ctrl+c');
        assert.equal(snapshot.qualifiedMapping, sent.qualifiedMapping);
        effects++;
        if (outcome === 'throw') throw Error('delivery acknowledgement lost');
        return {state: 'handoff', targetRef: action.targetRef, epoch: outcome === 'wrong-epoch' ? 'replacement' : snapshot.epoch};
      }
    };
    const dispatcher = createHostDispatcher({receivers: {[action.targetRef]: adapter}});
    const receipt = await dispatcher.dispatch(action);
    assert.equal((await receipt.completion).state, outcome === 'handoff' ? 'handoff' : 'unknown');
    assert.equal(effects, 1);
  }
});

test('capabilities distinguish implemented shell kinds from installed executable availability', async () => {
  const present=new Set(['/bin/bash','/usr/bin/open']);
  const dispatcher=createHostDispatcher({platform:'darwin',env:{PATH:'/fixture/bin'},fsStat:async file=>{if(!present.has(file))throw Error('absent');return {isFile:()=>true};},fsAccess:async()=>{}});
  const caps=await dispatcher.capabilities();assert.deepEqual(caps.shellKinds,['bash']);assert.equal(caps.shellStates.zsh,'unavailable');assert.equal(caps.shellStates.powershell,'unavailable');assert.equal(caps.hostUrl,true);assert.equal(caps.hostProcess,true);
  present.clear();const unavailable=await dispatcher.capabilities();assert.deepEqual(unavailable.shellKinds,[]);assert.equal(unavailable.hostProcess,false);assert.equal(unavailable.hostUrl,false);
});

test('mock Windows cwd must include drive or UNC share and never depends on current drive', async () => {
  let effects=0,lookups=0;
  const dispatcher=createHostDispatcher({platform:'win32',fsStat:async()=>{lookups++;return {isDirectory:()=>true};},spawnImpl:()=>{effects++;throw Error('must not spawn');}});
  for(const cwd of ['\\work','/work','C:work']){
    const receipt=await dispatcher.dispatch(processAction({shellKind:'cmd',cwd}));
    assert.equal((await receipt.completion).state,'blocked');
  }
  assert.equal(effects,0);assert.equal(lookups,0);
});

test('hung prepare inspection is bounded and late settlement cannot authorize input', async () => {
  const gate = deferred();let effects = 0;
  const dispatcher = createHostDispatcher({inspectionTimeoutMs: 10, receivers: {[textAction.targetRef]: {inspect: () => gate.promise, dispatch: async () => { effects++; }}}});
  const expectedReceiver = await dispatcher.receiverContext(textAction);
  assert.equal(expectedReceiver, null);
  gate.resolve(inspection());
  const receipt = await dispatcher.dispatch(textAction, {expectedReceiver});
  assert.equal((await receipt.completion).state, 'blocked');assert.equal(effects, 0);
});

test('real POSIX process returns observable output and exit; no optional receiver required', {skip: process.platform === 'win32'}, async () => {
  const dispatcher = createHostDispatcher();
  const receipt = await dispatcher.dispatch(processAction({script: 'printf local-output; printf local-error >&2; exit 3'}));
  const result = await receipt.completion;
  assert.equal(result.state, 'exit');
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, 'local-output');
  assert.equal(result.stderr, 'local-error');
  assert.ok(!JSON.stringify(dispatcher.status(receipt.runId)).includes('local-output'));
});

test('real macOS zsh lifecycle distinguishes timeout, output cap and cancellation', {skip:process.platform!=='darwin',timeout:10000},async()=>{
 const dispatcher=createHostDispatcher();
 const zsh=await dispatcher.dispatch(processAction({shellKind:'zsh',script:'printf "literal 한글"; exit 7'}));
 const exited=await zsh.completion;assert.equal(exited.state,'exit');assert.equal(exited.exitCode,7);assert.equal(exited.stdout,'literal 한글');
 const timed=await dispatcher.dispatch(processAction({shellKind:'zsh',script:'/bin/sleep 30',executionPolicy:{timeoutMs:50,maxOutputBytes:1024}}));
 assert.equal((await timed.completion).state,'timeout');
 const limited=await dispatcher.dispatch(processAction({shellKind:'zsh',script:'while true; do printf 1234567890; done',executionPolicy:{timeoutMs:3000,maxOutputBytes:37}}));
 const output=await limited.completion;assert.equal(output.state,'output-limit');assert.equal(Buffer.byteLength(output.stdout)+Buffer.byteLength(output.stderr),37);assert.equal(output.outputTruncated,true);
 const cancelled=await dispatcher.dispatch(processAction({shellKind:'zsh',script:'/bin/sleep 30'}));
 dispatcher.cancel(cancelled.runId);assert.equal((await cancelled.completion).state,'cancelled');
});
