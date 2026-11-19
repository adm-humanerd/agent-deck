import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const defaultExec = promisify(execFile);

export const MAC_SYSTEM_CATALOG = Object.freeze([
  Object.freeze({action: 'volume-up', name: '볼륨 올리기', detail: '음량 +10%', symbol: 'volume-up'}),
  Object.freeze({action: 'volume-down', name: '볼륨 내리기', detail: '음량 -10%', symbol: 'volume-down'}),
  Object.freeze({action: 'volume-mute', name: '음소거 전환', detail: '오디오 음소거', symbol: 'volume-mute'}),
  Object.freeze({action: 'media-play-pause', name: '재생 / 일시정지', detail: '미디어 제어', symbol: 'media-play'}),
  Object.freeze({action: 'media-next', name: '다음 트랙', detail: '미디어 제어', symbol: 'media-next'}),
  Object.freeze({action: 'media-prev', name: '이전 트랙', detail: '미디어 제어', symbol: 'media-prev'}),
  Object.freeze({action: 'dark-mode', name: '다크 모드 전환', detail: '화면 스타일', symbol: 'dark-mode'}),
  Object.freeze({action: 'screenshot', name: '영역 스크린샷', detail: '클립보드 복사', symbol: 'screenshot'}),
  Object.freeze({action: 'screen-lock', name: '화면 잠금', detail: '디스플레이 끄기', symbol: 'lock'}),
  Object.freeze({action: 'mission-control', name: '미션 컨트롤', detail: '창 한눈에 보기', symbol: 'app'}),
  Object.freeze({action: 'finder', name: 'Finder 열기', detail: '파일 관리자', symbol: 'folder'}),
  Object.freeze({action: 'downloads', name: '다운로드 폴더', detail: 'Finder 열기', symbol: 'folder'})
]);

export const MAC_SYSTEM_ACTIONS = Object.freeze(MAC_SYSTEM_CATALOG.map(item => item.action));

export const MAC_HOTKEY_PRESETS = Object.freeze([
  Object.freeze({key: 'c', modifiers: Object.freeze(['cmd']), label: '복사 (⌘C)'}),
  Object.freeze({key: 'v', modifiers: Object.freeze(['cmd']), label: '붙여넣기 (⌘V)'}),
  Object.freeze({key: 'z', modifiers: Object.freeze(['cmd']), label: '실행 취소 (⌘Z)'}),
  Object.freeze({key: 'z', modifiers: Object.freeze(['cmd', 'shift']), label: '다시 실행 (⌘⇧Z)'}),
  Object.freeze({key: '4', modifiers: Object.freeze(['cmd', 'shift']), label: '영역 캡처 (⌘⇧4)'}),
  Object.freeze({key: '5', modifiers: Object.freeze(['cmd', 'shift']), label: '화면 캡처 도구 (⌘⇧5)'}),
  Object.freeze({key: 'space', modifiers: Object.freeze(['cmd']), label: 'Spotlight 검색 (⌘Space)'}),
  Object.freeze({key: 'w', modifiers: Object.freeze(['cmd']), label: '창/탭 닫기 (⌘W)'}),
  Object.freeze({key: 't', modifiers: Object.freeze(['cmd']), label: '새 탭 (⌘T)'}),
  Object.freeze({key: 'a', modifiers: Object.freeze(['cmd', 'shift']), label: '회의 음소거 토글 (⌘⇧A)'})
]);

export const MAC_APP_URL_PRESETS = Object.freeze([
  Object.freeze({url: 'raycast://', label: 'Raycast 열기'}),
  Object.freeze({url: 'obsidian://open', label: 'Obsidian 열기'}),
  Object.freeze({url: 'slack://open', label: 'Slack 열기'}),
  Object.freeze({url: 'vscode://', label: 'VS Code 열기'}),
  Object.freeze({url: 'notion://', label: 'Notion 열기'}),
  Object.freeze({url: 'shortcuts://', label: '단축어 앱 열기'}),
  Object.freeze({url: 'spotify://', label: 'Spotify 열기'}),
  Object.freeze({url: 'x-apple.systempreferences:', label: '시스템 설정 열기'})
]);

