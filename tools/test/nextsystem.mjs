// The Spectrum Next's interrupts (the line interrupt, pulse mode, hardware IM 2 with its
// vectors and RETI), the CTC, the copper (raster splits, a change partway along a line), the
// DMA (memory to memory, the Zilog length, paced bytes to a DAC), TurboSound and the DACs, the
// joysticks (Kempston, MD pads) and the Kempston mouse. Expected values from docs/next-system.md.
import { SpectrumNext, PAD } from '../../web/js/emu/next.js';
import { NEXT_RGBA } from '../../web/js/emu/nextvideo.js';
import { FB_WIDTH, BORDER } from '../../web/js/emu/video.js';
import { loadRoms, runFrames, makeChecker } from './util.mjs';

const { check, done } = makeChecker();
const roms = loadRoms();
const nr = (m, r, v) => m.nextRegWrite(r, v);
const near = (a, b, d) => Math.abs(a - b) <= d;

// a Next running "JR $" at $8000 with interrupts off, a frame on; RAM page 20 at $0000 when ram0
function fresh({ ram0 = false } = {}) {
  const m = new SpectrumNext({ roms });
  m.injectBinary([0x18, 0xfe], 0x8000, 0x8000);
  m.cpu.iff1 = m.cpu.iff2 = 0;
  runFrames(m, 1); // past reset's frame interrupt
  if (ram0) nr(m, 0x50, 20);
  return m;
}
const poke = (m, a, bytes) => bytes.forEach((b, i) => m.write(a + i, b));
// a handler counting into addr: PUSH AF, LD A,(addr), INC A, LD (addr),A, POP AF, EI, then RETI or RET
const counter = (addr, reti = true) => [0xf5, 0x3a, addr & 0xff, addr >> 8, 0x3c, 0x32, addr & 0xff, addr >> 8, 0xf1, 0xfb, ...(reti ? [0xed, 0x4d] : [0xc9])];
const ei = (m, im = 1) => { m.cpu.im = im; m.cpu.iff1 = m.cpu.iff2 = 1; };

// ---- the line interrupt in pulse mode: IM 1 with the ULA's and the line's at $0038
let m = fresh({ ram0: true });
poke(m, 0x38, counter(0x9000, false));
nr(m, 0x22, 0x02); // the line interrupt on, the ULA's on
nr(m, 0x23, 100);
ei(m);
runFrames(m, 2);
m.write(0x9000, 0);
runFrames(m, 10);
check('pulse mode: the ULA\'s and the line\'s, 2 a frame', m.read(0x9000) === 20, String(m.read(0x9000)));
check('NR $C8 status: line and ULA', (m.nextRegRead(0xc8) & 3) === 3);
nr(m, 0xc8, 3);
check('NR $C8 cleared by writing 1s', (m.nextRegRead(0xc8) & 3) === 0);
nr(m, 0x22, 0x06); // the ULA's off
runFrames(m, 1);
m.write(0x9000, 0);
runFrames(m, 10);
check('ULA interrupt off (NR $22 bit 2): 1 a frame', m.read(0x9000) === 10, String(m.read(0x9000)));
check('port $FF bit 6 follows', (m.portFF & 0x40) !== 0 && (m.nextRegRead(0xc4) & 1) === 0);
// where the line interrupt comes: on line 99 (the line before), late in it
const m2 = fresh();
nr(m2, 0x22, 0x02);
nr(m2, 0x23, 100);
let seen = -1;
for (let i = 0; i < 200000 && seen < 0; i++) { m2.stepOnce(); if (m2.ints.status[0]) seen = m2.rasterLine(); if (m2.cpu.t >= m2.frameLen) m2.endFrame(); }
check('the line interrupt for line 100 comes on line 99', seen === 99, String(seen));
check('NR $1E/$1F read the line', ((m2.nextRegRead(0x1e) << 8) | m2.nextRegRead(0x1f)) === m2.rasterLine());

