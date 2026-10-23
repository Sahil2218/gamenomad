// EndingScene ('Ending'): the last screen of THE NOMAD (contract M3 §7).
//
//   1. A graded background: Village 07, slowly panned. `dawn` is a warm sunrise
//      (gold grade, light rays from the top, a slow brighten); `quiet` is a blue
//      night with gentle drifting motes. GameState.ending picks it (null → quiet).
//   2. The ending's big title and sub, then its narration: dialogue
//      `ending-<kind>`, drawn by UIScene's dialogue box. (UIScene hides the HUD
//      while this scene runs, and this scene launches the UI if it isn't up.)
//   3. A summary: evidence found, the party plus Eli "in memory", and the
//      truth / lie told to the Mayor.
//   4. Credits roll upwards (strings 'credits', one line per "\n"), then
//      "press any key". A key during the summary or credits skips ahead.
//   5. Any key: clear the save, reset GameState, stop the UI, start the Menu.
//
// Everything is drawn in screen space (scroll factor 0) except the map, which
// the camera pans across.

import Phaser from 'phaser';
import { GameState } from '../systems/GameState.js';
import { Dialogue } from '../systems/Dialogue.js';
import strings from '../data/strings.json';
import { COLORS, CSS, SCREEN } from '../ui/uiLayout.js';
import { bodyStyle, drawPanel, titleStyle } from '../ui/uiStyle.js';
import { GEN, ensureCanvasTexture, ensureEdge } from '../ui/uiTextures.js';

// strings.json text with an English fallback (the story task adds the ending keys).
const text = (key, fallback) => (typeof strings[key] === 'string' && strings[key]) || fallback;
// Wall-clock ms, for key guards.
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const TIMING = {
  fadeIn: 1600,
  title: 900, // title starts fading in
  narration: 4200, // the dialogue starts
  keyGuard: 650, // keys ignored after the narration closes (its last E press)
  statsMinimum: 1800, // the summary can't be skipped sooner than this
  statsHold: 8000, // then the credits start by themselves
  creditsSpeed: 40, // px per second
  fadeOut: 900,
};

// One look per ending.
const LOOKS = {
  dawn: {
    title: '#ffe3a8',
    stroke: '#2b1306',
    sub: '#f8e2c6',
    accent: 0xf0c060,
    accentCss: '#f0c060',
    divider: 'ui-divider-orange',
    panelBorder: 0x8a6232,
    fallbackTitle: 'DAWN',
    fallbackSub: 'For the first time in a lifetime, the sky is just the sky.',
  },
  quiet: {
    title: '#d8e8ff',
    stroke: '#050914',
    sub: '#b4c6e6',
    accent: 0x8fb6ff,
    accentCss: '#9fc0ff',
    divider: 'ui-divider-cyan',
    panelBorder: 0x34446e,
    fallbackTitle: 'THE QUIET',
    fallbackSub: 'The machines sleep. The world will have to wake itself.',
  },
};

// Credits are fully visible between these screen y values (they fade in below, out above).
const CREDITS_VISIBLE = { top: 240, bottom: 600 };
const FALLBACK_CREDITS = 'THE PARADISE SIGNAL\n\nA story about the world beyond the wall\n\nBUILT WITH\nPhaser 3 · Vite\n\nTHANK YOU FOR PLAYING';
const COMPANION_NAMES = { mira: 'Mira', kael: 'Kael', nova: 'Nova', ryn: 'Ryn', eli: 'Eli' };

// Generated textures (made once per game, colours baked in; see uiTextures.js).
const TEX = {
  ray: 'ui-gen-ending-ray',
  sun: 'ui-gen-ending-sun',
  moon: 'ui-gen-ending-moon',
  sky: 'ui-gen-ending-sky',
  moteWarm: 'ui-gen-ending-mote-warm',
  moteCool: 'ui-gen-ending-mote-cool',
  band: 'ui-gen-ending-band', // soft dark band behind the title
  column: 'ui-gen-ending-column', // soft dark column behind the credits
};

