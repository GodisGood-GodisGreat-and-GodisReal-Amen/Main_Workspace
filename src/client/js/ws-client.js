// WebSocket client with auto-reconnect. Message type strings mirror
// src/server/protocol.js — that file is the source of truth.

export function createWsClient({ role, token, device, onMessage, onOpen, onClose }) {
  let ws = null;
  let closedByUs = false;
  let retryMs = 800;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.addEventListener('open', () => {
      retryMs = 800;
      ws.send(JSON.stringify({ type: 'hello', role, token, device }));
      if (onOpen) onOpen();
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      onMessage(msg);
    });
    ws.addEventListener('close', (ev) => {
      if (onClose) onClose(ev);
      if (closedByUs || ev.code === 4001) return;
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 1.6, 8000);
    });
    ws.addEventListener('error', () => ws.close());
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  function stop() {
    closedByUs = true;
    if (ws) ws.close();
  }

  connect();
  return { send, stop };
}
