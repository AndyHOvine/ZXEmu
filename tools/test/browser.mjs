// Opens ZXEmu in a headless Chrome or Edge, loads a program, and checks the page: no script
// errors, the machine boots, keys and the joystick reach it, it draws, a save state works.
// Skipped when no browser is found (set BROWSER to one). Run: node tools/test/browser.mjs
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BROWSERS = [process.env.BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
const browser = BROWSERS.find((b) => fs.existsSync(b));
if (!browser) {
  console.log('No Chrome or Edge found: browser test skipped (set BROWSER)');
  process.exit(0);
}

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed++;
  else { failed++; console.log(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- a tiny static server for web/ plus a test program
const PAGE_PORT = 8000 + Math.floor(Math.random() * 900);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const program = makeProgram();
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/test.tap') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(program); return; }
  if (url === '/test.nex') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(makeNex()); return; }
  if (url === '/DATA.BIN') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(Buffer.from([0x1c])); return; }
  const file = path.join(root, 'web', url === '/' ? 'index.html' : url);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(data);
  });
}).listen(PAGE_PORT);

// a .tap with a BASIC program that prints the Kempston port and the last key, forever
function makeProgram() {
  // 10 PRINT AT 0,0;IN 31;" ";CODE INKEY$;"  ": GO TO 10 (tokens as the ROM stores them)
  const num = (n) => [...String(n)].map((c) => c.charCodeAt(0)).concat([0x0e, 0, 0, n & 0xff, n >> 8, 0]);
  const line = [0xf5, 0xac, ...num(0), 0x2c, ...num(0), 0x3b, 0xbf, ...num(31), 0x3b, 0x22, 0x20, 0x22, 0x3b, 0xaf, 0xa6, 0x3b, 0x22, 0x20, 0x20, 0x22,
    0x3a, 0xec, ...num(10), 0x0d];
  const body = [0, 10, line.length & 0xff, line.length >> 8, ...line];
  const header = [0, 0, ...[...'test      '].map((c) => c.charCodeAt(0)), body.length & 0xff, body.length >> 8, 10, 0, body.length & 0xff, body.length >> 8];
  const block = (bytes) => {
    let p = 0;
    for (const b of bytes) p ^= b;
    const all = [...bytes, p];
    return [all.length & 0xff, all.length >> 8, ...all];
  };
  return Buffer.from([...block(header), ...block([0xff, ...body])]);
}

// a .nex for the Next: 28 MHz, reads DATA.BIN's byte from the SD card, fills the first third of
// Layer 2 with it (writing and reading through port $123B's mapping) and shows Layer 2
function makeNex() {
  const code = [
    0xf3, 0xed, 0x91, 0x07, 0x03, // di; nextreg 7,3
    0x3e, 0x2a, 0xdd, 0x21, 0x00, 0x81, 0x06, 0x01, 0xcf, 0x9a, // F_OPEN DATA.BIN
    0xdd, 0x21, 0x00, 0x90, 0x01, 0x01, 0x00, 0xcf, 0x9d, // F_READ 1 byte to $9000
    0x01, 0x3b, 0x12, 0x3e, 0x07, 0xed, 0x79, // out ($123B),7
    0x3a, 0x00, 0x90, 0x21, 0x00, 0x00, 0x77, 0x11, 0x01, 0x00, 0x01, 0xff, 0x3f, 0xed, 0xb0, // fill $0000-$3FFF
    0x18, 0xfe,
  ];
  const head = Buffer.alloc(512);
  head.write('NextV1.2', 0, 'ascii');
  head[9] = 1; head[10] = 0x80; head[12] = 0xf0; head[13] = 0xbf; head[15] = 0x80; head[18 + 2] = 1;
  const bank = Buffer.alloc(0x4000);
  Buffer.from(code).copy(bank, 0);
  bank.write('DATA.BIN\0', 0x100, 'ascii');
  return Buffer.concat([head, bank]);
}

