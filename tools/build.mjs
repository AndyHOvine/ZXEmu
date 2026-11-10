import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
let name = null;
let allRoms = false;
let gameFile = null;
const settings = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--name') name = args[++i];
  else if (a === '--all-roms') allRoms = true;
  else if (/^[a-z]+=/i.test(a)) settings[a.slice(0, a.indexOf('=')).toLowerCase()] = a.slice(a.indexOf('=') + 1);
  else if (gameFile) {
    console.error(`Only one game file can be given (got ${path.basename(gameFile)} and ${a}).`);
    console.error('Put names with spaces in quotes: --name "My Game"');
    process.exit(1);
  } else gameFile = path.resolve(a);
}
if (gameFile && !fs.existsSync(gameFile)) {
  console.error(`File not found: ${gameFile}`);
  process.exit(1);
}
const SETTINGS = ['model', 'ram', 'plussystem', 'title', 'joykeys', 'crt', 'filter', 'palette', 'border', 'autostart', 'run', 'load', 'exec', 'minimal', 'touchkeys', 'touchstick', 'touchfire', 'touchslide'];
const unknown = Object.keys(settings).filter((k) => !SETTINGS.includes(k));
if (unknown.length) {
  console.error(`Unknown setting: ${unknown.join(', ')}. Settings are: ${SETTINGS.join(', ')}.`);
  process.exit(1);
}
const list = (s) => (s.toLowerCase() === 'none' ? [] : s.split(',').map((k) => k.trim()).filter(Boolean));
const STICK_DIRECTIONS = ['up', 'down', 'left', 'right'];
const { CPC_KEYS } = await import('../web/js/emu/keys.js');
if (settings.touchkeys) {
  const bad = list(settings.touchkeys).map((k) => k.toUpperCase()).filter((k) => CPC_KEYS[k] === undefined);
  if (bad.length) {
    console.error(`Unknown touch key: ${bad.join(', ')}. Use CPC key names such as F1, F2, SPACE, RETURN, Y, N, ESC, CURUP.`);
    process.exit(1);
  }
}
if (settings.touchstick) {
  const bad = list(settings.touchstick).filter((d) => !STICK_DIRECTIONS.includes(d.toLowerCase()));
  if (bad.length) {
    console.error(`Unknown touch stick direction: ${bad.join(', ')}. Use up, down, left, right, or none.`);
    process.exit(1);
  }
}
if (settings.touchfire) {
  const bad = list(settings.touchfire).map((b) => (b.indexOf(':', 1) < 0 ? b : b.slice(0, b.indexOf(':', 1))))
    .filter((n) => !['fire', 'fire2', ...STICK_DIRECTIONS].includes(n.toLowerCase()) && CPC_KEYS[n.toUpperCase()] === undefined);
  if (bad.length) {
    console.error(`Unknown touch fire button: ${bad.join(', ')}. Use fire, fire2, up, down, left, right or a CPC key name, optionally with :label (up:JUMP).`);
    process.exit(1);
  }
}
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
if (!name) name = gameFile ? slug(path.basename(gameFile, path.extname(gameFile))) || 'game' : 'amsemu';

const bundledName = gameFile ? (slug(name) || 'game') + path.extname(gameFile).toLowerCase() : null;

