import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRuntimeConfig } from '../config.mjs';
import { LocalStore } from '../local/store.mjs';
import { LocalPracticeAdapter, createSession, planLocalQueue } from '../local/learning.mjs';
import { createEmptySnapshot, parseSnapshot } from '../local/schema.mjs';
import { createId } from '../id.mjs';
import { BattleCheckpointStore } from '../battleCheckpoint.mjs';

test('a local typed review persists Web v5 session, FSRS state and log', async () => {
  const now = Date.now();
  const snapshot = snapshotWithWord('memory', '记忆', now);
  const runtime = resolveRuntimeConfig({
    mode: 'local',
    profile: 'fixture',
    home: await mkdtemp(join(tmpdir(), 'fm-local-')),
  });
  const store = new LocalStore(runtime);
  await store.save(snapshot);

  const adapter = await LocalPracticeAdapter.open(
    store,
    { 'learning-mode': 'keyboard-recall' },
    { json: false, printJson() {} },
  );
  await adapter.beginTyped('memory');
  assert.equal(adapter.pending.inputMatchedAnswer, true);
  assert.equal(adapter.previews.previews.good.scheduledDays >= 0, true);
  await adapter.rate('good');

  const persisted = await new LocalStore(runtime).load();
  assert.equal(persisted.tables.reviewStates.length, 1);
  assert.equal(persisted.tables.reviewLogs.length, 1);
  assert.equal(persisted.tables.practiceAttempts.length, 1);
  assert.equal(persisted.tables.practiceSessions[0].status, 'completed');
  assert.equal(persisted.tables.reviewStates[0].schedulerPackageVersion, '6.0.0');
  assert.equal(persisted.tables.reviewStates[0].schedulerModelVersion, 'fsrs-7');
  assert.equal('version' in persisted.tables.reviewStates[0], false);
  parseSnapshot(persisted);
});

test('local queue resume restores an unanswered pending checkpoint', async () => {
  const now = Date.now();
  const snapshot = snapshotWithWord('bridge', '桥', now);
  snapshot.tables.lexiconItems.push({
    lexiconId: snapshot.tables.lexicons[0].id,
    studyItemId: createStudyItem(snapshot, '跨过', now),
    order: 1,
    sourceHints: [],
  });
  const session = createSession(snapshot, {
    modeId: 'keyboard-recall',
    now,
    timeZone: 'UTC',
  });
  snapshot.tables.practiceSessions.push(session);
  const runtime = resolveRuntimeConfig({
    mode: 'local',
    profile: 'resume',
    home: await mkdtemp(join(tmpdir(), 'fm-resume-')),
  });
  const store = new LocalStore(runtime);
  await store.save(snapshot);

  const first = await LocalPracticeAdapter.open(
    store,
    { session: session.id },
    { json: false, printJson() {} },
  );
  await first.beginTyped('bridge');
  await first.pause();

  const resumed = await LocalPracticeAdapter.open(
    store,
    { resume: true },
    { json: false, printJson() {} },
  );
  assert.equal(resumed.session.session.status, 'active');
  assert.equal(resumed.pending.studyItemId, session.currentStudyItemId);
  assert.equal(resumed.previews.previews.again.rating, 'again');
});

test('queue excludes archived lexicons and due reviews beyond the local day', () => {
  const now = Date.now();
  const snapshot = snapshotWithWord('memory', '记忆', now);
  const plan = planLocalQueue(snapshot, {
    now,
    timeZone: 'UTC',
    newLimit: 10,
    reviewLimit: 50,
  });
  assert.equal(plan.selected.length, 1);
  snapshot.tables.lexicons[0].archivedAt = now;
  assert.equal(
    planLocalQueue(snapshot, {
      now,
      timeZone: 'UTC',
      newLimit: 10,
      reviewLimit: 50,
    }).selected.length,
    0,
  );
});

test('snapshot validation rejects future versions and dangling sessions', () => {
  const now = Date.now();
  const future = createEmptySnapshot(now);
  future.schemaVersion = 6;
  future.dataFormatVersion = 6;
  assert.throws(() => parseSnapshot(future), /只支持数据 v3\/v4\/v5/);

  const dangling = snapshotWithWord('memory', '记忆', now);
  dangling.tables.practiceSessions.push({
    id: 'session-bad',
    modeId: 'keyboard-recall',
    status: 'active',
    queue: [{
      studyItemId: 'missing-study',
      wordEntryId: 'missing-word',
      status: 'pending',
      source: 'new',
    }],
    currentIndex: 0,
    currentStudyItemId: 'missing-study',
    interactions: {},
    pendingAnswer: null,
    speed: 1,
    reduceMotion: true,
    createdAt: now,
    updatedAt: now,
    pausedAt: null,
    completedAt: null,
  });
  assert.throws(
    () => parseSnapshot(dangling),
    /引用了不存在的 studyItem/,
  );
});

test('battle claim checkpoints survive a process restart and clear atomically', async () => {
  const runtime = resolveRuntimeConfig({
    mode: 'account',
    profile: 'battle-checkpoint',
    home: await mkdtemp(join(tmpdir(), 'fm-claim-')),
  });
  const first = new BattleCheckpointStore(runtime);
  await first.set('battle-1', {
    actionId: 'claim-action',
    submissionId: 'review-id',
    sessionId: 'session-1',
    studyItemId: 'study-1',
    createdAtMs: 1,
  });
  const recovered = await new BattleCheckpointStore(runtime).get('battle-1');
  assert.equal(recovered.actionId, 'claim-action');
  await first.clear('battle-1');
  assert.equal(await first.get('battle-1'), undefined);
});

function snapshotWithWord(term, meaning, now) {
  const snapshot = createEmptySnapshot(now);
  const lexicon = {
    id: createId('lexicon'),
    name: 'fixture',
    description: '',
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  const word = {
    id: createId('word'),
    term,
    meaning,
    acceptedAnswers: [term],
    hints: ['first letter'],
    normalizedTerm: term,
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
  snapshot.tables.lexicons.push(lexicon);
  snapshot.tables.words.push(word);
  snapshot.tables.studyItems.push(studyItem);
  snapshot.tables.lexiconItems.push({
    lexiconId: lexicon.id,
    studyItemId: studyItem.id,
    order: 0,
    sourceHints: word.hints,
  });
  return snapshot;
}

function createStudyItem(snapshot, term, now) {
  const word = {
    id: createId('word'),
    term,
    meaning: '第二词',
    acceptedAnswers: [term],
    hints: [],
    normalizedTerm: term,
    createdAt: now,
    updatedAt: now,
  };
  const item = {
    id: createId('study'),
    wordEntryId: word.id,
    direction: 'meaning-to-spelling',
    createdAt: now,
    updatedAt: now,
  };
  snapshot.tables.words.push(word);
  snapshot.tables.studyItems.push(item);
  return item.id;
}
