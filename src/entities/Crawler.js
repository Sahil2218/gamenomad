import Phaser from 'phaser';
import tuning from '../data/tuning.json';

const T = tuning.crawler;
const TEXTURE = 'crawler'; // 32×24 frames: 0–3 scuttle, 4–5 hurt (task I)
const FALLBACK_TEXTURE = 'crawler-fallback';
const NANITE_TINTS = [0xff3df0, 0xd23cff, 0xffffff];

// The art is drawn top-down, facing DOWN (+y). Phaser angles: 0 = right, 90° = down,
// so turning the sprite to face a heading means rotation = heading − 90°.
const ART_FACING = Math.PI / 2;
const TURN_STEP = Math.PI / 4; // snap to 8 directions so the pixel art doesn't shimmer
const TURN_SLACK = Phaser.Math.DegToRad(8); // a little hysteresis, so it doesn't flick between two steps

/**
 * A nanite crawler: a small machine-bug that roams near its home spot and chases the player.
 *
 * States:
 *   'wander'  stroll to random points within `radius` of home, pausing in between
 *   'chase'   run at the player once they come within `aggro` px
 *   'return'  the player got away (or we strayed too far): walk back home
 * A "hunter" (spawned by Waves) skips 'return': within `aggro` it chases until one of you dies.
 * While "stunned" (just hit, or just bit the player) the AI waits and the knockback slides it.
 *
 * Crawlers (world/Crawlers.js) owns the group, the colliders and the contact damage.
 */
export default class Crawler extends Phaser.Physics.Arcade.Sprite {
  constructor(scene, x, y, { tag = null, radius = T.groupRadius, aggro = T.aggroRadius, home = null, hunter = false } = {}) {
    super(scene, x, y, textureFor(scene), firstFrame(scene));

    scene.add.existing(this); // draw it
    scene.physics.add.existing(this); // give it a physics body (this.body)

    // Origin in the middle: the bug lies flat on the ground and turns around its centre.
    // (x, y) is that centre, and also its depth (it has no "feet" like the characters).
    this.setOrigin(0.5, 0.5);
    // Arcade bodies never rotate, so use a near-square body centred in the frame:
    // it fits the bug whichever way it faces. true = centre the body on the frame.
    this.body.setSize(16, 14, true);

    this.tag = tag;
    this.hp = T.hp;
    this.dead = false;
    this.home = new Phaser.Math.Vector2(home ? home.x : x, home ? home.y : y);
    this.radius = radius;
    this.aggro = aggro;
    // Hunters (wave crawlers) never give up the chase; Waves steers them around walls via `waypoint`.
    this.hunter = hunter;
    this.waypoint = null; // { x, y } to run at instead of straight at the player, or null

    this.state = 'wander';
    this.target = null; // wander destination, or null while pausing
    this.nextMoveAt = scene.time.now + Phaser.Math.Between(T.pauseMinMs, T.pauseMaxMs);
    this.giveUpAt = 0;
    this.stunnedUntil = 0;
    this.frozen = false;
    this.heading = ART_FACING; // the direction it faces (radians); starts as drawn, facing down

    this.setDepth(this.y);
  }

  /** Called by Crawlers every frame. dt is in seconds. */
  update(time, dt, player, locked) {
    if (this.dead) return;
    this.setDepth(this.y); // depth = y, like every actor

    // Everyone holds still during dialogue and cutscenes.
    if (locked) {
      this.freeze();
      return;
    }
    if (this.frozen) this.unfreeze();

    if (time < this.stunnedUntil) {
      // Let the knockback slide out, slowing down quickly (manual friction).
      this.body.velocity.scale(Math.pow(0.02, dt));
      return;
    }

    this.think(time, player);
  }

  // ---------- AI ----------

  think(time, player) {
    const toPlayer = Phaser.Math.Distance.BetweenPoints(this, player);
    if (this.hunter) {
      this.hunt(time, player, toPlayer);
      return;
    }
    const fromHome = Phaser.Math.Distance.BetweenPoints(this, this.home);

    if (this.state === 'wander') {
      if (toPlayer <= this.aggro) this.state = 'chase';
      else this.wander(time);
    }

    if (this.state === 'chase') {
      if (toPlayer > T.loseInterestRadius || fromHome > T.leashRadius) this.state = 'return';
      else this.moveTowards(player.x, player.y, T.chaseSpeed);
    }

    if (this.state === 'return') {
      if (toPlayer <= this.aggro && fromHome < T.leashRadius * 0.75) {
        this.state = 'chase';
      } else if (fromHome <= this.radius * 0.5) {
        this.state = 'wander';
        this.pause(time);
      } else {
        this.moveTowards(this.home.x, this.home.y, T.returnSpeed);
      }
    }
  }

