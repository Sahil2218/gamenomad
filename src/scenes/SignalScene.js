// SignalScene ('Signal'): the signal-tuning mini-game at Ryn's rig (contract M2 §7).
//
// An oscilloscope shows a dim cyan target wave; the player tunes a bright green
// wave to match it: A/D (or ←/→) change the frequency, W/S (or ↑/↓) the amplitude.
// E locks the wave when the match is within tolerance (a wrong lock buzzes).
// Three rounds, each with its own target; every round lights two of the six
// artifact icons around the panel. ESC leaves.
//
// It is launched on top of the world scene and UI, draws everything in code,
// and can be launched again later (create() rebuilds all state).
//
// GameState: sets inputLocked while open; on success sets the `signal_solved`
// flag and emits 'signal:solved'; ESC emits 'signal:cancelled'. Then it stops itself.
//
// Milestone 3: launch data { mode }. 'reprogram' (the AEGIS core, Act VI) uses a
// red/magenta panel, its own title and help strings, and three harder rounds:
// the target DRIFTS (its frequency and amplitude wobble slowly) and the
// tolerance is tighter. Both events carry { mode } ('default' or 'reprogram').
// Without a mode the scene behaves exactly as in Milestone 2.

import Phaser from 'phaser';
import { GameState } from '../systems/GameState.js';
import { Dialogue } from '../systems/Dialogue.js';
import strings from '../data/strings.json';
import { COLORS, CSS, SCREEN } from '../ui/uiLayout.js';
import { bodyStyle, drawPanel, mixColor, titleStyle } from '../ui/uiStyle.js';
import { GEN, ensureColorGlow, ensureEdge, ensureGlow, ensureScanlines } from '../ui/uiTextures.js';
import { smoothItemTexture } from '../ui/InventoryBar.js';

const KEYS = Phaser.Input.Keyboard.KeyCodes;
// Wall-clock ms. (A re-launched scene's own clock still holds the time it stopped at.)
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const text = (key, fallback) => (typeof strings[key] === 'string' && strings[key]) || fallback;

// Artifact icons around the panel: round N lights the pair in row N (left + right).
const ARTIFACTS = ['shard', 'crystal', 'medallion', 'radio', 'core', 'keycard'];

// Each round: target frequency (cycles across the screen), amplitude (0..1) and
// the match needed to lock. Later rounds are stricter.
const ROUNDS = [
  { freq: 2.0, amp: 0.55, tolerance: 0.86 },
  { freq: 4.4, amp: 0.85, tolerance: 0.89 },
  { freq: 1.35, amp: 0.3, tolerance: 0.92 },
];
// Reprogram mode: each target wobbles around (freq, amp) by up to about
// ±drift.freq / ±drift.amp (two sine waves each, so the motion isn't too regular).
// Periods are in seconds; the fastest drift is well under the player's tuning speed.
const REPROGRAM_ROUNDS = [
  { freq: 2.4, amp: 0.6, tolerance: 0.89, drift: { freq: 0.28, amp: 0.08, periodF: 7.5, periodA: 5.6 } },
  { freq: 3.9, amp: 0.45, tolerance: 0.91, drift: { freq: 0.4, amp: 0.11, periodF: 6.4, periodA: 4.8 } },
  { freq: 1.7, amp: 0.76, tolerance: 0.93, drift: { freq: 0.3, amp: 0.1, periodF: 6.8, periodA: 5.2 } },
];
const START_WAVE = { freq: 3.6, amp: 0.22 };
const FREQ = { min: 0.8, max: 6, rate: 1.5 }; // rate: units per second at full speed
const AMP = { min: 0.08, max: 1, rate: 0.55 };
const RAMP = 4; // holding a key reaches full speed after 1/RAMP s (taps make fine changes)
const MISS = { freq: 1.6, amp: 0.55 }; // errors this large count as a 0% match
const LOCK_GUARD_MS = 350; // ignore E right after opening (the E that opened it)
const GREEN = 0x5dff8a;
const GREEN_CSS = '#5dff8a';

