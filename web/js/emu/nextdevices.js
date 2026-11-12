// The Spectrum Next's interrupt controller, copper, CTC and DMA for ZXEmu, written for it in
// 2026. GPL v2 or later, see LICENSE.
//
// Rules from the Next's FPGA source, written up in docs/next-system.md. Times: the machine's
// T-states (the ULA's 3.5 MHz) counted from power-on (`abs`), and the 28 MHz clock's ticks
// (8 to a T-state) for the copper and the CTC.

// ---------------------------------------------------------------- interrupts
// sources by priority (and vector index): 0 the line, 3-6 the CTC's channels, 11 the ULA
export const INT_LINE = 0, INT_CTC = 3, INT_ULA = 11;
const IDLE = 0, REQ = 1, ISR = 2;

export class Interrupts {
  constructor(m) {
    this.m = m;
    this.status = new Uint8Array(16);
    this.enabled = new Uint8Array(16);
    this.dmaInt = new Uint8Array(16); // NR $CC-$CD: the DMA gives way to these
    this.state = new Uint8Array(16); // hardware IM2: each source's daisy-chain state
    this.reset();
  }

  reset() {
    this.status.fill(0);
    this.enabled.fill(0);
    this.enabled[INT_ULA] = 1;
    this.dmaInt.fill(0);
    this.state.fill(0);
    this.pulseAt = -1e12; // where the last /INT pulse began
  }

  get hardware() { return (this.m.nr[0xc0] & 1) !== 0; }

  // a source's request at T-state `at` (forced by NR $20: whatever its enable)
  fire(idx, at, force = false) {
    this.status[idx] = 1;
    if (!this.enabled[idx] && !force) return;
    // (a source being served stays so until its RETI: a request meanwhile is lost)
    if (this.hardware && !(idx === INT_ULA && this.m.cpu.im !== 2)) { if (this.state[idx] === IDLE) this.state[idx] = REQ; }
    else this.pulseAt = at; // pulse mode (and the ULA in hardware mode while the Z80 isn't in IM 2)
  }

  // the pulse: 32 or 36 CPU cycles from its start
  get pulsing() {
    const m = this.m, cpu = m.cpu;
    const d = m.tBase + cpu.t - this.pulseAt;
    return d >= 0 && d * cpu.mult + cpu.tRem < m.timing.intLen;
  }

  // /INT is held now: pulse mode's pulse (and the ULA's while the Z80 isn't in IM 2), or in
  // hardware IM 2 the daisy chain alone
  asserted() {
    if (!this.hardware || this.m.cpu.im !== 2) return this.pulsing;
    for (let i = 0; i < 16; i++) {
      if (this.state[i] === ISR) return false; // the lower ones wait for its RETI
      if (this.state[i] === REQ) return true;
    }
    return false;
  }

  // the acknowledge in IM 2: the vector on the bus
  vector() {
    if (!this.hardware) return 0xff;
    for (let i = 0; i < 16; i++) {
      if (this.state[i] === ISR) break;
      if (this.state[i] === REQ) {
        this.state[i] = ISR;
        return (this.m.nr[0xc0] & 0xe0) | (i << 1);
      }
    }
    return 0xff;
  }

  reti() {
    if (!this.hardware) return;
    for (let i = 0; i < 16; i++) {
      if (this.state[i] === ISR) { this.state[i] = IDLE; return; }
    }
  }

  // NR $C8 / $C9 status (a pending request reads as set); a write of 1 clears
  statusByte(reg) {
    const s = (i) => (this.status[i] || this.state[i] !== IDLE ? 1 : 0);
    if (reg === 0xc8) return (s(INT_LINE) << 1) | s(INT_ULA);
    if (reg === 0xc9) { let v = 0; for (let c = 0; c < 4; c++) v |= s(INT_CTC + c) << c; return v; }
    return 0;
  }

  clearStatus(reg, v) {
    if (reg === 0xc8) { if (v & 2) this.status[INT_LINE] = 0; if (v & 1) this.status[INT_ULA] = 0; }
    if (reg === 0xc9) for (let c = 0; c < 4; c++) if (v & (1 << c)) this.status[INT_CTC + c] = 0;
  }

