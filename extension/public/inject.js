// PhoneCam — runs inside the meeting page (Google Meet etc.), in the page's own
// JavaScript world, so the page sees "PhoneCam" as a normal camera/microphone.
//
//   enumerateDevices()  -> real devices + "PhoneCam" + "PhoneCam Microphone"
//   getUserMedia()      -> for PhoneCam ids: tracks we generate ourselves; anything
//                          else goes to the real devices unchanged
//
// Video: frames from the phone's WebRTC track are copied into a
// MediaStreamTrackGenerator. While the phone isn't there, a "waiting" card is
// shown instead, so the meeting keeps the camera selected and the picture just
// switches to live when the phone connects.
// Audio: the phone's audio is routed through Web Audio into a destination track.
//
// Signaling goes page <-> bridge.js (postMessage) <-> background.js <-> local server.

(() => {
  'use strict';
  if (window.__phonecamInstalled) return;
  window.__phonecamInstalled = true;

  const MD = window.MediaDevices && window.MediaDevices.prototype;
  if (!MD || !window.MediaStreamTrackGenerator || !window.MediaStreamTrackProcessor) return;

  const VIDEO_ID = 'phonecam-video';
  const AUDIO_ID = 'phonecam-audio';
  const GROUP_ID = 'phonecam';
  const VIDEO_LABEL = 'PhoneCam';
  const AUDIO_LABEL = 'PhoneCam Microphone';
  const RELEASE_DELAY_MS = 3000;

  const origEnumerate = MD.enumerateDevices;
  const origGetUserMedia = MD.getUserMedia;

  // ---------------------------------------------------------------------------
  // Status (shown on the placeholder card)
  // ---------------------------------------------------------------------------

  const state = {
    server: null,      // true / false / null (unknown yet)
    phone: false,
    phoneName: '',
    streaming: false,
  };

  function statusText() {
    if (state.server === false) return ['PhoneCam server is not running', 'Start it on this PC (start.bat)'];
    if (state.server === null) return ['Connecting to PhoneCam…', ''];
    if (!state.phone) return ['Waiting for your phone', 'Open the PhoneCam app and tap Start'];
    return [`Connecting to ${state.phoneName || 'phone'}…`, ''];
  }

  // ---------------------------------------------------------------------------
  // Bridge to the extension
  // ---------------------------------------------------------------------------

  function post(msg) {
    window.postMessage({ __phonecam: 'page', msg }, location.origin);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__phonecam !== 'ext') return;
    link.handle(e.data.msg);
  });

  // ---------------------------------------------------------------------------
  // WebRTC link to the phone
  // ---------------------------------------------------------------------------

  const link = {
    watching: false,
    pc: null,
    queue: Promise.resolve(),
    releaseTimer: 0,
    retryTimer: 0,

    want() {
      clearTimeout(this.releaseTimer);
      if (this.watching) return;
      this.watching = true;
      post({ type: 'watch' });
    },

    release() {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = setTimeout(() => {
        if (outputCount() > 0 || !this.watching) return;
        this.watching = false;
        post({ type: 'unwatch' });
        this.closePeer();
      }, RELEASE_DELAY_MS);
    },

    closePeer() {
      if (this.pc) {
        this.pc.ontrack = this.pc.onicecandidate = this.pc.onconnectionstatechange = null;
        this.pc.close();
        this.pc = null;
      }
      clearRemoteVideo();
      clearRemoteAudio();
      state.streaming = false;
    },

    // Ask the phone for a fresh offer (after a failed connection).
    restart() {
      this.closePeer();
      if (!this.watching) return;
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        if (!this.watching) return;
        post({ type: 'unwatch' });
        post({ type: 'watch' });
      }, 1500);
    },

    handle(msg) {
      switch (msg.type) {
        case 'server':
          state.server = msg.connected;
          if (!msg.connected) { state.phone = false; this.closePeer(); }
          else if (this.watching) post({ type: 'watch' }); // new server session — ask again
          break;
        case 'bridge-down':
          state.server = null;
          this.closePeer();
          if (this.watching) setTimeout(() => this.watching && post({ type: 'watch' }), 1000);
          break;
        case 'phone':
          state.server = true;
          state.phone = !!msg.connected;
          state.phoneName = msg.name || '';
          if (!msg.connected) this.closePeer();
          break;
        case 'signal':
          // Process in order: candidates must not overtake their offer.
          this.queue = this.queue.then(() => this.onSignal(msg.data)).catch((err) => {
            console.warn('[PhoneCam] signaling error', err);
            this.restart();
          });
          break;
      }
    },

    async onSignal(data) {
      if (!data || !this.watching) return;
      if (data.sdp && data.sdp.type === 'offer') {
        this.closePeer();
        const pc = new RTCPeerConnection({ iceServers: [] });
        this.pc = pc;
        pc.onicecandidate = (e) => {
          if (e.candidate) post({ type: 'signal', data: { candidate: e.candidate.toJSON() } });
        };
        pc.ontrack = (e) => {
          minimizeDelay(e.receiver);
          if (e.track.kind === 'video') setRemoteVideo(e.track);
          if (e.track.kind === 'audio') setRemoteAudio(e.track);
        };
        pc.onconnectionstatechange = () => {
          if (this.pc !== pc) return;
          state.streaming = pc.connectionState === 'connected';
          if (pc.connectionState === 'failed') this.restart();
        };
        await pc.setRemoteDescription(data.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        post({ type: 'signal', data: { sdp: { type: answer.type, sdp: answer.sdp } } });
      } else if (data.candidate && this.pc) {
        await this.pc.addIceCandidate(data.candidate);
      }
    },
  };

  // A live camera wants the smallest possible receive buffer; Chrome otherwise
  // grows it to smooth out Wi-Fi jitter, which shows up as delay.
  function minimizeDelay(receiver) {
    try { receiver.jitterBufferTarget = 0; } catch { /* older Chrome */ }
    try { receiver.playoutDelayHint = 0; } catch { /* not supported */ }
  }

  // ---------------------------------------------------------------------------
  // Output tracks handed to the page
  // ---------------------------------------------------------------------------

  const videoOutputs = new Set(); // { writer, tracks: [], busy }
  const audioOutputs = new Set(); // { tracks: [] }
  const lastSize = { width: 1280, height: 720 };

  function isAlive(out) {
    return out.tracks.some((t) => t.readyState === 'live');
  }

  function outputCount() {
    for (const out of [...videoOutputs, ...audioOutputs]) {
      if (!isAlive(out)) {
        videoOutputs.delete(out);
        audioOutputs.delete(out);
      }
    }
    return videoOutputs.size + audioOutputs.size;
  }

  function outputsChanged() {
    if (outputCount() > 0) link.want();
    else link.release();
    if (videoOutputs.size && !remoteVideo) startPlaceholder();
    if (!videoOutputs.size) stopPlaceholder();
  }

  // Tracks ended by the page (camera turned off) — check regularly, because
  // a stopped track doesn't fire any event.
  setInterval(() => { if (videoOutputs.size || audioOutputs.size) outputsChanged(); }, 1000);

  function capabilities(kind) {
    return kind === 'video'
      ? {
          deviceId: VIDEO_ID, groupId: GROUP_ID,
          width: { min: 1, max: 1920 }, height: { min: 1, max: 1080 },
          frameRate: { min: 1, max: 30 }, aspectRatio: { min: 0.5, max: 2 },
          facingMode: [], resizeMode: ['none'],
        }
      : {
          deviceId: AUDIO_ID, groupId: GROUP_ID,
          echoCancellation: [true, false], autoGainControl: [true, false], noiseSuppression: [true, false],
          channelCount: { min: 1, max: 1 }, sampleRate: { min: 48000, max: 48000 },
        };
  }

  // Make our tracks report the PhoneCam device, like a real camera track would.
  function decorate(track, out, kind) {
    const origStop = track.stop;
    const origClone = track.clone;
    const origSettings = track.getSettings;
    Object.defineProperties(track, {
      label: { get: () => (kind === 'video' ? VIDEO_LABEL : AUDIO_LABEL), configurable: true },
      getSettings: {
        configurable: true,
        value: () => {
          const base = origSettings.call(track) || {};
          return kind === 'video'
            ? { ...base, deviceId: VIDEO_ID, groupId: GROUP_ID, width: lastSize.width, height: lastSize.height,
                frameRate: 30, aspectRatio: lastSize.width / lastSize.height, resizeMode: 'none' }
            : { ...base, deviceId: AUDIO_ID, groupId: GROUP_ID, channelCount: 1, sampleRate: 48000,
                echoCancellation: true, autoGainControl: true, noiseSuppression: true };
        },
      },
      getCapabilities: { configurable: true, value: () => capabilities(kind) },
      applyConstraints: { configurable: true, value: () => Promise.resolve() },
      stop: {
        configurable: true,
        value: () => {
          origStop.call(track);
          setTimeout(outputsChanged, 0);
        },
      },
      clone: {
        configurable: true,
        value: () => {
          const copy = origClone.call(track);
          decorate(copy, out, kind);
          out.tracks.push(copy);
          return copy;
        },
      },
    });
    return track;
  }

  function createVideoTrack() {
    const gen = new MediaStreamTrackGenerator({ kind: 'video' });
    const out = { writer: gen.writable.getWriter(), tracks: [gen], busy: false };
    decorate(gen, out, 'video');
    videoOutputs.add(out);
    outputsChanged();
    // Give the page a first frame right away.
    if (!remoteVideo) drawPlaceholder();
    return gen;
  }

  function deliverVideo(frame) {
    lastSize.width = frame.displayWidth;
    lastSize.height = frame.displayHeight;
    for (const out of videoOutputs) {
      if (out.busy) continue; // page is behind — drop rather than add delay
      out.busy = true;
      const copy = frame.clone();
      out.writer.write(copy).then(
        () => { out.busy = false; },
        () => { try { copy.close(); } catch { /* already closed */ } videoOutputs.delete(out); },
      );
    }
    frame.close();
  }

  // ---- Remote (phone) video -------------------------------------------------

  let remoteVideo = null; // { track, reader }

  function setRemoteVideo(track) {
    clearRemoteVideo();
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    const current = { track, reader };
    remoteVideo = current;
    stopPlaceholder();
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done || remoteVideo !== current) { value?.close(); break; }
          if (videoOutputs.size) deliverVideo(value);
          else value.close();
        }
      } catch { /* track ended */ }
      if (remoteVideo === current) {
        remoteVideo = null;
        if (videoOutputs.size) startPlaceholder();
      }
    })();
  }

  function clearRemoteVideo() {
    if (!remoteVideo) return;
    const { reader } = remoteVideo;
    remoteVideo = null;
    reader.cancel().catch(() => {});
    if (videoOutputs.size) startPlaceholder();
  }

  // ---- Placeholder card -----------------------------------------------------

  let placeholderTimer = 0;
  let canvas = null;

  function startPlaceholder() {
    if (placeholderTimer) return;
    placeholderTimer = setInterval(drawPlaceholder, 100);
  }

  function stopPlaceholder() {
    clearInterval(placeholderTimer);
    placeholderTimer = 0;
  }

  function drawPlaceholder() {
    if (!videoOutputs.size) return;
    const W = 1280;
    const H = 720;
    if (!canvas) canvas = new OffscreenCanvas(W, H);
    const g = canvas.getContext('2d');
    const t = performance.now() / 1000;

    g.fillStyle = '#0d0f12';
    g.fillRect(0, 0, W, H);

    // Camera icon with a soft pulse
    const pulse = 0.55 + 0.45 * Math.abs(Math.sin(t * 1.6));
    g.save();
    g.translate(W / 2, H / 2 - 70);
    g.globalAlpha = pulse;
    g.fillStyle = '#3ddc97';
    roundRect(g, -70, -45, 140, 95, 18);
    g.fill();
    g.fillRect(-28, -60, 56, 20);
    g.fillStyle = '#0d0f12';
    g.beginPath();
    g.arc(0, 2, 28, 0, Math.PI * 2);
    g.fill();
    g.restore();

    const [title, sub] = statusText();
    g.textAlign = 'center';
    g.fillStyle = '#e9ecf1';
    g.font = '600 44px system-ui, "Segoe UI", sans-serif';
    g.fillText(title, W / 2, H / 2 + 70);
    if (sub) {
      g.fillStyle = '#8b93a1';
      g.font = '30px system-ui, "Segoe UI", sans-serif';
      g.fillText(sub, W / 2, H / 2 + 120);
    }

    lastSize.width = W;
    lastSize.height = H;
    deliverVideo(new VideoFrame(canvas, { timestamp: Math.round(performance.now() * 1000) }));
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  // ---- Audio ----------------------------------------------------------------

  let audioCtx = null;
  let audioDest = null;
  let remoteAudio = null; // { source, sink }

  function ensureAudio() {
    if (audioCtx) return;
    audioCtx = new AudioContext({ sampleRate: 48000 });
    audioDest = audioCtx.createMediaStreamDestination();
    // Browsers start audio suspended until the user interacts with the page.
    const resume = () => { if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {}); };
    for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, resume, true);
    resume();
  }

  function createAudioTrack() {
    ensureAudio();
    const track = audioDest.stream.getAudioTracks()[0].clone();
    const out = { tracks: [track] };
    decorate(track, out, 'audio');
    audioOutputs.add(out);
    outputsChanged();
    return track;
  }

  function setRemoteAudio(track) {
    ensureAudio();
    clearRemoteAudio();
    const stream = new MediaStream([track]);
    // Chrome only pulls remote WebRTC audio into Web Audio if a media element
    // is also playing it.
    const sink = new Audio();
    sink.muted = true;
    sink.srcObject = stream;
    sink.play().catch(() => {});
    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(audioDest);
    remoteAudio = { source, sink };
  }

  function clearRemoteAudio() {
    if (!remoteAudio) return;
    remoteAudio.source.disconnect();
    remoteAudio.sink.srcObject = null;
    remoteAudio = null;
  }

  // ---------------------------------------------------------------------------
  // MediaDevices patches
  // ---------------------------------------------------------------------------

  function fakeDevice(kind, deviceId, label) {
    const Proto = window.InputDeviceInfo || window.MediaDeviceInfo;
    const info = { deviceId, kind, label, groupId: GROUP_ID };
    const d = Object.create(Proto.prototype);
    for (const [k, v] of Object.entries(info)) Object.defineProperty(d, k, { value: v, enumerable: true });
    Object.defineProperty(d, 'toJSON', { value: () => ({ ...info }) });
    Object.defineProperty(d, 'getCapabilities', { value: () => capabilities(kind === 'videoinput' ? 'video' : 'audio') });
    return d;
  }

  const fakeVideoDevice = fakeDevice('videoinput', VIDEO_ID, VIDEO_LABEL);
  const fakeAudioDevice = fakeDevice('audioinput', AUDIO_ID, AUDIO_LABEL);

  function idMatches(value, id) {
    if (value == null) return false;
    if (typeof value === 'string') return value === id;
    if (Array.isArray(value)) return value.includes(id);
    if (typeof value === 'object') return idMatches(value.exact, id) || idMatches(value.ideal, id);
    return false;
  }

  function wants(constraint, id) {
    if (!constraint || typeof constraint !== 'object') return false;
    if (idMatches(constraint.deviceId, id)) return true;
    return Array.isArray(constraint.advanced) && constraint.advanced.some((a) => idMatches(a && a.deviceId, id));
  }

  MD.enumerateDevices = async function enumerateDevices() {
    const devices = await origEnumerate.call(this);
    return [...devices, fakeVideoDevice, fakeAudioDevice];
  };

  MD.getUserMedia = async function getUserMedia(constraints) {
    const c = constraints || {};
    const wantVideo = wants(c.video, VIDEO_ID);
    const wantAudio = wants(c.audio, AUDIO_ID);
    if (!wantVideo && !wantAudio) return origGetUserMedia.call(this, constraints);

    const tracks = [];
    const real = {};
    if (c.video && !wantVideo) real.video = c.video;
    if (c.audio && !wantAudio) real.audio = c.audio;
    if (real.video || real.audio) tracks.push(...(await origGetUserMedia.call(this, real)).getTracks());
    if (wantVideo) tracks.push(createVideoTrack());
    if (wantAudio) tracks.push(createAudioTrack());
    return new MediaStream(tracks);
  };

  // Let the page and our test page know we're here.
  if (document.documentElement) document.documentElement.dataset.phonecam = 'ready';
  post({ type: 'hello' });
})();
