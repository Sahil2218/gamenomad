import Phaser from 'phaser';
import wastelandMap from '../data/maps/wasteland.json';
import { GameState } from '../systems/GameState.js';
import { Dialogue } from '../systems/Dialogue.js';
import { str } from '../systems/strings.js';
import WorldScene from './WorldScene.js';

// The Wasteland's quest stages, in order. Arriving with any other stage starts at 'city'.
const WASTELAND_STAGES = ['city', 'fight', 'survivors', 'signal', 'cloud'];
const PARTY_SIZE = 5;

// Kael's fight (contract M2 §5 and §8).
const KAEL_CRAWLERS = 3;
const KAEL_SPAWN_DISTANCE = 80; // px from Kael
const KAEL_CRAWLER_AGGRO = 200; // they come for you straight away
const KAEL_STRIKE_EVERY_MS = 1400;
const KAEL_REACH = 44; // px around Kael that his strike covers
const KAEL_SPEED = 60; // px/s while he closes in on a crawler
const KAEL_CLOSE_ENOUGH = 22;
const FIGHT_WON_DELAY_MS = 700; // let the last nanite burst play before Kael speaks

const SIGNAL_LAUNCH_DELAY_MS = 200; // after the 'ryn' dialogue closes

/**
 * Act III, The Ruined City: Kael's fight, then Nova, Ryn and Eli,
 * the signal puzzle at Ryn's rig, and the road east to the white cloud.
 */
export default class WastelandScene extends WorldScene {
  constructor() {
    super('Wasteland');
  }

  get mapData() {
    return wastelandMap;
  }

  get actId() {
    return 'III';
  }

  get usesCrawlers() {
    return true; // Kael's fight spawns crawlers even if the map had no groups
  }

  onWorldCreate() {
    GameState.setShowToxicity(true);
    if (!WASTELAND_STAGES.includes(GameState.quest)) GameState.setQuest('city');

    this.fightActive = false;
    this.nextKaelStrikeAt = 0;
    this.insideEncounter = false;
    this.signalPending = false;
    this.createRig();

    this.crawlers.events.on('killed', this.onCrawlerKilled, this);
    this.listen('party:changed', this.checkPartyComplete);
    this.listen('dialogue:end', this.launchPendingSignal);
    this.listen('signal:solved', this.onSignalSolved);
    this.listen('signal:cancelled', this.onSignalCancelled);

    this.playIntro({
      flag: 'wasteland_intro_done',
      title: 'act3-title',
      subtitle: 'act3-sub',
      dialogue: 'wasteland-intro',
    });

    this.resumeFightIfNeeded();
    this.checkPartyComplete();
  }

  onWorldUpdate(time) {
    if (this.fightActive) this.updateFight(time);
    if (this.busy) return;
    this.checkEncounter();
    this.checkExit();
  }

  /** Ryn himself (a follower by then) also opens the signal puzzle. */
  followerDialogue(companionId) {
    if (companionId === 'ryn' && GameState.quest === 'signal') return 'ryn';
    return super.followerDialogue(companionId);
  }

  onDialogueEvent(name) {
    if (name === 'start-fight') this.startFight();
    else if (name === 'start-signal') this.signalPending = true;
    else super.onDialogueEvent(name);
  }

  // ---------- Kael's fight ----------

  /** Walking into the encounter zone during 'city' starts the meeting with Kael. */
  checkEncounter() {
    if (GameState.inputLocked) return; // try again once the dialogue or cutscene is over
    const inside = this.playerInZone('encounter');
    if (inside && !this.insideEncounter && GameState.quest === 'city') Dialogue.start('kael-meet');
    this.insideEncounter = inside;
  }

  get kael() {
    return this.npcs.find((npc) => npc.npcId === 'kael') || null;
  }

  /** 'start-fight' (from kael-meet): three crawlers come out of the rubble around Kael. */
  startFight() {
    if (this.fightActive) return;
    GameState.setQuest('fight');
    this.fightActive = true;
    this.nextKaelStrikeAt = this.time.now + KAEL_STRIKE_EVERY_MS;

    const kael = this.kael || this.player;
    this.spotsAround(kael.x, kael.y, KAEL_SPAWN_DISTANCE, KAEL_CRAWLERS).forEach(({ x, y }) => {
      this.crawlers.spawn(x, y, { tag: 'kael', aggro: KAEL_CRAWLER_AGGRO });
    });
    if (this.kael) this.kael.scripted = true; // he moves on his own during the fight
    GameState.toast(str('weapon-hint'), 'info');
  }

  /** After loading a save made mid-fight, bring the fight back (or finish it). */
  resumeFightIfNeeded() {
    if (GameState.quest !== 'fight') return;
    if (GameState.hasFlag('kael_fight_won')) this.startDialogueWhenFree('kael', 600);
    else this.startFight();
  }

  /** Crawlers emits 'killed' for every crawler that dies; the fight ends with the last of Kael's. */
  onCrawlerKilled(crawler, tag) {
    if (tag === 'kael' && this.fightActive && this.crawlers.count('kael') === 0) this.endFight();
  }

  updateFight(time) {
    const targets = this.crawlers.alive('kael');
    if (targets.length === 0) return;
    if (!this.kael || GameState.inputLocked) {
      if (this.kael) this.kael.setVelocity(0, 0);
      return;
    }
    this.moveKaelTowards(this.nearest(this.kael, targets));
    if (time >= this.nextKaelStrikeAt) {
      this.nextKaelStrikeAt = time + KAEL_STRIKE_EVERY_MS;
      this.kaelStrike();
    }
  }

