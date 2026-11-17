#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {lstatSync} from 'node:fs';
import {lstat, mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {validateAction} from './host-actions.mjs';

export const TMUX_MAPPING = 'tmux-zsh-idle-v1';
const TMUX = process.env.AGENT_DECK_TMUX || 'tmux';
const KEYS = Object.freeze({'Ctrl-U': 'C-u', Enter: 'Enter'});
const FORMAT = '#{pid}:#{start_time}:#{pane_pid}:#{@agent_deck_shell}:#{@agent_deck_idle}';
const EPOCH = /^(\d+):(\d+):(\d+):([A-Fa-f0-9-]{36}):([A-Fa-f0-9-]{36})$/;
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

// run(argv, {input?}) is injectable for transport-failure tests, not a receiver
// qualification override. No shell, default socket, attach, or focus is used.
export function runTmux(argv, {input, tmuxPath = TMUX} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(tmuxPath, argv, {stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, TMUX: ''}});
    const stdout = [], stderr = [];
    let bytes = 0, settled = false;
    const timer = setTimeout(() => { child.kill(); finish(Error('tmux timeout; delivery may be unknown')); }, 5000);
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
    }
    child.on('error', error => finish(error));
    child.stdin.on('error', () => {});
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1048576) { child.kill(); finish(Error('tmux output limit')); }
      else chunks.push(chunk);
    });
    child.on('close', code => finish(null, {code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8')}));
    child.stdin.end(input);
  });
}

function configuration(socketPath, paneId, targetRef) {
  if (!['darwin', 'linux'].includes(process.platform)) throw Error('tmux receiver requires macOS or Linux; Windows is unsupported');
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath) || path.resolve(socketPath) !== socketPath || /[\x00-\x1f\x7f]/.test(socketPath)) throw new TypeError('Explicit absolute socketPath required');
  if (!/^%\d+$/.test(paneId) || typeof targetRef !== 'string' || !targetRef.length || targetRef.length > 256 || /[\x00-\x1f\x7f]/.test(targetRef)) throw new TypeError('Explicit paneId and targetRef required');
}

function executable(value) {
  if (typeof value !== 'string' || (value !== 'tmux' && !path.isAbsolute(value)) || /[\x00-\x1f\x7f]/.test(value)) throw new TypeError('tmuxPath must be tmux (PATH) or an absolute executable path');
}

async function privateParent(socketPath) {
  const parent = await lstat(path.dirname(socketPath));
  return parent.isDirectory() && parent.uid === process.getuid() && (parent.mode & 0o077) === 0;
}

async function privateSocket(socketPath) {
  const socket = await lstat(socketPath);
  return socket.isSocket() && socket.uid === process.getuid() && (socket.mode & 0o077) === 0 && await privateParent(socketPath);
}

function privateSocketSync(socketPath) {
  const socket = lstatSync(socketPath);
  const parent = lstatSync(path.dirname(socketPath));
  return socket.isSocket() && socket.uid === process.getuid() && (socket.mode & 0o077) === 0 &&
    parent.isDirectory() && parent.uid === process.getuid() && (parent.mode & 0o077) === 0;
}

