// The page's toolbar, panels and touch controls for ZXEmu (from AmsEmu's, by HEWCO).
// GPL v2 or later, see LICENSE.

import { PALETTE_NAMES, PALETTE_LABELS } from './palettes.js';
import { FILTER_RANGES, MASK_SHAPES } from './crtfilter.js';
import { JOY, MODELS, JOYSTICK_TYPES } from '../emu/spectrum.js';
import { isZxKey } from '../emu/keys.js';
import { keyLabel } from './input.js';
import { SLOT_COUNT } from './savestates.js';

const ICONS = {
  reset: '<path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/>',
  joystick: '<path d="M11 2h2v8.1a3 3 0 1 1-2 0zM5 15h14l2 5H3z"/>',
  warp: '<path d="M3 6l8 6-8 6zm9 0l8 6-8 6z"/>',
  crt: '<path d="M3 5h18v12H3zm2 2v8h14V7zM8 19h8v2H8z"/>',
  sound: '<path d="M4 9h4l5-4v14l-5-4H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/>',
  mute: '<path d="M4 9h4l5-4v14l-5-4H4zm12.6.4L18 8l2 2 2-2 1.4 1.4-2 2 2 2L22 15l-2-2-2 2-1.4-1.6 2-2z"/>',
  settings: '<path d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.4-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.4L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.4 2.5-1a7.4 7.4 0 0 0 1.7 1L11 21h4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.4zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/>',
  unload: '<path d="M12 4l8 10H4zM4 16h16v3H4z"/>',
  load: '<path d="M3 5h7l2 2h9v12H3zm9 4l-4 4h3v4h2v-4h3z"/>',
  fullscreen: '<path d="M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z"/>',
  pause: '<path d="M6 4h4v16H6zm8 0h4v16h-4z"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  states: '<path fill-rule="evenodd" d="M3 3h14l4 4v14H3zm3 2v5h10V5zm6 8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/>',
  slide: '<path d="M2 12a4 4 0 1 0 8 0 4 4 0 1 0-8 0zm10-1h6V7.5l4.5 4.5-4.5 4.5V13h-6z"/>',
  layout: '<path d="M12 2l3.5 3.5H13V11h5.5V8.5L22 12l-3.5 3.5V13H13v5.5h2.5L12 22l-3.5-3.5H11V13H5.5v2.5L2 12l3.5-3.5V11H11V5.5H8.5z"/>',
};

function icon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
}

function el(tag, attrs = {}, html = '') {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  if (html) e.innerHTML = html;
  return e;
}

const JOYSTICK_LABELS = { kempston: 'Kempston', cursor: 'Cursor (Protek, AGF)', sinclair1: 'Sinclair 1 (6-0)', sinclair2: 'Sinclair 2 (1-5)', fuller: 'Fuller', none: 'None (keys only)' };
const STEREO_LABELS = [['abc', 'Stereo ABC'], ['acb', 'Stereo ACB'], ['mono', 'Mono']];

const TOUCH_KEY_LABELS = {
  ENTER: 'ENTER', RETURN: 'ENTER', SPACE: 'SPACE', CAPS: 'CAPS', CAPSSHIFT: 'CAPS', SYMBOL: 'SYM', SYMSHIFT: 'SYM',
  UP: '▲', DOWN: '▼', LEFT: '◀', RIGHT: '▶', CURUP: '▲', CURDOWN: '▼', CURLEFT: '◀', CURRIGHT: '▶',
  DELETE: 'DEL', DEL: 'DEL', BREAK: 'BREAK', EDIT: 'EDIT',
};

export function touchKey(spec, option = 'ui.touchKeys') {
  const s = typeof spec === 'string' ? { key: spec } : spec || {};
  const keys = [].concat(s.keys || s.key || []).map((k) => String(k).toUpperCase());
  const name = keys.length === 1 ? keys[0] : null;
  const bad = keys.filter((k) => !isZxKey(k));
  if (!keys.length || bad.length) {
    console.warn(`${option}: unknown Spectrum key ${bad.join(', ') || JSON.stringify(spec)}`);
    return null;
  }
  return { keys, label: s.label || TOUCH_KEY_LABELS[name] || name || keys.join('+') };
}

const TOUCH_JOY = { up: JOY.UP, down: JOY.DOWN, left: JOY.LEFT, right: JOY.RIGHT, fire: JOY.FIRE, fire2: JOY.FIRE2 };
const TOUCH_JOY_LABELS = { up: '▲', down: '▼', left: '◀', right: '▶', fire: 'FIRE', fire2: 'FIRE 2' };

