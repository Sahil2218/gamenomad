import Phaser from 'phaser';
import items from '../data/items.json';
import quests from '../data/quests.json';
import { DEV } from './devFlags.js';

// The three artifacts the player must collect in Village 07.
const ARTIFACT_IDS = ['journal', 'map', 'shard'];

// Consumables are counted (you can carry several), not kept in the inventory list.
const SUPPLY_IDS = ['medkit', 'ration', 'water'];

// What using one supply does (contract M2 §8).
const SUPPLY_EFFECTS = {
  medkit: { heal: 50 },
  ration: { heal: 20 },
  water: { toxicity: -40 },
};

const PARTY_SIZE = 5; // the five companions
const ENDINGS = ['dawn', 'quiet'];
const SAVE_KEY = 'nomad-save-v1';
const SAVE_VERSION = 1;

// Dialogue data may give a single string or an array; treat both as an array.
function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function emptySupplies() {
  return { medkit: 0, ration: 0, water: 0 };
}

/**
 * GameState holds everything that must survive scene changes: flags, inventory,
 * quest stage, player stats, party, supplies, checkpoint and the save file.
 *
 * It extends Phaser's EventEmitter, so other code can subscribe to changes:
 *   GameState.on('quest:changed', (stageId) => { ... });
 * The UI scene never reads world scenes directly; it just listens to these events.
 */
class GameStateManager extends Phaser.Events.EventEmitter {
  constructor() {
    super();
    // The guide trail is a player preference: on by default, kept across reset() and saved.
    this._guideEnabled = true;
    this.reset();
  }

  /** Start a fresh game. */
  reset() {
    this._flags = new Set();
    this._inventory = [];
    this._quest = quests.start;
    this._maxHealth = 100;
    this._health = 100;
    this._toxicity = 0;
    this._showToxicity = false;

    this._act = 'I';
    this._world = null;
    this._party = [];
    this._supplies = emptySupplies();
    this._checkpoint = null;
    this._ending = null; // 'dawn' | 'quiet' once the final choice is made

    // Plain fields the world scene overwrites (no events, read by the minimap).
    this.playerPos = { x: 0, y: 0, facing: 'down' };
    this.minimapPoints = [];
    // The guide trail's route, [{ x, y }] (written by world/Guide.js, drawn by the minimap).
    this.guidePath = [];

    // ?god=1 survives a reset, so "New game" from the menu stays in god mode.
    this.godMode = DEV.god;

    // True while a dialogue or cutscene is on screen. World scenes check this
    // and ignore movement / interaction while it is set.
    this.inputLocked = false;

    // Let any listeners (the UI) redraw from the new state.
    this.emitEverything();
  }

  /** Re-announces the whole state, e.g. after reset() or loadSave(). */
  emitEverything() {
    this.emit('inventory:changed', this.inventory);
    this.emit('quest:changed', this._quest);
    this.emit('act:changed', this._act);
    this.emit('world:changed', this.world);
    this.emit('party:changed', this.party);
    this.emit('supplies:changed', this.supplies);
    // No 'guide:changed' here: the UI toasts on it, and a reset isn't a toggle.
    this.emitStats();
  }

  // ---------- Flags ----------

  hasFlag(name) {
    return this._flags.has(name);
  }

  setFlag(name) {
    if (this._flags.has(name)) return;
    this._flags.add(name);
    this.emit('flags:changed', name, true);
  }

  clearFlag(name) {
    if (!this._flags.has(name)) return;
    this._flags.delete(name);
    this.emit('flags:changed', name, false);
  }

  /** All flags whose name starts with `prefix`, e.g. flagsStartingWith('clue_'). */
  flagsStartingWith(prefix) {
    return [...this._flags].filter((name) => name.startsWith(prefix));
  }

  /** How many pieces of evidence (distinct clue_* flags) the player has found. */
  clueCount() {
    return this.flagsStartingWith('clue_').length;
  }

  // ---------- Inventory ----------

  /** A copy of the held item ids, in pickup order. Changing it changes nothing. */
  get inventory() {
    return [...this._inventory];
  }

