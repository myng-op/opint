# Architecture

Plain-English explanation of how the system fits together. Kept short on purpose —
updated as each phase lands.

## High-level data flow

```
┌─────────────┐   WS    ┌──────────────┐   HTTPS    ┌──────────────────────────┐
│  React UI   │ ──────▶ │  Node proxy  │ ─────────▶ │  Azure AI Foundry        │
│ (browser)   │ ◀────── │  + REST API  │ ◀───────── │   (Chat Completions LLM) │
└─────────────┘         └──┬───────┬───┘            └──────────────────────────┘
                           │       │  WSS           ┌──────────────────────────┐
                           │       ├──────────────▶ │  GPT Realtime API        │
                           │       │  ◀────────────│   (STT + VAD only)       │
                           │       │               └──────────────────────────┘
                           │       │  HTTPS         ┌──────────────────────────┐
                           │       └──────────────▶ │  Azure Speech            │
                           │           ◀────────────│   (TTS — DragonHD)       │
                           ▼                        └──────────────────────────┘
                    ┌──────────────┐
                    │   MongoDB    │
                    │ (interviews, │
                    │  questions,  │
                    │  transcripts)│
                    └──────────────┘
```

- The browser never talks to Azure directly — it would leak API keys.
- The browser↔Node WS carries audio in both directions (PCM16 24 kHz,
  base64-chunked deltas). The frame contract was deliberately preserved
  through the April 22 STT→LLM→TTS migration so the client did not need
  to change.
- The server orchestrates three services per turn: incoming PCM is
  forwarded to the GPT Realtime API over a persistent WebSocket (STT +
  server-side VAD); the transcribed utterance feeds the Python LangGraph
  sidecar (LLM reasoning); the assistant text feeds the Azure Speech SDK
  synthesizer (TTS); the resulting PCM streams back to the browser.
- REST endpoints on the same Node process handle CRUD for question sets,
  interview lifecycle, and transcript reads.

## Why these libraries

| Choice                                  | Why                                                                       |
|-----------------------------------------|---------------------------------------------------------------------------|
| Express                                 | Smallest viable HTTP framework; no opinions to fight.                     |
| `ws`                                    | Standard Node WS lib for the browser↔server bridge.                       |
| `microsoft-cognitiveservices-speech-sdk`| TTS only (DragonHD voices). STT moved to GPT Realtime API for native VAD + lower latency. |
| `fetch` (native)                        | LLM step is a single HTTPS call to Azure AI Foundry — no SDK needed.      |
| Mongoose                                | Schema validation + model methods; makes the data model explicit.         |
| Vite                                    | Fast dev server, native ESM, simple WS proxy config.                      |
| React Router                            | Multi-route shell (`/`, `/review`, `/review/:id`).                        |
| Docker Compose                          | Disposable Mongo for dev; one command up/down, no host pollution.         |

## Audio pipeline

- Browser captures mic at 24 kHz mono via `AudioContext`. Float32 → Int16 PCM
  → base64, sent as `input_audio_buffer.append` events on the WS.
- Server forwards audio frames as-is (base64 PCM16) to the GPT Realtime
  API over a persistent WebSocket (`RealtimeSttClient`). The Realtime API
  provides server-side VAD and Whisper-based transcription.
- VAD fires `input_audio_buffer.speech_started` immediately when the user
  begins speaking — this triggers barge-in (TTS abort + `response.cancelled`
  to the browser) with no delay.
- After the user stops speaking (~700ms silence), the API auto-commits
  the audio buffer and produces a final transcript via
  `conversation.item.input_audio_transcription.completed`.
- `runAssistantTurn()` POSTs the transcript to the Python sidecar's
  `/turn` endpoint. The Py service runs the LangGraph state machine
  (dispatcher / classifier / followup / advance nodes, checkpointed in
  Mongo) and returns the assistant's text reply.
- Assistant text (plaintext, possibly with paralinguistics like `[laughter]`,
  `…`, em-dashes — DragonHD voices auto-detect emotion natively, so SSML
  is no longer used) feeds the Speech SDK synthesizer (`speakTextAsync`,
  `Raw24Khz16BitMonoPcm`).