// A soft radial blob: `stops` are [offset, 'rgba(...)'] from the centre outwards.
function radialTexture(scene, key, size, stops) {
  return ensureCanvasTexture(scene, key, size, size, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    stops.forEach(([offset, color]) => g.addColorStop(offset, color));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }, { linear: true });
}

function ensureEndingTextures(scene) {
  // A light ray: bright down its middle, fading sideways and towards its far end.
  ensureCanvasTexture(scene, TEX.ray, 64, 512, (ctx, w, h) => {
    const across = ctx.createLinearGradient(0, 0, w, 0);
    across.addColorStop(0, 'rgba(255, 214, 150, 0)');
    across.addColorStop(0.5, 'rgba(255, 214, 150, 1)');
    across.addColorStop(1, 'rgba(255, 214, 150, 0)');
    ctx.fillStyle = across;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'destination-in'; // keep the colour, multiply its alpha
    const along = ctx.createLinearGradient(0, 0, 0, h);
    along.addColorStop(0, 'rgba(0, 0, 0, 1)');
    along.addColorStop(0.55, 'rgba(0, 0, 0, 0.4)');
    along.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = along;
    ctx.fillRect(0, 0, w, h);
  }, { linear: true });
  // Warm sky light pouring in from the top edge.
  ensureCanvasTexture(scene, TEX.sky, 4, 128, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(255, 176, 96, 0.95)');
    g.addColorStop(0.35, 'rgba(255, 140, 90, 0.35)');
    g.addColorStop(1, 'rgba(255, 120, 80, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }, { linear: true });
  radialTexture(scene, TEX.sun, 128, [[0, 'rgba(255, 244, 214, 1)'], [0.25, 'rgba(255, 206, 130, 0.7)'], [0.6, 'rgba(255, 150, 80, 0.2)'], [1, 'rgba(255, 130, 70, 0)']]);
  radialTexture(scene, TEX.moon, 128, [[0, 'rgba(225, 236, 255, 0.9)'], [0.3, 'rgba(150, 180, 240, 0.35)'], [1, 'rgba(90, 120, 200, 0)']]);
  radialTexture(scene, TEX.moteWarm, 8, [[0, 'rgba(255, 236, 190, 1)'], [0.5, 'rgba(255, 200, 120, 0.6)'], [1, 'rgba(255, 180, 100, 0)']]);
  radialTexture(scene, TEX.moteCool, 8, [[0, 'rgba(220, 235, 255, 1)'], [0.5, 'rgba(150, 190, 255, 0.55)'], [1, 'rgba(120, 160, 255, 0)']]);
  // Text backings: dark in the middle, fading out towards every edge (shown stretched).
  radialTexture(scene, TEX.column, 128, [[0, 'rgba(5, 6, 10, 0.85)'], [0.55, 'rgba(5, 6, 10, 0.6)'], [1, 'rgba(5, 6, 10, 0)']]);
  ensureCanvasTexture(scene, TEX.band, 256, 64, (ctx, w, h) => {
    for (let y = 0; y < h; y++) {
      const v = Math.min(1, Math.min(y, h - 1 - y) / (h * 0.35)); // vertical fade
      const row = ctx.createLinearGradient(0, 0, w, 0);
      row.addColorStop(0, 'rgba(5, 6, 10, 0)');
      row.addColorStop(0.25, `rgba(5, 6, 10, ${0.75 * v})`);
      row.addColorStop(0.75, `rgba(5, 6, 10, ${0.75 * v})`);
      row.addColorStop(1, 'rgba(5, 6, 10, 0)');
      ctx.fillStyle = row;
      ctx.fillRect(0, y, w, 1);
    }
  }, { linear: true });
}

// A grey, slightly silver copy of a portrait (Eli, in memory).
function memoryPortrait(scene, id) {
  const src = `portrait-${id}`;
  if (!scene.textures.exists(src)) return null;
  const image = scene.textures.get(src).getSourceImage();
  return ensureCanvasTexture(scene, `ui-gen-portrait-memory-${id}`, image.width, image.height, (ctx, w, h) => {
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, w, h);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      const grey = 0.3 * px[i] + 0.59 * px[i + 1] + 0.11 * px[i + 2];
      px[i] = grey * 0.82 + 18;
      px[i + 1] = grey * 0.86 + 20;
      px[i + 2] = grey * 0.92 + 30; // a faint cold silver
      px[i + 3] *= 0.8;
    }
    ctx.putImageData(data, 0, 0);
  });
}