  hasItem(id) {
    if (SUPPLY_IDS.includes(id)) return this._supplies[id] > 0;
    return this._inventory.includes(id);
  }

  /**
   * Adds an item (each id is held at most once). Returns true if it was added.
   * Supplies (medkit, ration, water) are counted in `supplies` instead.
   */
  addItem(id) {
    if (SUPPLY_IDS.includes(id)) {
      this.addSupply(id, 1);
      this.emit('item:added', id); // the UI still shows "Obtained: Medkit"
      return true;
    }

    if (this.hasItem(id)) return false;
    if (!items[id]) console.warn(`GameState.addItem: "${id}" is not in items.json`);

    this._inventory.push(id);
    // inventory:changed first, so the UI slot exists before item:added flashes it.
    this.emit('inventory:changed', this.inventory);
    this.emit('item:added', id);
    return true;
  }

  removeItem(id) {
    if (SUPPLY_IDS.includes(id)) return this.takeSupply(id);

    const index = this._inventory.indexOf(id);
    if (index === -1) return false;

    this._inventory.splice(index, 1);
    this.emit('inventory:changed', this.inventory);
    return true;
  }

  artifactCount() {
    return ARTIFACT_IDS.filter((id) => this.hasItem(id)).length;
  }

  // ---------- Supplies ----------

  /** A copy, e.g. { medkit: 1, ration: 0, water: 2 }. */
  get supplies() {
    return { ...this._supplies };
  }

  addSupply(id, n = 1) {
    if (!SUPPLY_IDS.includes(id)) {
      console.warn(`GameState.addSupply: "${id}" is not a supply`);
      return false;
    }
    this._supplies[id] += n;
    this.emit('supplies:changed', this.supplies);
    return true;
  }

  /** Uses one supply and applies its effect. Returns false if there is none left. */
  useSupply(id) {
    if (!this.takeSupply(id)) return false;

    const effect = SUPPLY_EFFECTS[id];
    if (effect.heal) this.heal(effect.heal);
    if (effect.toxicity) this.setToxicity(this._toxicity + effect.toxicity);
    return true;
  }

  /** Removes one supply without using it. */
  takeSupply(id) {
    if (!SUPPLY_IDS.includes(id) || this._supplies[id] <= 0) return false;
    this._supplies[id] -= 1;
    this.emit('supplies:changed', this.supplies);
    return true;
  }

  // ---------- Quest ----------

  get quest() {
    return this._quest;
  }

  setQuest(stageId) {
    if (stageId === this._quest) return;
    if (!quests.stages[stageId]) console.warn(`GameState.setQuest: "${stageId}" is not in quests.json`);

    this._quest = stageId;
    this.emit('quest:changed', stageId);
  }