export const MAC_SPECIAL_KEY_CODES = Object.freeze({
  space: 49,
  tab: 48,
  enter: 36,
  esc: 53,
  delete: 51,
  up: 126,
  down: 125,
  left: 123,
  right: 124,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111
});

export const MAC_MODIFIER_NAMES = Object.freeze({
  cmd: 'command down',
  shift: 'shift down',
  alt: 'option down',
  ctrl: 'control down'
});

export const MAC_MODIFIER_KEYS = Object.freeze(['cmd', 'shift', 'alt', 'ctrl']);

/** Validate allowed single lowercase alphanumeric or named special keys for System Events. */
export function isValidMacHotkeyKey(key) {
  return typeof key === 'string' && (/^[a-z0-9]$/.test(key) || Object.hasOwn(MAC_SPECIAL_KEY_CODES, key));
}

/** Build an injection-free AppleScript expression for System Events key dispatch. */
export function buildMacHotkeyScript(key, modifiers = []) {
  if (!isValidMacHotkeyKey(key)) throw new TypeError('Invalid macOS hotkey key');
  if (!Array.isArray(modifiers) || modifiers.length > MAC_MODIFIER_KEYS.length || new Set(modifiers).size !== modifiers.length || modifiers.some(m => typeof m !== 'string' || !MAC_MODIFIER_KEYS.includes(m))) {
    throw new TypeError('Invalid macOS hotkey modifiers');
  }
  const mods = modifiers.map(m => MAC_MODIFIER_NAMES[m]);
  const usingClause = mods.length ? ` using {${mods.join(', ')}}` : '';
  const keyExpr = Object.hasOwn(MAC_SPECIAL_KEY_CODES, key)
    ? `key code ${MAC_SPECIAL_KEY_CODES[key]}${usingClause}`
    : `keystroke "${key}"${usingClause}`;
  return `tell application "System Events" to ${keyExpr}`;
}

/** Resolve fixed argv command descriptors for preset macOS system and media actions. */
export function resolveMacSystemCommand(action, env = process.env) {
  switch (action) {
    case 'volume-up':
      return {command: '/usr/bin/osascript', args: ['-e', 'set volume output volume ((output volume of (get volume settings)) + 10)'], handoff: false};
    case 'volume-down':
      return {command: '/usr/bin/osascript', args: ['-e', 'set volume output volume ((output volume of (get volume settings)) - 10)'], handoff: false};
    case 'volume-mute':
      return {command: '/usr/bin/osascript', args: ['-e', 'set volume output muted (not (output muted of (get volume settings)))'], handoff: false};
    case 'media-play-pause':
      return {command: '/usr/bin/osascript', args: ['-e', 'if application "Spotify" is running then\ntell application "Spotify" to playpause\nelse if application "Music" is running then\ntell application "Music" to playpause\nelse\nerror "실행 중인 음악 앱(Music/Spotify)이 없습니다."\nend if'], handoff: false};
    case 'media-next':
      return {command: '/usr/bin/osascript', args: ['-e', 'if application "Spotify" is running then\ntell application "Spotify" to next track\nelse if application "Music" is running then\ntell application "Music" to next track\nelse\nerror "실행 중인 음악 앱(Music/Spotify)이 없습니다."\nend if'], handoff: false};
    case 'media-prev':
      return {command: '/usr/bin/osascript', args: ['-e', 'if application "Spotify" is running then\ntell application "Spotify" to previous track\nelse if application "Music" is running then\ntell application "Music" to previous track\nelse\nerror "실행 중인 음악 앱(Music/Spotify)이 없습니다."\nend if'], handoff: false};
    case 'dark-mode':
      return {command: '/usr/bin/osascript', args: ['-e', 'tell application "System Events" to tell appearance preferences to set dark mode to not dark mode'], handoff: false};
    case 'screenshot':
      return {command: '/usr/sbin/screencapture', args: ['-i', '-c'], handoff: false};
    case 'screen-lock':
      return {command: '/usr/bin/pmset', args: ['displaysleepnow'], handoff: false};
    case 'mission-control':
      return {command: '/usr/bin/open', args: ['-a', '/System/Applications/Mission Control.app'], handoff: true};
    case 'finder':
      return {command: '/usr/bin/open', args: ['-a', 'Finder'], handoff: true};
    case 'downloads': {
      const homeDir = env?.HOME;
      if (typeof homeDir !== 'string' || !path.posix.isAbsolute(homeDir)) return null;
      return {command: '/usr/bin/open', args: [path.posix.join(homeDir, 'Downloads')], handoff: true};
    }
    default:
      return null;
  }
}