export default class EndingScene extends Phaser.Scene {
  constructor() {
    super('Ending');
  }

  create() {
    this.kind = GameState.ending === 'dawn' ? 'dawn' : 'quiet';
    this.look = LOOKS[this.kind];
    this.phase = 'intro'; // intro → narration → stats → credits → prompt → leaving
    this.keyGuardUntil = 0;
    this.statsShownAt = 0;
    this.timers = [];

    GameState.inputLocked = false;
    if (typeof GameState.setWorld === 'function' && GameState.world) GameState.setWorld(null); // no minimap here
    // The narration needs UIScene's dialogue box (UIScene hides its HUD while this scene runs).
    if (!this.scene.isActive('UI')) this.scene.launch('UI');

    ensureEndingTextures(this);
    ensureEdge(this, GEN.edgeDark);
    this.createBackground();
    this.createTitle();
    this.cameras.main.fadeIn(TIMING.fadeIn, 0, 0, 0);

    this.onDialogueEnd = () => {
      if (this.phase !== 'narration') return;
      this.keyGuardUntil = now() + TIMING.keyGuard;
      this.later(500, () => this.showStats());
    };
    GameState.on('dialogue:end', this.onDialogueEnd);
    this.input.keyboard.on('keydown', this.onKeyDown, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.onShutdown, this);

    this.later(TIMING.title, () => this.revealTitle());
    this.later(TIMING.narration, () => this.startNarration());
  }

  later(ms, fn) {
    this.timers.push(this.time.delayedCall(ms, fn));
  }

  // ---------------------------------------------------------------------------
  // Background

  createBackground() {
    const { width, height } = SCREEN;
    const cam = this.cameras.main;
    const dawn = this.kind === 'dawn';

    if (this.textures.exists('map-village')) {
      // The map at 1:1 (crisp pixels); the camera drifts slowly across it.
      const map = this.add.image(0, 0, 'map-village').setOrigin(0);
      cam.setBounds(0, 0, map.width, map.height);
      const maxX = Math.max(0, map.width - width);
      const maxY = Math.max(0, map.height - height);
      const from = dawn ? { x: maxX * 0.15, y: maxY } : { x: maxX * 0.85, y: maxY * 0.1 };
      const to = dawn ? { x: maxX * 0.75, y: maxY * 0.1 } : { x: maxX * 0.2, y: maxY * 0.9 };
      cam.setScroll(from.x, from.y);
      this.tweens.add({ targets: cam, scrollX: to.x, scrollY: to.y, duration: 90000, ease: 'Sine.easeInOut', yoyo: true, repeat: -1 });
    }

    // Screen-space layers on top of the map.
    const screen = (obj) => obj.setScrollFactor(0);
    const rect = (color, alpha) => screen(this.add.rectangle(0, 0, width, height, color, alpha).setOrigin(0));

    if (dawn) {
      // Warm grade (MULTIPLY tints what's under it), with a night shade that lifts slowly.
      rect(0xffc890, 0.62).setBlendMode(Phaser.BlendModes.MULTIPLY);
      const night = rect(0x0a0f24, 0.8);
      this.tweens.add({ targets: night, alpha: 0.2, duration: 16000, ease: 'Sine.easeInOut' });
      const sky = screen(this.add.image(0, 0, TEX.sky).setOrigin(0).setDisplaySize(width, height * 0.75).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0));
      this.tweens.add({ targets: sky, alpha: 0.55, duration: 11000, delay: 1500, ease: 'Sine.easeInOut' });

      // The sun just above the top-right edge, with rays fanning down-left from it.
      const sunX = width * 0.8;
      const sunY = -70;
      this.createRays(sunX, sunY);
      const sun = screen(this.add.image(sunX, sunY, TEX.sun).setScale(5.2).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0));
      this.tweens.add({ targets: sun, alpha: 0.95, duration: 9000, delay: 800, ease: 'Sine.easeOut' });
      this.tweens.add({ targets: sun, scale: 5.8, duration: 4200, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
      this.createMotes(TEX.moteWarm, { speedY: { min: -14, max: -4 }, speedX: { min: -12, max: 6 }, alpha: 0.75 });
    } else {
      // Deep blue night: a cold MULTIPLY grade, a little extra dark, a moon glow and drifting motes.
      rect(0x3b4c8e, 0.9).setBlendMode(Phaser.BlendModes.MULTIPLY);
      const dark = rect(0x03050c, 0.62);
      this.tweens.add({ targets: dark, alpha: 0.34, duration: 12000, ease: 'Sine.easeInOut' });
      const moon = screen(this.add.image(width * 0.18, -50, TEX.moon).setScale(6).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0));
      this.tweens.add({ targets: moon, alpha: 0.55, duration: 7000, ease: 'Sine.easeOut' });
      this.createMotes(TEX.moteCool, { speedY: { min: 3, max: 12 }, speedX: { min: -6, max: 6 }, alpha: 0.6 });
    }

