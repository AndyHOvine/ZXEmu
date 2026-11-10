// Runs ZXEmu's Z80 and AmsEmu's (Caprice32's, which matches it on 46 million instructions)
// side by side on random code in a flat 64K, comparing the registers after every instruction.
// Usage: node tools/dev/compare-amsemu.mjs [path to AmsEmu] [instructions]
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Z80 } from '../../web/js/emu/z80.js';

const ams = process.argv[2] || 'C:/src/AmsEmu-src';
const N = Number(process.argv[3] || 2000000);
const { Z80: Ref } = await import(pathToFileURL(path.join(ams, 'web/js/emu/z80.js')).href);

let seed = 12345;
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16) & 0xff;

const memA = new Uint8Array(65536), memB = new Uint8Array(65536);
const io = (p) => (p ^ (p >> 8) ^ 0x5a) & 0xff;
const busA = { read: (a) => memA[a], write: (a, v) => { memA[a] = v; }, ioRead: io, ioWrite: () => {}, intVector: () => 0xff };
const busB = { read: (a) => memB[a], write: (a, v) => { memB[a] = v; }, ioIn: io, ioOut: () => {}, waitStates: () => {}, intAck: () => {}, intVector: () => 0xff };
const a = new Z80(busA);
a.intLen = 0;
a.ioContended = false;
const b = new Ref(busB);

const REGS = ['a', 'f', 'b', 'c', 'd', 'e', 'h', 'l', 'a_', 'f_', 'b_', 'c_', 'd_', 'e_', 'h_', 'l_', 'ix', 'iy', 'sp', 'pc', 'i', 'im'];
let bad = 0;
const seen = new Map();
function restart() {
  for (let i = 0; i < 65536; i++) memA[i] = memB[i] = rnd();
  for (const r of REGS) { const v = r === 'ix' || r === 'iy' || r === 'sp' || r === 'pc' ? rnd() | (rnd() << 8) : r === 'im' ? 1 : rnd(); a[r] = v; b[r] = v; }
  a.halted = 0; b.halt = 0; a.iff1 = a.iff2 = b.iff1 = b.iff2 = 0;
}
restart();
for (let n = 0; n < N; n++) {
  if (n % 5000 === 0) restart();
  const pc = a.pc;
  const bytes = [0, 1, 2, 3].map((i) => memA[(pc + i) & 0xffff]);
  a.step(); b.step();
  if (a.halted || b.halt) { restart(); continue; }
  // where Caprice32 leaves out known undocumented behaviour (X/Y of BIT, Q for SCF/CCF, the
  // block instructions' flags), only the documented flags are compared
  let mask = 0xff;
  if (bytes[0] === 0xcb && bytes[1] >= 0x40 && bytes[1] < 0x80) mask = 0xd7;
  if ((bytes[0] === 0xdd || bytes[0] === 0xfd) && bytes[1] === 0xcb && bytes[3] >= 0x40 && bytes[3] < 0x80) mask = 0xd7;
  if (bytes[0] === 0x37 || bytes[0] === 0x3f || ((bytes[0] === 0xdd || bytes[0] === 0xfd) && (bytes[1] === 0x37 || bytes[1] === 0x3f))) mask = 0xd7;
  if (bytes[0] === 0xed && bytes[1] >= 0xa0 && bytes[1] < 0xc0) mask = (bytes[1] & 3) === 3 ? 0xc2 : 0xc3; // OUTI's flags: Caprice32 adds C, the Z80 adds L
  const diff = REGS.filter((r) => (r === 'f' ? (a.f ^ b.f) & mask : a[r] !== b[r]));
  if (mask !== 0xff && !diff.length) a.f = b.f;
  let memDiff = -1;
  if (!diff.length) {
    // spot-check memory near the stack and the last writes
    for (const at of [a.sp, (a.sp + 1) & 0xffff, (a.sp - 1) & 0xffff, (a.sp - 2) & 0xffff, a.hl, a.de, a.bc, (a.ix + (bytes[2] << 24 >> 24)) & 0xffff, (a.iy + (bytes[2] << 24 >> 24)) & 0xffff]) if (memA[at] !== memB[at]) memDiff = at;
  }
  if (diff.length || memDiff >= 0) {
    const key = bytes.slice(0, bytes[0] === 0xdd || bytes[0] === 0xfd || bytes[0] === 0xed || bytes[0] === 0xcb ? 2 : 1).map((x) => x.toString(16).padStart(2, '0')).join(' ') + ' ' + diff.join(',') + (memDiff >= 0 ? ' mem' : '');
    if (!seen.has(key)) {
      seen.set(key, 1);
      if (bad < 40) console.log(`${key}: ${bytes.map((x) => x.toString(16).padStart(2, '0')).join(' ')} ${diff.map((r) => `${r} ${a[r].toString(16)}/${b[r].toString(16)}`).join(' ')}`);
      bad++;
    }
    for (const r of REGS) a[r] = b[r];
    for (let i = 0; i < 65536; i++) memA[i] = memB[i];
  }
}
console.log(bad ? `${bad} kinds of difference` : `no differences in ${N} instructions`);
process.exit(bad ? 1 : 0);
