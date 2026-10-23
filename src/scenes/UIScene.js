// UIScene: the HUD, inventory, dialogue box, choices, toasts, alert and title
// card, plus (Milestone 2) the minimap, act trail, supply counters, party row and
// feedback effects. It runs on top of every world scene (camera zoom 1, canvas
// pixels) and is driven by GameState events (contract §7.3 and M2 §4); the
// minimap also reads GameState.playerPos / minimapPoints every frame.
// Milestone 3 adds the guide route on the minimap (GameState.guidePath, read every
// frame), the relay hold meter, the wave label, the memory-restore overlay and the
// beacon alarm. While the 'Ending' scene runs, the HUD is hidden and only the
// dialogue box (plus toasts / title cards) is used.
// The Signal mini-game scene is the one scene allowed above it.
//
// Input (contract §7.4):
//   - Dialogue keys are only handled while a dialogue is active.
//   - Confirm presses are ignored for 150 ms after 'dialogue:start' / 'dialogue:line'
//     (the E that opened the dialogue reaches both scenes).
//   - First confirm while typing completes the line; the next calls Dialogue.advance().
//   - I / TAB toggles the inventory panel at any time.

import Phaser from 'phaser';
import { GameState } from '../systems/GameState.js';
import { Dialogue } from '../systems/Dialogue.js';
import items from '../data/items.json';
import strings from '../data/strings.json';
import { SUPPLIES } from '../ui/uiLayout.js';
import { Hud } from '../ui/Hud.js';
import { SupplyCounters } from '../ui/Supplies.js';
import { headTexture } from '../ui/PartyRow.js';
import { Minimap } from '../ui/Minimap.js';
import { ActTrail } from '../ui/ActTrail.js';
import { FeedbackFx } from '../ui/Feedback.js';
import { InventoryBar } from '../ui/InventoryBar.js';
import { InventoryPanel } from '../ui/InventoryPanel.js';
import { DialogueBox } from '../ui/DialogueBox.js';
import { ChoiceList } from '../ui/ChoiceList.js';
import { Toasts } from '../ui/Toasts.js';
import { AlertOverlay, TitleCard } from '../ui/Overlays.js';
import { HoldMeter, WaveLabel } from '../ui/FinaleHud.js';
import { MemoryOverlay } from '../ui/MemoryOverlay.js';

const CONFIRM_GUARD_MS = 150;
const OBJECTIVE_POLL_MS = 250; // the objective marker is re-read this often (and on quest/world changes)
const OVERLAY_SCENE = 'Signal'; // drawn above the UI while it runs
const CINEMATIC_SCENE = 'Ending'; // the HUD is hidden while it runs (only the dialogue box shows)
const BEACON_ALERT_MS = 3400;
const KEYS = Phaser.Input.Keyboard.KeyCodes;
const CONFIRM_KEYS = [KEYS.E, KEYS.SPACE, KEYS.ENTER];
const UP_KEYS = [KEYS.W, KEYS.UP];
const DOWN_KEYS = [KEYS.S, KEYS.DOWN];
const NUMBER_KEYS = [
  [KEYS.ONE, KEYS.NUMPAD_ONE],
  [KEYS.TWO, KEYS.NUMPAD_TWO],
  [KEYS.THREE, KEYS.NUMPAD_THREE],
  [KEYS.FOUR, KEYS.NUMPAD_FOUR],
];
const INVENTORY_KEYS = [KEYS.I, KEYS.TAB];
// H / R / T → supply id. The world scene uses the supply; the UI only nudges an empty slot.
const SUPPLY_KEYS = Object.fromEntries(SUPPLIES.order.map(({ id, key }) => [KEYS[key], id]));

// Wall-clock ms; used for the confirm guard so it doesn't depend on scene update order.
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const currentParty = () => (Array.isArray(GameState.party) ? GameState.party.slice() : []);

// strings.json text with an English fallback (some keys are added by the story task).
const text = (key, fallback) => (typeof strings[key] === 'string' && strings[key]) || fallback;

