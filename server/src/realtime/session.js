// Builds the Azure Realtime `session.update` payload the server sends upstream
// as soon as the WS opens. This is where the interviewer persona, the tool
// definition, and the audio format all live — all in the server, never the browser.
//
// The persona is split across three markdown files under `./prompts/`:
//   - persona.md    — who Anna is, how she sounds, silence discipline, opening
//   - mechanics.md  — tool usage, follow-ups, transitions, closing
//   - guardrails.md — researcher/therapist boundary, neutrality, AI transparency, etc.
// Files are read once at server start and concatenated. Edit a file, restart
// the server, the new prompt takes effect on the next WS connection.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE = 24000;

// 2 seconds of silence before Azure's server VAD considers a turn ended.
// Much longer than the default (~500ms) — matches Anna's low-arousal pacing
// and honors the "silence is a space to think" rule in persona.md.
const SILENCE_DURATION_MS = 500;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(__dirname, 'prompts');

function loadPrompt(name) {
  const file = path.join(PROMPTS_DIR, `${name}.md`);
  const text = fs.readFileSync(file, 'utf8').trim();
  console.log(`[session] loaded prompt ${name}.md (${text.length} chars)`);
  return text;
}

// Concatenate in order: persona first (the model re-reads the top most often),
// mechanics second (so the tool rules are near where the AI decides to call it),
// guardrails last (they override anything above).
const SYSTEM_PROMPT = [
  loadPrompt('persona'),
  loadPrompt('mechanics'),
  loadPrompt('guardrails'),
].join('\n\n');

console.log(`[session] system prompt assembled: ${SYSTEM_PROMPT.length} chars total`);

// Tool schema. No parameters: server owns the interview state, the AI just asks for "the next one".
// Description doubles as usage guidance the AI references at call time.
const GET_NEXT_QUESTION_TOOL = {
  type: 'function',
  name: 'get_next_interview_question',
  description:
    "Fetch the next interview item to deliver. Items have a `type`: " +
    "`non-question` means a statement to *say* (intro, transition, or closing) — deliver it in your own voice, do NOT wait for a participant response, and immediately call this tool again to get the next item. " +
    "`qualitative` or `factual` means a question to *ask* — deliver it, wait for the participant to answer, optionally ask ONE gentle follow-up, then call this tool again. " +
    "Returns { key, content, type, requirement, max_sec, question_number, total_questions }, or { done: true } when the interview is complete.",
  parameters: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
};

export function buildSessionConfig({ voice }) {
  console.log(
    `[session] build voice=${voice} sampleRate=${SAMPLE_RATE} vadSilence=${SILENCE_DURATION_MS}ms ` +
      `tools=[get_next_interview_question] prompt=${SYSTEM_PROMPT.length}chars`
  );
  return {
    type: 'realtime',
    output_modalities: ['audio'],
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: SAMPLE_RATE },
        turn_detection: { type: 'server_vad', silence_duration_ms: SILENCE_DURATION_MS },
        transcription: { model: 'whisper-1' },
      },
      output: {
        format: { type: 'audio/pcm', rate: SAMPLE_RATE },
        voice,
      },
    },
    instructions: SYSTEM_PROMPT,
    tools: [GET_NEXT_QUESTION_TOOL],
    tool_choice: 'auto',
  };
}
