# React Native voice experiment

The app connects one independent `gpt-realtime-2.1` voice session per running app. There is no shared count, transcript, event bus, audio relay, or turn scheduler. All three apps can run at once, and each has its own Start/End controls.

## Start one iOS Simulator at a time

Install **Xcode 26.4 or newer** and an iOS Simulator runtime, open Xcode once to complete setup, and use Node 22.19 or newer. This workspace currently has only Apple’s command-line tools; Xcode and Simulator must be installed before these commands can launch the app.

From the project root, restart the API server to load the new counting-mode configuration:

```sh
npm run dev
```

In another terminal, launch whichever participant you want:

```sh
npm run sim:1
npm run sim:2
npm run sim:3
```

Run these commands individually. Each opens only the selected simulator and leaves the others running. The first command compiles a Release simulator app with its JavaScript included. Later commands reuse the build, so there is no Metro server to manage for this experiment. Alternatively, `npm run sim` chooses the next participant whose simulator is stopped.

After changing mobile code, rebuild once, then reopen the other participants to install that build:

```sh
npm run sim:1 -- --rebuild
npm run sim:2
npm run sim:3
```

Each simulator is named **Talking Agent 1**, **Talking Agent 2**, or **Talking Agent 3**. A deep link selects its participant number. You can change the number manually before connecting. The same binary runs in three separate simulator sandboxes. Launching the app does not start a paid voice session; tap **Start session** yourself.

## Try counting as a group

1. Leave **Count to 10 as a group** enabled on all three apps.
2. Tap **Start session** in each and allow microphone access.
3. Check that each participant can hear the others through your audio setup.
4. Say **“begin”** once where all three can hear it. Observe their transcripts and spoken responses.
5. End each session when finished. Use **Share** to save individual transcripts.

The counting prompt asks each participant to contribute one number at a time, listen, and stop at 10. Participant voices are Marin, Cedar, and Coral. The prompt does not prescribe a speaking order. Success, collisions, or silence are outcomes of the experiment, not enforced by application logic.

**Audio limitation:** multiple simulators do not automatically hear each other. Expo documents audio input as unavailable in the iOS Simulator, so do not rely on simulators for this microphone experiment. Three physical devices within hearing distance are the most practical setup. On a simulator with working audio input, you still need actual speaker-to-microphone or separately configured audio routing. This app deliberately does not route audio between instances. Typing “begin” addresses only that app; it is not a broadcast.

## Physical phones / Android

The native app uses `react-native-webrtc` and needs a native build; it does **not** run inside Expo Go. For development:

```sh
cd mobile
npm install
npm run ios -- --device
# or, with Android Studio and an emulator/device available:
npm run android
```

For physical devices, set `HOST=0.0.0.0` and `APP_ORIGIN=http://YOUR_MAC_LAN_IP:3000` in the **root** `.env`, restart the API server, and enter that same origin in each app’s **Server address**. Put the phones and Mac on the same trusted network. Android’s emulator uses `http://10.0.2.2:3000`; set `APP_ORIGIN` to that origin for Android emulator testing. For a hosted server, use HTTPS and add authentication before public exposure.

`EXPO_PUBLIC_API_URL` in `mobile/.env` can set the default server address. This value is public configuration. Keep `OPENAI_API_KEY` only in the root server `.env`.

## Implementation and checks

- `App.tsx`: native controls, per-instance settings, transcript, and deep links.
- `src/native-runtime.ts`: microphone permission, speaker routing, and native WebRTC bindings.
- `src/voice-session.ts`: independent connection lifecycle, ephemeral credentials, cleanup, and data-channel events. It uses the direct Realtime WebRTC API because the browser SDK transport expects DOM audio objects.
- `../shared/session-options.mjs`: validated per-session assistant/counting instructions.
- `../scripts/ios-simulator.mjs`: one-simulator launcher and reusable native build.

```sh
npm run typecheck
npm run export:ios
cd ..
npm test
```

Verified here: TypeScript, iOS JavaScript/Hermes bundle, and mocked session tests including three simultaneous independent sessions. Native compilation, microphone/speaker behavior, and live group counting remain unverified until Xcode/devices are available.

References: [Expo 57 requirements](https://docs.expo.dev/versions/v57.0.0/), [Simulator limitations](https://docs.expo.dev/workflow/ios-simulator/), [native WebRTC setup](https://github.com/react-native-webrtc/react-native-webrtc), and [OpenAI Realtime WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc).
