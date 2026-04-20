// Mongo connection lifecycle. Mongoose holds its own connection pool globally,
// so we just call `connect` once at boot and let models/queries use the default
// connection implicitly. No custom client object needed.

import mongoose from 'mongoose';
import { config } from './config.js';

export async function connectDb() {
  // strictQuery=true rejects fields not in the schema at query time.
  // Safer default for a codebase that's still learning its shape.
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongo.uri);
  console.log(`[db] connected to ${config.mongo.uri}`);
}

// Used by /health. Returns true only if Mongo responds to a ping right now —
// `readyState === 1` alone can lie if the connection silently dropped.
export async function dbPing() {
  if (mongoose.connection.readyState !== 1) return false;
  await mongoose.connection.db.admin().ping();
  return true;
}
