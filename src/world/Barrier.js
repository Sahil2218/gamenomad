import Phaser from 'phaser';
import { GameState } from '../systems/GameState.js';
import { Dialogue } from '../systems/Dialogue.js';
import { str } from '../systems/strings.js';

// Phase lengths while the barrier is flickering (quest stage 'bridge').
const SOLID_MS = 2400;
const WARNING_MS = 400;
const OPEN_MS = 1200;

const TOAST_COOLDOWN_MS = 3000;
const APPROACH_RESET_PX = 64; // walk this far away and the next touch counts as a new approach
const PUSH_SPEED = 220; // px/s
const PUSH_MS = 120;

// The barrier only flickers in these quest stages; before that it is always solid.
const FLICKER_STAGES = ['bridge', 'crossed'];

const WALL_HEIGHT = 40; // px the energy wall rises above its footprint
const CYAN = 0x3ad4e8;
const WHITE = 0xe8fcff;

/**
 * The AEGIS Warden barrier across the south bridge.
 *
 * States:
 *   'locked'  quest not yet 'bridge': always solid
 *   'solid'   flicker cycle, part 1 (2.4 s)
 *   'warning' flicker cycle, part 2: rapid flicker, still solid (0.4 s)
 *   'open'    flicker cycle, part 3: faint and passable (1.2 s)
 *
 * It never hurts the player; touching it while solid just pushes them back.
 */
export default class Barrier {
  constructor(scene, rect, player) {
    this.scene = scene;
    this.rect = rect;
    this.player = player;

    this.state = 'locked';
    this.stateEndsAt = 0;
    this.hintShown = false;
    this.touchedThisApproach = false;
    this.lastToastAt = -Infinity;

    // An invisible static body over the barrier rectangle. Disabling the body
    // (body.enable = false) lets the player walk straight through.
    this.wall = scene.add.zone(rect.x, rect.y, rect.width, rect.height).setOrigin(0);
    scene.physics.add.existing(this.wall, true); // true = static body
    scene.physics.add.collider(player, this.wall, () => this.onTouch());

    // Graphics is a "drawing" game object: we clear and redraw it every frame to animate it.
    // Depth = bottom edge, so actors standing north of the wall are drawn behind it.
    this.graphics = scene.add.graphics().setDepth(rect.bottom);
  }

  /** Call once per frame from the scene's update(). */
  update(time) {
    this.updateState(time);
    this.updateApproach();
    this.draw(time);
  }

  // ---------- state machine ----------

  updateState(time) {
    const flickering = FLICKER_STAGES.includes(GameState.quest);

    if (!flickering) {
      this.setState('locked', time);
      return;
    }

    if (this.state === 'locked') this.setState('solid', time);

    if (time >= this.stateEndsAt) {
      const next = { solid: 'warning', warning: 'open', open: 'solid' }[this.state];
      this.setState(next, time);
    }

    // Explain the flicker once, when the player is free to read it.
    if (!this.hintShown && !GameState.inputLocked) {
      this.hintShown = true;
      GameState.toast(str('barrier-flicker-hint'), 'info');
    }
  }

  setState(state, time) {
    if (state === this.state) return;
    this.state = state;
    const durations = { solid: SOLID_MS, warning: WARNING_MS, open: OPEN_MS, locked: 0 };
    this.stateEndsAt = time + durations[state];
    this.wall.body.enable = state !== 'open';
  }

  // ---------- touching ----------

  /** Called by the physics collider while the player presses against the solid wall. */
  onTouch() {
    this.pushPlayerAway();
    this.scene.cameras.main.shake(120, 0.004);

    if (this.state === 'locked' && !this.touchedThisApproach && !GameState.inputLocked) {
      this.touchedThisApproach = true;
      this.lastToastAt = this.scene.time.now; // don't toast right after the dialogue
      Dialogue.start('warden-locked');
      return;
    }

    const now = this.scene.time.now;
    if (now - this.lastToastAt >= TOAST_COOLDOWN_MS) {
      this.lastToastAt = now;
      GameState.toast(str('warden-push'), 'warning');
    }
  }

  /** Normally north (back into the village); south if the player is already past the middle. */
  pushPlayerAway() {
    const direction = this.player.y < this.rect.centerY ? -1 : 1;
    this.player.pushBack(0, direction * PUSH_SPEED, PUSH_MS);
  }

  /** Once the player walks away, the next touch counts as a fresh approach. */
  updateApproach() {
    if (!this.touchedThisApproach) return;
    const far = Phaser.Math.Distance.Between(
      this.player.x,
      this.player.y,
      Phaser.Math.Clamp(this.player.x, this.rect.left, this.rect.right),
      Phaser.Math.Clamp(this.player.y, this.rect.top, this.rect.bottom),
    );
    if (far > APPROACH_RESET_PX) this.touchedThisApproach = false;
  }

  // ---------- visuals ----------

  /**
   * The zone is the wall's footprint on the ground. We draw a "curtain" of light
   * rising WALL_HEIGHT px up from its bottom edge, so it reads as a wall in this top-down view.
   */
  draw(time) {
    const g = this.graphics.clear();
    const { x, width, bottom } = this.rect;
    const height = Math.max(this.rect.height, WALL_HEIGHT);
    const top = bottom - height;

    let strength = 1; // overall opacity for this frame
    if (this.state === 'warning') strength = Math.floor(time / 50) % 2 === 0 ? 1 : 0.2; // fast strobe
    if (this.state === 'open') strength = 0.12;
    strength *= 0.85 + Math.sin(time / 300) * 0.15; // slow pulse

    // Soft glow around the wall (drawn first, so it sits behind).
    for (let i = 3; i >= 1; i -= 1) {
      g.fillStyle(CYAN, 0.07 * strength);
      g.fillRect(x - i * 3, top - i * 3, width + i * 6, height + i * 6);
    }

    // The curtain: horizontal bands, fainter at the top, like light fading upwards.
    const bands = 6;
    for (let i = 0; i < bands; i += 1) {
      const bandTop = top + (height * i) / bands;
      g.fillStyle(CYAN, (0.12 + 0.3 * (i / (bands - 1))) * strength);
      g.fillRect(x, bandTop, width, height / bands + 1);
    }

    // Scan-lines: thin bright lines scrolling upwards.
    const spacing = 4;
    const scroll = (time / 40) % spacing;
    g.lineStyle(1, WHITE, 0.35 * strength);
    for (let lineY = bottom - scroll; lineY > top; lineY -= spacing) {
      g.lineBetween(x, lineY, x + width, lineY);
    }

    // A vertical shimmer that sweeps across the wall.
    const sweepX = x + ((time / 8) % width);
    g.fillStyle(WHITE, 0.25 * strength);
    g.fillRect(sweepX, top, 3, height);

    // Bright base where the wall meets the ground, and a faint top edge.
    g.fillStyle(WHITE, 0.9 * strength);
    g.fillRect(x, bottom - 2, width, 2);
    g.lineStyle(1, WHITE, 0.4 * strength);
    g.lineBetween(x, top + 0.5, x + width, top + 0.5);
  }
}