  /** Hunters: chase within aggro (no leash, no losing interest), otherwise roam near home. */
  hunt(time, player, toPlayer) {
    if (toPlayer > this.aggro) {
      if (this.state === 'chase') this.pause(time);
      this.state = 'wander';
      this.wander(time);
      return;
    }
    this.state = 'chase';
    this.target = null;
    const goal = this.waypoint || player;
    this.moveTowards(goal.x, goal.y, T.chaseSpeed);
  }

  wander(time) {
    if (!this.target) {
      if (time >= this.nextMoveAt) this.pickTarget(time);
      return;
    }

    const arrived = Phaser.Math.Distance.BetweenPoints(this, this.target) < 3;
    const blocked = !this.body.blocked.none; // pressed against a wall
    if (arrived || blocked || time > this.giveUpAt) {
      this.pause(time);
      return;
    }
    this.moveTowards(this.target.x, this.target.y, T.wanderSpeed);
  }

  /** A random point within `radius` of home. */
  pickTarget(time) {
    const angle = Math.random() * Math.PI * 2;
    const distance = Math.sqrt(Math.random()) * this.radius; // sqrt = spread evenly over the circle
    this.target = new Phaser.Math.Vector2(
      this.home.x + Math.cos(angle) * distance,
      this.home.y + Math.sin(angle) * distance,
    );
    this.giveUpAt = time + T.maxWalkMs;
  }

  pause(time) {
    this.target = null;
    this.setVelocity(0, 0);
    this.playMove(false);
    this.nextMoveAt = time + Phaser.Math.Between(T.pauseMinMs, T.pauseMaxMs);
  }

  moveTowards(x, y, speed) {
    const direction = new Phaser.Math.Vector2(x - this.x, y - this.y);
    if (direction.lengthSq() < 1) {
      this.setVelocity(0, 0);
      this.playMove(false);
      return;
    }
    direction.normalize().scale(speed);
    this.setVelocity(direction.x, direction.y);
    this.playMove(true);
  }

  /** Scuttle animation while moving (turned to face where it is going), frame 0 while still. */
  playMove(moving) {
    if (moving) {
      this.faceVelocity();
      if (this.scene.anims.exists('crawler-walk')) this.anims.play('crawler-walk', true);
    } else {
      this.anims.stop();
      if (this.texture.has(0)) this.setFrame(0);
    }
  }

  /**
   * Turns towards the current velocity, in 45° steps. It only switches step once the travel
   * direction is clearly past the halfway point, so a chase along a diagonal doesn't jitter.
   */
  faceVelocity() {
    const { x, y } = this.body.velocity;
    if (Math.abs(x) < 1 && Math.abs(y) < 1) return;

    const travel = Math.atan2(y, x);
    const off = Math.abs(Phaser.Math.Angle.Wrap(travel - this.heading));
    if (off < TURN_STEP / 2 + TURN_SLACK) return; // still close enough to the current step

    this.heading = Math.round(travel / TURN_STEP) * TURN_STEP;
    this.setRotation(this.heading - ART_FACING);
  }

  // ---------- being hit / hitting ----------

  /** The area a strike must touch: a 24×24 square around the bug, whichever way it is turned. */
  hurtbox() {
    return new Phaser.Geom.Rectangle(this.x - 12, this.y - 12, 24, 24);
  }

  isStunned(time) {
    return time < this.stunnedUntil;
  }

  /** Takes `damage` from a hit that came from (fromX, fromY). Returns true if this killed it. */
  takeHit(damage, fromX, fromY) {
    if (this.dead) return false;
    this.hp -= damage;
    this.flash();

    if (this.hp <= 0) {
      this.die();
      return true;
    }

    this.shove(fromX, fromY, T.knockbackSpeed, T.hurtStunMs);
    if (this.scene.anims.exists('crawler-hurt')) this.anims.play('crawler-hurt', true);
    this.state = 'chase'; // hitting it makes it angry
    this.target = null;
    return false;
  }

