// WebSocket proxy between the browser and Azure's Realtime API.
//
// Responsibilities (Phase 3 + 4):
//   1. Each browser WS connects with `?interviewId=<id>`. We look up the
//      Interview + QuestionSet before opening the upstream WS — if either is
//      missing, we reject so the conversation can't start against empty state.
//   2. We own `session.update`: system prompt + tool definition + audio config
//      are all authored server-side. The browser never sees them.
//   3. We kick the model off with `response.create` immediately, so the AI
//      greets first instead of waiting for the participant to speak.
//   4. We intercept `response.function_call_arguments.done` events, resolve
//      the tool server-side (reads Mongo, advances `currentIndex`), and return
//      the result via `conversation.item.create` + another `response.create`.
//
// Logging note: each connection gets a short hash-id (cid) so you can follow
// one conversation's log lines when multiple WS sessions are alive.

import { URL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { config } from './config.js';
import { Interview } from './models/Interview.js';
import { QuestionSet } from './models/QuestionSet.js';
import { buildSessionConfig } from './realtime/session.js';
import { handleToolCall } from './realtime/tools.js';
import { describeEvent } from './logging.js';

function buildUpstreamUrl() {
  const url = new URL(config.azure.endpoint);
  const path = url.pathname.replace(/\/$/, '') + '/realtime';
  const params = new URLSearchParams({ model: config.azure.model });
  if (config.azure.apiVersion) params.set('api-version', config.azure.apiVersion);
  return `wss://${url.host}${path}?${params.toString()}`;
}

// Short per-connection id so logs from concurrent sessions stay readable.
let cidCounter = 0;
function nextCid() { cidCounter = (cidCounter + 1) % 1000; return `cid${cidCounter.toString().padStart(3, '0')}`; }

// Server-picked default voice. Pulled from env so the interviewer voice stays
// consistent and isn't something the browser can override.
const VOICE = process.env.VITE_AZURE_REALTIME_VOICE || 'coral';

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

    // ---- Handshake: load Interview + QuestionSet before touching Azure ----
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

    // ---- Open upstream WS to Azure ----
    const upstreamUrl = buildUpstreamUrl();
    console.log(`[rt ${cid}] opening upstream ${upstreamUrl}`);
    const upstream = new WebSocket(upstreamUrl, {
      headers: { 'api-key': config.azure.apiKey },
    });

    // Counters make it easy to see flow volume at a glance during debugging.
    let browserInCount = 0;     // audio frames from browser
    let upstreamInCount = 0;    // events from Azure (all types)
    let audioOutCount = 0;      // audio deltas from Azure
    let upstreamReady = false;
    const pending = [];         // browser frames buffered until upstream open

    upstream.on('open', () => {
      upstreamReady = true;
      console.log(`[rt ${cid}] upstream OPEN — sending session.update + response.create`);

      // 1) Session config — persona, tool, audio format.
      const sessionFrame = JSON.stringify({ type: 'session.update', session: buildSessionConfig({ voice: VOICE }) });
      console.log(`[rt ${cid}] → azure session.update (${sessionFrame.length}B payload)`);
      upstream.send(sessionFrame);

      // 2) Kick off so the AI greets before any user audio arrives.
      console.log(`[rt ${cid}] → azure response.create (open greeting)`);
      upstream.send(JSON.stringify({ type: 'response.create' }));

      if (pending.length) {
        console.log(`[rt ${cid}] flushing ${pending.length} buffered browser frames`);
        for (const msg of pending) upstream.send(msg);
        pending.length = 0;
      }
    });

    // ---- Upstream → browser, with tool-call interception ----
    upstream.on('message', async (data) => {
      const raw = data.toString();
      upstreamInCount++;

      let msg;
      try { msg = JSON.parse(raw); } catch { msg = null; }
      const desc = describeEvent(raw, msg);

      if (msg?.type === 'response.output_audio.delta' || msg?.type === 'response.audio.delta') audioOutCount++;

      console.log(`[rt ${cid}] ← azure #${upstreamInCount} ${desc}`);

      // Forward every frame to the browser unchanged.
      if (client.readyState === WebSocket.OPEN) client.send(raw);

      // --- Tool call interception ---
      if (msg?.type === 'response.function_call_arguments.done') {
        let args = {};
        try { args = msg.arguments ? JSON.parse(msg.arguments) : {}; } catch (err) {
          console.warn(`[rt ${cid}] could not parse tool args:`, err.message, msg.arguments);
        }

        console.log(`[rt ${cid}] TOOL CALL name=${msg.name} call_id=${msg.call_id} args=${JSON.stringify(args)}`);

        const result = await handleToolCall({ name: msg.name, args, interviewId, questionSet });
        console.log(`[rt ${cid}] TOOL RESULT → ${JSON.stringify(result)}`);

        if (upstream.readyState === WebSocket.OPEN) {
          const outputFrame = JSON.stringify({
            type: 'conversation.item.create',
            item: { type: 'function_call_output', call_id: msg.call_id, output: JSON.stringify(result) },
          });
          console.log(`[rt ${cid}] → azure conversation.item.create function_call_output call_id=${msg.call_id}`);
          upstream.send(outputFrame);

          console.log(`[rt ${cid}] → azure response.create (continue after tool)`);
          upstream.send(JSON.stringify({ type: 'response.create' }));
        } else {
          console.warn(`[rt ${cid}] upstream closed before tool output could be sent`);
        }
      }
    });

    upstream.on('close', (code, reason) => {
      console.log(`[rt ${cid}] upstream CLOSE code=${code} reason="${reason?.toString() ?? ''}" — totals: upstreamIn=${upstreamInCount} audioOut=${audioOutCount} browserIn=${browserInCount}`);
      if (client.readyState === WebSocket.OPEN) client.close();
    });
    upstream.on('error', (err) => {
      console.error(`[rt ${cid}] upstream ERROR ${err.message}`);
      if (client.readyState === WebSocket.OPEN) client.close(1011, 'upstream error');
    });

    // ---- Browser → upstream ----
    client.on('message', (data) => {
      const msgStr = data.toString();
      browserInCount++;

      let parsed;
      try { parsed = JSON.parse(msgStr); } catch { parsed = null; }
      const desc = describeEvent(msgStr, parsed);

      // Audio-append frames are extremely frequent; log every 25th so the
      // stream is visible but doesn't drown the other log lines.
      if (parsed?.type === 'input_audio_buffer.append') {
        if (browserInCount === 1 || browserInCount % 25 === 0) {
          console.log(`[rt ${cid}] → azure #${browserInCount} ${desc}`);
        }
      } else {
        console.log(`[rt ${cid}] → azure #${browserInCount} ${desc}`);
      }

      if (upstreamReady) upstream.send(msgStr);
      else pending.push(msgStr);
    });

    client.on('close', (code, reason) => {
      console.log(`[rt ${cid}] client CLOSE code=${code} reason="${reason?.toString() ?? ''}" — totals: browserIn=${browserInCount}`);
      if (upstream.readyState <= WebSocket.OPEN) upstream.close();
    });
  });
}
