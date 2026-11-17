import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createTmuxReceiver, createManagedTmuxSession, runTmux, TMUX_MAPPING} from '../src/host/tmux-receiver.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
async function until(check, label) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await pause(25);
  }
  throw Error(`Timed out: ${label}`);
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ad-'));
  const socketPath = path.join(directory, 's');
  t.after(async () => {
    // This is the sole cleanup server: an explicit, unique fixture socket.
    await runTmux(['-S', socketPath, '-N', 'kill-server']).catch(() => {});
    await rm(directory, {recursive: true, force: true});
  });
  const registration = await createManagedTmuxSession({socketPath, name: 'managed', targetRef: 'fixture'});
  const receiver = createTmuxReceiver({...registration, targetRef: registration.id});
  const tmux = async (...argv) => {
    const result = await runTmux(['-S', socketPath, '-N', ...argv]);
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trimEnd();
  };
  const ready = previous => until(async () => {
    const proof = await receiver.inspect();
    return proof.state === 'ready-idle' && proof.epoch !== previous ? proof : false;
  }, 'managed idle ZLE acknowledgement');
  await ready();
  const text = (literalText, submit = false) => ({kind: 'sessionText', targetRef: 'fixture', literalText, submit});
  const key = chord => ({kind: 'keyCombo', targetRef: 'fixture', chord, qualifiedMapping: TMUX_MAPPING});
  return {directory, socketPath, paneId: registration.paneId, receiver, tmux, ready, text, key};
}
async function contents(filename, expected) {
  return until(async () => {
    try { return await readFile(filename, 'utf8') === expected; } catch { return false; }
  }, `actual shell output ${filename}`);
}

test('real managed zsh: exact Unicode/quotes/tmux metacharacters, no-submit then Enter; stale nonce never replays', async t => {
  const f = await fixture(t);
  const output = path.join(f.directory, 'literal');
  const payload = `한글🙂 " ' \\ $() \`id\` ; } { #{pane_id}\tnewline\n'; set-option -g @injected yes ; #'`;
  const command = `printf '%s' ${quote(payload)} > ${quote(output)}`;
  const first = await f.ready();
  assert.equal((await f.receiver.dispatch(f.text(command), first)).state, 'handoff');
  await assert.rejects(readFile(output), {code: 'ENOENT'});
  const edited = await f.ready(first.epoch);
  assert.equal(edited.epoch.split(':')[3], first.epoch.split(':')[3], 'shell epoch is stable while idle nonce changes');
  assert.equal((await f.receiver.dispatch(f.key('Enter'), first)).state, 'blocked');
  assert.equal((await f.receiver.dispatch(f.key('Enter'), edited)).state, 'handoff');
  await contents(output, payload);
  const next = await f.ready(edited.epoch);
  assert.equal((await f.receiver.dispatch(f.text('printf BAD', true), first)).state, 'blocked');
  assert.equal(await f.tmux('show-options', '-gqv', '@injected'), '');
  assert.notEqual(next.epoch, first.epoch);
});

test('real text submission and explicit Ctrl-U clear only the selected pane and rearm from ZLE', async t => {
  const f = await fixture(t);
  const otherPane = await f.tmux('split-window', '-d', '-P', '-F', '#{pane_id}', '-t', f.paneId, '/bin/zsh', '-f', '-i');
  await pause(100);
  const before = await f.tmux('capture-pane', '-p', '-t', otherPane);
  let proof = await f.ready();
  assert.equal((await f.receiver.dispatch(f.text('THIS_MUST_BE_ERASED'), proof)).state, 'handoff');
  proof = await f.ready(proof.epoch);
  assert.equal((await f.receiver.dispatch(f.key('Ctrl-U'), proof)).state, 'handoff');
  proof = await f.ready(proof.epoch);
  const output = path.join(f.directory, 'cleared');
  assert.equal((await f.receiver.dispatch(f.text(`printf cleared > ${quote(output)}`, true), proof)).state, 'handoff');
  await contents(output, 'cleared');
  assert.equal(await f.tmux('capture-pane', '-p', '-t', otherPane), before);
  const other = createTmuxReceiver({socketPath: f.socketPath, paneId: otherPane, targetRef: 'other'});
  assert.equal((await other.inspect()).state, 'blocked', 'plain interactive zsh has no qualification');
});

