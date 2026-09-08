# Talking Agent

Three voice agents share one counter. Each agent uses the normal OpenAI Realtime SDK loop with microphone input, spoken replies, interruptions, and tools. Counting starts only when you ask.

## Start the demo

From this folder, run the durable-object runtime in one terminal:

```sh
npm run counter
```

Then run **one** web process in a second terminal:

```sh
npm run dev
```

This serves all three addresses with one shared coordinator:

- http://localhost:3002 — Alice, Marin voice
- http://localhost:3003 — Bob, Cedar voice
- http://localhost:3004 — Charlie, Coral voice

Stop old web processes before starting this version. Do not launch one process per port. Keep both terminals open. Refresh the pages and start fresh conversations after updating. Stop all agents before resetting the count. After an unclean shutdown, reset the counter before starting a new round if an old holder remains.

Requires Node.js 22.19+, the built SDK at `../little-durable-objects/npm`, and these values in `.env`:

```dotenv
OPENAI_API_KEY=your_key
DURABLE_OBJECT_BINARY=/Users/thomaskaratzas/Desktop/Projects/little-durable-objects/target/debug/little-durable-objects
```

The key stays on the server. The browser receives a short-lived credential. The model is `gpt-realtime-2.1`. No weather or web-search tool is configured.

## Turn flow

1. The model calls `getTalkingStick()`.
2. Its HTTP request remains open in `server/turn-coordinator.mjs` until the agent gets the turn. There is no wait timeout or repeated request.
3. The coordinator resolves that request with the reserved number. The SDK returns the tool result to the model.
4. The agent speaks, then calls `done_speaking()` with no arguments.
5. The DO verifies the holder, increments the count, and releases the stick. The coordinator directly resolves the next waiting request in FIFO order.

There are no coordination WebSockets, server-sent events, broadcasts, or polling. Pending promises live in one Node process. The DO stores only the next number and current holder; no long wait runs inside a serialized DO method.

`release_turn()` cancels a wait or releases the stick without advancing. Cancelling a pending HTTP request removes that waiter. Ending a browser session sends a release request. Graceful server shutdown cancels pending waits and releases the holder. Process crashes lose pending promises; saved counter state survives in `.counter-data`.

A completed tool call records the model's report, not verified audio playback. The prompt asks for silence while waiting; pending tools alone do not enforce model silence. No code scripts the words or forces tool choices.

## Following the demo

The runtime terminal logs `[counter]` acquisitions, completion reports, and releases. The web terminal logs queued requests. Chrome's console shows named tool starts, arguments, and results. A tool start without a finish remains pending. Session suffixes distinguish duplicate tabs.

The counter display shows the **last observed state**. It refreshes after local tool actions, on tab focus, and with the Refresh button. It does not continuously update from other agents. No microphone audio or conversation transcripts are logged by the application.

## Verification

```sh
npm test
npm run build
npm run test:counter:live
```

The live test uses three HTTP listeners sharing one coordinator and a real isolated counter ID. It verifies that a request remains pending until completion and that 1–100 is granted exactly once across three clients. It does not call OpenAI or verify audible playback. The earlier native experiment remains in `mobile/`.
