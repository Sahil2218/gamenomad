// UI layout constants for THE NOMAD (task B).
//
// Every number here is in OUTPUT pixels: canvas pixels for screen positions
// (1280×720, UIScene camera zoom 1) and texture pixels for rects that live
// inside a texture. The textures in public/assets/ui are pre-scaled by
// tools/assets/ui.mjs to exactly these sizes so they render 1:1.
//
// This file is plain data (no Phaser import) so the asset script can read it too.

export const SCREEN = { width: 1280, height: 720 };
export const MARGIN = 16;

// Palette from the contract (§4). Numbers for Phaser tints/graphics, strings for Text styles.
export const COLORS = {
  panel: 0x12141c,
  panelLight: 0x1a1d27,
  rust: 0x6b4a33,
  orange: 0xf0a030,
  cyan: 0x3ad4e8,
  health: 0xe8343f,
  toxicity: 0x9be33a,
  cream: 0xefe6d2,
  muted: 0x9a8f7c,
  warning: 0xff3b3b,
  black: 0x05060a,
};
export const CSS = {
  panel: '#12141c',
  panelLight: '#1a1d27',
  rust: '#6b4a33',
  orange: '#f0a030',
  cyan: '#3ad4e8',
  health: '#e8343f',
  toxicity: '#9be33a',
  cream: '#efe6d2',
  muted: '#9a8f7c',
  warning: '#ff3b3b',
};
export const FONTS = { body: 'VT323', title: 'Silkscreen' };

// ---------------------------------------------------------------------------
// Stat bars: `ui-bar-frame` (an empty icon box + bar). An icon box texture
// (`ui-icon-heart`, ...) is drawn at the same top-left so it covers the empty box.
// The fill is drawn in code inside `fill`.
export const BAR = {
  width: 278,
  height: 45,
  iconWidth: 48,
  iconHeight: 45,
  fill: { x: 51, y: 16, w: 208, h: 15 },
  spacing: 47, // vertical distance between stacked bars
};

// Top-left HUD: health bar, then toxicity bar (only when showToxicity), then the quest tracker.
export const HUD = { x: MARGIN, y: MARGIN };
export const TOXICITY_MAX = 100; // contract gives no max; toxicity is treated as 0..100

export const QUEST_TRACKER = {
  x: MARGIN,
  gapBelowBars: 8, // space between the last bar and the tracker panel
  width: 300,
  padX: 12,
  padY: 9,
  iconSize: 14, // orange diamond drawn in code
  titleSize: 16, // Silkscreen (pixel font, crisp at multiples of 8)
  objectiveSize: 24, // VT323
};

// ---------------------------------------------------------------------------
// Inventory: 8 slots in one row at the top-right.
export const SLOT = { size: 60, gap: 4, count: 8 };
export const INVENTORY = {
  x: SCREEN.width - MARGIN - (SLOT.count * SLOT.size + (SLOT.count - 1) * SLOT.gap), // 756
  y: MARGIN,
  iconScale: 0.625, // 64×64 item icons drawn at 40×40 inside the 60×60 slot
};

// Inventory detail panel (I / TAB), right side, below the toast lane (TOAST.y..+44).
export const INVENTORY_PANEL = {
  x: INVENTORY.x,
  y: 148,
  width: SCREEN.width - MARGIN - INVENTORY.x,
  rowHeight: 62,
  pad: 14,
};

// ---------------------------------------------------------------------------
// Dialogue box `ui-dialogue` (860×247), bottom-centre. All inner rects are
// relative to the texture's top-left corner.
export const DIALOGUE = {
  width: 860,
  height: 247,
  x: Math.round((SCREEN.width - 860) / 2), // 210
  y: SCREEN.height - 247 - 6, // 467
  slideDistance: 24, // slides up this far while fading in
  namePlate: { x: 82, y: 13, w: 145, h: 31 },
  nameSize: 16, // Silkscreen
  portrait: { x: 52, y: 62, w: 133, h: 131 }, // empty portrait recess
  portraitScale: 4 / 3, // 96×96 portraits shown at 128×128
  textWithPortrait: { x: 203, y: 64, w: 584, h: 122 },
  textFull: { x: 60, y: 64, w: 727, h: 122 },
  textSize: 28, // VT323
  lineSpacing: 2,
  arrow: { x: 767, y: 175, w: 14, h: 9 }, // blinking ▼ centre + size
  charsPerSecond: 40,
};

// Choice list: vertical panel right-aligned to the dialogue box, just above it.
export const CHOICES = {
  width: 400,
  right: DIALOGUE.x + DIALOGUE.width - 24, // panel's right edge
  bottom: DIALOGUE.y + 4, // panel's bottom edge (tucks just behind the box's top frame)
  rowHeight: 34,
  padX: 14,
  padY: 10,
  textSize: 26, // VT323
};

// Toasts: top-centre, below the inventory row so they never cover the slots.
export const TOAST = {
  centerX: SCREEN.width / 2,
  y: 96,
  minWidth: 220,
  maxWidth: 560,
  height: 40,
  padX: 16,
  textSize: 24, // VT323
  iconSize: 32,
  holdMs: 2200,
  fadeMs: 180,
};

