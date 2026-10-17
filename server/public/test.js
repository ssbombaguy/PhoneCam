// PhoneCam — fake meeting page. Uses the camera like a video-call site would,
// and exposes window.__meetingTest so automated tests can read the results.

(() => {
  const $ = (id) => document.getElementById(id);
  const result = { devices: [], frames: 0, width: 0, height: 0, audioPeak: 0, label: '', error: null };
  window.__meetingTest = result;
  let stream = null;
  let audioCtx = null;

  $('ext').textContent = document.documentElement.dataset.phonecam === 'ready'
    ? 'Extension: active ✓'
    : 'Extension: not detected — install it and reload this page';

  async function listDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    result.devices = devices.map((d) => ({ kind: d.kind, id: d.deviceId, label: d.label }));
    const fill = (sel, kind) => {
      sel.replaceChildren(...devices.filter((d) => d.kind === kind)
        .map((d, i) => new Option(d.label || `${kind} ${i + 1}`, d.deviceId)));
      const pc = devices.find((d) => d.kind === kind && d.deviceId.startsWith('phonecam'));
      if (pc) sel.value = pc.deviceId;
    };
    fill($('cam'), 'videoinput');
    fill($('mic'), 'audioinput');
  }

  async function start() {
    stop();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: $('cam').value }, width: 1280, height: 720 },
        audio: { deviceId: { exact: $('mic').value } },
      });
    } catch (err) {
      result.error = `${err.name}: ${err.message}`;
      $('vinfo').textContent = result.error;
      return;
    }
    const video = stream.getVideoTracks()[0];
    result.label = video?.label || '';
    $('video').srcObject = stream;

    // Count rendered frames.
    const v = $('video');
    const onFrame = (_, meta) => {
      result.frames++;
      result.width = meta.width;
      result.height = meta.height;
      $('vinfo').textContent = `${result.label} · ${meta.width}×${meta.height} · ${result.frames} frames`;
      if (stream) v.requestVideoFrameCallback(onFrame);
    };
    v.requestVideoFrameCallback(onFrame);

    // Audio level meter.
    const audio = stream.getAudioTracks()[0];
    if (audio) {
      audioCtx = new AudioContext();
      const analyser = audioCtx.createAnalyser();
      audioCtx.createMediaStreamSource(new MediaStream([audio])).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const tick = () => {
        if (!audioCtx) return;
        analyser.getFloatTimeDomainData(buf);
        const peak = buf.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
        result.audioPeak = Math.max(result.audioPeak, peak);
        $('level').value = peak;
        $('ainfo').textContent = `${audio.label} · peak ${result.audioPeak.toFixed(2)}`;
        requestAnimationFrame(tick);
      };
      tick();
    }
  }

  function stop() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    audioCtx?.close();
    audioCtx = null;
  }

  $('start').addEventListener('click', start);
  $('stop').addEventListener('click', stop);
  window.__meetingStart = start;
  window.__meetingStop = stop;
  listDevices();
})();
