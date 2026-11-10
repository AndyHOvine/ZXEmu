// Derived from Caprice32 src/fdc.cpp, written by Ulrich Doewich,
// Copyright (C) 1997-2015 Ulrich Doewich, (C) 2016-2025 Colin Pitrat.
// Ported to JavaScript and modified for AmsEmu, 2026; used unchanged by ZXEmu for the +3.
// GPL v2 or later, see LICENSE.

import { saveFields, loadFields } from './state.js';
import { makeSector, SECTOR_MAX, TRACK_MAX } from './dsk.js';

const CMD_PHASE = 0;
const EXEC_PHASE = 1;
const RESULT_PHASE = 2;

const FDC_TO_CPU = 0;
const CPU_TO_FDC = 1;

const SKIP_FLAG = 1;
const SEEKDRVA_FLAG = 2;
const SEEKDRVB_FLAG = 4;
const RNDDE_FLAG = 8;
const OVERRUN_FLAG = 16;
const SCAN_FLAG = 32;
const SCANFAILED_FLAG = 64;
const STATUSDRVA_FLAG = 128;
const STATUSDRVB_FLAG = 256;

const CMD_UNIT = 1, CMD_C = 2, CMD_H = 3, CMD_R = 4, CMD_N = 5, CMD_EOT = 6, CMD_DTL = 8, CMD_STP = 8;
const RES_ST0 = 0, RES_ST1 = 1, RES_ST2 = 2, RES_C = 3, RES_N = 6;

const OVERRUN_TIMEOUT = 128 * 4;
const INITIAL_TIMEOUT = OVERRUN_TIMEOUT * 80;
const MAX_TRACK_SIZE = 6144 - 154;

const BUF_TRACK = 0;
const BUF_FORMAT = 1;

const EMPTY_TRACK = { sectors: [], data: new Uint8Array(0) };

const CMD_TABLE = [
  [0x03, 3, 0, FDC_TO_CPU, 'cmdSpecify'],
  [0x04, 2, 1, FDC_TO_CPU, 'cmdDriveStatus'],
  [0x07, 2, 0, FDC_TO_CPU, 'cmdRecalibrate'],
  [0x08, 1, 2, FDC_TO_CPU, 'cmdIntStatus'],
  [0x0f, 3, 0, FDC_TO_CPU, 'cmdSeek'],
  [0x42, 9, 7, FDC_TO_CPU, 'cmdReadTrack'],
  [0x45, 9, 7, CPU_TO_FDC, 'cmdWrite'],
  [0x46, 9, 7, FDC_TO_CPU, 'cmdRead'],
  [0x49, 9, 7, CPU_TO_FDC, 'cmdWrite'],
  [0x4a, 2, 7, FDC_TO_CPU, 'cmdReadId'],
  [0x4c, 9, 7, FDC_TO_CPU, 'cmdRead'],
  [0x4d, 6, 7, CPU_TO_FDC, 'cmdWriteId'],
  [0x51, 9, 7, CPU_TO_FDC, 'cmdScan'],
  [0x59, 9, 7, CPU_TO_FDC, 'cmdScan'],
  [0x5d, 9, 7, CPU_TO_FDC, 'cmdScan'],
];

const newDrive = () => ({ image: null, track: 0, side: 0, sector: 0, writeProtected: false, flipped: false });
const DRIVE_FIELDS = ['track', 'side', 'sector', 'writeProtected', 'flipped'];

export class Fdc {
  constructor() {
    this.drives = [newDrive(), newDrive()];
    this.command = new Uint8Array(12);
    this.result = new Uint8Array(8);
    this.fmtBuf = new Uint8Array(4 * 256);
    this.track = EMPTY_TRACK;
    this.reset();
  }

  reset() {
    this.timeout = 0;
    this.motor = 0;
    this.led = 0;
    this.flags = STATUSDRVA_FLAG | STATUSDRVB_FLAG;
    this.phase = CMD_PHASE;
    this.byteCount = 0;
    this.bufferCount = 0;
    this.cmdLength = 0;
    this.resLength = 0;
    this.cmdDirection = FDC_TO_CPU;
    this.cmdIndex = -1;
    this.bufPos = 0;
    this.bufEnd = 0;
    this.bufTarget = BUF_TRACK;
    this.readStatusDelay = 0;
    this.activeDrive = 0;
    this.trackNum = 0;
    this.sideNum = 0;
    this.command.fill(0);
    this.result.fill(0);
    this.track = EMPTY_TRACK;
  }

