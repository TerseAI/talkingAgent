# Talking Agent

Three voice agents share one counter. Each agent uses the normal OpenAI Realtime SDK loop with microphone input, spoken replies, interruptions, and tools. Counting starts only when you ask.

## Start the demo

From this folder, run the durable-object runtime in one terminal:

```sh
npm run counter
```

Then run the web app in a second terminal:

```sh
npm run dev
```

This serves all three addresses, connected to the same counter actor:

- http://localhost:3002 — Alice, Marin voice
- http://localhost:3003 — Bob, Cedar voice
- http://localhost:3004 — Charlie, Coral voice

Keep both terminals open. Restart both processes and start fresh conversations after updating. This version requires fresh actor state; use a new `COUNTING_ROOM_ID` when starting the web app if you have saved state from an older version. Stop all agents before resetting the count. The default web process serves all three ports; `PORT=3002 npm run dev` serves only that port, so separate web processes can also share the same actor.

Requires Node.js 22.19+, the built SDK at `../little-durable-objects/npm`, and these values in `.env`:

```dotenv
OPENAI_API_KEY=your_key
DURABLE_OBJECT_BINARY=/Users/thomaskaratzas/Desktop/Projects/little-durable-objects/target/debug/little-durable-objects
```

The key stays on the server. The browser receives a short-lived credential. The model is `gpt-realtime-2.1`. No weather or web-search tool is configured.

## Turn flow

1. The model calls `waitForTurn()`.
2. The tool opens a WebSocket, waits for the actor's ready message, and sends one turn request. Each connection records its pending request and waiting position in participant metadata. The tool's promise remains pending without polling or retries.
3. The actor assigns the stick and broadcasts the holder, number, and request ID to every participant. Only the tool matching both the holder and request ID resolves with the reserved number. The SDK returns that result to the model.
4. The agent speaks, then calls `done_speaking()` with no arguments. The tool sends completion over the same WebSocket, identifying its grant.
5. The DO verifies the holder, increments the count, assigns the next waiting agent in FIFO order, and broadcasts the updated turn to everyone. The next agent's tool resolves; the others keep waiting. After 100, the actor broadcasts `done` and all pending tools finish.

`src/counting-room.ts` stores only the next number and `currentSpeaker: Participant | null`. It selects the next currentSpeaker from connected participants with a waiting position. New positions are derived from those connections; there is no separate queue or sequence counter. Its handlers finish immediately, leaving the actor available for completion and disconnect calls. `src/counting-connection.ts` holds the browser tool's pending promise. `server/counting-socket-relay.mjs` relays each browser socket to the DO's native `connect()` API, keeping runtime credentials on the server. The web server makes no turn decisions and has no shared turn queue.

Ending or interrupting a session closes its counter socket. The actor's `onDisconnect` releases its stick without advancing, then selects from the remaining connected participants and broadcasts the next turn. Reset also travels over a WebSocket so the actor can clear waiting metadata directly and broadcast cancellation. HTTP only reads the counter state. Native connection metadata remains available while the actor hibernates; closed connections stop being eligible. An unexpected socket failure rejects a pending tool without reconnecting or retrying.

A completed tool call records the model's report, not verified audio playback. The prompt asks for silence while waiting; pending tools alone do not enforce model silence. No code scripts the words or forces tool choices.

## Following the demo

The runtime terminal logs `[counter]` queued requests, acquisitions, completion reports, and releases. Chrome's console shows named tool starts, arguments, and results. A tool start without a finish remains pending. Session suffixes distinguish duplicate tabs.

The counter display shows the **last observed state**. It refreshes on turn broadcasts while its counter socket is connected, after local tool actions, on tab focus, and with the Refresh button. No microphone audio or conversation transcripts are logged by the application.

## Verification

```sh
npm test
npm run build
npm run test:counter:live
```

The live test uses three web listeners with independent socket relays and a real isolated counter ID. It exercises the browser tool's waiting logic against native DO broadcasts and checks that 1–100 is granted exactly once across three clients. It does not call OpenAI or verify audible playback. The earlier native experiment remains in `mobile/`.
