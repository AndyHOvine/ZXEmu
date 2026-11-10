// The Spectrum's keyboard for ZXEmu, written for it in 2026. GPL v2 or later, see LICENSE.
//
// Eight half-rows of five keys. A half-row is read when its address line (A8-A15) is low on
// an IN from port $FE; bits 0-4 are 0 for keys held.

const ROWS = [
  ['CAPS', 'Z', 'X', 'C', 'V'],
  ['A', 'S', 'D', 'F', 'G'],
  ['Q', 'W', 'E', 'R', 'T'],
  ['1', '2', '3', '4', '5'],
  ['0', '9', '8', '7', '6'],
  ['P', 'O', 'I', 'U', 'Y'],
  ['ENTER', 'L', 'K', 'J', 'H'],
  ['SPACE', 'SYMBOL', 'M', 'N', 'B'],
];

// key name -> row * 8 + bit
export const ZX_KEYS = {};
ROWS.forEach((row, r) => row.forEach((k, b) => { ZX_KEYS[k] = r * 8 + b; }));
Object.assign(ZX_KEYS, {
  CAPSSHIFT: ZX_KEYS.CAPS, SHIFT: ZX_KEYS.CAPS, LSHIFT: ZX_KEYS.CAPS,
  SYMSHIFT: ZX_KEYS.SYMBOL, SYM: ZX_KEYS.SYMBOL, RSHIFT: ZX_KEYS.SYMBOL,
  RETURN: ZX_KEYS.ENTER,
});

// keys that are two keys at once on a Spectrum (the 128K and +2 keyboards have some of them)
export const COMBO_KEYS = {
  DELETE: ['CAPS', '0'], BACKSPACE: ['CAPS', '0'], DEL: ['CAPS', '0'],
  LEFT: ['CAPS', '5'], DOWN: ['CAPS', '6'], UP: ['CAPS', '7'], RIGHT: ['CAPS', '8'],
  CURLEFT: ['CAPS', '5'], CURDOWN: ['CAPS', '6'], CURUP: ['CAPS', '7'], CURRIGHT: ['CAPS', '8'],
  EDIT: ['CAPS', '1'], CAPSLOCK: ['CAPS', '2'], TRUEVIDEO: ['CAPS', '3'], INVVIDEO: ['CAPS', '4'],
  GRAPH: ['CAPS', '9'], BREAK: ['CAPS', 'SPACE'], EXTEND: ['CAPS', 'SYMBOL'],
};

// every name key() takes
export function isZxKey(name) {
  return ZX_KEYS[name] !== undefined || COMBO_KEYS[name] !== undefined;
}

// keys a name presses
export function keysOf(name) {
  if (COMBO_KEYS[name]) return COMBO_KEYS[name];
  return ZX_KEYS[name] !== undefined ? [name] : [];
}

// the keys that type a character: [keys...]
export const CHAR_TO_KEYS = (() => {
  const m = {};
  for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    m[c.toLowerCase()] = [c];
    m[c] = ['CAPS', c];
  }
  for (const c of '0123456789') m[c] = [c];
  const sym = {
    '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '&': '6', "'": '7', '(': '8', ')': '9', _: '0',
    '<': 'R', '>': 'T', ';': 'O', '"': 'P', '^': 'H', '-': 'J', '+': 'K', '=': 'L',
    ':': 'Z', '£': 'X', '?': 'C', '/': 'V', '*': 'B', ',': 'N', '.': 'M',
  };
  for (const [ch, k] of Object.entries(sym)) m[ch] = ['SYMBOL', k];
  Object.assign(m, { ' ': ['SPACE'], '\r': ['ENTER'], '\n': ['ENTER'], '\b': ['CAPS', '0'] });
  return m;
})();
