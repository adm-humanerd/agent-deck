import {spawn, execFile} from 'node:child_process';
import {stat,access} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {MAC_SYSTEM_ACTIONS, MAC_MODIFIER_KEYS, isValidMacHotkeyKey, buildMacHotkeyScript, resolveMacSystemCommand} from './mac-control.mjs';

const CONTROL = /[\x00-\x1f\x7f]/;
const FORBIDDEN_APP_URL_SCHEMES = new Set(['http:', 'https:', 'file:', 'javascript:', 'data:', 'vbscript:', 'blob:', 'about:']);
const CHILD_ACTION_KINDS = new Set(['hostProcess', 'hostUrl', 'appUrl', 'macApp', 'macShortcut', 'macSystem', 'macHotkey']);
const MAX_ACTIVE = 4;
const MAX_HISTORY = 128;
const DEFAULT_TIMEOUT = 30000;
const DEFAULT_OUTPUT = 65536;
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Invalid action object');
  if (Reflect.ownKeys(value).some(key => !keys.includes(key))) throw new TypeError('Unknown action field');
  for (const key of keys) if (!Object.hasOwn(value, key) || !Object.getOwnPropertyDescriptor(value, key)?.hasOwnProperty('value')) throw new TypeError('Missing action field');
}
function text(value, max, controls = false) {
  if (typeof value !== 'string' || !value.length || value.length > max || value.includes('\0') || (!controls && CONTROL.test(value))) throw new TypeError('Invalid action text');
  return value;
}
function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError('Invalid execution policy');
  return value;
}

