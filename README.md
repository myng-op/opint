# opint — AI Social Worker Interview System

Conducts structured interviews by voice. The AI plays a warm, empathetic
interviewer trained in social-worker-style listening, walks the participant
through a configured question set, and persists the transcript for review.

## Stack

- **Python LangGraph sidecar** (`agent/`) — owns the LLM call, conversation history, tool dispatch, and Mongo writes. FastAPI on `:8001`.
- **Azure AI Foundry Chat Completions** — LLM (called from the Python sidecar via `AzureChatOpenAI`)
- **Azure Cognitive Services Speech** — Neural TTS (DragonHD voices for English/Chinese, standard Neural for other locales) via `microsoft-cognitiveservices-speech-sdk`
- **GPT Realtime API** — STT + server-side VAD (Azure OpenAI or OpenAI direct). Replaces Azure Speech SDK STT — native VAD gives instant barge-in and ~700ms turn detection.
- **Node.js + Express + `ws`** — HTTP API + WebSocket proxy: browser ↔ GPT Realtime (STT), browser ↔ Azure Speech (TTS), browser ↔ Py sidecar for the agent turn
- **MongoDB + Mongoose** — question bank, interviews, transcripts (Node side); raw `pymongo` for the same DB on the Py side
- **React (Vite)** — single-surface interviewee UI
- **Docker Compose** — local Mongo + Py agent

## Layout

```
opint/
├── README.md                 # this file — setup + daily dev
├── ARCHITECTURE.md           # data flow, schema, library choices
├── docker-compose.yml        # mongo for local dev
├── package.json              # root orchestration scripts
├── interviews/               # seed JSON — one file per QuestionSet
│   └── sample_interview.json
├── prompts/                  # app runtime prompts (LLM-facing assets)
│   └── anna/                 # Anna persona — read by Node + Py agent
│       ├── persona.md            # voice, silence discipline, opening
│       ├── speech.md             # natural-speech cues, paralinguistics
│       ├── mechanics.md          # tool usage, follow-ups, closing
│       └── guardrails.md         # ethics, neutrality, de-escalation
├── meta/                     # dev/process docs (collaboration, planning)
│   ├── behaviour.md          # collaboration rules (instruction hierarchy)
│   ├── manifest.md           # current plan + project state + tech debt
│   ├── PROMPTS.md            # log of influential prompts
│   └── archive/              # historical phase changelogs
│       └── logs.md
├── server/                   # Node backend (STT/TTS + REST + WS proxy)
│   ├── legacy/               # archived v1 Node-side LLM+tool loop (read-only)
│   └── src/
│       ├── index.js          # http + ws entrypoint
│       ├── config.js         # env loading + validation
│       ├── db.js             # mongoose connection + ping
│       ├── seed.js           # reads /interviews, upserts QuestionSets
│       ├── logging.js        # compact formatter for realtime-WS events
│       ├── realtime.js       # browser <-> GPT Realtime (STT) + Azure Speech (TTS) + Py sidecar
│       ├── realtime/
│       │   └── sttClient.js  # GPT Realtime API WebSocket client (VAD + transcription)
│       ├── models/
│       │   ├── QuestionSet.js
│       │   └── Interview.js
│       └── routes/
│           ├── questionSets.js
│           └── interviews.js
├── agent/                    # Python LangGraph sidecar (FastAPI :8001)
│   └── src/agent/            # graph, tools, prompts, checkpointer, endpoints
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

   # TTS — Azure Cognitive Services Speech
   AZURE_SPEECH_KEY="<key>"
   AZURE_SPEECH_REGION="<region>"          # e.g. swedencentral

   # STT + VAD — GPT Realtime API (Azure OpenAI preferred; OpenAI direct as fallback)
   AZURE_REALTIME_ENDPOINT="https://<resource>.openai.azure.com/"
   AZURE_REALTIME_DEPLOYMENT="gpt-4o-realtime-preview"
   AZURE_REALTIME_KEY="<key>"
   # OR: OPENAI_REALTIME_KEY="<key>" (if no Azure Realtime deployment)

   MONGO_URI="mongodb://localhost:27017/opint"
   ```

   Optional keys (sensible defaults applied if unset):

   ```
   AZURE_AI_API_VERSION                    # default "2024-10-21"
   AZURE_SPEECH_ENDPOINT                   # only if overriding the regional endpoint
   AZURE_TTS_VOICE                         # default "en-US-JennyMultilingualNeural"; recommended: "en-US-Ava:DragonHDLatestNeural"
   OPENAI_REALTIME_MODEL                   # default "gpt-4o-realtime-preview" (only used with OPENAI_REALTIME_KEY)
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

## Python sidecar

The agent path is the only path. Bring up the service alongside Mongo
before `npm run dev`:

```
docker compose up -d mongo agent
```

`PY_AGENT_URL` defaults to `http://localhost:8001`; override only if
you're running the sidecar elsewhere. If the sidecar is unreachable,
Node emits `response.error` on the WS — there is **no silent fallback**.

The previous Node-side LLM + tool loop is archived under `server/legacy/`
for historical reference; it is not imported by the running server.

Bench (manual, gated): `BENCH_LIVE=1 INTERVIEW_ID=<oid>
uv run --directory agent python scripts/bench.py`.

## REST surface

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