function gameConfig() {
  const flag = (v) => !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
  const game = {};
  if (bundledName) {
    const url = 'games/' + bundledName;
    game.media = settings.load ? { bin: { url, load: settings.load, exec: settings.exec || settings.load } } : { file: url };
  }
  if (settings.model) game.model = settings.model;
  if (settings.plussystem) game.plusSystem = settings.plussystem;
  if (settings.ram) game.ram = settings.ram === 'auto' ? 'auto' : Number(settings.ram);
  if (settings.run) game.autostartFile = settings.run;
  if (settings.title || settings.minimal !== undefined || settings.touchkeys !== undefined ||
      settings.touchstick !== undefined || settings.touchfire !== undefined || settings.touchslide !== undefined) {
    game.ui = {};
    if (settings.title) game.ui.title = settings.title;
    if (settings.minimal !== undefined) game.ui.minimal = flag(settings.minimal);
    if (settings.touchkeys !== undefined) game.ui.touchKeys = list(settings.touchkeys).map((k) => k.toUpperCase());
    if (settings.touchstick !== undefined) game.ui.touchStick = list(settings.touchstick).map((d) => d.toLowerCase());
    if (settings.touchfire !== undefined) game.ui.touchFire = list(settings.touchfire);
    if (settings.touchslide !== undefined) game.ui.touchSlide = flag(settings.touchslide);
  }
  if (settings.joykeys !== undefined) game.joystick = { keyboard: flag(settings.joykeys) };
  if (settings.crt !== undefined || settings.palette || settings.filter !== undefined || settings.border) {
    game.video = {};
    if (settings.crt !== undefined) game.video.crt = flag(settings.crt);
    if (settings.filter !== undefined) game.video.filter = flag(settings.filter);
    if (settings.palette) game.video.palette = settings.palette;
    if (settings.border) game.video.border = settings.border;
  }
  if (settings.autostart !== undefined) {
    game.autostart = ['0', '1', 'true', 'false'].includes(settings.autostart)
      ? flag(settings.autostart) : settings.autostart.replace(/\\r/g, '\r');
  }
  return game;
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(projectRoot, 'web');
const distRoot = path.join(projectRoot, 'dist');
const outDir = path.join(distRoot, name);
const zipFile = path.join(distRoot, `${name}-itch.zip`);

const EXCLUDE = [/^games[\\/]\.gitkeep$/, /\.map$/];

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else {
      const rel = path.relative(base, full);
      if (!EXCLUDE.some((re) => re.test(rel))) out.push(rel);
    }
  }
  return out;
}

fs.rmSync(outDir, { recursive: true, force: true });
for (const rel of walk(src)) {
  const to = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(src, rel), to);
}

if (gameFile) {
  fs.mkdirSync(path.join(outDir, 'games'), { recursive: true });
  fs.copyFileSync(gameFile, path.join(outDir, 'games', bundledName));
  if (path.relative(path.join(src, 'games'), path.dirname(gameFile)) === '' && path.basename(gameFile) !== bundledName) {
    fs.rmSync(path.join(outDir, 'games', path.basename(gameFile)));
  }
} else {
  const base = (await import(pathToFileURL(path.join(src, 'config.js')).href)).default;
  const m = base.media || {};
  const used = [m.disk, m.diskB, m.tape, m.snapshot, m.cart, m.bin, m.file].filter(Boolean)
    .map((c) => path.basename(typeof c === 'string' ? c : c.url || ''));
  const unused = fs.readdirSync(path.join(src, 'games')).filter((f) => !f.startsWith('.') && !used.includes(f));
  if (unused.length) {
    console.warn(`Warning: web/config.js does not load ${unused.map((f) => 'games/' + f).join(', ')}.`);
    console.warn(`  Set media in web/config.js, or give the file: build.bat web\\games\\${unused[0]} title="..."`);
  }
}

const { MODELS, ROM_FILES, resolveModel, romsFor, autoModel } = await import('../web/js/emu/cpc.js');
const { expand } = await import('../web/js/emu/media.js');
const base = (await import(pathToFileURL(path.join(src, 'config.js')).href)).default;
const game = gameConfig();
const config = { ...base, ...game };