export function createTmuxReceiver({socketPath, paneId, targetRef, tmuxPath = TMUX, run = (argv, options) => runTmux(argv, {...options, tmuxPath})}) {
  configuration(socketPath, paneId, targetRef);
  executable(tmuxPath);
  const args = ['-S', socketPath, '-N'];
  const blocked = () => ({state: 'blocked', targetRef});
  async function inspect() {
    try {
      if (!await privateSocket(socketPath)) return blocked();
      const result = await run([...args, 'display-message', '-p', '-t', paneId,
        `#{socket_path}\t#{pane_id}\t#{version}\t#{pane_dead}\t#{pane_in_mode}\t#{@agent_deck_pid}\t#{@agent_deck_mapping}\t${FORMAT}\t#{session_attached}\t#{window_linked}\t#{synchronize-panes}`]);
      if (result.code !== 0) return blocked();
      const fields = result.stdout.trimEnd().split('\t');
      if (fields.length !== 11) return blocked();
      const [socket, pane, version, dead, mode, shellPid, mapping, epoch, attached, linked, synchronized] = fields;
      const match = EPOCH.exec(epoch);
      if (socket !== socketPath || pane !== paneId || version !== '3.8' || dead !== '0' || mode !== '0' || attached !== '0' || linked !== '0' || synchronized !== '0' || mapping !== TMUX_MAPPING || !match || match[3] !== shellPid) return blocked();
      return {state: 'ready-idle', targetRef, epoch, capabilities: ['sessionText', 'keyCombo'], qualifiedMapping: TMUX_MAPPING};
    } catch { return blocked(); }
  }
  async function dispatch(raw, proof) {
    let action;
    try { action = validateAction(raw); } catch { return blocked(); }
    const match = typeof proof?.epoch === 'string' && EPOCH.exec(proof.epoch);
    if (!match || proof.targetRef !== targetRef || proof.state !== 'ready-idle' || proof.qualifiedMapping !== TMUX_MAPPING || !Array.isArray(proof.capabilities) || !proof.capabilities.includes(action.kind) || action.targetRef !== targetRef || !['sessionText', 'keyCombo'].includes(action.kind)) return blocked();
    if (action.kind === 'keyCombo' && (action.qualifiedMapping !== TMUX_MAPPING || !Object.hasOwn(KEYS, action.chord))) return blocked();
    if (action.kind === 'sessionText' && Buffer.from(action.literalText).toString('utf8') !== action.literalText) return blocked();
    const checks = [
      ['pid', match[1]], ['start_time', match[2]], ['pane_pid', match[3]],
      ['@agent_deck_pid', match[3]], ['@agent_deck_shell', match[4]], ['@agent_deck_idle', match[5]],
      ['@agent_deck_mapping', TMUX_MAPPING], ['version', '3.8'], ['pane_dead', '0'], ['pane_in_mode', '0'],
      ['session_attached', '0'], ['window_linked', '0'], ['synchronize-panes', '0']
    ].map(([key, value]) => `#{==:#{${key}},${value}}`);
    const condition = checks.reduce((left, right) => `#{&&:${left},${right}}`);
    const marker = `agent-deck-${randomUUID()}`;
    const commands = [`set-option -p -t ${paneId} @agent_deck_idle 0`];
    if (action.kind === 'sessionText') {
      // ZLE bracketed paste preserves tabs/newlines as buffer text, not editing
      // commands. ESC/control payloads are rejected by validateAction. All bytes
      // including wrappers go through -H: no payload is tmux source or a format.
      if (action.literalText.length) {
        const bytes = Buffer.concat([Buffer.from('\x1b[200~'), Buffer.from(action.literalText), Buffer.from('\x1b[201~')]);
        for (let offset = 0; offset < bytes.length; offset += 1024) commands.push(`send-keys -H -t ${paneId} ${[...bytes.subarray(offset, offset + 1024)].map(byte => byte.toString(16).padStart(2, '0')).join(' ')}`);
      }
      if (action.submit) commands.push(`send-keys -t ${paneId} Enter`);
    } else commands.push(`send-keys -t ${paneId} ${KEYS[action.chord]}`);
    // This private ZLE widget runs only after the preceding text/chord has been
    // processed. It acknowledges idle editing with a new nonce, never by timer.
    // Enter instead reaches preexec/precmd; never send an ack into a running app.
    if (action.kind === 'sessionText' ? !action.submit : action.chord !== 'Enter') commands.push(`send-keys -H -t ${paneId} 1b 5b 39 39 31 7e`);
    commands.push(`display-message -p -t ${paneId} '${marker}:accepted:${proof.epoch}'`);
    // tmux 3.8 cmd-if-shell.c: -F evaluates synchronously and inserts the parsed
    // branch immediately after itself. cmd-queue.c cmdq_next drains that queue
    // until CMD_RETURN_WAIT. set-option/send-keys/display-message do not WAIT.
    // Thus guard, consume, writes and receipt run without another client/event
    // interleaving. No run-shell/background job or conditional shell is involved.
    // Braces must be parsed command-list values: argv braces alone are strings
    // (cmd_parse_from_arguments). source-file stdin invokes the actual parser.
    const source = `if-shell -F -t ${paneId} '${condition}' { ${commands.join(' ; ')} } { display-message -p '${marker}:blocked' }\n`;
    // No await before run() synchronously spawns the transport: admission locks
    // must still be held when the effect enters. The receiver then revalidates
    // its identity/readiness in the server's synchronous conditional queue.
    try { if (!privateSocketSync(socketPath)) return blocked(); }
    catch { return blocked(); }
    try {
      const result = await run([...args, 'source-file', '-'], {input: source});
      if (result.code === 0 && result.stdout.trim() === `${marker}:accepted:${proof.epoch}`) return {state: 'handoff', targetRef, epoch: proof.epoch};
      if (result.code === 0 && result.stdout.trim() === `${marker}:blocked`) return blocked();
      // tmux3.8 client.c returns 1 here before creating client_peer or sending
      // commands. Only these exact, empty-stdout connection failures prove zero
      // admission; parse errors, lost receipts and partial execution stay unknown.
      const connectionPrefix = `error connecting to ${socketPath} (`;
      if (result.code === 1 && result.stdout === '' && typeof result.stderr === 'string' &&
        (result.stderr === `no server running on ${socketPath}\n` ||
          (result.stderr.startsWith(connectionPrefix) && /^[^\r\n]+\)\n$/.test(result.stderr.slice(connectionPrefix.length))))) return blocked();
      return {state: 'unknown', targetRef};
    } catch { return {state: 'unknown', targetRef}; }
  }
  return Object.freeze({inspect, dispatch});
}

