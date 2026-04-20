// Interviewee surface: voice chat against Azure Realtime via the Node proxy.
// In Phase 1 this is structurally the same as the Phase 0 voice chat — we
// just moved it into a route so Phase 6 can add avatar + transcript toggle
// without disturbing the top-level app shell.

import { useEffect, useRef, useState } from 'react';

// Azure `gpt-realtime` emits / consumes 24 kHz mono PCM16.
// Browser WebAudio will resample mic input to this rate because we construct
// the capture AudioContext with `sampleRate: 24000`.
const SAMPLE_RATE = 24000;
const VOICE = import.meta.env.VITE_AZURE_REALTIME_VOICE || 'coral';

// Float32 samples ([-1, 1]) → signed 16-bit PCM. This is what Azure expects
// in the `input_audio_buffer.append` event, base64-encoded.
function floatToPCM16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// Chunked base64 encode to avoid "arguments too long" on big audio buffers.
function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export default function Interview() {
  const [connected, setConnected] = useState(false);
  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState('disconnected');
  const [messages, setMessages] = useState([]);

  // Refs hold handles we don't want to trigger re-renders on:
  // websocket, audio contexts, mic stream, and the scheduled-playback cursor.
  const wsRef = useRef(null);
  const micCtxRef = useRef(null);
  const micStreamRef = useRef(null);
  const micProcRef = useRef(null);
  const playCtxRef = useRef(null);
  const playTimeRef = useRef(0);
  // Interview id is created server-side before the WS opens; we keep it so we
  // can POST /end when the user disconnects.
  const interviewIdRef = useRef(null);

  // Clean up everything if the component unmounts mid-call (route change, etc).
  useEffect(() => () => disconnect(), []);

  // Event counters: helpful when triaging from just the console.
  const wsInCount = useRef(0);
  const audioOutCount = useRef(0);
  const audioInCount = useRef(0);

  async function connect() {
    try {
      // Phase 3+4 flow: ask the server for a QuestionSet, spin up an Interview row,
      // then open the WS with that interviewId. The server owns `session.update`
      // and the AI greeting — the browser no longer sends either.
      console.log('[client] connect() start');
      setStatus('loading question set…');

      console.log('[client] GET /api/question-sets');
      const sets = await fetch('/api/question-sets').then((r) => r.json());
      console.log('[client] question sets ←', sets);
      if (!Array.isArray(sets) || sets.length === 0) {
        setStatus('no question sets in DB — run `npm run seed`');
        console.warn('[client] abort: no question sets');
        return;
      }
      const questionSetId = sets[0]._id;
      console.log(`[client] using questionSetId=${questionSetId} ("${sets[0].title}")`);

      setStatus('creating interview…');
      console.log('[client] POST /api/interviews');
      const created = await fetch('/api/interviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ questionSetId }),
      }).then((r) => r.json());
      console.log('[client] interview created ←', created);
      if (!created?._id) {
        setStatus(`error creating interview: ${created?.error ?? 'unknown'}`);
        return;
      }
      interviewIdRef.current = created._id;

      setStatus('connecting…');
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${proto}//${location.host}/ws?interviewId=${created._id}`;
      console.log(`[client] opening WS ${wsUrl}`);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      // Reset counters per session so the numbers stay meaningful.
      wsInCount.current = 0;
      audioOutCount.current = 0;
      audioInCount.current = 0;

      ws.onopen = () => {
        setConnected(true);
        setStatus('connected — listening for greeting');
        console.log('[client] WS open — server will send session.update + response.create upstream');
      };
      ws.onmessage = (evt) => {
        wsInCount.current++;
        let msg;
        try { msg = JSON.parse(evt.data); } catch { console.warn('[client] non-JSON frame', evt.data); return; }
        // Rate-limit audio delta logs. Everything else is logged in full (type-level).
        if (msg.type === 'response.output_audio.delta' || msg.type === 'response.audio.delta') {
          audioOutCount.current++;
          if (audioOutCount.current === 1 || audioOutCount.current % 25 === 0) {
            console.log(`[client] ← #${wsInCount.current} audio delta x${audioOutCount.current}`);
          }
        } else if (msg.type === 'response.output_audio_transcript.delta' || msg.type === 'response.audio_transcript.delta') {
          console.log(`[client] ← #${wsInCount.current} ${msg.type} "${(msg.delta ?? '').slice(0, 60)}"`);
        } else if (msg.type === 'conversation.item.input_audio_transcription.completed') {
          console.log(`[client] ← #${wsInCount.current} ${msg.type} transcript="${(msg.transcript ?? '').slice(0, 120)}"`);
        } else if (msg.type === 'response.function_call_arguments.done') {
          console.log(`[client] ← #${wsInCount.current} TOOL CALL name=${msg.name} args=${msg.arguments}`);
        } else if (msg.type === 'error') {
          console.error(`[client] ← #${wsInCount.current} ERROR`, msg.error);
        } else {
          console.log(`[client] ← #${wsInCount.current} ${msg.type}`);
        }
        handleServerEvent(msg);
      };
      ws.onclose = (evt) => {
        setConnected(false);
        setRecording(false);
        setStatus('disconnected');
        console.log(`[client] WS close code=${evt.code} reason="${evt.reason}" wasClean=${evt.wasClean} — totals: in=${wsInCount.current} audioOut=${audioOutCount.current} audioIn=${audioInCount.current}`);
      };
      ws.onerror = (err) => {
        setStatus('error');
        console.error('[client] WS error', err);
      };
    } catch (err) {
      console.error('[client] connect() threw', err);
      setStatus(`error: ${err?.message ?? 'unknown'}`);
    }
  }

  function disconnect() {
    console.log('[client] disconnect()');
    stopRecording();
    if (interviewIdRef.current) {
      console.log(`[client] POST /api/interviews/${interviewIdRef.current}/end (best-effort)`);
      fetch(`/api/interviews/${interviewIdRef.current}/end`, { method: 'POST' })
        .then((r) => console.log(`[client] /end ← status=${r.status}`))
        .catch((err) => console.warn('[client] /end failed', err.message));
    }
    interviewIdRef.current = null;
    wsRef.current?.close();
    wsRef.current = null;
    playCtxRef.current?.close().catch(() => {});
    playCtxRef.current = null;
  }

  // Route server → client events into UI state / audio playback.
  // We handle both the new (`response.output_audio.*`) and legacy (`response.audio.*`)
  // event names so a preview-model swap doesn't silently break the UI.
  function handleServerEvent(msg) {
    switch (msg.type) {
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        playAudioDelta(msg.delta);
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        appendMessage('assistant', msg.delta);
        break;
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        finalizeMessage('assistant');
        break;
      case 'conversation.item.input_audio_transcription.completed':
        setMessages((m) => [...m, { role: 'user', text: msg.transcript, done: true }]);
        break;
      case 'error':
        console.error('Realtime error:', msg.error);
        setStatus(`error: ${msg.error?.message ?? 'unknown'}`);
        break;
      default:
        break;
    }
  }

  function appendMessage(role, chunk) {
    setMessages((m) => {
      const last = m[m.length - 1];
      // Merge into the in-flight bubble of the same role; start a new one otherwise.
      if (last && last.role === role && !last.done) {
        return [...m.slice(0, -1), { ...last, text: last.text + chunk }];
      }
      return [...m, { role, text: chunk, done: false }];
    });
  }

  function finalizeMessage(role) {
    setMessages((m) => {
      const last = m[m.length - 1];
      if (last && last.role === role && !last.done) {
        return [...m.slice(0, -1), { ...last, done: true }];
      }
      return m;
    });
  }

  async function startRecording() {
    console.log('[client] startRecording() — requesting mic');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    console.log('[client] mic stream acquired tracks=', stream.getAudioTracks().map((t) => t.label));
    micStreamRef.current = stream;

    // AudioContext at 24 kHz forces resampling of the mic input, so whatever the
    // device's native rate is, we feed Azure exactly what it expects.
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    micCtxRef.current = ctx;

    const source = ctx.createMediaStreamSource(stream);
    // ScriptProcessorNode is deprecated but still the simplest way to get raw PCM
    // in every browser today. Migrate to AudioWorklet later if it becomes a pain.
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    micProcRef.current = proc;

    proc.onaudioprocess = (e) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const pcm16 = floatToPCM16(e.inputBuffer.getChannelData(0));
      const b64 = bytesToBase64(new Uint8Array(pcm16.buffer));
      ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 }));
      audioInCount.current++;
      // Log on first frame and every 25th so the user can see the mic is streaming
      // without flooding the console — each ScriptProcessor tick is ~85ms at 4096 samples / 24 kHz.
      if (audioInCount.current === 1 || audioInCount.current % 25 === 0) {
        console.log(`[client] → audio chunk #${audioInCount.current} (${b64.length}B b64)`);
      }
    };

    source.connect(proc);
    proc.connect(ctx.destination); // needed to keep `onaudioprocess` firing
    setRecording(true);
    console.log('[client] recording started — streaming PCM16 @ 24kHz');
  }

  function stopRecording() {
    if (!micProcRef.current && !micStreamRef.current && !micCtxRef.current) return;
    console.log(`[client] stopRecording() — sent ${audioInCount.current} chunks this session`);
    micProcRef.current?.disconnect();
    micProcRef.current = null;
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    micCtxRef.current?.close().catch(() => {});
    micCtxRef.current = null;
    setRecording(false);
  }

  // Stream playback: schedule each chunk back-to-back on a single AudioContext
  // timeline so the audio plays gaplessly even when chunks arrive unevenly.
  function playAudioDelta(b64) {
    if (!playCtxRef.current) {
      playCtxRef.current = new AudioContext({ sampleRate: SAMPLE_RATE });
      playTimeRef.current = playCtxRef.current.currentTime;
    }
    const ctx = playCtxRef.current;
    const bytes = base64ToBytes(b64);
    const pcm16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 0x8000;

    const buf = ctx.createBuffer(1, float32.length, SAMPLE_RATE);
    buf.copyToChannel(float32, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    // Start either now (if we're behind) or at the end of the last scheduled chunk.
    const startAt = Math.max(ctx.currentTime, playTimeRef.current);
    src.start(startAt);
    playTimeRef.current = startAt + buf.duration;
  }

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 640, margin: '40px auto', padding: 20 }}>
      <h1 style={{ marginBottom: 4 }}>Voice Chat</h1>
      <div style={{ color: '#666', marginBottom: 20, fontSize: 14 }}>Status: {status}</div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        {!connected ? (
          <button onClick={connect} style={btn}>Connect</button>
        ) : (
          <>
            <button
              onClick={recording ? stopRecording : startRecording}
              style={{ ...btn, background: recording ? '#c0392b' : '#2980b9' }}
            >
              {recording ? 'Stop mic' : 'Start mic'}
            </button>
            <button onClick={disconnect} style={{ ...btn, background: '#555' }}>Disconnect</button>
          </>
        )}
      </div>

      <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, minHeight: 200 }}>
        {messages.length === 0 && <div style={{ color: '#999' }}>Say something…</div>}
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: '#888', textTransform: 'uppercase' }}>{m.role}</div>
            <div>{m.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

const btn = {
  padding: '10px 16px',
  fontSize: 15,
  border: 'none',
  borderRadius: 6,
  color: 'white',
  background: '#2980b9',
  cursor: 'pointer',
};
