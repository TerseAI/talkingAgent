import { WebSocket, WebSocketServer } from 'ws';
import { participantIdSchema } from '../shared/counting-protocol.mjs';

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
