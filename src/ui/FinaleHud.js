// Act VI HUD (contract M3 §7):
//   - HoldMeter: a gold "HOLDING RELAY" meter at the top-centre while the player
//     holds a relay ('hold' events). It stacks under the cyan scan meter when
//     both are up, and flashes when the relay is secured.
//   - WaveLabel: a small "SWARM · WAVE n" tag that slides in on each 'wave' event.
// Both are built once; events only change text, position and alpha.

import { COLORS, CSS, GUIDE_GOLD, HOLD_METER, WAVE_LABEL } from './uiLayout.js';
import { DEPTH, bodyStyle, drawPanel, mixColor, titleStyle } from './uiStyle.js';

const GOLD = GUIDE_GOLD.color;
const GOLD_CSS = GUIDE_GOLD.css;
const SECURED_HIDE_MS = 1100; // how long "secured" stays up after a relay completes

// 'relay-2' → '2' (used if the label string contains {n}).
const relayNumber = (id) => {
  const match = /(\d+)\s*$/.exec(String(id || ''));
  return match ? match[1] : '';
};

export class HoldMeter {
  // labelText: strings 'hold-label' ("HOLDING RELAY"); securedText: shown on completion.
  constructor(scene, labelText, securedText) {
    const m = HOLD_METER;
    this.scene = scene;
    this.labelText = String(labelText);
    this.securedText = String(securedText);
    this.progress = 0;
    this.shown = false;
    this.stacked = false;
    this.completed = new Set(); // relay ids already secured (their later events are ignored)
    this.hideTimer = null;

    this.container = scene.add.container(m.x, m.y).setDepth(DEPTH.holdMeter).setVisible(false);
    const bg = scene.add.graphics();
    drawPanel(bg, 0, 0, m.width, m.height, { border: GOLD });
    this.icon = scene.add.graphics();
    this.drawIcon();
    this.label = scene.add.text(30, 6, '', titleStyle(8, GOLD_CSS));
    this.percent = scene.add.text(m.width - 10, 0, '0%', bodyStyle(20, GOLD_CSS)).setOrigin(1, 0);
    this.bar = scene.add.graphics();
    this.flash = scene.add.rectangle(3, 3, m.width - 6, m.height - 6, 0xfff4d6).setOrigin(0).setAlpha(0);
    this.container.add([bg, this.icon, this.label, this.percent, this.bar, this.flash]);
  }

  // A tiny relay pylon: diamond cap, mast and base.
  drawIcon() {
    const g = this.icon;
    const cx = 16;
    g.clear();
    g.fillStyle(COLORS.black, 1);
    g.fillRect(cx - 2, 9, 4, 17);
    g.fillStyle(GOLD, 1);
    g.fillRect(cx - 1, 10, 2, 15);
    g.fillRect(cx - 5, 24, 10, 3);
    g.fillTriangle(cx - 5, 8, cx, 3, cx + 5, 8);
    g.fillTriangle(cx - 5, 8, cx, 13, cx + 5, 8);
    g.fillStyle(0xfff4d6, 1);
    g.fillRect(cx - 1, 7, 2, 2);
  }

  // payload of 'hold': { id, progress 0..1, active }.
  onHold(payload) {
    const { id, progress, active } = payload || {};
    if (this.completed.has(id)) return;
    const value = Math.max(0, Math.min(1, Number(progress) || 0));
    if (value >= 1) {
      this.completed.add(id);
      this.setLabel(this.securedText, id);
      this.show();
      this.setProgress(1);
      this.celebrate();
      return;
    }
    if (!active) {
      this.hide();
      return;
    }
    this.setLabel(this.labelText, id);
    this.show();
    this.setProgress(value);
  }

  setLabel(text, id) {
    this.label.setText(text.replace(/\{n\}/g, relayNumber(id)).toUpperCase());
  }

  // Stack under the scan meter while it's showing (UIScene checks every frame).
  setStacked(stacked) {
    if (stacked === this.stacked) return;
    this.stacked = stacked;
    if (!this.shown) {
      this.container.y = this.restY();
      return;
    }
    this.scene.tweens.add({ targets: this.container, y: this.restY(), duration: 180, ease: 'Cubic.easeOut' });
  }

  restY() {
    return this.stacked ? HOLD_METER.stackedY : HOLD_METER.y;
  }

  show() {
    if (this.hideTimer) {
      this.hideTimer.remove(false);
      this.hideTimer = null;
    }
    if (this.shown) return;
    this.shown = true;
    const tweens = this.scene.tweens;
    tweens.killTweensOf(this.container);
    this.container.setVisible(true).setAlpha(0);
    this.container.y = this.restY() - 10;
    tweens.add({ targets: this.container, alpha: 1, y: this.restY(), duration: 160, ease: 'Cubic.easeOut' });
  }

