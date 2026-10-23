import Phaser from 'phaser';
import tuning from '../data/tuning.json';
import { GameState } from '../systems/GameState.js';

const T = tuning.hold;

const CYAN = 0x3ad4e8;
const GOLD = 0xf0c060;
const WHITE = 0xffffff;
const RELAY_TEXTURE = 'relay'; // 24×40 × 4 frames (task Q), animation 'relay-pulse' (Boot)
const RELAY_FALLBACK = 'relay-fallback';
const RING_SEGMENTS = 48; // straight pieces used to draw the ring (more = rounder)

/**
 * A relay the player must hold: stand inside its rectangle until the bar fills.
 *
 *   const relay = new HoldPoint(scene, player, rect, { id: 'relay-1', duration: 12000, onComplete });
 *   relay.update(time, delta);   // every frame
 *   relay.done                   // true once held
 *
 * - Progress fills while the player's feet are inside, and drains slowly when they step out.
 * - It pauses while input is locked (dialogue, cutscene).
 * - GameState 'hold' events ({ id, progress, active }) go out ~10×/s while anything changes,
 *   and immediately whenever `active` flips or the hold completes, for the UI's meter.
 * - The look: a 'relay' pylon at the centre and a pulsing ring on the floor that turns from
 *   cyan to gold as it fills, then flashes when complete. onComplete() runs exactly once.
 * - AEGIS field: while the player holds it, the relay pulses every few seconds and calls
 *   onPulse(x, y, radius) so the scene can blast nearby crawlers back. Stepping out (or being
 *   knocked out) gives a short grace period before progress starts to drain.
 */
export default class HoldPoint {
  /** rect: { x, y, w, h } (map JSON) or a Phaser.Geom.Rectangle. */
  constructor(scene, player, rect, { id, duration = T.duration, onComplete, onPulse } = {}) {
    this.scene = scene;
    this.player = player;
    this.rect = toRectangle(rect);
    this.id = id;
    this.duration = duration;
    this.onComplete = onComplete || (() => {});
    this.onPulse = onPulse || (() => {});

    this.progress = 0; // 0..1
    this.active = false; // the player is standing inside (and not locked)
    this.isDone = false;
    this.lastEmitAt = -Infinity;
    this.lastEmitted = null; // the last { progress, active } we sent
    this.flashUntil = 0;
    this.lastInsideAt = -Infinity; // for the grace period before draining
    this.nextPulseAt = 0;

    this.createVisuals();
  }

  /** True once the hold has completed. */
  get done() {
    return this.isDone;
  }

  /** Call once per frame from the scene's update(time, delta). delta is in ms. */
  update(time, delta) {
    if (!this.isDone) this.updateProgress(time, delta);
    this.draw(time);
  }

  destroy() {
    this.ring.destroy();
    this.glow?.destroy();
    this.relay.destroy();
  }

  // ---------- progress ----------

  updateProgress(time, delta) {
    const ms = Math.min(delta ?? this.scene.game.loop.delta, 100);
    const locked = GameState.inputLocked;
    const inside = this.rect.contains(this.player.x, this.player.y);

    // Frozen while locked; otherwise fill inside and, after a short grace, drain (slower) outside.
    if (!locked) {
      const rate = ms / this.duration;
      if (inside) {
        this.lastInsideAt = time;
        this.progress += rate;
      } else if (time - this.lastInsideAt > (T.graceMs ?? 0)) {
        this.progress -= rate * T.decayFraction;
      }
      this.progress = Phaser.Math.Clamp(this.progress, 0, 1);
    }

    const wasActive = this.active;
    this.active = inside && !locked;
    if (this.active && time >= this.nextPulseAt) this.pulse(time);

    if (this.progress >= 1) {
      this.complete(time);
      return;
    }
    this.emitHold(time, this.active !== wasActive);
  }

