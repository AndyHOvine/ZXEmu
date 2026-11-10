// Every model starts, BASIC works, programs put in memory run with IM 2, the joystick
// interfaces read right, an Interface 2 cartridge starts, and save states carry on the same.
import { makeMachine, screenText, runUntilText, shows, makeChecker } from './util.mjs';
import { JOY } from '../../web/js/emu/spectrum.js';

const { check, done } = makeChecker();

for (const [model, text] of [['16k', '1982 Sinclair'], ['48k', '1982 Sinclair'], ['128k', 'Tape Loader'], ['plus2', 'Amstrad Consumer'],
  ['plus2a', '128 +2A'], ['plus3', 'Drives A:, B: and M:']]) {
  const m = makeMachine({ model });
  check(`${model} starts`, runUntilText(m, text, 5), screenText(m).join('|'));
}

{
  const m = makeMachine({ model: '48k' });
  m.typeText('p6*7\r');
  check('48K: PRINT 6*7 shows 42', runUntilText(m, '42', 6), screenText(m).join('|'));
}
for (const model of ['128k', 'plus3']) {
  const m = makeMachine({ model });
  m.typeKeys('DOWN');
  m.typeKeys('ENTER');
  m.typeWait(30);
  m.typeText('print 6*7\r');
  check(`${model}: 128 BASIC prints 42`, runUntilText(m, '42', 10), screenText(m).join('|'));
}

// a program put in memory as Hewco BASIC does: its own stack and IM 2, the frames counted,
// the Kempston port read every frame
function program(m) {
  const code = [0xf3, 0x31, 0x00, 0xfd, // di; ld sp,$fd00
    0x3e, 0x10, 0x01, 0xfd, 0x7f, 0xed, 0x79, // ld a,$10; ld bc,$7ffd; out (c),a
    0x3e, 0xc3, 0x32, 0xfd, 0xfd, 0x21, 0x00, 0x91, 0x22, 0xfe, 0xfd, // jp $9100 at $fdfd
    0x21, 0x00, 0xfe, 0x36, 0xfd, 0x11, 0x01, 0xfe, 0x01, 0x00, 0x01, 0xed, 0xb0, // $fd in $fe00-$ff00
    0x3e, 0xfe, 0xed, 0x47, 0xed, 0x5e, 0xfb, // ld a,$fe; ld i,a; im 2; ei
    0x76, // halt
    0xdb, 0x1f, 0x32, 0x00, 0x90, // in a,($1f); ld ($9000),a
    0x18, 0xf8];
  const handler = [0x21, 0x01, 0x90, 0x34, 0xfb, 0xed, 0x4d]; // inc ($9001); ei; reti
  m.onReady(() => {
    m.injectBinary(Uint8Array.from(code), 0x8000, 0x8000);
    handler.forEach((b, i) => m.poke(0x9100 + i, b));
  });
}

for (const model of ['16k', '48k', '128k', 'plus2', 'plus2a', 'plus3']) {
  const m = makeMachine({ model });
  if (model === '16k') {
    // no RAM above $8000: the frame counter in the screen's attributes instead
    m.onReady(() => {
      const code = [0xf3, 0x31, 0x00, 0x7f, 0xed, 0x56, 0xfb, 0x76, 0x21, 0x00, 0x5b, 0x34, 0x18, 0xf9]; // im 1; loop: halt; inc ($5b00)
      m.injectBinary(Uint8Array.from(code), 0x6000, 0x6000);
    });
    for (let i = 0; i < 300; i++) m.runFrame();
    const a = m.peek(0x5b00);
    for (let i = 0; i < 50; i++) m.runFrame();
    check('16k: a program runs a frame at a time', ((m.peek(0x5b00) - a) & 0xff) === 50);
    continue;
  }
  program(m);
  for (let i = 0; i < 300; i++) m.runFrame();
  const before = m.peek(0x9001);
  m.setJoystick(JOY.UP | JOY.FIRE);
  for (let i = 0; i < 50; i++) m.runFrame();
  check(`${model}: IM 2 every frame`, ((m.peek(0x9001) - before) & 0xff) === 50, String((m.peek(0x9001) - before) & 0xff));
  check(`${model}: Kempston up and fire`, m.peek(0x9000) === 0x18, m.peek(0x9000).toString(16));
}

