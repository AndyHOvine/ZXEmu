// The Spectrum Next's picture for ZXEmu, written for it in 2026. GPL v2 or later, see LICENSE.
//
// The ULA (with ULANext, ULA+, Timex modes, LoRes, scroll and clip) is drawn a cell at a time
// as the beam reaches it, as video.js does, but into a line of 9-bit colours. When the beam
// finishes a line, the tilemap, Layer 2 (256x192, 320x256, 640x256) and the sprites (128,
// anchors and relatives, 4- and 8-bit, scaled, mirrored, rotated) are made for it and mixed
// in the order Next register $15 picks (or blended), with every layer's transparency and
// clip window, into the frame buffer (2 pixels to a Spectrum pixel, so the 640-wide modes
// keep their detail). Registers and memory are read when the line is finished: a change
// partway along a line shows on the whole line (the hardware takes most of them per pixel).
//
// docs/next-video.md has the rules, taken from the Next's FPGA source.

import { Video, FB_WIDTH, FB_HEIGHT, BORDER } from './video.js';

const CELLS = (256 + 2 * BORDER) / 8; // cells across a line
const LINES = FB_HEIGHT;
const SX = BORDER - 32; // the frame buffer's Spectrum pixel at the 320x256 area's x 0
const SY = BORDER - 32; // and its line at y 0
const HX = SX * 2; // the same in frame buffer pixels

// the ULA line: the 9-bit colour, and flags
const ULA_T = 0x200; // transparent
const ULA_B = 0x400; // border (not paper)

// a 9-bit colour (RRRGGGBBB) as the frame buffer's ABGR
const RGBA = new Uint32Array(512);
for (let c = 0; c < 512; c++) {
  const e = (v) => (v << 5) | (v << 2) | (v >> 1);
  RGBA[c] = (0xff000000 | (e(c & 7) << 16) | (e((c >> 3) & 7) << 8) | e(c >> 6)) >>> 0;
}

// the ULA palettes as the firmware leaves them (ZEsarUX's table; the FPGA doesn't set them)
const ULA_COLOURS = [0x000, 0x005, 0x140, 0x145, 0x028, 0x02d, 0x168, 0x16d, 0x000, 0x007, 0x1c0, 0x1cf, 0x038, 0x03f, 0x1f8, 0x1ff];

const POP = new Uint8Array(256); // bits set in a byte
for (let i = 0; i < 256; i++) for (let b = i; b; b >>= 1) POP[i] += b & 1;
const ULANEXT_MASKS = new Set([0x01, 0x03, 0x07, 0x0f, 0x1f, 0x3f, 0x7f]);

// palettes, by Next register $43 bits 6-4: 0 ULA, 1 Layer 2, 2 sprites, 3 tilemap; +4 the second
const P_ULA = 0, P_L2 = 1, P_SPR = 2, P_TM = 3;

export { RGBA as NEXT_RGBA };

export class NextVideo extends Video {
  constructor(m) {
    super(m);
    this.pal = new Uint16Array(8 * 256); // 9-bit colours
    this.prio = new Uint8Array(8 * 256); // NR $44's two top bits (bit 1: Layer 2 above all)
    this.sprAttr = new Uint8Array(128 * 5);
    this.patterns = new Uint8Array(0x4000);
    this.ulaLine = new Uint16Array(FB_WIDTH);
    this.l2Line = new Int16Array(640);
    this.l2Prio = new Uint8Array(640);
    this.tmLine = new Int16Array(640);
    this.tmBelow = new Uint8Array(640);
    this.sprLine = new Int16Array(320);
    // the 320x256 area (Renderer's border 'none')
    this.window = { x: HX, y: SY, w: 640, h: 256 };
    this.resetNext();
  }

