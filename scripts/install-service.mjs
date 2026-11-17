import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

export const serviceName = 'com.humanerd.agent-deck';
const exec = promisify(execFile);
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const unxml = value => value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => ({amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"})[entity]);

export function assertSupportedPlatform(platform) {
  if (platform !== 'darwin' && platform !== 'win32') throw new Error(`Unsupported service platform: ${platform}`);
}

function validatePaths({root, node, home}, platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  for (const value of [root, node, ...(home === undefined ? [] : [home])]) {
    if (typeof value !== 'string' || !p.isAbsolute(value) || /[\0-\x1f]/.test(value)
      || (platform === 'win32' && !/^[a-z]:[\\/]|^\\\\[^\\]+\\[^\\]+/i.test(value))) throw new Error('Service paths must be absolute and contain no control characters.');
  }
}

export function buildLaunchAgent({root, node, home, envPath = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'}) {
  validatePaths({root, node, home}, 'darwin');
  if (typeof envPath !== 'string' || /[\0-\x1f]/.test(envPath)) throw new Error('Service PATH must contain no control characters.');
  const logs = path.posix.join(home, 'Library/Logs/Agent Deck');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${serviceName}</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(path.posix.join(root, 'server.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(home)}</string><key>PATH</key><string>${xml(envPath)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(path.posix.join(logs, 'server.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.posix.join(logs, 'server.error.log'))}</string>
</dict></plist>
`;
}

// CommandLineToArgvW quoting; Task Scheduler supplies Command separately.
export function quoteWindowsArgument(value) {
  if (/[\0\r\n]/.test(value)) throw new Error('Invalid Windows argument.');
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}

export function buildWindowsTask({root, node, userId}) {
  validatePaths({root, node}, 'win32');
  if (!/^S-1-\d+(?:-\d+)+$/.test(userId)) throw new Error('An authenticated Windows user SID is required.');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<RegistrationInfo><Description>Agent Deck per-user interactive host</Description></RegistrationInfo>
<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(userId)}</UserId></LogonTrigger></Triggers>
<Principals><Principal id="Author"><UserId>${xml(userId)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings>
<Actions Context="Author"><Exec><Command>${xml(node)}</Command><Arguments>${xml(quoteWindowsArgument(path.win32.join(root, 'server.mjs')))}</Arguments><WorkingDirectory>${xml(root)}</WorkingDirectory></Exec></Actions>
</Task>
`;
}

export function ownsLaunchAgent(contents, {root, node}) {
  // Only the exact executable/argv and working directory establish ownership.
  // A label, PID, command substring, or listening port never does.
  if (/<!ENTITY|<!\[CDATA\[|<!--/i.test(contents)) return false;
  const strings = block => [...block.matchAll(/<string>([^<]*)<\/string>/g)].map(match => unxml(match[1]));
  const args = [...contents.matchAll(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/g)];
  const cwd = [...contents.matchAll(/<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/g)];
  const label = [...contents.matchAll(/<key>Label<\/key>\s*<string>([^<]*)<\/string>/g)];
  return args.length === 1 && cwd.length === 1 && label.length === 1
    && unxml(label[0][1]) === serviceName && unxml(cwd[0][1]) === root
    && JSON.stringify(strings(args[0][1])) === JSON.stringify([node, path.posix.join(root, 'server.mjs')])
    && !/<key>Program<\/key>/.test(contents);
}

export function ownsWindowsTask(task, {root, node, userId}) {
  return task.actionCount === 1 && task.command === node
    && task.arguments === quoteWindowsArgument(path.win32.join(root, 'server.mjs'))
    && task.cwd === root && task.userId === userId && task.logonType === 'Interactive';
}

export function ownsLoadedLaunchAgent(contents, {root, node, installedPath}) {
  const field = key => contents.match(new RegExp(`^\\s*${key} = (.+)$`, 'm'))?.[1];
  const args = contents.match(/^\s*arguments = \{\s*\n([\s\S]*?)^\s*\}/m)?.[1]
    .split('\n').map(value => value.trim()).filter(Boolean);
  return field('path') === installedPath && field('program') === node
    && field('working directory') === root
    && JSON.stringify(args) === JSON.stringify([node, path.posix.join(root, 'server.mjs')]);
}

async function portOccupied() {
  return new Promise((resolve, reject) => {
    const socket = net.connect({host: '127.0.0.1', port: 43187});
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Port ownership check timed out.')); });
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve(false) : reject(error));
  });
}

export function createServiceOperations({platform, run = exec, fsOps = fs, systemRoot = process.env.SystemRoot || 'C:\\Windows'} = {}) {
  const scheduler = path.win32.join(systemRoot, 'System32', 'schtasks.exe');
  const powershellExe = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const powershell = script => run(powershellExe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ' + script], {windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024});
  return {
    fs: fsOps,
    getuid: () => process.getuid(),
    userId: async () => (await powershell('[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value')).stdout.trim(),
    portOccupied,
    async query(config) {
      if (platform === 'win32') {
        // Fixed script, no caller values interpolated into PowerShell source.
        const script = `$ErrorActionPreference='Stop'; $name='${serviceName}-'+[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $t=@(Get-ScheduledTask -TaskPath '\\' | Where-Object TaskName -eq $name); if($t.Count -gt 1){throw 'Ambiguous task'}; if($t.Count -eq 1){$t=$t[0]; [pscustomobject]@{actionCount=@($t.Actions).Count; command=$t.Actions[0].Execute; arguments=$t.Actions[0].Arguments; cwd=$t.Actions[0].WorkingDirectory; userId=$t.Principal.UserId; logonType=[string]$t.Principal.LogonType; running=([string]$t.State -in @('Running','Queued'))} | ConvertTo-Json -Compress}`;
        const {stdout} = await powershell(script);
        return stdout.trim() ? JSON.parse(stdout) : null;
      }
      let contents = null;
      try { contents = await fsOps.readFile(config.installedPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      let loaded = null;
      try { loaded = (await run('/bin/launchctl', ['print', config.target])).stdout; }
      catch (error) { if (error.code !== 113) throw error; }
      if (contents === null && loaded === null) return null;
      if (loaded !== null && !ownsLoadedLaunchAgent(loaded, config)) throw new Error('Loaded service ownership is unknown; not modified.');
      return {contents, loaded: loaded !== null, running: !!loaded?.match(/^\s*state = running\s*$/m)};
    },
    async register(config) {
      if (platform === 'win32') {
        await run(scheduler, ['/Create', '/TN', config.taskName, '/XML', config.preparedPath, '/F']);
      } else {
        await run('/usr/bin/plutil', ['-lint', config.preparedPath]);
        await fsOps.mkdir(path.dirname(config.installedPath), {recursive: true});
        await fsOps.mkdir(config.logs, {recursive: true});
        await fsOps.copyFile(config.preparedPath, config.installedPath);
      }
    },
    async start(config, current) {
      if (platform === 'win32') await run(scheduler, ['/Run', '/TN', config.taskName]);
      else if (current?.loaded) await run('/bin/launchctl', ['kickstart', config.target]);
      else await run('/bin/launchctl', ['bootstrap', config.domain, config.installedPath]);
    },
    async stop(config, current) {
      if (platform === 'win32') { if (current.running) await run(scheduler, ['/End', '/TN', config.taskName]); }
      else if (current.loaded) await run('/bin/launchctl', ['bootout', config.target]);
    },
    async unregister(config) {
      if (platform === 'win32') await run(scheduler, ['/Delete', '/TN', config.taskName, '/F']);
      else await fsOps.unlink(config.installedPath);
    },
  };
}

// No process killing, pairing/layout access, elevation, shell interpolation, or
// Session 0 task. prepare does not query or mutate OS service registration.
export async function runInstaller({action = 'install', platform = process.platform, root = path.dirname(path.dirname(fileURLToPath(import.meta.url))), node = process.execPath, home = os.homedir(), env = process.env, operations} = {}) {
  assertSupportedPlatform(platform); // Must precede getuid and all side effects.
  if (!['prepare', 'install', 'start', 'stop', 'uninstall'].includes(action)) throw new Error(`Unknown lifecycle action: ${action}`);
  validatePaths({root, node, home}, platform);
  const ops = operations || createServiceOperations({platform});
  const p = platform === 'win32' ? path.win32 : path.posix;
  const config = {root, node, home};
  if (platform === 'darwin') {
    config.domain = `gui/${ops.getuid()}`;
    config.target = `${config.domain}/${serviceName}`;
    config.installedPath = p.join(home, 'Library/LaunchAgents', `${serviceName}.plist`);
    config.logs = p.join(home, 'Library/Logs/Agent Deck');
    config.preparedPath = p.join(root, 'agent-deck.launchagent.plist');
    config.contents = buildLaunchAgent({...config, envPath: env.PATH});
  } else {
    config.userId = await ops.userId();
    config.taskName = `${serviceName}-${config.userId}`;
    config.preparedPath = p.join(root, 'agent-deck.scheduled-task.xml');
    config.contents = buildWindowsTask(config);
  }
  async function prepare() {
    const data = platform === 'win32' ? Buffer.from('\ufeff' + config.contents, 'utf16le') : config.contents;
    await ops.fs.writeFile(config.preparedPath, data, {mode: 0o600});
  }
  if (action === 'prepare') { await prepare(); return {status: 'prepared', path: config.preparedPath}; }
  let current = await ops.query(config);
  if (current && !(platform === 'win32' ? ownsWindowsTask(current, config) : current.contents !== null && ownsLaunchAgent(current.contents, config))) {
    throw new Error('Existing service ownership is unknown; not modified.');
  }
  if (action === 'stop' || action === 'uninstall') {
    if (!current) return {status: 'absent'};
    await ops.stop(config, current);
    if (action === 'uninstall') await ops.unregister(config);
    return {status: action === 'stop' ? 'stopped' : 'uninstalled'};
  }
  if (current?.running) return {status: 'running', readiness: 'not-checked'};
  if (action === 'start' && !current) throw new Error('Service is not installed; run install first.');
  if (await ops.portOccupied()) throw new Error('Port 43187 is occupied; no listener was stopped and no service was modified.');
  if (action === 'install') {
    // Never overwrite a loaded definition: unload only after ownership and port checks.
    if (current) await ops.stop(config, current);
    await prepare();
    await ops.register(config);
    current = null;
  }
  await ops.start(config, current);
  return {status: 'start-requested', readiness: 'not-checked'};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const action = args.length === 0 ? 'install' : args.length === 1 ? args[0].replace(/^--/, '') : '';
  try {
    const result = await runInstaller({action});
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
