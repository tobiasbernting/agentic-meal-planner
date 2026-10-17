// Writes the app icons (public/icons/*.png) in the almanac look: paper background, a heavy ink
// rule across the top and thinner ink rules below, like a ruled page. No dependencies: the PNG
// chunks and CRC32 are written by hand and the pixels compressed with node:zlib.
// Run with `node scripts/build-icons.mjs` and commit the PNGs.
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const PAPER = [0xfb, 0xfa, 0xf6];
const INK = [0x1a, 0x1a, 0x1a];

/** Rules as [top, height, left, right], fractions of the icon size. */
const RULES = [
  [0.2, 0.09, 0.16, 0.84],
  [0.42, 0.025, 0.16, 0.84],
  [0.55, 0.025, 0.16, 0.84],
  [0.68, 0.025, 0.16, 0.6],
];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function isInk(size, x, y) {
  return RULES.some(([top, height, left, right]) => {
    const y0 = Math.round(top * size);
    const y1 = y0 + Math.max(1, Math.round(height * size));
    return y >= y0 && y < y1 && x >= Math.round(left * size) && x < Math.round(right * size);
  });
}

function png(size) {
  const row = 1 + size * 3;
  const pixels = Buffer.alloc(row * size);
  for (let y = 0; y < size; y++) {
    pixels[y * row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = isInk(size, x, y) ? INK : PAPER;
      const at = y * row + 1 + x * 3;
      pixels[at] = r;
      pixels[at + 1] = g;
      pixels[at + 2] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", deflateSync(pixels, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const out = new URL("../public/icons/", import.meta.url);
mkdirSync(out, { recursive: true });
for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]]) {
  writeFileSync(new URL(name, out), png(size));
}
