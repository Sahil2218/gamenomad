import Phaser from 'phaser';
import items from '../data/items.json';
import { GameState } from '../systems/GameState.js';
import { Dialogue } from '../systems/Dialogue.js';
import { DEV } from '../systems/devFlags.js';
import { str } from '../systems/strings.js';
import { buildMap } from '../world/MapBuilder.js';
import Interactions from '../world/Interactions.js';
import Hazards from '../world/Hazards.js';
import Party from '../world/Party.js';
import Crawlers from '../world/Crawlers.js';
import Guide from '../world/Guide.js';
import Survival from '../systems/Survival.js';
import Combat from '../systems/Combat.js';
import Cutscene from '../systems/Cutscene.js';
import Player from '../entities/Player.js';
import NPC from '../entities/NPC.js';
import Pickup from '../entities/Pickup.js';

const INTRO_DELAY_MS = 2500; // title card time before the intro dialogue
const MINIMAP_EVERY_MS = 250; // minimap points are refreshed about 4× per second
const ZONE_TOAST_COOLDOWN_MS = 3000;
const PUSH_SPEED = 220; // px/s, the "nudge back" out of a closed zone
const PUSH_MS = 120;
const FADE_MS = 500;
const RESPAWN_HEALTH = 60;
const CRAWLER_SAFE_RADIUS = 160; // no crawler group starts this close to the spawn or an NPC
const ENDING_FADE_MS = 1800;
// The screen fades to this colour on the way to each ending: warm light for dawn, black for quiet.
const ENDING_FADE_COLORS = { dawn: [255, 236, 204], quiet: [0, 0, 0] };

/**
 * The base class for every walkable area (Village, Outskirts, Wasteland).
 *
 * It builds what all areas share: the map, the player, NPCs, pickups, inspectables,
 * the party, hazards & survival, crawlers & combat, supply keys, checkpoints, death and
 * respawn, the minimap data and the shared dialogue events.
 *
 * Since Milestone 3 it also runs the gold guide trail (G toggles it), offers cutscenes
 * (startCutscene) and handles the shared M3 events: 'memory-restore', 'ending-quiet', 'ending-dawn'.
 *
 * A subclass only fills in a few "hooks":
 *   get mapData()            the map JSON (required)
 *   get actId()              'I', 'II', …
 *   get usesCrawlers()       true if the scene spawns crawlers itself (even with no map groups)
 *   get arrivalFade()        { ms, color: [r, g, b] } of the fade-in (default: short, from black)
 *   onWorldCreate()          scene-specific setup, after everything above exists
 *   onWorldUpdate(t, dt)     scene-specific per-frame logic
 *   onDialogueEvent(name)    dialogue events the base doesn't handle
 *   followerDialogue(id)     which dialogue a party member plays (default 'party-<id>')
 *   inspect(data)            what pressing E on an inspectable does (default: play its dialogue)
 *   onRespawn()              runs while the screen is black after a death (e.g. clear a swarm)
 */
export default class WorldScene extends Phaser.Scene {
  // ---------- hooks (override in subclasses) ----------

  get mapData() {
    throw new Error(`${this.scene.key} must define "get mapData()"`);
  }

  get actId() {
    return 'I';
  }

  get usesCrawlers() {
    return false;
  }

  get arrivalFade() {
    return { ms: FADE_MS, color: [0, 0, 0] };
  }

  onWorldCreate() {}

  onWorldUpdate() {}

  onDialogueEvent(name) {
    console.warn(`${this.scene.key}: unhandled dialogue event "${name}"`);
  }

  followerDialogue(companionId) {
    return `party-${companionId}`;
  }

  inspect(data) {
    Dialogue.start(data.dialogue);
  }

  onRespawn() {}

  // ---------- Phaser lifecycle ----------

