import Phaser from 'phaser';
import { GameState } from './GameState.js';
import { Dialogue } from './Dialogue.js';

const CAMERA_LERP = 0.12; // the same smooth follow WorldScene uses
const DEFAULT_PAN_MS = 1000;
const DEFAULT_FADE_MS = 600;

/**
 * Helpers for scripted scenes. Every helper that takes time returns a Promise, so a cutscene
 * reads top to bottom like a script:
 *
 *   const cs = new Cutscene(scene);           // input is locked from here…
 *   await cs.moveTo(eli, 620, 300);           // walk there (with walk animations)
 *   await cs.wait(3000);                      // three seconds of nothing
 *   await cs.pan(700, 240, 1200);             // glide the camera over
 *   cs.shake(300, 0.008);                     // no await: carry straight on
 *   cs.flash(200, [255, 255, 255]);
 *   await cs.dialogue('eli-dying');           // until the conversation closes
 *   await cs.fade('out', 800, [255, 255, 255]);
 *   cs.follow(player);
 *   cs.end();                                 // …until here
 *
 * `await` pauses only this function, never the game: Phaser keeps drawing and animating.
 * If the scene shuts down mid-script, the pending steps simply never finish (the script stops).
 */
export default class Cutscene {
  constructor(scene) {
    this.scene = scene;
    this.camera = scene.cameras.main;
    this.running = true;

    GameState.inputLocked = true;
    // Dialogue unlocks input 150 ms after each conversation ends. To keep the whole sequence locked,
    // we lock again at the start of every frame. PRE_UPDATE fires before the scene's own update().
    scene.events.on(Phaser.Scenes.Events.PRE_UPDATE, this.keepLocked, this);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, this.release, this);
  }

  /** Runs `script(cs)` (an async function) and always calls end() afterwards. */
  async run(script) {
    try {
      await script(this);
    } finally {
      this.end();
    }
  }

  // ---------- timing ----------

  /** Resolves after `ms` milliseconds of game time. */
  wait(ms) {
    return new Promise((resolve) => this.scene.time.delayedCall(ms, resolve));
  }

  /** A tween you can await, e.g. cs.tween({ targets: eli, alpha: 0, duration: 800 }). */
  tween(config) {
    return new Promise((resolve) => {
      this.scene.tweens.add({
        ...config,
        onComplete: (...args) => {
          if (config.onComplete) config.onComplete(...args);
          resolve();
        },
      });
    });
  }

  // ---------- actors ----------

  /**
   * Walks `actor` to (x, y) at `speed` px/s with its walk animation, facing the way it moves,
   * then stands idle. This is a tween, not physics: the body is switched off during the walk so
   * walls and other bodies can't push it around (the script is in charge), then back on at the end.
   * Party followers must be detached first (party.detach), or the party keeps steering them.
   */
  moveTo(actor, x, y, speed = 60) {
    return new Promise((resolve) => {
      const dx = x - actor.x;
      const dy = y - actor.y;
      const distance = Math.hypot(dx, dy);
      const facing = facingFor(dx, dy, actor.facing);

      if (distance < 0.5) {
        if (actor.playIdle) actor.playIdle(facing);
        resolve();
        return;
      }

      // `scripted` tells the Player / NPC update() to leave this actor alone while we move it.
      const hasScripted = 'scripted' in actor;
      const wasScripted = actor.scripted;
      if (hasScripted) actor.scripted = true;

      const body = actor.body;
      const bodyWasOn = Boolean(body && body.enable);
      if (body) {
        body.setVelocity(0, 0);
        body.enable = false; // a disabled body is ignored by the physics engine
      }

      if (actor.playWalk) actor.playWalk(facing);
      this.scene.tweens.add({
        targets: actor,
        x,
        y,
        duration: (distance / Math.max(speed, 1)) * 1000,
        ease: 'Linear',
        onUpdate: () => updateDepth(actor),
        onComplete: () => {
          if (bodyWasOn) {
            body.enable = true;
            body.reset(x, y); // puts the body exactly under the sprite again, with no velocity
          }
          if (hasScripted) actor.scripted = wasScripted;
          if (actor.playIdle) actor.playIdle(facing);
          updateDepth(actor);
          resolve();
        },
      });
    });
  }

  // ---------- dialogue ----------

  /**
   * Plays dialogue `id` and resolves (true) when it closes, or straight away (false) if it can't start.
   * If another dialogue is still open, it waits for that one to finish first.
   */
  async dialogue(id) {
    if (Dialogue.isActive()) await nextDialogueEnd();

    const started = await new Promise((resolve) => {
      const onEnd = () => resolve(true);
      // Listen before starting: a dialogue with no lines ends inside Dialogue.start().
      GameState.once('dialogue:end', onEnd);
      if (!Dialogue.start(id)) {
        GameState.off('dialogue:end', onEnd);
        resolve(false);
      }
    });

    if (this.running) GameState.inputLocked = true; // Dialogue is about to unlock; we're not done
    return started;
  }

  // ---------- camera ----------

  /** Glides the camera to centre on (x, y) over `ms`. Stops following whoever it was following. */
  pan(x, y, ms = DEFAULT_PAN_MS) {
    return new Promise((resolve) => {
      this.camera.stopFollow();
      if (ms <= 0) {
        this.camera.centerOn(x, y);
        resolve();
        return;
      }
      // pan(x, y, duration, ease, force, callback): the callback runs every frame with progress 0..1.
      this.camera.pan(x, y, ms, 'Sine.easeInOut', true, (camera, progress) => {
        if (progress >= 1) resolve();
      });
    });
  }

  /**
   * The camera follows `target` again. startFollow() would jump straight to it, so we put the
   * scroll back where it was and let the follow lerp glide the camera over.
   */
  follow(target) {
    const { scrollX, scrollY } = this.camera;
    this.camera.startFollow(target, true, CAMERA_LERP, CAMERA_LERP);
    this.camera.setScroll(scrollX, scrollY);
  }

  /** Fades the whole view 'out' to a colour, or 'in' from it. Colour is [r, g, b], 0–255. */
  fade(direction = 'out', ms = DEFAULT_FADE_MS, [r, g, b] = [0, 0, 0]) {
    return new Promise((resolve) => {
      const onProgress = (camera, progress) => {
        if (progress >= 1) resolve();
      };
      if (direction === 'in') this.camera.fadeIn(ms, r, g, b, onProgress);
      else this.camera.fadeOut(ms, r, g, b, onProgress);
    });
  }

  /** Shakes the camera. intensity is a fraction of the view size (0.005 is a gentle rumble). */
  shake(ms = 250, intensity = 0.006) {
    this.camera.shake(ms, intensity, true); // true = restart even if a shake is running
    return this.wait(ms); // awaiting it is optional
  }

  /** A full-view flash of colour [r, g, b] that fades over `ms`. */
  flash(ms = 250, [r, g, b] = [255, 255, 255]) {
    this.camera.flash(ms, r, g, b, true);
    return this.wait(ms);
  }

  // ---------- finishing ----------

  /** Ends the cutscene and gives control back to the player (unless a dialogue is still open). */
  end() {
    if (!this.running) return;
    this.release();
    if (!Dialogue.isActive()) GameState.inputLocked = false;
  }

  keepLocked() {
    if (this.running) GameState.inputLocked = true;
  }

  /** Stops re-locking every frame. Called by end(), and on scene shutdown. */
  release() {
    this.running = false;
    this.scene.events.off(Phaser.Scenes.Events.PRE_UPDATE, this.keepLocked, this);
    this.scene.events.off(Phaser.Scenes.Events.SHUTDOWN, this.release, this);
  }
}

/** Resolves the next time any dialogue closes. */
function nextDialogueEnd() {
  return new Promise((resolve) => GameState.once('dialogue:end', resolve));
}

/** The facing for a move of (dx, dy): the bigger axis wins. No move keeps the current facing. */
function facingFor(dx, dy, current = 'down') {
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return current;
  if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 'left' : 'right';
  return dy < 0 ? 'up' : 'down';
}

/** Depth = feet y, like every actor (Character has updateDepth; anything else gets setDepth). */
function updateDepth(actor) {
  if (actor.updateDepth) actor.updateDepth();
  else if (actor.setDepth) actor.setDepth(actor.y);
}