    // Dark screen edges keep the eye in the middle (and the text readable).
    screen(this.add.image(0, 0, GEN.edgeDark).setOrigin(0).setDisplaySize(width, height).setAlpha(dawn ? 0.55 : 0.75));
  }

  // Additive light rays from (x, y), swaying and breathing slowly.
  createRays(x, y) {
    const rays = [
      { angle: 0.42, scale: 1.8, alpha: 0.46, width: 3 },
      { angle: 0.6, scale: 2.2, alpha: 0.34, width: 1.7 },
      { angle: 0.78, scale: 2.4, alpha: 0.5, width: 3.6 },
      { angle: 0.97, scale: 2.3, alpha: 0.32, width: 2 },
      { angle: 1.15, scale: 2.1, alpha: 0.42, width: 2.8 },
      { angle: 1.33, scale: 1.9, alpha: 0.28, width: 1.6 },
    ];
    rays.forEach((r, i) => {
      // Origin at the top-centre, so rotating swings the ray around the sun.
      const ray = this.add.image(x, y, TEX.ray).setOrigin(0.5, 0).setScrollFactor(0).setBlendMode(Phaser.BlendModes.ADD);
      ray.setScale(r.width, r.scale).setRotation(r.angle).setAlpha(0);
      this.tweens.add({ targets: ray, alpha: r.alpha, duration: 7000, delay: 2500 + i * 500, ease: 'Sine.easeInOut' });
      this.tweens.add({ targets: ray, rotation: r.angle + 0.05, duration: 5200 + i * 700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    });
  }

  // Slow floating specks of light (pre-warmed so the screen isn't empty at first).
  createMotes(key, { speedX, speedY, alpha }) {
    const emitter = this.add.particles(0, 0, key, {
      x: { min: -20, max: SCREEN.width + 20 },
      y: { min: -20, max: SCREEN.height + 20 },
      lifespan: { min: 6000, max: 11000 },
      speedX,
      speedY,
      scale: { min: 0.5, max: 1.3 },
      alpha: { values: [0, alpha, alpha * 0.8, 0], interpolation: 'linear' },
      frequency: 140,
      blendMode: Phaser.BlendModes.ADD,
    });
    emitter.setScrollFactor(0);
    emitter.fastForward(8000, 50);
  }

  // ---------------------------------------------------------------------------
  // Title + narration

  createTitle() {
    const look = this.look;
    const { width } = SCREEN;
    this.titleGroup = this.add.container(width / 2, 250).setScrollFactor(0).setAlpha(0);
    const band = this.add.image(0, 14, TEX.band).setDisplaySize(980, 210).setAlpha(0.9);
    const title = this.add
      .text(0, -32, text(`ending-${this.kind}-title`, look.fallbackTitle).toUpperCase(), titleStyle(48, look.title, {
        stroke: look.stroke,
        strokeThickness: 8,
        shadow: { offsetX: 0, offsetY: 4, color: '#000000', fill: true },
        align: 'center',
      }))
      .setOrigin(0.5)
      .setLetterSpacing(6);
    this.titleDivider = this.textures.exists(look.divider) ? this.add.image(0, 16, look.divider) : this.add.rectangle(0, 16, 220, 2, look.accent);
    const sub = (this.titleSub = this.add
      .text(0, 54, text(`ending-${this.kind}-sub`, look.fallbackSub), bodyStyle(34, look.sub, {
        shadow: { offsetX: 0, offsetY: 2, color: '#000000', fill: true },
        align: 'center',
        wordWrap: { width: 900 },
      }))
      .setOrigin(0.5, 0));
    this.titleGroup.add([band, title, this.titleDivider, sub]);
  }

  revealTitle() {
    this.titleGroup.y = 262;
    this.titleDivider.setScale(0.2, 1);
    this.tweens.add({ targets: this.titleGroup, alpha: 1, y: 250, duration: 1600, ease: 'Sine.easeOut' });
    this.tweens.add({ targets: this.titleDivider, scaleX: 1, duration: 1800, delay: 300, ease: 'Cubic.easeOut' });
  }

  startNarration() {
    this.phase = 'narration';
    const started = typeof Dialogue.start === 'function' && Dialogue.start(`ending-${this.kind}`);
    if (!started) this.later(800, () => this.showStats()); // no narration: straight to the summary
  }

  // ---------------------------------------------------------------------------
  // Summary: evidence, party, the Mayor

  showStats() {
    if (this.phase === 'stats' || this.phase === 'credits' || this.phase === 'prompt' || this.phase === 'leaving') return;
    this.phase = 'stats';
    this.statsShownAt = now();
    // The title rises out of the way and stays as a header (without its sub).
    this.tweens.add({ targets: this.titleGroup, y: 92, scale: 0.8, duration: 900, ease: 'Cubic.easeInOut' });
    this.tweens.add({ targets: this.titleSub, alpha: 0, duration: 500, ease: 'Sine.easeIn' });

    this.stats = this.buildStats();
    this.stats.setAlpha(0).setY(this.stats.y + 14);
    this.tweens.add({ targets: this.stats, alpha: 1, y: this.stats.y - 14, duration: 700, delay: 400, ease: 'Cubic.easeOut' });
    this.later(TIMING.statsHold, () => this.startCredits());
  }

  buildStats() {
    const W = 760;
    const H = 372;
    const look = this.look;
    const panel = this.add.container((SCREEN.width - W) / 2, 176).setScrollFactor(0);
    const bg = this.add.graphics();
    drawPanel(bg, 0, 0, W, H, { border: look.panelBorder, alpha: 0.9 });
    const rules = this.add.graphics();
    rules.fillStyle(look.panelBorder, 0.8);
    rules.fillRect(24, 100, W - 48, 1);
    rules.fillRect(24, 300, W - 48, 1);
    panel.add([bg, rules]);
    const label = (x, y, str) => this.add.text(x, y, str, titleStyle(16, look.accentCss));

    // Evidence: big count plus a bar.
    const { found, total } = this.evidence();
    panel.add(label(28, 22, 'EVIDENCE'));
    panel.add(this.add.text(W - 28, 8, `${found} / ${total}`, bodyStyle(48, CSS.cream)).setOrigin(1, 0));
    const bar = this.add.graphics();
    const barW = W - 56;
    bar.fillStyle(COLORS.black, 1);
    bar.fillRect(26, 62, barW + 4, 16);
    bar.fillStyle(0x0f1118, 1);
    bar.fillRect(28, 64, barW, 12);
    const fillW = Math.round(barW * Math.min(1, total > 0 ? found / total : 0));
    bar.fillStyle(look.accent, 1);
    bar.fillRect(28, 64, fillW, 12);
    bar.fillStyle(0xffffff, 0.3);
    bar.fillRect(28, 65, fillW, 2);
    panel.add(bar);

    // The party, and Eli in memory.
    panel.add(label(28, 116, 'THE PARTY'));
    const members = this.partyMembers();
    const cell = 104;
    const gap = 18;
    const rowW = members.length * cell + (members.length - 1) * gap;
    members.forEach((m, i) => panel.add(this.portraitCell(m, (W - rowW) / 2 + i * (cell + gap), 142, cell)));

    // The Mayor.
    panel.add(label(28, 316, 'MAYOR ORRIN'));
    panel.add(this.add.text(W - 28, 312, this.mayorLine(), bodyStyle(28, CSS.cream)).setOrigin(1, 0));
    return panel;
  }

  evidence() {
    let found = 0;
    if (typeof GameState.clueCount === 'function') found = GameState.clueCount();
    else if (typeof GameState.flagsStartingWith === 'function') found = GameState.flagsStartingWith('clue_').length;
    const total = Number(strings['clue-total']) || Math.max(found, 1);
    return { found, total };
  }

  // Joined companions in join order, then Eli (greyed) unless he's somehow still with you.
  partyMembers() {
    const party = Array.isArray(GameState.party) ? GameState.party : [];
    const list = party.filter((id) => id !== 'eli').map((id) => ({ id, memory: false }));
    list.push({ id: 'eli', memory: !party.includes('eli') });
    return list;
  }

  portraitCell({ id, memory }, x, y, size) {
    const look = this.look;
    const cell = this.add.container(x, y);
    const plate = this.add.graphics();
    drawPanel(plate, 0, 0, size, size, { border: memory ? 0x4a4f5e : look.panelBorder, alpha: 1 });
    cell.add(plate);
    const key = memory ? memoryPortrait(this, id) : this.textures.exists(`portrait-${id}`) ? `portrait-${id}` : null;
    if (key) cell.add(this.add.image(size / 2, size - 4, key).setOrigin(0.5, 1));
    else cell.add(this.add.text(size / 2, size / 2, '?', titleStyle(32, CSS.muted)).setOrigin(0.5));
    const name = (COMPANION_NAMES[id] || id).toUpperCase();
    cell.add(this.add.text(size / 2, size + 8, name, titleStyle(16, memory ? CSS.muted : CSS.cream)).setOrigin(0.5, 0));
    if (memory) cell.add(this.add.text(size / 2, size + 30, 'IN MEMORY', titleStyle(8, CSS.muted)).setOrigin(0.5, 0).setAlpha(0.85));
    return cell;
  }

  mayorLine() {
    if (GameState.hasFlag('told_mayor_truth')) return text('end-truth', 'You told him the truth.');
    if (GameState.hasFlag('lied_to_mayor')) return text('end-lie', 'You lied to protect him.');
    return text('end-no-answer', 'You never gave him an answer.');
  }

  // ---------------------------------------------------------------------------
  // Credits

  startCredits() {
    if (this.phase !== 'stats') return;
    this.phase = 'credits';
    if (this.stats) this.tweens.add({ targets: this.stats, alpha: 0, y: this.stats.y - 12, duration: 600, ease: 'Sine.easeIn' });

    // A soft dark column keeps the credits readable on the bright dawn.
    const column = this.add.image(SCREEN.width / 2, 420, TEX.column).setDisplaySize(820, 640).setScrollFactor(0).setAlpha(0);
    this.tweens.add({ targets: column, alpha: this.kind === 'dawn' ? 0.75 : 0.55, duration: 1200, ease: 'Sine.easeOut' });

    const lines = text('credits', FALLBACK_CREDITS).split('\n');
    this.credits = this.add.container(SCREEN.width / 2, SCREEN.height + 30).setScrollFactor(0);
    this.creditLines = [];
    let y = 0;
    let first = true;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) {
        y += 22;
        continue;
      }
      // First line: big. ALL-CAPS lines: section headers. Others: names / body.
      const header = line === line.toUpperCase() && /[A-Z]/.test(line);
      const style = first
        ? titleStyle(32, this.look.accentCss, { stroke: this.look.stroke, strokeThickness: 6, align: 'center' })
        : header
          ? titleStyle(16, this.look.accentCss, { align: 'center' })
          : bodyStyle(30, CSS.cream, { align: 'center', shadow: { offsetX: 0, offsetY: 2, color: '#000000', fill: true } });
      const t = this.add.text(0, y, line, style).setOrigin(0.5, 0);
      this.credits.add(t);
      this.creditLines.push(t);
      y += Math.ceil(t.height) + (first ? 18 : header ? 10 : 4);
      first = false;
    }
    // Where the roll stops: a short block settles centred on screen; a long one
    // scrolls until its last line reaches screen y 380.
    const window = CREDITS_VISIBLE.bottom - CREDITS_VISIBLE.top;
    this.creditsEndY = y <= window ? (CREDITS_VISIBLE.top + CREDITS_VISIBLE.bottom) / 2 - y / 2 : 380 - y;
    this.updateCreditAlpha();
  }

  // Lines fade in at the bottom of the screen and out near the title at the top.
  updateCreditAlpha() {
    for (const t of this.creditLines) {
      const top = this.credits.y + t.y;
      const fadeIn = Phaser.Math.Clamp((CREDITS_VISIBLE.bottom + 90 - top) / 90, 0, 1);
      const fadeOut = Phaser.Math.Clamp((top - CREDITS_VISIBLE.top + 70) / 70, 0, 1);
      t.setAlpha(Math.min(fadeIn, fadeOut));
    }
  }

  finishCredits() {
    if (this.phase !== 'credits') return;
    this.phase = 'prompt';
    this.credits.y = Math.min(this.credits.y, this.creditsEndY);
    this.updateCreditAlpha();
    this.showPrompt();
  }

  showPrompt() {
    this.prompt = this.add
      .text(SCREEN.width / 2, 640, text('press-any-key', text('menu-prompt', 'PRESS ANY KEY')).toUpperCase(), titleStyle(24, CSS.cream, { stroke: '#05060a', strokeThickness: 6 }))
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setAlpha(0);
    this.tweens.add({
      targets: this.prompt,
      alpha: 1,
      duration: 700,
      onComplete: () => this.tweens.add({ targets: this.prompt, alpha: 0.5, duration: 800, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' }),
    });
    this.keyGuardUntil = Math.max(this.keyGuardUntil, now() + 400);
  }

  update(time, delta) {
    if (this.phase !== 'credits') return;
    this.credits.y -= (TIMING.creditsSpeed * Math.min(delta, 50)) / 1000;
    this.updateCreditAlpha();
    if (this.credits.y <= this.creditsEndY) this.finishCredits();
  }

  // ---------------------------------------------------------------------------
  // Keys and leaving

  onKeyDown(event) {
    if (event.repeat || this.phase === 'leaving') return;
    if (Dialogue.isActive() || now() < this.keyGuardUntil) return; // UIScene owns the keys during the narration
    if (this.phase === 'stats' && now() - this.statsShownAt >= TIMING.statsMinimum) this.startCredits();
    else if (this.phase === 'credits') this.finishCredits();
    else if (this.phase === 'prompt') this.leave();
  }

  // Back to the Menu with a fresh game: clear the save, reset, stop the UI.
  leave() {
    this.phase = 'leaving';
    const cam = this.cameras.main;
    cam.fadeOut(TIMING.fadeOut, 0, 0, 0);
    cam.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      if (typeof GameState.clearSave === 'function') GameState.clearSave();
      GameState.reset();
      this.scene.stop('UI');
      this.scene.start('Menu');
    });
  }

  onShutdown() {
    GameState.off('dialogue:end', this.onDialogueEnd);
    this.input.keyboard.off('keydown', this.onKeyDown, this);
    this.timers.forEach((t) => t.remove(false));
    this.timers = [];
  }
}