- TTS PCM streams back to the browser as `response.audio.delta` frames
  on the same WS — same frame shape the browser already played from the
  previous Realtime build, so the client's gapless `AudioContext`
  scheduler works unchanged.
- **Barge-in.** Instant — `speech_started` fires as soon as VAD detects
  the user's voice. The server aborts the active synthesizer and emits
  `response.cancelled`; the client flushes its scheduled
  `BufferSource` nodes so Anna stops mid-sentence.

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
  language: string             // BCP-47 locale (e.g. "fi-FI") — drives STT + system-prompt directive
  ttsVoice: string             // Azure voice name — drives the TTS synthesizer
  startedAt, endedAt
  createdAt, updatedAt
}
```

Lifecycle:
- `pending` — row created, no tool calls yet
- `in_progress` — set on the first `get_next_interview_question` call, stamps `startedAt`
- `completed` — set when the tool runs out of questions OR `/end` is called; stamps `endedAt`

### `TranscriptTurn` (implemented, Phase 5)

One completed utterance tied to an `Interview`. We persist **only when an
utterance is final** — no delta buffering:

- user turn      → after the STT debounce window closes and the accumulated
  `pendingUtterance` is consumed by `runAssistantTurn()`
- assistant turn → after the LLM emits its final `content` for the turn,
  before TTS streaming starts

If the WS dies mid-turn, that half-turn is dropped. This keeps the DB clean of
noise and means a stored transcript reflects what was actually recognised
(user) and finalised by the model (assistant).

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

## Realtime session lifecycle (post-migration)

```
 browser                       server                       External services
   │                              │                                 │
   │ POST /api/interviews ───────▶│                                 │
   │   { questionSetId,           │                                 │
   │     language, ttsVoice }     │                                 │
   │◀─────────── { _id } ─────────│                                 │
   │                              │                                 │
   │ WS open ?interviewId=<id> ──▶│ load Interview + QuestionSet    │
   │                              │ open Realtime API WS (STT+VAD)  │
   │                              │ create Speech synthesizer (TTS) │
   │                              │   for interview.ttsVoice        │
   │                              │                                 │
   │                              │ runAssistantTurn() — opening    │
   │                              │   POST /open → Py sidecar       │
   │                              │   ◀──── { assistantText } ──────│
   │                              │   TTS ─ speakTextAsync ────────▶│ (Azure Speech)
   │◀── response.audio.delta ─────│◀──────────── PCM frames ────────│
   │                              │                                 │
   │ input_audio_buffer.append ──▶│ forward to Realtime API WS ────▶│ (GPT Realtime)
   │   (PCM16 24kHz base64)       │                                 │
   │                              │◀─ speech_started (VAD) ─────────│
   │                              │◀─ transcription.completed ──────│
   │                              │   runAssistantTurn(transcript)   │
   │                              │   POST /turn → Py sidecar       │
   │                              │   ◀──── { assistantText } ──────│
   │                              │   TTS chunks ──────────────────▶│ (Azure Speech)
   │◀── response.audio.delta ─────│                                 │
   │                              │                                 │
   │   (user starts speaking)     │◀─ speech_started (instant) ─────│ (GPT Realtime)
   │                              │   → abort current synthesizer   │
   │◀── response.cancelled ───────│                                 │
   │   flush playback buffers     │                                 │
