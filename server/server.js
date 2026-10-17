// PhoneCam server — connects the phone app to browser tabs.
//
// The video itself goes directly phone -> browser over WebRTC; this server only
// passes the connection setup messages ("signaling") between them.
//
//   Phone app    ws://<LAN IP>:PORT/ws?role=phone&key=KEY     (needs the pairing key)
//   Browser      ws://127.0.0.1:PORT/ws?role=viewer           (this PC only: the Chrome
//                                                               extension or the preview page)
//   Pages        http://localhost:PORT/                       (preview + pairing QR code)
//                http://localhost:PORT/test.html              (fake meeting page for testing)
//                http://localhost:PORT/test-phone.html        (fake phone, for testing without the app)

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, '.data');
const MAX_MESSAGE_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Network + config
// ---------------------------------------------------------------------------

const VIRTUAL_ADAPTER = /vethernet|virtualbox|vmware|hyper-v|wsl|docker|loopback|tailscale|zerotier|bluetooth/i;

function lanAddresses() {
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      found.push({ name, address: a.address, virtual: VIRTUAL_ADAPTER.test(name) });
    }
  }
  // Real adapters first, then the usual home-network ranges.
  const rank = (x) => (x.virtual ? 10 : 0) + (x.address.startsWith('192.168.') ? 0 : x.address.startsWith('10.') ? 1 : 2);
  return found.sort((a, b) => rank(a) - rank(b));
}

function loadConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  if (process.env.PHONECAM_KEY) cfg.key = process.env.PHONECAM_KEY;
  if (!cfg.key) cfg.key = crypto.randomBytes(6).toString('hex');
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return cfg;
}

function pairingUrl(address, key) {
  return `phonecam://pair?host=${address}&port=${PORT}&key=${key}`;
}

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------