export function touchStickBits(spec) {
  if (spec === undefined || spec === true) return JOY.UP | JOY.DOWN | JOY.LEFT | JOY.RIGHT;
  if (!spec || String(spec).toLowerCase() === 'none') return 0;
  let bits = 0;
  for (const d of typeof spec === 'string' ? spec.split(',') : spec) {
    const name = String(d).trim().toLowerCase();
    if (TOUCH_JOY[name] && !name.startsWith('fire')) bits |= TOUCH_JOY[name];
    else if (name) console.warn(`ui.touchStick: unknown direction ${d}`);
  }
  return bits;
}

export function touchFireButton(spec) {
  let s = spec;
  if (typeof s === 'string') {
    const at = s.indexOf(':', 1);
    const name = at < 0 ? s : s.slice(0, at), label = at < 0 ? undefined : s.slice(at + 1);
    s = TOUCH_JOY[name.toLowerCase()] ? { joy: name, label } : { key: name, label };
  }
  if (s && s.joy !== undefined) {
    const name = String(s.joy).toLowerCase();
    if (!TOUCH_JOY[name]) {
      console.warn(`ui.touchFire: unknown joystick input ${s.joy}`);
      return null;
    }
    return { joy: TOUCH_JOY[name], label: s.label || TOUCH_JOY_LABELS[name] };
  }
  return touchKey(s, 'ui.touchFire');
}

