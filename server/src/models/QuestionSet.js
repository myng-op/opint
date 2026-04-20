// Question bank schema. One `QuestionSet` doc = one interview's worth of questions,
// seeded from a file in /interviews. Questions are embedded as an ordered array
// (not a separate collection) because they're always read together with the set
// and never referenced independently.

import mongoose from 'mongoose';

// Embedded subdoc. `_id: false` skips the auto ObjectId — we identify questions
// by their original JSON key (`q1`, `q2`) which is stable across re-seeds.
const QuestionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },          // original id from the JSON file ("q1")
    content: { type: String, required: true },      // the question text spoken to the user
    type: { type: String, default: 'qualitative' }, // free-text category; no enum until we know the taxonomy
    requirement: { type: String, default: '' },     // AI-facing coaching: what this question is trying to learn
    condition: { type: String, default: '' },       // future branching logic; empty for now
    maxSec: { type: Number, default: null },        // per-answer time budget, null = unlimited
  },
  { _id: false }
);

const QuestionSetSchema = new mongoose.Schema(
  {
    // `title` is the filename stem of the seed JSON and the upsert key.
    // Unique index so re-seeding the same file updates in place instead of duplicating.
    title: { type: String, required: true, unique: true, index: true },
    description: { type: String, default: '' },
    questions: { type: [QuestionSchema], default: [] }, // ordered — index in array = ask order
  },
  { timestamps: true }
);

export const QuestionSet = mongoose.model('QuestionSet', QuestionSetSchema);
