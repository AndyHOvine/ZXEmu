// The beeper and the AY: pitches, noise, envelopes, stereo placing, the ports on a 128K.
import { Sound } from '../../web/js/emu/sound.js';
import { makeMachine, makeChecker } from './util.mjs';

const { check, done } = makeChecker();

const RATE = 48000;

// samples of one second, made by `drive(sound, frameStartT)` each frame
function second(clock, frameLen, ay, drive) {
  const s = new Sound({ sampleRate: RATE, clock, ay });
  const frames = Math.round(clock / frameLen);
  const out = [];
  for (let f = 0; f < frames; f++) {
    drive(s, f * frameLen);
    s.endFrame(frameLen);
    out.push(...s.take());
  }
  return { s, left: out.filter((_, i) => !(i & 1)), right: out.filter((_, i) => i & 1) };
}

function crossings(x) {
  let n = 0;
  for (let i = 1; i < x.length; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) n++;
  return n;
}
const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);

// the beeper at 1 kHz: an edge every 1750 T-states of a 3.5 MHz frame
{
  const { left } = second(3500000, 69888, false, (s, base) => {
    for (let t = Math.ceil(base / 1750) * 1750; t < base + 69888; t += 1750) s.setBeeper(t - base, (t / 1750) & 1 ? 1 : 0);
  });
  const n = crossings(left.slice(RATE / 10));
  check('beeper 1 kHz', Math.abs(n - 1800) < 40, String(n));
}

// AY tone A at period 100: 1773450 / 1600 = 1108 Hz
{
  const { left, right } = second(3546900, 70908, true, (s, base) => {
    if (base) return;
    for (const [r, v] of [[0, 100], [1, 0], [7, 0x3e], [8, 15]]) { s.selectReg(r); s.writeReg(0, v); }
  });
  const n = crossings(left.slice(RATE / 10));
  check('AY tone 1108 Hz', Math.abs(n - 0.9 * 2 * 1108) < 40, String(n));
  check('AY channel A is on the left (ABC)', rms(left) > 2 * rms(right), `${rms(left)} ${rms(right)}`);
}

// noise only: many crossings, some sound
{
  const { left } = second(3546900, 70908, true, (s, base) => {
    if (base) return;
    for (const [r, v] of [[6, 1], [7, 0x37], [8, 15]]) { s.selectReg(r); s.writeReg(0, v); }
  });
  check('AY noise', crossings(left) > 3000 && rms(left) > 0.01, `${crossings(left)} ${rms(left)}`);
}

// envelope shape 14 (up and down) at period 1: the level climbs and falls, so it is heard
{
  const { left } = second(3546900, 70908, true, (s, base) => {
    if (base) return;
    for (const [r, v] of [[7, 0x3f], [8, 0x10], [11, 2], [12, 0], [13, 14]]) { s.selectReg(r); s.writeReg(0, v); }
  });
  check('AY envelope moves the level', rms(left) > 0.02, String(rms(left)));
}

// a 128K's ports: a register written through $FFFD/$BFFD reads back
{
  const m = makeMachine({ model: '128k' });
  m.ioWrite(0xfffd, 8);
  m.ioWrite(0xbffd, 0x0c);
  check('128K AY register reads back', m.ioRead(0xfffd) === 0x0c);
  const m48 = makeMachine({ model: '48k' });
  m48.ioWrite(0xfffd, 8);
  check('48K has no AY', !m48.psg.hasAy);
}

// the beeper from a program: OUT ($FE) every 100 loops makes a tone
{
  const m = makeMachine({ model: '48k' });
  // loop: xor $10; out ($fe),a; ld b,100; djnz $; jr loop
  m.onReady(() => m.injectBinary(Uint8Array.from([0xf3, 0xee, 0x10, 0xd3, 0xfe, 0x06, 0x64, 0x10, 0xfe, 0x18, 0xf6]), 0x8000, 0x8000));
  for (let i = 0; i < 120; i++) { m.runFrame(); m.psg.take(); }
  const out = [];
  for (let i = 0; i < 50; i++) { m.runFrame(); out.push(...m.psg.take()); }
  const left = out.filter((_, i) => !(i & 1));
  // a half period: 4+11+7 + 99*13 + 8 + 12 = 1329 T-states, so 3500000 / 2658 = 1317 Hz
  const n = crossings(left.slice(RATE / 10));
  check('a program\'s beeper tone', Math.abs(n - 0.9 * 2 * 1317) < 60, String(n));
}

done();
