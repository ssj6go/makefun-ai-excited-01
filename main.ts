// Moon Loop — an entry for make.fun ai-excited-01.
//
// A program that draws one image, "Moon Loop", and writes it to
// /output/entry.png: a roller-coaster train upside down at the top of a
// vertical loop that pierces the bottom edge of a giant full moon, over a
// sleeping city, with a big clean "WOW!" for the judge.
//
// Everything is procedural: a small software rasterizer draws the scene
// into an RGB buffer, and a hand-written PNG encoder (node:zlib deflate
// plus an own CRC32) writes the file. No assets, no network, no randomness
// outside a seeded PRNG, so two runs write byte-identical files.
//
// Run it outside the grader with:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';

// ---------------------------------------------------------------- canvas

const W = 1024;
const H = 1024;

// RGB buffer, row-major.
const px = new Uint8Array(W * H * 3);

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Deterministic PRNG (mulberry32). One fixed seed: the same scene, every run.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261117);

// ---------------------------------------------------------------- pixels

function setPixel(x: number, y: number, r: number, g: number, b: number): void {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = r;
  px[i + 1] = g;
  px[i + 2] = b;
}

// Alpha-composite a color over the pixel already there.
function blend(x: number, y: number, r: number, g: number, b: number, a: number): void {
  if (a <= 0) return;
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 3;
  if (a >= 1) {
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    return;
  }
  px[i] = Math.round(px[i] * (1 - a) + r * a);
  px[i + 1] = Math.round(px[i + 1] * (1 - a) + g * a);
  px[i + 2] = Math.round(px[i + 2] * (1 - a) + b * a);
}

// Smooth edge coverage for a signed distance: 1 inside, 0 outside, 1px ramp.
function edge(d: number): number {
  return clamp(0.5 - d, 0, 1);
}

// ---------------------------------------------------------------- shapes

// Antialiased filled disc. `shade` colors each covered pixel from its
// distance to the centre (0 at centre, 1 at the rim); pass null for flat.
function disc(
  cx: number, cy: number, radius: number,
  shade: ((t: number) => [number, number, number, number]) | null,
  flat: [number, number, number, number] | null,
): void {
  const x0 = Math.max(0, Math.floor(cx - radius - 1));
  const x1 = Math.min(W - 1, Math.ceil(cx + radius + 1));
  const y0 = Math.max(0, Math.floor(cy - radius - 1));
  const y1 = Math.min(H - 1, Math.ceil(cy + radius + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - radius;
      const cov = edge(d);
      if (cov <= 0) continue;
      if (shade) {
        const t = clamp(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / radius, 0, 1);
        const [r, g, b, a] = shade(t);
        blend(x, y, r, g, b, a * cov);
      } else if (flat) {
        blend(x, y, flat[0], flat[1], flat[2], flat[3] * cov);
      }
    }
  }
}

// Antialiased stroked circle (a ring of `width` centred on `radius`).
function ring(
  cx: number, cy: number, radius: number, width: number,
  r: number, g: number, b: number, a: number,
): void {
  const outer = radius + width / 2;
  const x0 = Math.max(0, Math.floor(cx - outer - 1));
  const x1 = Math.min(W - 1, Math.ceil(cx + outer + 1));
  const y0 = Math.max(0, Math.floor(cy - outer - 1));
  const y1 = Math.min(H - 1, Math.ceil(cy + outer + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.abs(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - radius) - width / 2;
      const cov = edge(d);
      if (cov > 0) blend(x, y, r, g, b, a * cov);
    }
  }
}

// Distance from a point to a segment.
function segDist(pxx: number, pyy: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((pxx - x1) * dx + (pyy - y1) * dy) / len2;
  t = clamp(t, 0, 1);
  return Math.hypot(pxx - (x1 + t * dx), pyy - (y1 + t * dy));
}

