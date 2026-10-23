import Phaser from 'phaser';
import hollowMap from '../data/maps/hollow.json';
import { GameState } from '../systems/GameState.js';
import { Dialogue } from '../systems/Dialogue.js';
import { str } from '../systems/strings.js';
import WorldScene from './WorldScene.js';

const ARRIVAL_FADE_MS = 1600; // out of the white cloud

// hollow.png already has a heavy night grade baked in, so this extra shade is light: it only dims
// the ground a touch (actors, pickups and the guide trail stay bright) and the ash does the rest.
const GROUND_SHADE = { color: 0x000000, alpha: 0.12, depth: -0.95 }; // just above the map (-1)

// Ash drifts down over the whole view. The spawn area follows the camera; each flake stays where it fell.
const ASH_DEPTH = 50000; // above the actors, below the E prompt (100000)
const ASH_AREA = { w: 760, h: 460 }; // a bit larger than the 640×360 world px the camera shows
const ASH_LIFESPAN_MS = 7000;

/**
 * Act IV, inside the cloud: the Hollow, a dead ash-black city under a black sky.
 * Search it and find the way down: Eli's keycard 01 opens the hatch to Silo 01.
 */
export default class HollowScene extends WorldScene {
  constructor() {
    super('Hollow');
  }

  get mapData() {
    return hollowMap;
  }

  get actId() {
    return 'IV';
  }

  /** We arrive out of the white, so the screen fades in from white. */
  get arrivalFade() {
    return { ms: ARRIVAL_FADE_MS, color: [255, 255, 255] };
  }

  onWorldCreate() {
    GameState.setShowToxicity(true);
    GameState.setQuest('hollow');

    this.createDarkGrade();
    this.createAsh();

    this.playIntro({
      flag: 'hollow_intro_done',
      title: 'hollow-title',
      subtitle: 'hollow-sub',
      dialogue: 'hollow-intro',
    });
  }

  onWorldUpdate() {
    // The camera's midPoint is the world position at the centre of the screen.
    const centre = this.cameras.main.midPoint;
    this.ashAnchor.x = centre.x;
    this.ashAnchor.y = centre.y;
  }

  onDialogueEvent(name) {
    if (name === 'enter-silo') this.leaveTo('Silo', 900);
    else super.onDialogueEvent(name);
  }

  /** The hatch only opens for Eli's keycard. */
  inspect(data) {
    if (data.id !== 'hatch') {
      super.inspect(data);
      return;
    }
    if (GameState.hasItem('keycard')) Dialogue.start(data.dialogue || 'inspect-hatch'); // fires 'enter-silo'
    else GameState.toast(str('hatch-locked'), 'warning');
  }

  // ---------- ambience ----------

  /** A translucent black rectangle over the whole map, drawn just above the map picture. */
  createDarkGrade() {
    const { width, height } = this.map;
    this.add.rectangle(0, 0, width, height, GROUND_SHADE.color, GROUND_SHADE.alpha).setOrigin(0).setDepth(GROUND_SHADE.depth);
  }

  /**
   * A particle emitter that never stops. It sits at (0, 0) and "follows" the ash anchor (the camera
   * centre), so new flakes appear around the view while old ones stay put in the world.
   */
  createAsh() {
    this.ashAnchor = { x: this.player.x, y: this.player.y };
    const key = this.textures.exists('fx-ash') ? 'fx-ash' : '__WHITE';

    this.ash = this.add.particles(0, 0, key, {
      emitZone: { type: 'random', source: new Phaser.Geom.Rectangle(-ASH_AREA.w / 2, -ASH_AREA.h / 2, ASH_AREA.w, ASH_AREA.h) },
      lifespan: ASH_LIFESPAN_MS,
      frequency: 60, // one flake every 60 ms
      speedX: { min: -6, max: 14 }, // a light wind from the west
      speedY: { min: 6, max: 20 }, // slowly falling
      scale: { min: 0.6, max: 1.5 },
      rotate: { min: 0, max: 360 },
      alpha: { start: 0.8, end: 0 },
    });
    this.ash.startFollow(this.ashAnchor);
    this.ash.setDepth(ASH_DEPTH);
    this.ash.fastForward(ASH_LIFESPAN_MS); // start with the air already full of ash
  }
}