const httpError = (status, message) => Object.assign(new Error(message), {status});

/** Create a host-only macOS app, Shortcut, and .icns PNG extractor service. */
export function createMacCatalog(options = {}) {
  const platform = options.platform ?? process.platform;
  const fs = options.fs || fsPromises;
  const execFileImpl = options.execFileImpl || defaultExec;
  const homeDir = options.homeDir ?? (process.env.HOME || os.homedir());
  const appDirs = options.appDirs || [
    '/Applications',
    '/System/Applications',
    '/System/Applications/Utilities',
    ...(homeDir ? [path.join(homeDir, 'Applications')] : [])
  ];
  const coreApps = options.coreApps || ['/System/Library/CoreServices/Finder.app'];
  const cacheTtlMs = options.cacheTtlMs ?? 30000;
  const tempDir = options.tempDir || os.tmpdir();
  const now = options.now || Date.now;

  let cachedCatalog = null;
  let cachedAt = 0;
  let catalogInFlight = null;

  async function runExec(file, args, opts = {}) {
    const res = await execFileImpl(file, args, {timeout: 10000, maxBuffer: 2 * 1024 * 1024, ...opts});
    return typeof res === 'string' ? res : (res?.stdout ?? '');
  }

  async function scanApps() {
    const found = new Map();

    async function scanDir(dir, depth) {
      let entries;
      try {
        entries = await fs.readdir(dir, {withFileTypes: true});
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry?.name || entry.name.startsWith('.') || entry.name === '__MACOSX') continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.name.endsWith('.app')) {
          if (entry.isDirectory() || entry.isSymbolicLink()) {
            found.set(fullPath, {app: fullPath, name: entry.name.slice(0, -4)});
          }
        } else if (depth === 0 && entry.isDirectory()) {
          await scanDir(fullPath, 1);
        }
      }
    }

    for (const dir of appDirs) {
      await scanDir(dir, 0);
    }

    for (const corePath of coreApps) {
      if (typeof corePath !== 'string' || !corePath.endsWith('.app')) continue;
      try {
        const st = await fs.stat(corePath);
        if (st.isDirectory()) {
          found.set(corePath, {app: corePath, name: path.basename(corePath, '.app')});
        }
      } catch {
        // Core app may be absent in minimal test fixtures.
      }
    }

    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }

  async function scanShortcuts() {
    try {
      const out = await runExec('/usr/bin/shortcuts', ['list'], {timeout: 5000});
      const seen = new Set();
      const list = [];
      for (const raw of String(out || '').split(/\r?\n/)) {
        const name = raw.trim();
        if (name && !seen.has(name)) {
          seen.add(name);
          list.push(name);
        }
      }
      return list;
    } catch {
      return [];
    }
  }

  async function getCatalog({force = false} = {}) {
    if (platform !== 'darwin') {
      return {
        ok: true,
        supported: false,
        apps: [],
        shortcuts: [],
        systemControls: MAC_SYSTEM_CATALOG,
        hotkeyPresets: MAC_HOTKEY_PRESETS,
        appUrlPresets: MAC_APP_URL_PRESETS,
        updated: new Date(now()).toISOString()
      };
    }
    if (!force && cachedCatalog && now() - cachedAt < cacheTtlMs) {
      return cachedCatalog;
    }
    if (!force && catalogInFlight) {
      return catalogInFlight;
    }
    catalogInFlight = (async () => {
      const [apps, shortcuts] = await Promise.all([scanApps(), scanShortcuts()]);
      cachedCatalog = {
        ok: true,
        supported: true,
        apps,
        shortcuts,
        systemControls: MAC_SYSTEM_CATALOG,
        hotkeyPresets: MAC_HOTKEY_PRESETS,
        appUrlPresets: MAC_APP_URL_PRESETS,
        updated: new Date(now()).toISOString()
      };
      cachedAt = now();
      return cachedCatalog;
    })().finally(() => {
      catalogInFlight = null;
    });
    return catalogInFlight;
  }

  async function fileExists(targetPath) {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  async function resolveIcnsPath(appPath) {
    const resourcesDir = path.join(appPath, 'Contents', 'Resources');
    const infoPlist = path.join(appPath, 'Contents', 'Info.plist');

    for (const key of ['CFBundleIconFile', 'CFBundleIconName']) {
      let raw = '';
      try {
        raw = (await runExec('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', infoPlist], {timeout: 3000})).trim();
      } catch {
        continue;
      }
      if (!raw) continue;
      const filename = raw.endsWith('.icns') ? raw : `${raw}.icns`;
      if (filename.includes('/') || filename.includes('\\') || filename.includes('..') || path.basename(filename) !== filename) {
        throw httpError(400, '잘못된 앱 아이콘 경로입니다.');
      }
      const candidate = path.join(resourcesDir, filename);
      if (await fileExists(candidate)) return candidate;
    }

    const appIcon = path.join(resourcesDir, 'AppIcon.icns');
    if (await fileExists(appIcon)) return appIcon;

    try {
      const files = await fs.readdir(resourcesDir);
      const icns = files.find(name => typeof name === 'string' && name.toLowerCase().endsWith('.icns') && path.basename(name) === name && !name.includes('..'));
      if (icns) return path.join(resourcesDir, icns);
    } catch {
      // Resources directory missing
    }
    throw httpError(404, '앱 아이콘 파일을 찾을 수 없습니다.');
  }

  async function extractAppIconPng(appPath) {
    if (platform !== 'darwin') {
      throw httpError(400, 'macOS에서만 앱 아이콘을 추출할 수 있습니다.');
    }
    if (typeof appPath !== 'string' || !appPath.trim()) {
      throw httpError(400, '유효한 앱 경로가 필요합니다.');
    }
    let catalog = await getCatalog();
    let matched = catalog.apps.find(item => item.app === appPath);
    if (!matched) {
      catalog = await getCatalog({force: true});
      matched = catalog.apps.find(item => item.app === appPath);
    }
    if (!matched) {
      throw httpError(404, '설치된 앱 목록에서 찾을 수 없습니다.');
    }

    const icnsPath = await resolveIcnsPath(matched.app);
    const dir = await fs.mkdtemp(path.join(tempDir, 'deck-mac-icon-'));
    try {
      const outPath = path.join(dir, 'icon.png');
      try {
        await runExec('/usr/bin/sips', ['-s', 'format', 'png', '-z', '128', '128', icnsPath, '--out', outPath], {timeout: 10000});
      } catch {
        throw httpError(422, '앱 아이콘을 PNG로 변환하지 못했습니다.');
      }
      const bytes = await fs.readFile(outPath);
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        throw httpError(500, '앱 아이콘 변환 결과가 비어 있습니다.');
      }
      return bytes;
    } finally {
      await fs.rm(dir, {recursive: true, force: true}).catch(() => {});
    }
  }

  return {getCatalog, extractAppIconPng};
}
