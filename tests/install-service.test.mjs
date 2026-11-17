import test from 'node:test';
import assert from 'node:assert/strict';
import {buildLaunchAgent, buildWindowsTask, quoteWindowsArgument, ownsLaunchAgent, ownsLoadedLaunchAgent, ownsWindowsTask, runInstaller, createServiceOperations, serviceName} from '../scripts/install-service.mjs';

const mac = {root: '/Applications/Deck & 한글', node: '/opt/node/bin/node', home: '/Users/fixture', env: {PATH: '/usr/bin:/bin'}};
const windows = {root: 'C:\\Deck & 한글', node: 'C:\\Program Files\\nodejs\\node.exe', home: 'C:\\Users\\fixture'};
const sid = 'S-1-5-21-111-222-333-1001';
function ownedTask(config = windows) {
  return {actionCount: 1, command: config.node, arguments: quoteWindowsArgument(`${config.root}\\server.mjs`), cwd: config.root, userId: sid, logonType: 'Interactive', running: false};
}
function operations(current = null) {
  const calls = [];
  return {
    calls,
    fs: {async writeFile(...args) { calls.push(['write', ...args]); }},
    getuid() { calls.push(['uid']); return 501; },
    async userId() { calls.push(['sid']); return sid; },
    async query(config) { calls.push(['query', config]); return current; },
    async portOccupied() { calls.push(['port']); return false; },
    async register(config) { calls.push(['register', config]); },
    async start(config, previous) { calls.push(['start', config, previous]); },
    async stop(config, previous) { calls.push(['stop', config, previous]); },
    async unregister(config) { calls.push(['unregister', config]); },
  };
}

test('macOS builder escapes XML and retains exact Unicode argv, environment and logs', () => {
  const contents = buildLaunchAgent({...mac, envPath: '/tools/"quotes" & more'});
  assert.ok(contents.includes('<key>Label</key><string>com.humanerd.agent-deck</string>'));
  assert.ok(contents.includes('<string>/Applications/Deck &amp; 한글/server.mjs</string>'));
  assert.ok(contents.includes('<key>PATH</key><string>/tools/&quot;quotes&quot; &amp; more</string>'));
  assert.ok(contents.includes('/Users/fixture/Library/Logs/Agent Deck/server.error.log'));
  assert.ok(ownsLaunchAgent(contents, mac));
  assert.equal(ownsLaunchAgent(contents, {...mac, root: '/Applications/Deck'}), false);
  assert.equal(ownsLaunchAgent(contents.replace('/server.mjs</string>', '/server.mjs --other</string>'), mac), false);
  assert.equal(ownsLaunchAgent(contents.replace('<key>RunAtLoad</key>', '<key>Program</key><string>/other</string><key>RunAtLoad</key>'), mac), false);
});

test('Windows builder uses per-user interactive least-privilege logon, never a shell or Session0', () => {
  const contents = buildWindowsTask({...windows, userId: sid});
  assert.ok(contents.includes(`<LogonTrigger><Enabled>true</Enabled><UserId>${sid}</UserId>`));
  assert.ok(contents.includes('<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel>'));
  assert.ok(contents.includes('<Command>C:\\Program Files\\nodejs\\node.exe</Command>'));
  assert.ok(contents.includes('<Arguments>&quot;C:\\Deck &amp; 한글\\server.mjs&quot;</Arguments>'));
  assert.ok(contents.includes('<WorkingDirectory>C:\\Deck &amp; 한글</WorkingDirectory>'));
  assert.ok(!contents.includes('cmd.exe'));
  assert.ok(!contents.includes('Password'));
  assert.throws(() => buildWindowsTask({...windows, userId: 'SYSTEM'}), /SID/);
});

test('Windows argv preserves embedded quotes and trailing backslashes without shell syntax', () => {
  assert.equal(quoteWindowsArgument('한글 & x"y\\'), '"한글 & x\\"y\\\\"');
  assert.equal(quoteWindowsArgument(''), '""');
  assert.throws(() => quoteWindowsArgument('x\ny'), /Invalid/);
});

test('unsupported platform rejects before getuid, identity, query or write', async () => {
  const ops = operations();
  await assert.rejects(runInstaller({platform: 'linux', operations: ops}), /Unsupported/);
  assert.deepEqual(ops.calls, []);
});

