import { readFile } from 'node:fs/promises';
import { parseCommandArgs } from '../args.mjs';
import { AccountApiClient } from '../api.mjs';
import { loadAccountConfig, resolveRuntimeConfig } from '../config.mjs';
import { CliError } from '../errors.mjs';
import { createId } from '../id.mjs';
import { LocalStore } from '../local/store.mjs';

export async function runData({ global, words, terminal }) {
  const command = words[0];
  const runtime = resolveRuntimeConfig(global);
  if (!['status', 'export', 'import'].includes(command)) {
    throw new CliError('CLI_COMMAND_UNKNOWN', '用法：fm data status|export|import');
  }
  if (runtime.mode === 'local') {
    const store = new LocalStore(runtime);
    if (command === 'status') {
      parseCommandArgs(words.slice(1), { positionals: 0 });
      const status = await store.status();
      if (terminal.json) {
        terminal.printJson(status);
      } else {
        terminal.event('LOCAL_DATA', {
          profile: status.profile,
          path: status.path,
          mode: status.mode,
          bytes: status.bytes,
        });
        for (const [name, count] of Object.entries(status.counts)) {
          terminal.event('COUNT', { table: name, value: count });
        }
      }
      return;
    }
    if (command === 'export') {
      const { options } = parseCommandArgs(words.slice(1), {
        values: ['output'],
        positionals: 0,
      });
      const result = await store.exportSnapshot(options.output);
      if (options.output) {
        terminal.write(`已导出 ${options.output}`);
      } else {
        terminal.output.write(result.text);
      }
      return;
    }
    const { options, positional } = parseCommandArgs(words.slice(1), {
      values: ['input'],
      flags: ['yes'],
      positionals: 1,
    });
    const input = options.input ?? positional[0];
    if (!input) {
      throw new CliError('CLI_FILE_REQUIRED', '需要 --input 快照路径');
    }
    if (!options.yes) {
      throw new CliError(
        'CLI_CONFIRMATION_REQUIRED',
        '导入会覆盖当前本地配置；确认后加 --yes',
      );
    }
    const parsed = parseJsonInput(await readFile(input, 'utf8'), input);
    const snapshot = await store.importSnapshot(parsed);
    terminal.write(
      `已恢复本地数据 v${snapshot.schemaVersion}，原状态保存在 profile 目录。`,
    );
    return;
  }

  const config = await loadAccountConfig(runtime);
  if (!config.token) {
    throw new CliError(
      'CLI_TOKEN_MISSING',
      '账号模式尚未配置令牌，请先运行 fm --mode account auth login',
    );
  }
  const api = new AccountApiClient(config);
  if (command === 'status') {
    parseCommandArgs(words.slice(1), { positionals: 0 });
    const user = await api.currentUser();
    if (terminal.json) {
      terminal.printJson({ serverUrl: config.serverUrl, user });
    } else {
      terminal.event('ACCOUNT', {
        server: config.serverUrl,
        user: user.username,
        display: user.displayName,
      });
    }
    return;
  }
  if (command === 'export') {
    const { options } = parseCommandArgs(words.slice(1), {
      values: ['output'],
      positionals: 0,
    });
    const backup = await api.exportBackup();
    const text = `${JSON.stringify(backup, null, 2)}\n`;
    if (options.output) {
      const { writeFileAtomic } = await import('../config.mjs');
      await writeFileAtomic(options.output, text);
      terminal.write(`已导出账号备份 ${options.output}`);
    } else {
      terminal.output.write(text);
    }
    return;
  }
  const { options, positional } = parseCommandArgs(words.slice(1), {
    values: ['input'],
    flags: ['yes'],
    positionals: 1,
  });
  const input = options.input ?? positional[0];
  if (!input) {
    throw new CliError('CLI_FILE_REQUIRED', '需要账号备份路径');
  }
  const backup = parseJsonInput(await readFile(input, 'utf8'), input);
  const preview = await api.previewBackupImport(backup);
  if (!options.yes) {
    if (terminal.json) {
      terminal.printJson(preview);
    } else {
      terminal.event('BACKUP_PREVIEW', preview);
      terminal.write('确认恢复请重复命令并加 --yes。');
    }
    return;
  }
  const result = await api.importBackup(backup, createId('backup_import'));
  if (terminal.json) {
    terminal.printJson(result);
  } else {
    terminal.event('BACKUP_RESTORED', {
      outcome: result.outcome,
      dataVersion: result.dataVersion,
    });
  }
}

function parseJsonInput(text, path) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError(
      'CLI_JSON_INVALID',
      `无法解析备份 JSON：${path}`,
      { cause: error },
    );
  }
}
