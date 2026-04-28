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
const required = [
  'AZURE_AI_ENDPOINT', 'AZURE_AI_KEY', 'AZURE_AI_DEPLOYMENT',
  'AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION',
];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const useEnvAgent = process.env.USE_PY_AGENT === 'true';
const pyAgentUrl = process.env.PY_AGENT_URL || 'http://localhost:8001';
if (useEnvAgent && !pyAgentUrl) {
  console.error('USE_PY_AGENT=true but PY_AGENT_URL is empty');
  process.exit(1);
}

export const config = {
  port: Number(process.env.PORT) || 3001,
  llm: {
    // Azure AI Foundry Chat Completions — used by the LLM step of the new pipeline.
    endpoint: process.env.AZURE_AI_ENDPOINT,
    apiKey: process.env.AZURE_AI_KEY,
    deployment: process.env.AZURE_AI_DEPLOYMENT,
    apiVersion: process.env.AZURE_AI_API_VERSION || '2024-10-21',
  },
  stt: {
    // Azure Cognitive Services Speech — used for streaming recognition.
    key: process.env.AZURE_SPEECH_KEY,
    region: process.env.AZURE_SPEECH_REGION,
    endpoint: process.env.AZURE_SPEECH_ENDPOINT, // optional override
    language: process.env.AZURE_STT_LANGUAGE || 'en-US',
  },
  tts: {
    // Same Speech resource as STT, separate config group so voice is explicit.
    // 'coral' is OpenAI-realtime-only; Azure Neural TTS needs an Azure voice name.
    key: process.env.AZURE_SPEECH_KEY,
    region: process.env.AZURE_SPEECH_REGION,
    endpoint: process.env.AZURE_SPEECH_ENDPOINT,
    voice: process.env.AZURE_TTS_VOICE || 'en-US-JennyMultilingualNeural',
  },
  mongo: {
    uri: process.env.MONGO_URI || 'mongodb://localhost:27017/opint',
  },
  // Phase 11.6 — Python LangGraph sidecar cutover. When `useEnvAgent` is true
  // realtime.js delegates the LLM+tool-loop step to the Py service instead of
  // calling Azure Chat Completions directly.
  pyAgent: {
    useEnvAgent,
    url: pyAgentUrl,
  },
};

// One-liner dump at import time. Secrets are never printed — only their
// presence + length so you can tell whether .env was picked up.
const lenOf = (v) => (v ?? '').length;
console.log(
  `[config] port=${config.port} mongo=${config.mongo.uri}`
);
console.log(
  `[config] llm.endpoint=${config.llm.endpoint} llm.deployment=${config.llm.deployment} ` +
    `llm.apiVersion=${config.llm.apiVersion} llm.apiKey=<${lenOf(config.llm.apiKey)} chars>`
);
console.log(
  `[config] stt.region=${config.stt.region} stt.language=${config.stt.language} ` +
    `stt.key=<${lenOf(config.stt.key)} chars> tts.voice=${config.tts.voice}`
);
console.log(
  `[config] pyAgent.useEnvAgent=${config.pyAgent.useEnvAgent} pyAgent.url=${config.pyAgent.url}`
);
