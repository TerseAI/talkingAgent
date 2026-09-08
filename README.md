# Talking Agent

A browser voice agent built with `RealtimeAgent` and `RealtimeSession` from `@openai/agents/realtime`. Each tab has an independent conversation with microphone input, spoken replies, interruptions, text messages, and a transcript.

The agent also has four ordinary tools backed by one local durable object: `read_counter`, `get_latest_count`, `done_speaking`, and `release_turn`. Ask it to count to use them. The SDK executes model-selected tools and returns their results to the model. Connecting does not start counting. The durable object keeps a FIFO queue of waiting agent IDs. The `get_latest_count` tool remains pending in the browser until a targeted socket handoff grants its lock. The DO method itself returns immediately; the browser waits outside the actor and rechecks only on a socket notification. The SDK receives the eventual tool result normally, without injected messages or forced responses. Speech and typed questions leave the wait pending; the model’s release tool or the explicit Stop response button cancels it; ending the session closes the socket and removes the agent from the queue. Reconnection rechecks the claim, and reaching 100 resolves waiting tools with `done`.

`src/counter-tools.ts` defines the tools; `shared/agent-config.mjs` contains the prompt. There is no application counting loop, forced tool choice, scripted number speech, or automatic playback-based increment. The durable object serializes updates and stores only the next number, talking-stick holder, and FIFO waiting queue. The count records what agents report through `done_speaking`; it does not verify what was audibly spoken or guarantee non-overlapping audio. Ending a session releases its turn without advancing the count.

## Run locally

Requires Node.js 22.19+, an OpenAI key, and a built local little-durable-objects checkout at `../little-durable-objects`. The SDK dependency points to its `npm` directory.

Set `.env`:

```dotenv
OPENAI_API_KEY=your_key
DURABLE_OBJECT_BINARY=/Users/thomaskaratzas/Desktop/Projects/little-durable-objects/target/debug/little-durable-objects
```

Start the shared runtime:

```sh
npm run counter
```

Start one or more web hosts in separate terminals:

```sh
PORT=3002 APP_ORIGIN=http://localhost:3002 npm run dev
PORT=3003 APP_ORIGIN=http://localhost:3003 npm run dev
PORT=3004 APP_ORIGIN=http://localhost:3004 npm run dev
```

Open the addresses in Chrome and click **Start conversation**. Speak or type normally; ask the agent to count when desired. All hosts share `.counter-data` and the default counter ID. Stop all agents before resetting the counter. Restart hosts when the runtime's one-hour client credentials expire.

The API key stays on the server; browsers receive short-lived credentials. Audio is sent to OpenAI while connected. The model is `gpt-realtime-2.1`. No live weather or web-search tool is configured. The previous native experiment remains in `mobile/`.

## Verification

```sh
npm test
npm run build
npm run test:counter:live
```

The live counter test exercises the real durable object across three HTTP hosts with simulated tool calls. It also verifies targeted delivery and disconnect handoff. It does not call OpenAI or test model decisions or audible playback. `scripts/browser-smoke.mjs` checks the UI with stubbed credentials and synthetic microphone input. The old scripted counting/audio test was removed along with its coordinator.
