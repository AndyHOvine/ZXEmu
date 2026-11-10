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

// ---- small BASIC programs for tests, tokenised as the ROM stores them
const TOKENS = {
  'RANDOMIZE': 0xf9, 'GO TO': 0xec, 'GO SUB': 0xed, 'INKEY$': 0xa6, 'PRINT': 0xf5, 'BORDER': 0xe7, 'RETURN': 0xfe,
  'PAUSE': 0xf2, 'POKE': 0xf4, 'PEEK': 0xbe, 'CODE': 0xaf, 'SAVE': 0xf8, 'LOAD': 0xef, 'LINE': 0xca, 'BEEP': 0xd7,
  'NEXT': 0xf3, 'STOP': 0xe2, 'USR': 0xc0, 'LET': 0xf1, 'FOR': 0xeb, 'OUT': 0xdf, 'CLS': 0xfb, 'REM': 0xea, 'RUN': 0xf7,
  'AT': 0xac, 'IN': 0xbf, 'TO': 0xcc, 'IF': 0xfa, 'THEN': 0xcb,
};
const KEYWORDS = Object.keys(TOKENS).sort((a, b) => b.length - a.length);

export function tokenise(text) {
  const out = [];
  let i = 0, quoted = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') { quoted = !quoted; out.push(0x22); i++; continue; }
    if (!quoted) {
      const kw = KEYWORDS.find((k) => text.startsWith(k, i) && !/[A-Z$]/.test(text[i + k.length] || ' ') && !/[A-Z]/.test(text[i - 1] || ' '));
      if (kw) { out.push(TOKENS[kw]); i += kw.length; while (text[i] === ' ') i++; continue; }
      const num = /^\d+/.exec(text.slice(i));
      if (num && !/[A-Z]/.test(text[i - 1] || ' ')) {
        const n = Number(num[0]);
        for (const c of num[0]) out.push(c.charCodeAt(0));
        out.push(0x0e, 0, 0, n & 0xff, (n >> 8) & 0xff, 0);
        i += num[0].length;
        continue;
      }
    }
    out.push(ch.charCodeAt(0));
    i++;
  }
  return out;
}

// a program as BASIC bytes: lines [[number, text], ...]
export function basicProgram(lines) {
  const out = [];
  for (const [n, text] of lines) {
    const body = [...tokenise(text), 0x0d];
    out.push(n >> 8, n & 0xff, body.length & 0xff, body.length >> 8, ...body);
  }
  return out;
}

export function tapBlock(bytes) {
  let p = 0;
  for (const b of bytes) p ^= b;
  const all = [...bytes, p];
  return [all.length & 0xff, all.length >> 8, ...all];
}

function header(type, name, len, p1, p2) {
  return [0, type, ...[...name.padEnd(10).slice(0, 10)].map((c) => c.charCodeAt(0)), len & 0xff, len >> 8, p1 & 0xff, p1 >> 8, p2 & 0xff, p2 >> 8];
}

// a .tap of a BASIC program that runs from `line`, then any CODE blocks [{ name, at, bytes }]
export function basicTap(lines, { line = 10, name = 'test', code = [] } = {}) {
  const prog = basicProgram(lines);
  const out = [...tapBlock(header(0, name, prog.length, line, prog.length)), ...tapBlock([0xff, ...prog])];
  for (const c of code) out.push(...tapBlock(header(3, c.name, c.bytes.length, c.at, 0x8000)), ...tapBlock([0xff, ...c.bytes]));
  return new Uint8Array(out);
}
