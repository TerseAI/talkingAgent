# Talking Agent

Three live voice agents take turns counting to 100. Each uses the OpenAI Realtime SDK for microphone input, spoken replies, interruptions, and tools. Counting starts when you ask one of them; the shared room then cues each agent's number into its live session.

## Run the app

Start the actor runtime:

```sh
npm run actors
```

Start the web app in another terminal:

```sh
npm run dev
```

The web app serves three participants connected to the same `CountingRoom`:

- http://localhost:3002 — Alice, Marin voice
- http://localhost:3003 — Bob, Cedar voice
- http://localhost:3004 — Charlie, Coral voice

On macOS, `pnpm run dev` automatically opens each participant in a separate Chrome window once all servers are ready. Use `OPEN_BROWSER=false pnpm run dev` to skip opening windows. Production startup does not open a browser.

Restart both processes and start fresh browser conversations after updating. Leave `PORT` unset in your shell and `.env` to serve all three participants. `PORT=3002 npm run dev` serves one port. Separate web processes can share a room; set `COUNTING_ROOM_ID` to choose a different room. The actor's name and room ID form its persistent identity. The runtime restores only the fields present in a saved snapshot, so after adding a field to `CountingRoom` either bump the default room ID or write the code to tolerate an undefined field.

Requires Node.js 22.19+, the built SDK at `../little-durable-objects/npm`, and these values in `.env`:

```dotenv
OPENAI_API_KEY=your_key
DURABLE_OBJECT_BINARY=/absolute/path/to/little-durable-objects
```

The OpenAI key stays on the server; the browser receives a short-lived credential. The model is `gpt-realtime-2.1`. Runtime data is stored in `.counter-data`.

## Responsibilities

| Name | Responsibility | Implementation |
| --- | --- | --- |
| `CountingRoom` | Owns the shared count, rotates the speaker round-robin over connected participants, and broadcasts every change. | [counting-room.ts](src/counting-room.ts) |
| `Participant` | One connected agent and its join order. Lives in native socket metadata. | [counting-room.ts](src/counting-room.ts) |
| `CountingConnection` | One browser's link to the room: sends commands, resolves acknowledgments, relays state broadcasts, reconnects while the session lives. | [counting-connection.ts](src/counting-connection.ts) |
| `CountingTurnDriver` | Cues the model when the room assigns this participant a number, reports the turn complete when playback stops, closes the mic while others count, and pauses the room when the user starts talking to the speaker. | [counting-turns.ts](src/counting-turns.ts) |
| `createCountingTools` | Exposes `start_counting` and `pause_counting`: the only counting decisions left to the model. | [counting-tools.ts](src/counting-tools.ts) |
| `attachCountingSocketRelay` | Forwards socket messages and expires a turn that never reports completion. Keeps runtime credentials on the server. | [counting-socket-relay.mjs](server/counting-socket-relay.mjs) |
| `CountingProgress` | Displays the last observed count and provides reset. | [CountingProgress.tsx](src/CountingProgress.tsx) |
| `CountingSnapshot` | Read-only view of the count, speaker, and counting flag, fetched for the display or included in broadcasts. | [counting-api.ts](src/counting-api.ts) |

```text
start_counting / pause_counting (model) -> CountingConnection -> relay -> CountingRoom
                                                 ^                          |
CountingTurnDriver <-- state_changed broadcasts --+--------------------------+
   | response.create "say 7"        ^
   v                                | complete_turn after playback stops
 live Realtime session -------------+
```

The model decides whether the group counts. Everything else is application code: the room decides who speaks and which number, the browser cues the live session and reports when the audio actually finished. This replaced a design where the model paced turns through blocking tool calls; the realtime model produces one response per trigger, either audio or a function call, and could not reliably chain "speak, then call the tool" a hundred times.

## A counting turn