  // the DMA stops while one of its NR $CC-$CD sources is pending or being served
  get holdsDma() {
    if (!this.hardware) return false;
    for (let i = 0; i < 16; i++) if (this.dmaInt[i] && this.state[i] !== IDLE) return true;
    return false;
  }

  saveState() { return { status: this.status.slice(), enabled: this.enabled.slice(), dmaInt: this.dmaInt.slice(), state: this.state.slice(), pulseAt: this.pulseAt }; }

  loadState(s) {
    this.status.set(s.status); this.enabled.set(s.enabled); this.dmaInt.set(s.dmaInt); this.state.set(s.state);
    this.pulseAt = s.pulseAt;
  }
}

// ---------------------------------------------------------------- the copper
// 1024 instructions: WAIT (1 hhhhhh vvvvvvvvv: line v, then 8-pixel column h from the paper's
// left) and MOVE (0 rrrrrrr dddddddd: Next register r, $00-$7F, gets d; r = 0 is a NOP). One
// instruction a 28 MHz cycle, a MOVE two.
export class Copper {
  constructor(m) {
    this.m = m;
    this.list = new Uint8Array(2048);
    this.reset();
  }

  reset() {
    this.addr = 0; // the CPU's write address, in bytes
    this.pc = 0; // the copper's, in instructions
    this.mode = 0;
    this.latch = 0;
    this.at = 0; // the 28 MHz tick it has run to
  }

  write(v) { this.list[this.addr] = v; this.addr = (this.addr + 1) & 0x7ff; }

  // NR $63: a whole instruction at once (the first byte is held until the second)
  write16(v) {
    if (!(this.addr & 1)) this.latch = v;
    else { this.list[this.addr - 1] = this.latch; this.list[this.addr] = v; }
    this.addr = (this.addr + 1) & 0x7ff;
  }

  setAddrLow(v) { this.addr = (this.addr & 0x700) | v; }

  control(v, ticks) {
    this.addr = (this.addr & 0xff) | ((v & 7) << 8);
    const mode = v >> 6;
    if (mode !== this.mode) {
      this.runTo(ticks);
      this.mode = mode;
      if (mode === 1 || mode === 3) this.pc = 0;
      this.at = ticks + 1;
    }
  }

  controlByte() { return (this.mode << 6) | (this.addr >> 8); }

  // the 28 MHz tick of line v (copper numbering), pixel column hc, at or after tick `from`
  lineTick(v, hc, from) {
    const m = this.m;
    const t = m.rasterT(v, hc);
    if (t < 0) return Infinity;
    const frame = m.frameLen * 8;
    let at = (m.tBase + t) * 8;
    while (at < from) at += frame;
    while (at - frame >= from) at -= frame;
    return at;
  }

  runTo(ticks) {
    if (this.mode === 0) { this.at = ticks; return; }
    const m = this.m;
    const lineTicks = m.timing.line * 8, maxHc = m.timing.line * 2 - 1;
    // mode 3 starts again at line 0, pixel column 0, every frame
    let restart = this.mode === 3 ? this.lineTick(0, 0, this.at) : Infinity;
    let guard = 0;
    while (this.at < ticks && guard++ < 200000) {
      if (this.at >= restart) {
        this.pc = 0;
        restart = this.lineTick(0, 0, this.at + 1);
      }
      const o = this.pc * 2, hi = this.list[o], lo = this.list[o + 1];
      if (hi & 0x80) { // WAIT: passes on line v once the beam is at column h or later
        const v = ((hi & 1) << 8) | lo, hc = ((hi >> 1) & 0x3f) * 8 + 12;
        let when = Infinity;
        if (hc <= maxHc) {
          const start = this.lineTick(v, 0, this.at - lineTicks + 1); // line v now, or the next one
          const match = start + hc * 4;
          when = this.at >= match ? this.at : match;
        }
        if (Math.min(when, restart) > ticks) { this.at = ticks; return; }
        if (restart <= when) { this.at = restart; continue; }
        this.at = when + 1;
        this.pc = (this.pc + 1) & 1023;
      } else { // MOVE
        const r = hi & 0x7f;
        if (r) {
          m.nextRegWrite(r, lo, this.at / 8 - m.tBase, true);
          this.at += 2;
        } else this.at += 1;
        this.pc = (this.pc + 1) & 1023;
      }
    }
    if (this.at < ticks) this.at = ticks;
  }

