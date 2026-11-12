// The ZX Spectrum Next for ZXEmu, written for it in 2026. GPL v2 or later, see LICENSE.
//
// The Next as a Spectrum with more: the Z80N (z80.js) at 3.5, 7, 14 or 28 MHz, 768K or 1792K
// of RAM in 8K pages that the MMU puts in any of the eight 8K slots, the Next registers
// (ports $243B and $253B, and NEXTREG), the 128K's paging through the MMU, .nex programs, and
// the esxDOS calls (RST $08) on an SD card in memory (sd.js), and the core's timing: the display
// timings, contention at 3.5 MHz, the read wait state at 28 MHz, the interrupt's length. The
// picture is nextvideo.js; the interrupt controller, copper, CTC and DMA nextdevices.js; the
// sound (TurboSound, the DACs) nextsound.js. Here too: the joysticks (Kempston, MD pads, the
// keyboard ones) by Next register $05, and the Kempston mouse.
//
// Sources: wiki.specnext.dev (Next registers, the memory map, the NEX file format) and
// "NextZXOS and esxDOS APIs" (24 May 2023) for the esxDOS calls. No NextZXOS ROM is needed:
// the 128K ROM sits under the MMU's ROM slots, and RST $08 is answered here.

import { Spectrum, MODELS, NEXT_TIMINGS, resolveModel } from './spectrum.js';
import { SdCard } from './sd.js';
import { NextVideo } from './nextvideo.js';
import { NextSound } from './nextsound.js';
import { Interrupts, Copper, Ctc, Dma, INT_LINE, INT_ULA, INT_CTC } from './nextdevices.js';

// joystick modes (Next register $05): what the keyboard ones press, and the Kempston/MD ports
const JOY_KEYS_MODE = { 0: 'sinclair2', 2: 'cursor', 3: 'sinclair1' };
const JOY_PORT_MODE = { 1: 0x1f, 4: 0x37, 5: 0x1f, 6: 0x37 };
const JOY_MODE_OF = { sinclair2: 0, kempston: 1, cursor: 2, sinclair1: 3, md: 5, none: 7, fuller: 7 };
// the Mega Drive pad's extra buttons, after the Spectrum's joystick bits (FIRE is B, FIRE2 C)
export const PAD = { A: 64, START: 128, X: 256, Y: 512, Z: 1024, MODE: 2048 };
// the DACs' ports (low byte): channels A 0, B 1, C 2, D 3
const DAC_PORTS = { 0x1f: [0], 0xf1: [0], 0x3f: [0], 0x0f: [1], 0xf3: [1], 0x4f: [2], 0xf9: [2], 0x5f: [3], 0xfb: [3], 0xdf: [0, 3], 0xb3: [1, 2] };

const PAGE = 0x2000;
const DEFAULT_MMU = [0xff, 0xff, 10, 11, 4, 5, 0, 1];
const NEX_BANK_ORDER = [5, 2, 0, 1, 3, 4];
for (let b = 6; b < 112; b++) NEX_BANK_ORDER.push(b);

// esxDOS error codes
const ESX = { ENOENT: 5, EIO: 6, EINVAL: 7, ENFILE: 12, EBADF: 13, EISDIR: 16, ENOTDIR: 17, EEXIST: 18, ENOCMD: 22 };
const ESX_MESSAGES = ['Unknown error', 'OK', 'Nonsense in esxDOS', 'Statement end error', 'Wrong file type', 'No such file or dir', 'I/O error', 'Invalid filename', 'Access denied', 'Drive full', 'Invalid i/o request', 'No such drive', 'Too many files open', 'Bad file number', 'No such device', 'File pointer overflow', 'Is a directory', 'Not a directory', 'Already exists', 'Invalid path', 'Missing system', 'Path too long', 'No such command', 'In use', 'Read only', 'Verify failed', 'Sys file load error', 'Directory in use', 'MAPRAM is active', 'Drive busy', 'Unknown filesystem', 'Device busy'];

// a Spectrum or a Next, as the model asks
export function createMachine(opts = {}) {
  return MODELS[resolveModel(opts.model)].next ? new SpectrumNext(opts) : new Spectrum(opts);
}

export class SpectrumNext extends Spectrum {
  constructor(opts = {}) {
    super({ ...opts, model: opts.model || 'next' });
    if (opts.sd) this.sd = opts.sd instanceof SdCard ? opts.sd : new SdCard(opts.sd);
  }

  // the Next's own state, made the first time hardReset runs (from Spectrum's constructor)
  initNext() {
    const pages = (this.info.ram / 8) | 0;
    this.ramPages = pages;
    this.mem = new Uint8Array(pages * PAGE);
    this.banks = [];
    for (let b = 0; b < pages / 2; b++) this.banks.push(this.mem.subarray(b * 0x4000, (b + 1) * 0x4000));
    this.page8 = [];
    for (let p = 0; p < pages; p++) this.page8.push(this.mem.subarray(p * PAGE, (p + 1) * PAGE));
    this.noPage = new Uint8Array(PAGE).fill(0xff);
    this.slots = new Array(8).fill(this.noPage);
    this.slotRO = new Uint8Array(8);
    this.mmu = DEFAULT_MMU.slice();
    this.nr = new Uint8Array(256);
    this.sd = this.sd || new SdCard();
    this.handles = new Map();
    this.cwd = '/';
    this.video = new NextVideo(this);
    this.video.setTiming(this.timing);
    this.psg = new NextSound({ sampleRate: this.sampleRate, clock: this.timing.clock });
    this.ints = new Interrupts(this);
    this.copper = new Copper(this);
    this.ctc = new Ctc(this);
    this.dma = new Dma(this);
    this.cpu.intHook = () => this.ints.asserted();
    this.kempPort = [0x1f, 0];
    this.mdPad = [false, false];
    this.mouse = { x: 0, y: 0, buttons: 0, wheel: 0 };
  }

  // ---------------------------------------------------------------- time
  // n of the CPU's cycles (at its speed) pass, the CPU not running (the DMA has the bus)
  cpuCycles(n) {
    const cpu = this.cpu;
    const s = n + cpu.tRem;
    cpu.t += Math.floor(s / cpu.mult);
    cpu.tRem = s % cpu.mult;
  }

  // the 28 MHz tick now
  get ticks() { return (this.tBase + this.cpu.t) * 8 + ((this.cpu.tRem * 8) / this.cpu.mult); }

