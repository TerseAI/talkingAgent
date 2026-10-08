# Talking Agent

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Inferred from the request to proceed immediately: React and TypeScript for the browser, Vite for development/builds, and a small Node/Express server for ephemeral credentials.

## Users

The project owner wants to talk to a helpful AI assistant. Broader audiences are undecided.

## Product Purpose

Implement the supplied OpenAI RealtimeAgent / RealtimeSession example as a runnable voice application.

## Capabilities and Constraints

- Use `@openai/agents/realtime` and the explicitly requested `gpt-realtime-2.1` model.
- The user will supply an OpenAI API key; keep that key on the server.
- Browser microphone input, spoken responses, session controls, and a live transcript.
- No credentials or real conversation examples were supplied.
- Assumption: local development is the initial deployment target.
- Current target: web hosts, each running one independent voice agent. No simulator is needed.
- Agents share one count through the `CountingRoom` actor. The model's only counting decisions are `start_counting` and `pause_counting`. The actor selects the speaker from its currently connected participants.
- The actor derives turns from `count % connected.length`. The selected browser tells its model to say `count + 1`, then invokes `increment()` through the web server when audio playback stops. Non-speaking agents close their microphone while the count runs so they do not answer each other. Speaking to the current speaker pauses the count and reopens every microphone.
- One normal voice session with microphone input and interruptions. Count only when asked; no forced response loop or separate counting mode.

## Product Principles

- Make starting and ending a conversation obvious.
- Show microphone, connection, and error states honestly.
- Never include a permanent API key in client code.