export function createUi(app, container) {
  const o = app.opts.ui;
  container.classList.add('zx');
  container.innerHTML = '';

  const screen = el('div', { class: 'zx-screen' });
  const canvas = el('canvas', { class: 'zx-canvas', tabindex: '0', 'aria-label': 'Spectrum screen' });
  screen.append(canvas);

  const status = el('div', { class: 'zx-status' });
  const led = el('span', { class: 'zx-led', title: 'Disk drive' });
  const tape = el('span', { class: 'zx-tag zx-tape', title: 'Tape' }, 'TAPE');
  const warp = el('span', { class: 'zx-tag zx-warp' }, 'WARP');
  const joyTag = el('span', { class: 'zx-tag zx-joytag', title: 'Keyboard joystick (F9)' }, 'JOY');
  status.append(joyTag, warp, tape, led);
  screen.append(status);

  const toast = el('div', { class: 'zx-toast', role: 'status' });
  screen.append(toast);

  const start = el('div', { class: 'zx-start' },
    `<div class="zx-start-box"><div class="zx-start-title"></div>
     <button class="zx-start-btn" type="button">${icon('play')}<span>Click to start</span></button>
     <div class="zx-start-hint"></div></div>`);
  start.querySelector('.zx-start-title').textContent = o.title || 'ZX Spectrum';
  start.hidden = true;
  screen.append(start);

  const drop = el('div', { class: 'zx-drop' }, '<div>Drop a Spectrum file (TAP, TZX, Z80, SNA, DSK, ROM, ZIP)<br><small>Hold Shift to attach it without running</small></div>');
  drop.hidden = true;
  screen.append(drop);

  container.append(screen);

  const fileInput = el('input', { type: 'file', accept: '.tap,.tzx,.csw,.wav,.z80,.sna,.dsk,.rom,.bin,.scr,.nex,.zip', hidden: '' });
  const btn = (name, title, onclick) => {
    const b = el('button', { class: 'zx-btn', type: 'button', title, 'aria-label': title, onclick }, icon(name));
    return b;
  };
  const toolbar = el('div', { class: 'zx-toolbar' });
  const bReset = btn('reset', 'Reset', () => app.reset());
  const bPause = btn('pause', 'Pause', () => app.pause(!app.paused));
  const bJoy = btn('joystick', 'Keyboard joystick (F9)', () => app.setJoystickKeys(!app.input.joyKeysEnabled));
  const bWarp = btn('warp', 'Warp speed (F10)', () => app.setWarp(!app.warp));
  const bCrt = btn('crt', 'CRT effects', () => {
    const on = !(app.renderer.crt.enabled || app.renderer.filter.enabled);
    app.setVideo({ crt: { enabled: on }, filter: { enabled: on } });
  });
  const bMute = btn('sound', 'Sound', () => { app.start(); app.setMuted(!app.audio.muted); });
  let loadAndRun = true;
  const pickFile = (e) => { loadAndRun = !(e && e.shiftKey); fileInput.click(); };
  const bLoad = btn('load', 'Load file (Shift+click: attach without running)', pickFile);
  const bUnload = btn('unload', 'Unload (start in BASIC)', () => app.unload());
  const bStates = btn('states', 'Save and load', () => toggleStates());
  const bSettings = btn('settings', 'Settings', () => toggleSettings());
  const bFull = btn('fullscreen', 'Fullscreen (F11)', () => toggleFullscreen());
  const touchWanted = o.touchControls === true ||
    (o.touchControls === 'auto' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  let touchCtl = null;
  const bSlide = btn('slide', 'Slide onto touch buttons', () => app.setTouchSlide(!app.touchSlide));
  const bLayout = btn('layout', 'Move touch controls', () => touchCtl && touchCtl.setEditing(!touchCtl.editing));
  const left = el('div', { class: 'zx-toolbar-group' });
  const right = el('div', { class: 'zx-toolbar-group' });
  const full = !o.minimal;
  const canLoad = full && o.allowFileDrop;
  if (full) left.append(bReset);
  left.append(bPause, bJoy);
  if (full) left.append(bWarp);
  if (touchWanted) left.append(bSlide, bLayout);
  if (o.saveStates) right.append(bStates);
  right.append(bCrt);
  right.append(bMute);
  if (canLoad) right.append(bLoad);
  if (full) right.append(bUnload);
  if (full && o.settings) right.append(bSettings);
  right.append(bFull);
  toolbar.append(left, el('div', { class: 'zx-title' }), right, fileInput);
  toolbar.querySelector('.zx-title').textContent = o.title || '';
  if (o.toolbar) container.append(toolbar);
  else container.classList.add('zx-notoolbar');

  const panel = el('div', { class: 'zx-panel', hidden: '' });
  container.append(panel);

  const statesPanel = el('div', { class: 'zx-panel zx-states', hidden: '' });
  container.append(statesPanel);
  let pausedBefore = false;

  function slotTime(t) {
    const d = new Date(t);
    const today = new Date().toDateString() === d.toDateString();
    return today ? 'Today ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  async function buildStates() {
    const h = app.opts.hotkeys;
    statesPanel.innerHTML = '';
    const head = el('div', { class: 'zx-panel-head' }, '<h2>Save and load</h2>');
    head.append(el('button', { class: 'zx-btn zx-close', type: 'button', 'aria-label': 'Close', onclick: () => toggleStates(false) }, '✕'));
    const list = el('div', { class: 'zx-slots' });
    const help = el('p', { class: 'zx-help' });
    help.textContent = `${h.saveState ? h.saveState + ' saves and ' : ''}${h.loadState ? h.loadState + ' loads ' : ''}` +
      `${h.saveState || h.loadState ? 'the last slot used. ' : ''}Saves are kept in this browser, separately for each game.`;
    statesPanel.append(head, list, help);
    let slots;
    try {
      slots = await app.listStates();
    } catch (e) {
      list.textContent = String(e.message || e);
      return;
    }
    for (let i = 1; i <= SLOT_COUNT; i++) {
      const s = slots[i - 1];
      const card = el('div', { class: 'zx-slot' + (s ? '' : ' empty') + (i === app.quickSlot ? ' quick' : '') });
      const pic = el('div', { class: 'zx-slot-pic' });
      if (s && s.thumb) pic.append(el('img', { src: s.thumb, alt: '' }));
      const info = el('div', { class: 'zx-slot-info' }, '<strong></strong><span></span>');
      info.firstChild.textContent = `Slot ${i}`;
      info.lastChild.textContent = s ? slotTime(s.time) : 'Empty';
      const acts = el('div', { class: 'zx-slot-acts' });
      acts.append(action('Save', () => app.saveState(i)));
      if (s) {
        acts.append(action('Load', async () => { if (await app.loadState(i)) toggleStates(false); }));
        const del = action('✕', () => { if (confirm(`Delete the save in slot ${i}?`)) app.deleteState(i); });
        del.title = 'Delete';
        acts.append(del);
      }
      card.append(pic, info, acts);
      list.append(card);
    }
  }

  function toggleStates(show) {
    const vis = show ?? statesPanel.hidden;
    if (vis === !statesPanel.hidden) return;
    if (vis) {
      if (touchCtl) touchCtl.setEditing(false);
      toggleSettings(false);
      pausedBefore = app.paused;
      app.pause(true);
      buildStates();
    } else if (!pausedBefore) {
      app.pause(false);
    }
    statesPanel.hidden = !vis;
    bStates.classList.toggle('on', vis);
    app.input.enabled = !vis;
    if (vis) app.input.releaseAll();
  }

  function select(label, options, value, onchange) {
    const row = el('label', { class: 'zx-row' }, `<span></span>`);
    row.firstChild.textContent = label;
    const s = el('select');
    for (const [v, t] of options) {
      const opt = el('option', { value: v });
      opt.textContent = t;
      if (String(v) === String(value)) opt.selected = true;
      s.append(opt);
    }
    s.addEventListener('change', () => onchange(s.value));
    row.append(s);
    return row;
  }

  function check(label, value, onchange) {
    const row = el('label', { class: 'zx-row zx-check' }, '<span></span>');
    row.firstChild.textContent = label;
    const c = el('input', { type: 'checkbox' });
    c.checked = !!value;
    c.addEventListener('change', () => onchange(c.checked));
    row.append(c);
    return row;
  }

  function slider(label, key, min, max) {
    const row = el('label', { class: 'zx-row zx-slider' }, '<span></span>');
    row.firstChild.textContent = label;
    const s = el('input', { type: 'range', min, max, step: 25 });
    s.value = app.renderer.crt[key];
    const out = el('output');
    out.textContent = s.value;
    s.addEventListener('input', () => {
      out.textContent = s.value;
      app.setVideo({ crt: { [key]: Number(s.value) } });
    });
    row.append(s, out);
    return row;
  }

  function filterSlider(label, key) {
    const [min, max] = FILTER_RANGES[key];
    const row = el('label', { class: 'zx-row zx-slider' }, '<span></span>');
    row.firstChild.textContent = label;
    const s = el('input', { type: 'range', min, max, step: 1 });
    s.value = app.renderer.filter[key];
    const out = el('output');
    out.textContent = s.value;
    s.addEventListener('input', () => {
      out.textContent = s.value;
      app.setVideo({ filter: { [key]: Number(s.value) } });
    });
    row.append(s, out);
    return row;
  }

  function colour(label, value, onchange) {
    const row = el('label', { class: 'zx-row' }, '<span></span>');
    row.firstChild.textContent = label;
    const c = el('input', { type: 'color', value });
    c.addEventListener('input', () => onchange(c.value));
    row.append(c);
    return row;
  }

  function joyKeyRow(dir) {
    const row = el('div', { class: 'zx-row' }, '<span></span>');
    row.firstChild.textContent = 'Joystick ' + (dir === 'fire2' ? 'fire 2' : dir);
    const codes = [].concat(app.input.joyKeyConfig[dir] || []);
    const pair = el('div', { class: 'zx-keypair' });
    for (const slot of [0, 1]) {
      const b = el('button', {
        class: 'zx-action zx-keybind', type: 'button',
        title: `${slot ? 'Secondary' : 'Primary'} key: click, then press a key`,
      });
      b.textContent = codes[slot] ? keyLabel(codes[slot]) : slot ? '+' : 'none';
      if (slot && codes.length > 2) b.title += `. Also: ${codes.slice(2).map(keyLabel).join(', ')}`;
      b.addEventListener('click', () => {
        b.textContent = 'Press a key';
        const capture = (e) => {
          e.preventDefault();
          e.stopImmediatePropagation();
          window.removeEventListener('keydown', capture, true);
          if (e.code === 'Escape') { buildPanel(); return; }
          if (e.code === 'Backspace') { app.setJoystickKey(dir, null, slot); buildPanel(); return; }
          if (Object.values(app.opts.hotkeys).includes(e.code)) {
            ui.message(`${keyLabel(e.code)} is already a hotkey`, 2000);
            buildPanel();
            return;
          }
          app.setJoystickKey(dir, e.code, slot);
          buildPanel();
        };
        window.addEventListener('keydown', capture, true);
      });
      pair.append(b);
    }
    row.append(pair);
    return row;
  }

  function section(title, ...rows) {
    const sec = el('section', { class: 'zx-section' }, '<h3></h3>');
    sec.firstChild.textContent = title;
    sec.append(...rows);
    return sec;
  }

  function action(label, fn) {
    return el('button', { class: 'zx-action', type: 'button', onclick: fn }, label);
  }

  function buildPanel() {
    panel.innerHTML = '';
    const head = el('div', { class: 'zx-panel-head' }, '<h2>Settings</h2>');
    head.append(el('button', { class: 'zx-btn zx-close', type: 'button', 'aria-label': 'Close', onclick: () => toggleSettings(false) }, '✕'));
    panel.append(head);
    const r = app.renderer;
    const m = app.machine;
    panel.append(
      section('Machine',
        select('Model', Object.entries(MODELS).filter(([k]) => app.modelAvailable(k)).map(([k, v]) => [k, v.name]), app.model, (v) => app.setModel(v)),
        select('Joystick interface', JOYSTICK_TYPES.map((t) => [t, JOYSTICK_LABELS[t]]), app.joystickType, (v) => app.setJoystickType(v)),
        check('Fast tape loading', app.flashLoad, (v) => app.setFlashLoad(v)),
        check('Auto warp while loading', app.opts.warp.auto, (v) => { app.opts.warp.auto = v; }),
        select('AY sound (128K)', STEREO_LABELS, app.stereo, (v) => app.setStereo(v)),
        el('div', { class: 'zx-actions' }),
      ),
      section('Display',
        check('CRT emulation', r.crt.enabled, (v) => app.setVideo({ crt: { enabled: v } })),
        select('Palette', PALETTE_NAMES.map((n) => [n, PALETTE_LABELS[n] || n]), r.palette, (v) => app.setVideo({ palette: v })),
        select('Borders', [['normal', 'Normal'], ['full', 'Full'], ['tight', 'Small'], ['none', 'None']], r.border, (v) => app.setVideo({ border: v })),
        select('Aspect ratio', [['tv', 'TV (non-square pixels)'], ['square', 'Square pixels']], r.aspect, (v) => app.setVideo({ aspect: v })),
        check('Integer scaling', r.integerScale, (v) => app.setVideo({ integerScale: v })),
        slider('Blur', 'blur', 0, 1000),
        slider('Scanline shade', 'scanlineShade', 0, 1000),
        slider('Saturation', 'saturation', 0, 2000),
        slider('Contrast', 'contrast', 0, 2000),
        slider('Brightness', 'brightness', 0, 2000),
        slider('Gamma', 'gamma', 0, 4000),
        slider('Tint', 'tint', 0, 2000),
        slider('PAL odd line phase', 'oddLinesPhase', 0, 2000),
        slider('PAL odd line offset', 'oddLinesOffset', 0, 2000),
      ),
      section('CRT filter',
        check('Draw the CRT filter', r.filter.enabled, (v) => app.setVideo({ filter: { enabled: v } })),
        filterSlider('Pattern scale', 'scale'),
        filterSlider('Scan lines: every n lines', 'everyNLines'),
        filterSlider('Lines darkened', 'linesDarkened'),
        filterSlider('Darkness (%)', 'darkness'),
        select('Direction', [['rows', 'Rows'], ['columns', 'Columns']], r.filter.direction, (v) => app.setVideo({ filter: { direction: v } })),
        filterSlider('Bulge (%)', 'bulge'),
        filterSlider('Rounded corners (%)', 'corners'),
        filterSlider('Corner dot', 'cornerDot'),
        filterSlider('Bleed (%)', 'bleed'),
        filterSlider('Glow (%)', 'glow'),
        filterSlider('Mask (%)', 'mask'),
        select('Mask shape', MASK_SHAPES.map((m) => [m, { stripes: 'Stripes', 'stripes-gaps': 'Stripes with gaps', slots: 'Slots', dots: 'Dots' }[m]]),
          r.filter.maskShape, (v) => app.setVideo({ filter: { maskShape: v } })),
        filterSlider('Stripe width', 'maskWidth'),
        colour('Tint colour', r.filter.tintColor, (v) => app.setVideo({ filter: { tintColor: v } })),
        filterSlider('Tint (%)', 'tint'),
        filterSlider('Roll per frame', 'roll'),
        filterSlider('Rolling bar (%)', 'rollingBar'),
      ),
      section('Input',
        check('Keyboard joystick (F9)', app.input.joyKeysEnabled, (v) => app.setJoystickKeys(v)),
        ...['up', 'down', 'left', 'right', 'fire', 'fire2'].map((dir) => joyKeyRow(dir)),
        el('div', { class: 'zx-actions zx-joyreset' }),
        select('Keyboard mapping', [['symbolic', 'Symbolic (type what you see)'], ['positional', 'Positional']],
          app.input.keyboardMap, (v) => app.setKeyboardMap(v)),
        el('p', { class: 'zx-help' },
          'Joystick keys: a primary and a secondary key each. Click one, then press a key (Backspace clears, Esc cancels). ' +
          'Spectrum keys: Shift = CAPS SHIFT, Ctrl or Alt = SYMBOL SHIFT, Backspace = DELETE, cursor keys = CAPS SHIFT + 5–8, ' +
          'Esc = BREAK, Tab = EXTEND MODE, Caps Lock = CAPS LOCK, Home = EDIT, End = GRAPH. ' +
          'Gamepads work automatically. Paste text to type it into BASIC (on a 48K, keywords are single keys).'),
      ),
      section('Media', el('div', { class: 'zx-actions zx-media' })),
    );
    panel.querySelector('.zx-joyreset').append(action('Default joystick keys', () => { app.resetJoystickKeys(); buildPanel(); }));
    const acts = panel.querySelector('.zx-actions');
    acts.append(action('Restart program', () => app.reset()), action('Reset to BASIC', () => app.resetToBasic()));
    const media = panel.querySelector('.zx-media');
    if (m && m.tape.present) {
      media.append(
        action('Tape: Play', () => m.tape.play()),
        action('Tape: Stop', () => m.tape.stop()),
        action('Tape: Rewind', () => m.tape.rewind()),
      );
    }
    if (m && m.tape.saved.length) {
      media.append(action('Download saved tape', () => download(m.tape.savedTap(), 'saved.tap')));
    }
    if (m && m.disks[0]) {
      media.append(action('Download disk image', () => download(app.diskImage(), (app.mediaNames && app.mediaNames.disk) || 'disk.dsk')));
    }
    if (m && !app.machine.info.next) media.append(action('Save snapshot (.z80)', () => download(app.snapshot(), 'snapshot.z80')));
    if (o.allowFileDrop) media.append(action('Load file…', pickFile));
    media.append(action('Unload (start in BASIC)', () => app.unload()));
  }

  function download(bytes, name) {
    if (!bytes) return;
    const a = el('a', { href: URL.createObjectURL(new Blob([bytes])), download: name });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function toggleSettings(show) {
    const vis = show ?? panel.hidden;
    if (vis) { if (touchCtl) touchCtl.setEditing(false); toggleStates(false); buildPanel(); }
    panel.hidden = !vis;
    app.input.enabled = !vis;
    if (vis) app.input.releaseAll();
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (container.requestFullscreen) container.requestFullscreen().catch(() => {});
    else if (container.webkitRequestFullscreen) container.webkitRequestFullscreen();
  }

  if (touchWanted) {
    const touch = el('div', { class: 'zx-touch' });
    const stickDirs = touchStickBits(o.touchStick);
    const stick = el('div', { class: 'zx-stick' }, '<div class="zx-knob"></div>');
    const fires = el('div', { class: 'zx-fires' });
    const keys = el('div', { class: 'zx-touch-keys' });
    for (const spec of o.touchKeys || []) {
      const t = touchKey(spec);
      if (!t) continue;
      const b = el('button', { type: 'button', class: 'zx-key' });
      b.textContent = t.label;
      let held = false;
      const down = (e) => {
        e.preventDefault();
        app.start();
        if (held) return;
        held = true;
        for (const k of t.keys) app.machine.key(k, true);
      };
      const up = (e) => {
        e.preventDefault();
        if (!held) return;
        held = false;
        for (const k of t.keys) app.machine.key(k, false);
      };
      b.addEventListener('pointerdown', down);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('pointerleave', up);
      keys.append(b);
    }
    touch.append(keys);
    if (stickDirs) touch.append(stick);
    else touch.classList.add('zx-touch-nostick');

    const buttons = [].concat(o.touchFire ?? []).map(touchFireButton).filter(Boolean);
    for (const t of buttons) {
      t.el = el('div', { class: 'zx-fire' });
      t.el.textContent = t.label;
      fires.append(t.el);
    }
    if (buttons.length) touch.append(fires);
    else touch.classList.add('zx-touch-nofire');
    if (buttons.length > 1) touch.classList.add('zx-touch-fires');
    if (buttons.length > 2) touch.classList.add('zx-touch-manyfires');
    const editBar = el('div', { class: 'zx-touch-editbar', hidden: '' }, '<span>Drag the stick and buttons to move them</span>');
    editBar.append(action('Reset', () => resetLayout()), action('Done', () => setEditing(false)));
    container.append(touch, editBar);

    const fingers = new Map();
    let stickId = null, stickBits = 0;
    const knob = stick.firstChild;
    const centre = (node) => {
      const r = node.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2 };
    };
    const onStick = (f) => {
      if (!stickDirs) return false;
      const c = centre(stick);
      return Math.hypot(f.x - c.x, f.y - c.y) <= c.r;
    };
    const buttonsAt = (f) => buttons.filter((t) => {
      const c = centre(t.el);
      return Math.hypot(f.x - c.x, f.y - c.y) <= c.r + f.r;
    });
    const fingerAt = (e) => ({ x: e.clientX, y: e.clientY, r: Math.max(16, Math.min(28, (e.width || 0) / 2)) });

    const updateStick = (f) => {
      const c = centre(stick);
      let dx = f.x - c.x, dy = f.y - c.y;
      if (!(stickDirs & (JOY.LEFT | JOY.RIGHT))) dx = 0;
      if (!(stickDirs & (JOY.UP | JOY.DOWN))) dy = 0;
      const len = Math.min(1, Math.hypot(dx, dy) / c.r);
      const ang = Math.atan2(dy, dx);
      knob.style.transform = `translate(${Math.cos(ang) * len * c.r * 0.6}px, ${Math.sin(ang) * len * c.r * 0.6}px)`;
      stickBits = 0;
      if (len > 0.3) {
        const oct = Math.round(ang / (Math.PI / 4)) & 7;
        stickBits = [JOY.RIGHT, JOY.RIGHT | JOY.DOWN, JOY.DOWN, JOY.DOWN | JOY.LEFT,
          JOY.LEFT, JOY.LEFT | JOY.UP, JOY.UP, JOY.UP | JOY.RIGHT][oct] & stickDirs;
      }
    };
    const releaseStick = () => { stickId = null; stickBits = 0; knob.style.transform = ''; };

    const refresh = () => {
      let bits = stickBits;
      for (const t of buttons) {
        const down = [...fingers.values()].some((f) => f.buttons.includes(t));
        if (down !== !!t.held) {
          t.held = down;
          t.el.classList.toggle('on', down);
          if (!t.joy) for (const k of t.keys) app.machine.key(k, down);
        }
        if (down && t.joy) bits |= t.joy;
      }
      app.input.setTouchJoy(bits);
    };
    const moveFinger = (id, f, landed) => {
      const take = landed || app.touchSlide;
      if (stickId === null && take && onStick(f)) stickId = id;
      if (id === stickId) { f.buttons = []; updateStick(f); }
      else if (take) f.buttons = buttonsAt(f);
      refresh();
    };

    const movable = (stickDirs ? [{ id: 'stick', node: stick }] : [])
      .concat(buttons.map((t, i) => ({ id: 'fire' + (i + 1), node: t.el })));
    const layout = app.pref('touchLayout', null) || {};
    let editing = false, editPaused = false, drag = null;
    const shape = () => (screen.clientHeight > screen.clientWidth ? 'portrait' : 'landscape');
    const setOffset = (m, x, y) => {
      m.node.style.transform = '';
      const r = m.node.getBoundingClientRect(), s = screen.getBoundingClientRect();
      x = Math.round(Math.min(Math.max(x, s.left - r.left), s.right - r.right));
      y = Math.round(Math.min(Math.max(y, s.top - r.top), s.bottom - r.bottom));
      m.node.style.transform = x || y ? `translate(${x}px, ${y}px)` : '';
      m.at = [x, y];
    };
    const place = () => {
      const offs = layout[shape()] || {};
      for (const m of movable) setOffset(m, ...(offs[m.id] || [0, 0]));
    };
    const saveLayout = () => app.savePref('touchLayout', Object.keys(layout).length ? layout : undefined);
    const resetLayout = () => { delete layout[shape()]; saveLayout(); place(); };
    const setEditing = (on) => {
      if (on === editing) return;
      if (on) {
        toggleSettings(false);
        toggleStates(false);
        editPaused = app.paused;
        app.pause(true);
        fingers.clear();
        releaseStick();
        refresh();
      } else if (!editPaused) {
        app.pause(false);
      }
      editing = on;
      drag = null;
      touch.classList.toggle('zx-touch-edit', on);
      editBar.hidden = !on;
      bLayout.classList.toggle('on', on);
    };
    touchCtl = { place, setEditing, get editing() { return editing; } };

    const elsewhere = (target) => [toolbar, panel, statesPanel, keys, editBar].some((n) => n.contains(target));
    container.addEventListener('pointerdown', (e) => {
      if (elsewhere(e.target)) return;
      if (editing) {
        const m = movable.find((c) => c.node.contains(e.target));
        if (!m) return;
        e.preventDefault();
        drag = { id: e.pointerId, m, x0: e.clientX - m.at[0], y0: e.clientY - m.at[1] };
        return;
      }
      const f = { ...fingerAt(e), buttons: [] };
      fingers.set(e.pointerId, f);
      moveFinger(e.pointerId, f, true);
      if (e.pointerId === stickId || f.buttons.length) { e.preventDefault(); app.start(); }
    }, true);
    window.addEventListener('pointermove', (e) => {
      if (drag && e.pointerId === drag.id) {
        setOffset(drag.m, e.clientX - drag.x0, e.clientY - drag.y0);
        return;
      }
      const f = fingers.get(e.pointerId);
      if (!f) return;
      Object.assign(f, fingerAt(e));
      moveFinger(e.pointerId, f, false);
    });
    const lift = (e) => {
      if (drag && e.pointerId === drag.id) {
        const offs = layout[shape()] = layout[shape()] || {};
        offs[drag.m.id] = drag.m.at;
        saveLayout();
        drag = null;
        return;
      }
      if (!fingers.delete(e.pointerId)) return;
      if (e.pointerId === stickId) releaseStick();
      refresh();
    };
    window.addEventListener('pointerup', lift);
    window.addEventListener('pointercancel', lift);
  }

  let toastTimer = 0;
  const ui = {
    canvas,
    message(text, ms = 2000) {
      toast.textContent = text;
      toast.classList.add('show');
      clearTimeout(toastTimer);
      if (ms) toastTimer = setTimeout(() => toast.classList.remove('show'), ms);
    },
    showStart() {
      start.hidden = false;
      const hint = start.querySelector('.zx-start-hint');
      hint.textContent = app.input.joyKeysEnabled
        ? `Joystick: cursor keys, fire = ${[].concat(app.input.joyKeyConfig.fire || []).map(keyLabel)[0] || 'none'}. F9 toggles keyboard joystick.`
        : 'F9 switches the cursor keys to joystick.';
    },
    hideStart() { start.hidden = true; toast.classList.remove('show'); canvas.focus({ preventScroll: true }); },
    toggleFullscreen,
    resize() {
      const r = screen.getBoundingClientRect();
      app.renderer.alignTop = touchWanted && r.height > r.width;
      app.renderer.resize(r.width, r.height, window.devicePixelRatio || 1);
      if (touchCtl) touchCtl.place();
    },
    update() {
      bJoy.classList.toggle('on', app.input.joyKeysEnabled);
      bSlide.classList.toggle('on', !!app.touchSlide);
      joyTag.classList.toggle('on', app.input.joyKeysEnabled);
      bWarp.classList.toggle('on', app.warp);
      bCrt.classList.toggle('on', app.renderer.crt.enabled || app.renderer.filter.enabled);
      bMute.innerHTML = icon(app.audio.muted ? 'mute' : 'sound');
      bPause.innerHTML = icon(app.paused ? 'play' : 'pause');
      bPause.title = app.paused ? 'Resume' : 'Pause';
    },
    refreshPanel() {
      if (!panel.hidden) buildPanel();
    },
    refreshStates() {
      if (!statesPanel.hidden) buildStates();
    },
    tick(warping) {
      const m = app.machine;
      led.classList.toggle('on', !!(m.fdc && m.fdc.led));
      led.hidden = !(m.fdc && m.disks[0]);
      tape.hidden = !m.tape.present;
      tape.classList.toggle('on', m.tape.running);
      warp.classList.toggle('on', !!warping);
    },
    attachInput() {
      const begin = () => app.start();
      start.addEventListener('click', begin);
      window.addEventListener('keydown', (e) => {
        if (!app.started && !start.hidden) begin();
        if (e.code === 'Escape' && !statesPanel.hidden) toggleStates(false);
      });
      screen.addEventListener('pointerdown', () => { app.start(); canvas.focus({ preventScroll: true }); });
      window.addEventListener('paste', (e) => {
        if (!panel.hidden) return;
        const text = (e.clipboardData || window.clipboardData).getData('text');
        if (text) { e.preventDefault(); app.typeText(text.replace(/\r\n?/g, '\r').replace(/\n/g, '\r')); }
      });
      fileInput.addEventListener('change', () => {
        if (fileInput.files[0]) app.loadFile(fileInput.files[0], { run: loadAndRun }).catch((e) => ui.message(String(e.message || e), 5000));
        fileInput.value = '';
      });
      if (canLoad) {
        let depth = 0;
        container.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; drop.hidden = false; });
        container.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; drop.hidden = true; } });
        container.addEventListener('dragover', (e) => e.preventDefault());
        container.addEventListener('drop', (e) => {
          e.preventDefault();
          depth = 0;
          drop.hidden = true;
          const f = e.dataTransfer.files[0];
          if (f) app.loadFile(f, { run: !e.shiftKey }).catch((err) => ui.message(String(err.message || err), 5000));
        });
      }
      if (window.ResizeObserver) new ResizeObserver(() => ui.resize()).observe(screen);
      window.addEventListener('resize', () => ui.resize());
      document.addEventListener('fullscreenchange', () => ui.resize());
    },
  };
  return ui;
}
