// The Spectrum Next machine: the 128K ROM boots under it, the Next registers (ports and
// NEXTREG), the MMU and the 128K's paging through it, the CPU speeds, a .nex program that
// reads and writes the SD card through esxDOS calls, and save states.
import { SpectrumNext, createMachine } from '../../web/js/emu/next.js';
import { Spectrum } from '../../web/js/emu/spectrum.js';
import { SdCard } from '../../web/js/emu/sd.js';
import { loadRoms, runFrames, runUntilText, makeChecker } from './util.mjs';

const { check, done } = makeChecker();
const roms = loadRoms();
const hex = (v) => '$' + v.toString(16).toUpperCase();

// ---- the machine picked by model
check('createMachine next', createMachine({ roms, model: 'next' }) instanceof SpectrumNext);
check('createMachine 48k', !(createMachine({ roms, model: '48k' }) instanceof SpectrumNext) && createMachine({ roms, model: '48k' }) instanceof Spectrum);
check('2 MB model', createMachine({ roms, model: 'next2m' }).ramPages === 224);

// ---- it boots the 128K ROM (its paging goes through the MMU)
const m = new SpectrumNext({ roms });
check('768K free', m.ramPages === 96);
check('boots to the 128K menu', runUntilText(m, '128 BASIC', 5));

// ---- the Next registers through the ports
m.ioWrite(0x243b, 0x00);
check('machine ID through $253B', m.ioRead(0x253b) === 10);
m.ioWrite(0x243b, 0x52);
m.ioWrite(0x253b, 40);
check('MMU2 set through the ports', m.mmu[2] === 40 && m.ioRead(0x253b) === 40);
m.mem[40 * 0x2000 + 5] = 0x99;
check('slot 2 shows page 40', m.read(0x4005) === 0x99);
m.nextRegWrite(0x52, 10);
check('MMU2 back', m.read(0x4005) !== 0x99);

// ---- the 128K's paging moves MMU6 and 7
m.port7ffd = 0; m.pagingLocked = false;
m.ioWrite(0x7ffd, 3);
check('7FFD bank 3: MMU6/7 = 6/7', m.mmu[6] === 6 && m.mmu[7] === 7 && m.nextRegRead(0x56) === 6);
m.ioWrite(0xdffd, 1);
check('DFFD adds bank bits: bank 11', m.mmu[6] === 22 && m.mmu[7] === 23);
m.ioWrite(0xdffd, 0);
m.ioWrite(0x7ffd, 0x10);
check('ROM 1 in slots 0-1', m.read(0) === roms.rom128[0x4000] && m.read(0x2000) === roms.rom128[0x6000]);
m.nextRegWrite(0x50, 4);
m.write(0x0000, 0x5a);
check('RAM in slot 0 is writable', m.read(0) === 0x5a && m.mem[4 * 0x2000] === 0x5a);
m.nextRegWrite(0x50, 0xff);
check('ROM back in slot 0', m.read(0) === roms.rom128[0x4000]);

// ---- the CPU speeds: a counting loop (18 T-states a pass) goes 2, 4 and 8 times as far a frame
function countAt(speed) {
  const n = new SpectrumNext({ roms });
  runFrames(n, 2);
  n.cpu.iff1 = n.cpu.iff2 = 0;
  n.injectBinary([0xed, 0x91, 0x07, speed, 0x21, 0, 0, 0x23, 0x18, 0xfd], 0x8000, 0x8000);
  runFrames(n, 1);
  const a = n.cpu.hl;
  runFrames(n, 1);
  return (n.cpu.hl - a) & 0xffff;
}
const c0 = countAt(0), c1 = countAt(1), c2 = countAt(2), c3 = countAt(3);
const near = (x, want) => Math.abs(x - want) <= 2;
check('3.5 MHz: a frame of 70908 T-states', near(c0, Math.floor(70908 / 18)), `${c0}`);
check('7 MHz is twice', near(c1, 2 * c0), `${c1}`);
check('14 MHz is 4 times', near(c2, 4 * c0), `${c2}`);
// at 28 MHz each of the loop's 3 reads (two fetches, one operand) waits a 28 MHz cycle: 21 a pass
check('28 MHz: 8 times, with the read waits', near(c3, Math.floor((70908 * 8) / 21)), `${c3}`);
const s = new SpectrumNext({ roms });
s.nextRegWrite(0x07, 3);
check('speed read back', s.nextRegRead(0x07) === 0x33);

