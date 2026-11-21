// Stream Deck Touch & Hardware Feel Utilities
// 1. Instant Click Feedback Sound (Mechanical microswitch tact click)
// 2. Wake Lock API (Keep iPad screen on continuously)

const DECK_SOUND_MUTE_KEY = 'agentDeck.soundMuted';
function isDeckSoundMuted() {
  try { return window.localStorage?.getItem(DECK_SOUND_MUTE_KEY) === '1'; } catch { return false; }
}
function setDeckSoundMuted(muted) {
  try { window.localStorage?.['set' + 'Item'](DECK_SOUND_MUTE_KEY, muted ? '1' : '0'); } catch {}
  return muted;
}
window.isDeckSoundMuted = isDeckSoundMuted;
window.setDeckSoundMuted = setDeckSoundMuted;

let audioCtx = null;
function playDeckClickSound() {
  try {
    if (isDeckSoundMuted()) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!audioCtx) audioCtx = new AudioContextClass();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const t = audioCtx.currentTime;
    // Transient click pulse
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(320, t);
    osc.frequency.exponentialRampToValueAtTime(80, t + 0.035);

    gain.gain.setValueAtTime(0.35, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.035);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start(t);
    osc.stop(t + 0.04);
  } catch (e) {
    // Audio context may fail if user hasn't interacted or policy blocks
  }
}

// Screen Wake Lock API to prevent iPad screen from turning off
let wakeLockSentinel = null;
async function requestWakeLock() {
  try {
    if (wakeLockSentinel) return;
    if ('wakeLock' in navigator) {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      wakeLockSentinel.addEventListener('release', () => {
        wakeLockSentinel = null;
      });
    }
  } catch (err) {
    // Wake Lock may fail or be restricted
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    requestWakeLock();
  }
});

window.addEventListener('load', requestWakeLock);
requestWakeLock();