  /** After biting the player, back off for a moment so it doesn't sit on top of them. */
  recoil(fromX, fromY) {
    this.shove(fromX, fromY, T.contactRecoilSpeed, T.contactRecoilMs);
    this.playMove(false);
  }

  /** Pushes away from (fromX, fromY) and pauses the AI for `ms`. */
  shove(fromX, fromY, speed, ms) {
    const away = new Phaser.Math.Vector2(this.x - fromX, this.y - fromY);
    if (away.lengthSq() === 0) away.set(Math.random() - 0.5, Math.random() - 0.5);
    away.normalize().scale(speed);
    this.setVelocity(away.x, away.y);
    this.stunnedUntil = this.scene.time.now + ms;
  }

  /** A brief solid-white flash (setTintFill paints every visible pixel one colour). */
  flash() {
    this.setTintFill(0xffffff);
    this.scene.time.delayedCall(T.hurtFlashMs, () => {
      if (this.active) this.clearTint();
    });
  }

  /** Bursts into magenta nanites and disappears. */
  die() {
    this.dead = true;
    burstNanites(this.scene, this.x, this.y, this.y + 1);
    this.destroy();
  }

  // ---------- pause during dialogue ----------

  freeze() {
    if (this.frozen) return;
    this.frozen = true;
    this.setVelocity(0, 0);
    this.anims.pause();
  }

  unfreeze() {
    this.frozen = false;
    this.anims.resume();
  }
}

/**
 * A one-shot particle burst. explode(count) fires `count` particles at once instead of a steady flow;
 * the emitter is destroyed once they have all faded.
 */
function burstNanites(scene, x, y, depth) {
  const key = scene.textures.exists('fx-nanite') ? 'fx-nanite' : '__WHITE'; // __WHITE is built into Phaser
  const emitter = scene.add.particles(x, y, key, {
    emitting: false,
    speed: { min: 30, max: 120 },
    lifespan: { min: 300, max: 700 },
    scale: { start: key === '__WHITE' ? 0.6 : 1.5, end: 0 },
    alpha: { start: 1, end: 0.2 },
    tint: NANITE_TINTS,
  });
  emitter.setDepth(depth);
  emitter.explode(T.deathParticles);
  scene.time.delayedCall(900, () => emitter.destroy());

  // A quick magenta pop of light, if the soft glow texture exists.
  if (scene.textures.exists('fx-glow')) {
    const glow = scene.add.image(x, y, 'fx-glow').setTint(0xff3df0).setBlendMode(Phaser.BlendModes.ADD);
    glow.setDepth(depth).setScale(0.3).setAlpha(0.9);
    scene.tweens.add({ targets: glow, scale: 1.1, alpha: 0, duration: 220, onComplete: () => glow.destroy() });
  }
}

/** Frame 0 only exists on the real spritesheet; the stand-in texture has a single unnamed frame. */
function firstFrame(scene) {
  return scene.textures.exists(TEXTURE) ? 0 : undefined;
}

/** Uses the real art if it loaded; otherwise draws a simple stand-in once so the game still works. */
function textureFor(scene) {
  if (scene.textures.exists(TEXTURE)) return TEXTURE;
  if (!scene.textures.exists(FALLBACK_TEXTURE)) {
    // Drawn like the real art: top-down, facing down (the magenta eyes are at the bottom).
    const g = scene.make.graphics({ x: 0, y: 0 }, false); // false = not added to the scene
    g.fillStyle(0x2a2233, 1).fillEllipse(16, 12, 16, 18);
    g.fillStyle(0xff3df0, 1).fillRect(12, 17, 2, 2).fillRect(18, 17, 2, 2);
    g.lineStyle(1, 0x5a4a66, 1).lineBetween(8, 8, 2, 4).lineBetween(24, 8, 30, 4).lineBetween(8, 15, 2, 19).lineBetween(24, 15, 30, 19);
    g.generateTexture(FALLBACK_TEXTURE, 32, 24);
    g.destroy();
  }
  return FALLBACK_TEXTURE;
}