test('real empty text acknowledgement, concurrent proof consumption and working-shell rejection', async t => {
  const f = await fixture(t);
  let proof = await f.ready();
  const outcomes = await Promise.all([f.receiver.dispatch(f.text(''), proof), f.receiver.dispatch(f.text(''), proof)]);
  assert.deepEqual(outcomes.map(item => item.state).sort(), ['blocked', 'handoff']);
  proof = await f.ready(proof.epoch);
  const started = path.join(f.directory, 'started');
  const done = path.join(f.directory, 'done');
  assert.equal((await f.receiver.dispatch(f.text(`printf started > ${quote(started)}; /bin/sleep 1; printf done > ${quote(done)}`, true), proof)).state, 'handoff');
  await contents(started, 'started');
  assert.equal((await f.receiver.inspect()).state, 'blocked');
  assert.equal((await f.receiver.dispatch(f.text('printf BAD', true), proof)).state, 'blocked');
  await contents(done, 'done');
  await f.ready(proof.epoch);
});

test('real guards: missing hooks, shell PID/epoch drift, stale restart, unsupported chord and mapping', async t => {
  const f = await fixture(t);
  const proof = await f.ready();
  assert.equal((await f.receiver.dispatch(f.key('Ctrl-C'), proof)).state, 'blocked');
  assert.equal((await f.receiver.dispatch({...f.key('Ctrl-U'), qualifiedMapping: 'other'}, proof)).state, 'blocked');
  assert.equal((await f.receiver.dispatch({...f.text('x'), targetRef: 'other'}, proof)).state, 'blocked');
  for (const [option, bad, original] of [
    ['@agent_deck_pid', '1', proof.epoch.split(':')[2]],
    ['@agent_deck_shell', '00000000-0000-0000-0000-000000000000', proof.epoch.split(':')[3]],
    ['@agent_deck_mapping', 'other', TMUX_MAPPING],
    ['@agent_deck_idle', '0', proof.epoch.split(':')[4]]
  ]) {
    await f.tmux('set-option', '-p', '-t', f.paneId, option, bad);
    assert.equal((await f.receiver.inspect()).state, option === '@agent_deck_shell' ? 'ready-idle' : 'blocked');
    assert.equal((await f.receiver.dispatch(f.text('bad', true), proof)).state, 'blocked');
    await f.tmux('set-option', '-p', '-t', f.paneId, option, original);
  }
  await f.tmux('respawn-pane', '-k', '-t', f.paneId, '/bin/zsh', '-f', '-i');
  assert.equal((await f.receiver.inspect()).state, 'blocked', 'inherited options cannot qualify a new pane PID');
  assert.equal((await f.receiver.dispatch(f.text('bad', true), proof)).state, 'blocked');
});

test('real attached control client and linked window block both inspection and atomic admission', async t => {
  const f = await fixture(t);
  const proof = await f.ready();
  const client = spawn(process.env.AGENT_DECK_TMUX || 'tmux', ['-S', f.socketPath, '-N', '-C', 'attach-session', '-t', 'managed'], {stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, TMUX: ''}});
  client.stdout.resume(); client.stderr.resume();
  t.after(() => client.kill());
  await until(async () => (await f.tmux('list-clients', '-F', '#{client_session}')).includes('managed'), 'control client attached');
  assert.equal((await f.receiver.inspect()).state, 'blocked');
  assert.equal((await f.receiver.dispatch(f.text('bad', true), proof)).state, 'blocked');
  client.kill();
  await until(async () => !(await f.tmux('list-clients', '-F', '#{client_session}')).includes('managed'), 'control client detached');
  await f.tmux('new-session', '-d', '-s', 'linked', '/bin/zsh', '-f', '-i');
  await f.tmux('link-window', '-s', 'managed:0', '-t', 'linked:1');
  assert.equal((await f.receiver.inspect()).state, 'blocked');
  assert.equal((await f.receiver.dispatch(f.text('bad', true), proof)).state, 'blocked');
});