  resetNext() {
    for (let p = 0; p < 8; p++) {
      for (let i = 0; i < 256; i++) {
        this.pal[p * 256 + i] = (p & 3) === P_ULA ? ULA_COLOURS[i & 15] : (i << 1) | (((i >> 1) | i) & 1);
      }
    }
    this.prio.fill(0);
    this.palIndex = 0;
    this.pal44Second = false;
    this.pal44First = 0;
    this.sprAttr.fill(0);
    this.patterns.fill(0);
    this.sprNum = 0;
    this.sprSub = 0;
    this.patAddr = 0;
    this.sprStatus = 0; // bit 1 overflow, bit 0 collision
    // clip windows (x1, x2, y1, y2): Layer 2, sprites, ULA, tilemap; and where the next write goes
    this.clip = [[0, 255, 0, 191], [0, 255, 0, 191], [0, 255, 0, 191], [0, 159, 0, 255]];
    this.clipIndex = [0, 0, 0, 0];
    this.ulaPlus = 0;
    this.ulaPlusGroup = 0;
    this.ulaPlusIndex = 0;
  }

  saveNext() {
    return {
      pal: this.pal.slice(), prio: this.prio.slice(), sprAttr: this.sprAttr.slice(), patterns: this.patterns.slice(),
      clip: this.clip.map((c) => c.slice()), clipIndex: this.clipIndex.slice(),
      palIndex: this.palIndex, sprNum: this.sprNum, sprSub: this.sprSub, patAddr: this.patAddr,
      ulaPlus: this.ulaPlus, ulaPlusGroup: this.ulaPlusGroup, ulaPlusIndex: this.ulaPlusIndex,
    };
  }

  loadNext(s) {
    this.pal.set(s.pal); this.prio.set(s.prio); this.sprAttr.set(s.sprAttr); this.patterns.set(s.patterns);
    this.clip = s.clip.map((c) => c.slice()); this.clipIndex = s.clipIndex.slice();
    Object.assign(this, { palIndex: s.palIndex, sprNum: s.sprNum, sprSub: s.sprSub, patAddr: s.patAddr, ulaPlus: s.ulaPlus, ulaPlusGroup: s.ulaPlusGroup, ulaPlusIndex: s.ulaPlusIndex });
    this.pal44Second = false;
  }

  // ---------------------------------------------------------------- palettes
  palWrite8(v) {
    const sel = (this.m.nr[0x43] >> 4) & 7, i = sel * 256 + this.palIndex;
    this.pal[i] = (v << 1) | (((v >> 1) | v) & 1);
    this.prio[i] = 0;
    this.palNext();
  }

  palWrite9(v) {
    if (!this.pal44Second) {
      this.pal44First = v;
      this.pal44Second = true;
      return;
    }
    const sel = (this.m.nr[0x43] >> 4) & 7, i = sel * 256 + this.palIndex;
    this.pal[i] = (this.pal44First << 1) | (v & 1);
    this.prio[i] = (v >> 6) & 3;
    this.pal44Second = false;
    this.palNext();
  }

  palNext() {
    if (!(this.m.nr[0x43] & 0x80)) this.palIndex = (this.palIndex + 1) & 0xff;
    this.pal44Second = false;
  }

  palRead8() { return this.pal[((this.m.nr[0x43] >> 4) & 7) * 256 + this.palIndex] >> 1; }

  palRead9() {
    const i = ((this.m.nr[0x43] >> 4) & 7) * 256 + this.palIndex;
    return (this.prio[i] << 6) | (this.pal[i] & 1);
  }

  // ULA+ (ports $BF3B and $FF3B)
  ulaPlusSelect(v) {
    this.ulaPlusGroup = v >> 6;
    if (this.ulaPlusGroup === 0) this.ulaPlusIndex = v & 0x3f;
  }

  ulaPlusWrite(v) {
    if (this.ulaPlusGroup === 1) { this.ulaPlus = v & 1; return; }
    if (this.ulaPlusGroup !== 0) return;
    const rgb8 = ((v & 0x1c) << 3) | ((v & 0xe0) >> 3) | (v & 3); // GGGRRRBB to RRRGGGBB
    const i = ((this.m.nr[0x43] & 0x40) ? 4 : 0) * 256 + 192 + this.ulaPlusIndex;
    this.pal[i] = (rgb8 << 1) | (((rgb8 >> 1) | rgb8) & 1);
  }

  ulaPlusRead() {
    if (this.ulaPlusGroup === 1) return this.ulaPlus;
    const c = this.pal[((this.m.nr[0x43] & 0x40) ? 4 : 0) * 256 + 192 + this.ulaPlusIndex] >> 1;
    return ((c & 0x1c) << 3) | ((c & 0xe0) >> 3) | (c & 3);
  }

