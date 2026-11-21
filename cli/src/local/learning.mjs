import { createLocalScheduler } from './scheduler.mjs';
import { queueSettings } from './schema.mjs';
import { CliError } from '../errors.mjs';
import { createId } from '../id.mjs';
import { localDayRange } from './day.mjs';

const RATINGS = ['again', 'hard', 'good', 'easy'];

export class LocalPracticeAdapter {
  constructor(store, snapshot, sessionId, scheduler) {
    this.store = store;
    this.snapshot = snapshot;
    this.scheduler = scheduler;
    this.mode = 'local';
    this.session = findSessionEnvelope(snapshot, sessionId);
    this.pending = this.session.session.pendingAnswer ?? null;
    this.previews = undefined;
    this.notRemembered = false;
    this.hintIndex = 0;
    this.hintUsed = false;
    this.revealed = false;
  }

  static async open(store, options, terminal) {
    const snapshot = await store.load();
    const scheduler = await createLocalScheduler();
    let session;
    if (options.session) {
      session = snapshot.tables.practiceSessions.find(
        (value) => value.id === options.session,
      );
      if (!session) {
        throw new CliError('CLI_SESSION_NOT_FOUND', '指定的本地会话不存在');
      }
    } else if (options.resume) {
      session = [...snapshot.tables.practiceSessions]
        .filter((value) => value.status !== 'completed')
        .sort((left, right) => right.updatedAt - left.updatedAt)[0];
      if (!session) {
        throw new CliError('CLI_SESSION_NOT_FOUND', '没有可恢复的本地学习会话');
      }
    } else {
      session = createSession(snapshot, {
        modeId: options['learning-mode'] ?? 'keyboard-recall',
        newLimit: parseLimit(options['new-limit'], 100),
        reviewLimit: parseLimit(options['review-limit'], 500),
        now: Date.now(),
        timeZone: currentTimeZone(),
      });
      snapshot.tables.practiceSessions.push(session);
    }
    if (session.status === 'paused') {
      session.status = 'active';
      session.pausedAt = null;
      session.updatedAt = Date.now();
    }
    await store.save(snapshot);
    const adapter = new LocalPracticeAdapter(
      store,
      snapshot,
      session.id,
      scheduler,
    );
    if (adapter.pending) {
      adapter.previews = await adapter.loadPreviews();
    }
    if (terminal.json) {
      terminal.printJson(await adapter.snapshotForMachine());
    }
    return adapter;
  }

  get currentItem() {
    const id = this.session.session.currentStudyItemId;
    if (id === null) {
      return undefined;
    }
    return this.session.items.find((item) => item.studyItem.id === id);
  }

  get modeName() {
    return this.session.session.modeId;
  }

  showHint(terminal) {
    const hints = this.currentItem?.wordEntry.hints ?? [];
    if (this.hintIndex >= hints.length) {
      terminal.write('当前词条没有更多提示。');
      return;
    }
    terminal.event('HINT', {
      index: this.hintIndex + 1,
      text: hints[this.hintIndex],
    });
    this.hintIndex += 1;
    this.hintUsed = true;
  }

  revealAnswer(terminal) {
    const item = this.currentItem;
    if (!item) {
      return;
    }
    this.revealed = true;
    this.hintUsed = true;
    terminal.event('ANSWER', {
      term: item.wordEntry.term,
      meaning: item.wordEntry.meaning,
    });
  }

  async beginTyped(response) {
    const item = this.currentItem;
    if (!item) {
      throw new CliError('CLI_CURRENT_ITEM_MISSING', '当前会话没有学习目标');
    }
    const now = Date.now();
    const pending = pendingAnswer({
      item,
      response,
      answerWasHidden: true,
      hintUsed: false,
      answerRevealed: false,
      assessmentType: 'typed-recall',
      stage: 'attempt',
      explicitNotRemembered: false,
      now,
    });
    this.session.session.pendingAnswer = pending;
    this.session.session.updatedAt = now;
    appendAttempt(this.snapshot, item, this.session, pending, now, false);
    this.pending = pending;
    this.previews = await this.loadPreviews();
    await this.persist();
    return pending;
  }

  async beginFlashcard(notRemembered) {
    const item = this.currentItem;
    const now = Date.now();
    const pending = pendingAnswer({
      item,
      response: '',
      answerWasHidden: true,
      hintUsed: false,
      answerRevealed: true,
      assessmentType: 'flashcard-self-report',
      stage: 'reveal-for-check',
      explicitNotRemembered: notRemembered,
      now,
    });
    this.session.session.pendingAnswer = pending;
    this.session.session.updatedAt = now;
    appendAttempt(this.snapshot, item, this.session, pending, now, false);
    this.pending = pending;
    this.notRemembered = notRemembered;
    this.revealed = true;
    this.previews = await this.loadPreviews();
    await this.persist();
    return pending;
  }

