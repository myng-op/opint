// STT → LLM → TTS pipeline. Replaces the Azure Realtime WS proxy.
//
// Per-connection flow:
//   1. Browser opens WS with ?interviewId=<id>. We validate Interview + QuestionSet.
//   2. Azure Speech SDK SpeechRecognizer receives streaming PCM16 from the browser
//      via a PushAudioInputStream. When a final recognition fires, we call the LLM.
//   3. LLM (Azure AI Foundry Chat Completions) processes conversation history +
//      tool definitions. Tool calls loop until the model produces final text.
//   4. Azure Speech SDK SpeechSynthesizer converts the text to PCM16 audio and
//      streams it back to the browser in the same frame format the client already expects.
//
// Frame contract with the browser (unchanged from the Realtime era):
//   Browser → server: { type: 'input_audio_buffer.append', audio: '<base64 PCM16>' }
//   Server → browser: { type: 'response.audio.delta', delta: '<base64 PCM16>' }
//                      { type: 'response.audio_transcript.delta', delta: '...' }
//                      { type: 'response.audio_transcript.done', transcript: '...' }
//                      { type: 'conversation.item.input_audio_transcription.completed', transcript: '...' }
//                      { type: 'response.cancelled' }   (barge-in)

import { WebSocket, WebSocketServer } from 'ws';
import sdk from 'microsoft-cognitiveservices-speech-sdk';
import { config } from './config.js';
import { Interview } from './models/Interview.js';
import { QuestionSet } from './models/QuestionSet.js';
import { TranscriptTurn } from './models/TranscriptTurn.js';
import { getSystemPrompt, getToolDefinition } from './realtime/session.js';
import { handleToolCall } from './realtime/tools.js';

// Strip SSML-like tags the LLM may still emit. DragonHD auto-detects
// emotion and paralinguistics from plaintext — we just need clean text.
function stripTags(text) {
  return text
    .replace(/<emotion\s+value="[^"]*"\s*\/?>/gi, '')
    .replace(/<\/emotion\s*>/gi, '')
    .replace(/<break\s+[^>]*\/>/gi, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let cidCounter = 0;
function nextCid() { cidCounter = (cidCounter + 1) % 1000; return `cid${cidCounter.toString().padStart(3, '0')}`; }

function send(client, obj) {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(obj));
}

function b64ToInt16(b64) {
  const bin = Buffer.from(b64, 'base64');
  return new Int16Array(bin.buffer, bin.byteOffset, bin.byteLength / 2);
}

function bufferToBase64(buf) {
  return Buffer.from(buf).toString('base64');
}

// ---------------------------------------------------------------------------
// LLM — Azure AI Foundry Chat Completions via fetch
// ---------------------------------------------------------------------------

async function chatCompletion(messages, tools, toolChoice = 'auto') {
  // Azure OpenAI expects: {host}/openai/deployments/{dep}/chat/completions
  // Strip any trailing path segments like /openai/v1 from the configured endpoint.
  const base = config.llm.endpoint.replace(/\/openai\/v\d+\/?$/, '').replace(/\/$/, '');
  const url =
    `${base}/openai/deployments/${config.llm.deployment}` +
    `/chat/completions?api-version=${config.llm.apiVersion}`;
  const body = { messages, tools, tool_choice: toolChoice };
  console.log(`[llm] POST ${url} messages=${messages.length} tools=${tools.length} tool_choice=${JSON.stringify(toolChoice)}`);
  const started = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': config.llm.apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000), // 60s hard timeout
  });
  const elapsed = Date.now() - started;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM ${res.status} (${elapsed}ms): ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const choice = json.choices?.[0];
  console.log(
    `[llm] ← ${res.status} (${elapsed}ms) finish=${choice?.finish_reason}` +
    (choice?.message?.tool_calls ? ` tool_calls=${choice.message.tool_calls.length}` : '') +
    (choice?.message?.content ? ` content="${choice.message.content.slice(0, 80)}…"` : '')
  );
  return json;
}

