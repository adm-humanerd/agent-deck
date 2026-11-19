import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {pathToFileURL} from 'node:url';
import {mkdtemp, rm, readdir} from 'node:fs/promises';
import sharp from 'sharp';
import {createRequestHandler} from '../server.mjs';
import {createSessions} from '../src/host/connections.mjs';
import {createLayoutStore} from '../src/deck/shared-layout.mjs';
import {createAssetStore} from '../src/actions/deck-assets.mjs';
import {defaultDeckLayouts, validateDeckLayouts} from '../src/deck/deck-layout.mjs';
import {validateCustomSnapshot, projectSnapshot} from '../src/actions/custom-snapshot.mjs';
import {createHostDispatcher, validateAction} from '../src/host/host-actions.mjs';
import {createMacCatalog, buildMacHotkeyScript, resolveMacSystemCommand, MAC_SYSTEM_CATALOG, MAC_HOTKEY_PRESETS, MAC_APP_URL_PRESETS} from '../src/host/mac-control.mjs';

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

test('validateAction strictly validates macOS controls and appUrl without loosening hostUrl', () => {
  const app = validateAction({kind: 'macApp', appPath: '/Applications/Safari.app'});
  assert.deepEqual(app, {kind: 'macApp', appPath: '/Applications/Safari.app'});
  assert.ok(Object.isFrozen(app));

  const shortcut = validateAction({kind: 'macShortcut', name: 'Work Setup'});
  assert.deepEqual(shortcut, {kind: 'macShortcut', name: 'Work Setup'});
  assert.ok(Object.isFrozen(shortcut));

  const sys = validateAction({kind: 'macSystem', action: 'volume-mute'});
  assert.deepEqual(sys, {kind: 'macSystem', action: 'volume-mute'});
  assert.ok(Object.isFrozen(sys));

  const hotkey = validateAction({kind: 'macHotkey', key: 'space', modifiers: ['cmd', 'shift']});
  assert.deepEqual(hotkey, {kind: 'macHotkey', key: 'space', modifiers: ['cmd', 'shift']});
  assert.ok(Object.isFrozen(hotkey));
  assert.ok(Object.isFrozen(hotkey.modifiers));

  for (const scheme of ['raycast://', 'obsidian://open?vault=Notes', 'slack://open', 'x-apple.systempreferences:']) {
    const parsed = validateAction({kind: 'appUrl', url: scheme});
    assert.equal(parsed.kind, 'appUrl');
    assert.equal(parsed.url, new URL(scheme).href);
  }

  for (const invalid of [
    {kind: 'macApp', appPath: 'Applications/Safari.app'},
    {kind: 'macApp', appPath: '/Applications/../etc/Safari.app'},
    {kind: 'macApp', appPath: '/Applications/Safari.app/'},
    {kind: 'macApp', appPath: '/Applications/.app'},
    {kind: 'macApp', appPath: '/Applications/Safari'},
    {kind: 'macApp', appPath: '/Applications/Safari.app', extra: 1},
    {kind: 'macApp', get appPath() { throw Error('accessor must not run'); }},
    {kind: 'macShortcut', name: ''},
    {kind: 'macShortcut', name: '   '},
    {kind: 'macShortcut', name: 'bad\nname'},
    {kind: 'macSystem', action: 'erase-disk'},
    {kind: 'macHotkey', key: 'A', modifiers: ['cmd']},
    {kind: 'macHotkey', key: 'cmd', modifiers: []},
    {kind: 'macHotkey', key: 'a', modifiers: ['cmd', 'cmd']},
    {kind: 'macHotkey', key: 'a', modifiers: ['meta']},
    {kind: 'appUrl', url: 'https://example.org/'},
    {kind: 'appUrl', url: 'http://127.0.0.1/'},
    {kind: 'appUrl', url: 'file:///etc/passwd'},
    {kind: 'appUrl', url: 'javascript:alert(1)'},
    {kind: 'appUrl', url: 'data:text/plain,hi'},
    {kind: 'appUrl', url: 'raycast://user:pass@host'},
    {kind: 'appUrl', url: 'raycast://bad url'},
    {kind: 'appUrl', url: 'raycast://bad%0a'},
    {kind: 'appUrl', url: 'c:\\Windows\\System32\\calc.exe'},
    {kind: 'hostUrl', url: 'raycast://'},
    {kind: 'hostUrl', url: 'obsidian://open'}
  ]) {
    assert.throws(() => validateAction(invalid), TypeError);
  }
});