// Title card (act titles) and alert ("ROGUE HUMAN DETECTED").
export const TITLE_CARD = {
  centerX: SCREEN.width / 2,
  centerY: 250,
  titleSize: 40, // Silkscreen
  subtitleSize: 28, // VT323
  fadeInMs: 700,
  holdMs: 2000,
  fadeOutMs: 700,
};
export const ALERT = {
  centerY: SCREEN.height / 2 - 30,
  titleSize: 40, // Silkscreen
  subtitleSize: 28, // VT323
  pulses: 3,
};

// "E" interaction prompt used by WORLD scenes (camera zoom 2): 24×24 texture.
export const KEY_E = { size: 24, largeSize: 48 };

// Decorative dividers (title card / inventory panel).
export const DIVIDER = {
  orange: { w: 244, h: 38 },
  cyan: { w: 183, h: 36 },
};

// ---------------------------------------------------------------------------
// Milestone 2 HUD (contract M2 §7). The dialogue box spans x 210–1070 at the
// bottom, so everything in the bottom-left corner stays left of x = 200.

// Small slot frame (same art as `ui-slot`), used by the supply counters and the party row.
export const SLOT_SMALL = { size: 44 };

// Circular minimap, bottom-left. `ui-minimap-frame` is size×size; its transparent
// inner circle is centred at (centerX, centerY) with radius innerRadius (texture px).
// The live map is clipped to maskRadius, which tucks just under the frame's dark rim.
export const MINIMAP = {
  size: 170,
  x: MARGIN, // 16
  y: SCREEN.height - MARGIN - 170, // 534
  centerX: 85,
  centerY: 85,
  innerRadius: 66.5,
  maskRadius: 68,
  mapScale: 0.18, // world px → minimap px
  markerInset: 8, // the off-range objective marker is clamped this far inside innerRadius
};

// Act trail, right above the minimap: a label tab ("ACT II · THE OUTSKIRTS") on
// top of a small panel with six act badges I–VI and the current area's name.
// The badge panel stays left of x = 200; the wider tab sits above the dialogue
// box's top edge (y 467), so it never overlaps it.
export const ACT_TRAIL = {
  x: MARGIN,
  width: 180, // badge panel: right edge at x 196
  height: 62,
  gapAboveMinimap: 6,
  tabHeight: 27,
  tabPadX: 10,
  labelSize: 16, // Silkscreen
  areaSize: 20, // VT323
  badgeW: 21,
  badgeH: 16,
  badgeGap: 6, // connector length between badges
  badgeY: 15, // badge row top, inside the panel
};
ACT_TRAIL.y = MINIMAP.y - ACT_TRAIL.gapAboveMinimap - ACT_TRAIL.height; // 466 (panel top)
ACT_TRAIL.tabY = ACT_TRAIL.y - ACT_TRAIL.tabHeight + 1; // 440: tab bottom tucks under the panel's top edge

// Supply counters to the right of the health bar: [H] medkit, [R] ration, [T] water.
export const SUPPLIES = {
  x: HUD.x + BAR.width + 8, // 302
  y: HUD.y,
  gap: 6,
  order: [
    { id: 'medkit', key: 'H' },
    { id: 'ration', key: 'R' },
    { id: 'water', key: 'T' },
  ],
};

// Party row: small companion heads under the quest tracker.
export const PARTY_ROW = {
  x: MARGIN,
  gapBelowTracker: 6,
  gap: 4,
  headSize: 32, // portraits are cropped to the head and pre-scaled to this size
};

// Warden scan meter, top-centre (between the supply counters and the inventory row).
export const SCAN_METER = {
  width: 216,
  height: 40,
  x: Math.round(SCREEN.width / 2 - 108), // 532
  y: MARGIN,
  segments: 18,
};

// ---------------------------------------------------------------------------
// Milestone 3 HUD (contract M3 §7).

// Gold used by the guide trail (world breadcrumbs and the minimap route).
export const GUIDE_GOLD = { color: 0xf0c060, css: '#f0c060' };

// The guide route on the minimap: one dot every `spacing` minimap px, redrawn
// `redrawMs` apart, drifting towards the objective at `marchSpeed` px per second.
export const MINIMAP_GUIDE = {
  spacing: 6,
  redrawMs: 100,
  marchSpeed: 9,
  startGap: 9, // keep the first dots clear of the player arrow
};

// "[G] GUIDE" tag in the empty bottom-right corner of the minimap's square
// (outside the round frame, left of x = 200).
export const GUIDE_HINT = {
  right: MINIMAP.x + MINIMAP.size + 12, // 198
  bottom: SCREEN.height - 3, // 717
  height: 17,
};

// Gold "HOLDING RELAY" meter, top-centre. It takes the scan meter's slot, or
// stacks just below it while the scan meter is showing.
export const HOLD_METER = {
  width: SCAN_METER.width,
  height: 36,
  x: SCAN_METER.x,
  y: SCAN_METER.y,
  stackedY: SCAN_METER.y + SCAN_METER.height + 4, // 60: bottom edge at the toast lane (96)
  segments: 18,
};

// "SWARM · WAVE n": a small tag under the inventory row, right-aligned with it,
// clear of the top-centre toast lane.
export const WAVE_LABEL = {
  right: SCREEN.width - MARGIN, // 1264
  y: INVENTORY.y + SLOT.size + 8, // 84
  height: 28,
  holdMs: 2400,
};
