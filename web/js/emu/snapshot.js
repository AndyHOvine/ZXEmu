// Snapshots for ZXEmu, written for it in 2026. GPL v2 or later, see LICENSE.
//
// .sna (48K and 128K) and .z80 (versions 1, 2 and 3, packed or not) are read; .z80 version 3
// is written (saveZ80), so a game can be kept as a file.

const w16 = (b, o) => b[o] | (b[o + 1] << 8);

export function isSna(b) {
  return b.length === 49179 || b.length === 131103 || b.length === 147487;
}

export function isZ80(b, name = '') {
  if (/\.z80$/i.test(name)) return true;
  if (b.length < 30) return false;
  const pc = w16(b, 6);
  if (pc === 0) {
    const ext = w16(b, 30);
    return (ext === 23 || ext === 54 || ext === 55) && b.length > 32 + ext;
  }
  return false;
}

// the model a snapshot was taken on
export function snapshotModel(b) {
  if (isSna(b)) return b.length === 49179 ? '48k' : '128k';
  if (b.length >= 35 && w16(b, 6) === 0) {
    const ext = w16(b, 30), hw = b[34], mod = b[37] & 0x80;
    if (ext === 23) return hw >= 3 ? (mod ? 'plus2' : '128k') : mod ? '16k' : '48k';
    if (hw <= 3) return mod ? '16k' : '48k';
    if (hw === 4 || hw === 5 || hw === 6) return mod ? 'plus2' : '128k';
    if (hw === 7 || hw === 8) return mod ? 'plus2a' : 'plus3';
    if (hw === 12) return 'plus2';
    if (hw === 13) return 'plus2a';
    return '128k';
  }
  return b.length >= 30 ? '48k' : null;
}

function is128(m) { return m.info.paging !== '48'; }

export function loadSnapshot(m, b) {
  if (isSna(b)) loadSna(m, b);
  else loadZ80(m, b);
}

function setRegs(m, r) {
  const c = m.cpu;
  Object.assign(c, r);
  c.halted = 0;
  c.eiDelay = 0;
  c.t = r.t ?? 0;
}

function loadSna(m, b) {
  m.hardReset();
  const c = m.cpu;
  const regs = {
    i: b[0], l_: b[1], h_: b[2], e_: b[3], d_: b[4], c_: b[5], b_: b[6], f_: b[7], a_: b[8],
    l: b[9], h: b[10], e: b[11], d: b[12], c: b[13], b: b[14], iy: w16(b, 15), ix: w16(b, 17),
    iff2: (b[19] >> 2) & 1, r: b[20], f: b[21], a: b[22], sp: w16(b, 23), im: b[25] & 3,
  };
  regs.iff1 = regs.iff2;
  setRegs(m, regs);
  const border = b[26] & 7;
  if (b.length === 49179) {
    m.banks[5].set(b.subarray(27, 27 + 0x4000));
    m.banks[2].set(b.subarray(27 + 0x4000, 27 + 0x8000));
    m.banks[0].set(b.subarray(27 + 0x8000, 27 + 0xc000));
    // PC is on the stack
    c.pc = m.peek(c.sp) | (m.peek((c.sp + 1) & 0xffff) << 8);
    c.sp = (c.sp + 2) & 0xffff;
  } else {
    if (!is128(m)) throw new Error('A 128K snapshot needs a 128K Spectrum');
    const pc = w16(b, 49179), port = b[49181];
    const paged = port & 7;
    m.banks[5].set(b.subarray(27, 27 + 0x4000));
    m.banks[2].set(b.subarray(27 + 0x4000, 27 + 0x8000));
    m.banks[paged].set(b.subarray(27 + 0x8000, 27 + 0xc000));
    let o = 49183;
    for (let n = 0; n < 8; n++) {
      if (n === 5 || n === 2 || n === paged) continue;
      if (o + 0x4000 > b.length) break;
      m.banks[n].set(b.subarray(o, o + 0x4000));
      o += 0x4000;
    }
    m.pagingLocked = false;
    m.write7ffd(port);
    c.pc = pc;
  }
  m.border = border;
  m.video.border = border;
}

function unpack(src, out) {
  let i = 0, o = 0;
  while (i < src.length && o < out.length) {
    if (src[i] === 0xed && src[i + 1] === 0xed) {
      const n = src[i + 2], v = src[i + 3];
      for (let k = 0; k < n && o < out.length; k++) out[o++] = v;
      i += 4;
    } else {
      out[o++] = src[i++];
    }
  }
  return out;
}

