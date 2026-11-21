import { parseCommandArgs } from '../args.mjs';
import { AccountApiClient } from '../api.mjs';
import { loadAccountConfig, resolveRuntimeConfig } from '../config.mjs';
import { CliError } from '../errors.mjs';
import { createId } from '../id.mjs';
import { runLocalLearn } from '../local/commands.mjs';

const RATINGS = new Map([
  ['1', 'again'],
  ['again', 'again'],
  ['2', 'hard'],
  ['hard', 'hard'],
  ['3', 'good'],
  ['good', 'good'],
  ['4', 'easy'],
  ['easy', 'easy'],
]);

export async function runLearn({ global, words, terminal }) {
  const { options } = parseCommandArgs(words, {
    values: ['session', 'learning-mode', 'new-limit', 'review-limit'],
    flags: ['resume'],
    positionals: 0,
  });
  const runtime = resolveRuntimeConfig(global);
  if (runtime.mode === 'local') {
    await runLocalLearn({ runtime, options, terminal });
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
  const adapter = await OnlinePracticeAdapter.open(api, options);
  await runPracticeLoop(adapter, terminal);
}

export async function runPracticeLoop(adapter, terminal) {
  let paused = false;
  let interrupted = false;
  const handleInterrupt = () => {
    interrupted = true;
    terminal.close();
  };
  process.once('SIGINT', handleInterrupt);
  try {
    if (terminal.json) {
      terminal.printJson(await adapter.snapshotForMachine());
    }
    await printCurrentCard(adapter, terminal);
    while (true) {
      if (adapter.session.session.status === 'completed') {
        break;
      }
      if (interrupted) {
        await adapter.pause();
        paused = true;
        break;
      }
      const input = await terminal.question('> ');
      if (input === undefined || interrupted) {
        await adapter.pause();
        paused = true;
        break;
      }
      const command = input.trim();
      if (command.length === 0) {
        continue;
      }
      if (command === '/pause' || command === 'pause' || command === '/quit') {
        await adapter.pause();
        paused = true;
        terminal.write(
          adapter.mode === 'local'
            ? '本地会话已保存，可运行 fm learn --resume 恢复。'
            : '账号会话已暂停，可运行 fm --mode account learn --resume 恢复。',
        );
        break;
      }
      if (command === '/help' || command === 'help') {
        printHelp(terminal, adapter);
        continue;
      }
      if (command === '/status' || command === 'status') {
        printStatus(adapter, terminal);
        continue;
      }
      if (command === '/hint' || command === 'hint' || command === '?') {
        adapter.showHint(terminal);
        continue;
      }
      if (command === '/reveal' || command === 'reveal') {
        adapter.revealAnswer(terminal);
        continue;
      }
      if (command === '/skip' || command === 'skip') {
        await adapter.completePractice({ outcome: 'skipped' });
        if (await afterMutation(adapter, terminal)) {
          break;
        }
        continue;
      }
      if (adapter.pending) {
        const rating = RATINGS.get(command.toLowerCase());
        if (rating === undefined) {
          terminal.write('请选择评分：1 Again / 2 Hard / 3 Good / 4 Easy。');
          continue;
        }
        if (adapter.notRemembered && rating !== 'again') {
          terminal.write('本张卡已明确表示没想起，只能记为 Again。');
          continue;
        }
        const result = await adapter.rate(rating);
        if (!terminal.json) {
          terminal.event('REVIEWED', {
            rating,
            dueAt: new Date(result.dueAt).toISOString(),
          });
        }
        if (await afterMutation(adapter, terminal)) {
          break;
        }
        continue;
      }
      if (adapter.session.session.modeId === 'flashcard') {
        if (command === '/flip' || command === 'flip') {
          const result = await adapter.beginFlashcard(false);
          printPendingAnswer(adapter, result, terminal);
          continue;
        }
        if (command === '/again' || command === 'n' || command === 'again') {
          const result = await adapter.beginFlashcard(true);
          printPendingAnswer(adapter, result, terminal);
          continue;
        }
        terminal.write('闪卡模式请先 flip；若没想起可输入 again。');
        continue;
      }
      if (adapter.revealed || adapter.hintUsed) {
        if (command === '/done' || command === 'done') {
          await adapter.completePractice({ outcome: 'completed', response: command });
          if (await afterMutation(adapter, terminal)) {
            break;
          }
          continue;
        }
        terminal.write('提示或答案揭晓后不会写入正式复习；输入 done 完成练习。');
        continue;
      }
      const result = await adapter.beginTyped(command);
      printPendingAnswer(adapter, result, terminal);
    }
  } finally {
    process.off('SIGINT', handleInterrupt);
    if (!paused && adapter.session?.session.status === 'active') {
      await adapter.pause().catch(() => {});
    }
    terminal.close();
  }
}

class OnlinePracticeAdapter {
  constructor(api, envelope) {
    this.api = api;
    this.mode = 'account';
    this.session = envelope;
    this.pending = envelope.session.pendingAnswer ?? null;
    this.previews = undefined;
    this.notRemembered = false;
    this.hintIndex = 0;
    this.hintUsed = false;
    this.revealed = false;
  }

  static async open(api, options) {
    let envelope;
    if (options.session) {
      envelope = await api.getSession(options.session);
    } else if (options.resume) {
      const active = await api.listActiveSessions();
      envelope = active.sessions.find(
        (candidate) => candidate.session.status !== 'completed',
      );
      if (!envelope) {
        throw new CliError('CLI_SESSION_NOT_FOUND', '没有可恢复的账号学习会话');
      }
    } else {
      envelope = await api.createSession({
        modeId: options['learning-mode'] ?? 'keyboard-recall',
        timeZone: currentTimeZone(),
        newLimit: parseOptionalInteger(options['new-limit'], '--new-limit', 100),
        reviewLimit: parseOptionalInteger(
          options['review-limit'],
          '--review-limit',
          500,
        ),
        reduceMotion: true,
      });
    }
    if (envelope.session.status === 'paused') {
      envelope = await api.updateSession({
        sessionId: envelope.session.id,
        expectedDataVersion: envelope.dataVersion,
        expectedVersion: envelope.session.version,
        status: 'active',
      });
    }
    return OnlinePracticeAdapter.fromEnvelope(api, envelope);
  }

  static async fromEnvelope(api, envelope) {
    const adapter = new OnlinePracticeAdapter(api, envelope);
    if (adapter.pending) {
      adapter.previews = await adapter.loadPreviews();
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
    const ids = this.newAttemptIds();
    const result = await this.api.submitPracticeResponse({
      sessionId: this.session.session.id,
      body: {
        practiceAttemptId: ids.practiceAttemptId,
        reviewSubmissionId: ids.reviewSubmissionId,
        studyItemId: item.studyItem.id,
        response,
        answerWasHidden: true,
        hintUsed: false,
        answerRevealed: false,
        assessmentType: 'typed-recall',
        assessmentPolicyVersion: 2,
        assessmentStage: 'attempt',
        priorExposure: false,
        explicitNotRemembered: false,
        abandoned: false,
        expectedDataVersion: this.session.dataVersion,
        expectedSessionVersion: this.session.session.version,
      },
    });
    this.session = {
      ...this.session,
      session: result.session,
      dataVersion: result.dataVersion,
    };
    this.pending = result.pendingAnswer;
    this.previews = await this.loadPreviews();
    return result.pendingAnswer;
  }

  async beginFlashcard(notRemembered) {
    const item = this.currentItem;
    const ids = this.newAttemptIds();
    const result = await this.api.submitPracticeResponse({
      sessionId: this.session.session.id,
      body: {
        practiceAttemptId: ids.practiceAttemptId,
        reviewSubmissionId: ids.reviewSubmissionId,
        studyItemId: item.studyItem.id,
        response: '',
        answerWasHidden: true,
        hintUsed: false,
        answerRevealed: true,
        assessmentType: 'flashcard-self-report',
        assessmentPolicyVersion: 2,
        assessmentStage: 'reveal-for-check',
        priorExposure: false,
        explicitNotRemembered: notRemembered,
        abandoned: false,
        expectedDataVersion: this.session.dataVersion,
        expectedSessionVersion: this.session.session.version,
      },
    });
    this.session = {
      ...this.session,
      session: result.session,
      dataVersion: result.dataVersion,
    };
    this.pending = result.pendingAnswer;
    this.notRemembered = notRemembered;
    this.revealed = true;
    this.previews = await this.loadPreviews();
    return result.pendingAnswer;
  }

  async loadPreviews() {
    const pending = this.pending ?? this.session.session.pendingAnswer;
    const item = this.currentItem;
    if (!pending || !item) {
      return undefined;
    }
    return this.api.previewReview({
      sessionId: this.session.session.id,
      body: {
        studyItemId: pending.studyItemId,
        expectedDataVersion: this.session.dataVersion,
        expectedSessionVersion: this.session.session.version,
        expectedReviewVersion: item.reviewVersion,
      },
    });
  }

  async rate(rating) {
    const pending = this.pending;
    const previews = this.previews;
    await this.api.submitReview({
      sessionId: this.session.session.id,
      submissionId: pending.reviewSubmissionId,
      body: {
        rating,
        expectedDataVersion: previews.dataVersion,
        expectedReviewVersion: previews.reviewVersion,
        expectedSessionVersion: previews.sessionVersion,
        evidence: {
          userConfirmedRating: true,
          answerWasHidden: pending.answerWasHidden,
          hintUsed: pending.hintUsed,
          answerRevealed: pending.answerRevealed,
          assessmentType: pending.assessmentType,
          assessmentPolicyVersion: pending.assessmentPolicyVersion,
          assessmentStage: pending.assessmentStage,
          priorExposure: pending.priorExposure,
          explicitNotRemembered: pending.explicitNotRemembered,
          abandoned: false,
        },
      },
    });
    const dueAt = previews.previews[rating].dueAt;
    this.session = await this.api.getSession(this.session.session.id);
    this.resetItemState();
    return { dueAt };
  }

  async completePractice({ outcome, response = '' }) {
    const item = this.currentItem;
    const ids = this.newAttemptIds();
    await this.api.completePractice({
      sessionId: this.session.session.id,
      body: {
        practiceAttemptId: ids.practiceAttemptId,
        studyItemId: item.studyItem.id,
        response,
        answerWasHidden: !this.revealed,
        hintUsed: this.hintUsed,
        answerRevealed: this.revealed,
        assessmentType: 'guided-practice',
        assessmentPolicyVersion: 2,
        assessmentStage: this.revealed ? 'reveal-for-check' : 'attempt',
        priorExposure: true,
        explicitNotRemembered: false,
        abandoned: outcome === 'skipped',
        outcome,
        expectedDataVersion: this.session.dataVersion,
        expectedSessionVersion: this.session.session.version,
      },
    });
    this.session = await this.api.getSession(this.session.session.id);
    this.resetItemState();
  }

  async pause() {
    if (this.session.session.status !== 'active') {
      return;
    }
    this.session = await this.api.updateSession({
      sessionId: this.session.session.id,
      expectedDataVersion: this.session.dataVersion,
      expectedVersion: this.session.session.version,
      status: 'paused',
    });
  }

  async snapshotForMachine() {
    return {
      mode: 'account',
      sessionId: this.session.session.id,
      status: this.session.session.status,
      currentStudyItemId: this.session.session.currentStudyItemId,
      queueLength: this.session.session.queue.length,
      dataVersion: this.session.dataVersion,
    };
  }

  newAttemptIds() {
    return {
      practiceAttemptId: createId('practice'),
      reviewSubmissionId: createId('review'),
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
}

async function afterMutation(adapter, terminal) {
  if (adapter.session.session.status === 'completed') {
    if (terminal.json) {
      terminal.printJson(await adapter.snapshotForMachine());
    } else {
      terminal.event('SESSION_COMPLETED', {
        sessionId: adapter.session.session.id,
      });
    }
    return true;
  }
  await printCurrentCard(adapter, terminal);
  return false;
}

async function printCurrentCard(adapter, terminal) {
  if (terminal.json) {
    return;
  }
  if (adapter.session.session.status === 'completed') {
    terminal.event('SESSION_COMPLETED', {
      sessionId: adapter.session.session.id,
    });
    return;
  }
  const item = adapter.currentItem;
  if (!item) {
    terminal.event('SESSION_WAITING', {
      sessionId: adapter.session.session.id,
    });
    return;
  }
  const completed = adapter.session.session.queue.filter(
    (entry) => entry.status !== 'pending',
  ).length;
  terminal.event('CARD', {
    position: `${completed + 1}/${adapter.session.session.queue.length}`,
    mode: adapter.modeName,
    sessionId: adapter.session.session.id,
    source: adapter.session.session.queue[adapter.session.session.currentIndex]?.source,
  });
  terminal.event('MEANING', { text: item.wordEntry.meaning });
  if (adapter.pending) {
    printPendingAnswer(adapter, adapter.pending, terminal);
  }
}

function printPendingAnswer(adapter, pending, terminal) {
  if (terminal.json) {
    return;
  }
  const item = adapter.currentItem;
  terminal.event('ANSWER', {
    term: item.wordEntry.term,
    meaning: item.wordEntry.meaning,
  });
  terminal.event('MATCH', { value: pending.inputMatchedAnswer });
  for (const rating of ['again', 'hard', 'good', 'easy']) {
    terminal.event('RATING', {
      key: ratingKey(rating),
      rating,
      dueAt: adapter.previews
        ? new Date(adapter.previews.previews[rating].dueAt).toISOString()
        : '-',
    });
  }
}

function printStatus(adapter, terminal) {
  terminal.event('STATUS', {
    mode: adapter.mode,
    session: adapter.session.session.id,
    state: adapter.session.session.status,
    pending: adapter.pending !== null,
    hintUsed: adapter.hintUsed,
    revealed: adapter.revealed,
    dataVersion: adapter.session.dataVersion,
    sessionVersion: adapter.session.session.version
      ?? adapter.session.session.updatedAt,
  });
}

function printHelp(terminal, adapter) {
  terminal.write('命令：hint 提示 · reveal 揭晓 · skip 跳过 · pause 暂停退出');
  if (adapter.session.session.modeId === 'flashcard') {
    terminal.write('闪卡：flip 翻面 · again 没想起（只允许 Again）');
  } else {
    terminal.write('拼写：直接输入英文答案；提示/揭晓后输入 done 完成练习');
  }
  terminal.write('评分：1 Again · 2 Hard · 3 Good · 4 Easy');
}

function ratingKey(rating) {
  return { again: '1', hard: '2', good: '3', easy: '4' }[rating];
}

function currentTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function parseOptionalInteger(value, option, maximum) {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new CliError(
      'CLI_NUMBER_INVALID',
      `${option} 需要 0 到 ${maximum} 的整数`,
    );
  }
  return parsed;
}

export { RATINGS, currentTimeZone };
export { OnlinePracticeAdapter };
