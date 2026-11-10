// Derived from Caprice32 src/slotshandler.cpp, written by Ulrich Doewich,
// Copyright (C) 1997-2015 Ulrich Doewich, (C) 2016-2025 Colin Pitrat.
// Ported to JavaScript and modified for AmsEmu, 2026; the +3 format added for ZXEmu.
// GPL v2 or later, see LICENSE.

export const TRACK_MAX = 102;
export const SECTOR_MAX = 29;

const EMPTY_TRACK = Object.freeze({
  sectors: Object.freeze([]), data: new Uint8Array(0), bps: 2, gap3: 0x4e, filler: 0xe5,
});

export function makeSector(c, h, r, n, st1, st2, off, total) {
  const size = 0x80 << Math.min(n, 8);
  const versions = size > 0 && size <= total ? Math.floor(total / size) : 1;
  return { c, h, r, n, st1, st2, off, size, total, versions, weakVer: 0 };
}

const FORMATS = {
  data: { ids: [0xc1, 0xc6, 0xc2, 0xc7, 0xc3, 0xc8, 0xc4, 0xc9, 0xc5], gap3: 0x52 },
  system: { ids: [0x41, 0x46, 0x42, 0x47, 0x43, 0x48, 0x44, 0x49, 0x45], gap3: 0x52 },
  ibm: { ids: [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08], gap3: 0x50 },
  plus3: { ids: [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09], gap3: 0x52 },
};

const DPB = {
  data: { first: 0xc1, spt: 9, off: 0, dsm: 179 },
  system: { first: 0x41, spt: 9, off: 2, dsm: 170 },
  ibm: { first: 0x01, spt: 8, off: 1, dsm: 155 },
  plus3: { first: 0x01, spt: 9, off: 1, dsm: 174 },
};

const ascii = (bytes, start, len) => {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[start + i]);
  return s;
};

export class DskImage {
  constructor() {
    this.tracks = 0;
    this.sides = 1;
    this.randomDEs = false;
    this.track = [];
    this.dirty = false;
  }

  getTrack(t, s) {
    const row = this.track[t];
    return (row && row[s]) || EMPTY_TRACK;
  }

  setTrack(t, s, tr) {
    while (this.track.length <= t) this.track.push([]);
    this.track[t][s] = tr;
    if (t >= this.tracks) this.tracks = t + 1;
  }

  static parse(input) {
    const b = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (b.length < 0x100) throw new Error('Not a disk image: file too short');
    const img = new DskImage();
    const sig = ascii(b, 0, 8);
    const ext = sig === 'EXTENDED';
    if (!ext && sig !== 'MV - CPC') throw new Error('Not a CPC disk image (no "MV - CPC" or "EXTENDED" signature)');
    img.tracks = Math.min(b[0x30], TRACK_MAX);
    let sides = ext ? b[0x31] & 3 : b[0x31];
    if (ext) img.randomDEs = (b[0x31] & 0x80) !== 0;
    if (sides > 2) throw new Error(`Disk image has ${sides} sides, at most 2 supported`);
    img.sides = sides || 1;
    const stdTrackSize = Math.max(0, b[0x32] + (b[0x33] << 8) - 0x100);
    let pos = 0x100;
    let tableIdx = 0x34;
    for (let t = 0; t < img.tracks; t++) {
      img.track.push([]);
      for (let s = 0; s < img.sides; s++) {
        let trackSize = stdTrackSize;
        if (ext) {
          trackSize = b[tableIdx++] << 8;
          if (trackSize === 0) { img.track[t][s] = null; continue; }
          trackSize -= 0x100;
        }
        if (pos + 0x100 > b.length) { img.track[t][s] = null; continue; }
        if (ascii(b, pos, 10) !== 'Track-Info') {
          throw new Error(`Corrupt disk image: bad track header for track ${t} side ${s}`);
        }
        const count = b[pos + 0x15];
        if (count > SECTOR_MAX) {
          throw new Error(`Disk image track ${t} side ${s} has ${count} sectors, at most ${SECTOR_MAX} supported`);
        }
        const bps = b[pos + 0x14];
        const sectors = [];
        let off = 0;
        for (let i = 0; i < count; i++) {
          const p = pos + 0x18 + i * 8;
          const total = ext ? b[p + 6] | (b[p + 7] << 8) : 0x80 << Math.min(bps, 8);
          sectors.push(makeSector(b[p], b[p + 1], b[p + 2], b[p + 3], b[p + 4], b[p + 5], off, total));
          off += total;
        }
        const data = new Uint8Array(Math.max(trackSize, off));
        const src = pos + 0x100;
        data.set(b.subarray(src, Math.min(src + trackSize, b.length)));
        img.track[t][s] = { sectors, data, bps, gap3: b[pos + 0x16], filler: b[pos + 0x17] };
        pos = src + trackSize;
      }
    }
    return img;
  }

