// Server entrypoint. Wires HTTP (Express) + WS (Azure proxy) onto one port,
// and fails fast if Mongo isn't reachable at boot.

import http from 'node:http';
import express from 'express';
import { config } from './config.js';
import { connectDb, dbPing } from './db.js';
import { attachRealtimeProxy } from './realtime.js';
import { questionSetsRouter } from './routes/questionSets.js';
import { interviewsRouter } from './routes/interviews.js';

const app = express();
app.use(express.json());

// Request logger. Prints every REST call with method, url, status, and latency.
// Placed before routes so it wraps both handlers and error responses.
app.use((req, res, next) => {
  const started = Date.now();
  console.log(`[api] → ${req.method} ${req.url}`);
  res.on('finish', () => {
    console.log(`[api] ← ${req.method} ${req.url} ${res.statusCode} (${Date.now() - started}ms)`);
  });
  next();
});

// Liveness + readiness in one endpoint. `db: false` means the process is up
// but Mongo is unreachable — useful when triaging "is my app broken or is Mongo down?".
app.get('/health', async (_req, res) => {
  const db = await dbPing().catch(() => false);
  res.json({ ok: true, db });
});

// REST API. All data routes mounted under /api so the realtime WS proxy
// (which shares this HTTP server) doesn't collide with them.
app.use('/api/question-sets', questionSetsRouter);
app.use('/api/interviews', interviewsRouter);
console.log('[server] routes mounted: /health, /api/question-sets, /api/interviews');

const server = http.createServer(app);

// The WS server shares the HTTP server so we only bind one port.
// Browser connects to ws://localhost:3001 (proxied through Vite in dev).
attachRealtimeProxy(server);

// Boot order matters: DB first so /health is truthful from the first request.
// If Mongo is down we want a loud crash, not a half-broken server.
await connectDb();
server.listen(config.port, () => {
  console.log(`[server] listening on http://localhost:${config.port}`);
});
