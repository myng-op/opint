# opint — AI Social Worker Interview System

Conducts structured interviews by voice. The AI plays a warm, empathetic
interviewer trained in social-worker-style listening, pulls questions
one-by-one via tool calling, and (Phase 5) persists the transcript for later
review.

## Stack

- **Azure AI Foundry Chat Completions** — LLM step (deployment via `AZURE_AI_DEPLOYMENT`)
- **Azure Cognitive Services Speech** — streaming STT + Neural TTS (DragonHD voices for English/Chinese, standard Neural for other locales) via `microsoft-cognitiveservices-speech-sdk`
- **Node.js + Express + `ws`** — HTTP API and WebSocket bridge between browser and the Azure services
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
├── meta/                     # dev/process docs (collaboration, planning)
│   ├── behaviour.md          # collaboration rules (instruction hierarchy)
│   ├── manifest.md           # current plan + project state + tech debt
│   ├── PROMPTS.md            # log of influential prompts
│   └── archive/              # historical phase changelogs
│       └── logs.md
├── server/                   # Node backend
│   └── src/
│       ├── index.js          # http + ws entrypoint
│       ├── config.js         # env loading + validation
│       ├── db.js             # mongoose connection + ping
│       ├── seed.js           # reads /interviews, upserts QuestionSets
│       ├── logging.js        # compact formatter for realtime-WS events
│       ├── realtime.js       # browser <-> Azure WS bridge, tool dispatch
│       ├── realtime/
│       │   ├── session.js    # tool schema + audio config; loads prompt files
│       │   ├── prompts/      # markdown — edit + restart to tweak persona
│       │   │   ├── persona.md     # Anna's voice, silence discipline, opening
│       │   │   ├── mechanics.md   # tool usage, follow-ups, closing
│       │   │   ├── guardrails.md  # ethics, neutrality, de-escalation
│       │   │   └── speech.md      # natural-speech cues (filler, pauses, paralinguistics)
│       │   └── tools.js      # get_next_interview_question handler
│       ├── models/
│       │   ├── QuestionSet.js
│       │   └── Interview.js
│       └── routes/
│           ├── questionSets.js
│           └── interviews.js
└── client/                   # React frontend (vite)
    └── src/
        ├── App.jsx           # router shell (/, /review, /review/:id)
        ├── theme.js          # shared color + shape tokens (#EE5A00)
        └── routes/
            ├── Interview.jsx     # interviewee voice chat + Anna orb
            ├── Review.jsx        # list of past interviews (unlinked from /)
            └── ReviewDetail.jsx  # transcript playback for one interview
```

## First-time setup

1. Populate `.env` at the repo root. Required keys:

   ```
   # LLM — Azure AI Foundry Chat Completions
   AZURE_AI_ENDPOINT="https://<resource>.openai.azure.com/"
   AZURE_AI_KEY="<key>"
   AZURE_AI_DEPLOYMENT="<chat-completions-deployment-name>"

   # STT + TTS — Azure Cognitive Services Speech
   AZURE_SPEECH_KEY="<key>"
   AZURE_SPEECH_REGION="<region>"          # e.g. swedencentral

   MONGO_URI="mongodb://localhost:27017/opint"
   ```

   Optional keys (sensible defaults applied if unset):

   ```
   AZURE_AI_API_VERSION                    # default "2024-10-21"
   AZURE_SPEECH_ENDPOINT                   # only if overriding the regional endpoint
   AZURE_STT_LANGUAGE                      # default "en-US" — overridden per-interview by the language picker
   AZURE_TTS_VOICE                         # default "en-US-JennyMultilingualNeural"; recommended: "en-US-Ava:DragonHDLatestNeural"
   PORT                                    # default 3001
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
- Review list: http://localhost:5173/review          (unlinked, typed-URL only)
- Transcript:  http://localhost:5173/review/:id
- Health:      http://localhost:3001/health          (returns `{ ok: true, db: true }` when Mongo is up)

`npm run dev` auto-runs `kill-ports` first (via npm's `predev` hook) so stale
processes from a previous crash or `Ctrl+C` can't block 3001 / 5173. If you
need to free the ports manually: `npm run kill-ports`.

Stop Mongo when you're done: `npm run mongo:down`.

## REST surface

See `ARCHITECTURE.md` for the full table. Quick reference:

- `GET  /api/question-sets`            — list (title + count)
- `GET  /api/question-sets/:id`        — full detail with ordered questions
- `POST /api/interviews`               — body `{ questionSetId }`
- `GET  /api/interviews`               — list all interviews (id, title, status, turn count)
- `GET  /api/interviews/:id`           — read interview state
- `POST /api/interviews/:id/end`       — mark completed (idempotent)
- `GET  /api/interviews/:id/transcript` — ordered list of completed turns

## Logging

Every step is logged with a consistent prefix so a single `npm run dev`
terminal is enough to debug the whole stack:

- `[config]`, `[db]`, `[server]` — boot
- `[api]`                          — REST requests (method, path, status, latency)
- `[rt cidNNN]`                    — realtime WS proxy (one id per live conversation)
- `[session]`                      — session config build
- `[tools]`                        — tool dispatch + interview state transitions

The browser console mirrors this with `[client]` prefixes.