// ---- the FPGA core's timing rules
// an interrupt handler longer than the interrupt (EI, RET alone is taken twice, as on a real
// Spectrum): PUSH AF, POP AF twice, EI, RET
const HANDLER = [0xf5, 0xf1, 0xf5, 0xf1, 0xfb, 0xc9];
// the loop at addr, with the slots and registers set first; its passes in a frame
function loopCount({ speed = 0, addr = 0x8000, mmu = {}, regs = {}, port7ffd = null, ei = false }) {
  const n = new SpectrumNext({ roms });
  runFrames(n, 2);
  n.cpu.iff1 = n.cpu.iff2 = 0;
  if (port7ffd !== null) n.ioWrite(0x7ffd, port7ffd);
  for (const [s, p] of Object.entries(mmu)) n.nextRegWrite(0x50 + Number(s), p);
  for (const [r, v] of Object.entries(regs)) n.nextRegWrite(Number(r), v);
  n.nextRegWrite(0x07, speed);
  const code = [0x21, 0, 0, 0x23, 0x18, 0xfd];
  code.forEach((b, i) => n.write(addr + i, b));
  n.cpu.pc = addr;
  if (ei) {
    // an interrupt handler of our own in RAM at $0038: EI, RET
    n.nextRegWrite(0x50, 20);
    HANDLER.forEach((b, i) => n.write(0x38 + i, b));
    n.cpu.iff1 = n.cpu.iff2 = 1; n.cpu.im = 1;
  }
  runFrames(n, 1);
  const a = n.cpu.hl, ints = n.cpu.ints;
  runFrames(n, 1);
  return { count: (n.cpu.hl - a) & 0xffff, ints: n.cpu.ints - ints, m: n };
}
const plain = loopCount({}).count;
check('page $0E has no 28 MHz wait: 18 a pass', near(loopCount({ speed: 3, addr: 0xc000, mmu: { 6: 0x0e } }).count, Math.floor((70908 * 8) / 18)));
check('the ROM waits at 28 MHz', loopCount({ speed: 3 }).m.cpu.rwait[0] === 1);
check('an unmapped page has no wait', (() => { const r = loopCount({ speed: 3, mmu: { 7: 0xe0 } }); return r.m.cpu.rwait[7] === 0 && r.m.cpu.rwait[6] === 1; })());
const inBank5 = loopCount({ addr: 0x6000 }).count;
check('128K timing: bank 5 is contended at 3.5 MHz', inBank5 < plain && inBank5 > plain * 0.6, inBank5 + " vs " + plain);
check('128K timing: bank 3 at $C000 contended, bank 2 not', loopCount({ addr: 0xc000, port7ffd: 3 }).count < plain && near(loopCount({ addr: 0xc000, port7ffd: 4 }).count, plain));
check('128K timing: an odd bank by the MMU', loopCount({ addr: 0xc000, mmu: { 6: 2 * 1, 7: 2 * 1 + 1 } }).count < plain);
check('register $08 bit 6 turns contention off', near(loopCount({ addr: 0x6000, regs: { 8: 0x40 } }).count, plain));
check('no contention at 7 MHz', near(loopCount({ speed: 1, addr: 0x6000 }).count, 2 * plain));
check('+3 timing: bank 4 contended, bank 3 not', loopCount({ addr: 0xc000, port7ffd: 4, regs: { 3: 0x30 } }).count < plain && near(loopCount({ addr: 0xc000, port7ffd: 3, regs: { 3: 0x30 } }).count, plain));
const t48 = loopCount({ regs: { 3: 0x10 } });
check('48K timing: a 69888 frame', t48.m.frameLen === 69888 && near(t48.count, Math.floor(69888 / 18)), String(t48.count));
check('48K timing: bank 3 not contended', near(loopCount({ addr: 0xc000, port7ffd: 3, regs: { 3: 0x10 } }).count, Math.floor(69888 / 18)));
check('Pentagon timing: 71680, no contention', (() => { const r = loopCount({ addr: 0x6000, regs: { 3: 0x40 } }); return r.m.frameLen === 71680 && near(r.count, Math.floor(71680 / 18)); })());
const fast = loopCount({ speed: 3, ei: true });
check('the interrupt is held 36 CPU cycles (128K timing)', fast.m.timing.intLen === 36 && fast.m.cpu.intLen === 0);
check('28 MHz: one interrupt a frame while busy', fast.ints === 1, String(fast.ints));
const h = new SpectrumNext({ roms });
runFrames(h, 100);
h.nextRegWrite(0x07, 3);
h.nextRegWrite(0x50, 20);
HANDLER.forEach((b, i) => h.write(0x38 + i, b));
h.cpu.im = 1;
h.injectBinary([0xfb, 0x76, 0x18, 0xfc], 0x8000, 0x8000);
runFrames(h, 1);
const before = h.cpu.ints;
runFrames(h, 10);
check('28 MHz: one interrupt a frame in HALT', h.cpu.ints - before === 10, String(h.cpu.ints - before));

