import { basename, extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseCommandArgs } from '../args.mjs';
import { AccountApiClient } from '../api.mjs';
import { loadAccountConfig, resolveRuntimeConfig } from '../config.mjs';
import { CliError } from '../errors.mjs';
import { runLocalLexicon } from '../local/commands.mjs';
import { parseTsv } from '../tsv.mjs';

export async function runLexicon({ global, words, terminal }) {
  const command = words[0] ?? 'list';
  const runtime = resolveRuntimeConfig(global);
  if (runtime.mode === 'local') {
    await runLocalLexicon({
      runtime,
      command,
      words: words.slice(1),
      terminal,
    });
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
  if (command === 'list') {
    parseCommandArgs(words.slice(1), { positionals: 0 });
    const lexicons = await api.listLexicons();
    if (terminal.json) {
      terminal.printJson(lexicons);
      return;
    }
    if (lexicons.length === 0) {
      terminal.write('账号中还没有词库。');
      return;
    }
    lexicons.forEach((lexicon, index) => {
      terminal.event('LEXICON', {
        index: index + 1,
        id: lexicon.id,
        name: lexicon.name,
        words: lexicon.wordCount ?? '-',
        archived: lexicon.archivedAtMs !== null,
      });
    });
    return;
  }
  if (command === 'import') {
    const { options, positional } = parseCommandArgs(words.slice(1), {
      values: ['name', 'description', 'lexicon-id'],
      positionals: 1,
    });
    const file = positional[0];
    if (!file) {
      throw new CliError('CLI_FILE_REQUIRED', '需要 TSV 文件路径');
    }
    const rows = parseTsv(await readFile(file, 'utf8'));
    const lexicons = await api.listLexicons();
    let lexicon = options['lexicon-id']
      ? lexicons.find((candidate) => candidate.id === options['lexicon-id'])
      : undefined;
    if (options['lexicon-id'] && !lexicon) {
      throw new CliError('CLI_LEXICON_NOT_FOUND', '指定的账号词库不存在');
    }
    lexicon ??= await api.createLexicon(
      options.name ?? basename(file, extname(file)),
      options.description ?? '通过 FingerMemory CLI 导入',
    );
    for (const row of rows) {
      await api.addWord(lexicon.id, row);
    }
    if (terminal.json) {
      terminal.printJson({ lexicon, imported: rows.length });
      return;
    }
    terminal.write(`已向“${lexicon.name}”导入 ${rows.length} 个词条。`);
    return;
  }
  throw new CliError('CLI_COMMAND_UNKNOWN', `未知 lexicon 命令：${command}`);
}
