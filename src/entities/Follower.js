import tuning from '../data/tuning.json';
import Character from './Character.js';

const T = tuning.party;

/**
 * A companion walking behind the player. Party (world/Party.js) tells it where to go each frame.
 *
 * It uses the companion's own spritesheet (the id doubles as the sprite key) and has no collisions:
 * the physics body is switched off and we move it by hand, so it can never get stuck on a wall
 * or block the player. Interactions can treat it like an NPC: `dialogueId` is 'party-<id>'.
 */
export default class Follower extends Character {
  constructor(scene, id, x, y, facing = 'down') {
    super(scene, x, y, id, facing);

    this.companionId = id;
    this.npcId = id;
    this.dialogueId = `party-${id}`;
    this.displayName = id.charAt(0).toUpperCase() + id.slice(1);

    // A disabled body is ignored by the physics engine: no collisions, no velocity.
    if (this.body) this.body.enable = false;
  }

  /**
   * Walk towards (tx, ty) for this frame. dt in seconds.
   * Far behind (e.g. just joined, or after a teleport) it hurries to catch up.
   */
  walkTowards(tx, ty, dt) {
    const dx = tx - this.x;
    const dy = ty - this.y;
    const distance = Math.hypot(dx, dy);

    if (distance <= T.arriveDistance) {
      this.playIdle();
      this.updateDepth();
      return;
    }

    const speed = distance > T.catchUpDistance ? T.catchUpSpeed : T.followSpeed;
    const step = Math.min(distance, speed * dt);
    this.setPosition(this.x + (dx / distance) * step, this.y + (dy / distance) * step);

    // Face the way we are walking (the bigger of the two axes wins).
    const facing = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down';
    this.playWalk(facing);
    this.updateDepth();
  }

  /** Jump straight to a spot (no walking), standing idle. */
  placeAt(x, y, facing = this.facing) {
    this.setPosition(x, y);
    this.playIdle(facing);
    this.updateDepth();
  }
}
