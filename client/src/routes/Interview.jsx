// Interviewee surface. Three phases inside one component:
//
//   "dashboard" — participant's study home. Shows four module cards
//                 (consent, interview, surveys, retake) with sequential
//                 unlock. Completion is in-memory only for now — reload
//                 resets it. Modules 3 and 4 are permanently locked in
//                 this phase; see Phase 9 in prompts/plan.md.
//
//   "consent"   — stub consent view. Placeholder text + "I consent"
//                 button. Clicking marks module 1 complete and returns
//                 to the dashboard. A real signed-PDF placeholder lands
//                 in Phase 9.2.
//
//   "stage"     — immersive two-column view. Left (large, glass): audio-reactive
//                 orb with Anna's face / headset icon that morphs based on who
//                 is currently speaking. Right (narrow, glass): live transcript
//                 with a "Live" pulse indicator. Ending the interview returns
//                 to the dashboard and marks module 2 complete.
//
// Analyser plumbing for the orb:
//   - `annaAnalyserRef` is tapped on the playback AudioContext. Every
//     decoded chunk connects `source → analyser → destination`.
//   - `userAnalyserRef` is tapped on the mic `MediaStreamAudioSourceNode`,
//     running alongside the `ScriptProcessorNode` that actually ships PCM16
//     upstream.
//   The Orb component reads both refs on each animation frame and bounces
//   itself via direct DOM writes (no React re-render per frame).

import { useEffect, useRef, useState } from 'react';
import { theme, primaryButton, landingAtmosphere, stageAtmosphere } from '../theme.js';
import Orb from '../components/Orb.jsx';
import opLogo from '../../../icons/OP_logo.png';

const SAMPLE_RATE = 24000;

