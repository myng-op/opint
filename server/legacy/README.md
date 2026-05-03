## Archive — anna v1 Node-side LLM + tool loop

Frozen snapshot from `py-langgraph-agent` @ commit before `anna-v2` Phase 15.0.
This directory is **not imported** by the running server. Its purpose is read-only
historical reference for the v1 path:

- `realtime-v1.js` — the Node WebSocket proxy when `USE_PY_AGENT` was a flag,
  including `chatCompletion()` and the in-process tool loop in `runAssistantTurn`.
- `tools-v1.js` — Node-side tool dispatcher (`get_next_interview_question`).
- `session-v1.js` — Node-side prompt assembly + tool-schema helper.
- `ssml-v1.js` — SSML translator for Azure DragonHD (was already a no-op
  passthrough — `realtime-v1.js` only used `stripTags`, not `buildSSML`).

Imports inside these files reference paths from when they lived under
`server/src/`. They are intentionally not rewritten — these files are not
expected to run.

Recovery path: `git log --follow server/legacy/realtime-v1.js` ties back to
the `py-langgraph-agent` history.
