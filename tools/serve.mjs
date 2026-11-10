import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flags = {};
const params = new URLSearchParams();
let gameFile = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--open') flags.open = true;
  else if (a.startsWith('--')) flags[a.slice(2)] = args[++i];
  else if (/^[a-z]+=/i.test(a)) params.append(a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1));
  else gameFile = path.resolve(a);
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(projectRoot, flags.root || 'web');
let port = Number(flags.port || process.env.PORT || 8080);

if (gameFile) {
  if (!fs.existsSync(gameFile) || !fs.statSync(gameFile).isFile()) {
    console.error(`File not found: ${gameFile}`);
    process.exit(1);
  }
  params.set('file', 'local/' + encodeURIComponent(path.basename(gameFile)));
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

function send(res, file, rel) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found: ' + rel);
      console.log(`404 ${rel}`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (gameFile && rel === '/local/' + path.basename(gameFile)) {
    send(res, gameFile, rel);
    return;
  }
  let file = path.resolve(root, '.' + rel);
  if (file !== root && !file.startsWith(root + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  send(res, file, rel);
});

function openBrowser(url) {
  const [cmd, cmdArgs] = process.platform === 'win32'
    ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).on('error', () => {
    console.log('Could not open a browser; open the address above yourself.');
  }).unref();
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && port < Number(flags.port || 8080) + 20) {
    port++;
    server.listen(port);
  } else {
    console.error(e.message);
    process.exit(1);
  }
});

server.on('listening', () => {
  const query = params.toString();
  const url = `http://localhost:${port}/${query ? '?' + query : ''}`;
  console.log(`AmsEmu dev server: ${url}`);
  console.log(`Serving ${path.relative(projectRoot, root) || '.'}${gameFile ? ' and ' + gameFile : ''}. Press Ctrl+C to stop.`);
  if (flags.open) openBrowser(url);
});

server.listen(port);
