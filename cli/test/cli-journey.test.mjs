import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(cliRoot, '..');
const main = join(cliRoot, 'src', 'main.mjs');
const fixture = join(cliRoot, 'test', 'fixtures', 'basic.tsv');

test('non-TTY CLI imports, learns, exits and exports portable v5 data', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fm-journey-'));
  const importResult = run([
    '--home', home,
    '--profile', 'offline',
    'lexicon', 'import', fixture,
    '--name', '离线旅程',
  ]);
  assert.equal(importResult.status, 0, importResult.stderr);
  assert.match(importResult.stdout, /导入 2 个词条/);

  const learnResult = run(
    [
      '--home', home,
      '--profile', 'offline',
      'learn',
      '--learning-mode', 'keyboard-recall',
    ],
    'bridge\n3\npause\n',
  );
  assert.equal(learnResult.status, 0, learnResult.stderr);
  assert.match(learnResult.stdout, /CARD/);
  assert.match(learnResult.stdout, /REVIEWED/);
  assert.match(learnResult.stdout, /账号会话已暂停|本地会话已保存/);

  const statePath = join(home, 'profiles', 'local', 'offline', 'state.json');
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.schemaVersion, 5);
  assert.equal(state.tables.reviewLogs.length, 1);
  assert.equal(state.tables.practiceSessions[0].status, 'paused');

  const exportPath = join(home, 'offline-export.json');
  const exportResult = run([
    '--home', home,
    '--profile', 'offline',
    'data', 'export',
    '--output', exportPath,
  ]);
  assert.equal(exportResult.status, 0, exportResult.stderr);
  const exported = JSON.parse(await readFile(exportPath, 'utf8'));
  assert.equal(exported.schemaVersion, 5);
  assert.equal(exported.tables.reviewLogs.length, 1);
});

function run(args, input = '') {
  return spawnSync(process.execPath, [main, ...args], {
    cwd: repositoryRoot,
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      FINGER_MEMORY_TOKEN: '',
      FINGER_MEMORY_SERVER: '',
    },
  });
}
