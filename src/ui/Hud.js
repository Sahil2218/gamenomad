// Top-left HUD: health bar, toxicity bar (only when showToxicity), the quest
// tracker panel underneath, and the party row under the tracker (M2).

import { BAR, COLORS, HUD, PARTY_ROW, QUEST_TRACKER, TOXICITY_MAX } from './uiLayout.js';
import { DEPTH, bodyStyle, drawDiamond, drawPanel, mixColor, titleStyle } from './uiStyle.js';
import { PartyRow } from './PartyRow.js';

const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

// One bar: frame + icon box + a fill drawn into BAR.fill. Changes animate:
// the fill tweens quickly, and a pale "ghost" trails behind when the value drops.
class StatBar {
  constructor(scene, x, y, { iconKey, color, iconTint = null }) {
    this.scene = scene;
    this.color = color;
    this.fillState = { ratio: 0 };
    this.ghostState = { ratio: 0 };

    this.container = scene.add.container(x, y).setDepth(DEPTH.hud);
    const frame = scene.add.image(0, 0, 'ui-bar-frame').setOrigin(0);
    this.ghost = scene.add.graphics();
    this.fill = scene.add.graphics();
    const icon = scene.add.image(0, 0, iconKey).setOrigin(0);
    if (iconTint !== null) icon.setTint(iconTint);
    this.container.add([frame, this.ghost, this.fill, icon]);
  }

  setRatio(ratio, animate = true) {
    const target = clamp01(ratio);
    const tweens = this.scene.tweens;
    tweens.killTweensOf(this.fillState);
    tweens.killTweensOf(this.ghostState);

    if (!animate) {
      this.fillState.ratio = target;
      this.ghostState.ratio = target;
      this.redraw();
      return;
    }

    const dropping = target < this.fillState.ratio;
    if (!dropping) this.ghostState.ratio = target; // ghost only trails on damage
    tweens.add({ targets: this.fillState, ratio: target, duration: 260, ease: 'Cubic.easeOut', onUpdate: () => this.redraw(), onComplete: () => this.redraw() });
    if (dropping) {
      tweens.add({ targets: this.ghostState, ratio: target, delay: 320, duration: 420, ease: 'Quad.easeIn', onUpdate: () => this.redraw(), onComplete: () => this.redraw() });
    }
  }

  redraw() {
    const f = BAR.fill;
    const fillW = Math.round(f.w * this.fillState.ratio);
    const ghostW = Math.round(f.w * this.ghostState.ratio);

    this.ghost.clear();
    if (ghostW > fillW) {
      this.ghost.fillStyle(mixColor(this.color, 0xffffff, 0.55), 0.55);
      this.ghost.fillRect(f.x + fillW, f.y, ghostW - fillW, f.h);
    }

    this.fill.clear();
    if (fillW <= 0) return;
    this.fill.fillStyle(this.color, 1);
    this.fill.fillRect(f.x, f.y, fillW, f.h);
    // Pixel-style shading: bright top line, darker bottom lines (like the sheet's bars).
    this.fill.fillStyle(mixColor(this.color, 0xffffff, 0.5), 1);
    this.fill.fillRect(f.x, f.y + 1, fillW, 2);
    this.fill.fillStyle(mixColor(this.color, 0x000000, 0.35), 1);
    this.fill.fillRect(f.x, f.y + f.h - 3, fillW, 3);
  }

  setVisible(visible) {
    this.container.setVisible(visible);
  }
}

// Quest stage title (Silkscreen, orange) + objective (VT323, cream) on a small panel.
class QuestTracker {
  constructor(scene, x, y) {
    const q = QUEST_TRACKER;
    this.scene = scene;
    this.container = scene.add.container(x, y).setDepth(DEPTH.hud);
    this.bg = scene.add.graphics();
    this.icon = scene.add.graphics();
    this.title = scene.add.text(q.padX + q.iconSize + 8, q.padY - 1, '', titleStyle(q.titleSize));
    this.objective = scene.add.text(q.padX, q.padY + q.titleSize + 6, '', bodyStyle(q.objectiveSize, undefined, { wordWrap: { width: q.width - q.padX * 2 } }));
    this.flash = scene.add.graphics().setAlpha(0);
    this.container.add([this.bg, this.icon, this.title, this.objective, this.flash]);
    this.current = { title: null, objective: null };
    this.height = 0; // panel height (0 while hidden)
    this.targetY = y; // where the panel is (or is sliding to)
  }

  // info: { id, title, objective } from GameState.questInfo(). Pulses if the text changed.
  setInfo(info, { pulse = true } = {}) {
    const title = (info && info.title) || '';
    const objective = (info && info.objective) || '';
    const changed = title !== this.current.title || objective !== this.current.objective;
    if (!changed) return;
    const firstTime = this.current.title === null;
    this.current = { title, objective };

    this.title.setText(title.toUpperCase());
    this.objective.setText(objective);
    this.container.setVisible(Boolean(title || objective));
    this.layout();
    if (pulse && !firstTime) this.pulse();
  }

