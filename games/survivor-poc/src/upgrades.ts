import type { Key } from './i18n';

export interface Stats {
  maxHp: number;
  hp: number;
  speed: number;
  damage: number;
  /** Seconds between volleys. */
  cooldown: number;
  projectiles: number;
  pierce: number;
  pickupRadius: number;
}

export const baseStats = (): Stats => ({
  maxHp: 100,
  hp: 100,
  speed: 6.5,
  damage: 12,
  cooldown: 0.6,
  projectiles: 1,
  pierce: 0,
  pickupRadius: 2.6,
});

export interface Upgrade {
  id: string;
  name: Key;
  desc: Key;
  apply(s: Stats): void;
}

export const UPGRADES: readonly Upgrade[] = [
  { id: 'damage', name: 'up.damage', desc: 'up.damage.d', apply: (s) => (s.damage *= 1.25) },
  { id: 'rate', name: 'up.rate', desc: 'up.rate.d', apply: (s) => (s.cooldown = Math.max(0.15, s.cooldown / 1.2)) },
  { id: 'multi', name: 'up.multi', desc: 'up.multi.d', apply: (s) => (s.projectiles = Math.min(7, s.projectiles + 1)) },
  { id: 'speed', name: 'up.speed', desc: 'up.speed.d', apply: (s) => (s.speed *= 1.12) },
  { id: 'magnet', name: 'up.magnet', desc: 'up.magnet.d', apply: (s) => (s.pickupRadius *= 1.4) },
  {
    id: 'hp',
    name: 'up.hp',
    desc: 'up.hp.d',
    apply: (s) => {
      s.maxHp += 20;
      s.hp = Math.min(s.maxHp, s.hp + 40);
    },
  },
  { id: 'pierce', name: 'up.pierce', desc: 'up.pierce.d', apply: (s) => (s.pierce += 1) },
];

/** Pick `n` distinct random upgrades. */
export function rollChoices(n: number, rnd: () => number = Math.random): Upgrade[] {
  const pool = [...UPGRADES];
  const out: Upgrade[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  return out;
}

/** XP needed to go from `level` to `level + 1`. */
export const xpForLevel = (level: number): number => 4 + level * 3;
