import dialogueData from '../data/dialogue.json';
import { GameState } from './GameState.js';

// After a dialogue ends we wait a moment before unlocking input, so the same
// E press that closed the dialogue can't immediately open it again.
const UNLOCK_DELAY_MS = 150;

/**
 * Dialogue runs conversations from dialogue.json. It never draws anything:
 * it emits events on GameState and the UI scene draws them.
 *
 *   dialogue:start → dialogue:line (one per line) → [dialogue:choices] → dialogue:end
 *
 * A dialogue id maps to a list of variants. The first variant whose `if` passes is played.
 */
class DialogueRunner {
  constructor() {
    this.rootId = null; // id passed to start(); reported in dialogue:start / dialogue:end
    this.variant = null; // the variant being played (null when idle)
    this.lineIndex = -1;
    this.waitingForChoice = false;
    this.unlockTimer = null;
  }

  /** Starts a conversation. Returns false (and warns) if it can't. */
  start(id) {
    if (this.isActive()) {
      console.warn(`Dialogue.start("${id}") ignored: "${this.rootId}" is still running`);
      return false;
    }
    return this.play(id, false);
  }

  isActive() {
    return this.variant !== null;
  }

  /** Called by the UI when the player confirms the current line. */
  advance() {
    if (!this.isActive() || this.waitingForChoice) return;
    this.showNextLine();
  }

  /** Called by the UI while choices are on screen. */
  choose(index) {
    if (!this.waitingForChoice) return;

    const choice = this.variant.choices[index];
    if (!choice) return;

    this.waitingForChoice = false;
    GameState.applyEffects(choice.effects);

    // A `next` continuation carries on in the same conversation (no dialogue:end in between).
    if (choice.next && this.play(choice.next, true)) return;
    this.finish();
  }

  // ---------- internals ----------

  /** Plays dialogue `id`. A continuation reuses the open conversation. */
  play(id, isContinuation) {
    const variant = this.pickVariant(id);
    if (!variant) return false;

    clearTimeout(this.unlockTimer);
    GameState.inputLocked = true;

    this.variant = variant;
    this.lineIndex = -1;
    this.waitingForChoice = false;

    if (!isContinuation) {
      this.rootId = id;
      GameState.emit('dialogue:start', { id });
    }

    this.showNextLine();
    return true;
  }

  pickVariant(id) {
    const variants = dialogueData[id];
    if (!Array.isArray(variants)) {
      console.warn(`Dialogue: no dialogue with id "${id}"`);
      return null;
    }

    const variant = variants.find((v) => GameState.check(v.if));
    if (!variant) {
      console.warn(`Dialogue: no variant of "${id}" matches the current game state`);
      return null;
    }
    return variant;
  }

  showNextLine() {
    const lines = this.variant.lines || [];
    this.lineIndex += 1;

    if (this.lineIndex < lines.length) {
      const line = lines[this.lineIndex];
      GameState.emit('dialogue:line', {
        speaker: line.speaker || '',
        portrait: line.portrait || null,
        text: line.text || '',
        index: this.lineIndex,
        count: lines.length,
      });
      return;
    }

    // All lines shown: apply the effects, then offer choices or finish.
    GameState.applyEffects(this.variant.effects);

    const choices = this.variant.choices || [];
    if (choices.length > 0) {
      this.waitingForChoice = true;
      GameState.emit('dialogue:choices', { choices: choices.map((c) => ({ text: c.text })) });
    } else {
      this.finish();
    }
  }

  finish() {
    const id = this.rootId;
    this.rootId = null;
    this.variant = null;
    this.waitingForChoice = false;

    GameState.emit('dialogue:end', { id });

    // Plain setTimeout is fine here: Dialogue isn't tied to any one scene.
    clearTimeout(this.unlockTimer);
    this.unlockTimer = setTimeout(() => {
      if (!this.isActive()) GameState.inputLocked = false;
    }, UNLOCK_DELAY_MS);
  }
}

export const Dialogue = new DialogueRunner();
