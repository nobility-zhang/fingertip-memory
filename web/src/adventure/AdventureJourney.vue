<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Flame,
  Map,
  Play,
  Sparkles,
  Swords,
} from '@lucide/vue';
import {
  accountApi,
  type AccountClient,
  type AdventureRunView,
  type SessionEnvelope,
} from '../api/client';
import BridgeBattlePanel from '../battle/BridgeBattlePanel.vue';
import CompanionPortrait from '../companions/CompanionPortrait.vue';
import type {
  CompanionCostumeId,
  CompanionExpression,
  CompanionId,
  CompanionProfile,
} from '../companions/catalog';
import {
  companions as builtInCompanions,
} from '../companions/catalog';
import { companionsForRun } from '../companions/registry';
import { sceneForNode } from './sceneCatalog';
import { lastLineIndex, lineAt } from './storyLines';

const props = withDefaults(
  defineProps<{
    api?: AccountClient;
    run: AdventureRunView;
    session?: SessionEnvelope;
    companion: CompanionProfile;
    companionOptions?: CompanionProfile[];
    loading: boolean;
    busy: boolean;
    error: string | null;
    notice: string | null;
    enableAudio?: boolean;
    reduceMotion?: boolean;
  }>(),
  {
    api: () => accountApi,
    session: undefined,
    companionOptions: () => [],
    enableAudio: false,
    reduceMotion: false,
  },
);

const emit = defineEmits<{
  choose: [choiceId: string];
  advance: [];
  nextLine: [];
  'start-encounter': [];
  'resolve-encounter': [];
  complete: [];
  'claim-reward': [choiceId: string];
  'select-companion': [companionKey: CompanionId];
  exit: [];
  replay: [];
  'session-changed': [session: SessionEnvelope];
}>();