  insert(drive, image) {
    const d = this.drives[drive];
    d.image = image || null;
    d.sector = 0;
    if (drive === this.activeDrive) this.resolveTrack();
  }

  setMotor(on) {
    this.motor = on & 1;
    this.flags |= STATUSDRVA_FLAG | STATUSDRVB_FLAG;
  }

  get busy() {
    return this.motor !== 0 || this.phase !== CMD_PHASE;
  }

  tick(t) {
    if (this.phase !== EXEC_PHASE) return;
    this.timeout -= t;
    while (this.timeout <= 0 && this.phase === EXEC_PHASE) {
      const debt = this.timeout;
      this.flags |= OVERRUN_FLAG;
      if (this.cmdDirection === FDC_TO_CPU) this.readData();
      else this.writeData(0xff);
      this.timeout += debt;
    }
  }

  readStatus() {
    let val = 0x80;
    if (this.phase === EXEC_PHASE) {
      if (this.readStatusDelay) {
        val = 0x10;
        this.readStatusDelay--;
      } else {
        val |= 0x30;
      }
      if (this.cmdDirection === FDC_TO_CPU) val |= 0x40;
    } else if (this.phase === RESULT_PHASE) {
      val |= 0x50;
    } else if (this.byteCount) {
      val |= 0x10;
    }
    return val;
  }

  readData() {
    let val = 0xff;
    if (this.phase === EXEC_PHASE) {
      if (this.cmdDirection !== FDC_TO_CPU) return val;
      this.timeout = OVERRUN_TIMEOUT;
      const data = this.track.data;
      val = this.bufPos < data.length ? data[this.bufPos] : 0;
      if (++this.bufPos >= this.bufEnd) this.bufPos = 0;
      if (--this.bufferCount > 0) return val;
      const drive = this.drives[this.activeDrive];
      drive.sector++;
      if (this.flags & OVERRUN_FLAG) {
        this.flags &= ~OVERRUN_FLAG;
        this.result[RES_ST0] |= 0x40;
        this.result[RES_ST1] |= 0x10;
        this.loadResultChrn();
        this.phase = RESULT_PHASE;
      } else if (this.command[0] === 0x42) {
        if (--this.command[CMD_EOT]) {
          if (drive.sector >= this.track.sectors.length) drive.sector = 0;
          this.command[CMD_R]++;
          this.execReadTrack();
        } else {
          this.loadResultStatus();
          this.loadResultChrn();
          this.phase = RESULT_PHASE;
        }
      } else if (!((this.result[RES_ST1] & 0x31) || (this.result[RES_ST2] & 0x21)) &&
                 this.command[CMD_R] !== this.command[CMD_EOT]) {
        this.command[CMD_R]++;
        this.execRead();
      } else {
        this.loadResultStatus();
        this.loadResultChrn();
        this.phase = RESULT_PHASE;
      }
    } else if (this.phase === RESULT_PHASE) {
      val = this.result[this.byteCount++];
      if (this.byteCount >= this.resLength) {
        this.flags &= ~SCAN_FLAG;
        this.byteCount = 0;
        this.phase = CMD_PHASE;
        this.led = 0;
      }
    }
    return val;
  }

