// Generates the app icons (PNG) with no dependencies: a cream star on a figure base, on Eevee brown.
// Usage: node scripts/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, px) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const TOP = hex('#b0723f'), BOT = hex('#7a4522'), CREAM = hex('#f6e6c4'), SHADE = hex('#e3c999'), BASE = hex('#5a3218');

function star(cx, cy, R, r) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 ? r : R;
    pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
  }
  return pts;
}
function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// shapes in a unit square (0..1); `scale` shrinks the art toward the centre for maskable icons
function render(size, { scale = 1, rounded = false } = {}) {
  const S = 4; // supersampling
  const px = Buffer.alloc(size * size * 4);
  const tf = (v) => 0.5 + (v - 0.5) * scale;
  const st = star(tf(0.5), tf(0.45), 0.27 * scale, 0.125 * scale);
  const baseC = [tf(0.5), tf(0.76)], baseR = [0.25 * scale, 0.065 * scale];
  const rad = 0.22;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let acc = [0, 0, 0, 0];
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const u = (x + (sx + 0.5) / S) / size, v = (y + (sy + 0.5) / S) / size;
      if (rounded) { // rounded-square mask
        const dx = Math.max(rad - u, u - (1 - rad), 0), dy = Math.max(rad - v, v - (1 - rad), 0);
        if (dx * dx + dy * dy > rad * rad) continue;
      }
      let c = TOP.map((t, i) => t + (BOT[i] - t) * v);
      const ex = (u - baseC[0]) / baseR[0], ey = (v - baseC[1]) / baseR[1];
      if (ex * ex + ey * ey <= 1) c = ey < -0.15 ? SHADE : BASE;
      if (inPoly(u, v, st)) c = u > tf(0.5) && v > tf(0.4) ? SHADE : CREAM;
      acc = [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2], acc[3] + 255];
    }
    const n = S * S, a = acc[3] / n;
    const o = (y * size + x) * 4;
    if (a) { px[o] = acc[0] / (acc[3] / 255); px[o + 1] = acc[1] / (acc[3] / 255); px[o + 2] = acc[2] / (acc[3] / 255); }
    px[o + 3] = Math.round(a);
  }
  return png(size, px);
}

writeFileSync('icons/icon-192.png', render(192, { rounded: true }));
writeFileSync('icons/icon-512.png', render(512, { rounded: true }));
writeFileSync('icons/icon-maskable-512.png', render(512, { scale: 0.78 }));
writeFileSync('icons/apple-touch-icon.png', render(180)); // iOS rounds the corners itself; must be opaque
console.log('icons written');
