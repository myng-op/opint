// Seeder: reads every *.json in /interviews and upserts one QuestionSet per file.
// Run manually with `npm run seed` — never touches the DB on server boot.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { connectDb } from './db.js';
import { QuestionSet } from './models/QuestionSet.js';

// /interviews lives at the repo root — two levels up from server/src/seed.js.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INTERVIEWS_DIR = path.resolve(__dirname, '../../interviews');

// Transform the raw JSON shape { q1: {...}, q2: {...} } into the embedded-subdoc
// shape our schema expects. Insertion order is preserved: JSON.parse keeps keys
// in source order, and Object.entries iterates in that same order on V8.
function mapQuestions(raw) {
  return Object.entries(raw).map(([key, q]) => ({
    key,
    content: q.content,
    type: q.type ?? 'qualitative',
    requirement: q.requirement ?? '',
    condition: q.condition ?? '',
    maxSec: q.max_sec ?? null, // rename snake → camel at the boundary
  }));
}

async function main() {
  await connectDb();

  const entries = await fs.readdir(INTERVIEWS_DIR).catch(() => []);
  const files = entries.filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    console.log(`[seed] no .json files found in ${INTERVIEWS_DIR}`);
    return;
  }

  for (const file of files) {
    const title = path.basename(file, '.json');                          // filename stem = upsert key
    const raw = JSON.parse(await fs.readFile(path.join(INTERVIEWS_DIR, file), 'utf8'));
    const questions = mapQuestions(raw);

    // Upsert by title so re-running the seeder edits existing sets in place
    // instead of duplicating them. `setDefaultsOnInsert` lets schema defaults
    // apply on the initial insert branch of the upsert.
    const doc = await QuestionSet.findOneAndUpdate(
      { title },
      { title, questions },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    console.log(`[seed] ${file} → QuestionSet "${doc.title}" (${doc.questions.length} questions)`);
  }
}

main()
  .catch((err) => {
    console.error('[seed] failed:', err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
