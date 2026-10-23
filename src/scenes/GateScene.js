import Phaser from 'phaser';
import gateMap from '../data/maps/gate.json';
import { GameState } from '../systems/GameState.js';
import { Dialogue } from '../systems/Dialogue.js';
import WorldScene from './WorldScene.js';
import NPC from '../entities/NPC.js';

// Paradise Gate's quest stages, in order. Arriving with any other stage starts at 'gate'.
const GATE_STAGES = ['gate', 'eli_scouts', 'eli_falls'];

// Eli's cutscene (contract M3 §8).
const PLAYER_WALK_SPEED = 60; // px/s, the player stepping up to the halt point
const ELI_WALK_SPEED = 52;
const ELI_STAGGER_SPEED = 30; // slow and unsteady on the way back out
const ELI_FADE_MS = 900; // swallowed by the white
const PAN_MS = 1400;
const CLOUD_WAIT_MS = 3000; // the camera watches the arch this long
const FLICKER_SHAKE_MS = 700;
const FLICKER_FLASH_MS = 450;
const COLLAPSE_ANGLE = -16; // degrees; he sinks to one side
const DISSOLVE_MS = 1900;
const SILVER = 0xc9d3e6;
const SILVER_TINTS = [0xffffff, 0xdfe6f2, 0xa9b8d4];

const WHITE_FADE_MS = 1200; // walking into the cloud

/**
 * Act IV, Paradise Gate: a vast wall of white. Eli scouts ahead alone and comes back dying,
 * bleeding silver. Then the party walks through the arch into the cloud anyway.
 */
export default class GateScene extends WorldScene {
  constructor() {
    super('Gate');
  }

  get mapData() {
    return gateMap;
  }

  get actId() {
    return 'IV';
  }

  onWorldCreate() {
    GameState.setShowToxicity(true);
    this.insideApproach = false;
    this.cutsceneRunning = false;
    this.eli = null; // Eli's sprite while the cutscene owns him
    this.eliDissolving = null; // a Promise while he dissolves

    this.resumeQuest();

    this.playIntro({ flag: 'gate_intro_done', title: 'act4-title', subtitle: 'act4-sub', dialogue: 'gate-intro' });
  }

  onWorldUpdate() {
    if (this.busy || this.cutsceneRunning || GameState.inputLocked) return;
    this.checkApproach();
    this.checkArch();
  }

  onDialogueEvent(name) {
    if (name === 'eli-scout') this.playEliCutscene();
    else if (name === 'eli-dies') this.eliDies();
    else super.onDialogueEvent(name);
  }

  /** Sets 'gate' on arrival, and tidies up a save that was made in the middle of the story here. */
  resumeQuest() {
    const quest = GameState.quest;
    if (quest === 'eli_scouts') {
      // Saved while the cutscene ran: if Eli already fell, carry on from there; otherwise replay it.
      GameState.setQuest(GameState.hasFlag('eli_gone') ? 'eli_falls' : 'gate');
    } else if (!GATE_STAGES.includes(quest)) {
      GameState.setQuest('gate');
    }

    // After Eli's death he can't still be walking with us.
    if (GameState.quest === 'eli_falls' && GameState.inParty('eli')) {
      const follower = this.detachFollower('eli');
      if (follower) follower.destroy();
      GameState.setFlag('eli_gone');
      GameState.leaveParty('eli');
    }
  }

  // ---------- zones ----------

  /** Walking up to the cloud during 'gate': Eli offers to scout ahead (dialogue 'eli-scout'). */
  checkApproach() {
    const inside = this.playerInZone('approach');
    if (inside && !this.insideApproach && GameState.quest === 'gate') Dialogue.start('eli-scout');
    this.insideApproach = inside;
  }

  /** The arch threshold only lets you in after Eli has fallen (quest 'eli_falls'). */
  checkArch() {
    if (!this.playerInZone('enter')) return;

    if (GameState.quest === 'eli_falls') {
      this.leaveTo('Hollow', WHITE_FADE_MS, [255, 255, 255]); // into the white
      return;
    }
    this.nudgeOutOfZone('enter');
    this.toastWithCooldown('gate-cloud-refuses');
  }

  // ---------- Eli's cutscene ----------

  /**
   * 'eli-scout' fires at the end of the 'eli-scout' dialogue. Each step waits for the previous one:
   * `await` pauses this function (not the game) until the walk, pan or dialogue has finished.
   */
  async playEliCutscene() {
    if (this.cutsceneRunning || GameState.quest !== 'gate') return;
    this.cutsceneRunning = true;
    const cs = this.startCutscene(); // locks input until cs.end()
    this.player.scripted = true; // the cutscene may walk the player
    GameState.setQuest('eli_scouts');

    try {
      await cs.wait(300); // let the 'eli-scout' dialogue box close
      await this.haltParty(cs);
      await this.eliWalksIn(cs);
      await this.cloudFlickers(cs);
      await this.eliStaggersOut(cs);

      await cs.dialogue('eli-dying'); // its 'eli-dies' event starts the dissolve
      if (!this.eliDissolving) this.eliDies(); // in case the story data didn't fire it
      await this.eliDissolving;

      await cs.dialogue('eli-after'); // sets the quest to 'eli_falls'
      if (GameState.quest !== 'eli_falls') GameState.setQuest('eli_falls');
      GameState.save(); // a reload must not bring Eli back
    } catch (error) {
      console.error('Gate: the Eli cutscene failed', error);
      if (GameState.quest === 'eli_scouts') GameState.setQuest('eli_falls');
    } finally {
      cs.follow(this.player);
      this.player.scripted = false;
      cs.end();
      this.cutsceneRunning = false;
    }
  }