  get rasterLines() { return Math.round(this.frameLen / this.timing.line); }

  // the T-state in this frame of line `cvc` in the copper's and line interrupt's numbering (line
  // 0 the paper's top row, moved by Next register $64) at pixel column hc (hc 12 the paper's
  // left edge); -1 if there is no such line
  rasterT(cvc, hc) {
    const t = this.timing, lines = this.rasterLines;
    if (cvc >= lines) return -1;
    const r = (((cvc - this.nr[0x64]) % lines) + lines) % lines;
    return (t.paper - 6 + r * t.line + hc / 2) % this.frameLen;
  }

  // the line (copper numbering) the beam is on now
  rasterLine() {
    const t = this.timing, lines = this.rasterLines;
    const rel = (((this.cpu.t - (t.paper - 6)) % this.frameLen) + this.frameLen) % this.frameLen;
    return (Math.floor(rel / t.line) + this.nr[0x64]) % lines;
  }

  // when the line interrupt comes next (Next registers $22, $23): on the line before its line, at
  // pixel column 255
  scheduleLine(from = this.tBase + this.cpu.t) {
    this.lineAt = Infinity;
    if (!(this.nr[0x22] & 2)) return;
    const n = ((this.nr[0x22] & 1) << 8) | this.nr[0x23], lines = this.rasterLines;
    if (n >= lines) return;
    const t = this.rasterT(n === 0 ? lines - 1 : n - 1, 255);
    let at = this.tBase + t;
    while (at < from) at += this.frameLen;
    this.lineAt = at;
  }

  // the bus's answers to the CPU: the IM 2 vector, and RETI
  intVector() { return this.ints.vector(); }
  reti() { this.ints.reti(); }

  // ---------------------------------------------------------------- running
  // the devices up to now: the line interrupt, the CTC, the copper, the DMA's next byte
  service() {
    const now = this.tBase + this.cpu.t;
    while (now >= this.lineAt) {
      const at = this.lineAt;
      this.ints.fire(INT_LINE, at);
      this.lineAt = Infinity;
      this.scheduleLine(at + 1);
    }
    const ticks = this.ticks;
    if (this.ctc.nextEvent <= ticks) this.ctc.advance(ticks);
    if (this.copper.mode !== 0) this.copper.runTo(ticks);
    if (this.dma.active) this.dma.service(now);
  }

  stepOnce() {
    this.service();
    const dma = this.dma;
    if (dma.active && dma.holding && !this.ints.holdsDma) dma.step();
    else this.cpu.step();
  }

  // the next T-state (in this frame) something happens without the CPU
  nextEventT() {
    let n = this.frameLen;
    const line = this.lineAt - this.tBase;
    if (line < n) n = line;
    const ctc = this.ctc.nextEvent / 8 - this.tBase;
    if (ctc < n) n = ctc;
    return n;
  }

  runFrame() {
    this.serviceTyping();
    const cpu = this.cpu, v = this.video, len = this.frameLen;
    while (cpu.t >= len) this.endFrame();
    v.frameCompleted = 0;
    while (!v.frameCompleted) {
      if (cpu.halted && !this.dma.active && this.copper.mode === 0 && cpu.trapFlags[cpu.pc] === 0 && !(cpu.iff1 && this.ints.asserted())) {
        // HALT: NOPs (4 cycles, and a wait at 28 MHz) until the next thing that happens
        this.service();
        const target = Math.min(len, Math.ceil(this.nextEventT()));
        const t = cpu.t;
        if (target > t + 1) {
          const raw = 4 + cpu.rwait[cpu.pc >> 13], mult = cpu.mult;
          const n = Math.max(1, Math.floor(((target - t) * mult - cpu.tRem) / raw));
          const total = n * raw + cpu.tRem;
          cpu.t = t + Math.floor(total / mult);
          cpu.tRem = total % mult;
          cpu.r = (cpu.r & 0x80) | ((cpu.r + n) & 0x7f);
        } else this.stepOnce();
      } else this.stepOnce();
      if (cpu.t >= len) this.endFrame();
    }
  }

  runCycles(n) {
    const cpu = this.cpu;
    let left = n;
    while (left > 0) {
      const before = cpu.t;
      this.stepOnce();
      left -= cpu.t - before;
      while (cpu.t >= this.frameLen) {
        this.endFrame();
        this.serviceTyping();
      }
    }
  }

  endFrame() {
    super.endFrame();
    this.ints.fire(INT_ULA, this.tBase); // the frame interrupt (its status bit, and /INT if on)
    if (this.lineAt === Infinity) this.scheduleLine(this.tBase);
  }

  // Layer 2 is shown (port $123B bit 1, or Next register $69 bit 7)
  get l2Display() { return (this.l2Port & 2) !== 0; }

  // Layer 2's memory in place of the MMU's for reads and/or writes (port $123B): $0000-$3FFF,
  // or $0000-$BFFF for segment 3
  updateL2Map() {
    const p = this.l2Port;
    this.l2Read = (p & 4) !== 0;
    this.l2Write = (p & 1) !== 0;
    const seg = p >> 6;
    this.l2Limit = seg === 3 ? 0xc000 : 0x4000;
    this.l2Bank = ((p & 8 ? this.nr[0x13] : this.nr[0x12]) & 0x7f) + this.l2Off + (seg === 3 ? 0 : seg);
  }

  l2Addr(addr) {
    const i = (this.l2Bank + (addr >> 14)) * 0x4000 + (addr & 0x3fff);
    return i < this.mem.length ? i : -1;
  }

  hardReset() {
    if (!this.mem) this.initNext();
    this.mem.fill(0);
    this.resetNextRegs();
    this.mmu = DEFAULT_MMU.slice();
    this.portDffd = 0;
    this.regSelect = 0;
    this.closeAll();
    this.speed = 0;
    this.l2Port = 0;
    this.l2Off = 0;
    this.portFF = 0;
    this.updateL2Map();
    this.video.resetNext();
    this.ints.reset();
    this.copper.reset();
    this.ctc.reset();
    this.dma.reset(true);
    this.psg.nextReset();
    this.mouse = { x: 0, y: 0, buttons: 0, wheel: 0 };
    super.hardReset();
    const cpu = this.cpu;
    cpu.z80n = true;
    cpu.trapFlags[0x0008] = 1;
    cpu.onTrap = (pc) => this.onTrapAt(pc);
    this.updateTiming();
    this.setSpeed(0);
    this.updateSound();
    this.updateJoysticks();
    this.scheduleLine(0);
    this.ints.fire(INT_ULA, 0);
  }

