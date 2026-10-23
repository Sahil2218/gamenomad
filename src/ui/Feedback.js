// Feedback effects (contract M2 §7):
//   - damage: a red flash along the screen edges
//   - toxicity ≥ 60: a pulsing green edge vignette, stronger as toxicity rises
//   - detection > 0: a cyan "WARDEN SCAN" meter at the top-centre
//   - respawn: a short fade from black with a "CHECKPOINT" label
// Everything is built once; updates only change alpha, tint or a redraw.

import Phaser from 'phaser';
import { COLORS, CSS, SCAN_METER, SCREEN, TITLE_CARD } from './uiLayout.js';
import { DEPTH, bodyStyle, drawPanel, mixColor, titleStyle } from './uiStyle.js';
import { GEN, ensureEdge } from './uiTextures.js';

const TOXIC_START = 60;
const TOXIC_FULL = 100;

// Segmented cyan meter that slides in while a Warden drone is scanning you.
class ScanMeter {
  constructor(scene) {
    const m = SCAN_METER;
    this.scene = scene;
    this.level = 0;
    this.shown = false;
    this.container = scene.add.container(m.x, m.y).setDepth(DEPTH.scanMeter).setVisible(false);
    this.bg = scene.add.graphics();
    drawPanel(this.bg, 0, 0, m.width, m.height, { border: COLORS.cyan });
    this.eye = scene.add.graphics();
    this.drawEye(COLORS.cyan);
    this.label = scene.add.text(30, 7, 'WARDEN SCAN', titleStyle(8, CSS.cyan));
    this.percent = scene.add.text(m.width - 10, 2, '0%', bodyStyle(20, CSS.cyan)).setOrigin(1, 0);
    this.bar = scene.add.graphics();
    this.container.add([this.bg, this.eye, this.label, this.percent, this.bar]);
  }

  // A small Warden "eye": diamond lens with a pupil.
  drawEye(color) {
    const g = this.eye;
    const cx = 17;
    const cy = 11;
    g.clear();
    g.fillStyle(color, 1);
    g.fillTriangle(cx - 9, cy, cx, cy - 5, cx + 9, cy);
    g.fillTriangle(cx - 9, cy, cx, cy + 5, cx + 9, cy);
    g.fillStyle(COLORS.panel, 1);
    g.fillCircle(cx, cy, 3);
    g.fillStyle(color, 1);
    g.fillRect(cx - 1, cy - 1, 2, 2);
  }

  // level: 0..1. Hidden at 0.
  setLevel(level) {
    const value = Math.max(0, Math.min(1, Number(level) || 0));
    this.level = value;
    if (value > 0 && !this.shown) this.show();
    else if (value <= 0 && this.shown) this.hide();
    if (value > 0) this.redraw();
  }

  show() {
    this.shown = true;
    const tweens = this.scene.tweens;
    tweens.killTweensOf(this.container);
    this.container.setVisible(true).setAlpha(0);
    this.container.y = SCAN_METER.y - 10;
    tweens.add({ targets: this.container, alpha: 1, y: SCAN_METER.y, duration: 160, ease: 'Cubic.easeOut' });
  }

  hide() {
    this.shown = false;
    const tweens = this.scene.tweens;
    tweens.killTweensOf(this.container);
    tweens.add({ targets: this.container, alpha: 0, y: SCAN_METER.y - 6, duration: 260, delay: 120, onComplete: () => this.container.setVisible(false) });
  }

  redraw() {
    const m = SCAN_METER;
    const g = this.bar;
    const x0 = 10;
    const y = 22;
    const h = 10;
    const gap = 2;
    const segW = (m.width - x0 * 2 - gap * (m.segments - 1)) / m.segments;
    const lit = this.level * m.segments;
    // Near full the meter heats from cyan towards white.
    const color = mixColor(COLORS.cyan, 0xffffff, Math.max(0, (this.level - 0.7) / 0.3) * 0.7);
    g.clear();
    for (let i = 0; i < m.segments; i++) {
      const x = Math.round(x0 + i * (segW + gap));
      const w = Math.round(x0 + (i + 1) * (segW + gap) - gap) - x;
      const fill = Math.max(0, Math.min(1, lit - i)); // 0..1 for the leading segment
      g.fillStyle(COLORS.cyan, 0.14);
      g.fillRect(x, y, w, h);
      if (fill > 0) {
        g.fillStyle(color, 0.35 + 0.65 * fill);
        g.fillRect(x, y, w, h);
        g.fillStyle(0xffffff, 0.35 * fill);
        g.fillRect(x, y, w, 2);
      }
    }
    this.percent.setText(`${Math.round(this.level * 100)}%`);
    this.drawEye(this.level > 0.7 ? COLORS.warning : COLORS.cyan);
  }

