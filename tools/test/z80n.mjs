// The Spectrum Next's Z80N instructions: what each does, its T-states, and that a plain Z80
// still treats them as NOPs. Expected values from wiki.specnext.dev ("Extended Z80
// instruction set").
import { Z80 } from '../../web/js/emu/z80.js';
import { makeChecker } from './util.mjs';

const { check, done } = makeChecker();

const mem = new Uint8Array(65536);
const regs = [];
const ports = [];
const bus = {
  read: (a) => mem[a],
  write: (a, v) => { mem[a] = v; },
  ioRead: (p) => (p === 0x1234 ? 0x42 : 0xff),
  ioWrite: (p, v) => ports.push([p, v]),
  intVector: () => 0xff,
  nextRegWrite: (r, v) => regs.push([r, v]),
};
const cpu = new Z80(bus);
cpu.intLen = 0;
cpu.ioContended = false;

// runs one instruction (all of a repeating one) at $8000; returns the CPU and the T-states
function run(bytes, setup = {}, z80n = true) {
  mem.fill(0);
  mem.set(bytes, 0x8000);
  regs.length = 0;
  ports.length = 0;
  cpu.reset();
  cpu.z80n = z80n;
  Object.assign(cpu, { pc: 0x8000, sp: 0xf000, f: 0 }, setup);
  cpu.t = 0;
  const end = 0x8000 + bytes.length;
  do cpu.step(); while (cpu.pc !== end && cpu.t < 100000 && !(bytes[1] === 0x98));
  return cpu.t;
}

const hex = (v) => '$' + v.toString(16).toUpperCase();
function eq(name, got, want) { check(name, got === want, `got ${hex(got)}, want ${hex(want)}`); }

let t;
t = run([0xed, 0x23], { a: 0x1f }); eq('SWAPNIB', cpu.a, 0xf1); eq('SWAPNIB T', t, 8);
t = run([0xed, 0x24], { a: 0x01 }); eq('MIRROR A', cpu.a, 0x80); eq('MIRROR T', t, 8);
run([0xed, 0x24], { a: 0xc5 }); eq('MIRROR A $C5', cpu.a, 0xa3);

t = run([0xed, 0x27, 0x0f], { a: 0xf0 }); eq('TEST keeps A', cpu.a, 0xf0); check('TEST zero', (cpu.f & 0x40) !== 0); eq('TEST T', t, 11);
run([0xed, 0x27, 0x80], { a: 0x81 }); check('TEST sign, H', (cpu.f & 0x90) === 0x90 && (cpu.f & 0x40) === 0);

t = run([0xed, 0x28], { d: 0x00, e: 0x81, b: 4 }); eq('BSLA', cpu.de, 0x0810); eq('BSLA T', t, 8);
run([0xed, 0x28], { d: 0x12, e: 0x34, b: 0x24 }); eq('BSLA B&31', cpu.de, 0x2340);
run([0xed, 0x29], { d: 0x80, e: 0x00, b: 4 }); eq('BSRA', cpu.de, 0xf800);
run([0xed, 0x29], { d: 0x80, e: 0x00, b: 20 }); eq('BSRA 20', cpu.de, 0xffff);
run([0xed, 0x2a], { d: 0x80, e: 0x00, b: 4 }); eq('BSRL', cpu.de, 0x0800);
run([0xed, 0x2b], { d: 0x00, e: 0x80, b: 4 }); eq('BSRF', cpu.de, 0xf008);
run([0xed, 0x2c], { d: 0x80, e: 0x01, b: 1 }); eq('BRLC', cpu.de, 0x0003);
run([0xed, 0x2c], { d: 0x12, e: 0x34, b: 0x14 }); eq('BRLC B&15', cpu.de, 0x2341);

t = run([0xed, 0x30], { d: 200, e: 100, f: 0xff }); eq('MUL D,E', cpu.de, 20000); eq('MUL keeps F', cpu.f, 0xff); eq('MUL T', t, 8);
t = run([0xed, 0x31], { h: 0x12, l: 0xff, a: 0x02 }); eq('ADD HL,A', cpu.hl, 0x1301); eq('ADD HL,A T', t, 8);
run([0xed, 0x32], { d: 0xff, e: 0xff, a: 0x02 }); eq('ADD DE,A wraps', cpu.de, 0x0001);
run([0xed, 0x33], { b: 0x00, c: 0x10, a: 0xf0 }); eq('ADD BC,A', cpu.bc, 0x0100);
t = run([0xed, 0x34, 0x34, 0x12], { h: 0x10, l: 0x00 }); eq('ADD HL,nn', cpu.hl, 0x2234); eq('ADD HL,nn T', t, 16);
run([0xed, 0x35, 0x01, 0x00], { d: 0, e: 0 }); eq('ADD DE,nn', cpu.de, 1);
run([0xed, 0x36, 0x00, 0x01], { b: 0, c: 0 }); eq('ADD BC,nn', cpu.bc, 0x100);

t = run([0xed, 0x8a, 0x12, 0x34]); eq('PUSH nn (big-endian)', mem[0xeffe] | (mem[0xefff] << 8), 0x1234); eq('PUSH nn SP', cpu.sp, 0xeffe); eq('PUSH nn T', t, 23);

