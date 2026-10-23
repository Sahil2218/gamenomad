// Memory restore overlay (contract M3 §7), on the 'memory-restore' event.
//
// About 4.5 s: a white bloom floods in from the centre, drifting light
// fragments (additive `fx-memory` streaks) rise through it, the memory title and
// sub fade in, then everything fades away.
// Purely visual: it never touches input, and it sits under the dialogue box
// (DEPTH.memory), so a dialogue that starts meanwhile stays readable.

import Phaser from 'phaser';
import { SCREEN } from './uiLayout.js';
import { DEPTH, bodyStyle, titleStyle } from './uiStyle.js';
import { GEN, ensureBloom, memoryStreakKey } from './uiTextures.js';

const TOTAL_MS = 4500;
const FADE_OUT_MS = 800;
const STREAKS = 34;
const GLOWS = 9; // big soft "bokeh" lights drifting slowly behind the streaks
const INK = '#1d2233'; // dark text reads best on the bright bloom
const INK_SOFT = '#4a4f63';
const STREAK_TINT = 0xfff0cc; // warm white (WebGL only; Canvas shows them white)

export class MemoryOverlay {
  constructor(scene) {
    this.scene = scene;
    this.active = false;
    this.timers = [];
    const { width, height } = SCREEN;
    const cx = width / 2;
    const cy = height / 2 - 40;

    this.container = scene.add.container(0, 0).setDepth(DEPTH.memory).setVisible(false);
    // A flat white veil plus a centred bloom: bright behind the text, softer at the edges.
    this.veil = scene.add.rectangle(0, 0, width, height, 0xfffaf0, 1).setOrigin(0);
    this.bloom = scene.add.image(cx, cy, ensureBloom(scene)).setDisplaySize(width * 1.5, height * 1.5);

    // Light fragments: soft glows first (behind), then the fx-memory streaks.
    const streakKey = memoryStreakKey(scene);
    this.streaks = [];
    for (let i = 0; i < GLOWS + STREAKS; i++) {
      const glow = i < GLOWS;
      const s = scene.add.image(0, 0, glow ? GEN.bloom : streakKey).setBlendMode(Phaser.BlendModes.ADD).setTint(STREAK_TINT);
      this.streaks.push({ sprite: s, glow, vx: 0, vy: 0, base: 1, flicker: 0 });
    }

    this.title = scene.add.text(cx, cy - 18, '', titleStyle(32, INK, { align: 'center' })).setOrigin(0.5);
    this.rule = scene.add.rectangle(cx, cy + 12, 280, 2, 0x1d2233, 0.55);
    this.sub = scene.add.text(cx, cy + 40, '', bodyStyle(30, INK_SOFT, { align: 'center', wordWrap: { width: 760 } })).setOrigin(0.5, 0);

    this.container.add([this.veil, this.bloom, ...this.streaks.map((s) => s.sprite), this.title, this.rule, this.sub]);
  }

  // Scatter one fragment over the screen (or just below it, so it rises in).
  placeStreak(streak, anywhere) {
    const { width, height } = SCREEN;
    const s = streak.sprite;
    const speed = streak.glow ? Phaser.Math.Between(8, 22) : Phaser.Math.Between(30, 75);
    const angle = Phaser.Math.FloatBetween(-1.3, -0.75); // upwards, leaning right
    streak.vx = Math.cos(angle) * speed;
    streak.vy = Math.sin(angle) * speed;
    streak.base = streak.glow ? Phaser.Math.FloatBetween(0.12, 0.3) : Phaser.Math.FloatBetween(0.45, 1);
    streak.flicker = Phaser.Math.FloatBetween(0, Math.PI * 2);
    s.setPosition(Phaser.Math.Between(-60, width), anywhere ? Phaser.Math.Between(0, height) : height + Phaser.Math.Between(20, 120));
    if (streak.glow) {
      const size = Phaser.Math.FloatBetween(60, 150); // round, although the bloom texture is 16:9
      s.setRotation(0).setDisplaySize(size, size);
    } else {
      s.setRotation(angle); // the streak points along its motion
      s.setScale(Phaser.Math.FloatBetween(1.2, 3), Phaser.Math.FloatBetween(1, 2));
    }
  }