1. The user asks an agent to count. The model calls `start_counting`. The room sets `counting`, assigns the first number to that participant, and broadcasts `state_changed` with a fresh `turnId`.
2. Every browser's `CountingTurnDriver` receives the broadcast. Participants who are not the speaker close their microphone track so they do not hear and answer each other. The speaker's driver sends `response.create` with per-response instructions to say only that number.
3. If the model is mid-response (for example, answering the user), the cue waits for `response.done` and is dropped if the turn has moved on.
4. The cue carries the `turnId` as response metadata, because the API queues `response.create` calls and the SDK's own post-tool response can run first. The driver matches `response.created` by that metadata. When `output_audio_buffer.stopped` arrives for that response, the browser sends `complete_turn` with the `turnId`. If the response finished without a spoken message, the driver cues once more.
5. The room verifies the socket and `turnId`, advances `nextNumber`, assigns the next participant by join order (wrapping around), and broadcasts. The loop repeats until 100, when `finished` is broadcast and `counting` clears.
6. If a browser never reports, the relay sends `expire_turn` eight seconds after the grant. Stale expiries and completions are ignored.
7. Talking to the current speaker pauses the room: their browser sends `pause_count` as soon as `input_audio_buffer.speech_started` arrives during their turn, which reopens every microphone. The model may also call `pause_counting`. The room remembers who was interrupted, and `start_counting` resumes with that participant and the same number. Reset returns to one.

## Why each piece of state exists

The actor saves five fields:

| Field | Why it exists |
| --- | --- |
| `nextNumber` | The number being spoken or next available. |
| `counting` | Whether the room should keep assigning turns. Stop pauses it; 100 clears it. |
| `currentSpeaker` | The assigned participant, socket, join order, and `turnId`. Only this socket and ID can complete the turn. |
| `joined` | Counter that gives each connection its join order. Other sockets are not visible inside `onConnect`, so the order cannot be derived there. |
| `pausedAt` | Join order of the speaker interrupted by a pause, so resume returns to them rather than to whoever asked. |

Each connection carries a `Participant`: `participantId` names the voice session; `joinOrder` fixes its place in the rotation.

The browser connection keeps only transport state plus the list of commands awaiting acknowledgment. The turn driver keeps the active turn: its `turnId`, number, the response ID created for its cue, and whether a cue is queued behind another response.

## Messages and lifecycle

[counting-protocol.mjs](shared/counting-protocol.mjs) defines the wire format.

| Command | Actor response |
| --- | --- |
| `start_count` | Set `counting`; if no speaker is assigned, assign the paused speaker or else the requester; `ack`, broadcast `state_changed`. |
| `pause_count` | Remember the current speaker in `pausedAt`, clear `counting` and the speaker, `ack`, broadcast. |
| `reset_count` | Return to one with counting stopped, `ack`, broadcast. |
| `complete_turn` | Sent by the browser when playback stops. If this socket and `turnId` own the number, advance and assign the next participant. |
| `expire_turn` | Sent by the relay as a fallback. Same validation as `complete_turn`. |

The actor sends `ready` when a participant is registered, `ack` for accepted commands, `error` for malformed ones, and `state_changed` to everyone after any change. A disconnecting speaker's number passes to the next participant without advancing. A participant who joins a running room with no speaker takes the next number.

The progress display refreshes after broadcasts, on tab focus, and through Refresh. The runtime logs counting events with `[counting]`. Each browser logs `[voice]` diagnostics: counting socket commands and broadcasts, `turn.cued`, `turn.cue_queued`, `turn.no_speech_retry`, `turn.playback_finished`, `turn.paused_for_user`, tool starts and results, model output types and transcripts, audio playback state, interruptions, and errors.

During development, the browser automatically sends those voice diagnostics plus uncaught errors and unhandled promise rejections to the local server. `pnpm run dev` prints the `.logs/<startup-time>/` directory. Each page gets a file such as `Bob-<page-id>.jsonl`; timestamps, participant IDs, and sequence numbers let you correlate all three agents without exporting Chrome logs. Refreshing a page creates a new file. The files stay local and are ignored by Git. Collection is disabled in production.

Events are batched every half second and retried after a temporary connection failure, with a bounded queue of 1,000 events per page. Closing or hiding a page attempts a final beacon flush.

## Verification

```sh
npm test
npm run build
npm run test:counting:live
```

The live script exercises three connections through independent socket relays and an isolated room. Each connection runs a real `CountingTurnDriver` against a simulated Realtime session that speaks fifty milliseconds after each cue. It covers round-robin rotation through 100, fallback expiry, disconnect handoff, and pause. It does not call OpenAI or verify audible playback. The earlier native experiment remains in `mobile/`.