const node = computed(() => props.run.currentNode);
const lineIndex = ref(0);
const fixedHash = computed(() => props.run.contentHash.slice(0, 8));
const storyLine = computed(() => lineAt(
  node.value,
  displayName,
  lineIndex.value,
));
const sceneNode = computed(() => ({
  ...node.value,
  sceneId: storyLine.value.line.stage?.sceneId ?? node.value.sceneId,
}));
const scene = computed(() => sceneForNode(
  sceneNode.value,
  props.run.scenes ?? [],
  props.run.installationId,
));
function displayName(speaker: string): string {
  if (speaker === 'lia') {
    return runtimeCompanions.value.find(
      (candidate) => candidate.id === 'lia',
    )?.name ?? props.companion.name;
  }
  if (speaker === 'serin') {
    return runtimeCompanions.value.find(
      (candidate) => candidate.id === 'serin',
    )?.name ?? props.companion.name;
  }
  if (speaker === 'fina') {
    return runtimeCompanions.value.find(
      (candidate) => candidate.id === 'fina',
    )?.name ?? '菲妮';
  }
  return speaker;
}
const runtimeCompanions = computed(() => companionsForRun(
  props.run,
  props.companionOptions.length > 0
    ? props.companionOptions
    : builtInCompanions,
));
const sceneCompanion = computed(() => {
  const targetId = storyLine.value.line.stage?.command === 'choice'
    ? props.run.companionKey
    : node.value.portraitCharacterId
    ?? props.run.companionKey;
  return runtimeCompanions.value.find((candidate) => candidate.id === targetId)
    ?? runtimeCompanions.value[0]
    ?? props.companion;
});
const sceneCostumeId = computed<CompanionCostumeId>(
  () => storyLine.value.line.stage?.sceneId === undefined
    ? node.value.costumeId ?? sceneCompanion.value.defaultCostumeId
      ?? 'summer-travel'
    : node.value.costumeId
    ?? sceneCompanion.value.defaultCostumeId
    ?? 'summer-travel',
);
const availableCompanions = computed(() =>
  runtimeCompanions.value.filter((candidate) =>
    props.run.unlockedCharacters.includes(candidate.id),
  ),
);
const sceneBackground = computed(() => scene.value.background);
const speaker = computed(() => storyLine.value.speakerName);
const speakingKey = computed(() => {
  const line = storyLine.value.line;
  if (line.portraitCharacterId !== undefined) {
    return line.portraitCharacterId;
  }
  if (line.speaker === 'serin' || line.speaker === '瑟琳') {
    return 'serin';
  }
  if (line.speaker === 'lia' || line.speaker === 'kind' || line.speaker === '莉娅') {
    return 'lia';
  }
  return 'narration';
});
const expressionFor = (
  _companion: CompanionProfile,
  speaking: boolean,
): CompanionExpression => {
  if (props.run.status === 'completed'
      || props.run.status === 'replayed') {
    return 'relief';
  }
  if (node.value.type === 'choice') {
    return speaking ? 'welcome' : 'concern';
  }
  if (node.value.type === 'encounter') {
    return 'concern';
  }
  if (node.value.type === 'camp' || node.value.type === 'chapter-end') {
    return 'relief';
  }
  return speaking ? 'cheer' : 'concern';
};
const expression = computed<CompanionExpression>(() =>
  expressionFor(
    sceneCompanion.value,
    speakingKey.value === sceneCompanion.value.id,
  ),
);
const canAdvance = computed(
  () => storyLine.value.advances
    || node.value.type === 'dialogue'
    || node.value.type === 'explore'
    || node.value.type === 'camp',
);
const atLastLine = computed(() => lineIndex.value >= lastLineIndex(node.value));
const stageLia = computed(() =>
  runtimeCompanions.value.find((candidate) => candidate.id === 'lia')
  ?? props.companion,
);
const stageSerin = computed(() =>
  runtimeCompanions.value.find((candidate) => candidate.id === 'serin')
  ?? props.companion,
);
const standingClass = (
  companion: 'lia' | 'serin',
): string => `standing-${storyLine.value.standing[companion]}`;
const lineSpeakerClass = computed(() => {
  if (speakingKey.value === 'lia') {
    return 'speaker-lia';
  }
  if (speakingKey.value === 'serin') {
    return 'speaker-serin';
  }
  return 'speaker-narration';
});
const propLabel = computed(() => {
  switch (storyLine.value.line.stage?.prop) {
    case 'match':
      return '火柴停在灯芯前';
    case 'map':
      return '地图上的泥痕';
    case 'red-string':
      return '地图的红系绳';
    default:
      return '';
  }
});
const sceneKicker = computed(() => {
  switch (node.value.type) {
    case 'encounter':
      return `${scene.value.label} · 遭遇`;
    case 'camp':
      return `${scene.value.label} · 营地`;
    case 'chapter-end':
      return `${scene.value.label} · 结算`;
    default:
      return scene.value.label;
  }
});
const battleReady = computed(
  () => props.run.battleId !== undefined && props.session !== undefined,
);
const battleCompanionKey = computed<CompanionId>(
  () => props.run.companionKey,
);
const battleCompanion = computed(() =>
  runtimeCompanions.value.find(
    (candidate) => candidate.id === battleCompanionKey.value,
  ) ?? runtimeCompanions.value[0] ?? props.companion,
);
const encounterEnemyName = computed(
  () => node.value.encounterName ?? node.value.title,
);
const encounterBrief = computed(
  () => node.value.encounterDescription ?? storyLine.value.line.text,
);
const primaryLabel = computed(() => {
  if (node.value.type === 'camp') {
    return '在营火旁收好笔记';
  }
  return '继续旅途';
});

function finishBattle(): void {
  emit('resolve-encounter');
}

function continueLine(): void {
  if (storyLine.value.advances) {
    lineIndex.value += 1;
    emit('nextLine');
    return;
  }
  if (node.value.type === 'camp' || node.value.type === 'dialogue' || node.value.type === 'explore') {
    emit('advance');
  }
}

function chooseLine(choiceId: string): void {
  emit('choose', choiceId);
}

watch(
  () => `${props.run.id}:${node.value.nodeId}`,
  () => {
    lineIndex.value = 0;
  },
  { immediate: true },
);

function handleDialogueKeydown(event: KeyboardEvent): void {
  if (
    event.isComposing
    || event.repeat
    || event.metaKey
    || event.ctrlKey
    || event.altKey
  ) {
    return;
  }
  const target = event.target;
  const interactive = target instanceof HTMLElement
    && target.closest('button, input, textarea, select, a, summary');
  if (interactive !== null && interactive !== undefined) {
    return;
  }
  if (event.key !== 'Enter' && event.key !== ' ') {
    return;
  }
  if (node.value.type === 'choice') {
    if (atLastLine.value && storyLine.value.choices.length === 1) {
      event.preventDefault();
      chooseLine(storyLine.value.choices[0]!.choiceId);
    }
    return;
  }
  if (!canAdvance.value) {
    return;
  }
  event.preventDefault();
  continueLine();
}

onMounted(() => {
  document.addEventListener('keydown', handleDialogueKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleDialogueKeydown);
});
</script>