// ---- a .nex: bank 2 holds the code, bank 3 is at $C000; it reads DATA.BIN and writes OUT.BIN
const code = [
  0xf3, // di
  0xed, 0x91, 0x07, 0x03, // nextreg 7,3
  0x3e, 0x2a, 0xdd, 0x21, 0x00, 0x81, 0x06, 0x01, 0xcf, 0x9a, // F_OPEN "DATA.BIN", read
  0x32, 0x80, 0x81, // ld ($8180),a
  0xdd, 0x21, 0x00, 0x90, 0x01, 0x04, 0x00, 0xcf, 0x9d, // F_READ 4 bytes to $9000
  0x3a, 0x80, 0x81, 0xcf, 0x9b, // F_CLOSE
  0x3e, 0x2a, 0xdd, 0x21, 0x10, 0x81, 0x06, 0x0e, 0xcf, 0x9a, // F_OPEN "OUT.BIN", write + create
  0x32, 0x80, 0x81,
  0xdd, 0x21, 0x00, 0x90, 0x01, 0x04, 0x00, 0xcf, 0x9e, // F_WRITE 4 bytes from $9000
  0x3a, 0x80, 0x81, 0xcf, 0x9b, // F_CLOSE
  0x3e, 0x2a, 0xdd, 0x21, 0x20, 0x81, 0x06, 0x01, 0xcf, 0x9a, // F_OPEN "NONE.BIN": fails
  0x32, 0x81, 0x81, // ld ($8181),a: the error code
  0x18, 0xfe, // jr $
];
const bank2 = new Uint8Array(0x4000);
bank2.set(code, 0);
bank2.set([...Buffer.from('DATA.BIN'), 0], 0x100);
bank2.set([...Buffer.from('out.bin'), 0], 0x110);
bank2.set([...Buffer.from('NONE.BIN'), 0], 0x120);
const bank3 = new Uint8Array(0x4000);
bank3[0] = 0x77;
const head = new Uint8Array(512);
head.set(Buffer.from('NextV1.2'), 0);
head[9] = 2;
head[10] = 0x80;
head[11] = 1;
head[12] = 0xf0; head[13] = 0xbf; // SP $BFF0
head[14] = 0x00; head[15] = 0x80; // PC $8000
head[18 + 2] = 1;
head[18 + 3] = 1;
head[139] = 3;
const nex = new Uint8Array(512 + 0x8000);
nex.set(head, 0);
nex.set(bank2, 512); // bank order 5, 2, 0, 1, 3: bank 2 first here
nex.set(bank3, 512 + 0x4000);

const card = new SdCard({ '/DATA.BIN': [1, 2, 3, 4, 5] });
const changes = [];
card.onChange = (p, d) => changes.push([p, d && Array.from(d)]);
const n = new SpectrumNext({ roms, sd: card });
const r = n.loadNex(nex, 'test.nex');
check('.nex start', r.pc === 0x8000 && n.cpu.sp === 0xbff0 && r.banks.join() === '2,3');
check('.nex entry bank at $C000', n.read(0xc000) === 0x77);
check('.nex border', n.border === 1);
runFrames(n, 2);
check('esxDOS F_READ', [0, 1, 2, 3].every((i) => n.read(0x9000 + i) === i + 1), Array.from({ length: 4 }, (_, i) => hex(n.read(0x9000 + i))).join(' '));
check('esxDOS F_WRITE to the card', card.get('/OUT.BIN') && Array.from(card.get('/out.bin')).join() === '1,2,3,4');
check('onChange told of OUT.BIN', changes.some(([p, d]) => p === '/out.bin' && d && d.join() === '1,2,3,4'));
check('F_OPEN of a missing file: error 5', n.read(0x8181) === 5);
check('handles closed', n.handles.size === 0);
check('the program set 28 MHz', n.speed === 3);

// ---- save states keep the Next's memory, registers and speed
const st = n.saveState();
const n2 = new SpectrumNext({ roms });
n2.loadState(st);
check('state: MMU and speed', n2.mmu.join() === n.mmu.join() && n2.speed === 3 && n2.cpu.mult === 8);
check('state: memory', n2.read(0xc000) === 0x77 && n2.read(0x9002) === 3);
runFrames(n2, 1);
check('state: runs on', n2.cpu.pc >= 0x8000 && n2.cpu.pc < 0x8100);

done();
