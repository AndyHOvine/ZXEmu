// The Z80: T-states of every kind of instruction, the 48K's memory and I/O contention, and
// Patrik Rak's z80test suite (all flags, MEMPTR, SCF/CCF) loaded from tape and run on a 48K.
import fs from 'node:fs';
import { Z80 } from '../../web/js/emu/z80.js';
import { makeMachine, screenText, makeChecker } from './util.mjs';
import { planAutostart } from '../../web/js/emu/autostart.js';

const { check, done } = makeChecker();

// ---- T-states, no contention
const mem = new Uint8Array(65536);
const cpu = new Z80({ read: (a) => mem[a], write: (a, v) => { mem[a] = v; }, ioRead: () => 0xff, ioWrite: () => {}, intVector: () => 0xff });
cpu.intLen = 0;
cpu.ioContended = false;

function time(bytes, f = 0, setup = {}) {
  mem.fill(0);
  mem.set(bytes, 0x8000);
  cpu.reset();
  Object.assign(cpu, { pc: 0x8000, sp: 0xf000, f, b: 2, c: 0, d: 0x90, e: 0, h: 0x90, l: 0, ix: 0x9000, iy: 0x9000 }, setup);
  cpu.t = 0;
  cpu.step();
  return cpu.t;
}

const COND = 'c';
const MAIN = [
  [4, 10, 7, 6, 4, 4, 7, 4, 4, 11, 7, 6, 4, 4, 7, 4],
  [13, 10, 7, 6, 4, 4, 7, 4, 12, 11, 7, 6, 4, 4, 7, 4],
  [COND, 10, 16, 6, 4, 4, 7, 4, COND, 11, 16, 6, 4, 4, 7, 4],
  [COND, 10, 13, 6, 11, 11, 10, 4, COND, 11, 13, 6, 4, 4, 7, 4],
];
// taken / not taken for each conditional opcode with F = 0 (NZ NC PO P all true)
const CONDS = { 0x20: [12, 7], 0x28: [7, 12], 0x30: [12, 7], 0x38: [7, 12] };
for (const cc of [0xc0, 0xd0, 0xe0, 0xf0]) { CONDS[cc] = [11, 5]; CONDS[cc + 8] = [5, 11]; CONDS[cc + 4] = [17, 10]; CONDS[cc + 12] = [10, 17]; }
const ROWC = {
  0xc0: [COND, 10, 10, 10, COND, 11, 7, 11, COND, 10, 10, -1, COND, 17, 7, 11],
  0xd0: [COND, 10, 10, 11, COND, 11, 7, 11, COND, 4, 10, 11, COND, -1, 7, 11],
  0xe0: [COND, 10, 10, 19, COND, 11, 7, 11, COND, 4, 10, 4, COND, -1, 7, 11],
  0xf0: [COND, 10, 10, 4, COND, 11, 7, 11, COND, 6, 10, 4, COND, -1, 7, 11],
};
let wrong = [];
for (let op = 0; op < 256; op++) {
  let want;
  if (op < 0x40) want = MAIN[op >> 4][op & 15];
  else if (op < 0x80) want = op === 0x76 ? 4 : (op & 7) === 6 || (op >= 0x70 && op < 0x78) ? 7 : 4;
  else if (op < 0xc0) want = (op & 7) === 6 ? 7 : 4;
  else want = ROWC[op & 0xf0][op & 15];
  if (want === -1) continue;
  const bytes = [op, 0x00, 0x80, 0];
  if (want === COND) {
    const [ifZero, ifOnes] = CONDS[op];
    const a = time(bytes, 0), b = time(bytes, 0xff);
    if (a !== ifZero || b !== ifOnes) wrong.push(`${op.toString(16)}: ${a}/${b} not ${ifZero}/${ifOnes}`);
  } else {
    const got = time(bytes, 0);
    if (got !== want) wrong.push(`${op.toString(16)}: ${got} not ${want}`);
  }
}
check('unprefixed T-states', !wrong.length, wrong.join(', '));