  // the Next registers as a reset leaves them (wiki.specnext.dev)
  resetNextRegs() {
    const nr = this.nr;
    nr.fill(0);
    nr[0x12] = 8; // Layer 2's first 16K bank
    nr[0x13] = 11; // its shadow
    nr[0x14] = 0xe3; // the transparent colour
    nr[0x4b] = 0xe3; // the sprites' transparent index
    nr[0x42] = 0x07; // ULANext's ink mask
    nr[0x4a] = 0xe3; // the fallback colour
    nr[0x4c] = 0x0f; // the tilemap's transparent index
    nr[0x6e] = 0x2c; // the tilemap at $6C00
    nr[0x6f] = 0x0c; // its tiles at $4C00
    nr[0x03] = 0x20; // 128K display timing (unchecked: which one NextZXOS gives a .nex)
    nr[0x05] = 0x40; // joystick 1 Kempston (port $1F), joystick 2 Sinclair 2
    nr[0x06] = 0x01; // AY, not YM
    nr[0x08] = 0x1a; // the speaker, the DACs and TurboSound on (unchecked: what NextZXOS leaves)
    nr[0x0a] = 0x01; // the mouse at normal speed
    nr[0xc4] = 0x81; // the ULA's interrupt on
    for (let s = 0; s < 8; s++) nr[0x50 + s] = DEFAULT_MMU[s];
  }

  // Next registers $06, $08, $09 to the sound
  updateSound() {
    const nr = this.nr, p = this.psg;
    p.ym = !(nr[0x06] & 1);
    p.turbo = (nr[0x08] & 2) !== 0;
    p.acb = (nr[0x08] & 0x20) !== 0;
    p.mono = [(nr[0x09] >> 5) & 1, (nr[0x09] >> 6) & 1, (nr[0x09] >> 7) & 1];
    if (!(nr[0x08] & 8)) for (let c = 0; c < 4; c++) p.setDac(this.cpu.t, c, 0x80); // held at the middle
  }

  // Next register $05 to the two joysticks
  updateJoysticks() {
    const v = this.nr[0x05];
    const modes = [((v >> 1) & 4) | (v >> 6), ((v << 1) & 4) | ((v >> 4) & 3)];
    for (let j = 0; j < 2; j++) {
      this.joyTypes[j] = JOY_KEYS_MODE[modes[j]] || 'none';
      this.kempPort[j] = JOY_PORT_MODE[modes[j]] || 0;
      this.mdPad[j] = modes[j] === 5 || modes[j] === 6;
    }
  }

  // the page's joystick choice: a Next register $05 mode (port 0 joystick 1, port 1 joystick 2)
  setJoystickType(type, port = 0) {
    let mode = JOY_MODE_OF[type] ?? 7;
    if (port && (mode === 1 || mode === 5)) mode += 3; // Kempston 2 / MD 2 on port $37
    const nr = this.nr;
    if (!port) nr[0x05] = (nr[0x05] & 0x37) | ((mode & 3) << 6) | ((mode & 4) << 1);
    else nr[0x05] = (nr[0x05] & 0xcd) | ((mode & 3) << 4) | ((mode & 4) >> 1);
    this.updateJoysticks();
  }

  // the Kempston mouse: moves (the page's pixels, y down), buttons (1 left, 2 right, 4 middle), wheel
  mouseMove(dx, dy) {
    const dpi = this.nr[0x0a] & 3;
    const f = (d) => (dpi === 0 ? d * 2 : dpi === 2 ? d >> 1 : dpi === 3 ? d >> 2 : d);
    this.mouse.x = (this.mouse.x + f(Math.round(dx))) & 0xff;
    this.mouse.y = (this.mouse.y - f(Math.round(dy))) & 0xff;
  }

  setMouseButtons(b) { this.mouse.buttons = b; }
  mouseWheel(d) { this.mouse.wheel = (this.mouse.wheel + d) & 15; }

  setSpeed(s) {
    this.speed = s & 3;
    this.cpu.mult = 1 << this.speed;
    this.cpu.tRem = 0;
    // the interrupt stays 32 or 36 CPU cycles long (zxnext.vhd counts it on the CPU's clock), so
    // it is shorter at turbo speeds: z80.js compares the CPU's cycles with intLen
    this.updateContention();
  }

  // the display timing from Next register $03 bits 6-4: the frame, the picture and the
  // contention follow it (a write with those bits 0 leaves the timing as it was)
  updateTiming() {
    const t = NEXT_TIMINGS[(this.nr[3] >> 4) & 7] || NEXT_TIMINGS[2];
    if (t !== this.timing) {
      this.video.catchUp(this.cpu.t);
      this.timing = t;
      this.setupTiming();
      if (this.lineAt !== undefined) this.scheduleLine();
    }
    this.cpu.intLen = 0; // the interrupt controller makes the ULA's interrupt
    this.updateContention();
  }

  // As the FPGA core (zxnext.vhd): contention only at 3.5 MHz, unless Next register $08 bit 6
  // turns it off, on the 16K banks the display timing's machine contends (only banks 0-7), by
  // the bank each 8K slot holds. At 28 MHz every memory read (fetches too, not writes or I/O)
  // takes one more 28 MHz cycle, except from page $0E (bank 7's first half, in fast block RAM)
  // and unmapped pages ($E0 and up).
  updateContention() {
    if (!this.slots) return;
    const cpu = this.cpu, t = this.timing;
    const on = this.speed === 0 && !(this.nr[8] & 0x40) && t.contend !== 'none';
    const contends = t.contend === '48' ? (b) => b === 5 : t.contend === '128' ? (b) => (b & 1) === 1 : t.contend === 'plus3' ? (b) => b >= 4 : () => false;
    for (let s = 0; s < 8; s++) {
      const p = this.mmu[s];
      const rom = s < 2 && p === 0xff;
      cpu.cpage[s] = on && !rom && p < 16 && contends(p >> 1) ? 1 : 0;
      cpu.rwait[s] = this.speed === 3 && (rom || (p !== 0x0e && p < 0xe0)) ? 1 : 0;
    }
    cpu.noMreqContended = on && t.noMreq;
    cpu.ioContended = on && t.io;
  }

