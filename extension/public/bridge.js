// PhoneCam — content script in the extension's isolated world.
// Relays messages between inject.js (in the page) and background.js, which
// holds the connection to the local PhoneCam server.

(() => {
  let port = null;

  function toPage(msg) {
    window.postMessage({ __phonecam: 'ext', msg }, location.origin);
  }

  function connect() {
    try {
      port = chrome.runtime.connect({ name: 'phonecam' });
    } catch {
      // Extension was reloaded or removed; this page needs a refresh.
      port = null;
      return null;
    }
    port.onMessage.addListener(toPage);
    port.onDisconnect.addListener(() => {
      port = null;
      toPage({ type: 'bridge-down' });
    });
    return port;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__phonecam !== 'page') return;
    const p = port || connect();
    if (p && e.data.msg?.type !== 'hello') p.postMessage(e.data.msg);
  });
})();
