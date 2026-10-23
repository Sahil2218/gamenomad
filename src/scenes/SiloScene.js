import Phaser from 'phaser';
import siloMap from '../data/maps/silo.json';
import tuning from '../data/tuning.json';
import { GameState } from '../systems/GameState.js';
import { Dialogue } from '../systems/Dialogue.js';
import WorldScene from './WorldScene.js';
import Waves from '../world/Waves.js';
import HoldPoint from '../world/HoldPoint.js';

// Silo 01's quest stages, in order. Arriving with any other stage starts at 'silo'.
const SILO_STAGES = ['silo', 'archives', 'remember', 'beacon', 'destroy', 'relays', 'reprogram'];
// From the beacon on it is Act VI, and the swarm keeps coming until the ending.
const ACT_VI_STAGES = ['beacon', 'destroy', 'relays', 'reprogram'];
const ARCHIVE_FLAGS = ['archive_history', 'archive_aegis', 'archive_villages'];

const MEMORY_OVERLAY_MS = 4600; // the UI's memory overlay lasts ~4.5 s
const RESUME_DIALOGUE_DELAY_MS = 800;
const READY_DIALOGUE_DELAY_MS = 600; // after the last relay is held
const SIGNAL_LAUNCH_DELAY_MS = 200; // after the core dialogue closes
const DAWN_DELAY_MS = 500; // let the Signal panel close before the fade

/**
 * Acts V and VI, Silo 01: the truth beneath.
 *   silo → archives (read 3 terminals) → remember (the memory chamber) → beacon (the swarm comes)
 *   → at the AEGIS core, choose:
 *       destroy: carry the artifacts to the reactor furnace           → the quiet ending
 *       relays → reprogram: hold 3 relays, rewrite the signal (Signal) → the dawn ending
 *
 * Everything is driven by the quest stage and flags, so loading a save in any stage
 * rebuilds the right state (waves running, relays to hold, …).
 */
export default class SiloScene extends WorldScene {
  constructor() {
    super('Silo');
  }

  get mapData() {
    return siloMap;
  }

  get actId() {
    return ACT_VI_STAGES.includes(GameState.quest) ? 'VI' : 'V';
  }

  get usesCrawlers() {
    return true; // the swarm waves need crawlers (and survival, and combat)
  }

  onWorldCreate() {
    if (!SILO_STAGES.includes(GameState.quest)) GameState.setQuest('silo');
    GameState.setAct(this.actId);

    this.waves = new Waves(this, this.crawlers, this.map.vents);
    this.wavesRunning = false;
    this.holds = []; // HoldPoints, created in stage 'relays'
    this.insideMemory = false;
    this.insideFurnace = false;
    this.memoryRunning = false;
    this.signalPending = false;
    // A resumed save in Act VI doesn't sound the alarm again.
    this.beaconAnnounced = this.beaconFired();

    this.listen('flags:changed', this.queueArchiveCheck);
    this.listen('quest:changed', this.onQuestChanged);
    this.listen('dialogue:end', this.launchPendingSignal);
    this.listen('signal:solved', this.onSignalSolved);
    this.listen('signal:cancelled', this.onSignalCancelled);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.cleanUp, this);