  async loadPreviews() {
    const pending = this.pending ?? this.session.session.pendingAnswer;
    if (!pending) {
      return undefined;
    }
    const now = Date.now();
    const state = this.snapshot.tables.reviewStates.find(
      (value) => value.studyItemId === pending.studyItemId,
    );
    const card = state
      ? reviewCard(state)
      : this.scheduler.createCard(pending.studyItemId, now);
    return {
      previews: Object.fromEntries(
        RATINGS.map((rating) => {
          const result = this.scheduler.review(card, rating, now);
          return [
            rating,
            {
              rating,
              dueAt: result.card.dueAt,
              scheduledDays: result.card.scheduledDays,
            },
          ];
        }),
      ),
      dataVersion: this.snapshot.exportedAt,
      reviewVersion: this.reviewCount(pending.studyItemId),
      sessionVersion: this.session.session.updatedAt,
      schedulerPackageVersion: this.scheduler.packageVersion,
      schedulerModelVersion: this.scheduler.modelVersion,
    };
  }

  async rate(rating) {
    const pending = this.pending;
    if (!pending) {
      throw new CliError('CLI_PENDING_MISSING', '当前词条没有待评分答案');
    }
    const item = this.currentItem;
    const now = Date.now();
    const existing = this.snapshot.tables.reviewStates.find(
      (value) => value.studyItemId === item.studyItem.id,
    );
    const beforeCard = existing ? reviewCard(existing) : null;
    const card = beforeCard
      ?? this.scheduler.createCard(item.studyItem.id, now);
    const scheduled = this.scheduler.review(card, rating, now);
    const state = {
      studyItemId: item.studyItem.id,
      ...scheduled.card,
      schedulerConfig: this.scheduler.config,
      schedulerPackageVersion: this.scheduler.packageVersion,
      schedulerModelVersion: this.scheduler.modelVersion,
      updatedAt: now,
    };
    const log = {
      submissionId: pending.reviewSubmissionId,
      studyItemId: item.studyItem.id,
      wordEntryId: item.wordEntry.id,
      modeId: this.session.session.modeId,
      sessionId: this.session.session.id,
      direction: 'meaning-to-spelling',
      rating,
      reviewedAt: now,
      response: pending.response,
      inputMatchedAnswer: matchesWord(item.wordEntry, pending.response),
      answerWasHidden: pending.answerWasHidden,
      hintUsed: pending.hintUsed,
      answerRevealed: pending.answerRevealed,
      assessmentType: pending.assessmentType,
      assessmentPolicyVersion: 2,
      assessmentStage: 'rate',
      priorExposure: pending.priorExposure,
      explicitNotRemembered: pending.explicitNotRemembered,
      abandoned: false,
      beforeCard,
      afterCard: scheduled.card,
      srsRevlog: scheduled.revlog,
      schedulerConfig: this.scheduler.config,
      schedulerPackageVersion: this.scheduler.packageVersion,
      schedulerModelVersion: this.scheduler.modelVersion,
      requestFingerprint: JSON.stringify([
        pending.reviewSubmissionId,
        item.studyItem.id,
        rating,
        now,
      ]),
    };
    const index = this.snapshot.tables.reviewStates.findIndex(
      (value) => value.studyItemId === item.studyItem.id,
    );
    if (index >= 0) {
      this.snapshot.tables.reviewStates[index] = state;
    } else {
      this.snapshot.tables.reviewStates.push(state);
    }
    this.snapshot.tables.reviewLogs.push(log);
    completeCurrentItem(this.session.session, 'completed', now);
    this.resetItemState();
    await this.persist();
    return { dueAt: scheduled.card.dueAt };
  }

  async completePractice({ outcome, response = '' }) {
    const item = this.currentItem;
    if (!item) {
      throw new CliError('CLI_CURRENT_ITEM_MISSING', '当前会话没有学习目标');
    }
    const now = Date.now();
    const pending = pendingAnswer({
      item,
      response,
      answerWasHidden: !this.revealed,
      hintUsed: this.hintUsed,
      answerRevealed: this.revealed,
      assessmentType: 'guided-practice',
      stage: this.revealed ? 'reveal-for-check' : 'attempt',
      explicitNotRemembered: false,
      now,
      abandoned: outcome === 'skipped',
    });
    appendAttempt(
      this.snapshot,
      item,
      this.session,
      pending,
      now,
      outcome === 'skipped',
    );
    this.session.session.pendingAnswer = null;
    completeCurrentItem(this.session.session, outcome, now);
    this.resetItemState();
    await this.persist();
  }

