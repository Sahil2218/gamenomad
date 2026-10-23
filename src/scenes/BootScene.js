import Phaser from 'phaser';
import villageMap from '../data/maps/village.json';
import outskirtsMap from '../data/maps/outskirts.json';
import wastelandMap from '../data/maps/wasteland.json';
import gateMap from '../data/maps/gate.json';
import hollowMap from '../data/maps/hollow.json';
import siloMap from '../data/maps/silo.json';
import { preloadUI } from '../ui/uiAssets.js';
import { DEV } from '../systems/devFlags.js';
import { GameState } from '../systems/GameState.js';
import { startWorldScene } from '../systems/sceneFlow.js';

// Map pictures, with their size (from the map JSON) for the placeholder if a file is missing.
const MAPS = [
  { name: 'village', w: villageMap.width, h: villageMap.height },
  { name: 'outskirts', w: outskirtsMap.width, h: outskirtsMap.height },
  { name: 'wasteland', w: wastelandMap.width, h: wastelandMap.height },
  { name: 'gate', w: gateMap.width, h: gateMap.height },
  { name: 'hollow', w: hollowMap.width, h: hollowMap.height },
  { name: 'silo', w: siloMap.width, h: siloMap.height },
];

const CHARACTERS = ['nomad', 'mira', 'kael', 'nova', 'ryn', 'eli', 'mayor', 'villager', 'scientist'];
const FRAME = { w: 32, h: 48 }; // one character frame
const SHEET = { cols: 4, rows: 3 }; // rows: down, left, up

// Creature spritesheets (contract M2 §6, M3 §9): one row of frames each.
const CREATURES = [
  { key: 'drone', frameW: 32, frameH: 32, frames: 4 },
  { key: 'crawler', frameW: 32, frameH: 24, frames: 6 },
  { key: 'relay', frameW: 24, frameH: 40, frames: 4 }, // the finale's pulsing cyan pylon
];

// Effect images (w × h). `optional` ones get no placeholder (the code checks whether they exist).
const FX = [
  { key: 'fx-spark', w: 4, h: 4 },
  { key: 'fx-bubble', w: 6, h: 6 },
  { key: 'fx-ember', w: 3, h: 3 },
  { key: 'fx-nanite', w: 2, h: 2 },
  { key: 'fx-slash', w: 28, h: 28 },
  { key: 'fx-glow', w: 32, h: 32 },
  { key: 'fx-cone', w: 64, h: 64, optional: true },
  { key: 'fx-silver', w: 3, h: 3 }, // Eli's silver blood
  { key: 'fx-ash', w: 3, h: 3 }, // the dead city's falling ash
  { key: 'fx-memory', w: 16, h: 4 }, // light streaks of the memory restore
];

const ITEMS = [
  'shard', 'map', 'medkit', 'water', 'ration', 'core',
  'journal', 'radio', 'keycard', 'toolkit', 'crystal', 'medallion',
];

// Scenes that ?scene=... is allowed to jump to. The old 'End' stub is now the 'Ending'.
const START_SCENES = ['Village', 'Outskirts', 'Wasteland', 'Gate', 'Hollow', 'Silo', 'Ending'];
const SCENE_ALIASES = { End: 'Ending' };

// Jumping straight into Act IV or later: what a real playthrough would have by then.
// (Only used when the URL doesn't give ?party / ?give itself.)
const LATE_SCENES = ['Gate', 'Hollow', 'Silo', 'Ending'];
const COMPANIONS = ['mira', 'kael', 'nova', 'ryn', 'eli'];
const ARTIFACTS = ['journal', 'map', 'shard', 'crystal', 'medallion', 'radio', 'core', 'keycard'];
const LATE_FLAGS = ['has_weapon', 'kael_fight_won', 'signal_solved'];

// Every texture the game expects, with the size of its placeholder if the file is missing.
function expectedImages() {
  const list = [];
  MAPS.forEach(({ name, w, h }) => list.push({ key: `map-${name}`, w, h }));
  CHARACTERS.forEach((name) => list.push({ key: `portrait-${name}`, w: 96, h: 96 }));
  ITEMS.forEach((id) => {
    list.push({ key: `item-${id}`, w: 64, h: 64 });
    list.push({ key: `item-${id}-sm`, w: 24, h: 24 });
  });
  FX.filter((fx) => !fx.optional).forEach(({ key, w, h }) => list.push({ key, w, h }));
  list.push({ key: 'ui-key-e', w: 24, h: 24 }); // the only UI texture world scenes rely on
  return list;
}