  // ---------------------------------------------------------------- memory
  updatePaging() {
    if (!this.mem) return;
    this.updateSlots();
  }

  // the eight 8K slots from the MMU; $FF in slots 0 and 1 is the ROM the 128K paging picks
  updateSlots() {
    const rom = (this.port7ffd >> 4) & 1;
    this.romIndex = rom;
    const romPage = this.romPages[Math.min(rom, this.romPages.length - 1)];
    for (let s = 0; s < 8; s++) {
      const p = this.mmu[s];
      if (s < 2 && p === 0xff) {
        this.slots[s] = romPage.subarray(s * PAGE, (s + 1) * PAGE);
        this.slotRO[s] = 1;
      } else if (p < this.ramPages) {
        this.slots[s] = this.page8[p];
        this.slotRO[s] = 0;
      } else {
        this.slots[s] = this.noPage;
        this.slotRO[s] = 1;
      }
    }
    // Spectrum's view (the tape traps ask for the BASIC ROM at the bottom)
    this.pageBank[0] = this.mmu[0] === 0xff ? -1 : this.mmu[0] >> 1;
    this.updateContention();
    const screen = this.port7ffd & 8 ? 7 : 5;
    if (screen !== this.screenBank) {
      this.video.catchUp(this.cpu.t);
      this.screenBank = screen;
      this.screenMem = this.banks[screen];
    }
  }

  read(addr) {
    if (this.l2Read && addr < this.l2Limit) {
      const i = this.l2Addr(addr);
      return i < 0 ? 0xff : this.mem[i];
    }
    return this.slots[addr >> 13][addr & 0x1fff];
  }

  write(addr, v) {
    if (this.l2Write && addr < this.l2Limit) {
      const i = this.l2Addr(addr);
      if (i >= 0) this.mem[i] = v;
      return;
    }
    const s = addr >> 13;
    if (this.slotRO[s]) return;
    const off = addr & 0x1fff;
    if (off < 0x1b00 && this.mmu[s] === this.screenBank * 2) this.video.catchUp(this.cpu.t);
    this.slots[s][off] = v;
  }

  peek(addr) { return this.read(addr & 0xffff); }

  poke(addr, v) {
    const s = (addr >> 13) & 7;
    if (!this.slotRO[s]) this.slots[s][addr & 0x1fff] = v & 0xff;
  }

  // ---------------------------------------------------------------- I/O
  ioRead(port) {
    if (port === 0x243b) return this.regSelect;
    if (port === 0x253b) return this.nextRegRead(this.regSelect);
    if (port === 0x123b) return this.l2Port & 0xcf;
    if (port === 0x303b) return this.video.spriteStatus();
    if (port === 0xff3b) return this.video.ulaPlusRead();
    const lo = port & 0xff;
    if ((lo === 0x1f || lo === 0x37) && (this.kempPort[0] === lo || this.kempPort[1] === lo)) {
      // Kempston: fire 2, fire, up, down, left, right; an MD pad adds START and A
      let v = 0;
      for (let j = 0; j < 2; j++) {
        if (this.kempPort[j] !== lo) continue;
        const b = this.joy[j];
        v |= (b & 8 ? 1 : 0) | (b & 4 ? 2 : 0) | (b & 2 ? 4 : 0) | (b & 1 ? 8 : 0) | (b & 16 ? 16 : 0) | (b & 32 ? 32 : 0);
        if (this.mdPad[j]) v |= (b & PAD.A ? 64 : 0) | (b & PAD.START ? 128 : 0);
      }
      return v;
    }
    if (lo === 0xdf) { // the Kempston mouse
      const hi = (port >> 8) & 0x0f, ms = this.mouse;
      if (hi === 0x0b) return ms.x;
      if (hi === 0x0f) return ms.y;
      if (hi === 0x0a) {
        let left = ms.buttons & 1, right = ms.buttons & 2;
        if (this.nr[0x0a] & 8) { const s = left; left = right; right = s; }
        return (ms.wheel << 4) | 8 | (ms.buttons & 4 ? 0 : 4) | (left ? 0 : 2) | (right ? 0 : 1);
      }
    }
    if (lo === 0x6b || lo === 0x0b) { this.dma.zilog = lo === 0x0b; return this.dma.read(); }
    if ((port & 0xf8ff) === 0x183b) {
      const ch = (port >> 8) & 7;
      return ch < 4 ? this.ctc.read(ch, this.ticks) : 0;
    }
    return super.ioRead(port);
  }

  // the ULA's frame interrupt on or off, in its three places (NR $22 bit 2, NR $C4 bit 0, port $FF bit 6)
  setUlaInt(on) {
    this.ints.enabled[INT_ULA] = on ? 1 : 0;
    this.nr[0x22] = (this.nr[0x22] & ~4) | (on ? 0 : 4);
    this.nr[0xc4] = (this.nr[0xc4] & ~1) | (on ? 1 : 0);
    this.portFF = (this.portFF & ~0x40) | (on ? 0 : 0x40);
  }

  setLineInt(on) {
    this.ints.enabled[INT_LINE] = on ? 1 : 0;
    this.nr[0x22] = (this.nr[0x22] & ~2) | (on ? 2 : 0);
    this.nr[0xc4] = (this.nr[0xc4] & ~2) | (on ? 2 : 0);
    this.scheduleLine();
  }

  ioWrite(port, v) {
    if (port === 0x243b) { this.regSelect = v; return; }
    if (port === 0x253b) { this.nextRegWrite(this.regSelect, v); return; }
    const lo = port & 0xff;
    const dac = DAC_PORTS[lo];
    if (dac) { // a DAC (and $F1, $F9 never reach the paging ports)
      if (this.nr[0x08] & 8) for (const c of dac) this.psg.setDac(this.cpu.t, c, v);
      return;
    }
    if (lo === 0x6b || lo === 0x0b) { this.dma.write(v, lo === 0x0b); return; }
    if ((port & 0xf8ff) === 0x183b) {
      const ch = (port >> 8) & 7;
      if (ch < 4) this.ctc.write(ch, v, this.ticks);
      return;
    }
    if (port === 0x123b || port === 0x303b || lo === 0x57 || lo === 0x5b || lo === 0xff || port === 0xbf3b || port === 0xff3b) {
      this.video.catchUp(this.cpu.t, true);
      if (port === 0x123b) {
        if (v & 0x10) this.l2Off = v & 7;
        else this.l2Port = v;
        this.updateL2Map();
      } else if (port === 0x303b) this.video.spriteSelect(v);
      else if (lo === 0x57) this.video.spriteAttrWrite(v);
      else if (lo === 0x5b) this.video.patternWrite(v);
      else if (port === 0xbf3b) this.video.ulaPlusSelect(v);
      else if (port === 0xff3b) this.video.ulaPlusWrite(v);
      else { this.portFF = v; this.setUlaInt(!(v & 0x40)); } // Timex screen modes; bit 6 the frame interrupt
      return;
    }
    if ((port & 0xc002) === 0x4000) this.write7ffd(v);
    else if ((port & 0xf002) === 0xd000) { this.portDffd = v; this.write7ffd(this.port7ffd, true); }
    else if ((port & 0xf002) === 0x1000) { this.port1ffd = v; }
    super.ioWrite(port, v);
  }