// Colours and words for each mode. 'default' is exactly the Milestone 2 look.
const THEMES = {
  default: {
    rounds: ROUNDS,
    accent: COLORS.cyan,
    accentCss: CSS.cyan,
    accentLight: 0xc8f6ff, // beam nodes
    border: COLORS.rust,
    screen: 0x061218,
    glowKey: GEN.glow,
    title: () => text('signal-title', 'TUNE THE SIGNAL'),
    help: () => text('signal-help', '[A/D] FREQUENCY    [W/S] AMPLITUDE    [E] LOCK    [ESC] LEAVE'),
    rig: 'RIG-7 // AEGIS BAND',
    hint: 'Match the cyan trace, then lock it.',
    solved: 'ALL SIX ARTIFACTS RESONATE',
  },
  reprogram: {
    rounds: REPROGRAM_ROUNDS,
    accent: 0xff3d8b,
    accentCss: '#ff4f96',
    accentLight: 0xffc8de,
    border: 0x8a2346,
    screen: 0x14060d,
    glowKey: GEN.glowMagenta,
    title: () => text('signal-reprogram-title', 'REWRITE THE SIGNAL'),
    help: () => text('signal-reprogram-help', 'The target drifts: follow it.  A/D frequency · W/S amplitude · E lock · ESC leave'),
    rig: 'AEGIS CORE // OVERRIDE',
    hint: 'Follow the drifting trace, then lock it.',
    solved: 'AEGIS SIGNAL REWRITTEN',
  },
};

// Layout (canvas pixels).
const PANEL = { x: 330, y: 104, w: 620, h: 360 };
const SCOPE = { x: PANEL.x + 16, y: PANEL.y + 16, w: PANEL.w - 32, h: PANEL.h - 32 };
const SCOPE_MID = SCOPE.y + SCOPE.h / 2;
const AMP_PX = SCOPE.h * 0.43; // amplitude 1.0 in pixels
const WAVE_STEP = 4; // px between wave samples
const ICON_X = { left: PANEL.x - 80, right: PANEL.x + PANEL.w + 80 };
const ICON_ROWS = [PANEL.y + 66, PANEL.y + PANEL.h / 2, PANEL.y + PANEL.h - 66];
const METER = { x: 520, y: 500, w: 240, h: 14 };

export default class SignalScene extends Phaser.Scene {
  constructor() {
    super('Signal');
  }

  // data: launch data, { mode: 'reprogram' } at the AEGIS core; anything else is the default game.
  create(data) {
    this.mode = data && data.mode === 'reprogram' ? 'reprogram' : 'default';
    this.theme = THEMES[this.mode];
    this.rounds = this.theme.rounds;
    this.targetFreq = this.rounds[0].freq; // the target right now (it drifts in reprogram mode)
    this.targetAmp = this.rounds[0].amp;
    this.round = 0;
    this.freq = START_WAVE.freq;
    this.amp = START_WAVE.amp;
    this.freqSpeed = 0;
    this.ampSpeed = 0;
    this.match = 0;
    this.shownMatch = 0;
    this.phase = 'tuning'; // 'tuning' | 'locked' | 'solved' | 'closing'
    this.finished = false;
    this.inputReleased = false;
    this.lockAllowedAt = now() + LOCK_GUARD_MS;
    this.lit = new Set();
    this.targetAlpha = { value: 1 };
    this.flashState = { value: 0, color: this.theme.accent };
    this.lastReadout = '';

    GameState.inputLocked = true;
    ensureGlow(this);
    ensureColorGlow(this, GEN.glowMagenta, [255, 61, 139]);
    ensureScanlines(this);
    ensureEdge(this, GEN.edgeDark);

    this.root = this.add.container(0, 0);
    this.buildBackdrop();
    this.machine = this.add.container(0, 0); // everything that shakes on a wrong lock
    this.root.add(this.machine);
    this.buildScope();
    this.buildArtifacts();
    this.buildReadouts();

    this.keys = this.input.keyboard.addKeys({
      a: KEYS.A, d: KEYS.D, w: KEYS.W, s: KEYS.S,
      left: KEYS.LEFT, right: KEYS.RIGHT, up: KEYS.UP, down: KEYS.DOWN,
    });
    this.input.keyboard.on('keydown', this.onKeyDown, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.onShutdown, this);

    this.scene.bringToTop();
    this.startRound(0, false);

    // Open: fade + slight zoom-in of the machine.
    this.root.setAlpha(0);
    this.tweens.add({ targets: this.root, alpha: 1, duration: 260, ease: 'Sine.easeOut' });
  }

