// One release-to-activate owner for all deck keys. No dispatch happens on down.
(() => {
  const bindings = new WeakMap();
  let owner = null;

  function snapshot(binding) {
    if (!binding.button.isConnected || binding.button.disabled) return null;
    try {
      const value = binding.context();
      return typeof value === 'string' ? value : null;
    } catch (_) {
      return null;
    }
  }

  function sound() {
    try {
      const result = window.playDeckClickSound?.();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (_) {
      // Feedback must never prevent or dispatch an action.
    }
  }

  function cancelDeckInput() {
    const previous = owner;
    owner = null;
    if (!previous) return;
    clearTimeout(previous.timer);
    previous.binding.button.classList.remove('pressed');
    try {
      previous.binding.button.releasePointerCapture(previous.pointerId);
    } catch (_) {
      // Document listeners also cover unsupported or already-lost capture.
    }
  }

  function bindingFor(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    for (const node of path) {
      if (bindings.has(node)) return bindings.get(node);
    }
    for (let node = event.target; node; node = node.parentNode) {
      if (bindings.has(node)) return bindings.get(node);
    }
    return null;
  }

  function inside(event, rect) {
    return event.clientX >= rect.left && event.clientX <= rect.right &&
      event.clientY >= rect.top && event.clientY <= rect.bottom;
  }

  document.addEventListener('pointerdown', (event) => {
    if (owner) {
      // Even an extra pointer outside the deck invalidates the current gesture.
      cancelDeckInput();
      return;
    }
    const binding = bindingFor(event);
    if (!binding || event.isPrimary !== true || event.button !== 0) return;
    const context = snapshot(binding);
    if (context === null) return;
    const bounds = binding.button.getBoundingClientRect();
    const rect = { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
    if (!inside(event, rect)) return;
    owner = { binding, pointerId: event.pointerId, context, rect, timer: null };
    owner.timer = setTimeout(cancelDeckInput, 30000);
    binding.button.classList.add('pressed');
    try {
      binding.button.setPointerCapture(event.pointerId);
    } catch (_) {
      // Capture is optional: document capture listeners remain authoritative.
    }
    sound();
  }, true);

  document.addEventListener('pointermove', (event) => {
    if (!owner || event.pointerId !== owner.pointerId) return;
    if (!inside(event, owner.rect) || snapshot(owner.binding) !== owner.context) cancelDeckInput();
  }, true);

  document.addEventListener('pointerup', (event) => {
    if (!owner) return;
    const previous = owner;
    const valid = event.pointerId === previous.pointerId && inside(event, previous.rect) &&
      snapshot(previous.binding) === previous.context;
    cancelDeckInput();
    if (valid) previous.binding.activate();
  }, true);

  for (const type of ['pointercancel', 'lostpointercapture']) {
    document.addEventListener(type, (event) => {
      if (owner && event.pointerId === owner.pointerId) cancelDeckInput();
    }, true);
  }

  document.addEventListener('keydown', (event) => {
    if (event.repeat && (event.key === 'Enter' || event.key === ' ') && bindingFor(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  document.addEventListener('click', (event) => {
    const binding = bindingFor(event);
    if (!binding) return;
    // Pointer compatibility clicks are never an activation path, including after
    // cancellation. Keyboard/assistive clicks have no physical pointer identity.
    event.preventDefault();
    event.stopImmediatePropagation();
    const hasPointer = Boolean(event.pointerType) ||
      (Number.isFinite(event.pointerId) && event.pointerId >= 0);
    if (event.detail !== 0 || hasPointer) return;
    cancelDeckInput();
    if (snapshot(binding) === null) return;
    sound();
    binding.activate();
  }, true);

  for (const type of ['blur', 'pagehide', 'offline']) {
    window.addEventListener(type, cancelDeckInput);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') cancelDeckInput();
  });

  window.bindDeckInput = function bindDeckInput(button, activate, context) {
    if (!bindings.has(button)) bindings.set(button, { button, activate, context });
  };
  window.cancelDeckInput = cancelDeckInput;
})();
