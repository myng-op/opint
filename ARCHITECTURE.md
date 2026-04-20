# Architecture

Plain-English explanation of how the system fits together. Kept short on purpose —
updated as each phase lands.

## High-level data flow

```
┌─────────────┐   WS    ┌──────────────┐   WSS    ┌──────────────────┐
│  React UI   │ ──────▶ │  Node proxy  │ ───────▶ │  Azure Realtime  │
│ (browser)   │ ◀────── │  + REST API  │ ◀─────── │   gpt-realtime   │
└─────────────┘         └──────┬───────┘          └──────────────────┘
                               │
                               ▼
                        ┌──────────────┐
                        │   MongoDB    │
                        │ (interviews, │
                        │  questions,  │
                        │  transcripts)│
                        └──────────────┘
```

- The browser never talks to Azure directly — it would leak the API key.
- One WS frame from the browser = one frame to Azure (and vice versa), with
  the server free to **inspect and mutate** frames (this is how tool calls
  like `get_next_interview_question` will be resolved server-side in Phase 4).
- REST endpoints on the same Node process handle CRUD for question sets and
  interview records.

## Why these libraries

| Choice             | Why                                                                 |
|--------------------|---------------------------------------------------------------------|
| Express            | Smallest viable HTTP framework; no opinions to fight.               |
| `ws`               | Standard Node WS lib, works both as server and upstream client.     |
| Mongoose           | Schema validation + model methods; makes the data model explicit.   |
| Vite               | Fast dev server, native ESM, simple WS proxy config.                |
| React Router       | Single route today; a shell that can host more pages without a refactor. |
| Docker Compose     | Disposable Mongo for dev; one command up/down, no host pollution.   |

## Audio pipeline

