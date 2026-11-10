// The ZX Spectrum for ZXEmu, written for it in 2026. GPL v2 or later, see LICENSE.
//
// The 48K, 128K, +2, +2A and +3 (and the 16K): memory and its paging, the ULA's contention,
// picture, keyboard, beeper and tape input, the AY on the 128K models, joystick interfaces
// (Kempston, cursor, Sinclair 1 and 2, Fuller), Interface 2 cartridges, the +3's disk drive,
// snapshots and save states. Usable in Node with no page: tests and Hewco BASIC run it there.

import { Z80 } from './z80.js';
import { Video, FB_WIDTH, FB_HEIGHT, standardColours } from './video.js';
import { Sound } from './sound.js';
import { Tape } from './tape.js';
import { ZX_KEYS, CHAR_TO_KEYS, keysOf } from './keys.js';
import { loadSnapshot, snapshotModel } from './snapshot.js';
import { Fdc } from './fdc.js';
import { DskImage } from './dsk.js';

export { FB_WIDTH, FB_HEIGHT };

const STATE_VERSION = 1;

// frame timings: T-states a frame and a line, the first T-state of the paper, where the
// contention starts and its pattern of delays (per 8 T-states), how long /INT is held, the
// CPU clock, where the floating bus shows the screen bytes, and the kind of contention
const T48 = { frame: 69888, line: 224, paper: 14336, contStart: 14335, pattern: [6, 5, 4, 3, 2, 1, 0, 0], intLen: 32, clock: 3500000, floatAt: 14338, floating: true, noMreq: true, io: true };
const T128 = { frame: 70908, line: 228, paper: 14364, contStart: 14361, pattern: [6, 5, 4, 3, 2, 1, 0, 0], intLen: 36, clock: 3546900, floatAt: 14365, floating: true, noMreq: true, io: true };
const TP3 = { frame: 70908, line: 228, paper: 14364, contStart: 14365, pattern: [1, 0, 7, 6, 5, 4, 3, 2], intLen: 32, clock: 3546900, floatAt: 0, floating: false, noMreq: false, io: false };

export const MODELS = {
  '16k': { name: 'ZX Spectrum 16K', rom: 'rom48', ram: 16, timing: T48, paging: '48', ay: false },
  '48k': { name: 'ZX Spectrum 48K', rom: 'rom48', ram: 48, timing: T48, paging: '48', ay: false },
  '128k': { name: 'ZX Spectrum 128K', rom: 'rom128', ram: 128, timing: T128, paging: '128', ay: true },
  plus2: { name: 'ZX Spectrum +2', rom: 'plus2', ram: 128, timing: T128, paging: '128', ay: true },
  plus2a: { name: 'ZX Spectrum +2A', rom: 'plus3', ram: 128, timing: TP3, paging: 'plus3', ay: true, fdc: false },
  plus3: { name: 'ZX Spectrum +3', rom: 'plus3', ram: 128, timing: TP3, paging: 'plus3', ay: true, fdc: true },
};

export const ROM_FILES = { rom48: '48.rom', rom128: '128.rom', plus2: 'plus2.rom', plus3: 'plus3.rom' };

export function resolveModel(model) {
  const k = String(model || '48k').toLowerCase().replace(/\s|zx|spectrum|_|-/g, '').replace(/\+/g, 'plus');
  const key = { 16: '16k', 48: '48k', 128: '128k', '128kplus2': 'plus2', plus2a: 'plus2a', plus3: 'plus3', plus2: 'plus2' }[k] || k;
  if (MODELS[key]) return key;
  throw new Error('Unknown Spectrum model: ' + model);
}

export function romsFor(model) {
  return [MODELS[resolveModel(model)].rom];
}

// the model a file wants: a 128K snapshot needs a 128K, a +3 disk a +3
export function autoModel({ snapshot = null, disk = false } = {}) {
  if (disk) return 'plus3';
  return (snapshot && snapshotModel(snapshot)) || '48k';
}