  /**
   * The current stage, with placeholders filled in:
   *   "{artifacts}"         → "2/3"  (journal / map / shard held)
   *   "{party}"             → "1/5"  (companions in the party)
   *   "{n:archive_/3}"      → "1/3"  (flags whose name starts with "archive_", out of 3)
   */
  questInfo() {
    const stage = quests.stages[this._quest] || {};
    const objective = (stage.objective || '')
      .replace(/\{artifacts\}/g, `${this.artifactCount()}/3`)
      .replace(/\{party\}/g, `${this._party.length}/${PARTY_SIZE}`)
      .replace(/\{n:([^/}]+)\/(\d+)\}/g, (match, prefix, total) => `${this.flagsStartingWith(prefix).length}/${total}`);
    return { id: this._quest, title: stage.title || this._quest, objective };
  }

  // ---------- Acts & world ----------

  get act() {
    return this._act;
  }

  setAct(id) {
    if (id === this._act) return;
    this._act = id;
    this.emit('act:changed', id);
  }

  /** { scene, mapKey, width, height, area, markers } of the current world scene, or null. */
  get world() {
    return this._world ? { ...this._world } : null;
  }

  setWorld(info) {
    this._world = info ? { ...info } : null;
    this.emit('world:changed', this.world);
  }

  /**
   * Where the minimap (and the guide trail) should point for the current quest stage, or null.
   * A map's marker for a stage is one point or a list of points, each with an optional `if`
   * condition, e.g. "explore": [{ x, y, if: { notFlags: ['picked_journal'] } }, …].
   * We return the passing point nearest to the player.
   */
  objectiveMarker() {
    const markers = (this._world && this._world.markers) || {};
    const candidates = toArray(markers[this._quest]).filter((point) => point && this.check(point.if));
    if (candidates.length === 0) return null;

    const { x: px, y: py } = this.playerPos;
    const nearest = candidates.reduce((best, point) =>
      Phaser.Math.Distance.Between(px, py, point.x, point.y) < Phaser.Math.Distance.Between(px, py, best.x, best.y)
        ? point
        : best,
    );
    return { x: nearest.x, y: nearest.y };
  }

  // ---------- Party ----------

  /** A copy of the joined companion ids, in join order. */
  get party() {
    return [...this._party];
  }

  inParty(id) {
    return this._party.includes(id);
  }

  joinParty(id) {
    if (this.inParty(id)) return false;
    this._party.push(id);
    this.emit('party:changed', this.party);
    return true;
  }

  /** A companion leaves the party for good (Eli, at the white cloud). */
  leaveParty(id) {
    if (!this.inParty(id)) return false;
    this._party = this._party.filter((member) => member !== id);
    this.emit('party:changed', this.party);
    return true;
  }

  // ---------- Ending & guide ----------

  /** 'dawn' (reprogram) | 'quiet' (destroy) | null before the final choice. */
  get ending() {
    return this._ending;
  }

  setEnding(kind) {
    if (kind !== null && !ENDINGS.includes(kind)) console.warn(`GameState.setEnding: unknown ending "${kind}"`);
    this._ending = kind;
  }

  /** Is the gold guide trail switched on? (G toggles it.) */
  get guideEnabled() {
    return this._guideEnabled;
  }

  setGuideEnabled(on) {
    const value = Boolean(on);
    if (value === this._guideEnabled) return;
    this._guideEnabled = value;
    this.emit('guide:changed', value);
  }

  // ---------- Stats ----------

  get health() {
    return this._health;
  }

  get maxHealth() {
    return this._maxHealth;
  }

  get toxicity() {
    return this._toxicity;
  }

  get showToxicity() {
    return this._showToxicity;
  }

  setHealth(value) {
    this._health = Phaser.Math.Clamp(value, 0, this._maxHealth);
    this.emitStats();
  }

  setToxicity(value) {
    this._toxicity = Phaser.Math.Clamp(value, 0, 100);
    this.emitStats();
  }

  setShowToxicity(show) {
    this._showToxicity = Boolean(show);
    this.emitStats();
  }

  /** Lowers health (ignored in god mode). `source` is e.g. 'fire' or 'crawler'. */
  damage(amount, source = null) {
    if (this.godMode || amount <= 0) return;
    this.setHealth(this._health - amount);
    this.emit('damage', { amount, source });
  }

  heal(amount) {
    this.setHealth(this._health + amount);
  }

  emitStats() {
    this.emit('stats:changed', {
      health: this._health,
      maxHealth: this._maxHealth,
      toxicity: this._toxicity,
      showToxicity: this._showToxicity,
    });
  }

  // ---------- Checkpoints & saving ----------

  /** { scene, x, y } where the player comes back after falling, or null. */
  get checkpoint() {
    return this._checkpoint ? { ...this._checkpoint } : null;
  }

  setCheckpoint(scene, x, y) {
    this._checkpoint = { scene, x, y };
    this.save();
  }

  /** Writes the game to the browser's localStorage. */
  save() {
    const data = {
      version: SAVE_VERSION,
      act: this._act,
      world: this._world,
      party: this._party,
      supplies: this._supplies,
      flags: [...this._flags],
      inventory: this._inventory,
      quest: this._quest,
      health: this._health,
      toxicity: this._toxicity,
      showToxicity: this._showToxicity,
      checkpoint: this._checkpoint,
      ending: this._ending,
      guideEnabled: this._guideEnabled,
    };
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
      return true;
    } catch (error) {
      console.warn('GameState.save failed', error);
      return false;
    }
  }

  hasSave() {
    return readSave() !== null;
  }

  /** Replaces the current state with the saved one. Returns false if there is no valid save. */
  loadSave() {
    const data = readSave();
    if (!data) return false;

    this._flags = new Set(toArray(data.flags));
    this._inventory = toArray(data.inventory);
    this._quest = quests.stages[data.quest] ? data.quest : quests.start;
    this._health = data.health > 0 ? Math.min(data.health, this._maxHealth) : 60;
    this._toxicity = Phaser.Math.Clamp(data.toxicity || 0, 0, 100);
    this._showToxicity = Boolean(data.showToxicity);
    this._act = data.act || 'I';
    this._world = data.world || null;
    this._party = toArray(data.party);
    this._supplies = { ...emptySupplies(), ...data.supplies };
    this._checkpoint = data.checkpoint || null;
    // Added in Milestone 3: older saves don't have these, so fall back to the defaults.
    this._ending = ENDINGS.includes(data.ending) ? data.ending : null;
    this._guideEnabled = data.guideEnabled !== false;
    this.guidePath = [];
    this.inputLocked = false;

    this.emitEverything();
    return true;
  }

  clearSave() {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch (error) {
      console.warn('GameState.clearSave failed', error);
    }
  }

  // ---------- Dialogue helpers ----------

  /**
   * Evaluates a dialogue `if` object. Every field is optional; all present fields must pass.
   * Example: { flags: ['met_mayor'], notItems: ['map'], quest: ['explore', 'confront'] }
   *   party: ['mira']   all of these companions are in the party
   *   notParty: ['eli'] none of them are
   *   clues: 14         at least 14 clue_* flags are set
   *   notClues: 14      fewer than 14 are set
   */
  check(condition) {
    if (!condition) return true;

    const { flags, notFlags, items: needItems, notItems, quest, party, notParty, clues, notClues } = condition;

    if (!toArray(flags).every((name) => this.hasFlag(name))) return false;
    if (toArray(notFlags).some((name) => this.hasFlag(name))) return false;
    if (!toArray(needItems).every((id) => this.hasItem(id))) return false;
    if (toArray(notItems).some((id) => this.hasItem(id))) return false;
    if (quest !== undefined && !toArray(quest).includes(this._quest)) return false;
    if (!toArray(party).every((id) => this.inParty(id))) return false;
    if (toArray(notParty).some((id) => this.inParty(id))) return false;
    // Number() also accepts a number written as a string, e.g. "14".
    if (clues !== undefined && this.clueCount() < Number(clues)) return false;
    if (notClues !== undefined && this.clueCount() >= Number(notClues)) return false;

    return true;
  }

  /** Runs a dialogue `effects` object. `event` may be one name or a list of names. */
  applyEffects(effects) {
    if (!effects) return;

    toArray(effects.setFlags).forEach((name) => this.setFlag(name));
    toArray(effects.giveItems).forEach((id) => this.addItem(id));
    toArray(effects.removeItems).forEach((id) => this.removeItem(id));
    if (effects.setQuest) this.setQuest(effects.setQuest);
    toArray(effects.event).forEach((name) => this.emit('dialogue:event', name));
  }

  // ---------- Messages for the UI scene ----------

  /** kind: 'info' | 'item' | 'warning' */
  toast(text, kind = 'info') {
    this.emit('toast', { text, kind });
  }

  /** Full-screen red warning flash. */
  alert(title, subtitle, duration = 2500) {
    this.emit('alert', { title, subtitle, duration });
  }

  /** Big centred act title that fades in and out. */
  titleCard(title, subtitle) {
    this.emit('title-card', { title, subtitle });
  }
}

/** The parsed save, or null if there is none (or it is from another version). */
function readSave() {
  try {
    const data = JSON.parse(localStorage.getItem(SAVE_KEY));
    return data && data.version === SAVE_VERSION ? data : null;
  } catch {
    return null;
  }
}

// One shared instance for the whole game (a "singleton").
export const GameState = new GameStateManager();
