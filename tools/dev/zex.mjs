// Runs ZEXDOC or ZEXALL (CP/M programs by Frank Cringle) on ZXEmu's Z80.
// Usage: node tools/dev/zex.mjs path/to/zexall.com
import fs from 'node:fs';
import { Z80 } from '../../web/js/emu/z80.js';

const mem = new Uint8Array(65536);
mem.set(fs.readFileSync(process.argv[2]), 0x100);
mem[0] = 0x76; // a jump to 0 ends it
mem[5] = 0xc9; // BDOS: answered by the trap below
const cpu = new Z80({ read: (a) => mem[a], write: (a, v) => { mem[a] = v; }, ioRead: () => 0xff, ioWrite: () => {}, intVector: () => 0xff });
cpu.intLen = 0;
cpu.ioContended = false;
cpu.pc = 0x100;
cpu.sp = 0xf000;
cpu.trapFlags = new Uint8Array(65536);
cpu.trapFlags[5] = 1;
let out = '';
const print = (s) => { process.stdout.write(s); out += s; };
cpu.onTrap = (pc) => {
  if (cpu.c === 2) print(String.fromCharCode(cpu.e));
  else if (cpu.c === 9) { let a = cpu.de; let s = ''; while (mem[a] !== 0x24) s += String.fromCharCode(mem[a++]); print(s); }
  return false;
};
const start = Date.now();
let n = 0;
while (!cpu.halted) { cpu.step(); n++; if (cpu.t > 1e9) cpu.t -= 1e9; }
console.log(`\n${n} instructions, ${((Date.now() - start) / 1000).toFixed(1)} s`);
process.exit(/ERROR/.test(out) ? 1 : 0);