  // the 128K's paging, through the MMU: the bank (with $DFFD's extra bits) at $C000
  write7ffd(v, force = false) {
    if (this.pagingLocked && !force) return;
    this.port7ffd = v;
    if (v & 0x20) this.pagingLocked = true;
    const bank = (v & 7) | ((this.portDffd & 0x0f) << 3);
    this.mmu[6] = bank * 2;
    this.mmu[7] = bank * 2 + 1;
    this.nr[0x56] = this.mmu[6];
    this.nr[0x57] = this.mmu[7];
    this.updateSlots();
  }

  // a Next register written (at T-state t: the copper's writes come at its own time)
  nextRegWrite(r, v, t = this.cpu.t) {
    const vid = this.video, ints = this.ints, nr = this.nr;
    vid.catchUp(t, true); // the picture so far, to the beam, with the registers as they were
    // registers that aren't simply stored
    switch (r) {
      case 0x05: nr[r] = v; this.updateJoysticks(); return;
      case 0x06: case 0x09: nr[r] = v; this.updateSound(); return;
      case 0x20: { // makes interrupts happen now, whatever their enables
        const now = this.tBase + this.cpu.t;
        if (v & 0x80) ints.fire(INT_LINE, now, true);
        if (v & 0x40) ints.fire(INT_ULA, now, true);
        for (let c = 0; c < 4; c++) if (v & (1 << c)) ints.fire(INT_CTC + c, now, true);
        return;
      }
      case 0x22:
        nr[0x22] = (nr[0x22] & ~1) | (v & 1);
        this.setUlaInt(!(v & 4));
        this.setLineInt(v & 2);
        return;
      case 0x23: case 0x64: nr[r] = v; this.scheduleLine(); return;
      case 0x2c: case 0x2d: case 0x2e: // the DACs: $2C B (left), $2D A and D, $2E C (right)
        if (nr[0x08] & 8) for (const c of r === 0x2c ? [1] : r === 0x2d ? [0, 3] : [2]) this.psg.setDac(t, c, v);
        return;
      case 0x60: this.copper.write(v); return;
      case 0x61: this.copper.setAddrLow(v); return;
      case 0x62: this.copper.control(v, this.ticks); return;
      case 0x63: this.copper.write16(v); return;
      case 0xc0: nr[r] = v & 0xe9; return;
      case 0xc4:
        nr[0xc4] = (nr[0xc4] & 0x7c) | (v & 0x83);
        this.setUlaInt(v & 1);
        this.setLineInt(v & 2);
        return;
      case 0xc5: this.ctc.setEnables(v); return;
      case 0xc8: case 0xc9: ints.clearStatus(r, v); return;
      case 0xcc: nr[r] = v; ints.dmaInt[INT_ULA] = v & 1; ints.dmaInt[INT_LINE] = (v >> 1) & 1; return;
      case 0xcd: nr[r] = v; for (let c = 0; c < 4; c++) ints.dmaInt[INT_CTC + c] = (v >> c) & 1; return;
      case 0x18: case 0x19: case 0x1a: case 0x1b: vid.clipWrite(r - 0x18, v); return;
      case 0x1c: vid.clipReset(v); return;
      case 0x34: vid.sprNum = v & 0x7f; break;
      case 0x35: case 0x36: case 0x37: case 0x38: case 0x39: vid.sprAttr[vid.sprNum * 5 + r - 0x35] = v; break;
      case 0x75: case 0x76: case 0x77: case 0x78: case 0x79:
        vid.sprAttr[vid.sprNum * 5 + r - 0x75] = v;
        vid.sprNum = (vid.sprNum + 1) & 0x7f;
        break;
      case 0x40: vid.palIndex = v; vid.pal44Second = false; break;
      case 0x41: vid.palWrite8(v); return;
      case 0x43: vid.pal44Second = false; break;
      case 0x44: vid.palWrite9(v); return;
      case 0x69: // Layer 2 on, the shadow screen, and port $FF
        this.l2Port = (this.l2Port & ~2) | (v & 0x80 ? 2 : 0);
        this.port7ffd = (this.port7ffd & ~8) | (v & 0x40 ? 8 : 0);
        this.portFF = (this.portFF & 0xc0) | (v & 0x3f);
        this.updateSlots();
        return;
      default:
    }
    this.nr[r] = v;
    if (r === 0x12 || r === 0x13) this.updateL2Map();
    if (r >= 0x50 && r <= 0x57) {
      this.mmu[r - 0x50] = v;
      this.updateSlots();
    } else if (r === 0x07) {
      this.setSpeed(v);
    } else if (r === 0x03) {
      if (v & 0x70) this.updateTiming();
    } else if (r === 0x08) {
      if (v & 0x80) this.pagingLocked = false; // unlocks the 128K's paging
      this.updateContention(); // bit 6: contention off
      this.updateSound(); // TurboSound, ABC/ACB, the DACs
    } else if (r === 0x02) {
      if (v & 3) this.hardReset();
    }
  }

