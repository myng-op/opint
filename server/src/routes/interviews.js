// REST lifecycle for Interview. Three endpoints:
//   POST /api/interviews          — create, returns id the client uses to open the WS
//   POST /api/interviews/:id/end  — mark as completed (idempotent)
//   GET  /api/interviews/:id      — read current state

import { Router } from 'express';
import mongoose from 'mongoose';
import { Interview } from '../models/Interview.js';
import { QuestionSet } from '../models/QuestionSet.js';
import { TranscriptTurn } from '../models/TranscriptTurn.js';

export const interviewsRouter = Router();

// List all interviews, newest first. Includes the question-set title and a
// turn count so the index is useful on its own — you can pick an id and drill
// into `/:id/transcript`.
interviewsRouter.get('/', async (_req, res) => {
  const docs = await Interview.aggregate([
    { $sort: { createdAt: -1 } },
    {
      $lookup: {
        from: 'questionsets',
        localField: 'questionSetId',
        foreignField: '_id',
        as: 'questionSet',
      },
    },
    { $unwind: { path: '$questionSet', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'transcriptturns',
        localField: '_id',
        foreignField: 'interviewId',
        as: 'turns',
      },
    },
    {
      $project: {
        _id: 1,
        status: 1,
        currentIndex: 1,
        startedAt: 1,
        endedAt: 1,
        createdAt: 1,
        questionSetId: 1,
        questionSetTitle: '$questionSet.title',
        turnCount: { $size: '$turns' },
      },
    },
  ]);
  console.log(`[api] interviews list → ${docs.length} docs`);
  res.json(docs);
});

// Create a new interview bound to an existing QuestionSet. We validate the set
// exists here (not at WS open time) so the browser gets a clean 4xx if the
// admin deleted the set between page load and start.
interviewsRouter.post('/', async (req, res) => {
  const { questionSetId, language, ttsVoice } = req.body ?? {};
  if (!mongoose.isValidObjectId(questionSetId)) {
    console.warn(`[api] create interview REJECT invalid questionSetId=${questionSetId}`);
    return res.status(400).json({ error: 'questionSetId required' });
  }
  const set = await QuestionSet.findById(questionSetId).select('_id title');
  if (!set) {
    console.warn(`[api] create interview REJECT questionSet not found id=${questionSetId}`);
    return res.status(404).json({ error: 'question set not found' });
  }

  const doc = await Interview.create({
    questionSetId,
    language: language || '',
    ttsVoice: ttsVoice || '',
  });
  console.log(`[api] interview created id=${doc._id} against set="${set.title}" (${questionSetId}) lang=${doc.language || 'default'}`);
  res.status(201).json({
    _id: doc._id,
    questionSetId: doc.questionSetId,
    status: doc.status,
    currentIndex: doc.currentIndex,
    language: doc.language,
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

// Read the recorded conversation. Turns are only persisted on completion, so
// there are no partials here — what you see is what the model / whisper
// finalised, in the order it happened.
interviewsRouter.get('/:id/transcript', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const interview = await Interview.findById(req.params.id).select('_id status').lean();
  if (!interview) return res.status(404).json({ error: 'not found' });

  const turns = await TranscriptTurn
    .find({ interviewId: req.params.id })
    .sort({ sequence: 1 })
    .select('sequence role text createdAt')
    .lean();

  console.log(`[api] transcript read id=${req.params.id} turns=${turns.length}`);
  res.json({ interviewId: interview._id, status: interview.status, turns });
});