- Browser captures mic at 24 kHz mono via `AudioContext` (Azure's native rate).
- Samples are converted Float32 → Int16 PCM → base64 and sent as
  `input_audio_buffer.append` events.
- Server VAD (Azure-side) decides when a turn ends; no push-to-talk button needed.
- Assistant audio arrives as `response.output_audio.delta` chunks that are
  scheduled back-to-back on a second `AudioContext` for gapless playback.

## Data model

### `QuestionSet` (implemented, Phase 2)

One doc per interview template. Seeded from a file in `/interviews` — the
filename stem becomes the `title`, which is also the upsert key so re-seeding
edits in place instead of duplicating.

```
QuestionSet {
  _id: ObjectId
  title: string              // unique; filename stem
  description: string
  questions: [Question]      // ordered; array index = ask order
  createdAt, updatedAt
}

Question (embedded, no _id) {
  key: string                // original JSON id, e.g. "q1" — stable across re-seeds
  content: string            // the question text spoken to the user
  type: string               // free-form category ("qualitative", etc.)
  requirement: string        // AI-facing coaching: what the interviewer should learn
  condition: string          // future branching logic; empty for now
  maxSec: number | null      // per-answer time budget; null = unlimited
}
```

Design choices:
- **Embedded questions, not a separate collection** — they're always read with
  the set, never referenced independently. Single doc fetch = single round trip.
- **`key` over ObjectId for question identity** — Phase 4 tool calls will refer
  to questions by this stable string. Immune to re-seed churn.
- **`unique` index on `title`** — makes the upsert race-free and catches typo
  collisions loudly.

### `Interview` (implemented, Phase 3)

One doc per live conversation. Created via `POST /api/interviews`, ended via
`POST /api/interviews/:id/end` (or automatically when the tool signals `done`).

```
Interview {
  _id: ObjectId
  questionSetId: ObjectId      // ref → QuestionSet
  status: "pending" | "in_progress" | "completed"
  currentIndex: number         // index of the NEXT question to ask
  startedAt, endedAt
  createdAt, updatedAt
}
```

Lifecycle:
- `pending` — row created, no tool calls yet
- `in_progress` — set on the first `get_next_interview_question` call, stamps `startedAt`
- `completed` — set when the tool runs out of questions OR `/end` is called; stamps `endedAt`

### `TranscriptTurn` (implemented, Phase 5)

One completed utterance tied to an `Interview`. We persist **only on
completion** events — no delta buffering:

- user turn    → `conversation.item.input_audio_transcription.completed`
- assistant turn → `response.output_audio_transcript.done`
  (or the legacy `response.audio_transcript.done`)

If the WS dies mid-turn, that half-turn is dropped. This keeps the DB clean of
noise and means a stored transcript reflects what was actually finalised by
whisper (user) and the model (assistant).

```
TranscriptTurn {
  _id: ObjectId
  interviewId: ObjectId        // ref → Interview
  sequence: number             // monotonic per interview; seeded from countDocuments at WS open
  role: "user" | "assistant"
  text: string
  createdAt, updatedAt
}
```

Indexes: `{ interviewId: 1, sequence: 1 }` so `/transcript` reads stream back
in order without a separate sort pass.

## REST surface (current)

| Method | Path                          | Purpose                                       |
|--------|-------------------------------|-----------------------------------------------|
| GET    | `/health`                     | Liveness + Mongo readiness                    |
| GET    | `/api/question-sets`          | List sets (title + count, no question bodies) |
| GET    | `/api/question-sets/:id`      | One set with full ordered questions           |
| POST   | `/api/interviews`             | Create Interview; body `{ questionSetId }`    |
| GET    | `/api/interviews`             | List all interviews (id, title, status, turn count) |
| POST   | `/api/interviews/:id/end`     | Mark Interview completed (idempotent)         |
| GET    | `/api/interviews/:id`         | Read Interview state                          |
| GET    | `/api/interviews/:id/transcript` | Ordered list of completed turns             |

## Realtime session lifecycle (Phase 3 + 4)

```
 browser                       server                          Azure Realtime
   │                              │                                 │
   │ POST /api/interviews ───────▶│                                 │
   │◀─────────── { _id } ─────────│                                 │
   │                              │                                 │
   │ WS open ?interviewId=<id> ──▶│ load Interview + QuestionSet    │
   │                              │   open upstream WS ────────────▶│
   │                              │                                 │
   │                              │ session.update (persona+tool) ─▶│
   │                              │ response.create ───────────────▶│
   │                              │                                 │
   │◀── audio + transcripts ──────│◀── response.output_audio.delta ─│
   │                              │                                 │
   │                              │◀── response.function_call ──────│
   │                              │   args.done { name, call_id }    │
   │                              │                                 │
   │                              │ resolve tool against Mongo       │
   │                              │   (advance currentIndex)         │
   │                              │                                 │
   │                              │ conversation.item.create ──────▶│
   │                              │   { function_call_output }       │
   │                              │ response.create ───────────────▶│
   │                              │                                 │
   │ input_audio_buffer.append ──▶│ ───────────────────────────────▶│  (user answers)
```

Key properties:
- **Session ownership is server-side.** System prompt, tool schema, audio
  config — all authored in `server/src/realtime/session.js`. The browser
  cannot override persona or inject tools.
- **AI greets first.** After `session.update` the server sends
  `response.create` with no user input, and the model emits its opening.
- **Tool dispatch is server-side.** `response.function_call_arguments.done`
  is intercepted in `realtime.js`; `tools.js` resolves the function against
  Mongo and returns a plain object serialized into `function_call_output`.
- **Questions are pulled, not pushed.** The AI decides when it's satisfied
  with an answer and calls `get_next_interview_question` — we never push
  question text into the conversation unilaterally.

## Open questions / decisions deferred

- **Auth** — none in the demo. Revisit if the interviewee surface is ever exposed to untrusted users.
- **Transcript storage format** — landed on cleaned turns in `TranscriptTurn`
  (Phase 5). JSON export / raw-event log can be added later if needed.
- **Tool-call execution** — run inside `realtime.js` on the server, so the model
  never learns about our DB and the browser never sees question text it hasn't
  already received as audio/transcript.