  saveState() { return { list: this.list.slice(), addr: this.addr, pc: this.pc, mode: this.mode, latch: this.latch, at: this.at }; }

  loadState(s) { this.list.set(s.list); Object.assign(this, { addr: s.addr, pc: s.pc, mode: s.mode, latch: s.latch, at: s.at }); }
}

// ---------------------------------------------------------------- the CTC
// 4 channels on the 28 MHz clock (ports $183B-$1B3B); timers (÷16 or ÷256 times the time
// constant) or counters of the channel before's zero counts (a ring: 3 → 0 → 1 → 2 → 3).
const STOPPED = 0, WAIT_TC = 1, RUNNING = 2, WAIT_TRIGGER = 3;

export class Ctc {
  constructor(m) {
    this.m = m;
    this.ch = [0, 1, 2, 3].map(() => ({}));
    this.reset();
  }

  reset() {
    for (const c of this.ch) Object.assign(c, { ctrl: 0, tc: 256, count: 256, state: STOPPED, next: Infinity, newTc: false });
  }

  presc(c) { return c.ctrl & 0x20 ? 256 : 16; }
  counter(c) { return (c.ctrl & 0x40) !== 0; }

  write(n, v, ticks) {
    this.advance(ticks);
    const c = this.ch[n];
    if (c.state === WAIT_TC || c.newTc) {
      c.tc = v || 256;
      if (c.newTc) { c.newTc = false; return; } // used at the next reload
      c.count = c.tc;
      if (this.counter(c)) { c.state = RUNNING; c.next = Infinity; }
      else if (c.ctrl & 8) { c.state = WAIT_TRIGGER; c.next = Infinity; }
      else { c.state = RUNNING; c.next = ticks + this.presc(c) * c.count; }
      return;
    }
    if (!(v & 1)) return; // a vector: not used on the Next
    c.ctrl = v;
    this.m.ints.enabled[3 + n] = v & 0x80 ? 1 : 0;
    if (v & 2) { c.state = v & 4 ? WAIT_TC : STOPPED; c.next = Infinity; c.newTc = false; }
    else if (v & 4) { if (c.state === RUNNING) c.newTc = true; else c.state = WAIT_TC; }
  }

  read(n, ticks) {
    this.advance(ticks);
    const c = this.ch[n];
    if (c.state !== RUNNING) return c.count & 0xff;
    if (this.counter(c)) return c.count & 0xff;
    return Math.max(1, Math.ceil((c.next - ticks) / this.presc(c))) & 0xff;
  }

  // NR $C5: the channels' interrupt enables
  setEnables(v) {
    for (let n = 0; n < 4; n++) {
      const c = this.ch[n];
      c.ctrl = (c.ctrl & 0x7f) | (v & (1 << n) ? 0x80 : 0);
      this.m.ints.enabled[3 + n] = v & (1 << n) ? 1 : 0;
    }
  }

  get nextEvent() {
    let n = Infinity;
    for (const c of this.ch) if (c.state === RUNNING && c.next < n) n = c.next;
    return n;
  }

  advance(ticks) {
    for (let guard = 0; guard < 10000; guard++) {
      let best = -1, at = Infinity;
      for (let n = 0; n < 4; n++) {
        const c = this.ch[n];
        if (c.state === RUNNING && c.next <= ticks && c.next < at) { at = c.next; best = n; }
      }
      if (best < 0) return;
      const c = this.ch[best];
      c.count = c.tc;
      c.next += this.presc(c) * c.tc;
      this.zero(best, at, 0);
    }
  }

  // channel n reached zero at tick `at`: its interrupt, and the next channel's clock
  zero(n, at, depth) {
    this.m.ints.fire(INT_CTC + n, at / 8);
    if (depth > 4) return;
    const k = (n + 1) & 3, c = this.ch[k];
    if (c.state === WAIT_TRIGGER) {
      c.state = RUNNING;
      c.next = at + this.presc(c) * c.count;
    } else if (c.state === RUNNING && this.counter(c)) {
      if (--c.count <= 0) {
        c.count = c.tc;
        this.zero(k, at, depth + 1);
      }
    }
  }

