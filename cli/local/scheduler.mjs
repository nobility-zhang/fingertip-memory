import {
  DefaultScheduler,
  Rating,
  State,
} from 'ts-fsrs';

const PACKAGE_VERSION = '6.0.0';

let schedulerPromise;

export async function createLocalScheduler() {
  schedulerPromise ??= DefaultScheduler({
    version: 'FSRS-7',
    desiredRetention: 0.9,
    enableFuzz: false,
    enableShortTerm: true,
    learningSteps: ['1m', '10m'],
    relearningSteps: ['10m'],
    graduatingInterval: 1,
    allowModelOverride: true,
  }).catch((error) => {
    schedulerPromise = undefined;
    throw error;
  });
  const scheduler = await schedulerPromise;
  return new SchedulerAdapter(scheduler);
}

class SchedulerAdapter {
  constructor(scheduler) {
    this.scheduler = scheduler;
    this.packageVersion = PACKAGE_VERSION;
  }

  get modelVersion() {
    return this.scheduler.definition.model.name;
  }

  get config() {
    const config = this.scheduler.config;
    return {
      packageVersion: PACKAGE_VERSION,
      modelVersion: this.scheduler.definition.model.name,
      weights: Array.from(config.weights),
      fractionalDays: config.fractionalDays,
      desiredRetention: Object.fromEntries(
        Object.entries(config.desiredRetention).map(([key, value]) => [
          key,
          Number(value),
        ]),
      ),
      enableFuzz: config.enableFuzz,
      maximumInterval: config.maximumInterval,
      clearStatsOnForget: config.clearStatsOnForget,
      enableShortTerm: config.enableShortTerm,
      learningSteps: Array.from(config.learningSteps),
      relearningSteps: Array.from(config.relearningSteps),
      graduatingInterval: config.graduatingInterval,
      allowModelOverride: config.allowModelOverride,
    };
  }

  createCard(cardId, now) {
    return toCardSnapshot(this.scheduler.newCard({
      cardId,
      now: new Date(assertTimestamp(now, 'now')),
    }));
  }

  review(card, rating, now) {
    const result = this.scheduler.review({
      card: toLibraryCard(card),
      grade: toGrade(rating),
      now: new Date(assertTimestamp(now, 'review time')),
    });
    return {
      card: toCardSnapshot(result.card),
      revlog: toRevlogSnapshot(result.revlog),
    };
  }
}

function toCardSnapshot(card) {
  return {
    cardId: String(card.cardId),
    stability: card.stability,
    stabilityFast: card.stabilityFast,
    difficulty: card.difficulty,
    dueAt: card.dueAt.getTime(),
    lastReviewAt: card.lastReviewAt?.getTime() ?? null,
    state: lifecycleState(card.state),
    scheduleStatus: card.scheduleStatus,
    reps: card.reps,
    lapses: card.lapses,
    scheduledDays: card.scheduledDays,
    learningStep: card.learningStep,
  };
}

function toLibraryCard(card) {
  return {
    cardId: card.cardId,
    stability: card.stability,
    stabilityFast: card.stabilityFast,
    difficulty: card.difficulty,
    dueAt: new Date(card.dueAt),
    lastReviewAt: card.lastReviewAt === null
      ? null
      : new Date(card.lastReviewAt),
    state: libraryState(card.state),
    scheduleStatus: card.scheduleStatus,
    reps: card.reps,
    lapses: card.lapses,
    scheduledDays: card.scheduledDays,
    learningStep: card.learningStep,
  };
}

function toRevlogSnapshot(revlog) {
  return {
    cardId: String(revlog.cardId),
    rating: ratingName(revlog.rating),
    stability: revlog.stability,
    stabilityFast: revlog.stabilityFast,
    difficulty: revlog.difficulty,
    dueAt: revlog.dueAt.getTime(),
    lastReviewAt: revlog.lastReviewAt?.getTime() ?? null,
    reviewTime: revlog.reviewTime.getTime(),
    state: lifecycleState(revlog.state),
    scheduleStatus: revlog.scheduleStatus,
    scheduledDays: revlog.scheduledDays,
    learningStep: revlog.learningStep,
  };
}

function toGrade(rating) {
  return {
    again: Rating.Again,
    hard: Rating.Hard,
    good: Rating.Good,
    easy: Rating.Easy,
  }[rating];
}

function ratingName(rating) {
  return {
    [Rating.Again]: 'again',
    [Rating.Hard]: 'hard',
    [Rating.Good]: 'good',
    [Rating.Easy]: 'easy',
  }[rating];
}

function lifecycleState(state) {
  return {
    [State.New]: 'new',
    [State.Learning]: 'learning',
    [State.Review]: 'review',
    [State.Relearning]: 'relearning',
  }[state];
}

function libraryState(state) {
  return {
    new: State.New,
    learning: State.Learning,
    review: State.Review,
    relearning: State.Relearning,
  }[state];
}

function assertTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive timestamp`);
  }
  return value;
}