  async pause() {
    if (this.session.session.status !== 'active') {
      return;
    }
    const now = Date.now();
    this.session.session.status = 'paused';
    this.session.session.pausedAt = now;
    this.session.session.updatedAt = now;
    await this.persist();
  }

  async snapshotForMachine() {
    return {
      mode: 'local',
      sessionId: this.session.session.id,
      status: this.session.session.status,
      currentStudyItemId: this.session.session.currentStudyItemId,
      queueLength: this.session.session.queue.length,
      dataVersion: this.snapshot.exportedAt,
    };
  }

  resetItemState() {
    this.pending = null;
    this.previews = undefined;
    this.notRemembered = false;
    this.hintIndex = 0;
    this.hintUsed = false;
    this.revealed = false;
  }

  async persist() {
    this.snapshot.exportedAt = Date.now();
    await this.store.save(this.snapshot);
  }

  reviewCount(studyItemId) {
    return this.snapshot.tables.reviewLogs.filter(
      (value) => value.studyItemId === studyItemId,
    ).length;
  }
}

export function createSession(snapshot, input) {
  if (!['flashcard', 'keyboard-recall'].includes(input.modeId)) {
    throw new CliError(
      'CLI_MODE_RETIRED',
      '新本地会话只支持 flashcard 或 keyboard-recall',
    );
  }
  const plan = planLocalQueue(snapshot, input);
  if (plan.selected.length === 0) {
    throw new CliError(
      'CLI_QUEUE_EMPTY',
      plan.paused
        ? '本地队列已暂停，请先在 Web 或数据文件中恢复队列'
        : '本地没有到期或新词，请先导入词库',
    );
  }
  const now = input.now;
  const selected = input.modeId === 'flashcard'
    ? plan.selected.filter(
        (entry, index, all) =>
          all.findIndex(
            (candidate) =>
              candidate.studyItem.id === entry.studyItem.id,
          ) === index,
      )
    : plan.selected;
  const queue = selected.map((entry) => ({
    studyItemId: entry.studyItem.id,
    wordEntryId: entry.wordEntry.id,
    status: 'pending',
    source: entry.source,
  }));
  return {
    id: createId('session'),
    modeId: input.modeId,
    status: 'active',
    queue,
    currentIndex: 0,
    currentStudyItemId: queue[0].studyItemId,
    interactions: {},
    pendingAnswer: null,
    speed: 1,
    reduceMotion: true,
    createdAt: now,
    updatedAt: now,
    pausedAt: null,
    completedAt: null,
  };
}

export function planLocalQueue(snapshot, input) {
  const settings = queueSettings(snapshot);
  const newLimit = input.newLimit ?? settings.newLimit;
  const reviewLimit = input.reviewLimit ?? settings.reviewLimit;
  const day = localDayRange(input.now, input.timeZone);
  const activeLexicons = new Set(
    snapshot.tables.lexicons
      .filter((value) => value.archivedAt === null)
      .map((value) => value.id),
  );
  const studyItemIds = new Set(
    snapshot.tables.lexiconItems
      .filter((value) => activeLexicons.has(value.lexiconId))
      .map((value) => value.studyItemId),
  );
  const studyItems = new Map(
    snapshot.tables.studyItems.map((value) => [value.id, value]),
  );
  const words = new Map(snapshot.tables.words.map((value) => [value.id, value]));
  const items = [...studyItemIds]
    .map((id) => {
      const studyItem = studyItems.get(id);
      const wordEntry = studyItem ? words.get(studyItem.wordEntryId) : undefined;
      return studyItem && wordEntry ? { studyItem, wordEntry } : undefined;
    })
    .filter(Boolean)
    .sort((left, right) =>
      left.wordEntry.term.localeCompare(right.wordEntry.term)
      || left.studyItem.id.localeCompare(right.studyItem.id));
  const states = new Map(
    snapshot.tables.reviewStates.map((value) => [value.studyItemId, value]),
  );
  const due = items
    .filter((item) => {
      const state = states.get(item.studyItem.id);
      return state !== undefined && state.dueAt < day.endAt;
    })
    .sort((left, right) =>
      states.get(left.studyItem.id).dueAt
      - states.get(right.studyItem.id).dueAt);
  const fresh = items.filter((item) => !states.has(item.studyItem.id));
  return {
    paused: settings.paused,
    dayStartAt: day.startAt,
    dayEndAt: day.endAt,
    dueAvailableCount: due.length,
    newAvailableCount: fresh.length,
    selected: settings.paused
      ? []
      : [
          ...due.slice(0, reviewLimit).map((item) => ({ ...item, source: 'review' })),
          ...fresh.slice(0, newLimit).map((item) => ({ ...item, source: 'new' })),
        ],
  };
}

