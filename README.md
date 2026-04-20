# opint — AI Social Worker Interview System

Conducts structured interviews by voice. The AI plays an empathetic interviewer, pulls
questions one-by-one via tool calling, and stores the transcript for later review.

## Stack

- **Azure OpenAI Realtime (`gpt-realtime-1.5`)** — speech-in / speech-out model
- **Node.js + Express + `ws`** — HTTP API and WebSocket proxy to Azure
- **MongoDB + Mongoose** — interviews, question sets, transcripts
- **React (Vite) + React Router** — interviewee and admin surfaces
- **Docker Compose** — local Mongo

## Layout

```
opint/
├── README.md                 # this file — setup + daily dev
├── ARCHITECTURE.md           # data flow, schema, library choices
├── docker-compose.yml        # mongo for local dev
├── package.json              # root orchestration scripts
├── prompts/                  # human-authored planning docs
│   ├── behaviour.md          # collaboration rules
│   ├── plan.md               # project-level plan
│   └── PROMPTS.md            # log of influential prompts
├── server/                   # Node backend
│   └── src/
│       ├── index.js          # http + ws entrypoint
│       ├── config.js         # env loading + validation
│       ├── db.js             # mongoose connection
│       └── realtime.js       # browser <-> Azure WS bridge
└── client/                   # React frontend (vite)
    └── src/
        ├── App.jsx           # router shell
        └── routes/
            ├── Interview.jsx # interviewee voice chat
            └── Admin.jsx     # operator surface (placeholder)
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

## Daily dev

```
npm run dev        # runs server (3001) and client (5173) together
```

- Interviewee: http://localhost:5173/
- Admin:       http://localhost:5173/admin
- Health:      http://localhost:3001/health  (returns `{ ok: true, db: true }` when Mongo is up)

`npm run dev` auto-runs `kill-ports` first (via npm's `predev` hook) so stale processes
from a previous crash or `Ctrl+C` can't block 3001 / 5173. If you need to free the ports
manually: `npm run kill-ports`.

Stop Mongo when you're done: `npm run mongo:down`.
