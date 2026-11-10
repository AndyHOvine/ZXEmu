// Tapes: .tap loaded at once (flash load) and as real edges, on the 48K and 128K; the TZX
// blocks' pulses; .wav and .csw recordings of a tape; the loader starting and stopping the
// tape; SAVE to the saved tape; ZIP files.
import zlib from 'node:zlib';
import { makeMachine, screenText, makeChecker, basicTap, runUntilText } from './util.mjs';
import { planAutostart } from '../../web/js/emu/autostart.js';
import { Tape, parseTzx, isTap } from '../../web/js/emu/tape.js';
import { expand, detectType } from '../../web/js/emu/media.js';

const { check, done } = makeChecker();

const tap = basicTap([[10, 'PRINT "LOADED OK"'], [20, 'GO TO 20']]);
check('a .tap is recognised', isTap(tap) && detectType('x.tap', tap) === 'tape');

function load(bytes, { model = '48k', flashLoad = true, seconds = 40 } = {}) {
  const m = makeMachine({ model, flashLoad });
  m.insertTape(bytes);
  planAutostart(m, { tape: bytes }, {});
  const ok = runUntilText(m, 'LOADED OK', seconds);
  return { m, ok };
}

for (const model of ['48k', '128k', 'plus3']) {
  const { m, ok } = load(tap, { model });
  check(`${model}: flash load`, ok, screenText(m).join('|'));
  check(`${model}: flash load leaves the tape stopped`, !m.tape.playing);
}
for (const model of ['48k', '128k']) {
  const { m, ok } = load(tap, { model, flashLoad: false });
  check(`${model}: loads from real edges`, ok, screenText(m).join('|'));
  for (let i = 0; i < 150; i++) m.runFrame();
  check(`${model}: the tape stops once the program is loaded`, !m.tape.playing, `${m.tape.playing} ${m.tape.atEnd}`);
}

// ---- pulses from TZX blocks
function pulses(blocks, limit = 100000) {
  const t = new Tape();
  t.blocks = blocks;
  t.present = true;
  t.reset();
  t.play(0);
  const out = [];
  let last = 0, lv = 0;
  t.advanceTo(1e12, (at, level) => {
    if (out.length < limit) out.push([Math.round(at - last), lv]);
    last = at;
    lv = level;
  });
  return out;
}
const w16 = (n) => [n & 0xff, n >> 8];
const tzx = (...blocks) => new Uint8Array([...'ZXTape!'].map((c) => c.charCodeAt(0)).concat([0x1a, 1, 20], ...blocks));
{
  const blocks = parseTzx(tzx(
    [0x12, ...w16(1000), ...w16(3)], // pure tone: 3 pulses of 1000
    [0x13, 2, ...w16(300), ...w16(400)], // pulse sequence
    [0x14, ...w16(500), ...w16(900), 2, ...w16(0), 1, 0, 0, 0xc0], // pure data: bits 1, 1 (2 used bits)
    [0x24, ...w16(2)], [0x12, ...w16(700), ...w16(1)], [0x25], // a loop of 2
    [0x20, ...w16(10)], // 10 ms pause
  ));
  const p = pulses(blocks);
  const lens = p.map((x) => x[0]);
  check('TZX pure tone', lens.slice(0, 3).join() === '1000,1000,1000', lens.slice(0, 6).join());
  check('TZX pulse sequence', lens.slice(3, 5).join() === '300,400', lens.slice(0, 8).join());
  check('TZX pure data: two 1 bits', lens.slice(5, 9).join() === '900,900,900,900', lens.join());
  check('TZX loop played twice', lens.slice(9, 12).join() === '700,700,3500', lens.join());
}
{
  // turbo block 0x11: pilot 4 x 2000, syncs 600/700, bits 400/800, one byte $80
  const blocks = parseTzx(tzx([0x11, ...w16(2000), ...w16(600), ...w16(700), ...w16(400), ...w16(800), ...w16(4), 8, ...w16(0), 1, 0, 0, 0x80]));
  const lens = pulses(blocks).map((x) => x[0]);
  check('TZX turbo block', lens.join() === '2000,2000,2000,2000,600,700,800,800,400,400,400,400,400,400,400,400,400,400,400,400,400,400', lens.join());
}
{
  // direct recording: 3 samples high, 2 low, of 100 T-states each
  const blocks = parseTzx(tzx([0x15, ...w16(100), ...w16(0), 5, 1, 0, 0, 0b11100000]));
  const p = pulses(blocks);
  check('TZX direct recording', p.length >= 2 && p[1][0] === 300 && p[1][1] === 1, JSON.stringify(p.slice(0, 4)));
}