  /** The AEGIS field: an expanding cyan ring, and the scene repels crawlers inside it. */
  pulse(time) {
    this.nextPulseAt = time + (T.pulseEveryMs ?? 2200);
    const radius = T.pulseRadius ?? 72;
    const { centerX: x, centerY: y } = this.rect;
    this.onPulse(x, y, radius);

    const wave = this.scene.add.circle(x, y, radius, CYAN, 0).setStrokeStyle(2, CYAN, 0.9).setDepth(T.ringDepth);
    wave.setScale(0.2);
    this.scene.tweens.add({ targets: wave, scale: 1, alpha: 0, duration: 450, ease: 'Cubic.easeOut', onComplete: () => wave.destroy() });
  }

  complete(time) {
    this.isDone = true;
    this.active = false;
    this.progress = 1;
    this.emitHold(time, true);
    this.celebrate(time);
    this.onComplete(this);
  }

  /**
   * Sends a 'hold' event when the state flips (force), otherwise at most every emitEveryMs and
   * only if something changed. Standing outside at 0 progress sends nothing.
   */
  emitHold(time, force) {
    const last = this.lastEmitted;
    const changed = !last || last.progress !== this.progress || last.active !== this.active;
    if (!changed) return;
    if (!force && time - this.lastEmitAt < T.emitEveryMs) return;
    if (!force && !last && this.progress === 0) return; // never touched yet: nothing to report

    this.lastEmitAt = time;
    this.lastEmitted = { progress: this.progress, active: this.active };
    GameState.emit('hold', { id: this.id, progress: this.progress, active: this.active });
  }

  // ---------- visuals ----------

  createVisuals() {
    const scene = this.scene;
    const { centerX, centerY } = this.rect;

    // The ring is redrawn every frame on a Graphics object lying on the floor (below every actor).
    this.ring = scene.add.graphics().setDepth(T.ringDepth);

    // A soft light pooled on the floor (ADD blending brightens what's underneath).
    if (scene.textures.exists('fx-glow')) {
      const size = Math.max(this.rect.width, this.rect.height);
      this.glow = scene.add.image(centerX, centerY, 'fx-glow').setBlendMode(Phaser.BlendModes.ADD);
      this.glow.setDepth(T.ringDepth).setScale(size / 32).setTint(CYAN).setAlpha(0.2);
    }

    // The pylon: feet (bottom-centre) at the middle of the rectangle; depth = feet y like any actor.
    const hasArt = scene.textures.exists(RELAY_TEXTURE);
    this.relay = scene.add.sprite(centerX, centerY, hasArt ? RELAY_TEXTURE : relayFallback(scene), hasArt ? 0 : undefined);
    this.relay.setOrigin(0.5, 1).setDepth(centerY);
    if (hasArt && scene.anims.exists('relay-pulse')) this.relay.play('relay-pulse');
  }

  draw(time) {
    const g = this.ring;
    const { centerX: x, centerY: y } = this.rect;
    // An ellipse that fits inside the rectangle, so the ring shows exactly where to stand.
    const rx = Math.max(6, this.rect.width / 2 - T.ringInsetPx);
    const ry = Math.max(4, this.rect.height / 2 - T.ringInsetPx);
    const pulse = 0.5 + 0.5 * Math.sin((time / T.ringPulseMs) * Math.PI * 2);
    const flashing = time < this.flashUntil;

    // Cyan when empty, gold when full (and white while the completion flash runs).
    const colour = flashing ? WHITE : lerpColour(CYAN, GOLD, this.isDone ? 1 : this.progress);
    const energy = this.isDone ? 0.6 : this.active ? 1 : 0.7;

    g.clear();
    // A faint disc on the floor, brighter while you stand in it.
    g.fillStyle(colour, (flashing ? 0.35 : this.active ? 0.14 : 0.06) + 0.05 * pulse);
    g.fillEllipse(x, y, rx * 2, ry * 2);
    // A wide soft halo that breathes in and out, then the crisp ring itself.
    g.lineStyle(4, colour, (0.18 + 0.17 * pulse) * energy);
    g.strokeEllipse(x, y, (rx + 2 + pulse * 2) * 2, (ry + 2 + pulse * 2) * 2);
    g.lineStyle(1, colour, (0.75 + 0.25 * pulse) * energy);
    g.strokeEllipse(x, y, rx * 2, ry * 2);

    // The fill: a thick gold arc growing clockwise from the top, with a soft edge.
    if (this.progress > 0 && !this.isDone) {
      const arc = ellipseArc(x, y, rx, ry, this.progress);
      g.lineStyle(5, GOLD, 0.25);
      g.strokePoints(arc, false);
      g.lineStyle(2, GOLD, 1);
      g.strokePoints(arc, false);
    }

    if (this.glow) {
      this.glow.setTint(colour).setAlpha((0.14 + 0.1 * pulse) * energy + (flashing ? 0.5 : 0));
    }
  }

