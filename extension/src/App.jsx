import { useEffect, useState } from 'react';

const DEFAULT_PORT = 8080;
const hasChrome = typeof chrome !== 'undefined' && chrome.storage;

function useServerPort() {
  const [port, setPort] = useState(DEFAULT_PORT);
  useEffect(() => {
    if (!hasChrome) return;
    chrome.storage.local.get('port').then(({ port: p }) => p && setPort(Number(p)));
  }, []);
  const save = (p) => {
    setPort(p);
    if (hasChrome) chrome.storage.local.set({ port: p });
  };
  return [port, save];
}

// Polls the local server. status: null = loading, false = server not running.
function useServer(port) {
  const [status, setStatus] = useState(null);
  const [info, setInfo] = useState(null);

  useEffect(() => {
    let alive = true;
    let timer;
    const base = `http://127.0.0.1:${port}`;

    async function poll() {
      try {
        const s = await fetch(`${base}/status`, { cache: 'no-store' }).then((r) => r.json());
        if (!alive) return;
        setStatus(s);
        if (!s.phone.connected) {
          const i = await fetch(`${base}/info`, { cache: 'no-store' }).then((r) => r.json());
          if (alive) setInfo(i);
        }
      } catch {
        if (alive) setStatus(false);
      }
      if (alive) timer = setTimeout(poll, 1500);
    }

    poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [port]);

  return { status, info };
}

export default function App() {
  const [port, setPort] = useServerPort();
  const { status, info } = useServer(port);
  const [showSettings, setShowSettings] = useState(false);

  const phone = status && status.phone;
  const overall = status === null ? 'loading' : status === false ? 'off' : phone.connected ? 'live' : 'waiting';

  return (
    <main className="popup">
      <header className="head">
        <img src="icons/icon32.png" alt="" width="24" height="24" />
        <h1>PhoneCam</h1>
        <span className={`dot ${overall}`} title={overall} />
      </header>

      {overall === 'loading' && <p className="muted">Checking…</p>}

      {overall === 'off' && (
        <section className="card warn">
          <h2>Server isn't running</h2>
          <p>
            On this PC, double-click <b>start.bat</b> in the PhoneCam folder. Keep that window open while you use your
            phone camera.
          </p>
        </section>
      )}

      {overall === 'waiting' && (
        <section className="card">
          <h2>Connect your phone</h2>
          <p className="muted">Open the PhoneCam app → <b>Scan QR</b>. Phone and PC must be on the same Wi-Fi.</p>
          {info?.qr ? (
            <div className="qr" dangerouslySetInnerHTML={{ __html: info.qr }} />
          ) : (
            <p className="muted">No network found. Connect this PC to Wi-Fi.</p>
          )}
          {info?.primary && (
            <dl className="manual">
              <dt>Address</dt><dd>{info.primary.address}</dd>
              <dt>Port</dt><dd>{info.port}</dd>
              <dt>Key</dt><dd>{info.key}</dd>
            </dl>
          )}
        </section>
      )}

      {overall === 'live' && (
        <section className="card ok">
          <h2>{phone.name} is connected</h2>
          <p className="muted">
            {status.watching > 0 ? `Streaming to ${status.watching} tab${status.watching === 1 ? '' : 's'}` : 'Ready — pick PhoneCam in your meeting'}
          </p>
        </section>
      )}

      <section className="card">
        <h2>In Google Meet</h2>
        <ol>
          <li>Click <b>⋮ → Settings → Video</b>.</li>
          <li>Camera: choose <b>PhoneCam</b>.</li>
          <li>Optional — Audio → Microphone: <b>PhoneCam Microphone</b>.</li>
        </ol>
        <p className="muted small">Already in a call when you installed this? Reload the Meet tab once.</p>
      </section>

      <footer className="foot">
        <button
          type="button"
          onClick={() => (hasChrome ? chrome.tabs.create({ url: `http://localhost:${port}/` }) : window.open(`http://localhost:${port}/`))}
          disabled={!status}
        >
          Open preview
        </button>
        <button type="button" className="link" onClick={() => setShowSettings((v) => !v)}>
          Settings
        </button>
      </footer>

      {showSettings && (
        <section className="card">
          <label className="field">
            Server port
            <input
              type="number"
              min="1"
              max="65535"
              value={port}
              onChange={(e) => {
                const p = Number(e.target.value);
                if (p > 0 && p < 65536) setPort(p);
              }}
            />
          </label>
          <p className="muted small">Only change this if you started the server with a different PORT.</p>
        </section>
      )}
    </main>
  );
}