function findSessionEnvelope(snapshot, sessionId) {
  const session = snapshot.tables.practiceSessions.find(
    (value) => value.id === sessionId,
  );
  if (!session) {
    throw new CliError('CLI_SESSION_NOT_FOUND', '本地会话不存在');
  }
  const itemIds = new Set(session.queue.map((value) => value.studyItemId));
  const items = [...itemIds].map((id) => {
    const studyItem = snapshot.tables.studyItems.find((value) => value.id === id);
    const wordEntry = studyItem
      ? snapshot.tables.words.find((value) => value.id === studyItem.wordEntryId)
      : undefined;
    const lexiconItem = snapshot.tables.lexiconItems.find(
      (value) => value.studyItemId === id,
    );
    const reviewState = snapshot.tables.reviewStates.find(
      (value) => value.studyItemId === id,
    );
    return {
      studyItem,
      wordEntry,
      lexiconItem: lexiconItem ?? null,
      reviewState,
      reviewVersion: snapshot.tables.reviewLogs.filter(
        (value) => value.studyItemId === id,
      ).length,
    };
  });
  return { session, items, dataVersion: snapshot.exportedAt };
}

function pendingAnswer(input) {
  return {
    studyItemId: input.item.studyItem.id,
    response: input.response,
    answerWasHidden: input.answerWasHidden,
    hintUsed: input.hintUsed,
    answerRevealed: input.answerRevealed,
    inputMatchedAnswer: matchesWord(input.item.wordEntry, input.response),
    assessmentType: input.assessmentType,
    assessmentPolicyVersion: 2,
    assessmentStage: input.stage,
    priorExposure: input.hintUsed || input.answerRevealed,
    explicitNotRemembered: input.explicitNotRemembered,
    practiceAttemptId: createId('practice'),
    reviewSubmissionId: createId('review'),
    submittedAt: input.now,
  };
}

function appendAttempt(snapshot, item, envelope, pending, now, abandoned) {
  snapshot.tables.practiceAttempts.push({
    id: pending.practiceAttemptId,
    studyItemId: item.studyItem.id,
    modeId: envelope.session.modeId,
    sessionId: envelope.session.id,
    direction: 'meaning-to-spelling',
    promptText: item.wordEntry.meaning,
    response: pending.response,
    inputMatchedAnswer: pending.inputMatchedAnswer,
    answerWasHidden: pending.answerWasHidden,
    hintUsed: pending.hintUsed,
    answerRevealed: pending.answerRevealed,
    assessmentType: pending.assessmentType,
    assessmentPolicyVersion: pending.assessmentPolicyVersion,
    assessmentStage: pending.assessmentStage,
    priorExposure: pending.priorExposure,
    explicitNotRemembered: pending.explicitNotRemembered,
    abandoned,
    occurredAt: now,
    requestFingerprint: JSON.stringify([
      pending.practiceAttemptId,
      item.studyItem.id,
      envelope.session.id,
      now,
    ]),
  });
}

function completeCurrentItem(session, status, now) {
  const queue = session.queue.map((item, index) =>
    index === session.currentIndex ? { ...item, status } : item);
  const later = queue.findIndex(
    (item, index) => index > session.currentIndex && item.status === 'pending',
  );
  const nextIndex = later >= 0
    ? later
    : queue.findIndex((item) => item.status === 'pending');
  const next = nextIndex >= 0 ? queue[nextIndex] : undefined;
  session.queue = queue;
  session.pendingAnswer = null;
  session.status = next ? session.status : 'completed';
  session.currentIndex = next ? nextIndex : session.currentIndex;
  session.currentStudyItemId = next?.studyItemId ?? null;
  session.updatedAt = now;
  session.completedAt = next ? null : now;
  session.endedReason = next ? undefined : 'completed';
}

function reviewCard(state) {
  return {
    cardId: state.cardId,
    stability: state.stability,
    stabilityFast: state.stabilityFast,
    difficulty: state.difficulty,
    dueAt: state.dueAt,
    lastReviewAt: state.lastReviewAt,
    state: state.state,
    scheduleStatus: state.scheduleStatus,
    reps: state.reps,
    lapses: state.lapses,
    scheduledDays: state.scheduledDays,
    learningStep: state.learningStep,
  };
}

function matchesWord(word, response) {
  const normalized = normalize(response);
  return normalized.length > 0
    && [word.term, ...word.acceptedAnswers].some(
      (value) => normalize(value) === normalized,
    );
}

function normalize(value) {
  return String(value).trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function currentTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function parseLimit(value, maximum) {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new CliError(
      'CLI_NUMBER_INVALID',
      `队列上限必须是 0 到 ${maximum} 的整数`,
    );
  }
  return parsed;
}
