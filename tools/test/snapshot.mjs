// Snapshots: .z80 written and read back on each model, .sna (48K and 128K) and .z80 version 1
// made by hand, the model a snapshot asks for.
import { makeMachine, makeChecker } from './util.mjs';
import { saveZ80, snapshotModel } from '../../web/js/emu/snapshot.js';
import { detectType } from '../../web/js/emu/media.js';

const { check, done } = makeChecker();

// a program counting frames under IM 2 and changing the border, as boot.mjs's
function program(m) {
  const code = [0xf3, 0x31, 0x00, 0xfd, 0x3e, 0x10, 0x01, 0xfd, 0x7f, 0xed, 0x79,
    0x3e, 0xc3, 0x32, 0xfd, 0xfd, 0x21, 0x00, 0x91, 0x22, 0xfe, 0xfd,
    0x21, 0x00, 0xfe, 0x36, 0xfd, 0x11, 0x01, 0xfe, 0x01, 0x00, 0x01, 0xed, 0xb0,
    0x3e, 0xfe, 0xed, 0x47, 0xed, 0x5e, 0xfb,
    0x76, 0x3a, 0x01, 0x90, 0xe6, 0x07, 0xd3, 0xfe, 0x18, 0xf6]; // halt; ld a,($9001); and 7; out ($fe),a; jr
  const handler = [0x21, 0x01, 0x90, 0x34, 0xfb, 0xed, 0x4d];
  m.onReady(() => {
    m.injectBinary(Uint8Array.from(code), 0x8000, 0x8000);
    handler.forEach((b, i) => m.poke(0x9100 + i, b));
  });
}

for (const model of ['48k', '128k', 'plus2', 'plus2a', 'plus3']) {
  const a = makeMachine({ model });
  program(a);
  for (let i = 0; i < 230; i++) a.runFrame();
  const z80 = saveZ80(a);
  check(`${model}: .z80 is recognised`, detectType('s.z80', z80) === 'snapshot' && snapshotModel(z80) === model, snapshotModel(z80));
  const b = makeMachine({ model });
  b.loadSnapshot(z80);
  check(`${model}: .z80 registers`, a.cpu.pc === b.cpu.pc && a.cpu.sp === b.cpu.sp && a.cpu.i === b.cpu.i && a.cpu.im === b.cpu.im);
  for (let i = 0; i < 20; i++) { a.runFrame(); b.runFrame(); }
  check(`${model}: .z80 carries on`, a.peek(0x9001) === b.peek(0x9001) && a.border === b.border, `${a.peek(0x9001)} ${b.peek(0x9001)}`);
}

// a 48K .sna by hand: PC on the stack, the border in the header
{
  const sna = new Uint8Array(49179);
  const sp = 0xf000;
  sna[25] = 1; // IM 1
  sna[26] = 3; // border
  sna[23] = sp & 0xff; sna[24] = sp >> 8;
  sna[19] = 0; // interrupts off
  const ram = (a) => 27 + a - 0x4000;
  sna.set([0x3e, 0x05, 0xd3, 0xfe, 0x18, 0xfe], ram(0x8000));
  sna[ram(sp)] = 0x00; sna[ram(sp + 1)] = 0x80;
  check('a 48K .sna is recognised', detectType('x.sna', sna) === 'snapshot' && snapshotModel(sna) === '48k');
  const m = makeMachine({ model: '48k' });
  m.loadSnapshot(sna);
  check('48K .sna: PC from the stack, border', m.cpu.pc === 0x8000 && m.cpu.sp === sp + 2 && m.border === 3);
  m.runFrame();
  check('48K .sna runs', m.border === 5);
}

// a 128K .sna: bank 7 paged in at $C000, code in bank 1
{
  const sna = new Uint8Array(131103);
  sna[25] = 1; sna[23] = 0x00; sna[24] = 0x90;
  const banks = { 5: 27, 2: 27 + 0x4000, 7: 27 + 0x8000 };
  sna[49179] = 0x00; sna[49180] = 0xc0; // PC $C000
  sna[49181] = 0x17; // 7FFD: bank 7, ROM 1
  let o = 49183;
  for (const n of [0, 1, 3, 4, 6]) { banks[n] = o; o += 0x4000; }
  sna.set([0x3e, 0x06, 0xd3, 0xfe, 0x18, 0xfe], banks[7]);
  const m = makeMachine({ model: '128k' });
  check('a 128K .sna asks for a 128K', snapshotModel(sna) === '128k');
  m.loadSnapshot(sna);
  m.runFrame();
  check('128K .sna: paging and PC', m.port7ffd === 0x17 && m.border === 6);
}

// a .z80 version 1, packed
{
  const ram = new Uint8Array(0xc000);
  ram.set([0x3e, 0x04, 0xd3, 0xfe, 0x18, 0xfe], 0x4000); // at $8000
  const packed = [];
  for (let i = 0; i < ram.length;) {
    let n = 1;
    while (i + n < ram.length && ram[i + n] === ram[i] && n < 255) n++;
    if (n >= 5) { packed.push(0xed, 0xed, n, ram[i]); i += n; } else { packed.push(ram[i]); i++; }
  }
  const head = new Uint8Array(30);
  head[6] = 0x00; head[7] = 0x80; // PC
  head[8] = 0x00; head[9] = 0xf0; // SP
  head[12] = 0x20 | (2 << 1); // packed, border 2
  head[29] = 1;
  const z = new Uint8Array([...head, ...packed, 0, 0xed, 0xed, 0]);
  const m = makeMachine({ model: '48k' });
  m.loadSnapshot(z);
  check('.z80 version 1: border', m.border === 2);
  m.runFrame();
  check('.z80 version 1 runs', m.border === 4 && m.cpu.pc === 0x8004);
}

done();
