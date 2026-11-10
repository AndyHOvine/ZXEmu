// The PC's keyboard, gamepads and touch joystick for ZXEmu (from AmsEmu's, by HEWCO).
// GPL v2 or later, see LICENSE.
//
// Shift is CAPS SHIFT and Ctrl or Alt is SYMBOL SHIFT. Typed symbols ("symbolic" mapping)
// press SYMBOL SHIFT and their key, with CAPS SHIFT let go while they are held, so " is
// Symbol Shift + P whatever the PC needs to type it. Backspace is DELETE, the cursor keys
// are CAPS SHIFT + 5-8, Esc is BREAK, Tab is EXTEND MODE, Caps Lock is CAPS LOCK.

import { CHAR_TO_KEYS } from '../emu/keys.js';
import { JOY } from '../emu/spectrum.js';

const SPECIAL = {
  Enter: ['ENTER'], NumpadEnter: ['ENTER'],
  Backspace: ['CAPS', '0'], Delete: ['CAPS', '0'],
  Escape: ['CAPS', 'SPACE'],
  Tab: ['CAPS', 'SYMBOL'],
  CapsLock: ['CAPS', '2'],
  Home: ['CAPS', '1'], End: ['CAPS', '9'],
  Space: ['SPACE'],
  ArrowLeft: ['CAPS', '5'], ArrowDown: ['CAPS', '6'], ArrowUp: ['CAPS', '7'], ArrowRight: ['CAPS', '8'],
  Numpad0: ['0'], Numpad1: ['1'], Numpad2: ['2'], Numpad3: ['3'], Numpad4: ['4'],
  Numpad5: ['5'], Numpad6: ['6'], Numpad7: ['7'], Numpad8: ['8'], Numpad9: ['9'],
};

export const DEFAULT_JOY_KEYS = {
  up: ['ArrowUp', 'Numpad8'],
  down: ['ArrowDown', 'Numpad2', 'Numpad5'],
  left: ['ArrowLeft', 'Numpad4'],
  right: ['ArrowRight', 'Numpad6'],
  fire: ['ControlLeft', 'ControlRight', 'Numpad0'],
  fire2: ['AltRight', 'NumpadDecimal'],
  upleft: ['Numpad7'], upright: ['Numpad9'], downleft: ['Numpad1'], downright: ['Numpad3'],
};

const JOY_BITS = {
  up: JOY.UP, down: JOY.DOWN, left: JOY.LEFT, right: JOY.RIGHT, fire: JOY.FIRE, fire2: JOY.FIRE2,
  upleft: JOY.UP | JOY.LEFT, upright: JOY.UP | JOY.RIGHT,
  downleft: JOY.DOWN | JOY.LEFT, downright: JOY.DOWN | JOY.RIGHT,
};

export function keyLabel(code) {
  const names = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space',
    ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl', ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift',
    AltLeft: 'Left Alt', AltRight: 'Right Alt', Enter: 'Enter', NumpadEnter: 'Num Enter',
    IntlBackslash: '\\', Backslash: '\\ (US)',
  };
  if (names[code]) return names[code];
  let m = /^Key([A-Z])$/.exec(code) || /^Digit([0-9])$/.exec(code);
  if (m) return m[1];
  m = /^Numpad(.+)$/.exec(code);
  if (m) return 'Num ' + m[1];
  return code;
}

export class Input {
  constructor(machine, opts = {}) {
    this.machine = machine;
    this.keyboardMap = opts.keyboardMap || 'symbolic';
    this.joyKeysEnabled = !!opts.joyKeys;
    this.setJoyKeys(opts.joyKeyMap || DEFAULT_JOY_KEYS);
    this.gamepadEnabled = opts.gamepad !== false;
    this.gamepadButtons = opts.gamepadButtons || {};
    this.pressed = new Map();
    this.joyKeyBits = 0;
    this.joyPadBits = 0;
    this.joyTouchBits = 0;
    this.padKeys = new Set();
    this.phys = { caps: false, sym: false };
    this.applied = { caps: false, sym: false };
    this.hotkeys = {};
    this.enabled = true;
    this.holdCycles = 0;
    this.gapCycles = 0;
    this.queue = [];
    this.active = [];
    this.nextFree = 0;
    this.joyDelayed = [];
  }

