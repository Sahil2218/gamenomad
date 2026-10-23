import Phaser from 'phaser';
import tuning from '../data/tuning.json';
import { GameState } from '../systems/GameState.js';
import Follower from '../entities/Follower.js';

const T = tuning.party;

// Unit vector pointing *behind* someone facing each way.
const BEHIND = {
  down: { x: 0, y: -1 },
  up: { x: 0, y: 1 },
  left: { x: 1, y: 0 },
  right: { x: -1, y: 0 },
};

/**
 * The companions walking behind the player, like a line of ducklings.
 *
 * We record the player's path as a list of points ("history", newest first) whenever they move
 * at least recordStepPx. Follower N walks to the point `spacing × N` px back along that path,
 * so the party follows the exact route the player took, around corners and all.
 */
export default class Party {
  constructor(scene, player) {
    this.scene = scene;
    this.player = player;
    this.followers = [];
    this.history = []; // [{ x, y }], history[0] = most recent player position
    this.lastTime = null;

    // Companions who joined in earlier scenes (or loaded from a save) start in line behind the player.
    GameState.party.forEach((id) => this.followers.push(new Follower(scene, id, player.x, player.y, player.facing)));
    this.teleportToPlayer();
  }

  /** The follower sprites, in join order. Each has .companionId and .dialogueId ('party-<id>'). */
  get members() {
    return [...this.followers];
  }

  /** The follower for a companion id, or null. */
  get(id) {
    return this.followers.find((f) => f.companionId === id) || null;
  }

  /**
   * A newly joined companion appears at (x, y), usually where their NPC stood, and walks into line.
   * Adding someone who is already following just returns them.
   */
  add(id, x, y) {
    const existing = this.get(id);
    if (existing) return existing;

    const follower = new Follower(this.scene, id, x, y);
    follower.faceTowards(this.player.x, this.player.y);
    this.followers.push(follower);
    return follower;
  }

  /**
   * Takes a companion out of the line (e.g. for a cutscene) and returns their Follower, or null.
   * The sprite stays in the world, but the party stops steering it: the caller owns it now.
   * Everyone behind them moves up one place and closes the gap by walking.
   * (Interactions still knows the sprite: call interactions.removeOwner(follower) if needed.)
   */
  detach(id) {
    const follower = this.get(id);
    if (!follower) return null;
    this.followers = this.followers.filter((f) => f !== follower);
    return follower;
  }

  /** Takes a companion out of the line and destroys their sprite. Returns true if they were here. */
  remove(id) {
    const follower = this.detach(id);
    if (!follower) return false;
    follower.destroy();
    return true;
  }

  /** Call once per frame from the scene's update(time, delta). delta is optional. */
  update(time, delta) {
    const dt = this.frameSeconds(time, delta);
    this.recordPlayer();

    this.followers.forEach((follower, index) => {
      const target = this.pointBehind(T.spacing * (index + 1));
      follower.walkTowards(target.x, target.y, dt);
    });
  }

  /**
   * Puts everyone straight into line just behind the player (after a respawn or a drone catch).
   * The path history is reset to a straight line behind the player, so nobody walks in from far away.
   */
  teleportToPlayer() {
    const { x, y, facing } = this.player;
    const back = BEHIND[facing] || BEHIND.down;
    const length = T.spacing * (this.followers.length + 1);

    this.history = [];
    for (let d = 0; d <= length; d += T.recordStepPx) {
      this.history.push({ x: x + back.x * d, y: y + back.y * d });
    }

    this.followers.forEach((follower, index) => {
      const spot = this.pointBehind(T.spacing * (index + 1));
      follower.placeAt(spot.x, spot.y, facing);
    });
  }

  // ---------- path history ----------

  /** Adds the player's position once they have moved far enough, and forgets what nobody needs. */
  recordPlayer() {
    const { x, y } = this.player;
    const newest = this.history[0];
    if (newest && Phaser.Math.Distance.Between(x, y, newest.x, newest.y) < T.recordStepPx) return;

    this.history.unshift({ x, y });
    this.trimHistory();
  }

  /** Keep just enough path for the last follower (plus a little spare). */
  trimHistory() {
    const needed = T.spacing * (this.followers.length + 1) + 20;
    let total = 0;
    for (let i = 1; i < this.history.length; i += 1) {
      const a = this.history[i - 1];
      const b = this.history[i];
      total += Phaser.Math.Distance.Between(a.x, a.y, b.x, b.y);
      if (total > needed) {
        this.history.length = i + 1; // drop everything older
        return;
      }
    }
  }

  /**
   * The point `distance` px back along the player's path, starting from where the player is now.
   * If the path is shorter than that, the oldest recorded point.
   */
  pointBehind(distance) {
    let previous = { x: this.player.x, y: this.player.y };
    let remaining = distance;

    for (const point of this.history) {
      const segment = Phaser.Math.Distance.Between(previous.x, previous.y, point.x, point.y);
      if (segment >= remaining && segment > 0) {
        const t = remaining / segment;
        return { x: previous.x + (point.x - previous.x) * t, y: previous.y + (point.y - previous.y) * t };
      }
      remaining -= segment;
      previous = point;
    }
    return previous;
  }

  /** Seconds since the last frame: from delta if given, else from the time difference. */
  frameSeconds(time, delta) {
    const ms = delta ?? (this.lastTime === null ? 0 : time - this.lastTime);
    this.lastTime = time;
    return Phaser.Math.Clamp(ms / 1000, 0, 0.1);
  }
}
