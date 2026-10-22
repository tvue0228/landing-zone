import './style.css';
import { Game } from './game';
import { installDebug } from './debug';
import { detectLang, setLang, t } from './i18n';
import { sfx } from './audio';
import { createInput } from './input';
import { load } from './save';
import { UI } from './ui';

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    return false;
  }
}

const data = load();
setLang(detectLang(data.lang));
sfx.muted = data.muted;

const root = document.getElementById('ui')!;
const canvas = document.getElementById('game') as HTMLCanvasElement;
const input = createInput(root);
const ui = new UI(root, input);

if (!webglAvailable()) {
  ui.fatal(t('noWebgl'));
} else {
  const game = new Game(canvas, input, ui);
  installDebug(game, new URLSearchParams(location.search));
  game.run();
  const params = new URLSearchParams(location.search);
  if (params.has('bot')) {
    sfx.setMuted(true);
    game.start();
  } else {
    ui.showTitle(() => game.start());
  }
}