  /** Step 1: the player stops at the halt point (if the map has one); the party falls in behind. */
  async haltParty(cs) {
    const halt = this.map.points['party-halt'];
    if (halt) await cs.moveTo(this.player, halt.x, halt.y, PLAYER_WALK_SPEED);
    this.player.playIdle('up');
  }

  /** Step 2: Eli leaves the line, walks to the edge of the cloud and fades into it. */
  async eliWalksIn(cs) {
    this.eli = this.takeEli();
    const enter = this.map.points['eli-enter'] || this.archCentre();
    await cs.moveTo(this.eli, enter.x, enter.y, ELI_WALK_SPEED);
    await this.tweenAsync({ targets: this.eli, alpha: 0, duration: ELI_FADE_MS });
  }

  /** Step 3: the camera watches the arch; the cloud shudders and flashes white. */
  async cloudFlickers(cs) {
    const arch = this.archCentre();
    await cs.pan(arch.x, arch.y, PAN_MS);
    await cs.wait(CLOUD_WAIT_MS / 2);
    cs.shake(FLICKER_SHAKE_MS, 0.008);
    cs.flash(FLICKER_FLASH_MS, [255, 255, 255]);
    await cs.wait(CLOUD_WAIT_MS / 2);
  }

  /** Step 4: Eli stumbles back out, silver, and collapses. */
  async eliStaggersOut(cs) {
    const eli = this.eli;
    const collapse = this.map.points['eli-collapse'] || { x: this.player.x, y: this.player.y - 28 };

    eli.setTint(SILVER);
    this.tweens.add({ targets: eli, alpha: 1, duration: 500 });
    cs.pan(collapse.x, collapse.y, PAN_MS);
    await cs.moveTo(eli, collapse.x, collapse.y, ELI_STAGGER_SPEED);

    eli.playIdle('down');
    await this.tweenAsync({ targets: eli, angle: COLLAPSE_ANGLE, duration: 260, ease: 'Quad.easeIn' });
    this.player.faceTowards(eli.x, eli.y);
    await cs.wait(500);
  }

  /** Eli's sprite for the cutscene: his follower, or a stand-in if he isn't in the party. */
  takeEli() {
    const follower = this.detachFollower('eli');
    if (follower) return follower;
    return new NPC(this, { id: 'eli', sprite: 'eli', name: 'Eli', x: this.player.x + 18, y: this.player.y + 6 });
  }

  /**
   * 'eli-dies' (inside 'eli-dying'): a burst of silver, then he dissolves.
   * When the dissolve ends he leaves the party for good and the flag 'eli_gone' is set.
   */
  eliDies() {
    if (this.eliDissolving) return;
    const eli = this.eli || this.detachFollower('eli');
    this.eli = eli;

    if (!eli) {
      this.eliDissolving = Promise.resolve();
      this.markEliGone();
      return;
    }

    this.burstSilver(eli);
    this.eliDissolving = this.tweenAsync({ targets: eli, alpha: 0, duration: DISSOLVE_MS, ease: 'Sine.easeIn' }).then(
      () => {
        eli.destroy();
        this.eli = null;
        this.markEliGone();
      },
    );
  }

  markEliGone() {
    GameState.leaveParty('eli');
    GameState.setFlag('eli_gone');
  }

  /** Silver "blood": a quick burst, then a thin stream of motes rising while he fades. */
  burstSilver(eli) {
    const key = this.textures.exists('fx-silver') ? 'fx-silver' : '__WHITE'; // __WHITE is built into Phaser
    const emitter = this.add.particles(eli.x, eli.y - 18, key, {
      emitting: false,
      lifespan: { min: 700, max: 1500 },
      speed: { min: 15, max: 70 },
      angle: { min: 200, max: 340 }, // mostly upwards
      gravityY: -18, // motes drift up
      scale: { start: 1.6, end: 0 },
      alpha: { start: 1, end: 0 },
      tint: SILVER_TINTS,
      blendMode: 'ADD', // glowing
      emitZone: { type: 'random', source: new Phaser.Geom.Rectangle(-8, -18, 16, 36) },
    });
    emitter.setDepth(eli.y + 1);
    emitter.explode(40); // the burst

    // Then a steady trickle (one mote every 45 ms) for as long as the dissolve lasts.
    emitter.flow(45, 1);
    this.time.delayedCall(DISSOLVE_MS, () => emitter.stop());
    this.time.delayedCall(DISSOLVE_MS + 1600, () => emitter.destroy());
  }

  /** The middle of the arch (the 'arch' inspectable, else the 'enter' zone). */
  archCentre() {
    const arch = (this.mapData.inspectables || []).find((data) => data.id === 'arch');
    if (arch) return { x: arch.x + arch.w / 2, y: arch.y + arch.h / 2 };
    const enter = this.map.zones.enter;
    if (enter) return { x: enter.centerX, y: enter.centerY };
    return { x: this.player.x, y: this.player.y - 80 };
  }
}
