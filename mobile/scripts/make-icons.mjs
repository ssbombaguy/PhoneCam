// Generates the app icons (same design as the Chrome extension icon) with no
// image libraries: 4x4 supersampled shapes + a minimal PNG encoder.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const GREEN = [61, 220, 151];
const INK = [6, 42, 27];
const WHITE = [255, 255, 255];

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// Camera glyph in a 32x32 space. Returns 'body', 'lens' or null.
function glyph(x, y) {
  if ((x - 16) ** 2 + (y - 17.5) ** 2 <= 16) return 'lens';
  if (inRoundRect(x, y, 6, 11, 26, 24, 1.5) || inRoundRect(x, y, 12, 8.5, 20, 12, 1)) return 'body';
  return null;
}

// Each variant maps a point in 32x32 design space to a colour (or null).
const variants = {
  // Full-bleed square; launchers apply their own mask.
  'icon.png': (x, y) => (glyph(x, y) === 'body' ? INK : GREEN),
  // Adaptive icon foreground: glyph scaled into the 66% safe zone, transparent around it.
  'android-icon-foreground.png': (x, y) => {
    const g = glyph(16 + (x - 16) / 0.62, 16 + (y - 16) / 0.62);
    return g === 'body' ? INK : null;
  },
  'android-icon-background.png': () => GREEN,
  'android-icon-monochrome.png': (x, y) => {
    const g = glyph(16 + (x - 16) / 0.62, 16 + (y - 16) / 0.62);
    return g === 'body' ? WHITE : null;
  },
  // Splash: green tile with the glyph, centred on the dark splash background.
  'splash-icon.png': (x, y) => {
    if (!inRoundRect(x, y, 4, 4, 28, 28, 6)) return null;
    return glyph(16 + (x - 16) / 0.75, 16 + (y - 16) / 0.75) === 'body' ? INK : GREEN;
  },
  'favicon.png': (x, y) => (inRoundRect(x, y, 0, 0, 32, 32, 8) ? (glyph(x, y) === 'body' ? INK : GREEN) : null),
};

const sizes = { 'favicon.png': 48 };

function render(size, shade) {
  const SS = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade(((pxl + (sx + 0.5) / SS) / size) * 32, ((py + (sy + 0.5) / SS) / size) * 32);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a++;
        }
      }
      const i = (py * size + pxl) * 4;
      if (a) {
        px[i] = Math.round(r / a);
        px[i + 1] = Math.round(g / a);
        px[i + 2] = Math.round(b / a);
      }
      px[i + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return encodePng(size, size, px);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const [file, shade] of Object.entries(variants)) {
  fs.writeFileSync(path.join(ASSETS, file), render(sizes[file] || 1024, shade));
  console.log(`wrote ${file}`);
}
