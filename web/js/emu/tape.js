// Tapes for ZXEmu, written for it in 2026. GPL v2 or later, see LICENSE.
//
// .tap, .tzx (and .cdt), .csw and .wav files become a list of blocks, each giving its pulses:
// a positive number holds the level that many T-states (at 3.5 MHz) and then flips it; a
// { pause } holds the level low; a { level, hold } sets it and holds it; 'stop' stops the
// tape. The player turns them into edges at the machine's T-states as the program reads
// the EAR bit, so loaders with their own timings (turbo loaders) load as on a real machine.
// The flash-load trap in spectrum.js takes a whole data block at once instead.

const TZX_CLOCK = 3500000;
const MS = TZX_CLOCK / 1000;

const ascii = (b, at, n) => String.fromCharCode(...b.subarray(at, at + n));
const w16 = (b, o) => b[o] | (b[o + 1] << 8);
const w24 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const w32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

// ---------------------------------------------------------------- blocks

// a block of bytes with a ROM-style or turbo timing
function dataBlock(data, t, pause, { name = '' } = {}) {
  return {
    kind: 'data', data, timing: t, pause, name,
    standard: t.pilot === 2168 && t.zero === 855 && t.one === 1710,
    * pulses(p) {
      if (t.pilotCount) {
        p.phase = 'pilot';
        for (let i = 0; i < t.pilotCount; i++) yield t.pilot;
        if (t.sync1) yield t.sync1;
        if (t.sync2) yield t.sync2;
      }
      p.phase = 'data';
      const n = data.length;
      for (let i = 0; i < n; i++) {
        const byte = data[i];
        const bits = i === n - 1 ? t.lastBits || 8 : 8;
        for (let b = 0; b < bits; b++) {
          const len = byte & (0x80 >> b) ? t.one : t.zero;
          yield len;
          yield len;
        }
      }
      p.phase = 'other';
      if (pause) yield { pause: pause * MS };
    },
  };
}

const STANDARD = (flag) => ({ pilot: 2168, sync1: 667, sync2: 735, zero: 855, one: 1710, pilotCount: flag < 128 ? 8063 : 3223, lastBits: 8 });

function pulsesBlock(list, name) {
  return { kind: 'pulses', name, * pulses(p) { p.phase = 'other'; for (const n of list) yield n; } };
}

function pauseBlock(ms) {
  return {
    kind: 'pause', ms,
    * pulses(p) { p.phase = 'other'; if (ms === 0) yield 'stop'; else yield { pause: ms * MS }; },
  };
}

// samples of the level, each `per` T-states long: as levels set
function levelsBlock(levels, per, pause) {
  return {
    kind: 'levels',
    * pulses(p) {
      p.phase = 'other';
      let i = 0;
      const n = levels.length;
      while (i < n) {
        const lv = levels[i];
        let j = i + 1;
        while (j < n && levels[j] === lv) j++;
        yield { level: lv, hold: (j - i) * per };
        i = j;
      }
      if (pause) yield { pause: pause * MS };
    },
  };
}

// run lengths of flips (CSW): each a number of samples at `rate`
function runsBlock(runs, rate, pause) {
  const per = TZX_CLOCK / rate;
  return {
    kind: 'csw',
    * pulses(p) {
      p.phase = 'other';
      for (const r of runs) yield r * per;
      if (pause) yield { pause: pause * MS };
    },
  };
}

// ---------------------------------------------------------------- .tap
export function parseTap(b) {
  const blocks = [];
  let o = 0;
  while (o + 2 <= b.length) {
    const len = w16(b, o);
    const data = b.slice(o + 2, o + 2 + len);
    o += 2 + len;
    if (!data.length) continue;
    blocks.push(dataBlock(data, STANDARD(data[0]), 1000, { name: tapName(data) }));
  }
  return blocks;
}

function tapName(data) {
  if (data.length === 19 && data[0] === 0) return ['Program', 'Number array', 'Character array', 'Bytes'][data[1]] + ': ' + ascii(data, 2, 10).trim();
  return '';
}