  toBytes() {
    const sizes = [];
    let total = 0x100;
    for (let t = 0; t < this.tracks; t++) {
      for (let s = 0; s < this.sides; s++) {
        const tr = this.getTrack(t, s);
        const n = tr.sectors.length ? (0x100 + tr.data.length + 0xff) >> 8 : 0;
        sizes.push(n);
        total += n << 8;
      }
    }
    if (sizes.some((n) => n > 0xff)) throw new Error('Track too large for an EDSK image');
    const out = new Uint8Array(total);
    const put = (p, str) => { for (let i = 0; i < str.length; i++) out[p + i] = str.charCodeAt(i); };
    put(0, 'EXTENDED CPC DSK File\r\nDisk-Info\r\n');
    put(0x22, 'AmsEmu\r\n');
    out[0x30] = this.tracks;
    out[0x31] = this.sides | (this.randomDEs ? 0x80 : 0);
    out.set(sizes, 0x34);
    let pos = 0x100;
    let i = 0;
    for (let t = 0; t < this.tracks; t++) {
      for (let s = 0; s < this.sides; s++) {
        if (!sizes[i++]) continue;
        const tr = this.getTrack(t, s);
        put(pos, 'Track-Info\r\n');
        out[pos + 0x10] = t;
        out[pos + 0x11] = s;
        out[pos + 0x14] = tr.bps;
        out[pos + 0x15] = Math.min(tr.sectors.length, SECTOR_MAX);
        out[pos + 0x16] = tr.gap3;
        out[pos + 0x17] = tr.filler;
        tr.sectors.slice(0, SECTOR_MAX).forEach((sec, k) => {
          const p = pos + 0x18 + k * 8;
          out.set([sec.c, sec.h, sec.r, sec.n, sec.st1, sec.st2, sec.total & 0xff, sec.total >> 8], p);
        });
        out.set(tr.data, pos + 0x100);
        pos += sizes[i - 1] << 8;
      }
    }
    return out;
  }

  static blank(format = 'data') {
    const f = FORMATS[format];
    if (!f) throw new Error(`Unknown disk format "${format}"`);
    const img = new DskImage();
    img.tracks = 40;
    for (let t = 0; t < 40; t++) {
      const sectors = f.ids.map((r, i) => makeSector(t, 0, r, 2, 0, 0, i * 512, 512));
      const data = new Uint8Array(f.ids.length * 512).fill(0xe5);
      img.track.push([{ sectors, data, bps: 2, gap3: f.gap3, filler: 0xe5 }]);
    }
    // a +3 disk says what it is in its first sector, as +3DOS's FORMAT writes it
    if (format === 'plus3') img.track[0][0].data.set([0, 0, 40, 9, 2, 1, 3, 2, 0x2a, 0x52, 0, 0, 0, 0, 0, 0], 0);
    return img;
  }

  findSector(t, s, r) {
    const tr = this.getTrack(t, s);
    const sec = tr.sectors.find((x) => x.r === r);
    return sec ? { track: tr, sector: sec } : null;
  }

  readSector(t, s, r) {
    const f = this.findSector(t, s, r);
    if (!f) return null;
    const out = new Uint8Array(f.sector.size);
    out.set(f.track.data.subarray(f.sector.off, f.sector.off + f.sector.size));
    return out;
  }

  writeSector(t, s, r, bytes) {
    const f = this.findSector(t, s, r);
    if (!f) return false;
    const n = Math.min(bytes.length, f.sector.size, f.track.data.length - f.sector.off);
    f.track.data.set(bytes.subarray(0, n), f.sector.off);
    this.dirty = true;
    return true;
  }