/**
 * BootScene loads every asset, builds the global animations and then moves on.
 *
 * A scene's lifecycle is: preload() → (loader runs) → create() → update() every frame.
 */
export default class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  preload() {
    this.failedKeys = new Set();
    this.load.on('loaderror', (file) => {
      console.warn(`Missing asset "${file.key}" (${file.src}); using a placeholder.`);
      this.failedKeys.add(file.key);
    });

    this.createLoadingBar();

    MAPS.forEach(({ name }) => this.load.image(`map-${name}`, `assets/maps/${name}.png`));

    CHARACTERS.forEach((name) => {
      // A spritesheet is one image cut into equal frames, numbered left→right, top→bottom.
      this.load.spritesheet(name, `assets/characters/${name}.png`, {
        frameWidth: FRAME.w,
        frameHeight: FRAME.h,
      });
      this.load.image(`portrait-${name}`, `assets/portraits/${name}.png`);
    });

    CREATURES.forEach(({ key, frameW, frameH }) => {
      this.load.spritesheet(key, `assets/creatures/${key}.png`, { frameWidth: frameW, frameHeight: frameH });
    });

    FX.forEach(({ key }) => this.load.image(key, `assets/fx/${key}.png`));

    ITEMS.forEach((id) => {
      this.load.image(`item-${id}`, `assets/items/${id}.png`);
      this.load.image(`item-${id}-sm`, `assets/items/${id}-sm.png`);
    });

    preloadUI(this);
  }

  create() {
    this.createPlaceholders();
    this.createCharacterAnimations();
    this.createCreatureAnimations();
    this.routeToFirstScene();
  }

  // ---------- loading bar ----------

  createLoadingBar() {
    const { width, height } = this.scale;
    const barW = 420;
    const barH = 14;
    const x = (width - barW) / 2;
    const y = height / 2;

    this.add
      .text(width / 2, y - 28, 'LOADING', { fontFamily: 'Silkscreen', fontSize: '20px', color: '#efe6d2' })
      .setOrigin(0.5);

    const frame = this.add.graphics();
    frame.lineStyle(2, 0x6b4a33).strokeRect(x - 3, y - 3, barW + 6, barH + 6);

    const fill = this.add.graphics();
    this.load.on('progress', (progress) => {
      fill.clear().fillStyle(0xf0a030).fillRect(x, y, barW * progress, barH);
    });
  }

  // ---------- missing-asset fallback ----------

  isMissing(key) {
    // A file can also "load" but fail to decode (e.g. the dev server returned HTML),
    // in which case no loaderror fires, so we also check the texture manager.
    return this.failedKeys.has(key) || !this.textures.exists(key);
  }

  createPlaceholders() {
    expectedImages().forEach(({ key, w, h }) => {
      if (this.isMissing(key)) this.createPlaceholderImage(key, w, h);
    });

    CHARACTERS.forEach((key) => {
      if (this.isMissing(key)) this.createPlaceholderSheet(key, FRAME.w, FRAME.h, SHEET.cols, SHEET.rows);
    });

    CREATURES.forEach(({ key, frameW, frameH, frames }) => {
      if (this.isMissing(key)) this.createPlaceholderSheet(key, frameW, frameH, frames, 1);
    });
  }

  /** Draws a magenta "missing" box with a cross into a new canvas texture. */
  createPlaceholderImage(key, w, h) {
    if (this.textures.exists(key)) this.textures.remove(key);
    const texture = this.textures.createCanvas(key, w, h);
    drawMissingBox(texture.context, 0, 0, w, h);
    texture.refresh(); // upload the drawing to the GPU (WebGL)
  }

  /** A placeholder spritesheet with the same numbered frames as the real one. */
  createPlaceholderSheet(key, frameW, frameH, cols, rows) {
    if (this.textures.exists(key)) this.textures.remove(key);
    const texture = this.textures.createCanvas(key, frameW * cols, frameH * rows);

    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const x = col * frameW;
        const y = row * frameH;
        drawMissingBox(texture.context, x, y, frameW, frameH);
        texture.add(row * cols + col, 0, x, y, frameW, frameH);
      }
    }
    texture.refresh();
  }

  // ---------- animations ----------

  // Animations live in the global Animation Manager, so every scene can use them.
  createCharacterAnimations() {
    const rows = { down: 0, left: 1, up: 2 };

    CHARACTERS.forEach((key) => {
      Object.entries(rows).forEach(([dir, row]) => {
        const first = row * SHEET.cols;

        this.createAnim({
          key: `${key}-walk-${dir}`,
          frames: this.anims.generateFrameNumbers(key, { start: first, end: first + SHEET.cols - 1 }),
          frameRate: 8,
          repeat: -1,
        });

        this.createAnim({
          key: `${key}-idle-${dir}`,
          frames: [{ key, frame: first }],
          frameRate: 1,
        });
      });
    });
  }

  createCreatureAnimations() {
    const frames = (key, start, end) => this.anims.generateFrameNumbers(key, { start, end });
    // repeat: -1 loops forever; repeat: 0 plays once.
    this.createAnim({ key: 'drone-hover', frames: frames('drone', 0, 3), frameRate: 6, repeat: -1 });
    this.createAnim({ key: 'crawler-walk', frames: frames('crawler', 0, 3), frameRate: 10, repeat: -1 });
    this.createAnim({ key: 'crawler-hurt', frames: frames('crawler', 4, 5), frameRate: 12, repeat: 0 });
    this.createAnim({ key: 'relay-pulse', frames: frames('relay', 0, 3), frameRate: 6, repeat: -1 });
  }

  createAnim(config) {
    if (!this.anims.exists(config.key)) this.anims.create(config);
  }

  // ---------- routing ----------

  routeToFirstScene() {
    const scene = SCENE_ALIASES[DEV.scene] || DEV.scene;
    if (scene && START_SCENES.includes(scene)) {
      GameState.reset();
      applyDevState(scene);
      startWorldScene(this, scene);
      return;
    }
    if (DEV.scene && DEV.scene !== 'Menu') {
      console.warn(`Unknown ?scene=${DEV.scene}; showing the menu.`);
    }
    this.scene.start('Menu');
  }
}

