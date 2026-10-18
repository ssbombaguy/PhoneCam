// End-to-end test: real Chrome + the PhoneCam extension + the fake phone page
// + the fake meeting page. Requires the server to be running (npm start in server/).
//
//   node run.js            run headless
//   node run.js --show     watch it happen

const path = require('path');
const puppeteer = require('puppeteer');

const BASE = 'http://localhost:8080';
const EXT = path.resolve(__dirname, '..', 'extension', 'dist');
const SHOTS = path.join(__dirname, 'screenshots');
const show = process.argv.includes('--show');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

async function status() {
  return fetch(`${BASE}/status`).then((r) => r.json());
}

(async () => {
  require('fs').mkdirSync(SHOTS, { recursive: true });
  const browser = await puppeteer.launch({
    headless: !show,
    enableExtensions: [EXT],
    // Fake devices + auto-accept the camera prompt (PhoneCam now asks for the
    // same permission as a real webcam).
    args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    defaultViewport: { width: 1100, height: 800 },
  });

  try {
    // 1. Meeting page, before any phone exists: extension + placeholder.
    const meet = await browser.newPage();
    meet.on('console', (m) => m.type() === 'warn' && console.log('  [meet]', m.text()));
    await meet.goto(`${BASE}/test.html`);
    await meet.waitForFunction(() => window.__meetingTest?.devices.length > 0, { timeout: 10000 });

    const ready = await meet.evaluate(() => document.documentElement.dataset.phonecam);
    check('extension injected into page', ready === 'ready');

    const devices = await meet.evaluate(() => window.__meetingTest.devices);
    check('PhoneCam listed as camera', devices.some((d) => d.kind === 'videoinput' && d.id === 'phonecam-video' && d.label === 'PhoneCam'));
    check('PhoneCam Microphone listed', devices.some((d) => d.kind === 'audioinput' && d.id === 'phonecam-audio'));

    await meet.evaluate(() => window.__meetingStart());
    await sleep(2000);
    let r = await meet.evaluate(() => ({ ...window.__meetingTest }));
    check('getUserMedia succeeded', !r.error, r.error || '');
    check('track label is PhoneCam', r.label === 'PhoneCam', r.label);
    check('placeholder frames while no phone', r.frames > 5, `${r.frames} frames`);
    await meet.screenshot({ path: path.join(SHOTS, '1-waiting.png') });

    // 2. Fake phone connects — picture should switch to live.
    const phone = await browser.newPage();
    await phone.goto(`${BASE}/test-phone.html`);
    await meet.bringToFront();
    const t0 = Date.now();
    let connected = 0;
    while (Date.now() - t0 < 10000) {
      connected = await phone.evaluate(() => window.__testPhone?.connected || 0);
      if (connected) break;
      await sleep(250);
    }
    check('phone -> meeting WebRTC connected', connected === 1, `${Date.now() - t0} ms`);

    const before = (await meet.evaluate(() => window.__meetingTest.frames));
    await sleep(3000);
    r = await meet.evaluate(() => ({ ...window.__meetingTest }));
    const fps = (r.frames - before) / 3;
    check('live video flowing', fps > 10, `${fps.toFixed(1)} fps, ${r.width}x${r.height}`);
    check('phone audio reaches meeting mic', r.audioPeak > 0.05, `peak ${r.audioPeak.toFixed(2)}`);
    await meet.screenshot({ path: path.join(SHOTS, '2-live.png') });

    let s = await status();
    check('server sees phone + 1 watcher', s.phone.connected && s.watching === 1, JSON.stringify(s));

    // 3. Meeting turns the camera off — stream should be released.
    await meet.evaluate(() => window.__meetingStop());
    await sleep(4500);
    s = await status();
    check('camera released after stop', s.watching === 0, `watching=${s.watching}`);
    const phonePeers = await phone.evaluate(() => window.__testPhone?.peers);
    check('phone closed the connection', phonePeers === 0, `peers=${phonePeers}`);

    // 4. Camera on again — reconnects.
    await meet.evaluate(() => { window.__meetingTest.frames = 0; window.__meetingStart(); });
    await sleep(4000);
    r = await meet.evaluate(() => ({ ...window.__meetingTest }));
    s = await status();
    check('camera restarts', s.watching === 1 && r.frames > 20, `frames=${r.frames}`);

    // 5. Phone goes away mid-call — placeholder comes back, track stays alive.
    await phone.close();
    await sleep(2500);
    const f1 = await meet.evaluate(() => window.__meetingTest.frames);
    await sleep(1500);
    const f2 = await meet.evaluate(() => window.__meetingTest.frames);
    check('placeholder resumes when phone leaves', f2 > f1, `${f2 - f1} frames in 1.5s`);
    await meet.screenshot({ path: path.join(SHOTS, '3-phone-left.png') });

    // 6. Site without camera permission must not get PhoneCam either.
    await meet.evaluate(() => window.__meetingStop());
    const cdp = await meet.createCDPSession();
    await cdp.send('Browser.setPermission', { origin: BASE, permission: { name: 'camera' }, setting: 'denied' });
    const denied = await meet.evaluate(() => navigator.mediaDevices
      .getUserMedia({ video: { deviceId: { exact: 'phonecam-video' } } })
      .then((s) => { s.getTracks().forEach((t) => t.stop()); return 'GRANTED'; }, (e) => e.name));
    check('PhoneCam respects a denied camera permission', denied === 'NotAllowedError', denied);
  } catch (err) {
    console.error(err);
    failures++;
  } finally {
    await browser.close();
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
