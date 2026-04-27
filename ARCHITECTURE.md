# Architecture

Plain-English explanation of how the system fits together. Kept short on purpose —
updated as each phase lands.

## High-level data flow

```
┌─────────────┐   WS    ┌──────────────┐   HTTPS    ┌──────────────────────────┐
│  React UI   │ ──────▶ │  Node proxy  │ ─────────▶ │  Azure AI Foundry        │
│ (browser)   │ ◀────── │  + REST API  │ ◀───────── │   (Chat Completions LLM) │
└─────────────┘         └──┬───────┬───┘            └──────────────────────────┘
                           │       │  WSS/HTTPS     ┌──────────────────────────┐
                           │       └──────────────▶ │  Azure Speech            │
                           │           ◀────────────│   (streaming STT + TTS)  │
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
- The server orchestrates three Azure services per turn: incoming PCM
  feeds the Speech SDK recognizer (STT); the recognized utterance feeds
  Chat Completions (LLM); the LLM's text reply feeds the Speech SDK
  synthesizer (TTS); the resulting PCM streams back to the browser.
- REST endpoints on the same Node process handle CRUD for question sets,
  interview lifecycle, and transcript reads.

## Why these libraries

| Choice                                  | Why                                                                       |
|-----------------------------------------|---------------------------------------------------------------------------|
| Express                                 | Smallest viable HTTP framework; no opinions to fight.                     |
| `ws`                                    | Standard Node WS lib for the browser↔server bridge.                       |
| `microsoft-cognitiveservices-speech-sdk`| Streaming STT + TTS in one package; `PushAudioInputStream` lets us feed it the same PCM frames the browser sends. |
| `fetch` (native)                        | LLM step is a single HTTPS call to Azure AI Foundry — no SDK needed.      |
| Mongoose                                | Schema validation + model methods; makes the data model explicit.         |
| Vite                                    | Fast dev server, native ESM, simple WS proxy config.                      |
| React Router                            | Multi-route shell (`/`, `/review`, `/review/:id`).                        |
| Docker Compose                          | Disposable Mongo for dev; one command up/down, no host pollution.         |

## Audio pipeline

- Browser captures mic at 24 kHz mono via `AudioContext`. Float32 → Int16 PCM
  → base64, sent as `input_audio_buffer.append` events on the WS.
- Server pushes incoming PCM into a Speech SDK `PushAudioInputStream` that
  feeds a continuous `SpeechRecognizer` (STT). Endpointing is handled by the
  recognizer itself, not by the browser.
- The recognizer's `recognized` event fires on each silence gap. A 1.5 s
  debounce (`RECOGNIZE_DEBOUNCE_MS`) accumulates fragments into a
  `pendingUtterance` so a single sentence with mid-thought pauses doesn't
  trigger multiple LLM turns.
- After debounce, `runAssistantTurn()` calls Chat Completions (LLM) with
  the system prompt + transcript history + the new utterance. The tool
  loop iterates up to 20 times: the model can call
  `get_next_interview_question`, the server resolves it against Mongo,
  and the loop continues until the model emits text content.
- LLM text (plaintext, possibly with paralinguistics like `[laughter]`,
  `…`, em-dashes — DragonHD voices auto-detect emotion natively, so SSML
  is no longer used) feeds the Speech SDK synthesizer (`speakTextAsync`,
  `Raw24Khz16BitMonoPcm`).
- TTS PCM streams back to the browser as `response.audio.delta` frames
  on the same WS — same frame shape the browser already played from the
  previous Realtime build, so the client's gapless `AudioContext`
  scheduler works unchanged.
- **Barge-in.** When the recognizer fires `recognized` while TTS is
  speaking, the server aborts the active synthesizer and emits
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
 browser                       server                       Azure (Speech + AI Foundry)
   │                              │                                 │
   │ POST /api/interviews ───────▶│                                 │
   │   { questionSetId,           │                                 │
   │     language, ttsVoice }     │                                 │
   │◀─────────── { _id } ─────────│                                 │
   │                              │                                 │
   │ WS open ?interviewId=<id> ──▶│ load Interview + QuestionSet    │
   │                              │ build system prompt             │
   │                              │ create Speech recognizer (STT)  │
   │                              │   for interview.language        │
   │                              │ create Speech synthesizer (TTS) │
   │                              │   for interview.ttsVoice        │
   │                              │                                 │
   │                              │ runAssistantTurn() — opening    │
   │                              │   LLM ─ Chat Completions ──────▶│
   │                              │   ◀───────────────── tool_call ─│
   │                              │   resolve tool against Mongo    │
   │                              │   LLM (loop) ──────────────────▶│
   │                              │   ◀──────── content (greeting) ─│
   │                              │   TTS ─ speakTextAsync ────────▶│
   │◀── response.audio.delta ─────│◀──────────── PCM frames ────────│
   │                              │                                 │
   │ input_audio_buffer.append ──▶│ push into recognizer's stream   │
   │   (PCM16 24kHz)              │                                 │
   │                              │ STT recognized event            │
   │                              │   debounced 1.5 s →             │
   │                              │   runAssistantTurn(utterance)   │
   │                              │   LLM (loop, max 20 iter) ─────▶│
   │                              │   ◀──── tool_calls / content ───│
   │                              │   TTS chunks ──────────────────▶│
   │◀── response.audio.delta ─────│                                 │
   │                              │                                 │
   │   (user starts speaking)     │ STT recognized while TTS active │
   │                              │   → abort current synthesizer   │
   │◀── response.cancelled ───────│                                 │
   │   flush playback buffers     │                                 │
```

