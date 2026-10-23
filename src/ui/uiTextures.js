// Small textures generated at runtime with a 2D canvas: soft glows, gradients,
// minimap markers and smooth pre-scaled copies of existing textures.
//
// Textures are global (shared by every scene), so each one is created once per
// game and simply reused when a scene is restarted or re-launched.
// Colours are baked into the textures instead of using setTint(), because tints
// only work in WebGL and these must also look right with the Canvas renderer.

import Phaser from 'phaser';

export const GEN = {
  scanlines: 'ui-gen-scanlines', // 4×4, dark line on the lower half (tile it)
  glow: 'ui-gen-glow-cyan', // 64×64 soft cyan radial glow (use with additive blend)
  // 320×180 screen-edge vignettes, shown stretched to the screen (smooth filtering):
  edgeDamage: 'ui-gen-edge-red',
  edgeToxic: 'ui-gen-edge-green',
  edgeToxicShade: 'ui-gen-edge-toxic-shade',
  edgeDark: 'ui-gen-edge-dark',
  // 6×6 minimap dots with a dark outline, one per point kind
  mmDot: { npc: 'ui-gen-mm-dot-npc', companion: 'ui-gen-mm-dot-companion', pickup: 'ui-gen-mm-dot-pickup' },
  mmArrow: 'ui-gen-mm-arrow', // 19×19 cyan player arrow pointing up
  mmDiamond: 'ui-gen-mm-diamond', // 15×15 yellow objective diamond
  mmShade: 'ui-gen-mm-shade', // inner shadow for the minimap circle
  mmSweep: 'ui-gen-mm-sweep', // faint radar sweep wedge
  // Milestone 3
  glowMagenta: 'ui-gen-glow-magenta', // 64×64, like `glow` but magenta (Signal reprogram mode)
  bloom: 'ui-gen-bloom', // 160×90 soft white radial, stretched over the screen (memory restore)
  memoryStreak: 'ui-gen-memory-streak', // 16×4 soft white streak: fallback for fx-memory
};

// Create `key` once by drawing into a width×height canvas. `linear` turns on smooth
// filtering (the game uses nearest filtering), for gradients that are shown scaled up.
export function ensureCanvasTexture(scene, key, width, height, draw, { linear = false } = {}) {
  if (scene.textures.exists(key)) return key;
  const texture = scene.textures.createCanvas(key, width, height);
  draw(texture.getContext(), width, height);
  texture.refresh(); // upload the drawing to the GPU (WebGL)
  if (linear) texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
  return key;
}

// A smooth, pre-scaled copy of `srcKey` (optionally only its `crop` rect). The image
// is halved step by step first, so the final resize never skips source pixels.
// Returns the new key, or null if the source texture doesn't exist.
export function ensureScaledCopy(scene, srcKey, key, width, height, crop = null) {
  if (scene.textures.exists(key)) return key;
  if (!srcKey || !scene.textures.exists(srcKey)) return null;
  const source = scene.textures.get(srcKey).getSourceImage();
  let image = source;
  let { x, y, w, h } = crop || { x: 0, y: 0, w: source.width, h: source.height };

  while (w / 2 >= width && h / 2 >= height) {
    const half = document.createElement('canvas');
    half.width = Math.ceil(w / 2);
    half.height = Math.ceil(h / 2);
    const ctx = half.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, x, y, w, h, 0, 0, half.width, half.height);
    image = half;
    x = 0;
    y = 0;
    w = half.width;
    h = half.height;
  }

  return ensureCanvasTexture(scene, key, Math.max(1, width), Math.max(1, height), (ctx, cw, ch) => {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, x, y, w, h, 0, 0, cw, ch);
  });
}

const EDGE_COLORS = {
  [GEN.edgeDamage]: [232, 52, 63], // health red
  [GEN.edgeToxic]: [155, 227, 58], // toxicity green
  [GEN.edgeToxicShade]: [13, 42, 6], // dark green, for contrast under the glow
  [GEN.edgeDark]: [0, 0, 0],
};
const DOT_COLORS = { npc: '#efe6d2', companion: '#7be35a', pickup: '#f0a030' };

// Fill every pixel of a canvas with colour `rgb` and the alpha from alphaAt(nx, ny);
// nx/ny run from -1 to 1 across the canvas.
function paintAlpha(ctx, w, h, rgb, alphaAt) {
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      img.data[i] = rgb[0];
      img.data[i + 1] = rgb[1];
      img.data[i + 2] = rgb[2];
      img.data[i + 3] = Math.round(255 * Math.max(0, Math.min(1, alphaAt(((x + 0.5) / w) * 2 - 1, ((y + 0.5) / h) * 2 - 1))));
    }
  }
  ctx.putImageData(img, 0, 0);
}

const smoothstep = (t) => {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
};

export function ensureScanlines(scene) {
  return ensureCanvasTexture(scene, GEN.scanlines, 4, 4, (ctx) => {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(0, 2, 4, 2);
  });
}

// 64×64 soft radial glow in colour `rgb` (use with additive blending).
export function ensureColorGlow(scene, key, rgb) {
  return ensureCanvasTexture(scene, key, 64, 64, (ctx, w, h) => paintAlpha(ctx, w, h, rgb, (nx, ny) => {
    const d = Math.sqrt(nx * nx + ny * ny);
    return Math.pow(1 - smoothstep(d), 1.6);
  }), { linear: true });
}

