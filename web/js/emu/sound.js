// The Spectrum's sound for ZXEmu, written for it in 2026. GPL v2 or later, see LICENSE.
//
// The beeper (the ULA's EAR and MIC bits, and the tape's sound heard through them) and, on
// the 128K models, the AY-3-8912. Both are worked out in steps of 16 T-states (8 AY clocks on
// a 128K, whose AY runs at half the CPU's clock) and averaged into samples. The machine calls
// update(t) before every change, so each lands at its T-state. The output is stereo, left and
// right interleaved, and is named `psg` on the machine, as AmsEmu's is.

const STEP = 16; // T-states a step
const HIGH_PASS_HZ = 15;
const LOW_PASS_HZ = 12000;

// the AY's volume levels (measured from a real chip, as ayumi uses them)
const AY_LEVELS = [0, 0.00999, 0.01445, 0.02106, 0.0307, 0.04555, 0.0645, 0.10736,
  0.12659, 0.20499, 0.29221, 0.37284, 0.49253, 0.63532, 0.80558, 1.0];

// the envelope shapes: two parts each (0 down, 1 up, 2 stay at the top, 3 stay at the bottom)
const ENV_SHAPES = [
  [0, 3], [0, 3], [0, 3], [0, 3], [1, 3], [1, 3], [1, 3], [1, 3],
  [0, 0], [0, 3], [0, 1], [0, 2], [1, 1], [1, 2], [1, 0], [1, 3],
];

const REG_MASK = [0xff, 0x0f, 0xff, 0x0f, 0xff, 0x0f, 0x1f, 0xff, 0x1f, 0x1f, 0x1f, 0xff, 0xff, 0x0f, 0xff, 0xff];

// stereo placing of A, B and C: [left, right] gains
const PANS = {
  abc: [[1, 0.15], [0.6, 0.6], [0.15, 1]],
  acb: [[1, 0.15], [0.15, 1], [0.6, 0.6]],
  mono: [[0.6, 0.6], [0.6, 0.6], [0.6, 0.6]],
};

export const STEREO_MODES = ['abc', 'acb', 'mono'];

export class Sound {
  constructor({ sampleRate = 48000, clock = 3500000, ay = false } = {}) {
    this.out = new Float32Array(16384);
    this.outLen = 0;
    this.enabled = true;
    this.clock = clock;
    this.hasAy = ay;
    this.regs = new Uint8Array(16);
    this.stereoMode = 'abc';
    this.setSampleRate(sampleRate);
    this.reset();
  }

  // AmsEmu's switch: true is ABC, false mono
  get stereo() { return this.stereoMode !== 'mono'; }
  set stereo(on) { this.stereoMode = on === true ? 'abc' : on === false ? 'mono' : STEREO_MODES.includes(on) ? on : 'abc'; }

  setSampleRate(rate) {
    this.sampleRate = rate;
    this.tps = this.clock / rate; // T-states a sample
    this.hpBeta = 1 - Math.exp((-2 * Math.PI * HIGH_PASS_HZ) / rate);
    this.lpBeta = 1 - Math.exp((-2 * Math.PI * LOW_PASS_HZ) / rate);
  }

  // the host's speed trim (factor near 1) to keep the sound card's queue steady
  setRateTrim(factor) {
    this.tps = (this.clock / this.sampleRate) * factor;
  }

  reset() {
    this.regs.fill(0);
    this.select = 0;
    this.toneCnt = [0, 0, 0];
    this.toneOut = [0, 0, 0];
    this.noiseCnt = 0;
    this.noiseRng = 1;
    this.noiseOut = 0;
    this.envCnt = 0;
    this.envShape = 0;
    this.envSeg = 0;
    this.envStep = 0;
    this.beeper = 0;
    this.lastT = 0; // T-state worked out to
    this.next = this.tps; // where the next sample ends
    this.sumL = 0; this.sumR = 0; this.sumN = 0;
    this.hpL = 0; this.hpR = 0; this.lpL = 0; this.lpR = 0;
  }

  // the beeper's level now (0 to 1), from T-state t
  setBeeper(t, level) {
    if (level === this.beeper) return;
    this.update(t);
    this.beeper = level;
  }

  selectReg(v) { this.select = v & 0x0f; }

  readReg() { return this.regs[this.select]; }

  writeReg(t, v) {
    this.update(t);
    const r = this.select;
    this.regs[r] = v & REG_MASK[r];
    if (r === 13) {
      this.envShape = v & 15;
      this.envSeg = 0;
      this.envStep = 0;
      this.envCnt = 0;
    }
  }