  // ---------------------------------------------------------------------------
  // Building the screen

  buildBackdrop() {
    // Oversized so nothing of the world peeks through at the edges.
    const shade = this.add.rectangle(-40, -40, SCREEN.width + 80, SCREEN.height + 80, 0x05060a, 0.9).setOrigin(0);
    const vignette = this.add.image(0, 0, GEN.edgeDark).setOrigin(0).setDisplaySize(SCREEN.width, SCREEN.height).setAlpha(0.8);
    this.title = this.add
      .text(SCREEN.width / 2, 44, this.theme.title().toUpperCase(), titleStyle(32, this.theme.accentCss, { shadow: { offsetX: 0, offsetY: 3, color: '#000000', fill: true } }))
      .setOrigin(0.5);
    this.roundLabel = this.add.text(SCREEN.width / 2, 80, '', bodyStyle(24, CSS.muted)).setOrigin(0.5);

    // Help strip along the bottom.
    const strip = this.add.graphics();
    strip.fillStyle(COLORS.black, 0.9);
    strip.fillRect(0, SCREEN.height - 52, SCREEN.width, 52);
    strip.fillStyle(this.theme.border, 1);
    strip.fillRect(0, SCREEN.height - 52, SCREEN.width, 2);
    const help = this.add
      .text(SCREEN.width / 2, SCREEN.height - 26, this.theme.help(), bodyStyle(24, CSS.cream))
      .setOrigin(0.5);
    this.root.add([shade, vignette, this.title, this.roundLabel, strip, help]);
    if (this.mode === 'reprogram') {
      // A faint red glow behind the machine: the core is running hot.
      const heat = this.add.image(SCREEN.width / 2, PANEL.y + PANEL.h / 2, GEN.glowMagenta).setBlendMode(Phaser.BlendModes.ADD).setScale(15, 9).setAlpha(0.22);
      this.root.addAt(heat, 2);
    }
  }

  buildScope() {
    const panel = this.add.graphics();
    drawPanel(panel, PANEL.x, PANEL.y, PANEL.w, PANEL.h, { alpha: 1, border: this.theme.border });
    // Bezel bolts in the corners.
    panel.fillStyle(this.theme.border, 1);
    for (const [bx, by] of [[PANEL.x + 8, PANEL.y + 8], [PANEL.x + PANEL.w - 11, PANEL.y + 8], [PANEL.x + 8, PANEL.y + PANEL.h - 11], [PANEL.x + PANEL.w - 11, PANEL.y + PANEL.h - 11]]) {
      panel.fillRect(bx, by, 3, 3);
    }

    // Screen: dark glass, grid, centre line.
    const screen = this.add.graphics();
    screen.fillStyle(COLORS.black, 1);
    screen.fillRect(SCOPE.x - 2, SCOPE.y - 2, SCOPE.w + 4, SCOPE.h + 4);
    screen.fillStyle(this.theme.screen, 1);
    screen.fillRect(SCOPE.x, SCOPE.y, SCOPE.w, SCOPE.h);
    const cols = 10;
    const rows = 6;
    const accent = this.theme.accent;
    screen.fillStyle(accent, 0.08);
    for (let i = 1; i < cols; i++) screen.fillRect(Math.round(SCOPE.x + (SCOPE.w * i) / cols), SCOPE.y, 1, SCOPE.h);
    for (let j = 1; j < rows; j++) screen.fillRect(SCOPE.x, Math.round(SCOPE.y + (SCOPE.h * j) / rows), SCOPE.w, 1);
    screen.fillStyle(accent, 0.2);
    screen.fillRect(SCOPE.x, SCOPE_MID, SCOPE.w, 1);
    // Small ticks along the centre line.
    for (let x = SCOPE.x; x < SCOPE.x + SCOPE.w; x += SCOPE.w / (cols * 5)) screen.fillRect(Math.round(x), SCOPE_MID - 2, 1, 5);

    this.targetWave = this.add.graphics();
    this.playerWave = this.add.graphics();
    this.flash = this.add.rectangle(SCOPE.x, SCOPE.y, SCOPE.w, SCOPE.h, accent, 1).setOrigin(0).setAlpha(0);
    this.scanlines = this.add.tileSprite(SCOPE.x, SCOPE.y, SCOPE.w, SCOPE.h, GEN.scanlines).setOrigin(0).setAlpha(0.45);
    const glass = this.add.image(SCOPE.x, SCOPE.y, GEN.edgeDark).setOrigin(0).setDisplaySize(SCOPE.w, SCOPE.h).setAlpha(0.75);
    this.border = this.add.graphics(); // coloured frame flash (red on a miss, cyan on a lock)

    // Corner labels on the glass.
    const label = (x, y, str, color, originX) => this.add.text(x, y, str, titleStyle(8, color)).setOrigin(originX, 0).setAlpha(0.8);
    this.targetTag = label(SCOPE.x + 10, SCOPE.y + 8, 'TARGET', this.theme.accentCss, 0);
    this.playerTag = label(SCOPE.x + 70, SCOPE.y + 8, 'YOU', GREEN_CSS, 0);
    const tagLine = this.add.graphics();
    tagLine.fillStyle(accent, 0.6);
    tagLine.fillRect(SCOPE.x + 56, SCOPE.y + 11, 8, 2);
    tagLine.fillStyle(GREEN, 1);
    tagLine.fillRect(SCOPE.x + 96, SCOPE.y + 11, 8, 2);
    const rig = label(SCOPE.x + SCOPE.w - 10, SCOPE.y + 8, this.theme.rig, CSS.muted, 1);

    this.machine.add([panel, screen, this.targetWave, this.playerWave, this.flash, this.scanlines, glass, this.border, this.targetTag, this.playerTag, tagLine, rig]);
    this.driftTag = null;
    if (this.mode === 'reprogram') {
      // Blinking warning in the middle of the glass's top edge.
      this.driftTag = label(SCOPE.x + SCOPE.w / 2, SCOPE.y + 8, '/// TARGET DRIFTING ///', this.theme.accentCss, 0.5);
      this.machine.add(this.driftTag);
    }
  }