test('real socket security, missing explicit target and missing socket fail closed', async t => {
  const f = await fixture(t);
  const proof = await f.ready();
  const missing = createTmuxReceiver({socketPath: path.join(f.directory, 'absent'), paneId: '%0', targetRef: 'missing'});
  assert.equal((await missing.inspect()).state, 'blocked');
  const wrong = createTmuxReceiver({socketPath: f.socketPath, paneId: '%99999', targetRef: 'missing'});
  assert.equal((await wrong.inspect()).state, 'blocked');
  await chmod(f.socketPath, 0o666);
  assert.equal((await f.receiver.inspect()).state, 'blocked');
  assert.equal((await f.receiver.dispatch(f.text('bad', true), proof)).state, 'blocked');
  await chmod(f.socketPath, 0o600);
  await chmod(f.directory, 0o755);
  assert.equal((await f.receiver.inspect()).state, 'blocked');
  await chmod(f.directory, 0o700);
  assert.throws(() => createTmuxReceiver({socketPath: 'relative', paneId: '%0', targetRef: 'x'}));
  assert.throws(() => createTmuxReceiver({socketPath: f.socketPath, paneId: 'current', targetRef: 'x'}));
});

test('real server restart at same socket and pane number cannot reuse old proof', async t => {
  const f = await fixture(t);
  const old = await f.ready();
  await f.tmux('kill-server');
  await until(async () => (await f.receiver.inspect()).state === 'blocked', 'old server exited');
  assert.equal((await f.receiver.dispatch(f.text('bad', true), old)).state, 'blocked');
  const fresh = await createManagedTmuxSession({socketPath: f.socketPath, name: 'managed', targetRef: 'fixture'});
  assert.equal(fresh.paneId, f.paneId, 'new server reuses pane number, not receiver epoch');
  const current = await f.ready(old.epoch);
  assert.notEqual(current.epoch.split(':')[3], old.epoch.split(':')[3]);
  assert.equal((await f.receiver.dispatch(f.text('bad', true), old)).state, 'blocked');
  const output = path.join(f.directory, 'restarted');
  assert.equal((await f.receiver.dispatch(f.text(`printf restarted > ${quote(output)}`, true), current)).state, 'handoff');
  await contents(output, 'restarted');
});

test('transport diagnostics distinguish proven connection refusal from uncertain delivery', async t => {
  const f = await fixture(t);
  const proof = await f.ready();
  const cases = [
    [{code: 1, stdout: '', stderr: `no server running on ${f.socketPath}\n`}, 'blocked'],
    [{code: 1, stdout: '', stderr: `error connecting to ${f.socketPath} (Connection refused)\n`}, 'blocked'],
    [{code: 1, stdout: '', stderr: 'parse error: unknown command\n'}, 'unknown'],
    [{code: 1, stdout: 'partial receipt\n', stderr: `no server running on ${f.socketPath}\n`}, 'unknown'],
    [{code: 1, stdout: '', stderr: `no server running on ${f.socketPath}\nextra diagnostic\n`}, 'unknown'],
    [{code: 1, stdout: '', stderr: 'no server running on /different/socket\n'}, 'unknown'],
    [{code: 0, stdout: '', stderr: ''}, 'unknown']
  ];
  for (const [result, expected] of cases) {
    const receiver = createTmuxReceiver({socketPath: f.socketPath, paneId: f.paneId, targetRef: 'fixture', run: async () => result});
    assert.equal((await receiver.dispatch(f.text(''), proof)).state, expected);
  }
  assert.equal((await f.receiver.inspect()).epoch, proof.epoch, 'diagnostic fixtures never send input');
});