  // ---------------------------------------------------------------- clip windows
  clipWrite(w, v) {
    this.clip[w][this.clipIndex[w]] = v;
    this.clipIndex[w] = (this.clipIndex[w] + 1) & 3;
  }

  clipRead(w) { return this.clip[w][this.clipIndex[w]]; }

  clipReset(bits) {
    for (let w = 0; w < 4; w++) if (bits & (1 << w)) this.clipIndex[w] = 0;
  }

  clipIndexes() {
    const c = this.clipIndex;
    return (c[3] << 6) | (c[2] << 4) | (c[1] << 2) | c[0];
  }

  // ---------------------------------------------------------------- sprites' ports
  spriteSelect(v) {
    this.sprNum = v & 0x7f;
    this.sprSub = 0;
    this.patAddr = ((v & 0x3f) << 8) | (v & 0x80 ? 0x80 : 0);
  }

  spriteAttrWrite(v) {
    const sub = this.sprSub;
    this.sprAttr[this.sprNum * 5 + sub] = v;
    if (sub === 4 || (sub === 3 && !(v & 0x40))) {
      this.sprNum = (this.sprNum + 1) & 0x7f;
      this.sprSub = 0;
    } else this.sprSub++;
  }

  patternWrite(v) {
    this.patterns[this.patAddr] = v;
    this.patAddr = (this.patAddr + 1) & 0x3fff;
  }

  spriteStatus() {
    const s = this.sprStatus;
    this.sprStatus = 0;
    return s;
  }

  // ---------------------------------------------------------------- the beam
  reset() {
    super.reset();
    this.composedTo = 0; // how much of the line being drawn is in the frame buffer
  }

  // the picture up to T-state t; partial: a register is about to change, so the line the beam
  // is on is made up to the beam now, with the registers as they were
  catchUp(t, partial = false) {
    const end = LINES * CELLS;
    let pos = this.pos;
    if (pos >= end) return;
    let y = (pos / CELLS) | 0;
    let x = pos - y * CELLS;
    let at = this.lineStart[y] + x * 4;
    while (at <= t) {
      this.ulaCell(x, y);
      pos++;
      if (++x === CELLS) {
        this.composeLine(y);
        x = 0;
        if (++y === LINES) break;
        at = this.lineStart[y];
      } else {
        at += 4;
      }
    }
    this.pos = pos;
    if (partial && y < LINES && x > 0) {
      const beam = Math.min(x * 16, Math.floor((t - this.lineStart[y]) * 4) + 1);
      if (beam > this.composedTo) {
        this.composeRange(y, this.composedTo, beam);
        this.composedTo = beam;
      }
    }
  }

  // the colour of a ULA palette index (or -1, the fallback colour), with the transparency test
  ulaColour(idx, clipped) {
    const nr = this.m.nr;
    let c;
    if (idx < 0) {
      const f = nr[0x4a];
      c = (f << 1) | (((f >> 1) | f) & 1);
    } else {
      c = this.pal[(nr[0x43] & 2 ? 4 * 256 : 0) + idx];
    }
    return c | ((c >> 1) === nr[0x14] || clipped || nr[0x68] & 0x80 ? ULA_T : 0);
  }

  // the palette index of a ULA pixel: attr, ink (1) or paper (0), or the border (b 0-7)
  ulaIndex(attr, ink, border) {
    const nr = this.m.nr;
    if (nr[0x43] & 1) { // ULANext
      const mask = nr[0x42];
      if (border >= 0) return mask === 0xff ? -1 : 128 + border;
      if (ink) return attr & mask;
      return ULANEXT_MASKS.has(mask) ? 128 + (attr >> POP[mask]) : -1;
    }
    if (this.ulaPlus) {
      if (border >= 0) return 192 + 8 + border;
      return 192 + (attr >> 6) * 16 + (ink ? attr & 7 : 8 + ((attr >> 3) & 7));
    }
    if (border >= 0) return 16 + border;
    const bright = attr & 0x40 ? 8 : 0;
    return ink ? bright + (attr & 7) : 16 + bright + ((attr >> 3) & 7);
  }

