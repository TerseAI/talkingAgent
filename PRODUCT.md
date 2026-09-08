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
- Agents share one count through the `CountingRoom` actor. The model's only counting decisions are `start_counting` and `pause_counting`. The room rotates turns round-robin over connected participants and broadcasts each assignment.
- The browser drives the live session: on its turn it sends `response.create` telling the model to say only its number, and reports `complete_turn` when audio playback stops. The relay expires a turn after eight seconds only as a fallback. Non-speaking agents close their microphone while the count runs so they do not answer each other. Speaking to the current speaker pauses the count at that speaker and reopens every microphone; `start_counting` resumes with the same participant and number.
- One normal voice session with microphone input and interruptions. Count only when asked; no forced response loop or separate counting mode.

## Product Principles

- Make starting and ending a conversation obvious.
- Show microphone, connection, and error states honestly.
- Never include a permanent API key in client code.
