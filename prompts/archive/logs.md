# Change log

Append-only. Newest at the bottom.

---

**2026-04-22 — Phase A: Config + Speech SDK**

- Restructured `server/src/config.js`: added `config.llm`, `config.stt`, `config.tts` groups for the new STT→LLM→TTS pipeline. Legacy `config.azure` kept until Phase C.
- Added `microsoft-cognitiveservices-speech-sdk` to `server/package.json`.
- New `.env` vars: `AZURE_AI_ENDPOINT`, `AZURE_AI_KEY`, `AZURE_AI_DEPLOYMENT`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `AZURE_TTS_VOICE`.
- Voice fix: `.env` had `AZURE_TTS_VOICE=sv-SE-HedvigNeural` — that voice doesn't exist on Azure Neural TTS. Swedish options are `sv-SE-SofieNeural`, `sv-SE-MattiasNeural`, `sv-SE-HilleviNeural`. For DragonHD quality, must use `en-US-*:DragonHDLatestNeural` voices (e.g. Ava, Andrew, Emma). User to pick final voice.
- Default in `config.js` remains `en-US-JennyMultilingualNeural` if env var is unset.
- Server boots successfully; all three `[config]` log lines print non-empty values.

**2026-04-22 — Phase B: Refactor session.js exports**

- `server/src/realtime/session.js`: removed `buildSessionConfig()` (Azure Realtime shape), `SAMPLE_RATE`, `SILENCE_DURATION_MS`. Added `getSystemPrompt()` and `getToolDefinition()` (Chat Completions tool shape).
- `server/src/realtime.js`: updated import; inlined the Azure Realtime session payload so the legacy bridge keeps working until Phase C.
- `.env`: fixed `AZURE_TTS_VOICE` to `en-US-Ava:DragonHDLatestNeural`.
- Server boots cleanly. Legacy Realtime bridge still functional but Azure upstream drops connections mid-session (code 1006) — confirms urgency of Phase C.

**2026-04-22 — Phase C: Rewrite realtime.js as STT→LLM→TTS pipeline**

- `server/src/realtime.js`: complete rewrite (~300 lines). Removed Azure Realtime upstream WS, `buildUpstreamUrl`, `describeEvent` import, `VOICE` const, `inFlightResponse`/`toolOutputReady` state machine. Added:
  - `createRecognizer()` — Speech SDK continuous STT on `PushAudioInputStream` (PCM16 24kHz mono).
  - `chatCompletion()` — fetch-based Azure AI Foundry Chat Completions with 30s timeout, detailed logging (elapsed ms, finish_reason, content preview).
  - `synthesizeAndStream()` — Speech SDK TTS (`Raw24Khz16BitMonoPcm`), chunks audio back as `response.audio.delta` frames.
  - `runAssistantTurn()` — LLM + tool loop (max 8 iterations), calls `handleToolCall` unchanged.
  - Barge-in: STT `recognized` event aborts `currentTts` and sends `response.cancelled`.
  - Opening greeting: `runAssistantTurn()` fires immediately on WS connect (Anna speaks first).
- `server/src/config.js`: removed `config.azure` block and legacy `AZURE_ENDPOINT`/`AZURE_API_KEY`/`AZURE_REALTIME_MODEL` from required vars + log output.
- Bug fix: LLM endpoint URL construction stripped `/openai/v1` suffix from configured endpoint so Azure path resolves correctly (`/openai/deployments/{dep}/chat/completions`).
- Browser frame contract preserved exactly — no client changes needed. `tools.js`, `session.js`, `index.js` unchanged.
- Verified: STT transcribes user speech, LLM responds, TTS plays audio back to browser.

**2026-04-22 — Phase D: Client barge-in handling**

- `client/src/routes/Interview.jsx`: added `activeSourcesRef` to track scheduled `BufferSource` nodes. New `flushPlayback()` stops all queued sources and resets `playTimeRef` so Anna's voice cuts immediately on barge-in. `response.cancelled` frame triggers `flushPlayback()`. Sources auto-remove from the array via `onended`.

**2026-04-22 — Phase E: SSML translator**

- New file `server/src/realtime/ssml.js`: translates LLM output cues into valid Azure SSML for DragonHD voices.
  - `<break time="..."/>` → passthrough (supported on DragonHD).
  - `<emotion value="..."/>` → stripped (DragonHD auto-detects emotion from text content; `<mstts:express-as>` is NOT supported on DragonHD, only on DragonHD Omni).
  - `[laughter]` → `<break time="200ms"/>` (no explicit laughter primitive on DragonHD).
  - Bare `&` escaped. Output wrapped in `<speak><voice name="...">` envelope.