// Creates only the explicitly named session; never attaches or replaces one.
// No user dotfiles are read/written: a private temporary ZDOTDIR supplies .zshrc.
export async function createManagedTmuxSession({socketPath, name, targetRef = name, tmuxPath = TMUX, run = (argv, options) => runTmux(argv, {...options, tmuxPath})}) {
  configuration(socketPath, '%0', targetRef);
  executable(tmuxPath);
  if (!await privateParent(socketPath)) throw Error('Socket parent must be a same-user private directory (0700)');
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(name)) throw new TypeError('Explicit simple session name required');
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-deck-zsh-'));
  const hook = fileURLToPath(new URL('./tmux-receiver.zsh', import.meta.url));
  const startup = `source ${quote(hook)}\n/bin/rm -f -- ${quote(path.join(directory, '.zshrc'))}\n/bin/rmdir -- ${quote(directory)}\nunset ZDOTDIR\n`;
  await writeFile(path.join(directory, '.zshrc'), startup, {mode: 0o600});
  let result;
  try {
    result = await run(['-S', socketPath, '-f', '/dev/null', 'new-session', '-d', '-P', '-F', '#{pane_id}', '-s', name,
      '-e', `ZDOTDIR=${directory}`, '-e', `AGENT_DECK_TMUX=${tmuxPath}`, '/bin/zsh', '-d', '-i']);
  } catch (error) {
    // An uncertain create is not retried or killed. Its private startup may still
    // be needed, so leave it for the shell to remove rather than break startup.
    throw error;
  }
  if (result.code !== 0) {
    await rm(directory, {recursive: true, force: true});
    throw Error(`tmux create failed: ${result.stderr}`);
  }
  const paneId = result.stdout.trim();
  configuration(socketPath, paneId, targetRef);
  return {id: targetRef, socketPath, paneId};
}

// Private local-process RPC, not an HTTP command-authoring surface. Only the
// existing receiver's inspect/dispatch union is admitted; no session creation,
// executable, working-directory or shell overrides can cross stdin.
async function stdinRpc() {
  let targetRef;
  const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
  const blocked = () => targetRef === undefined ? {state: 'blocked'} : {state: 'blocked', targetRef};
  let result;
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 1048576) throw Error('RPC input limit');
      chunks.push(chunk);
    }
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof request?.targetRef === 'string' && request.targetRef.length > 0 && request.targetRef.length <= 256 && !/[\x00-\x1f\x7f]/.test(request.targetRef)) targetRef = request.targetRef;
    const keys = ['operation', 'socketPath', 'paneId', 'targetRef'];
    if (request?.operation === 'dispatch') keys.push('action', 'proof');
    if (!exact(request, keys) || !['inspect', 'dispatch'].includes(request.operation)) throw Error('Invalid RPC');
    let action;
    if (request.operation === 'dispatch') {
      action = validateAction(request.action);
      const proof = request.proof;
      if (!['sessionText', 'keyCombo'].includes(action.kind) || action.targetRef !== targetRef ||
        !exact(proof, ['state', 'targetRef', 'epoch', 'capabilities', 'qualifiedMapping']) ||
        proof.state !== 'ready-idle' || proof.targetRef !== targetRef || typeof proof.epoch !== 'string' || !EPOCH.test(proof.epoch) ||
        proof.qualifiedMapping !== TMUX_MAPPING || !Array.isArray(proof.capabilities) || proof.capabilities.length !== 2 ||
        !proof.capabilities.includes('sessionText') || !proof.capabilities.includes('keyCombo')) throw Error('Invalid RPC proof');
    }
    const receiver = createTmuxReceiver({socketPath: request.socketPath, paneId: request.paneId, targetRef: request.targetRef});
    const response = request.operation === 'inspect' ? await receiver.inspect() : await receiver.dispatch(action, request.proof);
    // Explicit projection: never expose diagnostics, generated tmux source,
    // executable paths or socket paths through the RPC response.
    if (request.operation === 'inspect' && response.state === 'ready-idle') result = {
      state: response.state, targetRef, epoch: response.epoch,
      capabilities: [...response.capabilities], qualifiedMapping: response.qualifiedMapping,
    };
    else if (request.operation === 'dispatch' && response.state === 'handoff') result = {state: response.state, targetRef, epoch: response.epoch};
    else result = {state: response.state === 'unknown' ? 'unknown' : 'blocked', targetRef};
  } catch { result = blocked(); }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function cli() {
  const [operation, ...values] = process.argv.slice(2);
  if (operation === '--stdin-rpc') {
    if (values.length) process.stdout.write(`${JSON.stringify({state: 'blocked'})}\n`);
    else await stdinRpc();
  } else if (operation === 'create' && values.length === 3) {
    console.log(JSON.stringify(await createManagedTmuxSession({socketPath: values[0], name: values[1], targetRef: values[2]})));
  } else if (operation === 'inspect' && values.length === 3) {
    console.log(JSON.stringify(await createTmuxReceiver({socketPath: values[0], paneId: values[1], targetRef: values[2]}).inspect()));
  } else throw Error('Usage: node src/host/tmux-receiver.mjs create /absolute/socket session-name target-id | inspect /absolute/socket %pane target-id | --stdin-rpc');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) cli().catch(error => { console.error(error.message); process.exitCode = 1; });