  nextRegRead(r) {
    switch (r) {
      case 0x00: return 10; // the machine: a Next
      case 0x01: return 0x32; // core 3.2
      case 0x0e: return 0x01; // .1
      case 0x07: return (this.speed << 4) | this.speed;
      case 0x18: case 0x19: case 0x1a: case 0x1b: return this.video.clipRead(r - 0x18);
      case 0x1c: return this.video.clipIndexes();
      case 0x34: return this.video.sprNum;
      case 0x1e: return this.rasterLine() >> 8;
      case 0x1f: return this.rasterLine() & 0xff;
      case 0x20: {
        const s = this.ints.status;
        return (s[INT_LINE] << 7) | (s[INT_ULA] << 6) | s[INT_CTC] | (s[INT_CTC + 1] << 1) | (s[INT_CTC + 2] << 2) | (s[INT_CTC + 3] << 3);
      }
      case 0x22: return (this.ints.pulsing ? 0x80 : 0) | (this.nr[0x22] & 7);
      case 0x61: return this.copper.addr & 0xff;
      case 0x62: return this.copper.controlByte();
      case 0xb2: { // the MD pads' X, Z, Y, MODE: joystick 2 high, joystick 1 low
        const x = (b) => (b & PAD.X ? 8 : 0) | (b & PAD.Z ? 4 : 0) | (b & PAD.Y ? 2 : 0) | (b & PAD.MODE ? 1 : 0);
        return (this.mdPad[1] ? x(this.joy[1]) << 4 : 0) | (this.mdPad[0] ? x(this.joy[0]) : 0);
      }
      case 0xc0: return (this.nr[0xc0] & 0xe9) | ((this.cpu.im & 3) << 1);
      case 0xc4: return (this.nr[0xc4] & 0x80) | (this.ints.enabled[INT_LINE] << 1) | this.ints.enabled[INT_ULA];
      case 0xc5: { let v = 0; for (let c = 0; c < 4; c++) v |= this.ints.enabled[INT_CTC + c] << c; return v; }
      case 0xc8: case 0xc9: return this.ints.statusByte(r);
      case 0x40: return this.video.palIndex;
      case 0x41: return this.video.palRead8();
      case 0x44: return this.video.palRead9();
      case 0x4c: return this.nr[0x4c] & 15;
      case 0x69: return (this.l2Port & 2 ? 0x80 : 0) | (this.port7ffd & 8 ? 0x40 : 0) | (this.portFF & 0x3f);
      default:
        if (r >= 0x50 && r <= 0x57) return this.mmu[r - 0x50];
        return this.nr[r];
    }
  }

  // ---------------------------------------------------------------- traps
  onTrapAt(pc) {
    if (pc === 0x0008 && this.mmu[0] === 0xff) return this.esxCall();
    return super.onTrapAt(pc);
  }

  // ---------------------------------------------------------------- .nex programs
  // Loads a .nex (wiki.specnext.dev "NEX file format", V1.0-V1.2) straight into memory and
  // starts it, as NextZXOS's loader does. Returns { pc, sp, banks }.
  loadNex(bytes, name = 'program.nex') {
    const b = bytes;
    const text = (o, n) => String.fromCharCode(...b.subarray(o, o + n));
    if (text(0, 4) !== 'Next') throw new Error('Not a .nex file');
    if (b[8] === 1 && this.info.ram < 1792) throw new Error('This .nex needs a 2 MB Next');
    this.hardReset();
    const u16 = (o) => b[o] | (b[o + 1] << 8);
    const flags = b[10];
    let off = 512;
    // a palette comes with a Layer 2 or LoRes screen, unless flag bit 7 says there is none
    this.nexPalette = null;
    if (!(flags & 0x80) && flags & 0x05) { this.nexPalette = b.slice(off, off + 512); off += 512; }
    if (flags & 0x01) { this.mem.set(b.subarray(off, off + 49152), this.nr[0x12] * 0x4000); off += 49152; }
    if (flags & 0x02) { this.banks[5].set(b.subarray(off, off + 6912)); off += 6912; }
    if (flags & 0x04) { this.nexLoRes = b.slice(off, off + 12288); off += 12288; }
    if (flags & 0x08) off += 12288; // Timex hi-res
    if (flags & 0x10) off += 12288; // Timex hi-colour
    const loaded = [];
    for (const bank of NEX_BANK_ORDER) {
      if (!b[18 + bank]) continue;
      if (bank * 0x4000 >= this.mem.length) throw new Error(`The .nex has bank ${bank}, beyond this Next's memory`);
      this.mem.set(b.subarray(off, off + 0x4000), bank * 0x4000);
      off += 0x4000;
      loaded.push(bank);
    }
    this.border = b[11] & 7;
    this.video.border = this.border;
    const entry = b[139];
    this.port7ffd = entry & 7;
    this.portDffd = entry >> 3;
    this.mmu[6] = entry * 2;
    this.mmu[7] = entry * 2 + 1;
    this.updateSlots();
    const cpu = this.cpu;
    cpu.sp = u16(12);
    cpu.pc = u16(14);
    cpu.iff1 = cpu.iff2 = 0;
    cpu.im = 1;
    cpu.halted = 0;
    // the file handle a program can read more of its .nex through
    const fh = u16(140);
    if (fh) {
      const path = '/' + name.replace(/^.*[\\/]/, '');
      if (!this.sd.exists(path)) this.sd.put(path, b);
      const h = this.openHandle({ path, data: b.slice(), len: b.length, pos: off, write: false });
      if (fh < 0x4000) cpu.bc = h;
      else this.write(fh, h);
    }
    this.ready = true;
    this.readyHandlers = [];
    return { pc: cpu.pc, sp: cpu.sp, banks: loaded };
  }

  // ---------------------------------------------------------------- esxDOS
  closeAll() {
    if (!this.handles) return;
    for (const h of this.handles.values()) this.flush(h);
    this.handles.clear();
  }

  openHandle(h) {
    let n = 1;
    while (this.handles.has(n)) n++;
    if (n > 255) return -1;
    this.handles.set(n, h);
    return n;
  }

  flush(h) {
    if (h.dirty && !h.dir) {
      const data = h.data.slice(0, h.len);
      this.sd.put(h.path, data);
      this.sd.changed(h.path, data);
      h.dirty = false;
    }
  }

