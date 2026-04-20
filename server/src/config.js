// Central config loader. Reads the repo-root .env and exposes a typed object
// to the rest of the server. Validates that required secrets are present so
// we crash at boot (loud) instead of on first request (confusing).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// We explicitly resolve the repo-root .env (two levels up from this file)
// because `npm run dev` is launched from /server, so process.cwd() is /server
// and the default dotenv lookup would miss the root file.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Hard-fail if any of these are missing. Adding to this list = adding a boot-time gate.
const required = ['AZURE_ENDPOINT', 'AZURE_API_KEY', 'AZURE_REALTIME_MODEL'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

export const config = {
  port: Number(process.env.PORT) || 3001,
  azure: {
    endpoint: process.env.AZURE_ENDPOINT,
    apiKey: process.env.AZURE_API_KEY,
    model: process.env.AZURE_REALTIME_MODEL,
    apiVersion: process.env.AZURE_API_VERSION, // optional
  },
  mongo: {
    uri: process.env.MONGO_URI || 'mongodb://localhost:27017/opint',
  },
};

// One-liner dump at import time. Key is never printed — only its presence + length
// so you can tell whether .env was picked up without leaking the secret.
const keyLen = (process.env.AZURE_API_KEY ?? '').length;
console.log(
  `[config] port=${config.port} mongo=${config.mongo.uri} azure.endpoint=${config.azure.endpoint} ` +
    `azure.model=${config.azure.model} azure.apiVersion=${config.azure.apiVersion ?? '-'} azure.apiKey=<${keyLen} chars>`
);