  saveState() { return this.ch.map((c) => ({ ...c })); }

  loadState(s) { s.forEach((c, i) => Object.assign(this.ch[i], c)); }
}

// ---------------------------------------------------------------- the DMA
// zxnDMA (port $6B) and the Zilog-like form (port $0B, whose length is one more): WR0-WR6, one
// byte at a time over the bus while the CPU waits; burst mode lets the CPU run between bytes,
// which the prescaler paces (32 28 MHz ticks a unit).
const CYCLES = [4, 3, 2, 4];

export class Dma {
  constructor(m) {
    this.m = m;
    this.reset(true);
  }

  reset(hard = false) {
    if (hard) {
      Object.assign(this, { aAddr: 0, bAddr: 0, length: 0, aToB: true, aIO: false, bIO: false, aStep: 1, bStep: 1, mode: 1, mask: 0x7f, zilog: false });
    }
    Object.assign(this, { aTiming: 1, bTiming: 1, prescaler: 0, autoRestart: false, active: false, holding: false, ended: false, moved: false });
    this.expect = [];
    this.wedged = false;
    this.readSeq = 0;
    this.src = 0; this.dst = 0; this.counter = 0; this.done = 0;
    this.nextByte = 0;
  }

  // a byte written to port $6B (or $0B)
  write(v, zilog) {
    this.zilog = zilog;
    if (this.wedged) return;
    if (this.expect.length) { this.expect.shift()(v); return; }
    const follow = [];
    if (!(v & 0x80)) {
      if (v & 3) { // WR0
        this.aToB = (v & 4) !== 0;
        if (v & 8) follow.push((b) => { this.aAddr = (this.aAddr & 0xff00) | b; });
        if (v & 0x10) follow.push((b) => { this.aAddr = (this.aAddr & 0xff) | (b << 8); });
        if (v & 0x20) follow.push((b) => { this.length = (this.length & 0xff00) | b; });
        if (v & 0x40) follow.push((b) => { this.length = (this.length & 0xff) | (b << 8); });
      } else { // WR1 (port A) or WR2 (port B)
        const a = (v & 4) !== 0, io = (v & 8) !== 0, step = (v & 0x20) ? 0 : v & 0x10 ? 1 : -1;
        if (a) { this.aIO = io; this.aStep = step; } else { this.bIO = io; this.bStep = step; }
        if (v & 0x40) {
          follow.push((t) => {
            if (a) this.aTiming = t & 3; else this.bTiming = t & 3;
            if (t & 0x20) this.expect.unshift((p) => { if (!a) this.prescaler = p; });
          });
        }
      }
    } else {
      switch (v & 3) {
        case 0: // WR3
          if (v & 8) follow.push(() => {});
          if (v & 0x10) follow.push(() => {});
          if (v & 0x40) this.enable();
          break;
        case 1: // WR4
          this.mode = (v >> 5) & 3;
          if (v & 4) follow.push((b) => { this.bAddr = (this.bAddr & 0xff00) | b; });
          if (v & 8) follow.push((b) => { this.bAddr = (this.bAddr & 0xff) | (b << 8); });
          if (v & 0x10 && !(v & 0x0c)) this.wedged = true; // as the core: no way out but a reset
          break;
        case 2:
          if (!(v & 4) && !(v & 0x40)) this.autoRestart = (v & 0x20) !== 0; // WR5
          break;
        default: this.command(v);
      }
    }
    this.expect.push(...follow);
  }

  command(v) {
    switch (v) {
      case 0xc3: this.reset(false); break;
      case 0xc7: this.aTiming = 1; break;
      case 0xcb: this.bTiming = 1; break;
      case 0xcf: this.load(); break;
      case 0xd3: this.counter = this.zilog ? 0xffff : 0; this.done = 0; this.ended = false; break;
      case 0x87: this.enable(); break;
      case 0x83: this.active = false; this.holding = false; break;
      case 0xbf: this.readSeq = 0; break;
      case 0x8b: this.ended = false; this.moved = false; break;
      case 0xa7: this.readSeq = 0; this.skipToMasked(); break;
      case 0xbb: this.expect.push((b) => { this.mask = b & 0x7f; this.readSeq = 0; this.skipToMasked(); }); break;
      default:
    }
  }

