// Procedural SFX on the raw Web Audio API: no audio files to ship.
type Wave = OscillatorType;

class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  muted = false;
  private lastPlayed = new Map<string, number>();

  /** Must be called from a user gesture (autoplay policy). */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.25;
      this.master.connect(this.ctx.destination);
    }
    void this.ctx.resume();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.25;
  }

  private blip(freq: number, to: number, dur: number, type: Wave, vol: number, delay = 0): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(to, 20), t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** Rate-limit spammy sounds so a swarm doesn't turn into noise. */
  private gate(name: string, minGapMs: number): boolean {
    const now = performance.now();
    if (now - (this.lastPlayed.get(name) ?? 0) < minGapMs) return false;
    this.lastPlayed.set(name, now);
    return true;
  }

  shoot(): void { if (this.gate('shoot', 60)) this.blip(620, 280, 0.08, 'square', 0.12); }
  hit(): void { if (this.gate('hit', 40)) this.blip(180, 70, 0.07, 'sawtooth', 0.1); }
  pickup(): void { if (this.gate('pickup', 50)) this.blip(660, 990, 0.07, 'sine', 0.12); }
  hurt(): void { this.blip(220, 60, 0.25, 'sawtooth', 0.22); }
  nova(): void { this.blip(90, 700, 0.45, 'triangle', 0.3); this.blip(700, 90, 0.5, 'sine', 0.2, 0.05); }
  levelUp(): void { [523, 659, 784, 1047].forEach((f, i) => this.blip(f, f, 0.12, 'square', 0.14, i * 0.09)); }
  win(): void { [523, 659, 784, 1047, 1319].forEach((f, i) => this.blip(f, f, 0.18, 'triangle', 0.2, i * 0.12)); }
  lose(): void { [392, 330, 262, 196].forEach((f, i) => this.blip(f, f * 0.8, 0.22, 'sawtooth', 0.16, i * 0.16)); }
}

export const sfx = new Sfx();