  writeData(val) {
    if (this.phase === CMD_PHASE) {
      if (this.byteCount) {
        this.command[this.byteCount++] = val;
        if (this.byteCount === this.cmdLength) this.startCommand();
        return;
      }
      if (val & 0x20) {
        this.flags |= SKIP_FLAG;
        val &= ~0x20;
      } else {
        this.flags &= ~SKIP_FLAG;
      }
      const idx = CMD_TABLE.findIndex((c) => c[0] === val);
      if (idx < 0) {
        this.result[0] = 0x80;
        this.resLength = 1;
        this.phase = RESULT_PHASE;
        return;
      }
      const [, cmdLength, resLength, dir] = CMD_TABLE[idx];
      this.cmdIndex = idx;
      this.cmdLength = cmdLength;
      this.resLength = resLength;
      this.cmdDirection = dir;
      this.command[this.byteCount++] = val;
      if (this.byteCount === this.cmdLength) this.startCommand();
    } else if (this.phase === EXEC_PHASE) {
      if (this.cmdDirection !== CPU_TO_FDC) return;
      this.timeout = OVERRUN_TIMEOUT;
      if (this.flags & SCAN_FLAG) {
        const d = this.track.data;
        const cur = this.bufPos < d.length ? d[this.bufPos] : 0;
        if (val !== 0xff) {
          switch (this.command[0]) {
            case 0x51:
              if (val !== cur) { this.result[RES_ST2] &= 0xf7; this.flags |= SCANFAILED_FLAG; }
              break;
            case 0x59:
              if (val !== cur) this.result[RES_ST2] &= 0xf7;
              if (val > cur) this.flags |= SCANFAILED_FLAG;
              break;
            case 0x5d:
              if (val !== cur) this.result[RES_ST2] &= 0xf7;
              if (val < cur) this.flags |= SCANFAILED_FLAG;
              break;
          }
        }
        this.bufPos++;
      } else if (this.bufTarget === BUF_FORMAT) {
        this.fmtBuf[this.bufPos++] = val;
      } else {
        const d = this.track.data;
        if (this.bufPos < d.length) d[this.bufPos] = val;
        this.bufPos++;
      }
      if (this.bufTarget === BUF_TRACK && this.bufPos >= this.bufEnd) this.bufPos = 0;
      if (--this.bufferCount > 0) return;
      const drive = this.drives[this.activeDrive];
      if (this.flags & SCAN_FLAG) {
        if ((this.flags & SCANFAILED_FLAG) && this.command[CMD_R] !== this.command[CMD_EOT]) {
          this.command[CMD_R] += this.command[CMD_STP];
          this.execScan();
        } else {
          if (this.flags & SCANFAILED_FLAG) this.result[RES_ST2] |= 0x04;
          this.loadResultChrn();
          this.phase = RESULT_PHASE;
        }
      } else if (this.command[0] === 0x4d) {
        this.finishWriteId(drive);
      } else if (this.command[CMD_R] !== this.command[CMD_EOT]) {
        this.command[CMD_R]++;
        this.execWrite();
      } else {
        this.markDirty(drive);
        this.result[RES_ST0] |= 0x40;
        this.result[RES_ST1] |= 0x80;
        this.loadResultChrn();
        this.phase = RESULT_PHASE;
      }
    }
  }

  saveState() {
    const s = saveFields(this, ['drives', 'track']);
    s.drives = this.drives.map((d) => {
      const o = {};
      for (const k of DRIVE_FIELDS) o[k] = d[k];
      return o;
    });
    return s;
  }

  loadState(s) {
    const { drives, ...rest } = s;
    for (const k of ['command', 'result', 'fmtBuf']) {
      if (rest[k] && !(rest[k] instanceof Uint8Array)) rest[k] = Uint8Array.from(Object.values(rest[k]));
    }
    loadFields(this, rest);
    if (drives) {
      drives.forEach((src, i) => { for (const k of DRIVE_FIELDS) if (k in src) this.drives[i][k] = src[k]; });
    }
    this.resolveTrack();
  }

  startCommand() {
    this.byteCount = 0;
    this.phase = EXEC_PHASE;
    this[CMD_TABLE[this.cmdIndex][4]]();
  }

  resolveTrack() {
    const img = this.drives[this.activeDrive].image;
    this.track = img ? img.getTrack(this.trackNum, this.sideNum) : EMPTY_TRACK;
  }

  markDirty(drive) {
    if (drive.image) drive.image.dirty = true;
  }

  checkUnit() {
    this.activeDrive = this.command[CMD_UNIT] & 1;
  }

  driveReady(d) {
    return d.image !== null && d.image.tracks > 0 && this.motor !== 0;
  }

