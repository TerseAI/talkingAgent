export async function counterEvents(counter, clientId, req, res) {
  let socket;
  let closed = false;
  const close = () => { closed = true; socket?.close(); };
  res.on('close', close);
  try {
    socket = await counter.connect({ clientId });
    if (closed) { socket.close(); return; }
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const pulse = () => { if (!closed) res.write('event: turn\ndata: {}\n\n'); };
    socket.addEventListener('message', ({ data }) => {
      try {
        if (JSON.parse(String(data)).type === 'turn_available') pulse();
      } catch { /* Ignore messages unrelated to counter releases. */ }
    });
    socket.addEventListener('close', () => res.end());
    socket.addEventListener('error', () => res.end());
    // Reconcile after connecting so a release during reconnection is not lost.
    const state = await counter.getState();
    if (closed) return;
    res.write('event: ready\ndata: {}\n\n');
    if (state.talkingStick === clientId || state.done) pulse();
  } catch {
    socket?.close();
    if (!closed) {
      if (!res.headersSent) res.status(503);
      res.end();
    }
  }
}
