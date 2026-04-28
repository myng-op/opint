# opint — Project Manifest

Living state file for the AI Social Worker Interview System. Updated only at
phase boundaries per `meta/behaviour.md` §4.

## Current Plan (next 3 phases)

Phases 0–7 of the original roadmap (voice scaffold, foundations, schema +
seeder, interview lifecycle + tool calling, debug logging, transcript
persistence, review surface, Anna avatar UI) are complete. The April 22
STT→LLM→TTS migration (Phases A–E in `archive/logs.md`) is also complete and
stable. The roadmap from here:

### Phase 8 — UI overhaul (op.fi-adjacent)

Strip the marketing-hero feel, replace with restrained, trustworthy,
generous-whitespace styling closer to op.fi while keeping enough warmth that a
vulnerable participant doesn't feel they walked into a bank login screen.

- **8.1 Re-theme tokens (landing only).** Flat OP-orange on near-white,
  `shadowSoft` instead of `shadowWarm`, drop the multi-radial gradient.
  Stage tokens deferred to 8.3.
- **8.2 Landing restraint.** OP logo top-left, single clean headline, one
  supporting line, one flat CTA. Drop italic gradient headline, eyebrow
  caps, floating chip row.
- **8.3 Single-column stage.** Collapse two-column glass layout. White
  circle (Anna face / mic glyph swap driven by analyser amplitudes),
  pulsating ring scaled by amplitude, caption underneath. Decide whether
  to gut `Orb.jsx` or replace with `InterviewerAvatar.jsx`.
- **8.4 Progress rail, subtitle band, controls.** Horizontal traveler dot
  driven by `Interview.currentIndex` (needs new WS event from server),
  single-line subtitle showing only Anna's current question, Pause + End
  controls.

### Phase 9 — Participant study flow

Shift the landing from "Meet Anna" to a participant dashboard with sequential
module unlock: Consent → Interview → Surveys → Self-consistency retake.
Module 4 additionally time-gated to unlock 2 weeks after Module 3.

- 9.1 Dashboard shell (in-memory state).
- 9.2 Consent module (placeholder PDF + consent button).
- 9.3 Interview as Module 2.
- 9.4 Identity + persistence (deferred — defines auth + `Participant` model).

### Phase 10 — Test infrastructure (NEW, blocks new work)

Stand up the test harness `behaviour.md` §3 demands. Currently zero tests in
either `client/` or `server/` — every line of new feature code from here on
owes a test, so the harness must exist before Phase 8 starts. Vitest for
client (Vite-native), node `--test` or vitest for server. Real Mongo via
Docker, no DB mocks. First targets: `realtime/tools.js` dispatch,
`session.js` language directive, `realtime.js` debounce + barge-in, the
question-set REST routes.

### Phase 11 — Python LangGraph agent sidecar (experimental, branch only)

Lives on branch `py-langgraph-agent`, ring-fenced behind `USE_PY_AGENT=true`.
Goal: prove the plumbing for (a) a graph-shaped agent (ready for branching
when `Question.condition` lands) and (b) durable resumable state via a Mongo
checkpointer. Secondary win: LangSmith tracing on Anna's persona.
"Fat Py" split — Python owns graph + tool dispatch + Mongo writes (raw
`pymongo`); Node keeps STT/TTS/WS/REST. Wire = HTTP REST, buffered:
`POST /open` + `POST /turn`. Plan in `~/.claude/plans/crystalline-sauteeing-treehouse.md`.

- 11.0 Branch + `agent/` skeleton (uv, FastAPI `/healthz`, dockerised). **Done.**
- 11.1 Move Anna persona to `prompts/anna/` at repo root, dual reader (Node + Py). **Done.**
- 11.2 Mongo client + bit-exact `get_next_interview_question` parity in Py. **Done.**
- 11.3 `MongoDBSaver` wired, `thread_id = interviewId`. **Done.**
- 11.4 ReAct graph (agent + tools nodes, messages-only state). **Done.**
- 11.5 FastAPI `/open` + `/turn` endpoints. **Done.**
- 11.6 Node-side cutover behind `USE_PY_AGENT`, fail-loud on Py down. **Done (code); manual smoke pending.**
- 11.7 DoD verification (parity / resume / latency) + LangSmith. **Done (code); user manual steps remain.**