  initStatusRegs() {
    this.result.fill(0);
    let val = this.command[CMD_UNIT] & 7;
    if (!this.driveReady(this.drives[this.activeDrive])) val |= 0x48;
    this.result[RES_ST0] = val;
    return !(val & 8);
  }

  selectTrack() {
    const d = this.drives[this.activeDrive];
    d.side = (this.command[CMD_UNIT] & 4) >> 2;
    let side = d.image.sides > 1 ? d.side : 0;
    if (d.flipped) side = side ? 0 : 1;
    this.trackNum = d.track;
    this.sideNum = side;
    this.track = d.image.getTrack(d.track, side);
  }

  loadResultStatus() {
    const r = this.result;
    r[RES_ST0] |= 0x40;
    r[RES_ST1] |= 0x80;
    if (this.command[0] !== 0x42) {
      if ((r[RES_ST1] & 0x7f) || (r[RES_ST2] & 0x7f)) {
        r[RES_ST1] &= 0x7f;
        if ((r[RES_ST1] & 0x20) || (r[RES_ST2] & 0x20)) {
          r[RES_ST2] &= 0xbf;
        } else if (r[RES_ST2] & 0x40) {
          r[RES_ST0] &= 0x3f;
          r[RES_ST1] &= 0x7f;
        }
      }
    }
  }

  loadResultChrn() {
    this.result.set(this.command.subarray(CMD_C, CMD_N + 1), RES_C);
  }

  sectorSize() {
    const n = this.command[CMD_N];
    if (n === 0) return Math.min(this.command[CMD_DTL], 0x80);
    return 0x80 << Math.min(n, 8);
  }

  findSector() {
    const drive = this.drives[this.activeDrive];
    const secs = this.track.sectors;
    if (!secs.length) return null;
    const cmd = this.command;
    const r = this.result;
    let found = null;
    let loops = 0;
    let idx = drive.sector < secs.length ? drive.sector : 0;
    do {
      const s = secs[idx];
      if (s.c === cmd[CMD_C] && s.h === cmd[CMD_H] && s.r === cmd[CMD_R] && s.n === cmd[CMD_N]) {
        found = s;
        if (((s.st1 & 0x20) || (s.st2 & 0x20)) && drive.image.randomDEs) this.flags |= RNDDE_FLAG;
        r[RES_ST2] &= ~(0x02 | 0x10);
        break;
      }
      if (s.c === 0xff) r[RES_ST2] |= 0x02;
      else if (s.c !== cmd[CMD_C]) r[RES_ST2] |= 0x10;
      if (++idx >= secs.length) {
        idx = 0;
        loops++;
      }
    } while (loops < 2);
    if (r[RES_ST2] & 0x02) r[RES_ST2] &= ~0x10;
    drive.sector = idx;
    return found;
  }

  readOffset(s) {
    s.weakVer = (s.weakVer + 1) % s.versions;
    return s.off + s.weakVer * s.size;
  }

  startTransfer(count, pos) {
    this.bufferCount = count;
    this.bufPos = pos;
    this.bufEnd = this.track.data.length;
    this.bufTarget = BUF_TRACK;
    this.timeout = INITIAL_TIMEOUT;
    this.readStatusDelay = 1;
  }

  sectorNotFound() {
    this.result[RES_ST0] |= 0x40;
    this.result[RES_ST1] |= 0x04;
    this.loadResultChrn();
    this.phase = RESULT_PHASE;
  }

  execWrite() {
    const s = this.findSector();
    if (!s) { this.sectorNotFound(); return; }
    s.st1 = 0;
    s.st2 = this.command[0] === 0x45 ? 0 : 0x40;
    this.startTransfer(this.sectorSize(), s.off);
  }

