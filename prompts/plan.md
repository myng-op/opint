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

### ✅ Phase 6 — review surface

`/review` (list of interviews) and `/review/:id` (transcript playback).
Unlinked from `/` on purpose — type the URL to reach it. Snapshot on load +
manual Refresh button; no polling. Uses `GET /api/interviews` and
`GET /api/interviews/:id/transcript`.

### ✅ Phase 7 — Anna UI

Gradient orb avatar (warm Nordic orange — `#EE5A00`), idle drift + speaking
pulse (triggered by incoming audio deltas). Transcript panel visible by
default with a hide/show toggle. Shared `theme.js` keeps `/review/*` and `/`
visually coherent.

### ⏳ Phase 8 — UI overhaul (op.fi-adjacent, not fully corporate)

Goal: strip the "flashy marketing hero" feel and replace it with something
closer to op.fi — restrained, trustworthy, generous whitespace — while
keeping enough warmth that a vulnerable elderly participant doesn't feel
they've walked into a bank login screen. Flat OP-orange on near-white,
one accent per view, soft shadows instead of radial atmospheres.

The audio plumbing (WebSocket, `annaAnalyserRef`, `userAnalyserRef`, rAF
amplitude loop) is preserved throughout — only the visual wrapper changes.

#### 8.1 — Re-theme tokens (landing only)

Swap `landingAtmosphere` from the multi-radial peach/ink gradient to a
near-white linear gradient (`#FFFFFF` → `theme.bg`). Replace `primaryButton`'s
gradient fill with flat `theme.primary`, and drop `shadowWarm` for
`shadowSoft` so the button doesn't scream. Keep `theme.primary = #EE5A00`,
pill radius, and all text tokens. `stageAtmosphere` is **deferred to 8.3** —
flipping the stage to light surface now would render the existing cream-text
stage unreadable, and 8.3 rebuilds the stage anyway.

#### 8.2 — Landing restraint

Drop the italic gradient "Meet Anna" headline, the eyebrow caps, and the
floating chip row. Replace with an op.fi-style hero: OP logo (from
`/icons/OP_logo.png`) top-left, a single clean headline, one short
supporting line, one flat CTA. Centered, lots of whitespace, no animation
beyond a gentle fade-in.

#### 8.3 — Single-column stage

Collapse the two-column glass layout to one centered column. Delete
`transcriptCard`. Stage contents, top to bottom:

- **White circle** (soft drop shadow, not glass). Contains either
  `/icons/female_face.svg` (Anna's turn) or a microphone glyph
  (participant's turn). Swap driven by which analyser currently has the
  higher recent amplitude — Anna's audio deltas trigger her turn; mic
  activity triggers participant's turn.
- **Pulsating ring** around the circle, radius scaled by the active
  analyser's amplitude (same rAF loop as today's Orb, just rendering a
  ring instead of a blob). This is where the kept warmth lives.
- **Caption** under the circle: "Anna is listening" / "Your turn" / etc.

`Orb.jsx` either gets gutted to render the ring+circle, or is replaced
by a new `InterviewerAvatar.jsx`. Decision deferred until 8.3 lands —
depends on how much of the existing rAF code is worth keeping.

#### 8.4 — Progress rail, subtitle band, controls

- **Progress rail.** A thin horizontal line with a traveler dot moving
  from left to right as `currentIndex` advances through the question
  set. Source of truth is `Interview.currentIndex` /
  `QuestionSet.questions.length`. Needs the server to push index
  updates to the client — likely a new WS event emitted after the
  `get_next_interview_question` tool call resolves, so we don't poll.
- **Subtitle band.** Single-line strip showing **only** Anna's current
  question — nothing else (no prior turns, no participant input).
  Positioned **directly under the orb**, above the progress rail and
  controls. Clears when Anna finishes speaking; re-populates on her
  next turn.
- **Controls.** Pause button (suspend mic + playback without tearing
  down the WS) and End button. Subtitle toggle if we decide subtitles
  should be optional.

### ⏳ Phase 9 — Participant study flow

Shift the landing from a "Meet Anna" marketing hero to a **participant
dashboard** showing the study's modules, with sequential unlock. The
participant works through the dashboard, not a single standalone
interview. Phase 8's visual tokens (logo, restrained type, flat CTA)
are reused — only the landing's content shape changes.

Modules (in order):

1. **Study consent** — participant reads + signs consent before anything
   else is available.
2. **Interview** — the existing Anna realtime flow.
3. **Surveys and experiments** — design-only for Phase 9; visibly locked.
4. **Self-consistency retake** — repeats module 3 to measure
   consistency over time. Design-only for Phase 9; additionally
   time-gated to unlock **two weeks after module 3 is completed**.

Each module card shows: number, title, short description, status
(locked / available / in progress / completed), and a Start button.
The button is disabled until every prior module is completed; for
module 4, the 2-week clock from module 3's completion timestamp must
also have elapsed.

#### 9.1 — Dashboard shell (in-memory state)

Replace the `Landing` component content with a dashboard of four
module cards. Completion state lives in React component state only
— no persistence across reloads yet. Modules 1 and 2 are interactive;
3 and 4 are permanently locked ("Coming soon") with their unlock
rules shown as copy on the card. Reuses the op.fi-adjacent tokens
from Phase 8 (OP logo top-left, flat orange button, near-white bg).

#### 9.2 — Consent module (placeholder)

New view that embeds a **placeholder signed PDF** plus an "I consent"
button. Clicking marks module 1 complete in the dashboard state and
returns to the dashboard. No backend yet — just a stub so the unlock
flow is clickable end-to-end.

#### 9.3 — Interview as module 2

Starting the interview from the dashboard launches the existing
stage flow (untouched here — the stage redesign is still Phase 8.3).
Ending the interview returns to the dashboard and marks module 2
complete.

#### 9.4 — Identity + persistence (deferred)

Login / signup, a `Participant` model, and durable module state so
a participant can close the tab and return without losing progress.
Scope to be defined when we reach it. Until this lands, any reload
resets the dashboard — acceptable for internal demo only.

## Deferred / open

- **Auth.** None in the demo. Revisit before exposing to untrusted users.
- **Admin surface.** Deleted in Phase 5 pre-work; may return as Phase 6.
- **Atlas / prod deployment.** Currently local-only via Docker Compose.
- **Branching / conditional questions.** `Question.condition` is in the
  schema but not wired up anywhere yet.
