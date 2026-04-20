# Project plan — AI Social Worker Interview System

A living document. Top half is the original project brief; bottom half is the
phase roadmap, updated as each phase lands.

## Project brief (original)

We are building an AI social worker interview system using:
- Azure `gpt-realtime-1.5` for real-time speech-in / speech-out interaction
- MongoDB for storing interview data
- React + Node.js for the web framework
- JavaScript throughout
- npm for project scripts and dependency management
- Docker for local Mongo
- Git + GitHub for version control

Goals:
- The human prepares a set of questions. The AI conducts the interview,
  transcribes it, and stores the data.
- The interviewee surface is a web app. The AI is warm and empathetic so the
  interview feels comfortable, not interrogative. A friendly avatar makes it
  less intimidating. The user can hide / show the transcript.
- The AI pulls questions **one at a time** via tool calling — it only advances
  when satisfied with the current answer. This keeps the conversation natural
  and stops the model from racing through the list.
- Data model stores questions, answers, timestamps, and metadata so we can
  retrieve and analyse interviews later.
- Modular, so we can swap models or extend the schema later.

## Phase roadmap

Legend: ✅ done · 🚧 in progress · ⏳ planned

### ✅ Phase 0 — bootstrap voice chat

Minimal React + Node + Azure Realtime scaffold. No DB. Just prove the audio
pipeline and the WS proxy work.

### ✅ Phase 0.5 — Azure GA schema

Migrate `session.update` to `session.type: "realtime"` with audio under
`audio.input` / `audio.output`.

### ✅ Phase 1 — foundations

Repo split into `server/` + `client/`. Docker Compose for local Mongo.
Mongoose connection + `/health`. React Router shell.
`kill-ports` script so stale processes never block 3001 / 5173 again.

### ✅ Phase 2 — question schema + seeder

`QuestionSet` with embedded `Question` subdocs. `server/src/seed.js` reads
`interviews/*.json` and upserts by filename stem. REST:
`GET /api/question-sets`, `GET /api/question-sets/:id`.

### ✅ Phase 3 + 4 — interview lifecycle + tool calling

`Interview` model with `currentIndex` state machine. `get_next_interview_question`
tool dispatched server-side against Mongo. System prompt authored as a
warm, empathetic social worker in `server/src/realtime/session.js`. Server
owns session config; browser cannot override persona or inject tools.

### ✅ Phase 4.5 — debug-friendly logging

Consistent prefixes across the stack (`[config]`, `[db]`, `[server]`, `[api]`,
`[rt cidNNN]`, `[session]`, `[tools]`, `[client]`). Per-connection ids.
Rate-limited audio logs. Compact realtime event formatter.

### 🚧 Phase 5 — transcript persistence

Goal: every interview ends with a replayable record in Mongo.

- New `TranscriptTurn` collection: `interviewId`, `sequence`, `role`
  (`user` | `assistant`), `text`, `startedAt`, `endedAt`.
- Capture in `server/src/realtime.js`:
  - Assistant: buffer `response.output_audio_transcript.delta`, persist on
    `.done`.
  - User: persist on `conversation.item.input_audio_transcription.completed`.
- Partial buffers are discarded if the WS dies mid-turn — no half-turns in DB.
- `GET /api/interviews/:id/transcript` returns turns in `sequence` order.
- ARCHITECTURE.md gets the new schema added.

JSON export is deferred — Mongo is the source of truth; an export endpoint
can be added later if we need offline review.

### ⏳ Phase 6 — interview review surface (future)

Somewhere to read finished interviews back. Likely a minimal admin-style page
re-introduced behind a feature flag, or a read-only export. Scope TBD.

### ⏳ Phase 7 — avatar + transcript toggle (future)

Friendly avatar on the interviewee UI. Show/hide transcript button. Covered
in the original brief but not yet in scope — Phase 5 needs to land first so
there's actually a transcript to toggle.

## Deferred / open

- **Auth.** None in the demo. Revisit before exposing to untrusted users.
- **Admin surface.** Deleted in Phase 5 pre-work; may return as Phase 6.
- **Atlas / prod deployment.** Currently local-only via Docker Compose.
- **Branching / conditional questions.** `Question.condition` is in the
  schema but not wired up anywhere yet.