for (const [platform, config] of [['darwin', mac], ['win32', windows]]) {
  test(`${platform}: prepare only writes a configuration, no registration, listener or service mutation`, async () => {
    const ops = operations();
    const result = await runInstaller({...config, platform, action: 'prepare', operations: ops});
    assert.equal(result.status, 'prepared');
    assert.equal(result.path, platform === 'darwin' ? `${mac.root}/agent-deck.launchagent.plist` : `${windows.root}\\agent-deck.scheduled-task.xml`);
    assert.deepEqual(ops.calls.map(call => call[0]), [platform === 'darwin' ? 'uid' : 'sid', 'write']);
    if (platform === 'win32') {
      const bytes = ops.calls.find(call => call[0] === 'write')[2];
      assert.ok(Buffer.isBuffer(bytes));
      assert.equal(bytes.readUInt16LE(), 0xfeff);
      assert.ok(bytes.toString('utf16le').includes('C:\\Deck &amp; 한글'));
    }
  });

  test(`${platform}: install requests registration/start and does not claim readiness`, async () => {
    const ops = operations();
    const result = await runInstaller({...config, platform, action: 'install', operations: ops});
    assert.deepEqual(result, {status: 'start-requested', readiness: 'not-checked'});
    assert.deepEqual(ops.calls.map(call => call[0]), [platform === 'darwin' ? 'uid' : 'sid', 'query', 'port', 'write', 'register', 'start']);
  });

  test(`${platform}: unknown ownership refuses all mutations`, async () => {
    const ops = operations(platform === 'darwin' ? {contents: buildLaunchAgent({...mac, root: '/unrelated'}), loaded: true} : {...ownedTask(), command: 'C:\\unrelated.exe'});
    for (const action of ['install', 'start', 'stop', 'uninstall']) {
      await assert.rejects(runInstaller({...config, platform, action, operations: ops}), /ownership is unknown/);
    }
    assert.ok(ops.calls.every(call => ['uid', 'sid', 'query'].includes(call[0])));
  });

  test(`${platform}: occupied port is never killed and registration remains untouched`, async () => {
    const ops = operations();
    ops.portOccupied = async () => true;
    await assert.rejects(runInstaller({...config, platform, action: 'install', operations: ops}), /occupied/);
    assert.ok(ops.calls.every(call => ['uid', 'sid', 'query'].includes(call[0])));
  });

  test(`${platform}: absent stop/uninstall are idempotent; absent start refuses`, async () => {
    const ops = operations();
    for (const action of ['stop', 'uninstall']) assert.deepEqual(await runInstaller({...config, platform, action, operations: ops}), {status: 'absent'});
    await assert.rejects(runInstaller({...config, platform, action: 'start', operations: ops}), /not installed/);
    assert.ok(ops.calls.every(call => ['uid', 'sid', 'query'].includes(call[0])));
  });

  test(`${platform}: running owned service is not replaced or restarted`, async () => {
    const current = platform === 'darwin' ? {contents: buildLaunchAgent(mac), loaded: true, running: true} : {...ownedTask(), running: true};
    const ops = operations(current);
    assert.deepEqual(await runInstaller({...config, platform, action: 'install', operations: ops}), {status: 'running', readiness: 'not-checked'});
    assert.ok(ops.calls.every(call => ['uid', 'sid', 'query'].includes(call[0])));
  });

  test(`${platform}: owned uninstall stops and removes only the service registration`, async () => {
    const current = platform === 'darwin' ? {contents: buildLaunchAgent(mac), loaded: true, running: true} : {...ownedTask(), running: true};
    const ops = operations(current);
    assert.deepEqual(await runInstaller({...config, platform, action: 'uninstall', operations: ops}), {status: 'uninstalled'});
    assert.deepEqual(ops.calls.map(call => call[0]), [platform === 'darwin' ? 'uid' : 'sid', 'query', 'stop', 'unregister']);
  });
}

test('Windows ownership requires exact action count, argv, cwd, SID and interactive token', () => {
  assert.ok(ownsWindowsTask(ownedTask(), {...windows, userId: sid}));
  for (const change of [{actionCount: 2}, {arguments: 'server.mjs & other'}, {cwd: 'C:\\other'}, {userId: 'S-1-5-18'}, {logonType: 'Password'}]) {
    assert.equal(ownsWindowsTask({...ownedTask(), ...change}, {...windows, userId: sid}), false);
  }
});

test('invalid paths and lifecycle actions fail before any injected side effects', async () => {
  for (const change of [{root: 'relative'}, {node: '/bad\nnode'}, {action: 'erase'}]) {
    const ops = operations();
    await assert.rejects(runInstaller({...mac, platform: 'darwin', ...change, operations: ops}));
    assert.deepEqual(ops.calls, []);
  }
});

