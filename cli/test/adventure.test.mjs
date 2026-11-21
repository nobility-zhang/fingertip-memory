import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdventureCheckpointStore } from '../src/adventureCheckpoint.mjs';
import { AdventureController } from '../src/commands/adventure.mjs';
import { resolveRuntimeConfig } from '../src/config.mjs';

test('text adventure resolves numbered choices and saves the returned checkpoint', async () => {
  const initial = runFixture({
    node: {
      ...nodeFixture('choice'),
      choices: [
        { choiceId: 'follow-route', label: '沿路标前进' },
        { choiceId: 'wait', label: '留在原地' },
      ],
    },
  });
  const next = runFixture({
    runVersion: 1,
    node: {
      ...nodeFixture('dialogue'),
      nodeId: 'north-road',
      text: '风从北边吹来。',
    },
  });
  const calls = [];
  const api = fakeAdventureApi({
    actAdventure: async (input) => {
      calls.push(input);
      return { outcome: 'applied', run: next };
    },
  });
  const terminal = new FakeTerminal(['choose 1', 'pause']);
  const controller = new AdventureController({
    api,
    run: initial,
    terminal,
    actions: memoryCheckpointStore(),
    battleCheckpoints: {},
  });
  await controller.run();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.action, 'choose');
  assert.equal(calls[0].body.choiceId, 'follow-route');
  assert.equal(calls[0].body.expectedVersion, 0);
  assert.equal(controller.journey.currentNode.nodeId, 'north-road');
  assert.match(terminal.output(), /CHOICE index=1 id=follow-route/);
  assert.match(terminal.output(), /ADVENTURE_ACTION action=choose/);
});

test('encounter text flow starts battle, resolves victory, and claims a reward', async () => {
  const initial = runFixture({
    node: {
      ...nodeFixture('encounter'),
      encounterId: 'bridge-guardian',
      encounterName: '桥雾守卫',
    },
  });
  const encounterRun = {
    ...initial,
    runVersion: 1,
    battleId: 'battle-1',
  };
  const rewardRun = {
    ...initial,
    runVersion: 2,
    battleId: undefined,
    rewardOffer: {
      offerId: 'offer-1',
      nodeId: 'bridge',
      choices: [{
        choiceId: 'reward-ember',
        cardDefinitionId: 'ember-rune',
        name: '余烬符文',
        description: '伤害并施加灼烧',
      }],
    },
  };
  const claimedRun = runFixture({
    runVersion: 3,
    node: {
      ...nodeFixture('dialogue'),
      nodeId: 'bridge-crossed',
      text: '桥雾散去。',
    },
  });
  const calls = [];
  const api = fakeAdventureApi({
    startAdventureEncounter: async () => ({
      outcome: 'started',
      battleId: 'battle-1',
      runId: initial.id,
      runVersion: 1,
    }),
    getBattle: async () => ({
      battle: { battleId: 'battle-1', phase: 'learning' },
      events: [],
      stateVersion: 0,
    }),
    actAdventure: async (input) => {
      calls.push(input.body);
      return {
        outcome: 'applied',
        run: input.body.action === 'resolve-encounter'
          ? rewardRun
          : claimedRun,
      };
    },
  });
  const terminal = new FakeTerminal(['fight', 'reward 1', 'pause']);
  const controller = new AdventureController({
    api,
    run: initial,
    terminal,
    actions: memoryCheckpointStore(),
    battleCheckpoints: {},
    createBattleController: () => ({
      run: async () => 'victory',
    }),
  });
  await controller.run();

  assert.deepEqual(
    calls.map((body) => body.action),
    ['resolve-encounter', 'claim-reward'],
  );
  assert.equal(calls[1].choiceId, 'reward-ember');
  assert.match(terminal.output(), /REWARD index=1 id=reward-ember/);
  assert.match(terminal.output(), /node=bridge-crossed/);
});

test('adventure action checkpoints survive restart and are cleared after success', async () => {
  const runtime = resolveRuntimeConfig({
    mode: 'account',
    profile: 'adventure',
    home: await mkdtemp(join(tmpdir(), 'fm-adventure-')),
  });
  const first = new AdventureCheckpointStore(runtime);
  await first.set('run-1', {
    actionId: 'adventure_action-1',
    signature: 'run-1:0:choose:left',
    createdAtMs: 1,
  });
  const recovered = await new AdventureCheckpointStore(runtime).get('run-1');
  assert.equal(recovered.actionId, 'adventure_action-1');
  await first.clear('run-1');
  assert.equal(await first.get('run-1'), undefined);
});

function runFixture({ node, runVersion = 0, battleId }) {
  return {
    id: 'run-1',
    installationId: 'install-1',
    namespace: 'test',
    bookId: 'book-1',
    contentVersion: '1.0.0',
    contentHash: 'a'.repeat(64),
    title: '测试旅途',
    seriesId: 'series-1',
    companionKey: 'lia',
    status: 'active',
    runVersion,
    sessionId: 'session-1',
    battleId,
    currentNode: node,
    deck: ['traveler-strike'],
    unlockedCharacters: ['lia', 'serin'],
    characters: [
      {
        characterKey: 'lia',
        name: '莉娅',
      },
      {
        characterKey: 'serin',
        name: '瑟琳',
      },
    ],
    scenes: [],
    flags: {},
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function nodeFixture(type) {
  return {
    nodeId: 'bridge',
    chapterId: 'chapter-1',
    type,
    title: '溪桥',
    speaker: '莉娅',
    text: '雾里有一座旧桥。',
    choices: [],
  };
}

function fakeAdventureApi(overrides = {}) {
  return {
    actAdventure: async () => {
      throw new Error('unexpected actAdventure');
    },
    startAdventureEncounter: async () => {
      throw new Error('unexpected startAdventureEncounter');
    },
    getBattle: async () => {
      throw new Error('unexpected getBattle');
    },
    getAdventure: async () => {
      throw new Error('unexpected getAdventure');
    },
    ...overrides,
  };
}

function memoryCheckpointStore() {
  const records = new Map();
  return {
    async get(runId) {
      return records.get(runId);
    },
    async set(runId, value) {
      records.set(runId, value);
    },
    async clear(runId) {
      records.delete(runId);
    },
  };
}

class FakeTerminal {
  constructor(answers) {
    this.answers = [...answers];
    this.events = [];
    this.messages = [];
    this.json = false;
  }

  event(name, fields = {}) {
    this.events.push({ name, fields });
  }

  write(message) {
    this.messages.push(message);
  }

  printJson(value) {
    this.messages.push(JSON.stringify(value));
  }

  async question() {
    return this.answers.shift();
  }

  output() {
    return [
      ...this.events.map(({ name, fields }) =>
        `${name} ${Object.entries(fields)
          .map(([key, value]) => `${key}=${value}`)
          .join(' ')}`),
      ...this.messages,
    ].join('\n');
  }
}