  envLevel() {
    switch (ENV_SHAPES[this.envShape][this.envSeg]) {
      case 0: return 15 - this.envStep;
      case 1: return this.envStep;
      case 2: return 15;
      default: return 0;
    }
  }

  // one step of the AY: 8 of its clocks
  ayStep() {
    const r = this.regs;
    for (let c = 0; c < 3; c++) {
      const period = (r[c * 2] | (r[c * 2 + 1] << 8)) || 1;
      if (++this.toneCnt[c] >= period) {
        this.toneCnt[c] = 0;
        this.toneOut[c] ^= 1;
      }
    }
    if (++this.noiseCnt >= ((r[6] || 1) << 1)) {
      this.noiseCnt = 0;
      const bit = (this.noiseRng ^ (this.noiseRng >> 3)) & 1;
      this.noiseRng = (this.noiseRng >> 1) | (bit << 16);
      this.noiseOut = this.noiseRng & 1;
    }
    if (++this.envCnt >= ((r[11] | (r[12] << 8)) || 1) << 1) {
      this.envCnt = 0;
      const kind = ENV_SHAPES[this.envShape][this.envSeg];
      if (kind < 2 && ++this.envStep > 15) {
        this.envStep = 0;
        this.envSeg ^= 1;
      }
    }
  }

  // works the sound out up to T-state t
  update(t) {
    let at = this.lastT;
    if (t <= at) return;
    const r = this.regs, ay = this.hasAy;
    const pans = PANS[this.stereoMode];
    const beep = this.beeper * 0.5;
    while (at + STEP <= t) {
      at += STEP;
      let l = beep, rr = beep;
      if (ay) {
        this.ayStep();
        const mix = r[7];
        let env = -1;
        for (let c = 0; c < 3; c++) {
          const on = ((this.toneOut[c] | ((mix >> c) & 1)) & (this.noiseOut | ((mix >> (c + 3)) & 1)));
          if (!on) continue;
          const vr = r[8 + c];
          let lev;
          if (vr & 0x10) { if (env < 0) env = this.envLevel(); lev = AY_LEVELS[env]; }
          else lev = AY_LEVELS[vr & 15];
          l += lev * pans[c][0] * 0.35;
          rr += lev * pans[c][1] * 0.35;
        }
      }
      this.sumL += l; this.sumR += rr; this.sumN++;
      if (at >= this.next) {
        this.next += this.tps;
        this.emit(this.sumL / this.sumN, this.sumR / this.sumN);
        this.sumL = this.sumR = 0; this.sumN = 0;
      }
    }
    this.lastT = at;
  }

  emit(l, r) {
    // a gentle low pass (the speaker), then take off the DC
    this.lpL += (l - this.lpL) * this.lpBeta;
    this.lpR += (r - this.lpR) * this.lpBeta;
    this.hpL += (this.lpL - this.hpL) * this.hpBeta;
    this.hpR += (this.lpR - this.hpR) * this.hpBeta;
    if (!this.enabled) return;
    if (this.outLen + 2 > this.out.length) {
      const bigger = new Float32Array(this.out.length * 2);
      bigger.set(this.out);
      this.out = bigger;
    }
    this.out[this.outLen++] = this.lpL - this.hpL;
    this.out[this.outLen++] = this.lpR - this.hpR;
  }

  // the end of a frame of frameLen T-states
  endFrame(frameLen) {
    this.update(frameLen);
    this.lastT -= frameLen;
    this.next -= frameLen;
  }

  // the samples made since the last take (stereo, interleaved)
  take() {
    const s = this.out.subarray(0, this.outLen);
    this.outLen = 0;
    return s;
  }

  saveState() {
    return {
      regs: this.regs.slice(), select: this.select, toneCnt: this.toneCnt.slice(), toneOut: this.toneOut.slice(),
      noiseCnt: this.noiseCnt, noiseRng: this.noiseRng, noiseOut: this.noiseOut, envCnt: this.envCnt,
      envShape: this.envShape, envSeg: this.envSeg, envStep: this.envStep, beeper: this.beeper, lastT: this.lastT,
    };
  }

  loadState(s) {
    this.regs.set(s.regs);
    Object.assign(this, { ...s, regs: this.regs, toneCnt: s.toneCnt.slice(), toneOut: s.toneOut.slice() });
    this.next = this.lastT + this.tps;
    this.sumL = this.sumR = this.sumN = 0;
  }
}