const JOY_UP = 1, JOY_DOWN = 2, JOY_LEFT = 4, JOY_RIGHT = 8, JOY_FIRE = 16, JOY_FIRE2 = 32;
export const JOY = { UP: JOY_UP, DOWN: JOY_DOWN, LEFT: JOY_LEFT, RIGHT: JOY_RIGHT, FIRE: JOY_FIRE, FIRE2: JOY_FIRE2 };
export const JOYSTICK_TYPES = ['kempston', 'cursor', 'sinclair1', 'sinclair2', 'fuller', 'none'];

// the keys each keyboard joystick presses: up, down, left, right, fire
const JOY_KEYS = {
  cursor: ['7', '6', '5', '8', '0'],
  sinclair1: ['9', '8', '6', '7', '0'],
  sinclair2: ['4', '3', '1', '2', '5'],
};

const PLUS3_SPECIAL = [[0, 1, 2, 3], [4, 5, 6, 7], [4, 5, 6, 3], [4, 7, 6, 3]];

// LD-BYTES and SA-BYTES in the 48K BASIC ROM, with the bytes there to make sure of it
const LD_BYTES = 0x0556, SA_BYTES = 0x04c2, LD_RET = 0x053f;
const LD_SIG = [0x14, 0x08, 0x15, 0xf3];

// frames to give the ROM to reach its prompt before the machine counts as ready
const READY_FRAMES = { '16k': 60, '48k': 110, '128k': 90, plus2: 90, plus2a: 170, plus3: 170 };

export class Spectrum {
  constructor({ roms, model = '48k', sampleRate = 48000, joystick = 'kempston', joystick2 = 'none', flashLoad = true, cartridge = null, issue = 3 } = {}) {
    this.model = resolveModel(model);
    const info = MODELS[this.model];
    this.info = info;
    this.timing = info.timing;
    this.roms = roms;
    this.flashLoad = flashLoad;
    this.issue = issue;
    this.sampleRate = sampleRate;

    const rom = (roms && roms[info.rom]) || null;
    if (!rom && !cartridge) throw new Error(`The ${info.name} ROM is missing`);
    this.romPages = [];
    if (cartridge) this.romPages.push(cartridgePage(cartridge));
    else for (let o = 0; o < rom.length; o += 0x4000) this.romPages.push(rom.slice(o, o + 0x4000));
    this.cartridge = cartridge ? cartridge.slice() : null;
    this.basicRom = this.romPages.length - 1; // the 48K BASIC ROM is the last
    this.banks = [];
    for (let i = 0; i < 8; i++) this.banks.push(new Uint8Array(0x4000));
    this.nothing = new Uint8Array(0x4000).fill(0xff); // the 16K's missing RAM
    this.pages = [null, null, null, null];
    this.pageBank = new Int8Array(4); // the RAM bank in each page, -1 for ROM
    this.readOnly = new Uint8Array(4);

    this.cpu = new Z80(this);
    this.video = new Video(this);
    this.psg = new Sound({ sampleRate, clock: this.timing.clock, ay: info.ay });
    this.tape = new Tape();
    this.tape.is48 = info.paging === '48';
    this.tape.scale = this.timing.clock / 3500000;
    this.fdc = info.fdc ? new Fdc() : null;
    this.disks = [null, null];

    this.keyCount = new Uint8Array(64);
    this.matrix = new Uint8Array(8); // bits held in each half-row
    this.typedMatrix = new Uint8Array(8);
    this.joyTypes = [joystick, joystick2];
    this.joy = [0, 0];
    this.typeQueue = [];
    this.typeHold = 0;
    this.typeGap = 0;
    this.readyHandlers = [];
    this.ready = false;

    this.setupTiming();
    this.hardReset();
  }

  setupTiming() {
    const t = this.timing, cpu = this.cpu;
    const ctab = new Uint8Array(t.frame + 1000);
    for (let line = 0; line < 192; line++) {
      const start = t.contStart + line * t.line;
      for (let x = 0; x < 128; x++) ctab[start + x] = t.pattern[x & 7];
    }
    cpu.ctab = ctab;
    cpu.frameLen = t.frame;
    cpu.intLen = t.intLen;
    cpu.noMreqContended = t.noMreq;
    cpu.ioContended = t.io;
    this.video.setTiming(t);
    this.frameLen = t.frame;
  }

