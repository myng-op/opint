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

const pyAgentUrl = process.env.PY_AGENT_URL || 'http://localhost:8001';
if (!pyAgentUrl) {
  console.error('PY_AGENT_URL is empty — cannot reach Python sidecar');
  process.exit(1);
}

// GPT Realtime API — at least one provider (Azure or OpenAI direct) must be configured.
const hasAzureRealtime = process.env.AZURE_REALTIME_ENDPOINT && process.env.AZURE_REALTIME_KEY && process.env.AZURE_REALTIME_DEPLOYMENT;
const hasOpenaiRealtime = !!process.env.OPENAI_REALTIME_KEY;
if (!hasAzureRealtime && !hasOpenaiRealtime) {
  console.error('GPT Realtime API not configured — set AZURE_REALTIME_ENDPOINT+KEY+DEPLOYMENT or OPENAI_REALTIME_KEY');
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
  // Python LangGraph sidecar — owns the LLM call, tool dispatch, conversation
  // history, and Mongo writes for the agent path. Node only proxies STT/TTS
  // and persists transcript turns.
  pyAgent: {
    url: pyAgentUrl,
  },
  // GPT Realtime API — used for STT + VAD only. Azure preferred; OpenAI direct as fallback.
  realtime: {
    azureEndpoint: process.env.AZURE_REALTIME_ENDPOINT || null,
    azureDeployment: process.env.AZURE_REALTIME_DEPLOYMENT || null,
    azureKey: process.env.AZURE_REALTIME_KEY || null,
    openaiKey: process.env.OPENAI_REALTIME_KEY || null,
    openaiModel: process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview',
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
console.log(`[config] pyAgent.url=${config.pyAgent.url}`);
console.log(
  `[config] realtime: ${hasAzureRealtime ? 'Azure' : 'OpenAI direct'} ` +
    `${hasAzureRealtime ? `endpoint=${config.realtime.azureEndpoint} deployment=${config.realtime.azureDeployment}` : `model=${config.realtime.openaiModel}`}`
);
