import { randomUUID } from 'node:crypto';
import { parseCommandArgs } from '../args.mjs';
import { AccountApiClient } from '../api.mjs';
import { BATTLE_CARDS } from '../battleCatalog.mjs';
import { loadAccountConfig, resolveRuntimeConfig } from '../config.mjs';
import { BattleCheckpointStore } from '../battleCheckpoint.mjs';
import { CliError } from '../errors.mjs';
import { createId } from '../id.mjs';
import { OnlinePracticeAdapter, RATINGS } from './learn.mjs';

export async function runBattle({ global, words, terminal }) {
  if (words[0] === 'list') {
    if (resolveRuntimeConfig(global).mode === 'local') {
      throw new CliError(
        'CLI_LOCAL_BATTLE_UNSUPPORTED',
        '文字卡牌战斗只使用账号共享检查点',
      );
    }
    const runtime = resolveRuntimeConfig({ ...global, mode: 'account' });
    const config = await loadAccountConfig(runtime);
    if (!config.token) {
      throw new CliError(
        'CLI_TOKEN_MISSING',
        '账号模式尚未配置令牌，请先运行 fm --mode account auth login',
      );
    }
    const { options } = parseCommandArgs(words.slice(1), {
      values: ['limit'],
      positionals: 0,
    });
    const limit = options.limit === undefined ? 20 : Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new CliError('CLI_NUMBER_INVALID', '--limit 必须在 1 到 50 之间');
    }
    const battles = await new AccountApiClient(config).listActiveBattles(limit);
    if (terminal.json) {
      terminal.printJson(battles);
      return;
    }
    if (battles.length === 0) {
      terminal.write('没有仍在进行的文字卡牌战斗。');
      return;
    }
    battles.forEach((battle, index) => {
      terminal.event('BATTLE_CHECKPOINT', {
        index: index + 1,
        id: battle.battle.battleId,
        phase: battle.battle.phase,
        turn: battle.battle.turnId,
        stateVersion: battle.stateVersion,
        session: battle.battle.learningTask?.sessionId,
      });
    });
    return;
  }
  const { options } = parseCommandArgs(words, {
    values: [
      'battle',
      'session',
      'study-item',
      'encounter',
      'companion',
      'seed',
    ],
    flags: ['shuffle', 'resume'],
    positionals: 0,
  });
  if (resolveRuntimeConfig(global).mode === 'local') {
    throw new CliError(
      'CLI_LOCAL_BATTLE_UNSUPPORTED',
      '文字卡牌战斗使用账号共享检查点；本地模式请使用 fm learn',
    );
  }
  const runtime = resolveRuntimeConfig({ ...global, mode: 'account' });
  const config = await loadAccountConfig(runtime);
  if (!config.token) {
    throw new CliError(
      'CLI_TOKEN_MISSING',
      '账号模式尚未配置令牌，请先运行 fm --mode account auth login',
    );
  }
  const api = new AccountApiClient(config);
  const controller = new BattleController(
    api,
    await openBattle(api, options),
    terminal,
    new BattleCheckpointStore(runtime),
  );
  await controller.run();
}

export class BattleController {
  constructor(api, envelope, terminal, checkpoints, options = {}) {
    this.api = api;
    this.envelope = envelope;
    this.terminal = terminal;
    this.checkpoints = checkpoints;
    this.closeTerminal = options.closeTerminal ?? true;
  }

  get battle() {
    return this.envelope.battle;
  }

  async run() {
    try {
      while (true) {
        if (this.battle.phase === 'learning') {
          await this.runLearningPhase();
          continue;
        }
        if (this.battle.phase === 'player-action') {
          const action = await this.runPlayerPhase();
          if (action === 'exit') {
            return 'exit';
          }
          continue;
        }
        printBattleState(this.envelope, this.terminal);
        this.terminal.write(
          this.battle.phase === 'victory'
            ? '战斗胜利。账号检查点已保存在服务端。'
            : '战斗失败，需要救援。账号检查点已保存在服务端。',
        );
        if (this.terminal.json) {
          this.terminal.printJson(this.envelope);
        }
        return this.battle.phase;
      }
    } finally {
      if (this.closeTerminal) {
        this.terminal.close();
      }
    }
  }