  /** The completion flash: white ring, a bright expanding glow, and the pylon turns gold. */
  celebrate(time) {
    this.flashUntil = time + T.flashMs;
    this.relay.setTint(0xffe6a8);

    const scene = this.scene;
    if (!scene.textures.exists('fx-glow')) return;
    const { centerX, centerY } = this.rect;
    const size = Math.max(this.rect.width, this.rect.height) / 32;
    const burst = scene.add.image(centerX, centerY - 12, 'fx-glow').setBlendMode(Phaser.BlendModes.ADD);
    burst.setTint(GOLD).setDepth(centerY + 1).setScale(size * 0.5).setAlpha(1);
    scene.tweens.add({
      targets: burst,
      scale: size * 2.2,
      alpha: 0,
      duration: T.flashMs,
      ease: 'Quad.easeOut',
      onComplete: () => burst.destroy(),
    });
  }
}

// ---------- helpers ----------

function toRectangle(r) {
  if (r instanceof Phaser.Geom.Rectangle) return r;
  return new Phaser.Geom.Rectangle(r.x, r.y, r.w ?? r.width, r.h ?? r.height);
}

/** Mixes two 0xRRGGBB colours: t = 0 gives a, t = 1 gives b. */
function lerpColour(a, b, t) {
  const from = Phaser.Display.Color.IntegerToColor(a);
  const to = Phaser.Display.Color.IntegerToColor(b);
  const mixed = Phaser.Display.Color.Interpolate.ColorWithColor(from, to, 100, Math.round(t * 100));
  return Phaser.Display.Color.GetColor(mixed.r, mixed.g, mixed.b);
}

/** Points along an ellipse from the top (12 o'clock), clockwise, for `fraction` of a full turn. */
function ellipseArc(x, y, rx, ry, fraction) {
  const steps = Math.max(2, Math.ceil(RING_SEGMENTS * fraction));
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const angle = -Math.PI / 2 + (i / steps) * fraction * Math.PI * 2;
    points.push({ x: x + Math.cos(angle) * rx, y: y + Math.sin(angle) * ry });
  }
  return points;
}

/** A simple stand-in pylon (24×40), drawn once, for when the 'relay' art isn't loaded. */
function relayFallback(scene) {
  if (!scene.textures.exists(RELAY_FALLBACK)) {
    const g = scene.make.graphics({ x: 0, y: 0 }, false); // false = not added to the scene
    g.fillStyle(0x1a1d27, 1).fillRect(5, 34, 14, 6); // base
    g.fillStyle(0x3a3f4f, 1).fillRect(9, 6, 6, 30); // mast
    g.fillStyle(CYAN, 1).fillRect(10, 10, 4, 22); // glowing core
    g.fillStyle(0xbff6ff, 1).fillRect(8, 2, 8, 6); // emitter
    g.generateTexture(RELAY_FALLBACK, 24, 40);
    g.destroy();
  }
  return RELAY_FALLBACK;
}
