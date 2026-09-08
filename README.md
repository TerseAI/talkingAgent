# Talking Agent

Independent web voice agents count to 100 using OpenAI Realtime and one local [little-durable-objects](https://github.com/TerseAI/little-durable-objects) instance. Voice chat remains available. No simulator is needed.

## Coordination

`src/durable-objects.ts` defines `Counter` with exactly two stored properties:

```ts
number = 1;
talkingStick: string | null = null;
```

- `getLatestCount(agentId)` checks and takes the talking stick in one DO method. The holder receives `number`; other agents receive `waiting` and retry.
- The holder says only that number. The browser waits for the expected transcript and WebRTC playback completion.
- `doneSpeaking(agentId, number)` checks the holder, advances the number, and clears the talking stick in one DO method.

The runtime serializes each method, so checking and updating the properties is atomic. Both properties persist on the same object across every host. There are no application queues, heartbeats, workers, or HTTP playback callbacks inside the DO. Only the browser knows when audio has finished, so it sends that completion to its own web server, which calls the DO through the SDK.

The SDK currently exports its base class as `Actor`. The counter imports it as `Actor as DurableObject` and directly extends it. Each web server uses `Counter.get('voice-count-to-100')`.

Stopping an agent mutes its output and releases its stick without advancing the number. If a page crashes before releasing the stick, stop all agents and use **Reset count**. Reset always starts at 1. Playback events do not prove physical audibility when the OS or tab is muted.

## Run locally

Requires Node.js 22.19+, an OpenAI key, and a built local little-durable-objects checkout. This workspace links `/Users/olimorissette/Desktop/projects/durable-objects/npm`. For another checkout, install its built SDK directory with `npm install /absolute/path/to/little-durable-objects/npm`.

Set these in `.env`, preserving an existing key:

```dotenv
OPENAI_API_KEY=your_key
DURABLE_OBJECT_BINARY=/absolute/path/to/little-durable-objects/target/debug/little-durable-objects
```

Start the control plane once:

```sh
npm run counter
```

This uses the SDK's `dev` command on port 7110, loading `src/durable-objects.ts` and keeping local state in `.counter-data`. Restart it after editing the DO.

Start each web host in a separate terminal:

```sh
PORT=3000 APP_ORIGIN=http://localhost:3000 npm run dev
```

```sh
PORT=3001 APP_ORIGIN=http://localhost:3001 npm run dev
```

```sh
PORT=3002 APP_ORIGIN=http://localhost:3002 npm run dev
```

Open each address and click **Start this agent**. Several tabs also work. Each page creates an independent Realtime session and unique agent ID. All hosts use the same control plane, `.counter-data` directory, and `COUNTER_ID` (default `voice-count-to-100`). The SDK's `run` command supplies local credentials; restart web servers after its one-hour credential expires.

When running separate copies of the app, use the same absolute `--data-dir` in their SDK `run` commands. A separate control plane or data directory creates a separate counter. This configuration runs on one computer; remote hosts need access to the shared runtime.

Microphone permission is needed for WebRTC setup, but microphone input stays disabled during counting. Keep audio enabled on every page. Stop all agents before resetting. The permanent OpenAI key stays on the server; the browser receives a short-lived credential. The model is `gpt-realtime-2.1`.

## Verification

```sh
npm test
npm run build
npm run test:counter:live
```

The live counter test requires the control plane. It starts three HTTP hosts that use the real SDK and one isolated counter. It verifies 1–100 exactly once and one talking-stick holder while simulating spoken turns. It does not call OpenAI.

`node scripts/browser-smoke.mjs` checks the interface in installed Chrome, with the web app running. `node scripts/counting-browser-live.mjs` runs a billable test with three real voice agents on temporary hosts 3101–3103 and an isolated counter; build first. It checks playback events for overlap.

`npm start` serves the production build through the same SDK client command. Transcripts remain in browser memory and can be downloaded. The previous native experiment remains in `mobile/` outside this web workflow.
