// The ULA's picture for ZXEmu, written for it in 2026. GPL v2 or later, see LICENSE.
//
// The frame buffer holds the paper and 48 Spectrum pixels of border on each side, every
// Spectrum pixel two pixels wide (so the CRT shaders, made for the CPC's 768-wide picture,
// see the same detail). It is drawn a cell (8 pixels, 4 T-states) at a time as the beam
// reaches it: the machine catches the picture up to the CPU's T-state before every change
// that shows (a write to the screen memory being shown, the border, the screen page), so
// colour changes in mid-line (multicolour) and border effects come out where they did.

export const BORDER = 48; // Spectrum pixels of border round the paper in the frame buffer
export const FB_WIDTH = (256 + 2 * BORDER) * 2;
export const FB_HEIGHT = 192 + 2 * BORDER;
const CELLS = (256 + 2 * BORDER) / 8; // cells across a line
const LINES = FB_HEIGHT;

// the colours with no page to set them: normal at 0xD7, bright at 0xFF
export function standardColours(normal = 0xd7, bright = 0xff) {
  const out = new Uint32Array(16);
  for (let i = 0; i < 16; i++) {
    const v = i & 8 ? bright : normal;
    const r = i & 2 ? v : 0, g = i & 4 ? v : 0, b = i & 1 ? v : 0;
    out[i] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
  }
  return out;
}

export class Video {
  constructor(m) {
    this.m = m;
    this.fb = new Uint32Array(FB_WIDTH * FB_HEIGHT);
    this.colours = standardColours();
    // the paper in the frame buffer: Renderer's border 'none'
    this.window = { x: BORDER * 2, y: BORDER, w: 512, h: 192 };
    this.lineStart = new Float64Array(LINES); // T-state of each visible line's first cell
    this.reset();
  }

  setTiming(t) {
    this.lineT = t.line;
    this.paperT = t.paper;
    for (let y = 0; y < LINES; y++) this.lineStart[y] = t.paper + (y - BORDER) * t.line - BORDER / 2;
  }

  setColours(c) {
    this.colours = Uint32Array.from(c);
  }

  reset() {
    this.border = 7;
    this.flashCount = 0;
    this.flash = 0;
    this.pos = 0; // the next cell to draw, line * CELLS + cell
    this.frameCompleted = 0;
  }

  // the T-state at which cell `pos` is shown
  cellT(pos) {
    const y = (pos / CELLS) | 0;
    return this.lineStart[y] + (pos - y * CELLS) * 4;
  }

  // draws every cell shown before T-state t
  catchUp(t) {
    const end = LINES * CELLS;
    let pos = this.pos;
    if (pos >= end) return;
    let y = (pos / CELLS) | 0;
    let x = pos - y * CELLS;
    let at = this.lineStart[y] + x * 4;
    if (at > t) return;
    const fb = this.fb, col = this.colours;
    const scr = this.m.screenMem;
    const border = col[this.border];
    const flash = this.flash;
    while (at <= t) {
      let o = y * FB_WIDTH + x * 16;
      const py = y - BORDER, px = x - BORDER / 8;
      if (py >= 0 && py < 192 && px >= 0 && px < 32) {
        const bits = scr[((py & 0xc0) << 5) | ((py & 7) << 8) | ((py & 0x38) << 2) | px];
        const attr = scr[0x1800 + ((py >> 3) << 5) + px];
        const bright = (attr & 0x40) >> 3;
        let ink = col[(attr & 7) | bright], paper = col[((attr >> 3) & 7) | bright];
        if (attr & 0x80 && flash) { const s = ink; ink = paper; paper = s; }
        for (let b = 0x80; b; b >>= 1) {
          const c = bits & b ? ink : paper;
          fb[o++] = c;
          fb[o++] = c;
        }
      } else {
        fb.fill(border, o, o + 16);
      }
      pos++;
      if (++x === CELLS) {
        x = 0;
        if (++y === LINES) break;
        at = this.lineStart[y];
      } else {
        at += 4;
      }
    }
    this.pos = pos;
  }

  setBorder(t, c) {
    if ((c & 7) === this.border) return;
    this.catchUp(t);
    this.border = c & 7;
  }

  // the whole frame drawn: start the next one
  endFrame(frameLen) {
    this.catchUp(frameLen + 1e9);
    this.pos = 0;
    if (++this.flashCount === 16) {
      this.flashCount = 0;
      this.flash ^= 1;
    }
    this.frameCompleted = 1;
  }
}
