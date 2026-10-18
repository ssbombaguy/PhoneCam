// Security checks against a running PhoneCam server (no browser needed).
//   node security.js
// Note: the lockout check blocks 127.0.0.1 for a minute afterwards — run run.js first.

const crypto = require('crypto');
const WebSocket = require('ws');

const BASE = 'ws://127.0.0.1:8080/ws';
const EXT_ORIGIN = 'chrome-extension://ojnbajfobalgohpmbmngfkjglepholmi';
const hmac = (k, t) => crypto.createHmac('sha256', k).update(t).digest('hex');
let failures = 0;
const sockets = [];

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

// Opens a socket; resolves with { ws, first } or { error } if the upgrade is refused.
function open(url, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    sockets.push(ws);
    ws.once('message', (m) => resolve({ ws, first: JSON.parse(m) }));
    ws.once('unexpected-response', (_, res) => resolve({ error: res.statusCode }));
    ws.once('error', (e) => resolve({ error: e.message }));
  });
}

const closed = (ws) => new Promise((resolve) => ws.once('close', (code) => resolve(code)));
const nextMessage = (ws) => new Promise((resolve) => ws.once('message', (m) => resolve(JSON.parse(m))));

// Full handshake with a given key. Resolves with the result of the server's reply.
async function pair(key) {
  const { ws, first } = await open(`${BASE}?role=phone`);
  const pn = crypto.randomBytes(16).toString('hex');
  ws.send(JSON.stringify({ type: 'auth', nonce: pn, proof: hmac(key, `phone|${first.nonce}|${pn}`) }));
  const reply = await Promise.race([nextMessage(ws), closed(ws).then((code) => ({ closeCode: code }))]);
  return { ws, sn: first.nonce, pn, reply };
}

(async () => {
  const { key } = await fetch('http://127.0.0.1:8080/info').then((r) => r.json());

  // Viewers: our extension yes, other extensions and websites no.
  let r = await open(`${BASE}?role=viewer`, { Origin: EXT_ORIGIN });
  check('PhoneCam extension may watch', !!r.ws, r.error);
  r.ws?.close();
  r = await open(`${BASE}?role=viewer`, { Origin: 'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh' });
  check('other extensions are refused', r.error === 403, r.error);
  r = await open(`${BASE}?role=viewer`, { Origin: 'https://evil.example' });
  check('websites are refused', r.error === 403, r.error);

  // Correct key: server proves it knows the key too.
  const good = await pair(key);
  const serverProof = hmac(key, `server|${good.sn}|${good.pn}`);
  check('right key pairs, server proves itself', good.reply.type === 'auth-ok' && good.reply.proof === serverProof);

  // Signed message accepted; tampered one closes the connection.
  const session = hmac(key, `session|${good.sn}|${good.pn}`);
  const m = JSON.stringify({ type: 'hello', name: 'Security test' });
  good.ws.send(JSON.stringify({ m, s: 1, h: hmac(session, `p|1|${m}`) }));
  await new Promise((res) => setTimeout(res, 300));
  const st = await fetch('http://127.0.0.1:8080/status').then((x) => x.json());
  check('signed messages accepted', st.phone.name === 'Security test', st.phone.name);
  const evil = JSON.stringify({ type: 'hello', name: 'Hacked' });
  good.ws.send(JSON.stringify({ m: evil, s: 2, h: hmac(session, `p|2|${m}`) })); // signature of a different message
  check('tampered message closes the connection', (await closed(good.ws)) === 4003);

  // Replay of an old sequence number is refused.
  const again = await pair(key);
  const s2 = hmac(key, `session|${again.sn}|${again.pn}`);
  again.ws.send(JSON.stringify({ m, s: 5, h: hmac(s2, `p|5|${m}`) }));
  again.ws.send(JSON.stringify({ m, s: 5, h: hmac(s2, `p|5|${m}`) }));
  check('replayed message closes the connection', (await closed(again.ws)) === 4003);

  // Old style (?key= in the URL) gives nothing without the handshake.
  const { ws: legacy, first } = await open(`${BASE}?role=phone&key=${key}`);
  check('key in URL alone does not pair', first.type === 'challenge');
  legacy.close();

  // Wrong key: rejected, and after 5 tries the address is locked out.
  const bad = await pair('wrong-key-1234');
  check('wrong key is rejected', bad.reply.closeCode === 4003, JSON.stringify(bad.reply));
  for (let i = 0; i < 4; i++) await pair('wrong-key-1234');
  r = await open(`${BASE}?role=phone`);
  check('locked out after 5 wrong keys', r.error === 429, r.error);

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll security checks passed');
  sockets.forEach((s) => s.terminate());
  process.exitCode = failures ? 1 : 0;
})();