// ---------------------------------------------------------------- .tzx
export function parseTzx(b) {
  if (ascii(b, 0, 7) !== 'ZXTape!') throw new Error('Not a TZX file');
  const blocks = [];
  let o = 10;
  const loops = [];
  while (o < b.length) {
    const id = b[o++];
    switch (id) {
      case 0x10: {
        const pause = w16(b, o), len = w16(b, o + 2);
        const data = b.slice(o + 4, o + 4 + len);
        o += 4 + len;
        blocks.push(dataBlock(data, STANDARD(data[0] ?? 0xff), pause, { name: tapName(data) }));
        break;
      }
      case 0x11: {
        const t = { pilot: w16(b, o), sync1: w16(b, o + 2), sync2: w16(b, o + 4), zero: w16(b, o + 6), one: w16(b, o + 8), pilotCount: w16(b, o + 10), lastBits: b[o + 12] };
        const pause = w16(b, o + 13), len = w24(b, o + 15);
        const data = b.slice(o + 18, o + 18 + len);
        o += 18 + len;
        blocks.push(dataBlock(data, t, pause));
        break;
      }
      case 0x12: {
        const len = w16(b, o), n = w16(b, o + 2);
        o += 4;
        blocks.push(pulsesBlock(new Array(n).fill(len), 'tone'));
        break;
      }
      case 0x13: {
        const n = b[o++];
        const list = [];
        for (let i = 0; i < n; i++) list.push(w16(b, o + i * 2));
        o += n * 2;
        blocks.push(pulsesBlock(list, 'pulses'));
        break;
      }
      case 0x14: {
        const t = { pilot: 0, pilotCount: 0, zero: w16(b, o), one: w16(b, o + 2), lastBits: b[o + 4] };
        const pause = w16(b, o + 5), len = w24(b, o + 7);
        const data = b.slice(o + 10, o + 10 + len);
        o += 10 + len;
        blocks.push(dataBlock(data, t, pause));
        break;
      }
      case 0x15: {
        const per = w16(b, o), pause = w16(b, o + 2), last = b[o + 4], len = w24(b, o + 5);
        const data = b.subarray(o + 8, o + 8 + len);
        o += 8 + len;
        const levels = [];
        for (let i = 0; i < len; i++) {
          const bits = i === len - 1 ? last || 8 : 8;
          for (let k = 0; k < bits; k++) levels.push(data[i] & (0x80 >> k) ? 1 : 0);
        }
        blocks.push(levelsBlock(levels, per, pause));
        break;
      }
      case 0x18: {
        const len = w32(b, o);
        const pause = w16(b, o + 4), rate = w24(b, o + 6), comp = b[o + 9];
        const data = b.subarray(o + 14, o + 4 + len);
        o += 4 + len;
        if (comp === 1) blocks.push(runsBlock(cswRuns(data), rate, pause));
        else blocks.push(pauseBlock(pause || 1)); // Z-RLE inside a TZX: not supported
        break;
      }
      case 0x19: {
        const len = w32(b, o);
        blocks.push(generalBlock(b.subarray(o + 4, o + 4 + len)));
        o += 4 + len;
        break;
      }
      case 0x20: blocks.push(pauseBlock(w16(b, o))); o += 2; break;
      case 0x21: o += 1 + b[o]; break; // group start
      case 0x22: break; // group end
      case 0x23: blocks.push({ kind: 'jump', by: (w16(b, o) << 16) >> 16, * pulses() {} }); o += 2; break;
      case 0x24: loops.push({ at: blocks.length, count: w16(b, o) }); o += 2; break;
      case 0x25: {
        const l = loops.pop();
        if (l) {
          const body = blocks.slice(l.at);
          for (let i = 1; i < l.count; i++) blocks.push(...body);
        }
        break;
      }
      case 0x26: {
        const n = w16(b, o);
        const to = [];
        for (let i = 0; i < n; i++) to.push((w16(b, o + 2 + i * 2) << 16) >> 16);
        blocks.push({ kind: 'call', to, * pulses() {} });
        o += 2 + n * 2;
        break;
      }
      case 0x27: blocks.push({ kind: 'return', * pulses() {} }); break;
      case 0x28: o += 2 + w16(b, o); break; // select block: the first is played
      case 0x2a: blocks.push({ kind: 'stop48', * pulses(p) { if (p.is48) yield 'stop'; } }); o += 4; break;
      case 0x2b: {
        const lv = b[o + 4] ? 1 : 0;
        blocks.push({ kind: 'level', * pulses() { yield { level: lv, hold: 0 }; } });
        o += 5;
        break;
      }
      case 0x30: o += 1 + b[o]; break;
      case 0x31: o += 2 + b[o + 1]; break;
      case 0x32: o += 2 + w16(b, o); break;
      case 0x33: o += 1 + b[o] * 3; break;
      case 0x35: o += 20 + w32(b, o + 16); break;
      case 0x5a: o += 9; break;
      default:
        // an unknown block: TZX 1.10 says the length follows as 4 bytes
        o += 4 + w32(b, o);
        break;
    }
  }
  return blocks;
}