  buildArtifacts() {
    this.beams = this.add.graphics();
    this.machine.add(this.beams);
    this.icons = ARTIFACTS.map((id, i) => {
      const side = i % 2 === 0 ? 'left' : 'right';
      const x = ICON_X[side];
      const y = ICON_ROWS[Math.floor(i / 2)];
      const glow = this.add.image(x, y, this.theme.glowKey).setBlendMode(Phaser.BlendModes.ADD).setScale(1.9).setAlpha(0);
      const slot = this.add.image(x, y, 'ui-slot');
      const key = `item-${id}`;
      const icon = this.add.image(x, y, smoothItemTexture(this, key) ? key : '__DEFAULT').setScale(0.625);
      const ring = this.add.graphics(); // cyan corner brackets while it's this round's pair
      this.machine.add([glow, slot, icon, ring]);
      return { id, side, x, y, glow, slot, icon, ring };
    });
    this.icons.forEach((entry) => this.setIconState(entry, 'off'));
  }

  buildReadouts() {
    const muted = CSS.muted;
    const top = PANEL.y + PANEL.h + 12;
    this.freqLabel = this.add.text(PANEL.x, top, 'FREQUENCY  A / D', bodyStyle(22, muted));
    this.freqValue = this.add.text(PANEL.x, top + 20, '', bodyStyle(34, GREEN_CSS));
    this.ampLabel = this.add.text(PANEL.x + PANEL.w, top, 'W / S  AMPLITUDE', bodyStyle(22, muted)).setOrigin(1, 0);
    this.ampValue = this.add.text(PANEL.x + PANEL.w, top + 20, '', bodyStyle(34, GREEN_CSS)).setOrigin(1, 0);

    this.meterLabel = this.add.text(SCREEN.width / 2, METER.y - 24, 'MATCH', bodyStyle(22, muted)).setOrigin(0.5, 0);
    this.meter = this.add.graphics();
    this.meterValue = this.add.text(SCREEN.width / 2, METER.y + METER.h + 4, '', bodyStyle(24, CSS.cream)).setOrigin(0.5, 0);
    this.status = this.add.text(SCREEN.width / 2, 600, '', bodyStyle(30, CSS.cream, { shadow: { offsetX: 0, offsetY: 2, color: '#000000', fill: true } })).setOrigin(0.5);
    this.machine.add([this.freqLabel, this.freqValue, this.ampLabel, this.ampValue, this.meterLabel, this.meter, this.meterValue]);
    this.root.add(this.status);
  }

