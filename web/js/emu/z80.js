// The Z80 for ZXEmu, written for it in 2026. GPL v2 or later, see LICENSE.
//
// Every machine cycle is counted in T-states, with the Spectrum's memory contention applied
// to each access the way the ULA does it: the machine fills `ctab` (the delay at each T-state
// of the frame) and `cpage` (which 8K slots are contended), and `rwait` (the 8K slots whose reads take a wait state:
// the Next at 28 MHz), and says whether the cycles
// without a memory request are contended too (48K and 128K: yes; +2A and +3: no). Undocumented
// opcodes and flags (X and Y, MEMPTR, Q for SCF and CCF, the block instructions' flags when
// they repeat) are as on a Zilog NMOS Z80.
//
// The bus: read(addr), write(addr, v), ioRead(port), ioWrite(port, v), intVector().

const CF = 0x01, NF = 0x02, PF = 0x04, XF = 0x08, HF = 0x10, YF = 0x20, ZF = 0x40, SF = 0x80;
const XYF = XF | YF;

const SZ = new Uint8Array(256); // S, Z and the X/Y copies of the value
const SZP = new Uint8Array(256); // ... and parity
const PARITY = new Uint8Array(256); // PF when even
for (let i = 0; i < 256; i++) {
  let p = 0;
  for (let b = 0; b < 8; b++) if (i & (1 << b)) p++;
  PARITY[i] = p & 1 ? 0 : PF;
  SZ[i] = (i & (SF | XYF)) | (i ? 0 : ZF);
  SZP[i] = SZ[i] | PARITY[i];
}

const IM_MODES = [0, 0, 1, 2, 0, 0, 1, 2];

const MIRROR = new Uint8Array(256); // the bits of a byte the other way round (Z80N MIRROR A)
for (let i = 0; i < 256; i++) {
  let m = 0;
  for (let b = 0; b < 8; b++) if (i & (1 << b)) m |= 0x80 >> b;
  MIRROR[i] = m;
}

export class Z80 {
  constructor(bus) {
    this.bus = bus;
    this.trapFlags = null; // a Uint8Array(65536): onTrap(pc) is asked before the instruction there
    this.onTrap = null; // true: the instruction is skipped
    this.cpage = new Uint8Array(8); // contended 8K slots
    this.rwait = new Uint8Array(8); // extra T-states on each read from an 8K slot (the Next at 28 MHz)
    this.ctab = new Uint8Array(1); // contention delay by frame T-state (machine fills it)
    this.noMreqContended = true; // 48K/128K: the cycles without MREQ are contended too
    this.ioContended = true; // 48K/128K: I/O contention as the ULA does it
    this.frameLen = 69888;
    this.intLen = 32; // CPU cycles the /INT line is held at the start of a frame (0: never)
    this.t = 0; // T-states into the frame
    this.ints = 0; // interrupts taken (typing waits for the ROM to have seen keys)
    this.z80n = false; // the Spectrum Next's extra instructions
    // the Next's turbo: the CPU's clock is `mult` times the ULA's (1, 2, 4 or 8). `t` stays in
    // the ULA's T-states, so each instruction counts 1/mult of its own; the rest carries over
    this.mult = 1;
    this.tRem = 0;
    // the Next: its interrupt controller says whether /INT is held (besides the frame's own
    // interrupt, intLen), and hears RETI
    this.intHook = null;
    this.reset();
  }

  reset() {
    this.a = 0xff; this.f = 0xff; this.b = 0; this.c = 0; this.d = 0; this.e = 0; this.h = 0; this.l = 0;
    this.a_ = 0xff; this.f_ = 0xff; this.b_ = 0; this.c_ = 0; this.d_ = 0; this.e_ = 0; this.h_ = 0; this.l_ = 0;
    this.ix = 0xffff; this.iy = 0xffff; this.sp = 0xffff; this.pc = 0;
    this.i = 0; this.r = 0;
    this.iff1 = 0; this.iff2 = 0; this.im = 0;
    this.halted = 0;
    this.eiDelay = 0; // the instruction just run was EI: no interrupt after it
    this.wz = 0; // MEMPTR
    this.q = 0; // F as the previous instruction set it (0 if it set no flags)
    this.qf = 0; // this instruction set flags
    this.ldair = 0; // LD A,I / LD A,R just run (an interrupt now clears P/V)
  }

  // AmsEmu's names
  get halt() { return this.halted; }
  set halt(v) { this.halted = v ? 1 : 0; }
  getR() { return this.r; }
  setR(v) { this.r = v & 0xff; }

  // The /INT line is held now (for the debugger: an interrupt comes after this step)
  get intPending() {
    let t = this.t;
    if (t >= this.frameLen) t %= this.frameLen;
    return t * this.mult + this.tRem < this.intLen || (this.intHook !== null && this.intHook()) ? 1 : 0;
  }
  set intPending(v) { /* the ULA drives /INT: nothing to set */ }

  get af() { return (this.a << 8) | this.f; }
  get bc() { return (this.b << 8) | this.c; }
  get de() { return (this.d << 8) | this.e; }
  get hl() { return (this.h << 8) | this.l; }
  set af(v) { this.a = (v >> 8) & 0xff; this.f = v & 0xff; }
  set bc(v) { this.b = (v >> 8) & 0xff; this.c = v & 0xff; }
  set de(v) { this.d = (v >> 8) & 0xff; this.e = v & 0xff; }
  set hl(v) { this.h = (v >> 8) & 0xff; this.l = v & 0xff; }
  get af_() { return (this.a_ << 8) | this.f_; }
  get bc_() { return (this.b_ << 8) | this.c_; }
  get de_() { return (this.d_ << 8) | this.e_; }
  get hl_() { return (this.h_ << 8) | this.l_; }