<template>
  <section
    class="adventure-journey"
    :class="[
      `scene-${node.type}`,
      lineSpeakerClass,
      { 'story-lines': node.lines !== undefined && node.lines.length > 0 },
    ]"
    :data-run-id="run.id"
    :data-node-id="node.nodeId"
    :data-content-version="run.contentVersion"
    :data-content-hash="run.contentHash"
    :data-scene-id="scene.id"
    :data-costume-id="sceneCostumeId"
    :style="{ '--scene-background': `url(${sceneBackground})` }"
    :aria-labelledby="`adventure-${node.nodeId}`"
  >
    <header class="journey-heading">
      <button type="button" class="exit-journey" :disabled="busy" @click="emit('exit')">
        <ArrowLeft :size="18" aria-hidden="true" />
        保存并离开
      </button>
      <div class="journey-identity">
        <p class="section-label">
          <Map :size="15" aria-hidden="true" />
          {{ run.title }}
        </p>
        <h2 :id="`adventure-${node.nodeId}`">{{ node.title }}</h2>
      </div>
      <div class="run-lock" aria-label="固定内容版本">
        <span>v{{ run.contentVersion }}</span>
        <code>{{ fixedHash }}</code>
        <small v-if="run.sourceCompletionId">
          前作回执 {{ run.sourceCompletionId.slice(0, 8) }}
        </small>
      </div>
    </header>

    <div v-if="run.status === 'completed'" class="journey-complete" role="status">
      <Sparkles :size="22" aria-hidden="true" />
      <div>
        <strong>这本冒险已经写入存档。</strong>
        <p>章节、伙伴、牌组和这次学习记录都会保留在同一个固定版本中。</p>
      </div>
      <button type="button" class="journey-primary" @click="emit('exit')">
        回到旅店
        <ArrowRight :size="18" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="journey-primary journey-replay"
        :disabled="busy"
        @click="emit('replay')"
      >
        从窗边重开一局 · 上一局结局保留
        <ArrowRight :size="18" aria-hidden="true" />
      </button>
    </div>

    <template v-else>
      <p v-if="error" class="journey-message journey-message--error" role="alert">
        {{ error }}
      </p>
      <p v-if="notice" class="journey-message" role="status">
        {{ notice }}
      </p>

      <div v-if="loading" class="journey-loading" role="status">
        正在读取冒险检查点...
      </div>

      <section
        v-else-if="run.rewardOffer"
        class="reward-offer"
        aria-labelledby="reward-offer-title"
      >
        <p class="section-label">本场战利品</p>
        <h3 id="reward-offer-title">选择一张加入本次冒险牌组</h3>
        <div class="reward-grid">
          <button
            v-for="choice in run.rewardOffer.choices"
            :key="choice.choiceId"
            type="button"
            :disabled="busy"
            @click="emit('claim-reward', choice.choiceId)"
          >
            <strong>{{ choice.name }}</strong>
            <span>{{ choice.description }}</span>
          </button>
        </div>
        <p>奖励只在本次冒险中领取一次，刷新不会重新抽取。</p>
      </section>

      <BridgeBattlePanel
        v-else-if="node.type === 'encounter' && battleReady && battleCompanionKey"
        :api="api"
        :session="session!"
        :companion-key="battleCompanionKey"
        :companion-profile="battleCompanion"
        :companion-costume-id="sceneCostumeId"
        :initial-battle-id="run.battleId"
        :encounter-id="node.encounterId ?? 'bridge-guardian'"
        :encounter-title="node.title"
        :encounter-kicker="`${scene.label} · 遭遇`"
        :enemy-name="encounterEnemyName"
        :battle-theme="scene.battleTheme"
        :ambient-key="scene.ambientKey"
        finish-label="继续剧情"
        :enable-audio="enableAudio"
        :reduce-motion="reduceMotion"
        @session-changed="emit('session-changed', $event)"
        @finished="finishBattle"
      />

      <div
        v-else-if="node.type === 'encounter' && run.battleId"
        class="journey-loading"
        role="status"
      >
        已找到固定战斗，正在恢复学习会话...
      </div>

      <div
        v-else
        class="journey-stage"
        :data-line-id="storyLine.line.lineId"
        :data-speaker="storyLine.line.speaker"
        :data-line-index="lineIndex"
      >
        <div class="scene-atmosphere" aria-hidden="true">
          <span class="scene-light"></span>
          <span
            v-if="storyLine.line.stage?.light !== undefined"
            class="stage-light"
            :class="`light-${storyLine.line.stage.light}`"
            aria-hidden="true"
          ></span>
          <span class="window-frame" aria-hidden="true">
            <span class="window-lamp"></span>
          </span>
          <span
            v-if="storyLine.line.stage?.prop === 'red-string'"
            class="stage-prop red-string"
            aria-hidden="true"
          ></span>
          <span
            v-if="storyLine.line.stage?.command === 'close'"
            class="stage-prop closed-latch"
            aria-hidden="true"
          ></span>
          <span
            v-if="storyLine.line.stage?.command === 'choice'"
            class="stage-prop chalk-arrow"
            aria-hidden="true"
          ></span>
        </div>

        <div class="journey-copy">
          <p class="scene-kicker">
            <Swords v-if="node.type === 'encounter'" :size="16" aria-hidden="true" />
            <Flame v-else-if="node.type === 'camp'" :size="16" aria-hidden="true" />
            <BookOpen v-else :size="16" aria-hidden="true" />
            {{ sceneKicker }}
          </p>
          <p class="speaker">{{ speaker }}</p>
          <p
            class="node-text"
            :title="storyLine.line.text"
            @click="storyLine.advances ? continueLine() : undefined"
          >
            {{ storyLine.line.text }}
          </p>
          <p
            v-if="propLabel.length > 0"
            class="stage-prop-label"
          >
            可见细节 · {{ propLabel }}
          </p>

          <div
            v-if="node.type === 'choice' && atLastLine"
            class="choice-list"
            aria-label="剧情选项"
          >
            <button
              v-for="choice in storyLine.choices"
              :key="choice.choiceId"
              type="button"
              :disabled="busy"
              @click="chooseLine(choice.choiceId)"
            >
              <span>{{ choice.label }}</span>
              <ArrowRight :size="17" aria-hidden="true" />
            </button>
          </div>

          <div v-if="node.type === 'encounter'" class="encounter-actions">
            <p>
              <strong>{{ encounterEnemyName }}</strong>
              {{ encounterBrief }}
            </p>
            <button
              type="button"
              class="journey-primary"
              :disabled="busy"
              @click="emit('start-encounter')"
            >
              <Play :size="18" aria-hidden="true" />
              开始{{ scene.label }}战斗
            </button>
          </div>

          <div v-else-if="node.type === 'chapter-end'" class="encounter-actions">
            <button
              type="button"
              class="journey-primary"
              :disabled="busy"
              @click="emit('complete')"
            >
              完成当前章节
              <Sparkles :size="18" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="journey-replay"
              :disabled="busy"
              @click="emit('replay')"
            >
              从窗边重开一局 · 保留已完成的章节与学习记录
            </button>
            <p class="replay-note">
              新一局会从旅店窗边重新开始，上一局的结局和学习记录不会被改写。
            </p>
          </div>

          <div
            v-if="node.type === 'camp' && availableCompanions.length > 1"
            class="camp-companion-switch"
            aria-label="切换带队伙伴"
          >
            <span>带队伙伴</span>
            <div>
              <button
                v-for="candidate in availableCompanions"
                :key="candidate.id"
                type="button"
                :class="{ selected: candidate.id === run.companionKey }"
                :disabled="busy"
                :aria-pressed="candidate.id === run.companionKey"
                @click="emit('select-companion', candidate.id)"
              >
                {{ candidate.name }}
              </button>
            </div>
          </div>

          <button
            v-if="canAdvance"
            type="button"
            class="journey-primary"
            :disabled="busy"
            @click="continueLine"
          >
            {{
              busy
                ? '正在保存检查点'
                : storyLine.advances
                  ? '继续'
                  : primaryLabel
            }}
            <ArrowRight :size="18" aria-hidden="true" />
          </button>
          <p v-if="!atLastLine" class="line-hint">
            点击或按 Enter 继续本句。选择会在最后一句后出现。
          </p>
        </div>

        <div class="journey-companion story-cast">
          <span class="lamp-glow" aria-hidden="true"></span>
          <div
            v-if="node.lines !== undefined && node.lines.length > 0"
            class="dual-cast"
          >
            <div
              class="cast-member cast-lia"
              :class="[
                standingClass('lia'),
                { speaking: speakingKey === 'lia' },
              ]"
            >
              <CompanionPortrait
                :companion="stageLia"
                :expression="expressionFor(stageLia, speakingKey === 'lia')"
                :costume-id="stageLia.defaultCostumeId ?? 'summer-travel'"
                :reduce-motion="reduceMotion"
              />
              <span class="cast-name">{{ stageLia.name }}</span>
            </div>
            <div
              class="cast-member cast-serin"
              :class="[
                standingClass('serin'),
                { speaking: speakingKey === 'serin' },
              ]"
            >
              <CompanionPortrait
                :companion="stageSerin"
                :expression="expressionFor(stageSerin, speakingKey === 'serin')"
                :costume-id="stageSerin.defaultCostumeId ?? 'summer-travel'"
                :reduce-motion="reduceMotion"
              />
              <span class="cast-name">{{ stageSerin.name }}</span>
            </div>
          </div>
          <CompanionPortrait
            v-else
            :companion="sceneCompanion"
            :expression="expression"
            :costume-id="sceneCostumeId"
            :reduce-motion="reduceMotion"
          />
          <div v-if="node.lines === undefined" class="companion-line">
            <span>{{ sceneCompanion.name }} · {{ sceneCompanion.epithet }}</span>
            <p>{{ sceneCompanion.dialogue.training }}</p>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.adventure-journey {
  --scene-deep: #14211d;
  --scene-middle: #31473b;
  --scene-warm: #bd8b4f;
  --scene-background: none;
  position: relative;
  display: grid;
  min-height: calc(100vh - 150px);
  gap: 18px;
  overflow: hidden;
  border: 1px solid rgb(217 183 121 / 36%);
  border-radius: 8px;
  padding: clamp(18px, 3vw, 34px);
  background:
    linear-gradient(90deg, rgb(17 12 13 / 90%) 0 38%, rgb(17 12 13 / 42%) 56%, transparent 82%),
    linear-gradient(180deg, transparent 52%, rgb(12 10 12 / 58%) 100%),
    var(--scene-background) center / cover no-repeat,
    linear-gradient(135deg, var(--scene-deep), var(--scene-middle));
  color: #f7ead5;
  isolation: isolate;
}

