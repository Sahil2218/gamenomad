import Phaser from 'phaser';
import tuning from '../data/tuning.json';

const T = tuning.hazards;
export const HAZARD_TYPES = ['toxic', 'corrupt', 'fire'];

/**
 * The map's hazard rectangles (contract M2 §1): toxic pools, corrupted ground and fires.
 *
 *   hazards.typesAt(x, y)   → Set of the hazard types under a point (Survival uses the player's feet)
 *   hazards.update()        → keeps the ambient particles running only where the camera can see
 *
 * The map picture already shows the pools and flames, so the particles are only a subtle "alive" touch.
 */
export default class Hazards {
  /** hazardsArray: [{ type: 'toxic'|'corrupt'|'fire', x, y, w, h }] from the map JSON (may be missing). */
  constructor(scene, hazardsArray = []) {
    this.scene = scene;

    // Phaser.Geom.Rectangle gives us contains() and friends for free.
    this.areas = (hazardsArray || [])
      .filter((h) => HAZARD_TYPES.includes(h.type))
      .map((h) => ({ type: h.type, rect: new Phaser.Geom.Rectangle(h.x, h.y, h.w, h.h) }));

    // A few cheap emitters per area; each is paused while its area is off-screen.
    this.emitters = [];
    this.areas.forEach((area) => this.createEmitters(area));
  }

  /** Which hazard types cover (x, y). Overlapping areas can give more than one. */
  typesAt(x, y) {
    const types = new Set();
    this.areas.forEach(({ type, rect }) => {
      if (rect.contains(x, y)) types.add(type);
    });
    return types;
  }

  /** The hazard areas under (x, y), as [{ type, rect }] (Survival uses the fire rect to push you out). */
  areasAt(x, y) {
    return this.areas.filter(({ rect }) => rect.contains(x, y));
  }

  /** Call once per frame. Only emits particles where the camera is looking. */
  update() {
    if (this.emitters.length === 0) return;

    // worldView is the rectangle of the world the camera currently shows.
    const view = this.scene.cameras.main.worldView;
    const pad = T.cullPadding;
    const padded = new Phaser.Geom.Rectangle(view.x - pad, view.y - pad, view.width + pad * 2, view.height + pad * 2);

    this.emitters.forEach(({ emitter, rect }) => {
      emitter.emitting = Phaser.Geom.Intersects.RectangleToRectangle(rect, padded);
    });
  }

  // ---------- particles ----------

  /**
   * Phaser 3.60+ particles: scene.add.particles(x, y, textureKey, config) returns an emitter.
   * An "emit zone" with a rectangle source makes each particle start at a random point inside it.
   */
  createEmitters(area) {
    const { type, rect } = area;
    const zone = { type: 'random', source: rect };

    if (type === 'toxic') {
      this.addEmitter(rect, 'fx-bubble', {
        emitZone: zone,
        frequency: frequencyFor(rect, T.toxic),
        lifespan: { min: 900, max: 1700 },
        speedY: { min: -14, max: -5 }, // negative y = upwards
        speedX: { min: -3, max: 3 },
        scale: { start: 0.45, end: 1 }, // bubbles swell as they rise...
        alpha: { start: 0.75, end: 0 }, // ...and fade out (pop)
      });
    }

    if (type === 'corrupt') {
      // Nanites: tiny magenta specks that jitter and blink out quickly.
      this.addEmitter(rect, 'fx-nanite', {
        emitZone: zone,
        frequency: frequencyFor(rect, T.corrupt),
        quantity: 2,
        lifespan: { min: 220, max: 520 },
        speed: { min: 8, max: 30 },
        alpha: { start: 1, end: 0 },
      });
      // Sparks: an occasional bright crackle, added on top (ADD blend = glowing).
      this.addEmitter(rect, 'fx-spark', {
        emitZone: zone,
        frequency: T.corrupt.sparkEveryMs,
        lifespan: { min: 90, max: 180 },
        speed: { min: 0, max: 12 },
        scale: { start: 1, end: 0.3 },
        alpha: { start: 1, end: 0 },
        blendMode: Phaser.BlendModes.ADD,
      });
    }

    if (type === 'fire') {
      this.addEmitter(rect, 'fx-ember', {
        emitZone: zone,
        frequency: frequencyFor(rect, T.fire),
        lifespan: { min: 600, max: 1300 },
        speedY: { min: -40, max: -16 },
        speedX: { min: -8, max: 8 },
        accelerationX: { min: -12, max: 12 }, // a little sideways drift
        alpha: { start: 1, end: 0 },
        tint: [0xffd27a, 0xf0a030, 0xff6a2a],
        blendMode: Phaser.BlendModes.ADD,
      });
    }
  }

  addEmitter(rect, textureKey, config) {
    // Missing art (task I not done yet) just means no particles, never a crash.
    if (!this.scene.textures.exists(textureKey)) return;

    const emitter = this.scene.add.particles(0, 0, textureKey, config);
    emitter.setDepth(T.depth); // just above the map background (-1), under every actor
    emitter.emitting = false; // update() switches it on when the area is on screen
    this.emitters.push({ emitter, rect });
  }
}

/** Bigger areas emit more often: one particle per `areaPerParticle` px² each second, within limits. */
function frequencyFor(rect, { areaPerParticle, minPerSec, maxPerSec }) {
  const perSecond = Phaser.Math.Clamp((rect.width * rect.height) / areaPerParticle, minPerSec, maxPerSec);
  return Math.round(1000 / perSecond); // ms between particles
}
