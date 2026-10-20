// Renders the extension icons as PNGs at build time so the repository holds no binaries.
// The glyph is a rounded tile with three "section" rows: a folder tab and two list rows.
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

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

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function insideRoundRect(x, y, rx, ry, rw, rh, r) {
  if (x < rx || y < ry || x > rx + rw || y > ry + rh) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + rw - r);
  const cy = Math.min(Math.max(y, ry + r), ry + rh - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// Shapes in a 0..1 unit square, painted in order.
const SHAPES = [
  { rect: [0.02, 0.02, 0.96, 0.96, 0.2], color: [31, 35, 40, 255] },
  { rect: [0.18, 0.2, 0.18, 0.14, 0.04], color: [63, 185, 80, 255] },
  { rect: [0.4, 0.22, 0.42, 0.1, 0.05], color: [240, 246, 252, 255] },
  { rect: [0.18, 0.43, 0.18, 0.14, 0.04], color: [88, 166, 255, 255] },
  { rect: [0.4, 0.45, 0.42, 0.1, 0.05], color: [240, 246, 252, 255] },
  { rect: [0.18, 0.66, 0.18, 0.14, 0.04], color: [210, 153, 34, 255] },
  { rect: [0.4, 0.68, 0.42, 0.1, 0.05], color: [240, 246, 252, 255] },
];

export function renderIcon(size) {
  const samples = 4;
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          let color = null;
          for (const shape of SHAPES) {
            const [rx, ry, rw, rh, rr] = shape.rect;
            if (insideRoundRect(x, y, rx, ry, rw, rh, rr)) color = shape.color;
          }
          if (color) {
            r += color[0]; g += color[1]; b += color[2]; a += color[3];
          }
        }
      }
      const n = samples * samples;
      const i = (py * size + px) * 4;
      const alpha = a / n;
      // Store straight (un-premultiplied) color.
      rgba[i] = alpha ? Math.round((r / n) * (255 / alpha)) : 0;
      rgba[i + 1] = alpha ? Math.round((g / n) * (255 / alpha)) : 0;
      rgba[i + 2] = alpha ? Math.round((b / n) * (255 / alpha)) : 0;
      rgba[i + 3] = Math.round(alpha);
    }
  }
  return encodePng(size, rgba);
}
