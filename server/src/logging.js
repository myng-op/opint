// Compact formatters for realtime-WS frames. Goals:
//  - Every event visible on the log at least as a type name.
//  - Audio deltas rendered as one short line with a byte estimate, never the full base64.
//  - Transcript deltas and errors rendered with their actual text so you can follow the conversation live.

const AUDIO_DELTA_TYPES = new Set([
  'response.output_audio.delta',
  'response.audio.delta',
]);

// base64 → raw bytes is ~ length * 3/4. Rounded for readability.
function b64Bytes(b64) {
  return Math.round((b64 ?? '').length * 0.75);
}

export function describeEvent(raw, msg) {
  if (!msg || !msg.type) return `non-json frame (${raw.length}B)`;
  const t = msg.type;

  if (AUDIO_DELTA_TYPES.has(t)) return `${t} audio(${b64Bytes(msg.delta)}B)`;
  if (t === 'input_audio_buffer.append') return `${t} audio(${b64Bytes(msg.audio)}B)`;

  if (t === 'response.output_audio_transcript.delta' || t === 'response.audio_transcript.delta') {
    return `${t} "${(msg.delta ?? '').replace(/\n/g, ' ').slice(0, 80)}"`;
  }
  if (t === 'response.output_audio_transcript.done' || t === 'response.audio_transcript.done') {
    return `${t} transcript="${(msg.transcript ?? '').replace(/\n/g, ' ').slice(0, 120)}"`;
  }
  if (t === 'conversation.item.input_audio_transcription.completed') {
    return `${t} transcript="${(msg.transcript ?? '').replace(/\n/g, ' ').slice(0, 120)}"`;
  }
  if (t === 'response.function_call_arguments.delta') {
    return `${t} call_id=${msg.call_id} delta="${(msg.delta ?? '').slice(0, 60)}"`;
  }
  if (t === 'response.function_call_arguments.done') {
    return `${t} name=${msg.name} call_id=${msg.call_id} args=${msg.arguments}`;
  }
  if (t === 'error') return `ERROR ${JSON.stringify(msg.error)}`;

  // Default: just the type name. Rich enough to trace the lifecycle without drowning in payloads.
  return t;
}
