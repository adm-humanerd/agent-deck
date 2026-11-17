import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tools = {
  herdr: {env: 'AGENT_DECK_HERDR', name: 'herdr'},
  reasonNetwork: {env: 'AGENT_DECK_REASON_NETWORK', name: 'reason-network'},
  nativeHerdr: {env: 'AGENT_DECK_NATIVE_HERDR'},
  hc: {env: 'AGENT_DECK_HC', name: 'hc'},
};

// Overrides are executable paths, never command lines. An invalid override disables
// that integration rather than silently selecting a different executable.
export async function discoverHostTools({env = process.env, platform = process.platform, home = os.homedir(), fsOps = fs} = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const get = name => platform === 'win32'
    ? Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1]
    : env[name];
  const extensions = platform === 'win32'
    ? (get('PATHEXT') || '.EXE;.COM').split(';').filter(ext => /^\.(exe|com)$/i.test(ext))
    : [''];
  const absolute = value => typeof value === 'string' && p.isAbsolute(value)
    && (platform !== 'win32' || /^[a-z]:[\\/]|^\\\\[^\\]+\\[^\\]+/i.test(value));
  async function executable(candidate) {
    if (!candidate || !absolute(candidate) || /[\0\r\n]/.test(candidate)) return false;
    // Batch scripts require a command interpreter, which is not this API's contract.
    if (platform === 'win32' && !/\.(exe|com)$/i.test(candidate)) return false;
    try {
      if (!(await fsOps.stat(candidate)).isFile()) return false;
      await fsOps.access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
      return true;
    } catch { return false; }
  }
  const dirs = (get('PATH') || '').split(platform === 'win32' ? ';' : ':')
    .map(dir => dir.replace(/^"(.*)"$/, '$1')).filter(absolute);
  if (platform === 'darwin') dirs.push(p.join(home, '.local/bin'), p.join(home, '.reason/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin');
  if (platform === 'win32') {
    for (const base of [get('LOCALAPPDATA'), get('ProgramFiles'), get('ProgramFiles(x86)')].filter(Boolean)) {
      dirs.push(p.join(base, 'Herdr'), p.join(base, 'Herdr', 'bin'), p.join(base, 'Reason', 'bin'));
    }
  }
  const result = {};
  for (const [key, tool] of Object.entries(tools)) {
    const override = get(tool.env);
    if (override !== undefined) {
      result[key] = await executable(override) ? override : null;
      continue;
    }
    const candidates = [];
    if (key === 'nativeHerdr') {
      // Herdr and herdr are the same basename on case-insensitive filesystems.
      // PATH therefore cannot distinguish the native app from the CLI adapter.
      if (platform === 'darwin') candidates.push('/Applications/Herdr.app/Contents/MacOS/Herdr', p.join(home, 'Applications/Herdr.app/Contents/MacOS/Herdr'));
      if (platform === 'win32') {
        for (const base of [get('LOCALAPPDATA'), get('ProgramFiles'), get('ProgramFiles(x86)')].filter(absolute)) {
          candidates.push(p.join(base, 'Herdr', 'Herdr.exe'));
        }
      }
    } else {
      for (const dir of new Set(dirs)) for (const ext of extensions) candidates.push(p.join(dir, tool.name + ext));
    }
    result[key] = null;
    for (const candidate of candidates) {
      if (await executable(candidate)) { result[key] = candidate; break; }
    }
  }
  return result;
}