// ---- the browser and a minimal DevTools websocket client
const CDP_PORT = 9300 + Math.floor(Math.random() * 600);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zxemu-test-'));
const proc = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`, '--autoplay-policy=no-user-gesture-required', '--window-size=1024,768', 'about:blank'], { stdio: 'ignore' });

async function json(p) {
  for (let i = 0; i < 50; i++) {
    try {
      return await new Promise((res, rej) => http.get(`http://127.0.0.1:${CDP_PORT}${p}`, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));
    } catch { await sleep(200); }
  }
  throw new Error('The browser did not answer');
}

class Socket {
  constructor(url) {
    const u = new URL(url);
    this.waiting = new Map();
    this.events = [];
    this.id = 0;
    this.buf = Buffer.alloc(0);
    this.ready = new Promise((resolve) => {
      this.s = net.connect(Number(u.port), u.hostname, () => {
        const key = crypto.randomBytes(16).toString('base64');
        this.s.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      let upgraded = false;
      this.s.on('data', (d) => {
        this.buf = Buffer.concat([this.buf, d]);
        if (!upgraded) {
          const end = this.buf.indexOf('\r\n\r\n');
          if (end < 0) return;
          this.buf = this.buf.subarray(end + 4);
          upgraded = true;
          resolve();
        }
        this.frames();
      });
    });
  }

  frames() {
    for (;;) {
      if (this.buf.length < 2) return;
      let len = this.buf[1] & 0x7f, o = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); o = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); o = 10; }
      if (this.buf.length < o + len) return;
      const msg = JSON.parse(this.buf.subarray(o, o + len).toString());
      this.buf = this.buf.subarray(o + len);
      if (msg.id && this.waiting.has(msg.id)) { this.waiting.get(msg.id)(msg); this.waiting.delete(msg.id); }
      else this.events.push(msg);
    }
  }

  call(method, params = {}) {
    const id = ++this.id;
    const data = Buffer.from(JSON.stringify({ id, method, params }));
    const mask = crypto.randomBytes(4);
    const head = data.length < 126 ? Buffer.from([0x81, 0x80 | data.length]) : Buffer.from([0x81, 0x80 | 126, data.length >> 8, data.length & 0xff]);
    const body = Buffer.from(data.map((b, i) => b ^ mask[i & 3]));
    this.s.write(Buffer.concat([head, mask, body]));
    return new Promise((res) => this.waiting.set(id, res));
  }

  async eval(expr) {
    const r = await this.call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate failed');
    return r.result.result.value;
  }
}

async function key(p, code, keyName, down) {
  await p.call('Input.dispatchKeyEvent', { type: down ? 'keyDown' : 'keyUp', code, key: keyName, windowsVirtualKeyCode: { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, KeyA: 65, ControlLeft: 17 }[code] || 0 });
}

