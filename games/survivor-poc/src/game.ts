import {
  AmbientLight,
  Color,
  ConeGeometry,
  DirectionalLight,
  DoubleSide,
  Fog,
  GridHelper,
  Group,
  HemisphereLight,
  IcosahedronGeometry,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  OctahedronGeometry,
  PerspectiveCamera,
  PlaneGeometry,
  RingGeometry,
  Scene,
  SphereGeometry,
  TetrahedronGeometry,
  WebGLRenderer,
} from 'three';
import { sfx } from './audio';
import type { InputState } from './input';
import { t } from './i18n';
import type { UI } from './ui';
import { baseStats, rollChoices, xpForLevel, type Stats } from './upgrades';

const HALF = 40; // arena half-size
const WIN_TIME = 180;
const MAX_ENEMIES = 260;
const MAX_PROJ = 160;
const MAX_GEMS = 400;
const MAX_PARTS = 300;
const SPAWN_RADIUS = 30;
const NOVA_CD = 18;
const NOVA_RADIUS = 9;
const FIRE_RANGE = 24;
const CAM_OFFSET = { y: 19, z: 13 };

interface Enemy { id: number; x: number; z: number; hp: number; speed: number; r: number; dmg: number; xp: number; flash: number; color: Color; phase: number }
interface Proj { x: number; z: number; vx: number; vz: number; life: number; dmg: number; pierce: number; hit: number[] }
interface Gem { x: number; z: number; xp: number; pulled: boolean }
interface Part { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; color: Color }

type State = 'title' | 'play' | 'levelup' | 'end';

const ENEMY_COLORS = { basic: new Color('#8e5bd6'), fast: new Color('#ff5d8f'), tank: new Color('#3aa17e') };

export class Game {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(45, 1, 0.1, 200);
  input: InputState;
  /** Fixed sub-steps per rendered frame; only raised by ?timescale= for testing. */
  timescale = 1;

  state: State = 'title';
  time = 0;
  kills = 0;
  level = 1;
  xp = 0;
  stats: Stats = baseStats();
  novaCd = 0;

  private player = new Group();
  private px = 0;
  private pz = 0;
  private faceY = 0;
  private invuln = 0;
  private fireTimer = 0;
  private spawnAcc = 0;
  private nextId = 1;
  private enemies: Enemy[] = [];
  private projs: Proj[] = [];
  private gems: Gem[] = [];
  private parts: Part[] = [];
  private novaAnim = -1;
  private novaRing: Mesh;

  private enemyMesh: InstancedMesh;
  private projMesh: InstancedMesh;
  private gemMesh: InstancedMesh;
  private partMesh: InstancedMesh;
  private dummy = new Object3D();
  private tmpColor = new Color();
  private white = new Color('#ffffff');
  private last = 0;
  private raf = 0;