  hide() {
    if (!this.shown) return;
    this.shown = false;
    const tweens = this.scene.tweens;
    tweens.killTweensOf(this.container);
    tweens.add({ targets: this.container, alpha: 0, y: this.restY() - 6, duration: 260, delay: 120, onComplete: () => this.container.setVisible(false) });
  }

  setProgress(value) {
    this.progress = value;
    const m = HOLD_METER;
    const g = this.bar;
    const x0 = 30;
    const y = 21;
    const h = 8;
    const gap = 2;
    const segW = (m.width - x0 - 10 - gap * (m.segments - 1)) / m.segments;
    const lit = value * m.segments;
    const color = mixColor(GOLD, 0xffffff, value >= 1 ? 0.45 : 0);
    g.clear();
    for (let i = 0; i < m.segments; i++) {
      const x = Math.round(x0 + i * (segW + gap));
      const w = Math.round(x0 + (i + 1) * (segW + gap) - gap) - x;
      const fill = Math.max(0, Math.min(1, lit - i)); // 0..1 for the leading segment
      g.fillStyle(GOLD, 0.14);
      g.fillRect(x, y, w, h);
      if (fill > 0) {
        g.fillStyle(color, 0.35 + 0.65 * fill);
        g.fillRect(x, y, w, h);
        g.fillStyle(0xffffff, 0.35 * fill);
        g.fillRect(x, y, w, 2);
      }
    }
    this.percent.setText(`${Math.round(value * 100)}%`);
  }

  // Relay secured: two bright flashes, then the meter slides away.
  celebrate() {
    const tweens = this.scene.tweens;
    tweens.killTweensOf(this.flash);
    this.flash.setAlpha(0);
    tweens.add({ targets: this.flash, alpha: 0.85, duration: 90, yoyo: true, repeat: 1, ease: 'Sine.easeOut', onComplete: () => this.flash.setAlpha(0) });
    if (this.hideTimer) this.hideTimer.remove(false);
    this.hideTimer = this.scene.time.delayedCall(SECURED_HIDE_MS, () => {
      this.hideTimer = null;
      this.hide();
    });
  }

  // Gentle breathing of the label while holding (called every frame).
  update(time) {
    if (!this.shown || this.progress >= 1) {
      this.label.setAlpha(1);
      return;
    }
    this.label.setAlpha(0.7 + 0.3 * Math.sin(time / 140));
  }
}

export class WaveLabel {
  // template: strings 'wave-label' ("SWARM · WAVE {n}").
  constructor(scene, template) {
    this.scene = scene;
    this.template = String(template);
    this.timer = null;
    this.container = scene.add.container(0, WAVE_LABEL.y).setDepth(DEPTH.waveLabel).setVisible(false);
    this.bg = scene.add.graphics();
    this.dot = scene.add.rectangle(13, WAVE_LABEL.height / 2, 6, 6, COLORS.warning);
    this.text = scene.add.text(24, Math.round(WAVE_LABEL.height / 2), '', titleStyle(16, CSS.cream)).setOrigin(0, 0.5);
    this.container.add([this.bg, this.dot, this.text]);
    this.blink = scene.tweens.add({ targets: this.dot, alpha: 0.25, duration: 300, yoyo: true, repeat: -1, ease: 'Sine.easeInOut', paused: true });
  }

  // payload of 'wave': { n }.
  show(payload) {
    const n = payload && payload.n !== undefined ? payload.n : '';
    const label = this.template.includes('{n}') ? this.template.replace(/\{n\}/g, String(n)) : `${this.template} ${n}`.trim();
    this.text.setText(label.toUpperCase());
    const width = Math.ceil(this.text.x + this.text.width + 12);
    this.bg.clear();
    drawPanel(this.bg, 0, 0, width, WAVE_LABEL.height, { border: COLORS.warning });
    const x = WAVE_LABEL.right - width;

    const tweens = this.scene.tweens;
    tweens.killTweensOf(this.container);
    if (this.timer) this.timer.remove(false);
    this.container.setVisible(true).setAlpha(0).setX(x + 24);
    this.blink.resume();
    tweens.add({ targets: this.container, alpha: 1, x, duration: 220, ease: 'Cubic.easeOut' });
    this.timer = this.scene.time.delayedCall(WAVE_LABEL.holdMs, () => {
      this.timer = null;
      this.hide();
    });
  }

  hide() {
    if (!this.container.visible) return;
    const tweens = this.scene.tweens;
    tweens.killTweensOf(this.container);
    tweens.add({
      targets: this.container,
      alpha: 0,
      duration: 260,
      onComplete: () => {
        this.container.setVisible(false);
        this.blink.pause();
      },
    });
  }
}
