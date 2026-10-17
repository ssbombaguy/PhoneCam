// PhoneCam — background service worker.
// Each meeting tab gets its own WebSocket to the local PhoneCam server. Doing
// this here (instead of in the page) avoids the page's security rules blocking
// connections to localhost.

const DEFAULT_PORT = 8080;

async function serverPort() {
  const { port } = await chrome.storage.local.get('port');
  return Number(port) || DEFAULT_PORT;
}

chrome.runtime.onConnect.addListener((tabPort) => {
  if (tabPort.name !== 'phonecam') return;

  let ws = null;
  let closed = false;
  let retryTimer = 0;
  let retryDelay = 1000;
  const pending = [];

  function toTab(msg) {
    if (!closed) tabPort.postMessage(msg);
  }

  async function open() {
    if (closed) return;
    const port = await serverPort();
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=viewer`);
    } catch {
      return scheduleRetry();
    }
    ws.onopen = () => {
      retryDelay = 1000;
      toTab({ type: 'server', connected: true });
      while (pending.length) ws.send(JSON.stringify(pending.shift()));
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type !== 'ping') toTab(msg);
    };
    ws.onclose = () => {
      ws = null;
      toTab({ type: 'server', connected: false });
      scheduleRetry();
    };
  }

  function scheduleRetry() {
    if (closed) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 5000);
  }

  tabPort.onMessage.addListener((msg) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else if (msg.type === 'watch' || msg.type === 'unwatch') {
      // Only intent matters while disconnected; signals are stale by then.
      pending.length = 0;
      pending.push(msg);
    }
  });

  tabPort.onDisconnect.addListener(() => {
    closed = true;
    clearTimeout(retryTimer);
    ws?.close();
  });

  open();
});