  // Blink the label faster as the scan fills (called every frame).
  update(time) {
    if (!this.shown) return;
    const speed = 160 - 110 * this.level;
    this.label.setAlpha(0.65 + 0.35 * Math.sin(time / speed));
  }
}

export class FeedbackFx {
  constructor(scene) {
    this.scene = scene;
    const edge = (key) => scene.add.image(0, 0, ensureEdge(scene, key)).setOrigin(0).setDisplaySize(SCREEN.width, SCREEN.height).setDepth(DEPTH.fx).setAlpha(0);

    // Toxic vignette in two layers so it reads on any map: a dark green shade for
    // contrast, then an additive green glow on top.
    this.toxicShade = edge(GEN.edgeToxicShade).setVisible(false);
    this.toxic = edge(GEN.edgeToxic).setBlendMode(Phaser.BlendModes.ADD).setVisible(false);
    this.toxicStrength = 0;
    this.damageFlash = edge(GEN.edgeDamage);
    this.scan = new ScanMeter(scene);

    // Respawn: black cover that fades away, plus a small label.
    this.cover = scene.add.rectangle(0, 0, SCREEN.width, SCREEN.height, 0x000000, 1).setOrigin(0).setDepth(DEPTH.respawn).setAlpha(0).setVisible(false);
    this.respawnText = scene.add
      .text(SCREEN.width / 2, TITLE_CARD.centerY, 'CHECKPOINT', titleStyle(16, CSS.cyan, { shadow: { offsetX: 0, offsetY: 2, color: '#000000', fill: true } }))
      .setOrigin(0.5)
      .setDepth(DEPTH.respawn)
      .setAlpha(0);
  }

  // payload of 'damage': { amount, source }. Bigger hits flash harder.
  damage(payload) {
    const amount = Math.max(0, Number(payload && payload.amount) || 0);
    const tweens = this.scene.tweens;
    tweens.killTweensOf(this.damageFlash);
    this.damageFlash.setAlpha(Math.min(1, 0.6 + amount * 0.03));
    tweens.add({ targets: this.damageFlash, alpha: 0, duration: 480, ease: 'Quad.easeOut' });
  }

  // From 'stats:changed'. The vignette fades in from TOXIC_START and is full at 100.
  setToxicity(toxicity) {
    const t = Number(toxicity) || 0;
    this.toxicStrength = t >= TOXIC_START ? Math.min(1, (t - TOXIC_START) / (TOXIC_FULL - TOXIC_START)) : 0;
    this.toxic.setVisible(t >= TOXIC_START);
    this.toxicShade.setVisible(t >= TOXIC_START);
  }

  setDetection(level) {
    this.scan.setLevel(level);
  }

  respawn() {
    const tweens = this.scene.tweens;
    tweens.killTweensOf([this.cover, this.respawnText]);
    this.cover.setVisible(true).setAlpha(1);
    tweens.add({ targets: this.cover, alpha: 0, duration: 700, delay: 150, ease: 'Sine.easeOut', onComplete: () => this.cover.setVisible(false) });
    this.respawnText.setAlpha(0).setY(TITLE_CARD.centerY + 6);
    tweens.add({ targets: this.respawnText, alpha: 1, y: TITLE_CARD.centerY, duration: 260, delay: 200, ease: 'Cubic.easeOut' });
    tweens.add({ targets: this.respawnText, alpha: 0, duration: 400, delay: 1300 });
    this.scan.setLevel(0);
  }

  // Called every frame by UIScene.
  update(time) {
    if (this.toxic.visible) {
      // Base strength 0.35..1, breathing about ±25%; faster when it's worse.
      const base = 0.35 + 0.65 * this.toxicStrength;
      const speed = 420 - 200 * this.toxicStrength;
      const breath = 0.75 + 0.25 * Math.sin(time / speed);
      this.toxicShade.setAlpha(Math.min(1, base * 0.85));
      this.toxic.setAlpha(base * breath * 0.55);
    }
    this.scan.update(time);
  }
}