function loadZ80(m, b) {
  m.hardReset();
  let flags = b[12];
  if (flags === 0xff) flags = 1;
  const regs = {
    a: b[0], f: b[1], c: b[2], b: b[3], l: b[4], h: b[5], sp: w16(b, 8), i: b[10],
    r: (b[11] & 0x7f) | ((flags & 1) << 7), e: b[13], d: b[14], c_: b[15], b_: b[16], e_: b[17], d_: b[18],
    l_: b[19], h_: b[20], a_: b[21], f_: b[22], iy: w16(b, 23), ix: w16(b, 25), iff1: b[27] ? 1 : 0, iff2: b[28] ? 1 : 0,
    im: b[29] & 3,
  };
  const border = (flags >> 1) & 7;
  let pc = w16(b, 6);
  if (pc !== 0) {
    // version 1: 48K, packed if bit 5 of flags
    const data = b.subarray(30);
    const ram = new Uint8Array(0xc000);
    if (flags & 0x20) unpack(data, ram);
    else ram.set(data.subarray(0, 0xc000));
    m.banks[5].set(ram.subarray(0, 0x4000));
    m.banks[2].set(ram.subarray(0x4000, 0x8000));
    m.banks[0].set(ram.subarray(0x8000));
  } else {
    const ext = w16(b, 30);
    pc = w16(b, 32);
    const hw = b[34];
    const v2 = ext === 23;
    const big = v2 ? hw >= 3 : hw >= 4;
    if (big && !is128(m)) throw new Error('This snapshot needs a 128K Spectrum');
    if (is128(m) && big) {
      m.pagingLocked = false;
      if (m.info.paging === 'plus3' && ext === 55) m.write1ffd(b[86]);
      m.write7ffd(b[35]);
    }
    if (m.info.ay) {
      m.psg.selectReg(0);
      for (let r = 0; r < 16; r++) { m.psg.selectReg(r); m.psg.writeReg(0, b[39 + r]); }
      m.psg.selectReg(b[38]);
    }
    let o = 32 + ext;
    while (o + 3 <= b.length) {
      const len = w16(b, o), page = b[o + 2];
      o += 3;
      const raw = len === 0xffff;
      const data = b.subarray(o, o + (raw ? 0x4000 : len));
      o += raw ? 0x4000 : len;
      let bank;
      if (big) bank = page - 3;
      else bank = { 4: 2, 5: 0, 8: 5 }[page];
      if (bank === undefined || bank < 0 || bank > 7) continue;
      if (raw) m.banks[bank].set(data);
      else unpack(data, m.banks[bank]);
    }
    if (!v2 && ext >= 54) {
      // the T-state counter: where in the frame it was
      const low = w16(b, 55), hi = b[57];
      const quarter = m.frameLen / 4;
      const t = ((hi + 1) % 4 + 1) * quarter - (low + 1);
      regs.t = Math.max(0, Math.min(m.frameLen - 1, Math.round(t)));
    }
  }
  regs.pc = pc;
  setRegs(m, regs);
  m.border = border;
  m.video.border = border;
}

function pack(data) {
  const out = [];
  for (let i = 0; i < data.length;) {
    const v = data[i];
    let n = 1;
    while (i + n < data.length && data[i + n] === v && n < 255) n++;
    if (n >= 5 || (v === 0xed && n >= 2)) {
      out.push(0xed, 0xed, n, v);
      i += n;
    } else if (v === 0xed) {
      // ED then one byte is never packed: write the next byte as it is
      out.push(0xed);
      i++;
      if (i < data.length) out.push(data[i++]);
    } else {
      out.push(v);
      i++;
    }
  }
  return out;
}

// the machine as a .z80 file (version 3, packed)
export function saveZ80(m) {
  const c = m.cpu;
  const h = new Uint8Array(32 + 54);
  const hw = { '16k': 0, '48k': 0, '128k': 4, plus2: 12, plus2a: 13, plus3: 7 }[m.model];
  h.set([c.a, c.f, c.c, c.b, c.l, c.h, 0, 0, c.sp & 0xff, c.sp >> 8, c.i, c.r & 0x7f,
    ((c.r >> 7) & 1) | ((m.border & 7) << 1), c.e, c.d, c.c_, c.b_, c.e_, c.d_, c.l_, c.h_, c.a_, c.f_,
    c.iy & 0xff, c.iy >> 8, c.ix & 0xff, c.ix >> 8, c.iff1, c.iff2, c.im & 3], 0);
  h[30] = 54;
  h[32] = c.pc & 0xff; h[33] = c.pc >> 8;
  h[34] = hw;
  h[35] = m.port7ffd;
  h[37] = m.model === '16k' ? 0x80 | 4 : 4;
  // where in the frame it is: a quarter-frame count and the T-states left in the quarter
  const quarter = m.frameLen / 4, t = Math.max(0, Math.min(m.frameLen - 1, c.t));
  const low = quarter - (t % quarter) - 1;
  h[55] = low & 0xff; h[56] = (low >> 8) & 0xff;
  h[57] = (Math.floor(t / quarter) + 3) % 4;
  h[38] = m.psg.select;
  h.set(m.psg.regs, 39);
  const parts = [h];
  const banks = m.info.paging === '48' ? [[5, 8], [2, 4], [0, 5]] : [0, 1, 2, 3, 4, 5, 6, 7].map((n) => [n, n + 3]);
  for (const [bank, page] of banks) {
    const p = pack(m.banks[bank]);
    const raw = p.length >= 0x4000;
    const body = raw ? m.banks[bank] : Uint8Array.from(p);
    const len = raw ? 0xffff : body.length;
    parts.push(new Uint8Array([len & 0xff, len >> 8, page]), body);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
