import { CliError } from './errors.mjs';

export function parseTsv(text) {
  const rows = [];
  const seen = new Set();
  for (const [index, rawLine] of text.replace(/\r\n?/g, '\n').split('\n').entries()) {
    if (rawLine.trim().length === 0) {
      continue;
    }
    const cells = rawLine.split('\t');
    if (cells.length < 2) {
      throw new CliError(
        'CLI_TSV_INVALID',
        `第 ${index + 1} 行至少需要英文拼写和中文释义两列`,
      );
    }
    const term = cells[0].trim();
    const meaning = cells[1].trim();
    if (!term || !meaning) {
      throw new CliError(
        'CLI_TSV_INVALID',
        `第 ${index + 1} 行的英文拼写和中文释义不能为空`,
      );
    }
    const key = `${normalize(term)}\0${normalize(meaning)}`;
    if (seen.has(key)) {
      throw new CliError(
        'CLI_TSV_DUPLICATE',
        `第 ${index + 1} 行与文件内已有词条重复`,
      );
    }
    seen.add(key);
    rows.push({
      term,
      meaning,
      acceptedAnswers: [term],
      hints: cells.slice(2).map((value) => value.trim()).filter(Boolean),
    });
  }
  if (rows.length === 0) {
    throw new CliError('CLI_TSV_EMPTY', 'TSV 文件没有有效词条');
  }
  return rows;
}

function normalize(value) {
  return value.normalize('NFKC').toLocaleLowerCase('en-US');
}