  format() {
    const secs = this.getTrack(0, 0).sectors;
    if (!secs.length) return null;
    const min = Math.min(...secs.map((x) => x.r));
    if (min === 0xc1) return 'data';
    if (min === 0x41) return 'system';
    if (min === 0x01) return secs.length >= 9 ? 'plus3' : 'ibm';
    return null;
  }

  _readBlock(dpb, block) {
    const out = new Uint8Array(1024);
    for (let k = 0; k < 2; k++) {
      const idx = block * 2 + k;
      const sec = this.readSector(dpb.off + Math.floor(idx / dpb.spt), 0, dpb.first + (idx % dpb.spt));
      if (sec) out.set(sec.subarray(0, 512), k * 512);
    }
    return out;
  }

  _directory() {
    const fmt = this.format();
    if (!fmt) return { dpb: null, files: [] };
    const dpb = DPB[fmt];
    const dir = new Uint8Array(2048);
    dir.set(this._readBlock(dpb, 0), 0);
    dir.set(this._readBlock(dpb, 1), 1024);
    const files = new Map();
    for (let e = 0; e < 64; e++) {
      const p = e * 32;
      const user = dir[p];
      if (user > 15) continue;
      let rawName = '';
      for (let i = 1; i < 12; i++) rawName += String.fromCharCode(dir[p + i] & 0x7f);
      const key = `${user}:${rawName}`;
      let f = files.get(key);
      if (!f) {
        const name = rawName.slice(0, 8).trimEnd();
        const ext = rawName.slice(8).trimEnd();
        f = {
          user, name, ext,
          readOnly: (dir[p + 9] & 0x80) !== 0,
          system: (dir[p + 10] & 0x80) !== 0,
          hidden: /[\x00-\x1f\x7f]/.test(rawName),
          extents: [],
        };
        f.hidden = f.hidden || f.system;
        files.set(key, f);
      }
      f.extents.push({
        num: ((dir[p + 14] & 0x3f) << 5) | (dir[p + 12] & 0x1f),
        rc: Math.min(dir[p + 15], 0x80),
        blocks: Array.from(dir.subarray(p + 16, p + 32)),
      });
    }
    for (const f of files.values()) {
      f.extents.sort((a, b) => a.num - b.num);
      f.size = Math.max(...f.extents.map((x) => x.num * 128 + x.rc)) * 128;
    }
    return { dpb, files: [...files.values()] };
  }

  listFiles() {
    return this._directory().files.map(({ user, name, ext, size, system, readOnly, hidden }) =>
      ({ user, name, ext, size, system, readOnly, hidden }));
  }

  readFile(user, name, ext = '') {
    const { dpb, files } = this._directory();
    const N = name.toUpperCase().trim();
    const E = ext.toUpperCase().trim();
    const f = files.find((x) => (user == null || x.user === user) &&
      x.name.toUpperCase() === N && x.ext.toUpperCase() === E);
    if (!f) return null;
    const out = new Uint8Array(f.size);
    for (const x of f.extents) {
      const nblocks = Math.ceil(x.rc / 8);
      for (let k = 0; k < nblocks; k++) {
        const blk = x.blocks[k];
        if (!blk || blk > dpb.dsm) continue;
        const at = x.num * 16384 + k * 1024;
        if (at >= out.length) break;
        const data = this._readBlock(dpb, blk);
        out.set(data.subarray(0, Math.min(1024, out.length - at)), at);
      }
    }
    return out;
  }

  isCpmBoot() {
    if (this.format() !== 'system') return false;
    const boot = this.readSector(0, 0, 0x41);
    if (!boot || boot.every((v) => v === boot[0])) return false;
    for (const f of this.listFiles()) {
      if (['BAS', 'BIN', ''].includes(f.ext.toUpperCase())) return false;
      const head = this.readFile(f.user, f.name, f.ext);
      if (head && head.length >= 128 && hasAmsdosHeader(head)) return false;
    }
    return true;
  }
}

export function hasAmsdosHeader(b) {
  let sum = 0;
  for (let i = 0; i < 67; i++) sum += b[i];
  return sum !== 0 && (sum & 0xffff) === (b[67] | (b[68] << 8));
}
