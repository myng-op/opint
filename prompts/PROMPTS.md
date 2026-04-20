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

## Phase 1 — foundations

> let's move to phase 1
> yes to both, no need to explain, go straight to the code, as I know why

Answers to design questions:
- Mongo: local Docker for dev, Atlas deferred to prod
- Surfaces: one app, `/` interviewee + (at the time) `/admin` operator, no auth yet

Produced: folder split (`server/`, `client/`), docker-compose for Mongo,
mongoose connection + `/health`, react-router shell.

## Phase 1.5 — kill stale ports

> I have made some changes to the structure of the project: docs is removed,
> README and ARCHITECTURE are in the root, while PROMPTS is in the prompts
> file. I also propose adding in the scripts that we kill the process that
> blocks the ports so the previous error never happens again.

Produced: `kill-ports` npm script using `lsof -ti` to free 3001 / 5173, wired
to `predev` so `npm run dev` is self-healing after a crash.

## Phase 2 — question schema + seeder

> Let's go to code phase 2. I prepared a sample question list on interviews folder
> yes to both

Produced:
- `QuestionSet` model with embedded `Question` subdocs (`key`, `content`,
  `type`, `requirement`, `condition`, `maxSec`), unique index on `title`.
- `server/src/seed.js` reads `interviews/*.json`, upserts by filename stem
  so re-seeding edits in place.
- `GET /api/question-sets` (list, title + count via aggregation)
- `GET /api/question-sets/:id` (full set with ordered questions)

## Phase 3 + 4 (combined) — interview lifecycle + tool calling

> ok, let's combine phase 3 and 4 together in this stage
> agree to both, we can completely ignore the admin-driven for now as this is
> for demo purpose, we should focus strongly on the performance of the AI
> interviewer, aka the system prompt

Design choices driven by this prompt:
- System prompt is the load-bearing artifact — authored carefully in
  `server/src/realtime/session.js` as a warm, empathetic social-worker persona
  with explicit rules for listening, transitions, opening, closing.
- Tool `get_next_interview_question` takes no args — Mongo state
  (`Interview.currentIndex`) decides what comes next, so the model can't skip
  or repeat.
- Server-owned session: browser never sends `session.update`, cannot override
  persona or inject tools.

Produced:
- `Interview` model (`questionSetId`, `status`, `currentIndex`, timestamps).
- `POST /api/interviews`, `GET /api/interviews/:id`, `POST /:id/end`.
- `server/src/realtime/session.js` — system prompt + tool schema + audio
  config (Azure GA shape).
- `server/src/realtime/tools.js` — `get_next_interview_question` handler that
  advances `currentIndex` and returns `{ done: true }` when exhausted.
- `server/src/realtime.js` — bridges browser ↔ Azure, loads Interview+
  QuestionSet at WS handshake using `?interviewId=`, intercepts
  `response.function_call_arguments.done` and sends back
  `function_call_output` + `response.create`.
- Client: sends `?interviewId=` on WS open; no longer sends client-side
  session.update.

## Phase 4.5 — debug-friendly logging

> please add as many log/debug printing on the console as detailed as each
> step takes so i know when the code go wrong

Produced: consistent prefixes (`[config]`, `[db]`, `[server]`, `[api]`,
`[rt cidNNN]`, `[session]`, `[tools]`, `[client]`). Per-connection `cid`
counter so multiple simultaneous conversations stay legible. Audio-frame logs
rate-limited (every 25th) so the terminal isn't flooded. `describeEvent()` in
`server/src/logging.js` renders realtime events compactly (audio chunks as
`audio(NNNB)`, transcript deltas with previews, function calls with args).

## Phase 5 pre-work — docs + admin removal

> yes. I agree to the plan. but before working on phase 5, i'd like the
> prompts.md file and readme.md file and plan.md file updated. I also want to
> get rid of admin view completely. the transcript will also be saved in a
> persistent manner, can be a db for json format

Produced:
- Deleted `client/src/routes/Admin.jsx`; `App.jsx` now a single-route shell.
- README / ARCHITECTURE / plan / PROMPTS all updated to match.
- Phase 5 scope locked: transcript persistence goes to Mongo
  (`TranscriptTurn` collection), JSON export is deferred / optional.