mem.fill(0);
t = run([0xed, 0x91, 0x07, 0x03]); check('NEXTREG n,n', regs.length === 1 && regs[0][0] === 7 && regs[0][1] === 3); eq('NEXTREG n,n T', t, 20);
t = run([0xed, 0x92, 0x50], { a: 0x20 }); check('NEXTREG n,A', regs.length === 1 && regs[0][0] === 0x50 && regs[0][1] === 0x20); eq('NEXTREG n,A T', t, 17);

t = run([0xed, 0x90], { b: 0x12, c: 0x34, h: 0x90, l: 0x00 });
check('OUTINB', ports.length === 1 && ports[0][0] === 0x1234); eq('OUTINB keeps B', cpu.b, 0x12); eq('OUTINB HL', cpu.hl, 0x9001); eq('OUTINB T', t, 16);

t = run([0xed, 0x94], { d: 0, e: 0 }); eq('PIXELAD 0,0', cpu.hl, 0x4000); eq('PIXELAD T', t, 8);
run([0xed, 0x94], { d: 191, e: 255 }); eq('PIXELAD 255,191', cpu.hl, 0x57ff);
run([0xed, 0x94], { d: 9, e: 16 }); eq('PIXELAD 16,9', cpu.hl, 0x4122);
run([0xed, 0x93], { h: 0x40, l: 0x00 }); eq('PIXELDN in a cell', cpu.hl, 0x4100);
run([0xed, 0x93], { h: 0x47, l: 0x00 }); eq('PIXELDN to the next row', cpu.hl, 0x4020);
run([0xed, 0x93], { h: 0x47, l: 0xe5 }); eq('PIXELDN to the next third', cpu.hl, 0x4805);
// PIXELDN from every line agrees with PIXELAD on the line below
let pixOk = true;
for (let y = 0; y < 191; y++) {
  run([0xed, 0x94], { d: y, e: 40 }); const here = cpu.hl;
  run([0xed, 0x94], { d: y + 1, e: 40 }); const below = cpu.hl;
  run([0xed, 0x93], { hl: here }); if (cpu.hl !== below) pixOk = false;
}
check('PIXELDN matches PIXELAD on every line', pixOk);
run([0xed, 0x95], { e: 0 }); eq('SETAE 0', cpu.a, 0x80);
run([0xed, 0x95], { e: 15 }); eq('SETAE 15', cpu.a, 0x01);

t = run([0xed, 0x98], { b: 0x12, c: 0x34 }); eq('JP (C)', cpu.pc, 0x8000 | (0x42 << 6)); eq('JP (C) T', t, 13);

// LDIX / LDIRX: the bytes equal to A are skipped
mem.fill(0);
function block(op, setup, src) {
  mem.fill(0);
  mem.set([0xed, op], 0x8000);
  mem.set(src, 0x9000);
  mem.fill(0x55, 0xa000, 0xa010);
  cpu.reset();
  cpu.z80n = true;
  Object.assign(cpu, { pc: 0x8000, sp: 0xf000 }, setup);
  cpu.t = 0;
  do cpu.step(); while (cpu.pc !== 0x8002);
  return cpu.t;
}
t = block(0xa4, { a: 0xe3, hl: 0x9000, de: 0xa000, bc: 1 }, [7]);
eq('LDIX copies', mem[0xa000], 7); eq('LDIX HL', cpu.hl, 0x9001); eq('LDIX DE', cpu.de, 0xa001); eq('LDIX BC', cpu.bc, 0); eq('LDIX T', t, 16);
block(0xa4, { a: 0xe3, hl: 0x9000, de: 0xa000, bc: 1 }, [0xe3]); eq('LDIX skips A', mem[0xa000], 0x55);
t = block(0xb4, { a: 0xe3, hl: 0x9000, de: 0xa000, bc: 4 }, [1, 0xe3, 3, 4]);
check('LDIRX', mem[0xa000] === 1 && mem[0xa001] === 0x55 && mem[0xa002] === 3 && mem[0xa003] === 4); eq('LDIRX T', t, 21 * 3 + 16);
block(0xbc, { a: 0xe3, hl: 0x9003, de: 0xa000, bc: 4 }, [1, 2, 0xe3, 4]);
check('LDDRX: HL down, DE up', mem[0xa000] === 4 && mem[0xa001] === 0x55 && mem[0xa002] === 2 && mem[0xa003] === 1 && cpu.hl === 0x8fff && cpu.de === 0xa004);
block(0xb7, { a: 0xe3, hl: 0x9005, de: 0xa006, bc: 4 }, [0, 1, 2, 3, 4, 5, 6, 0xe3]);
check('LDPIRX', mem[0xa006] === 6 && mem[0xa007] === 0x55 && mem[0xa008] === 0 && mem[0xa009] === 1 && cpu.hl === 0x9005);
t = block(0xa5, { hl: 0x90ff, de: 0x7f00 }, []);
mem[0x90ff] = 9; block(0xa5, { hl: 0x90ff, de: 0x7f00, f: 0 }, []);
eq('LDWS L wraps, H kept', cpu.hl, 0x9000); eq('LDWS D', cpu.d, 0x80); check('LDWS flags as INC D (S, H, P/V)', (cpu.f & 0x94) === 0x94); eq('LDWS T', t, 14);

// a plain Z80: the same bytes are 8 T-state NOPs
t = run([0xed, 0x30], { d: 200, e: 100 }, false); eq('Z80: MUL is a NOP', cpu.de, (200 << 8) | 100); eq('Z80: NOP T', t, 8);
t = run([0xed, 0x91, 0x07, 0x03], {}, false); check('Z80: NEXTREG is not', regs.length === 0);

done();
