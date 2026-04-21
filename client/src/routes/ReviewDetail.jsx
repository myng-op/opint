// /review/:id — transcript playback for a single interview.
// Snapshot on load. A manual "Refresh" button re-fetches — simpler than a
// polling loop, and sufficient for reviewing completed sessions.

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { theme, secondaryButton } from '../theme.js';

function fmt(d) {
  if (!d) return '';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString();
}

export default function ReviewDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  async function load() {
    try {
      console.log(`[client/reviewDetail] GET /api/interviews/${id}/transcript`);
      const res = await fetch(`/api/interviews/${id}/transcript`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      console.log(`[client/reviewDetail] ${json.turns?.length ?? 0} turns loaded`);
      setData(json);
    } catch (err) {
      console.error('[client/reviewDetail] load failed', err);
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, [id]);

  return (
    <div style={wrap}>
      <div style={topBar}>
        <Link to="/review" style={backLink}>← All interviews</Link>
        <button onClick={load} style={secondaryButton()}>Refresh</button>
      </div>

      <h1 style={title}>Transcript</h1>
      <div style={idLine}>id <code>{id}</code>{data?.status && <> · <em>{data.status}</em></>}</div>

      {error && <div style={errorBox}>Error: {error}</div>}
      {data === null && !error && <div style={muted}>Loading…</div>}
      {data?.turns?.length === 0 && <div style={muted}>No turns recorded for this interview.</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 20 }}>
        {data?.turns?.map((t) => (
          <Bubble key={t._id ?? t.sequence} role={t.role} text={t.text} time={fmt(t.createdAt)} />
        ))}
      </div>
    </div>
  );
}

function Bubble({ role, text, time }) {
  const isAnna = role === 'assistant';
  return (
    <div style={{ display: 'flex', justifyContent: isAnna ? 'flex-start' : 'flex-end' }}>
      <div style={isAnna ? bubbleAnna : bubbleUser}>
        <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.75, marginBottom: 4 }}>
          {isAnna ? 'Anna' : 'Participant'}{time && <span style={{ opacity: 0.6, fontWeight: 400 }}> · {time}</span>}
        </div>
        <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>{text || <em style={{ opacity: 0.6 }}>(empty)</em>}</div>
      </div>
    </div>
  );
}

const wrap = { maxWidth: 720, margin: '48px auto', padding: '0 20px' };
const topBar = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 };
const backLink = { color: theme.primary, textDecoration: 'none', fontWeight: 500 };
const title = { fontSize: 28, fontWeight: 700, color: theme.text, margin: '0 0 4px' };
const idLine = { color: theme.textMuted, fontSize: 13, marginBottom: 8 };
const muted = { color: theme.textMuted, padding: '16px 0' };
const errorBox = { background: '#FFE5E5', color: '#8B1A1A', padding: 12, borderRadius: theme.radiusSm, marginBottom: 16 };

const bubbleBase = {
  maxWidth: '78%',
  padding: '12px 16px',
  borderRadius: theme.radius,
  boxShadow: theme.shadowSoft,
  fontSize: 15,
};
const bubbleAnna = {
  ...bubbleBase,
  background: theme.surface,
  color: theme.text,
  borderBottomLeftRadius: 6,
  border: `1px solid ${theme.border}`,
};
const bubbleUser = {
  ...bubbleBase,
  background: `linear-gradient(135deg, ${theme.primary} 0%, ${theme.primaryDeep} 100%)`,
  color: 'white',
  borderBottomRightRadius: 6,
};