  constructor(canvas: HTMLCanvasElement, input: InputState, private ui: UI) {
    this.input = input;
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.scene.background = new Color('#1a1630');
    this.scene.fog = new Fog('#1a1630', 35, 75);

    this.scene.add(new HemisphereLight('#bcd0ff', '#2a2148', 1.5), new AmbientLight('#ffffff', 0.4));
    const sun = new DirectionalLight('#fff2dd', 1.8);
    sun.position.set(-10, 25, 8);
    this.scene.add(sun);

    const ground = new Mesh(new PlaneGeometry(HALF * 2 + 40, HALF * 2 + 40), new MeshLambertMaterial({ color: '#2b3a55' }));
    ground.rotation.x = -Math.PI / 2;
    const grid = new GridHelper(HALF * 2, HALF, '#3d507a', '#34466b');
    grid.position.y = 0.01;
    this.scene.add(ground, grid);
    const border = new Mesh(new RingGeometry(HALF * Math.SQRT2 - 0.2, HALF * Math.SQRT2, 4, 1, Math.PI / 4), new MeshBasicMaterial({ color: '#ff7a59', side: DoubleSide }));
    border.rotation.x = -Math.PI / 2;
    border.position.y = 0.02;
    this.scene.add(border);

    this.buildPlayer();
    this.scene.add(this.player);

    this.enemyMesh = this.instanced(new IcosahedronGeometry(1, 1), new MeshLambertMaterial({ color: '#ffffff', flatShading: true }), MAX_ENEMIES);
    this.enemyMesh.setColorAt(0, this.white);
    this.projMesh = this.instanced(new SphereGeometry(0.24, 8, 6), new MeshBasicMaterial({ color: '#ffe14d' }), MAX_PROJ);
    this.gemMesh = this.instanced(new OctahedronGeometry(0.3), new MeshBasicMaterial({ color: '#4ed1ff' }), MAX_GEMS);
    this.partMesh = this.instanced(new TetrahedronGeometry(0.22), new MeshBasicMaterial({ color: '#ffffff' }), MAX_PARTS);
    this.partMesh.setColorAt(0, this.white);

    this.novaRing = new Mesh(new RingGeometry(0.92, 1, 48), new MeshBasicMaterial({ color: '#ff9d6e', transparent: true, side: DoubleSide, depthWrite: false }));
    this.novaRing.rotation.x = -Math.PI / 2;
    this.novaRing.visible = false;
    this.scene.add(this.novaRing);

    addEventListener('resize', () => this.resize());
    this.resize();
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      cancelAnimationFrame(this.raf);
      this.ui.fatal(t('noWebgl'));
    });
    this.updateCamera(1);
  }

  private instanced(geo: ConstructorParameters<typeof InstancedMesh>[0], mat: ConstructorParameters<typeof InstancedMesh>[1], max: number): InstancedMesh {
    const m = new InstancedMesh(geo, mat, max);
    m.count = 0;
    m.frustumCulled = false; // the cached bounding sphere would not follow moving instances
    this.scene.add(m);
    return m;
  }

  private buildPlayer(): void {
    const skin = new MeshLambertMaterial({ color: '#ff7a59' });
    const white = new MeshBasicMaterial({ color: '#ffffff' });
    const dark = new MeshBasicMaterial({ color: '#1a1630' });
    const body = new Mesh(new SphereGeometry(0.8, 20, 14), skin);
    body.scale.set(1, 0.9, 1);
    body.position.y = 0.8;
    const earGeo = new ConeGeometry(0.25, 0.55, 8);
    const earL = new Mesh(earGeo, skin);
    earL.position.set(-0.5, 1.7, 0);
    earL.rotation.z = 0.35;
    const earR = earL.clone();
    earR.position.x = 0.5;
    earR.rotation.z = -0.35;
    const face = new Group(); // +Z is "forward"
    for (const sx of [-0.28, 0.28]) {
      const eye = new Mesh(new SphereGeometry(0.17, 10, 8), white);
      eye.position.set(sx, 1.0, 0.68);
      const pupil = new Mesh(new SphereGeometry(0.08, 8, 6), dark);
      pupil.position.set(sx, 1.0, 0.82);
      face.add(eye, pupil);
    }
    this.player.add(body, earL, earR, face);
  }

  private resize(): void {
    const w = innerWidth;
    const h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private updateCamera(lerp: number): void {
    // Pull the camera back on portrait screens so the playfield still fits.
    const k = this.camera.aspect < 1 ? 1.5 : 1;
    const tx = this.px;
    const ty = CAM_OFFSET.y * k;
    const tz = this.pz + CAM_OFFSET.z * k;
    this.camera.position.x += (tx - this.camera.position.x) * lerp;
    this.camera.position.y += (ty - this.camera.position.y) * lerp;
    this.camera.position.z += (tz - this.camera.position.z) * lerp;
    this.camera.lookAt(this.px, 0, this.pz);
  }

  start(): void {
    this.reset();
    this.state = 'play';
    this.ui.closeScreen();
    this.ui.showHud(true);
  }

  private reset(): void {
    this.time = 0;
    this.kills = 0;
    this.level = 1;
    this.xp = 0;
    this.stats = baseStats();
    this.novaCd = 0;
    this.px = this.pz = 0;
    this.invuln = 0;
    this.fireTimer = 0;
    this.spawnAcc = 0;
    this.enemies.length = this.projs.length = this.gems.length = this.parts.length = 0;
    this.novaAnim = -1;
    this.novaRing.visible = false;
  }

  run(): void {
    this.last = performance.now();
    const frame = (now: number): void => {
      this.raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      for (let i = 0; i < this.timescale; i++) this.step(dt);
      this.draw(now / 1000);
    };
    this.raf = requestAnimationFrame(frame);
  }

  // ---- simulation ---------------------------------------------------------

  private step(dt: number): void {
    if (this.state !== 'play') return;
    this.time += dt;
    this.invuln = Math.max(0, this.invuln - dt);
    this.novaCd = Math.max(0, this.novaCd - dt);

    this.movePlayer(dt);
    if (this.input.consumeNova() && this.novaCd === 0) this.castNova();
    this.autoFire(dt);
    this.spawn(dt);
    this.updateEnemies(dt);
    this.updateProjectiles(dt);
    this.updateGems(dt);
    this.updateParticles(dt);
    this.updateNova(dt);

    if (this.stats.hp <= 0) return this.finish(false);
    if (this.time >= WIN_TIME) return this.finish(true);
    if (this.xp >= xpForLevel(this.level)) this.levelUp();
  }

  private movePlayer(dt: number): void {
    let dx = this.input.x;
    let dz = this.input.y;
    const len = Math.hypot(dx, dz);
    if (len > 1) {
      dx /= len;
      dz /= len;
    }
    this.px = Math.max(-HALF, Math.min(HALF, this.px + dx * this.stats.speed * dt));
    this.pz = Math.max(-HALF, Math.min(HALF, this.pz + dz * this.stats.speed * dt));
    if (len > 0.1) {
      const target = Math.atan2(dx, dz);
      let diff = target - this.faceY;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      this.faceY += diff * Math.min(1, dt * 14);
    }
  }

  private autoFire(dt: number): void {
    this.fireTimer -= dt;
    if (this.fireTimer > 0) return;
    let best: Enemy | null = null;
    let bestD = FIRE_RANGE * FIRE_RANGE;
    for (const e of this.enemies) {
      const d = (e.x - this.px) ** 2 + (e.z - this.pz) ** 2;
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    if (!best) {
      this.fireTimer = 0;
      return;
    }
    this.fireTimer = this.stats.cooldown;
    const base = Math.atan2(best.z - this.pz, best.x - this.px);
    const n = this.stats.projectiles;
    for (let i = 0; i < n && this.projs.length < MAX_PROJ; i++) {
      const a = base + (i - (n - 1) / 2) * 0.2;
      this.projs.push({ x: this.px, z: this.pz, vx: Math.cos(a) * 20, vz: Math.sin(a) * 20, life: 1.4, dmg: this.stats.damage, pierce: this.stats.pierce, hit: [] });
    }
    sfx.shoot();
  }

  private spawn(dt: number): void {
    this.spawnAcc += dt * (0.8 + this.time / 40);
    while (this.spawnAcc >= 1) {
      this.spawnAcc -= 1;
      if (this.enemies.length >= MAX_ENEMIES) continue;
      const a = Math.random() * Math.PI * 2;
      const roll = Math.random();
      const hp = 12 + this.time * 0.12;
      const speed = 2.3 + Math.random() * 0.7 + Math.min(this.time * 0.012, 1.8);
      let e: Enemy = { id: this.nextId++, x: this.px + Math.cos(a) * SPAWN_RADIUS, z: this.pz + Math.sin(a) * SPAWN_RADIUS, hp, speed, r: 0.75, dmg: 6 + this.time / 30, xp: 1, flash: 0, color: ENEMY_COLORS.basic, phase: Math.random() * 6 };
      if (this.time > 90 && roll < 0.14) e = { ...e, hp: hp * 3.2, speed: speed * 0.7, r: 1.25, dmg: e.dmg * 1.6, xp: 3, color: ENEMY_COLORS.tank };
      else if (this.time > 35 && roll < 0.35) e = { ...e, hp: hp * 0.6, speed: speed * 1.55, r: 0.55, color: ENEMY_COLORS.fast };
      e.x = Math.max(-HALF - 6, Math.min(HALF + 6, e.x));
      e.z = Math.max(-HALF - 6, Math.min(HALF + 6, e.z));
      this.enemies.push(e);
    }
  }

  private updateEnemies(dt: number): void {
    const es = this.enemies;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      let dx = this.px - e.x;
      let dz = this.pz - e.z;
      const d = Math.hypot(dx, dz) || 1;
      dx /= d;
      dz /= d;
      let sx = 0;
      let sz = 0;
      // Soft separation so the horde spreads out instead of stacking on one point.
      for (let j = i + 1; j < es.length; j++) {
        const o = es[j];
        const ox = e.x - o.x;
        const oz = e.z - o.z;
        const min = e.r + o.r;
        if (Math.abs(ox) > min || Math.abs(oz) > min) continue;
        const dist = Math.hypot(ox, oz) || 0.001;
        if (dist < min) {
          const push = ((min - dist) / min) * 3;
          sx += (ox / dist) * push;
          sz += (oz / dist) * push;
          o.x -= (ox / dist) * push * dt;
          o.z -= (oz / dist) * push * dt;
        }
      }
      e.x += (dx * e.speed + sx) * dt;
      e.z += (dz * e.speed + sz) * dt;
      e.flash = Math.max(0, e.flash - dt * 6);
      if (d < e.r + 0.7 && this.invuln === 0) {
        this.stats.hp -= e.dmg;
        this.invuln = 0.5;
        sfx.hurt();
      }
    }
  }

  private updateProjectiles(dt: number): void {
    for (let i = this.projs.length - 1; i >= 0; i--) {
      const p = this.projs[i];
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      p.life -= dt;
      let dead = p.life <= 0;
      if (!dead) {
        for (const e of this.enemies) {
          const rr = e.r + 0.25;
          if ((e.x - p.x) ** 2 + (e.z - p.z) ** 2 > rr * rr || p.hit.includes(e.id)) continue;
          p.hit.push(e.id);
          this.damage(e, p.dmg, p.vx, p.vz);
          if (p.pierce-- <= 0) {
            dead = true;
            break;
          }
        }
      }
      if (dead) {
        this.projs[i] = this.projs[this.projs.length - 1];
        this.projs.pop();
      }
    }
    this.reapEnemies();
  }

  /** Remove enemies killed this frame (hp <= 0) after all hits resolved. */
  private reapEnemies(): void {
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (e.hp > 0) continue;
      this.kills++;
      if (this.gems.length < MAX_GEMS) this.gems.push({ x: e.x, z: e.z, xp: e.xp, pulled: false });
      this.burst(e.x, e.z, e.color, 6);
      this.enemies[i] = this.enemies[this.enemies.length - 1];
      this.enemies.pop();
    }
  }

  private damage(e: Enemy, amount: number, kx: number, kz: number): void {
    e.hp -= amount;
    e.flash = 1;
    const k = Math.hypot(kx, kz) || 1;
    e.x += (kx / k) * 0.35;
    e.z += (kz / k) * 0.35;
    sfx.hit();
  }

  private updateGems(dt: number): void {
    const pr2 = this.stats.pickupRadius ** 2;
    for (let i = this.gems.length - 1; i >= 0; i--) {
      const g = this.gems[i];
      const dx = this.px - g.x;
      const dz = this.pz - g.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < pr2) g.pulled = true;
      if (g.pulled) {
        const d = Math.sqrt(d2) || 1;
        const sp = 14 + 10 / (d + 0.5);
        g.x += (dx / d) * sp * dt;
        g.z += (dz / d) * sp * dt;
      }
      if (d2 < 0.6) {
        this.xp += g.xp;
        sfx.pickup();
        this.gems[i] = this.gems[this.gems.length - 1];
        this.gems.pop();
      }
    }
  }

  private burst(x: number, z: number, color: Color, n: number): void {
    for (let i = 0; i < n && this.parts.length < MAX_PARTS; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 2 + Math.random() * 4;
      this.parts.push({ x, y: 0.6, z, vx: Math.cos(a) * s, vy: 3 + Math.random() * 3, vz: Math.sin(a) * s, life: 0.5 + Math.random() * 0.3, color });
    }
  }

  private updateParticles(dt: number): void {
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.life -= dt;
      p.vy -= 14 * dt;
      p.x += p.vx * dt;
      p.y = Math.max(0.05, p.y + p.vy * dt);
      p.z += p.vz * dt;
      if (p.life <= 0) {
        this.parts[i] = this.parts[this.parts.length - 1];
        this.parts.pop();
      }
    }
  }

  private castNova(): void {
    this.novaCd = NOVA_CD;
    this.novaAnim = 0;
    sfx.nova();
    for (const e of this.enemies) {
      const dx = e.x - this.px;
      const dz = e.z - this.pz;
      if (dx * dx + dz * dz < NOVA_RADIUS * NOVA_RADIUS) this.damage(e, this.stats.damage * 4, dx, dz);
    }
    this.reapEnemies();
  }

  private updateNova(dt: number): void {
    if (this.novaAnim < 0) return;
    this.novaAnim += dt / 0.5;
    if (this.novaAnim >= 1) {
      this.novaAnim = -1;
      this.novaRing.visible = false;
      return;
    }
    const r = NOVA_RADIUS * this.novaAnim;
    this.novaRing.visible = true;
    this.novaRing.position.set(this.px, 0.05, this.pz);
    this.novaRing.scale.set(r, r, 1);
    (this.novaRing.material as MeshBasicMaterial).opacity = 1 - this.novaAnim;
  }

  private levelUp(): void {
    this.xp -= xpForLevel(this.level);
    this.level++;
    this.state = 'levelup';
    sfx.levelUp();
    this.ui.showLevelUp(rollChoices(3), (u) => {
      u.apply(this.stats);
      this.state = 'play';
    });
  }

  private finish(win: boolean): void {
    this.state = 'end';
    if (win) sfx.win();
    else sfx.lose();
    this.ui.showHud(false);
    this.ui.showEnd(win, this.time, this.kills, () => this.start());
  }

  // ---- rendering ----------------------------------------------------------

  private draw(sec: number): void {
    const d = this.dummy;
    const moving = Math.hypot(this.input.x, this.input.y) > 0.1;
    this.player.position.set(this.px, moving ? Math.abs(Math.sin(sec * 12)) * 0.12 : 0, this.pz);
    this.player.rotation.y = this.faceY;
    this.player.visible = this.state === 'title' || this.state === 'end' || this.invuln === 0 || Math.floor(sec * 20) % 2 === 0;

    const es = this.enemies;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      d.position.set(e.x, e.r + Math.abs(Math.sin(sec * 6 + e.phase)) * 0.15, e.z);
      d.rotation.set(0, sec + e.phase, 0);
      d.scale.setScalar(e.r);
      d.updateMatrix();
      this.enemyMesh.setMatrixAt(i, d.matrix);
      this.enemyMesh.setColorAt(i, this.tmpColor.copy(e.color).lerp(this.white, e.flash));
    }
    this.enemyMesh.count = es.length;
    this.enemyMesh.instanceMatrix.needsUpdate = true;
    if (this.enemyMesh.instanceColor) this.enemyMesh.instanceColor.needsUpdate = true;

    this.fill(this.projMesh, this.projs, (o, p) => o.position.set(p.x, 0.8, p.z));
    this.fill(this.gemMesh, this.gems, (o, g) => {
      o.position.set(g.x, 0.5 + Math.sin(sec * 4 + g.x) * 0.1, g.z);
      o.rotation.y = sec * 2;
    });
    const ps = this.parts;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      d.position.set(p.x, p.y, p.z);
      d.rotation.set(sec * 5 + i, sec * 3, 0);
      d.scale.setScalar(Math.max(0.1, p.life * 1.6));
      d.updateMatrix();
      this.partMesh.setMatrixAt(i, d.matrix);
      this.partMesh.setColorAt(i, p.color);
    }
    this.partMesh.count = ps.length;
    this.partMesh.instanceMatrix.needsUpdate = true;
    if (this.partMesh.instanceColor) this.partMesh.instanceColor.needsUpdate = true;

    this.updateCamera(0.12);
    this.renderer.render(this.scene, this.camera);

    if (this.state === 'play') {
      this.ui.update({ hp: this.stats.hp, maxHp: this.stats.maxHp, xp: this.xp, xpNeed: xpForLevel(this.level), level: this.level, kills: this.kills, time: this.time, novaReady: 1 - this.novaCd / NOVA_CD });
    }
  }

  /** Writes simple (position-only, uniform-scale) instances for pooled entity lists. */
  private fill<T>(mesh: InstancedMesh, items: T[], place: (o: Object3D, item: T) => void): void {
    const d = this.dummy;
    for (let i = 0; i < items.length; i++) {
      d.rotation.set(0, 0, 0);
      d.scale.setScalar(1);
      place(d, items[i]);
      d.updateMatrix();
      mesh.setMatrixAt(i, d.matrix);
    }
    mesh.count = items.length;
    mesh.instanceMatrix.needsUpdate = true;
  }

  /** Test/debug accessors (exposed only with ?debug). */
  debugSnapshot() {
    return { state: this.state, time: this.time, kills: this.kills, level: this.level, hp: this.stats.hp, enemies: this.enemies.length, projs: this.projs.length, gems: this.gems.length, px: this.px, pz: this.pz, enemyPositions: this.enemies.map((e) => [e.x, e.z] as const) };
  }
}
