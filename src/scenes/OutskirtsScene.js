import outskirtsMap from '../data/maps/outskirts.json';
import { GameState } from '../systems/GameState.js';
import { str } from '../systems/strings.js';
import WorldScene from './WorldScene.js';
import Drones from '../world/Drones.js';

// Quest stages that belong to the Village: arriving with one of them starts the Outskirts quest.
const VILLAGE_STAGES = ['wake', 'explore', 'confront', 'bridge', 'crossed'];
const CAUGHT_PAUSE_MS = 1400; // how long the "caught" warning shows before the fade

/**
 * Act II, The Outskirts: the meadow decays into ash. Avoid the Warden drones,
 * meet Mira at the field station, recover her satchel, then head south to the city.
 */
export default class OutskirtsScene extends WorldScene {
  constructor() {
    super('Outskirts');
  }

  get mapData() {
    return outskirtsMap;
  }

  get actId() {
    return 'II';
  }

  onWorldCreate() {
    // Outside the village the air is toxic, so the UI shows the meter from now on.
    GameState.setShowToxicity(true);
    if (VILLAGE_STAGES.includes(GameState.quest)) GameState.setQuest('outskirts');

    this.caught = false;
    this.lastDetection = 0;
    this.listen('detection', this.onDetection);
    this.drones = new Drones(this, this.player, this.mapData.drones || [], this.map.colliders, {
      onCaught: () => this.onDroneCaught(),
    });

    this.playIntro({
      flag: 'outskirts_intro_done',
      title: 'act2-title',
      subtitle: 'act2-sub',
      dialogue: 'outskirts-intro',
    });
  }

  onWorldUpdate(time, delta) {
    this.drones.update(time, delta);
    if (this.busy) return;
    this.checkGate();
    this.checkExit();
  }

  // ---------- drones ----------
  // Drones pause by themselves while input is locked (dialogues, cutscenes).

  /** The Warden speaks up when a scan starts (the drones emit 'detection' 0..1). */
  onDetection(level) {
    if (level > 0 && this.lastDetection === 0) this.toastWithCooldown('drone-spotted');
    this.lastDetection = level;
  }

  /**
   * Caught in a vision cone: AEGIS doesn't hurt you, it "herds" you back.
   * Warning → fade → back at the last checkpoint. Not a death: health is untouched.
   */
  onDroneCaught() {
    if (this.caught || this.busy) return;
    this.caught = true;
    this.busy = true; // no deaths, zones or supply keys until we're back
    this.drones.setEnabled(false);

    GameState.inputLocked = true;
    this.player.setVelocity(0, 0);
    GameState.alert(str('drone-caught-title'), str('drone-caught-sub'));

    this.time.delayedCall(CAUGHT_PAUSE_MS, () => {
      this.returnToCheckpoint(
        () => {},
        () => {
          this.caught = false;
          this.drones.setEnabled(true);
        },
      );
    });
  }

  // ---------- zones ----------

  /** The strip just south of the bridge: the way back to the village is sealed. */
  checkGate() {
    if (!this.playerInZone('gate')) return;
    this.nudgePlayer(0, 1); // south, away from the bridge
    this.toastWithCooldown('gate-sealed');
  }

  /** The road south only opens once Mira has joined (quest 'to_city'). */
  checkExit() {
    if (!this.playerInZone('exit')) return;

    if (GameState.quest === 'to_city') {
      this.leaveTo('Wasteland');
      return;
    }
    this.nudgeOutOfZone('exit');
    this.toastWithCooldown('exit-locked-outskirts');
  }
}
