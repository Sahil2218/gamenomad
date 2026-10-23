// Act trail, above the minimap (contract M2 §7): a label tab reading e.g.
// "ACT II · THE OUTSKIRTS", and under it six act badges I–VI joined by
// connectors, plus the name of the current area. Past acts are orange, the
// current act is cyan with a pulsing glow and a "you are here" chevron, future
// acts are dim.
// Spoiler rule: only the CURRENT act's title and area are ever shown. Other
// badges show their roman numeral only (acts V–VI take place somewhere the
// story keeps secret until then).

import Phaser from 'phaser';
import { ACT_TRAIL, COLORS, CSS } from './uiLayout.js';
import { DEPTH, bodyStyle, drawPanel, fillChamferRect, titleStyle } from './uiStyle.js';
import { GEN, ensureGlow } from './uiTextures.js';
import actsData from '../data/acts.json';

export const ACT_IDS = ['I', 'II', 'III', 'IV', 'V', 'VI'];

// Used if src/data/acts.json doesn't list an act.
const FALLBACK_TITLES = {
  I: 'The Forbidden Boundary',
  II: 'The Outskirts',
  III: 'The Journey of Six',
  IV: 'The White Cloud',
  V: 'The Truth Beneath',
  VI: 'The Final Choice',
};

// acts.json: [{ id: 'II', title: 'The Outskirts', area: 'The Outskirts' }, …]
// Returns six { id, title, area } entries in order I..VI.
export function normalizeActs(raw) {
  const byId = {};
  (Array.isArray(raw) ? raw : []).forEach((act) => {
    if (act && act.id) byId[String(act.id).toUpperCase()] = act;
  });
  return ACT_IDS.map((id) => {
    const act = byId[id] || {};
    return { id, title: String(act.title || FALLBACK_TITLES[id]), area: String(act.area || '') };
  });
}

export class ActTrail {
  constructor(scene, rawActs = actsData) {
    const a = ACT_TRAIL;
    this.scene = scene;
    this.acts = normalizeActs(rawActs);
    this.current = -1;
    this.areaName = '';
    this.shown = true; // UIScene hides the trail with the minimap when there's no world
    ensureGlow(scene);

    // Container origin = the tab's top-left; the badge panel starts panelY below it.
    this.panelY = a.y - a.tabY;
    this.container = scene.add.container(a.x, a.tabY).setDepth(DEPTH.hud);

    this.tab = scene.add.graphics();
    this.actLabel = scene.add.text(a.tabPadX, 6, '', titleStyle(a.labelSize, CSS.cyan));
    this.titleLabel = scene.add.text(0, 6, '', titleStyle(a.labelSize, CSS.cream));

    this.panel = scene.add.graphics();
    drawPanel(this.panel, 0, this.panelY, a.width, a.height);

    // Badges: connectors + badge shapes in one Graphics, numerals as Text on top.
    const rowW = ACT_IDS.length * a.badgeW + (ACT_IDS.length - 1) * a.badgeGap;
    this.badgeX0 = Math.round((a.width - rowW) / 2);
    this.badgeTop = this.panelY + a.badgeY;
    const badgeMid = this.badgeTop + a.badgeH / 2;
    this.glow = scene.add.image(0, badgeMid, GEN.glow).setBlendMode(Phaser.BlendModes.ADD).setScale(1.4, 1).setAlpha(0);
    this.badges = scene.add.graphics();
    this.numerals = ACT_IDS.map((id, i) => scene.add.text(this.badgeCenterX(i), badgeMid, id, titleStyle(8, CSS.muted)).setOrigin(0.5));

    // "You are here" chevron above the current badge.
    this.chevron = scene.add.graphics();
    this.chevron.fillStyle(COLORS.black, 1);
    this.chevron.fillTriangle(-5, -4, 5, -4, 0, 2);
    this.chevron.fillStyle(COLORS.cyan, 1);
    this.chevron.fillTriangle(-3, -3, 3, -3, 0, 1);
    this.chevron.y = this.badgeTop - 4;
    this.chevronBob = scene.tweens.add({ targets: this.chevron, y: this.badgeTop - 6, duration: 520, yoyo: true, repeat: -1, ease: 'Sine.easeInOut', paused: true });

    // Current area, centred along the bottom of the panel between two small marks.
    this.area = scene.add.text(a.width / 2, this.panelY + a.height - 9, '', bodyStyle(a.areaSize, CSS.cream)).setOrigin(0.5, 1).setAlpha(0.85);
    this.areaMarks = scene.add.graphics();

    this.container.add([this.tab, this.actLabel, this.titleLabel, this.panel, this.glow, this.badges, ...this.numerals, this.chevron, this.area, this.areaMarks]);
    this.glowPulse = scene.tweens.add({ targets: this.glow, alpha: { from: 0.6, to: 1 }, duration: 760, yoyo: true, repeat: -1, ease: 'Sine.easeInOut', paused: true });
    this.container.setVisible(false);
  }

  badgeCenterX(index) {
    return this.badgeX0 + index * (ACT_TRAIL.badgeW + ACT_TRAIL.badgeGap) + ACT_TRAIL.badgeW / 2;
  }

  setVisible(visible) {
    this.shown = visible;
    this.container.setVisible(visible && this.current >= 0);
  }