// Antialiased thick line with round caps.
function line(
  x1: number, y1: number, x2: number, y2: number, width: number,
  r: number, g: number, b: number, a: number,
): void {
  const pad = width / 2 + 1;
  const x0 = Math.max(0, Math.floor(Math.min(x1, x2) - pad));
  const x1b = Math.min(W - 1, Math.ceil(Math.max(x1, x2) + pad));
  const y0 = Math.max(0, Math.floor(Math.min(y1, y2) - pad));
  const y1b = Math.min(H - 1, Math.ceil(Math.max(y1, y2) + pad));
  for (let y = y0; y <= y1b; y++) {
    for (let x = x0; x <= x1b; x++) {
      const d = segDist(x + 0.5, y + 0.5, x1, y1, x2, y2) - width / 2;
      const cov = edge(d);
      if (cov > 0) blend(x, y, r, g, b, a * cov);
    }
  }
}

// Polyline of thick segments.
function polyline(
  pts: Array<[number, number]>, width: number,
  r: number, g: number, b: number, a: number,
): void {
  for (let i = 0; i + 1 < pts.length; i++) {
    line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], width, r, g, b, a);
  }
}

// Quadratic bezier sampled into a polyline.
function bezier(
  x0: number, y0: number, cx: number, cy: number, x1: number, y1: number,
  steps: number,
): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    pts.push([
      u * u * x0 + 2 * u * t * cx + t * t * x1,
      u * u * y0 + 2 * u * t * cy + t * t * y1,
    ]);
  }
  return pts;
}

// Antialiased filled ellipse (axis-aligned).
function ellipse(
  cx: number, cy: number, rx: number, ry: number,
  r: number, g: number, b: number, a: number,
): void {
  const x0 = Math.max(0, Math.floor(cx - rx - 1));
  const x1 = Math.min(W - 1, Math.ceil(cx + rx + 1));
  const y0 = Math.max(0, Math.floor(cy - ry - 1));
  const y1 = Math.min(H - 1, Math.ceil(cy + ry + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const nx = (x + 0.5 - cx) / rx;
      const ny = (y + 0.5 - cy) / ry;
      const d = (Math.hypot(nx, ny) - 1) * Math.min(rx, ry);
      const cov = edge(d);
      if (cov > 0) blend(x, y, r, g, b, a * cov);
    }
  }
}

// Rounded rectangle, rotated by `angleDeg` around its centre, drawn from a
// signed-distance field so edges stay clean at any angle.
function roundedRect(
  cx: number, cy: number, w: number, h: number, radius: number,
  angleDeg: number, r: number, g: number, b: number, a: number,
): void {
  const th = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  const hw = w / 2;
  const hh = h / 2;
  const bound = Math.hypot(hw, hh) + 1;
  const x0 = Math.max(0, Math.floor(cx - bound));
  const x1 = Math.min(W - 1, Math.ceil(cx + bound));
  const y0 = Math.max(0, Math.floor(cy - bound));
  const y1 = Math.min(H - 1, Math.ceil(cy + bound));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      // Rotate the point back into the rectangle's local frame.
      const lx = dx * cos + dy * sin;
      const ly = -dx * sin + dy * cos;
      const qx = Math.abs(lx) - (hw - radius);
      const qy = Math.abs(ly) - (hh - radius);
      const ox = Math.max(qx, 0);
      const oy = Math.max(qy, 0);
      const d = Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - radius;
      const cov = edge(d);
      if (cov > 0) blend(x, y, r, g, b, a * cov);
    }
  }
}

// Four-point sparkle: a bright core with horizontal and vertical rays.
function sparkle(x: number, y: number, size: number, a: number): void {
  for (let i = -size; i <= size; i++) {
    const fall = 1 - Math.abs(i) / (size + 1);
    blend(x + i, y, 255, 250, 230, a * fall * fall);
    blend(x, y + i, 255, 250, 230, a * fall * fall);
  }
  blend(x, y, 255, 255, 255, a);
}

// ---------------------------------------------------------------- text
//
// The word "WOW!" is drawn with bold vector strokes (round-capped lines
// and a ring), not a bitmap font: at this size a pixel W blurs into an H,
// while four clean diagonal strokes read as W at any scale. The whole word
// is drawn three times — a soft yellow halo, a thicker dark underlay that
// peeks out as an outline, then the bright fill — so it stays legible over
// any background.