    this.makeRelaysInspectable();
    this.playIntro({ flag: 'silo_intro_done', title: 'act5-title', subtitle: 'act5-sub', dialogue: 'silo-arrival' });
    this.resumeStage();
  }

  onWorldUpdate(time, delta) {
    this.waves.update(time);
    this.holds.forEach((hold) => hold.update(time, delta));

    if (this.busy || GameState.inputLocked) return;
    this.checkMemory();
    this.checkFurnace();
  }

  onDialogueEvent(name) {
    if (name === 'beacon') this.fireBeacon();
    else if (name === 'choose-destroy') GameState.setQuest('destroy');
    else if (name === 'choose-reprogram') GameState.setQuest('relays'); // onQuestChanged builds the relays
    else if (name === 'start-reprogram') this.signalPending = true;
    else super.onDialogueEvent(name);
  }

  /** Both endings stop the swarm. */
  goToEnding(kind) {
    this.stopWaves();
    super.goToEnding(kind);
  }

  /** After a death the swarm pulls back (the waves keep coming), so you don't wake up inside it. */
  onRespawn() {
    this.waves.hunters().forEach((crawler) => crawler.die());
  }

  // ---------- stages ----------

  /** Loading a save (or a dev jump) puts back whatever the current stage needs. */
  resumeStage() {
    const quest = GameState.quest;
    this.checkArchives();
    if (ACT_VI_STAGES.includes(quest)) this.startWaves();
    if (quest === 'relays') this.createHolds();

    // The memory played but the alarm never did (e.g. the page closed in between).
    if (quest === 'remember' && GameState.hasFlag('memories_restored')) {
      this.startDialogueWhenFree('beacon-alarm', RESUME_DIALOGUE_DELAY_MS);
    }
  }

  /** Each stage change gets whatever it needs (the story data may set stages directly). */
  onQuestChanged(stage) {
    GameState.setAct(this.actId);
    this.queueArchiveCheck();
    if (ACT_VI_STAGES.includes(stage)) this.startWaves();
    if (stage === 'relays') this.createHolds();
    if (ACT_VI_STAGES.includes(stage)) GameState.save(); // a reload resumes the finale here
  }

  /** Deferred one tick, so every listener sees the flag (or stage) change before the quest moves on. */
  queueArchiveCheck() {
    this.time.delayedCall(0, () => this.checkArchives());
  }

  /** All three archive terminals read during 'archives': time to remember. */
  checkArchives() {
    if (GameState.quest !== 'archives') return;
    if (ARCHIVE_FLAGS.every((flag) => GameState.hasFlag(flag))) GameState.setQuest('remember');
  }

  // ---------- the memory chamber ----------

  /** Stepping into the memory chamber during 'remember' restores the memories. */
  checkMemory() {
    const inside = this.playerInZone('memory');
    if (inside && !this.insideMemory && GameState.quest === 'remember') this.playMemory();
    this.insideMemory = inside;
  }

  /**
   * The 'memory' dialogue fires 'memory-restore' (WorldScene shows the overlay and sets
   * 'memories_restored'). Once the overlay has faded, the beacon alarm sounds.
   */
  async playMemory() {
    if (this.memoryRunning) return;
    this.memoryRunning = true;
    const cs = this.startCutscene(); // keeps input locked between the two dialogues
    try {
      await cs.dialogue('memory');
      if (GameState.hasFlag('memories_restored')) await cs.wait(MEMORY_OVERLAY_MS);
      if (!this.beaconFired()) await cs.dialogue('beacon-alarm'); // fires 'beacon'
    } catch (error) {
      console.error('Silo: the memory sequence failed', error);
    } finally {
      cs.end();
      this.memoryRunning = false;
    }
  }

  beaconFired() {
    return ACT_VI_STAGES.includes(GameState.quest);
  }

  /** 'beacon': the artifacts are calling the swarm. Alarm, Act VI, waves. */
  fireBeacon() {
    if (this.beaconAnnounced) return;
    this.beaconAnnounced = true;
    GameState.setAct('VI');
    GameState.emit('beacon'); // the UI shows the red alert
    const camera = this.cameras.main;
    camera.flash(500, 255, 40, 40);
    camera.shake(900, 0.006);
    this.startWaves();
    GameState.setQuest('beacon');
  }

  // ---------- the swarm ----------

  startWaves() {
    if (this.wavesRunning) return;
    if (this.map.vents.length === 0) {
      console.warn('silo.json has no "vents": no waves');
      return;
    }
    this.wavesRunning = true;
    this.waves.start();
  }

  /** Stops new waves, and the crawlers still out there burst apart. */
  stopWaves() {
    this.waves.stop(true); // true = the wave crawlers still alive burst too
    this.wavesRunning = false;
  }

  // ---------- destroy: the furnace ----------

  /** The furnace during 'destroy': dialogue 'furnace' fires 'ending-quiet' (handled by WorldScene). */
  checkFurnace() {
    const inside = this.playerInZone('furnace');
    if (inside && !this.insideFurnace && GameState.quest === 'destroy') Dialogue.start('furnace');
    this.insideFurnace = inside;
  }

  // ---------- reprogram: the relays and the signal ----------

  /** E on a relay ring plays 'relay' (what the rings are for; its variants follow the stage). */
  makeRelaysInspectable() {
    this.map.relays.forEach(({ id, rect }) => {
      this.interactions.addInspectable({ id, x: rect.x, y: rect.y, w: rect.width, h: rect.height, dialogue: 'relay' });
    });
  }

  /** One HoldPoint per relay that hasn't been held yet. Holding one sets 'relay_<n>'. */
  createHolds() {
    if (this.holds.length > 0) return;
    if (this.map.relays.length === 0) console.warn('silo.json has no "relays"');

    this.map.relays.forEach((relay, index) => {
      const flag = `relay_${relayNumber(relay.id, index)}`;
      if (GameState.hasFlag(flag)) return; // already held before the save
      const hold = new HoldPoint(this, this.player, relay.rect, {
        id: relay.id,
        onComplete: () => this.onRelayHeld(flag),
        onPulse: (x, y, radius) => this.repelCrawlers(x, y, radius),
      });
      this.holds.push(hold);
    });
    this.checkRelaysDone();
  }

  /** A held relay's AEGIS pulse: crawlers near it take a hit and are knocked away from it. */
  repelCrawlers(x, y, radius) {
    if (!this.crawlers) return;
    const area = { x: x - radius, y: y - radius, w: radius * 2, h: radius * 2 };
    this.crawlers.hitArea(area, tuning.hold.pulseDamage ?? 1, x, y);
  }

  onRelayHeld(flag) {
    GameState.setFlag(flag);
    GameState.save();
    this.checkRelaysDone();
  }

  /** Every relay held during 'relays': back to the core to rewrite the signal. */
  checkRelaysDone() {
    if (GameState.quest !== 'relays' || this.map.relays.length === 0) return;
    const allHeld = this.map.relays.every((relay, index) => GameState.hasFlag(`relay_${relayNumber(relay.id, index)}`));
    if (!allHeld) return;
    GameState.setQuest('reprogram');
    this.startDialogueWhenFree('reprogram-ready', READY_DIALOGUE_DELAY_MS);
  }

  /**
   * 'start-reprogram' fires inside the core dialogue. Wait until that dialogue has closed
   * (and unlocked input), then open the Signal mini-game on top in its hard 'reprogram' mode.
   */
  launchPendingSignal() {
    if (!this.signalPending) return;
    this.signalPending = false;
    this.time.delayedCall(SIGNAL_LAUNCH_DELAY_MS, () => {
      GameState.inputLocked = true;
      this.scene.launch('Signal', { mode: 'reprogram' }); // this scene keeps running underneath
    });
  }

  /** The rewritten signal holds: the dawn ending. (Ignores the plain Act III signal, if any.) */
  onSignalSolved(payload) {
    const mode = payload && payload.mode;
    if (mode !== 'reprogram' && !(mode === undefined && GameState.quest === 'reprogram')) return;
    this.stopWaves();
    this.time.delayedCall(DAWN_DELAY_MS, () => this.goToEnding('dawn'));
  }

  onSignalCancelled() {
    this.time.delayedCall(0, () => {
      GameState.inputLocked = false;
    });
  }

  cleanUp() {
    if (this.wavesRunning) this.waves.stop();
    this.wavesRunning = false;
    this.holds.forEach((hold) => hold.destroy());
    this.holds = [];
  }
}

/** 'relay-2' → 2. Falls back to the position in the list (1-based) if the id has no number. */
function relayNumber(id, index) {
  const match = /(\d+)$/.exec(id || '');
  return match ? Number(match[1]) : index + 1;
}
