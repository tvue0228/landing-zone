export type Lang = 'en' | 'es';

const dict = {
  en: {
    title: 'Survivor PoC',
    tagline: 'Survive the horde for 3 minutes. Level up. Unleash your Nova.',
    play: 'Play',
    best: 'Best',
    controls: 'WASD / arrows to move · Space for Nova',
    touchControls: 'Drag to move · tap Nova',
    levelUp: 'Level up!',
    pick: 'Choose an upgrade',
    gameOver: 'Game over',
    victory: 'Victory!',
    survived: 'Survived',
    kills: 'Kills',
    level: 'Lv',
    again: 'Play again',
    nova: 'Nova',
    muteOn: 'Sound: on',
    muteOff: 'Sound: off',
    noWebgl: 'This game needs WebGL. Enable it and reload.',
    retry: 'Retry',
    'up.damage': 'Sharper bolts',
    'up.damage.d': '+25% damage',
    'up.rate': 'Quick cast',
    'up.rate.d': '+20% fire rate',
    'up.multi': 'Multi-shot',
    'up.multi.d': '+1 projectile',
    'up.speed': 'Swift paws',
    'up.speed.d': '+12% move speed',
    'up.magnet': 'Magnet',
    'up.magnet.d': '+40% pickup radius',
    'up.hp': 'Hardy',
    'up.hp.d': '+20 max HP and heal',
    'up.pierce': 'Piercing',
    'up.pierce.d': 'Bolts pass through +1 enemy',
  },
  es: {
    title: 'Survivor PoC',
    tagline: 'Sobrevive 3 minutos a la horda. Sube de nivel. Lanza tu Nova.',
    play: 'Jugar',
    best: 'Mejor',
    controls: 'WASD / flechas para moverte · Espacio para Nova',
    touchControls: 'Arrastra para moverte · toca Nova',
    levelUp: '¡Subes de nivel!',
    pick: 'Elige una mejora',
    gameOver: 'Fin de la partida',
    victory: '¡Victoria!',
    survived: 'Sobrevivido',
    kills: 'Bajas',
    level: 'Nv',
    again: 'Jugar otra vez',
    nova: 'Nova',
    muteOn: 'Sonido: sí',
    muteOff: 'Sonido: no',
    noWebgl: 'Este juego necesita WebGL. Actívalo y recarga.',
    retry: 'Reintentar',
    'up.damage': 'Rayos afilados',
    'up.damage.d': '+25% de daño',
    'up.rate': 'Lanzamiento rápido',
    'up.rate.d': '+20% de cadencia',
    'up.multi': 'Multidisparo',
    'up.multi.d': '+1 proyectil',
    'up.speed': 'Patas veloces',
    'up.speed.d': '+12% de velocidad',
    'up.magnet': 'Imán',
    'up.magnet.d': '+40% de radio de recogida',
    'up.hp': 'Resistente',
    'up.hp.d': '+20 de vida máxima y curación',
    'up.pierce': 'Perforante',
    'up.pierce.d': 'Los rayos atraviesan +1 enemigo',
  },
} as const;

export type Key = keyof (typeof dict)['en'];

export const LANGS: readonly Lang[] = ['en', 'es'];

let current: Lang = 'en';

export function detectLang(saved?: string): Lang {
  const q = new URLSearchParams(location.search).get('lang');
  for (const c of [q, saved, navigator.language.slice(0, 2)]) {
    if (c && (LANGS as readonly string[]).includes(c)) return c as Lang;
  }
  return 'en';
}

export function setLang(l: Lang): void {
  current = l;
  document.documentElement.lang = l;
}

export const getLang = (): Lang => current;
export const t = (k: Key): string => dict[current][k];