// TZX block 0x19: pulses from symbol tables
function generalBlock(b) {
  const pause = w16(b, 0);
  const totp = w32(b, 2), npp = b[6], asp = b[7] || 256;
  const totd = w32(b, 8), npd = b[12], asd = b[13] || 256;
  let o = 14;
  const readSyms = (count, max) => {
    const syms = [];
    for (let i = 0; i < count; i++) {
      const flags = b[o];
      const pulses = [];
      for (let k = 0; k < max; k++) {
        const x = w16(b, o + 1 + k * 2);
        if (!x) break; // a 0 ends the symbol
        pulses.push(x);
      }
      syms.push({ flags, pulses });
      o += 1 + max * 2;
    }
    return syms;
  };
  const pilotSyms = totp ? readSyms(asp, npp) : [];
  const pilot = [];
  for (let i = 0; i < totp; i++) { pilot.push([b[o], w16(b, o + 1)]); o += 3; }
  const dataSyms = totd ? readSyms(asd, npd) : [];
  const nb = Math.ceil(Math.log2(asd));
  const data = b.subarray(o);
  return {
    kind: 'general',
    * pulses(p) {
      p.phase = 'other';
      const sym = function* (s) {
        // flags 0: flip at the start (an edge), 1: no flip, 2: force low, 3: force high
        const f = s.flags & 3;
        if (f === 2 || f === 3) yield { level: f === 3 ? 1 : 0, hold: 0 };
        else if (f === 1) yield { flipNext: false };
        for (const n of s.pulses) yield n;
      };
      for (const [si, rep] of pilot) for (let r = 0; r < rep; r++) yield* sym(pilotSyms[si]);
      let bit = 0;
      for (let i = 0; i < totd; i++) {
        let v = 0;
        for (let k = 0; k < nb; k++) { v = (v << 1) | ((data[bit >> 3] >> (7 - (bit & 7))) & 1); bit++; }
        yield* sym(dataSyms[v]);
      }
      if (pause) yield { pause: pause * MS };
    },
  };
}

// ---------------------------------------------------------------- .csw and .wav
function cswRuns(data) {
  const runs = [];
  for (let i = 0; i < data.length; i++) {
    let n = data[i];
    if (n === 0) { n = w32(data, i + 1); i += 4; }
    runs.push(n);
  }
  return runs;
}

export function parseCsw(b) {
  if (ascii(b, 0, 22) !== 'Compressed Square Wave') throw new Error('Not a CSW file');
  const major = b[0x17];
  let rate, comp, start;
  if (major === 1) { rate = w16(b, 0x19); comp = b[0x1b]; start = 0x20; }
  else { rate = w32(b, 0x19); comp = b[0x21]; start = 0x34 + b[0x23]; }
  if (comp !== 1) throw new Error('This CSW file is compressed (Z-RLE): load it as a ZIP or TZX instead');
  return [runsBlock(cswRuns(b.subarray(start)), rate, 0)];
}

