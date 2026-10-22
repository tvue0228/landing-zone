import { LANGS, getLang, setLang, t, type Lang } from './i18n';
import { sfx } from './audio';
import { load, save } from './save';
import type { InputState } from './input';
import type { Upgrade } from './upgrades';

const fmtTime = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** DOM overlay: HUD plus title / level-up / end screens. Kept framework-free on purpose. */
export class UI {
  private hud: HTMLElement;
  private hpFill: HTMLElement;
  private xpFill: HTMLElement;
  private timeEl: HTMLElement;
  private lvEl: HTMLElement;
  private killEl: HTMLElement;
  private novaBtn: HTMLButtonElement;
  private novaFill: HTMLElement;
  private screen: HTMLElement | null = null;
  private lastTime = -1;

  constructor(private root: HTMLElement, private input: InputState) {
    this.hud = el('div', 'hud hidden');
    const top = el('div', 'hud-top');
    this.timeEl = el('div', 'hud-time');
    this.lvEl = el('div', 'hud-chip');
    this.killEl = el('div', 'hud-chip');
    top.append(this.lvEl, this.timeEl, this.killEl);

    const bars = el('div', 'bars');
    const hp = el('div', 'bar hp');
    this.hpFill = el('div', 'fill');
    hp.append(this.hpFill);
    const xp = el('div', 'bar xp');
    this.xpFill = el('div', 'fill');
    xp.append(this.xpFill);
    bars.append(hp, xp);

    this.novaBtn = document.createElement('button');
    this.novaBtn.className = 'nova';
    this.novaFill = el('div', 'nova-fill');
    this.novaBtn.append(this.novaFill, el('span', ''));
    this.novaBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.input.queueNova();
    });

    this.hud.append(top, bars, this.novaBtn);
    root.append(this.hud);
  }

  showHud(on: boolean): void {
    this.hud.classList.toggle('hidden', !on);
    this.novaBtn.firstElementChild!.nextElementSibling!.textContent = t('nova');
  }

  /** Cheap per-frame HUD refresh; only touches the DOM when something changed. */
  update(s: { hp: number; maxHp: number; xp: number; xpNeed: number; level: number; kills: number; time: number; novaReady: number }): void {
    this.hpFill.style.transform = `scaleX(${Math.max(0, s.hp / s.maxHp)})`;
    this.xpFill.style.transform = `scaleX(${Math.min(1, s.xp / s.xpNeed)})`;
    this.novaFill.style.transform = `scaleY(${1 - s.novaReady})`;
    this.novaBtn.classList.toggle('ready', s.novaReady >= 1);
    const sec = Math.floor(s.time);
    if (sec !== this.lastTime) {
      this.lastTime = sec;
      this.timeEl.textContent = fmtTime(s.time);
    }
    this.lvEl.textContent = `${t('level')} ${s.level}`;
    this.killEl.textContent = `☠ ${s.kills}`;
  }

  private open(card: HTMLElement): void {
    this.closeScreen();
    this.screen = el('div', 'screen');
    this.screen.append(card);
    this.root.append(this.screen);
  }

  closeScreen(): void {
    this.screen?.remove();
    this.screen = null;
  }

  showTitle(onPlay: () => void): void {
    const data = load();
    const card = el('div', 'card');
    const touch = matchMedia('(pointer: coarse)').matches;
    card.append(
      h('h1', t('title')),
      h('p', t('tagline')),
      h('p', `${t('best')}: ${data.bestTime ? fmtTime(data.bestTime) : '–'} · ☠ ${data.bestKills}`, 'muted'),
      button(t('play'), 'primary', () => {
        sfx.unlock();
        onPlay();
      }),
      h('p', touch ? t('touchControls') : t('controls'), 'muted small'),
    );

    const row = el('div', 'row');
    for (const l of LANGS) {
      const b = button(l.toUpperCase(), getLang() === l ? 'chip on' : 'chip', () => {
        setLang(l as Lang);
        save({ lang: l });
        this.showTitle(onPlay);
      });
      row.append(b);
    }
    const mute = button(sfx.muted ? t('muteOff') : t('muteOn'), 'chip', () => {
      sfx.unlock();
      sfx.setMuted(!sfx.muted);
      save({ muted: sfx.muted });
      mute.textContent = sfx.muted ? t('muteOff') : t('muteOn');
    });
    row.append(mute);
    card.append(row);
    this.open(card);
  }

  showLevelUp(choices: Upgrade[], onPick: (u: Upgrade) => void): void {
    const card = el('div', 'card');
    card.append(h('h2', t('levelUp')), h('p', t('pick'), 'muted'));
    const list = el('div', 'choices');
    choices.forEach((u, i) => {
      const b = button('', 'choice', () => {
        window.removeEventListener('keydown', onKey);
        this.closeScreen();
        onPick(u);
      });
      b.append(h('strong', `${i + 1}. ${t(u.name)}`), h('span', t(u.desc), 'muted'));
      list.append(b);
    });
    card.append(list);
    const onKey = (e: KeyboardEvent): void => {
      const i = Number(e.key) - 1;
      if (choices[i]) (list.children[i] as HTMLButtonElement).click();
    };
    window.addEventListener('keydown', onKey);
    this.open(card);
  }

  showEnd(win: boolean, time: number, kills: number, onAgain: () => void): void {
    const prev = load();
    const newBest = time > prev.bestTime;
    save({ bestTime: Math.max(prev.bestTime, time), bestKills: Math.max(prev.bestKills, kills) });
    const card = el('div', 'card');
    card.append(
      h('h2', win ? t('victory') : t('gameOver')),
      h('p', `${t('survived')}: ${fmtTime(time)}${newBest ? ' ★' : ''}`),
      h('p', `${t('kills')}: ${kills}`),
      button(t('again'), 'primary', onAgain),
    );
    this.open(card);
  }

  fatal(message: string): void {
    const card = el('div', 'card');
    card.append(h('h2', 'PoC'), h('p', message), button(t('retry'), 'primary', () => location.reload()));
    this.open(card);
  }
}

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}
function h(tag: string, text: string, cls = ''): HTMLElement {
  const e = el(tag, cls);
  e.textContent = text;
  return e;
}
function button(text: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}
