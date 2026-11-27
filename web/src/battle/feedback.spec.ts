import { describe, expect, it } from 'vitest';
import { battleFeedbackSteps } from './feedback';

describe('battleFeedbackSteps', () => {
  it('turns accepted card events into one hit and one displayed damage drop', () => {
    const steps = battleFeedbackSteps(
      [
        { type: 'card-played', definitionId: 'traveler-strike' },
        {
          type: 'damage',
          source: 'card',
          hpLost: 6,
          blocked: 0,
        },
      ],
      { hp: 30, block: 0, enemyHp: 36, enemyBlocked: 0 },
      { hp: 30, block: 0, enemyHp: 30, enemyBlocked: 0 },
    );

    expect(steps.map((step) => step.kind)).toEqual(['strike']);
    expect(steps[0]).toMatchObject({
      enemyHpFrom: 36,
      enemyHpTo: 30,
    });
  });

  it('shows a guard effect before the committed enemy damage lands', () => {
    const steps = battleFeedbackSteps(
      [
        { type: 'card-played', definitionId: 'companion-guard' },
        { type: 'block-gained', targetId: 'party', totalBlock: 5 },
        {
          type: 'damage',
          source: 'enemy',
          hpLost: 1,
          blocked: 5,
        },
      ],
      { hp: 30, block: 0, enemyHp: 36, enemyBlocked: 0 },
      { hp: 29, block: 0, enemyHp: 36, enemyBlocked: 0 },
    );

    expect(steps[0]?.kind).toBe('guard');
    expect(steps.map((step) => step.kind)).toEqual(['guard', 'guard']);
  });

  it('treats an overshielded attack as a blocked result with no invented damage', () => {
    const steps = battleFeedbackSteps(
      [
        {
          type: 'damage',
          source: 'card',
          amount: 6,
          blocked: 6,
          hpLost: 0,
        },
      ],
      { hp: 30, block: 5, enemyHp: 20, enemyBlocked: 6 },
      { hp: 30, block: 5, enemyHp: 20, enemyBlocked: 6 },
    );

    expect(steps[0]).toMatchObject({
      kind: 'strike',
      blocked: 6,
      enemyHpFrom: 20,
      enemyHpTo: 20,
    });
  });
});