// This is a local-authored definition validator, not authority to accept remote commands.
export function validateAction(raw) {
  if (!raw || typeof raw !== 'object') throw new TypeError('Invalid action');
  switch (Object.getOwnPropertyDescriptor(raw, 'kind')?.value) {
    case 'hostUrl': {
      object(raw, ['kind', 'url']);
      text(raw.url, 8192);
      if (/\s/.test(raw.url) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(raw.url)) throw new TypeError('Invalid URL');
      let url;
      try { url = new URL(raw.url); } catch { throw new TypeError('Invalid URL'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) throw new TypeError('Invalid URL');
      return Object.freeze({kind: raw.kind, url: url.href});
    }
    case 'hostProcess': {
      object(raw, ['kind', 'shellKind', 'script', 'cwd', 'executionPolicy']);
      if (!['bash', 'zsh', 'powershell', 'cmd'].includes(raw.shellKind)) throw new TypeError('Invalid interpreter');
      object(raw.executionPolicy, ['timeoutMs', 'maxOutputBytes']);
      return Object.freeze({kind: raw.kind, shellKind: raw.shellKind, script: text(raw.script, 262144, true), cwd: text(raw.cwd, 32768), executionPolicy: Object.freeze({timeoutMs: integer(raw.executionPolicy.timeoutMs, 1, 3600000), maxOutputBytes: integer(raw.executionPolicy.maxOutputBytes, 1, 1048576)})});
    }
    case 'sessionText':
      object(raw, ['kind', 'targetRef', 'literalText', 'submit']);
      if (typeof raw.literalText !== 'string' || raw.literalText.length > 262144 || /[\x00-\x08\x0b-\x1f\x7f]/.test(raw.literalText) || typeof raw.submit !== 'boolean') throw new TypeError('Invalid literal input');
      return Object.freeze({kind: raw.kind, targetRef: text(raw.targetRef, 256), literalText: raw.literalText, submit: raw.submit});
    case 'keyCombo':
      object(raw, ['kind', 'targetRef', 'chord', 'qualifiedMapping']);
      return Object.freeze({kind: raw.kind, targetRef: text(raw.targetRef, 256), chord: text(raw.chord, 128), qualifiedMapping: text(raw.qualifiedMapping, 256)});
    case 'appUrl': {
      object(raw, ['kind', 'url']);
      text(raw.url, 8192);
      if (/\s/.test(raw.url) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(raw.url)) throw new TypeError('Invalid URL');
      let url;
      try { url = new URL(raw.url); } catch { throw new TypeError('Invalid URL'); }
      if (!/^[a-z][a-z0-9+.-]{1,31}:$/.test(url.protocol) || FORBIDDEN_APP_URL_SCHEMES.has(url.protocol) || url.username || url.password) throw new TypeError('Invalid URL');
      return Object.freeze({kind: raw.kind, url: url.href});
    }
    case 'macApp': {
      object(raw, ['kind', 'appPath']);
      text(raw.appPath, 1024);
      if (!raw.appPath.startsWith('/') || raw.appPath.endsWith('/') || !raw.appPath.endsWith('.app') || raw.appPath.split('/').includes('..') || path.posix.basename(raw.appPath).length <= 4) throw new TypeError('Invalid macOS app path');
      return Object.freeze({kind: raw.kind, appPath: raw.appPath});
    }
    case 'macShortcut': {
      object(raw, ['kind', 'name']);
      const name = text(raw.name, 256);
      if (!name.trim().length) throw new TypeError('Invalid macOS shortcut name');
      return Object.freeze({kind: raw.kind, name});
    }
    case 'macSystem': {
      object(raw, ['kind', 'action']);
      if (typeof raw.action !== 'string' || !MAC_SYSTEM_ACTIONS.includes(raw.action)) throw new TypeError('Invalid macOS system action');
      return Object.freeze({kind: raw.kind, action: raw.action});
    }
    case 'macHotkey': {
      object(raw, ['kind', 'key', 'modifiers']);
      if (!isValidMacHotkeyKey(raw.key)) throw new TypeError('Invalid macOS hotkey key');
      if (!Array.isArray(raw.modifiers) || raw.modifiers.length > MAC_MODIFIER_KEYS.length || new Set(raw.modifiers).size !== raw.modifiers.length || raw.modifiers.some(m => typeof m !== 'string' || !MAC_MODIFIER_KEYS.includes(m))) {
        throw new TypeError('Invalid macOS hotkey modifiers');
      }
      return Object.freeze({kind: raw.kind, key: raw.key, modifiers: Object.freeze([...raw.modifiers])});
    }
    default: throw new TypeError('Unknown action kind');
  }
}

// Receiver adapter contract (not a Herdr wire protocol): inspect() must produce a
// confirmed identity/epoch and ready-idle state. dispatch(action, inspected) MUST
// atomically recheck that exact identity, epoch, readiness and qualified key map
// at the receiver before writing literal input, and return {state:'handoff',
// targetRef,epoch}. A timeout/throw after entry is unknown, never retried.
// Adapters are trusted local code, NEVER supplied by an HTTP caller. Registration
// alone is not real receiver qualification; a mock can only prove this contract.
// Public Herdr generation-1 docs provide conditional idle send but no expected
// epoch on send/keys, and keys has no idle condition. Consequently no native
// Herdr adapter is claimed here. Sources:
// https://github.com/herdrdev/herdr-core/blob/master/schema/README.md
// https://github.com/herdrdev/herdr-core/blob/master/schema/hc.openrpc.json
export function createHostDispatcher({platform = process.platform, spawnImpl = spawn, execFileImpl = execFile, fsStat = stat, fsAccess = access, env = process.env, receivers = {}, now = Date.now, inspectionTimeoutMs = 3000} = {}) {
  integer(inspectionTimeoutMs, 1, 30000);
  const runs = new Map(), targets = new Map();
  let active = 0;
  async function executableAvailable(command){
    const p=platform==='win32'?path.win32:path.posix;
    const searchPath=Object.entries(env).find(([key])=>platform==='win32'?key.toUpperCase()==='PATH':key==='PATH')?.[1]||'';
    const candidates=p.isAbsolute(command)?[command]:searchPath.split(platform==='win32'?';':':').filter(dir=>p.isAbsolute(dir)).map(dir=>p.join(dir,command));
    for(const candidate of candidates)try{if(!(await fsStat(candidate)).isFile())continue;await fsAccess(candidate,platform==='win32'?constants.F_OK:constants.X_OK);return true;}catch{}
    return false;
  }
  const safe = run => run ? {runId: run.runId, state: run.state, exitCode: run.exitCode, signal: run.signal} : null;
  function finish(run, state, code = null, signal = null) {
    if (run.done) return;
    run.done = true;
    run.state = state;
    run.exitCode = Number.isInteger(code) ? code : null;
    run.signal = typeof signal === 'string' && /^[A-Z0-9]+$/.test(signal) ? signal : null;
    clearTimeout(run.timer);
    clearTimeout(run.killTimer);
    active--;
    run.resolve({...safe(run), stdout: Buffer.concat(run.stdout).toString('utf8'), stderr: Buffer.concat(run.stderr).toString('utf8'), outputTruncated: run.truncated});
  }
  function killTree(run) {
    const child = run.child;
    if (!child) return;
    if (child.pid && platform === 'win32') {
      try { execFileImpl('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, timeout: 2000, maxBuffer: 4096}, () => {}); } catch {}
    } else if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
    try { child.kill('SIGKILL'); } catch {}
  }
  function stop(run, reason) {
    if (run.done || run.stopReason) return;
    run.stopReason = reason;
    run.state = 'cancelling';
    killTree(run);
    // A missing close event is not evidence that the process exited.
    run.killTimer ??= setTimeout(() => finish(run, 'unknown'), 2000);
  }
  function startChild(run, command, args, options, input, url = false) {
    try {
      const child = spawnImpl(command, args, {...options, shell: false, windowsHide: true, detached: platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']});
      run.child = child;
      child.once('error', () => finish(run, run.stopReason || 'spawn-error'));
      child.once('close', (code, signal) => finish(run, run.stopReason || (url ? (code === 0 ? 'handoff' : 'exit') : 'exit'), code, signal));
      for (const [stream, chunks] of [[child.stdout, run.stdout], [child.stderr, run.stderr]]) stream?.on('data', data => {
        if (run.done) return;
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data), available = run.limit - run.bytes;
        if (available > 0) { chunks.push(Buffer.from(bytes.subarray(0, available))); run.bytes += Math.min(bytes.length, available); }
        if (bytes.length > available) { run.truncated = true; stop(run, 'output-limit'); }
      });
      child.stdin?.on('error', () => {});
      child.stdin?.end(input);
    } catch { finish(run, 'spawn-error'); }
  }
  function confirmed(value, action) {
    return value && value.targetRef === action.targetRef && value.state === 'ready-idle' &&
      ((typeof value.epoch === 'string' && value.epoch.length > 0) || (Number.isSafeInteger(value.epoch) && value.epoch >= 0)) &&
      Array.isArray(value.capabilities) && value.capabilities.includes(action.kind) &&
      (action.kind !== 'keyCombo' || value.qualifiedMapping === action.qualifiedMapping);
  }
  function receiverAdapter(action) {
    const adapter = Object.hasOwn(receivers, action.targetRef) ? receivers[action.targetRef] : null;
    return adapter && typeof adapter.inspect === 'function' && typeof adapter.dispatch === 'function' ? adapter : null;
  }
  function proof(value) {
    return Object.freeze({targetRef: value.targetRef, epoch: value.epoch, state: value.state, qualifiedMapping: value.qualifiedMapping, capabilities: Object.freeze([...value.capabilities])});
  }
  function sameReceiver(value, expected) {
    return expected && value.targetRef === expected.targetRef && value.epoch === expected.epoch && value.qualifiedMapping === expected.qualifiedMapping;
  }
  // Prepare-time proof stays private to the trusted HTTP owner. This performs
  // inspection only; it does not reserve a target or authorize a later effect.
  async function receiverContext(raw) {
    const action = validateAction(raw);
    if (!['sessionText', 'keyCombo'].includes(action.kind)) return null;
    const adapter = receiverAdapter(action);
    if (!adapter || targets.has(action.targetRef)) return null;
    let timer;
    try {
      const inspected = await Promise.race([Promise.resolve().then(() => adapter.inspect()), new Promise(resolve => { timer = setTimeout(() => resolve(null), inspectionTimeoutMs); })]);
      return confirmed(inspected, action) ? proof(inspected) : null;
    } catch { return null; }
    finally { clearTimeout(timer); }
  }
  async function authorized(run) {
    try {
      if (await run.beforeDispatch() === false || run.done || run.stopReason) {
        finish(run, 'blocked');
        return false;
      }
      return true;
    } catch { finish(run, 'blocked'); return false; }
  }
  async function enterEffect(run,effect) {
    if(!await authorized(run))return null;
    try {
      return await run.withAdmission(()=>{
        if(run.done||run.stopReason)throw Error('Cancelled before admission');
        return effect();
      });
    } catch { finish(run,run.effectEntered?'unknown':'blocked');return null; }
  }
  async function receiverRun(run, action, adapter) {
    let entered = false;
    try {
      if (run.done) return;
      if (run.hasExpectedReceiver && !confirmed(run.expectedReceiver, action)) { finish(run, 'blocked'); return; }
      const first = await adapter.inspect();
      if (!confirmed(first, action)) { finish(run, 'blocked'); return; }
      if (run.hasExpectedReceiver && !sameReceiver(first, run.expectedReceiver)) { finish(run, 'blocked'); return; }
      const snapshot = proof(first);
      const second = await adapter.inspect();
      if (!confirmed(second, action) || !sameReceiver(second, snapshot) || run.done) { finish(run, 'blocked'); return; }
      const admission=await enterEffect(run,()=>{entered=true;run.effectEntered=true;return adapter.dispatch(action,snapshot);});
      if(!admission)return;
      const result = await admission.effect;
      finish(run, result?.state === 'handoff' && result.targetRef === snapshot.targetRef && result.epoch === snapshot.epoch ? 'handoff' : result?.state === 'blocked' ? 'blocked' : 'unknown');
    } catch { finish(run, entered ? 'unknown' : 'blocked'); }
    finally {
      // Release synchronously with receiver settlement, before completion awaiters
      // can submit another action. Cancellation alone never reaches this finally
      // while adapter.dispatch remains unresolved.
      if (targets.get(action.targetRef) === run) targets.delete(action.targetRef);
    }
  }
  async function dispatch(raw, options = {}) {
    const {beforeDispatch = async () => {},withAdmission=enter=>({effect:enter()})} = options;
    const action = validateAction(raw);
    if (typeof beforeDispatch !== 'function'||typeof withAdmission!=='function') throw new TypeError('Invalid authority callback');
    const hasExpectedReceiver = Object.hasOwn(options, 'expectedReceiver');
    const expectedReceiver = hasExpectedReceiver && confirmed(options.expectedReceiver, action) ? proof(options.expectedReceiver) : null;
    // Never await filesystem work before reserving the concurrency slot.
    const run = {runId: randomUUID(), state: 'running', exitCode: null, signal: null, created: now(), stdout: [], stderr: [], bytes: 0, limit: action.executionPolicy?.maxOutputBytes || DEFAULT_OUTPUT, done: false, truncated: false, beforeDispatch, withAdmission, hasExpectedReceiver, expectedReceiver};
    const completion = new Promise(resolve => { run.resolve = resolve; });
    if (runs.size >= MAX_HISTORY) {
      const old = [...runs.values()].find(item => item.done);
      if (old) runs.delete(old.runId);
    }
    if (active >= MAX_ACTIVE) return {runId: null, state: 'blocked', completion: Promise.resolve({runId: null, state: 'blocked', exitCode: null, signal: null})};
    runs.set(run.runId, run);
    active++;
    const receipt = () => ({runId: run.runId, state: run.state, completion});
    run.timer = setTimeout(() => {
      if (CHILD_ACTION_KINDS.has(action.kind)) stop(run, 'timeout');
      else finish(run, 'unknown');
    }, action.executionPolicy?.timeoutMs || DEFAULT_TIMEOUT);
    async function dispatchUrl(urlString) {
      await enterEffect(run, () => {
        run.effectEntered = true;
        if (platform === 'darwin') startChild(run, '/usr/bin/open', [urlString], {}, undefined, true);
        else if (platform === 'win32') {
          // URL travels on stdin as data; never in PowerShell source or parsed argv.
          const script = '$ErrorActionPreference = "Stop"; $u = [Console]::In.ReadLine(); Start-Process -FilePath $u';
          startChild(run, 'powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {}, urlString + '\n', true);
        } else if (platform === 'linux') startChild(run, 'xdg-open', [urlString], {}, undefined, true);
        else finish(run, 'blocked');
      });
    }
    if (action.kind === 'hostProcess') {
      try {
        const absolute = platform === 'win32' ? path.win32.isAbsolute(action.cwd) && /^[a-z]:[\\/]|^\\\\[^\\]+\\[^\\]+/i.test(action.cwd) : path.posix.isAbsolute(action.cwd);
        if (!absolute || !(await fsStat(action.cwd)).isDirectory()) { finish(run, 'blocked'); return receipt(); }
      } catch { finish(run, 'blocked'); return receipt(); }
      if (run.done || run.stopReason) { finish(run, run.stopReason || 'blocked'); return receipt(); }
      if (platform === 'win32' && ['bash', 'zsh'].includes(action.shellKind) || platform !== 'win32' && action.shellKind === 'cmd') { finish(run, 'blocked'); return receipt(); }
      const commands = {
        bash: ['/bin/bash', ['-c', action.script]],
        zsh: ['/bin/zsh', ['-c', action.script]],
        powershell: [platform === 'win32' ? 'powershell.exe' : 'pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(action.script, 'utf16le').toString('base64')]],
        cmd: ['cmd.exe', ['/d', '/s', '/c', action.script]]
      };
      const [command, args] = commands[action.shellKind];
      await enterEffect(run,()=>{run.effectEntered=true;startChild(run,command,args,{cwd:action.cwd});});
    } else if (action.kind === 'hostUrl' || action.kind === 'appUrl') {
      await dispatchUrl(action.url);
    } else if (action.kind === 'macApp') {
      if (platform !== 'darwin') { finish(run, 'unavailable'); return receipt(); }
      try {
        if (!(await fsStat(action.appPath)).isDirectory()) { finish(run, 'blocked'); return receipt(); }
      } catch { finish(run, 'blocked'); return receipt(); }
      if (run.done || run.stopReason) { finish(run, run.stopReason || 'blocked'); return receipt(); }
      await enterEffect(run, () => {
        run.effectEntered = true;
        startChild(run, '/usr/bin/open', ['-a', action.appPath], {}, undefined, true);
      });
    } else if (action.kind === 'macShortcut') {
      if (platform !== 'darwin') { finish(run, 'unavailable'); return receipt(); }
      await enterEffect(run, () => {
        run.effectEntered = true;
        startChild(run, '/usr/bin/shortcuts', ['run', action.name], {}, undefined, false);
      });
    } else if (action.kind === 'macSystem') {
      if (platform !== 'darwin') { finish(run, 'unavailable'); return receipt(); }
      const spec = resolveMacSystemCommand(action.action, env);
      if (!spec) { finish(run, 'blocked'); return receipt(); }
      await enterEffect(run, () => {
        run.effectEntered = true;
        startChild(run, spec.command, spec.args, {}, undefined, spec.handoff);
      });
    } else if (action.kind === 'macHotkey') {
      if (platform !== 'darwin') { finish(run, 'unavailable'); return receipt(); }
      const script = buildMacHotkeyScript(action.key, action.modifiers);
      await enterEffect(run, () => {
        run.effectEntered = true;
        startChild(run, '/usr/bin/osascript', ['-e', script], {}, undefined, false);
      });
    } else {
      const adapter = receiverAdapter(action);
      if (!adapter) finish(run, 'unavailable');
      else if (targets.has(action.targetRef)) finish(run, 'blocked');
      else {
        // Mutual exclusion, not an auto-retrying queue. A hung adapter retains
        // the lock even after local timeout: its effect may still be in flight.
        targets.set(action.targetRef, run);
        void receiverRun(run, action, adapter);
      }
    }
    return receipt();
  }
  return {
    dispatch,
    receiverContext,
    // The HTTP owner must recheck current device authority and run ownership on
    // every cancel/status request; a runId is an identifier, never authorization.
    cancel(runId) {
      const run = runs.get(runId);
      if (run && !run.done) {
        if (run.child) stop(run, 'cancelled');
        else { run.stopReason = 'cancelled'; finish(run, 'unknown'); }
      }
      return safe(run);
    },
    status(runId) { return safe(runs.get(runId)); },
    // Local management only. Never forward this method or completion to paired UI.
    localStatus(runId) {
      const run = runs.get(runId);
      return run ? {...safe(run), stdout: Buffer.concat(run.stdout).toString('utf8'), stderr: Buffer.concat(run.stderr).toString('utf8'), outputTruncated: run.truncated} : null;
    },
    async capabilities() {
      const supported=['darwin','win32','linux'].includes(platform);
      const commands=platform==='win32'?{powershell:'powershell.exe',cmd:'cmd.exe'}:{bash:'/bin/bash',zsh:'/bin/zsh',powershell:'pwsh'};
      const shellStates={};for(const [kind,command]of Object.entries(commands))shellStates[kind]=supported&&await executableAvailable(command)?'available':'unavailable';
      const shellKinds=Object.keys(shellStates).filter(kind=>shellStates[kind]==='available');
      const opener=platform==='darwin'?'/usr/bin/open':platform==='win32'?'powershell.exe':'xdg-open';
      const urlAvailable=supported&&await executableAvailable(opener);
      let macTools=null;
      if(platform==='darwin'){
        const paths={open:'/usr/bin/open',osascript:'/usr/bin/osascript',shortcuts:'/usr/bin/shortcuts',sips:'/usr/bin/sips',plutil:'/usr/bin/plutil',screencapture:'/usr/sbin/screencapture',pmset:'/usr/bin/pmset'};
        macTools={};
        for(const [name,file]of Object.entries(paths))macTools[name]=await executableAvailable(file);
      }
      return {hostUrl: urlAvailable, appUrl: urlAvailable, hostProcess: shellKinds.length>0, macControl: platform==='darwin', macTools, shellKinds, shellStates, maxConcurrent: MAX_ACTIVE, maxTimeoutMs: 3600000, maxOutputBytes: 1048576, receivers: Object.keys(receivers).filter(key => typeof receivers[key]?.inspect === 'function' && typeof receivers[key]?.dispatch === 'function'), herdr: 'unavailable', windowsQualified: false};
    }
  };
}
