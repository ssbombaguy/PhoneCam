// PhoneCam — PC preview page. Connects to the server as a viewer (like the
// Chrome extension does) and shows the phone's stream.

(() => {
  const $ = (id) => document.getElementById(id);
  const video = $('video');
  let ws = null;
  let pc = null;
  let queue = Promise.resolve();
  let phone = { connected: false };

  // ---- Server connection ----------------------------------------------------

  // Every watching tab costs the phone a separate video stream, so the preview
  // only pulls video while it is actually visible (not behind the Meet tab).
  const wantVideo = () => document.visibilityState === 'visible';

  document.addEventListener('visibilitychange', () => {
    if (wantVideo()) send({ type: 'watch' });
    else {
      send({ type: 'unwatch' });
      closePeer();
      render();
    }
  });

  function connect() {
    ws = new WebSocket(`ws://${location.host}/ws?role=viewer`);
    ws.onopen = () => { if (wantVideo()) send({ type: 'watch' }); };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'phone') {
        phone = msg;
        if (!msg.connected) closePeer();
        render();
      } else if (msg.type === 'signal') {
        queue = queue.then(() => onSignal(msg.data)).catch((err) => console.warn('[PhoneCam]', err));
      }
    };
    ws.onclose = () => {
      ws = null;
      phone = { connected: false };
      closePeer();
      render('Server stopped — start PhoneCam on this PC');
      setTimeout(connect, 2000);
    };
  }

  function send(msg) {
    if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
  }

  async function onSignal(data) {
    if (data.sdp?.type === 'offer') {
      closePeer();
      pc = new RTCPeerConnection({ iceServers: [] });
      pc.onicecandidate = (e) => e.candidate && send({ type: 'signal', data: { candidate: e.candidate.toJSON() } });
      pc.ontrack = (e) => {
        // Smallest receive buffer = least delay.
        try { e.receiver.jitterBufferTarget = 0; } catch { /* older Chrome */ }
        try { e.receiver.playoutDelayHint = 0; } catch { /* not supported */ }
        video.srcObject = e.streams[0] || new MediaStream([e.track]);
        $('sound').disabled = false;
      };
      pc.onconnectionstatechange = () => render();
      await pc.setRemoteDescription(data.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: 'signal', data: { sdp: { type: answer.type, sdp: answer.sdp } } });
    } else if (data.candidate && pc) {
      await pc.addIceCandidate(data.candidate);
    }
  }

  function closePeer() {
    pc?.close();
    pc = null;
    video.srcObject = null;
    $('sound').disabled = true;
  }

  // ---- UI -------------------------------------------------------------------

  function render(override) {
    const conn = $('conn');
    const text = conn.lastElementChild;
    const live = pc?.connectionState === 'connected';
    if (override) { conn.className = 'badge'; text.textContent = override; }
    else if (live) { conn.className = 'badge ok'; text.textContent = `Live · ${phone.name}`; }
    else if (phone.connected) { conn.className = 'badge warn'; text.textContent = `Connecting to ${phone.name}…`; }
    else { conn.className = 'badge'; text.textContent = 'Waiting for phone'; }
    $('connect').hidden = !!phone.connected;
    video.classList.toggle('on', !!phone.connected);
  }

  // Resolution / fps readout.
  setInterval(async () => {
    if (!pc || pc.connectionState !== 'connected') { $('meta').textContent = ''; return; }
    const stats = await pc.getStats();
    for (const s of stats.values()) {
      if (s.type === 'inbound-rtp' && s.kind === 'video') {
        $('meta').textContent = `${s.frameWidth || 0}×${s.frameHeight || 0} · ${Math.round(s.framesPerSecond || 0)} fps`;
      }
    }
  }, 1000);

  async function loadInfo() {
    try {
      const info = await fetch('/info').then((r) => r.json());
      if (info.qr) $('qr').innerHTML = info.qr;
      $('addr').textContent = info.primary?.address || 'No network — connect to Wi-Fi';
      $('port').textContent = info.port;
      $('key').textContent = info.key;
      if (info.addresses.length > 1) {
        $('otherAddrs').hidden = false;
        $('addrList').replaceChildren(...info.addresses.slice(1).map((a) => {
          const li = document.createElement('li');
          li.textContent = `${a.address} (${a.name})`;
          return li;
        }));
      }
    } catch { /* server down; the socket retry shows that */ }
  }

  $('sound').addEventListener('click', () => {
    video.muted = !video.muted;
    $('sound').textContent = video.muted ? 'Sound off' : 'Sound on';
    $('sound').setAttribute('aria-pressed', String(!video.muted));
  });

  $('help').addEventListener('click', () => $('helpDialog').showModal());

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }
  $('fullscreen').addEventListener('click', toggleFullscreen);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'f' && !e.ctrlKey && !e.metaKey && !$('helpDialog').open) toggleFullscreen();
  });
  document.addEventListener('fullscreenchange', () => document.body.classList.toggle('fs', !!document.fullscreenElement));

  let idleTimer = 0;
  document.addEventListener('mousemove', () => {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.add('idle'), 2500);
  });

  loadInfo();
  render();
  connect();
})();
