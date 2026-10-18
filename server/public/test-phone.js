// PhoneCam — fake phone. Speaks exactly the same protocol as the Android app,
// so the extension can be tested without a phone. It's also the reference for
// what the app must do:
//
//   connect   ws://HOST:PORT/ws?role=phone, pair (challenge/auth, below), then send {type:'hello', name}
//   on {type:'viewer-join', id}   create an RTCPeerConnection, add camera + mic
//                                 tracks, send the offer: {type:'signal', to:id, data:{sdp}}
//   on {type:'signal', from, data} apply the answer / ICE candidate to that viewer
//   on {type:'viewer-leave', id}  close that viewer's connection
//   send own ICE candidates as    {type:'signal', to:id, data:{candidate}}

(() => {
  const $ = (id) => document.getElementById(id);
  const peers = new Map();
  let stream = null;
  let ws = null;

  function log(text) {
    $('log').textContent = `${new Date().toLocaleTimeString()}  ${text}\n` + $('log').textContent;
  }

  // ---- Media: animated test pattern + beep, or the PC webcam ----------------

  function testPattern() {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const g = canvas.getContext('2d');
    const draw = () => {
      const t = performance.now() / 1000;
      const hue = (t * 40) % 360;
      g.fillStyle = `hsl(${hue} 60% 35%)`;
      g.fillRect(0, 0, 1280, 720);
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(640 + Math.cos(t * 2) * 400, 360 + Math.sin(t * 3) * 200, 60, 0, Math.PI * 2);
      g.fill();
      g.font = '600 64px system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText('PhoneCam test phone', 640, 120);
      g.font = '48px ui-monospace, Consolas, monospace';
      g.fillText(new Date().toLocaleTimeString(), 640, 660);
    };
    draw();
    setInterval(draw, 1000 / 30);
    const video = canvas.captureStream(30).getVideoTracks()[0];

    // A soft 440 Hz beep, once a second.
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const dest = ctx.createMediaStreamDestination();
    osc.frequency.value = 440;
    gain.gain.value = 0;
    osc.connect(gain).connect(dest);
    osc.start();
    setInterval(() => {
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.setValueAtTime(0, ctx.currentTime + 0.15);
    }, 1000);
    window.addEventListener('pointerdown', () => ctx.resume(), { once: true });
    ctx.resume().catch(() => {});

    return new MediaStream([video, dest.stream.getAudioTracks()[0]]);
  }

  async function useWebcam() {
    const cam = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: true });
    setStream(cam);
    log('Switched to this PC\'s webcam');
  }

  function setStream(s) {
    stream?.getTracks().forEach((t) => t.stop());
    stream = s;
    $('preview').srcObject = s;
    // Swap tracks on live connections without renegotiating.
    for (const pc of peers.values()) {
      for (const sender of pc.getSenders()) {
        const next = s.getTracks().find((t) => t.kind === sender.track?.kind);
        if (next) sender.replaceTrack(next);
      }
    }
  }

  // ---- Signaling -------------------------------------------------------------

  // ---- Pairing handshake + signed messages (same as the app; see server.js) ----

  let key = '';
  let session = null;
  let sendSeq = 0;
  let recvSeq = 0;

  async function hmac(k, text) {
    const enc = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(k), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(text));
    return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  const randomHex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');

  async function connect() {
    key = (await fetch('/info').then((r) => r.json())).key;
    ws = new WebSocket(`ws://${location.host}/ws?role=phone`);
    session = null;
    sendSeq = 0;
    recvSeq = 0;
    let serverNonce = null;
    let phoneNonce = null;
    let inbox = Promise.resolve();

    ws.onclose = () => {
      $('state').textContent = 'Disconnected — retrying';
      for (const id of [...peers.keys()]) closePeer(id);
      setTimeout(connect, 1500);
    };
    ws.onmessage = (e) => {
      // Handle strictly in order (hashing is async).
      inbox = inbox.then(async () => {
        const frame = JSON.parse(e.data);
        if (!session) {
          if (frame.type === 'challenge') {
            serverNonce = frame.nonce;
            phoneNonce = randomHex(16);
            ws.send(JSON.stringify({ type: 'auth', nonce: phoneNonce, proof: await hmac(key, `phone|${serverNonce}|${phoneNonce}`) }));
          } else if (frame.type === 'auth-ok') {
            if (frame.proof !== await hmac(key, `server|${serverNonce}|${phoneNonce}`)) { log('Server failed to prove the key!'); ws.close(); return; }
            session = await hmac(key, `session|${serverNonce}|${phoneNonce}`);
            $('state').textContent = 'Connected to server';
            log('Paired with server');
            await send({ type: 'hello', name: 'Test phone' });
          }
          return;
        }
        if (!(frame.s > recvSeq) || frame.h !== await hmac(session, `s|${frame.s}|${frame.m}`)) { log('Bad signature — closing'); ws.close(); return; }
        recvSeq = frame.s;
        await onMessage(JSON.parse(frame.m));
      }).catch((err) => log(`Error: ${err.message}`));
    };
  }

  // Signing is async, so queue sends: sequence numbers must leave in order.
  let outbox = Promise.resolve();
  function send(msg) {
    outbox = outbox.then(async () => {
      if (ws?.readyState !== 1 || !session) return;
      const m = JSON.stringify(msg);
      const s = ++sendSeq;
      ws.send(JSON.stringify({ m, s, h: await hmac(session, `p|${s}|${m}`) }));
    }).catch(() => {});
    return outbox;
  }

  async function onMessage(msg) {
    switch (msg.type) {
      case 'viewer-join': {
        closePeer(msg.id);
        const pc = new RTCPeerConnection({ iceServers: [] });
        peers.set(msg.id, pc);
        stream.getTracks().forEach((t) => pc.addTrack(t, stream));
        pc.onicecandidate = (e) => {
          if (e.candidate) send({ type: 'signal', to: msg.id, data: { candidate: e.candidate.toJSON() } });
        };
        pc.onconnectionstatechange = () => {
          log(`Viewer ${msg.id}: ${pc.connectionState}`);
          updateCount();
        };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send({ type: 'signal', to: msg.id, data: { sdp: { type: offer.type, sdp: offer.sdp } } });
        log(`Viewer ${msg.id} joined — offer sent`);
        break;
      }
      case 'viewer-leave':
        closePeer(msg.id);
        log(`Viewer ${msg.id} left`);
        break;
      case 'signal': {
        const pc = peers.get(msg.from);
        if (!pc) return;
        if (msg.data.sdp) await pc.setRemoteDescription(msg.data.sdp);
        else if (msg.data.candidate) await pc.addIceCandidate(msg.data.candidate).catch(() => {});
        break;
      }
      case 'replaced':
        log('Another phone took over');
        break;
    }
    updateCount();
  }

  function closePeer(id) {
    peers.get(id)?.close();
    peers.delete(id);
    updateCount();
  }

  function updateCount() {
    const live = [...peers.values()].filter((pc) => pc.connectionState === 'connected').length;
    $('viewers').textContent = `${live} connected / ${peers.size} total`;
    window.__testPhone = { peers: peers.size, connected: live };
  }

  $('webcam').addEventListener('click', () => useWebcam().catch((e) => log(`Webcam error: ${e.message}`)));
  $('pattern').addEventListener('click', () => { setStream(testPattern()); log('Switched to test pattern'); });

  setStream(testPattern());
  connect();
})();
