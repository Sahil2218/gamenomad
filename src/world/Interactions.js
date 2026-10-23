import Phaser from 'phaser';
import { GameState } from '../systems/GameState.js';
import { Dialogue } from '../systems/Dialogue.js';

const RADIUS = 28; // px, how close the player's feet must be
const PROMPT_DEPTH = 100000; // above everything in the world

/**
 * Everything the player can press E on: NPCs, party followers, pickups and inspectable spots.
 *
 * Each frame we find the nearest one within RADIUS, float the "E" prompt above it,
 * and run its action when E is pressed.
 *
 * Internally every interactable is a "target" object:
 *   { owner, distanceTo(x, y), promptPosition(), interact(), isAvailable() }
 * `owner` is the NPC / follower / pickup it belongs to, so it can be removed later.
 */
export default class Interactions {
  constructor(scene, player) {
    this.scene = scene;
    this.player = player;
    this.targets = [];
    this.current = null; // nearest target in range, or null

    // Origin (0.5, 1): the prompt's bottom-centre sits at the position we give it.
    this.prompt = scene.add.image(0, 0, 'ui-key-e').setOrigin(0.5, 1).setDepth(PROMPT_DEPTH).setVisible(false);
    this.keyE = scene.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.E);
  }

  /** Adds a target with sensible defaults (always available, normal priority 0) and returns it. */
  add(target) {
    const full = { owner: null, isAvailable: () => true, priority: 0, ...target };
    this.targets.push(full);
    return full;
  }

  /**
   * Someone to talk to. `getDialogueId` lets a scene pick the dialogue at the moment of talking.
   * `options` can override isAvailable / priority (used for followers).
   */
  addCharacter(character, getDialogueId, options = {}) {
    this.add({
      ...options,
      owner: character,
      distanceTo: (x, y) => Phaser.Math.Distance.Between(x, y, character.x, character.y),
      promptPosition: () => ({ x: character.x, y: character.y - character.displayHeight - 2 }),
      interact: () => {
        character.faceTowards(this.player.x, this.player.y);
        this.player.faceTowards(character.x, character.y);
        Dialogue.start(getDialogueId());
      },
    });
  }

  addNPC(npc) {
    this.addCharacter(npc, () => npc.dialogueId);
  }

  /**
   * A party member trailing the player. Talking to them plays 'party-<id>' (or what the scene picks).
   * Followers always walk right behind you, so they only count when you turn to face them,
   * and anything else in range (an NPC, a pickup) wins over them.
   */
  addFollower(follower, getDialogueId = () => `party-${follower.companionId}`) {
    this.addCharacter(follower, getDialogueId, {
      isAvailable: () => isFacing(this.player, follower),
      priority: 1,
    });
  }

  /** A Pickup. While its `requires` condition fails it is hidden and ignored. */
  addPickup(pickup) {
    const target = this.add({
      owner: pickup,
      isAvailable: () => pickup.isAvailable(),
      distanceTo: (x, y) => Phaser.Math.Distance.Between(x, y, pickup.x, pickup.y),
      promptPosition: () => ({ x: pickup.x, y: pickup.y - 34 }),
      interact: () => {
        // Destroy first: setFlag below makes the scene refresh its pickups.
        pickup.destroy();
        this.remove(target);
        GameState.addItem(pickup.item);
        GameState.setFlag(`picked_${pickup.id}`);
        if (pickup.dialogueId) Dialogue.start(pickup.dialogueId);
      },
    });
  }

  /**
   * data: { id, x, y, w, h, dialogue }, a rectangle in the world.
   * isAvailable: optional () => bool, e.g. "only during the signal stage".
   * onInteract:  optional () => void, instead of just playing data.dialogue (e.g. a locked hatch).
   */
  addInspectable(data, isAvailable = () => true, onInteract = () => Dialogue.start(data.dialogue)) {
    const rect = new Phaser.Geom.Rectangle(data.x, data.y, data.w, data.h);
    this.add({
      owner: data,
      isAvailable,
      distanceTo: (x, y) => distanceToRect(x, y, rect),
      promptPosition: () => ({ x: rect.centerX, y: rect.top - 2 }),
      interact: onInteract,
    });
  }

  /** True if this NPC / follower / pickup already has a target. */
  has(owner) {
    return this.targets.some((t) => t.owner === owner);
  }

  remove(target) {
    this.targets = this.targets.filter((t) => t !== target);
    if (this.current === target) this.current = null;
  }

  /** Removes every target that belongs to `owner` (e.g. an NPC who joined the party). */
  removeOwner(owner) {
    this.targets.filter((t) => t.owner === owner).forEach((t) => this.remove(t));
  }

  /** Call once per frame from the scene's update(). */
  update(time) {
    // Always read JustDown, even when we can't use it; otherwise an old press
    // would be "remembered" and fire later when the player walks up to something.
    const pressedE = Phaser.Input.Keyboard.JustDown(this.keyE);

    // Nothing is interactable during dialogues and cutscenes, or while the scene fades out (busy).
    const blocked = GameState.inputLocked || this.scene.busy;
    this.current = blocked ? null : this.findNearest();
    this.updatePrompt(time);

    if (pressedE && this.current) {
      this.current.interact();
    }
  }

  /** The closest available target in range; a lower `priority` number always wins first. */
  findNearest() {
    let nearest = null;
    let bestDistance = RADIUS;
    for (const target of this.targets) {
      if (!target.isAvailable()) continue;
      const distance = target.distanceTo(this.player.x, this.player.y);
      if (distance > RADIUS) continue;
      const better =
        !nearest || target.priority < nearest.priority || (target.priority === nearest.priority && distance < bestDistance);
      if (better) {
        nearest = target;
        bestDistance = distance;
      }
    }
    return nearest;
  }

  updatePrompt(time) {
    if (!this.current) {
      this.prompt.setVisible(false);
      return;
    }
    const { x, y } = this.current.promptPosition();
    const bob = Math.sin(time / 180) * 2; // gentle up-and-down
    this.prompt.setPosition(x, y + bob).setVisible(true);
  }
}

// Unit vector for each facing direction.
const FACING_VECTORS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };

/** Is `other` roughly in front of `character` (within 90° of where they look)? */
function isFacing(character, other) {
  const look = FACING_VECTORS[character.facing] || FACING_VECTORS.down;
  const dx = other.x - character.x;
  const dy = other.y - character.y;
  return dx * look.x + dy * look.y > 0; // dot product > 0 means "in front"
}

/** Distance from a point to the nearest edge of a rectangle (0 if inside). */
function distanceToRect(x, y, rect) {
  const dx = Math.max(rect.left - x, 0, x - rect.right);
  const dy = Math.max(rect.top - y, 0, y - rect.bottom);
  return Math.hypot(dx, dy);
}
