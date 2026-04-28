// Assembles the interviewer persona prompt and tool definition used by the
// STT→LLM→TTS pipeline. The persona is split across markdown files under
// `prompts/anna/` (repo root) and concatenated at server start.
// Same source-of-truth as the Python LangGraph sidecar (Phase 11.1).
//
// Exports:
//   getSystemPrompt()   — full system prompt string
//   getToolDefinition() — Chat Completions tool shape

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(__dirname, '..', '..', '..', 'prompts', 'anna');

function loadPrompt(name) {
  const file = path.join(PROMPTS_DIR, `${name}.md`);
  const text = fs.readFileSync(file, 'utf8').trim();
  console.log(`[session] loaded prompt ${name}.md (${text.length} chars)`);
  return text;
}

// Concatenate in order:
//   persona    — who Anna is (the model re-reads the top most often)
//   speech     — how she vocalizes (fillers, pauses, emotion cues) — extends persona
//   mechanics  — tool flow / item types (kept near where the AI decides to call the tool)
//   guardrails — last, so they override anything above
const SYSTEM_PROMPT = [
  loadPrompt('persona'),
  loadPrompt('speech'),
  loadPrompt('mechanics'),
  loadPrompt('guardrails'),
].join('\n\n');

console.log(`[session] system prompt assembled: ${SYSTEM_PROMPT.length} chars total`);

// Tool schema. No parameters: server owns the interview state, the AI just asks for "the next one".
// Description doubles as usage guidance the AI references at call time.
//
// Shape: Chat Completions `tools` array element.
// Phase C passes [getToolDefinition()] in the Chat Completions request body.
const GET_NEXT_QUESTION_TOOL = {
  type: 'function',
  function: {
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
  },
};

/** Returns the fully assembled system prompt (persona + speech + mechanics + guardrails).
 *  When `language` is a non-English locale (e.g. "fi-FI"), a language instruction
 *  is appended so the LLM speaks the target language throughout the interview. */
export function getSystemPrompt(language) {
  if (!language || language.startsWith('en')) return SYSTEM_PROMPT;
  // Map BCP-47 locale to a human-readable language name.
  let langName;
  try {
    langName = new Intl.DisplayNames(['en'], { type: 'language' }).of(language);
  } catch {
    langName = language;
  }
  const langDirective =
    `\n\n# Language\n\n` +
    `Conduct this entire interview in **${langName}**. ` +
    `All your speech — greetings, questions, follow-ups, acknowledgements, ` +
    `and closing — must be in ${langName}. ` +
    `If the participant switches to another language, gently continue in ${langName}.`;
  return SYSTEM_PROMPT + langDirective;
}

/** Returns the tool definition in Chat Completions shape. */
export function getToolDefinition() {
  return GET_NEXT_QUESTION_TOOL;
}
