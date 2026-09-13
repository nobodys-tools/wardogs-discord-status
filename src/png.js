// Dependency-free RGBA canvas + PNG encoder + 5x7 bitmap font. Enough for a line chart.
import { deflateSync } from "node:zlib";

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

export function hexToRgb(hex, fallback = [255, 255, 255]) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return fallback;
  const v = parseInt(m[1], 16);
  return [v >> 16, (v >> 8) & 255, v & 255];
}

export class Canvas {
  constructor(width, height, bg = [0, 0, 0, 255]) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 4);
    this.fillRect(0, 0, width, height, bg);
  }

  // Alpha-blend a pixel. color = [r,g,b] or [r,g,b,a]
  px(x, y, color) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const a = (color[3] ?? 255) / 255;
    const i = (y * this.width + x) * 4;
    const d = this.data;
    d[i] = Math.round(color[0] * a + d[i] * (1 - a));
    d[i + 1] = Math.round(color[1] * a + d[i + 1] * (1 - a));
    d[i + 2] = Math.round(color[2] * a + d[i + 2] * (1 - a));
    d[i + 3] = 255;
  }

  fillRect(x, y, w, h, color) {
    const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w)), y1 = Math.min(this.height, Math.round(y + h));
    const a = color[3] ?? 255;
    if (a === 255) {
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * this.width + xx) * 4;
          this.data[i] = color[0]; this.data[i + 1] = color[1]; this.data[i + 2] = color[2]; this.data[i + 3] = 255;
        }
      }
      return;
    }
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.px(xx, yy, color);
  }

  // Anti-aliased-ish line via supersampling along its length.
  line(x0, y0, x1, y1, color, thickness = 1) {
    const dx = x1 - x0, dy = y1 - y0;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 2));
    const half = (thickness - 1) / 2;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = x0 + dx * t, y = y0 + dy * t;
      for (let ox = -half; ox <= half; ox += 1) {
        for (let oy = -half; oy <= half; oy += 1) this.px(x + ox, y + oy, color);
      }
    }
  }

  circle(cx, cy, r, color) {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
      if (x * x + y * y <= r * r) this.px(cx + x, cy + y, color);
    }
  }

  text(x, y, str, color, scale = 1) {
    let cx = x;
    for (const ch of String(str)) {
      const glyph = FONT[ch] || FONT["?"];
      for (let row = 0; row < 7; row++) {
        const bits = glyph[row];
        for (let col = 0; col < 5; col++) {
          if (bits & (1 << (4 - col))) this.fillRect(cx + col * scale, y + row * scale, scale, scale, color);
        }
      }
      cx += 6 * scale;
    }
    return cx - x;
  }

  static textWidth(str, scale = 1) {
    return String(str).length * 6 * scale - scale;
  }

  toPNG() {
    const { width, height, data } = this;
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
      raw[y * (width * 4 + 1)] = 0; // filter: none
      data.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // RGBA
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw, { level: 9 })),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }
}

// 5x7 glyphs, one byte per row, MSB = leftmost column.
const FONT = {
  "0": [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  "1": [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  "2": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  "3": [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  "4": [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  "5": [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  "6": [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  "7": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  "9": [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  "-": [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  "+": [0x00, 0x04, 0x04, 0x1f, 0x04, 0x04, 0x00],
  ":": [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00],
  "/": [0x01, 0x01, 0x02, 0x04, 0x08, 0x10, 0x10],
  ".": [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  " ": [0, 0, 0, 0, 0, 0, 0],
  "?": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x00, 0x04],
  "h": [0x10, 0x10, 0x16, 0x19, 0x11, 0x11, 0x11],
  "n": [0x00, 0x00, 0x16, 0x19, 0x11, 0x11, 0x11],
  "o": [0x00, 0x00, 0x0e, 0x11, 0x11, 0x11, 0x0e],
  "w": [0x00, 0x00, 0x11, 0x11, 0x15, 0x15, 0x0a],
  "a": [0x00, 0x00, 0x0e, 0x01, 0x0f, 0x11, 0x0f],
  "v": [0x00, 0x00, 0x11, 0x11, 0x11, 0x0a, 0x04],
  "g": [0x00, 0x00, 0x0f, 0x11, 0x0f, 0x01, 0x0e],
  "p": [0x00, 0x00, 0x1e, 0x11, 0x1e, 0x10, 0x10],
  "e": [0x00, 0x00, 0x0e, 0x11, 0x1f, 0x10, 0x0e],
  "k": [0x10, 0x10, 0x12, 0x14, 0x18, 0x14, 0x12],
  "l": [0x0c, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  "y": [0x00, 0x00, 0x11, 0x11, 0x0f, 0x01, 0x0e],
  "r": [0x00, 0x00, 0x16, 0x19, 0x10, 0x10, 0x10],
  "s": [0x00, 0x00, 0x0f, 0x10, 0x0e, 0x01, 0x1e],
  "m": [0x00, 0x00, 0x1a, 0x15, 0x15, 0x11, 0x11],
  "x": [0x00, 0x00, 0x11, 0x0a, 0x04, 0x0a, 0x11],
  "i": [0x04, 0x00, 0x0c, 0x04, 0x04, 0x04, 0x0e],
  "t": [0x08, 0x08, 0x1c, 0x08, 0x08, 0x09, 0x06],
  "u": [0x00, 0x00, 0x11, 0x11, 0x11, 0x13, 0x0d],
  "d": [0x01, 0x01, 0x0d, 0x13, 0x11, 0x11, 0x0f],
  "c": [0x00, 0x00, 0x0e, 0x10, 0x10, 0x11, 0x0e],
  "b": [0x10, 0x10, 0x1e, 0x11, 0x11, 0x11, 0x1e],
  "f": [0x06, 0x09, 0x08, 0x1c, 0x08, 0x08, 0x08],
  "j": [0x02, 0x00, 0x06, 0x02, 0x02, 0x12, 0x0c],
  "q": [0x00, 0x00, 0x0f, 0x11, 0x0f, 0x01, 0x01],
  "z": [0x00, 0x00, 0x1f, 0x02, 0x04, 0x08, 0x1f],
};