  // ---------------------------------------------------------------- memory
  updatePaging() {
    const p = this.port7ffd, info = this.info;
    let banks, rom;
    if (info.paging === '48') {
      banks = [-1, 5, 2, 0];
      rom = 0;
    } else if (info.paging === 'plus3' && (this.port1ffd & 1)) {
      banks = PLUS3_SPECIAL[(this.port1ffd >> 1) & 3];
      rom = -1;
    } else {
      banks = [-1, 5, 2, p & 7];
      rom = info.paging === 'plus3' ? ((this.port1ffd >> 1) & 2) | ((p >> 4) & 1) : (p >> 4) & 1;
    }
    this.romIndex = rom;
    const contended = info.paging === 'plus3' ? (b) => b >= 4 : info.paging === '128' ? (b) => (b & 1) === 1 : (b) => b === 5;
    for (let i = 0; i < 4; i++) {
      const b = banks[i];
      this.pageBank[i] = b;
      if (b < 0) {
        this.pages[i] = this.romPages[Math.min(rom, this.romPages.length - 1)];
        this.readOnly[i] = 1;
        this.cpu.cpage[i] = 0;
      } else if (this.model === '16k' && i > 1) {
        this.pages[i] = this.nothing;
        this.readOnly[i] = 1;
        this.cpu.cpage[i] = 0;
      } else {
        this.pages[i] = this.banks[b];
        this.readOnly[i] = 0;
        this.cpu.cpage[i] = contended(b) ? 1 : 0;
      }
    }
    const screen = info.paging !== '48' && (p & 8) ? 7 : 5;
    if (screen !== this.screenBank) {
      this.video.catchUp(this.cpu.t);
      this.screenBank = screen;
      this.screenMem = this.banks[screen];
    }
  }

  read(addr) {
    return this.pages[addr >> 14][addr & 0x3fff];
  }

  write(addr, v) {
    const p = addr >> 14;
    if (this.readOnly[p]) return;
    const off = addr & 0x3fff;
    if (off < 0x1b00 && this.pageBank[p] === this.screenBank) this.video.catchUp(this.cpu.t);
    this.pages[p][off] = v;
  }

  peek(addr) { return this.read(addr & 0xffff); }

  poke(addr, v) {
    const p = (addr >> 14) & 3;
    if (this.readOnly[p]) return;
    this.pages[p][addr & 0x3fff] = v & 0xff;
  }

  // the whole 128K (or 48K) of RAM in bank order
  get ram() {
    return this.banks;
  }

  // ---------------------------------------------------------------- I/O
  intVector() { return 0xff; }

  ioRead(port) {
    const t = this.cpu.t;
    let v = 0xff, claimed = false;
    if (!(port & 1)) {
      // the ULA: keyboard, EAR
      claimed = true;
      const hi = port >> 8;
      let bits = 0;
      for (let r = 0; r < 8; r++) if (!(hi & (1 << r))) bits |= this.matrix[r] | this.typedMatrix[r] | this.joyKeyRow(r);
      this.detectLoader(t);
      let ear;
      if (this.tape.playing) {
        this.updateTape(t);
        ear = this.tape.level;
      } else {
        ear = this.issue === 2 ? this.earOut | this.micOut : this.earOut;
      }
      v = (~bits & 0x1f) | 0xa0 | (ear ? 0x40 : 0);
    }
    for (let j = 0; j < 2; j++) {
      const type = this.joyTypes[j];
      if (type === 'kempston' && (port & 0xe0) === 0) {
        claimed = true;
        const b = this.joy[j];
        v &= (b & JOY_RIGHT ? 1 : 0) | (b & JOY_LEFT ? 2 : 0) | (b & JOY_DOWN ? 4 : 0) | (b & JOY_UP ? 8 : 0) | (b & JOY_FIRE ? 16 : 0) | (b & JOY_FIRE2 ? 32 : 0);
      } else if (type === 'fuller' && (port & 0xff) === 0x7f) {
        claimed = true;
        const b = this.joy[j];
        v &= ~((b & JOY_UP ? 1 : 0) | (b & JOY_DOWN ? 2 : 0) | (b & JOY_LEFT ? 4 : 0) | (b & JOY_RIGHT ? 8 : 0) | (b & JOY_FIRE ? 0x80 : 0)) & 0xff;
      }
    }
    const info = this.info;
    if (info.ay && (port & 0xc002) === 0xc000) { claimed = true; v &= this.psg.readReg(); }
    if (this.fdc && (port & 0xf002) === 0x2000) { claimed = true; v = this.fdc.readStatus(); }
    if (this.fdc && (port & 0xf002) === 0x3000) { claimed = true; v = this.fdc.readData(); }
    if (!claimed) v = this.floatingBus(t);
    return v;
  }