function floatToPCM16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

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
  const [phase, setPhase] = useState('dashboard'); // 'dashboard' | 'consent' | 'stage'
  const [completion, setCompletion] = useState({ consent: false, interview: false });
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState('ready');
  const [messages, setMessages] = useState([]);
  const [muted, setMuted] = useState(false);
  const [micError, setMicError] = useState(null);

  // Mirrored into a ref so the ScriptProcessor callback (which closes over
  // its own scope, not React state) sees changes without needing to
  // re-subscribe.
  const mutedRef = useRef(false);

  const wsRef = useRef(null);
  const micCtxRef = useRef(null);
  const micStreamRef = useRef(null);
  const micProcRef = useRef(null);
  const playCtxRef = useRef(null);
  const playTimeRef = useRef(0);
  const interviewIdRef = useRef(null);

  // Analyser refs — passed into <Orb /> by reference so the orb can read them
  // via rAF without needing React state to propagate.
  const annaAnalyserRef = useRef(null);
  const userAnalyserRef = useRef(null);

  const wsInCount = useRef(0);
  const audioOutCount = useRef(0);
  const audioInCount = useRef(0);
  const transcriptBottomRef = useRef(null);

  useEffect(() => () => disconnect(), []);

  // Auto-scroll transcript to bottom when new turns arrive.
  useEffect(() => {
    transcriptBottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  async function beginInterview() {
    // Pre-acquire the mic on the dashboard so the permission prompt (if any)
    // happens *before* Anna starts. Once we're in the stage the user should
    // not have to answer a browser dialog. The stream is stashed on
    // `micStreamRef` so `startRecording()` reuses it without re-prompting.
    setMicError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
      micStreamRef.current = stream;
      // Reset mute state — a freshly acquired stream is live.
      mutedRef.current = false;
      setMuted(false);
    } catch (err) {
      console.warn('[client] mic permission denied', err);
      setMicError('Microphone access is needed for the interview. Please allow it and try again.');
      return;
    }

    setPhase('stage');
    // Small delay so the view has mounted before we open WS.
    await new Promise((r) => setTimeout(r, 200));
    await connect();
  }

  function toggleMute() {
    setMuted((prev) => {
      const next = !prev;
      mutedRef.current = next;
      // Also flip the track's `enabled` flag. Disabled tracks emit silence,
      // but we additionally short-circuit in `onaudioprocess` below so we
      // don't waste bandwidth sending zeros upstream.
      micStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = !next));
      console.log(`[client] mic ${next ? 'muted' : 'unmuted'}`);
      return next;
    });
  }

  async function connect() {
    try {
      console.log('[client] connect() start');
      setStatus('loading question set…');

      const sets = await fetch('/api/question-sets').then((r) => r.json());
      if (!Array.isArray(sets) || sets.length === 0) {
        setStatus('no question sets in DB — run `npm run seed`');
        return;
      }
      const questionSetId = sets[0]._id;
      console.log(`[client] using questionSetId=${questionSetId} ("${sets[0].title}")`);

      setStatus('creating interview…');
      const created = await fetch('/api/interviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ questionSetId }),
      }).then((r) => r.json());
      if (!created?._id) {
        setStatus(`error: ${created?.error ?? 'unknown'}`);
        return;
      }
      interviewIdRef.current = created._id;

      setStatus('connecting…');
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${proto}//${location.host}/ws?interviewId=${created._id}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      wsInCount.current = 0;
      audioOutCount.current = 0;
      audioInCount.current = 0;

      ws.onopen = async () => {
        setConnected(true);
        setStatus('Anna is preparing her greeting');
        // Open the mic immediately so VAD can pick up the user's response to Anna's greeting.
        try { await startRecording(); } catch (err) {
          console.error('[client] startRecording failed', err);
          setStatus('mic permission denied — please reload and allow mic access');
        }
      };
      ws.onmessage = (evt) => {
        wsInCount.current++;
        let msg;
        try { msg = JSON.parse(evt.data); } catch { return; }
        if (msg.type === 'response.output_audio.delta' || msg.type === 'response.audio.delta') {
          audioOutCount.current++;
          if (audioOutCount.current === 1 || audioOutCount.current % 25 === 0) {
            console.log(`[client] ← #${wsInCount.current} audio delta x${audioOutCount.current}`);
          }
        } else if (msg.type === 'error') {
          console.error(`[client] ← #${wsInCount.current} ERROR`, msg.error);
        } else {
          console.log(`[client] ← #${wsInCount.current} ${msg.type}`);
        }
        handleServerEvent(msg);
      };
      ws.onclose = (evt) => {
        setConnected(false);
        setStatus('disconnected');
        console.log(`[client] WS close code=${evt.code} — totals: in=${wsInCount.current} audioOut=${audioOutCount.current} audioIn=${audioInCount.current}`);
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
      fetch(`/api/interviews/${interviewIdRef.current}/end`, { method: 'POST' })
        .then((r) => console.log(`[client] /end ← ${r.status}`))
        .catch((err) => console.warn('[client] /end failed', err.message));
    }
    interviewIdRef.current = null;
    wsRef.current?.close();
    wsRef.current = null;
    playCtxRef.current?.close().catch(() => {});
    playCtxRef.current = null;
    annaAnalyserRef.current = null;
  }

  function endAndReturnHome() {
    disconnect();
    setMessages([]);
    setCompletion((c) => ({ ...c, interview: true }));
    // Show a simple thank-you / end screen instead of jumping straight home
    setPhase('ended');
    setStatus('ready');
  }

  function startConsent() {
    setPhase('consent');
  }

  function completeConsent() {
    setCompletion((c) => ({ ...c, consent: true }));
    setPhase('dashboard');
  }

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
        setStatus(`error: ${msg.error?.message ?? 'unknown'}`);
        break;
      default:
        break;
    }
  }

  function appendMessage(role, chunk) {
    setMessages((m) => {
      const last = m[m.length - 1];
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
    // Reuse the stream acquired by `beginInterview` when possible — that
    // pre-acquire is what keeps the permission prompt off the stage view.
    // Only fall back to getUserMedia here if the stream was never acquired
    // (shouldn't happen in the normal flow, but harmless as a safety net).
    const stream = micStreamRef.current ?? await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    micStreamRef.current = stream;
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    micCtxRef.current = ctx;

    const source = ctx.createMediaStreamSource(stream);

    // Mic analyser — a silent branch off the source, read by the orb.
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.7;
    source.connect(analyser);
    userAnalyserRef.current = analyser;

    const proc = ctx.createScriptProcessor(4096, 1, 1);
    micProcRef.current = proc;
    proc.onaudioprocess = (e) => {
      // Drop frames when the user has muted themselves. The track's
      // `enabled=false` already means the PCM is zeros, but sending silence
      // wastes bandwidth and would keep feeding Azure's VAD with audio it
      // should ignore.
      if (mutedRef.current) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const pcm16 = floatToPCM16(e.inputBuffer.getChannelData(0));
      const b64 = bytesToBase64(new Uint8Array(pcm16.buffer));
      ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 }));
      audioInCount.current++;
      if (audioInCount.current === 1 || audioInCount.current % 25 === 0) {
        console.log(`[client] → audio chunk #${audioInCount.current}`);
      }
    };
    source.connect(proc);
    proc.connect(ctx.destination);
    console.log('[client] recording started — mic analyser attached');
  }

  function stopRecording() {
    if (!micProcRef.current && !micStreamRef.current && !micCtxRef.current) return;
    console.log(`[client] stopRecording — sent ${audioInCount.current} chunks`);
    micProcRef.current?.disconnect();
    micProcRef.current = null;
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    micCtxRef.current?.close().catch(() => {});
    micCtxRef.current = null;
    userAnalyserRef.current = null;
  }

  function playAudioDelta(b64) {
    // Lazy-create playback ctx + analyser on the first delta so we don't
    // spin up an AudioContext before Anna actually starts talking.
    if (!playCtxRef.current) {
      const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      playCtxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.7;
      analyser.connect(ctx.destination);
      annaAnalyserRef.current = analyser;
      playTimeRef.current = ctx.currentTime;
      console.log('[client] playback ctx + Anna analyser attached');
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
    // Route through the analyser instead of directly to destination — the
    // analyser's connect-to-destination happens once at ctx creation.
    src.connect(annaAnalyserRef.current);
    const startAt = Math.max(ctx.currentTime, playTimeRef.current);
    src.start(startAt);
    playTimeRef.current = startAt + buf.duration;
  }

  if (phase === 'dashboard') {
    return (
      <Dashboard
        completion={completion}
        micError={micError}
        onStartConsent={startConsent}
        onStartInterview={beginInterview}
      />
    );
  }
  if (phase === 'consent') {
    return <Consent onConsent={completeConsent} onBack={() => setPhase('dashboard')} />;
  }
  if (phase === 'ended') {
    return <EndScreen onReturn={() => setPhase('dashboard')} />;
  }
  return (
    <Stage
      status={status}
      connected={connected}
      messages={messages}
      muted={muted}
      onToggleMute={toggleMute}
      annaAnalyserRef={annaAnalyserRef}
      userAnalyserRef={userAnalyserRef}
      onEnd={endAndReturnHome}
      transcriptBottomRef={transcriptBottomRef}
    />
  );
}