  // ---------------------------------------------------------------- timing
  // the contention delay now: by the T-state within the frame, so stepping the CPU on its own
  // past a frame's end (a debugger, a test timing code) keeps counting right
  delay() {
    const t = this.t;
    return t < this.frameLen ? this.ctab[t] : this.ctab[t % this.frameLen];
  }

  // one contended cycle of n T-states at addr (a memory access)
  cyc(addr, n) {
    if (this.cpage[addr >> 13] !== 0) this.t += this.delay();
    this.t += n;
  }

  // n cycles of 1 T-state with addr on the bus but no memory request
  nm(addr, n) {
    if (this.noMreqContended && this.cpage[addr >> 13] !== 0) {
      for (let i = 0; i < n; i++) this.t += this.delay() + 1;
    } else {
      this.t += n;
    }
  }

  ir() { return (this.i << 8) | this.r; }

  incR() { this.r = (this.r & 0x80) | ((this.r + 1) & 0x7f); }

  // an opcode fetch (M1): 4 T-states
  fetchOp() {
    const pc = this.pc;
    if (this.cpage[pc >> 13] !== 0) this.t += this.delay();
    const op = this.bus.read(pc);
    this.t += 4 + this.rwait[pc >> 13];
    this.pc = (pc + 1) & 0xffff;
    this.incR();
    return op;
  }

  rm(addr) {
    if (this.cpage[addr >> 13] !== 0) this.t += this.delay();
    const v = this.bus.read(addr);
    this.t += 3 + this.rwait[addr >> 13];
    return v;
  }

  wm(addr, v) {
    if (this.cpage[addr >> 13] !== 0) this.t += this.delay();
    this.bus.write(addr, v);
    this.t += 3;
  }

