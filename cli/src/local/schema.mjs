import { CliError } from '../errors.mjs';

export const STORAGE_SCHEMA_VERSION = 5;
export const DATA_FORMAT_VERSION = 5;

const TABLES = [
  'appMeta',
  'lexicons',
  'words',
  'studyItems',
  'lexiconItems',
  'notes',
  'practiceAttempts',
  'practiceSessions',
  'reviewStates',
  'reviewLogs',
];

const MODES = new Set([
  'flashcard',
  'keyboard-recall',
  'lyrics-scroll',
  'danmaku-stream',
  'card-rain',
]);

export function createEmptySnapshot(now = Date.now()) {
  return {
    snapshotVersion: 1,
    schemaVersion: STORAGE_SCHEMA_VERSION,
    dataFormatVersion: DATA_FORMAT_VERSION,
    exportedAt: now,
    tables: {
      appMeta: [
        meta('database.initializedAt', String(now), now),
        meta('data.formatVersion', String(DATA_FORMAT_VERSION), now),
        meta(
          'practice.queueSettings',
          JSON.stringify({ newLimit: 10, reviewLimit: 50, paused: false }),
          now,
        ),
      ],
      lexicons: [],
      words: [],
      studyItems: [],
      lexiconItems: [],
      notes: [],
      practiceAttempts: [],
      practiceSessions: [],
      reviewStates: [],
      reviewLogs: [],
    },
  };
}

export function parseSnapshot(input) {
  const root = requireObject(input, 'snapshot');
  if (root.snapshotVersion !== 1) {
    throw invalid('只支持 snapshotVersion 1');
  }
  const schemaVersion = root.schemaVersion;
  const dataFormatVersion = root.dataFormatVersion;
  if (![3, 4, 5].includes(schemaVersion) || schemaVersion !== dataFormatVersion) {
    throw invalid(
      `只支持数据 v3/v4/v5，收到 schema=${schemaVersion}, format=${dataFormatVersion}`,
    );
  }
  const tables = requireObject(root.tables, 'tables');
  for (const name of TABLES) {
    if (!Array.isArray(tables[name])) {
      throw invalid(`tables.${name} 必须是数组`);
    }
  }
  const migrated = {
    snapshotVersion: 1,
    schemaVersion: STORAGE_SCHEMA_VERSION,
    dataFormatVersion: DATA_FORMAT_VERSION,
    exportedAt: positiveInteger(root.exportedAt, 'exportedAt'),
    tables: Object.fromEntries(TABLES.map((name) => [name, tables[name]])),
  };
  migrated.tables.practiceSessions = tables.practiceSessions.map((session) => {
    const value = requireObject(session, 'practiceSession');
    if (!Array.isArray(value.queue)) {
      throw invalid('practiceSession.queue 必须是数组');
    }
    return {
      ...value,
      queue: value.queue.map((item) => ({
        ...requireObject(item, 'practiceSession.queue item'),
        source: item.source ?? 'new',
      })),
    };
  });
  validateSnapshot(migrated);
  ensureAppMeta(migrated, Date.now());
  return migrated;
}

export function validateSnapshot(snapshot) {
  const tables = snapshot.tables;
  uniqueBy(tables.lexicons, 'id', 'lexicons');
  uniqueBy(tables.words, 'id', 'words');
  uniqueBy(tables.studyItems, 'id', 'studyItems');
  uniqueBy(tables.notes, 'id', 'notes');
  uniqueBy(tables.practiceAttempts, 'id', 'practiceAttempts');
  uniqueBy(tables.practiceSessions, 'id', 'practiceSessions');
  uniqueBy(tables.reviewStates, 'studyItemId', 'reviewStates');
  uniqueBy(tables.reviewLogs, 'submissionId', 'reviewLogs');

  const lexiconIds = new Set(tables.lexicons.map((value) => requiredId(value, 'lexicon')));
  const words = new Map();
  for (const word of tables.words) {
    const id = requiredId(word, 'word');
    requiredText(word.term, `word ${id} term`);
    requiredText(word.meaning, `word ${id} meaning`);
    if (!Array.isArray(word.acceptedAnswers) || !Array.isArray(word.hints)) {
      throw invalid(`word ${id} 缺少 answers/hints`);
    }
    words.set(id, word);
  }
  const studyItems = new Map();
  for (const item of tables.studyItems) {
    const id = requiredId(item, 'studyItem');
    if (!words.has(item.wordEntryId)) {
      throw invalid(`studyItem ${id} 引用了不存在的 word`);
    }
    if (item.direction !== 'meaning-to-spelling') {
      throw invalid(`studyItem ${id} 的学习方向不受支持`);
    }
    studyItems.set(id, item);
  }
  const membershipKeys = new Set();
  for (const item of tables.lexiconItems) {
    if (!lexiconIds.has(item.lexiconId)) {
      throw invalid(`lexiconItem 引用了不存在的 lexicon ${item.lexiconId}`);
    }
    if (!studyItems.has(item.studyItemId)) {
      throw invalid(`lexiconItem 引用了不存在的 studyItem ${item.studyItemId}`);
    }
    const key = `${item.lexiconId}\0${item.studyItemId}`;
    if (membershipKeys.has(key)) {
      throw invalid(`lexiconItem 重复：${item.lexiconId}/${item.studyItemId}`);
    }
    membershipKeys.add(key);
  }
  for (const note of tables.notes) {
    if (!studyItems.has(note.studyItemId)) {
      throw invalid(`note ${note.id} 引用了不存在的 studyItem`);
    }
  }
  for (const attempt of tables.practiceAttempts) {
    if (!studyItems.has(attempt.studyItemId)) {
      throw invalid(`practiceAttempt ${attempt.id} 引用了不存在的 studyItem`);
    }
  }
  for (const session of tables.practiceSessions) {
    validateSession(session, studyItems);
  }
  for (const state of tables.reviewStates) {
    if (!studyItems.has(state.studyItemId)) {
      throw invalid(`reviewState ${state.studyItemId} 引用了不存在的 studyItem`);
    }
    if (
      state.schedulerPackageVersion !== '6.0.0'
      || state.schedulerModelVersion?.toLowerCase() !== 'fsrs-7'
    ) {
      throw invalid(`reviewState ${state.studyItemId} 的 FSRS 版本不兼容`);
    }
  }
  for (const log of tables.reviewLogs) {
    if (!studyItems.has(log.studyItemId)) {
      throw invalid(`reviewLog ${log.submissionId} 引用了不存在的 studyItem`);
    }
  }
  return snapshot;
}

