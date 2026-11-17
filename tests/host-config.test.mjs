import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {discoverHostTools} from '../src/host/host-config.mjs';

const missing = {herdr: null, reasonNetwork: null, nativeHerdr: null, hc: null};
function files(paths) {
  return {
    async stat(candidate) { if (!paths.includes(candidate)) throw Object.assign(new Error('missing'), {code: 'ENOENT'}); return {isFile: () => true}; },
    async access(candidate) { if (!paths.includes(candidate)) throw new Error('missing'); },
  };
}

test('native app discovery never aliases a case-insensitive CLI PATH lookup', async () => {
  for (const [platform, dir, executable] of [
    ['darwin', '/fixture/bin', '/fixture/bin/herdr'],
    ['win32', 'C:\\fixture\\bin', 'C:\\fixture\\bin\\herdr.EXE'],
  ]) {
    const fsOps = {
      async stat(candidate) { if (candidate.toLowerCase() !== executable.toLowerCase()) throw new Error('missing'); return {isFile: () => true}; },
      async access() {},
    };
    const result = await discoverHostTools({platform, env: {PATH: dir}, home: platform === 'darwin' ? '/fixture/home' : 'C:\\fixture\\home', fsOps});
    assert.deepEqual(result, {...missing, herdr: executable});
  }
});

test('PATH resolves absolute executable files, never current directory or command lines', {skip: process.platform === 'win32' && 'POSIX executable permission check'}, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'deck tools '));
  try {
    const executable = path.join(temp, 'herdr');
    await fs.writeFile(executable, '#!/bin/sh\nexit 0\n', {mode: 0o700});
    await fs.mkdir(path.join(temp, 'hc'));
    const nonExecutable = path.join(temp, 'reason-network');
    await fs.writeFile(nonExecutable, 'not executable', {mode: 0o600});
    const actual = await discoverHostTools({env: {PATH: `:relative:${temp}`}, platform: 'linux', home: temp});
    assert.deepEqual(actual, {...missing, herdr: executable});
    assert.deepEqual(await discoverHostTools({env: {PATH: '', AGENT_DECK_HERDR: 'herdr --flag'}, platform: 'linux'}), missing);
  } finally { await fs.rm(temp, {recursive: true, force: true}); }
});

test('explicit configured executables take precedence; invalid overrides do not fall back', async () => {
  const candidates = ['/custom/한글 & tools/herdr', '/bin/herdr', '/bin/hc'];
  const actual = await discoverHostTools({platform: 'darwin', home: '/home/test', env: {PATH: '/bin', AGENT_DECK_HERDR: candidates[0], AGENT_DECK_HC: '/missing/hc'}, fsOps: files(candidates)});
  assert.deepEqual(actual, {...missing, herdr: candidates[0]});
});

test('all integration overrides are independent and return only the documented keys', async () => {
  const env = {PATH: '', AGENT_DECK_HERDR: '/x/herdr', AGENT_DECK_REASON_NETWORK: '/x/network', AGENT_DECK_NATIVE_HERDR: '/x/native', AGENT_DECK_HC: '/x/hc'};
  assert.deepEqual(await discoverHostTools({platform: 'linux', env, fsOps: files(Object.values(env))}), {herdr: '/x/herdr', reasonNetwork: '/x/network', nativeHerdr: '/x/native', hc: '/x/hc'});
});

test('macOS standard installation locations use the supplied home, never a personal hardcoded home', async () => {
  const actual = await discoverHostTools({platform: 'darwin', env: {}, home: '/Users/fixture', fsOps: files(['/opt/homebrew/bin/herdr', '/Users/fixture/.reason/bin/reason-network', '/Applications/Herdr.app/Contents/MacOS/Herdr', '/Users/fixture/.local/bin/hc'])});
  assert.deepEqual(actual, {herdr: '/opt/homebrew/bin/herdr', reasonNetwork: '/Users/fixture/.reason/bin/reason-network', nativeHerdr: '/Applications/Herdr.app/Contents/MacOS/Herdr', hc: '/Users/fixture/.local/bin/hc'});
});

test('Windows handles PATH casing, quoted Unicode directories and PATHEXT without executing batch files', async () => {
  const dir = 'C:\\工具 & apps';
  const actual = await discoverHostTools({platform: 'win32', home: 'C:\\Users\\fixture', env: {Path: `.;relative;"${dir}"`, PATHEXT: '.BAT;.CMD;.EXE;.COM'}, fsOps: files([`${dir}\\herdr.EXE`, `${dir}\\reason-network.COM`, `${dir}\\hc.CMD`])});
  assert.deepEqual(actual, {...missing, herdr: `${dir}\\herdr.EXE`, reasonNetwork: `${dir}\\reason-network.COM`});
});

test('Windows standard program directories and explicit overrides remain absolute', async () => {
  const env = {ProgramFiles: 'C:\\Program Files', agent_deck_hc: 'C:\\custom\\hc.exe', AGENT_DECK_HERDR: 'relative.exe'};
  const actual = await discoverHostTools({platform: 'win32', home: 'C:\\Users\\fixture', env, fsOps: files(['C:\\Program Files\\Herdr\\Herdr.exe', 'C:\\custom\\hc.exe'])});
  assert.deepEqual(actual, {...missing, nativeHerdr: 'C:\\Program Files\\Herdr\\Herdr.exe', hc: 'C:\\custom\\hc.exe'});
});

test('Windows rejects current-drive-rooted overrides as ambiguous', async () => {
  assert.deepEqual(await discoverHostTools({platform: 'win32', env: {AGENT_DECK_HERDR: '\\tools\\herdr.exe', PATH: '\\tools'}, fsOps: files(['\\tools\\herdr.exe'])}), missing);
});
