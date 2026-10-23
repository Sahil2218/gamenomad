import Phaser from 'phaser';
import tuning from '../data/tuning.json';
import { GameState } from './GameState.js';

const T = tuning.combat;

// Unit vectors and slash rotations (radians) for each facing.
// The fx-slash art is drawn for an UPWARD swing (the arc bulges towards the top of the texture),
// so up needs no rotation and the others turn clockwise from there. It pivots on its centre.
const DIRECTIONS = {
  up: { x: 0, y: -1, angle: 0 },
  right: { x: 1, y: 0, angle: Math.PI / 2 },
  down: { x: 0, y: 1, angle: Math.PI },
  left: { x: -1, y: 0, angle: -Math.PI / 2 },
};

// The player's feet are at (x, y); the middle of the body is about this far up.
const BODY_MID_Y = 10;

/**
 * SPACE = strike with Kael's rebar (needs the 'has_weapon' flag).
 * The hitbox is a rectangle in front of the player; anything crawlers.hitArea finds there takes a hit.
 */
export default class Combat {
  constructor(scene, player, crawlers) {
    this.scene = scene;
    this.player = player;
    this.crawlers = crawlers;
    this.readyAt = 0; // time (ms) when the next strike is allowed

    this.key = scene.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
  }

  /** Call once per frame from the scene's update(time). */
  update(time) {
    // JustDown is true once per physical press (holding the key or OS key-repeat doesn't re-fire).
    // Always read it, so a press made during a dialogue isn't "remembered" and fired later.
    const pressed = Phaser.Input.Keyboard.JustDown(this.key);

    if (!pressed || time < this.readyAt) return;
    if (GameState.inputLocked || !GameState.hasFlag('has_weapon')) return;

    this.strike(time);
  }

  strike(time) {
    this.readyAt = time + T.strikeCooldownMs;

    const dir = DIRECTIONS[this.player.facing] || DIRECTIONS.down;
    const hitbox = this.hitboxFor(dir);

    this.showSlash(hitbox, dir);
    this.player.pushBack(dir.x * T.lungeSpeed, dir.y * T.lungeSpeed, T.lungeMs); // small lunge forward

    // Knock crawlers away from the player's body, not from the hitbox centre.
    const hits = this.crawlers ? this.crawlers.hitArea(hitbox, T.strikeDamage, this.player.x, this.player.y - BODY_MID_Y / 2) : 0;
    if (hits > 0) this.scene.cameras.main.shake(T.hitShakeMs, T.hitShakeIntensity);
    return hits;
  }

  /**
   * A rectangle `hitboxLength` deep in front of the player and `hitboxWidth` across.
   * It starts a little inside the body so point-blank enemies are still hit.
   */
  hitboxFor(dir) {
    const length = T.hitboxLength;
    const width = T.hitboxWidth;
    const cx = this.player.x;
    const cy = this.player.y - BODY_MID_Y;

    if (dir.x !== 0) {
      const x = dir.x > 0 ? cx + 4 : cx - 4 - length;
      return new Phaser.Geom.Rectangle(x, cy - width / 2, length, width);
    }
    const y = dir.y > 0 ? cy + 2 : cy - 6 - length;
    return new Phaser.Geom.Rectangle(cx - width / 2, y, width, length);
  }

  /** The white fx-slash arc, rotated to the facing, swelling and fading over ~150 ms. */
  showSlash(hitbox, dir) {
    if (!this.scene.textures.exists('fx-slash')) return;

    const slash = this.scene.add.image(hitbox.centerX, hitbox.centerY, 'fx-slash');
    slash.setRotation(dir.angle);
    // Above the player, except when striking upwards (then the arc is "behind" the body).
    slash.setDepth(dir.y < 0 ? this.player.y - 1 : this.player.y + 1);
    slash.setScale(0.8).setAlpha(1);

    this.scene.tweens.add({
      targets: slash,
      scale: 1.15,
      alpha: 0,
      duration: T.slashFadeMs,
      ease: 'Quad.easeOut',
      onComplete: () => slash.destroy(),
    });
  }
}
