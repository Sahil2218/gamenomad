import Phaser from 'phaser';
import tuning from '../data/tuning.json';
import { GameState } from './GameState.js';

const T = tuning.survival;

/**
 * The player's health and toxicity rules.
 *
 * Every frame (update):
 *   - toxic ground raises toxicity; elsewhere it decays (faster with the healer in the party)
 *   - at 100 toxicity, health drains
 *   - corrupted ground and fire hurt; fire also pushes you out of the flames
 * Health damage is dealt in "ticks" (every hazardTickSec) so the UI's red flash pulses instead of strobing.
 *
 * hurt(amount, fromX, fromY) is for contact damage (crawlers): a knockback, then ~0.8 s of
 * invulnerability ("i-frames") shown by flickering the player.
 *
 * onDeath() fires once when health reaches 0, and not again until reset().
 */
export default class Survival {
  constructor(scene, player, hazards, { onDeath } = {}) {
    this.scene = scene;
    this.player = player;
    this.hazards = hazards || null; // the Village has no hazards
    this.onDeath = onDeath || (() => {});
    this.reset();
  }

  /** Clears i-frames and the death latch, e.g. after respawning at a checkpoint. */
  reset() {
    this.invulnerableUntil = 0;
    this.flickering = false;
    this.dead = false;
    // Starts "full" so the first frame on a hazard ticks straight away.
    this.tickClock = T.hazardTickSec;
    if (this.player) this.player.setAlpha(1);
  }

  /** True during the i-frames after a hit. */
  isInvulnerable() {
    return this.scene.time.now < this.invulnerableUntil;
  }

  /** Call once per frame from the scene's update(time, delta). */
  update(time, delta) {
    this.updateFlicker(time); // visuals keep running even while input is locked

    if (GameState.inputLocked || this.dead) return;

    // delta is in ms; clamp it so a long pause (switching tabs) doesn't land as one huge tick.
    const dt = Math.min((delta ?? this.scene.game.loop.delta) / 1000, T.maxFrameSec);
    const types = this.hazards ? this.hazards.typesAt(this.player.x, this.player.y) : new Set();

    this.updateToxicity(types, dt);
    this.updateHazardDamage(types, dt);
    this.checkDeath();
  }

  // ---------- toxicity ----------

  updateToxicity(types, dt) {
    const current = GameState.toxicity;
    let next;

    if (types.has('toxic')) {
      next = current + T.toxicRisePerSec * dt;
    } else {
      const healer = GameState.inParty(T.healer);
      next = current - (healer ? T.toxicDecayWithHealerPerSec : T.toxicDecayPerSec) * dt;
    }

    next = Phaser.Math.Clamp(next, 0, 100);
    if (next !== current) GameState.setToxicity(next); // skip the event when nothing changed
  }

  // ---------- damage over time ----------

  /** Collects every damaging source under the player and deals them together once per tick. */
  updateHazardDamage(types, dt) {
    const sources = [];
    if (GameState.toxicity >= 100) sources.push({ source: 'toxic', perSec: T.toxicDrainHealthPerSec });
    if (types.has('corrupt')) sources.push({ source: 'corrupt', perSec: T.corruptDamagePerSec });
    if (types.has('fire')) sources.push({ source: 'fire', perSec: T.fireDamagePerSec });

    // Off every hazard the clock refills (capped), so stepping out and back in can't double-tick.
    this.tickClock = Math.min(this.tickClock + dt, T.hazardTickSec);
    if (sources.length === 0 || this.tickClock < T.hazardTickSec) return;
    this.tickClock = 0;

    sources.forEach(({ source, perSec }) => {
      const amount = Math.max(1, Math.round(perSec * T.hazardTickSec));
      GameState.damage(amount, source);
    });

    if (types.has('fire')) this.pushOutOfFire();
  }

  /** Shoves the player towards the nearest edge of the fire they stand in. */
  pushOutOfFire() {
    const { x, y } = this.player;
    const fire = this.hazards.areasAt(x, y).find((area) => area.type === 'fire');
    if (!fire) return;

    const { rect } = fire;
    // Distance to each edge; the smallest one is the quickest way out.
    const exits = [
      { d: x - rect.left, vx: -1, vy: 0 },
      { d: rect.right - x, vx: 1, vy: 0 },
      { d: y - rect.top, vx: 0, vy: -1 },
      { d: rect.bottom - y, vx: 0, vy: 1 },
    ];
    const best = exits.reduce((a, b) => (b.d < a.d ? b : a));
    this.player.pushBack(best.vx * T.firePushSpeed, best.vy * T.firePushSpeed, T.firePushMs);
  }

  // ---------- contact damage ----------

  /**
   * A hit from something at (fromX, fromY). Returns false (and does nothing) during i-frames.
   * source is passed on to GameState.damage for the UI ('crawler' by default).
   */
  hurt(amount, fromX, fromY, source = 'crawler') {
    if (this.dead || this.isInvulnerable()) return false;

    GameState.damage(amount, source);
    this.invulnerableUntil = this.scene.time.now + T.invulnerableSec * 1000;
    this.knockBack(fromX, fromY);
    this.checkDeath();
    return true;
  }

  /** Pushes the player directly away from the hit. */
  knockBack(fromX, fromY) {
    if (fromX === undefined || fromY === undefined) return;
    const away = new Phaser.Math.Vector2(this.player.x - fromX, this.player.y - fromY);
    if (away.lengthSq() === 0) away.set(0, 1); // standing exactly on top: push south
    away.normalize().scale(T.knockbackSpeed);
    this.player.pushBack(away.x, away.y, T.knockbackMs);
  }

  /** Blinks the player's alpha during i-frames, and makes sure it ends fully visible. */
  updateFlicker(time) {
    if (time < this.invulnerableUntil) {
      this.flickering = true;
      const on = Math.floor(time / T.flickerMs) % 2 === 0;
      this.player.setAlpha(on ? 1 : T.flickerAlpha);
    } else if (this.flickering) {
      this.flickering = false;
      this.player.setAlpha(1);
    }
  }

  // ---------- death ----------

  checkDeath() {
    if (this.dead || GameState.godMode) return;
    if (GameState.health > 0) return;

    this.dead = true; // latch: only once until reset()
    this.player.setAlpha(1);
    this.onDeath();
  }
}