  // title / sub: strings 'memory-title' / 'memory-sub'.
  show(title, sub) {
    this.stop();
    const scene = this.scene;
    const tweens = scene.tweens;
    this.active = true;
    this.title.setText(String(title || '').toUpperCase());
    this.sub.setText(String(sub || ''));
    this.container.setVisible(true).setAlpha(1);

    // 1) The bloom floods in, peaks, then settles into a bright haze.
    this.veil.setAlpha(0);
    this.bloom.setAlpha(0).setScale(this.bloom.scaleX * 0.8, this.bloom.scaleY * 0.8);
    tweens.add({ targets: this.veil, alpha: 0.88, duration: 850, ease: 'Sine.easeIn' });
    tweens.add({ targets: this.veil, alpha: 0.34, delay: 900, duration: 900, ease: 'Sine.easeInOut' });
    tweens.add({ targets: this.bloom, alpha: 0.95, scaleX: this.bloom.scaleX / 0.8, scaleY: this.bloom.scaleY / 0.8, duration: 1300, ease: 'Sine.easeOut' });

    // 2) Light fragments drift up through it.
    this.streaks.forEach((streak) => {
      this.placeStreak(streak, true);
      streak.sprite.setAlpha(0);
    });
    this.fragments = { value: 0 };
    tweens.add({ targets: this.fragments, value: 1, delay: 250, duration: 900, ease: 'Sine.easeOut' });

    // 3) The words of the memory.
    this.title.setAlpha(0).setY(this.title.y + 8);
    tweens.add({ targets: this.title, alpha: 1, y: this.title.y - 8, delay: 1050, duration: 650, ease: 'Cubic.easeOut' });
    this.rule.setAlpha(0).setScale(0.1, 1);
    tweens.add({ targets: this.rule, alpha: 0.55, scaleX: 1, delay: 1250, duration: 700, ease: 'Cubic.easeOut' });
    this.sub.setAlpha(0);
    tweens.add({ targets: this.sub, alpha: 1, delay: 1500, duration: 650, ease: 'Sine.easeOut' });

    // 4) Fade it all away.
    this.timers.push(
      scene.time.delayedCall(TOTAL_MS - FADE_OUT_MS, () => {
        tweens.add({ targets: this.container, alpha: 0, duration: FADE_OUT_MS, ease: 'Sine.easeIn', onComplete: () => this.stop() });
      }),
    );
  }

  // Called every frame by UIScene: move the fragments (only while showing).
  update(time, delta) {
    if (!this.active) return;
    const dt = Math.min(delta, 50) / 1000;
    const fade = this.fragments ? this.fragments.value : 1;
    for (const streak of this.streaks) {
      const s = streak.sprite;
      s.x += streak.vx * dt;
      s.y += streak.vy * dt;
      if (s.y < -160 || s.x > SCREEN.width + 160) this.placeStreak(streak, false);
      s.setAlpha(fade * streak.base * (0.65 + 0.35 * Math.sin(time / 160 + streak.flicker)));
    }
  }

  stop() {
    this.timers.forEach((t) => t.remove(false));
    this.timers = [];
    const tweens = this.scene.tweens;
    tweens.killTweensOf([this.container, this.veil, this.bloom, this.title, this.rule, this.sub]);
    if (this.fragments) tweens.killTweensOf(this.fragments);
    if (this.active) {
      // Put the moved pieces back where the next show() expects them.
      const cy = SCREEN.height / 2 - 40;
      this.title.setY(cy - 18);
      this.bloom.setDisplaySize(SCREEN.width * 1.5, SCREEN.height * 1.5);
    }
    this.active = false;
    this.container.setVisible(false).setAlpha(1);
  }
}
