// The Spectrum's colours for ZXEmu. GPL v2 or later, see LICENSE.
//
// 8 colours, each normal or bright. 'standard' is the usual emulator choice (normal at 0xD7);
// 'vivid' has normal at 0xCD as some measure it; 'grey' and 'green' are a monochrome TV and
// a green-screen monitor.

export const PALETTE_NAMES = ['standard', 'vivid', 'grey', 'green'];
export const PALETTE_LABELS = { standard: 'Standard', vivid: 'Vivid (darker normal colours)', grey: 'Grey (black and white TV)', green: 'Green screen' };

function rgba(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return (0xff000000 | (c(b) << 16) | (c(g) << 8) | c(r)) >>> 0;
}

// the 16 colours (0-7 normal, 8-15 bright) as RGBA words
export function spectrumColours(name) {
  const out = new Uint32Array(16);
  const normal = name === 'vivid' ? 0xcd : 0xd7;
  for (let i = 0; i < 16; i++) {
    const v = i & 8 ? 0xff : normal;
    const r = i & 2 ? v : 0, g = i & 4 ? v : 0, b = i & 1 ? v : 0;
    if (name === 'grey' || name === 'green') {
      const l = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      out[i] = name === 'grey' ? rgba(l * 255, l * 255, l * 255) : rgba(l * 40, l * 255, l * 60);
    } else {
      out[i] = rgba(r, g, b);
    }
  }
  return out;
}