  execRead() {
    const r = this.result;
    for (;;) {
      const s = this.findSector();
      if (!s) { this.sectorNotFound(); return; }
      r[RES_ST1] = s.st1 & 0x25;
      r[RES_ST2] = s.st2 & 0x61;
      if (this.command[0] === 0x4c) r[RES_ST2] ^= 0x40;
      if ((this.flags & SKIP_FLAG) && (r[RES_ST2] &= 0x40)) {
        if (this.command[CMD_R] !== this.command[CMD_EOT]) {
          this.command[CMD_R]++;
          continue;
        }
        this.loadResultStatus();
        this.loadResultChrn();
        this.phase = RESULT_PHASE;
        return;
      }
      if (r[RES_ST2] &= 0x40) this.command[CMD_EOT] = this.command[CMD_R];
      this.startTransfer(this.sectorSize(), this.readOffset(s));
      return;
    }
  }

  execReadTrack() {
    const drive = this.drives[this.activeDrive];
    const s = this.track.sectors[drive.sector];
    if (!s) { this.sectorNotFound(); return; }
    const cmd = this.command;
    const r = this.result;
    if (s.c !== cmd[CMD_C] || s.h !== cmd[CMD_H] || s.r !== cmd[CMD_R] || s.n !== cmd[CMD_N]) {
      r[RES_ST1] |= 0x04;
    }
    r[RES_ST2] &= 0xbf;
    r[RES_ST1] |= s.st1 & 0x25;
    r[RES_ST2] |= s.st2 & 0x61;
    this.startTransfer(this.sectorSize(), this.readOffset(s));
  }

  execScan() {
    const r = this.result;
    for (;;) {
      const s = this.findSector();
      if (!s) { this.sectorNotFound(); return; }
      r[RES_ST1] = s.st1 & 0x25;
      r[RES_ST2] = s.st2 & 0x61;
      if ((this.flags & SKIP_FLAG) && (r[RES_ST2] &= 0x40)) {
        if (this.command[CMD_R] !== this.command[CMD_EOT]) {
          this.command[CMD_R] += this.command[CMD_STP];
          continue;
        }
        this.loadResultStatus();
        this.loadResultChrn();
        this.phase = RESULT_PHASE;
        return;
      }
      if (r[RES_ST2] &= 0x40) this.command[CMD_EOT] = this.command[CMD_R];
      this.startTransfer(0x80 << Math.min(this.command[CMD_N], 8), this.readOffset(s));
      this.flags &= ~SCANFAILED_FLAG;
      r[RES_ST2] |= 0x08;
      return;
    }
  }

  finishWriteId(drive) {
    const n = this.command[CMD_C];
    const count = this.command[CMD_H];
    const gap = this.command[CMD_R];
    const filler = this.command[CMD_N];
    const size = 0x80 << Math.min(n, 8);
    let tr;
    if ((size + 62 + gap) * count > MAX_TRACK_SIZE || count === 0 || count > SECTOR_MAX) {
      tr = { sectors: [], data: new Uint8Array(0), bps: n, gap3: gap, filler };
    } else {
      const sectors = [];
      for (let i = 0; i < count; i++) {
        const p = i * 4;
        const f = this.fmtBuf;
        sectors.push(makeSector(f[p], f[p + 1], f[p + 2], f[p + 3], 0, 0, i * size, size));
      }
      tr = { sectors, data: new Uint8Array(size * count).fill(filler), bps: n, gap3: gap, filler };
    }
    drive.image.setTrack(this.trackNum, this.sideNum, tr);
    this.track = tr;
    if (count) this.result.set(this.fmtBuf.subarray((count - 1) * 4, count * 4), RES_C);
    this.result[RES_N] = n;
    this.markDirty(drive);
    this.phase = RESULT_PHASE;
  }

  cmdSpecify() {
    this.phase = CMD_PHASE;
  }

  cmdDriveStatus() {
    this.checkUnit();
    const d = this.drives[this.activeDrive];
    const hasDisk = d.image !== null && d.image.tracks > 0;
    let val = this.command[CMD_UNIT] & 7;
    if (d.writeProtected || !hasDisk) val |= 0x48;
    if (hasDisk && this.motor) val |= 0x20;
    if (d.track === 0) val |= 0x10;
    this.result[RES_ST0] = val;
    this.phase = RESULT_PHASE;
  }

  cmdRecalibrate() {
    this.command[CMD_C] = 0;
    this.cmdSeek();
  }

