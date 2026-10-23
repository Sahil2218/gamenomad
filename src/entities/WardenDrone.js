import Phaser from 'phaser';
import tuning from '../data/tuning.json';

const T = tuning.drone;
const TEXTURE = 'drone'; // 32×32 frames, 4 of them (task I); animation 'drone-hover'
const FALLBACK_TEXTURE = 'drone-fallback';
const CYAN = 0x3ad4e8;
const WHITE = 0xe8fcff;
const ALERT_DEPTH = 99999; // like the E prompt: above every actor

const HALF_CONE = Phaser.Math.DegToRad(T.coneAngleDeg) / 2;
const SWEEP = Phaser.Math.DegToRad(T.sweepDeg);
const TURN_SPEED = Phaser.Math.DegToRad(T.turnDegPerSec); // radians per second

/**
 * An AEGIS Warden drone. It floats along its waypoint path and watches a cone of ground ahead.
 * The sprite always faces the camera; the cone shows which way it is looking.
 * It never attacks: Drones (world/Drones.js) turns "seen for long enough" into a catch.
 *
 * Positions: `ground` is the point on the ground under the drone (where the cone starts);
 * the sprite itself hovers `hoverHeight` px above it, with a shadow on the ground.
 *
 * data (from the map): { id, speed, loop, path: [{ x, y }, ...] }
 *   loop: true  → after the last waypoint, fly back to the first
 *   loop: false → ping-pong: retrace the path backwards
 */
export default class WardenDrone extends Phaser.GameObjects.Sprite {
  constructor(scene, data) {
    const path = (data.path || []).map((p) => new Phaser.Math.Vector2(p.x, p.y));
    const start = path[0] || new Phaser.Math.Vector2(data.x || 0, data.y || 0);
    super(scene, start.x, start.y - T.hoverHeight, textureFor(scene));
    scene.add.existing(this);

    this.droneId = data.id;
    this.path = path;
    this.speed = data.speed || T.defaultSpeed;
    this.loop = data.loop !== false;
    this.ground = start.clone();
    this.targetIndex = path.length > 1 ? 1 : 0;
    this.step = 1; // +1 forwards along the path, -1 backwards (ping-pong)
    this.pausedUntil = 0;
    this.bobOffset = Math.random() * 1000; // so drones don't bob in sync

    // Face the first leg of the path (or south if the drone has no path).
    this.travelAngle = path.length > 1 ? Phaser.Math.Angle.BetweenPoints(path[0], path[1]) : Math.PI / 2;
    this.heading = this.travelAngle;
    this.coneAngle = this.heading;

    this.spotting = false; // true while this drone can see the player
    this.alert = 0; // 0..1, eases towards 1 while spotting (drives the eye flare)

    if (scene.anims.exists('drone-hover')) this.play('drone-hover');
    this.createExtras(scene);
    this.syncVisuals(0);
  }