  // the 8 pixels (16 in the frame buffer) of one ULA cell into the line
  ulaCell(x, y) {
    const m = this.m, nr = m.nr, line = this.ulaLine;
    const py = y - BORDER, cx = x - BORDER / 8;
    let o = x * 16;
    const timex = m.port7ffd & 8 ? 0 : m.portFF & 7;
    if (py < 0 || py >= 192 || cx < 0 || cx >= 32) {
      let c;
      if (timex & 4) {
        const k = (m.portFF >> 3) & 7;
        c = this.ulaColour(this.ulaIndex(0x40 | ((~k & 7) << 3) | k, 0, -1), false);
      } else c = this.ulaColour(this.ulaIndex(0, 0, this.border), false);
      c |= ULA_B;
      line.fill(c, o, o + 16);
      return;
    }
    const scr = m.screenMem, clip = this.clip[2];
    const y2 = clip[3] >= 192 ? 191 : clip[3];
    const yOut = py < clip[2] || py > y2;
    if (nr[0x15] & 0x80) { // LoRes over the paper
      const b5 = m.banks[5];
      const ys = py + nr[0x33], ly = ys >= 192 ? (ys + 64) & 255 : ys;
      for (let i = 0; i < 8; i++) {
        const sx = cx * 8 + i;
        const lx = (sx + nr[0x32]) & 255;
        let a = (ly >> 1) * 128 + (lx >> 1);
        if (ly >= 96) a += 0x800;
        const b = b5[a];
        const idx = ((((b >> 4) + (nr[0x6a] & 15)) & 15) << 4) | (b & 15);
        const c = this.ulaColour(idx, yOut || sx < clip[0] || sx > clip[1]);
        line[o++] = c;
        line[o++] = c;
      }
      return;
    }
    if (timex & 4) { // Timex hi-res: 512 across, ink and paper from port $FF
      const k = (m.portFF >> 3) & 7;
      const attr = 0x40 | ((~k & 7) << 3) | k;
      const a = ((py & 0xc0) << 5) | ((py & 7) << 8) | ((py & 0x38) << 2) | cx;
      for (let i = 0; i < 16; i++) {
        const b = i < 8 ? scr[a] : scr[0x2000 + a];
        const ink = (b >> (7 - (i & 7))) & 1;
        const sx = cx * 8 + (i >> 1);
        line[o++] = this.ulaColour(this.ulaIndex(attr, ink, -1), yOut || sx < clip[0] || sx > clip[1]);
      }
      return;
    }
    const fy = (py + nr[0x27]) % 192;
    const flash = this.flash && !(nr[0x43] & 1) && !this.ulaPlus;
    const dfile = timex & 1 ? 0x2000 : 0;
    for (let i = 0; i < 8; i++) {
      const sx = cx * 8 + i;
      const fx = (sx + nr[0x26]) & 255, col = fx >> 3;
      const a = ((fy & 0xc0) << 5) | ((fy & 7) << 8) | ((fy & 0x38) << 2) | col;
      const bits = scr[dfile + a];
      const attr = timex & 2 ? scr[0x2000 + a] : scr[dfile + 0x1800 + ((fy >> 3) << 5) + col];
      let ink = (bits >> (7 - (fx & 7))) & 1;
      if (flash && attr & 0x80) ink ^= 1;
      const c = this.ulaColour(this.ulaIndex(attr, ink, -1), yOut || sx < clip[0] || sx > clip[1]);
      line[o++] = c;
      line[o++] = c;
    }
  }

  // ---------------------------------------------------------------- a line
  composeLine(y) {
    this.composeRange(y, this.composedTo, FB_WIDTH);
    this.composedTo = 0;
  }