// ---- Dashboard ----

// Module status derivation lives next to the dashboard so the unlock
// rules are obvious in one place. Keep this in sync with the module
// list in `Dashboard` below.
function deriveModuleStatuses(completion) {
  return {
    consent: completion.consent ? 'completed' : 'available',
    interview: !completion.consent ? 'locked' : completion.interview ? 'completed' : 'available',
    surveys: 'locked',      // Phase 9 design-only
    retake: 'locked',       // unlocks 2 weeks after surveys — also Phase 9 design-only
  };
}

function Dashboard({ completion, micError, onStartConsent, onStartInterview }) {
  const s = deriveModuleStatuses(completion);
  const modules = [
    {
      key: 'consent',
      number: 1,
      title: 'Study consent',
      description: 'Review and sign the consent form before beginning.',
      status: s.consent,
      onStart: onStartConsent,
    },
    {
      key: 'interview',
      number: 2,
      title: 'Interview',
      description: 'A warm, unhurried conversation with Anna about your life.',
      status: s.interview,
      onStart: onStartInterview,
    },
/*    {
      key: 'surveys',
      number: 3,
      title: 'Surveys and experiments',
      description: 'A short set of surveys and decision-making tasks. Coming soon.',
      status: s.surveys,
    },
    {
      key: 'retake',
      number: 4,
      title: 'Self-consistency retake',
      description: 'Repeats the surveys to measure consistency over time. Unlocks two weeks after module 3.',
      status: s.retake,
    },*/
  ];

  return (
    <div style={landingPage}>
      <img src={opLogo} alt="OP" style={landingLogo} />
      <div style={dashboardInner}>
        <h1 style={{ ...dashboardHeadline, ...rise, animationDelay: '80ms' }}>
          Your study
        </h1>
        <p style={{ ...dashboardLede, ...rise, animationDelay: '200ms' }}>
          Work through each module in order. The next one unlocks as you complete the previous.
        </p>
        {micError && <div style={micErrorBanner}>{micError}</div>}
        <div style={moduleList}>
          {modules.map((m, i) => (
            <ModuleCard key={m.key} module={m} delay={320 + i * 90} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ModuleCard({ module: m, delay }) {
  const isAvailable = m.status === 'available';
  const isCompleted = m.status === 'completed';
  const isLocked = m.status === 'locked';

  return (
    <div style={{ ...moduleCard, ...rise, animationDelay: `${delay}ms`, opacity: isLocked ? 0.55 : 1 }}>
      <div style={moduleNumber}>{String(m.number).padStart(2, '0')}</div>
      <div style={moduleBody}>
        <div style={moduleTitleRow}>
          <span style={moduleTitle}>{m.title}</span>
          <StatusBadge status={m.status} />
        </div>
        <p style={moduleDescription}>{m.description}</p>
      </div>
      <div style={moduleAction}>
        {isAvailable && (
          <button
            onClick={m.onStart}
            style={primaryButton()}
            onMouseDown={(e) => (e.currentTarget.style.transform = 'scale(0.97)')}
            onMouseUp={(e) => (e.currentTarget.style.transform = 'scale(1)')}
            onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
          >
            Start
          </button>
        )}
        {isCompleted && <div style={completedMark}>✓ Completed</div>}
        {isLocked && <div style={lockedMark}>Locked</div>}
      </div>
    </div>
  );
}

function StatusBadge({ status }) {
  const label = {
    available: 'Available',
    completed: 'Completed',
    locked: 'Locked',
  }[status];
  return <span style={{ ...statusBadge, ...statusBadgeVariant[status] }}>{label}</span>;
}

// ---- Consent (stub — 9.2 will flesh this out with a placeholder PDF) ----

function Consent({ onConsent, onBack }) {
  return (
    <div style={landingPage}>
      <img src={opLogo} alt="OP" style={landingLogo} />
      <div style={consentInner}>
        <h1 style={{ ...dashboardHeadline, ...rise, animationDelay: '80ms' }}>
          Study consent
        </h1>
        <p style={{ ...dashboardLede, ...rise, animationDelay: '200ms' }}>
          (Placeholder — the signed PDF embed lands in the next phase.)
        </p>
        <div style={{ display: 'flex', gap: 12, ...rise, animationDelay: '320ms' }}>
          <button
            onClick={onConsent}
            style={primaryButton()}
            onMouseDown={(e) => (e.currentTarget.style.transform = 'scale(0.97)')}
            onMouseUp={(e) => (e.currentTarget.style.transform = 'scale(1)')}
            onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
          >
            I consent
          </button>
          <button onClick={onBack} style={consentBackButton}>Back</button>
        </div>
      </div>
    </div>
  );
}

function EndScreen({ onReturn }) {
  return (
    <div style={landingPage}>
      <img src={opLogo} alt="OP" style={landingLogo} />
      <div style={consentInner}>
        <h1 style={{ ...dashboardHeadline, ...rise, animationDelay: '80ms' }}>Thank you</h1>
        <p style={{ ...dashboardLede, ...rise, animationDelay: '200ms' }}>
          Thank you for participating in the study. Your time and responses are appreciated.
        </p>
        <div style={{ marginTop: 12, ...rise, animationDelay: '320ms' }}>
          <button onClick={onReturn} style={primaryButton()}>Return to home</button>
        </div>
      </div>
    </div>
  );
}

// ---- Stage ----

function Stage({ status, connected, messages, muted, onToggleMute, annaAnalyserRef, userAnalyserRef, onEnd, transcriptBottomRef }) {
  return (
    <div style={stagePage}>
      <main style={stageLayout}>
        <section style={annaCard}>
          <div style={cardCorner}>
            <span style={cornerDot} />
            <span style={cornerLabel}>Anna · AI interviewer</span>
          </div>

          <div style={orbSlot}>
            <Orb annaAnalyser={annaAnalyserRef} userAnalyser={userAnalyserRef} size={300} />
            <div style={annaName}>Anna</div>
            <div style={annaStatus}>{muted ? 'You are muted' : connected ? status : 'connecting…'}</div>
          </div>

          <div style={stageControlsRow}>
            <button
              onClick={onToggleMute}
              style={muted ? muteButtonActive : stageControlButton}
              aria-pressed={muted}
            >
              {muted ? 'Unmute' : 'Mute'}
            </button>
            <button onClick={onEnd} style={stageControlButton}>End interview</button>
          </div>
        </section>

        <aside style={transcriptCard}>
          <div style={transcriptHeader}>
            <span style={livePulse} />
            <span style={liveLabel}>Live · Transcript</span>
          </div>
          <div style={transcriptBody}>
            {messages.length === 0 && (
              <div style={transcriptEmpty}>Anna will begin in a moment…</div>
            )}
            {messages.map((m, i) => (
              <Bubble key={i} role={m.role} text={m.text} />
            ))}
            <div ref={transcriptBottomRef} />
          </div>
        </aside>
      </main>
    </div>
  );
}

function Bubble({ role, text }) {
  const isAnna = role === 'assistant';
  return (
    <div style={{ display: 'flex', justifyContent: isAnna ? 'flex-start' : 'flex-end' }}>
      <div style={isAnna ? bubbleAnna : bubbleUser}>
        <div style={bubbleLabel}>{isAnna ? 'Anna' : 'You'}</div>
        <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>
          {text || <em style={{ opacity: 0.6 }}>…</em>}
        </div>
      </div>
    </div>
  );
}

// ---- styles ----

const rise = { animation: 'riseIn 600ms ease both' };

const landingPage = {
  minHeight: '100vh',
  background: landingAtmosphere,
  backgroundAttachment: 'fixed',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '80px 24px 120px',
  position: 'relative',
  overflow: 'hidden',
};
const landingLogo = {
  position: 'absolute',
  top: 32,
  left: 40,
  height: 36,
  width: 'auto',
};

// -- dashboard --

const dashboardInner = {
  maxWidth: 760,
  width: '100%',
  display: 'flex',
  flexDirection: 'column',
  gap: 20,
};
const dashboardHeadline = {
  fontSize: 'clamp(40px, 6vw, 64px)',
  lineHeight: 1.05,
  margin: 0,
  fontWeight: 700,
  color: theme.ink,
  letterSpacing: '-0.02em',
};
const dashboardLede = {
  fontSize: 17,
  lineHeight: 1.55,
  color: theme.text,
  opacity: 0.72,
  maxWidth: 560,
  margin: 0,
};
const moduleList = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  marginTop: 28,
};
const moduleCard = {
  display: 'flex',
  alignItems: 'center',
  gap: 24,
  padding: '22px 24px',
  background: theme.surface,
  border: `1px solid ${theme.border}`,
  borderRadius: theme.radius,
  boxShadow: theme.shadowSoft,
};
const moduleNumber = {
  fontSize: 28,
  fontWeight: 700,
  color: theme.primary,
  letterSpacing: '-0.02em',
  minWidth: 48,
};
const moduleBody = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};
const moduleTitleRow = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
};
const moduleTitle = {
  fontSize: 18,
  fontWeight: 600,
  color: theme.ink,
};
const moduleDescription = {
  margin: 0,
  fontSize: 14,
  lineHeight: 1.5,
  color: theme.textMuted,
};
const moduleAction = {
  display: 'flex',
  alignItems: 'center',
  minWidth: 120,
  justifyContent: 'flex-end',
};
const completedMark = {
  fontSize: 13,
  fontWeight: 600,
  color: theme.primaryDeep,
  letterSpacing: '0.02em',
};
const lockedMark = {
  fontSize: 13,
  fontWeight: 500,
  color: theme.textMuted,
  letterSpacing: '0.02em',
};
const statusBadge = {
  fontSize: 11,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  fontWeight: 700,
  padding: '3px 8px',
  borderRadius: 999,
};
const statusBadgeVariant = {
  available: { background: 'rgba(238, 90, 0, 0.10)', color: theme.primaryDeep },
  completed: { background: 'rgba(178, 62, 0, 0.08)', color: theme.primaryDeep },
  locked: { background: theme.surfaceMuted, color: theme.textMuted },
};
const micErrorBanner = {
  marginTop: 12,
  padding: '12px 16px',
  borderRadius: theme.radiusSm,
  background: 'rgba(238, 90, 0, 0.08)',
  border: `1px solid ${theme.primary}`,
  color: theme.primaryDeep,
  fontSize: 14,
  lineHeight: 1.5,
};

// -- consent --

const consentInner = {
  maxWidth: 560,
  width: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 20,
};
const consentBackButton = {
  padding: '14px 24px',
  fontSize: 15,
  fontWeight: 500,
  border: `1px solid ${theme.border}`,
  borderRadius: 999,
  color: theme.text,
  background: theme.surface,
  cursor: 'pointer',
};

// -- stage --

const stagePage = {
  minHeight: '100vh',
  background: stageAtmosphere,
  backgroundAttachment: 'fixed',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '40px 24px',
  position: 'relative',
  overflow: 'hidden',
};
const stageLayout = {
  width: '100%',
  maxWidth: 1180,
  display: 'flex',
  gap: 24,
  alignItems: 'stretch',
  minHeight: 'min(85vh, 720px)',
  flexWrap: 'wrap',
};
const glassBase = {
  background: theme.glass,
  backdropFilter: 'blur(18px)',
  WebkitBackdropFilter: 'blur(18px)',
  border: `1px solid ${theme.glassBorder}`,
  borderRadius: theme.radiusXl,
  boxShadow: theme.shadowDeep,
  color: theme.textOnInk,
};
const annaCard = {
  ...glassBase,
  flex: '1 1 560px',
  position: 'relative',
  padding: '36px 32px 32px',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'space-between',
  overflow: 'hidden',
  minHeight: 600,
};
const cardCorner = {
  position: 'absolute',
  top: 24,
  left: 28,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};
const cornerDot = {
  width: 10,
  height: 10,
  borderRadius: '50%',
  background: `linear-gradient(135deg, ${theme.primaryLight}, ${theme.primary})`,
  boxShadow: `0 0 10px ${theme.primary}`,
};
const cornerLabel = {
  fontSize: 11,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  fontWeight: 700,
  color: theme.textOnInkMuted,
};
const orbSlot = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
  paddingTop: 40,
};
const annaName = {
  fontSize: 32,
  fontWeight: 800,
  color: theme.textOnInk,
  letterSpacing: '-0.01em',
  marginTop: 24,
};
const annaStatus = {
  fontSize: 13,
  color: theme.textOnInkMuted,
  letterSpacing: '0.06em',
};
const stageControlsRow = {
  display: 'flex',
  gap: 12,
  alignItems: 'center',
};
const stageControlButton = {
  padding: '10px 22px',
  fontSize: 13,
  fontWeight: 600,
  color: theme.textOnInk,
  background: 'rgba(255, 240, 228, 0.08)',
  border: `1px solid ${theme.glassBorder}`,
  borderRadius: 999,
  cursor: 'pointer',
  letterSpacing: '0.04em',
};
// When muted the button gets the orange accent — it's the louder state,
// the one the participant should notice if they've forgotten to un-mute.
const muteButtonActive = {
  ...stageControlButton,
  background: theme.primary,
  borderColor: theme.primary,
  color: 'white',
};

// -- transcript --

const transcriptCard = {
  ...glassBase,
  width: 380,
  flex: '0 1 380px',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  minHeight: 600,
};
const transcriptHeader = {
  padding: '20px 24px 14px',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  borderBottom: `1px solid ${theme.glassBorder}`,
};
const livePulse = {
  width: 9,
  height: 9,
  borderRadius: '50%',
  background: '#6EEB83',
  boxShadow: '0 0 10px rgba(110, 235, 131, 0.7)',
  animation: 'livePulse 2s ease-in-out infinite',
};
const liveLabel = {
  fontSize: 11,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  fontWeight: 700,
  color: theme.textOnInkMuted,
};
const transcriptBody = {
  flex: 1,
  padding: 20,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};
const transcriptEmpty = {
  color: theme.textOnInkMuted,
  fontSize: 14,
  fontStyle: 'italic',
  textAlign: 'center',
  marginTop: 40,
};

const bubbleBase = {
  maxWidth: '88%',
  padding: '10px 14px',
  borderRadius: theme.radius,
  fontSize: 14,
  lineHeight: 1.45,
};
const bubbleAnna = {
  ...bubbleBase,
  background: 'rgba(255, 240, 228, 0.1)',
  color: theme.textOnInk,
  border: `1px solid ${theme.glassBorder}`,
  borderBottomLeftRadius: 6,
};
const bubbleUser = {
  ...bubbleBase,
  background: `linear-gradient(135deg, ${theme.primary} 0%, ${theme.primaryDeep} 100%)`,
  color: 'white',
  borderBottomRightRadius: 6,
  boxShadow: '0 6px 20px rgba(238, 90, 0, 0.30)',
};
const bubbleLabel = {
  fontSize: 10,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  fontWeight: 700,
  opacity: 0.7,
  marginBottom: 4,
};
