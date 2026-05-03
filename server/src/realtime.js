// STT → Py-agent → TTS pipeline.
//
// Per-connection flow:
//   1. Browser opens WS with ?interviewId=<id>. We validate Interview + QuestionSet.
//   2. GPT Realtime API provides server-side VAD + transcription. Audio frames from
//      the browser are forwarded directly. Native VAD events drive turn detection —
//      no hand-rolled debounce.
//   3. The Py sidecar owns the LLM call, conversation history, tool dispatch, and
//      Mongo writes. Node never talks to Azure OpenAI directly anymore — the
//      legacy Node-side LLM + tool loop lives under `server/legacy/` for reference.
//   4. Azure Speech SDK SpeechSynthesizer converts the assistant text to PCM16
//      audio and streams it to the browser in the existing frame format.
//
// Frame contract with the browser (unchanged):
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
import { RealtimeSttClient } from './realtime/sttClient.js';

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

function bufferToBase64(buf) {
  return Buffer.from(buf).toString('base64');
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

    // Current TTS job — stored so barge-in can abort it.
    let currentTts = null;
    let closed = false;

    // Turn lock — prevent concurrent runAssistantTurn executions. Py owns
    // conversation history via its checkpointer; when a turn is queued we
    // remember the queued user utterance text. Null means "opening" → POST /open.
    let turnRunning = false;
    let turnQueued = false;
    let queuedUserText = null;

    // ---- STT via GPT Realtime API (VAD + transcription) ----
    const sttClient = new RealtimeSttClient({
      config,
      cid,
      onSpeechStarted: () => {
        if (closed) return;
        if (currentTts) {
          console.log(`[rt ${cid}] barge-in — cancelling TTS`);
          currentTts.abort = true;
          currentTts = null;
          send(client, { type: 'response.cancelled' });
        }
      },
      onTranscriptionCompleted: (transcript) => {
        if (closed) return;
        console.log(`[rt ${cid}] STT final: "${transcript.slice(0, 120)}"`);
        send(client, {
          type: 'conversation.item.input_audio_transcription.completed',
          transcript,
        });
        persistTurn('user', transcript);
        runAssistantTurn(transcript);
      },
      onError: (err) => {
        console.error(`[rt ${cid}] STT error:`, err.message);
        if (!closed) send(client, { type: 'response.error', error: { message: `STT: ${err.message}` } });
      },
    });
    sttClient.connect();

    // ---- Py-agent delegation ----
    // POST to the Python LangGraph sidecar. Py owns conversation state via its
    // Mongo checkpointer; Node keeps STT (via Realtime API), TTS, barge-in, and
    // transcript persistence. On Py failure we surface response.error to the WS.
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

    // ---- Assistant turn ----
    // Defers entirely to the Py sidecar. On failure we surface response.error
    // to the WS — no silent fallback.
    async function runAssistantTurn(userText = null) {
      if (turnRunning) {
        console.log(`[rt ${cid}] turn already running — queuing`);
        turnQueued = true;
        queuedUserText = userText;
        return;
      }
      turnRunning = true;
      turnQueued = false;

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
          console.log(`[rt ${cid}] draining queued turn`);
          runAssistantTurn(next);
        }
      }
    }

    // ---- TTS streaming ----
    async function synthesizeAndStream(text) {
      if (closed || !text.trim()) return;

      const ttsEnterTime = Date.now(); // Phase 12 timing
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
            const ttsAzureElapsed = Date.now() - ttsEnterTime; // Phase 12 timing
            if (ttsJob.abort) {
              console.log(`[rt ${cid}] TTS aborted (barge-in)`);
              synthesizer.close();
              resolve();
              return;
            }
            if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
              console.log(`[rt ${cid}] [timing] TTS Azure ready: ${ttsAzureElapsed}ms`);
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
              const ttsTotalElapsed = Date.now() - ttsEnterTime; // Phase 12 timing
              console.log(`[rt ${cid}] [timing] TTS total: ${ttsTotalElapsed}ms`);
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
        sttClient.pushAudio(parsed.audio);
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
      sttClient.close();
      if (currentTts) currentTts.abort = true;
    });
  });
}
