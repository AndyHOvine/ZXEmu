// What a file is, for ZXEmu. GPL v2 or later, see LICENSE.

import { isTapeFile, isTap } from './tape.js';
import { isSna, isZ80 } from './snapshot.js';

function ext(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function ascii(bytes, start, len) {
  return String.fromCharCode(...bytes.subarray(start, start + len));
}

export function isDsk(bytes) {
  const s = ascii(bytes, 0, 8);
  return s === 'MV - CPC' || s === 'EXTENDED';
}

export function isZip(bytes) {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

// tape, snapshot, disk, cart (Interface 2), bin (bytes to put in memory), nex (a Spectrum Next
// program), or null
export function detectType(name, bytes) {
  const e = ext(name);
  if (isZip(bytes)) return 'zip';
  if (e === 'nex' || (bytes.length >= 512 && ascii(bytes, 0, 4) === 'Next')) return 'nex';
  if (isDsk(bytes)) return 'disk';
  if (isTapeFile(bytes)) return 'tape';
  if (e === 'tap' || (e !== 'bin' && e !== 'rom' && e !== 'scr' && isTap(bytes))) return 'tape';
  if (e === 'sna' || e === 'z80' || isSna(bytes) || isZ80(bytes, name)) return 'snapshot';
  if (e === 'rom' && bytes.length <= 0x4000) return 'cart';
  if (e === 'bin' || e === 'scr' || e === 'code') return 'bin';
  return null;
}

// a binary: bytes put at `load` and run from `exec` (a .scr goes on the screen, not run)
export function parseBinary(bytes, load, exec, name = '') {
  if (ext(name) === 'scr' && bytes.length === 6912 && (load === undefined || load === null)) {
    return { load: 0x4000, exec: null, data: bytes };
  }
  if (load === undefined || load === null) throw new Error('A binary needs a load address (load=&8000)');
  return { load, exec: exec ?? load, data: bytes };
}

export async function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Invalid ZIP file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const lNameLen = dv.getUint16(local + 26, true);
    const lExtraLen = dv.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = await inflate(raw, crc, usize);
    else continue;
    files.push({ name: name.split('/').pop(), data });
  }
  return files;
}

async function inflate(raw, crc, size) {
  const gz = new Uint8Array(raw.length + 18);
  gz.set([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]);
  gz.set(raw, 10);
  const t = raw.length + 10;
  for (let i = 0; i < 4; i++) {
    gz[t + i] = (crc >>> (8 * i)) & 0xff;
    gz[t + 4 + i] = (size >>> (8 * i)) & 0xff;
  }
  const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// a CSW version 2 file packed with Z-RLE: unpacked to RLE (version 1 data) for the tape
async function cswToRle(bytes) {
  if (ascii(bytes, 0, 22) !== 'Compressed Square Wave' || bytes[0x17] !== 2 || bytes[0x21] !== 2) return bytes;
  const start = 0x34 + bytes[0x23];
  const stream = new Blob([bytes.subarray(start)]).stream().pipeThrough(new DecompressionStream('deflate'));
  const data = new Uint8Array(await new Response(stream).arrayBuffer());
  const out = new Uint8Array(start + data.length);
  out.set(bytes.subarray(0, start));
  out[0x21] = 1;
  out.set(data, start);
  return out;
}

async function item(name, type, data) {
  return { name, type, data: type === 'tape' ? await cswToRle(data) : data };
}

// the files in a file (a ZIP's, or itself), with their types; a ZIP's other files are 'file'
// (the Next's SD card takes them)
export async function expand(name, bytes) {
  const type = detectType(name, bytes);
  if (type !== 'zip') return type ? [await item(name, type, bytes)] : [];
  const out = [];
  for (const f of await unzip(bytes)) {
    const t = detectType(f.name, f.data);
    if (t && t !== 'zip') out.push(await item(f.name, t, f.data));
    else if (!t) out.push({ name: f.name, type: 'file', data: f.data });
  }
  return out;
}