test('buildMacHotkeyScript and resolveMacSystemCommand generate injection-free argv descriptors', () => {
  assert.equal(buildMacHotkeyScript('c', ['cmd']), 'tell application "System Events" to keystroke "c" using {command down}');
  assert.equal(buildMacHotkeyScript('space', ['cmd', 'alt']), 'tell application "System Events" to key code 49 using {command down, option down}');
  assert.equal(buildMacHotkeyScript('f12', []), 'tell application "System Events" to key code 111');
  assert.throws(() => buildMacHotkeyScript('rm -rf', ['cmd']), TypeError);

  assert.equal(MAC_SYSTEM_CATALOG.length, 12);
  assert.equal(MAC_HOTKEY_PRESETS.length, 10);
  assert.equal(MAC_APP_URL_PRESETS.length, 8);
  assert.deepEqual(resolveMacSystemCommand('downloads', {HOME: '/Users/alice'}), {command: '/usr/bin/open', args: ['/Users/alice/Downloads'], handoff: true});
  assert.equal(resolveMacSystemCommand('downloads', {HOME: 'relative/home'}), null);
  assert.equal(resolveMacSystemCommand('downloads', {}), null);
  assert.equal(resolveMacSystemCommand('unknown'), null);
});

test('snapshot validation and remote projection hide macOS action definitions while retaining new symbols', () => {
  const layouts = defaultDeckLayouts();
  layouts[0].slots[0] = {type: 'custom', actionId: 'mac-app', presentation: {label: 'Safari', symbol: 'app'}};
  layouts[0].slots[1] = {type: 'custom', actionId: 'mac-hotkey', presentation: {label: 'Copy', symbol: 'keyboard'}};
  layouts[0].slots[2] = {type: 'custom', actionId: 'app-url', presentation: {label: 'Raycast', symbol: 'link'}};
  assert.deepEqual(validateDeckLayouts(layouts), layouts);

  const snapshot = {
    schemaVersion: 1,
    revision: 0,
    layouts,
    actions: [
      {id: 'mac-app', enabled: true, definition: {kind: 'macApp', appPath: '/Applications/PrivateTool.app'}},
      {id: 'mac-hotkey', enabled: true, definition: {kind: 'macHotkey', key: 'v', modifiers: ['cmd']}},
      {id: 'app-url', enabled: true, definition: {kind: 'appUrl', url: 'obsidian://open?vault=PrivateVault'}}
    ],
    assets: []
  };
  assert.equal(validateCustomSnapshot(snapshot).actions.length, 3);
  const remoteProjection = projectSnapshot({...snapshot, initialized: true}, false);
  assert.deepEqual(remoteProjection.actions, [
    {id: 'mac-app', enabled: true},
    {id: 'mac-hotkey', enabled: true},
    {id: 'app-url', enabled: true}
  ]);
  const serialized = JSON.stringify(remoteProjection);
  assert.equal(serialized.includes('PrivateTool'), false);
  assert.equal(serialized.includes('PrivateVault'), false);
  assert.equal(serialized.includes('modifiers'), false);
});