  ioWrite(port, v) {
    const t = this.cpu.t;
    const info = this.info;
    if (!(port & 1)) {
      this.video.setBorder(t, v & 7);
      this.border = v & 7;
      this.updateTape(t);
      this.earOut = (v >> 4) & 1;
      this.micOut = (v >> 3) & 1;
      this.updateBeeper(t);
    }
    if (info.paging === '128' && (port & 0x8002) === 0) this.write7ffd(v);
    if (info.paging === 'plus3') {
      if ((port & 0xc002) === 0x4000) this.write7ffd(v);
      else if ((port & 0xf002) === 0x1000) this.write1ffd(v);
      else if (this.fdc && (port & 0xf002) === 0x3000) this.fdc.writeData(v);
    }
    if (info.ay) {
      if ((port & 0xc002) === 0xc000) this.psg.selectReg(v);
      else if ((port & 0xc002) === 0x8000) this.psg.writeReg(t, v);
    }
  }

  write7ffd(v) {
    if (this.pagingLocked) return;
    this.port7ffd = v;
    if (v & 0x20) this.pagingLocked = true;
    this.updatePaging();
  }

  write1ffd(v) {
    if (this.pagingLocked) return;
    this.port1ffd = v;
    if (this.fdc) this.fdc.setMotor((v >> 3) & 1);
    this.updatePaging();
  }

  // an IN nothing answers: on the 48K and 128K, the byte the ULA is fetching for the screen
  floatingBus(t) {
    const tm = this.timing;
    if (!tm.floating) return 0xff;
    const rel = t - tm.floatAt;
    if (rel < 0) return 0xff;
    const line = (rel / tm.line) | 0;
    if (line >= 192) return 0xff;
    const x = rel - line * tm.line;
    if (x >= 128) return 0xff;
    const col = (x >> 3) << 1;
    const scr = this.screenMem;
    const bitmap = ((line & 0xc0) << 5) | ((line & 7) << 8) | ((line & 0x38) << 2);
    const attr = 0x1800 + ((line >> 3) << 5);
    switch (x & 7) {
      case 0: return scr[bitmap + col];
      case 1: return scr[attr + col];
      case 2: return scr[bitmap + col + 1];
      case 3: return scr[attr + col + 1];
      default: return 0xff;
    }
  }

  // keys a keyboard joystick (cursor, Sinclair) holds in half-row r
  joyKeyRow(r) {
    let bits = 0;
    for (let j = 0; j < 2; j++) {
      const keys = JOY_KEYS[this.joyTypes[j]];
      const b = this.joy[j];
      if (!keys || !b) continue;
      for (let k = 0; k < 5; k++) {
        if (!(b & (1 << k))) continue;
        const code = ZX_KEYS[keys[k]];
        if (code >> 3 === r) bits |= 1 << (code & 7);
      }
    }
    return bits;
  }

  updateBeeper(t) {
    const tapeSound = this.tape.playing && this.tape.level ? 0.08 : 0;
    this.psg.setBeeper(t, this.earOut * 0.75 + this.micOut * 0.08 + tapeSound);
  }

  // the tape up to T-state t of this frame, its edges heard through the beeper
  updateTape(t) {
    const tape = this.tape;
    if (!tape.playing) return;
    const base = this.tBase;
    tape.advanceTo(base + t, (at, level) => {
      const ft = Math.max(0, at - base);
      this.psg.setBeeper(ft, this.earOut * 0.75 + this.micOut * 0.08 + (level ? 0.08 : 0));
    });
    if (!tape.playing) this.updateBeeper(t);
  }

