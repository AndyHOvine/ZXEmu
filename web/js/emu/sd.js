// The Spectrum Next's SD card for ZXEmu, written for it in 2026. GPL v2 or later, see LICENSE.
//
// Files in memory, by path ("/GAME/LEVEL1.BIN"): the page or Hewco BASIC fills it from real
// files and reads back what a program saves (onChange tells it). Names are found whatever
// their case, as on the Next's FAT card. Directories exist when something is in them, or when
// a program made them.

export class SdCard {
  constructor(files = {}) {
    this.files = new Map(); // upper-case path -> { name: path as given, data: Uint8Array }
    this.dirs = new Set(['/']);
    this.onChange = null; // (path, data or null) after a program writes, deletes or renames
    for (const [p, d] of Object.entries(files)) this.put(p, d);
  }

  static norm(path) {
    let p = String(path).replace(/\\/g, '/').replace(/^[a-z]:/i, '');
    if (!p.startsWith('/')) p = '/' + p;
    const out = [];
    for (const part of p.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') out.pop();
      else out.push(part);
    }
    return '/' + out.join('/');
  }

  // a path relative to the directory `cwd`
  resolve(cwd, path) {
    const p = String(path).replace(/\\/g, '/').replace(/^[a-z]:/i, '');
    return SdCard.norm(p.startsWith('/') ? p : cwd + '/' + p);
  }

  put(path, data) {
    const p = SdCard.norm(path);
    this.files.set(p.toUpperCase(), { name: p, data: data instanceof Uint8Array ? data : new Uint8Array(data) });
    for (let d = parentOf(p); ; d = parentOf(d)) { this.dirs.add(d.toUpperCase()); if (d === '/') break; }
  }

  get(path) {
    const f = this.files.get(SdCard.norm(path).toUpperCase());
    return f ? f.data : null;
  }

  exists(path) { return this.files.has(SdCard.norm(path).toUpperCase()); }
  isDir(path) { return this.dirs.has(SdCard.norm(path).toUpperCase()); }

  remove(path) {
    const ok = this.files.delete(SdCard.norm(path).toUpperCase());
    if (ok) this.changed(path, null);
    return ok;
  }

  mkdir(path) { this.dirs.add(SdCard.norm(path).toUpperCase()); }

  // what is directly in a directory: [{ name, dir, size }]
  list(path) {
    const d = SdCard.norm(path).toUpperCase();
    const pre = d === '/' ? '/' : d + '/';
    const out = new Map();
    for (const [k, f] of this.files) {
      if (!k.startsWith(pre)) continue;
      const rest = f.name.slice(pre.length);
      const i = rest.indexOf('/');
      if (i < 0) out.set(rest.toUpperCase(), { name: rest, dir: false, size: f.data.length });
      else if (!out.has(rest.slice(0, i).toUpperCase())) out.set(rest.slice(0, i).toUpperCase(), { name: rest.slice(0, i), dir: true, size: 0 });
    }
    for (const k of this.dirs) {
      if (k.startsWith(pre) && k.length > pre.length && !k.slice(pre.length).includes('/') && !out.has(k.slice(pre.length))) {
        out.set(k.slice(pre.length), { name: k.slice(pre.length), dir: true, size: 0 });
      }
    }
    return [...out.values()];
  }

  changed(path, data) {
    if (this.onChange) this.onChange(SdCard.norm(path), data);
  }
}

function parentOf(p) {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}