test('mock dispatcher handles macOS actions on darwin and fails closed as unavailable on non-darwin', async () => {
  const statCalls = [];
  const mock = mockChildren();
  const dispatcher = createHostDispatcher({
    platform: 'darwin',
    env: {HOME: '/Users/tester'},
    fsStat: async target => {
      statCalls.push(target);
      if (target === '/Applications/Safari.app') return {isDirectory: () => true};
      throw Object.assign(Error('ENOENT'), {code: 'ENOENT'});
    },
    ...mock
  });

  const missingApp = await dispatcher.dispatch({kind: 'macApp', appPath: '/Applications/Missing.app'});
  assert.equal((await missingApp.completion).state, 'blocked');
  assert.equal(mock.calls.length, 0);

  const appRun = await dispatcher.dispatch({kind: 'macApp', appPath: '/Applications/Safari.app'});
  assert.deepEqual(statCalls, ['/Applications/Missing.app', '/Applications/Safari.app']);
  assert.equal(mock.calls[0].command, '/usr/bin/open');
  assert.deepEqual(mock.calls[0].args, ['-a', '/Applications/Safari.app']);
  assert.equal(mock.calls[0].options.shell, false);
  mock.calls[0].child.emit('close', 0, null);
  assert.equal((await appRun.completion).state, 'handoff');

  const shortcutRun = await dispatcher.dispatch({kind: 'macShortcut', name: 'Morning Brief'});
  assert.equal(mock.calls[1].command, '/usr/bin/shortcuts');
  assert.deepEqual(mock.calls[1].args, ['run', 'Morning Brief']);
  mock.calls[1].child.emit('close', 0, null);
  assert.equal((await shortcutRun.completion).state, 'exit');

  const dlRun = await dispatcher.dispatch({kind: 'macSystem', action: 'downloads'});
  assert.equal(mock.calls[2].command, '/usr/bin/open');
  assert.deepEqual(mock.calls[2].args, ['/Users/tester/Downloads']);
  mock.calls[2].child.emit('close', 0, null);
  assert.equal((await dlRun.completion).state, 'handoff');

  const hotkeyRun = await dispatcher.dispatch({kind: 'macHotkey', key: 'c', modifiers: ['cmd']});
  assert.equal(mock.calls[3].command, '/usr/bin/osascript');
  assert.deepEqual(mock.calls[3].args, ['-e', 'tell application "System Events" to keystroke "c" using {command down}']);
  mock.calls[3].child.emit('close', 0, null);
  assert.equal((await hotkeyRun.completion).state, 'exit');

  const appUrlRun = await dispatcher.dispatch({kind: 'appUrl', url: 'obsidian://open?vault=SecretVault'});
  assert.equal(mock.calls[4].command, '/usr/bin/open');
  assert.deepEqual(mock.calls[4].args, ['obsidian://open?vault=SecretVault']);
  mock.calls[4].child.emit('close', 0, null);
  assert.equal((await appUrlRun.completion).state, 'handoff');
  assert.equal(JSON.stringify(dispatcher.status(appUrlRun.runId)).includes('SecretVault'), false);

  for (const nonDarwin of ['linux', 'win32']) {
    const otherMock = mockChildren();
    const other = createHostDispatcher({platform: nonDarwin, ...otherMock});
    for (const def of [
      {kind: 'macApp', appPath: '/Applications/Safari.app'},
      {kind: 'macShortcut', name: 'Morning Brief'},
      {kind: 'macSystem', action: 'volume-up'},
      {kind: 'macHotkey', key: 'c', modifiers: ['cmd']}
    ]) {
      const receipt = await other.dispatch(def);
      assert.equal((await receipt.completion).state, 'unavailable');
    }
    assert.equal(otherMock.calls.length, 0);
    const caps = await other.capabilities();
    assert.equal(caps.macControl, false);
    assert.equal(caps.macTools, null);
  }
});