  async runLearningPhase() {
    const task = this.battle.learningTask;
    if (!task) {
      throw new CliError('BATTLE_LEARNING_TASK_MISSING', '战斗缺少学习任务');
    }
    const session = await this.api.getSession(task.sessionId);
    const savedCheckpoint = await this.checkpoints.get(this.battle.battleId);
    if (savedCheckpoint && session.session.pendingAnswer === null) {
      const recovered = await this.claimLearning(
        savedCheckpoint.actionId,
        savedCheckpoint.submissionId,
      );
      await this.checkpoints.clear(this.battle.battleId);
      this.envelope = recovered;
      this.terminal.event('LEARNING_CLAIM_RECOVERED', {
        battleId: this.battle.battleId,
      });
      return;
    }
    const adapter = await OnlinePracticeAdapter.fromEnvelope(this.api, session);
    const item = adapter.currentItem;
    if (!item) {
      throw new CliError('BATTLE_STUDY_ITEM_MISSING', '学习会话没有当前词条');
    }
    this.terminal.event('BATTLE_LEARNING', {
      phase: this.battle.phase,
      energy: this.battle.energy,
      meaning: item.wordEntry.meaning,
      mode: session.session.modeId,
    });
    let reviewedSubmissionId;
    let claimActionId = savedCheckpoint?.actionId;
    let lastRating;
    while (true) {
      if (adapter.pending) {
        for (const rating of ['again', 'hard', 'good', 'easy']) {
          this.terminal.event('RATING', {
            key: ratingKey(rating),
            rating,
            dueAt: adapter.previews
              ? new Date(adapter.previews.previews[rating].dueAt).toISOString()
              : '-',
          });
        }
        const input = await this.readInput('评分 1-4：');
        if (input === 'pause' || input === '/pause' || input === 'quit') {
          throw new CliError('CLI_BATTLE_PAUSED', '战斗检查点已保留，可重新运行 fm battle --battle <id>');
        }
        const rating = RATINGS.get(input.toLowerCase());
        if (!rating) {
          this.terminal.write('请选择评分：1 Again / 2 Hard / 3 Good / 4 Easy。');
          continue;
        }
        if (adapter.notRemembered && rating !== 'again') {
          this.terminal.write('已明确表示没想起，只能记为 Again。');
          continue;
        }
        reviewedSubmissionId = adapter.pending.reviewSubmissionId;
        claimActionId ??= createId('battle_claim');
        await this.checkpoints.set(this.battle.battleId, {
          actionId: claimActionId,
          submissionId: reviewedSubmissionId,
          sessionId: session.session.id,
          studyItemId: task.studyItemId,
          createdAtMs: Date.now(),
        });
        await adapter.rate(rating);
        lastRating = rating;
        break;
      }

      if (session.session.modeId === 'flashcard') {
        const input = await this.readInput('flip / again：');
        if (input === 'pause' || input === '/pause' || input === 'quit') {
          throw new CliError('CLI_BATTLE_PAUSED', '战斗检查点已保留，可重新运行 fm battle --battle <id>');
        }
        if (input === 'flip') {
          await adapter.beginFlashcard(false);
          continue;
        }
        if (input === 'again' || input === 'n') {
          await adapter.beginFlashcard(true);
          continue;
        }
        this.terminal.write('先输入 flip 翻面；若没想起可输入 again。');
        continue;
      }

      const answer = await this.readInput('英文拼写：');
      if (answer === 'pause' || answer === '/pause' || answer === 'quit') {
        throw new CliError('CLI_BATTLE_PAUSED', '战斗检查点已保留，可重新运行 fm battle --battle <id>');
      }
      if (answer.trim().length === 0) {
        continue;
      }
      await adapter.beginTyped(answer.trim());
    }

    const claimed = await this.claimLearning(claimActionId, reviewedSubmissionId);
    await this.checkpoints.clear(this.battle.battleId);
    this.envelope = claimed;
    this.terminal.event('LEARNING_CLAIMED', {
      rating: lastRating,
      energy: this.battle.energy,
    });
  }

