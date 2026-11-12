// The Spectrum Next's picture: the ULA through the Next's palettes and transparency, Layer 2
// in its three modes (scroll, clip, mapping into memory), palettes through the Next
// registers, the tilemap (attributes, mirror, rotate, text mode), sprites (ports, priority,
// scaling, 4-bit patterns, relative sprites, collision), the layer orders and blending, a
// change partway down the frame, and save states. Expected values from docs/next-video.md.
import { SpectrumNext } from '../../web/js/emu/next.js';
import { NEXT_RGBA } from '../../web/js/emu/nextvideo.js';
import { FB_WIDTH, BORDER } from '../../web/js/emu/video.js';
import { loadRoms, runFrames, makeChecker } from './util.mjs';

const { check, done } = makeChecker();
const roms = loadRoms();
const SX = (BORDER - 32) * 2, SY = BORDER - 32;
const hex = (v) => '$' + (v >>> 0).toString(16).toUpperCase();

// a Next with the CPU in a loop of its own (interrupts off) and a clear screen
function fresh() {
  const m = new SpectrumNext({ roms });
  m.injectBinary([0xf3, 0x18, 0xfe], 0x8000, 0x8000);
  m.banks[5].fill(0, 0, 0x1800);
  m.banks[5].fill(0x38, 0x1800, 0x1b00); // black on white
  return m;
}
const nr = (m, r, v) => m.nextRegWrite(r, v);
// the frame buffer at (x, y) of the 320x256 area (h: the right half of a pixel)
const at = (m, x, y, h = 0) => m.video.fb[(SY + y) * FB_WIDTH + SX + x * 2 + h];
const rgb8 = (c) => (c << 1) | (((c >> 1) | c) & 1); // an 8-bit colour as the palette keeps it
function is(name, m, x, y, rgb9, h = 0) {
  const got = at(m, x, y, h);
  check(name, got === NEXT_RGBA[rgb9], `got ${hex(got)}, want ${hex(NEXT_RGBA[rgb9])} (${hex(rgb9)})`);
}
const frame = (m) => runFrames(m, 1);

// ---- the ULA through the Next's ULA palette
let m = fresh();
m.banks[5][0] = 0x80; // the paper's first pixel is ink
frame(m);
is('ULA ink (black)', m, 32, 32, 0x000);
is('ULA paper (white, the Next\'s 0x16D)', m, 33, 32, 0x16d);
is('border (white)', m, 0, 0, 0x16d);
// paper white (index 23) made the transparent colour: the fallback shows
nr(m, 0x4a, 0x1c);
nr(m, 0x43, 0x00);
nr(m, 0x40, 23);
nr(m, 0x41, 0xe3);
frame(m);
is('transparent ULA paper shows the fallback', m, 33, 32, rgb8(0x1c));
is('ULA ink still black', m, 32, 32, 0x000);
nr(m, 0x68, 0x80);
frame(m);
is('ULA off: the fallback everywhere', m, 32, 32, rgb8(0x1c));

// ---- ULA scroll and clip
m = fresh();
m.banks[5][2] = 0x80; // the pixel at x 16
nr(m, 0x26, 8);
frame(m);
is('ULA scroll x 8: x 16 shows at 8', m, 32 + 8, 32, 0x000);
nr(m, 0x26, 0);
nr(m, 0x1c, 4);
[8, 255, 0, 191].forEach((v) => nr(m, 0x1a, v));
nr(m, 0x4a, 0x03);
frame(m);
is('ULA clip: left of x 8 is clear', m, 32 + 2, 32, rgb8(0x03));
is('ULA clip: the border isn\'t clipped', m, 0, 0, 0x16d);

// ---- Layer 2, 256x192
m = fresh();
m.ioWrite(0x123b, 0x02);
const L2 = 8 * 0x4000;
m.mem.fill(0xe3, L2, L2 + 3 * 0x4000); // all transparent
m.mem[L2 + 10 * 256 + 20] = 0x1c;
frame(m);
is('Layer 2 256: a pixel', m, 32 + 20, 32 + 10, rgb8(0x1c));
is('Layer 2 256: $E3 is clear', m, 32 + 21, 32 + 10, 0x16d);
nr(m, 0x16, 5);
nr(m, 0x17, 4);
frame(m);
is('Layer 2 256: scroll', m, 32 + 15, 32 + 6, rgb8(0x1c));
nr(m, 0x70, 0x01); // palette offset 1: $1C becomes $2C
nr(m, 0x16, 0);
nr(m, 0x17, 0);
frame(m);
is('Layer 2: palette offset', m, 32 + 20, 32 + 10, rgb8(0x2c));

