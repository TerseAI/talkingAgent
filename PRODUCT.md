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
- Agents coordinate on counting to 100 using one local little-durable-objects actor and the get_latest_count model tool.
- The DO stores the next number, a talking stick, and a FIFO queue. It reserves each handoff for one waiter and pulses only that agent over its socket. Model-selected tools claim, complete, and release turns; completion records an agent report, not verified playback.
- One normal voice session with microphone input and interruptions. Count only when asked; no forced response loop or separate counting mode.

## Product Principles

- Make starting and ending a conversation obvious.
- Show microphone, connection, and error states honestly.
- Never include a permanent API key in client code.