// ---- hardware IM 2: each source its vector, RETI re-arms it, a lower one waits for it
m = fresh();
nr(m, 0xc0, 0xa1); // vectors from $A0, hardware IM 2
nr(m, 0x22, 0x02);
nr(m, 0x23, 50);
m.cpu.i = 0x90;
poke(m, 0x90a0, [0x00, 0xa0]); // line (index 0): $A000
poke(m, 0x90b6, [0x00, 0xa1]); // ULA (index 11, $A0 | $16): $A100
poke(m, 0xa000, counter(0x9800));
poke(m, 0xa100, counter(0x9801));
ei(m, 2);
runFrames(m, 5);
check('IM 2: the line\'s vector $A0', m.read(0x9800) === 5, String(m.read(0x9800)));
// (the first frame interrupt came in pulse mode, before NR $C0 was set, and was lost: so 4)
check('IM 2: the ULA\'s vector $B6', m.read(0x9801) === 4, String(m.read(0x9801)));
check('NR $C0 reads IM 2', ((m.nextRegRead(0xc0) >> 1) & 3) === 2);
poke(m, 0xa100, counter(0x9801, false)); // the ULA's handler ends with RET, not RETI
runFrames(m, 5);
check('without RETI the ULA is served once more, then never', m.read(0x9801) === 5, String(m.read(0x9801)));
check('and the line (higher) still comes', m.read(0x9800) === 10, String(m.read(0x9800)));

// ---- the CTC: channel 0, 28 MHz / 16 / 175 = 10 kHz, by hardware IM 2 (vector $A6)
m = fresh();
nr(m, 0xc0, 0xa1);
m.cpu.i = 0x90;
poke(m, 0x90a6, [0x00, 0xa2]);
poke(m, 0xa200, [0xf5, 0xe5, 0x2a, 0x02, 0x98, 0x23, 0x22, 0x02, 0x98, 0xe1, 0xf1, 0xfb, 0xed, 0x4d]); // a 16-bit count at $9802
nr(m, 0x22, 0x04); // the ULA's off (and no line interrupt)
ei(m, 2);
m.ioWrite(0x183b, 0x85); // interrupt, timer, /16, control word, a time constant follows
m.ioWrite(0x183b, 175);
runFrames(m, 5);
const ticks = 5 * m.frameLen * 8, want = ticks / (16 * 175);
const got = m.read(0x9802) | (m.read(0x9803) << 8);
check('CTC timer: 10 kHz', near(got, want, 3), `${got} vs ${want.toFixed(1)}`);
const r1 = m.ioRead(0x183b);
check('CTC count reads back', r1 >= 1 && r1 <= 175, String(r1));
// channel 1 counting channel 0's zeros: 10 kHz / 4
m.ioWrite(0x193b, 0xc5); // counter mode, interrupt... (polled here)
m.ioWrite(0x193b, 4);
nr(m, 0xc9, 0xff);
let c1 = 0;
for (let f = 0; f < 3; f++) for (let i = 0; i < 10000; i++) { m.stepOnce(); if (m.ints.status[4]) { c1++; m.ints.status[4] = 0; } if (m.cpu.t >= m.frameLen) m.endFrame(); }
check('CTC channel 1 counts channel 0', c1 > 20, String(c1));

