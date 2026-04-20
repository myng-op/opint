// REST endpoints for the Admin surface to read the question bank.
// No write endpoints yet — seeding is the only way to populate data in Phase 2.

import { Router } from 'express';
import mongoose from 'mongoose';
import { QuestionSet } from '../models/QuestionSet.js';

export const questionSetsRouter = Router();

// Lightweight listing. We use an aggregation instead of `find` so we can project
// `questionCount` (via $size) without pulling the full questions array into the
// response — the admin index page only needs counts, not content.
questionSetsRouter.get('/', async (_req, res) => {
  const sets = await QuestionSet.aggregate([
    {
      $project: {
        title: 1,
        description: 1,
        createdAt: 1,
        updatedAt: 1,
        questionCount: { $size: '$questions' },
      },
    },
    { $sort: { updatedAt: -1 } },
  ]);
  res.json(sets);
});

// Full detail for a single set (used when viewing/previewing questions).
// Validates the id shape up front so malformed URLs get a clean 400 instead
// of a 500 from mongoose throwing deeper in the stack.
questionSetsRouter.get('/:id', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error: 'invalid id' });
  const doc = await QuestionSet.findById(id).lean();
  if (!doc) return res.status(404).json({ error: 'not found' });
  res.json(doc);
});
