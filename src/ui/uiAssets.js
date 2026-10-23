// Loads every UI texture produced by tools/assets/ui.mjs.
// BootScene calls preloadUI(this) inside preload().
//
// Texture sizes (all pre-scaled, displayed at 1:1):
//   ui-bar-frame 278×45, ui-icon-heart/food/water/ring 48×45 (drawn at the bar's top-left),
//   ui-slot / ui-slot-selected 60×60, ui-key-e 24×24 (world prompt), ui-key-e-lg 48×48,
//   ui-dialogue (+ -noplate / -noportrait / -narration variants) 860×247, ui-divider-orange 244×38, ui-divider-cyan 183×36,
//   ui-slot-sm 44×44 (supply counters, party row), ui-minimap-frame 170×170 (transparent inside,
//   inner circle centre/radius in MINIMAP in uiLayout.js).
// Soft glows and gradients are generated at runtime instead (see uiTextures.js).

export const UI_TEXTURES = [
  'ui-bar-frame',
  'ui-icon-heart',
  'ui-icon-food',
  'ui-icon-water',
  'ui-icon-ring', // white dashed ring only: tint it (toxicity green)
  'ui-slot',
  'ui-slot-selected',
  'ui-key-e',
  'ui-key-e-lg',
  'ui-dialogue', // with an empty name plate
  'ui-dialogue-noplate', // no name plate (portrait only)
  'ui-dialogue-noportrait', // name plate, no portrait recess
  'ui-dialogue-narration', // neither (narration lines)
  'ui-divider-orange',
  'ui-divider-cyan',
  'ui-slot-sm',
  'ui-minimap-frame', // circular compass frame, interior transparent
];

export function preloadUI(scene) {
  for (const key of UI_TEXTURES) {
    scene.load.image(key, `assets/ui/${key}.png`);
  }
}