const PREFIXED = [
  [[0xcb, 0x00], 8], [[0xcb, 0x06], 15], [[0xcb, 0x46], 12], [[0xcb, 0xc6], 15],
  [[0xed, 0x40], 12], [[0xed, 0x41], 12], [[0xed, 0x42], 15], [[0xed, 0x43, 0, 0x90], 20], [[0xed, 0x44], 8],
  [[0xed, 0x45], 14], [[0xed, 0x46], 8], [[0xed, 0x47], 9], [[0xed, 0x57], 9], [[0xed, 0x67], 18], [[0xed, 0x6f], 18],
  [[0xed, 0xa0], 16], [[0xed, 0xa1], 16], [[0xed, 0xa2], 16], [[0xed, 0xa3], 16], [[0xed, 0x00], 8],
  [[0xdd, 0x21, 0, 0], 14], [[0xdd, 0x22, 0, 0x90], 20], [[0xdd, 0x2a, 0, 0x90], 20], [[0xdd, 0x23], 10],
  [[0xdd, 0x09], 15], [[0xdd, 0x34, 1], 23], [[0xdd, 0x36, 1, 2], 19], [[0xdd, 0x46, 1], 19], [[0xdd, 0x70, 1], 19],
  [[0xdd, 0x86, 1], 19], [[0xdd, 0xe1], 14], [[0xdd, 0xe5], 15], [[0xdd, 0xe3], 23], [[0xdd, 0xe9], 8], [[0xdd, 0xf9], 10],
  [[0xdd, 0x44], 8], [[0xfd, 0xcb, 1, 0x06], 23], [[0xfd, 0xcb, 1, 0x46], 20], [[0xdd, 0x00], 8],
];
wrong = [];
for (const [bytes, want] of PREFIXED) {
  const got = time(bytes, 0, { b: 1, c: 1 });
  if (got !== want) wrong.push(`${bytes.map((b) => b.toString(16)).join(' ')}: ${got} not ${want}`);
}
check('prefixed T-states', !wrong.length, wrong.join(', '));
check('LDIR repeating 21', time([0xed, 0xb0], 0, { b: 0, c: 2 }) === 21);
check('LDIR last 16', time([0xed, 0xb0], 0, { b: 0, c: 1 }) === 16);

// interrupts: IM 1 13 T-states, IM 2 19
for (const [im, want] of [[1, 13], [2, 19]]) {
  mem.fill(0);
  cpu.reset();
  Object.assign(cpu, { pc: 0x8000, sp: 0xf000, im, iff1: 1, iff2: 1, i: 0x90 });
  cpu.intLen = 32;
  cpu.t = 0;
  cpu.interrupt();
  check(`IM ${im} interrupt takes ${want}`, cpu.t === want, String(cpu.t));
  cpu.intLen = 0;
}

// ---- contention on a 48K
{
  const m = makeMachine({ model: '48k' });
  const c = m.cpu;
  const at = (t0, bytes, regs = {}) => {
    bytes.forEach((b, i) => m.poke(0x8000 + i, b));
    Object.assign(c, { pc: 0x8000, halted: 0, iff1: 0, h: 0x40, l: 0, b: 0x40, c: 0xfe, a: 0x40 }, regs);
    c.t = t0;
    c.step();
    return c.t - t0;
  };
  // LD A,(HL) with its read at 14335, the first contended T-state: 6 more
  check('48K read at 14335 waits 6', at(14331, [0x7e]) === 13);
  check('48K read at 14341 waits 0', at(14337, [0x7e]) === 7);
  check('48K read in the border waits 0', at(100, [0x7e]) === 7);
  // code in contended memory: the opcode fetch waits too
  m.poke(0x4000, 0x00);
  Object.assign(c, { pc: 0x4000 });
  c.t = 14335;
  c.step();
  check('48K NOP fetched at 14335 takes 10', c.t - 14335 === 10);
  // OUT ($FE),A: a ULA port, high byte $40 contended: C:1, C:3
  check('48K OUT to the ULA from contended memory', at(14331, [0xd3, 0xfe], { a: 0x40 }) > 11);
  check('48K OUT to the ULA in the border', at(100, [0xd3, 0xfe], { a: 0x40 }) === 11);
  // the floating bus: the screen byte being fetched, $FF in the border
  m.screenMem[0] = 0x5a;
  m.screenMem[0x1800] = 0x47;
  check('floating bus in the border is $FF', m.floatingBus(100) === 0xff);
  check('floating bus at 14338 is the first screen byte', m.floatingBus(14338) === 0x5a);
  check('floating bus at 14339 is its attribute', m.floatingBus(14339) === 0x47);
}

// ---- the z80test suite (MIT licence, by Patrik Rak) on a 48K, loaded from its tape
function z80test(file, seconds) {
  const m = makeMachine({ model: '48k' });
  const tap = new Uint8Array(fs.readFileSync(new URL(`z80test/${file}`, import.meta.url)));
  m.insertTape(tap);
  planAutostart(m, { tape: tap }, {});
  const lines = new Map();
  let result = '';
  for (let i = 0; i < seconds * 50 && !result; i++) {
    m.runFrame();
    if (i % 25) continue;
    const text = screenText(m);
    for (const l of text) {
      const k = /^(\d\d\d) /.exec(l);
      if (k && /OK|FAILED/.test(l)) lines.set(k[1], l);
      if (/^Result:/.test(l)) result = l;
    }
    if (text.some((l) => l.includes('scroll?')) && !m.typing) m.typeKeys('Y');
  }
  const bad = [...lines.values()].filter((l) => !/OK$/.test(l));
  check(`${file}: ${result || 'no result'}`, /all tests passed/.test(result) && !bad.length, bad.join(' | '));
}
z80test('z80full.tap', 600);
z80test('z80memptr.tap', 400);
z80test('z80ccf.tap', 400);

done();