  // starts and stops the tape when a program's own loader reads the EAR bit (as Fuse does):
  // reads close together with B counting are a loader's edge loop
  detectLoader(t) {
    const tape = this.tape;
    if (!tape.present || !this.autoTape) return;
    const now = this.tBase + t;
    const dt = now - this.lastEarRead;
    const db = (this.cpu.b - this.lastEarB) & 0xff;
    this.lastEarRead = now;
    this.lastEarB = this.cpu.b;
    if (tape.playing) {
      if (dt > 1000 || (db !== 1 && db !== 0 && db !== 0xff)) {
        if (++this.loaderCount > 10) { tape.stop(); this.loaderCount = 0; }
      } else this.loaderCount = 0;
    } else if (!tape.atEnd) {
      if (dt <= 500 && (db === 1 || db === 0xff)) {
        if (++this.loaderCount > 10) { tape.play(now); this.loaderCount = 0; }
      } else this.loaderCount = 0;
    }
  }

  // ---------------------------------------------------------------- traps
  onTrapAt(pc) {
    if (this.romIndex !== this.basicRom || this.pageBank[0] >= 0) return false;
    if (pc === LD_BYTES && this.flashLoad) return this.flashLoadBlock();
    if (pc === SA_BYTES && this.saveTraps) return this.saveBlock();
    return false;
  }

  romIs48(addr, sig) {
    for (let i = 0; i < sig.length; i++) if (this.read(addr + i) !== sig[i]) return false;
    return true;
  }

  // LD-BYTES: a whole block from the tape at once. A: the flag byte wanted, IX: where to,
  // DE: how many, carry: load (or verify). Returns through LD-RET with carry set if it worked.
  flashLoadBlock() {
    const tape = this.tape, cpu = this.cpu;
    if (!tape.present || !this.romIs48(LD_BYTES, LD_SIG)) return false;
    const found = tape.dataBlockHere();
    if (!found) {
      // a block the ROM can't take at once: play it
      tape.play(this.tBase + cpu.t);
      return false;
    }
    const data = found.block.data;
    const verify = !(cpu.f & 1);
    let ok = false;
    let ix = cpu.ix, de = cpu.de;
    if (data.length && data[0] === cpu.a) {
      let parity = data[0];
      let i = 1;
      while (de > 0 && i < data.length) {
        const b = data[i++];
        parity ^= b;
        if (!verify) this.write(ix, b);
        else if (this.read(ix) !== b) break;
        ix = (ix + 1) & 0xffff;
        de--;
      }
      if (de === 0 && i < data.length) {
        parity ^= data[i];
        ok = parity === 0;
      }
    }
    cpu.ix = ix;
    cpu.de = de;
    cpu.f = ok ? cpu.f | 1 : cpu.f & ~1;
    cpu.a = 0;
    // a second of tape time for each 1.5K, so a game's loading screen is seen
    tape.skipTo(found.index + 1, this.tBase + cpu.t);
    tape.stop();
    cpu.pc = LD_RET;
    return true;
  }

  // SA-BYTES: the block the program saves goes on the saved tape (A flag, IX from, DE bytes)
  saveBlock() {
    const cpu = this.cpu;
    const out = new Uint8Array(cpu.de + 2);
    out[0] = cpu.a;
    let parity = cpu.a;
    for (let i = 0; i < cpu.de; i++) { const b = this.read((cpu.ix + i) & 0xffff); out[i + 1] = b; parity ^= b; }
    out[out.length - 1] = parity;
    this.tape.saved.push(out);
    cpu.pc = cpu.pop();
    cpu.f |= 1;
    return true;
  }