  // ---------------------------------------------------------------------------
  // Rounds

  startRound(index, animate = true) {
    this.round = index;
    this.phase = 'tuning';
    this.roundLabel.setText(`ROUND ${index + 1} / ${this.rounds.length}`);
    this.setStatus(this.theme.hint, CSS.muted);
    this.updateTarget(this.time.now);
    this.icons.forEach((entry, i) => {
      if (this.lit.has(entry.id)) return;
      this.setIconState(entry, Math.floor(i / 2) === index ? 'next' : 'off');
    });
    if (animate) {
      this.tweens.killTweensOf(this.targetAlpha);
      this.targetAlpha.value = 0;
      this.tweens.add({ targets: this.targetAlpha, value: 1, duration: 500, ease: 'Sine.easeOut' });
    }
  }

  tryLock() {
    if (this.phase !== 'tuning' || now() < this.lockAllowedAt) return;
    if (this.match >= this.rounds[this.round].tolerance) this.lockRound();
    else this.buzz();
  }

  lockRound() {
    this.phase = 'locked'; // also freezes a drifting target where it is
    this.freqSpeed = 0;
    this.ampSpeed = 0;
    // Snap the wave onto the target so the two traces merge.
    this.tweens.add({ targets: this, freq: this.targetFreq, amp: this.targetAmp, duration: 220, ease: 'Cubic.easeOut' });
    this.flashScreen(this.theme.accent, 0.55);
    this.flashBorder(this.theme.accent);
    this.setStatus(text('signal-locked', 'SIGNAL LOCKED'), this.theme.accentCss, true);

    const pair = this.icons.filter((_, i) => Math.floor(i / 2) === this.round);
    pair.forEach((entry, k) => this.time.delayedCall(120 + k * 160, () => this.lightIcon(entry)));

    const last = this.round >= this.rounds.length - 1;
    this.time.delayedCall(1300, () => (last ? this.solve() : this.startRound(this.round + 1)));
  }

  solve() {
    this.phase = 'solved';
    this.setStatus(this.theme.solved, CSS.orange, true);
    this.flashScreen(0xffffff, 0.5);
    this.icons.forEach((entry, i) => {
      this.tweens.add({ targets: entry.icon, scale: 0.75, duration: 180, delay: i * 60, yoyo: true, ease: 'Sine.easeOut' });
    });
    this.time.delayedCall(1500, () => this.close('signal:solved'));
  }

  // A miss: the machine shakes, the frame flashes red.
  buzz() {
    this.tweens.killTweensOf(this.machine);
    this.machine.x = 0;
    this.tweens.add({ targets: this.machine, x: { from: -7, to: 7 }, duration: 45, yoyo: true, repeat: 3, ease: 'Sine.easeInOut', onComplete: () => (this.machine.x = 0) });
    this.flashScreen(COLORS.warning, 0.25);
    this.flashBorder(COLORS.warning);
    this.setStatus('NO LOCK: the waves don\'t match yet.', CSS.warning, true);
    this.lockAllowedAt = now() + 300;
  }

  // ---------------------------------------------------------------------------
  // Feedback helpers