// the joystick interfaces
{
  const m = makeMachine({ model: '48k' });
  const row = (hi) => m.ioRead((hi << 8) | 0xfe) & 0x1f;
  m.setJoystick(0);
  check('Kempston reads 0 with nothing held', m.ioRead(0x1f) === 0);
  m.setJoystickType('cursor');
  m.setJoystick(JOY.LEFT | JOY.FIRE);
  check('cursor joystick: left is 5', row(0xf7) === 0x0f, row(0xf7).toString(2));
  check('cursor joystick: fire is 0', row(0xef) === 0x1e, row(0xef).toString(2));
  m.setJoystickType('sinclair1');
  m.setJoystick(JOY.UP);
  check('Sinclair 1: up is 9', row(0xef) === 0x1d, row(0xef).toString(2));
  m.setJoystickType('sinclair2');
  m.setJoystick(JOY.RIGHT);
  check('Sinclair 2: right is 2', row(0xf7) === 0x1d, row(0xf7).toString(2));
  m.setJoystickType('fuller');
  m.setJoystick(JOY.DOWN | JOY.FIRE);
  check('Fuller: down and fire', m.ioRead(0x7f) === (0xff & ~0x82), m.ioRead(0x7f).toString(16));
  m.setJoystickType('none');
  m.setJoystick(JOY.FIRE);
  check('no interface: port 31 is the floating bus', m.ioRead(0x1f) === m.floatingBus(m.cpu.t));
  m.key('A', true);
  check('A on the keyboard', row(0xfd) === 0x1e);
  m.key('A', false);
  m.key('DELETE', true);
  check('DELETE is CAPS SHIFT and 0', row(0xfe) === 0x1e && row(0xef) === 0x1e);
}

// an Interface 2 cartridge in place of the ROM: a border of red
{
  const cart = new Uint8Array(0x4000);
  cart.set([0xf3, 0x3e, 0x02, 0xd3, 0xfe, 0x18, 0xfe]);
  const m = makeMachine({ model: '48k', cartridge: cart });
  for (let i = 0; i < 5; i++) m.runFrame();
  check('Interface 2 cartridge runs', m.border === 2 && m.cpu.pc === 5);
}

// a save state carries on the same as the machine it came from
{
  const a = makeMachine({ model: '128k' });
  program(a);
  for (let i = 0; i < 320; i++) a.runFrame();
  const s = a.saveState();
  const b = makeMachine({ model: '128k' });
  b.loadState(JSON.parse(JSON.stringify(s, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v)), (k, v) => v), true);
  for (let i = 0; i < 30; i++) { a.runFrame(); b.runFrame(); }
  const same = a.cpu.pc === b.cpu.pc && a.cpu.t === b.cpu.t && a.peek(0x9001) === b.peek(0x9001) &&
    a.video.fb.every((v, i) => v === b.video.fb[i]);
  check('save state carries on the same', same, `${a.cpu.pc} ${b.cpu.pc} ${a.cpu.t} ${b.cpu.t}`);
}

// the screen: a known picture in the frame buffer, the border round it
{
  const m = makeMachine({ model: '48k' });
  for (let i = 0; i < 120; i++) m.runFrame();
  m.onReady(() => {});
  m.injectBinary(Uint8Array.from([0xf3, 0x3e, 0x01, 0xd3, 0xfe, 0x76]), 0x8000, 0x8000);
  m.screenMem.fill(0, 0, 0x1800);
  m.screenMem.fill(0x38, 0x1800, 0x1b00);
  m.screenMem[0] = 0x80;
  m.runFrame();
  m.runFrame();
  const fb = m.video.fb, col = m.video.colours;
  const at = (x, y) => fb[y * 704 + x];
  check('border is blue', at(2, 2) === col[1]);
  check('paper is white, first pixel black', at(96, 48) === col[0] && at(98, 48) === col[7]);
  shows(m, '');
}

// the CPU stepped on its own, past the ends of frames (as a debugger and timing tests do):
// it keeps counting, and the frames carry on with their interrupts afterwards
for (const model of ['48k', '128k', 'plus3']) {
  const m = makeMachine({ model });
  program(m);
  for (let i = 0; i < 300; i++) m.runFrame();
  const c0 = m.cycles, n0 = m.peek(0x9001);
  for (let i = 0; i < 100000; i++) m.cpu.step();
  const c1 = m.cycles;
  check(`${model}: stepping keeps counting T-states`, Number.isFinite(c1) && c1 > c0 + 100000, `${c0} ${c1}`);
  check(`${model}: interrupts come while stepping`, ((m.peek(0x9001) - n0) & 0xff) === Math.floor(c1 / m.frameLen) - Math.floor(c0 / m.frameLen) || ((m.peek(0x9001) - n0) & 0xff) > 0,
    `${(m.peek(0x9001) - n0) & 0xff}`);
  const before = m.peek(0x9001);
  for (let i = 0; i < 10; i++) m.runFrame();
  check(`${model}: frames carry on after stepping`, ((m.peek(0x9001) - before) & 0xff) >= 9 && m.cpu.t < m.frameLen + 100, `${(m.peek(0x9001) - before) & 0xff} ${m.cpu.t}`);
}

done();
