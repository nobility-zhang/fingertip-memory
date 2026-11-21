import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGlobalArgs } from '../args.mjs';
import {
  normalizeServerUrl,
  resolveRuntimeConfig,
  saveAccountSession,
} from '../config.mjs';

test('global arguments keep local and account profiles separate', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fm-config-'));
  const global = {
    mode: 'account',
    profile: 'work laptop',
    home,
  };
  assert.throws(
    () => resolveRuntimeConfig(global),
    /配置名只能包含/,
  );
  const runtime = resolveRuntimeConfig({ ...global, profile: 'work-laptop' });
  assert.match(runtime.profileDirectory, /profiles\/account\/work-laptop$/);
  assert.doesNotMatch(runtime.tokenPath, /profiles\/local/);
});

test('saved tokens are private and are not part of account metadata', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fm-token-'));
  const runtime = resolveRuntimeConfig({
    mode: 'account',
    profile: 'default',
    home,
  });
  const token = 'fm_pat_example_secret_that_must_not_enter_config';
  await saveAccountSession(runtime, {
    serverUrl: 'http://127.0.0.1:8080/api/v1',
    token,
    tokenId: 'token-id',
    tokenName: 'test',
  });
  const tokenFile = await readFile(runtime.tokenPath, 'utf8');
  const configFile = await readFile(runtime.configPath, 'utf8');
  assert.equal(tokenFile.trim(), token);
  assert.doesNotMatch(configFile, new RegExp(token));
  assert.equal((await stat(runtime.tokenPath)).mode & 0o777, 0o600);
  assert.equal((await stat(runtime.configPath)).mode & 0o777, 0o600);
});

test('server URL normalization always points at api v1', () => {
  assert.equal(
    normalizeServerUrl('https://memory.example.test'),
    'https://memory.example.test/api/v1',
  );
  assert.equal(
    normalizeServerUrl('https://memory.example.test/console/'),
    'https://memory.example.test/console/api/v1',
  );
  assert.equal(
    normalizeServerUrl('http://127.0.0.1:8080/api/v1/'),
    'http://127.0.0.1:8080/api/v1',
  );
});

test('global option parser rejects unknown modes', () => {
  assert.deepEqual(parseGlobalArgs(['--mode', 'local', 'learn']).global, {
    mode: 'local',
  });
  assert.throws(
    () => parseGlobalArgs(['--mode=remote', 'learn']),
    /--mode 只能是 local 或 account/,
  );
});
