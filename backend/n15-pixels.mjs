import { readFileSync } from 'fs';
import { inflateSync } from 'zlib';

// Minimal PNG decoder (8-bit RGB/RGBA, non-interlaced) using node builtins.
// Returns { width, height, data: Uint8Array RGBA }.
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    if (type === 'IHDR') {
      width = buf.readUInt32BE(pos + 8);
      height = buf.readUInt32BE(pos + 12);
      bitDepth = buf[pos + 16];
      colorType = buf[pos + 17];
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(pos + 8, pos + 8 + len));
    }
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride);
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[x] = v;
    }
    for (let x = 0; x < stride; x++) prev[x] = cur[x];
    for (let x = 0; x < width; x++) {
      if (channels === 4) {
        out[(y * width + x) * 4] = cur[x * 4];
        out[(y * width + x) * 4 + 1] = cur[x * 4 + 1];
        out[(y * width + x) * 4 + 2] = cur[x * 4 + 2];
        out[(y * width + x) * 4 + 3] = cur[x * 4 + 3];
      } else if (channels === 3) {
        out[(y * width + x) * 4] = cur[x * 3];
        out[(y * width + x) * 4 + 1] = cur[x * 3 + 1];
        out[(y * width + x) * 4 + 2] = cur[x * 3 + 2];
        out[(y * width + x) * 4 + 3] = 255;
      }
    }
    p += stride;
  }
  return { width, height, data: out };
}

// Average RGBA over a rect (x,y,w,h in px). Returns [r,g,b,a].
export function regionAvg(img, x, y, w, h) {
  let r = 0, g = 0, b = 0, n = 0;
  const x0 = Math.max(0, x), y0 = Math.max(0, y);
  const x1 = Math.min(img.width, x + w), y1 = Math.min(img.height, y + h);
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const i = (py * img.width + px) * 4;
      r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
    }
  }
  if (n === 0) return [0, 0, 0, 0];
  return [r / n, g / n, b / n, 255];
}

// Perceived luminance of an rgb triple.
export function lum(rgb) {
  const [r, g, b] = rgb.map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// WCAG contrast ratio between two rgb triples.
export function contrast(a, b) {
  const la = lum(a), lb = lum(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

export function loadPng(path) {
  return decodePng(readFileSync(path));
}