// ---- the copper: Layer 2 scrolled between lines 50 and 150 (mode 11, again each frame)
const SX = (BORDER - 32) * 2, SY = BORDER - 32;
const px = (mm, x, y) => mm.video.fb[(SY + y) * FB_WIDTH + SX + x * 2];
const rgb8 = (c) => (c << 1) | (((c >> 1) | c) & 1);
m = fresh();
m.ioWrite(0x123b, 0x02);
const L2 = 8 * 0x4000;
m.mem.fill(0xe3, L2, L2 + 3 * 0x4000);
for (let y = 0; y < 192; y++) m.mem[L2 + y * 256 + 100] = 0x1c;
const list = [0x80, 50, 0x16, 50, 0x80 | 0, 150, 0x16, 0, 0xff, 0xff]; // WAIT 50; MOVE $16,50; WAIT 150; MOVE $16,0; HALT
nr(m, 0x61, 0);
nr(m, 0x62, 0);
list.forEach((b) => nr(m, 0x60, b));
nr(m, 0x62, 0xc0);
runFrames(m, 3);
const green = NEXT_RGBA[rgb8(0x1c)];
check('copper: above line 50 unscrolled', px(m, 32 + 100, 32 + 40) === green);
check('copper: lines 50-149 scrolled 50', px(m, 32 + 50, 32 + 100) === green && px(m, 32 + 100, 32 + 100) !== green);
check('copper: from 150 unscrolled again', px(m, 32 + 100, 32 + 160) === green);
check('copper: the same next frame (mode 11)', (runFrames(m, 1), px(m, 32 + 50, 32 + 60) === green));
// partway along a line: WAIT line 80 column 16 (paper x 128), MOVE the fallback colour
m = fresh();
nr(m, 0x68, 0x80); // the ULA off: all fallback
nr(m, 0x4a, 0x03);
const list2 = [0x80 | (16 << 1), 80, 0x4a, 0xe0, 0x80, 81, 0x4a, 0x1c, 0xff, 0xff];
nr(m, 0x61, 0); nr(m, 0x62, 0);
list2.forEach((b) => nr(m, 0x60, b));
nr(m, 0x62, 0xc0);
runFrames(m, 2);
// (the colour before line 80's MOVE is line 81's from the frame before: green)
check('copper mid-line: left of x 128 the old colour', px(m, 32 + 100, 32 + 80) === NEXT_RGBA[rgb8(0x1c)]);
check('copper mid-line: from x 128 the new', px(m, 32 + 200, 32 + 80) === NEXT_RGBA[rgb8(0xe0)]);
check('copper: line 81 the next', px(m, 32 + 10, 32 + 81) === NEXT_RGBA[rgb8(0x1c)]);

// ---- the DMA: 256 bytes $8100 to $C000, memory to memory (the spec's example)
m = fresh();
for (let i = 0; i < 256; i++) m.write(0x8100 + i, i ^ 0x5a);
const t0 = m.tBase + m.cpu.t;
[0x83, 0x7d, 0x00, 0x81, 0x00, 0x01, 0x54, 0x02, 0x50, 0x02, 0xad, 0x00, 0xc0, 0x82, 0xcf, 0x87].forEach((b) => m.ioWrite(0x6b, b));
for (let i = 0; i < 1000 && m.dma.active; i++) m.stepOnce();
let same = true;
for (let i = 0; i < 256; i++) if (m.read(0xc000 + i) !== (i ^ 0x5a)) same = false;
check('DMA copies 256 bytes', same);
const took = m.tBase + m.cpu.t - t0;
check('DMA time: 256 x 4 cycles', near(took, 1024, 8), String(took));
m.ioWrite(0x6b, 0xbb); m.ioWrite(0x6b, 0x07);
check('DMA status after: $1A, counter 256', m.ioRead(0x6b) === 0x1a && m.ioRead(0x6b) === 0x00 && m.ioRead(0x6b) === 0x01);
// the Zilog port: length + 1
m.write(0xc100, 0); m.write(0xc101, 0);
[0x83, 0x7d, 0x00, 0x81, 0x01, 0x00, 0x54, 0x02, 0x50, 0x02, 0xad, 0x00, 0xc1, 0x82, 0xcf, 0x87].forEach((b) => m.ioWrite(0x0b, b));
for (let i = 0; i < 100 && m.dma.active; i++) m.stepOnce();
check('Zilog mode moves length + 1', m.read(0xc100) === (0 ^ 0x5a) && m.read(0xc101) === (1 ^ 0x5a));
// paced bytes to the SpecDrum DAC ($DF): burst, prescaler 55, the CPU running between
m = fresh();
for (let i = 0; i < 0x1000; i++) m.write(0x9000 + i, i & 0xff);
[0x83, 0x7d, 0x00, 0x90, 0x00, 0x10, 0x54, 0x02, 0x68, 0x22, 55, 0xcd, 0xdf, 0x00, 0xa2, 0xcf, 0x87].forEach((b) => m.ioWrite(0x6b, b));
const pc0 = m.cpu.r;
runFrames(m, 1);
const moved = m.dma.done;
check('DMA paced: about 875 kHz / 55 a second', near(moved, (m.frameLen * 8) / (55 * 32), 6), String(moved));
check('the CPU ran meanwhile', m.cpu.r !== pc0);
check('the DAC got the bytes', m.psg.dac[0] === m.psg.dac[3]);