  // frame buffer pixels h0 to h1 of line y (the sprites are made once a line, at its start, as
  // the hardware makes them a line ahead)
  composeRange(y, h0, h1) {
    const m = this.m, nr = m.nr, fb = this.fb, ula = this.ulaLine;
    const o0 = y * FB_WIDTH;
    const wy = y - SY;
    const inArea = wy >= 0 && wy < 256;
    const f4a = nr[0x4a], fallback = (f4a << 1) | (((f4a >> 1) | f4a) & 1);
    const l2On = inArea && m.l2Display;
    const tmOn = inArea && (nr[0x6b] & 0x80) !== 0;
    if (h0 === 0) this.sprAny = inArea && this.renderSprites(wy);
    const sprOn = inArea && this.sprAny && (nr[0x15] & 1) !== 0;
    if (!l2On && !tmOn && !sprOn) {
      for (let h = h0; h < h1; h++) {
        const u = ula[h];
        fb[o0 + h] = RGBA[u & ULA_T ? fallback : u & 0x1ff];
      }
      return;
    }
    if (l2On) this.renderLayer2(wy, h0 - HX, h1 - HX);
    if (tmOn) this.renderTilemap(wy, h0 - HX, h1 - HX);
    const order = (nr[0x15] >> 2) & 7;
    const stencil = (nr[0x68] & 1) !== 0 && !(nr[0x68] & 0x80) && tmOn;
    const blendSel = (nr[0x68] >> 5) & 3;
    // the sprites' clip window, in the 320x256 area
    const sc = this.clip[1];
    let cx1, cx2, cy1, cy2;
    if (!(nr[0x15] & 2)) { cx1 = sc[0] + 32; cx2 = sc[1] + 32; cy1 = sc[2] + 32; cy2 = Math.min(sc[3] + 32, 223); }
    else if (!(nr[0x15] & 0x20)) { cx1 = 0; cx2 = 319; cy1 = 0; cy2 = 255; }
    else { cx1 = sc[0] * 2; cx2 = sc[1] * 2 + 1; cy1 = sc[2]; cy2 = sc[3]; }
    const sprRow = sprOn && wy >= cy1 && wy <= cy2;
    const l2 = this.l2Line, l2p = this.l2Prio, tm = this.tmLine, below = this.tmBelow, spr = this.sprLine;
    for (let h = h0; h < h1; h++) {
      const u = ula[h];
      const a = h - HX;
      if (a < 0 || a >= 640) {
        fb[o0 + h] = RGBA[u & ULA_T ? fallback : u & 0x1ff];
        continue;
      }
      const ulaT = (u & ULA_T) !== 0, ulaRgb = u & 0x1ff, isBorder = (u & ULA_B) !== 0;
      const t = tmOn ? tm[a] : -1;
      const tmT = t < 0;
      const bel = tmOn && below[a] === 1;
      let U;
      if (stencil) U = ulaT || tmT ? -1 : ulaRgb & t;
      else U = !tmT && (!bel || ulaT) ? t : ulaT ? -1 : ulaRgb;
      const L = l2On ? l2[a] : -1;
      const P = L >= 0 && l2p[a] === 1;
      const sx = a >> 1;
      const S = sprRow && sx >= cx1 && sx <= cx2 ? spr[sx] : -1;
      const Uv = isBorder && tmT && S >= 0 ? -1 : U; // sprites show over the border where the tilemap is clear
      let out;
      switch (order) {
        case 0: out = P ? L : S >= 0 ? S : L >= 0 ? L : U; break; // S L U
        case 1: out = L >= 0 ? L : S >= 0 ? S : U; break; // L S U
        case 2: out = P ? L : S >= 0 ? S : U >= 0 ? U : L; break; // S U L
        case 3: out = L >= 0 ? L : Uv >= 0 ? Uv : S; break; // L U S
        case 4: out = P ? L : Uv >= 0 ? Uv : S >= 0 ? S : L; break; // U S L
        case 5: out = P ? L : Uv >= 0 ? Uv : L >= 0 ? L : S; break; // U L S
        default: { // 6, 7: Layer 2 and a blend colour added
          let M, top, bot;
          const ulaV = ulaT ? -1 : ulaRgb;
          if (blendSel === 0) { M = ulaV; top = !tmT && !bel ? t : -1; bot = !tmT && bel ? t : -1; }
          else if (blendSel === 2) { M = U; top = -1; bot = -1; }
          else if (blendSel === 3) { M = t; top = ulaV >= 0 && bel ? ulaV : -1; bot = ulaV >= 0 && !bel ? ulaV : -1; }
          else { M = -1; top = bel ? ulaV : t; bot = bel ? t : ulaV; }
          let c = -1;
          if (L >= 0) c = blend(L, M, order === 7);
          out = P ? c : top >= 0 ? top : S >= 0 ? S : bot >= 0 ? bot : c;
        }
      }
      fb[o0 + h] = RGBA[out >= 0 ? out : fallback];
    }
  }

