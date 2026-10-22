import type { Lang } from './i18n';

export interface SaveData {
  bestTime: number;
  bestKills: number;
  lang?: Lang;
  muted: boolean;
}

const KEY = 'survivor-poc.save.v1';
const defaults: SaveData = { bestTime: 0, bestKills: 0, muted: false };

// localStorage can throw (private mode, blocked site data): always degrade to in-memory.
let memory: SaveData | null = null;

export function load(): SaveData {
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(KEY);
    memory = { ...defaults, ...(raw ? (JSON.parse(raw) as Partial<SaveData>) : {}) };
  } catch {
    memory = { ...defaults };
  }
  return memory;
}

export function save(patch: Partial<SaveData>): SaveData {
  memory = { ...load(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    /* storage unavailable: keep the in-memory copy */
  }
  return memory;
}
