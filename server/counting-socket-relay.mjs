import { WebSocket, WebSocketServer } from 'ws';
import { TURN_FALLBACK_MS, participantIdSchema } from '../shared/counting-protocol.mjs';

export function attachCountingSocketRelay(server, room, allowedOrigins) {
  const socketServer = new WebSocketServer({ noServer: true, maxPayload: 2048 });
  const acceptParticipantSocket = (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== '/api/counting/socket') return;
    const participantId = participantIdSchema.safeParse(url.searchParams.get('participantId'));
    if (!allowedOrigins.includes(request.headers.origin) || !participantId.success) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    socketServer.handleUpgrade(request, socket, head, (browserSocket) => relayParticipantSocket(browserSocket, room, participantId.data));
  };
  server.on('upgrade', acceptParticipantSocket);
  return {
    close: () => new Promise((resolve) => {
      server.off('upgrade', acceptParticipantSocket);
      for (const socket of socketServer.clients) socket.close(1001, 'Server shutting down.');
      socketServer.close(resolve);
    }),
  };
}

function relayParticipantSocket(browserSocket, room, participantId) {
  let actorSocket;
  browserSocket.on('close', () => actorSocket?.close());
  browserSocket.on('error', () => actorSocket?.close());
  browserSocket.on('message', (data, binary) => {
    if (!actorSocket || binary) { browserSocket.close(1008, 'Wait for the actor to be ready and send text messages.'); return; }
    if (actorSocket.readyState === WebSocket.OPEN) actorSocket.send(data.toString());
  });
  void room.connect({ participantId }).then((connection) => {
    actorSocket = connection;
    if (browserSocket.readyState !== WebSocket.OPEN) { actorSocket.close(); return; }
    scheduleTurnFallback(actorSocket, participantId);
    actorSocket.addEventListener('message', (event) => {
      if (browserSocket.readyState === WebSocket.OPEN) browserSocket.send(event.data, { binary: false });
    });
    actorSocket.addEventListener('close', () => browserSocket.close(1011, 'Counting connection closed.'));
    actorSocket.addEventListener('error', () => browserSocket.close(1011, 'Counting connection failed.'));
  }).catch(() => {
    if (browserSocket.readyState === WebSocket.OPEN) {
      browserSocket.send(JSON.stringify({ type: 'error', message: 'Could not connect to the counting room. Start the actor runtime.' }));
      browserSocket.close(1011, 'Counting room unavailable.');
    }
  });
}

function scheduleTurnFallback(actorSocket, participantId) {
  let turnId = null;
  let timeout;
  const clear = () => {
    clearTimeout(timeout);
    turnId = null;
  };
  actorSocket.addEventListener('close', clear);
  actorSocket.addEventListener('message', ({ data }) => {
    let message;
    try { message = JSON.parse(String(data)); } catch { return; }
    if (message.type !== 'state_changed') return;
    const assigned = message.state.currentSpeakerId === participantId ? message.turnId : null;
    if (assigned === turnId) return;
    clear();
    turnId = assigned;
    if (!assigned) return;
    // Safety net only: the browser normally completes the turn when its audio playback stops.
    timeout = setTimeout(() => {
      if (actorSocket.readyState === WebSocket.OPEN) {
        actorSocket.send(JSON.stringify({ type: 'expire_turn', turnId: assigned }));
      }
    }, TURN_FALLBACK_MS);
  });
}
