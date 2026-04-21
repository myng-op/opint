// /review — operator-facing list of all recorded interviews.
// Not linked from / (the participant surface stays clean). Reachable only by
// typing the URL. No auth — demo only.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { theme, secondaryButton } from '../theme.js';

function fmt(d) {
  if (!d) return '—';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

const statusColors = {
  pending:     { bg: '#FFF3E6', fg: '#B23E00' },
  in_progress: { bg: '#FFE5D1', fg: '#B23E00' },
  completed:   { bg: '#E6F4EA', fg: '#1F6B3A' },
};

export default function Review() {
  const [interviews, setInterviews] = useState(null);
  const [error, setError] = useState(null);

  async function load() {
    try {
      console.log('[client/review] GET /api/interviews');
      const res = await fetch('/api/interviews');
      const data = await res.json();
      console.log(`[client/review] received ${Array.isArray(data) ? data.length : 0} interviews`);
      setInterviews(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('[client/review] load failed', err);
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  return (
    <div style={wrap}>
      <header style={header}>
        <h1 style={title}>Past interviews</h1>
        <button onClick={load} style={secondaryButton()}>Refresh</button>
      </header>

      {error && <div style={errorBox}>Error: {error}</div>}
      {interviews === null && !error && <div style={muted}>Loading…</div>}
      {interviews?.length === 0 && <div style={muted}>No interviews yet. Run one at <code>/</code>.</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {interviews?.map((it) => {
          const color = statusColors[it.status] ?? statusColors.pending;
          return (
            <Link key={it._id} to={`/review/${it._id}`} style={cardLink}>
              <div style={card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                  <div style={{ fontWeight: 600, fontSize: 16 }}>{it.questionSetTitle ?? '(unknown question set)'}</div>
                  <span style={{ ...pill, background: color.bg, color: color.fg }}>{it.status}</span>
                </div>
                <div style={{ ...meta, marginTop: 6 }}>
                  <span>{it.turnCount} turn{it.turnCount === 1 ? '' : 's'}</span>
                  <span style={dot} />
                  <span>started {fmt(it.startedAt ?? it.createdAt)}</span>
                  {it.endedAt && <><span style={dot} /><span>ended {fmt(it.endedAt)}</span></>}
                </div>
                <div style={{ ...meta, marginTop: 4, fontSize: 12 }}>id: <code>{it._id}</code></div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

const wrap = { maxWidth: 720, margin: '48px auto', padding: '0 20px' };
const header = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 };
const title = { fontSize: 28, fontWeight: 700, color: theme.text, margin: 0 };
const muted = { color: theme.textMuted, padding: '16px 0' };
const cardLink = { textDecoration: 'none', color: 'inherit' };
const card = {
  background: theme.surface,
  border: `1px solid ${theme.border}`,
  borderRadius: theme.radius,
  padding: '16px 18px',
  boxShadow: theme.shadowSoft,
};
const pill = { fontSize: 12, fontWeight: 600, padding: '4px 10px', borderRadius: 999, textTransform: 'lowercase' };
const meta = { display: 'flex', gap: 8, alignItems: 'center', color: theme.textMuted, fontSize: 13, flexWrap: 'wrap' };
const dot = { width: 3, height: 3, borderRadius: '50%', background: theme.textMuted, display: 'inline-block' };
const errorBox = { background: '#FFE5E5', color: '#8B1A1A', padding: 12, borderRadius: theme.radiusSm, marginBottom: 16 };