// ---------------------------------------------------------------------------
// STT — Azure Speech SDK continuous recognition on a PushAudioInputStream
// ---------------------------------------------------------------------------

function createRecognizer(cid, { language } = {}) {
  const lang = language || config.stt.language;
  const speechConfig = sdk.SpeechConfig.fromSubscription(config.stt.key, config.stt.region);
  speechConfig.speechRecognitionLanguage = lang;
  // 16-bit PCM mono 24 kHz — matches the browser's capture format.
  const format = sdk.AudioStreamFormat.getWaveFormatPCM(24000, 16, 1);
  const pushStream = sdk.AudioInputStream.createPushStream(format);
  const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
  const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
  console.log(`[rt ${cid}] STT recognizer created lang=${lang}`);
  return { recognizer, pushStream };
}

// ---------------------------------------------------------------------------
// TTS — Azure Speech SDK synthesizer (PCM16 24kHz mono)
// ---------------------------------------------------------------------------

function createSynthesizer({ voice } = {}) {
  const v = voice || config.tts.voice;
  const speechConfig = sdk.SpeechConfig.fromSubscription(config.tts.key, config.tts.region);
  // Raw PCM 24kHz 16-bit mono — same format the browser expects.
  speechConfig.speechSynthesisOutputFormat =
    sdk.SpeechSynthesisOutputFormat.Raw24Khz16BitMonoPcm;
  speechConfig.speechSynthesisVoiceName = v;
  // null audioConfig = pull mode (we pull the audio stream ourselves)
  return new sdk.SpeechSynthesizer(speechConfig, null);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function attachRealtimeProxy(httpServer) {
  const wss = new WebSocketServer({ server: httpServer });
  console.log('[rt] WebSocketServer attached to HTTP server');

  wss.on('connection', async (client, req) => {
    const cid = nextCid();
    const url = new URL(req.url, 'http://localhost');
    const interviewId = url.searchParams.get('interviewId');

    console.log(`[rt ${cid}] client connected url=${req.url} interviewId=${interviewId}`);

    if (!interviewId) {
      console.warn(`[rt ${cid}] REJECT: missing interviewId`);
      client.close(1008, 'interviewId required');
      return;
    }

    // ---- Handshake: load Interview + QuestionSet ----
    const interview = await Interview.findById(interviewId).catch((err) => {
      console.error(`[rt ${cid}] interview lookup threw:`, err.message);
      return null;
    });
    if (!interview) {
      console.warn(`[rt ${cid}] REJECT: interview not found id=${interviewId}`);
      client.close(1008, 'interview not found');
      return;
    }
    console.log(`[rt ${cid}] interview loaded status=${interview.status} currentIndex=${interview.currentIndex} questionSet=${interview.questionSetId}`);

    const questionSet = await QuestionSet.findById(interview.questionSetId);
    if (!questionSet) {
      console.warn(`[rt ${cid}] REJECT: questionSet missing id=${interview.questionSetId}`);
      client.close(1011, 'question set missing');
      return;
    }
    console.log(`[rt ${cid}] questionSet loaded title="${questionSet.title}" questions=${questionSet.questions.length}`);

    // ---- Per-interview language settings ----
    // The participant chooses their language before the session starts;
    // it's stored on the Interview doc. Empty = fall back to config/.env defaults.
    const connLanguage = interview.language || config.stt.language;
    const connVoice = interview.ttsVoice || config.tts.voice;
    console.log(`[rt ${cid}] language=${connLanguage} voice=${connVoice}`);

    // Transcript sequence counter (monotonic across reconnects).
    let turnSequence = await TranscriptTurn.countDocuments({ interviewId }).catch(() => 0);
    console.log(`[rt ${cid}] transcript sequence seeded at ${turnSequence}`);

    async function persistTurn(role, text) {
      try {
        const doc = await TranscriptTurn.create({
          interviewId,
          sequence: turnSequence,
          role,
          text: text ?? '',
        });
        console.log(`[rt ${cid}] transcript SAVE seq=${turnSequence} role=${role} len=${(text ?? '').length} id=${doc._id}`);
        turnSequence++;
      } catch (err) {
        console.error(`[rt ${cid}] transcript SAVE FAILED role=${role} err=${err.message}`);
      }
    }

    // ---- Per-connection state ----
    let browserInCount = 0;
    let audioOutCount = 0;

    const conversationHistory = [
      { role: 'system', content: getSystemPrompt(connLanguage) },
    ];
    const tools = [getToolDefinition()];

    // Current TTS job — stored so barge-in can abort it.
    let currentTts = null;
    let closed = false;

    // Turn lock — prevent concurrent runAssistantTurn executions.
    let turnRunning = false;
    let turnQueued = false;
    // Py-agent path is stateless on the Node side (Py owns history via
    // its own checkpointer), so when a turn is queued we must remember
    // the queued user utterance text. Null means "opening" → POST /open.
    let queuedUserText = null;

    // Debounce — accumulate STT fragments before triggering LLM.
    const RECOGNIZE_DEBOUNCE_MS = 1500; // wait 1.5s of silence after last fragment
    let pendingUtterance = '';
    let debounceTimer = null;

    // ---- STT setup ----
    let stt = createRecognizer(cid, { language: connLanguage });
    let sttRebuilding = false;

    function wireRecognizerEvents(rec) {
      // Partial recognition → optional live user text in transcript panel.
      rec.recognizing = (_s, e) => {
        if (closed) return;
        const text = e.result.text;
        if (text) {
          send(client, {
            type: 'conversation.item.input_audio_transcription.delta',
            delta: text,
          });
        }
      };

      // Final recognition → accumulate text, debounce before triggering LLM.
      rec.recognized = (_s, e) => {
        if (closed) return;
        if (e.result.reason !== sdk.ResultReason.RecognizedSpeech) return;
        const text = e.result.text;
        if (!text || !text.trim()) return;

        console.log(`[rt ${cid}] STT fragment: "${text.slice(0, 120)}"`);

        // Barge-in: if TTS is playing, cancel it on the first fragment.
        if (currentTts) {
          console.log(`[rt ${cid}] barge-in — cancelling TTS`);
          currentTts.abort = true;
          currentTts = null;
          send(client, { type: 'response.cancelled' });
        }

        // Accumulate fragment.
        pendingUtterance += (pendingUtterance ? ' ' : '') + text;

        // Reset debounce timer.
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          if (closed || !pendingUtterance.trim()) return;

          const fullText = pendingUtterance;
          pendingUtterance = '';

          console.log(`[rt ${cid}] STT final (debounced): "${fullText.slice(0, 120)}"`);

          send(client, {
            type: 'conversation.item.input_audio_transcription.completed',
            transcript: fullText,
          });

          persistTurn('user', fullText);
          if (config.pyAgent.useEnvAgent) {
            // Py owns conversation history via its checkpointer; don't
            // duplicate locally — pass the user text into the turn.
            runAssistantTurn(fullText);
          } else {
            conversationHistory.push({ role: 'user', content: fullText });
            runAssistantTurn();
          }
        }, RECOGNIZE_DEBOUNCE_MS);
      };

      rec.canceled = (_s, e) => {
        if (e.reason !== sdk.CancellationReason.Error) return;
        console.warn(`[rt ${cid}] STT canceled (error): ${e.errorDetails}`);
        if (closed || sttRebuilding) return;
        rebuildRecognizer();
      };
    }

    function rebuildRecognizer() {
      sttRebuilding = true;
      console.log(`[rt ${cid}] rebuilding STT recognizer…`);
      // Best-effort teardown of old recognizer.
      try { stt.recognizer.close(); } catch (_) {}
      try { stt.pushStream.close(); } catch (_) {}

      stt = createRecognizer(cid, { language: connLanguage });
      wireRecognizerEvents(stt.recognizer);
      stt.recognizer.startContinuousRecognitionAsync(
        () => {
          sttRebuilding = false;
          console.log(`[rt ${cid}] STT rebuilt and restarted`);
        },
        (err) => {
          sttRebuilding = false;
          console.error(`[rt ${cid}] STT rebuild start failed:`, err);
        },
      );
    }

    wireRecognizerEvents(stt.recognizer);

    // Start continuous recognition.
    stt.recognizer.startContinuousRecognitionAsync(
      () => console.log(`[rt ${cid}] STT continuous recognition started`),
      (err) => console.error(`[rt ${cid}] STT start failed:`, err),
    );

    // ---- Py-agent delegation (USE_PY_AGENT=true) ----
    // Replaces the Node chatCompletion + tool loop with a single buffered
    // POST to the Python LangGraph sidecar. Py owns conversation state via
    // its Mongo checkpointer; Node keeps STT, TTS, debounce, barge-in, and
    // transcript persistence (all unchanged). On Py failure we surface
    // response.error to the WS — no silent fallback to the Node path.
    async function runPyAgentTurn(userText) {
      const isOpen = userText === null || userText === undefined;
      const endpoint = isOpen ? '/open' : '/turn';
      const url = `${config.pyAgent.url}${endpoint}`;
      const body = isOpen ? { interviewId } : { interviewId, userText };
      console.log(`[rt ${cid}] [py-agent] POST ${url} (${isOpen ? 'open' : 'turn'})`);
      const started = Date.now();
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      const elapsed = Date.now() - started;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`py-agent ${res.status} (${elapsed}ms): ${text.slice(0, 300)}`);
      }
      const json = await res.json();
      const assistantText = (json.assistantText ?? '').trim();
      console.log(`[rt ${cid}] [py-agent] ← ${res.status} (${elapsed}ms) text="${assistantText.slice(0, 80)}…"`);
      if (!assistantText) {
        console.warn(`[rt ${cid}] [py-agent] empty assistantText — nothing to speak`);
        return;
      }
      await persistTurn('assistant', assistantText);
      await synthesizeAndStream(assistantText);
    }

    // ---- LLM + tool loop ----
    async function runAssistantTurn(userText = null) {
      if (turnRunning) {
        console.log(`[rt ${cid}] turn already running — queuing`);
        turnQueued = true;
        // Remember the most recent queued utterance for Py path replay;
        // the Node path reads from conversationHistory so it doesn't care.
        queuedUserText = userText;
        return;
      }
      turnRunning = true;
      turnQueued = false;

      // Py-agent path: defer entirely to the sidecar. Skip the local LLM
      // loop, tool dispatch, and conversationHistory bookkeeping.
      if (config.pyAgent.useEnvAgent) {
        try {
          await runPyAgentTurn(userText);
        } catch (err) {
          console.error(`[rt ${cid}] [py-agent] ERROR:`, err.message);
          send(client, { type: 'response.error', error: { message: err.message } });
        } finally {
          turnRunning = false;
          if (turnQueued && !closed) {
            const next = queuedUserText;
            queuedUserText = null;
            console.log(`[rt ${cid}] draining queued turn (py-agent)`);
            runAssistantTurn(next);
          }
        }
        return;
      }

      // Bumped from 8 — chained non-question items consume extra iterations.
      const MAX_TOOL_ITERATIONS = 20;
      // Track last item type from tool results so we can auto-continue
      // after non-question items (they don't wait for user input).
      let lastItemType = null;
      let lastItemRequirement = null;
      // When true, the next LLM call forces tool invocation.
      let forceToolCall = false;

      try {
        for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
          if (closed) return;
          console.log(`[rt ${cid}] LLM call #${i + 1} messages=${conversationHistory.length} forceToolCall=${forceToolCall}`);

          const toolChoice = forceToolCall
            ? { type: 'function', function: { name: 'get_next_interview_question' } }
            : 'auto';
          forceToolCall = false;

          const json = await chatCompletion(conversationHistory, tools, toolChoice);
          const choice = json.choices?.[0];
          if (!choice) {
            console.error(`[rt ${cid}] LLM returned no choices`);
            return;
          }

          const msg = choice.message;

          // Tool calls?
          if (msg.tool_calls && msg.tool_calls.length > 0) {
            // The LLM sometimes returns content alongside tool_calls
            // (e.g. speaking a non-question item while calling the tool
            // for the next one). Speak that content before processing
            // the tool calls so it isn't silently dropped.
            if (msg.content && msg.content.trim()) {
              const inlineText = msg.content;
              console.log(`[rt ${cid}] LLM inline content+tool_calls: "${inlineText.slice(0, 120)}"`);
              await persistTurn('assistant', inlineText);
              await synthesizeAndStream(inlineText);
            }

            // Append the assistant message (with tool_calls) to history.
            conversationHistory.push(msg);

            for (const tc of msg.tool_calls) {
              let args = {};
              try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch (err) {
                console.warn(`[rt ${cid}] could not parse tool args:`, err.message);
              }
              console.log(`[rt ${cid}] TOOL CALL name=${tc.function.name} id=${tc.id} args=${JSON.stringify(args)}`);

              const result = await handleToolCall({
                name: tc.function.name,
                args,
                interviewId,
                questionSet,
              });
              console.log(`[rt ${cid}] TOOL RESULT → ${JSON.stringify(result)}`);

              // Track the item type/requirement so we know what to do after TTS.
              if (result.type) lastItemType = result.type;
              if (result.hasOwnProperty('requirement')) lastItemRequirement = result.requirement || '';

              conversationHistory.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: JSON.stringify(result),
              });
            }
            // Loop — re-POST to LLM with the tool results.
            continue;
          }

          // Final text response.
          const text = msg.content ?? '';
          console.log(`[rt ${cid}] LLM response (lastItemType=${lastItemType}): "${text.slice(0, 120)}"`);
          conversationHistory.push({ role: 'assistant', content: text });
          await persistTurn('assistant', text);

          // TTS + synchronized transcript (words drip with audio).
          await synthesizeAndStream(text);

          // Non-question items (intro, transition, closing) don't wait for
          // user input. Auto-continue so the LLM calls the tool again for
          // the next item.
          if (lastItemType === 'non-question') {
            console.log(`[rt ${cid}] non-question delivered — auto-continuing`);
            lastItemType = null;
            continue;
          }

          // For question items (qualitative/factual), always wait for the
          // user to respond — even if requirement is empty (e.g. a greeting).
          // Only force-continue for non-questions with empty requirement.
          console.log(`[rt ${cid}] question delivered (type=${lastItemType}) — waiting for user`);
          
          return;
        }
        console.warn(`[rt ${cid}] tool loop hit max iterations (${MAX_TOOL_ITERATIONS})`);
      } catch (err) {
        console.error(`[rt ${cid}] runAssistantTurn error:`, err);
        send(client, { type: 'error', error: { message: err.message } });
      } finally {
        turnRunning = false;
        if (turnQueued && !closed) {
          console.log(`[rt ${cid}] draining queued turn`);
          runAssistantTurn();
        }
      }
    }

    // ---- TTS streaming ----
    async function synthesizeAndStream(text) {
      if (closed || !text.trim()) return;

      const ttsJob = { abort: false };
      currentTts = ttsJob;

      const synthesizer = createSynthesizer({ voice: connVoice });
      const CHUNK_BYTES = 12000; // ~250ms of 24kHz 16-bit mono
      const cleanText = stripTags(text);
      console.log(`[rt ${cid}] TTS plaintext (${cleanText.length} chars)`);

      return new Promise((resolve) => {
        synthesizer.speakTextAsync(
          cleanText,
          (result) => {
            if (ttsJob.abort) {
              console.log(`[rt ${cid}] TTS aborted (barge-in)`);
              synthesizer.close();
              resolve();
              return;
            }
            if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
              const audioData = result.audioData;
              const totalChunks = Math.ceil(audioData.byteLength / CHUNK_BYTES);

              // Split text into words and distribute across audio chunks
              // so subtitles drip in sync with speech.
              const words = text.split(/\s+/).filter(Boolean);
              const wordsPerChunk = totalChunks > 0 ? words.length / totalChunks : words.length;
              let wordsSent = 0;

              // Stream audio chunks + interleaved transcript words.
              let chunkIndex = 0;
              for (let offset = 0; offset < audioData.byteLength; offset += CHUNK_BYTES) {
                if (ttsJob.abort || closed) break;
                const end = Math.min(offset + CHUNK_BYTES, audioData.byteLength);
                const chunk = new Uint8Array(audioData, offset, end - offset);
                send(client, {
                  type: 'response.audio.delta',
                  delta: bufferToBase64(chunk),
                });
                audioOutCount++;
                chunkIndex++;

                // Drip the next batch of words for this chunk.
                const targetWords = Math.min(
                  Math.round(wordsPerChunk * chunkIndex),
                  words.length,
                );
                if (targetWords > wordsSent) {
                  const batch = words.slice(wordsSent, targetWords).join(' ');
                  const prefix = wordsSent === 0 ? '' : ' ';
                  send(client, {
                    type: 'response.audio_transcript.delta',
                    delta: prefix + batch,
                  });
                  wordsSent = targetWords;
                }
              }

              // Flush any remaining words (rounding edge case).
              if (wordsSent < words.length && !ttsJob.abort && !closed) {
                const remaining = words.slice(wordsSent).join(' ');
                send(client, {
                  type: 'response.audio_transcript.delta',
                  delta: ' ' + remaining,
                });
              }

              if (!ttsJob.abort) {
                send(client, { type: 'response.audio_transcript.done', transcript: text });
                send(client, { type: 'response.done' });
              }
              console.log(`[rt ${cid}] TTS complete text="${text.slice(0, 60)}…" chunks=${audioOutCount}`);
            } else {
              console.error(`[rt ${cid}] TTS failed reason=${result.reason} errorDetails=${result.errorDetails}`);
              send(client, { type: 'response.done' });
            }
            if (currentTts === ttsJob) currentTts = null;
            synthesizer.close();
            resolve();
          },
          (err) => {
            console.error(`[rt ${cid}] TTS error:`, err);
            if (currentTts === ttsJob) currentTts = null;
            synthesizer.close();
            resolve();
          },
        );
      });
    }

    // ---- Browser → server ----
    client.on('message', (data) => {
      const msgStr = data.toString();
      browserInCount++;

      let parsed;
      try { parsed = JSON.parse(msgStr); } catch { parsed = null; }

      if (parsed?.type === 'input_audio_buffer.append' && parsed.audio) {
        if (browserInCount === 1 || browserInCount % 25 === 0) {
          console.log(`[rt ${cid}] ← browser #${browserInCount} input_audio_buffer.append audio(${Math.round((parsed.audio.length || 0) * 0.75)}B)`);
        }
        // Decode base64 PCM16 and push to STT stream.
        try {
          const int16 = b64ToInt16(parsed.audio);
          stt.pushStream.write(int16.buffer);
        } catch (err) {
          console.error(`[rt ${cid}] audio decode error:`, err.message);
        }
      } else {
        console.log(`[rt ${cid}] ← browser #${browserInCount} ${parsed?.type ?? 'unknown'}`);
      }
    });

    // ---- Opening greeting ----
    // Anna speaks first, just like the old Realtime bridge.
    console.log(`[rt ${cid}] triggering opening assistant turn`);
    runAssistantTurn();

    // ---- Cleanup on close ----
    client.on('close', (code, reason) => {
      closed = true;
      console.log(`[rt ${cid}] client CLOSE code=${code} reason="${reason?.toString() ?? ''}" — totals: browserIn=${browserInCount} audioOut=${audioOutCount}`);
      // Cancel pending debounce.
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      // Stop STT.
      try { stt.recognizer.close(); } catch (_) {}
      try { stt.pushStream.close(); } catch (_) {}
      console.log(`[rt ${cid}] STT closed`);
      // Abort any in-flight TTS.
      if (currentTts) currentTts.abort = true;
    });
  });
}