  async runPlayerPhase() {
    printBattleState(this.envelope, this.terminal);
    while (true) {
      const input = (await this.readInput('战斗命令：')).trim();
      if (input === 'pause' || input === '/pause' || input === 'quit') {
        this.terminal.write('战斗检查点已保留，可重新运行 fm battle --battle <id>。');
        return 'exit';
      }
      if (input === 'help' || input === '/help') {
        this.terminal.write('play N [目标] · skill · end · status · pause');
        continue;
      }
      if (input === 'status' || input === '/status') {
        printBattleState(this.envelope, this.terminal);
        continue;
      }
      if (input.startsWith('play ')) {
        await this.play(input);
        if (this.battle.phase !== 'player-action') {
          return 'continue';
        }
        continue;
      }
      if (input === 'skill') {
        if (this.battle.companion?.skillUsed) {
          this.terminal.write('伙伴技能本场已经使用。');
          continue;
        }
        this.envelope = await this.api.useBattleCompanionSkill({
          battleId: this.battle.battleId,
          actionId: createId('battle_skill'),
          body: { expectedStateVersion: this.battle.stateVersion },
        });
        this.terminal.event('COMPANION_SKILL', { key: this.battle.companion?.key });
        printBattleState(this.envelope, this.terminal);
        continue;
      }
      if (input === 'end') {
        await this.endTurn();
        return 'continue';
      }
      this.terminal.write('未知战斗命令；输入 help 查看可用命令。');
    }
  }

  async play(input) {
    const match = /^play\s+(\d+)(?:\s+(\d+))?$/i.exec(input);
    if (!match) {
      this.terminal.write('格式：play 手牌编号 [目标编号]');
      return;
    }
    const handIndex = Number(match[1]) - 1;
    const card = this.battle.hand[handIndex];
    if (!card) {
      this.terminal.write('手牌编号不存在。');
      return;
    }
    const definition = BATTLE_CARDS[card.definitionId];
    if (!definition) {
      throw new CliError('BATTLE_CARD_UNKNOWN', `未知卡牌 ${card.definitionId}`);
    }
    if (this.battle.energy < definition.cost) {
      this.terminal.write(`能量不足：需要 ${definition.cost}，当前 ${this.battle.energy}。`);
      return;
    }
    let targetId;
    if (definition.target === 'enemy') {
      const enemies = this.battle.enemies.filter((enemy) => enemy.hp > 0);
      const targetIndex = match[2] === undefined ? 0 : Number(match[2]) - 1;
      const target = enemies[targetIndex];
      if (!target) {
        this.terminal.write('目标编号不存在。');
        return;
      }
      targetId = target.id;
    }
    this.envelope = await this.api.playBattleCard({
      battleId: this.battle.battleId,
      actionId: createId('battle_card'),
      body: {
        expectedStateVersion: this.battle.stateVersion,
        cardInstanceId: card.instanceId,
        targetId,
      },
    });
    this.terminal.event('CARD_PLAYED', {
      name: definition.name,
      stateVersion: this.envelope.stateVersion,
    });
    printBattleState(this.envelope, this.terminal);
  }

