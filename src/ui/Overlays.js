// Full-screen overlays: the red alert ("ROGUE HUMAN DETECTED", and in M3 the
// beacon alarm, which adds a pulsing red screen edge) and the act title card.

import { ALERT, COLORS, CSS, SCREEN, TITLE_CARD } from './uiLayout.js';
import { DEPTH, bodyStyle, titleStyle } from './uiStyle.js';
import { GEN, ensureEdge } from './uiTextures.js';

const VIGNETTE_KEY = 'ui-gen-red-vignette';
const SCANLINE_KEY = 'ui-gen-scanlines';
const BAND_KEY = 'ui-gen-title-band';
const BAND_SIZE = { w: 760, h: 170 };

// Runtime-generated textures (created once per game, shared by every UIScene instance).
function ensureGeneratedTextures(scene) {
  if (!scene.textures.exists(VIGNETTE_KEY)) {
    const tex = scene.textures.createCanvas(VIGNETTE_KEY, SCREEN.width, SCREEN.height);
    const ctx = tex.getContext();
    const cx = SCREEN.width / 2;
    const cy = SCREEN.height / 2;
    const gradient = ctx.createRadialGradient(cx, cy, SCREEN.height * 0.25, cx, cy, SCREEN.width * 0.62);
    gradient.addColorStop(0, 'rgba(255, 40, 50, 0)');
    gradient.addColorStop(0.55, 'rgba(220, 20, 35, 0.35)');
    gradient.addColorStop(1, 'rgba(160, 0, 15, 0.92)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, SCREEN.width, SCREEN.height);
    tex.refresh();
  }
  if (!scene.textures.exists(BAND_KEY)) {
    // Soft dark band behind the title card: fades out towards every edge.
    // Drawn one row at a time (each row a horizontal gradient scaled by a vertical fade).
    const tex = scene.textures.createCanvas(BAND_KEY, BAND_SIZE.w, BAND_SIZE.h);
    const ctx = tex.getContext();
    for (let y = 0; y < BAND_SIZE.h; y++) {
      const v = Math.min(1, Math.min(y, BAND_SIZE.h - 1 - y) / (BAND_SIZE.h * 0.3));
      const alpha = 0.7 * v;
      const row = ctx.createLinearGradient(0, 0, BAND_SIZE.w, 0);
      row.addColorStop(0, 'rgba(5, 6, 10, 0)');
      row.addColorStop(0.25, `rgba(5, 6, 10, ${alpha})`);
      row.addColorStop(0.75, `rgba(5, 6, 10, ${alpha})`);
      row.addColorStop(1, 'rgba(5, 6, 10, 0)');
      ctx.fillStyle = row;
      ctx.fillRect(0, y, BAND_SIZE.w, 1);
    }
    tex.refresh();
  }
  if (!scene.textures.exists(SCANLINE_KEY)) {
    const tex = scene.textures.createCanvas(SCANLINE_KEY, 4, 4);
    const ctx = tex.getContext();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(0, 2, 4, 2);
    tex.refresh();
  }
}

export class AlertOverlay {
  constructor(scene) {
    this.scene = scene;
    ensureGeneratedTextures(scene);
    const cy = ALERT.centerY;

    this.container = scene.add.container(0, 0).setDepth(DEPTH.alert).setVisible(false);
    this.tint = scene.add.rectangle(0, 0, SCREEN.width, SCREEN.height, COLORS.warning, 0.1).setOrigin(0);
    this.vignette = scene.add.image(0, 0, VIGNETTE_KEY).setOrigin(0);
    this.scanlines = scene.add.tileSprite(0, 0, SCREEN.width, SCREEN.height, SCANLINE_KEY).setOrigin(0).setAlpha(0.35);
    // Optional pulsing red edge (the beacon alarm), off by default.
    this.edge = scene.add.image(0, 0, ensureEdge(scene, GEN.edgeDamage)).setOrigin(0).setDisplaySize(SCREEN.width, SCREEN.height).setVisible(false);

    // Dark band behind the text with red rules above and below.
    this.band = scene.add.graphics();
    this.band.fillStyle(COLORS.black, 0.82);
    this.band.fillRect(0, cy - 58, SCREEN.width, 116);
    this.band.fillStyle(COLORS.warning, 0.9);
    this.band.fillRect(0, cy - 60, SCREEN.width, 2);
    this.band.fillRect(0, cy + 58, SCREEN.width, 2);

    const titleStyleRed = titleStyle(ALERT.titleSize, CSS.warning, { shadow: { offsetX: 0, offsetY: 3, color: '#000000', fill: true } });
    this.ghost = scene.add.text(SCREEN.width / 2, cy - 18, '', titleStyle(ALERT.titleSize, CSS.cyan)).setOrigin(0.5).setAlpha(0);
    this.title = scene.add.text(SCREEN.width / 2, cy - 18, '', titleStyleRed).setOrigin(0.5);
    this.subtitle = scene.add.text(SCREEN.width / 2, cy + 30, '', bodyStyle(ALERT.subtitleSize, CSS.cream)).setOrigin(0.5);

    this.container.add([this.tint, this.vignette, this.edge, this.scanlines, this.band, this.ghost, this.title, this.subtitle]);
    this.timers = [];
  }

  // payload of 'alert': { title, subtitle, duration }. `edgePulse: true` adds the
  // pulsing red screen edge (used by the beacon alarm).
  show({ title = '', subtitle = '', duration = 2500, edgePulse = false } = {}) {
    this.stop();
    const scene = this.scene;
    const total = Math.max(600, Number(duration) || 2500);
    this.title.setText(String(title));
    this.ghost.setText(String(title));
    this.subtitle.setText(String(subtitle));
    this.container.setVisible(true).setAlpha(1);

    // Vignette pulses ALERT.pulses times over the first ~60% of the alert.
    const pulseMs = Math.min(320, (total * 0.6) / (ALERT.pulses * 2));
    this.vignette.setAlpha(0.2);
    scene.tweens.add({ targets: this.vignette, alpha: 1, duration: pulseMs, yoyo: true, repeat: ALERT.pulses - 1, ease: 'Sine.easeInOut', onComplete: () => this.vignette.setAlpha(0.75) });

    if (edgePulse) {
      this.edge.setVisible(true).setAlpha(0.3);
      scene.tweens.add({ targets: this.edge, alpha: 1, duration: 340, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    }

    // Text slams in, then glitches now and then (offset + cyan ghost).
    this.title.setScale(1.25).setAlpha(0);
    scene.tweens.add({ targets: this.title, scale: 1, alpha: 1, duration: 160, ease: 'Back.easeOut' });
    this.subtitle.setAlpha(0);
    scene.tweens.add({ targets: this.subtitle, alpha: 1, delay: 200, duration: 200 });
    this.timers.push(scene.time.addEvent({ delay: 90, loop: true, callback: () => this.glitchStep() }));

    // Fade out at the end.
    this.timers.push(
      scene.time.delayedCall(total - 300, () => {
        scene.tweens.add({ targets: this.container, alpha: 0, duration: 300, onComplete: () => this.stop() });
      }),
    );
  }

  glitchStep() {
    const glitching = Math.random() < 0.22;
    const dx = glitching ? Math.round((Math.random() - 0.5) * 10) : 0;
    this.title.x = SCREEN.width / 2 + dx;
    this.ghost.x = SCREEN.width / 2 - dx - 3;
    this.ghost.setAlpha(glitching ? 0.45 : 0);
    this.scanlines.tilePositionY -= 1;
  }

  stop() {
    this.timers.forEach((t) => t.remove(false));
    this.timers = [];
    this.scene.tweens.killTweensOf([this.container, this.vignette, this.edge, this.title, this.subtitle]);
    this.edge.setVisible(false);
    this.container.setVisible(false).setAlpha(1);
    this.title.x = SCREEN.width / 2;
    this.ghost.setAlpha(0);
  }
}

export class TitleCard {
  constructor(scene) {
    this.scene = scene;
    const t = TITLE_CARD;
    ensureGeneratedTextures(scene);
    this.container = scene.add.container(0, 0).setDepth(DEPTH.titleCard).setVisible(false);
    this.band = scene.add.image(t.centerX, t.centerY + 14, BAND_KEY);
    this.title = scene.add
      .text(t.centerX, t.centerY - 24, '', titleStyle(t.titleSize, CSS.cream, { shadow: { offsetX: 0, offsetY: 3, color: '#000000', fill: true } }))
      .setOrigin(0.5);
    this.divider = scene.add.image(t.centerX, t.centerY + 21, 'ui-divider-orange');
    this.subtitle = scene.add.text(t.centerX, t.centerY + 58, '', bodyStyle(t.subtitleSize, CSS.cream, { shadow: { offsetX: 0, offsetY: 2, color: '#000000', fill: true } })).setOrigin(0.5);
    this.container.add([this.band, this.title, this.divider, this.subtitle]);
    this.timer = null;
  }

  // payload of 'title-card': { title, subtitle }. Purely visual; never blocks input.
  show({ title = '', subtitle = '' } = {}) {
    const scene = this.scene;
    const t = TITLE_CARD;
    scene.tweens.killTweensOf([this.container, this.divider]);
    if (this.timer) this.timer.remove(false);

    this.title.setText(String(title));
    this.subtitle.setText(String(subtitle)).setVisible(Boolean(subtitle));
    this.container.setVisible(true).setAlpha(0);
    this.divider.setScale(0.2, 1);

    scene.tweens.add({ targets: this.container, alpha: 1, duration: t.fadeInMs, ease: 'Sine.easeOut' });
    scene.tweens.add({ targets: this.divider, scaleX: 1, duration: t.fadeInMs + 200, ease: 'Cubic.easeOut' });
    this.timer = scene.time.delayedCall(t.fadeInMs + t.holdMs, () => {
      this.timer = null;
      scene.tweens.add({ targets: this.container, alpha: 0, duration: t.fadeOutMs, ease: 'Sine.easeIn', onComplete: () => this.container.setVisible(false) });
    });
  }
}