  // ---------------------------------------------------------------- running
  hardReset() {
    for (const b of this.banks) b.fill(0);
    this.port7ffd = 0;
    this.port1ffd = 0;
    this.pagingLocked = this.info.paging === '48';
    this.screenBank = -1;
    this.updatePaging();
    this.border = 7;
    this.earOut = 0;
    this.micOut = 0;
    this.tBase = 0;
    this.frames = 0;
    this.lastEarRead = 0;
    this.lastEarB = 0;
    this.loaderCount = 0;
    this.autoTape = true;
    this.saveTraps = true;
    this.video.reset();
    this.psg.reset();
    if (this.fdc) this.fdc.reset();
    const cpu = this.cpu;
    cpu.reset();
    cpu.t = 0;
    cpu.trapFlags = new Uint8Array(0x10000);
    cpu.trapFlags[LD_BYTES] = 1;
    cpu.trapFlags[SA_BYTES] = 1;
    cpu.onTrap = (pc) => this.onTrapAt(pc);
    this.typeQueue = [];
    this.typeHold = this.typeGap = 0;
    this.lastTyped = [];
    this.typeInts = 0;
    this.gapFrames = 0;
    this.waitTaken = 0;
    this.typedMatrix.fill(0);
    this.readyHandlers = [];
    this.ready = false;
    this.tape.reset();
    this.tape.playing = false;
  }

  reset() { this.hardReset(); }

  endFrame() {
    const len = this.frameLen;
    this.updateTape(len);
    this.video.endFrame(len);
    this.psg.endFrame(len);
    this.cpu.t -= len;
    this.tBase += len;
    this.frames++;
    if (!this.ready && this.frames >= READY_FRAMES[this.model]) this.becomeReady();
  }

  runFrame() {
    this.serviceTyping();
    const cpu = this.cpu, v = this.video, len = this.frameLen;
    // the CPU stepped on its own past the end of frames (a debugger, a test): finish them
    while (cpu.t >= len) this.endFrame();
    v.frameCompleted = 0;
    while (!v.frameCompleted) {
      if (cpu.halted && cpu.cpage[cpu.pc >> 14] === 0 && cpu.trapFlags[cpu.pc] === 0) {
        // HALT out of contended memory: nothing changes until the interrupt
        let t = cpu.t;
        const intEnd = cpu.iff1 ? cpu.intLen : 0;
        if (t >= intEnd && t < len) {
          const n = Math.ceil((len - t) / 4);
          cpu.t = t + n * 4;
          cpu.r = (cpu.r & 0x80) | ((cpu.r + n) & 0x7f);
        } else {
          cpu.step();
        }
      } else if (this.fdc !== null && this.fdc.phase === 1) {
        // the disk drive's timing (the FDC counts in the CPC's 4 MHz cycles)
        const before = cpu.t;
        cpu.step();
        this.fdc.tick(Math.round(((cpu.t - before) * 4000000) / this.timing.clock));
      } else {
        cpu.step();
      }
      if (cpu.t >= len) this.endFrame();
    }
  }

  runCycles(n) {
    const cpu = this.cpu;
    let left = n;
    while (left > 0) {
      const before = cpu.t;
      cpu.step();
      left -= cpu.t - before;
      while (cpu.t >= this.frameLen) {
        this.endFrame();
        this.serviceTyping();
      }
    }
  }

  get cycles() { return this.tBase + this.cpu.t; }
  get clock() { return this.timing.clock; }
  get cyclesPerFrame() { return this.frameLen; }
  get busy() { return (this.tape.present && this.tape.playing) || (this.fdc !== null && this.fdc.busy); }

  // ---------------------------------------------------------------- keys, joysticks
  key(name, down) {
    for (const k of keysOf(name)) {
      const code = ZX_KEYS[k];
      if (down) this.keyCount[code]++;
      else if (this.keyCount[code] > 0) this.keyCount[code]--;
      const row = code >> 3, bit = 1 << (code & 7);
      if (this.keyCount[code]) this.matrix[row] |= bit;
      else this.matrix[row] &= ~bit;
    }
  }

  releaseAllKeys() {
    this.keyCount.fill(0);
    this.matrix.fill(0);
  }

  setJoystick(bits, port = 0) {
    this.joy[port ? 1 : 0] = bits;
  }

  setJoystickType(type, port = 0) {
    this.joyTypes[port ? 1 : 0] = JOYSTICK_TYPES.includes(type) ? type : 'none';
  }

  typeText(text) {
    for (const ch of text) {
      const k = CHAR_TO_KEYS[ch];
      if (k) this.typeQueue.push(k);
    }
  }