export function ensureGlow(scene) {
  return ensureColorGlow(scene, GEN.glow, [58, 212, 232]);
}

// Soft white radial "bloom": bright in the middle, clear at the edges (16:9, shown stretched).
export function ensureBloom(scene) {
  return ensureCanvasTexture(scene, GEN.bloom, 160, 90, (ctx, w, h) => paintAlpha(ctx, w, h, [255, 252, 244], (nx, ny) => {
    const d = Math.sqrt(nx * nx + ny * ny);
    return 1 - smoothstep(d * 0.95);
  }), { linear: true });
}

// The drifting memory fragments use task Q's `fx-memory` (16×4 white streak);
// if it isn't loaded, a look-alike is drawn here. Returns the key to use.
export function memoryStreakKey(scene) {
  if (scene.textures.exists('fx-memory')) return 'fx-memory';
  return ensureCanvasTexture(scene, GEN.memoryStreak, 16, 4, (ctx, w, h) => paintAlpha(ctx, w, h, [255, 255, 255], (nx, ny) => {
    const along = 1 - Math.abs(nx); // fades towards both ends
    const across = 1 - Math.abs(ny);
    return Math.pow(along, 0.8) * Math.pow(across, 1.5);
  }), { linear: true });
}

// Screen-edge vignette `key` (one of the GEN.edge* keys). Rounded-box falloff:
// clear in the middle, solid along every edge (stronger in the corners).
export function ensureEdge(scene, key) {
  return ensureCanvasTexture(scene, key, 320, 180, (ctx, w, h) => paintAlpha(ctx, w, h, EDGE_COLORS[key], (nx, ny) => {
    const d = Math.pow(nx ** 4 + ny ** 4, 0.25);
    return smoothstep((d - 0.6) / 0.45);
  }), { linear: true });
}

// Minimap markers, drawn with canvas paths (dark outline first, then the colour).
export function ensureMinimapTextures(scene, { innerRadius }) {
  ensureGlow(scene);

  for (const [kind, color] of Object.entries(DOT_COLORS)) {
    ensureCanvasTexture(scene, GEN.mmDot[kind], 6, 6, (ctx) => {
      ctx.fillStyle = '#05060a';
      ctx.fillRect(1, 0, 4, 6);
      ctx.fillRect(0, 1, 6, 4);
      ctx.fillStyle = color;
      ctx.fillRect(2, 1, 2, 4);
      ctx.fillRect(1, 2, 4, 2);
    });
  }

  ensureCanvasTexture(scene, GEN.mmArrow, 19, 19, (ctx) => {
    const arrow = (inset) => {
      ctx.beginPath();
      ctx.moveTo(9.5, 1 + inset * 1.4);
      ctx.lineTo(17.5 - inset, 17 - inset * 0.7);
      ctx.lineTo(9.5, 13 - inset * 0.3);
      ctx.lineTo(1.5 + inset, 17 - inset * 0.7);
      ctx.closePath();
      ctx.fill();
    };
    ctx.fillStyle = '#05060a';
    arrow(0);
    ctx.fillStyle = '#3ad4e8';
    arrow(2);
    ctx.fillStyle = '#d8faff'; // bright left facet, so it reads as a pointer
    ctx.beginPath();
    ctx.moveTo(9.5, 4.5);
    ctx.lineTo(9.5, 11.6);
    ctx.lineTo(5, 14.2);
    ctx.closePath();
    ctx.fill();
  });

  ensureCanvasTexture(scene, GEN.mmDiamond, 15, 15, (ctx) => {
    const diamond = (r) => {
      ctx.beginPath();
      ctx.moveTo(7.5, 7.5 - r);
      ctx.lineTo(7.5 + r, 7.5);
      ctx.lineTo(7.5, 7.5 + r);
      ctx.lineTo(7.5 - r, 7.5);
      ctx.closePath();
      ctx.fill();
    };
    ctx.fillStyle = '#05060a';
    diamond(7.5);
    ctx.fillStyle = '#ffd23f';
    diamond(6);
    ctx.fillStyle = '#3a2a08';
    diamond(3.6);
    ctx.fillStyle = '#ffe98a';
    diamond(2);
  });

  // Inner shadow: transparent in the middle, dark towards the rim.
  const size = Math.ceil(innerRadius * 2) + 4;
  ensureCanvasTexture(scene, GEN.mmShade, size, size, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, innerRadius * 0.55, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(5, 8, 14, 0)');
    g.addColorStop(0.75, 'rgba(5, 8, 14, 0.35)');
    g.addColorStop(1, 'rgba(5, 8, 14, 0.85)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });

  // Radar sweep: a soft cyan wedge that fades out behind its leading edge.
  ensureCanvasTexture(scene, GEN.mmSweep, size, size, (ctx, w, h) => {
    const cx = w / 2;
    const cy = h / 2;
    const steps = 40;
    const span = Math.PI / 2.2;
    for (let i = 0; i < steps; i++) {
      const a0 = -Math.PI / 2 - (span * (i + 1)) / steps;
      const a1 = -Math.PI / 2 - (span * i) / steps;
      ctx.fillStyle = `rgba(58, 212, 232, ${0.3 * Math.pow(1 - i / steps, 2)})`;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, w / 2, a0, a1 + 0.01);
      ctx.closePath();
      ctx.fill();
    }
  }, { linear: true });
}
