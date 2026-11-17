import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/deck/deck-input.js', import.meta.url), 'utf8');

function harness() {
  const listeners = () => ({
    handlers: new Map(),
    addEventListener(type, callback, capture) {
      const list = this.handlers.get(type) || [];
      list.push({ callback, capture });
      this.handlers.set(type, list);
    },
    emit(type, event = {}) {
      for (const { callback } of this.handlers.get(type) || []) callback(event);
    },
  });
  const document = { ...listeners(), visibilityState: 'visible' };
  let sounds = 0;
  const window = { ...listeners(), playDeckClickSound() { sounds++; } };
  const timers = new Map();
  let nextTimer = 0;
  vm.runInNewContext(source, {
    document, window,
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  const makeKey = () => {
    const classes = new Set();
    const key = {
      isConnected: true, disabled: false, classes, captures: [], releases: [],
      classList: { add(value) { classes.add(value); }, remove(value) { classes.delete(value); } },
      getBoundingClientRect() { return { left: 10, right: 110, top: 20, bottom: 120 }; },
      setPointerCapture(id) { this.captures.push(id); },
      releasePointerCapture(id) { this.releases.push(id); },
    };
    const state = { context: 'profile:page:key', calls: 0 };
    window.bindDeckInput(key, () => { state.calls++; }, () => state.context);
    return { key, state };
  };
  const first = makeKey();
  const emit = (type, changes = {}) => {
    const event = {
      target: first.key, pointerId: 1, pointerType: 'touch', isPrimary: true,
      button: 0, clientX: 50, clientY: 60, detail: 1,
      prevented: false, stopped: false,
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; },
      ...changes,
    };
    document.emit(type, event);
    return event;
  };
  return { document, window, timers, makeKey, emit, ...first, sounds: () => sounds };
}

function assertClear(h) {
  assert.equal(h.key.classes.has('pressed'), false);
  assert.equal(h.timers.size, 0);
}

test('browser exposes exactly two functions and binding is idempotent', () => {
  const h = harness();
  assert.equal(typeof h.window.bindDeckInput, 'function');
  assert.equal(typeof h.window.cancelDeckInput, 'function');
  h.window.bindDeckInput(h.key, () => assert.fail('duplicate binding'), () => 'other');
  h.emit('pointerdown');
  assert.equal(h.state.calls, 0);
  assert.equal(h.sounds(), 1);
  assert.equal(h.key.classes.has('pressed'), true);
  assert.deepEqual(h.key.captures, [1]);
  assert.equal([...h.timers.values()][0].delay, 30000);
  h.emit('pointerup');
  h.emit('pointerup');
  assert.equal(h.state.calls, 1);
  assertClear(h);
  assert.deepEqual(h.key.releases, [1]);
});

test('consume ownership and clear feedback before invoking activation', () => {
  const h = harness();
  const key = h.makeKey().key;
  const other = h.makeKey();
  let calls = 0;
  const fresh = { ...key };
  h.window.bindDeckInput(fresh, () => {
    calls++;
    assert.equal(fresh.classes.has('pressed'), false);
    assert.equal(h.timers.size, 0);
    h.emit('pointerup', { target: fresh });
    h.emit('pointerdown', { target: other.key, pointerId: 2 });
  }, () => 'valid');
  h.emit('pointerdown', { target: fresh });
  h.emit('pointerup', { target: fresh });
  assert.equal(calls, 1);
  assert.equal(other.key.classes.has('pressed'), true);
  h.window.cancelDeckInput();
});

test('explicit cancel clears feedback and compatibility clicks never revive it', () => {
  const h = harness();
  h.emit('pointerdown');
  h.window.cancelDeckInput();
  h.window.cancelDeckInput();
  h.emit('pointerup');
  for (const changes of [{}, { pointerType: '', pointerId: undefined }, { detail: 0 }]) {
    const click = h.emit('click', changes);
    assert.equal(click.prevented, true);
    assert.equal(click.stopped, true);
  }
  assert.equal(h.state.calls, 0);
  assertClear(h);
});

test('completed pointer compatibility click cannot double-dispatch', () => {
  const h = harness();
  h.emit('pointerdown');
  h.emit('pointerup');
  h.emit('click');
  h.emit('click', { pointerType: 'mouse', pointerId: 0, detail: 0 });
  assert.equal(h.state.calls, 1);
  assert.equal(h.sounds(), 1);
});

for (const scenario of ['outside move', 'outside release', 'wrong pointer', 'second pointer', 'duplicate down', 'cancel', 'lost capture']) {
  test(`${scenario} cancels with zero dispatch`, () => {
    const h = harness();
    h.emit('pointerdown');
    if (scenario === 'outside move') {
      h.emit('pointermove', { clientX: 111 });
      h.emit('pointermove');
    }
    if (scenario === 'outside release') h.emit('pointerup', { clientY: 121 });
    if (scenario === 'wrong pointer') h.emit('pointerup', { pointerId: 2 });
    if (scenario === 'second pointer') h.emit('pointerdown', { target: {}, pointerId: 2, isPrimary: false });
    if (scenario === 'duplicate down') h.emit('pointerdown');
    if (scenario === 'cancel') h.emit('pointercancel');
    if (scenario === 'lost capture') h.emit('lostpointercapture');
    h.emit('pointerup');
    h.emit('click');
    assert.equal(h.state.calls, 0);
    assertClear(h);
  });
}

test('global ownership cancels across keys without arming the extra pointer', () => {
  const h = harness();
  const second = h.makeKey();
  h.emit('pointerdown');
  h.emit('pointerdown', { target: second.key, pointerId: 2 });
  h.emit('pointerup');
  h.emit('pointerup', { target: second.key, pointerId: 2 });
  assert.equal(h.state.calls + second.state.calls, 0);
  assert.equal(second.key.classes.has('pressed'), false);
  assertClear(h);
});

for (const change of ['context', 'null', 'disabled', 'removed']) {
  test(`${change} invalidates the original gesture`, () => {
    const h = harness();
    h.emit('pointerdown');
    if (change === 'context') h.state.context = 'different';
    if (change === 'null') h.state.context = null;
    if (change === 'disabled') h.key.disabled = true;
    if (change === 'removed') h.key.isConnected = false;
    h.emit('pointerup');
    assert.equal(h.state.calls, 0);
    assertClear(h);
  });
}

test('rect is captured on down, including when release is retargeted by capture', () => {
  const h = harness();
  h.emit('pointerdown');
  h.key.getBoundingClientRect = () => ({ left: 200, right: 300, top: 200, bottom: 300 });
  h.emit('pointerup', { target: {}, clientX: 110, clientY: 120 });
  assert.equal(h.state.calls, 1);
  assertClear(h);
});

for (const reason of ['timeout', 'blur', 'pagehide', 'offline', 'hidden']) {
  test(`${reason} cancels ownership`, () => {
    const h = harness();
    h.emit('pointerdown');
    if (reason === 'timeout') [...h.timers.values()][0].callback();
    else if (reason === 'hidden') {
      h.document.visibilityState = 'hidden';
      h.document.emit('visibilitychange');
    } else h.window.emit(reason);
    h.emit('pointerup');
    h.emit('click');
    assert.equal(h.state.calls, 0);
    assertClear(h);
  });
}

test('only primary left pointer can arm; ineligible keys send nothing', () => {
  for (const changes of [{ isPrimary: false }, { button: 1 }, { button: 2 }]) {
    const h = harness();
    h.emit('pointerdown', changes);
    h.emit('pointerup');
    assert.equal(h.state.calls, 0);
    assert.equal(h.sounds(), 0);
    assertClear(h);
  }
  for (const value of [null, undefined, {}, 1]) {
    const h = harness();
    h.state.context = value;
    h.emit('pointerdown');
    h.emit('pointerup');
    assert.equal(h.state.calls, 0);
    assertClear(h);
  }
});

test('keyboard and assistive clicks work immediately after cancellation without a suppression timer', () => {
  const h = harness();
  h.emit('pointerdown');
  h.window.cancelDeckInput();
  h.emit('click', { detail: 0, pointerType: undefined, pointerId: undefined });
  h.emit('click', { detail: 0, pointerType: '', pointerId: -1 });
  assert.equal(h.state.calls, 2);
  assert.equal(h.sounds(), 3);
  h.state.context = null;
  h.emit('click', { detail: 0, pointerType: undefined, pointerId: undefined });
  assert.equal(h.state.calls, 2);
  assertClear(h);
});

test('keyboard consumes a pending pointer, and feedback/capture failures do not block activation', () => {
  const h = harness();
  h.window.playDeckClickSound = () => { throw new Error('audio unavailable'); };
  h.key.setPointerCapture = () => { throw new Error('capture unavailable'); };
  h.key.releasePointerCapture = () => { throw new Error('capture unavailable'); };
  h.emit('pointerdown');
  h.emit('click', { detail: 0, pointerType: undefined, pointerId: undefined });
  h.emit('pointerup');
  assert.equal(h.state.calls, 1);
  assertClear(h);
});

test('context exceptions fail closed on both pointer and keyboard input', () => {
  const h = harness();
  const key = h.makeKey().key;
  const fresh = { ...key };
  h.window.bindDeckInput(fresh, () => assert.fail('ineligible'), () => { throw new Error('replaced'); });
  h.emit('pointerdown', { target: fresh });
  h.emit('pointerup', { target: fresh });
  h.emit('click', { target: fresh, detail: 0, pointerType: undefined, pointerId: undefined });
  assert.equal(h.timers.size, 0);
});

test('repeated activation keydowns suppress native repeat without dispatching on keydown', () => {
  const h = harness();
  for (const key of ['Enter', ' ']) {
    const initial = h.emit('keydown', { key, repeat: false });
    assert.equal(initial.prevented, false);
    const repeated = h.emit('keydown', { key, repeat: true });
    assert.equal(repeated.prevented, true);
    assert.equal(repeated.stopped, true);
  }
  assert.equal(h.state.calls, 0);
  assert.equal(h.sounds(), 0);
});

test('haptics retains audio and wake lock without independent touch/click paths', async () => {
  const haptics = await fs.readFile(new URL('../src/deck/streamdeck-haptics.js', import.meta.url), 'utf8');
  assert.match(haptics, /function playDeckClickSound\(/);
  assert.match(haptics, /navigator\.wakeLock\.request\('screen'\)/);
  assert.doesNotMatch(haptics, /addEventListener\(['"](?:touchstart|touchend|touchcancel|click)['"]/);
  assert.doesNotMatch(haptics, /classList\.(?:add|remove)\('pressed'\)/);
});