  // presses keys together (names as key() takes them), as one keystroke
  typeKeys(...names) {
    const keys = names.flatMap((n) => keysOf(n));
    if (keys.length) this.typeQueue.push(keys);
  }

  typeKey(name, shift = false) {
    this.typeKeys(...(shift ? ['CAPS', name] : [name]));
  }

  typeWait(frames) {
    this.typeQueue.push(frames);
  }

  // Typing: each key is held until the ROM has scanned the keyboard twice with it down (its
  // interrupt), then let go until it has seen it up: once for another key, five times for the
  // same key again (the ROM's key memory), 25 after ENTER while the editor takes the line in.
  // A program with interrupts off gets a frame for each instead.
  serviceTyping() {
    if (!this.ready) return;
    const ints = this.cpu.ints;
    if (this.typeHold > 0) {
      this.typeHold++;
      if (ints - this.typeInts < 2 && this.typeHold < 40) return;
      this.typeHold = 0;
      this.typedMatrix.fill(0);
      const next = this.typeQueue[0];
      if (this.lastTyped.length === 1 && this.lastTyped[0] === 'ENTER') this.typeGap = 25;
      else this.typeGap = Array.isArray(next) && next.some((k) => this.lastTyped.includes(k)) ? 6 : 1;
      this.typeInts = ints;
      this.gapFrames = 0;
      return;
    }
    if (this.typeGap > 0) {
      if (ints - this.typeInts < this.typeGap && ++this.gapFrames < this.typeGap + 10) return;
      this.typeGap = 0;
    }
    if (!this.typeQueue.length) return;
    // while the ROM's editor runs (IY at its system variables, IM 1), the key before must have
    // been taken (FLAGS bit 5 clear) before the next is pressed
    if (this.cpu.iy === 0x5c3a && this.cpu.im === 1 && this.pageBank[0] < 0 && (this.peek(0x5c3b) & 0x20) && ++this.waitTaken < 50) return;
    this.waitTaken = 0;
    const next = this.typeQueue.shift();
    if (typeof next === 'number') { this.typeGap = next; this.typeInts = ints; this.gapFrames = 0; return; }
    this.lastTyped = next;
    for (const k of next) {
      const code = ZX_KEYS[k];
      this.typedMatrix[code >> 3] |= 1 << (code & 7);
    }
    this.typeHold = 1;
    this.typeInts = ints;
  }

  get typing() { return this.typeQueue.length > 0 || this.typeHold > 0; }

  onReady(fn) {
    if (this.ready) fn(this);
    else this.readyHandlers.push(fn);
  }

  becomeReady() {
    this.ready = true;
    const handlers = this.readyHandlers;
    this.readyHandlers = [];
    for (const h of handlers) h(this);
  }

  // ---------------------------------------------------------------- media
  insertTape(bytes, name = '') {
    this.tape.insert(bytes, name);
    this.tape.is48 = this.info.paging === '48';
    this.tape.scale = this.timing.clock / 3500000;
    this.tapeData = bytes;
  }

  ejectTape() {
    this.tape.eject();
    this.tapeData = null;
  }

  insertDisk(image, drive = 0) {
    const img = image ? (image instanceof DskImage ? image : DskImage.parse(image)) : null;
    this.disks[drive] = img;
    if (this.fdc) this.fdc.insert(drive, img);
  }

  ejectDisk(drive = 0) { this.insertDisk(null, drive); }

  diskImage(drive = 0) {
    const d = this.disks[drive];
    return d ? d.toBytes() : null;
  }

  // an Interface 2 cartridge: it takes the place of the ROM; the machine starts again
  insertCartridge(bytes) {
    this.cartridge = bytes ? bytes.slice() : null;
    this.romPages = bytes ? [cartridgePage(bytes)] : [];
    if (!bytes) {
      const rom = this.roms[this.info.rom];
      for (let o = 0; o < rom.length; o += 0x4000) this.romPages.push(rom.slice(o, o + 0x4000));
    }
    this.basicRom = this.romPages.length - 1;
    this.hardReset();
  }