.adventure-journey.scene-choice,
.adventure-journey.scene-dialogue {
  --scene-deep: #261b18;
  --scene-middle: #594135;
  --scene-warm: #d0a063;
}

.adventure-journey.scene-encounter {
  --scene-deep: #11272a;
  --scene-middle: #3d6662;
  --scene-warm: #b7d3bd;
}

.adventure-journey.scene-camp,
.adventure-journey.scene-chapter-end {
  --scene-deep: #1b1521;
  --scene-middle: #5c372d;
  --scene-warm: #f0a95c;
}

.journey-heading {
  position: relative;
  z-index: 2;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 18px;
}

.journey-identity {
  min-width: 0;
  text-align: center;
}

.journey-identity .section-label {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin: 0 0 5px;
  color: #d9b779;
  letter-spacing: 0.08em;
}

.journey-identity h2 {
  margin: 0;
  color: #fff0d7;
  font-family: "Songti SC", "Noto Serif CJK SC", Georgia, serif;
  font-size: clamp(1.55rem, 3vw, 2.5rem);
  font-weight: 600;
  line-height: 1.15;
  overflow-wrap: anywhere;
}

.exit-journey,
.journey-primary,
.choice-list button {
  display: inline-flex;
  min-height: 40px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid rgb(234 205 145 / 46%);
  border-radius: 5px;
  padding: 8px 13px;
  background: rgb(22 18 18 / 44%);
  color: #f3dfb7;
  cursor: pointer;
}