function drawW(x: number, y: number, s: number, w: number, r: number, g: number, b: number, a: number): void {
  // Four diagonal strokes: down, up to the centre peak, down, up.
  line(x, y, x + s * 0.27, y + s, w, r, g, b, a);
  line(x + s * 0.27, y + s, x + s * 0.5, y + s * 0.32, w, r, g, b, a);
  line(x + s * 0.5, y + s * 0.32, x + s * 0.73, y + s, w, r, g, b, a);
  line(x + s * 0.73, y + s, x + s, y, w, r, g, b, a);
}

function drawO(x: number, y: number, s: number, w: number, r: number, g: number, b: number, a: number): void {
  ring(x + s * 0.5, y + s * 0.5, s * 0.42, w, r, g, b, a);
}

function drawBang(x: number, y: number, s: number, w: number, r: number, g: number, b: number, a: number): void {
  const cx = x + s * 0.5;
  line(cx, y + s * 0.04, cx, y + s * 0.66, w, r, g, b, a);
  disc(cx, y + s * 0.88, w * 0.62, null, [r, g, b, a]);
}

// Draw "WOW!" with its top-left at (x, y), letters `s` px tall.
function drawWord(x: number, y: number, s: number): void {
  const gap = s * 0.18;
  const pass = (w: number, r: number, g: number, b: number, a: number): void => {
    let cx = x;
    drawW(cx, y, s, w, r, g, b, a);
    cx += s + gap;
    drawO(cx, y, s, w, r, g, b, a);
    cx += s + gap;
    drawW(cx, y, s, w, r, g, b, a);
    cx += s + gap;
    drawBang(cx, y, s, w, r, g, b, a);
  };
  pass(30, 255, 214, 80, 0.14); // soft halo
  pass(23, 8, 10, 38, 1); // dark underlay = outline
  pass(17, 255, 217, 61, 1); // bright fill
}

// ---------------------------------------------------------------- scene

const MOON_X = 690;
const MOON_Y = 320;
const MOON_R = 285;
const LOOP_X = 540;
const LOOP_Y = 560;
const LOOP_R = 200;

type RGB = [number, number, number];

