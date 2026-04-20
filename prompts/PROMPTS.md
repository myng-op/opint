# Prompt log

Record of the user prompts that shaped this project. Useful for restarting a
fresh chat with context, or for reusing phrasing that worked well.

## Phase 0 — bootstrap scaffold

> build me a super simple voice chat interface with react node and javascript
> using the azure api to realtime 1.5. make it as simple as possible for now,
> ignore my prompts guide for now

Produced: root `server.js` + `client/` vite app, mic capture at 24 kHz PCM16,
gapless playback, bare proxy with no DB / no persistence.

## Phase 0.5 — switch to GA realtime schema

> Status: error: Missing required parameter: 'session.type'.

Fix: moved `session.update` payload to the GA schema (`session.type: "realtime"`,
audio under `audio.input` / `audio.output`) and accepted both old and new event
names for audio deltas.

## Phase 1 — foundations (current)

> let's move to phase 1
> yes to both, no need to explain, go straight to the code, as I know why

Answers to design questions:
- Mongo: local Docker for dev, Atlas deferred to prod
- Surfaces: one app, `/` interviewee + `/admin` operator, no auth yet

Produced: folder split (`server/`, `client/`, `docs/`), docker-compose for
Mongo, mongoose connection + `/health`, react-router shell with two routes.
