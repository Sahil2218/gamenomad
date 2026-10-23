import Phaser from 'phaser';
import Character from './Character.js';
import { GameState } from '../systems/GameState.js';

const WANDER_SPEED = 30; // px/s, a slow stroll
const PAUSE_MIN_MS = 1500;
const PAUSE_MAX_MS = 4000;
const MAX_WALK_MS = 3000; // give up on a target after this long (e.g. blocked by a wall)

/**
 * A villager or companion. Stands still facing `facing`, or wanders around its home spot
 * when `wander` (a radius in px) is greater than 0.
 *
 * data: { id, sprite, name, x, y, facing, dialogue, wander, tint }
 */
export default class NPC extends Character {
  constructor(scene, data) {
    super(scene, data.x, data.y, data.sprite, data.facing || 'down');

    this.npcId = data.id;
    this.displayName = data.name;
    this.dialogueId = data.dialogue;
    this.home = new Phaser.Math.Vector2(data.x, data.y);
    this.wanderRadius = data.wander || 0;

    // Immovable: the player can bump into an NPC but can't shove it around.
    this.body.setImmovable(true);
    this.body.pushable = false;

    if (data.tint) this.setTint(Phaser.Display.Color.HexStringToColor(data.tint).color);

    // A scene script (e.g. Kael's fight) can take over: while true, update() leaves the NPC alone.
    this.scripted = false;

    this.target = null; // where we are walking to, or null while pausing
    this.nextMoveAt = scene.time.now + Phaser.Math.Between(PAUSE_MIN_MS, PAUSE_MAX_MS);
    this.giveUpAt = 0;
  }

  /** Call once per frame from the scene's update(). */
  update(time) {
    this.updateDepth();
    if (this.scripted || this.wanderRadius <= 0) return;

    // Stand still during conversations and cutscenes.
    if (GameState.inputLocked) {
      if (this.target) this.pause(time);
      return;
    }

    if (this.target) this.walkTowardsTarget(time);
    else if (time >= this.nextMoveAt) this.pickTarget(time);
  }

  pickTarget(time) {
    const awayFromHome = Phaser.Math.Distance.BetweenPoints(this, this.home);

    if (awayFromHome > this.wanderRadius) {
      // Drifted too far (e.g. pushed around by collisions): head home.
      this.target = this.home.clone();
    } else {
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.random() * this.wanderRadius;
      this.target = new Phaser.Math.Vector2(
        this.home.x + Math.cos(angle) * distance,
        this.home.y + Math.sin(angle) * distance,
      );
    }
    this.giveUpAt = time + MAX_WALK_MS;
  }

  walkTowardsTarget(time) {
    const dx = this.target.x - this.x;
    const dy = this.target.y - this.y;
    const arrived = Math.hypot(dx, dy) < 2;
    const blocked = !this.body.blocked.none; // touching a collider

    if (arrived || blocked || time > this.giveUpAt) {
      this.pause(time);
      return;
    }

    const velocity = new Phaser.Math.Vector2(dx, dy).normalize().scale(WANDER_SPEED);
    this.setVelocity(velocity.x, velocity.y);

    const facing = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down';
    this.playWalk(facing);
  }

  pause(time) {
    this.target = null;
    this.stopMoving();
    this.nextMoveAt = time + Phaser.Math.Between(PAUSE_MIN_MS, PAUSE_MAX_MS);
  }
}
