// SSML translator for Azure Neural TTS (DragonHD voices).
//
// The LLM's output may contain delivery cues authored in speech.md:
//   <break time="300ms"/>    — Azure SSML passthrough (supported on DragonHD)
//   <emotion value="..."/>   — not supported on DragonHD; stripped (model auto-detects)
//   [laughter]               — no DragonHD primitive; replaced with a soft pause
//
// This module translates those cues into valid Azure SSML and wraps the result
// in a <speak><voice> envelope so the Speech SDK's speakSsmlAsync can consume it.

const SPEAK_OPEN =
  '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis"' +
  ' xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US">';

// Emotion tags: <emotion value="peaceful" />, <emotion value="sad"/>, etc.
// DragonHD auto-detects emotion from text — strip the tags, keep inner text.
// Handles both self-closing and paired forms.
const EMOTION_SELF_CLOSE = /<emotion\s+value="[^"]*"\s*\/>/gi;
const EMOTION_OPEN = /<emotion\s+value="[^"]*"\s*>/gi;
const EMOTION_CLOSE = /<\/emotion\s*>/gi;

// [laughter] → soft pause. DragonHD can't produce explicit laughter.
const LAUGHTER = /\[laughter\]/gi;

// Valid SSML tags we want to preserve (self-closing <break .../> only for DragonHD).
const BREAK_TAG = /<break\s+[^>]*\/>/gi;

// XML-escape text content (everything that isn't a preserved SSML tag).
function xmlEscape(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildSSML(text, { voice }) {
  let work = text;

  // 1. Strip emotion tags (self-closing and paired).
  work = work.replace(EMOTION_SELF_CLOSE, '');
  work = work.replace(EMOTION_OPEN, '');
  work = work.replace(EMOTION_CLOSE, '');

  // 2. [laughter] → soft pause.
  work = work.replace(LAUGHTER, '<break time="200ms"/>');

  // 3. Extract valid <break/> tags, XML-escape the rest, then re-insert.
  const breaks = [];
  work = work.replace(BREAK_TAG, (match) => {
    const idx = breaks.length;
    breaks.push(match);
    return `\x00BREAK${idx}\x00`;
  });

  work = xmlEscape(work);

  for (let i = 0; i < breaks.length; i++) {
    work = work.replace(`\x00BREAK${i}\x00`, breaks[i]);
  }

  // 4. Wrap in SSML envelope.
  return `${SPEAK_OPEN}<voice name="${voice}">${work}</voice></speak>`;
}