function isLoopback(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// Blocks DNS-rebinding: a web page can't pretend "evil.com" is this server.
function isLocalHost(req) {
  const host = (req.headers.host || '').toLowerCase();
  return host === `localhost:${PORT}` || host === `127.0.0.1:${PORT}` || host === `[::1]:${PORT}`;
}

// Only our own pages and browser extensions may watch the camera. Websites
// can't open this socket and spy on the stream.
function isTrustedViewerOrigin(origin) {
  if (!origin) return true; // non-browser local tools (tests)
  if (origin.startsWith('chrome-extension://')) return true;
  return origin === `http://localhost:${PORT}` || origin === `http://127.0.0.1:${PORT}`;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------------
// Signaling state
// ---------------------------------------------------------------------------

let phone = null;           // { ws, name, ip, since }
const viewers = new Map();  // id -> { ws, watching }
let nextViewerId = 1;

function send(ws, msg) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
}

function phoneState() {
  return phone ? { connected: true, name: phone.name, since: phone.since } : { connected: false };
}

function broadcastPhoneState() {
  for (const v of viewers.values()) send(v.ws, { type: 'phone', ...phoneState() });
}

function watchingCount() {
  let n = 0;
  for (const v of viewers.values()) if (v.watching) n++;
  return n;
}

function handlePhone(ws, req) {
  const ip = req.socket.remoteAddress?.replace('::ffff:', '');
  if (phone) {
    send(phone.ws, { type: 'replaced' });
    phone.ws.close(4000, 'Another phone connected');
  }
  // The PC address the phone reached us on — the browser is reachable there too.
  const localIp = req.socket.localAddress?.replace('::ffff:', '');
  phone = { ws, name: 'Phone', ip, localIp, since: new Date().toISOString() };
  log(`Phone connected from ${ip}`);

  ws.on('message', (raw) => {
    if (phone?.ws !== ws) return;
    const msg = parse(raw);
    if (!msg) return;
    switch (msg.type) {
      case 'hello':
        phone.name = String(msg.name || 'Phone').slice(0, 60);
        log(`Phone is "${phone.name}"`);
        broadcastPhoneState();
        // Start a stream for every tab already waiting on the camera.
        for (const [id, v] of viewers) if (v.watching) send(ws, { type: 'viewer-join', id });
        break;
      case 'signal': {
        const v = viewers.get(msg.to);
        if (v) send(v.ws, { type: 'signal', data: msg.data });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (phone?.ws !== ws) return;
    phone = null;
    log('Phone disconnected');
    broadcastPhoneState();
  });
}

function handleViewer(ws) {
  const id = String(nextViewerId++);
  const viewer = { ws, watching: false };
  viewers.set(id, viewer);
  send(ws, { type: 'phone', ...phoneState() });

  ws.on('message', (raw) => {
    const msg = parse(raw);
    if (!msg) return;
    switch (msg.type) {
      case 'watch':
        if (viewer.watching) return;
        viewer.watching = true;
        log(`Camera requested (${watchingCount()} active)`);
        if (phone) send(phone.ws, { type: 'viewer-join', id });
        break;
      case 'unwatch':
        if (!viewer.watching) return;
        viewer.watching = false;
        if (phone) send(phone.ws, { type: 'viewer-leave', id });
        log(`Camera released (${watchingCount()} active)`);
        break;
      case 'signal':
        if (phone && viewer.watching) send(phone.ws, { type: 'signal', from: id, data: revealCandidate(msg.data, phone.localIp) });
        break;
    }
  });

  ws.on('close', () => {
    viewers.delete(id);
    if (viewer.watching && phone) send(phone.ws, { type: 'viewer-leave', id });
  });
}

// Chrome hides its own IP in ICE candidates behind a random "<uuid>.local" name.
// The phone can't resolve that (and is often behind a second router), so swap
// in the PC address the phone already reaches. The port stays real.
function revealCandidate(data, ip) {
  const c = data?.candidate;
  if (!ip || !c || typeof c.candidate !== 'string') return data;
  const replaced = c.candidate.replace(/ [0-9a-f-]{36}\.local /i, ` ${ip} `);
  return replaced === c.candidate ? data : { ...data, candidate: { ...c, candidate: replaced } };
}

// Minimal STUN server (RFC 5389 Binding only) so the phone can learn the
// address it appears as from this PC, which gets video through a second router.
function startStunServer(port) {
  const dgram = require('dgram');
  const sock = dgram.createSocket('udp4');
  const MAGIC = 0x2112a442;
  sock.on('message', (msg, rinfo) => {
    if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0001 || msg.readUInt32BE(4) !== MAGIC) return;
    const res = Buffer.alloc(32);
    res.writeUInt16BE(0x0101, 0);        // Binding success response
    res.writeUInt16BE(12, 2);            // attributes length
    res.writeUInt32BE(MAGIC, 4);
    msg.copy(res, 8, 8, 20);             // transaction id
    res.writeUInt16BE(0x0020, 20);       // XOR-MAPPED-ADDRESS
    res.writeUInt16BE(8, 22);
    res.writeUInt16BE(0x0001, 24);       // IPv4
    res.writeUInt16BE(rinfo.port ^ (MAGIC >>> 16), 26);
    const ip = rinfo.address.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
    res.writeUInt32BE((ip ^ MAGIC) >>> 0, 28);
    sock.send(res, rinfo.port, rinfo.address);
  });
  sock.on('error', (err) => log(`STUN disabled: ${err.message}`));
  sock.bind(port, '0.0.0.0');
}

function parse(raw) {
  try {
    const msg = JSON.parse(raw.toString());
    return msg && typeof msg === 'object' ? msg : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendFile(res, name) {
  const file = path.join(PUBLIC_DIR, name);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return notFound(res);
  fs.readFile(file, (err, data) => {
    if (err) return notFound(res);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function sendJson(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const cfg = loadConfig();
  const lan = lanAddresses();
  const pairing = lan.map((a) => ({ ...a, url: pairingUrl(a.address, cfg.key) }));

  const server = http.createServer(async (req, res) => {
    // Everything over HTTP is for this PC only. The phone only uses the WebSocket.
    if (!isLoopback(req) || !isLocalHost(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('PhoneCam: open the PhoneCam app on your phone to connect.');
    }
    const url = new URL(req.url, 'http://x');
    switch (url.pathname) {
      case '/':
        return sendFile(res, 'viewer.html');
      case '/status':
        return sendJson(res, { server: true, phone: phoneState(), watching: watchingCount() });
      case '/info': {
        const primary = pairing[0] || null;
        const qr = primary ? await QRCode.toString(primary.url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) : null;
        return sendJson(res, {
          port: PORT,
          key: cfg.key,
          addresses: pairing.map(({ name, address, virtual, url: u }) => ({ name, address, virtual, url: u })),
          primary: primary && { address: primary.address, url: primary.url },
          qr,
        });
      }
      default:
        if (/^\/[\w.-]+\.(html|js|css|svg)$/.test(url.pathname)) return sendFile(res, url.pathname.slice(1));
        return notFound(res);
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const role = url.searchParams.get('role');
    const reject = (code, text) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname !== '/ws') return reject(404, 'Not Found');

    if (role === 'phone') {
      if (!safeEqual(url.searchParams.get('key') || '', cfg.key)) return reject(403, 'Forbidden');
    } else if (role === 'viewer') {
      if (!isLoopback(req) || !isTrustedViewerOrigin(req.headers.origin)) return reject(403, 'Forbidden');
    } else {
      return reject(400, 'Bad Request');
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      if (role === 'phone') handlePhone(ws, req);
      else handleViewer(ws);
    });
  });

  // Drop dead connections (phone left Wi-Fi, laptop slept). The app-level ping
  // also keeps the Chrome extension's background worker awake.
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
      send(ws, { type: 'ping' });
    }
  }, 15000);

  await new Promise((resolve) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\n  Port ${PORT} is already in use. Is PhoneCam already running? Otherwise set PORT=<another port>.\n`);
        process.exit(1);
      }
      throw err;
    });
    server.listen(PORT, '0.0.0.0', resolve);
  });
  startStunServer(PORT); // UDP, same port number as the web server

  console.log('\n  PhoneCam server is running\n');
  if (pairing[0]) {
    console.log(await QRCode.toString(pairing[0].url, { type: 'terminal', small: true }));
    console.log('  Scan this with the PhoneCam app (phone on the same Wi-Fi), or enter manually:');
    for (const p of pairing) console.log(`     ${p.address}  port ${PORT}  key ${cfg.key}   [${p.name}]${p.virtual ? ' (virtual)' : ''}`);
  } else {
    console.log('  ! No network adapter found. Connect this PC to Wi-Fi/Ethernet and restart.');
  }
  console.log(`\n  Preview on this PC: http://localhost:${PORT}/`);
  console.log('  In Google Meet: Settings -> Video -> Camera -> "PhoneCam"');
  console.log('\n  If the phone cannot connect, allow Node.js through Windows Firewall on Private networks.\n');
}

function log(msg) {
  console.log(`  [${new Date().toLocaleTimeString()}] ${msg}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
