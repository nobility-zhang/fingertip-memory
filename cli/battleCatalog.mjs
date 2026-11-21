export const BATTLE_CARDS = Object.freeze({
  'traveler-strike': {
    name: '旅人突刺',
    cost: 1,
    target: 'enemy',
    effect: '伤害 6',
  },
  'companion-guard': {
    name: '同伴守护',
    cost: 1,
    target: 'none',
    effect: '格挡 5',
  },
  'ember-rune': {
    name: '余烬符文',
    cost: 1,
    target: 'enemy',
    effect: '伤害 3，灼烧 2 回合',
  },
  'herb-pouch': {
    name: '采药包',
    cost: 1,
    target: 'none',
    effect: '回复 4',
  },
  'observe-signpost': {
    name: '观察路标',
    cost: 0,
    target: 'none',
    effect: '抽 1，消耗',
  },
  'party-strike': {
    name: '旅团合击',
    cost: 2,
    target: 'enemy',
    effect: '伤害 10',
  },
});
