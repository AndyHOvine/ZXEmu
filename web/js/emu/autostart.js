// Starting a game by itself, for ZXEmu. GPL v2 or later, see LICENSE.
//
// A tape: LOAD "" on a 48K (J, then " twice: Symbol Shift + P), the menu's first entry
// (Tape Loader, or Loader on the +2A and +3) on the others. A +3 disk: Loader. A binary is
// put in memory once the ROM is ready, and run if it has a start. Snapshots and cartridges
// start by themselves.

export function planAutostart(m, media, opts) {
  if (media.cart || media.snapshot) return '';
  const auto = opts.autostart ?? true;
  const is48 = m.info.paging === '48';
  let note = '';
  if (auto === false) {
    // nothing
  } else if (typeof auto === 'string') {
    if (!is48) { m.typeKeys('DOWN'); m.typeWait(5); m.typeKeys('ENTER'); m.typeWait(40); }
    m.typeText(auto);
  } else if (media.bin) {
    const bin = media.bin;
    m.onReady(() => {
      if (bin.exec !== null && bin.exec !== undefined) m.injectBinary(bin.data, bin.load, bin.exec);
      else for (let i = 0; i < bin.data.length; i++) m.poke((bin.load + i) & 0xffff, bin.data[i]);
    });
  } else if (media.disk) {
    if (m.fdc) m.typeKeys('ENTER');
    else note = 'Disks need a +3';
  } else if (media.tape) {
    if (is48) {
      m.typeKeys('J');
      m.typeKeys('SYMBOL', 'P');
      m.typeKeys('SYMBOL', 'P');
      m.typeKeys('ENTER');
    } else {
      m.typeKeys('ENTER');
    }
  }
  if (opts.type) m.typeText(opts.type);
  return note;
}