  cmdIntStatus() {
    const r = this.result;
    const [a, b] = this.drives;
    let val = r[RES_ST0] & 0xf8;
    if (this.flags & SEEKDRVA_FLAG) {
      this.flags &= ~(SEEKDRVA_FLAG | STATUSDRVA_FLAG);
      r[RES_ST0] = val | 0x20;
      r[RES_ST1] = a.track;
    } else if (this.flags & SEEKDRVB_FLAG) {
      this.flags &= ~(SEEKDRVB_FLAG | STATUSDRVB_FLAG);
      r[RES_ST0] = val | 0x21;
      r[RES_ST1] = b.track;
    } else if (this.flags & STATUSDRVA_FLAG) {
      this.flags &= ~STATUSDRVA_FLAG;
      r[RES_ST0] = this.driveReady(a) ? 0xc0 : 0xc8;
      r[RES_ST1] = a.track;
    } else if (this.flags & STATUSDRVB_FLAG) {
      this.flags &= ~STATUSDRVB_FLAG;
      r[RES_ST0] = this.driveReady(b) ? 0xc1 : 0xc9;
      r[RES_ST1] = b.track;
    } else {
      r[RES_ST0] = 0x80;
      this.resLength = 1;
    }
    this.phase = RESULT_PHASE;
  }

  cmdSeek() {
    this.checkUnit();
    if (this.initStatusRegs()) {
      this.drives[this.activeDrive].track = Math.min(this.command[CMD_C], TRACK_MAX - 1);
    }
    this.flags |= (this.command[CMD_UNIT] & 1) ? SEEKDRVB_FLAG : SEEKDRVA_FLAG;
    this.phase = CMD_PHASE;
  }

  dataCommandStart(needFormatted, isWrite) {
    this.led = 1;
    this.checkUnit();
    if (!this.initStatusRegs()) {
      this.loadResultChrn();
      this.phase = RESULT_PHASE;
      return false;
    }
    this.selectTrack();
    const drive = this.drives[this.activeDrive];
    if (isWrite && drive.writeProtected) {
      this.result[RES_ST0] |= 0x40;
      this.result[RES_ST1] |= 0x02;
      this.loadResultChrn();
      this.phase = RESULT_PHASE;
      return false;
    }
    if (isWrite) this.markDirty(drive);
    if (needFormatted && this.track.sectors.length === 0) {
      this.result[RES_ST0] |= 0x40;
      this.result[RES_ST1] |= 0x01;
      this.loadResultChrn();
      this.phase = RESULT_PHASE;
      return false;
    }
    return true;
  }

  cmdReadTrack() {
    if (!this.dataCommandStart(true, false)) return;
    this.command[CMD_R] = 1;
    this.drives[this.activeDrive].sector = 0;
    this.execReadTrack();
  }

  cmdWrite() {
    if (this.dataCommandStart(true, true)) this.execWrite();
  }

  cmdRead() {
    if (this.dataCommandStart(true, false)) this.execRead();
  }

  cmdScan() {
    if (!this.dataCommandStart(true, false)) return;
    if (this.command[CMD_STP] > 2) this.command[CMD_STP] = 2;
    this.flags |= SCAN_FLAG;
    this.execScan();
  }

  cmdReadId() {
    this.led = 1;
    this.checkUnit();
    if (this.initStatusRegs()) {
      this.selectTrack();
      const drive = this.drives[this.activeDrive];
      const secs = this.track.sectors;
      if (secs.length) {
        const idx = drive.sector < secs.length ? drive.sector : 0;
        const s = secs[idx];
        this.result.set([s.c, s.h, s.r, s.n], RES_C);
        drive.sector = idx + 1;
      } else {
        this.result[RES_ST0] |= 0x40;
        this.result[RES_ST1] |= 0x01;
        this.loadResultChrn();
      }
    }
    this.phase = RESULT_PHASE;
  }

  cmdWriteId() {
    if (!this.dataCommandStart(false, true)) return;
    this.bufferCount = this.command[CMD_H] << 2;
    this.bufPos = 0;
    this.bufEnd = this.bufferCount;
    this.bufTarget = BUF_FORMAT;
    this.timeout = INITIAL_TIMEOUT;
    this.readStatusDelay = 1;
  }
}
