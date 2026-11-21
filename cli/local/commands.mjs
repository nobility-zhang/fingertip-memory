import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { parseCommandArgs } from '../args.mjs';
import { CliError } from '../errors.mjs';
import { createId } from '../id.mjs';
import { parseTsv } from '../tsv.mjs';
import { LocalStore } from './store.mjs';
import { LocalPracticeAdapter } from './learning.mjs';
import { runPracticeLoop } from '../commands/learn.mjs';

export async function runLocalLearn({ runtime, options, terminal }) {
  const store = new LocalStore(runtime);
  const adapter = await LocalPracticeAdapter.open(store, options, terminal);
  await runPracticeLoop(adapter, terminal);
}

export async function runLocalLexicon({ runtime, command, words, terminal }) {
  const store = new LocalStore(runtime);
  if (command === 'list') {
    parseCommandArgs(words, { positionals: 0 });
    const snapshot = await store.load();
    if (terminal.json) {
      terminal.printJson(snapshot.tables.lexicons);
      return;
    }
    if (snapshot.tables.lexicons.length === 0) {
      terminal.write('本地配置中还没有词库。');
      return;
    }
    snapshot.tables.lexicons.forEach((lexicon, index) => {
      const studyItemIds = new Set(
        snapshot.tables.lexiconItems
          .filter((item) => item.lexiconId === lexicon.id)
          .map((item) => item.studyItemId),
      );
      terminal.event('LEXICON', {
        index: index + 1,
        id: lexicon.id,
        name: lexicon.name,
        words: studyItemIds.size,
        archived: lexicon.archivedAt !== null,
      });
    });
    return;
  }
  if (command === 'import') {
    const { options, positional } = parseCommandArgs(words, {
      values: ['name', 'description', 'lexicon-id'],
      positionals: 1,
    });
    const file = positional[0];
    if (!file) {
      throw new CliError('CLI_FILE_REQUIRED', '需要 TSV 文件路径');
    }
    const rows = parseTsv(await readFile(file, 'utf8'));
    const snapshot = await store.load();
    let lexicon = options['lexicon-id']
      ? snapshot.tables.lexicons.find((value) => value.id === options['lexicon-id'])
      : undefined;
    if (options['lexicon-id'] && !lexicon) {
      throw new CliError('CLI_LEXICON_NOT_FOUND', '指定的本地词库不存在');
    }
    const now = Date.now();
    lexicon ??= {
      id: createId('lexicon'),
      name: options.name ?? basename(file, extname(file)),
      description: options.description ?? '通过 FingerMemory CLI 导入',
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    if (!snapshot.tables.lexicons.includes(lexicon)) {
      snapshot.tables.lexicons.push(lexicon);
    }
    const existingKeys = new Set(
      snapshot.tables.lexiconItems
        .filter((item) => item.lexiconId === lexicon.id)
        .map((item) => item.studyItemId),
    );
    let imported = 0;
    for (const row of rows) {
      const word = {
        id: createId('word'),
        term: row.term,
        meaning: row.meaning,
        acceptedAnswers: row.acceptedAnswers,
        hints: row.hints,
        normalizedTerm: normalize(row.term),
        createdAt: now,
        updatedAt: now,
      };
      const studyItem = {
        id: createId('study'),
        wordEntryId: word.id,
        direction: 'meaning-to-spelling',
        createdAt: now,
        updatedAt: now,
      };
      const duplicate = snapshot.tables.words.find(
        (value) =>
          normalize(value.term) === normalize(row.term)
          && normalize(value.meaning) === normalize(row.meaning),
      );
      if (duplicate) {
        throw new CliError(
          'CLI_LEXICON_DUPLICATE',
          `本地词库已存在词条：${row.term}`,
        );
      }
      snapshot.tables.words.push(word);
      snapshot.tables.studyItems.push(studyItem);
      snapshot.tables.lexiconItems.push({
        lexiconId: lexicon.id,
        studyItemId: studyItem.id,
        order: existingKeys.size + imported,
        sourceHints: row.hints,
      });
      imported += 1;
    }
    await store.save(snapshot);
    if (terminal.json) {
      terminal.printJson({ lexicon, imported });
      return;
    }
    terminal.write(`已向本地词库“${lexicon.name}”导入 ${imported} 个词条。`);
    return;
  }
  throw new CliError('CLI_COMMAND_UNKNOWN', `未知 lexicon 命令：${command}`);
}

function normalize(value) {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
