import { parseCommandArgs } from '../args.mjs';
import { AccountApiClient } from '../api.mjs';
import { AdventureCheckpointStore } from '../adventureCheckpoint.mjs';
import { BattleCheckpointStore } from '../battleCheckpoint.mjs';
import { loadAccountConfig, resolveRuntimeConfig } from '../config.mjs';
import { CliError } from '../errors.mjs';
import { createId } from '../id.mjs';
import { BattleController } from './battle.mjs';

export async function runAdventure({ global, words, terminal }) {
  if (resolveRuntimeConfig(global).mode === 'local') {
    throw new CliError(
      'CLI_LOCAL_ADVENTURE_UNSUPPORTED',
      '冒险使用账号固定版本与共享检查点，请加 --mode account',
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
  const command = words[0];
  if (command === undefined || command === 'help') {
    printAdventureHelp(terminal);
    return;
  }
  if (command === 'books') {
    const { options } = parseCommandArgs(words.slice(1), {
      values: ['limit'],
      positionals: 0,
    });
    await listBooks(api, terminal, parseLimit(options.limit, 50));
    return;
  }
  if (command === 'list') {
    const { options } = parseCommandArgs(words.slice(1), {
      values: ['limit'],
      positionals: 0,
    });
    const runs = await api.listAdventures(parseLimit(options.limit, 50));
    if (terminal.json) {
      terminal.printJson(runs);
      return;
    }
    if (runs.length === 0) {
      terminal.write('当前没有进行中的冒险。运行 fm adventure books 查看已安装书籍。');
      return;
    }
    runs.forEach((run, index) => printRunSummary(run, index, terminal));
    return;
  }
  if (command === 'completions') {
    const { options } = parseCommandArgs(words.slice(1), {
      values: ['limit'],
      positionals: 0,
    });
    const completions = await api.listAdventureCompletions(
      parseLimit(options.limit, 100),
    );
    if (terminal.json) {
      terminal.printJson(completions);
      return;
    }
    if (completions.length === 0) {
      terminal.write('当前账号还没有结局完成回执。');
      return;
    }
    completions.forEach((completion, index) => {
      terminal.event('COMPLETION', {
        index: index + 1,
        id: completion.id,
        bookId: completion.bookId,
        version: completion.contentVersion,
        endingId: completion.endingId,
        endingTitle: completion.endingTitle,
      });
    });
    return;
  }
  if (command === 'show') {
    const { positional } = parseCommandArgs(words.slice(1), {
      positionals: 1,
    });
    const run = await resolveRun(api, positional[0]);
    if (terminal.json) {
      terminal.printJson(run);
    } else {
      printRun(run, terminal);
    }
    return;
  }
  if (command === 'start') {
    const { options } = parseCommandArgs(words.slice(1), {
      values: ['install', 'companion', 'source-completion'],
      positionals: 0,
    });
    const installations = await api.listContentPackages(50);
    const installationId = options.install
      ?? (installations.length === 1 ? installations[0].id : undefined);
    if (!installationId) {
      throw new CliError(
        'CLI_ADVENTURE_INSTALL_REQUIRED',
        installations.length === 0
          ? '账号没有已安装冒险，请先在 Web 内容书架安装 .fmbook'
          : '账号有多本已安装冒险，请用 --install 指定 installationId',
      );
    }
    const result = await api.startAdventure({
      actionId: createId('adventure_start'),
      installationId,
      companionKey: options.companion ?? 'lia',
      sourceCompletionId: options['source-completion'],
    });
    if (terminal.json) {
      terminal.printJson(result);
    } else {
      terminal.event('ADVENTURE_STARTED', {
        outcome: result.outcome,
        runId: result.run.id,
        node: result.run.currentNode.nodeId,
        version: result.run.runVersion,
      });
      printRun(result.run, terminal);
    }
    return;
  }
  if (command === 'resume' || command === 'run') {
    const { positional } = parseCommandArgs(words.slice(1), {
      positionals: 1,
    });
    const run = await resolveRun(api, positional[0]);
    if (terminal.json) {
      terminal.printJson(run);
      return;
    }
    const controller = new AdventureController({
      api,
      run,
      terminal,
      actions: new AdventureCheckpointStore(runtime),
      battleCheckpoints: new BattleCheckpointStore(runtime),
    });
    await controller.run();
    return;
  }
  if (command === 'upgrade') {
    const { options, positional } = parseCommandArgs(words.slice(1), {
      values: ['install'],
      positionals: 1,
    });
    const runId = positional[0];
    if (!runId || !options.install) {
      throw new CliError(
        'CLI_ARGUMENT_REQUIRED',
        '用法：fm adventure upgrade RUN_ID --install INSTALLATION_ID',
      );
    }
    const result = await api.upgradeAdventure({
      runId,
      installationId: options.install,
      actionId: createId('adventure_upgrade'),
    });
    if (terminal.json) {
      terminal.printJson(result);
    } else {
      terminal.event('ADVENTURE_UPGRADED', {
        runId: result.run.id,
        version: result.run.contentVersion,
        runVersion: result.run.runVersion,
        node: result.run.currentNode.nodeId,
      });
      printRun(result.run, terminal);
    }
    return;
  }
  throw new CliError('CLI_COMMAND_UNKNOWN', `未知 adventure 命令：${command}`);
}

export class AdventureController {
  constructor({
    api,
    run,
    terminal,
    actions,
    battleCheckpoints,
    createBattleController,
  }) {
    this.api = api;
    this.journey = run;
    this.terminal = terminal;
    this.actions = actions;
    this.battleCheckpoints = battleCheckpoints;
    this.createBattleController = createBattleController
      ?? ((envelope) => new BattleController(
        api,
        envelope,
        terminal,
        battleCheckpoints,
        { closeTerminal: false },
      ));
  }

  async run() {
    while (true) {
      if (this.journey.status === 'completed') {
        printRun(this.journey, this.terminal);
        this.terminal.write('冒险已经完成，检查点保存在服务端。');
        return;
      }
      printRun(this.journey, this.terminal);
      const input = await this.readInput('冒险命令：');
      if (input === undefined || input === 'pause' || input === '/pause') {
        this.terminal.write(
          `冒险已暂停；运行 fm adventure resume ${this.journey.id} 恢复。`,
        );
        return;
      }
      if (input === 'help' || input === '/help') {
        this.terminal.write(
          'next · choose N/ID · fight · resolve · reward N/ID · companion N/ID · complete · status · pause',
        );
        continue;
      }
      if (input === 'status' || input === '/status') {
        continue;
      }
      if (input === 'refresh') {
        await this.refresh();
        continue;
      }
      if (this.journey.rewardOffer) {
        await this.claimReward(input, this.journey.rewardOffer.choices);
        continue;
      }
      const node = this.journey.currentNode;
      if (node.type === 'choice') {
        await this.choose(input, node.choices);
        continue;
      }
      if (node.type === 'encounter') {
        if (input === 'fight' || input === 'battle' || input === 'resume') {
          const outcome = await this.playEncounter();
          if (outcome === 'pause') {
            return;
          }
          continue;
        }
        if (input === 'resolve') {
          await this.resolveEncounter();
          continue;
        }
        if (input === 'next' || input === '') {
          this.terminal.write(
            this.journey.battleId
              ? '当前遭遇已有战斗检查点；输入 fight 恢复。'
              : '当前节点是遭遇；输入 fight 开始战斗。',
          );
          continue;
        }
        this.terminal.write('遭遇节点可用命令：fight · status · pause');
        continue;
      }
      if (node.type === 'chapter-end') {
        if (input === 'complete' || input === 'next' || input === '') {
          await this.act('complete');
          continue;
        }
        this.terminal.write('章节结算节点请输入 complete。');
        continue;
      }
      if (node.type === 'camp') {
        if (input.startsWith('companion ')) {
          await this.selectCompanion(input.slice('companion '.length));
          continue;
        }
        if (input === 'next' || input === '') {
          await this.act('advance');
          continue;
        }
        this.terminal.write(
          '营地可用命令：next · companion N/ID · status · pause',
        );
        continue;
      }
      if (input === 'next' || input === '') {
        await this.act('advance');
        continue;
      }
      this.terminal.write('当前节点输入 next 保存并继续剧情。');
    }
  }

  async choose(input, choices) {
    const choiceId = resolveChoice(input.replace(/^choose\s+/, ''), choices);
    if (!choiceId) {
      this.terminal.write('请用 choose N 或 choose ID 选择剧情分支。');
      return;
    }
    await this.act('choose', { choiceId });
  }

  async claimReward(input, choices) {
    const choiceId = resolveChoice(input.replace(/^reward\s+/, ''), choices);
    if (!choiceId) {
      this.terminal.write('请用 reward N 或 reward ID 选择牌组奖励。');
      return;
    }
    await this.act('claim-reward', { choiceId });
  }

  async selectCompanion(value) {
    const choices = availableCompanions(this.journey).map((character, index) => ({
      choiceId: character.characterKey,
      label: character.name,
      index: index + 1,
    }));
    const companionKey = resolveChoice(value, choices);
    if (!companionKey) {
      this.terminal.write('请用 companion N 或 companion KEY 选择可用伙伴。');
      return;
    }
    await this.act('select-companion', { companionKey });
  }

  async playEncounter() {
    if (!this.journey.battleId) {
      const signature = signatureFor(
        this.journey,
        'start-encounter',
        {},
      );
      const action = await reusableAction(this.actions, this.journey.id, signature);
      const encounter = await this.api.startAdventureEncounter({
        runId: this.journey.id,
        actionId: action.actionId,
      });
      await this.actions.clear(this.journey.id);
      this.journey = {
        ...this.journey,
        battleId: encounter.battleId,
        runVersion: encounter.runVersion,
      };
    }
    const battle = await this.api.getBattle(this.journey.battleId);
    const controller = this.createBattleController(battle);
    try {
      const outcome = await controller.run();
      if (outcome === 'exit') {
        this.terminal.write(
          `战斗已暂停；运行 fm adventure resume ${this.journey.id} 后输入 fight。`,
        );
        return 'pause';
      }
      await this.resolveEncounter();
      return outcome;
    } catch (error) {
      if (error instanceof CliError && error.code === 'CLI_BATTLE_PAUSED') {
        this.terminal.write(
          `战斗已暂停；运行 fm adventure resume ${this.journey.id} 后输入 fight。`,
        );
        return 'pause';
      }
      throw error;
    }
  }

  async resolveEncounter() {
    const battleId = this.journey.battleId;
    if (!battleId) {
      this.terminal.write('当前冒险没有待结算战斗。');
      return;
    }
    await this.act('resolve-encounter', { battleId });
  }

  async act(action, extra = {}) {
    const signature = signatureFor(this.journey, action, extra);
    const pending = await reusableAction(this.actions, this.journey.id, signature);
    const result = await this.api.actAdventure({
      runId: this.journey.id,
      actionId: pending.actionId,
      body: {
        expectedVersion: this.journey.runVersion,
        action,
        ...extra,
      },
    });
    await this.actions.clear(this.journey.id);
    this.journey = result.run;
    this.terminal.event('ADVENTURE_ACTION', {
      action,
      node: this.journey.currentNode.nodeId,
      type: this.journey.currentNode.type,
      version: this.journey.runVersion,
      status: this.journey.status,
    });
  }

  async refresh() {
    this.journey = await this.api.getAdventure(this.journey.id);
    this.terminal.event('ADVENTURE_REFRESHED', {
      node: this.journey.currentNode.nodeId,
      version: this.journey.runVersion,
      battle: this.journey.battleId,
    });
  }

  async readInput(prompt) {
    const input = await this.terminal.question(prompt);
    return input?.trim();
  }
}

async function listBooks(api, terminal, limit) {
  const [installations, completions] = await Promise.all([
    api.listContentPackages(limit),
    api.listAdventureCompletions(100),
  ]);
  if (terminal.json) {
    terminal.printJson({ installations, completions });
    return;
  }
  if (installations.length === 0) {
    terminal.write('账号还没有安装冒险书。请先在 Web 内容书架安装 .fmbook。');
    return;
  }
  for (const [index, installation] of installations.entries()) {
    terminal.event('BOOK', {
      index: index + 1,
      installationId: installation.id,
      title: installation.title,
      bookId: installation.bookId,
      version: installation.contentVersion,
      nodes: installation.nodeCount,
    });
    for (const requirement of installation.requirements ?? []) {
      const matched = completions.find(
        (completion) => completionMatches(completion, requirement),
      );
      terminal.event('BOOK_REQUIREMENT', {
        bookId: requirement.bookId,
        endingId: requirement.endingId,
        endingTitle: requirement.endingTitle,
        status: matched ? 'ready' : 'missing',
        completionId: matched?.id,
      });
    }
  }
}

async function resolveRun(api, requestedRunId) {
  if (requestedRunId) {
    return api.getAdventure(requestedRunId);
  }
  const runs = await api.listAdventures(20);
  if (runs.length === 0) {
    throw new CliError('CLI_ADVENTURE_NOT_FOUND', '没有可恢复的冒险');
  }
  return runs[0];
}

function printRunSummary(run, index, terminal) {
  terminal.event('ADVENTURE', {
    index: index + 1,
    id: run.id,
    title: run.title,
    bookId: run.bookId,
    version: run.contentVersion,
    status: run.status,
    node: run.currentNode.nodeId,
    nodeType: run.currentNode.type,
    runVersion: run.runVersion,
    battle: run.battleId,
  });
}

function printRun(run, terminal) {
  const node = run.currentNode;
  terminal.event('ADVENTURE', {
    id: run.id,
    title: run.title,
    bookId: run.bookId,
    contentVersion: run.contentVersion,
    companion: run.companionKey,
    status: run.status,
    runVersion: run.runVersion,
  });
  terminal.event('NODE', {
    id: node.nodeId,
    chapter: node.chapterId,
    type: node.type,
    title: node.title,
  });
  if (node.speaker) {
    terminal.event('SPEAKER', { name: node.speaker });
  }
  if (node.text) {
    terminal.event('TEXT', { value: node.text });
  }
  if (node.type === 'encounter') {
    terminal.event('ENCOUNTER', {
      id: node.encounterId,
      name: node.encounterName ?? node.title,
      description: node.encounterDescription ?? node.text,
      battle: run.battleId,
    });
  }
  node.choices.forEach((choice, index) => {
    terminal.event('CHOICE', {
      index: index + 1,
      id: choice.choiceId,
      label: choice.label,
    });
  });
  run.rewardOffer?.choices.forEach((choice, index) => {
    terminal.event('REWARD', {
      index: index + 1,
      id: choice.choiceId,
      card: choice.cardDefinitionId,
      name: choice.name,
      description: choice.description,
    });
  });
  const companions = availableCompanions(run);
  if (node.type === 'camp' && companions.length > 1) {
    companions.forEach((character, index) => {
      terminal.event('COMPANION', {
        index: index + 1,
        key: character.characterKey,
        name: character.name,
        selected: character.characterKey === run.companionKey,
      });
    });
  }
  terminal.event('DECK', {
    size: run.deck.length,
    cards: run.deck.join(','),
  });
  if (run.sourceCompletionId) {
    terminal.event('SOURCE_COMPLETION', { id: run.sourceCompletionId });
  }
}

function resolveChoice(value, choices) {
  const normalized = String(value).trim();
  const numeric = Number(normalized);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= choices.length) {
    return choices[numeric - 1].choiceId;
  }
  return choices.find((choice) => choice.choiceId === normalized)?.choiceId;
}

function availableCompanions(run) {
  return (run.characters ?? []).filter(
    (character) => run.unlockedCharacters.includes(character.characterKey),
  );
}

function signatureFor(run, action, extra) {
  return [
    run.id,
    run.runVersion,
    action,
    extra.choiceId ?? '',
    extra.battleId ?? '',
    extra.companionKey ?? '',
  ].join(':');
}

async function reusableAction(store, runId, signature) {
  const existing = await store.get(runId);
  if (existing?.signature === signature) {
    return existing;
  }
  const record = {
    actionId: createId('adventure_action'),
    signature,
    createdAtMs: Date.now(),
  };
  await store.set(runId, record);
  return record;
}

function completionMatches(completion, requirement) {
  if (
    completion.bookId !== requirement.bookId
    || completion.endingId !== requirement.endingId
  ) {
    return false;
  }
  const version = compareVersions(
    completion.contentVersion,
    requirement.minContentVersion,
  );
  if (version < 0) {
    return false;
  }
  return requirement.maxContentVersionExclusive === undefined
    || compareVersions(
      completion.contentVersion,
      requirement.maxContentVersionExclusive,
    ) < 0;
}

function compareVersions(left, right) {
  if (right === undefined) {
    return 0;
  }
  const parse = (value) =>
    String(value).split('-')[0].split('.').map((part) => Number(part));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function parseLimit(value, maximum) {
  if (value === undefined) {
    return 20;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new CliError(
      'CLI_NUMBER_INVALID',
      `--limit 必须在 1 到 ${maximum} 之间`,
    );
  }
  return parsed;
}

function printAdventureHelp(terminal) {
  terminal.write('用法：');
  terminal.write('  fm adventure books          列出已安装冒险与结局前置条件');
  terminal.write('  fm adventure list           列出进行中的冒险');
  terminal.write('  fm adventure completions    列出可用于续作的结局回执');
  terminal.write('  fm adventure show [RUN_ID]  查看已提交检查点');
  terminal.write('  fm adventure start --install ID --companion lia');
  terminal.write('  fm adventure resume [RUN_ID] 进入文字剧情与遭遇');
  terminal.write('  fm adventure upgrade RUN_ID --install ID');
}