  // id: GameState.act ('I'..'VI'). Unknown ids hide the trail.
  setAct(id, { animate = true } = {}) {
    const index = ACT_IDS.indexOf(String(id || '').toUpperCase());
    const changed = index !== this.current;
    this.current = index;
    if (index < 0) {
      this.container.setVisible(false);
      this.glowPulse.pause();
      this.chevronBob.pause();
      return;
    }
    this.container.setVisible(this.shown);
    const act = this.acts[index];
    this.actLabel.setText(`ACT ${act.id}`);
    this.titleLabel.setText(`· ${act.title.toUpperCase()}`);
    this.drawTab();
    this.drawBadges();
    this.setArea(this.areaName);

    this.glow.x = this.badgeCenterX(index);
    this.chevron.x = this.badgeCenterX(index);
    this.glowPulse.resume();
    this.chevronBob.resume();
    if (animate && changed) this.celebrate(index);
  }

  // area: the current world's area name (GameState.world.area); falls back to the
  // current act's area from acts.json.
  setArea(area) {
    this.areaName = area || '';
    const act = this.current >= 0 ? this.acts[this.current] : null;
    const name = String(this.areaName || (act && act.area) || '').toUpperCase();
    this.area.setText(name);
    const g = this.areaMarks;
    g.clear();
    if (!name) return;
    const y = Math.round(this.area.y - this.area.height / 2 + 1);
    const half = Math.ceil(this.area.width / 2);
    g.fillStyle(COLORS.orange, 0.9);
    for (const x of [ACT_TRAIL.width / 2 - half - 9, ACT_TRAIL.width / 2 + half + 6]) {
      g.fillRect(Math.round(x), y - 1, 3, 3);
    }
  }

  // The tab grows with the label; it's at least as wide as the badge panel.
  drawTab() {
    const a = ACT_TRAIL;
    this.titleLabel.x = a.tabPadX + Math.ceil(this.actLabel.width) + 6;
    const width = Math.max(a.width, Math.ceil(this.titleLabel.x + this.titleLabel.width + a.tabPadX));
    this.tab.clear();
    drawPanel(this.tab, 0, 0, width, a.tabHeight);
    // Cyan accent line along the tab's left edge marks the "now" label.
    this.tab.fillStyle(COLORS.cyan, 0.9);
    this.tab.fillRect(4, 7, 2, a.tabHeight - 14);
  }

  drawBadges() {
    const a = ACT_TRAIL;
    const g = this.badges;
    const y = this.badgeTop;
    const midY = y + a.badgeH / 2;
    g.clear();

    // Connectors: solid orange along the road already travelled, dotted ahead.
    for (let i = 0; i < ACT_IDS.length - 1; i++) {
      const x0 = this.badgeCenterX(i) + a.badgeW / 2;
      const x1 = this.badgeCenterX(i + 1) - a.badgeW / 2;
      if (i < this.current) {
        g.fillStyle(COLORS.orange, 1);
        g.fillRect(x0, midY - 1, x1 - x0, 2);
      } else {
        g.fillStyle(COLORS.muted, 0.7);
        for (let x = x0 + 1; x < x1; x += 2) g.fillRect(x, midY, 1, 1);
      }
    }

    ACT_IDS.forEach((id, i) => {
      const x = this.badgeCenterX(i) - a.badgeW / 2;
      const past = i < this.current;
      const now = i === this.current;
      if (now) {
        fillChamferRect(g, x - 2, y - 2, a.badgeW + 4, a.badgeH + 4, COLORS.cream, 1, 3);
        fillChamferRect(g, x - 1, y - 1, a.badgeW + 2, a.badgeH + 2, COLORS.black, 1, 3);
        fillChamferRect(g, x, y, a.badgeW, a.badgeH, COLORS.cyan, 1, 2);
        g.fillStyle(0xc8f6ff, 1);
        g.fillRect(x + 2, y + 1, a.badgeW - 4, 1); // highlight
      } else if (past) {
        fillChamferRect(g, x - 1, y - 1, a.badgeW + 2, a.badgeH + 2, COLORS.black, 1, 3);
        fillChamferRect(g, x, y, a.badgeW, a.badgeH, COLORS.orange, 1, 2);
        g.fillStyle(0xffd27a, 1);
        g.fillRect(x + 2, y + 1, a.badgeW - 4, 1);
      } else {
        fillChamferRect(g, x - 1, y - 1, a.badgeW + 2, a.badgeH + 2, COLORS.muted, 0.5, 3);
        fillChamferRect(g, x, y, a.badgeW, a.badgeH, COLORS.panelLight, 1, 2);
      }
      const numeral = this.numerals[i];
      numeral.setColor(now || past ? CSS.panel : CSS.muted);
      numeral.setAlpha(now || past ? 1 : 0.9);
    });
  }

  // New act: the current badge pops and the label slides in.
  celebrate(index) {
    const tweens = this.scene.tweens;
    const numeral = this.numerals[index];
    const labels = [this.actLabel, this.titleLabel];
    tweens.killTweensOf([numeral, ...labels]);
    numeral.setScale(1.8);
    tweens.add({ targets: numeral, scale: 1, duration: 420, ease: 'Back.easeOut' });
    labels.forEach((label, k) => {
      const x = label.x;
      label.setAlpha(0).setX(x - 6);
      tweens.add({ targets: label, alpha: 1, x, delay: k * 90, duration: 260, ease: 'Cubic.easeOut' });
    });
  }
}