  setMachine(m) {
    this.machine = m;
    this.applied = { caps: false, sym: false };
    this.pressed.clear();
    this.queue = [];
    this.active = [];
    this.joyDelayed = [];
    this.nextFree = 0;
    // a key is held at least a frame and two between presses, so the ROM sees each
    this.holdCycles = m ? Math.ceil(m.clock / 50) : 0;
    this.gapCycles = this.holdCycles;
  }

  schedule(at, down, entry) {
    const a = { at, down, entry };
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].at > at) i--;
    this.queue.splice(i, 0, a);
    this.service();
  }

  service() {
    const now = this.machine.cycles;
    let changed = false;
    while (this.queue.length && this.queue[0].at <= now) {
      const { down, entry } = this.queue.shift();
      for (const k of entry.keys) this.machine.key(k, down);
      if (down) this.active.push(entry);
      else this.active = this.active.filter((e) => e !== entry);
      changed = true;
    }
    if (this.joyDelayed.length && this.joyDelayed.some((d) => d.at <= now)) {
      this.joyDelayed = this.joyDelayed.filter((d) => d.at > now);
      this.updateJoyKeys();
    }
    if (changed) this.updateShift();
  }

  setJoyKeys(map) {
    this.joyKeyConfig = map;
    this.joyKeyMap = new Map();
    for (const [dir, codes] of Object.entries(map)) {
      for (const c of [].concat(codes)) this.joyKeyMap.set(c, JOY_BITS[dir] || 0);
    }
  }

  attach(target = window) {
    this.target = target;
    this.onDown = (e) => this.keyDown(e);
    this.onUp = (e) => this.keyUp(e);
    this.onBlur = () => this.releaseAll();
    target.addEventListener('keydown', this.onDown);
    target.addEventListener('keyup', this.onUp);
    window.addEventListener('blur', this.onBlur);
  }

  keyDown(e) {
    if (!this.enabled) return;
    const hk = (e.shiftKey && this.hotkeys['Shift+' + e.code]) || this.hotkeys[e.code];
    if (hk && !e.repeat) { e.preventDefault(); hk(); return; }
    if (e.metaKey) return;
    if (this.joyKeysEnabled && this.joyKeyMap.has(e.code)) {
      e.preventDefault();
      if (!this.pressed.has(e.code)) {
        this.pressed.set(e.code, { joy: this.joyKeyMap.get(e.code), at: this.machine.cycles });
        this.updateJoyKeys();
      }
      return;
    }
    if (e.ctrlKey && (e.code === 'KeyV' || e.code === 'KeyC')) return;
    if (this.pressed.has(e.code)) { e.preventDefault(); return; }
    const m = this.resolve(e);
    if (!m) return;
    e.preventDefault();
    this.pressed.set(e.code, m);
    if (m.phys) {
      this.phys[m.phys] = true;
      this.updateShift();
      return;
    }
    const at = Math.max(this.machine.cycles, this.nextFree);
    m.downAt = at;
    this.nextFree = at + this.holdCycles + this.gapCycles;
    this.schedule(at, true, m);
  }

  keyUp(e) {
    const m = this.pressed.get(e.code);
    if (!m) return;
    e.preventDefault();
    this.pressed.delete(e.code);
    const now = this.machine.cycles;
    if (m.joy !== undefined) {
      const until = m.at + this.holdCycles * 2;
      if (now < until) this.joyDelayed.push({ joy: m.joy, at: until });
      this.updateJoyKeys();
      return;
    }
    if (m.phys) {
      this.phys[m.phys] = [...this.pressed.values()].some((p) => p.phys === m.phys);
      this.updateShift();
      return;
    }
    this.schedule(Math.max(now, m.downAt + this.holdCycles), false, m);
  }

  releaseAll() {
    for (const e of this.active) for (const k of e.keys) this.machine.key(k, false);
    this.active = [];
    this.queue = [];
    this.joyDelayed = [];
    this.pressed.clear();
    this.phys = { caps: false, sym: false };
    this.joyKeyBits = 0;
    this.updateShift();
    this.pushJoy();
  }

  // a PC key as Spectrum keys: { keys, caps } (caps false: CAPS SHIFT let go while it is
  // held), or { phys } for the shift keys themselves
  resolve(e) {
    const code = e.code;
    if (code === 'ShiftLeft' || code === 'ShiftRight') return { keys: [], phys: 'caps' };
    if (code === 'ControlLeft' || code === 'ControlRight' || code === 'AltLeft' || code === 'AltRight') return { keys: [], phys: 'sym' };
    const sp = SPECIAL[code];
    if (sp) return { keys: sp, caps: null };
    if (/^Key[A-Z]$/.test(code)) return { keys: [code.slice(3)], caps: null };
    if (/^Digit[0-9]$/.test(code) && (!e.shiftKey || this.keyboardMap === 'positional')) return { keys: [code.slice(5)], caps: null };
    if (this.keyboardMap === 'positional') return null;
    if (e.key && e.key.length === 1) {
      const c = CHAR_TO_KEYS[e.key];
      if (c) return { keys: c, caps: c.includes('CAPS') ? true : false };
    }
    return null;
  }

  updateShift() {
    let caps = this.phys.caps;
    for (const e of this.active) if (e.caps === false) caps = false;
    const sym = this.phys.sym;
    if (caps !== this.applied.caps) { this.machine.key('CAPS', caps); this.applied.caps = caps; }
    if (sym !== this.applied.sym) { this.machine.key('SYMBOL', sym); this.applied.sym = sym; }
  }

  updateJoyKeys() {
    let bits = 0;
    for (const [, m] of this.pressed) if (m.joy !== undefined) bits |= m.joy;
    for (const d of this.joyDelayed) bits |= d.joy;
    this.joyKeyBits = bits;
    this.pushJoy();
  }

  setJoyKeysEnabled(on) {
    if (on === this.joyKeysEnabled) return;
    this.releaseAll();
    this.joyKeysEnabled = on;
  }

  setTouchJoy(bits) {
    this.joyTouchBits = bits;
    this.pushJoy();
  }

  pushJoy() {
    let bits = this.joyKeyBits | this.joyPadBits | this.joyTouchBits;
    if ((bits & (JOY.UP | JOY.DOWN)) === (JOY.UP | JOY.DOWN)) bits &= ~(JOY.UP | JOY.DOWN);
    if ((bits & (JOY.LEFT | JOY.RIGHT)) === (JOY.LEFT | JOY.RIGHT)) bits &= ~(JOY.LEFT | JOY.RIGHT);
    if (this.machine) this.machine.setJoystick(bits);
  }

  pollGamepads() {
    if (!this.gamepadEnabled || !navigator.getGamepads) return;
    let bits = 0;
    const keysDown = new Set();
    for (const gp of navigator.getGamepads()) {
      if (!gp || !gp.connected) continue;
      const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
      const b = (i) => gp.buttons[i] && gp.buttons[i].pressed;
      if (ax < -0.4 || b(14)) bits |= JOY.LEFT;
      if (ax > 0.4 || b(15)) bits |= JOY.RIGHT;
      if (ay < -0.4 || b(12)) bits |= JOY.UP;
      if (ay > 0.4 || b(13)) bits |= JOY.DOWN;
      for (const [btn, key] of Object.entries(this.gamepadButtons)) {
        if (b(Number(btn))) keysDown.add(key);
      }
      for (const i of [0, 1, 2, 3, 4, 5, 6, 7]) {
        if (b(i) && !(String(i) in this.gamepadButtons)) bits |= i & 1 ? JOY.FIRE2 : JOY.FIRE;
      }
    }
    if (bits !== this.joyPadBits) { this.joyPadBits = bits; this.pushJoy(); }
    for (const k of keysDown) if (!this.padKeys.has(k)) this.machine.key(k, true);
    for (const k of this.padKeys) if (!keysDown.has(k)) this.machine.key(k, false);
    this.padKeys = keysDown;
  }
}
