// Server-side tool dispatcher. When the model emits
// `response.function_call_arguments.done`, the realtime proxy calls
// `handleToolCall` with the event's `name` + parsed `arguments`, and expects
// a plain object back that will be serialized as the function_call_output.

import { Interview } from '../models/Interview.js';

export async function handleToolCall({ name, args, interviewId, questionSet }) {
  console.log(`[tools] dispatch name=${name} interview=${interviewId} args=${JSON.stringify(args)}`);
  switch (name) {
    case 'get_next_interview_question':
      return getNextInterviewQuestion({ interviewId, questionSet });
    default:
      // Defensive: any unknown tool name bubbles back to the model as an error
      // so it can recover gracefully rather than hang waiting on a silent drop.
      console.warn('[tools] UNKNOWN TOOL name=' + name);
      return { error: `unknown tool: ${name}` };
  }
}

// The core logic: read currentIndex, hand out that question, bump the index.
// We re-read the interview from Mongo (not the snapshot we held at WS open)
// so this is accurate across long sessions where the doc may have been mutated.
async function getNextInterviewQuestion({ interviewId, questionSet }) {
  const interview = await Interview.findById(interviewId);
  if (!interview) {
    console.error(`[tools] interview not found id=${interviewId}`);
    return { error: 'interview not found' };
  }

  const total = questionSet.questions.length;
  const idx = interview.currentIndex;
  console.log(
    `[tools] interview state before: status=${interview.status} currentIndex=${idx} total=${total}`
  );

  // Exhausted — mark completed and signal done to the model so it can close out.
  if (idx >= total) {
    if (interview.status !== 'completed') {
      interview.status = 'completed';
      interview.endedAt = new Date();
      await interview.save();
      console.log(`[tools] interview COMPLETED (no more questions) id=${interviewId}`);
    } else {
      console.log(`[tools] interview already completed id=${interviewId} — returning done again`);
    }
    return { done: true,
             closing_note: 'Thank the participant warmly for sharing their story. Their contribution is valuable to this research.'
     };
  }

  const q = questionSet.questions[idx];
  console.log(`[tools] handing out question[${idx}] key="${q.key}" content="${q.content.slice(0, 80)}…"`);

  // First tool call transitions pending → in_progress and stamps startedAt.
  if (interview.status === 'pending') {
    interview.status = 'in_progress';
    interview.startedAt = new Date();
    console.log(`[tools] status pending → in_progress (startedAt set)`);
  }
  interview.currentIndex = idx + 1;
  await interview.save();
  console.log(`[tools] interview state after: status=${interview.status} currentIndex=${interview.currentIndex}`);

  const result = {
    key: q.key,
    content: q.content,
    // `type` tells the model how to deliver this item: `non-question` items
    // (intro, transitions, closing) are *stated*, not asked, and the model
    // should fetch the next item without waiting for a participant response.
    // `qualitative` / `factual` are asked as questions and require waiting.
    type: q.type,
    requirement: q.requirement,
    // Snake_case on the wire — that's what the model sees. Null = unlimited.
    max_sec: q.maxSec,
    question_number: idx + 1,
    total_questions: total,
  };
  return result;
}
