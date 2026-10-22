# Survivor PoC

A proof-of-concept 3D "survivor" game in the browser, built to mirror the tech stack observed on a comparable
production site. It uses original placeholder art (primitive shapes) and synthesized sound; no third-party code or
assets are copied.

**Play:** survive 3 minutes. Move, let your bolts auto-fire, collect gems, pick upgrades on level-up, and use Nova
(Space / on-screen button) to clear the crowd.

## Run it

```bash
cd games/survivor-poc
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build into dist/
npm run preview    # serve dist/
```

Controls: `WASD` / arrows to move, `Space` for Nova, `1`/`2`/`3` to pick an upgrade. On touch screens drag anywhere to
move and tap the Nova button.

## Stack (and where each piece lives)

| Concern | Choice | File |
|---|---|---|
| Build | Vite, relative `base`, `three` split into its own chunk | `vite.config.ts` |
| Language | TypeScript (strict) | `tsconfig.json` |
| 3D | three.js r186, `InstancedMesh` for enemies / bolts / gems / particles | `src/game.ts` |
| UI | Framework-free DOM overlay on top of `<canvas id="game">` / `<div id="ui">` | `src/ui.ts`, `src/style.css` |
| Audio | Raw Web Audio API, procedural SFX, unlocked on first gesture | `src/audio.ts` |
| Input | Keyboard + floating touch joystick (pointer events) | `src/input.ts` |
| i18n | Typed string table, `?lang=` / saved / browser language (en, es) | `src/i18n.ts` |
| Save | `localStorage` with in-memory fallback | `src/save.ts` |
| PWA | Web manifest (fullscreen, landscape); no service worker | `public/manifest.webmanifest` |

## Debug flags

| Query | Effect |
|---|---|
| `?debug` | Exposes `window.__game` (`debugSnapshot()`) |
| `?timescale=N` | Runs N simulation steps per frame (max 20) |
| `?bot` | Autopilot that kites the horde and auto-picks upgrades; handy for balance and smoke tests |

Example: `http://localhost:5173/?bot&timescale=6` plays a full run in under a minute.

## Not in the PoC (ideas)

- Real glTF models (GLTFLoader + Draco/KTX2) instead of primitives
- Backend: accounts / leaderboards (e.g. a small API behind Cloudflare Turnstile)
- Service worker for offline play, more languages, more enemy and weapon types, a boss

## Deployment note

Unlike the other projects in this repo this one has a build step. GitHub Pages will not serve `src/` directly: build
and publish `dist/` (it uses relative paths, so it works from a sub-directory).