  // a zero-terminated string from memory
  cString(addr) {
    let s = '';
    for (let i = 0; i < 512; i++) {
      const c = this.read((addr + i) & 0xffff);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  putBytes(addr, bytes) {
    for (let i = 0; i < bytes.length; i++) this.write((addr + i) & 0xffff, bytes[i]);
  }

  // RST $08 / DEFB code: the call runs at once; the program carries on after the code byte
  esxCall() {
    const cpu = this.cpu;
    const ret = cpu.pop();
    const fn = this.read(ret);
    cpu.pc = (ret + 1) & 0xffff;
    cpu.t += 40;
    const ok = () => { cpu.f &= ~1; };
    const fail = (code) => { cpu.f |= 1; cpu.a = code; };
    const handle = () => this.handles.get(cpu.a);
    const bcde = () => ((cpu.b << 24) | (cpu.c << 16) | (cpu.d << 8) | cpu.e) >>> 0;
    const setBcde = (v) => { cpu.bc = (v >>> 16) & 0xffff; cpu.de = v & 0xffff; };
    const sd = this.sd;
    const path = (addr) => sd.resolve(this.cwd, this.cString(addr));
    switch (fn) {
      case 0x88: // M_DOSVERSION: NextZXOS 2.07, in NextZXOS mode
        cpu.bc = 0x4e58; cpu.de = 0x0207; cpu.hl = 0x6e65; cpu.a = 0; cpu.f = (cpu.f & ~1) | 0x40;
        return true;
      case 0x89: // M_GETSETDRV: always C:
        cpu.a = 2 << 3; ok();
        return true;
      case 0x93: { // M_GETERR
        if (cpu.b === 1) {
          const msg = cpu.a ? ESX_MESSAGES[cpu.a] || 'Unknown error' : this.cString(cpu.ix);
          const out = Array.from(msg.slice(0, 31), (ch) => ch.charCodeAt(0) & 0x7f);
          out[out.length - 1] |= 0x80;
          this.putBytes(cpu.de, out);
          ok();
        } else fail(ESX.ENOCMD);
        return true;
      }
      case 0x9a: { // F_OPEN
        const p = path(cpu.ix), mode = cpu.b, create = mode & 0x0c;
        if (sd.isDir(p) && !sd.exists(p)) { fail(ESX.EISDIR); return true; }
        let data = sd.get(p);
        if (!data) {
          if (create === 0x00) { fail(ESX.ENOENT); return true; }
          data = new Uint8Array(0);
        } else if (create === 0x04) { fail(ESX.EEXIST); return true; }
        else if (create === 0x0c) data = new Uint8Array(0);
        const h = { path: p, data: data.slice(), len: data.length, pos: 0, write: (mode & 2) !== 0, dirty: !sd.exists(p) || create === 0x0c };
        if (mode & 0x40) this.putBytes(cpu.de, [0xff, 0, 0, 0, 0, 0, 0, 0]);
        const n = this.openHandle(h);
        if (n < 0) { fail(ESX.ENFILE); return true; }
        if (h.dirty) this.flush(h);
        cpu.a = n; ok();
        return true;
      }
      case 0x9b: { // F_CLOSE
        const h = handle();
        if (!h) { fail(ESX.EBADF); return true; }
        this.flush(h);
        this.handles.delete(cpu.a);
        cpu.a = 0; ok();
        return true;
      }
      case 0x9c: { const h = handle(); if (!h) fail(ESX.EBADF); else { this.flush(h); ok(); } return true; } // F_SYNC
      case 0x9d: { // F_READ
        const h = handle();
        if (!h || h.dir) { fail(ESX.EBADF); return true; }
        const n = Math.max(0, Math.min(cpu.bc, h.len - h.pos));
        this.putBytes(cpu.ix, h.data.subarray(h.pos, h.pos + n));
        h.pos += n;
        cpu.t += n; // about a byte a T-state
        cpu.bc = n; cpu.de = n; cpu.hl = (cpu.ix + n) & 0xffff;
        ok();
        return true;
      }
      case 0x9e: { // F_WRITE
        const h = handle();
        if (!h || h.dir || !h.write) { fail(ESX.EBADF); return true; }
        const n = cpu.bc;
        this.grow(h, h.pos + n);
        for (let i = 0; i < n; i++) h.data[h.pos + i] = this.read((cpu.ix + i) & 0xffff);
        h.pos += n;
        h.len = Math.max(h.len, h.pos);
        h.dirty = true;
        cpu.t += n;
        cpu.bc = n;
        ok();
        return true;
      }
      case 0x9f: { // F_SEEK: IXL is the mode (0 from the start, 1 forward, 2 back)
        const h = handle();
        if (!h || h.dir) { fail(ESX.EBADF); return true; }
        const n = bcde(), mode = cpu.ix & 0xff;
        let pos = mode === 1 ? h.pos + n : mode === 2 ? h.pos - n : n;
        pos = Math.max(0, Math.min(pos, h.len));
        h.pos = pos;
        setBcde(pos);
        ok();
        return true;
      }
      case 0xa0: { const h = handle(); if (!h || h.dir) fail(ESX.EBADF); else { setBcde(h.pos); ok(); } return true; } // F_FGETPOS
      case 0xa1: { // F_FSTAT
        const h = handle();
        if (!h || h.dir) { fail(ESX.EBADF); return true; }
        this.putBytes(cpu.ix, statBytes(h.len));
        ok();
        return true;
      }
      case 0xa2: { // F_FTRUNCATE
        const h = handle();
        if (!h || h.dir) { fail(ESX.EBADF); return true; }
        const n = bcde();
        this.grow(h, n);
        if (n > h.len) h.data.fill(0, h.len, n);
        h.len = n;
        h.dirty = true;
        ok();
        return true;
      }
      case 0xa3: { // F_OPENDIR
        const p = path(cpu.ix);
        if (!sd.isDir(p)) { fail(sd.exists(p) ? ESX.ENOTDIR : ESX.ENOENT); return true; }
        const wild = cpu.b & 0x20 ? wildcard(this.cString(cpu.de)) : null;
        const entries = sd.list(p).filter((e) => !wild || wild.test(e.name));
        const n = this.openHandle({ dir: true, path: p, entries, pos: 0, mode: cpu.b });
        if (n < 0) { fail(ESX.ENFILE); return true; }
        cpu.a = n; cpu.c = 1; ok();
        return true;
      }
      case 0xa4: { // F_READDIR: attributes, name, time, date, size
        const h = handle();
        if (!h || !h.dir) { fail(ESX.EBADF); return true; }
        const e = h.entries[h.pos];
        if (!e) { cpu.a = 0; ok(); return true; }
        h.pos++;
        const short = (h.mode & 0x18) === 0;
        const name = short ? shortName(e.name) : e.name;
        const out = [e.dir ? 0x10 : 0x20, ...Array.from(name, (ch) => ch.charCodeAt(0) & 0xff), 0, 0, 0, 0, 0];
        if ((h.mode & 0x18) === 0x18) out.splice(1 + name.length + 1, 0, ...Array.from(shortName(e.name), (ch) => ch.charCodeAt(0)), 0);
        const size = e.size;
        out.push(size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >>> 24) & 0xff);
        if (h.mode & 0x40) out.push(0xff, 0, 0, 0, 0, 0, 0, 0);
        this.putBytes(cpu.ix, out);
        cpu.a = 1; ok();
        return true;
      }
      case 0xa5: { const h = handle(); if (!h || !h.dir) fail(ESX.EBADF); else { setBcde(h.pos); ok(); } return true; } // F_TELLDIR
      case 0xa6: { const h = handle(); if (!h || !h.dir) fail(ESX.EBADF); else { h.pos = bcde(); ok(); } return true; } // F_SEEKDIR
      case 0xa7: { const h = handle(); if (!h || !h.dir) fail(ESX.EBADF); else { h.pos = 0; ok(); } return true; } // F_REWINDDIR
      case 0xa8: { // F_GETCWD
        const dir = cpu.a === 0xff ? sd.resolve(this.cwd, this.cString(cpu.de).replace(/[^/\\:]*$/, '') || '.') : this.cwd;
        this.putBytes(cpu.ix, [...Array.from(dir, (ch) => ch.charCodeAt(0)), 0]);
        ok();
        return true;
      }
      case 0xa9: { // F_CHDIR
        const p = path(cpu.ix);
        if (!sd.isDir(p)) { fail(sd.exists(p) ? ESX.ENOTDIR : ESX.ENOENT); return true; }
        this.cwd = p;
        ok();
        return true;
      }
      case 0xaa: { const p = path(cpu.ix); if (sd.isDir(p) || sd.exists(p)) fail(ESX.EEXIST); else { sd.mkdir(p); ok(); } return true; } // F_MKDIR
      case 0xab: { // F_RMDIR
        const p = path(cpu.ix);
        if (!sd.isDir(p)) fail(ESX.ENOENT);
        else if (sd.list(p).length) fail(27);
        else { sd.dirs.delete(p.toUpperCase()); ok(); }
        return true;
      }
      case 0xac: { // F_STAT
        const p = path(cpu.ix), data = sd.get(p);
        if (!data && !sd.isDir(p)) { fail(ESX.ENOENT); return true; }
        const st = statBytes(data ? data.length : 0);
        if (!data) st[2] = 0x10;
        this.putBytes(cpu.de, st);
        ok();
        return true;
      }
      case 0xad: { const p = path(cpu.ix); if (sd.remove(p)) ok(); else fail(ESX.ENOENT); return true; } // F_UNLINK
      case 0xae: { // F_TRUNCATE
        const p = path(cpu.ix), data = sd.get(p);
        if (!data) { fail(ESX.ENOENT); return true; }
        const out = new Uint8Array(bcde());
        out.set(data.subarray(0, out.length));
        sd.put(p, out);
        sd.changed(p, out);
        ok();
        return true;
      }
      case 0xb0: { // F_RENAME
        const from = path(cpu.ix), to = path(cpu.de), data = sd.get(from);
        if (!data) { fail(ESX.ENOENT); return true; }
        if (sd.exists(to)) { fail(ESX.EEXIST); return true; }
        sd.remove(from);
        sd.put(to, data);
        sd.changed(to, data);
        ok();
        return true;
      }
      default:
        fail(ESX.ENOCMD);
        return true;
    }
  }

  grow(h, n) {
    if (n <= h.data.length) return;
    const d = new Uint8Array(Math.max(n, h.data.length * 2, 256));
    d.set(h.data.subarray(0, h.len));
    h.data = d;
  }

  // ---------------------------------------------------------------- save states
  saveState() {
    const s = super.saveState();
    s.banks = []; // all of it is in s.next.mem
    s.next = {
      mem: this.mem.slice(), nr: this.nr.slice(), mmu: this.mmu.slice(), portDffd: this.portDffd,
      regSelect: this.regSelect, speed: this.speed, tRem: this.cpu.tRem, cwd: this.cwd,
      l2Port: this.l2Port, l2Off: this.l2Off, portFF: this.portFF, video: this.video.saveNext(),
      ints: this.ints.saveState(), copper: this.copper.saveState(), ctc: this.ctc.saveState(), dma: this.dma.saveState(),
      mouse: { ...this.mouse },
    };
    return s;
  }

  loadState(s) {
    const n = s.next;
    if (!n) throw new Error('Incompatible save state');
    this.mem.set(n.mem);
    this.nr.set(n.nr);
    this.mmu = n.mmu.slice();
    this.portDffd = n.portDffd;
    this.regSelect = n.regSelect;
    this.cwd = n.cwd || '/';
    this.l2Port = n.l2Port || 0;
    this.l2Off = n.l2Off || 0;
    this.portFF = n.portFF || 0;
    if (n.video) this.video.loadNext(n.video);
    if (n.ints) { this.ints.loadState(n.ints); this.copper.loadState(n.copper); this.ctc.loadState(n.ctc); this.dma.loadState(n.dma); }
    if (n.mouse) this.mouse = { ...n.mouse };
    super.loadState({ ...s, banks: [] });
    this.updateL2Map();
    this.updateTiming();
    this.setSpeed(n.speed);
    this.cpu.tRem = n.tRem || 0;
    this.cpu.z80n = true;
    this.updateSound();
    this.updateJoysticks();
    this.scheduleLine(this.tBase + this.cpu.t);
  }
}

// F_STAT and F_FSTAT's 11 bytes: '*', $81, attributes, time, date, size
function statBytes(size) {
  return [0x2a, 0x81, 0x20, 0, 0, 0x21, 0, size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >>> 24) & 0xff];
}

// an 8.3 name, as F_READDIR gives in its short mode
function shortName(name) {
  const up = name.toUpperCase().replace(/[^A-Z0-9._~!#$%&'()@^`{}-]/g, '_');
  const dot = up.lastIndexOf('.');
  const base = (dot > 0 ? up.slice(0, dot) : up).replace(/\./g, '').slice(0, 8);
  const ext = dot > 0 ? up.slice(dot + 1, dot + 4) : '';
  return ext ? `${base}.${ext}` : base;
}

function wildcard(w) {
  const re = w.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${re}$`, 'i');
}