try {
  const targets = await json('/json');
  const page = targets.find((t) => t.type === 'page');
  const p = new Socket(page.webSocketDebuggerUrl);
  await p.ready;
  await p.call('Runtime.enable');
  await p.call('Page.enable');
  await p.call('Page.navigate', { url: `http://127.0.0.1:${PAGE_PORT}/?file=test.tap&model=48k` });
  let started = false;
  for (let i = 0; i < 50 && !started; i++) { await sleep(200); started = await p.eval('!!(window.zxemu && window.zxemu.machine)').catch(() => false); }
  check('the page makes a machine', started);
  await p.eval('window.zxemu.start(), true');
  // the program loads from the tape (flash load) and runs: wait for its line
  const text = `(() => { const m = window.zxemu.machine, s = m.screenMem; let out = ''; for (let c = 0; c < 12; c++) { let v = s[0x100 + c] | s[0x200 + c]; out += v ? '#' : '.'; } return { frames: m.frames, pc: m.cpu.pc, line0: out, kemp: m.peek(0x5c00) }; })()`;
  let st;
  for (let i = 0; i < 60; i++) { await sleep(250); st = await p.eval(text); if (st.frames > 200 && st.line0.includes('#')) break; }
  check('the program loaded and printed', st && st.line0.includes('#'), JSON.stringify(st));
  // the keyboard joystick (on by default): the cursor keys and Ctrl to Kempston
  await p.eval('document.querySelector("canvas").focus(), true');
  await key(p, 'ArrowLeft', 'ArrowLeft', true);
  await key(p, 'ControlLeft', 'Control', true);
  await sleep(300);
  const kemp = await p.eval('window.zxemu.machine.ioRead(0x1f)');
  check('cursor keys and Ctrl are the Kempston joystick', kemp === (2 | 16), String(kemp));
  await key(p, 'ArrowLeft', 'ArrowLeft', false);
  await key(p, 'ControlLeft', 'Control', false);
  // F9 turns the keyboard joystick off: then a letter key reaches the keyboard
  await p.call('Input.dispatchKeyEvent', { type: 'keyDown', code: 'F9', key: 'F9', windowsVirtualKeyCode: 120 });
  await p.call('Input.dispatchKeyEvent', { type: 'keyUp', code: 'F9', key: 'F9', windowsVirtualKeyCode: 120 });
  await key(p, 'KeyA', 'a', true);
  await sleep(150);
  const row = await p.eval('window.zxemu.machine.ioRead(0xfdfe) & 0x1f');
  check('A reaches the keyboard', row === 0x1e, String(row));
  await key(p, 'KeyA', 'a', false);
  // it draws: the canvas is not one colour
  const shot = await p.call('Page.captureScreenshot', { format: 'png' });
  const png = Buffer.from(shot.result.data, 'base64');
  fs.writeFileSync(path.join(os.tmpdir(), 'zxemu-browser.png'), png);
  check('a screenshot was taken', png.length > 2000);
  // a save state into slot 1 and back
  const saved = await p.eval('window.zxemu.saveState(1).then(() => window.zxemu.listStates()).then((l) => !!l[0])');
  check('save state slot 1', saved);
  const loaded = await p.eval('window.zxemu.loadState(1)');
  check('load state slot 1', loaded === true);
  // a .z80 snapshot of the machine
  const snap = await p.eval('window.zxemu.snapshot().length');
  check('snapshot made', snap > 1000, String(snap));
  // the Next: a .nex with a file for its SD card, through the page's own loading
  const next = await p.eval(`(async () => {
    const z = window.zxemu;
    const get = async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer());
    z.media = { disk: null, diskB: null, tape: null, snapshot: null, cart: null, bin: null, nex: null, sd: null };
    await z.addFile('DATA.BIN', await get('/DATA.BIN'), 'file');
    await z.addFile('test.nex', await get('/test.nex'));
    await z.boot();
    await new Promise((r) => setTimeout(r, 1000));
    const m = z.machine, { NEXT_RGBA } = await import('./js/emu/nextvideo.js');
    return { model: z.model, speed: m.speed, l2: m.l2Display, px: m.video.fb[48 * 704 + 96], want: NEXT_RGBA[0x38], frames: m.frames };
  })()`);
  check('the Next model for a .nex', next.model === 'next', JSON.stringify(next));
  check('the .nex ran at 28 MHz with Layer 2 on', next.speed === 3 && next.l2 === true, JSON.stringify(next));
  check('the SD card file\'s byte drawn by Layer 2', next.px === next.want, JSON.stringify(next));
  const shot2 = await p.call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(os.tmpdir(), 'zxemu-browser-next.png'), Buffer.from(shot2.result.data, 'base64'));
  const errors = p.events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
  check('no script errors', !errors.length, JSON.stringify(errors.map((e) => e.params.exceptionDetails?.exception?.description || e.params.args?.map((a) => a.value || a.description).join(' '))).slice(0, 500));
} catch (e) {
  check('the browser test ran', false, String(e.stack || e));
} finally {
  proc.kill();
  server.close();
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } }, 500);
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