  async endTurn() {
    const task = this.battle.learningTask;
    if (!task) {
      throw new CliError('BATTLE_LEARNING_TASK_MISSING', '战斗缺少下一学习任务');
    }
    const session = await this.api.getSession(task.sessionId);
    const nextStudyItemId = session.session.currentStudyItemId;
    if (!nextStudyItemId) {
      throw new CliError(
        'BATTLE_NEXT_STUDY_ITEM_MISSING',
        '学习会话没有下一目标，无法继续下一回合',
      );
    }
    this.envelope = await this.api.endBattleTurn({
      battleId: this.battle.battleId,
      actionId: createId('battle_turn'),
      body: {
        expectedStateVersion: this.battle.stateVersion,
        nextSessionId: session.session.id,
        nextStudyItemId,
      },
    });
    this.terminal.event('TURN_ENDED', {
      phase: this.battle.phase,
      turn: this.battle.turnId,
    });
  }

  async readInput(prompt) {
    const input = await this.terminal.question(prompt);
    if (input === undefined) {
      throw new CliError('CLI_BATTLE_PAUSED', '战斗检查点已保留');
    }
    return input.trim();
  }

  async claimLearning(actionId, submissionId) {
    return this.api.claimBattleLearning({
      battleId: this.battle.battleId,
      actionId,
      body: {
        expectedStateVersion: this.battle.stateVersion,
        submissionId,
      },
    });
  }
}

async function openBattle(api, options) {
  if (options.battle) {
    return api.getBattle(options.battle);
  }
  if (options.resume) {
    const battles = await api.listActiveBattles(20);
    if (battles.length === 0) {
      throw new CliError('CLI_BATTLE_NOT_FOUND', '没有可恢复的文字卡牌战斗');
    }
    return battles[0];
  }
  if (!options.session || !options['study-item']) {
    throw new CliError(
      'CLI_BATTLE_ARGS_REQUIRED',
      '开始战斗需要 --session 和 --study-item，或用 --battle 恢复',
    );
  }
  const seed = options.seed === undefined ? 42 : Number(options.seed);
  if (!Number.isSafeInteger(seed)) {
    throw new CliError('CLI_BATTLE_SEED_INVALID', '--seed 需要安全整数');
  }
  return api.createBattle({
    actionId: createId('battle_create'),
    body: {
      battleId: randomUUID(),
      encounterId: options.encounter ?? 'cli-training',
      sessionId: options.session,
      studyItemId: options['study-item'],
      companionKey: options.companion ?? 'lia',
      seed,
      shuffle: Boolean(options.shuffle),
    },
  });
}

function printBattleState(envelope, terminal) {
  const battle = envelope.battle;
  if (terminal.json) {
    terminal.printJson(envelope);
    return;
  }
  terminal.event('BATTLE', {
    id: battle.battleId,
    phase: battle.phase,
    turn: battle.turnId,
    stateVersion: battle.stateVersion,
  });
  terminal.event('PARTY', {
    hp: `${battle.party.hp}/${battle.party.maxHp}`,
    block: battle.party.block,
    energy: battle.energy,
  });
  battle.enemies.forEach((enemy, index) => {
    terminal.event('ENEMY', {
      index: index + 1,
      id: enemy.id,
      hp: `${enemy.hp}/${enemy.maxHp}`,
      block: enemy.block,
      burn: enemy.burn
        ? `${enemy.burn.remainingTurns}回合/${enemy.burn.damagePerTurn}`
        : '-',
    });
  });
  terminal.event('INTENT', {
    target: battle.currentIntent.enemyId,
    action: battle.currentIntent.type === 'attack' ? '攻击' : '格挡',
    value: battle.currentIntent.value,
  });
  battle.hand.forEach((card, index) => {
    const definition = BATTLE_CARDS[card.definitionId];
    terminal.event('HAND', {
      index: index + 1,
      id: definition?.name ?? card.definitionId,
      cost: definition?.cost ?? '?',
      effect: definition?.effect ?? '未知',
      target: definition?.target ?? '?',
    });
  });
  if (battle.companion) {
    terminal.event('COMPANION', {
      key: battle.companion.key,
      skill: battle.companion.skillName ?? '协助',
      used: battle.companion.skillUsed,
    });
  }
}

function ratingKey(rating) {
  return { again: '1', hard: '2', good: '3', easy: '4' }[rating];
}