  layout() {
    const q = QUEST_TRACKER;
    const height = Math.round(q.padY * 2 + q.titleSize + 6 + this.objective.height);
    this.height = this.container.visible ? height : 0;
    this.bg.clear();
    drawPanel(this.bg, 0, 0, q.width, height);
    this.icon.clear();
    drawDiamond(this.icon, q.padX + q.iconSize / 2, q.padY + q.iconSize / 2 + 1, q.iconSize);
    this.flash.clear();
    this.flash.fillStyle(COLORS.orange, 1);
    this.flash.fillRect(3, 3, q.width - 6, height - 6);
  }

  // Two quick orange flashes and a small nudge so the player notices the update.
  pulse() {
    const tweens = this.scene.tweens;
    tweens.killTweensOf(this.flash);
    tweens.killTweensOf(this.title);
    this.flash.setAlpha(0);
    tweens.add({ targets: this.flash, alpha: 0.28, duration: 140, yoyo: true, repeat: 1, ease: 'Sine.easeInOut', onComplete: () => this.flash.setAlpha(0) });
    const q = QUEST_TRACKER;
    this.title.x = q.padX + q.iconSize + 8 + 6;
    tweens.add({ targets: this.title, x: q.padX + q.iconSize + 8, duration: 320, ease: 'Back.easeOut' });
  }

  moveTo(y, animate) {
    this.targetY = y;
    this.scene.tweens.killTweensOf(this.container);
    if (animate) this.scene.tweens.add({ targets: this.container, y, duration: 220, ease: 'Cubic.easeOut' });
    else this.container.y = y;
  }
}

export class Hud {
  constructor(scene) {
    this.scene = scene;
    this.health = new StatBar(scene, HUD.x, HUD.y, { iconKey: 'ui-icon-heart', color: COLORS.health });
    // The toxicity bar uses the frame's empty box plus a green-tinted dashed ring.
    this.toxicity = new StatBar(scene, HUD.x, HUD.y + BAR.spacing, { iconKey: 'ui-icon-ring', color: COLORS.toxicity, iconTint: COLORS.toxicity });
    this.quest = new QuestTracker(scene, QUEST_TRACKER.x, this.trackerY(false));
    this.party = new PartyRow(scene);
    this.showToxicity = null;
    this.placeParty(false);
  }

  // The party row sits just under the quest tracker (or under the bars if it's hidden).
  placeParty(animate) {
    const below = this.quest.height > 0 ? this.quest.height + PARTY_ROW.gapBelowTracker : 0;
    this.party.moveTo(this.quest.targetY + below, animate);
  }

  trackerY(showToxicity) {
    const lastBarY = showToxicity ? HUD.y + BAR.spacing : HUD.y;
    return lastBarY + BAR.height + QUEST_TRACKER.gapBelowBars;
  }

  // stats: { health, maxHealth, toxicity, showToxicity } (payload of 'stats:changed').
  setStats(stats, animate = true) {
    const maxHealth = stats.maxHealth > 0 ? stats.maxHealth : 100;
    this.health.setRatio(stats.health / maxHealth, animate);
    this.toxicity.setRatio(stats.toxicity / TOXICITY_MAX, animate);

    const show = Boolean(stats.showToxicity);
    if (show !== this.showToxicity) {
      const firstTime = this.showToxicity === null;
      this.showToxicity = show;
      this.toxicity.setVisible(show);
      this.quest.moveTo(this.trackerY(show), animate && !firstTime);
      this.placeParty(animate && !firstTime);
    }
  }

  setQuest(info, options) {
    this.quest.setInfo(info, options);
    this.placeParty(Boolean(options && options.pulse));
  }

  // Small horizontal jolt of the health bar when the player takes damage.
  shakeHealth() {
    const bar = this.health.container;
    const tweens = this.scene.tweens;
    tweens.killTweensOf(bar);
    tweens.add({ targets: bar, x: { from: HUD.x - 4, to: HUD.x + 4 }, duration: 40, yoyo: true, repeat: 2, onComplete: () => (bar.x = HUD.x) });
  }

  // ids: GameState.party; fresh: ids that just joined (they pop in).
  setParty(ids, fresh = []) {
    this.party.setParty(ids, fresh);
  }

  // Hide or show the whole top-left HUD (M3: the Ending scene has none). This uses
  // alpha, because each piece already manages its own visibility (e.g. the toxicity bar).
  setHidden(hidden) {
    const alpha = hidden ? 0 : 1;
    [this.health.container, this.toxicity.container, this.quest.container, this.party.container].forEach((c) => c.setAlpha(alpha));
  }
}