  /** Kael steps towards the nearest crawler so his strikes can reach it. */
  moveKaelTowards(target) {
    const kael = this.kael;
    const dx = target.x - kael.x;
    const dy = target.y - kael.y;
    if (Math.hypot(dx, dy) <= KAEL_CLOSE_ENOUGH) {
      kael.faceTowards(target.x, target.y); // also stops him
      return;
    }
    const velocity = new Phaser.Math.Vector2(dx, dy).normalize().scale(KAEL_SPEED);
    kael.setVelocity(velocity.x, velocity.y);
    kael.playWalk(Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down');
  }

  /** Every ~1.4 s Kael hits every one of "his" crawlers within reach. */
  kaelStrike() {
    const kael = this.kael;
    const reach = new Phaser.Geom.Rectangle(kael.x - KAEL_REACH, kael.y - KAEL_REACH, KAEL_REACH * 2, KAEL_REACH * 2);
    const hits = this.crawlers.hitArea(reach, 1, kael.x, kael.y, 'kael');
    if (hits > 0) this.showKaelSlash(kael);
  }

  /** A quick white arc at Kael's side so you can see him fight. */
  showKaelSlash(kael) {
    if (!this.textures.exists('fx-slash')) return;
    const slash = this.add.image(kael.x, kael.y - 14, 'fx-slash').setDepth(kael.y + 1);
    slash.setFlipX(kael.facing === 'left');
    this.tweens.add({ targets: slash, alpha: 0, scale: 1.4, duration: 180, onComplete: () => slash.destroy() });
  }

  /** The last of Kael's crawlers is gone: he talks, joins and hands over the medallion. */
  endFight() {
    this.fightActive = false;
    if (this.kael) {
      this.kael.scripted = false;
      this.kael.stopMoving();
    }
    GameState.setFlag('kael_fight_won');
    this.startDialogueWhenFree('kael', FIGHT_WON_DELAY_MS);
  }

  // ---------- the party and the signal ----------

  /** With all five companions, it's time for Ryn's signal. */
  checkPartyComplete() {
    const beforeSignal = ['city', 'fight', 'survivors'].includes(GameState.quest);
    if (beforeSignal && GameState.party.length === PARTY_SIZE) {
      // Deferred one tick so every listener sees the join before the quest moves on.
      this.time.delayedCall(0, () => GameState.setQuest('signal'));
    }
  }

  /** The rig zone is talkable during the 'signal' stage: it plays Ryn's dialogue. */
  createRig() {
    const rig = this.map.zones.rig;
    if (!rig) {
      console.warn('wasteland.json has no "rig" zone');
      return;
    }
    const data = { id: 'rig', x: rig.x, y: rig.y, w: rig.width, h: rig.height, dialogue: 'ryn' };
    this.interactions.addInspectable(data, () => GameState.quest === 'signal');
  }

  /**
   * 'start-signal' fires inside the 'ryn' dialogue. We wait until the dialogue has closed
   * (and unlocked input) before opening the Signal scene on top, so the dialogue's unlock
   * can't free the player while the puzzle is open.
   */
  launchPendingSignal() {
    if (!this.signalPending) return;
    this.signalPending = false;
    this.time.delayedCall(SIGNAL_LAUNCH_DELAY_MS, () => {
      if (!this.scene.get('Signal')) {
        console.warn('No "Signal" scene registered');
        return;
      }
      GameState.inputLocked = true;
      this.scene.launch('Signal'); // runs on top; this scene keeps running underneath
    });
  }

  onSignalSolved() {
    GameState.setFlag('signal_solved');
    // The Signal scene unlocks input as it stops, so start the dialogue a moment later.
    this.startDialogueWhenFree('signal-solved', 300);
  }

  onSignalCancelled() {
    this.time.delayedCall(0, () => {
      GameState.inputLocked = false;
    });
  }

  // ---------- exit ----------

  /** East toward the white cloud: open once the signal is solved (quest 'cloud'). Leads to Paradise Gate. */
  checkExit() {
    if (!this.playerInZone('exit')) return;

    if (GameState.quest === 'cloud') {
      this.leaveTo('Gate', 900);
      return;
    }
    this.nudgeOutOfZone('exit');
    this.toastWithCooldown('exit-locked-wasteland');
  }

  // ---------- small helpers ----------

  nearest(from, list) {
    return list.reduce((best, item) =>
      Phaser.Math.Distance.BetweenPoints(from, item) < Phaser.Math.Distance.BetweenPoints(from, best) ? item : best,
    );
  }

  /** `count` points on a circle around (x, y), skipping spots inside walls or off the map. */
  spotsAround(x, y, distance, count) {
    const spots = [];
    const steps = 12;
    for (let i = 0; i < steps && spots.length < count; i += 1) {
      // Spread the first tries evenly (0°, 120°, 240°), then fill the gaps.
      const angle = ((i * (360 / count)) % 360) + Math.floor(i / count) * 30;
      const px = x + Math.cos(Phaser.Math.DegToRad(angle)) * distance;
      const py = y + Math.sin(Phaser.Math.DegToRad(angle)) * distance;
      if (this.isFreeSpot(px, py)) spots.push({ x: px, y: py });
    }
    while (spots.length < count) spots.push({ x, y: y + distance }); // fallback: Kael's feet, below
    return spots;
  }

  isFreeSpot(x, y) {
    const margin = 16;
    if (x < margin || y < margin || x > this.map.width - margin || y > this.map.height - margin) return false;
    return !this.map.colliderRects.some((rect) => rect.contains(x, y));
  }
}

// Also available by name: import { WastelandScene } from './WastelandScene.js'
export { WastelandScene };
