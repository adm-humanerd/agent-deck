import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateAction} from './host-actions.mjs';
import {TMUX_MAPPING} from './tmux-receiver.mjs';

const LIMIT = 1048576;
const TIMEOUT = 5000;
const CONTROL = /[\x00-\x1f\x7f]/;
const EPOCH = /^\d+:\d+:\d+:[A-Fa-f0-9-]{36}:[A-Fa-f0-9-]{36}$/;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const posixAbsolute = value => typeof value === 'string' && value.length <= 32768 &&
  path.posix.isAbsolute(value) && path.posix.normalize(value) === value && !CONTROL.test(value);
const ready = (value, targetRef) => exact(value, ['state', 'targetRef', 'epoch', 'capabilities', 'qualifiedMapping']) &&
  value.state === 'ready-idle' && value.targetRef === targetRef && typeof value.epoch === 'string' && EPOCH.test(value.epoch) &&
  value.qualifiedMapping === TMUX_MAPPING && Array.isArray(value.capabilities) &&
  value.capabilities.length === 2 && value.capabilities.includes('sessionText') && value.capabilities.includes('keyCombo');

// Local owner transport only. WSL runs the same socket/atomic-pane guard as Linux;
// neither Windows focus nor a default/current distribution is consulted.
export function createWslTmuxReceiver({distribution, socketPath, paneId, targetRef, spawnImpl = spawn,
  scriptPath = fileURLToPath(new URL('./tmux-receiver.mjs', import.meta.url))}) {
  if (typeof distribution !== 'string' || !distribution.length || distribution.length > 256 || distribution.trim() !== distribution || distribution.startsWith('-') || CONTROL.test(distribution)) throw new TypeError('Explicit WSL distribution required');
  if (!posixAbsolute(socketPath) || typeof paneId !== 'string' || !/^%\d+$/.test(paneId) || typeof targetRef !== 'string' || !targetRef.length || targetRef.length > 256 || CONTROL.test(targetRef)) throw new TypeError('Explicit POSIX socketPath, paneId and targetRef required');
  const absoluteHostScript = typeof scriptPath === 'string' &&
    (/^[A-Za-z]:[\\/]/.test(scriptPath) ||
      (/^\\\\[^\\/?\.][^\\/]*[\\/][^\\/]+(?:[\\/]|$)/.test(scriptPath) && path.win32.isAbsolute(scriptPath)) ||
      (process.platform !== 'win32' && path.posix.isAbsolute(scriptPath)));
  if (!absoluteHostScript || scriptPath.length > 32768 || CONTROL.test(scriptPath)) throw new TypeError('Absolute host receiver scriptPath required');
  let mappedScript;
  const blocked = () => ({state: 'blocked', targetRef});
  const unknown = () => ({state: 'unknown', targetRef});
  function run(argv, input) {
    // Promise executors are synchronous: dispatch enters spawn before returning,
    // while the host dispatcher's admission locks are still held.
    return new Promise(resolve => {
      let child, timer, settled = false, bytes = 0;
      const chunks = [];
      const finish = (ok, stdout = '') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ok, started: !!child, stdout});
      };
      const stop = () => {
        finish(false);
        try { child?.kill(); } catch {}
      };
      try {
        child = spawnImpl('wsl.exe', ['--distribution', distribution, '--exec', ...argv],
          {shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
        timer = setTimeout(stop, TIMEOUT);
        child.once('error', () => finish(false));
        child.once('close', code => finish(code === 0, Buffer.concat(chunks).toString('utf8')));
        for (const [stream, keep] of [[child.stdout, true], [child.stderr, false]]) stream.on('data', data => {
          if (settled) return;
          const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
          bytes += chunk.length;
          if (bytes > LIMIT) stop();
          else if (keep) chunks.push(chunk);
        });
        child.stdin.on('error', stop);
        child.stdin.end(input);
      } catch { stop(); }
    });
  }
  function request(operation, action, proof) {
    const value = {operation, socketPath, paneId, targetRef};
    if (operation === 'dispatch') Object.assign(value, {action, proof});
    const input = JSON.stringify(value);
    return Buffer.byteLength(input) <= LIMIT ? input : null;
  }
  function decode(result) {
    if (!result.ok) return null;
    try { return JSON.parse(result.stdout); } catch { return null; }
  }
  async function inspect() {
    try {
      if (!mappedScript) {
        const mapped = await run(['wslpath', '-a', '-u', scriptPath]);
        if (!mapped.ok) return blocked();
        const value = mapped.stdout.replace(/\r?\n$/, '');
        if (!posixAbsolute(value)) return blocked();
        mappedScript = value;
      }
      const value = decode(await run(['node', mappedScript, '--stdin-rpc'], request('inspect')));
      return ready(value, targetRef) ? {state: value.state, targetRef, epoch: value.epoch,
        capabilities: [...value.capabilities], qualifiedMapping: value.qualifiedMapping} : blocked();
    } catch { return blocked(); }
  }
  function dispatch(raw, proof) {
    let action, input;
    try {
      action = validateAction(raw);
      if (!mappedScript || !ready(proof, targetRef) || action.targetRef !== targetRef || !['sessionText', 'keyCombo'].includes(action.kind) ||
        (action.kind === 'keyCombo' && (action.qualifiedMapping !== TMUX_MAPPING || !['Ctrl-U', 'Enter'].includes(action.chord)))) return Promise.resolve(blocked());
      input = request('dispatch', action, proof);
      if (!input) return Promise.resolve(blocked());
    } catch { return Promise.resolve(blocked()); }
    return run(['node', mappedScript, '--stdin-rpc'], input).then(result => {
      if (!result.started) return blocked();
      const value = decode(result);
      if (exact(value, ['state', 'targetRef']) && value.targetRef === targetRef && ['blocked', 'unknown'].includes(value.state)) return {state: value.state, targetRef};
      if (exact(value, ['state', 'targetRef', 'epoch']) && value.state === 'handoff' && value.targetRef === targetRef && value.epoch === proof.epoch) return {state: 'handoff', targetRef, epoch: value.epoch};
      return unknown();
    });
  }
  return Object.freeze({inspect, dispatch});
}