  // Layer 2's pixels a0 to a1 of surface line wy into l2Line (-1 clear)
  renderLayer2(wy, a0 = 0, a1 = 640) {
    const m = this.m, nr = m.nr, mem = m.mem, line = this.l2Line, pr = this.l2Prio;
    if (a0 < 0) a0 = 0;
    if (a1 > 640) a1 = 640;
    if (a0 >= a1) return;
    line.fill(-1, a0, a1);
    pr.fill(0, a0, a1);
    const res = (nr[0x70] >> 4) & 3, off = nr[0x70] & 15, nr14 = nr[0x14];
    const palBase = (nr[0x43] & 4 ? 5 : 1) * 256;
    const base = nr[0x12] & 0x7f;
    const c = this.clip[0];
    const sx = ((nr[0x71] & 1) << 8) | nr[0x16], sy = nr[0x17];
    const put = (h, idx) => {
      const col = this.pal[palBase + idx];
      if (col >> 1 === nr14) return;
      line[h] = col;
      pr[h] = this.prio[palBase + idx] & 2 ? 1 : 0;
    };
    const byteAt = (addr) => {
      const bank = base + (addr >> 14);
      if (bank >= 112) return -1;
      const i = bank * 0x4000 + (addr & 0x3fff);
      return i < mem.length ? mem[i] : -1;
    };
    if (res === 0) {
      const py = wy - 32;
      if (py < 0 || py >= 192 || py < c[2] || py > c[3]) return;
      const ys = py + sy, Y = ys >= 192 ? (ys + 64) & 255 : ys;
      for (let x = Math.max(c[0], (a0 >> 1) - 32); x <= Math.min(c[1], 255, (a1 >> 1) - 32); x++) {
        const b = byteAt(Y * 256 + ((x + sx) & 255));
        if (b < 0) continue;
        const h = (x + 32) * 2;
        put(h, ((((b >> 4) + off) & 15) << 4) | (b & 15));
        line[h + 1] = line[h];
        pr[h + 1] = pr[h];
      }
      return;
    }
    if (wy < c[2] || wy > c[3]) return;
    const Y = (wy + sy) & 255;
    const x1 = Math.max(c[0] * 2, a0 >> 1), x2 = Math.min(c[1] * 2 + 1, 319, (a1 - 1) >> 1);
    for (let x = x1; x <= x2; x++) {
      const xs = x + sx, X = xs < 320 ? xs : (xs + 192) & 0x1ff;
      const b = byteAt(X * 256 + Y);
      if (b < 0) continue;
      const h = x * 2;
      if (res === 1) {
        put(h, ((((b >> 4) + off) & 15) << 4) | (b & 15));
        line[h + 1] = line[h];
        pr[h + 1] = pr[h];
      } else {
        put(h, (off << 4) | (b >> 4));
        put(h + 1, (off << 4) | (b & 15));
      }
    }
  }

