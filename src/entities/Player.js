import Phaser from 'phaser';
import Character from './Character.js';
import { GameState } from '../systems/GameState.js';

const SPEED = 90; // pixels per second

/** The Nomad: moved with WASD or the arrow keys. */
export default class Player extends Character {
  constructor(scene, x, y, facing = 'down') {
    super(scene, x, y, 'nomad', facing);

    this.setCollideWorldBounds(true); // can't walk off the map

    this.keys = scene.input.keyboard.addKeys({
      up: 'W',
      down: 'S',
      left: 'A',
      right: 'D',
      arrowUp: 'UP',
      arrowDown: 'DOWN',
      arrowLeft: 'LEFT',
      arrowRight: 'RIGHT',
    });

    this.pushedUntil = 0; // while pushed back, player input is ignored

    // A cutscene (or a scene fading out) can take over: while true, the keys do nothing
    // and update() leaves the position and animation alone.
    this.scripted = false;
  }

  /** Call once per frame from the scene's update(). */
  update(time) {
    this.updateDepth();

    if (this.scripted) return;
    if (time < this.pushedUntil) return; // let the push-back velocity play out

    if (GameState.inputLocked) {
      this.stopMoving();
      return;
    }

    const { dx, dy } = this.readDirection();
    if (dx === 0 && dy === 0) {
      this.stopMoving();
      return;
    }

    // Normalise so diagonal movement isn't faster than straight movement.
    const velocity = new Phaser.Math.Vector2(dx, dy).normalize().scale(SPEED);
    this.setVelocity(velocity.x, velocity.y);
    this.playWalk(chooseFacing(dx, dy, this.facing));
  }

  /** Returns -1, 0 or 1 on each axis from the held keys. */
  readDirection() {
    const k = this.keys;
    const left = k.left.isDown || k.arrowLeft.isDown;
    const right = k.right.isDown || k.arrowRight.isDown;
    const up = k.up.isDown || k.arrowUp.isDown;
    const down = k.down.isDown || k.arrowDown.isDown;
    return { dx: Number(right) - Number(left), dy: Number(down) - Number(up) };
  }

  /** Shoves the player with a velocity for a short time (barrier, zones, knockback). */
  pushBack(vx, vy, durationMs) {
    this.setVelocity(vx, vy);
    this.playIdle();
    this.pushedUntil = this.scene.time.now + durationMs;
  }

  /** Jumps to (x, y) instantly, e.g. back to a checkpoint. */
  teleportTo(x, y) {
    // body.reset moves both the sprite and its physics body, and zeroes the velocity.
    this.body.reset(x, y);
    this.pushedUntil = 0;
    this.playIdle();
    this.updateDepth();
  }
}

/** While moving diagonally, keep the current facing if it is still one of the pressed directions. */
function chooseFacing(dx, dy, current) {
  const options = [];
  if (dx < 0) options.push('left');
  if (dx > 0) options.push('right');
  if (dy < 0) options.push('up');
  if (dy > 0) options.push('down');
  return options.includes(current) ? current : options[0];
}