  createExtras(scene) {
    // A soft shadow on the ground sells the "hovering" look.
    this.shadow = scene.add.ellipse(this.ground.x, this.ground.y, 16, 6, 0x000000, 0.28).setDepth(T.coneDepth + 0.05);

    // Eye flare: an additive glow over the drone, brighter while it is detecting.
    this.glow = scene.textures.exists('fx-glow')
      ? scene.add.image(this.x, this.y, 'fx-glow').setBlendMode(Phaser.BlendModes.ADD).setTint(CYAN).setAlpha(0)
      : null;

    // "!" over the drone while it can see you.
    this.mark = scene.add
      .text(this.x, this.y, '!', {
        fontFamily: 'Silkscreen',
        fontSize: '12px',
        color: '#ff3b3b',
        stroke: '#12141c',
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1)
      .setDepth(ALERT_DEPTH)
      .setVisible(false);

    // Destroy the helpers with the drone.
    this.once(Phaser.GameObjects.Events.DESTROY, () => {
      this.shadow.destroy();
      this.mark.destroy();
      if (this.glow) this.glow.destroy();
    });
  }

  // ---------- movement ----------

  /** Called by Drones every frame. dt is in seconds; while `frozen` the drone just hovers in place. */
  update(time, dt, frozen) {
    if (!frozen) this.patrol(time, dt);
    this.turn(dt);

    // The cone sweeps gently from side to side around the heading (wider for a drone with no path).
    const sweep = this.path.length > 1 ? SWEEP : SWEEP * 3;
    this.coneAngle = this.heading + Math.sin(((time + this.bobOffset) / T.sweepPeriodMs) * Math.PI * 2) * sweep;

    this.alert = Phaser.Math.Clamp(this.alert + (this.spotting ? dt * 4 : -dt * 2), 0, 1);
    this.syncVisuals(time);
  }

  patrol(time, dt) {
    if (this.path.length < 2 || time < this.pausedUntil) return;

    const target = this.path[this.targetIndex];
    const distance = Phaser.Math.Distance.BetweenPoints(this.ground, target);
    const move = this.speed * dt;

    if (distance <= move) {
      this.ground.copy(target);
      this.pickNextWaypoint();
      this.pausedUntil = time + T.waypointPauseMs; // hover a moment, turning to the next leg
      return;
    }

    this.travelAngle = Phaser.Math.Angle.BetweenPoints(this.ground, target);
    this.ground.x += Math.cos(this.travelAngle) * move;
    this.ground.y += Math.sin(this.travelAngle) * move;
  }

  pickNextWaypoint() {
    const last = this.path.length - 1;
    if (this.loop) {
      this.targetIndex = (this.targetIndex + 1) % this.path.length;
    } else {
      if (this.targetIndex + this.step > last || this.targetIndex + this.step < 0) this.step = -this.step;
      this.targetIndex += this.step;
    }
    this.travelAngle = Phaser.Math.Angle.BetweenPoints(this.ground, this.path[this.targetIndex]);
  }

  /** Rotate the heading towards the travel direction at a limited speed (no snapping at corners). */
  turn(dt) {
    const turned = Phaser.Math.Angle.RotateTo(this.heading, this.travelAngle, TURN_SPEED * dt);
    this.heading = Phaser.Math.Angle.Wrap(turned); // keep it within -π..π
  }

  /** Place the sprite, shadow, glow and "!" around the ground point. */
  syncVisuals(time) {
    const bob = Math.sin((time + this.bobOffset) / 260) * T.bobPx;
    this.setPosition(this.ground.x, this.ground.y - T.hoverHeight + bob);
    // The art is front-facing (its eye looks at the camera) and symmetric, so the sprite never
    // turns or flips; only the vision cone points along the heading.
    this.setDepth(this.ground.y); // depth-sorted by the ground point, like actors' feet

    this.shadow.setPosition(this.ground.x, this.ground.y);

    if (this.glow) {
      this.glow.setPosition(this.x, this.y).setDepth(this.depth + 0.1);
      this.glow.setAlpha(0.12 + this.alert * 0.6).setScale(0.45 + this.alert * 0.35);
      this.glow.setTint(this.alert > 0.5 ? WHITE : CYAN);
    }

    this.mark.setVisible(this.spotting);
    this.mark.setPosition(this.x, this.y - 14 + Math.sin(time / 90) * 1.5);
  }

  // ---------- vision ----------

  /**
   * True if (x, y) is inside the cone and no collider blocks the straight line to it.
   * rects: Phaser.Geom.Rectangles of the map colliders.
   */
  canSee(x, y, rects) {
    const { x: ox, y: oy } = this.ground;
    if (Phaser.Math.Distance.Between(ox, oy, x, y) > T.coneRange) return false;

    const angleToTarget = Phaser.Math.Angle.Between(ox, oy, x, y);
    const off = Math.abs(Phaser.Math.Angle.Wrap(angleToTarget - this.coneAngle));
    if (off > HALF_CONE) return false;

    const sightLine = new Phaser.Geom.Line(ox, oy, x, y);
    return !this.blockers(rects).some((rect) => Phaser.Geom.Intersects.LineToRectangle(sightLine, rect));
  }

  /**
   * Colliders near enough to matter. A wall the drone is hovering over doesn't block its own view
   * (drones fly), so rects containing the ground point are skipped.
   */
  blockers(rects) {
    const { x, y } = this.ground;
    const reach = new Phaser.Geom.Rectangle(x - T.coneRange, y - T.coneRange, T.coneRange * 2, T.coneRange * 2);
    return rects.filter((r) => !r.contains(x, y) && Phaser.Geom.Intersects.RectangleToRectangle(r, reach));
  }

  /**
   * The cone as a polygon, clipped by walls: a fan of rays, each stopping at the first collider it hits.
   * Returns the points along the outer edge (the ground point is the fan's centre).
   */
  conePoints(rects) {
    const { x: ox, y: oy } = this.ground;
    const near = this.blockers(rects);
    const points = [];
    const hits = [];

    for (let i = 0; i <= T.coneRays; i += 1) {
      const angle = this.coneAngle - HALF_CONE + (i / T.coneRays) * HALF_CONE * 2;
      const ray = new Phaser.Geom.Line(ox, oy, ox + Math.cos(angle) * T.coneRange, oy + Math.sin(angle) * T.coneRange);

      let length = T.coneRange;
      near.forEach((rect) => {
        hits.length = 0;
        Phaser.Geom.Intersects.GetLineToRectangle(ray, rect, hits);
        hits.forEach((p) => {
          length = Math.min(length, Phaser.Math.Distance.Between(ox, oy, p.x, p.y));
        });
      });
      points.push({ x: ox + Math.cos(angle) * length, y: oy + Math.sin(angle) * length });
    }
    return points;
  }

  /**
   * Draws the cone into the shared Graphics layer: three stacked fans (full, ¾ and ½ length),
   * so it is densest near the drone and fades softly towards the far edge.
   * strength: 0..1 extra brightness while detecting; dim: true while drones are disabled.
   */
  drawCone(graphics, rects, strength, dim) {
    const edge = this.conePoints(rects);
    const { x: ox, y: oy } = this.ground;
    const base = dim ? T.coneAlpha * 0.35 : Phaser.Math.Linear(T.coneAlpha, T.coneAlertAlpha, strength);
    const color = strength > 0.5 ? WHITE : CYAN;

    [1, 0.72, 0.45].forEach((scale) => {
      const fan = [{ x: ox, y: oy }];
      edge.forEach((p) => fan.push({ x: ox + (p.x - ox) * scale, y: oy + (p.y - oy) * scale }));
      graphics.fillStyle(CYAN, base * 0.55);
      graphics.fillPoints(fan, true);
    });

    // A faint bright rim along the far edge.
    graphics.lineStyle(1, color, base * 1.6);
    graphics.strokePoints(edge, false);
  }
}

/** Uses the real art if it loaded; otherwise draws a simple stand-in once. */
function textureFor(scene) {
  if (scene.textures.exists(TEXTURE)) return TEXTURE;
  if (!scene.textures.exists(FALLBACK_TEXTURE)) {
    const g = scene.make.graphics({ x: 0, y: 0 }, false); // false = not added to the scene
    g.fillStyle(0x2b3240, 1).fillCircle(16, 16, 10);
    g.lineStyle(2, 0x9aa4b4, 1).strokeCircle(16, 16, 10);
    g.fillStyle(CYAN, 1).fillCircle(16, 16, 4);
    g.generateTexture(FALLBACK_TEXTURE, 32, 32);
    g.destroy();
  }
  return FALLBACK_TEXTURE;
}