Key properties:
- **Session ownership is server-side.** System prompt, tool schema, audio
  format — all authored in `server/src/realtime/session.js`. The browser
  cannot override persona or inject tools.
- **Prompt is modular.** `session.js` concatenates four files from
  `server/src/realtime/prompts/` at boot: `persona.md` (voice + silence +
  opening), `mechanics.md` (tool usage, follow-ups, closing),
  `guardrails.md` (ethics, neutrality, de-escalation), `speech.md`
  (natural-speech cues — fillers, ellipses, em-dashes, paralinguistics
  like `[laughter]` that DragonHD voices render natively). Edit a file,
  restart the server, the new prompt takes effect on the next WS
  connection.
- **STT debounce is 1.5 s.** `RECOGNIZE_DEBOUNCE_MS` accumulates
  fragmentary `recognized` events into a single utterance so a thoughtful
  participant who pauses mid-sentence doesn't trigger multiple LLM turns.
- **STT recognizer is rebuildable.** If the recognizer enters
  `Disconnected`, `rebuildRecognizer()` creates a fresh SDK instance +
  push stream rather than restarting the same one (the SDK's restart
  path was unreliable in our testing).
- **AI greets first.** `runAssistantTurn()` fires immediately on WS
  connect with no user utterance, so Anna speaks the opening before
  the participant says anything.
- **Tool dispatch is server-side.** Chat Completions returns a
  `tool_calls` array; the server runs each call against Mongo (advancing
  `Interview.currentIndex`) and feeds the results back into the next
  iteration of the LLM loop.
- **`non-question` items auto-chain.** Items typed `non-question` (intro,
  transition, closing) skip waiting for a user response — the loop
  continues until a question-typed item is emitted.
- **Questions are pulled, not pushed.** The model decides when it's
  satisfied and calls `get_next_interview_question` — we never push
  question text into the conversation unilaterally.
- **Per-interview language.** `Interview.language` (BCP-47) and
  `Interview.ttsVoice` are set when the participant picks a language on
  the client. `realtime.js` reads them at WS open and passes them to
  STT, TTS, and the system-prompt language directive.

## Open questions / decisions deferred

- **Auth** — none in the demo. Revisit if the interviewee surface is ever exposed to untrusted users.
- **Transcript storage format** — landed on cleaned turns in `TranscriptTurn`
  (Phase 5). JSON export / raw-event log can be added later if needed.
- **Tool-call execution** — run inside `realtime.js` on the server, so the model
  never learns about our DB and the browser never sees question text it hasn't
  already received as audio/transcript.
