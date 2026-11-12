// The Spectrum Next's sound for ZXEmu, written for it in 2026. GPL v2 or later, see LICENSE.
//
// TurboSound (three AY chips, chosen and panned through port $FFFD), the four 8-bit DACs
// (A and B on the left, C and D on the right) and the beeper, mixed at the levels of the
// Next's mixer (audio_mixer.vhd): beeper 512, an AY channel 0-255 through the Next's level
// table, a DAC side (A + B) x 4. docs/next-system.md section 6 has the rules.

import { Sound } from './sound.js';

// the Next's AY levels (turbosound.vhd), 0-255
const LEVELS = [0x00, 0x03, 0x04, 0x06, 0x0a, 0x0f, 0x15, 0x22, 0x28, 0x41, 0x5b, 0x72, 0x90, 0xb5, 0xd7, 0xff];
const ENV_SHAPES = [
  [0, 3], [0, 3], [0, 3], [0, 3], [1, 3], [1, 3], [1, 3], [1, 3],
  [0, 0], [0, 3], [0, 1], [0, 2], [1, 1], [1, 2], [1, 0], [1, 3],
];
const AY_MASK = [0xff, 0x0f, 0xff, 0x0f, 0xff, 0x0f, 0x1f, 0xff, 0x1f, 0x1f, 0x1f, 0xff, 0xff, 0x0f, 0xff, 0xff];
const STEP = 16;
const SCALE = 1 / 1200; // the mixer's units to the sound card's

function newChip() {
  return {
    regs: new Uint8Array(16), select: 0, toneCnt: [0, 0, 0], toneOut: [0, 0, 0], noiseCnt: 0, noiseRng: 1, noiseOut: 0,
    envCnt: 0, envShape: 0, envSeg: 0, envStep: 0,
  };
}

function envLevel(c) {
  switch (ENV_SHAPES[c.envShape][c.envSeg]) {
    case 0: return 15 - c.envStep;
    case 1: return c.envStep;
    case 2: return 15;
    default: return 0;
  }
}

function chipStep(c) {
  const r = c.regs;
  for (let k = 0; k < 3; k++) {
    const period = (r[k * 2] | (r[k * 2 + 1] << 8)) || 1;
    if (++c.toneCnt[k] >= period) { c.toneCnt[k] = 0; c.toneOut[k] ^= 1; }
  }
  if (++c.noiseCnt >= ((r[6] || 1) << 1)) {
    c.noiseCnt = 0;
    const bit = (c.noiseRng ^ (c.noiseRng >> 3)) & 1;
    c.noiseRng = (c.noiseRng >> 1) | (bit << 16);
    c.noiseOut = c.noiseRng & 1;
  }
  if (++c.envCnt >= ((r[11] | (r[12] << 8)) || 1) << 1) {
    c.envCnt = 0;
    if (ENV_SHAPES[c.envShape][c.envSeg] < 2 && ++c.envStep > 15) { c.envStep = 0; c.envSeg ^= 1; }
  }
}

export class NextSound extends Sound {
  constructor(opts = {}) {
    super({ ...opts, ay: true });
    this.chips = [newChip(), newChip(), newChip()];
    this.nextReset();
  }

  nextReset() {
    this.chips = [newChip(), newChip(), newChip()];
    this.active = 0;
    this.pan = [3, 3, 3]; // bit 1 left, bit 0 right
    this.dac = [0x80, 0x80, 0x80, 0x80];
    this.turbo = false; // NR $08 bit 1
    this.acb = false; // NR $08 bit 5
    this.mono = [0, 0, 0]; // NR $09 bits 5-7
    this.ym = false; // NR $06 bit 0 = 0: YM (all 8 bits of a register read back)
  }

  // port $FFFD: a register of the chip in use, or (TurboSound on) the chip and its panning
  selectReg(v) {
    if ((v & 0xe0) === 0) { this.chips[this.active].select = v & 0x1f; return; }
    if (this.turbo && v & 0x80 && ((v >> 2) & 7) === 7) {
      const chip = [0, 2, 1, 0][v & 3];
      this.pan[chip] = (v >> 5) & 3;
      this.active = chip;
    }
  }

  readReg() {
    const c = this.chips[this.active];
    if (c.select > 15) return this.ym ? 0xff : 0;
    return this.ym ? c.regs[c.select] : c.regs[c.select] & AY_MASK[c.select];
  }

  writeReg(t, v) {
    this.update(t);
    const c = this.chips[this.active];
    if (c.select > 15) return;
    c.regs[c.select] = v;
    if (c.select === 13) { c.envShape = v & 15; c.envSeg = 0; c.envStep = 0; c.envCnt = 0; }
  }

  setDac(t, ch, v) {
    if (this.dac[ch] === v) return;
    this.update(t);
    this.dac[ch] = v;
  }

  update(t) {
    let at = this.lastT;
    if (t <= at) return;
    const beep = this.beeper * (512 / 0.75);
    while (at + STEP <= t) {
      at += STEP;
      let l = beep, r = beep;
      for (let k = 0; k < 3; k++) {
        const c = this.chips[k];
        chipStep(c);
        if (!this.turbo && k !== this.active) continue;
        const reg = c.regs, mix = reg[7];
        const lv = [0, 0, 0];
        let env = -1;
        for (let ch = 0; ch < 3; ch++) {
          const on = (c.toneOut[ch] | ((mix >> ch) & 1)) & (c.noiseOut | ((mix >> (ch + 3)) & 1));
          if (!on) continue;
          const vr = reg[8 + ch];
          if (vr & 0x10) { if (env < 0) env = envLevel(c); lv[ch] = LEVELS[env]; } else lv[ch] = LEVELS[vr & 15];
        }
        let cl, cr;
        if (this.mono[k]) cl = cr = lv[0] + lv[1] + lv[2];
        else if (this.acb) { cl = lv[0] + lv[2]; cr = lv[1] + lv[2]; }
        else { cl = lv[0] + lv[1]; cr = lv[2] + lv[1]; }
        if (this.pan[k] & 2) l += cl;
        if (this.pan[k] & 1) r += cr;
      }
      l += (this.dac[0] + this.dac[1]) * 4;
      r += (this.dac[2] + this.dac[3]) * 4;
      this.sumL += l * SCALE; this.sumR += r * SCALE; this.sumN++;
      if (at >= this.next) {
        this.next += this.tps;
        this.emit(this.sumL / this.sumN, this.sumR / this.sumN);
        this.sumL = this.sumR = 0; this.sumN = 0;
      }
    }
    this.lastT = at;
  }

  saveState() {
    const s = super.saveState();
    s.nextSound = {
      chips: this.chips.map((c) => ({ ...c, regs: c.regs.slice(), toneCnt: c.toneCnt.slice(), toneOut: c.toneOut.slice() })),
      active: this.active, pan: this.pan.slice(), dac: this.dac.slice(), turbo: this.turbo, acb: this.acb, mono: this.mono.slice(), ym: this.ym,
    };
    return s;
  }

  loadState(s) {
    super.loadState(s);
    const n = s.nextSound;
    if (!n) return;
    this.chips = n.chips.map((c) => ({ ...c, regs: Uint8Array.from(c.regs), toneCnt: c.toneCnt.slice(), toneOut: c.toneOut.slice() }));
    Object.assign(this, { active: n.active, pan: n.pan.slice(), dac: n.dac.slice(), turbo: n.turbo, acb: n.acb, mono: n.mono.slice(), ym: n.ym });
  }
}