  // the tilemap's pixels a0 to a1 of surface line wy into tmLine (-1 clear) and tmBelow
  renderTilemap(wy, a0 = 0, a1 = 640) {
    const m = this.m, nr = m.nr, line = this.tmLine, below = this.tmBelow;
    if (a0 < 0) a0 = 0;
    if (a1 > 640) a1 = 640;
    if (a0 >= a1) return;
    line.fill(-1, a0, a1);
    below.fill(0, a0, a1);
    const c = this.clip[3];
    if (wy < c[2] || wy > c[3]) return;
    const r6b = nr[0x6b];
    const wide = (r6b & 0x40) !== 0, noAttr = (r6b & 0x20) !== 0, text = (r6b & 8) !== 0;
    const t512 = (r6b & 2) !== 0, onTop = (r6b & 1) !== 0;
    const palBase = (r6b & 0x10 ? 7 : 3) * 256, nr14 = nr[0x14], tIdx = nr[0x4c] & 15;
    const mapBank = m.banks[nr[0x6e] & 0x80 ? 7 : 5], mapWrap = nr[0x6e] & 0x80 ? 0x1fff : 0x3fff, mapBase = nr[0x6e] & 0x3f;
    const tileBank = m.banks[nr[0x6f] & 0x80 ? 7 : 5], tileWrap = nr[0x6f] & 0x80 ? 0x1fff : 0x3fff, tileBase = nr[0x6f] & 0x3f;
    const at = (bank, wrap, b6, rel) => bank[(((((rel >> 8) + b6) & 63) << 8) | (rel & 255)) & wrap];
    const scrollX = ((nr[0x2f] & 3) << 8) | nr[0x30];
    const Y = (wy + nr[0x31]) & 255, row = Y >> 3, py = Y & 7;
    const cols = wide ? 80 : 40, width = wide ? 640 : 320;
    const h1 = Math.max(c[0] * 4, a0), h2 = Math.min(c[1] * 4 + 3, 639, a1 - 1); // the clip's x: 320 units, 2 a step
    const step = wide ? 1 : 2;
    for (let h = h1 - (h1 % step); h <= h2; h += step) {
      const X = ((wide ? h : h >> 1) + scrollX) % width;
      const entry = row * cols + (X >> 3);
      let tile, attr;
      if (noAttr) { tile = at(mapBank, mapWrap, mapBase, entry); attr = nr[0x6c]; }
      else { tile = at(mapBank, mapWrap, mapBase, entry * 2); attr = at(mapBank, mapWrap, mapBase, entry * 2 + 1); }
      const tile9 = (t512 ? (attr & 1) << 8 : 0) | tile;
      const px = X & 7;
      let col = -1;
      if (text) {
        const b = at(tileBank, tileWrap, tileBase, tile9 * 8 + py);
        const idx = (attr & 0xfe) | ((b >> (7 - px)) & 1);
        const rgb = this.pal[palBase + idx];
        if (rgb >> 1 !== nr14) col = rgb;
      } else {
        const xm = ((attr >> 3) ^ (attr >> 1)) & 1;
        const ex = xm ? 7 - px : px, ey = attr & 4 ? 7 - py : py;
        const tx = attr & 2 ? ey : ex, ty = attr & 2 ? ex : ey;
        const b = at(tileBank, tileWrap, tileBase, tile9 * 32 + ty * 4 + (tx >> 1));
        const nib = tx & 1 ? b & 15 : b >> 4;
        if (nib !== tIdx) col = this.pal[palBase + ((attr & 0xf0) | nib)];
      }
      const bel = ((attr & 1) || t512) && !onTop ? 1 : 0;
      for (let k = 0; k < step; k++) {
        if (h + k < h1 || h + k > h2) continue;
        line[h + k] = col;
        below[h + k] = bel;
      }
    }
  }

