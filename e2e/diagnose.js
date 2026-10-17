// Diagnoses the phone -> browser video connection with the REAL phone.
// Start the server, connect the phone app, then: node diagnose.js
// Prints the offer from the phone, every ICE candidate in both directions and
// the connection states, so you can see exactly where it stops.

const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', (m) => console.log(m.text()));
  await page.goto('http://localhost:8080/test.css'); // any localhost page, for the origin
  await page.evaluate(() => new Promise((resolve) => {
    const log = (...a) => console.log(`[${(performance.now() / 1000).toFixed(1)}s]`, ...a);
    const ws = new WebSocket(`ws://${location.host}/ws?role=viewer`);
    let pc = null;
    const send = (m) => ws.send(JSON.stringify(m));
    ws.onopen = () => { log('server connected, asking for video'); send({ type: 'watch' }); };
    ws.onmessage = async (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'ping') return;
      if (msg.type === 'phone') return log('phone state:', JSON.stringify(msg));
      if (msg.type !== 'signal') return log('other:', e.data);
      const d = msg.data;
      if (d.sdp) {
        log('OFFER from phone; media lines:', d.sdp.sdp.split('\r\n').filter((l) => l.startsWith('m=')).join(' | '));
        pc = new RTCPeerConnection({ iceServers: [] });
        pc.onicecandidate = (ev) => {
          if (ev.candidate) { log('browser candidate ->', ev.candidate.candidate); send({ type: 'signal', data: { candidate: ev.candidate.toJSON() } }); }
        };
        pc.oniceconnectionstatechange = () => log('ICE state:', pc.iceConnectionState);
        pc.onconnectionstatechange = () => {
          log('connection state:', pc.connectionState);
          if (pc.connectionState === 'connected') setTimeout(async () => {
            // Where does the delay come from? (averages over the stream so far)
            const stats = await pc.getStats();
            for (const s of stats.values()) {
              if (s.type === 'inbound-rtp') {
                const jb = s.jitterBufferEmittedCount ? (1000 * s.jitterBufferDelay / s.jitterBufferEmittedCount).toFixed(0) : '?';
                const dec = s.framesDecoded ? (1000 * s.totalDecodeTime / s.framesDecoded).toFixed(0) : '-';
                const codec = s.codecId && stats.get(s.codecId)?.mimeType;
                log(`${s.kind}: codec ${codec || '?'}, jitter buffer ${jb} ms, decode ${dec} ms, fps ${s.framesPerSecond ?? '-'}, ${s.frameWidth ?? ''}x${s.frameHeight ?? ''}, lost ${s.packetsLost}`);
              }
              if (s.type === 'candidate-pair' && s.nominated) log(`network round trip ${(1000 * (s.currentRoundTripTime || 0)).toFixed(0)} ms, available bitrate ${Math.round((s.availableIncomingBitrate || 0) / 1000)} kb/s`);
            }
            resolve();
          }, 8000);
        };
        pc.ontrack = (ev) => {
          try { ev.receiver.jitterBufferTarget = 0; } catch { /* older Chrome */ }
          log('TRACK received:', ev.track.kind);
        };
        await pc.setRemoteDescription(d.sdp);
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        send({ type: 'signal', data: { sdp: { type: ans.type, sdp: ans.sdp } } });
        log('answer sent');
      } else if (d.candidate) {
        log('phone candidate <-', d.candidate.candidate);
        try { await pc.addIceCandidate(d.candidate); } catch (err) { log('addIceCandidate failed:', err.message); }
      }
    };
    setTimeout(async () => {
      if (pc) {
        const stats = await pc.getStats();
        for (const s of stats.values()) {
          if (s.type === 'candidate-pair') log('pair', s.state, 'nominated=' + s.nominated, 'sent=' + s.requestsSent, 'recv=' + s.responsesReceived);
        }
      }
      resolve();
    }, 15000);
  }));
  await browser.close();
})();