- `server/src/realtime.js`: imported `buildSSML`, switched TTS from `speakTextAsync` to `speakSsmlAsync` with the generated SSML.
- Server boots cleanly. SSML length logged per TTS call for debugging.

**2026-04-22 — Bugfix batch: silent TTS, double responses, STT disconnects**

- SSML escaping: LLM output containing `<`, `>` broke the XML envelope → added full XML entity escaping. Root cause of silent TTS after ~3 questions.
- Turn concurrency guard: added `turnRunning`/`turnQueued` with drain in `finally` to prevent overlapping `runAssistantTurn()` calls.
- TTS error recovery: added `response.done` in TTS error path so client doesn't hang waiting.
- STT debounce: Azure `recognized` fires on every silence gap → added 1.5s `RECOGNIZE_DEBOUNCE_MS`, accumulates fragments in `pendingUtterance` before triggering LLM.
- STT reconnect: recognizer enters irrecoverable "Disconnected" state → `rebuildRecognizer()` creates fresh SDK instance + push stream instead of restarting the same one.

**2026-04-22 — Bugfix: non-question auto-continue + LLM improvisation**

- Non-question items (intro, transition, closing) weren't chaining — loop exited after every text response. Added `lastItemType` tracking; `continue` when type is `non-question`.
- LLM improvised questions instead of calling the tool. Added server-side `forceToolCall` when `lastItemRequirement` is empty (forces `tool_choice` to named function). Added `mechanics.md` section "The tool is your ONLY source of questions".
- LLM timeout bumped from 30s to 60s for chained non-question turns.
- Max tool iterations bumped from 8 to 20.

**2026-04-22 — Switch to plaintext TTS**

- DragonHD auto-detects emotion and renders `[laughter]`/`[sigh]` natively from plaintext — SSML unnecessary.
- `realtime.js`: removed `buildSSML` import, added `stripTags()` to clean residual XML, switched from `speakSsmlAsync(ssml)` to `speakTextAsync(cleanText)`.
- `speech.md`: removed all XML tags (`<break>`, `<emotion>`). Pauses now use `...` (ellipsis) and `—` (em-dash). Paralinguistics kept as-is (`[laughter]`, `[sigh]`).
- `ssml.js` still exists on disk but is no longer imported.

**2026-04-22 — Prompt hardening: improvisation + non-question embellishment**

- `persona.md`: replaced unconditional "ask thoughtful follow-ups" with scoped version — follow-ups only when requirement warrants it, never invent own questions.
- `mechanics.md`: hardened `non-question` rule — must NOT add questions, commentary, elaborations, or anything beyond the `content`. Must not use content as springboard for own thoughts.
- `mechanics.md`: added rule that participant questions are answered first, before calling the tool.

**2026-04-22 — Bugfix: inline content dropped + forced skip of user response**

- LLM returns both `content` and `tool_calls` for non-question items (speaks the text while calling tool for next item). Code treated them as mutually exclusive → q2/q3 content was silently dropped. Fix: speak inline content via TTS before processing tool calls.
- `forceToolCall` on empty requirement caused q1 (greeting, qualitative, empty requirement) to skip waiting for user response. Fix: removed `forceToolCall` for question items entirely — only `non-question` auto-continues (already handled by `lastItemType` check).

**2026-04-22 — Per-interview language selection (multilingual pipeline)**

- `Interview.js` model: added `language` (BCP-47 locale) and `ttsVoice` fields.
- `POST /api/interviews`: accepts `language` and `ttsVoice` from client.
- `realtime.js`: reads `interview.language`/`interview.ttsVoice` at WS connect time. Passes to `createRecognizer()` (STT locale), `createSynthesizer()` (TTS voice), and `getSystemPrompt()` (language directive).
- `session.js`: `getSystemPrompt(language)` appends a `# Language` section for non-English locales using `Intl.DisplayNames` to resolve locale → language name.
- `Interview.jsx`: new `language` phase between dashboard and stage. Grid of 7 language buttons: English (en-US), Suomi (fi-FI), Svenska (sv-SE), 中文 (zh-CN), العربية (ar-SA), Soomaali (so-SO), Tiếng Việt (vi-VN).
- Voice map: DragonHD for en-US (`Ava`) and zh-CN (`Xiaochen`), standard Neural for fi-FI (`Noora`), sv-SE (`Sofie`), ar-SA (`Zariyah`), so-SO (`Ubax`), vi-VN (`HoaiMy`).
- CSS fix: replaced `border` shorthand with `borderWidth`/`borderStyle`/`borderColor` to avoid React warning when toggling `borderColor` on selected state.
- QuestionSet `language`/`ttsVoice` fields added then reverted — language is a participant choice, not a question set property.
