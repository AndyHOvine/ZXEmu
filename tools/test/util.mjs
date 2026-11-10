import fs from 'node:fs';
import zlib from 'node:zlib';
import { Spectrum, ROM_FILES, FB_WIDTH, FB_HEIGHT } from '../../web/js/emu/spectrum.js';

const ROM_DIR = new URL('../../web/roms/', import.meta.url);

export function loadRoms() {
  const out = {};
  for (const [k, f] of Object.entries(ROM_FILES)) out[k] = new Uint8Array(fs.readFileSync(new URL(f, ROM_DIR)));
  return out;
}

const ROMS = loadRoms();

export function makeMachine(opts = {}) {
  return new Spectrum({ roms: ROMS, ...opts });
}

export function runFrames(m, n) {
  for (let i = 0; i < n; i++) m.runFrame();
}

export function runSeconds(m, s) {
  runFrames(m, Math.round(s * 50));
}

// the screen as text, by matching each 8x8 cell against the 48K ROM's font (ink on paper or
// paper on ink)
const FONT = ROMS.rom48.subarray(0x3d00, 0x4000);
const GLYPHS = new Map();
for (let c = 0; c < 96; c++) GLYPHS.set(Array.from(FONT.subarray(c * 8, c * 8 + 8)).join(','), String.fromCharCode(32 + c));

export function screenText(m) {
  const scr = m.screenMem;
  const lines = [];
  for (let row = 0; row < 24; row++) {
    let s = '';
    for (let col = 0; col < 32; col++) {
      const bytes = [];
      for (let y = 0; y < 8; y++) {
        const py = row * 8 + y;
        bytes.push(scr[((py & 0xc0) << 5) | ((py & 7) << 8) | ((py & 0x38) << 2) | col]);
      }
      let ch = GLYPHS.get(bytes.join(','));
      if (ch === undefined) ch = GLYPHS.get(bytes.map((b) => ~b & 0xff).join(','));
      s += ch === undefined ? '#' : ch;
    }
    lines.push(s.replace(/\s+$/, ''));
  }
  return lines;
}

export function shows(m, text) {
  return screenText(m).some((l) => l.includes(text));
}

export function runUntilText(m, text, seconds = 10) {
  const frames = Math.round(seconds * 50);
  for (let i = 0; i < frames; i++) {
    m.runFrame();
    if (i % 10 === 0 && shows(m, text)) return true;
  }
  return shows(m, text);
}

export function writePng(file, m) {
  const w = FB_WIDTH, h = FB_HEIGHT, fb = m.video.fb;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      const c = fb[y * w + x];
      raw[o++] = c & 255; raw[o++] = (c >> 8) & 255; raw[o++] = (c >> 16) & 255;
    }
  }
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (buf) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

export function makeChecker() {
  let passed = 0, failed = 0;
  return {
    check(name, ok, detail = '') {
      if (ok) passed++;
      else { failed++; console.log(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
    },
    done() {
      console.log(`${passed} passed, ${failed} failed`);
      process.exit(failed ? 1 : 0);
    },
  };
}