// M3: the guide trail is on unless GameState says otherwise.
const guideEnabled = () => GameState.guideEnabled !== false;

// "mira" → "Mira joined the party" (strings.json 'party-joined' uses {name}).
function partyJoinedText(id) {
  const name = String(id).charAt(0).toUpperCase() + String(id).slice(1);
  const template = typeof strings['party-joined'] === 'string' ? strings['party-joined'] : '{name} joined the party';
  return template.replace(/\{name\}/g, name);
}

export default class UIScene extends Phaser.Scene {
  constructor() {
    super('UI');
  }

  create() {
    this.subscriptions = [];
    this.dialogueActive = false;
    this.confirmBlockedUntil = 0;
    // Phaser re-dispatches every queued key event of the current frame whenever a new
    // key event arrives, so fast presses can reach 'keydown' more than once. Each native
    // event is handled only once.
    this.handledKeyEvents = new WeakSet();

    this.knownParty = [];
    this.objectiveTimer = 0;
    this.cinematic = false;
    this.guideOn = guideEnabled();

    // Built bottom-to-top; each piece also sets its own depth (see DEPTH in uiStyle.js).
    this.feedback = new FeedbackFx(this);
    this.hud = new Hud(this);
    this.supplies = new SupplyCounters(this);
    this.minimap = new Minimap(this, text('guide-hint', '[G] Guide'));
    this.actTrail = new ActTrail(this);
    this.inventoryBar = new InventoryBar(this);
    this.inventoryPanel = new InventoryPanel(this, items);
    this.holdMeter = new HoldMeter(this, text('hold-label', 'HOLDING RELAY'), text('relay-secured', 'RELAY SECURED'));
    this.waveLabel = new WaveLabel(this, text('wave-label', 'SWARM · WAVE {n}'));
    this.titleCard = new TitleCard(this);
    this.memoryOverlay = new MemoryOverlay(this);
    this.choices = new ChoiceList(this);
    this.dialogueBox = new DialogueBox(this);
    this.toasts = new Toasts(this);
    this.alertOverlay = new AlertOverlay(this);

    this.input.keyboard.addCapture([KEYS.SPACE, KEYS.TAB, KEYS.UP, KEYS.DOWN]);
    this.input.keyboard.on('keydown', this.onKeyDown, this);

    this.subscribeToGameState();
    this.syncFromGameState();

    // Clean up on shutdown/destroy so a restarted UIScene never doubles its handlers.
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.cleanup, this);
    this.events.once(Phaser.Scenes.Events.DESTROY, this.cleanup, this);