  injectBinary(data, load, exec) {
    for (let i = 0; i < data.length; i++) this.poke((load + i) & 0xffff, data[i]);
    this.cpu.pc = exec & 0xffff;
    this.cpu.halted = 0;
  }

  loadSnapshot(bytes) {
    loadSnapshot(this, bytes);
    this.ready = true;
    this.readyHandlers = [];
  }

  loadSna(bytes) { this.loadSnapshot(bytes); }
  loadZ80(bytes) { this.loadSnapshot(bytes); }

  static snaModel(bytes) { return snapshotModel(bytes); }

  // ---------------------------------------------------------------- save states
  saveState() {
    const c = this.cpu;
    const cpu = {};
    for (const k of ['a', 'f', 'b', 'c', 'd', 'e', 'h', 'l', 'a_', 'f_', 'b_', 'c_', 'd_', 'e_', 'h_', 'l_', 'ix', 'iy', 'sp', 'pc', 'i', 'r', 'iff1', 'iff2', 'im', 'halted', 'eiDelay', 'wz', 'q', 'qf', 't']) cpu[k] = c[k];
    return {
      version: STATE_VERSION,
      model: this.model,
      cartridge: this.cartridge ? this.cartridge.slice() : null,
      banks: this.banks.map((b) => b.slice()),
      cpu,
      machine: {
        port7ffd: this.port7ffd, port1ffd: this.port1ffd, pagingLocked: this.pagingLocked, border: this.border,
        earOut: this.earOut, micOut: this.micOut, tBase: this.tBase, frames: this.frames, joyTypes: this.joyTypes.slice(),
      },
      video: { border: this.video.border, flashCount: this.video.flashCount, flash: this.video.flash, pos: this.video.pos, fb: this.video.fb.slice() },
      psg: this.psg.saveState(),
      fdc: this.fdc ? this.fdc.saveState() : null,
      disks: this.disks.map((d) => (d ? d.toBytes() : null)),
      tapeData: this.tapeData ? this.tapeData.slice() : null,
      tape: this.tape.present ? this.tape.saveState() : null,
    };
  }

  loadState(s) {
    if (s.version !== STATE_VERSION || s.model !== this.model) throw new Error('Incompatible save state');
    if (s.cartridge) this.insertCartridge(s.cartridge);
    s.banks.forEach((b, i) => this.banks[i].set(b));
    Object.assign(this.cpu, s.cpu);
    const m = s.machine;
    this.port7ffd = m.port7ffd;
    this.port1ffd = m.port1ffd;
    this.pagingLocked = m.pagingLocked;
    this.border = m.border;
    this.earOut = m.earOut;
    this.micOut = m.micOut;
    this.tBase = m.tBase;
    this.frames = m.frames;
    if (m.joyTypes) this.joyTypes = m.joyTypes.slice();
    this.screenBank = -1;
    this.updatePaging();
    Object.assign(this.video, { border: s.video.border, flashCount: s.video.flashCount, flash: s.video.flash, pos: s.video.pos });
    this.video.fb.set(s.video.fb);
    this.psg.loadState(s.psg);
    this.psg.outLen = 0;
    s.disks.forEach((d, i) => this.insertDisk(d ? DskImage.parse(d) : null, i));
    if (this.fdc && s.fdc) this.fdc.loadState(s.fdc);
    if (s.tapeData) {
      this.insertTape(s.tapeData.slice());
      if (s.tape) this.tape.loadState(s.tape);
    } else {
      this.ejectTape();
    }
    this.releaseAllKeys();
    this.joy = [0, 0];
    this.typeQueue = [];
    this.typedMatrix.fill(0);
    this.ready = true;
    this.readyHandlers = [];
  }
}

// an Interface 2 cartridge's 16K (a smaller one repeats)
function cartridgePage(bytes) {
  const out = new Uint8Array(0x4000).fill(0xff);
  if (bytes.length >= 0x4000) out.set(bytes.subarray(0, 0x4000));
  else for (let o = 0; o < 0x4000; o += bytes.length || 0x4000) out.set(bytes.subarray(0, Math.min(bytes.length, 0x4000 - o)), o);
  return out;
}

export { standardColours };
