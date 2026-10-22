export interface InputState {
  /** Movement intent, each axis in [-1, 1]. */
  x: number;
  y: number;
  /** True for one poll after the Nova key/button was pressed. */
  consumeNova(): boolean;
  /** Queue a Nova cast (used by the on-screen button). */
  queueNova(): void;
}

/** Keyboard (WASD/arrows/space) plus a floating touch joystick and Nova button. */
export function createInput(root: HTMLElement): InputState {
  const keys = new Set<string>();
  let novaQueued = false;
  let joyX = 0;
  let joyY = 0;

  addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      novaQueued = true;
      e.preventDefault();
    }
    keys.add(e.code);
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());

  // Touch joystick: any pointer-down on the playfield (not on UI) starts a drag.
  const base = document.createElement('div');
  base.className = 'joy';
  const knob = document.createElement('div');
  knob.className = 'joy-knob';
  base.append(knob);
  root.append(base);

  const R = 56;
  let pid = -1;
  let ox = 0;
  let oy = 0;
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || pid !== -1) return;
    pid = e.pointerId;
    ox = e.clientX;
    oy = e.clientY;
    base.style.left = `${ox}px`;
    base.style.top = `${oy}px`;
    base.classList.add('on');
    canvas.setPointerCapture(pid);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pid) return;
    let dx = e.clientX - ox;
    let dy = e.clientY - oy;
    const len = Math.hypot(dx, dy);
    if (len > R) {
      dx = (dx / len) * R;
      dy = (dy / len) * R;
    }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    joyX = dx / R;
    joyY = dy / R;
  });
  const end = (e: PointerEvent): void => {
    if (e.pointerId !== pid) return;
    pid = -1;
    joyX = joyY = 0;
    knob.style.transform = '';
    base.classList.remove('on');
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  return {
    get x() {
      const k = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
      return clamp(k + joyX);
    },
    get y() {
      const k = (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) - (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0);
      return clamp(k + joyY);
    },
    consumeNova() {
      const v = novaQueued;
      novaQueued = false;
      return v;
    },
    queueNova() {
      novaQueued = true;
    },
  };
}

const clamp = (v: number): number => Math.max(-1, Math.min(1, v));