// ---- Layer 2, 320x256 and 640x256 (by columns)
m = fresh();
m.ioWrite(0x123b, 0x02);
m.mem.fill(0xe3, L2, L2 + 5 * 0x4000);
nr(m, 0x1c, 1);
[0, 159, 0, 255].forEach((v) => nr(m, 0x18, v));
nr(m, 0x70, 0x10);
m.mem[L2 + 3 * 256 + 7] = 0xe0;
m.mem[L2 + 300 * 256 + 250] = 0x03;
frame(m);
is('Layer 2 320: (3, 7) over the border', m, 3, 7, rgb8(0xe0));
is('Layer 2 320: (300, 250)', m, 300, 250, rgb8(0x03));
nr(m, 0x70, 0x20);
m.mem[L2 + 3 * 256 + 7] = 0x12;
frame(m);
is('Layer 2 640: high nibble on the left', m, 3, 7, rgb8(0x01), 0);
is('Layer 2 640: low nibble on the right', m, 3, 7, rgb8(0x02), 1);

// ---- writing Layer 2 through port $123B's mapping
m = fresh();
m.ioWrite(0x123b, 0x01);
m.write(0x0010, 0x55);
check('Layer 2 write mapping', m.mem[L2 + 0x10] === 0x55 && m.read(0x0010) === roms.rom128[0x10]);
m.ioWrite(0x123b, 0x05);
check('Layer 2 read mapping', m.read(0x0010) === 0x55);
m.ioWrite(0x123b, 0x41);
m.write(0x0010, 0x66);
check('Layer 2 mapping segment 1', m.mem[L2 + 0x4000 + 0x10] === 0x66);
m.ioWrite(0x123b, 0x11); // the bank offset form: +1
m.ioWrite(0x123b, 0x01);
m.write(0x0000, 0x77);
check('Layer 2 mapping bank offset', m.mem[L2 + 0x4000] === 0x77);

// ---- palettes through the Next registers
m = fresh();
nr(m, 0x43, 0x10); // Layer 2's first palette
nr(m, 0x40, 5);
nr(m, 0x44, 0xab);
nr(m, 0x44, 0x81);
check('NR $44: 9-bit colour and priority', m.video.pal[256 + 5] === ((0xab << 1) | 1) && m.video.prio[256 + 5] === 2);
check('NR $44 moved on', m.nextRegRead(0x40) === 6);
nr(m, 0x40, 5);
check('NR $41 and $44 read back', m.nextRegRead(0x41) === 0xab && m.nextRegRead(0x44) === 0x81);
nr(m, 0x41, 0x02);
check('NR $41: blue\'s low bit from the others', m.video.pal[256 + 5] === 0x005 && m.video.prio[256 + 5] === 0);
nr(m, 0x43, 0x90); // no auto-increment
nr(m, 0x40, 9);
nr(m, 0x41, 0x11);
check('NR $43 bit 7: no increment', m.nextRegRead(0x40) === 9);

