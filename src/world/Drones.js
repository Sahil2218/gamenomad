import Phaser from 'phaser';
import tuning from '../data/tuning.json';
import { GameState } from '../systems/GameState.js';
import WardenDrone from '../entities/WardenDrone.js';

const T = tuning.drone;

// Aim sight lines at the middle of the player's body rather than the exact feet point.
const PLAYER_BODY_Y = 6;

/**
 * The Outskirts' Warden drones and the shared "detection" meter.
 *
 * While any drone sees the player (inside its cone, with no collider in the way), detection
 * fills from 0 to 1 in ~0.7 s; otherwise it drains. The level is broadcast as
 * GameState 'detection' events for the UI's WARDEN SCAN meter.
 * At 1 the scene's onCaught() runs once and the drones go idle until setEnabled(true).
 *
 * Drones never damage the player: AEGIS can't harm humans, it only "herds" them back.
 */
export default class Drones {
  /** mapDrones: map JSON `drones`; colliders: the map's static group (or plain rects). */
  constructor(scene, player, mapDrones, colliders, { onCaught } = {}) {
    this.scene = scene;
    this.player = player;
    this.onCaught = onCaught || (() => {});
    this.rects = collisionRects(colliders);

    this.enabled = true;
    this.caught = false; // latched after a catch, until setEnabled(true)
    this.level = 0; // detection 0..1
    this.lastEmitted = 0;

    // One Graphics object draws every cone, in its own layer just above the ground.
    this.graphics = scene.add.graphics().setDepth(T.coneDepth);
    this.drones = (mapDrones || []).map((data) => new WardenDrone(scene, data));
  }

  /** Turn detection on or off. Turning it on also clears a previous catch. */
  setEnabled(on) {
    this.enabled = Boolean(on);
    if (this.enabled) this.caught = false;
  }

  /** Call once per frame from the scene's update(time, delta). */
  update(time, delta) {
    if (this.drones.length === 0) return;

    const dt = Math.min((delta ?? this.scene.game.loop.delta) / 1000, 0.1); // delta in ms
    const locked = GameState.inputLocked;
    const watching = this.enabled && !this.caught && !locked;

    // Move first, then look: the cone used for detection is the one that gets drawn.
    let anyoneSees = false;
    this.drones.forEach((drone) => {
      drone.update(time, dt, locked);
      drone.spotting = watching && drone.canSee(this.player.x, this.player.y - PLAYER_BODY_Y, this.rects);
      if (drone.spotting) anyoneSees = true;
    });

    this.updateDetection(dt, anyoneSees);
    this.draw(watching);
  }

  updateDetection(dt, anyoneSees) {
    const change = anyoneSees ? dt / T.detectionFillSec : -dt / T.detectionDrainSec;
    this.level = Phaser.Math.Clamp(this.level + change, 0, 1);

    // Broadcast while above 0, plus one final 0 when it clears.
    if (this.level > 0 || this.lastEmitted > 0) GameState.emit('detection', this.level);
    this.lastEmitted = this.level;

    if (this.level >= 1 && !this.caught) {
      this.caught = true; // go idle: no more detection until setEnabled(true)
      this.onCaught();
    }
  }

  /** Redraws every cone (Graphics is cleared and redrawn each frame to animate it). */
  draw(watching) {
    const g = this.graphics.clear();
    this.drones.forEach((drone) => drone.drawCone(g, this.rects, drone.spotting ? this.level : 0, !watching));
  }
}

/** The colliders as Phaser.Geom.Rectangles: a static group's bodies, or plain { x, y, w, h } rects. */
function collisionRects(colliders) {
  if (!colliders) return [];
  const list = Array.isArray(colliders) ? colliders : colliders.getChildren?.() || [];
  return list.map((item) => {
    if (item instanceof Phaser.Geom.Rectangle) return item;
    if (item.body) return new Phaser.Geom.Rectangle(item.body.x, item.body.y, item.body.width, item.body.height);
    return new Phaser.Geom.Rectangle(item.x, item.y, item.w ?? item.width, item.h ?? item.height);
  });
}
