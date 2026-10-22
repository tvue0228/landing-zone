import type { Game } from './game';
import type { InputState } from './input';

/**
 * Dev-only helpers, enabled with query flags:
 *   ?debug          expose window.__game (state snapshots for tests)
 *   ?timescale=N    run N simulation steps per frame
 *   ?bot            autopilot: kite away from the horde, auto-click the first upgrade
 */
export function installDebug(game: Game, params: URLSearchParams): void {
  if (!params.has('debug') && !params.has('bot')) return;
  (window as unknown as Record<string, unknown>).__game = game;
  const ts = Number(params.get('timescale'));
  if (ts >= 1) game.timescale = Math.min(20, Math.floor(ts));

  if (!params.has('bot')) return;
  const real = game.input;
  let x = 0;
  let y = 0;
  game.input = {
    get x() { return x; },
    get y() { return y; },
    consumeNova: () => real.consumeNova(),
    queueNova: () => real.queueNova(),
  } satisfies InputState;

  setInterval(() => {
    const s = game.debugSnapshot();
    // Flee from the average position of enemies within 12 units, else drift in a circle.
    let fx = 0;
    let fy = 0;
    for (const [ex, ez] of s.enemyPositions) {
      const dx = s.px - ex;
      const dz = s.pz - ez;
      const d2 = dx * dx + dz * dz;
      if (d2 < 144) {
        fx += dx / (d2 + 1);
        fy += dz / (d2 + 1);
      }
    }
    // Steer back toward the middle if we're near the walls.
    fx -= s.px * 0.02;
    fy -= s.pz * 0.02;
    const m = Math.hypot(fx, fy);
    if (m > 0.001) { x = fx / m; y = fy / m; } else { x = Math.cos(s.time); y = Math.sin(s.time); }
    if (game.novaCd === 0 && s.enemies > 25) game.input.queueNova();
    (document.querySelector('.choice') as HTMLButtonElement | null)?.click();
  }, 100);
}