// ---- sprites
// a 16x16 8-bit pattern n of colour c (transparent with c = $E3)
function pattern(m, n, c) {
  m.ioWrite(0x303b, n);
  for (let i = 0; i < 256; i++) m.ioWrite(0x5b, c);
}
function sprite(m, n, bytes) {
  m.ioWrite(0x303b, n);
  for (const b of bytes) m.ioWrite(0x57, b);
}
m = fresh();
pattern(m, 0, 0x1c);
pattern(m, 1, 0xe0);
nr(m, 0x15, 0x01);
sprite(m, 0, [32, 32, 0, 0x80]);
frame(m);
is('sprite at (32, 32)', m, 32, 32, rgb8(0x1c));
is('sprite 16 wide', m, 47, 47, rgb8(0x1c));
is('not at 48', m, 48, 32, 0x16d);
sprite(m, 1, [40, 32, 0, 0x81]);
frame(m);
is('sprite 127 side on top: the later one', m, 41, 33, rgb8(0xe0));
check('collision flag', (m.ioRead(0x303b) & 1) === 1 && m.ioRead(0x303b) === 0);
nr(m, 0x15, 0x41);
frame(m);
is('NR $15 bit 6: sprite 0 on top', m, 41, 33, rgb8(0x1c));
nr(m, 0x15, 0x01);
sprite(m, 1, [0, 0, 0, 0x00]); // hidden
sprite(m, 0, [32, 32, 0, 0xc0, 0x08]); // x2 across
frame(m);
is('scaled x2: 32 wide', m, 32 + 31, 32, rgb8(0x1c));
is('scaled x2: 16 high', m, 32, 47, rgb8(0x1c));
is('scaled x2: not 17', m, 32, 48, 0x16d);
sprite(m, 0, [0, 0, 0, 0x80]); // over the border: clipped by default
frame(m);
is('clip: off the paper by default', m, 0, 0, 0x16d);
nr(m, 0x15, 0x03);
frame(m);
is('NR $15 bit 1: over the border', m, 0, 0, rgb8(0x1c));
// rotate and mirror: pattern 2 has a red top row; X mirror + rotate is a transpose (red left
// column), rotate alone is 90° clockwise (red right column), Y mirror puts it at the bottom
m = fresh();
m.ioWrite(0x303b, 2);
for (let i = 0; i < 256; i++) m.ioWrite(0x5b, i < 16 ? 0xe0 : 0x1c);
nr(m, 0x15, 0x01);
sprite(m, 0, [32, 32, 0x0a, 0x82]);
sprite(m, 1, [64, 32, 0x02, 0x82]);
sprite(m, 2, [96, 32, 0x04, 0x82]);
frame(m);
is('X mirror + rotate: red left column', m, 32, 40, rgb8(0xe0));
is('X mirror + rotate: not the top row', m, 40, 32, rgb8(0x1c));
is('rotate: red right column', m, 64 + 15, 40, rgb8(0xe0));
is('Y mirror: red bottom row', m, 100, 32 + 15, rgb8(0xe0));
// 4-bit: pattern 4 (128 bytes at 2 * 256), nibbles 1 and 2, palette offset 3
m = fresh();
m.ioWrite(0x303b, 2);
for (let i = 0; i < 128; i++) m.ioWrite(0x5b, 0x12);
nr(m, 0x15, 0x01);
sprite(m, 0, [32, 32, 0x30, 0xc2, 0x80]); // H, N5-0 = 2, N6 = 0
frame(m);
is('4-bit sprite: even pixel = high nibble + offset', m, 32, 32, rgb8(0x31));
is('4-bit sprite: odd pixel', m, 33, 32, rgb8(0x32));
// a relative sprite 20 to the right of its anchor, using the anchor's pattern + 1
m = fresh();
pattern(m, 0, 0x1c);
pattern(m, 1, 0xe0);
nr(m, 0x15, 0x01);
sprite(m, 0, [100, 100, 0, 0xc0, 0x00]); // anchor, E set, 8-bit
sprite(m, 1, [20, 0, 0, 0xc0, 0x41]); // relative (01), pattern 0 + anchor's pattern... + rel
frame(m);
is('anchor', m, 100, 100, rgb8(0x1c));
is('relative at +20, its pattern relative to the anchor\'s', m, 120, 100, rgb8(0x1c));
sprite(m, 1, [20, 0, 0, 0xc1, 0x41]);
frame(m);
is('relative pattern 1 + anchor 0', m, 120, 100, rgb8(0xe0));
sprite(m, 0, [100, 100, 0, 0x40, 0x00]); // anchor hidden
frame(m);
is('relative hidden with its anchor', m, 120, 100, 0x16d);

