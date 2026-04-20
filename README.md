# opint — AI Social Worker Interview System

Conducts structured interviews by voice. The AI plays a warm, empathetic
interviewer trained in social-worker-style listening, pulls questions
one-by-one via tool calling, and (Phase 5) persists the transcript for later
review.

## Stack

- **Azure OpenAI Realtime (`gpt-realtime-1.5`)** — speech-in / speech-out model
- **Node.js + Express + `ws`** — HTTP API and WebSocket proxy to Azure
- **MongoDB + Mongoose** — question bank, interviews, transcripts
- **React (Vite)** — single-surface interviewee UI
- **Docker Compose** — local Mongo

## Layout

```
opint/
├── README.md                 # this file — setup + daily dev
├── ARCHITECTURE.md           # data flow, schema, library choices
├── docker-compose.yml        # mongo for local dev
├── package.json              # root orchestration scripts
├── interviews/               # seed JSON — one file per QuestionSet
│   └── sample_interview.json
├── prompts/                  # human-authored planning docs
│   ├── behaviour.md          # collaboration rules
│   ├── plan.md               # project-level plan + phase roadmap
│   └── PROMPTS.md            # log of influential prompts
├── server/                   # Node backend
│   └── src/
│       ├── index.js          # http + ws entrypoint
│       ├── config.js         # env loading + validation
│       ├── db.js             # mongoose connection + ping
│       ├── seed.js           # reads /interviews, upserts QuestionSets
│       ├── logging.js        # compact formatter for realtime-WS events
│       ├── realtime.js       # browser <-> Azure WS bridge, tool dispatch
│       ├── realtime/
│       │   ├── session.js    # system prompt + tool schema + audio config
│       │   └── tools.js      # get_next_interview_question handler
│       ├── models/
│       │   ├── QuestionSet.js
│       │   └── Interview.js
│       └── routes/
│           ├── questionSets.js
│           └── interviews.js
└── client/                   # React frontend (vite)
    └── src/
        ├── App.jsx           # router shell (single route)
        └── routes/
            └── Interview.jsx # interviewee voice chat
```

## First-time setup

1. Populate `.env` at the repo root. Required keys:

   ```
   AZURE_ENDPOINT="https://<resource>.openai.azure.com/openai/v1/"
   AZURE_API_KEY="<key>"
   AZURE_REALTIME_MODEL="gpt-realtime-1.5"
   AZURE_API_VERSION="2024-10-01-preview"
   MONGO_URI="mongodb://localhost:27017/opint"
   VITE_AZURE_REALTIME_VOICE="coral"
   ```

2. Install dependencies (root, server, client):

   ```
   npm run install:all
   ```

3. Start MongoDB in Docker:

   ```
   npm run mongo:up
   ```

4. Seed the question bank from `interviews/*.json`:

   ```
   npm run seed
   ```

## Daily dev

```
npm run dev        # runs server (3001) and client (5173) together
```

- Interviewee: http://localhost:5173/
- Health:      http://localhost:3001/health  (returns `{ ok: true, db: true }` when Mongo is up)

`npm run dev` auto-runs `kill-ports` first (via npm's `predev` hook) so stale
processes from a previous crash or `Ctrl+C` can't block 3001 / 5173. If you
need to free the ports manually: `npm run kill-ports`.

Stop Mongo when you're done: `npm run mongo:down`.

## REST surface

See `ARCHITECTURE.md` for the full table. Quick reference:

- `GET  /api/question-sets`            — list (title + count)
- `GET  /api/question-sets/:id`        — full detail with ordered questions
- `POST /api/interviews`               — body `{ questionSetId }`
- `GET  /api/interviews/:id`           — read interview state
- `POST /api/interviews/:id/end`       — mark completed (idempotent)

## Logging

Every step is logged with a consistent prefix so a single `npm run dev`
terminal is enough to debug the whole stack:

- `[config]`, `[db]`, `[server]` — boot
- `[api]`                          — REST requests (method, path, status, latency)
- `[rt cidNNN]`                    — realtime WS proxy (one id per live conversation)
- `[session]`                      — session config build
- `[tools]`                        — tool dispatch + interview state transitions

The browser console mirrors this with `[client]` prefixes.