export function queueSettings(snapshot) {
  const record = snapshot.tables.appMeta.find(
    (value) => value.key === 'practice.queueSettings',
  );
  if (!record) {
    return { newLimit: 10, reviewLimit: 50, paused: false };
  }
  try {
    const parsed = JSON.parse(record.value);
    if (
      Number.isInteger(parsed.newLimit)
      && parsed.newLimit >= 0
      && parsed.newLimit <= 100
      && Number.isInteger(parsed.reviewLimit)
      && parsed.reviewLimit >= 0
      && parsed.reviewLimit <= 500
      && typeof parsed.paused === 'boolean'
    ) {
      return parsed;
    }
  } catch {
    // Web treats malformed local preferences as defaults.
  }
  return { newLimit: 10, reviewLimit: 50, paused: false };
}

export function ensureAppMeta(snapshot, now) {
  const records = snapshot.tables.appMeta;
  upsertMeta(records, 'data.formatVersion', String(DATA_FORMAT_VERSION), now);
  if (!records.some((value) => value.key === 'database.initializedAt')) {
    upsertMeta(records, 'database.initializedAt', String(now), now);
  }
  if (!records.some((value) => value.key === 'practice.queueSettings')) {
    upsertMeta(
      records,
      'practice.queueSettings',
      JSON.stringify({ newLimit: 10, reviewLimit: 50, paused: false }),
      now,
    );
  }
}

export function snapshotCounts(snapshot) {
  return Object.fromEntries(
    TABLES.map((name) => [name, snapshot.tables[name].length]),
  );
}

function validateSession(session, studyItems) {
  const id = requiredId(session, 'practiceSession');
  if (!MODES.has(session.modeId)) {
    throw invalid(`practiceSession ${id} 的 modeId 未知`);
  }
  if (!['active', 'paused', 'completed'].includes(session.status)) {
    throw invalid(`practiceSession ${id} 的状态未知`);
  }
  if (!Array.isArray(session.queue) || session.queue.length === 0) {
    throw invalid(`practiceSession ${id} 的 queue 不能为空`);
  }
  for (const item of session.queue) {
    if (!studyItems.has(item.studyItemId)) {
      throw invalid(`practiceSession ${id} 引用了不存在的 studyItem`);
    }
    if (!['pending', 'completed', 'skipped'].includes(item.status)) {
      throw invalid(`practiceSession ${id} 的队列状态未知`);
    }
    if (!['new', 'review', 'retry'].includes(item.source)) {
      throw invalid(`practiceSession ${id} 的队列来源未知`);
    }
  }
  if (!Number.isInteger(session.currentIndex) || session.currentIndex < 0) {
    throw invalid(`practiceSession ${id} 的位置无效`);
  }
}

function uniqueBy(values, field, label) {
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'object' || value === null) {
      throw invalid(`${label} 只能包含对象`);
    }
    const id = requiredText(value[field], `${label}.${field}`);
    if (seen.has(id)) {
      throw invalid(`${label} 存在重复键 ${id}`);
    }
    seen.add(id);
  }
}

function requiredId(value, label) {
  return requiredText(value.id, `${label} id`);
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalid(`${label} 必须是非空字符串`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalid(`${label} 必须是正整数时间戳`);
  }
  return value;
}

function requireObject(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`${label} 必须是对象`);
  }
  return value;
}

function invalid(message) {
  return new CliError('CLI_SNAPSHOT_INVALID', message);
}

function meta(key, value, updatedAt) {
  return { key, value, updatedAt };
}

function upsertMeta(records, key, value, updatedAt) {
  const index = records.findIndex((record) => record.key === key);
  const record = meta(key, value, updatedAt);
  if (index >= 0) {
    records[index] = record;
  } else {
    records.push(record);
  }
}