// ---- the tilemap: 40x32, attributes, at $6C00, tiles at $4C00
m = fresh();
const b5 = m.banks[5];
b5.fill(0xff, 0x0c00, 0x0c00 + 64); // tiles 0 and 1 all index 15 (clear)
b5[0x0c00 + 32] = 0x12; // tile 1, row 0: index 1, index 2, then clear
b5[0x0c00 + 32 + 3] = 0x34; // pixels 6, 7: index 3, 4
b5.fill(0, 0x2c00, 0x2c00 + 40 * 32 * 2);
b5[0x2c00] = 1; // tile 1 at (0, 0)
nr(m, 0x6b, 0x80);
frame(m);
is('tile pixel 0 = index 1', m, 0, 0, rgb8(1));
is('tile pixel 1 = index 2', m, 1, 0, rgb8(2));
is('index 15 is clear: the ULA border', m, 2, 0, 0x16d);
b5[0x2c01] = 0x08; // X mirror
frame(m);
is('X mirror: pixel 0 = pixel 7', m, 0, 0, rgb8(4));
b5[0x2c01] = 0x52; // rotate, palette offset 5
frame(m);
is('rotate: (0,0) from (0,7)... row 0 col 0 unchanged at the corner', m, 7, 0, rgb8(0x51));
b5[0x2c01] = 0x00;
nr(m, 0x30, 1);
frame(m);
is('tilemap scroll x 1', m, 0, 0, rgb8(2));
nr(m, 0x30, 0);
// text mode: 1 bit a pixel, 8 bytes a tile, attribute bits 7-1 + the bit
nr(m, 0x6b, 0x88);
b5[0x0c00 + 8] = 0x80;
b5[0x2c01] = 0x40;
frame(m);
is('text mode: set bit', m, 0, 0, rgb8(0x41));
is('text mode: clear bit = index $40', m, 1, 0, rgb8(0x40));

// ---- layer order and Layer 2's priority colour
m = fresh();
pattern(m, 0, 0x1c);
nr(m, 0x15, 0x01);
sprite(m, 0, [32, 32, 0, 0x80]);
m.ioWrite(0x123b, 0x02);
m.mem.fill(0xe0, L2, L2 + 3 * 0x4000); // Layer 2 all red
frame(m);
is('S L U: the sprite over Layer 2', m, 32, 32, rgb8(0x1c));
is('S L U: Layer 2 over the ULA', m, 40, 50, rgb8(0xe0));
nr(m, 0x15, 0x05); // L S U
frame(m);
is('L S U: Layer 2 over the sprite', m, 32, 32, rgb8(0xe0));
nr(m, 0x15, 0x11); // U S L: the ULA's white paper on top
frame(m);
is('U S L: the ULA on top', m, 32, 32, 0x16d);
nr(m, 0x43, 0x10);
nr(m, 0x40, 0xe0);
nr(m, 0x44, 0xe0);
nr(m, 0x44, 0x80); // priority bit
frame(m);
is('Layer 2 priority colour over everything', m, 32, 32, 0x1c0);
// blend: Layer 2 + the ULA, each part to 7 at most
m = fresh();
m.ioWrite(0x123b, 0x02);
m.mem.fill(0x24, L2, L2 + 3 * 0x4000); // 001 001 00 (+B0 0): 0x048
nr(m, 0x15, 0x18); // mode 110
frame(m);
// Layer 2 001 001 000 + the ULA's white 101 101 101 = 110 110 101
is('blend add: Layer 2 + the ULA', m, 33, 32, (6 << 6) | (6 << 3) | 5);

// ---- a change partway down the frame: the lines after it only
m = fresh();
m.ioWrite(0x123b, 0x02);
m.mem.fill(0xe3, L2, L2 + 3 * 0x4000);
for (let y = 0; y < 192; y++) m.mem[L2 + y * 256 + 100] = 0x1c;
frame(m);
m.runCycles(m.timing.paper + 96 * m.timing.line); // to about paper line 96
nr(m, 0x16, 50);
runFrames(m, 1);
is('raster split: above, unscrolled', m, 32 + 100, 32 + 40, rgb8(0x1c));
is('raster split: below, scrolled', m, 32 + 50, 32 + 150, rgb8(0x1c));

// ---- save states keep the palettes and sprites
m = fresh();
pattern(m, 0, 0x1c);
nr(m, 0x15, 0x01);
sprite(m, 0, [32, 32, 0, 0x80]);
nr(m, 0x43, 0x20);
nr(m, 0x40, 0x1c);
nr(m, 0x41, 0x03);
frame(m);
const st = m.saveState();
const m2 = new SpectrumNext({ roms });
m2.loadState(st);
frame(m2);
is('state: sprite and its palette colour', m2, 32, 32, rgb8(0x03));

done();