DoD-gate status (Phase 11.7):
- Gate 2 (resume): regression-locked by `test_resume_preserves_state_and_does_not_replay_questions` — currentIndex + checkpointer state preserved across simulated drop, Anna doesn't replay q1.
- Gate 1 (parity): structural baseline-capture script at `agent/scripts/dump_baseline.py`. **User action**: run a Node-path interview with `USE_PY_AGENT=false`, then run the dumper to write `agent/tests/fixtures/sample_baseline.json`. Py-path parity assertion against that fixture is a follow-up.
- Gate 3 (latency): `agent/scripts/bench.py` gated by `BENCH_LIVE=1`. **User action**: run on Node + Py paths, compare p95.
- LangSmith: `configure_langsmith` wired at FastAPI startup; service still boots without creds. **User action**: set `LANGSMITH_TRACING=true` + key, eyeball the LangSmith dashboard for traces.

DoD gates: parity (turn count + role sequence vs captured Node baseline),
resume (WS drop → reconnect → no repeated question), latency p95 ≤ 1.5×
Node. v2 branching pilot is **out of scope** for this branch.

## Project State

**Built features.** Voice interview pipeline running on three Azure services:
Azure Speech (STT, streaming recognition with 1.5s debounce on the
`recognized` event), Azure AI Foundry Chat Completions (LLM, deployment
behind `AZURE_AI_DEPLOYMENT`), Azure Speech (TTS, plaintext sent to
DragonHD voices for English/Chinese, standard Neural voices for other
locales). The browser↔Node WebSocket carries the same audio frame contract
as the original Azure Realtime build (PCM16 24kHz, base64-chunked deltas),
so the client was unchanged across the migration. Mongo persists three
collections: `QuestionSet` (seeded from `interviews/*.json`), `Interview`
(lifecycle: pending → in_progress → completed, with `currentIndex` state
machine), `TranscriptTurn` (per-utterance, persisted on completion events
only — half-turns dropped if the WS dies). Anna's persona is assembled at
boot from four markdown files in `prompts/anna/`
(persona, speech, mechanics, guardrails) — same source-of-truth read by
both the Node path and the Python LangGraph sidecar. Per-interview language selection
covers seven locales (English, Finnish, Swedish, Chinese, Arabic, Somali,
Vietnamese) and routes both STT locale and TTS voice. UI: gradient orb
avatar with idle drift + speaking pulse, hide/show transcript, plus an
unlinked `/review` surface for replaying past interviews.

**File structure.** Backend in `server/src/`: `index.js` (HTTP+WS entry),
`config.js` (env validation, fail-fast at boot), `realtime.js` (the
STT→LLM→TTS pipeline + tool loop + barge-in), `realtime/session.js`
(system-prompt assembly + tool schema), `realtime/tools.js`
(`get_next_interview_question` handler),
`models/{QuestionSet,Interview,TranscriptTurn}.js`,
`routes/{questionSets,interviews}.js`, `seed.js`, `logging.js`. Frontend
in `client/src/`: `routes/{Interview,Review,ReviewDetail}.jsx`, shared
`theme.js`, `components/`. Repo-root: `docker-compose.yml` (Mongo),
`interviews/*.json` (seed data), `icons/` (SVGs — use these, do not
author inline), `meta/` (this file + `behaviour.md` + `archive/` — dev/process docs),
`prompts/anna/` (Anna runtime persona — read by both Node and the Py
LangGraph sidecar).

**Where we are.** Demo-ready end-to-end. The pipeline is stable after the
April 22 bugfix batch (silent-TTS / double-response / STT-disconnect
fixes). Outstanding scope: Phase 8 UI overhaul has not started; Phase 9
participant flow has not started; test infrastructure is absent. Currently
on branch `stt-llm-tts-pipeline`, ahead of `origin/stt-llm-tts-pipeline`
by one commit. A WIP stash holds in-progress edits to
`client/src/routes/Interview.jsx` and `interviews/sample_interview.json`
that pre-date this cleanup.

## Technical Debt

1. **Zero test coverage** — blocks `behaviour.md` §3 TDD requirement for
   any new code. Phase 10 above stands up the harness.
2. **`server/src/realtime/ssml.js` is dead code.** Used briefly in Phase E,
   abandoned when the DragonHD plaintext path landed. Still on disk, no
   longer imported. Delete, or revive only if a non-DragonHD voice path
   returns.
3. **`Question.condition` is in the schema but unused.** Branching /
   conditional questions designed but never wired up.
4. **No auth.** Anyone with the URL can start an interview. Acceptable for
   internal demo only; revisit before any external exposure.
5. **No production deploy story.** Local-only via Docker Compose; no
   Atlas / cloud target chosen yet.
6. **`meta/PROMPTS.md`** — historical prompt log not formally required
   by current `behaviour.md`. Decision (keep / archive / delete) deferred.
