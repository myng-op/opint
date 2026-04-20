// One `TranscriptTurn` doc = one completed utterance in an Interview.
//
// We only persist on *completion* events:
//   - user     → `conversation.item.input_audio_transcription.completed`
//   - assistant → `response.output_audio_transcript.done` (or legacy `.audio_transcript.done`)
//
// Intentional: partial deltas are NOT buffered. If the WS dies mid-turn, that
// half-turn is dropped. This keeps the DB clean of noise and matches how a
// human would summarise an interview ("what was actually said and heard").

import mongoose from 'mongoose';

const TranscriptTurnSchema = new mongoose.Schema(
  {
    // The conversation this turn belongs to.
    interviewId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Interview',
      required: true,
      index: true,
    },

    // Monotonic per-interview ordering. Seeded from `countDocuments` at WS open,
    // incremented locally per save. Makes replay trivial without relying on
    // Mongo's createdAt tie-breaking.
    sequence: { type: Number, required: true, min: 0 },

    role: {
      type: String,
      enum: ['user', 'assistant'],
      required: true,
    },

    // The final recognised text. Empty strings are allowed (e.g. the mic was
    // hot but nothing was said) — the UI can filter them out.
    text: { type: String, default: '' },
  },
  { timestamps: true }
);

// Compound index so transcript reads stream in order without a separate sort pass.
TranscriptTurnSchema.index({ interviewId: 1, sequence: 1 });

export const TranscriptTurn = mongoose.model('TranscriptTurn', TranscriptTurnSchema);