  // The sprites on surface line wy into sprLine (-1 clear), as the hardware's engine draws them
  // (sprite 0 first; relatives after their anchor), with the collision and overflow flags.
  // False when nothing is drawn.
  renderSprites(wy) {
    const nr = this.m.nr, A = this.sprAttr, pat = this.patterns, line = this.sprLine;
    const zeroOnTop = (nr[0x15] & 0x40) !== 0;
    const tr = nr[0x4b];
    const palBase = (nr[0x43] & 8 ? 6 : 2) * 256;
    // the engine's time for a line: 4 28 MHz cycles a pixel, a cycle for each sprite looked at
    const budget = this.lineT * 2 * 4;
    let cost = 128, any = false;
    line.fill(-1);
    let anchor = false;
    let ax = 0, ay = 0, avis = 0, apat = 0, apal = 0, aH = 0, aT = 0, arot = 0, axm = 0, aym = 0, axs = 0, ays = 0;
    for (let i = 0; i < 128; i++) {
      const o = i * 5, a0 = A[o], a1 = A[o + 1], a2 = A[o + 2], a3 = A[o + 3], a4 = A[o + 4];
      const E = (a3 & 0x40) !== 0;
      let x, y, vis, pal, xm, ym, rot, xs, ys, H, pat7;
      if (E && (a4 & 0xc0) === 0x40) { // a relative sprite
        if (!anchor) continue;
        let ox = (a0 << 24) >> 24, oy = (a1 << 24) >> 24;
        if (arot) { const s = ox; ox = oy; oy = s; }
        if (arot ^ axm) ox = (-ox << 24) >> 24;
        if (aym) oy = (-oy << 24) >> 24;
        x = (ax + (ox << axs)) & 511;
        y = (ay + (oy << ays)) & 511;
        pal = a2 & 1 ? (apal + (a2 >> 4)) & 15 : a2 >> 4;
        pat7 = ((a3 & 0x3f) << 1) | (a4 & 0x20 && aH ? 1 : 0);
        if (a4 & 1) pat7 = (pat7 + apat) & 127;
        H = aH;
        vis = avis && (a3 & 0x80);
        const oxm = (a2 >> 3) & 1, oym = (a2 >> 2) & 1, orot = (a2 >> 1) & 1;
        if (!aT) { xm = oxm; ym = oym; rot = orot; xs = (a4 >> 3) & 3; ys = (a4 >> 1) & 3; }
        else {
          const uxm = arot ? oym ^ orot : oxm, uym = arot ? oxm ^ orot : oym;
          xm = axm ^ uxm; ym = aym ^ uym; rot = arot ^ orot; xs = axs; ys = ays;
        }
      } else { // an anchor (or a sprite on its own)
        anchor = true;
        ax = a0 | ((a2 & 1) << 8);
        ay = a1 | (E ? (a4 & 1) << 8 : 0);
        avis = a3 & 0x80;
        aH = E && a4 & 0x80 ? 1 : 0;
        apat = ((a3 & 0x3f) << 1) | (aH && a4 & 0x40 ? 1 : 0);
        apal = a2 >> 4;
        aT = E && a4 & 0x20 ? 1 : 0;
        if (aT) { arot = (a2 >> 1) & 1; axm = (a2 >> 3) & 1; aym = (a2 >> 2) & 1; axs = (a4 >> 3) & 3; ays = (a4 >> 1) & 3; }
        else { arot = axm = aym = axs = ays = 0; }
        x = ax; y = ay; vis = avis; pal = apal; H = aH; pat7 = apat;
        xm = (a2 >> 3) & 1; ym = (a2 >> 2) & 1; rot = (a2 >> 1) & 1;
        xs = E ? (a4 >> 3) & 3 : 0; ys = E ? (a4 >> 1) & 3 : 0;
      }
      if (!vis) continue;
      const ry = (wy - y) & 511;
      if (ry >= 16 << ys) continue;
      cost += 16 << xs;
      if (cost > budget) { this.sprStatus |= 2; break; }
      const sy = ry >> ys, rep = 1 << xs;
      const mx = xm ^ rot;
      for (let sxp = 0; sxp < 16; sxp++) {
        const ey = ym ? 15 - sy : sy, ex = mx ? 15 - sxp : sxp;
        const row = rot ? ex : ey, col = rot ? ey : ex;
        let idx;
        if (H) {
          const b = pat[((pat7 >> 1) << 8) | ((pat7 & 1) << 7) | ((row * 16 + col) >> 1)];
          const nib = col & 1 ? b & 15 : b >> 4;
          if (nib === (tr & 15)) continue;
          idx = (pal << 4) | nib;
        } else {
          const b = pat[((pat7 >> 1) << 8) | (row * 16 + col)];
          if (b === tr) continue;
          idx = ((((b >> 4) + pal) & 15) << 4) | (b & 15);
        }
        const colour = this.pal[palBase + idx];
        for (let k = 0; k < rep; k++) {
          const X = (x + sxp * rep + k) & 511;
          if (X >= 320) continue;
          if (line[X] >= 0) {
            this.sprStatus |= 1;
            if (zeroOnTop) continue;
          }
          line[X] = colour;
          any = true;
        }
      }
    }
    return any;
  }
}

// Layer 2's colour L added to the blend colour M (-1: none), each 3-bit part; minus 5 in mode 7
function blend(L, M, minus5) {
  let out = 0;
  for (let sh = 6; sh >= 0; sh -= 3) {
    const l = (L >> sh) & 7, mv = M >= 0 ? (M >> sh) & 7 : 0, s = l + mv;
    let c;
    if (!minus5) c = Math.min(s, 7);
    else if (M < 0) c = l;
    else c = s <= 4 ? 0 : s >= 12 ? 7 : s - 5;
    out |= c << sh;
  }
  return out;
}
