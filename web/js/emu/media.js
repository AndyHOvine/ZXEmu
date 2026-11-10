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

export function isTape(bytes) {
  return ascii(bytes, 0, 7) === 'ZXTape!' ||
    ascii(bytes, 0, 19) === 'Creative Voice File' ||
    ascii(bytes, 0, 22) === 'Compressed Square Wave' ||
    (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE');
}

export function isSna(bytes) {
  return ascii(bytes, 0, 8) === 'MV - SNA';
}

export function isCpr(bytes) {
  return ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'AMS!';
}

export function amsdosHeader(d) {
  if (d.length < 128) return false;
  let sum = 0;
  for (let i = 0; i < 67; i++) sum += d[i];
  return sum !== 0 && (sum & 0xFFFF) === (d[67] | (d[68] << 8));
}

export function isZip(bytes) {
  return bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export function detectType(name, bytes) {
  const e = ext(name);
  if (isZip(bytes)) return 'zip';
  if (isDsk(bytes)) return 'disk';
  if (isSna(bytes)) return 'snapshot';
  if (isCpr(bytes)) return 'cart';
  if (isTape(bytes)) return 'tape';
  if (amsdosHeader(bytes)) return 'bin';
  if (e === 'bin') return 'bin';
  return null;
}

export function parseBinary(bytes, load, exec) {
  if (amsdosHeader(bytes)) {
    const w = (o) => bytes[o] | (bytes[o + 1] << 8);
    const len = w(0x40) | (bytes[0x42] << 16);
    const data = bytes.subarray(128, 128 + (len || w(0x18)));
    return { type: bytes[0x12] & 0x0E ? 2 : bytes[0x12] & 1, load: load ?? w(0x15), exec: exec ?? w(0x1A), data };
  }
  if (load === undefined || load === null) throw new Error('A binary without an AMSDOS header needs a load address');
  return { type: 2, load, exec: exec ?? load, data: bytes };
}

export async function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054B50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Invalid ZIP file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014B50) break;
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
  gz.set([0x1F, 0x8B, 8, 0, 0, 0, 0, 0, 0, 0xFF]);
  gz.set(raw, 10);
  const t = raw.length + 10;
  for (let i = 0; i < 4; i++) {
    gz[t + i] = (crc >>> (8 * i)) & 0xFF;
    gz[t + 4 + i] = (size >>> (8 * i)) & 0xFF;
  }
  const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

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

export async function expand(name, bytes) {
  const type = detectType(name, bytes);
  if (type !== 'zip') return type ? [await item(name, type, bytes)] : [];
  const out = [];
  for (const f of await unzip(bytes)) {
    const t = detectType(f.name, f.data);
    if (t && t !== 'zip') out.push(await item(f.name, t, f.data));
  }
  return out;
}
