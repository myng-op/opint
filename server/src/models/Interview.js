// One `Interview` doc = one live conversation run. Refs a QuestionSet and
// tracks the linear progression through it. Transcript turns will attach to
// this doc in Phase 5.

import mongoose from 'mongoose';

const InterviewSchema = new mongoose.Schema(
  {
    // Points at the template. Index because we'll filter by it in the admin view later.
    questionSetId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'QuestionSet',
      required: true,
      index: true,
    },

    // Lifecycle: pending (created, not yet greeted) → in_progress (first question fetched)
    //         → completed (tool returned done OR /end was called).
    status: {
      type: String,
      enum: ['pending', 'in_progress', 'completed'],
      default: 'pending',
      index: true,
    },

    // Index of the NEXT question to ask. When the tool is called we read this,
    // return that question, then increment. When currentIndex === questions.length
    // the interview is done.
    currentIndex: { type: Number, default: 0, min: 0 },

    startedAt: Date,
    endedAt: Date,
  },
  { timestamps: true }
);

export const Interview = mongoose.model('Interview', InterviewSchema);