  setIconState(entry, state) {
    entry.ring.clear();
    this.tweens.killTweensOf([entry.icon, entry.glow]);
    if (state === 'lit') {
      entry.icon.clearTint().setAlpha(1).setScale(0.625);
      entry.slot.setTexture('ui-slot-selected');
      entry.glow.setAlpha(0.55);
      this.tweens.add({ targets: entry.glow, alpha: 0.9, duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
      return;
    }
    entry.slot.setTexture('ui-slot');
    entry.glow.setAlpha(0);
    entry.icon.setTint(0x6a6a72).setScale(0.625);
    if (state === 'next') {
      // This round's pair: half-lit and breathing, with cyan corner brackets.
      entry.icon.setAlpha(0.6);
      this.tweens.add({ targets: entry.icon, alpha: 0.9, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
      const r = 33;
      const g = entry.ring;
      g.fillStyle(this.theme.accent, 0.9);
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const cx = entry.x + sx * r;
        const cy = entry.y + sy * r;
        g.fillRect(Math.min(cx, cx - sx * 8), cy - (sy > 0 ? 1 : 0), 8, 2);
        g.fillRect(cx - (sx > 0 ? 1 : 0), Math.min(cy, cy - sy * 8), 2, 8);
      }
    } else {
      entry.icon.setAlpha(0.3);
    }
  }

  lightIcon(entry) {
    this.lit.add(entry.id);
    this.setIconState(entry, 'lit');
    entry.icon.setScale(1);
    this.tweens.add({ targets: entry.icon, scale: 0.625, duration: 420, ease: 'Back.easeOut' });
    this.drawBeams();
  }

  // Cyan beams from every lit artifact into the side of the scope.
  drawBeams() {
    const g = this.beams;
    g.clear();
    for (const entry of this.icons) {
      if (!this.lit.has(entry.id)) continue;
      const x0 = entry.side === 'left' ? entry.x + 30 : PANEL.x + PANEL.w;
      const x1 = entry.side === 'left' ? PANEL.x : entry.x - 30;
      g.fillStyle(this.theme.accent, 0.18);
      g.fillRect(x0, entry.y - 3, x1 - x0, 6);
      g.fillStyle(this.theme.accent, 0.9);
      g.fillRect(x0, entry.y - 1, x1 - x0, 2);
      const nodeX = entry.side === 'left' ? PANEL.x - 3 : PANEL.x + PANEL.w - 3;
      g.fillStyle(this.theme.accentLight, 1);
      g.fillRect(nodeX, entry.y - 3, 6, 6);
    }
  }

  flashScreen(color, alpha) {
    this.tweens.killTweensOf(this.flash);
    this.flash.setFillStyle(color, 1).setAlpha(alpha);
    this.tweens.add({ targets: this.flash, alpha: 0, duration: 420, ease: 'Quad.easeOut' });
  }

  flashBorder(color) {
    const g = this.border;
    g.clear();
    g.lineStyle(3, color, 1);
    g.strokeRect(SCOPE.x - 1, SCOPE.y - 1, SCOPE.w + 2, SCOPE.h + 2);
    this.tweens.killTweensOf(g);
    g.setAlpha(1);
    this.tweens.add({ targets: g, alpha: 0, duration: 600, ease: 'Quad.easeIn' });
  }

  setStatus(message, color, pop = false) {
    this.status.setText(message).setColor(color).setAlpha(1);
    if (!pop) return;
    this.tweens.killTweensOf(this.status);
    this.status.setScale(1.15);
    this.tweens.add({ targets: this.status, scale: 1, duration: 260, ease: 'Back.easeOut' });
  }

  // ---------------------------------------------------------------------------
  // Frame update

  update(time, delta) {
    if (this.finished) return;
    GameState.inputLocked = true; // a dialogue ending underneath must not unlock the world
    const dt = Math.min(delta, 50) / 1000;

    if (this.phase === 'tuning') {
      const k = this.keys;
      const freqDir = (k.d.isDown || k.right.isDown ? 1 : 0) - (k.a.isDown || k.left.isDown ? 1 : 0);
      const ampDir = (k.w.isDown || k.up.isDown ? 1 : 0) - (k.s.isDown || k.down.isDown ? 1 : 0);
      this.freqSpeed = this.rampSpeed(this.freqSpeed, freqDir, dt);
      this.ampSpeed = this.rampSpeed(this.ampSpeed, ampDir, dt);
      this.freq = Phaser.Math.Clamp(this.freq + this.freqSpeed * FREQ.rate * dt, FREQ.min, FREQ.max);
      this.amp = Phaser.Math.Clamp(this.amp + this.ampSpeed * AMP.rate * dt, AMP.min, AMP.max);
      this.updateTarget(time);
    }

    const errF = Math.abs(this.freq - this.targetFreq) / MISS.freq;
    const errA = Math.abs(this.amp - this.targetAmp) / MISS.amp;
    this.match = Phaser.Math.Clamp(1 - Math.sqrt(errF * errF + errA * errA), 0, 1);
    this.shownMatch += (this.match - this.shownMatch) * Math.min(1, dt * 12);

    this.drawWaves(time);
    this.drawMeter(time);
    this.updateReadouts(time);
    this.scanlines.tilePositionY -= dt * 12;
    if (this.driftTag) this.driftTag.setAlpha(this.phase === 'tuning' ? 0.55 + 0.45 * Math.sin(time / 170) : 0.25);
  }

  // Where the target is now. Default rounds hold still; reprogram rounds drift.
  updateTarget(time) {
    const round = this.rounds[this.round];
    const d = round.drift;
    if (!d) {
      this.targetFreq = round.freq;
      this.targetAmp = round.amp;
      return;
    }
    const t = (time / 1000) * Math.PI * 2;
    // A slow main wobble plus a smaller, quicker one on top.
    const wobbleF = 0.75 * Math.sin(t / d.periodF) + 0.25 * Math.sin(t / (d.periodF * 0.37) + 2.1);
    const wobbleA = 0.75 * Math.sin(t / d.periodA + 1.3) + 0.25 * Math.sin(t / (d.periodA * 0.41) + 0.4);
    this.targetFreq = Phaser.Math.Clamp(round.freq + d.freq * wobbleF, FREQ.min, FREQ.max);
    this.targetAmp = Phaser.Math.Clamp(round.amp + d.amp * wobbleA, AMP.min, AMP.max);
  }

  // Holding a key ramps the speed up to ±1; releasing it stops quickly.
  rampSpeed(speed, dir, dt) {
    if (dir === 0) return Math.abs(speed) < 0.05 ? 0 : speed * Math.max(0, 1 - dt * 18);
    if (Math.sign(speed) !== dir) speed = 0;
    return Phaser.Math.Clamp(speed + dir * RAMP * dt, -1, 1);
  }

  drawWaves(time) {
    const round = this.rounds[this.round];
    const phase = time * 0.0024;
    const t = this.targetWave;
    t.clear();
    const ta = this.targetAlpha.value;
    const accent = this.theme.accent;
    this.strokeWave(t, this.targetFreq, this.targetAmp, phase, 7, accent, 0.08 * ta, 0);
    this.strokeWave(t, this.targetFreq, this.targetAmp, phase, 2, accent, 0.55 * ta, 0);

    // The player's wave carries a little static until it's close to the target.
    const noise = this.phase === 'tuning' ? (1 - this.match) * 7 : 0;
    const matched = this.phase === 'tuning' && this.match >= round.tolerance;
    const core = matched ? 0xc8ffd8 : GREEN;
    const p = this.playerWave;
    p.clear();
    this.strokeWave(p, this.freq, this.amp, phase, 8, GREEN, 0.1, noise, time);
    this.strokeWave(p, this.freq, this.amp, phase, 4, GREEN, 0.28, noise, time);
    this.strokeWave(p, this.freq, this.amp, phase, 2, core, 1, noise, time);
  }

  // One wave as a polyline across the scope (no arrays allocated per frame).
  strokeWave(g, freq, amp, phase, width, color, alpha, noise = 0, time = 0) {
    if (alpha <= 0.001) return;
    g.lineStyle(width, color, alpha);
    g.beginPath();
    for (let x = 0; x <= SCOPE.w; x += WAVE_STEP) {
      const u = x / SCOPE.w;
      let y = Math.sin(u * freq * Math.PI * 2 - phase) * amp * AMP_PX;
      if (noise > 0) y += (Math.sin(x * 0.71 + time * 0.031) * Math.sin(x * 0.23 - time * 0.017)) * noise;
      if (x === 0) g.moveTo(SCOPE.x + x, SCOPE_MID - y);
      else g.lineTo(SCOPE.x + x, SCOPE_MID - y);
    }
    g.strokePath();
  }

  drawMeter(time) {
    const round = this.rounds[this.round];
    const g = this.meter;
    const m = METER;
    const ready = this.phase === 'tuning' && this.match >= round.tolerance;
    const locked = this.phase === 'locked' || this.phase === 'solved' || this.phase === 'closing';
    g.clear();
    g.fillStyle(COLORS.black, 1);
    g.fillRect(m.x - 2, m.y - 2, m.w + 4, m.h + 4);
    g.fillStyle(COLORS.rust, 1);
    g.fillRect(m.x - 1, m.y - 1, m.w + 2, m.h + 2);
    g.fillStyle(0x0a1418, 1);
    g.fillRect(m.x, m.y, m.w, m.h);

    // Fill: orange while far, green once inside the tolerance.
    const fillW = Math.round(m.w * this.shownMatch);
    const color = ready || locked ? GREEN : mixColor(COLORS.warning, COLORS.orange, Math.min(1, this.shownMatch / round.tolerance));
    g.fillStyle(color, ready ? 0.75 + 0.25 * Math.sin(time / 90) : 1);
    g.fillRect(m.x, m.y, fillW, m.h);
    g.fillStyle(0xffffff, 0.25);
    g.fillRect(m.x, m.y + 1, fillW, 2);

    // Tolerance tick.
    const tx = Math.round(m.x + m.w * round.tolerance);
    g.fillStyle(COLORS.cream, 1);
    g.fillRect(tx - 1, m.y - 5, 2, m.h + 10);
    g.fillTriangle(tx - 4, m.y - 8, tx + 4, m.y - 8, tx, m.y - 3);
  }

  updateReadouts(time) {
    const freq = this.freq.toFixed(2);
    const amp = Math.round(this.amp * 100);
    const pct = Math.round(this.shownMatch * 100);
    const key = `${freq}|${amp}|${pct}`;
    if (key !== this.lastReadout) {
      this.lastReadout = key;
      this.freqValue.setText(`${freq} Hz`);
      this.ampValue.setText(`${amp}%`);
      this.meterValue.setText(`${pct}%`);
    }
    if (this.phase !== 'tuning') return;
    const ready = this.match >= this.rounds[this.round].tolerance;
    if (ready && this.status.text !== 'LOCK READY  [E]') this.setStatus('LOCK READY  [E]', GREEN_CSS);
    else if (!ready && this.status.text === 'LOCK READY  [E]') this.setStatus(this.theme.hint, CSS.muted);
    if (ready) this.status.setAlpha(0.7 + 0.3 * Math.sin(time / 110));
    else this.status.setAlpha(1);
  }

  // ---------------------------------------------------------------------------
  // Input & closing

  onKeyDown(event) {
    if (this.finished || this.phase === 'closing' || event.repeat) return;
    if (event.keyCode === KEYS.ESC) this.close('signal:cancelled');
    else if (event.keyCode === KEYS.E || event.keyCode === KEYS.SPACE || event.keyCode === KEYS.ENTER) this.tryLock();
  }

  // Fade out, then report the result and stop.
  close(eventName) {
    if (this.phase === 'closing' || this.finished) return;
    this.phase = 'closing';
    this.tweens.add({ targets: this.root, alpha: 0, duration: 220, ease: 'Sine.easeIn', onComplete: () => this.finish(eventName) });
  }

  finish(eventName) {
    if (this.finished) return;
    this.finished = true;
    // Unlock first: a listener may start a dialogue right away, which locks input again.
    this.releaseInput();
    const solved = eventName === 'signal:solved';
    const rig = this.mode === 'default'; // the Wasteland rig (M2); the core leads straight to the ending
    if (solved && rig) GameState.setFlag('signal_solved');
    GameState.emit(eventName, { mode: this.mode });
    if (solved && rig) GameState.toast(text('signal-solved-toast', 'The signal is clear.'), 'item');
    this.scene.stop();
  }

  // Give input back to the world, unless a dialogue has taken it over meanwhile.
  releaseInput() {
    if (this.inputReleased) return;
    this.inputReleased = true;
    const dialogueOpen = typeof Dialogue.isActive === 'function' && Dialogue.isActive();
    if (!dialogueOpen) GameState.inputLocked = false;
  }

  onShutdown() {
    this.finished = true;
    // Phaser keeps the last launch data when launch() is called without any, so
    // forget the mode: the next plain launch('Signal') must be the default game.
    this.sys.settings.data = {};
    this.releaseInput();
    this.input.keyboard.off('keydown', this.onKeyDown, this);
    this.input.keyboard.removeAllKeys(false);
  }
}
