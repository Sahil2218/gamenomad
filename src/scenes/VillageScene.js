import Phaser from 'phaser';
import villageMap from '../data/maps/village.json';
import { GameState } from '../systems/GameState.js';
import { str } from '../systems/strings.js';
import WorldScene from './WorldScene.js';
import Barrier from '../world/Barrier.js';

const EXIT_DELAY_MS = 2800; // "ROGUE HUMAN DETECTED" time before fading out

/**
 * Act I, Village 07: collect Tobin's three artifacts, confront the Mayor,
 * then slip through the flickering barrier at the south bridge.
 * WorldScene builds the map, actors and interactions; this file adds the Village's story rules.
 */
export default class VillageScene extends WorldScene {
  constructor() {
    super('Village');
  }

  get mapData() {
    return villageMap;
  }

  get actId() {
    return 'I';
  }

  onWorldCreate() {
    this.exiting = false;
    this.createBarrierAndExit();

    this.listen('inventory:changed', this.checkConfront);
    this.listen('quest:changed', this.onQuestChanged);
    this.checkConfront();

    this.playIntro({ flag: 'village_intro_done', title: 'act1-title', subtitle: 'act1-sub', dialogue: 'intro' });
  }

  onWorldUpdate(time) {
    if (this.barrier) this.barrier.update(time);
    this.checkExit();
  }

  createBarrierAndExit() {
    const { barrier, exit } = this.map.zones;
    this.barrier = barrier ? new Barrier(this, barrier, this.player) : null;
    this.exitZone = exit || null;
    if (!barrier || !exit) console.warn('village.json is missing the "barrier" or "exit" zone');
  }

  // ---------- quest logic ----------

  /** Holding all three artifacts during 'explore' moves the story on to the confrontation. */
  checkConfront() {
    if (GameState.quest === 'explore' && GameState.artifactCount() === 3) {
      GameState.setQuest('confront');
    }
  }

  onQuestChanged() {
    // Also covers reaching 'explore' while already holding all three artifacts.
    // Deferred one tick so every listener sees the 'explore' change before 'confront'.
    this.time.delayedCall(0, () => this.checkConfront());
  }

  /** Stepping onto the bridge exit while the barrier is passable ends the act. */
  checkExit() {
    if (this.exiting || !this.exitZone || GameState.quest !== 'bridge') return;
    if (!this.exitZone.contains(this.player.x, this.player.y)) return;

    this.exiting = true;
    this.busy = true;
    GameState.setQuest('crossed');
    GameState.inputLocked = true;
    GameState.alert(str('rogue-title'), str('rogue-subtitle'));

    const camera = this.cameras.main;
    camera.flash(400, 255, 40, 40);
    camera.shake(700, 0.01);

    this.time.delayedCall(EXIT_DELAY_MS, () => {
      camera.fadeOut(600, 0, 0, 0);
      camera.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => this.scene.start('Outskirts'));
    });
  }
}