// ---- the tape recorded as sound: .wav (44.1 kHz) and .csw (RLE), loaded as edges
function recording(bytes, rate) {
  const t = new Tape();
  t.insert(bytes);
  t.play(0);
  const runs = [];
  let last = 0;
  t.advanceTo(1e12, (at) => { runs.push(at - last); last = at; });
  return runs.map((r) => Math.max(1, Math.round((r * rate) / 3500000)));
}
{
  const runs = recording(tap, 44100);
  const n = runs.reduce((a, b) => a + b, 0) + 44100;
  const pcm = new Uint8Array(n);
  let o = 0, high = false;
  for (const r of runs) { pcm.fill(high ? 200 : 56, o, o + r); o += r; high = !high; }
  pcm.fill(128, o);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + n, 4); head.write('WAVE', 8); head.write('fmt ', 12);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(44100, 24);
  head.writeUInt32LE(44100, 28); head.writeUInt16LE(1, 32); head.writeUInt16LE(8, 34); head.write('data', 36); head.writeUInt32LE(n, 40);
  const wav = new Uint8Array(Buffer.concat([head, Buffer.from(pcm)]));
  check('a .wav is a tape', detectType('x.wav', wav) === 'tape');
  const { m, ok } = load(wav, { flashLoad: true });
  check('48K loads a .wav recording', ok, screenText(m).join('|'));

  const csw = [];
  for (const r of recording(tap, 44100)) { if (r < 256) csw.push(r); else csw.push(0, r & 0xff, (r >> 8) & 0xff, (r >> 16) & 0xff, 0); }
  const cswHead = new Uint8Array(0x20);
  cswHead.set([...'Compressed Square Wave'].map((c) => c.charCodeAt(0)));
  cswHead[0x16] = 0x1a; cswHead[0x17] = 1; cswHead[0x18] = 1;
  cswHead.set(w16(44100), 0x19);
  cswHead[0x1b] = 1;
  const cswFile = new Uint8Array([...cswHead, ...csw]);
  const r2 = load(cswFile);
  check('48K loads a .csw recording', r2.ok, screenText(r2.m).join('|'));
}

// ---- SAVE: blocks the program saves go on the saved tape
{
  // SAVE "hi" CODE 16384,10 by keys (S is SAVE, CODE is EXTEND then I), then a key for
  // "Start tape, then press any key"
  const m2 = makeMachine({ model: '48k' });
  m2.typeText('s"hi"');
  m2.typeKeys('EXTEND');
  m2.typeKeys('I');
  m2.typeText('16384,10\r');
  m2.typeWait(30);
  m2.typeKeys('M');
  for (let i = 0; i < 400; i++) m2.runFrame();
  const saved = m2.tape.saved;
  check('SAVE "hi" CODE makes a header and a block', saved.length === 2 && saved[0][0] === 0 && saved[0][1] === 3 && saved[1].length === 12,
    `${saved.length} ${saved.map((b) => b.length).join(',')} ${screenText(m2).join('|')}`);
  const back = m2.tape.savedTap();
  check('the saved tape is a .tap', isTap(back));
}

// ---- a ZIP holding the tape
{
  const data = Buffer.from(tap);
  const packed = zlib.deflateRawSync(data);
  const name = Buffer.from('game.tap');
  const crc = (() => { let c = -1; for (const b of data) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ -1) >>> 0; })();
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const body = Buffer.concat([local, name, packed]);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(body.length, 16);
  const zip = new Uint8Array(Buffer.concat([body, central, name, end]));
  const items = await expand('game.zip', zip);
  check('a ZIP gives its tape', items.length === 1 && items[0].type === 'tape' && items[0].data.length === tap.length);
}

done();
