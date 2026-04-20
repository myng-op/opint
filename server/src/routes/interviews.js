// REST lifecycle for Interview. Three endpoints:
//   POST /api/interviews          — create, returns id the client uses to open the WS
//   POST /api/interviews/:id/end  — mark as completed (idempotent)
//   GET  /api/interviews/:id      — read current state

import { Router } from 'express';
import mongoose from 'mongoose';
import { Interview } from '../models/Interview.js';
import { QuestionSet } from '../models/QuestionSet.js';

export const interviewsRouter = Router();

// Create a new interview bound to an existing QuestionSet. We validate the set
// exists here (not at WS open time) so the browser gets a clean 4xx if the
// admin deleted the set between page load and start.
interviewsRouter.post('/', async (req, res) => {
  const { questionSetId } = req.body ?? {};
  if (!mongoose.isValidObjectId(questionSetId)) {
    console.warn(`[api] create interview REJECT invalid questionSetId=${questionSetId}`);
    return res.status(400).json({ error: 'questionSetId required' });
  }
  const set = await QuestionSet.findById(questionSetId).select('_id title');
  if (!set) {
    console.warn(`[api] create interview REJECT questionSet not found id=${questionSetId}`);
    return res.status(404).json({ error: 'question set not found' });
  }

  const doc = await Interview.create({ questionSetId });
  console.log(`[api] interview created id=${doc._id} against set="${set.title}" (${questionSetId})`);
  res.status(201).json({
    _id: doc._id,
    questionSetId: doc.questionSetId,
    status: doc.status,
    currentIndex: doc.currentIndex,
    createdAt: doc.createdAt,
  });
});

// End an interview. Idempotent — double-calling is harmless and returns the
// current doc. Does NOT re-set endedAt if already completed.
interviewsRouter.post('/:id/end', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const doc = await Interview.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'not found' });
  if (doc.status !== 'completed') {
    doc.status = 'completed';
    doc.endedAt = new Date();
    await doc.save();
    console.log(`[api] interview ended id=${doc._id} (was: ${doc.status})`);
  } else {
    console.log(`[api] interview end id=${doc._id} — already completed, no-op`);
  }
  res.json(doc);
});

interviewsRouter.get('/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const doc = await Interview.findById(req.params.id).lean();
  if (!doc) return res.status(404).json({ error: 'not found' });
  res.json(doc);
});
