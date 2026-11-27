export type BattleFeedbackKind =
  | 'strike'
  | 'guard'
  | 'heal'
  | 'draw'
  | 'burn'
  | 'victory'
  | 'rescue'
  | 'none';

export interface BattleFeedbackStep {
  kind: BattleFeedbackKind;
  durationMs: number;
  hpFrom?: number;
  hpTo?: number;
  blockFrom?: number;
  blockTo?: number;
  enemyHpFrom?: number;
  enemyHpTo?: number;
  blocked?: number;
}

export interface BattleFeedbackFrame {
  hp: number;
  block: number;
  enemyHp: number;
  enemyBlocked: number;
}

/**
 * The server has already committed these events. This only turns the event
 * log into a bounded presentation sequence so the DOM never has to guess
 * damage or invent a resolution order.
 */
export function battleFeedbackSteps(
  events: ReadonlyArray<Record<string, unknown>>,
  before: BattleFeedbackFrame,
  after: BattleFeedbackFrame,
): BattleFeedbackStep[] {
  const steps: BattleFeedbackStep[] = [];
  let hp = before.hp;
  let block = before.block;
  let enemyHp = before.enemyHp;
  let enemyBlocked = before.enemyBlocked;
  let lastCardKind: BattleFeedbackKind | undefined;
  for (const event of events) {
    const type = text(event, 'type');
    if (type === 'card-played') {
      const definition = text(event, 'definitionId');
      lastCardKind = definition === 'companion-guard'
        ? 'guard'
        : definition === 'herb-pouch'
          ? 'heal'
          : definition === 'observe-signpost'
            ? 'draw'
            : 'strike';
      continue;
    }
    if (type === 'damage') {
      const hpLost = number(event, 'hpLost');
      const blocked = number(event, 'blocked');
      if (text(event, 'source') === 'enemy') {
        steps.push({
          kind: 'guard',
          durationMs: 280,
          hpFrom: hp,
          hpTo: Math.max(0, hp - hpLost),
          blocked,
        });
        hp = Math.max(0, hp - hpLost);
      } else {
        const hpAfter = Math.max(0, enemyHp - hpLost);
        steps.push({
          kind: lastCardKind === 'guard' ? 'guard' : 'strike',
          durationMs: 280,
          blocked,
          enemyHpFrom: enemyHp,
          enemyHpTo: hpAfter,
        });
        enemyHp = hpAfter;
      }
      continue;
    }
    if (type === 'block-gained') {
      const target = text(event, 'targetId');
      const total = number(event, 'totalBlock');
      if (target === 'party') {
        steps.push({
          kind: 'guard',
          durationMs: 220,
          blockFrom: block,
          blockTo: total,
        });
        block = total;
      } else {
        enemyBlocked = Math.max(enemyBlocked, total);
        steps.push({
          kind: 'guard',
          durationMs: 220,
          enemyHpFrom: enemyHp,
          enemyHpTo: enemyHp,
          blockTo: total,
        });
      }
      continue;
    }
    if (type === 'healed') {
      const total = number(event, 'totalHp');
      steps.push({
        kind: 'heal',
        durationMs: 220,
        hpFrom: hp,
        hpTo: total,
      });
      hp = total;
      continue;
    }
    if (type === 'burn-ticked') {
      steps.push({ kind: 'burn', durationMs: 200 });
      continue;
    }
    if (type === 'battle-ended') {
      steps.push({
        kind: text(event, 'result') === 'victory' ? 'victory' : 'rescue',
        durationMs: 360,
      });
    }
  }
  if (steps.length === 0) {
    steps.push({
      kind: lastCardKind ?? 'none',
      durationMs: 120,
      hpFrom: before.hp,
      hpTo: after.hp,
      blockFrom: before.block,
      blockTo: after.block,
      enemyHpFrom: before.enemyHp,
      enemyHpTo: after.enemyHp,
    });
  }
  return steps;
}

function text(event: Record<string, unknown>, field: string): string {
  const value = event[field];
  return typeof value === 'string' ? value : '';
}

function number(event: Record<string, unknown>, field: string): number {
  const value = event[field];
  return typeof value === 'number' ? value : 0;
}