```

Key properties:
- **Session ownership is server-side.** System prompt, audio format —
  authored in `agent/src/agent/prompts.py` + `prompts/anna/`. The browser
  cannot override persona or inject tools.
- **Prompt is modular.** `agent/src/agent/prompts.py` concatenates four
  files from `prompts/anna/` at boot: `persona.md` (voice + silence +
  opening), `mechanics.md` (item delivery, follow-ups, closing),
  `guardrails.md` (ethics, neutrality, de-escalation), `speech.md`
  (natural-speech cues — fillers, ellipses, em-dashes, paralinguistics
  like `[laughter]` that DragonHD voices render natively). Edit a file,
  restart the agent, the new prompt takes effect on the next interview.
- **Native VAD replaces debounce.** The GPT Realtime API's server-side
  VAD (~700ms silence threshold) detects turn boundaries. No hand-rolled
  debounce timer — turns fire as soon as the user stops speaking.
- **Barge-in is instant.** `speech_started` fires the moment the user
  begins speaking. TTS aborts immediately, no waiting for a full
  recognition result.
- **AI greets first.** `runAssistantTurn()` fires immediately on WS
  connect with no user utterance, so Anna speaks the opening before
  the participant says anything.
- **Tool dispatch is sidecar-side.** The Python LangGraph state machine
  (dispatcher / classifier / followup / advance) manages interview flow.
  Node never touches the LLM API.
- **`non-question` items auto-chain.** Items typed `non-question` (intro,
  transition, closing) skip waiting for a user response — the dispatcher
  loops until a question-typed item is emitted.
- **Per-interview language.** `Interview.language` (BCP-47) and
  `Interview.ttsVoice` are set when the participant picks a language on
  the client. `realtime.js` reads them at WS open and passes the voice
  to TTS and the language to the system-prompt directive.

## Python LangGraph agent sidecar

A FastAPI service in `agent/` (uv-managed, Python 3.12) owns the LLM
call, tool dispatch, and Mongo writes for interview-state mutations.
Node keeps STT (via GPT Realtime API), TTS, WS, REST, and transcript
persistence. Wire is HTTP REST, buffered (no token streaming):
`POST /open` on WS connect, `POST /turn` per VAD-detected utterance.
Checkpointer = `MongoDBSaver` against the same Mongo, collection
`agent_checkpoints`, `thread_id = interviewId`.

The previous Node-side LLM + tool loop is archived under `server/legacy/`
for historical reference; it is not imported by the running server.

**Tool parity.** `agent/src/agent/tools.py` mutates the `interviews`
collection with the same semantics the Node v1 path used:
`pending → in_progress + startedAt` on first call, `currentIndex++`,
`completed + endedAt` when exhausted, idempotent on re-call. Node REST
routes still own interview *creation* and `/end`.

**Agent graph.** Deterministic state machine: dispatcher → responder →
classifier → (advance | followup) nodes. The LLM no longer holds the
question index; the graph does. `advance` writes `currentIndex++` only
when the classifier confirms the requirement is satisfied. Followup cap
of 2 prevents infinite loops.

**HTTP contract.**

| Method | Path       | Body                                | Returns                   |
|--------|------------|-------------------------------------|---------------------------|
| GET    | `/healthz` | —                                   | `{ok, port}`              |
| POST   | `/open`    | `{interviewId}`                     | `{assistantText}`         |
| POST   | `/turn`    | `{interviewId, userText}`           | `{assistantText}`         |

`/open` inspects the checkpointed graph state via `get_state`. Empty →
prepend `SystemMessage` from `prompts/anna/` + seed `HumanMessage("begin")`.
Existing → resume nudge, no re-greet (asserts SystemMessage isn't
duplicated). The `get_next_interview_question` tool reads `agent_db`,
`agent_interview_id`, and `agent_question_set` from the per-invoke
`RunnableConfig.configurable`, so the same compiled graph serves every
interview without rebuilds. Errors:

- `404` — interview or question set not found in Mongo.
- `422` — malformed body (Pydantic).
- `502` — graph invocation raised, or final AIMessage was empty.

**Node delegation.** `server/src/realtime.js`'s `runAssistantTurn`
defers entirely to the Py sidecar: `POST /open` on WS connect,
`POST /turn` per VAD-detected utterance. Browser audio-frame contract,
GPT Realtime STT, TTS synth, barge-in via `currentTts.abort`, and
`persistTurn` are unchanged. On Py failure (network, 5xx, timeout) Node
emits `response.error` on the WS and logs loud; **no silent fallback**.

Helper scripts: `agent/scripts/dump_baseline.py` captures a transcript
as a parity baseline; `agent/scripts/bench.py` measures per-turn
latency. Both are user-driven, not part of CI.

## Open questions / decisions deferred

- **Auth** — none in the demo. Revisit if the interviewee surface is ever exposed to untrusted users.
- **Transcript storage format** — landed on cleaned turns in `TranscriptTurn`
  (Phase 5). JSON export / raw-event log can be added later if needed.
- **Tool-call execution** — run inside `realtime.js` on the server, so the model
  never learns about our DB and the browser never sees question text it hasn't
  already received as audio/transcript.