test('macOS OS-operation adapter uses fixed argv and only its exact registration paths', async () => {
  const calls = [];
  const run = async (...args) => { calls.push(['exec', ...args]); return {stdout: ''}; };
  const fsOps = {
    async mkdir(...args) { calls.push(['mkdir', ...args]); },
    async copyFile(...args) { calls.push(['copy', ...args]); },
    async unlink(...args) { calls.push(['unlink', ...args]); },
  };
  const config = {...mac, preparedPath: '/fixture/config & 한글.plist', installedPath: '/fixture/LaunchAgents/own.plist', logs: '/fixture/Logs', domain: 'gui/501', target: `gui/501/${serviceName}`};
  const ops = createServiceOperations({platform: 'darwin', run, fsOps});
  await ops.register(config);
  await ops.start(config, null);
  await ops.stop(config, {loaded: true});
  await ops.unregister(config);
  assert.deepEqual(calls.filter(call => call[0] === 'exec'), [
    ['exec', '/usr/bin/plutil', ['-lint', config.preparedPath]],
    ['exec', '/bin/launchctl', ['bootstrap', config.domain, config.installedPath]],
    ['exec', '/bin/launchctl', ['bootout', config.target]],
  ]);
  assert.deepEqual(calls.filter(call => call[0] === 'unlink'), [['unlink', config.installedPath]]);
  assert.deepEqual(calls.filter(call => call[0] === 'copy'), [['copy', config.preparedPath, config.installedPath]]);
});

test('loaded LaunchAgent ownership checks actual loaded executable/argv/cwd, not a matching plist path alone', () => {
  const config = {...mac, installedPath: '/fixture/own.plist'};
  const loaded = `path = ${config.installedPath}\nprogram = ${mac.node}\nworking directory = ${mac.root}\narguments = {\n  ${mac.node}\n  ${mac.root}/server.mjs\n}\nstate = running\n`;
  assert.ok(ownsLoadedLaunchAgent(loaded, config));
  assert.equal(ownsLoadedLaunchAgent(loaded.replace(`program = ${mac.node}`, 'program = /unrelated/node'), config), false);
  assert.equal(ownsLoadedLaunchAgent(loaded.replace('/server.mjs\n', '/server.mjs\n  --other\n'), config), false);
  assert.equal(ownsLoadedLaunchAgent(`path = ${config.installedPath}`, config), false);
});

test('Windows OS-operation adapter uses direct executable/argv; no XML/path text enters PowerShell source', async () => {
  const calls = [];
  const run = async (...args) => { calls.push(args); return {stdout: ''}; };
  const ops = createServiceOperations({platform: 'win32', run, systemRoot: 'C:\\Windows'});
  const config = {...windows, userId: sid, taskName: `${serviceName}-${sid}`, preparedPath: `${windows.root}\\task.xml`};
  await ops.register(config);
  await ops.start(config);
  await ops.stop(config, {running: true});
  await ops.unregister(config);
  assert.deepEqual(calls, [
    ['C:\\Windows\\System32\\schtasks.exe', ['/Create', '/TN', config.taskName, '/XML', config.preparedPath, '/F']],
    ['C:\\Windows\\System32\\schtasks.exe', ['/Run', '/TN', config.taskName]],
    ['C:\\Windows\\System32\\schtasks.exe', ['/End', '/TN', config.taskName]],
    ['C:\\Windows\\System32\\schtasks.exe', ['/Delete', '/TN', config.taskName, '/F']],
  ]);
  assert.equal(await ops.query(config), null);
  const query = calls.at(-1);
  assert.equal(query[0], 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.ok(!query[1].at(-1).includes(windows.root));
  assert.ok(query[1].at(-1).includes('GetCurrent().User.Value'));
});

test('service query errors are not mistaken for absence or permission to overwrite', async () => {
  const ops = operations();
  ops.query = async () => { throw new Error('access denied'); };
  await assert.rejects(runInstaller({...mac, platform: 'darwin', operations: ops}), /access denied/);
  assert.deepEqual(ops.calls, [['uid']]);
});

test('registration failure never starts a service or touches layout/pairing data', async () => {
  const ops = operations();
  ops.register = async () => { throw new Error('registration denied'); };
  await assert.rejects(runInstaller({...mac, platform: 'darwin', operations: ops}), /registration denied/);
  assert.deepEqual(ops.calls.map(call => call[0]), ['uid', 'query', 'port', 'write']);
  assert.ok(ops.calls.find(call => call[0] === 'write')[1].endsWith('/agent-deck.launchagent.plist'));
});

test('Windows drive-relative and current-drive-rooted service paths reject before identity lookup', async () => {
  for (const root of ['C:relative', '\\tools']) {
    const ops = operations();
    await assert.rejects(runInstaller({...windows, root, platform: 'win32', operations: ops}), /absolute/);
    assert.deepEqual(ops.calls, []);
  }
});