  fetch() {
    const v = this.rm(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return v;
  }

  fetch16() {
    const lo = this.fetch();
    return lo | (this.fetch() << 8);
  }

  push(v) {
    this.sp = (this.sp - 1) & 0xffff;
    this.wm(this.sp, v >> 8);
    this.sp = (this.sp - 1) & 0xffff;
    this.wm(this.sp, v & 0xff);
  }

  pop() {
    const lo = this.rm(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    const hi = this.rm(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    return lo | (hi << 8);
  }

  // I/O: the ULA's contention for the port's high byte (as a memory address) and low bit,
  // read one T-state before the end
  portIn(port) {
    this.ioPre(port);
    const v = this.bus.ioRead(port);
    this.t += 1;
    return v;
  }

  portOut(port, v) {
    this.ioPre(port);
    this.bus.ioWrite(port, v);
    this.t += 1;
  }

  ioPre(port) {
    if (!this.ioContended) { this.t += 3; return; }
    const hi = this.cpage[port >> 13] !== 0;
    if (!(port & 1)) {
      if (hi) this.t += this.delay();
      this.t += 1;
      this.t += this.delay();
      this.t += 2;
    } else if (hi) {
      for (let i = 0; i < 3; i++) this.t += this.delay() + 1;
      this.t += this.delay();
    } else {
      this.t += 3;
    }
  }

  // ---------------------------------------------------------------- running
  step() {
    const tf = this.trapFlags;
    const t0 = this.t;
    if (tf !== null && tf[this.pc] !== 0 && this.onTrap !== null && this.onTrap(this.pc)) {
      // skipped
    } else {
      this.q = this.qf ? this.f : 0;
      this.qf = 0;
      this.ldair = 0;
      if (this.halted) {
        // HALT: NOPs at the HALT until an interrupt
        if (this.cpage[this.pc >> 13] !== 0) this.t += this.delay();
        this.t += 4 + this.rwait[this.pc >> 13];
        this.incR();
      } else {
        this.execMain(this.fetchOp());
      }
    }
    if (this.mult !== 1) this.scaleTime(t0);
    if (this.eiDelay !== 0) {
      this.eiDelay = 0;
    } else if (this.iff1 !== 0) {
      let t = this.t;
      if (t >= this.frameLen) t %= this.frameLen;
      // intLen is in CPU cycles: at a turbo speed, the cycles since the frame began are t * mult
      // and the carried-over part
      if (t * this.mult + this.tRem < this.intLen || (this.intHook !== null && this.intHook())) {
        const t1 = this.t;
        this.interrupt();
        if (this.mult !== 1) this.scaleTime(t1);
      }
    }
  }

  // the T-states since t0 at the turbo clock, counted in the ULA's
  scaleTime(t0) {
    const s = this.t - t0 + this.tRem;
    this.t = t0 + Math.floor(s / this.mult);
    this.tRem = s % this.mult;
  }

  interrupt() {
    if (this.halted) {
      this.halted = 0;
      this.pc = (this.pc + 1) & 0xffff;
    }
    if (this.ldair) this.f &= ~PF;
    this.iff1 = this.iff2 = 0;
    this.incR();
    this.ints++;
    this.t += 7;
    this.push(this.pc);
    if (this.im === 2) {
      const v = (this.i << 8) | (this.bus.intVector() & 0xff);
      const lo = this.rm(v);
      const hi = this.rm((v + 1) & 0xffff);
      this.pc = lo | (hi << 8);
    } else {
      this.pc = 0x38;
    }
    this.wz = this.pc;
    this.qf = 0;
  }

  // ---------------------------------------------------------------- arithmetic
  add8(v) {
    const a = this.a, r = a + v;
    this.f = SZ[r & 0xff] | ((r >> 8) & CF) | ((a ^ r ^ v) & HF) | ((((v ^ a ^ 0x80) & (v ^ r)) >> 5) & PF);
    this.a = r & 0xff;
    this.qf = 1;
  }

  adc8(v) {
    const a = this.a, r = a + v + (this.f & CF);
    this.f = SZ[r & 0xff] | ((r >> 8) & CF) | ((a ^ r ^ v) & HF) | ((((v ^ a ^ 0x80) & (v ^ r)) >> 5) & PF);
    this.a = r & 0xff;
    this.qf = 1;
  }

  sub8(v) {
    const a = this.a, r = a - v;
    this.f = SZ[r & 0xff] | ((r >> 8) & CF) | NF | ((a ^ r ^ v) & HF) | ((((v ^ a) & (a ^ r)) >> 5) & PF);
    this.a = r & 0xff;
    this.qf = 1;
  }

  sbc8(v) {
    const a = this.a, r = a - v - (this.f & CF);
    this.f = SZ[r & 0xff] | ((r >> 8) & CF) | NF | ((a ^ r ^ v) & HF) | ((((v ^ a) & (a ^ r)) >> 5) & PF);
    this.a = r & 0xff;
    this.qf = 1;
  }

  cp8(v) {
    const a = this.a, r = a - v;
    this.f = (SZ[r & 0xff] & (SF | ZF)) | (v & XYF) | ((r >> 8) & CF) | NF | ((a ^ r ^ v) & HF) | ((((v ^ a) & (a ^ r)) >> 5) & PF);
    this.qf = 1;
  }

  alu(k, v) {
    switch (k) {
      case 0: this.add8(v); break;
      case 1: this.adc8(v); break;
      case 2: this.sub8(v); break;
      case 3: this.sbc8(v); break;
      case 4: this.a &= v; this.f = SZP[this.a] | HF; this.qf = 1; break;
      case 5: this.a ^= v; this.f = SZP[this.a]; this.qf = 1; break;
      case 6: this.a |= v; this.f = SZP[this.a]; this.qf = 1; break;
      default: this.cp8(v); break;
    }
  }

  inc8(v) {
    const r = (v + 1) & 0xff;
    this.f = (this.f & CF) | SZ[r] | (r === 0x80 ? PF : 0) | ((r & 0x0f) === 0 ? HF : 0);
    this.qf = 1;
    return r;
  }

  dec8(v) {
    const r = (v - 1) & 0xff;
    this.f = (this.f & CF) | SZ[r] | NF | (r === 0x7f ? PF : 0) | ((r & 0x0f) === 0x0f ? HF : 0);
    this.qf = 1;
    return r;
  }

  add16(a, v) {
    const r = a + v;
    this.f = (this.f & (SF | ZF | PF)) | (((a ^ v ^ r) >> 8) & HF) | ((r >> 16) & CF) | ((r >> 8) & XYF);
    this.wz = (a + 1) & 0xffff;
    this.qf = 1;
    return r & 0xffff;
  }

  adc16(v) {
    const hl = this.hl, r = hl + v + (this.f & CF);
    this.f = (((hl ^ r ^ v) >> 8) & HF) | ((r >> 16) & CF) | ((r >> 8) & (SF | XYF)) |
      ((r & 0xffff) ? 0 : ZF) | ((((v ^ hl ^ 0x8000) & (v ^ r)) >> 13) & PF);
    this.wz = (hl + 1) & 0xffff;
    this.hl = r & 0xffff;
    this.qf = 1;
  }

  sbc16(v) {
    const hl = this.hl, r = hl - v - (this.f & CF);
    this.f = (((hl ^ r ^ v) >> 8) & HF) | NF | ((r >> 16) & CF) | ((r >> 8) & (SF | XYF)) |
      ((r & 0xffff) ? 0 : ZF) | ((((v ^ hl) & (hl ^ r)) >> 13) & PF);
    this.wz = (hl + 1) & 0xffff;
    this.hl = r & 0xffff;
    this.qf = 1;
  }

  // the CB rotations and shifts: rlc rrc rl rr sla sra sll srl
  rot(k, v) {
    let r, c;
    switch (k) {
      case 0: c = v >> 7; r = ((v << 1) | c) & 0xff; break;
      case 1: c = v & 1; r = (v >> 1) | (c << 7); break;
      case 2: c = v >> 7; r = ((v << 1) | (this.f & CF)) & 0xff; break;
      case 3: c = v & 1; r = (v >> 1) | ((this.f & CF) << 7); break;
      case 4: c = v >> 7; r = (v << 1) & 0xff; break;
      case 5: c = v & 1; r = (v >> 1) | (v & 0x80); break;
      case 6: c = v >> 7; r = ((v << 1) | 1) & 0xff; break;
      default: c = v & 1; r = v >> 1; break;
    }
    this.f = SZP[r] | c;
    this.qf = 1;
    return r;
  }

  bit(n, v, xy) {
    const r = v & (1 << n);
    this.f = (this.f & CF) | HF | (r ? r & SF : ZF | PF) | (xy & XYF);
    this.qf = 1;
  }

  daa() {
    const a = this.a, lo = a & 0x0f;
    let diff = 0, c = this.f & CF;
    if ((this.f & HF) || lo > 9) diff = 6;
    if (c || a > 0x99) { diff |= 0x60; c = CF; }
    let h, r;
    if (this.f & NF) { h = (this.f & HF) && lo < 6; r = (a - diff) & 0xff; }
    else { h = lo > 9; r = (a + diff) & 0xff; }
    this.a = r;
    this.f = SZP[r] | c | (h ? HF : 0) | (this.f & NF);
    this.qf = 1;
  }

  cond(k) {
    const f = this.f;
    switch (k) {
      case 0: return !(f & ZF);
      case 1: return !!(f & ZF);
      case 2: return !(f & CF);
      case 3: return !!(f & CF);
      case 4: return !(f & PF);
      case 5: return !!(f & PF);
      case 6: return !(f & SF);
      default: return !!(f & SF);
    }
  }

  // registers by their number in an opcode: B C D E H L - A
  getReg(k) {
    switch (k) {
      case 0: return this.b; case 1: return this.c; case 2: return this.d; case 3: return this.e;
      case 4: return this.h; case 5: return this.l; default: return this.a;
    }
  }

  setReg(k, v) {
    switch (k) {
      case 0: this.b = v; break; case 1: this.c = v; break; case 2: this.d = v; break; case 3: this.e = v; break;
      case 4: this.h = v; break; case 5: this.l = v; break; default: this.a = v; break;
    }
  }

  getRp(p) {
    switch (p) { case 0: return this.bc; case 1: return this.de; case 2: return this.hl; default: return this.sp; }
  }

  setRp(p, v) {
    switch (p) { case 0: this.bc = v; break; case 1: this.de = v; break; case 2: this.hl = v; break; default: this.sp = v; break; }
  }

  jr() {
    const at = this.pc;
    const d = (this.rm(at) << 24) >> 24;
    this.nm(at, 5);
    this.pc = (at + 1 + d) & 0xffff;
    this.wz = this.pc;
  }

  // ---------------------------------------------------------------- unprefixed
  execMain(op) {
    switch (op) {
      case 0x00: return;
      case 0x01: case 0x11: case 0x21: case 0x31: this.setRp(op >> 4, this.fetch16()); return;
      case 0x02: this.wm(this.bc, this.a); this.wz = ((this.bc + 1) & 0xff) | (this.a << 8); return;
      case 0x12: this.wm(this.de, this.a); this.wz = ((this.de + 1) & 0xff) | (this.a << 8); return;
      case 0x03: case 0x13: case 0x23: case 0x33: this.nm(this.ir(), 2); this.setRp(op >> 4, (this.getRp(op >> 4) + 1) & 0xffff); return;
      case 0x0b: case 0x1b: case 0x2b: case 0x3b: this.nm(this.ir(), 2); this.setRp(op >> 4, (this.getRp(op >> 4) - 1) & 0xffff); return;
      case 0x04: case 0x0c: case 0x14: case 0x1c: case 0x24: case 0x2c: case 0x3c: { const k = op >> 3; this.setReg(k, this.inc8(this.getReg(k))); return; }
      case 0x05: case 0x0d: case 0x15: case 0x1d: case 0x25: case 0x2d: case 0x3d: { const k = op >> 3; this.setReg(k, this.dec8(this.getReg(k))); return; }
      case 0x06: case 0x0e: case 0x16: case 0x1e: case 0x26: case 0x2e: case 0x3e: this.setReg(op >> 3, this.fetch()); return;
      case 0x07: { const c = this.a >> 7; this.a = ((this.a << 1) | c) & 0xff; this.f = (this.f & (SF | ZF | PF)) | (this.a & XYF) | c; this.qf = 1; return; }
      case 0x0f: { const c = this.a & 1; this.a = (this.a >> 1) | (c << 7); this.f = (this.f & (SF | ZF | PF)) | (this.a & XYF) | c; this.qf = 1; return; }
      case 0x17: { const c = this.a >> 7; this.a = ((this.a << 1) | (this.f & CF)) & 0xff; this.f = (this.f & (SF | ZF | PF)) | (this.a & XYF) | c; this.qf = 1; return; }
      case 0x1f: { const c = this.a & 1; this.a = (this.a >> 1) | ((this.f & CF) << 7); this.f = (this.f & (SF | ZF | PF)) | (this.a & XYF) | c; this.qf = 1; return; }
      case 0x08: {
        let t = this.a; this.a = this.a_; this.a_ = t;
        t = this.f; this.f = this.f_; this.f_ = t;
        return;
      }
      case 0x09: case 0x19: case 0x29: case 0x39: this.nm(this.ir(), 7); this.hl = this.add16(this.hl, this.getRp(op >> 4)); return;
      case 0x0a: this.a = this.rm(this.bc); this.wz = (this.bc + 1) & 0xffff; return;
      case 0x1a: this.a = this.rm(this.de); this.wz = (this.de + 1) & 0xffff; return;
      case 0x10: {
        this.nm(this.ir(), 1);
        this.b = (this.b - 1) & 0xff;
        if (this.b !== 0) this.jr();
        else { this.rm(this.pc); this.pc = (this.pc + 1) & 0xffff; }
        return;
      }
      case 0x18: this.jr(); return;
      case 0x20: case 0x28: case 0x30: case 0x38:
        if (this.cond((op >> 3) & 3)) this.jr();
        else { this.rm(this.pc); this.pc = (this.pc + 1) & 0xffff; }
        return;
      case 0x22: { const a = this.fetch16(); this.wm(a, this.l); this.wm((a + 1) & 0xffff, this.h); this.wz = (a + 1) & 0xffff; return; }
      case 0x2a: { const a = this.fetch16(); this.l = this.rm(a); this.h = this.rm((a + 1) & 0xffff); this.wz = (a + 1) & 0xffff; return; }
      case 0x32: { const a = this.fetch16(); this.wm(a, this.a); this.wz = ((a + 1) & 0xff) | (this.a << 8); return; }
      case 0x3a: { const a = this.fetch16(); this.a = this.rm(a); this.wz = (a + 1) & 0xffff; return; }
      case 0x27: this.daa(); return;
      case 0x2f: this.a ^= 0xff; this.f = (this.f & (SF | ZF | PF | CF)) | HF | NF | (this.a & XYF); this.qf = 1; return;
      case 0x37: this.f = (this.f & (SF | ZF | PF)) | CF | (((this.q ^ this.f) | this.a) & XYF); this.qf = 1; return;
      case 0x3f: this.f = ((this.f & (SF | ZF | PF | CF)) | ((this.f & CF) << 4) | (((this.q ^ this.f) | this.a) & XYF)) ^ CF; this.qf = 1; return;
      case 0x34: { const hl = this.hl; const v = this.rm(hl); this.nm(hl, 1); this.wm(hl, this.inc8(v)); return; }
      case 0x35: { const hl = this.hl; const v = this.rm(hl); this.nm(hl, 1); this.wm(hl, this.dec8(v)); return; }
      case 0x36: { const n = this.fetch(); this.wm(this.hl, n); return; }
      case 0x76: this.halted = 1; this.pc = (this.pc - 1) & 0xffff; return;
      case 0xc0: case 0xc8: case 0xd0: case 0xd8: case 0xe0: case 0xe8: case 0xf0: case 0xf8:
        this.nm(this.ir(), 1);
        if (this.cond((op >> 3) & 7)) { this.pc = this.pop(); this.wz = this.pc; }
        return;
      case 0xc1: this.bc = this.pop(); return;
      case 0xd1: this.de = this.pop(); return;
      case 0xe1: this.hl = this.pop(); return;
      case 0xf1: this.af = this.pop(); return;
      case 0xc2: case 0xca: case 0xd2: case 0xda: case 0xe2: case 0xea: case 0xf2: case 0xfa: {
        const a = this.fetch16();
        this.wz = a;
        if (this.cond((op >> 3) & 7)) this.pc = a;
        return;
      }
      case 0xc3: this.pc = this.wz = this.fetch16(); return;
      case 0xc4: case 0xcc: case 0xd4: case 0xdc: case 0xe4: case 0xec: case 0xf4: case 0xfc: {
        const a = this.fetch16();
        this.wz = a;
        if (this.cond((op >> 3) & 7)) { this.nm((this.pc - 1) & 0xffff, 1); this.push(this.pc); this.pc = a; }
        return;
      }
      case 0xcd: { const a = this.fetch16(); this.wz = a; this.nm((this.pc - 1) & 0xffff, 1); this.push(this.pc); this.pc = a; return; }
      case 0xc5: this.nm(this.ir(), 1); this.push(this.bc); return;
      case 0xd5: this.nm(this.ir(), 1); this.push(this.de); return;
      case 0xe5: this.nm(this.ir(), 1); this.push(this.hl); return;
      case 0xf5: this.nm(this.ir(), 1); this.push(this.af); return;
      case 0xc6: case 0xce: case 0xd6: case 0xde: case 0xe6: case 0xee: case 0xf6: case 0xfe: this.alu((op >> 3) & 7, this.fetch()); return;
      case 0xc7: case 0xcf: case 0xd7: case 0xdf: case 0xe7: case 0xef: case 0xf7: case 0xff:
        this.nm(this.ir(), 1); this.push(this.pc); this.pc = this.wz = op & 0x38; return;
      case 0xc9: this.pc = this.wz = this.pop(); return;
      case 0xcb: this.execCB(); return;
      case 0xd3: {
        const n = this.fetch();
        this.portOut(n | (this.a << 8), this.a);
        this.wz = ((n + 1) & 0xff) | (this.a << 8);
        return;
      }
      case 0xdb: {
        const port = this.fetch() | (this.a << 8);
        this.a = this.portIn(port);
        this.wz = (port + 1) & 0xffff;
        return;
      }
      case 0xd9: {
        let t;
        t = this.b; this.b = this.b_; this.b_ = t; t = this.c; this.c = this.c_; this.c_ = t;
        t = this.d; this.d = this.d_; this.d_ = t; t = this.e; this.e = this.e_; this.e_ = t;
        t = this.h; this.h = this.h_; this.h_ = t; t = this.l; this.l = this.l_; this.l_ = t;
        return;
      }
      case 0xdd: this.execIndex(true); return;
      case 0xfd: this.execIndex(false); return;
      case 0xed: this.execED(); return;
      case 0xe3: {
        const sp = this.sp;
        const lo = this.rm(sp), hi = this.rm((sp + 1) & 0xffff);
        this.nm((sp + 1) & 0xffff, 1);
        this.wm((sp + 1) & 0xffff, this.h);
        this.wm(sp, this.l);
        this.nm(sp, 2);
        this.l = lo; this.h = hi;
        this.wz = this.hl;
        return;
      }
      case 0xe9: this.pc = this.hl; return;
      case 0xeb: { let t = this.d; this.d = this.h; this.h = t; t = this.e; this.e = this.l; this.l = t; return; }
      case 0xf3: this.iff1 = this.iff2 = 0; return;
      case 0xfb: this.iff1 = this.iff2 = 1; this.eiDelay = 1; return;
      case 0xf9: this.nm(this.ir(), 2); this.sp = this.hl; return;
      default:
        break;
    }
    if (op < 0x80) {
      // LD r,r' / LD r,(HL) / LD (HL),r
      const dst = (op >> 3) & 7, src = op & 7;
      if (src === 6) this.setReg(dst, this.rm(this.hl));
      else if (dst === 6) this.wm(this.hl, this.getReg(src));
      else this.setReg(dst, this.getReg(src));
    } else {
      const src = op & 7;
      this.alu((op >> 3) & 7, src === 6 ? this.rm(this.hl) : this.getReg(src));
    }
  }

  // ---------------------------------------------------------------- CB
  execCB() {
    const op = this.fetchOp();
    const x = op >> 6, y = (op >> 3) & 7, z = op & 7;
    if (z === 6) {
      const hl = this.hl;
      const v = this.rm(hl);
      this.nm(hl, 1);
      if (x === 1) { this.bit(y, v, this.wz >> 8); return; }
      const r = x === 0 ? this.rot(y, v) : x === 2 ? v & ~(1 << y) : v | (1 << y);
      this.wm(hl, r);
      return;
    }
    const v = this.getReg(z);
    if (x === 0) this.setReg(z, this.rot(y, v));
    else if (x === 1) this.bit(y, v, v);
    else if (x === 2) this.setReg(z, v & ~(1 << y));
    else this.setReg(z, v | (1 << y));
  }

  // ---------------------------------------------------------------- DD / FD
  execIndex(isIx) {
    let ix = isIx;
    let op = this.fetchOp();
    // a chain of prefixes: only the last counts
    while (op === 0xdd || op === 0xfd) {
      ix = op === 0xdd;
      op = this.fetchOp();
    }
    if (op === 0xed) { this.execED(); return; }
    let xy = ix ? this.ix : this.iy;
    const r = this.execXY(op, xy);
    if (r !== undefined) {
      if (ix) this.ix = r; else this.iy = r;
    }
  }

  // the displacement after a DD/FD opcode, with its 5 extra T-states: the address it gives
  disp(xy) {
    const at = this.pc;
    const d = (this.rm(at) << 24) >> 24;
    this.nm(at, 5);
    this.pc = (at + 1) & 0xffff;
    const a = (xy + d) & 0xffff;
    this.wz = a;
    return a;
  }

  getRegX(k, xy) {
    if (k === 4) return xy >> 8;
    if (k === 5) return xy & 0xff;
    return this.getReg(k);
  }

  // runs op with IX or IY in place of HL; returns the new IX/IY if it changed
  execXY(op, xy) {
    switch (op) {
      case 0x09: case 0x19: case 0x29: case 0x39: {
        this.nm(this.ir(), 7);
        const p = op >> 4;
        return this.add16(xy, p === 2 ? xy : this.getRp(p));
      }
      case 0x21: return this.fetch16();
      case 0x22: { const a = this.fetch16(); this.wm(a, xy & 0xff); this.wm((a + 1) & 0xffff, xy >> 8); this.wz = (a + 1) & 0xffff; return undefined; }
      case 0x2a: { const a = this.fetch16(); const lo = this.rm(a); const hi = this.rm((a + 1) & 0xffff); this.wz = (a + 1) & 0xffff; return lo | (hi << 8); }
      case 0x23: this.nm(this.ir(), 2); return (xy + 1) & 0xffff;
      case 0x2b: this.nm(this.ir(), 2); return (xy - 1) & 0xffff;
      case 0x24: return (this.inc8(xy >> 8) << 8) | (xy & 0xff);
      case 0x25: return (this.dec8(xy >> 8) << 8) | (xy & 0xff);
      case 0x26: return (this.fetch() << 8) | (xy & 0xff);
      case 0x2c: return (xy & 0xff00) | this.inc8(xy & 0xff);
      case 0x2d: return (xy & 0xff00) | this.dec8(xy & 0xff);
      case 0x2e: return (xy & 0xff00) | this.fetch();
      case 0x34: { const a = this.disp(xy); const v = this.rm(a); this.nm(a, 1); this.wm(a, this.inc8(v)); return undefined; }
      case 0x35: { const a = this.disp(xy); const v = this.rm(a); this.nm(a, 1); this.wm(a, this.dec8(v)); return undefined; }
      case 0x36: {
        const at = this.pc;
        const d = (this.rm(at) << 24) >> 24;
        const n = this.rm((at + 1) & 0xffff);
        this.nm((at + 1) & 0xffff, 2);
        this.pc = (at + 2) & 0xffff;
        const a = (xy + d) & 0xffff;
        this.wz = a;
        this.wm(a, n);
        return undefined;
      }
      case 0xcb: {
        const at = this.pc;
        const d = (this.rm(at) << 24) >> 24;
        const op2 = this.rm((at + 1) & 0xffff);
        this.nm((at + 1) & 0xffff, 2);
        this.pc = (at + 2) & 0xffff;
        const a = (xy + d) & 0xffff;
        this.wz = a;
        const v = this.rm(a);
        this.nm(a, 1);
        const x = op2 >> 6, y = (op2 >> 3) & 7, z = op2 & 7;
        if (x === 1) { this.bit(y, v, a >> 8); return undefined; }
        const r = x === 0 ? this.rot(y, v) : x === 2 ? v & ~(1 << y) : v | (1 << y);
        this.wm(a, r);
        if (z !== 6) this.setReg(z, r);
        return undefined;
      }
      case 0xe1: return this.pop();
      case 0xe5: this.nm(this.ir(), 1); this.push(xy); return undefined;
      case 0xe9: this.pc = xy; return undefined;
      case 0xf9: this.nm(this.ir(), 2); this.sp = xy; return undefined;
      case 0xe3: {
        const sp = this.sp;
        const lo = this.rm(sp), hi = this.rm((sp + 1) & 0xffff);
        this.nm((sp + 1) & 0xffff, 1);
        this.wm((sp + 1) & 0xffff, xy >> 8);
        this.wm(sp, xy & 0xff);
        this.nm(sp, 2);
        const r = lo | (hi << 8);
        this.wz = r;
        return r;
      }
      default:
        break;
    }
    if (op >= 0x40 && op < 0xc0 && op !== 0x76) {
      const z = op & 7;
      if (op < 0x80) {
        const y = (op >> 3) & 7;
        if (z === 6) { this.setReg(y, this.rm(this.disp(xy))); return undefined; }
        if (y === 6) { const a = this.disp(xy); this.wm(a, this.getReg(z)); return undefined; }
        const v = this.getRegX(z, xy);
        if (y === 4) return (v << 8) | (xy & 0xff);
        if (y === 5) return (xy & 0xff00) | v;
        this.setReg(y, v);
        return undefined;
      }
      this.alu((op >> 3) & 7, z === 6 ? this.rm(this.disp(xy)) : this.getRegX(z, xy));
      return undefined;
    }
    // the prefix does nothing to the rest
    this.execMain(op);
    return undefined;
  }

  // ---------------------------------------------------------------- ED
  execED() {
    const op = this.fetchOp();
    if (op >= 0x40 && op < 0x80) {
      const y = (op >> 3) & 7, z = op & 7;
      switch (z) {
        case 0: {
          const bc = this.bc;
          const v = this.portIn(bc);
          this.wz = (bc + 1) & 0xffff;
          if (y !== 6) this.setReg(y, v);
          this.f = (this.f & CF) | SZP[v];
          this.qf = 1;
          return;
        }
        case 1: {
          const bc = this.bc;
          this.portOut(bc, y === 6 ? 0 : this.getReg(y));
          this.wz = (bc + 1) & 0xffff;
          return;
        }
        case 2:
          this.nm(this.ir(), 7);
          if (y & 1) this.adc16(this.getRp(y >> 1)); else this.sbc16(this.getRp(y >> 1));
          return;
        case 3: {
          const a = this.fetch16();
          if (y & 1) {
            const lo = this.rm(a), hi = this.rm((a + 1) & 0xffff);
            this.setRp(y >> 1, lo | (hi << 8));
          } else {
            const v = this.getRp(y >> 1);
            this.wm(a, v & 0xff);
            this.wm((a + 1) & 0xffff, v >> 8);
          }
          this.wz = (a + 1) & 0xffff;
          return;
        }
        case 4: { const v = this.a; this.a = 0; this.sub8(v); return; }
        case 5: // RETN, RETI (ED 4D, which the Next's interrupt controller watches for)
          this.iff1 = this.iff2;
          this.pc = this.wz = this.pop();
          if (y === 1 && this.bus.reti) this.bus.reti();
          return;
        case 6: this.im = IM_MODES[y]; return;
        default:
          switch (y) {
            case 0: this.nm(this.ir(), 1); this.i = this.a; return;
            case 1: this.nm(this.ir(), 1); this.r = this.a; return;
            case 2: case 3:
              this.nm(this.ir(), 1);
              this.a = y === 2 ? this.i : this.r;
              this.f = (this.f & CF) | SZ[this.a] | (this.iff2 ? PF : 0);
              this.qf = 1;
              this.ldair = 1;
              return;
            case 4: case 5: {
              const hl = this.hl;
              const v = this.rm(hl);
              this.nm(hl, 4);
              let r;
              if (y === 4) { r = ((this.a << 4) | (v >> 4)) & 0xff; this.a = (this.a & 0xf0) | (v & 0x0f); }
              else { r = ((v << 4) | (this.a & 0x0f)) & 0xff; this.a = (this.a & 0xf0) | (v >> 4); }
              this.wm(hl, r);
              this.f = (this.f & CF) | SZP[this.a];
              this.qf = 1;
              this.wz = (hl + 1) & 0xffff;
              return;
            }
            default: return;
          }
      }
    }
    if (op >= 0xa0 && op < 0xc0 && (op & 7) < 4) {
      this.block(op);
      return;
    }
    if (this.z80n) this.execNext(op);
    // the rest are 8 T-state NOPs
  }

  // ---------------------------------------------------------------- Z80N
  // The Spectrum Next's extra instructions (all ED-prefixed), on when `z80n` is set. Timings
  // and operations from wiki.specnext.dev's "Extended Z80 instruction set". The bus takes
  // NEXTREG through nextRegWrite(reg, v).
  execNext(op) {
    switch (op) {
      case 0x23: this.a = ((this.a << 4) | (this.a >> 4)) & 0xff; return; // SWAPNIB
      case 0x24: this.a = MIRROR[this.a]; return; // MIRROR A
      case 0x27: { // TEST n: the flags of AND n, A kept
        const r = this.a & this.fetch();
        this.f = SZP[r] | HF;
        this.qf = 1;
        return;
      }
      case 0x28: this.de = (this.b & 31) > 15 ? 0 : (this.de << (this.b & 31)) & 0xffff; return; // BSLA DE,B
      case 0x29: { // BSRA DE,B
        const s = (this.de << 16) >> 16;
        this.de = (s >> Math.min(this.b & 31, 16)) & 0xffff;
        return;
      }
      case 0x2a: this.de = (this.b & 31) > 15 ? 0 : this.de >>> (this.b & 31); return; // BSRL DE,B
      case 0x2b: this.de = ~((~this.de & 0xffff) >>> Math.min(this.b & 31, 16)) & 0xffff; return; // BSRF DE,B
      case 0x2c: { // BRLC DE,B
        const n = this.b & 15, de = this.de;
        this.de = ((de << n) | (de >>> (16 - n))) & 0xffff;
        return;
      }
      case 0x30: this.de = this.d * this.e; return; // MUL D,E
      case 0x31: this.hl = (this.hl + this.a) & 0xffff; return; // ADD HL,A
      case 0x32: this.de = (this.de + this.a) & 0xffff; return; // ADD DE,A
      case 0x33: this.bc = (this.bc + this.a) & 0xffff; return; // ADD BC,A
      case 0x34: case 0x35: case 0x36: { // ADD HL/DE/BC,nn
        const n = this.fetch16();
        this.t += 2;
        if (op === 0x34) this.hl = (this.hl + n) & 0xffff;
        else if (op === 0x35) this.de = (this.de + n) & 0xffff;
        else this.bc = (this.bc + n) & 0xffff;
        return;
      }
      case 0x8a: { // PUSH nn: the operand's high byte first
        const hi = this.fetch(), lo = this.fetch();
        this.t += 3;
        this.push((hi << 8) | lo);
        return;
      }
      case 0x90: { // OUTINB: OUTI without changing B
        const hl = this.hl;
        const v = this.rm(hl);
        this.portOut(this.bc, v);
        this.t += 1;
        this.hl = (hl + 1) & 0xffff;
        return;
      }
      case 0x91: { // NEXTREG n,n
        const reg = this.fetch(), v = this.fetch();
        this.t += 6;
        if (this.bus.nextRegWrite) this.bus.nextRegWrite(reg, v);
        return;
      }
      case 0x92: { // NEXTREG n,A
        const reg = this.fetch();
        this.t += 6;
        if (this.bus.nextRegWrite) this.bus.nextRegWrite(reg, this.a);
        return;
      }
      case 0x93: { // PIXELDN
        const hl = this.hl;
        if ((hl & 0x0700) !== 0x0700) this.hl = (hl + 0x100) & 0xffff;
        else if ((hl & 0xe0) !== 0xe0) this.hl = ((hl & 0xf8ff) + 0x20) & 0xffff;
        else this.hl = ((hl & 0xf81f) + 0x800) & 0xffff;
        return;
      }
      case 0x94: { // PIXELAD: D = y, E = x
        const d = this.d, e = this.e;
        this.hl = 0x4000 + ((d & 0xc0) << 5) + ((d & 0x07) << 8) + ((d & 0x38) << 2) + (e >> 3);
        return;
      }
      case 0x95: this.a = 0x80 >> (this.e & 7); return; // SETAE
      case 0x98: { // JP (C): within the 16K the PC is in, from the byte read at port BC
        const v = this.portIn(this.bc);
        this.t += 1;
        this.pc = this.wz = (this.pc & 0xc000) | (v << 6);
        return;
      }
      case 0xa4: case 0xac: case 0xb4: case 0xbc: { // LDIX LDDX LDIRX LDDRX
        const hl = this.hl, de = this.de;
        const v = this.rm(hl);
        if (v !== this.a) this.wm(de, v); else this.t += 3;
        this.t += 2;
        this.hl = (hl + (op & 8 ? -1 : 1)) & 0xffff;
        this.de = (de + 1) & 0xffff;
        this.bc = (this.bc - 1) & 0xffff;
        if (op & 0x10 && this.bc) { this.t += 5; this.pc = (this.pc - 2) & 0xffff; }
        return;
      }
      case 0xa5: { // LDWS: (DE) := (HL), INC L, INC D (the flags as INC D)
        this.wm(this.de, this.rm(this.hl));
        this.l = (this.l + 1) & 0xff;
        this.d = this.inc8(this.d);
        return;
      }
      case 0xb7: { // LDPIRX: from a pattern of 8 bytes at HL, the one E picks
        const v = this.rm((this.hl & 0xfff8) | (this.e & 7));
        const de = this.de;
        if (v !== this.a) this.wm(de, v); else this.t += 3;
        this.t += 2;
        this.de = (de + 1) & 0xffff;
        this.bc = (this.bc - 1) & 0xffff;
        if (this.bc) { this.t += 5; this.pc = (this.pc - 2) & 0xffff; }
        return;
      }
      default:
    }
  }

  // LDI CPI INI OUTI, LDD ..., LDIR ..., LDDR ...
  block(op) {
    const kind = op & 3;
    const dec = op & 8;
    const rep = op & 0x10;
    const step = dec ? -1 : 1;
    const start = (this.pc - 2) & 0xffff;
    if (kind === 0) {
      const hl = this.hl, de = this.de;
      const v = this.rm(hl);
      this.wm(de, v);
      this.nm(de, 2);
      const bc = (this.bc - 1) & 0xffff;
      this.bc = bc;
      this.hl = (hl + step) & 0xffff;
      this.de = (de + step) & 0xffff;
      const n = (v + this.a) & 0xff;
      this.f = (this.f & (SF | ZF | CF)) | (bc ? PF : 0) | (n & XF) | ((n & 2) << 4);
      this.qf = 1;
      if (rep && bc) {
        this.nm(de, 5);
        this.pc = start;
        this.wz = (start + 1) & 0xffff;
        this.f = (this.f & ~XYF) | ((start >> 8) & XYF);
      }
      return;
    }
    if (kind === 1) {
      const hl = this.hl;
      const v = this.rm(hl);
      this.nm(hl, 5);
      const r = (this.a - v) & 0xff;
      const bc = (this.bc - 1) & 0xffff;
      this.bc = bc;
      this.hl = (hl + step) & 0xffff;
      const h = (this.a ^ v ^ r) & HF;
      const n = (r - (h ? 1 : 0)) & 0xff;
      this.f = (this.f & CF) | NF | (SZ[r] & (SF | ZF)) | h | (bc ? PF : 0) | (n & XF) | ((n & 2) << 4);
      this.qf = 1;
      this.wz = (this.wz + step) & 0xffff;
      if (rep && bc && r) {
        this.nm(hl, 5);
        this.pc = start;
        this.wz = (start + 1) & 0xffff;
        this.f = (this.f & ~XYF) | ((start >> 8) & XYF);
      }
      return;
    }
    let v, k;
    const hl = this.hl;
    if (kind === 2) {
      this.nm(this.ir(), 1);
      const bc = this.bc;
      v = this.portIn(bc);
      this.wm(hl, v);
      this.wz = (bc + step) & 0xffff;
      this.b = (this.b - 1) & 0xff;
      this.hl = (hl + step) & 0xffff;
      k = v + ((this.c + step) & 0xff);
    } else {
      this.nm(this.ir(), 1);
      v = this.rm(hl);
      this.b = (this.b - 1) & 0xff;
      this.wz = (this.bc + step) & 0xffff;
      this.portOut(this.bc, v);
      this.hl = (hl + step) & 0xffff;
      k = v + this.l;
    }
    const b = this.b;
    let f = SZ[b] | ((v >> 6) & NF) | (k > 0xff ? HF | CF : 0) | PARITY[(k & 7) ^ b];
    if (rep && b) {
      if (kind === 2) this.nm(hl, 5); else this.nm(this.bc, 5);
      this.pc = start;
      this.wz = (start + 1) & 0xffff;
      // the flags while it repeats (as found by Patrik Rak and David Banks)
      f = (f & ~XYF) | ((start >> 8) & XYF);
      if (f & CF) {
        f &= ~HF;
        if (v & 0x80) {
          f ^= (PARITY[(b - 1) & 7] ^ PF) & PF;
          if ((b & 0x0f) === 0) f |= HF;
        } else {
          f ^= (PARITY[(b + 1) & 7] ^ PF) & PF;
          if ((b & 0x0f) === 0x0f) f |= HF;
        }
      } else {
        f ^= (PARITY[b & 7] ^ PF) & PF;
      }
    }
    this.f = f;
    this.qf = 1;
  }
}