/**
 * ?quest=…&party=…&flags=…&give=…&god=1&clues=N&ending=…: jump into the middle of the story for testing.
 * A jump to Act IV or later also brings what you'd have by then (see applyLateSceneDefaults).
 */
function applyDevState(scene) {
  if (LATE_SCENES.includes(scene)) applyLateSceneDefaults(scene);

  if (DEV.quest) GameState.setQuest(DEV.quest);
  DEV.flags.forEach((name) => GameState.setFlag(name));
  DEV.give.forEach((id) => GameState.addItem(id));
  DEV.party.forEach((id) => GameState.joinParty(id));
  for (let i = 1; i <= (DEV.clues || 0); i += 1) GameState.setFlag(`clue_test_${i}`);

  if (DEV.ending) GameState.setEnding(DEV.ending);
  else if (scene === 'Ending') GameState.setEnding('dawn');
  GameState.godMode = DEV.god;
}

/**
 * By Paradise Gate you carry the artifacts, wield Kael's rebar and the signal is solved.
 * Eli is with you at the Gate (unless ?quest=eli_falls); from the Hollow on he is gone,
 * and his keycard opens the hatch.
 */
function applyLateSceneDefaults(scene) {
  LATE_FLAGS.forEach((name) => GameState.setFlag(name));
  const eliGone = scene !== 'Gate' || DEV.quest === 'eli_falls';
  if (eliGone) GameState.setFlag('eli_gone');

  if (!DEV.hasGive) ARTIFACTS.forEach((id) => GameState.addItem(id));
  if (!DEV.hasParty) {
    COMPANIONS.filter((id) => !(eliGone && id === 'eli')).forEach((id) => GameState.joinParty(id));
  }
}

function drawMissingBox(ctx, x, y, w, h) {
  ctx.fillStyle = '#ff00ff';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y + h);
  ctx.moveTo(x + w, y);
  ctx.lineTo(x, y + h);
  ctx.stroke();
}