  create() {
    // Every field is set here (not in the constructor): Phaser reuses the scene object on restart.
    this.busy = false; // true while respawning or leaving: no zones, keys or deaths
    this.lastToastAt = {}; // toast key → time, for cooldowns
    this.subscriptions = [];
    this.nextMinimapAt = 0;
    this.insideCheckpoint = null;
    this.hasFallen = false; // the 'respawn' narration plays after the first fall here
    this.endingStarted = false;
    this.cutscene = null; // the running Cutscene, if any (see startCutscene)
    GameState.inputLocked = false; // the previous scene may have left it locked

    this.map = buildMap(this, this.mapData);
    this.createPlayer();
    this.createNPCs();
    this.createParty();
    this.createPickups();
    this.createInteractions();
    this.createSurvivalSystems();
    this.createSupplyKeys();
    this.createGuide();

    // The camera smoothly follows the player (lerp 0.12) and stays inside the map bounds.
    this.cameras.main.startFollow(this.player, true, 0.12, 0.12);
    const { ms, color } = this.arrivalFade;
    this.cameras.main.fadeIn(ms, ...color);

    this.registerWorld();
    this.listenToGameState();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.onShutdown, this);

    this.onWorldCreate();
    this.saveArrivalCheckpoint();
    this.publishMinimap();
  }

  update(time, delta) {
    this.player.update(time);
    this.npcs.forEach((npc) => npc.update(time));
    this.party.update(time, delta);
    this.interactions.update(time);

    if (this.hazards) this.hazards.update(time, delta);
    if (this.survival) this.survival.update(time, delta);
    if (this.crawlers) this.crawlers.update(time, delta);
    if (this.combat) this.combat.update(time);

    this.updateSupplyKeys();
    this.updateCheckpoints();
    this.publishPlayer(time);
    this.updateGuide(time); // after publishPlayer: the trail starts at the player's new position

    this.onWorldUpdate(time, delta);
  }

  // ---------- setup ----------

  /** On "Continue" we start at the saved checkpoint of this scene; otherwise at the spawn. */
  startPosition() {
    const saved = GameState.checkpoint;
    if (saved && saved.scene === this.scene.key) return { x: saved.x, y: saved.y };
    return this.mapData.spawn;
  }

  createPlayer() {
    const { x, y } = this.startPosition();
    this.player = new Player(this, x, y, this.mapData.spawn.facing || 'down');
    this.physics.add.collider(this.player, this.map.colliders);
    GameState.playerPos = { x, y, facing: this.player.facing }; // objectiveMarker() needs it from the start
  }

  createNPCs() {
    // Companions who already joined walk with us as followers, not as NPCs.
    this.npcs = (this.mapData.npcs || [])
      .filter((data) => !GameState.inParty(data.id))
      .map((data) => new NPC(this, data));

    // Colliders tell the physics engine which bodies should block each other.
    this.physics.add.collider(this.player, this.npcs);
    this.physics.add.collider(this.npcs, this.map.colliders);
  }

  createParty() {
    // Party spawns a follower for every companion already in GameState.party.
    this.party = new Party(this, this.player);
  }

  createPickups() {
    this.pickups = (this.mapData.pickups || [])
      .filter((data) => !GameState.hasFlag(`picked_${data.id}`)) // already collected
      .map((data) => new Pickup(this, data));
  }

  createInteractions() {
    this.interactions = new Interactions(this, this.player);
    this.npcs.forEach((npc) => this.interactions.addNPC(npc));
    this.pickups.forEach((pickup) => this.interactions.addPickup(pickup));
    (this.mapData.inspectables || []).forEach((data) =>
      this.interactions.addInspectable(data, undefined, () => this.inspect(data)),
    );
    this.addFollowerInteractions();
  }

  /** Makes every party member talkable (call again after someone joins). */
  addFollowerInteractions() {
    this.party.members
      .filter((follower) => !this.interactions.has(follower))
      .forEach((follower) =>
        this.interactions.addFollower(follower, () => this.followerDialogue(follower.companionId)),
      );
  }

  /** Only build the systems this map actually uses. */
  createSurvivalSystems() {
    const crawlerGroups = this.safeCrawlerGroups();
    const needsCrawlers = crawlerGroups.length > 0 || this.usesCrawlers;

    this.hazards = this.mapData.hazards ? new Hazards(this, this.map.hazards) : null;
    this.survival =
      this.hazards || needsCrawlers
        ? new Survival(this, this.player, this.hazards, { onDeath: () => this.onPlayerDeath() })
        : null;

    this.crawlers = needsCrawlers ? new Crawlers(this, this.player, this.map.colliders, this.survival) : null;
    if (this.crawlers) this.crawlers.spawnGroups(crawlerGroups);

    // Combat checks the has_weapon flag itself, so SPACE does nothing until Kael hands you the rebar.
    this.combat = this.crawlers ? new Combat(this, this.player, this.crawlers) : null;
  }

  /** The map's crawler groups, minus any that would start too close to the spawn or an NPC. */
  safeCrawlerGroups() {
    const keepAway = [this.mapData.spawn, ...(this.mapData.npcs || [])];
    return (this.mapData.crawlers || []).filter((group) =>
      keepAway.every((spot) => Phaser.Math.Distance.BetweenPoints(group, spot) >= CRAWLER_SAFE_RADIUS),
    );
  }

  registerWorld() {
    const map = this.mapData;
    GameState.setAct(this.actId);
    GameState.setWorld({
      scene: this.scene.key,
      mapKey: map.image,
      width: map.width,
      height: map.height,
      area: map.area || '',
      markers: this.map.markers,
    });
  }

  // ---------- GameState listeners ----------

  /** Subscribes to a GameState event and remembers it, so shutdown can unsubscribe. */
  listen(event, handler) {
    GameState.on(event, handler, this);
    this.subscriptions.push([event, handler]);
  }

  listenToGameState() {
    this.listen('dialogue:event', this.handleDialogueEvent);
    this.listen('quest:changed', this.refreshPickups);
    this.listen('flags:changed', this.refreshPickups);
  }

  /** GameState outlives this scene, so remove our listeners or they would pile up. */
  onShutdown() {
    this.subscriptions.forEach(([event, handler]) => GameState.off(event, handler, this));
    this.subscriptions = [];
    if (this.guide) this.guide.destroy();
    this.guide = null;
  }

  refreshPickups() {
    this.pickups.forEach((pickup) => pickup.refresh());
  }

  // ---------- dialogue events ----------

  handleDialogueEvent(name) {
    if (name.startsWith('join:')) {
      this.joinCompanion(name.slice('join:'.length));
    } else if (name === 'heal-full') {
      GameState.setHealth(GameState.maxHealth);
      GameState.setToxicity(0);
    } else if (name === 'memory-restore') {
      // The UI draws the full-screen memory overlay.
      GameState.setFlag('memories_restored');
      GameState.emit('memory-restore');
    } else if (name === 'ending-quiet') {
      this.goToEnding('quiet');
    } else if (name === 'ending-dawn') {
      this.goToEnding('dawn');
    } else {
      this.onDialogueEvent(name);
    }
  }

  /** The final choice is made: remember it, fade out and play the Ending scene. */
  goToEnding(kind) {
    if (this.endingStarted) return;
    this.endingStarted = true;
    GameState.setEnding(kind);
    this.leaveTo('Ending', ENDING_FADE_MS, ENDING_FADE_COLORS[kind] || [0, 0, 0]);
  }

  /** The NPC leaves the world and walks with us from now on. */
  joinCompanion(id) {
    if (GameState.inParty(id)) return;

    const npc = this.npcs.find((n) => n.npcId === id);
    const from = npc ? { x: npc.x, y: npc.y } : { x: this.player.x, y: this.player.y };
    if (npc) {
      this.interactions.removeOwner(npc);
      this.npcs = this.npcs.filter((n) => n !== npc);
      npc.destroy();
    }

    this.party.add(id, from.x, from.y);
    GameState.joinParty(id);
    this.addFollowerInteractions();
  }

  // ---------- guide trail (G) ----------

  createGuide() {
    // Guide does A* around the colliders to the current objective marker and draws gold breadcrumbs.
    this.guide = new Guide(this, this.player, this.map.colliderRects, this.map.width, this.map.height);
    this.guideKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.G);
  }

  updateGuide(time) {
    // Read JustDown every frame, so a G pressed during a dialogue doesn't fire afterwards.
    const pressedG = Phaser.Input.Keyboard.JustDown(this.guideKey);
    if (pressedG && !GameState.inputLocked && !this.busy) {
      GameState.setGuideEnabled(!GameState.guideEnabled); // the UI shows a "Guide on/off" toast
      GameState.save(); // the choice is remembered even before the next checkpoint
    }
    this.guide.update(time); // it hides itself while the guide is off or input is locked
  }

  // ---------- supplies (H / R / T) ----------

  createSupplyKeys() {
    this.supplyKeys = this.input.keyboard.addKeys({ heal: 'H', ration: 'R', water: 'T' });
  }

  updateSupplyKeys() {
    const { JustDown } = Phaser.Input.Keyboard;
    // Read every key each frame, so a press made while locked isn't remembered for later.
    const heal = JustDown(this.supplyKeys.heal);
    const ration = JustDown(this.supplyKeys.ration);
    const water = JustDown(this.supplyKeys.water);
    if (GameState.inputLocked || this.busy) return;

    if (heal) this.useSupply(this.healingSupply());
    if (ration) this.useSupply('ration');
    if (water) this.useSupply('water');
  }

  /** H uses a medkit, or a ration if you have no medkit. */
  healingSupply() {
    const { medkit, ration } = GameState.supplies;
    if (medkit === 0 && ration > 0) return 'ration';
    return 'medkit'; // with neither, this shows the "no medkit" toast
  }

  useSupply(id) {
    if (GameState.useSupply(id)) {
      GameState.toast(str(`used-${id}`), 'item');
    } else {
      const name = (items[id] && items[id].name) || id;
      GameState.toast(str('no-supply', { item: name, name }), 'warning');
    }
  }

  // ---------- checkpoints ----------

  /** The spawn (or the checkpoint we continued from) is always the first checkpoint. */
  saveArrivalCheckpoint() {
    const { x, y } = this.startPosition();
    GameState.setCheckpoint(this.scene.key, x, y);
  }

  updateCheckpoints() {
    if (this.busy) return;
    const here = this.map.checkpoints.find((cp) => cp.rect.contains(this.player.x, this.player.y)) || null;

    // Only on entering: standing inside a checkpoint doesn't save every frame.
    if (here && here !== this.insideCheckpoint) {
      GameState.setCheckpoint(this.scene.key, here.respawn.x, here.respawn.y);
    }
    this.insideCheckpoint = here;
  }

  // ---------- death & respawn ----------

  /** Survival calls this once when health reaches 0. */
  onPlayerDeath() {
    if (this.busy) {
      this.survival.reset(); // already fading out (leaving, caught): just clear Survival's death latch
      return;
    }
    this.returnToCheckpoint(
      () => {
        GameState.setHealth(RESPAWN_HEALTH);
        GameState.setToxicity(0);
        if (this.survival) this.survival.reset();
        this.onRespawn();
      },
      () => {
        GameState.emit('respawn');
        GameState.toast(str('respawn-toast'), 'warning');
        if (!this.hasFallen) this.startDialogueWhenFree('respawn', 700);
        this.hasFallen = true;
      },
    );
  }

  /**
   * Fade out, put the player (and party) back at the checkpoint, fade in.
   *   whileDark()  runs while the screen is black (fix stats, reset systems…)
   *   whenDone()   runs once input is unlocked again
   * Used for deaths and for drone catches.
   */
  returnToCheckpoint(whileDark = () => {}, whenDone = () => {}) {
    this.busy = true;
    GameState.inputLocked = true;
    this.player.setVelocity(0, 0);

    const camera = this.cameras.main;
    camera.fadeOut(FADE_MS, 0, 0, 0);
    camera.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      const checkpoint = GameState.checkpoint || this.mapData.spawn;
      this.player.teleportTo(checkpoint.x, checkpoint.y);
      this.party.teleportToPlayer();
      this.snapCamera();
      this.guide.refresh(); // route again from the new spot
      whileDark();

      camera.fadeIn(FADE_MS, 0, 0, 0);
      this.busy = false;
      GameState.inputLocked = false;
      whenDone();
    });
  }

  /** startFollow jumps the camera straight to the player (no slow pan after a teleport). */
  snapCamera() {
    this.cameras.main.startFollow(this.player, true, 0.12, 0.12);
  }

  // ---------- minimap data ----------

  publishPlayer(time) {
    const { x, y, facing } = this.player;
    GameState.playerPos = { x, y, facing };
    if (time >= this.nextMinimapAt) {
      this.nextMinimapAt = time + MINIMAP_EVERY_MS;
      this.publishMinimap();
    }
  }

  publishMinimap() {
    GameState.minimapPoints = [
      ...this.npcs.map((npc) => ({ x: npc.x, y: npc.y, kind: 'npc' })),
      ...this.party.members.map((f) => ({ x: f.x, y: f.y, kind: 'companion' })),
      ...this.pickups.filter((p) => p.isAvailable()).map((p) => ({ x: p.x, y: p.y, kind: 'pickup' })),
    ];
  }

  // ---------- helpers for subclasses ----------

  /**
   * First visit only: act title card, then the intro dialogue after a pause.
   * `flag` remembers that the intro has played. ?skipIntro=1 skips it all.
   */
  playIntro({ flag, title, subtitle, dialogue }) {
    if (GameState.hasFlag(flag)) return;
    GameState.setFlag(flag);
    if (DEV.skipIntro) return;

    GameState.inputLocked = true; // no walking during the title card
    GameState.titleCard(str(title), str(subtitle));

    this.time.delayedCall(INTRO_DELAY_MS, () => {
      if (!Dialogue.start(dialogue)) GameState.inputLocked = false;
    });
  }

  /** Is the player's feet position inside zone `id` of the map? */
  playerInZone(id) {
    const zone = this.map.zones[id];
    return Boolean(zone && zone.contains(this.player.x, this.player.y));
  }

  /** A toast that shows at most once every 3 s (e.g. while bumping into a closed exit). */
  toastWithCooldown(key, kind = 'warning') {
    const now = this.time.now;
    if (now - (this.lastToastAt[key] ?? -Infinity) < ZONE_TOAST_COOLDOWN_MS) return;
    this.lastToastAt[key] = now;
    GameState.toast(str(key), kind);
  }

  /** Shoves the player one short step in direction (dx, dy), e.g. (0, -1) = north. */
  nudgePlayer(dx, dy) {
    this.player.pushBack(dx * PUSH_SPEED, dy * PUSH_SPEED, PUSH_MS);
  }

  /** Pushes the player out of zone `id`, towards the middle of the map. */
  nudgeOutOfZone(id) {
    const zone = this.map.zones[id];
    const dx = this.map.width / 2 - zone.centerX;
    const dy = this.map.height / 2 - zone.centerY;
    // Push along the main axis only, like the barrier does.
    if (Math.abs(dx) > Math.abs(dy)) this.nudgePlayer(Math.sign(dx), 0);
    else this.nudgePlayer(0, Math.sign(dy) || -1);
  }

  /** Starts a dialogue as soon as no other dialogue is running. */
  startDialogueWhenFree(id, delayMs = 0) {
    this.time.delayedCall(delayMs, () => {
      if (!Dialogue.isActive()) {
        Dialogue.start(id);
        return;
      }
      const retry = () => this.startDialogueWhenFree(id, 200);
      GameState.once('dialogue:end', retry);
      this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => GameState.off('dialogue:end', retry));
    });
  }

  /**
   * Fades out (to black, or to `color` [r, g, b]) and starts the next area.
   * The player stands still from now on, even if a closing dialogue unlocks input meanwhile.
   */
  leaveTo(sceneKey, fadeMs = 600, color = [0, 0, 0]) {
    if (this.busy) return;
    this.busy = true;
    GameState.inputLocked = true;
    this.player.stopMoving();
    this.player.scripted = true;

    const camera = this.cameras.main;
    camera.fadeOut(fadeMs, ...color);
    camera.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => this.scene.start(sceneKey));
  }

  // ---------- cutscenes and actors (used by the Act IV–VI scenes) ----------

  /**
   * Starts a scripted sequence. A Cutscene keeps input locked until cs.end():
   *   const cs = this.startCutscene();
   *   await cs.moveTo(actor, x, y); await cs.dialogue('id'); cs.end();
   */
  startCutscene() {
    this.cutscene = new Cutscene(this);
    return this.cutscene;
  }

  /** The party's follower sprites, in join order. */
  get followers() {
    return this.party.members;
  }

  /** The follower for a companion id, or null. */
  follower(id) {
    return this.party.get(id);
  }

  /** The NPC with this id (still standing in the world, not in the party), or null. */
  npc(id) {
    return this.npcs.find((npc) => npc.npcId === id) || null;
  }

  /** A tween you can `await`: resolves when it completes. */
  tweenAsync(config) {
    return new Promise((resolve) => {
      this.tweens.add({ ...config, onComplete: () => resolve() });
    });
  }

  /**
   * Takes a companion out of the walking line, so a cutscene can move them by hand.
   * Returns the Follower (now owned by the caller), or null if they aren't following.
   */
  detachFollower(id) {
    const follower = this.party.detach(id);
    if (follower) this.interactions.removeOwner(follower); // no "talk" prompt on them any more
    return follower || null;
  }
}