.run-lock {
  display: grid;
  justify-items: end;
  gap: 3px;
  color: #cfb982;
  font-size: 0.72rem;
}

.run-lock code {
  color: #a8c7b6;
  font-size: 0.66rem;
}

.run-lock small {
  color: #c6b28f;
  font-size: 0.62rem;
}

.journey-message {
  position: relative;
  z-index: 2;
  margin: 0;
  border-left: 3px solid #d7b773;
  padding: 9px 12px;
  background: rgb(24 18 18 / 48%);
  color: #e9dcc4;
  overflow-wrap: anywhere;
}

.journey-message--error {
  border-left-color: #d78373;
  color: #ffd8ce;
}

.journey-loading {
  display: grid;
  min-height: 360px;
  place-items: center;
  color: #d7c79e;
}

.journey-stage {
  position: relative;
  display: grid;
  grid-template-columns: minmax(330px, 0.9fr) minmax(340px, 1.1fr);
  min-height: 560px;
  align-items: end;
  overflow: hidden;
  border: 1px solid rgb(234 205 145 / 20%);
  background:
    linear-gradient(90deg, rgb(12 10 12 / 84%) 0 38%, rgb(12 10 12 / 18%) 58%, transparent 84%),
    linear-gradient(180deg, transparent 40%, rgb(12 10 12 / 82%) 100%),
    var(--scene-background) center / cover no-repeat;
}