// ---- TurboSound: three AYs; the DACs
m = fresh();
m.ioWrite(0xfffd, 0xfd); // AY 2 (chip number 2 = d bits 01), both sides
m.ioWrite(0xfffd, 8); m.ioWrite(0xbffd, 15);
m.ioWrite(0xfffd, 0xfe); // AY 1
m.ioWrite(0xfffd, 8); m.ioWrite(0xbffd, 7);
m.ioWrite(0xfffd, 0xff); // AY 0
m.ioWrite(0xfffd, 8);
check('TurboSound: three chips each its own registers', m.psg.chips[2].regs[8] === 15 && m.psg.chips[1].regs[8] === 7 && m.ioRead(0xfffd) === 0);
nr(m, 0x08, 0x18); // TurboSound off: chips can't be picked
m.ioWrite(0xfffd, 0xfe);
check('TurboSound off: AY 0 stays', m.psg.active === 0);
nr(m, 0x08, 0x1a);
m.ioWrite(0xdf, 0x20);
check('SpecDrum ($DF) is DACs A and D', m.psg.dac[0] === 0x20 && m.psg.dac[3] === 0x20 && m.psg.dac[1] === 0x80);
nr(m, 0x2c, 0x40);
check('NR $2C is DAC B', m.psg.dac[1] === 0x40);
m.psg.take();
runFrames(m, 2);
check('sound comes out', m.psg.take().length > 1000);

// ---- the joysticks and the mouse
m = fresh();
m.setJoystick(1 | 16, 0); // up, fire
check('Kempston 1 on $1F', m.ioRead(0x1f) === (8 | 16));
nr(m, 0x05, 0x48); // joystick 1 = 101 (MD 1)
m.setJoystick(8 | PAD.A | PAD.START | PAD.X, 0);
check('MD pad: right, A, START on $1F', m.ioRead(0x1f) === (1 | 64 | 128));
check('MD pad: X in NR $B2', (m.nextRegRead(0xb2) & 8) !== 0);
nr(m, 0x05, 0x02 | 0x00 | 0x10); // joystick 2 = 1 0 1? (b1, b5:4 = 1, 01) MD 2 on $37
m.setJoystick(2, 1);
check('joystick 2 on $37', (m.ioRead(0x37) & 4) !== 0);
m.mouseMove(10, -5);
m.setMouseButtons(1);
check('mouse X right, Y up', m.ioRead(0xfbdf) === 10 && m.ioRead(0xffdf) === 5);
check('mouse buttons read 0 when pressed (left = bit 1)', (m.ioRead(0xfadf) & 7) === 5);

// ---- save states keep the copper, the CTC and the interrupts
m = fresh();
nr(m, 0x61, 0); nr(m, 0x62, 0);
list.forEach((b) => nr(m, 0x60, b));
nr(m, 0x62, 0xc0);
nr(m, 0xc0, 0xa1);
m.ioWrite(0x183b, 0x05); m.ioWrite(0x183b, 99);
const st = m.saveState();
const n2 = new SpectrumNext({ roms });
n2.loadState(st);
check('state: copper list and mode', n2.copper.mode === 3 && n2.copper.list[0] === 0x80 && n2.copper.list[3] === 50);
check('state: CTC and NR $C0', n2.ctc.ch[0].tc === 99 && n2.nextRegRead(0xc0) & 1);

done();
