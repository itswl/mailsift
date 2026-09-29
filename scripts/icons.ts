#!/usr/bin/env node
/**
 * Draw the app icon and emit it as PNG, with no image dependency.
 *
 * The mark is geometric, so it can be rasterised directly: shapes are sampled
 * with supersampling into an RGBA buffer, and PNG is little more than zlib
 * around filtered scanlines. Output is written as a TypeScript module of
 * base64 strings, which keeps the runtime free of static file serving and the
 * container image free of an assets directory.
 *
 * Run with: npx tsx scripts/icons.ts
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const BG = [0x2f, 0x6f, 0xd0] as const;
const GLYPH = [0xff, 0xff, 0xff] as const;
const ACCENT = [0xf5, 0xa5, 0x24] as const;
const SAMPLES = 4;

type Rgb = readonly [number, number, number];

/** Distance from a point to a line segment, for stroking a polyline. */
function distanceToSegment(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/** Signed distance to a rounded rectangle: negative inside. */
function roundedRect(x: number, y: number, x0: number, y0: number, x1: number, y1: number, r: number): number {
  const cx = Math.max(x0 + r, Math.min(x1 - r, x));
  const cy = Math.max(y0 + r, Math.min(y1 - r, y));
  const inside = x >= x0 && x <= x1 && y >= y0 && y <= y1;
  const d = Math.hypot(x - cx, y - cy) - r;
  return inside && x > x0 + r === false && false ? d : d;
}

/**
 * The mark, on a unit canvas.
 *
 * An envelope with a badge over one corner: mail, and the one piece of it that
 * was judged worth interrupting for. Returns the colour at a point, or null
 * where the icon is transparent.
 */
function sample(x: number, y: number, scale: number, round: boolean): Rgb | null {
  // Background fills the tile. Rounded only for the favicon; the launcher and
  // iOS apply their own mask, and rounding twice leaves pale corners.
  if (round && roundedRect(x, y, 0, 0, 1, 1, 0.22) > 0) return null;

  // Scale the glyph about the centre so a maskable icon keeps its safe zone.
  const gx = (x - 0.5) / scale + 0.5;
  const gy = (y - 0.5) / scale + 0.5;

  const stroke = 0.055;
  const dot = Math.hypot(gx - 0.755, gy - 0.275);
  if (dot <= 0.105) return ACCENT;
  // A gap in the background colour, so the badge reads as sitting above.
  if (dot <= 0.142) return BG;

  const body = Math.abs(roundedRect(gx, gy, 0.20, 0.31, 0.80, 0.71, 0.05));
  if (body <= stroke / 2) return GLYPH;

  const flap = Math.min(
    distanceToSegment(gx, gy, 0.20, 0.355, 0.50, 0.545),
    distanceToSegment(gx, gy, 0.50, 0.545, 0.80, 0.355),
  );
  if (flap <= stroke / 2) return GLYPH;

  return BG;
}

function render(size: number, scale: number, round: boolean): Buffer {
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const colour = sample(
            (px + (sx + 0.5) / SAMPLES) / size,
            (py + (sy + 0.5) / SAMPLES) / size,
            scale,
            round,
          );
          if (!colour) continue;
          r += colour[0];
          g += colour[1];
          b += colour[2];
          a += 255;
        }
      }
      const n = SAMPLES * SAMPLES;
      const i = (py * size + px) * 4;
      // Premultiplied average, so edges blend against whatever is behind them.
      rgba[i] = a === 0 ? 0 : Math.round(r / (a / 255));
      rgba[i + 1] = a === 0 ? 0 : Math.round(g / (a / 255));
      rgba[i + 2] = a === 0 ? 0 : Math.round(b / (a / 255));
      rgba[i + 3] = Math.round(a / n);
    }
  }
  return rgba;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(size: number, rgba: Buffer): Buffer {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const icons: Array<{ name: string; size: number; scale: number; round: boolean }> = [
  // Launcher icons carry their own background; the platform masks them.
  { name: 'icon192', size: 192, scale: 1, round: false },
  { name: 'icon512', size: 512, scale: 1, round: false },
  // Maskable: the glyph must survive a circular crop, so it sits in the middle 72%.
  { name: 'maskable512', size: 512, scale: 0.72, round: false },
  // iOS never rounds a transparent corner, so this one is square and opaque.
  { name: 'appleTouch180', size: 180, scale: 1, round: false },
  { name: 'favicon64', size: 64, scale: 1, round: true },
];

const lines = [
  '/**',
  ' * Application icons, generated by scripts/icons.ts.',
  ' *',
  ' * Base64 rather than files on disk: the runtime serves them from memory and',
  ' * the container image needs no assets directory. Regenerate with',
  ' * `npx tsx scripts/icons.ts` after changing the mark.',
  ' */',
  '',
];
for (const icon of icons) {
  const png = encodePng(icon.size, render(icon.size, icon.scale, icon.round));
  lines.push(`/** ${icon.size}x${icon.size}, ${png.length} bytes. */`);
  lines.push(`export const ${icon.name} = Buffer.from('${png.toString('base64')}', 'base64');`);
  lines.push('');
  console.log(`${icon.name.padEnd(14)} ${icon.size}x${icon.size}  ${String(png.length).padStart(6)} bytes`);
}
writeFileSync('src/web-icons.ts', lines.join('\n'));
console.log('wrote src/web-icons.ts');