test('mock createMacCatalog scans nested apps, resolves icons safely, cleans temp dirs, and handles non-darwin', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-mac-cat-'));
  try {
    const entriesByDir = {
      '/Applications': [
        {name: 'Safari.app', isDirectory: () => true, isSymbolicLink: () => false},
        {name: '.Hidden.app', isDirectory: () => true, isSymbolicLink: () => false},
        {name: '__MACOSX', isDirectory: () => true, isSymbolicLink: () => false},
        {name: 'Utilities', isDirectory: () => true, isSymbolicLink: () => false}
      ],
      '/Applications/Utilities': [
        {name: 'SubTool.app', isDirectory: () => true, isSymbolicLink: () => false},
        {name: 'TooDeep', isDirectory: () => true, isSymbolicLink: () => false}
      ],
      '/Applications/Utilities/TooDeep': [
        {name: 'Ignored.app', isDirectory: () => true, isSymbolicLink: () => false}
      ],
      '/Applications/Fallback.app/Contents/Resources': ['custom.icns'],
      '/Applications/Traversal.app/Contents/Resources': ['AppIcon.icns']
    };
    const accessible = new Set([
      '/Applications/Safari.app/Contents/Resources/compass.icns',
      '/Applications/Fallback.app/Contents/Resources/custom.icns'
    ]);
    const written = new Map();
    let sipsShouldFail = false;

    const catalogService = createMacCatalog({
      platform: 'darwin',
      appDirs: ['/Applications'],
      coreApps: ['/System/Library/CoreServices/Finder.app'],
      tempDir: dir,
      fs: {
        readdir: async (target, opts) => {
          if (target === '/Applications/Fallback.app/Contents/Resources' && !opts) return entriesByDir[target];
          if (entriesByDir[target]) return entriesByDir[target];
          throw Object.assign(Error('ENOENT'), {code: 'ENOENT'});
        },
        stat: async target => {
          if (target === '/System/Library/CoreServices/Finder.app') return {isDirectory: () => true};
          throw Error('ENOENT');
        },
        access: async target => {
          if (!accessible.has(target)) throw Error('ENOENT');
        },
        mkdtemp: prefix => mkdtemp(prefix),
        rm: (target, opts) => rm(target, opts),
        readFile: async target => written.get(target)
      },
      execFileImpl: async (file, args) => {
        if (file === '/usr/bin/shortcuts') return {stdout: 'Alpha\n\nBeta\nAlpha\n'};
        if (file === '/usr/bin/plutil') {
          const plist = args.at(-1);
          if (plist.includes('Safari.app')) return {stdout: 'compass\n'};
          if (plist.includes('Traversal.app')) return {stdout: '../../../etc/passwd\n'};
          throw Error('missing plist');
        }
        if (file === '/usr/bin/sips') {
          if (sipsShouldFail) throw Error('sips failed');
          const out = args.at(-1);
          written.set(out, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
          return {stdout: ''};
        }
        throw Error('unexpected binary: ' + file);
      }
    });

    const cat = await catalogService.getCatalog();
    assert.equal(cat.supported, true);
    assert.deepEqual(cat.apps.map(a => a.app), [
      '/System/Library/CoreServices/Finder.app',
      '/Applications/Safari.app',
      '/Applications/Utilities/SubTool.app'
    ]);
    assert.deepEqual(cat.shortcuts, ['Alpha', 'Beta']);

    const png = await catalogService.extractAppIconPng('/Applications/Safari.app');
    assert.equal(png.subarray(0, 4).toString('binary'), '\x89PNG');
    assert.deepEqual(await readdir(dir), []);

    await assert.rejects(catalogService.extractAppIconPng('/Applications/NotInstalled.app'), {status: 404});

    // Fallback scanning & traversal guard
    entriesByDir['/Applications'].push(
      {name: 'Fallback.app', isDirectory: () => true, isSymbolicLink: () => false},
      {name: 'Traversal.app', isDirectory: () => true, isSymbolicLink: () => false}
    );
    await catalogService.getCatalog({force: true});
    const fallbackPng = await catalogService.extractAppIconPng('/Applications/Fallback.app');
    assert.equal(fallbackPng.subarray(0, 4).toString('binary'), '\x89PNG');
    await assert.rejects(catalogService.extractAppIconPng('/Applications/Traversal.app'), {status: 400});

    sipsShouldFail = true;
    await assert.rejects(catalogService.extractAppIconPng('/Applications/Safari.app'), {status: 422});
    assert.deepEqual(await readdir(dir), []);

    const linuxCat = createMacCatalog({platform: 'linux'});
    assert.deepEqual((await linuxCat.getCatalog()).supported, false);
    assert.deepEqual((await linuxCat.getCatalog()).apps, []);
    await assert.rejects(linuxCat.extractAppIconPng('/Applications/Safari.app'), {status: 400});
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('HTTP routes gate mac-catalog/mac-app-icon to localhost and execute saved macSystem once', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-mac-http-'));
  const layouts = createLayoutStore(path.join(dir, 'layout.json'));
  const assets = createAssetStore(path.join(dir, 'assets'));
  const sessions = await createSessions(pathToFileURL(path.join(dir, 'sessions.json')));
  const mock = mockChildren();
  const dispatcher = createHostDispatcher({platform: 'darwin', ...mock});
  const iconPng = await sharp({create: {width: 16, height: 16, channels: 4, background: '#3b82f6'}}).png().toBuffer();
  const macCatalog = {
    getCatalog: async ({force} = {}) => ({
      ok: true,
      supported: true,
      apps: [{app: '/Applications/Fixture.app', name: 'Fixture'}],
      shortcuts: ['FixtureFlow'],
      systemControls: MAC_SYSTEM_CATALOG,
      hotkeyPresets: MAC_HOTKEY_PRESETS,
      appUrlPresets: MAC_APP_URL_PRESETS,
      force: !!force,
      updated: '2026-01-01T00:00:00.000Z'
    }),
    extractAppIconPng: async appPath => {
      assert.equal(appPath, '/Applications/Fixture.app');
      return iconPng;
    }
  };
  let handler;
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, local = `127.0.0.1:${port}`, lan = `192.0.2.10:${port}`;
  const runner = {refresh: async () => ({ok: true, agents: [], sessions: []})};
  handler = createRequestHandler({
    sessions,
    layouts,
    assets,
    dispatcher,
    macCatalog,
    bridge: runner,
    nativeHerdr: runner,
    network: {refresh: async () => ({ok: true, sessions: []})},
    quotas: {refresh: async () => ({providers: []})},
    pin: '123456',
    listenPort: port,
    addresses: () => [{address: '192.0.2.10'}]
  });
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
    await rm(dir, {recursive: true, force: true});
  });

  async function req(route, {method = 'GET', body, remote = false, cookie, origin = true} = {}) {
    const host = remote ? lan : local, headers = {Host: host};
    if (origin) headers.Origin = 'http://' + host;
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return new Promise((resolve, reject) => {
      const r = http.request({hostname: '127.0.0.1', port, path: route, method, headers}, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({status: res.statusCode, headers: res.headers, bytes: buf, json: res.headers['content-type']?.includes('application/json') ? JSON.parse(buf) : null});
        });
      });
      r.on('error', reject);
      r.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  const paired = await req('/api/pair', {method: 'POST', remote: true, body: {code: '123456'}});
  const cookie = paired.headers['set-cookie'][0].split(';')[0];

  assert.equal((await req('/api/actions/mac-catalog', {remote: true})).status, 401);
  assert.equal((await req('/api/actions/mac-catalog', {remote: true, cookie})).status, 403);
  const localCat = await req('/api/actions/mac-catalog?refresh=1');
  assert.equal(localCat.status, 200);
  assert.equal(localCat.json.apps[0].app, '/Applications/Fixture.app');
  assert.equal(localCat.json.force, true);

  assert.equal((await req('/api/actions/mac-app-icon', {method: 'POST', remote: true, cookie, body: {appPath: '/Applications/Fixture.app'}})).status, 403);
  assert.equal((await req('/api/actions/mac-app-icon', {method: 'POST', origin: false, body: {appPath: '/Applications/Fixture.app'}})).status, 403);
  assert.equal((await req('/api/actions/mac-app-icon', {method: 'POST', body: {appPath: '/Applications/Fixture.app', extra: true}})).status, 400);

  const staged = await req('/api/actions/mac-app-icon', {method: 'POST', body: {appPath: '/Applications/Fixture.app'}});
  assert.equal(staged.status, 201);
  const assetId = staged.json.id;
  assert.equal((await req('/api/assets/' + assetId, {remote: true, cookie})).status, 404);

  const pages = defaultDeckLayouts();
  pages[0].slots[0] = {type: 'custom', actionId: 'vol', presentation: {label: 'Volume Up', asset: assetId}};
  const saved = await req('/api/custom-layout', {
    method: 'PUT',
    body: {schemaVersion: 1, revision: 0, layouts: pages, actions: [{id: 'vol', enabled: true, definition: {kind: 'macSystem', action: 'volume-up'}}], assets: [assetId]}
  });
  assert.equal(saved.status, 200);

  const served = await req('/api/assets/' + assetId, {remote: true, cookie});
  assert.equal(served.status, 200);
  assert.equal((await sharp(served.bytes).metadata()).format, 'webp');

  const prepared = await req('/api/actions/prepare', {remote: true, cookie, method: 'POST', body: {actionId: 'vol', revision: 1, pageId: 'agents', slotIndex: 0}});
  assert.equal(prepared.status, 200);
  const invoked = await req('/api/actions/invoke', {remote: true, cookie, method: 'POST', body: prepared.json});
  assert.equal(invoked.status, 202);
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].command, '/usr/bin/osascript');
  mock.calls[0].child.emit('close', 0, null);
  assert.equal((await req('/api/actions/invoke', {remote: true, cookie, method: 'POST', body: prepared.json})).status, 409);
});

test('real macOS catalog scans Finder.app and stages a real extracted icon to WebP', {skip: process.platform !== 'darwin', timeout: 15000}, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-mac-real-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const macCatalog = createMacCatalog();
  const catalog = await macCatalog.getCatalog();
  assert.equal(catalog.supported, true);
  assert.ok(catalog.apps.some(item => item.app === '/System/Library/CoreServices/Finder.app'));

  const png = await macCatalog.extractAppIconPng('/System/Library/CoreServices/Finder.app');
  assert.equal(png.subarray(0, 4).toString('binary'), '\x89PNG');
  const assets = createAssetStore(path.join(dir, 'assets'));
  const staged = await assets.stage(png);
  assert.match(staged.id, /^[a-f0-9]{64}$/);
  const meta = await sharp(await assets.read(staged.id)).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 128);
  assert.equal(meta.height, 128);
});