    this.scene.bringToTop();
  }

  update(time, delta) {
    this.dialogueBox.update(delta);
    this.minimap.update(time, delta, GameState.playerPos, GameState.minimapPoints, GameState.guidePath);
    this.objectiveTimer -= delta;
    if (this.objectiveTimer <= 0) this.refreshObjective();
    this.feedback.update(time);
    this.holdMeter.setStacked(this.feedback.scan.shown); // never overlap the scan meter
    this.holdMeter.update(time);
    this.memoryOverlay.update(time, delta);
    this.updateCinematic();
    this.keepOnTop();
  }

  // The Ending has no HUD: hide it while that scene runs (it is checked every
  // frame because the UI may be launched before or after the Ending starts).
  updateCinematic() {
    const cinematic = Boolean(this.scene.isActive(CINEMATIC_SCENE)); // null if there's no such scene
    if (cinematic === this.cinematic) return;
    this.cinematic = cinematic;
    this.hud.setHidden(cinematic);
    this.supplies.container.setAlpha(cinematic ? 0 : 1);
    this.inventoryBar.container.setAlpha(cinematic ? 0 : 1);
    if (cinematic) {
      if (this.inventoryPanel.isOpen) this.inventoryPanel.close();
      this.minimap.setVisible(false);
      this.actTrail.setVisible(false);
      this.feedback.setDetection(0);
      this.feedback.setToxicity(0);
      this.holdMeter.hide();
      this.waveLabel.hide();
    } else {
      this.feedback.setToxicity(GameState.toxicity);
      this.applyWorld(GameState.world || null);
    }
  }

  // Stay above any world scene that gets started later, but below the Signal mini-game.
  keepOnTop() {
    const scenes = this.scene.manager.scenes;
    let coveredByWorld = false;
    for (let i = scenes.indexOf(this) + 1; i < scenes.length; i++) {
      if (scenes[i].sys.settings.key !== OVERLAY_SCENE) coveredByWorld = true;
    }
    if (!coveredByWorld) return;
    this.scene.bringToTop();
    if (this.scene.isActive(OVERLAY_SCENE)) this.scene.bringToTop(OVERLAY_SCENE);
  }

  // ---------------------------------------------------------------------------
  // GameState wiring

  listen(event, handler) {
    const bound = handler.bind(this);
    GameState.on(event, bound);
    this.subscriptions.push([event, bound]);
  }

  subscribeToGameState() {
    this.listen('stats:changed', this.onStatsChanged);
    this.listen('quest:changed', this.onQuestChanged);
    this.listen('inventory:changed', this.onInventoryChanged);
    this.listen('item:added', this.onItemAdded);
    this.listen('dialogue:start', this.onDialogueStart);
    this.listen('dialogue:line', this.onDialogueLine);
    this.listen('dialogue:choices', this.onDialogueChoices);
    this.listen('dialogue:end', this.onDialogueEnd);
    this.listen('toast', this.onToast);
    this.listen('alert', this.onAlert);
    this.listen('title-card', this.onTitleCard);
    // Milestone 2
    this.listen('act:changed', this.onActChanged);
    this.listen('world:changed', this.onWorldChanged);
    this.listen('party:changed', this.onPartyChanged);
    this.listen('supplies:changed', this.onSuppliesChanged);
    this.listen('damage', this.onDamage);
    this.listen('detection', this.onDetection);
    this.listen('respawn', this.onRespawn);
    // Milestone 3
    this.listen('guide:changed', this.onGuideChanged);
    this.listen('hold', this.onHold);
    this.listen('wave', this.onWave);
    this.listen('memory-restore', this.onMemoryRestore);
    this.listen('beacon', this.onBeacon);
  }

  cleanup() {
    for (const [event, bound] of this.subscriptions) GameState.off(event, bound);
    this.subscriptions = [];
    if (this.minimap) this.minimap.destroy(); // its mask shape isn't on the display list
    if (this.memoryOverlay) this.memoryOverlay.stop();
    if (this.input && this.input.keyboard) this.input.keyboard.off('keydown', this.onKeyDown, this);
    this.events.off(Phaser.Scenes.Events.SHUTDOWN, this.cleanup, this);
    this.events.off(Phaser.Scenes.Events.DESTROY, this.cleanup, this);
  }

  // Initial state (the UI may be launched after GameState already changed).
  syncFromGameState() {
    this.hud.setStats(
      {
        health: GameState.health,
        maxHealth: GameState.maxHealth,
        toxicity: GameState.toxicity,
        showToxicity: GameState.showToxicity,
      },
      false,
    );
    this.inventoryBar.setItems(GameState.inventory);
    this.refreshQuest(false);
    this.feedback.setToxicity(GameState.toxicity);
    this.actTrail.setAct(GameState.act, { animate: false });
    this.applyWorld(GameState.world || null);
    this.syncParty();
    this.supplies.setSupplies(GameState.supplies, false);
    this.guideOn = guideEnabled();
    this.minimap.setGuideEnabled(this.guideOn);
  }

  // Party row without pop-ins or toasts (initial state, new area, load or reset).
  syncParty() {
    this.knownParty = currentParty();
    this.hud.setParty(this.knownParty);
  }

  applyWorld(world) {
    this.minimap.setWorld(world);
    this.actTrail.setVisible(Boolean(world));
    this.actTrail.setArea(world && world.area);
    this.refreshObjective();
  }

  refreshObjective() {
    this.objectiveTimer = OBJECTIVE_POLL_MS;
    const marker = typeof GameState.objectiveMarker === 'function' ? GameState.objectiveMarker() : null;
    this.minimap.setObjective(marker);
  }

  refreshQuest(pulse = true) {
    const info = typeof GameState.questInfo === 'function' ? GameState.questInfo() : null;
    this.hud.setQuest(info, { pulse });
  }

  onStatsChanged(stats) {
    this.hud.setStats(stats || {}, true);
    this.feedback.setToxicity(stats ? stats.toxicity : GameState.toxicity);
  }

  onQuestChanged() {
    this.refreshQuest(true);
    this.refreshObjective(); // markers are per quest stage
  }

  onInventoryChanged(inventory) {
    const ids = Array.isArray(inventory) ? inventory : GameState.inventory;
    this.inventoryBar.setItems(ids);
    this.inventoryPanel.refresh(ids);
    this.refreshQuest(true); // objective may contain {artifacts}
  }

  onItemAdded(id) {
    // Re-sync first: 'inventory:changed' may arrive before or after this event.
    this.inventoryBar.setItems(GameState.inventory);
    this.inventoryBar.flash(id);
    const name = (items[id] && items[id].name) || id;
    const iconKey = this.textures.exists(`item-${id}-sm`) ? `item-${id}-sm` : `item-${id}`;
    this.toasts.push(`Obtained: ${name}`, 'item', iconKey);
  }

  onDialogueStart() {
    this.dialogueActive = true;
    this.blockConfirm();
    this.choices.hide();
    this.dialogueBox.open();
  }

  onDialogueLine(line) {
    this.dialogueActive = true;
    this.blockConfirm();
    this.choices.hide();
    this.dialogueBox.showLine(line || {});
  }

  onDialogueChoices(payload) {
    const labels = ((payload && payload.choices) || []).map((c) => (c && c.text) || '');
    if (labels.length === 0) return;
    this.dialogueActive = true;
    this.blockConfirm(); // not required by the contract, but stops a held key skipping the menu
    this.dialogueBox.open();
    this.dialogueBox.finishLine();
    this.dialogueBox.stopArrow();
    this.choices.show(labels);
  }

  onDialogueEnd() {
    this.dialogueActive = false;
    this.choices.hide();
    this.dialogueBox.close();
  }

  onToast(payload) {
    if (!payload) return;
    this.toasts.push(payload.text, payload.kind || 'info');
  }

  onAlert(payload) {
    this.alertOverlay.show(payload || {});
  }

  onTitleCard(payload) {
    this.titleCard.show(payload || {});
  }

  // ---------------------------------------------------------------------------
  // Milestone 2 events

  onActChanged(id) {
    this.actTrail.setAct(id !== undefined ? id : GameState.act, { animate: true });
  }

  // info: { scene, mapKey, width, height, area } or null.
  onWorldChanged(info) {
    this.applyWorld(info !== undefined ? info : GameState.world || null);
    // A new area can follow a load or a reset: quietly re-sync the counters.
    this.syncParty();
    this.supplies.setSupplies(GameState.supplies, false);
  }

  onPartyChanged(party) {
    const ids = Array.isArray(party) ? party.slice() : currentParty();
    const fresh = ids.filter((id) => !this.knownParty.includes(id));
    this.knownParty = ids;
    // Companions join one at a time; several at once means a load/reset, so no fanfare.
    const joined = fresh.length === 1 ? fresh : [];
    this.hud.setParty(ids, joined);
    joined.forEach((id) => this.toasts.push(partyJoinedText(id), 'party', headTexture(this, id)));
    this.refreshQuest(true); // the objective may contain {party}
  }

  onSuppliesChanged(supplies) {
    this.supplies.setSupplies(supplies || GameState.supplies, true);
  }

  onDamage(payload) {
    this.feedback.damage(payload);
    this.hud.shakeHealth();
  }

  // level 0..1 (a { level } object is accepted too).
  onDetection(level) {
    this.feedback.setDetection(level && typeof level === 'object' ? level.level : level);
  }

  onRespawn() {
    this.feedback.respawn();
  }

  // ---------------------------------------------------------------------------
  // Milestone 3 events

  // enabled: bool (G toggles the guide trail). Only a real change toasts.
  onGuideChanged(enabled) {
    const on = enabled === undefined ? guideEnabled() : Boolean(enabled);
    if (on === this.guideOn) return;
    this.guideOn = on;
    this.minimap.setGuideEnabled(on, true);
    if (!this.cinematic) this.toasts.push(on ? text('guide-on', 'Guide on') : text('guide-off', 'Guide off'), 'info', null, 'guide');
  }

  // { id, progress 0..1, active } from a relay HoldPoint.
  onHold(payload) {
    if (this.cinematic) return;
    this.holdMeter.onHold(payload);
  }

  // { n }: a new swarm wave.
  onWave(payload) {
    if (this.cinematic) return;
    this.waveLabel.show(payload);
  }

  onMemoryRestore() {
    this.memoryOverlay.show(text('memory-title', 'MEMORY RESTORED'), text('memory-sub', 'It all comes back at once.'));
  }

  // The beacon alarm: the red alert plus a pulsing red screen edge.
  onBeacon() {
    this.alertOverlay.show({
      title: text('beacon-title', 'BEACON ACTIVE'),
      subtitle: text('beacon-sub', 'THE SWARM IS COMING'),
      duration: BEACON_ALERT_MS,
      edgePulse: true,
    });
  }

  // ---------------------------------------------------------------------------
  // Input

  blockConfirm() {
    this.confirmBlockedUntil = now() + CONFIRM_GUARD_MS;
  }

  confirmBlocked() {
    return now() < this.confirmBlockedUntil;
  }

  onKeyDown(event) {
    if (this.handledKeyEvents.has(event)) return;
    this.handledKeyEvents.add(event);
    if (this.scene.isActive(OVERLAY_SCENE)) return; // the Signal mini-game owns the keyboard
    const code = event.keyCode;

    if (INVENTORY_KEYS.includes(code)) {
      if (!event.repeat && !this.cinematic) this.inventoryPanel.toggle(GameState.inventory);
      return;
    }

    const supplyId = SUPPLY_KEYS[code];
    if (supplyId && !this.dialogueActive && !GameState.inputLocked && !event.repeat) {
      if (!this.cinematic) this.supplies.nudgeIfEmpty(supplyId);
      return;
    }

    // Everything else belongs to the dialogue; world scenes own the keys otherwise.
    if (!this.dialogueActive) return;

    if (this.choices.isVisible) {
      if (UP_KEYS.includes(code)) {
        this.choices.move(-1);
        return;
      }
      if (DOWN_KEYS.includes(code)) {
        this.choices.move(1);
        return;
      }
      const number = NUMBER_KEYS.findIndex((codes) => codes.includes(code));
      if (number >= 0) {
        if (number < this.choices.count && !event.repeat && !this.confirmBlocked()) this.pickChoice(number);
        return;
      }
    }

    if (CONFIRM_KEYS.includes(code) && !event.repeat) this.onConfirm();
  }

  onConfirm() {
    if (!this.dialogueActive || !Dialogue.isActive()) return;
    if (this.confirmBlocked()) return;

    if (this.choices.isVisible) {
      this.pickChoice(this.choices.index);
    } else if (this.dialogueBox.isTyping()) {
      this.dialogueBox.finishLine();
    } else if (this.dialogueBox.hasLine) {
      Dialogue.advance();
    }
  }

  pickChoice(index) {
    if (!Dialogue.isActive()) return;
    // Hide first: choose() may synchronously emit the next line or choices.
    this.choices.hide();
    Dialogue.choose(index);
  }
}