  load() {
    this.src = this.aToB ? this.aAddr : this.bAddr;
    this.dst = this.aToB ? this.bAddr : this.aAddr;
    this.counter = this.zilog ? 0xffff : 0;
    this.done = 0;
    this.ended = false;
  }

  enable() {
    this.active = true;
    this.holding = true;
    this.nextByte = this.m.tBase + this.m.cpu.t;
  }

  get total() { return this.zilog ? this.length + 1 : Math.max(this.length, 1); }

  skipToMasked() {
    for (let i = 0; i < 7 && !(this.mask & (1 << this.readSeq)); i++) this.readSeq = (this.readSeq + 1) % 7;
  }

  read() {
    const items = [
      () => 0x1a | (this.ended ? 0 : 0x20) | (this.active && this.moved ? 1 : 0),
      () => this.counter & 0xff, () => this.counter >> 8,
      () => (this.aToB ? this.src : this.dst) & 0xff, () => (this.aToB ? this.src : this.dst) >> 8,
      () => (this.aToB ? this.dst : this.src) & 0xff, () => (this.aToB ? this.dst : this.src) >> 8,
    ];
    if (!this.mask) return 0;
    this.skipToMasked();
    const v = items[this.readSeq]();
    this.readSeq = (this.readSeq + 1) % 7;
    this.skipToMasked();
    return v;
  }

  // one byte over the bus (the CPU waiting); its time is added to the CPU's
  step() {
    const m = this.m, cpu = m.cpu;
    const start = m.tBase + cpu.t;
    const srcIO = this.aToB ? this.aIO : this.bIO, dstIO = this.aToB ? this.bIO : this.aIO;
    const srcStep = this.aToB ? this.aStep : this.bStep, dstStep = this.aToB ? this.bStep : this.aStep;
    let cycles = CYCLES[this.aToB ? this.aTiming : this.bTiming] + CYCLES[this.aToB ? this.bTiming : this.aTiming];
    let v;
    if (srcIO) v = m.ioRead(this.src);
    else { v = m.read(this.src); cycles += cpu.rwait[this.src >> 13]; }
    if (dstIO) m.ioWrite(this.dst, v);
    else m.write(this.dst, v);
    m.cpuCycles(cycles);
    this.src = (this.src + srcStep) & 0xffff;
    this.dst = (this.dst + dstStep) & 0xffff;
    this.counter = (this.counter + 1) & 0xffff;
    this.moved = true;
    if (++this.done >= this.total) {
      this.ended = true;
      if (this.autoRestart) this.load();
      else { this.active = false; this.holding = false; return; }
    }
    // the prescaler: each byte starts prescaler × 32 ticks (× 4 T-states) after the last
    if (this.prescaler) {
      this.nextByte = start + this.prescaler * 4;
      if (this.mode === 2) this.holding = false; // burst: the CPU runs until then
      else {
        const now = m.tBase + cpu.t;
        if (this.nextByte > now) cpu.t += Math.ceil(this.nextByte - now); // continuous: the CPU still waits
      }
    } else if (this.mode === 0 || this.mode === 2) {
      this.nextByte = m.tBase + cpu.t;
      this.holding = false; // byte mode (and burst without a prescaler): an instruction between bytes
    }
  }

  // between CPU steps: take the bus back when the next byte is due
  service(now) {
    if (this.active && !this.holding && now >= this.nextByte) {
      this.holding = true;
      this.m.cpuCycles(2); // picking the bus up
    }
  }

  saveState() {
    const s = {};
    for (const k of ['aAddr', 'bAddr', 'length', 'aToB', 'aIO', 'bIO', 'aStep', 'bStep', 'mode', 'mask', 'zilog', 'aTiming', 'bTiming', 'prescaler', 'autoRestart', 'active', 'holding', 'ended', 'moved', 'wedged', 'readSeq', 'src', 'dst', 'counter', 'done', 'nextByte']) s[k] = this[k];
    return s;
  }

  loadState(s) { if (s && typeof s === 'object') Object.assign(this, s); this.expect = []; }
}
