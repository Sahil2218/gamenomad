// Shared look for code-drawn UI: text styles and the chamfered panel used by
// the quest tracker, toasts, choices and the inventory panel.
// (tools/assets/ui.mjs draws the same panel shape in its preview.)

import { COLORS, CSS, FONTS } from './uiLayout.js';

// VT323: body text.
export function bodyStyle(size, color = CSS.cream, extra = {}) {
  return { fontFamily: FONTS.body, fontSize: `${size}px`, color, ...extra };
}

// Silkscreen: titles, labels, name plate.
export function titleStyle(size, color = CSS.orange, extra = {}) {
  return { fontFamily: FONTS.title, fontSize: `${size}px`, color, ...extra };
}

// Points of a rectangle with its corners cut off, shrunk by `inset` px.
function chamferPoints(x, y, w, h, inset, cut = 4) {
  const a = inset;
  const k = cut + inset * 0.4;
  return [
    { x: x + a + k, y: y + a },
    { x: x + w - a - k, y: y + a },
    { x: x + w - a, y: y + a + k },
    { x: x + w - a, y: y + h - a - k },
    { x: x + w - a - k, y: y + h - a },
    { x: x + a + k, y: y + h - a },
    { x: x + a, y: y + h - a - k },
    { x: x + a, y: y + a + k },
  ];
}

// Filled chamfered rectangle in one colour (small badges, keycaps).
export function fillChamferRect(g, x, y, w, h, color, alpha = 1, cut = 2) {
  g.fillStyle(color, alpha);
  g.fillPoints(chamferPoints(x, y, w, h, 0, cut), true);
}

// Dark panel: black outline, 2 px border (rust by default), a thin lighter
// inner line, then the panel fill. Draws into an existing Graphics object.
export function drawPanel(g, x, y, w, h, { border = COLORS.rust, alpha = 0.94 } = {}) {
  g.fillStyle(COLORS.black, 1);
  g.fillPoints(chamferPoints(x, y, w, h, 0), true);
  g.fillStyle(border, 1);
  g.fillPoints(chamferPoints(x, y, w, h, 1), true);
  g.fillStyle(COLORS.panelLight, 1);
  g.fillPoints(chamferPoints(x, y, w, h, 3), true);
  g.fillStyle(COLORS.panel, alpha);
  g.fillPoints(chamferPoints(x, y, w, h, 4), true);
}

// Small orange diamond (the quest marker from the UI sheet), centred on (cx, cy).
export function drawDiamond(g, cx, cy, size, color = COLORS.orange) {
  const r = size / 2;
  const diamond = (s) => [
    { x: cx, y: cy - s },
    { x: cx + s, y: cy },
    { x: cx, y: cy + s },
    { x: cx - s, y: cy },
  ];
  g.fillStyle(color, 1);
  g.fillPoints(diamond(r), true);
  g.fillStyle(COLORS.panel, 1);
  g.fillPoints(diamond(r - 3), true);
  g.fillStyle(color, 1);
  g.fillPoints(diamond(r - 5), true);
}

// Mix two 0xRRGGBB colours (t = 0 gives a, t = 1 gives b).
export function mixColor(a, b, t) {
  const ch = (c, shift) => (c >> shift) & 255;
  const mix = (shift) => Math.round(ch(a, shift) + (ch(b, shift) - ch(a, shift)) * t);
  return (mix(16) << 16) | (mix(8) << 8) | mix(0);
}

// Draw order of the UI pieces (higher is on top).
export const DEPTH = {
  fx: 5, // damage flash / toxic vignette: above the world, under the HUD
  hud: 10,
  minimap: 10,
  scanMeter: 12,
  holdMeter: 12, // M3: relay hold meter (top-centre, stacks under the scan meter)
  waveLabel: 12, // M3: "SWARM · WAVE n"
  inventory: 10,
  inventoryPanel: 20,
  respawn: 29, // fade from black after a respawn (title cards and dialogue stay above it)
  titleCard: 30,
  memory: 35, // M3: memory-restore bloom (under the dialogue box, so a dialogue stays readable)
  choices: 40,
  dialogue: 41,
  toasts: 50,
  alert: 100,
};