.scene-atmosphere {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.scene-atmosphere::before {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(circle at 76% 25%, rgb(255 214 151 / 8%), transparent 27%),
    linear-gradient(180deg, rgb(12 13 16 / 8%), rgb(11 10 12 / 30%));
  content: "";
}

.scene-light {
  position: absolute;
  top: 18%;
  right: 15%;
  width: 22%;
  aspect-ratio: 1;
  border-radius: 50%;
  background: radial-gradient(circle, rgb(255 212 139 / 28%), transparent 68%);
  filter: blur(10px);
}

.story-lines .journey-stage {
  grid-template-columns: minmax(0, 1fr);
  min-height: min(720px, 76vh);
}

.story-lines .journey-copy {
  justify-content: start;
  padding-bottom: min(23vh, 220px);
}

.story-lines .journey-copy .node-text {
  max-width: 46rem;
  min-height: 5.2em;
  border-left: 2px solid rgb(224 194 120 / 52%);
  padding: 14px 0 0 18px;
  background:
    linear-gradient(90deg, rgb(14 11 12 / 74%), transparent 84%);
  text-shadow: 0 2px 16px rgb(0 0 0 / 72%);
}

.stage-light {
  position: absolute;
  border-radius: 50%;
  pointer-events: none;
}

.light-window-bell {
  top: 10%;
  right: 9%;
  width: 36%;
  aspect-ratio: 1;
  border: 1px solid rgb(232 192 118 / 26%);
  background: radial-gradient(circle, rgb(255 209 130 / 10%), transparent 64%);
}

.light-window-lamp {
  top: 14%;
  right: 7%;
  width: 38%;
  aspect-ratio: 1;
  background: radial-gradient(circle, rgb(255 203 116 / 34%), transparent 67%);
  filter: blur(4px);
}

.light-campfire {
  right: 14%;
  bottom: 8%;
  width: 56%;
  height: 38%;
  background: radial-gradient(ellipse, rgb(255 155 65 / 28%), transparent 68%);
}

.window-frame {
  position: absolute;
  top: 9%;
  right: 7%;
  width: 31%;
  height: 35%;
  border: 1px solid rgb(228 189 117 / 18%);
  box-shadow:
    inset 0 0 40px rgb(255 206 122 / 6%),
    0 0 26px rgb(255 206 122 / 8%);
  pointer-events: none;
}

.window-frame::before,
.window-frame::after {
  position: absolute;
  background: rgb(228 189 117 / 15%);
  content: "";
}

.window-frame::before {
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
}

.window-frame::after {
  right: 0;
  left: 0;
  top: 52%;
  height: 1px;
}

.window-lamp {
  position: absolute;
  bottom: 13%;
  left: 18%;
  width: 12px;
  height: 16px;
  border-radius: 50% 50% 42% 42%;
  background: #ffd78f;
  box-shadow:
    0 0 16px #ffcb75,
    0 0 44px rgb(255 190 90 / 46%);
}

.stage-prop {
  position: absolute;
  pointer-events: none;
}

.red-string {
  top: 30%;
  right: 14%;
  width: 7px;
  height: 28%;
  border-radius: 60% 30% 50% 40%;
  background:
    repeating-linear-gradient(
      180deg,
      #b74f42 0 8px,
      #8b302b 8px 12px
    );
  box-shadow: 0 0 8px rgb(183 79 66 / 38%);
  transform: rotate(11deg);
}

.closed-latch {
  right: 32%;
  bottom: 37%;
  width: 46px;
  height: 8px;
  border-radius: 3px;
  background: #8b6b43;
  box-shadow: 0 2px 7px rgb(0 0 0 / 54%);
}

.chalk-arrow {
  right: 21%;
  bottom: 24%;
  width: 48px;
  height: 3px;
  border-radius: 2px;
  background: #d8c69f;
  transform: rotate(-24deg);
}

.chalk-arrow::after {
  position: absolute;
  right: -1px;
  top: -5px;
  width: 9px;
  height: 9px;
  border-top: 2px solid #d8c69f;
  border-right: 2px solid #d8c69f;
  content: "";
  transform: rotate(45deg);
}

.stage-prop-label,
.line-hint {
  margin: 0;
  color: #d3c1a0;
  font-size: 0.72rem;
  line-height: 1.5;
}

.stage-prop-label {
  width: fit-content;
  border: 1px solid rgb(230 199 134 / 28%);
  border-radius: 4px;
  padding: 4px 8px;
  background: rgb(18 14 14 / 58%);
}

.story-lines .journey-companion {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: block;
  overflow: hidden;
  padding: 0;
  pointer-events: none;
}

.dual-cast {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.cast-member {
  position: absolute;
  bottom: 22%;
  height: min(500px, 63vh);
  transition:
    transform 240ms ease-out,
    filter 240ms ease-out,
    opacity 240ms ease-out;
}

.cast-member :deep(.companion-portrait) {
  height: 100%;
}

.cast-member .cast-name {
  position: absolute;
  bottom: 4%;
  left: 50%;
  border: 1px solid rgb(225 192 122 / 24%);
  border-radius: 12px;
  padding: 3px 9px;
  background: rgb(14 11 12 / 72%);
  color: #e7d2aa;
  font-size: 0.68rem;
  transform: translateX(-50%);
  white-space: nowrap;
}

.cast-lia.standing-left {
  left: 2%;
}

.cast-lia.standing-right {
  right: 23%;
  left: auto;
}

.cast-lia.standing-far-right {
  right: 2%;
  left: auto;
}

.cast-serin.standing-left {
  left: 2%;
  right: auto;
}

.cast-serin.standing-right {
  right: 2%;
  left: auto;
}

.cast-serin.standing-far-right {
  right: 12%;
  left: auto;
}

.cast-member.speaking {
  filter: drop-shadow(0 0 18px rgb(255 205 117 / 36%));
  transform: translateY(-6px) scale(1.025);
  z-index: 2;
}

.cast-member:not(.speaking) {
  filter: brightness(0.76) saturate(0.86);
}

.speaker-narration .cast-member:not(.speaking) {
  filter: brightness(0.86) saturate(0.92);
}

.journey-copy {
  position: relative;
  z-index: 2;
  display: flex;
  min-width: 0;
  align-self: stretch;
  flex-direction: column;
  justify-content: end;
  gap: 16px;
  padding: clamp(26px, 4vw, 54px);
}

.scene-kicker {
  display: inline-flex;
  width: fit-content;
  align-items: center;
  gap: 7px;
  margin: 0;
  color: #d9b779;
  font-size: 0.74rem;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.speaker {
  margin: 0;
  color: #f0c980;
  font-size: 0.88rem;
  font-weight: 700;
}

.node-text {
  max-width: 38rem;
  margin: 0;
  color: #fff1d8;
  font-family: "Songti SC", "Noto Serif CJK SC", Georgia, serif;
  font-size: clamp(1.35rem, 2.6vw, 2.15rem);
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.choice-list,
.encounter-actions,
.camp-companion-switch {
  display: grid;
  max-width: 38rem;
  gap: 9px;
}

.choice-list button {
  justify-content: space-between;
  text-align: left;
}

.choice-list button:hover,
.choice-list button:focus-visible {
  border-color: #e5c67f;
  background: rgb(209 171 92 / 24%);
}

.encounter-actions p {
  margin: 0;
  color: #c7d7cb;
  line-height: 1.6;
}

.encounter-actions code {
  color: #f0d89e;
}

.camp-companion-switch {
  padding-top: 12px;
  border-top: 1px solid rgb(217 183 121 / 24%);
}

.camp-companion-switch > span {
  color: #c6b28f;
  font-size: 0.72rem;
}

.camp-companion-switch > div {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}

.camp-companion-switch button {
  min-height: 34px;
  border: 1px solid rgb(234 205 145 / 38%);
  border-radius: 4px;
  padding: 5px 11px;
  background: rgb(24 18 18 / 46%);
  color: #e8d5b2;
  cursor: pointer;
}

.camp-companion-switch button.selected {
  border-color: #e1c477;
  background: #d1ab5c;
  color: #201d19;
}

.reward-offer {
  position: relative;
  z-index: 2;
  display: grid;
  gap: 14px;
  border: 1px solid rgb(234 205 145 / 32%);
  padding: clamp(20px, 4vw, 38px);
  background:
    linear-gradient(135deg, rgb(27 20 20 / 92%), rgb(53 39 31 / 86%)),
    var(--scene-background) center / cover no-repeat;
}

.reward-offer h3 {
  margin: 0;
  color: #fff0d7;
  font-family: "Songti SC", "Noto Serif CJK SC", Georgia, serif;
  font-size: clamp(1.45rem, 3vw, 2.3rem);
  font-weight: 600;
}

.reward-offer > p:last-child {
  margin: 0;
  color: #b7ad9c;
  font-size: 0.74rem;
}

.reward-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.reward-grid button {
  display: grid;
  min-height: 150px;
  align-content: start;
  gap: 10px;
  border: 1px solid rgb(226 195 128 / 42%);
  border-radius: 6px;
  padding: 16px;
  background:
    linear-gradient(160deg, rgb(43 35 31 / 92%), rgb(23 22 21 / 96%));
  color: #f1e1c6;
  text-align: left;
  cursor: pointer;
}

.reward-grid button:hover,
.reward-grid button:focus-visible {
  border-color: #f0cc7e;
  transform: translateY(-2px);
}

.reward-grid strong {
  color: #ffe9b9;
  font-family: "Songti SC", "Noto Serif CJK SC", Georgia, serif;
  font-size: 1.12rem;
}

.reward-grid span {
  color: #c9c1ae;
  line-height: 1.55;
}

.journey-primary {
  width: fit-content;
  border-color: #e0c278;
  background: #d1ab5c;
  color: #201d19;
  font-weight: 700;
}

.journey-replay {
  width: fit-content;
  min-height: 40px;
  border: 1px solid rgb(234 205 145 / 48%);
  border-radius: 5px;
  padding: 8px 13px;
  background: rgb(22 18 18 / 52%);
  color: #f3dfb7;
  cursor: pointer;
}

.replay-note {
  max-width: 38rem;
  margin: 0;
  color: #b9ad98;
  font-size: 0.72rem;
  line-height: 1.55;
}

.journey-companion {
  position: relative;
  z-index: 1;
  display: flex;
  min-width: 0;
  align-items: end;
  justify-content: center;
  gap: 0;
  padding: 20px 28px 0;
}

.journey-companion :deep(.companion-portrait) {
  width: min(390px, 94%);
  height: min(580px, 72vh);
}

.lamp-glow {
  position: absolute;
  right: 8%;
  bottom: 13%;
  width: 54%;
  aspect-ratio: 1;
  border-radius: 50%;
  background: radial-gradient(circle, rgb(255 196 108 / 28%), transparent 70%);
  filter: blur(14px);
}

.companion-line {
  position: absolute;
  right: 24px;
  bottom: 24px;
  max-width: 310px;
  border-left: 2px solid #dcb772;
  padding: 8px 12px;
  background: rgb(17 13 14 / 72%);
}

.companion-line span {
  color: #e4c786;
  font-size: 0.75rem;
}

.companion-line p {
  margin: 4px 0 0;
  color: #fff0d7;
  line-height: 1.45;
}

.journey-complete {
  position: relative;
  z-index: 2;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 18px;
  border: 1px solid rgb(234 205 145 / 34%);
  padding: clamp(22px, 4vw, 42px);
  background: rgb(26 19 17 / 70%);
}

.journey-complete strong {
  color: #ffe8ba;
  font-family: "Songti SC", "Noto Serif CJK SC", Georgia, serif;
  font-size: 1.55rem;
}

.journey-complete p {
  margin: 6px 0 0;
  color: #d4c7ad;
}

button:disabled {
  cursor: wait;
  opacity: 0.55;
}

@media (max-width: 900px) {
  .adventure-journey {
    min-height: calc(100vh - 120px);
    background:
      linear-gradient(180deg, rgb(17 12 13 / 56%) 0 34%, rgb(14 11 13 / 82%) 72%),
      var(--scene-background) center / cover no-repeat,
      var(--scene-deep);
  }

  .journey-heading {
    grid-template-columns: 1fr auto;
  }

  .journey-identity {
    grid-row: 1;
    grid-column: 1 / -1;
    text-align: left;
  }

  .journey-stage {
    grid-template-columns: 1fr;
    min-height: auto;
    background:
      linear-gradient(180deg, rgb(12 10 12 / 28%) 0 30%, rgb(12 10 12 / 84%) 72%),
      var(--scene-background) center / cover no-repeat;
  }

  .journey-copy {
    min-height: 480px;
  }

  .journey-companion {
    min-height: 420px;
  }

  .journey-companion :deep(.companion-portrait) {
    width: min(320px, 84vw);
    height: 430px;
  }

  .journey-complete {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .journey-complete .journey-primary {
    grid-column: 1 / -1;
  }

  .reward-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 520px) {
  .adventure-journey {
    margin-inline: -10px;
    padding: 14px;
  }

  .journey-heading {
    gap: 10px;
  }

  .exit-journey {
    padding-inline: 9px;
  }

  .run-lock {
    max-width: 92px;
    text-align: right;
    overflow-wrap: anywhere;
  }

  .journey-copy {
    min-height: 430px;
    padding: 22px 18px;
  }

  .node-text {
    font-size: 1.28rem;
  }

  .journey-companion {
    min-height: 350px;
    padding-inline: 10px;
  }

  .journey-companion :deep(.companion-portrait) {
    height: 360px;
  }

  .companion-line {
    right: 10px;
    bottom: 12px;
    left: 10px;
    max-width: none;
  }

  .journey-complete {
    grid-template-columns: 1fr;
  }
}
</style>