export function parseWav(b) {
  if (ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WAVE') throw new Error('Not a WAV file');
  let o = 12, fmt = null, data = null;
  while (o + 8 <= b.length) {
    const id = ascii(b, o, 4), len = w32(b, o + 4);
    if (id === 'fmt ') fmt = { format: w16(b, o + 8), channels: w16(b, o + 10), rate: w32(b, o + 12), bits: w16(b, o + 22) };
    else if (id === 'data') data = b.subarray(o + 8, o + 8 + len);
    o += 8 + len + (len & 1);
  }
  if (!fmt || !data || fmt.format !== 1) throw new Error('Only PCM WAV files can be played');
  const step = (fmt.bits >> 3) * fmt.channels;
  const n = Math.floor(data.length / step);
  const sample = fmt.bits === 8 ? (i) => data[i * step] - 128 : (i) => (data[i * step] | (data[i * step + 1] << 8)) << 16 >> 24;
  // a Schmitt trigger round the middle: runs of samples on one side
  const runs = [];
  let level = sample(0) > 0 ? 1 : 0, run = 0;
  for (let i = 0; i < n; i++) {
    const s = sample(i);
    run++;
    if ((level === 0 && s > 6) || (level === 1 && s < -6)) {
      runs.push(run);
      run = 0;
      level ^= 1;
    }
  }
  if (run) runs.push(run);
  return [runsBlock(runs, fmt.rate, 0)];
}

export function isTapeFile(b) {
  return ascii(b, 0, 7) === 'ZXTape!' || ascii(b, 0, 22) === 'Compressed Square Wave' ||
    (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE');
}

// a .tap file is a chain of lengths that ends exactly at the end
export function isTap(b) {
  let o = 0, n = 0;
  while (o + 2 <= b.length) {
    const len = w16(b, o);
    if (!len) return false;
    o += 2 + len;
    n++;
  }
  return n > 0 && o === b.length;
}

export function parseTape(bytes) {
  const tag = ascii(bytes, 0, 7);
  if (tag === 'ZXTape!') return parseTzx(bytes);
  if (ascii(bytes, 0, 22) === 'Compressed Square Wave') return parseCsw(bytes);
  if (ascii(bytes, 0, 4) === 'RIFF') return parseWav(bytes);
  return parseTap(bytes);
}

// ---------------------------------------------------------------- the player
export class Tape {
  constructor() {
    this.blocks = [];
    this.present = false;
    this.playing = false;
    this.is48 = true;
    this.scale = 1; // the machine's T-states for a 3.5 MHz T-state
    this.saved = []; // blocks the program saved (SA-BYTES), for a .tap
    this.reset();
  }

  reset() {
    this.index = 0;
    this.gen = null;
    this.level = 0;
    this.edgeAt = 0; // when the current hold ends (machine T-states from the start)
    this.flip = false; // the level flips at edgeAt
    this.phase = 'other';
    this.stack = [];
    this.after = 0;
    this.atEnd = this.blocks.length === 0;
  }

  insert(bytes, name = '') {
    this.blocks = parseTape(bytes);
    this.name = name;
    this.present = true;
    this.playing = false;
    this.reset();
  }

  eject() {
    this.blocks = [];
    this.present = false;
    this.playing = false;
    this.reset();
  }

  play(now = this.edgeAt) {
    if (!this.present || this.atEnd) return;
    if (!this.playing) {
      this.playing = true;
      if (this.edgeAt < now) this.edgeAt = now;
    }
  }

  stop() { this.playing = false; }

  rewind() {
    this.playing = false;
    this.reset();
  }

  get running() { return this.playing; }

  // the next event of the tape, starting at T-state `now`
  next(now, onEdge) {
    if (this.after > 0) {
      // the rest of a pause after its first millisecond
      this.flip = false;
      this.edgeAt = now + this.after * this.scale;
      this.after = 0;
      return;
    }
    for (;;) {
      if (!this.gen) {
        if (this.index >= this.blocks.length) {
          this.atEnd = true;
          this.playing = false;
          this.flip = false;
          return;
        }
        const blk = this.blocks[this.index];
        if (blk.kind === 'jump') { this.index += blk.by; continue; }
        if (blk.kind === 'call') {
          if (!blk.to.length) { this.index++; continue; }
          this.stack.push({ at: this.index, k: 0 });
          this.index += blk.to[0];
          continue;
        }
        if (blk.kind === 'return') {
          const s = this.stack[this.stack.length - 1];
          if (!s) { this.index++; continue; }
          const call = this.blocks[s.at];
          if (++s.k < call.to.length) this.index = s.at + call.to[s.k];
          else { this.stack.pop(); this.index = s.at + 1; }
          continue;
        }
        this.gen = blk.pulses(this);
      }
      const r = this.gen.next();
      if (r.done) {
        this.gen = null;
        this.index++;
        continue;
      }
      const v = r.value;
      if (typeof v === 'number') {
        this.flip = true;
        this.edgeAt = now + v * this.scale;
        return;
      }
      if (v === 'stop') {
        this.gen = null;
        this.index++;
        this.playing = false;
        this.flip = false;
        this.edgeAt = now;
        return;
      }
      if (v.pause !== undefined) {
        // a high level is held a millisecond first, so the last edge is seen, then low
        if (this.level && v.pause > MS) {
          this.flip = true;
          this.edgeAt = now + MS * this.scale;
          this.after = v.pause - MS;
          return;
        }
        if (this.level) { this.level = 0; onEdge(now, 0); }
        this.flip = false;
        this.edgeAt = now + v.pause * this.scale;
        return;
      }
      if (v.level !== undefined) {
        if (v.level !== this.level) { this.level = v.level; onEdge(now, v.level); }
        if (!v.hold) continue;
        this.flip = false;
        this.edgeAt = now + v.hold * this.scale;
        return;
      }
      // { flipNext: false }: the next pulse starts without an edge: undo the one to come
      if (v.flipNext === false) { this.level ^= 1; onEdge(now, this.level); continue; }
    }
  }

  // plays the tape up to T-state t, calling onEdge(at, level) at each change
  advanceTo(t, onEdge) {
    while (this.playing && this.edgeAt <= t) {
      const at = this.edgeAt;
      if (this.flip) {
        this.level ^= 1;
        onEdge(at, this.level);
      }
      this.next(at, onEdge);
    }
  }

  // the data block the tape is at the start of (or in the pilot tone of), for the flash load
  dataBlockHere() {
    if (this.atEnd) return null;
    let i = this.index;
    if (this.gen && this.phase !== 'pilot') {
      // part way through a block: the next one, unless this one's data has started
      if (this.phase === 'data') return null;
      i++;
    }
    for (; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      if (b.kind === 'data') return { block: b, index: i };
      if (b.kind === 'pause' || b.kind === 'level') continue;
      return null;
    }
    return null;
  }

  // after a flash load: the tape waits at the block after `index`
  skipTo(index, now) {
    this.index = index;
    this.gen = null;
    this.flip = false;
    this.level = 0;
    this.edgeAt = now;
    this.phase = 'other';
    this.after = 0;
    this.atEnd = index >= this.blocks.length;
  }

  // what the program saved, as a .tap
  savedTap() {
    const parts = [];
    for (const d of this.saved) parts.push(new Uint8Array([d.length & 0xff, d.length >> 8]), d);
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  saveState() {
    return { index: this.index, level: this.level, playing: this.playing, saved: this.saved.map((d) => d.slice()) };
  }

  loadState(s) {
    this.reset();
    this.index = s.index;
    this.level = s.level;
    this.atEnd = this.index >= this.blocks.length;
    this.playing = false;
    this.saved = (s.saved || []).map((d) => Uint8Array.from(d));
  }
}
