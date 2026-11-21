import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {access, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import sharp from 'sharp';
import {createRequestHandler} from '../server.mjs';
import {createSessions} from '../src/host/connections.mjs';
import {createLayoutStore} from '../src/deck/shared-layout.mjs';
import {createAssetStore} from '../src/actions/deck-assets.mjs';
import {createHostDispatcher} from '../src/host/host-actions.mjs';

test('Stream Deck driver UX upgrades: always-on edit canvas, catalog search/click/drag, Finder file drop, live auto-save + undo/redo, auto-linked page + canvas bar, profile backup/restore, streamlined trust, and remote isolation', {timeout: 120000, skip: process.platform === 'win32'}, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-editor-ux-'));
  let browser, server;
  const children = new Set();
  try {
    const layouts = createLayoutStore(path.join(dir, 'layout.json'));
    const assets = createAssetStore(path.join(dir, 'assets'));
    const sessions = await createSessions(pathToFileURL(path.join(dir, 'sessions.json')));
    let starts = 0;
    const dispatcher = createHostDispatcher({
      platform: 'darwin',
      spawnImpl: (...args) => {
        starts++;
        const child = spawn(...args);
        children.add(child);
        child.once('close', () => children.delete(child));
        return child;
      }
    });
    const macCatalog = {
      getCatalog: async () => ({
        ok: true,
        supported: true,
        apps: [{app: '/System/Library/CoreServices/Finder.app', name: 'Finder'}],
        shortcuts: ['UX Fixture Shortcut'],
        systemControls: [{action: 'volume-up', name: '볼륨 올리기', detail: '음량 +10%', symbol: 'volume-up'}],
        hotkeyPresets: [{key: 'c', modifiers: ['cmd'], label: '복사 (⌘C)'}],
        appUrlPresets: [{url: 'raycast://', label: 'Raycast 열기'}],
        updated: new Date().toISOString()
      }),
      extractAppIconPng: async () => await sharp({create: {width: 16, height: 16, channels: 4, background: '#315a82'}}).png().toBuffer()
    };
    const runner = {refresh: async () => ({ok: true, agents: [{pane_id: 'p0', agent: 'codex', label: 'Codex 메인', agent_status: 'idle'}], sessions: []})};
    let handler;
    server = http.createServer((req, res) => handler(req, res));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const localURL = `http://127.0.0.1:${port}`;
    const remoteURL = `http://deck-remote.test:${port}`;
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
      addresses: () => [{address: 'deck-remote.test', url: remoteURL}]
    });

    let executablePath = process.env.DECK_BROWSER_PATH;
    if (!executablePath) {
      try {
        await access('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
        executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      } catch {}
    }
    browser = await chromium.launch({
      headless: true,
      executablePath,
      args: ['--host-resolver-rules=MAP deck-remote.test 127.0.0.1']
    });

    const pcCtx = await browser.newContext({viewport: {width: 1440, height: 900}, acceptDownloads: true});
    const pc = await pcCtx.newPage();
    const wait = fn => pc.waitForFunction(fn, null, {timeout: 15000});
    const pageErrors = [];
    pc.on('pageerror', err => pageErrors.push(err.message));

    await pc.goto(localURL);
    await wait(() => layoutRevision === 0 && deckLocal);
    await pc.locator('#initializeLayout').click();
    await wait(() => layoutRevision === 1);

    // 1. Always-on Edit Canvas + Action Library + Collapsed Nav Check + Canvas Page Bar
    assert.equal(await pc.evaluate(() => deckEditing), true);
    assert.equal(await pc.locator('#editorModeBadge').textContent(), '편집 캔버스');
    assert.equal(await pc.locator('#editDeck').textContent(), '동작 미리보기');
    assert.equal(await pc.locator('#actionCatalog').isVisible(), true);
    assert.equal(await pc.locator('#canvasPageBar').isVisible(), true);
    assert.equal(await pc.locator('#navCheckDetails').evaluate(e => e.open), false);

    // Preview toggle turns off edit canvas; right-clicking any key restores edit mode & opens slot 0
    await pc.locator('#editDeck').click();
    await wait(() => deckEditing === false);
    assert.equal(await pc.locator('#catalogPreviewNote').isVisible(), true);
    assert.equal(await pc.locator('#editDeck').textContent(), '편집으로 돌아가기');
    await pc.locator('#keys button[data-key-id]').nth(0).click({button: 'right'});
    await wait(() => deckEditing === true && editingSlot === 0);
    assert.equal(await pc.locator('#keyEditor').isVisible(), true);

    // 2. Mode tabs + Korean-IME-proof hotkey recording + Escape cancels recording without closing editor
    await pc.locator('#modeTabMac').click();
    assert.equal(await pc.locator('#builtinAssignmentGroup').isVisible(), false);
    assert.equal(await pc.locator('#customActionGroup').isVisible(), true);
    await pc.locator('#customKind').selectOption('macHotkey');
    assert.equal(await pc.locator('.custom-trust-warning').isVisible(), false);
    assert.equal(await pc.locator('#customTrusted').isVisible(), false);
    assert.equal(await pc.locator('#recordMacHotkey').isVisible(), true);
    await pc.locator('#recordMacHotkey').click();
    assert.equal(await pc.evaluate(() => hotkeyRecording), true);
    await pc.keyboard.press('Escape');
    assert.equal(await pc.evaluate(() => hotkeyRecording), false);
    assert.equal(await pc.locator('#keyEditor').isVisible(), true);
    await pc.locator('#recordMacHotkey').click();
    await pc.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ㅏ',
        code: 'KeyK',
        metaKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true
      }));
    });
    assert.equal(await pc.evaluate(() => hotkeyRecording), false);
    assert.equal(await pc.locator('#customMacHotkeyKey').inputValue(), 'k');
    assert.equal(await pc.locator('#customModCmd').isChecked(), true);
    assert.equal(await pc.locator('#customModShift').isChecked(), true);
    await wait(() => layoutRevision === 2 && !layoutSaving);

    // Switch back to builtin via modeTabBuiltin -> auto-saves reset cleanly
    await pc.locator('#modeTabBuiltin').click();
    assert.equal(await pc.locator('#customKind').inputValue(), 'builtin');
    assert.equal(await pc.locator('#builtinAssignmentGroup').isVisible(), true);
    assert.equal(await pc.locator('#customActionGroup').isVisible(), false);

    // 3. High-risk kind (hostProcess) requires explicit #customTrusted + manual Save, smart trust focus, and 1-click Test
    await writeFile(path.join(dir, 'ux-test.sh'), '#!/bin/sh\necho UX_TEST_OK\n', {mode: 0o700});
    await pc.locator('#modeTabAutomation').click();
    await pc.locator('#customKind').selectOption('hostProcess');
    assert.equal(await pc.locator('.custom-trust-warning').isVisible(), true);
    assert.equal(await pc.locator('#customTrusted').isVisible(), true);
    await pc.locator('#customLabel').fill('UX Runner');
    await pc.locator('#customColor').fill('315a82');
    await pc.locator('#customColor').blur();
    assert.equal(await pc.locator('#customColor').inputValue(), '#315a82');
    await pc.locator('#customColorPresets .color-preset-chip[data-color="#1b4332"]').click();
    assert.equal(await pc.locator('#customColor').inputValue(), '#1b4332');
    await pc.locator('#customShell').selectOption('bash');
    await pc.locator('#customScript').fill('./ux-test.sh');
    await pc.locator('#customCwd').fill(dir);

    await pc.locator('#saveAssignment').click();
    assert.equal(await pc.locator('#customTrusted').evaluate(e => e === document.activeElement), true);
    assert.equal(await pc.locator('#customTrusted').evaluate(e => e.closest('.custom-check').classList.contains('is-attention')), true);

    await pc.locator('#customTrusted').check();
    await pc.locator('#testCustomAction').click();
    await wait(() => document.querySelector('#customOutput').textContent.includes('UX_TEST_OK'));
    assert.equal(starts, 1);

    // 4. Copy slot 0, step to slot 1 via ›, paste, save; then clear slot 1
    await pc.locator('#copySlotBtn').click();
    await pc.locator('#nextSlotBtn').click();
    await wait(() => editingSlot === 1);
    assert.equal(await pc.locator('#pasteSlotBtn').isDisabled(), false);
    await pc.locator('#pasteSlotBtn').click();
    assert.equal(await pc.locator('#customLabel').inputValue(), 'UX Runner');
    assert.equal(await pc.locator('#customKind').inputValue(), 'hostProcess');
    await pc.locator('#saveAssignment').click();
    await wait(() => !layoutSaving && editingSlot === null);
    assert.equal((await layouts.snapshot()).layouts[0].slots[1].type, 'custom');

    await pc.locator('#keys button[data-key-id]').nth(1).click();
    await wait(() => editingSlot === 1);
    await pc.locator('#clearSlotBtn').click();
    await wait(() => !layoutSaving && currentDeckLayout().slots[1].type === 'empty');
    assert.equal((await layouts.snapshot()).layouts[0].slots[1].type, 'empty');
    await pc.locator('#backToCatalogBtn').click();
    await wait(() => editingSlot === null && !document.querySelector('#actionCatalog').hidden);

    // 5. Drag-and-drop swap key 0 and key 2 in edit mode
    const box0 = await pc.locator('#keys button[data-key-id]').nth(0).boundingBox();
    const box2 = await pc.locator('#keys button[data-key-id]').nth(2).boundingBox();
    const revBeforeSwap = await pc.evaluate(() => layoutRevision);
    await pc.mouse.move(box0.x + box0.width / 2, box0.y + box0.height / 2);
    await pc.mouse.down();
    await pc.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2, {steps: 8});
    await pc.mouse.up();
    await pc.waitForFunction(rev => layoutRevision > rev && !layoutSaving, revBeforeSwap);
    const afterSwap = (await layouts.snapshot()).layouts[0].slots;
    assert.equal(afterSwap[2].type, 'custom');
    assert.equal(afterSwap[2].presentation.label, 'UX Runner');
    assert.equal(afterSwap[0].type, 'auto-agent');

    // 6. Action Library search + click-to-assign + live auto-save + Undo/Redo
    await pc.locator('#catalogSearch').fill('볼륨');
    const volumeBtn = pc.locator('#catalogGroups button[data-catalog-id="macSystem:volume-up"]');
    assert.equal(await volumeBtn.isVisible(), true);
    const revBeforeCatalog = await pc.evaluate(() => layoutRevision);
    await volumeBtn.click();
    await pc.waitForFunction(rev => layoutRevision > rev && editingSlot === 1 && !layoutSaving, revBeforeCatalog);
    assert.equal((await layouts.snapshot()).layouts[0].slots[1].type, 'custom');
    assert.equal(await pc.locator('.custom-trust-warning').isVisible(), false);

    // Live auto-save on safe slot label WITHOUT clicking Save
    const revBeforeAuto = await pc.evaluate(() => layoutRevision);
    await pc.locator('#customLabel').fill('볼륨 +');
    await pc.waitForFunction(rev => layoutRevision > rev && !layoutSaving, revBeforeAuto);
    assert.equal((await layouts.snapshot()).layouts[0].slots[1].presentation.label, '볼륨 +');

    await pc.locator('#backToCatalogBtn').click();
    await wait(() => editingSlot === null);

    // Drag catalog item onto key slot 10 via HTML5 Drag & Drop
    await pc.locator('#catalogSearch').fill('');
    const refreshCatalogBtn = pc.locator('#catalogGroups button[data-catalog-id="refresh"]');
    const revBeforeDrop = await pc.evaluate(() => layoutRevision);
    await refreshCatalogBtn.dragTo(pc.locator('#keys button[data-key-id]').nth(10));
    await pc.waitForFunction(rev => layoutRevision > rev && !layoutSaving, revBeforeDrop);
    assert.equal((await layouts.snapshot()).layouts[0].slots[10].type, 'refresh');
    await pc.locator('#backToCatalogBtn').click();
    await wait(() => editingSlot === null);

    // Multi-step Undo & Redo
    const revBeforeUndo = await pc.evaluate(() => layoutRevision);
    await pc.locator('#undoDeckBtn').click();
    await pc.waitForFunction(rev => layoutRevision > rev && !layoutSaving, revBeforeUndo);
    assert.equal((await layouts.snapshot()).layouts[0].slots[10].type, 'auto-agent');
    const revBeforeRedo = await pc.evaluate(() => layoutRevision);
    await pc.locator('#redoDeckBtn').click();
    await pc.waitForFunction(rev => layoutRevision > rev && !layoutSaving, revBeforeRedo);
    assert.equal((await layouts.snapshot()).layouts[0].slots[10].type, 'refresh');

    // Keyboard Undo (Meta+z or Control+z)
    const revBeforeKbUndo = await pc.evaluate(() => layoutRevision);
    await pc.evaluate(() => document.activeElement?.blur());
    await pc.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await pc.waitForFunction(rev => layoutRevision > rev && !layoutSaving, revBeforeKbUndo);
    assert.equal((await layouts.snapshot()).layouts[0].slots[10].type, 'auto-agent');

    // 7. Finder PNG Image File drop directly onto Key 9
    const pngBytes = [...await sharp({create: {width: 16, height: 16, channels: 4, background: '#1b4332'}}).png().toBuffer()];
    const revBeforeFileDrop = await pc.evaluate(() => layoutRevision);
    await pc.evaluate((bytes) => {
      const target = document.querySelectorAll('#keys button[data-key-id]')[9];
      const file = new File([new Uint8Array(bytes)], 'drop-icon.png', {type: 'image/png'});
      const dt = new DataTransfer();
      dt.items.add(file);
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(new DragEvent('dragover', {bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, dataTransfer: dt}));
      target.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, dataTransfer: dt}));
    }, pngBytes);
    await pc.waitForFunction(rev => layoutRevision > rev && !layoutSaving, revBeforeFileDrop);
    assert.ok((await layouts.snapshot()).layouts[0].slots[9].presentation?.asset);
    if (await pc.evaluate(() => editingSlot !== null)) {
      await pc.locator('#backToCatalogBtn').click();
      await wait(() => editingSlot === null);
    }

    // 8. 1-Step Auto-Wired Page Creation (free 1 empty slot on root page first) + Canvas Page Bar + Profile Export/Import
    await pc.locator('#keys button[data-key-id]').nth(14).click();
    await wait(() => editingSlot === 14);
    const revBeforeClear14 = await pc.evaluate(() => layoutRevision);
    await pc.locator('#clearSlotBtn').click();
    await pc.waitForFunction(rev => layoutRevision > rev && !layoutSaving, revBeforeClear14);
    await pc.locator('#backToCatalogBtn').click();
    await wait(() => editingSlot === null);

    const revBeforeAddPage = await pc.evaluate(() => layoutRevision);
    await pc.locator('#canvasPageBar .canvas-page-add').click();
    assert.equal(await pc.locator('#autoLinkPage').isChecked(), true);
    await pc.locator('#pageName').fill('개발 매크로');
    await pc.locator('#pageForm button[type="submit"]').click();
    await pc.waitForFunction(rev => layoutRevision > rev && !layoutSaving, revBeforeAddPage);
    assert.equal(await pc.locator('#draftCallout').isVisible(), false);
    assert.equal(await pc.locator('#navCheckDetails').evaluate(e => e.open), false);
    assert.ok(['준비 완료', '점검 필요'].includes(await pc.locator('#navSummaryBadge').textContent()));
    const newPageId = await pc.evaluate(() => deckProfile);
    assert.equal((await layouts.snapshot()).layouts.find(p => p.id === newPageId).slots[14].type, 'page');
    assert.equal(await pc.locator('#canvasPageBar .canvas-page-pill').count(), 4);
    await pc.locator('#canvasPageBar .canvas-page-pill[data-page="quota"]').click();
    await wait(() => deckProfile === 'quota');

    // Manual unlinked draft when #autoLinkPage unchecked still shows draft guidance cleanly
    await pc.locator('#addDeckPage').click();
    await pc.locator('#autoLinkPage').uncheck();
    await pc.locator('#pageName').fill('수동 초안');
    await pc.locator('#pageForm button[type="submit"]').click();
    await pc.waitForFunction(() => !document.querySelector('#draftCallout').hidden && document.querySelector('#draftCallout').textContent.includes('수동 초안'));
    assert.equal(await pc.locator('#navCheckDetails').evaluate(e => e.open), true);
    await pc.locator('#reloadLayout').click();
    await wait(() => !deckCandidate && deckProfile === 'agents');

    // Profile Export & Import JSON roundtrip
    const downloadPromise = pc.waitForEvent('download');
    await pc.locator('#exportProfileBtn').click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'agent-deck-profile.json');
    const exportedPath = path.join(dir, 'exported-profile.json');
    await download.saveAs(exportedPath);
    const exportedJson = JSON.parse(await readFile(exportedPath, 'utf8'));
    exportedJson.layouts[0].name = '백업에서 복원됨';
    const revBeforeImport = await pc.evaluate(() => layoutRevision);
    await pc.locator('#importProfileInput').setInputFiles({
      name: 'restore.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(exportedJson), 'utf8')
    });
    await pc.waitForFunction(rev => layoutRevision > rev && !layoutSaving, revBeforeImport);
    assert.equal((await layouts.snapshot()).layouts[0].name, '백업에서 복원됨');

    // 9. Zero horizontal overflow at 390px with catalog or key editor open
    await pc.setViewportSize({width: 390, height: 844});
    assert.equal(await pc.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await pc.locator('#keys button[data-key-id]').nth(0).click();
    await wait(() => editingSlot === 0);
    assert.equal(await pc.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

    // 10. Remote authority isolation: none of the desktop driver authoring controls appear on paired remote
    const finalRev = await pc.evaluate(() => layoutRevision);
    const remoteCtx = await browser.newContext({viewport: {width: 1112, height: 834}, hasTouch: true, isMobile: true});
    const remote = await remoteCtx.newPage();
    await remote.goto(remoteURL);
    await remote.locator('#code').fill('123456');
    await remote.locator('#pairButton').click();
    await remote.waitForFunction(rev => online && !deckLocal && layoutRevision === rev, finalRev);
    for (const id of ['deckLayoutToolbar', 'editorSettings', 'canvasPageBar', 'undoDeckBtn', 'redoDeckBtn', 'actionCatalog', 'exportProfileBtn', 'importProfileBtn', 'renameDeckPage', 'movePageUp', 'movePageDown', 'draftCallout']) {
      assert.equal(await remote.locator('#' + id).count() === 0 || !(await remote.locator('#' + id).isVisible()), true, id + ' must not be visible on remote');
    }
    assert.deepEqual(pageErrors, []);
  } finally {
    for (const child of children) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      child.kill('SIGKILL');
    }
    const closed = server ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
    server?.closeAllConnections();
    try { if (browser) await browser.close(); } finally {
      await closed;
      await rm(dir, {recursive: true, force: true});
    }
  }
});