// Multi-stop vertical gradient.
function gradient(stops: Array<[number, RGB]>, t: number): RGB {
  for (let i = 0; i + 1 < stops.length; i++) {
    if (t <= stops[i + 1][0]) {
      const f = (t - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
      return [
        Math.round(lerp(stops[i][1][0], stops[i + 1][1][0], f)),
        Math.round(lerp(stops[i][1][1], stops[i + 1][1][1], f)),
        Math.round(lerp(stops[i][1][2], stops[i + 1][1][2], f)),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

const SKY: Array<[number, RGB]> = [
  [0.0, [6, 10, 36]],
  [0.35, [13, 19, 56]],
  [0.65, [23, 18, 67]],
  [0.88, [42, 21, 71]],
  [1.0, [28, 15, 51]],
];

function drawSky(): void {
  for (let y = 0; y < H; y++) {
    const [r, g, b] = gradient(SKY, y / H);
    // Warm horizon glow around the city line.
    const glow = Math.max(0, 1 - Math.abs(y - 880) / 130);
    const gr = Math.round(lerp(r, 122, glow * glow * 0.35));
    const gg = Math.round(lerp(g, 52, glow * glow * 0.25));
    const gb = Math.round(lerp(b, 96, glow * glow * 0.3));
    for (let x = 0; x < W; x++) setPixel(x, y, gr, gg, gb);
  }
}

function drawStars(): void {
  for (let i = 0; i < 260; i++) {
    const x = Math.floor(rand() * W);
    const y = Math.floor(rand() * 860);
    // No stars on the moon's face.
    if (Math.hypot(x - MOON_X, y - MOON_Y) < MOON_R * 1.04) continue;
    const bright = rand();
    const a = 0.25 + bright * 0.65;
    if (bright > 0.94) {
      sparkle(x, y, 5 + Math.floor(rand() * 6), a);
    } else if (bright > 0.8) {
      blend(x, y, 235, 240, 255, a);
      blend(x + 1, y, 235, 240, 255, a * 0.6);
      blend(x, y + 1, 235, 240, 255, a * 0.6);
    } else {
      blend(x, y, 220, 228, 255, a);
    }
  }
  // One shooting star, upper left, clear of the text.
  const sx = 300;
  const sy = 150;
  for (let i = 0; i < 90; i++) {
    const t = i / 90;
    const a = (1 - t) * 0.9;
    blend(Math.round(sx + i * 1.6), Math.round(sy + i * 0.9), 255, 255, 255, a);
    if (i < 60) blend(Math.round(sx + i * 1.6), Math.round(sy + i * 0.9) + 1, 200, 220, 255, a * 0.5);
  }
  disc(sx, sy, 2.5, null, [255, 255, 255, 1]);
}

function drawMoon(): void {
  // Halo: pale gold light falling off around the disc.
  const haloR = MOON_R * 1.55;
  const x0 = Math.max(0, Math.floor(MOON_X - haloR));
  const x1 = Math.min(W - 1, Math.ceil(MOON_X + haloR));
  const y0 = Math.max(0, Math.floor(MOON_Y - haloR));
  const y1 = Math.min(H - 1, Math.ceil(MOON_Y + haloR));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - MOON_X, y + 0.5 - MOON_Y);
      if (d < MOON_R || d > haloR) continue;
      const t = (d - MOON_R) / (haloR - MOON_R);
      blend(x, y, 245, 230, 168, 0.16 * (1 - t) * (1 - t));
    }
  }
  // The disc: warm cream, brighter at the centre, dimming toward the limb.
  disc(MOON_X, MOON_Y, MOON_R, (t) => {
    const core: RGB = [255, 248, 220];
    const edgeC: RGB = [228, 205, 142];
    const f = t * t;
    return [
      Math.round(lerp(core[0], edgeC[0], f)),
      Math.round(lerp(core[1], edgeC[1], f)),
      Math.round(lerp(core[2], edgeC[2], f)),
      1,
    ];
  }, null);
  // Craters: soft darker patches, seeded, kept inside the disc.
  for (let i = 0; i < 16; i++) {
    const ang = rand() * Math.PI * 2;
    const dist = Math.sqrt(rand()) * MOON_R * 0.82;
    const cx = MOON_X + Math.cos(ang) * dist;
    const cy = MOON_Y + Math.sin(ang) * dist;
    const cr = 10 + rand() * 42;
    disc(cx, cy, cr, null, [196, 172, 110, 0.12 + rand() * 0.12]);
  }
}

// Wispy dark clouds drifting across the moon's lower edge — kept faint so
// they read as atmosphere, not smudges.
function drawClouds(): void {
  ellipse(400, 585, 150, 16, 10, 15, 42, 0.16);
  ellipse(850, 640, 120, 13, 12, 17, 46, 0.14);
}

// The coaster track: a full vertical loop plus approach rails sweeping in
// from the lower left and out to the lower right, on support pillars.
function drawTrack(): void {
  const dark: [number, number, number] = [16, 22, 40];
  const steel: [number, number, number] = [168, 196, 232];
  // The loop: a dark band, two bright rails on it, ties across it.
  ring(LOOP_X, LOOP_Y, LOOP_R, 13, dark[0], dark[1], dark[2], 1);
  ring(LOOP_X, LOOP_Y, LOOP_R - 4.5, 2.5, steel[0], steel[1], steel[2], 0.95);
  ring(LOOP_X, LOOP_Y, LOOP_R + 4.5, 2.5, steel[0], steel[1], steel[2], 0.95);
  for (let deg = 0; deg < 360; deg += 12) {
    const th = (deg * Math.PI) / 180;
    const ix = LOOP_X + Math.cos(th) * (LOOP_R - 7);
    const iy = LOOP_Y + Math.sin(th) * (LOOP_R - 7);
    const ox = LOOP_X + Math.cos(th) * (LOOP_R + 7);
    const oy = LOOP_Y + Math.sin(th) * (LOOP_R + 7);
    line(ix, iy, ox, oy, 2.5, 38, 48, 78, 1);
  }
  // Approach rails: bezier sweeps meeting the loop's lower sides.
  const entry = bezier(28, 940, 210, 860, 399, 701, 48);
  const exit = bezier(681, 701, 850, 860, 1000, 940, 48);
  for (const rail of [entry, exit]) {
    polyline(rail, 13, dark[0], dark[1], dark[2], 1);
    // Two bright rails offset either side of the centre line.
    for (const off of [-4.5, 4.5]) {
      const side: Array<[number, number]> = rail.map(([x, y], i) => {
        const [nx, ny] = rail[Math.min(i + 1, rail.length - 1)];
        const [pxx, pyy] = rail[Math.max(i - 1, 0)];
        const dx = nx - pxx;
        const dy = ny - pyy;
        const len = Math.hypot(dx, dy) || 1;
        return [x + (-dy / len) * off, y + (dx / len) * off];
      });
      polyline(side, 2.5, steel[0], steel[1], steel[2], 0.95);
    }
  }
  // Support pillars: two under the loop, one under each approach rail.
  // Legs run to the bottom edge so they never float above the rooftops;
  // the city is drawn over them later.
  const ground = 905;
  line(LOOP_X - 60, LOOP_Y + LOOP_R - 6, LOOP_X - 85, H, 9, dark[0], dark[1], dark[2], 1);
  line(LOOP_X + 60, LOOP_Y + LOOP_R - 6, LOOP_X + 85, H, 9, dark[0], dark[1], dark[2], 1);
  line(LOOP_X - 85, ground, LOOP_X + 85, ground, 7, dark[0], dark[1], dark[2], 1);
  line(LOOP_X - 60, LOOP_Y + LOOP_R - 6, LOOP_X + 60, LOOP_Y + LOOP_R - 6, 7, dark[0], dark[1], dark[2], 1);
  line(230, 838, 215, H, 8, dark[0], dark[1], dark[2], 1);
  line(800, 838, 815, H, 8, dark[0], dark[1], dark[2], 1);
  // Light edges on the pillars so they read against the night.
  line(LOOP_X - 60, LOOP_Y + LOOP_R - 6, LOOP_X - 85, H, 2, 120, 140, 190, 0.5);
  line(LOOP_X + 60, LOOP_Y + LOOP_R - 6, LOOP_X + 85, H, 2, 120, 140, 190, 0.5);
}

// The train: four cars at the top of the loop, upside down, windows glowing.
function drawTrain(): void {
  const carAngles = [246, 262, 278, 294];
  for (let i = 0; i < carAngles.length; i++) {
    const th = (carAngles[i] * Math.PI) / 180;
    const cx = LOOP_X + Math.cos(th) * LOOP_R;
    const cy = LOOP_Y + Math.sin(th) * LOOP_R;
    // The car's long axis follows the loop's tangent.
    const tangentDeg = carAngles[i] + 90;
    roundedRect(cx, cy, 46, 22, 8, tangentDeg, 255, 59, 48, 1);
    // Glowing windows: three bright dots along the outward face.
    for (const off of [-15, 0, 15]) {
      const wx = cx + Math.cos(th) * 0 + Math.cos((tangentDeg * Math.PI) / 180) * off + Math.cos(th) * 8;
      const wy = cy + Math.sin(th) * 0 + Math.sin((tangentDeg * Math.PI) / 180) * off + Math.sin(th) * 8;
      disc(wx, wy, 3.5, null, [255, 224, 138, 1]);
    }
    // Headlight on the leading car.
    if (i === 0) {
      const hx = cx + Math.cos(((tangentDeg + 180) * Math.PI) / 180) * 26;
      const hy = cy + Math.sin(((tangentDeg + 180) * Math.PI) / 180) * 26;
      disc(hx, hy, 4, null, [255, 255, 240, 1]);
      line(hx, hy, hx + Math.cos(((tangentDeg + 180) * Math.PI) / 180) * 46, hy + Math.sin(((tangentDeg + 180) * Math.PI) / 180) * 46, 3, 255, 250, 200, 0.55);
    }
  }
}

// Speed lines: short streaks tangent to the loop, denser near the train,
// plus a few long horizontal streaks across the sky.
function drawSpeedLines(): void {
  for (let i = 0; i < 46; i++) {
    const nearTrain = rand() < 0.6;
    const ang = nearTrain
      ? (230 + rand() * 100) * (Math.PI / 180)
      : rand() * Math.PI * 2;
    const rr = LOOP_R + 18 + rand() * 60;
    const cx = LOOP_X + Math.cos(ang) * rr;
    const cy = LOOP_Y + Math.sin(ang) * rr;
    const tan = ang + Math.PI / 2;
    const len = 18 + rand() * 55;
    const a = 0.15 + rand() * 0.45;
    const w = 1.5 + rand() * 2;
    line(
      cx - Math.cos(tan) * len / 2, cy - Math.sin(tan) * len / 2,
      cx + Math.cos(tan) * len / 2, cy + Math.sin(tan) * len / 2,
      w, 191, 230, 255, a,
    );
  }
  for (let i = 0; i < 7; i++) {
    const y = 120 + rand() * 500;
    const x = rand() * 500;
    const len = 60 + rand() * 130;
    line(x, y, x + len, y + (rand() - 0.5) * 8, 2, 191, 230, 255, 0.12 + rand() * 0.2);
  }
}

// Sparks bursting off the track near the train.
function drawSparks(): void {
  for (let i = 0; i < 60; i++) {
    const ang = (225 + rand() * 110) * (Math.PI / 180);
    const rr = LOOP_R + 8 + rand() * 90;
    const x = LOOP_X + Math.cos(ang) * rr;
    const y = LOOP_Y + Math.sin(ang) * rr;
    const gold = rand() < 0.6;
    if (rand() < 0.3) {
      sparkle(Math.round(x), Math.round(y), 3 + Math.floor(rand() * 3), 0.5 + rand() * 0.4);
    } else {
      disc(x, y, 1 + rand() * 1.6, null, gold ? [255, 209, 102, 0.9] : [127, 212, 255, 0.9]);
    }
  }
}

// The sleeping city: dark towers with warm lit windows.
function drawCity(): void {
  let x = 0;
  while (x < W) {
    const bw = 34 + Math.floor(rand() * 48);
    const bh = 42 + Math.floor(rand() * 110);
    const top = H - bh;
    for (let yy = top; yy < H; yy++) {
      for (let xx = x; xx < Math.min(x + bw, W); xx++) {
        setPixel(xx, yy, 4, 6, 15);
      }
    }
    // Lit windows.
    for (let wy = top + 8; wy < H - 8; wy += 13) {
      for (let wx = x + 6; wx < Math.min(x + bw - 6, W - 4); wx += 11) {
        if (rand() < 0.34) {
          const warm = rand() < 0.8;
          for (let dy = 0; dy < 5; dy++) {
            for (let dx = 0; dx < 4; dx++) {
              blend(wx + dx, wy + dy, warm ? 255 : 159, warm ? 196 : 216, warm ? 107 : 255, 0.85);
            }
          }
        }
      }
    }
    // Antenna on the tallest towers.
    if (bh > 120 && rand() < 0.6) {
      const ax = x + Math.floor(bw / 2);
      line(ax, top, ax, top - 22, 2, 4, 6, 15, 1);
      disc(ax, top - 24, 2.5, null, [255, 70, 60, 1]);
    }
    x += bw + 2 + Math.floor(rand() * 8);
  }
}

// ---------------------------------------------------------------- PNG

// CRC32 (IEEE 802.3), the checksum every PNG chunk carries.
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const crcBuf = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  out.writeUInt32BE(crc32(crcBuf), 8 + data.length);
  return out;
}

// Encode the RGB buffer as a PNG: 8-bit colour type 2, filter 0 per row,
// deflate at level 9. Fully deterministic: same buffer, same bytes.
function encodePng(): Buffer {
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0; // filter: none
    Buffer.from(px.buffer, y * W * 3, W * 3).copy(raw, y * (1 + W * 3) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- main

drawSky();
drawStars();
drawMoon();
drawClouds();
drawTrack();
drawTrain();
drawSpeedLines();
drawSparks();
drawCity();
drawWord(48, 60, 100);

const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outDir, { recursive: true });
const png = encodePng();
writeFileSync(join(outDir, 'entry.png'), png);
console.log(`wrote entry.png: ${png.length} bytes, ${W}x${H}`);