const found = { cartridge: false, disk: false, snapshot: null };
for (const entry of Object.values(config.media || {})) {
  const url = typeof entry === 'string' ? entry : entry && entry.url;
  if (!url) continue;
  const file = path.join(outDir, url);
  if (!fs.existsSync(file)) {
    console.warn(`Warning: ${url} is not in the package, so its ROMs can't be worked out.`);
    continue;
  }
  for (const it of await expand(path.basename(file), new Uint8Array(fs.readFileSync(file)))) {
    if (it.type === 'cart') found.cartridge = true;
    if (it.type === 'disk') found.disk = true;
    if (it.type === 'snapshot') found.snapshot = it.data;
  }
}
const plusSystem = config.plusSystem === 'cartridge' ? 'cartridge' : 'cpc6128';
let model;
try {
  model = config.model && config.model !== 'auto' ? resolveModel(config.model) : autoModel(found);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
if (found.cartridge && !MODELS[model].plus) model = '6128plus';
const roms = new Set(romsFor(model, { plusSystem, cartridge: found.cartridge, disk: found.disk }));
if (allRoms) {
  for (const k of ['cpc464', 'cpc664', 'cpc6128', 'amsdos']) roms.add(k);
  if (plusSystem === 'cartridge') roms.add('system');
}
for (const [key, file] of Object.entries(ROM_FILES)) {
  if (!roms.has(key)) fs.rmSync(path.join(outDir, 'roms', file), { force: true });
}
const missingRoms = [...roms].filter((k) => !fs.existsSync(path.join(outDir, 'roms', ROM_FILES[k])));
if (missingRoms.length) {
  console.error(`Missing from web/roms/: ${missingRoms.map((k) => ROM_FILES[k]).join(', ')}`);
  if (missingRoms.includes('system')) {
    console.error('Copy system.cpr into web/roms/ yourself: see "A Plus without a cartridge" in README.md.');
  }
  process.exit(1);
}
game.romsIncluded = [...roms];

{
  fs.renameSync(path.join(outDir, 'config.js'), path.join(outDir, 'config.base.js'));
  fs.writeFileSync(path.join(outDir, 'config.js'),
    `import base from './config.base.js';\n\n` +
    `const game = ${JSON.stringify(game, null, 2)};\n\n` +
    `const merged = { ...base, ...game };\n` +
    `for (const k of ['ui', 'joystick', 'video', 'audio']) {\n` +
    `  if (game[k]) merged[k] = { ...(base[k] || {}), ...game[k] };\n` +
    `}\n\n` +
    `export default merged;\n`);
}

const files = walk(outDir).sort();

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const now = new Date();
const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

const locals = [];
const centrals = [];
let offset = 0;
for (const rel of files) {
  const data = fs.readFileSync(path.join(outDir, rel));
  const zname = Buffer.from(rel.split(path.sep).join('/'));
  const deflated = zlib.deflateRawSync(data, { level: 9 });
  const store = deflated.length >= data.length;
  const body = store ? data : deflated;
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034B50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(store ? 0 : 8, 8);
  local.writeUInt16LE(dosTime, 10);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(zname.length, 26);
  locals.push(local, zname, body);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014B50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(store ? 0 : 8, 10);
  central.writeUInt16LE(dosTime, 12);
  central.writeUInt16LE(dosDate, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(zname.length, 28);
  central.writeUInt32LE(offset, 42);
  centrals.push(central, zname);

  offset += 30 + zname.length + body.length;
}
const centralBuf = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054B50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
fs.mkdirSync(distRoot, { recursive: true });
fs.writeFileSync(zipFile, Buffer.concat([...locals, centralBuf, end]));

const kb = (fs.statSync(zipFile).size / 1024).toFixed(0);
console.log(`Built ${path.relative(projectRoot, outDir)}/ (${files.length} files)`);
console.log(`ROMs for the ${MODELS[model].name}: ${[...roms].map((k) => ROM_FILES[k]).join(', ') || 'none (the cartridge is the whole program)'}`);
if (roms.has('system')) {
  console.log('  system.cpr is Amstrad\'s Plus cartridge, which also holds Ocean\'s Burnin\' Rubber.');
}
console.log(`itch.io package: ${path.relative(projectRoot, zipFile)} (${kb} KB)`);
